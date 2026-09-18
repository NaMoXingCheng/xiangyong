/**
 * 起隔离实例 → 跑 验收界面.js（Electron 离屏）→ 拆干净。
 * 验收界面.js 自己要求 4399 上先有实例，原来得手动开两个终端、
 * 后台进程还常被 shell 一起带走（ERR_CONNECTION_REFUSED）。包一层省事。
 * 用法：node 跑界面验收.js
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4399;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangyong-ui-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 只复制清单和消息，不复制几个 GB 的模型
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

  let up = false, code = 1;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/persons'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (!up) {
    console.log('❌ 隔离实例没起来\n' + srvErr.slice(0, 800));
  } else {
    const env = Object.assign({}, process.env, { SHOT_URL: 'http://127.0.0.1:' + PORT });
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      ['--no-sandbox', path.join(__dirname, '验收界面.js')], { stdio: 'inherit', env });
    code = r.status || 0;
  }

  try { srv.kill(); } catch (e) {}
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(up ? code : 1);
})();
