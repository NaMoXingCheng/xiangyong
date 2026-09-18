/**
 * 打包：把「源目录」里运行时真正需要的文件，复制成一份干净的「打包目录」。
 *
 * 用法：
 *   node 工具/打包.js            完整复制（默认，最保险）
 *   node 工具/打包.js --slim     顺带砍掉构建期垃圾（省 ~230MB，需实测）
 *   node 工具/打包.js --dry-run  只看要复制什么、多大，不落盘
 *
 * 为什么不直接把整个目录压包：
 *   1) data/ 里是真实聊天记录，绝不能进分发包 —— 下面有硬断言拦这一条
 *   2) 测试脚本/工具/截图 是我们自己用的，装到用户机器上是纯垃圾
 *   3) node_modules 里有安装期才用的包，运行时一个都用不上
 *
 * ⚠️ 必须记住的坑：electron 写在 package.json 的 devDependencies 里，
 *    但它是这个应用的「运行宿主」—— 启动应用.bat 直接调
 *    node_modules/electron/dist/electron.exe。所以凡是按「devDeps 一律不带」
 *    来做的打包器，都会做出一个双击打不开的包。这里显式把它当运行时依赖处理。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.OUT || 'E:/相拥-打包版';

const argv = process.argv.slice(2);
const SLIM = argv.includes('--slim');
const DRY = argv.includes('--dry-run');

// ---------- 要复制的项目文件 ----------
// 显式白名单，而不是黑名单过滤。分发包里出现什么，必须是我们一个个点过头的。
const FILES = [
  'electron-main.js',   // Electron 主进程
  'server.js',          // 本地 HTTP 服务
  'ai.js',              // 内置本地小AI（node-llama-cpp）
  'score.js',           // 三个指数的口径与算法
  'package.json',
  'package-lock.json',
  'emoji_name_map.json',
  'wordlist.txt',       // 中文分词词表
  'app.ico',
  'README.md',
  'LICENSE',
  '启动应用.bat',        // 用户的启动入口
  'build.iss',          // Inno Setup 打包脚本（留给要出安装包的人）
];
const DIRS = ['public'];   // 前端资源

// 明确不带的（只用于日志说明，实际靠白名单保证）
const EXCLUDE_NOTE = ['data', '测试脚本', '工具', '截图', 'node_modules/.cache', '.git'];

// ---------- 依赖闭包 ----------
// 入口包。electron 虽在 devDeps，但它是运行宿主，必须带。
const ENTRY = ['electron', 'node-llama-cpp'];

// 这几个包只需要"能启动"那部分，不需要拉它们的安装期依赖树
const LEAF = new Set(['electron']);

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch (e) { return null; }
}

/** 递归收集一个包名及其运行时依赖，返回「包名 -> 源目录」 */
function collect(names) {
  const found = new Map();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    if (found.has(name)) continue;
    const dir = path.join(ROOT, 'node_modules', name);
    if (!fs.existsSync(dir)) {
      // 缺失不一定是错：optionalDependencies 允许装不上（比如非本平台的二进制包）
      found.set(name, null);
      continue;
    }
    found.set(name, dir);
    const pkg = readPkg(dir);
    if (pkg && !LEAF.has(name)) {
      queue.push(...Object.keys(pkg.dependencies || {}));
      queue.push(...Object.keys(pkg.optionalDependencies || {}));
    }
  }
  return found;
}

// ---------- 体积统计 ----------
function dirSize(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let s = 0;
  for (const n of fs.readdirSync(p)) s += dirSize(path.join(p, n));
  return s;
}
const mb = b => (b / 1048576).toFixed(1) + ' MB';

// ---------- 删除目录树 ----------
// 不用 fs.rmSync：它在 Windows 上是纯 JS 递归 + 逐个 unlink。
// 实测清一个「661MB node_modules + 一个 195MB 带 .git 的源码树」的旧打包目录，
// 跑了 5 分 41 秒还没删完，直接把整个打包流程拖到工具超时被杀。
// rd /s /q 是系统原生递归删除，快一个数量级。
// node_modules 嵌套很深，路径轻易超过 260 字符的 MAX_PATH，所以没删干净时
// 再套一层 \\?\ 前缀重试 —— 而不是默默失败留下半个旧目录。
function rmrf(target) {
  if (!fs.existsSync(target)) return;
  // 要删的东西不一定都是目录：llama/gitRelease.bundle 就是个 33MB 的文件。
  // rd 是「删目录」的命令，对文件静默什么都不做，然后会被下面的存在性检查
  // 判成「删不掉」而报错 —— 删文件走 unlink 就行。
  let isDir = false;
  try { isDir = fs.lstatSync(target).isDirectory(); } catch (e) {}
  if (!isDir) { fs.unlinkSync(target); return; }
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'rd', '/s', '/q', target], { stdio: 'ignore' });
    if (fs.existsSync(target)) {
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', '\\\\?\\' + path.resolve(target)], { stdio: 'ignore' });
    }
    if (fs.existsSync(target)) throw new Error('删不掉：' + target + '（可能有进程正占着里面的文件）');
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

