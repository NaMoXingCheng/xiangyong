/**
 * 验证「打包目录」真的能跑起来。
 *
 * 打包脚本那句「全部检查通过」只证明文件都在，不证明它们能跑。这个脚本做两件真验收：
 *   1) 起一个隔离实例（换端口 + 换数据目录），确认 HTTP 服务、前端页面、API 都正常
 *   2) 从打包目录加载 node-llama-cpp 并初始化推理后端
 *      —— 这是打包最容易坏的地方：native 模块的路径、以及
 *         @node-llama-cpp/win-x64* 那几个后端包能不能被解析到。
 *         ai.js 里 node-llama-cpp 是懒加载的（顶部没有 require），
 *         所以「服务能起来」根本覆盖不到它，必须单独验。
 *
 * 只 require 不加载模型，所以不吃显存、不留常驻进程。
 * 真模型那条链路归「测试脚本/测寄语真AI.js」管。
 *
 * 用法：node 工具/验证打包.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.OUT || 'E:/相拥-打包版';
const PORT = 4399;                                   // 刻意不用默认 4322，免得和在跑的实例撞
const TMP_DATA = path.join(os.tmpdir(), 'xiangyong-verify-' + Date.now());

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  \u2705 ' + msg); }
  else { fail++; console.log('  \u274c ' + msg + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 200) : '')); }
};

(async () => {
  console.log('验证打包目录：' + OUT);
  console.log('  隔离实例：端口 ' + PORT + '，数据目录 ' + TMP_DATA);
  console.log('');

  if (!fs.existsSync(path.join(OUT, 'server.js'))) {
    console.error('\u274c 打包目录里没有 server.js，先跑 工具/打包.js');
    process.exit(1);
  }

  // ---------- 1. 起隔离实例 ----------
  console.log('【一】HTTP 服务与前端');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: OUT,
    env: { ...process.env, TA_LOVE_PORT: String(PORT), TA_LOVE_DATA: TMP_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  let exited = false;
  child.on('exit', () => exited = true);

  const base = 'http://127.0.0.1:' + PORT;
  const get = async p => { const r = await fetch(base + p); return { code: r.status, body: await r.text() }; };

  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (exited) break;
    try { await fetch(base + '/api/ai/status'); up = true; break; } catch (e) {}
  }
  ok(up, '服务能起来（' + PORT + ' 端口有响应）');
  if (!up) { console.log('\n服务启动日志：\n' + log.slice(0, 1200)); child.kill(); process.exit(1); }

  // 前端三件套
  const idx = await get('/');
  ok(idx.code === 200 && /<title>|关系分析室/.test(idx.body), '首页返回 200 且有内容', idx.code);
  for (const f of ['/app.js', '/style.css', '/sound.js']) {
    const r = await get(f);
    ok(r.code === 200 && r.body.length > 1000, '静态资源 ' + f + ' 正常（' + r.body.length + ' 字节）', r.code);
  }

  // AI 状态：这是「删干净 Ollama」的接口级复查
  const st = await get('/api/ai/status');
  let s = null;
  try { s = JSON.parse(st.body); } catch (e) {}
  ok(!!s, '/api/ai/status 返回合法 JSON');
  if (s) {
    const keys = Object.keys(s);
    const oll = keys.filter(k => /ollama/i.test(k));
    ok(oll.length === 0, '状态里没有任何 ollama 字段（' + keys.length + ' 个字段已核）', oll);
    ok(Array.isArray(s.tiers) && s.tiers.length === 3, '三档模型元数据齐全', s.tiers && s.tiers.length);
    ok(s.tiers && s.tiers.every(t => t.key && t.label && t.params && t.sizeGB && t.minVRAM && t.desc),
      '每档的 key/label/params/sizeGB/minVRAM/desc 都不缺');
  }

  // 联系人接口（空数据目录应返回空，但不该报 404/500）
  const ps = await get('/api/persons');
  ok(ps.code === 200, '/api/persons 正常响应', ps.code);

  // 打包目录不该被写入 data/
  ok(!fs.existsSync(path.join(OUT, 'data')), '隔离实例没往打包目录写 data/');
  ok(!fs.existsSync(path.join(OUT, 'node_modules', '.cache')), '没有 node_modules/.cache');

  child.kill();
  await new Promise(r => setTimeout(r, 400));

  // ---------- 2. native 推理引擎 ----------
  console.log('\n【二】native 推理引擎（node-llama-cpp）');
  // 不能直接在本进程 import —— ai.js 用的是裸包名 `await import('node-llama-cpp')`，
  // 裸包名从「脚本自己住的目录」往上找 node_modules。我们这个验证脚本住在源目录，
  // 直接 import 会解析到源目录的包，等于什么都没验。
  // 所以在打包目录里放一个一次性探针，让 Node 按真实规则从打包目录往上找。
  // 探针跑完立刻删掉，不能留在分发包里。
  const probe = path.join(OUT, '_probe_llama.mjs');
  try {
    fs.writeFileSync(probe, [
      "import { getLlama } from 'node-llama-cpp';",
      "const t0 = Date.now();",
      "let llama;",
      // 和 ai.js 一样的兜底顺序：Vulkan → auto → CPU
      "try { llama = await getLlama({ gpu: 'vulkan' }); }",
      "catch (e1) { try { llama = await getLlama({ gpu: 'auto' }); } catch (e2) { llama = await getLlama({ gpu: false }); } }",
      "const dev = typeof llama.getGpuDeviceNames === 'function'",
      "  ? await llama.getGpuDeviceNames().catch(() => []) : [];",
      "console.log('PROBE_OK|' + ((Date.now() - t0) / 1000).toFixed(1) + '|' + (dev.length ? dev.join(' / ') : '仅 CPU'));",
      "await llama.dispose();",
    ].join('\n'), 'utf8');

    const r = spawnSync(process.execPath, [probe], { cwd: OUT, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/PROBE_OK\|([\d.]+)\|(.+)/);
    // 这一步会真的去解压/映射 addon 的 .node/.dll，并加载后端包。
    // 打包漏了 @node-llama-cpp/win-x64* 或 native 路径不对，这里必炸。
    ok(!!m, '能从打包目录加载并初始化推理引擎（Vulkan 优先）');
    if (m) {
      console.log('     初始化耗时 ' + m[1] + ' 秒，可见设备：' + m[2].trim());
    } else {
      console.log('     探针输出：' + out.trim().split('\n').slice(-6).join('\n     '));
    }
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch (e) {}
  }

  // ---------- 结果 ----------
  // 清掉隔离数据目录，别在 %TEMP% 里堆垃圾
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，未通过 ' + fail + ' 项');
  if (fail) { console.log('\u274c 打包目录还有问题，别急着分发'); process.exit(1); }
  console.log('\u2705 打包目录可以跑，拿去分发吧');
})();
