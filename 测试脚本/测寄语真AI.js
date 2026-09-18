// 年度报告「结尾寄语」的真 AI 端到端验证
//
// 之前只验过 AI 未就绪时的 503 快速失败路径——那条路走通了不代表真能生成。
// 这个脚本起一个**隔离实例**（换端口 + 换数据目录），真加载本地模型，
// 把真实分析数据喂给 /api/ai/blessing，看它到底能不能写出一段像样的祝福。
//
// 隔离做法：数据目录复制一份（只有 1.1MB），models 用 junction 指回原目录，
// 避免把 3GB+ 的模型复制一遍，也避免污染真实数据。
//
// 用法：node 测试脚本/测寄语真AI.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 默认测源目录。设 TA_APP_ROOT 可以改测别处 —— 主要用途是验打包目录：
//   TA_APP_ROOT=/path/to/打包目录 node 测试脚本/测寄语真AI.js
// 真实数据（聊天记录、模型）始终从源目录取：打包目录里本来就不该有 data，
// 而且模型有 2~8GB，不可能为了测试再复制一份。
const ROOT = process.env.TA_APP_ROOT || path.join(__dirname, '..');
const REAL_DATA = process.env.TA_APP_DATA || path.join(__dirname, '..', 'data');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const TIER = 'lite';        // 3B，出字最快，够用来验链路

let pass = 0, fail = 0;

// Node 在管道下 process.exit() 会丢掉没刷出去的 stdout 缓冲。
// 所以每行同时同步写一份到文件，跑挂了也能看到跑到哪一步。
const LOGF = path.join(__dirname, '截图', '测寄语真AI.log');
try { fs.mkdirSync(path.dirname(LOGF), { recursive: true }); fs.writeFileSync(LOGF, ''); } catch (e) {}
const rawLog = console.log.bind(console);
console.log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ');
  rawLog(line);
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
};
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const no = (m) => { fail++; console.log('  ❌ ' + m); };
const ck = (cond, m) => (cond ? ok(m) : no(m));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmp = path.join(os.tmpdir(), 'ta-blessing-e2e-' + Date.now());

async function jget(url) {
  const r = await fetch(BASE + url);
  return { code: r.status, body: await r.json().catch(() => null) };
}
async function jpost(url, obj) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj || {})
  });
  return { code: r.status, body: await r.json().catch(() => null) };
}

