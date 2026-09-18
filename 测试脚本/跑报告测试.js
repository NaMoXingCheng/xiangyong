/**
 * 一键跑完年度报告那三套 Electron 巡检（版式 / 收尾 / 交互）。
 * 它们都要求 4399 上先有实例，而 shell 里的后台进程经常被一起带走
 * （跑界面验收.js 的注释里记过这个坑）。这里复用同一套做法：起隔离实例 → 跑 → 拆干净。
 *
 * 用法：node 测试脚本/跑报告测试.js
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4399;
const SUITES = ['测报告版式.js', '测报告收尾.js', '测报告交互.js'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangyong-report-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(TMP, 'messages'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'persons.json'), path.join(TMP, 'persons.json'));
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'messages'))) {
    fs.copyFileSync(path.join(ROOT, 'data', 'messages', f), path.join(TMP, 'messages', f));
  }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { TA_LOVE_DATA: TMP, TA_LOVE_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvErr = '';
  srv.stderr.on('data', d => { srvErr += d.toString(); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/persons'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(250);
  }

  let bad = 0;
  if (!up) {
    console.log('❌ 隔离实例没起来\n' + srvErr.slice(0, 800));
    bad = 1;
  } else {
    const env = Object.assign({}, process.env, { SHOT_URL: 'http://127.0.0.1:' + PORT });
    delete env.ELECTRON_RUN_AS_NODE;
    for (const s of SUITES) {
      console.log('\n══════════ ' + s + ' ══════════');
      const r = spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
        ['--no-sandbox', path.join(__dirname, s)], { stdio: 'inherit', env });
      if (r.status) bad++;
    }
  }

  try { srv.kill(); } catch (e) {}
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(bad ? `\n有 ${bad} 套没跑过` : '\n全部巡检通过');
  process.exit(bad ? 1 : 0);
})();