// ---------- 瘦身规则 ----------
// node-llama-cpp 的 npm 包里捆绑了上游 llama.cpp 的完整源码树，其中有：
//   llama/llama.cpp/models/   74MB  上游跑测试用的小模型，我们一个都不用
//   llama/llama.cpp/docs/     37MB  文档
//   llama/llama.cpp/.git/     33MB  整个 git 仓库
//   llama/gitRelease.bundle   33MB  git bundle
//   llama.cpp 其余源码        ~20MB  只有「本机从源码编译」这条路才会读
// 我们的运行路径是「加载 @node-llama-cpp/win-x64-vulkan 预编译二进制」，
// 走不到上面任何一样。
//
// 已实测（2026-09-17）：把这三样移走后，真加载 Qwen2.5-3B 跑通了完整生成链路
// （测寄语真AI.js 23 项全绿）。所以 --slim 是安全的，不是「看起来应该没事」。
// 但默认仍然不砍 —— 分发包能不能跑，比少 250MB 重要得多；
// 要省这个体积，请显式加 --slim，并且装完在目标机器上验一次。
const SLIM_RULES = [
  { at: 'node-llama-cpp', rel: 'llama/llama.cpp',        why: '上游源码树，只有本机编译才用' },
  { at: 'node-llama-cpp', rel: 'llama/gitRelease.bundle', why: 'git bundle，用不上' },
  // electron 本体是 x64 的，整个应用就是 x64 的；Windows on ARM 上也是走 x64 模拟，
  // 所以这个包永远加载不到。删了它不影响任何一台能跑起这个应用的机器。
  { at: '',               rel: '@node-llama-cpp/win-arm64', why: 'ARM 平台包，x64 应用用不到' },
];

// ---------- 复制 ----------
// ⚠️ 不用 fs.cpSync。实测在 Node 22.22.2 / Windows 上，
//    fs.cpSync(src, dst, { recursive: true, dereference: true }) 复制第一个目录时
//    会让 node 进程**直接崩溃**：退出码 127、没有任何异常堆栈、stdout 停在 "public … "。
//    public/ 里就是 4 个普通文件、一个符号链接都没有，所以不是链接引起的，
//    是这个 API 本身在这套组合下就不可用。手写递归慢一点，但结果可预期。
let copiedCount = 0;
let skippedLinks = 0;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else if (st.isSymbolicLink()) skippedLinks++;   // 不跟链接，免得复制到源目录外面去
    else { fs.copyFileSync(s, d); copiedCount++; }
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copiedCount++;
}

// ================= 执行 =================
console.log('相拥 · 关系分析室（抓取版）—— 打包');
console.log('  源目录：' + ROOT);
console.log('  目标  ：' + OUT);
console.log('  模式  ：' + (DRY ? '试算（不落盘）' : SLIM ? '瘦身复制' : '完整复制'));
console.log('');

if (path.resolve(OUT) === ROOT) {
  console.error('❌ 目标目录不能等于源目录，会把自己覆盖掉');
  process.exit(1);
}
if (OUT.startsWith(ROOT + path.sep)) {
  console.error('❌ 目标目录不能在源目录里面，否则下次打包会把自己复制进去');
  process.exit(1);
}

const deps = collect(ENTRY);
const missing = [...deps].filter(([, d]) => !d).map(([n]) => n);
if (missing.length) console.log('   （装不上的可选依赖，跳过：' + missing.join(', ') + '）\n');

// 计划清单。体积在这里算一次存下来 —— node_modules 里有十几万个小文件，
// 遍历一遍就要好几秒，后面打印时再算一遍纯属白费。
const plan = [];
let total = 0;
const add = (rel, src, dir, dep) => {
  const size = dirSize(src);
  plan.push({ rel, src, dir, dep, size });
  total += size;
};
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.log('   （跳过不存在的 ' + f + '）'); continue; }
  add(f, src, fs.statSync(src).isDirectory());
}
for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) continue;
  add(d, src, true);
}
for (const [name, dir] of deps) {
  if (!dir) continue;
  add('node_modules/' + name, dir, true, true);
}