let child = null;
function cleanup() {
  try { if (child && !child.killed) child.kill(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

(async function main() {
  console.log('\n=== 防编造数字：反向校验（纯函数，不加载模型）===');
  {
    const ai = require(path.join(ROOT, 'ai.js'));
    const F = ai._noFabricatedNumbers;
    const summary = '昵称「她」；消息 6633 条，跨度 340 天，日均 20 条；正向情绪占比 61%';
    ck(F('时光荏苒，感谢你这一年的陪伴。', summary) === true,
      '不引用数字的祝福算合格（数字本就是可选的）');
    ck(F('你们聊了 6633 条，跨过 340 天。', summary) === true,
      '引用了真实数字也算合格');
    ck(F('你们聊了 9999 条消息。', summary) === false,
      '出现统计里没有的数字 → 判为编造');
    ck(F('2025 年就要过去了，愿你来年顺遂。', summary) === true,
      '年份不算统计量，不该误判成编造');
    ck(F('', summary) === true, '空文本不报错');
    ck(F('从 2024 到 2025 年，你们聊了 88 天。', summary) === false,
      '年份放行、假数字照样抓得住');
  }

  console.log('\n=== 准备隔离实例 ===');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'messages'), { recursive: true });
  // 逐个文件复制。别用 fs.cpSync —— 这个 Node 版本上它会让进程直接挂掉（无异常、无输出）
  for (const f of fs.readdirSync(path.join(REAL_DATA, 'messages'))) {
    fs.copyFileSync(path.join(REAL_DATA, 'messages', f), path.join(tmp, 'messages', f));
  }
  for (const f of ['persons.json', 'promises.json', 'settings.json']) {
    const src = path.join(REAL_DATA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  // 模型目录用 junction，不复制
  fs.symlinkSync(path.join(REAL_DATA, 'models'), path.join(tmp, 'models'), 'junction');
  ok('数据目录已隔离到 ' + tmp);
  ck(fs.existsSync(path.join(tmp, 'models', 'qwen2.5-3b-instruct-q4_k_m.gguf')), 'junction 指向的 lite 模型可见');

  console.log('\n=== 起服务（新代码，端口 ' + PORT + '）===');
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { TA_LOVE_PORT: String(PORT), TA_LOVE_DATA: tmp }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  child.stdout.on('data', d => srvLog += d);
  child.stderr.on('data', d => srvLog += d);

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await jget('/api/persons'); if (r.code === 200) { up = true; break; } } catch (e) {}
  }
  if (!up) { no('服务没起来'); console.log(srvLog.slice(-2000)); cleanup(); process.exit(1); }
  ok('服务已就绪');

  console.log('\n=== 确认新代码生效 ===');
  const st0 = await jget('/api/ai/status');
  ck(st0.code === 200 && st0.body && Array.isArray(st0.body.tiers), '/api/ai/status 有 tiers 字段（新代码特征）');
  ck(st0.body && st0.body.ready === false, '当前还没加载模型（ready=false）');

  console.log('\n=== 加载本地模型（' + TIER + '）===');
  console.log('  …这一步要读 3GB 权重，慢一点是正常的');
  const t0 = Date.now();
  await jpost('/api/ai/setup', { tier: TIER });
  let ready = false, st = null;
  for (let i = 0; i < 400; i++) {           // 最多等 200 秒
    await sleep(500);
    st = (await jget('/api/ai/status')).body;
    if (st && st.error) { no('加载报错：' + st.error); break; }
    if (st && st.ready) { ready = true; break; }
  }
  const loadSec = Math.round((Date.now() - t0) / 1000);
  if (!ready) {
    no('模型没加载成功（等了 ' + loadSec + 's）');
    console.log('  最后状态:', JSON.stringify(st));
    console.log(srvLog.slice(-2000));
    cleanup(); process.exit(1);
  }
  ok('模型加载成功，用时 ' + loadSec + 's（backend=' + st.backend + '，model=' + st.model + '）');

  console.log('\n=== 取真实分析数据 ===');
  const an = await jget('/api/person/p-d');
  ck(an.code === 200 && an.body && an.body.gauges, '拿到「她」的分析数据');
  const d = an.body;
  ck(d && d.signals && typeof d.signals.startRatio === 'number', '带 signals 原始信号（本轮新增）');
  if (d && d.gauges) {
    console.log('  仪表盘：' + d.gauges.map(g => g.label + ' ' + g.value).join(' / '));
    console.log('  对称性：' + d.symmetry);
  }

  console.log('\n=== 真 AI 生成结尾寄语 ===');
  const t1 = Date.now();
  const r1 = await jpost('/api/ai/blessing', { d });
  const genSec = ((Date.now() - t1) / 1000).toFixed(1);

  if (r1.code !== 200) {
    no('生成失败 HTTP ' + r1.code + '：' + JSON.stringify(r1.body));
  } else {
    const b = r1.body || {};
    const text = (b.blessing || '').trim();
    ck(!!text, '返回了寄语正文');
    ck(text.length >= 40 && text.length <= 600, '篇幅合理（' + text.length + ' 字，用时 ' + genSec + 's）');
    ck(b.backend && b.backend !== 'none', '用的是真后端：' + b.backend);
    ck(!!b.model, '报告了模型名：' + b.model);

    // 不编数字：判据是「没说统计里没有的数」，而不是「必须引用数字」——
    // 寄语是创作性文本，BLESSING_SYSTEM 里数字本来就是可选的
    ck(b.grounded === true, '没有编造统计外的数字（grounded=true）');
    ck(!/\d{4,}/.test(text.replace(/(?:19|20)\d{2}/g, '')), '正文里没有可疑的长数字');

    // 别写成模板腔：检查没有残留的提示词痕迹
    ck(!/作为(一个)?(AI|人工智能|语言模型)/.test(text), '没有「作为一个 AI」式开场');
    ck(!/\{|\}|undefined|NaN/.test(text), '没有模板占位符残留');

    console.log('\n----------- 模型写出来的寄语 -----------');
    console.log(text.split('\n').map(l => '  ' + l).join('\n'));
    console.log('----------------------------------------');

    // 稳定性：同一个输入再跑一次，不该报错
    console.log('\n=== 再跑一次（看是否稳定）===');
    const r2 = await jpost('/api/ai/blessing', { d });
    ck(r2.code === 200 && r2.body && (r2.body.blessing || '').trim().length > 20, '第二次也能正常生成');
  }

  console.log('\n──────────────────────────────────────────────');
  console.log((fail === 0 ? '✅ 全部通过：' : '❌ 有失败：') + pass + ' 项通过，' + fail + ' 项不通过');
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('脚本异常：', e);
  cleanup();
  process.exit(1);
});
