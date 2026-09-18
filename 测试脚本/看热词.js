/**
 * 看热词选词实际输出：起隔离实例（真实数据副本）→ 打 /api/person/<id> → 打印榜单 → 拆干净。
 * 调选词逻辑时用它比开整个应用快得多，也不用重启用户在跑的实例。
 * 用法：node 看热词.js [personId]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4398;
const PID = process.argv[2] || 'p-d';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangyong-words-'));
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
  let err = '';
  srv.stderr.on('data', d => { err += d.toString(); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/persons'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (up) {
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/person/' + PID)).json();
    const d = j.data || j;
    const fmt = list => (list || []).map(x => x.w + '(' + x.n + ')').join('  ') || '（空）';
    console.log('【我】' + fmt(d.topWords && d.topWords.me));
    console.log('【TA】' + fmt(d.topWords && d.topWords.ta));
    console.log('【报告里会显示】我 top3：' + (d.topWords && d.topWords.me || []).slice(0, 3).map(x => x.w).join(' · '));
  } else {
    console.log('❌ 实例没起来\n' + err.slice(0, 600));
  }

  try { srv.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(up ? 0 : 1);
})();
