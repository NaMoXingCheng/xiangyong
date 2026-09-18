/**
 * 验证防多开（app.requestSingleInstanceLock）。
 *
 * 判据：第二个实例必须在几秒内自己退出。
 *   · 防多开生效 → 第二实例拿到锁失败，立刻退出，退出码 0
 *   · 防多开没生效 → 第二实例会一直活着（窗口起得来，但后端撞 4322 端口）
 *
 * 同时确认第二实例退出后，第一个实例仍正常监听 4322（没被第二实例搞坏）。
 *
 * 用法：node 测试脚本/测防多开.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const APP = path.join(__dirname, '..');
const EXE = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

function launch(tag) {
  const p = spawn(EXE, ['--no-sandbox', APP], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { tag, pid: p.pid, out: '', exited: false, code: null, at: Date.now() };
  p.stdout.on('data', d => rec.out += d);
  p.stderr.on('data', d => rec.out += d);
  p.on('exit', (code) => { rec.exited = true; rec.code = code; rec.ms = Date.now() - rec.at; });
  return rec;
}

function probe() {
  return new Promise(res => {
    const req = http.get('http://localhost:4322/api/settings', r => { r.resume(); res(r.statusCode); });
    req.on('error', () => res(0));
    req.setTimeout(3000, () => { req.destroy(); res(-1); });
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✅ ' : '  ❌ ') + m); };

  console.log('【1】启动第一个实例');
  const a = launch('A');
  console.log('  PID=' + a.pid);
  await sleep(9000);

  const statusA = await probe();
  check(statusA === 200, '第一个实例已就绪（/api/settings → HTTP ' + statusA + '）');
  check(!a.exited, '第一个实例仍在运行');

  console.log('\n【2】再启动一次（模拟用户又双击了一下图标）');
  const b = launch('B');
  console.log('  PID=' + b.pid);
  await sleep(9000);

  check(b.exited, '第二个实例已自行退出' + (b.exited ? '（耗时 ' + b.ms + 'ms，退出码 ' + b.code + '）' : ''));
  if (b.exited) {
    check(b.code === 0, '退出码为 0（不是崩溃退出）');
    const bad = /EADDRINUSE|Unhandled|Error:|异常/i.test(b.out);
    check(!bad, '输出里没有端口冲突/未捕获异常' + (bad ? '\n        ' + b.out.slice(0, 300) : ''));
    if (b.out.trim()) console.log('      第二实例输出: ' + JSON.stringify(b.out.trim().slice(0, 200)));
  }

  console.log('\n【3】确认第一个实例没被影响');
  const statusA2 = await probe();
  check(statusA2 === 200, '端口 4322 仍可用（HTTP ' + statusA2 + '）');
  check(!a.exited, '第一个实例还活着（用户原来的窗口没被顶掉）');

  console.log('\n================ 结果 ================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('======================================');

  // 清理
  for (const r of [a, b]) {
    if (!r.exited) { try { process.kill(r.pid); } catch (e) {} }
  }
  await sleep(1500);
  process.exit(fail ? 1 : 0);
})();