// 只详细列 1MB 以上的。依赖闭包能拉进来 90 多个包，全列出来会把真正的体积大头淹掉，
// 而"这个包 0.0MB"这种信息对一个要判断能不能分发的人毫无价值。
const BIG = 1048576;
console.log('要复制的内容（小于 1MB 的合并成一行）：');
let smallN = 0, smallSum = 0;
for (const it of plan) {
  if (it.size < BIG) { smallN++; smallSum += it.size; continue; }
  console.log('  ' + mb(it.size).padStart(11) + '  ' + it.rel + (it.dep ? '' : '   (项目文件)'));
}
if (smallN) console.log('  ' + mb(smallSum).padStart(11) + '  （其余 ' + smallN + ' 个零碎文件）');
console.log('  ' + '-'.repeat(30));
console.log('  ' + mb(total).padStart(11) + '  合计');

let slimSave = 0;
if (SLIM) {
  for (const r of SLIM_RULES) {
    const p = path.join(ROOT, 'node_modules', r.at, r.rel);
    if (fs.existsSync(p)) slimSave += dirSize(p);
  }
  console.log('\n  瘦身可再省：' + mb(slimSave));
  for (const r of SLIM_RULES) console.log('     - ' + r.rel + '（' + r.why + '）');
}
console.log('\n明确不带：' + EXCLUDE_NOTE.join('、'));

if (DRY) { console.log('\n（试算模式，什么都没写）'); process.exit(0); }

// ---------- 真复制 ----------
console.log('\n开始复制…');
const t0 = Date.now();
if (fs.existsSync(OUT)) {
  console.log('  清空已存在的目标目录…');
  const tClean = Date.now();
  rmrf(OUT);
  console.log('  已清空（' + ((Date.now() - tClean) / 1000).toFixed(1) + ' 秒）');
}
fs.mkdirSync(OUT, { recursive: true });

for (const it of plan) {
  const dst = path.join(OUT, it.rel);
  process.stdout.write('  ' + it.rel + ' … ');
  const n0 = copiedCount;
  if (it.dir) copyDir(it.src, dst); else copyFile(it.src, dst);
  // 报文件数：node_modules 那几项要跑几十秒，只打一个 ok 会让人以为卡住了
  process.stdout.write('ok（' + (copiedCount - n0).toLocaleString('en-US') + ' 个文件）\n');
}

// ---------- 瘦身 ----------
if (SLIM) {
  console.log('\n瘦身中…');
  for (const r of SLIM_RULES) {
    const p = path.join(OUT, 'node_modules', r.at, r.rel);
    if (fs.existsSync(p)) { rmrf(p); console.log('  已删 ' + r.rel + '   ← ' + r.why); }
  }
}

// ---------- 安全断言 ----------
// 这一条是这个脚本存在的主要理由。打包时把聊天记录带出去，是最不能犯的错。
console.log('\n安全检查：');
let bad = 0;
const mustNotExist = ['data', 'node_modules/.cache'];
for (const r of mustNotExist) {
  const p = path.join(OUT, r);
  if (fs.existsSync(p)) { console.log('  ❌ 不该出现：' + r); bad++; }
  else console.log('  ✅ 没有 ' + r);
}
const mustExist = [
  'node_modules/electron/dist/electron.exe',
  'node_modules/node-llama-cpp/package.json',
  'server.js', 'ai.js', 'public/index.html', '启动应用.bat',
];
for (const r of mustExist) {
  const p = path.join(OUT, r);
  if (fs.existsSync(p)) console.log('  ✅ 有 ' + r);
  else { console.log('  ❌ 缺了 ' + r); bad++; }
}

const finalSize = dirSize(OUT);
console.log('\n复制完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
console.log('共写入 ' + copiedCount.toLocaleString('en-US') + ' 个文件，成品体积：' + mb(finalSize) + (SLIM ? '（已瘦身）' : ''));
if (skippedLinks) console.log('跳过 ' + skippedLinks + ' 个符号链接（应用启动不依赖它们）');
if (bad) { console.log('\n❌ 有 ' + bad + ' 项检查没过，别急着分发'); process.exit(1); }
console.log('✅ 全部检查通过。目录：' + OUT);
console.log('   连 build.iss 一起交给 Inno Setup 就能出安装包。');
