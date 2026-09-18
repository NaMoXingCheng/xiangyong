#!/usr/bin/env node
// 版本对比.js —— 拿某个历史提交跟当前工作区比，产出「更新日志」需要的两组数据：
//   ① 逐文件行数变化（谁膨胀了、谁是新文件）
//   ② 功能关键词计数变化（哪些功能是新增的、哪些是增强的）
//
// 用法：
//   node 工具/版本对比.js <基准SHA>        # 例：node 工具/版本对比.js 2a79d76
//   node 工具/版本对比.js                  # 不传则列出最近提交供选择
//
// 注意：跑之前先 `git fetch`，或直接把远程 SHA 传进来（远程对象要在本地存在）。
// 输出可直接粘进 README 的更新日志与 commit message。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GIT = process.env.GIT_BIN || 'git';

const git = (args) => {
  const r = spawnSync(GIT, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? (r.stdout || '') : null;
};

// ---------- 定义要统计的功能点（改这里就能定制）----------
const FEATURES = [
  ['年度报告', /年度报告|年度总结|report-stage|buildReport|renderReport/g],
  ['音效/背景音乐', /sfx\(|createOscillator|musicStart|AudioContext/g],
  ['可解释关系指数', /parts|signalsOf|gaugesOf/g],
  ['多档模型', /tier|minVRAM|TIERS/g],
  ['断点续传', /Range|content-range|resume|断点/g],
  ['GPU 加速', /vulkan|Vulkan|cuda|metal/gi],
  ['显存/内存回收', /unload|keep_alive|AI_IDLE|卸载模型|归还显存/g],
  ['承诺追踪', /promise|承诺/g],
  ['自定义头像', /contextmenu|avatar|头像/g],
  ['中文分词/热词', /wordlist|分词|segment/g],
  ['数字显示统一', /tabular-nums|font-variant-numeric/g],
  ['防多开', /requestSingleInstanceLock|second-instance|单实例/g],
  ['局域网访问', /局域网|\bLAN\b|0\.0\.0\.0/g],
  ['毛玻璃/景深', /backdrop-filter/g],
];

// 参与统计的文件（不存在的会自动跳过）
const FILES = [
  'public/app.js', 'public/style.css', 'public/index.html', 'public/sound.js',
  'server.js', 'ai.js', 'score.js', 'electron-main.js', 'package.json',
];
// 这些不参与统计（工具/ 属仓库内脚本，不随应用分发，单独在更新日志里讲）
const SKIP = /^(node_modules|data|\.git|测试脚本|截图|工具|相拥-)/;

const MB = b => (b / 1048576).toFixed(1) + ' MB';

// ---------- 参数 ----------
const BASE = process.argv[2];
if (!BASE) {
  console.log('用法：node 工具/版本对比.js <基准SHA>\n');
  console.log('=== 最近 12 个提交（挑一个当基准）===');
  console.log(git(['log', '--oneline', '--no-decorate', '-12']) || '（git log 失败）');
  console.log('\n提示：想看「本地相对远程」的差异，先 git fetch，再传 origin/main 的 SHA。');
  process.exit(0);
}
if (!git(['cat-file', '-t', BASE])) {
  console.error('❌ 本地没有这个对象：' + BASE + '（先 git fetch，或换一个 SHA）');
  process.exit(1);
}

const lines = t => (t || '').split('\n').length;
const cnt = (s, re) => (s.match(re) || []).length;

// ---------- ① 行数对比 ----------
// ⚠️ 必须带 -c core.quotepath=false：否则 git 会把中文文件名输出成 "\345\220\..." 八进制转义，
//    与文件系统里的真实名字对不上（且那种转义不是合法 JSON，解析会直接抛错）。
const remoteList = (git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', BASE]) || '')
  .trim().split('\n').filter(Boolean);

function walk(d, out, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rp = rel ? rel + '/' + e.name : e.name;
    if (SKIP.test(rp)) continue;
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp, out, rp);
    else out.push(rp);
  }
  return out;
}
const localList = walk(ROOT, [], '');

console.log('# 与 ' + BASE + ' 的差异\n');
console.log('## ① 文件行数\n');
console.log('| 文件 | 基准 | 本版 | 变化 |');
console.log('|---|---:|---:|---:|');
let totB = 0, totL = 0, newFiles = 0;
const rows = [];
for (const f of localList) {
  const isNew = !remoteList.includes(f);
  const rr = isNew ? null : git(['show', BASE + ':' + f]);
  const baseLines = rr === null ? 0 : lines(rr);
  let loc = 0;
  try { loc = lines(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { }
  // 只看有意义的文件：代码/文本，且变化不为 0 或是新增
  if (!/\.(js|css|html|json|md|iss|bat)$/i.test(f)) continue;
  if (!isNew && loc === baseLines) continue;
  if (loc < 5) continue;
  rows.push({ f, baseLines, loc, isNew, d: loc - baseLines });
  if (!isNew) { totB += baseLines; totL += loc; } else { newFiles++; totL += loc; }
}
rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
for (const r of rows) {
  console.log('| `' + r.f + '` | ' + (r.isNew ? '—' : r.baseLines + ' 行') + ' | **' + r.loc + ' 行** | '
    + (r.isNew ? '🆕 新增' : (r.d > 0 ? '+' : '') + r.d) + ' |');
}
console.log('| **合计** | **' + totB + '** | **' + totL + '** | 约 ' + (totB ? (totL / totB).toFixed(2) : '?') + ' 倍 |');
console.log('（新增文件 ' + newFiles + ' 个；行数含词表之类的大文本，必要时手动剔除）\n');

// ---------- ② 功能关键词对比 ----------
const allBase = FILES.map(f => git(['show', BASE + ':' + f]) || '').join('\n');
const allLocal = FILES.map(f => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } }).join('\n');

console.log('## ② 功能点变化\n');
console.log('| 功能 | 基准 | 本版 | 判定 |');
console.log('|---|---:|---:|---|');
for (const [name, re] of FEATURES) {
  const a = cnt(allBase, new RegExp(re.source, re.flags));
  const b = cnt(allLocal, new RegExp(re.source, re.flags));
  let v;
  if (a === 0 && b > 0) v = '🆕 **本次新增**';
  else if (a > 0 && b === 0) v = '❌ 本次移除';
  else if (b > a * 1.3) v = '🔧 大幅增强 (' + a + '→' + b + ')';
  else if (b > a) v = '· 小幅增强';
  else if (a === b) v = '= 持平';
  else v = '· 减少 (' + a + '→' + b + ')';
  console.log('| ' + name + ' | ' + a + ' | ' + b + ' | ' + v + ' |');
}
console.log('\n> 关键词计数只是线索，不是证据 —— 写更新日志前对「新增/移除」逐条人工确认。');
console.log('> 典型陷阱：某个词在基准版里出现 0 次，不代表那个功能不存在，也可能只是叫法不同。');
