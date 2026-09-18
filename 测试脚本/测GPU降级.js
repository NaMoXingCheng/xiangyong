/**
 * 验证「GPU 崩溃自动降级」不会误伤。
 *
 * 曾经的 bug：应用正常关闭时系统给 GPU 进程发 SIGTERM（exit_code=143），
 * Electron 把这也报成 reason='crashed'。不排除的话，用户正常开关两次应用
 * 就被记成「这台机器 GPU 一直崩」，下次启动悄悄降级成软件渲染 → 又卡回去。
 *
 * 判据：
 *   · 正常关闭后，日志里不该出现「GPU 进程异常」
 *   · 不该生成降级标记文件
 *
 * 用法：node 测试脚本/测GPU降级.js
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const EXE = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG = path.join(APP, '_gputest.log');
const FLAG = path.join(os.homedir(), '.xiangyong-gpu-flag');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIANGYONG_SOFT_RENDER;

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

  try { fs.unlinkSync(FLAG); } catch (e) {}
  try { fs.unlinkSync(LOG); } catch (e) {}

  console.log('【1】启动应用');
  const out = fs.openSync(LOG, 'w');
  const p = spawn(EXE, ['--no-sandbox', APP], { env, stdio: ['ignore', out, out], detached: true });
  p.unref();
  const pid = p.pid;
  console.log('  PID=' + pid);
  await sleep(13000);

  const s = await probe();
  check(s === 200, '应用已就绪（HTTP ' + s + '）');

  console.log('\n【2】按正常方式关闭（等价于用户点窗口右上角 ×）');
  // 不带 /F：发的是关闭请求，触发正常的 before-quit / window-all-closed 流程
  try { execSync('taskkill /PID ' + pid, { stdio: 'ignore' }); } catch (e) {}
  await sleep(8000);

  const s2 = await probe();
  check(s2 !== 200, '应用已退出（端口已释放）');

  console.log('\n【3】检查有没有误报');
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const falseCrash = /GPU 进程异常/.test(log);
  check(!falseCrash, '日志里没有把正常退出误报成 GPU 崩溃');
  if (falseCrash) {
    console.log('      误报内容: ' + (log.match(/.*GPU 进程异常.*/g) || []).join(' | '));
  }
  check(!fs.existsSync(FLAG), '没有生成降级标记文件（不会下次偷偷变软件渲染）');

  // 顺带确认日志里没有别的问题
  const errs = (log.match(/^\[.*ERROR.*$/gm) || []).filter(x => !/Autofill|DevTools/.test(x));
  if (errs.length) {
    console.log('  ℹ 日志里的其他 ERROR（供参考）:');
    [...new Set(errs)].slice(0, 5).forEach(x => console.log('      ' + x.slice(0, 140)));
  }

  console.log('\n================ 结果 ================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('======================================');
  try { fs.unlinkSync(LOG); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
