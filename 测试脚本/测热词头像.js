/**
 * 热词选词 + 自定义头像 的端到端自检。
 * 起一个隔离实例（独立端口 + 独立数据目录），跑完就关，不碰用户正在用的 4322 实例。
 * 用法：node 测热词头像.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4399;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangyong-test-'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra ? '\n       实测: ' + JSON.stringify(extra) : '')); }
};

const api = async (m, p, body) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j, type: r.headers.get('content-type') || '' };
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- 准备隔离数据目录：只复制清单和消息，不复制几个 GB 的模型 ----
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

  // 等端口起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/persons'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (!up) {
    console.log('❌ 测试实例没起来\n' + srvErr.slice(0, 800));
    try { srv.kill(); } catch (e) {}
    process.exit(1);
  }
  const persons = (await api('GET', '/api/persons')).json;
  console.log('测试实例已就绪 · ' + TMP + ' · 联系人 ' + persons.length + ' 个\n');

  try {
    // ==================== 一、热词选词 ====================
    console.log('【热词选词】');
    for (const p of persons) {
      const d = (await api('GET', '/api/person/' + p.id)).json;
      const tw = d.topWords || {};
      const all = [...(tw.me || []), ...(tw.ta || [])];
      if (!all.length) { console.log('  ⏭  ' + p.name + ' 没有热词，跳过'); continue; }

      const stems = [];
      const nm = String(p.name || '');
      for (let i = 0; i < nm.length; i++) for (let j = i + 2; j <= nm.length; j++) stems.push(nm.slice(i, j));
      const polluted = stems.length ? all.filter(x => stems.some(s => x.w.includes(s))) : [];
      ok(polluted.length === 0, p.name + '：热词里不含本人姓名（' + all.length + ' 个词）',
        polluted.map(x => x.w));

      // 互相包含 = 同一话题重复上榜
      const dup = [];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++)
          if (all[i].w.includes(all[j].w) || all[j].w.includes(all[i].w)) dup.push(all[i].w + '⊃' + all[j].w);
      ok(dup.length === 0, p.name + '：没有互相包含的重复词', dup);

      const low = all.filter(x => typeof x.df === 'number' && x.df < 2);
      ok(low.length === 0, p.name + '：每个词都跨多条消息出现（df≥2）', low.map(x => x.w + ':' + x.df));

      // 单侧榜单应该按出现次数降序 —— 顺序和数字对不上会让人以为是 bug
      const unsorted = [];
      for (const [who, arr] of [['我', tw.me || []], ['TA', tw.ta || []]]) {
        for (let i = 1; i < arr.length; i++) if (arr[i].n > arr[i - 1].n) unsorted.push(who + ':' + arr[i - 1].n + '<' + arr[i].n);
      }
      ok(unsorted.length === 0, p.name + '：榜单按出现次数从高到低排', unsorted);

      console.log('     前 6 个：' + all.slice(0, 6).map(x => x.w + '(' + x.n + '次/' + x.df + '条)').join('、'));
    }

    // ==================== 二、自定义头像 ====================
    console.log('\n【自定义头像】');
    const pid = persons[0].id;

    let r = await api('PUT', '/api/person/' + pid + '/avatar', { text: '🌸' });
    ok(r.status === 200 && r.json.avatar === '🌸', '用 emoji 设头像', r.json);

    r = await api('GET', '/api/persons');
    ok(r.json.find(x => x.id === pid).avatar === '🌸', 'emoji 已落盘并在列表里生效');

    // 1×1 透明 PNG
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    r = await api('PUT', '/api/person/' + pid + '/avatar', { img: 'data:image/png;base64,' + PNG });
    ok(r.status === 200 && r.json.avatarImg && r.json.avatarImg === pid + '.png', '上传图片设头像，落盘名由服务端决定', r.json);

    const avFile = path.join(TMP, 'avatars', pid + '.png');
    ok(fs.existsSync(avFile), '图片文件确实写到了 data/avatars/');
    ok(fs.readFileSync(avFile).equals(Buffer.from(PNG, 'base64')), '写进去的字节和上传的一致');

    const rImg = await fetch(BASE + '/api/avatar/' + pid);
    ok(rImg.status === 200 && rImg.headers.get('content-type') === 'image/png', 'GET /api/avatar 能取回图片');
    ok((await rImg.arrayBuffer()).byteLength === Buffer.from(PNG, 'base64').length, '取回的图片大小正确');

    r = await api('PUT', '/api/person/' + pid + '/avatar', { img: 'data:text/html;base64,PHNjcmlwdD4=' });
    ok(r.status === 400, '非图片类型被拒（只放行 png/jpeg/webp/gif）', r.json);

    r = await api('PUT', '/api/person/' + pid + '/avatar', { img: 'data:image/png;base64,' + 'A'.repeat(9e6) });
    ok(r.status === 413 || r.status === 400, '超大图片被拒', r.status);

    r = await api('PUT', '/api/person/' + pid + '/avatar', { text: '' });
    ok(r.status === 400, '空文字被拒', r.json);

    r = await api('PUT', '/api/person/不存在的人/avatar', { text: 'x' });
    ok(r.status === 404, '不存在的联系人返回 404', r.status);

    const rTrav = await fetch(BASE + '/api/avatar/..%2F..%2Fpersons.json');
    ok(rTrav.status === 404 || rTrav.status === 400, '路径穿越取文件被拒', rTrav.status);

    r = await api('PUT', '/api/person/' + pid + '/avatar', { reset: true });
    ok(r.status === 200 && r.json.avatarImg === '', '恢复默认会清掉图片引用', r.json);
    ok(!fs.existsSync(avFile), '换头像后旧的图片文件被删掉，不留垃圾');

    const nm = String(persons[0].name || '?');
    ok(r.json.avatar === (nm[0] || '?'), '恢复默认后回退成昵称首字', { got: r.json.avatar, want: nm[0] });

    // ==================== 三、AI 话题归纳 ====================
    console.log('\n【AI 话题归纳】');
    const st = (await api('GET', '/api/ai/status')).json;
    r = await api('POST', '/api/topwords/ai', { personId: pid });
    if (st && st.ready) {
      ok(r.status === 200 && Array.isArray(r.json.topics), 'AI 就绪时能返回话题列表', r.json);
      if (r.json && r.json.topics) {
        const allow = new Set();
        for (const t of r.json.topics) for (const w of t.words) allow.add(w);
        console.log('     话题：' + r.json.topics.map(t => t.label + '(' + t.words.join('/') + ')').join(' · '));
        ok(r.json.topics.every(t => t.label && t.words.length), '每个话题都有标签和词组');
      }
    } else {
      ok(r.status === 503 && r.json && /AI|模型/.test(String(r.json.error)),
        'AI 未就绪时快速失败（503 + 可读提示），不会隐式去下模型', r.status + ' ' + JSON.stringify(r.json));
    }
    r = await api('POST', '/api/topwords/ai', { personId: '不存在' });
    ok(r.status === 404, 'AI 归纳对不存在的联系人返回 404', r.status);

  } catch (e) {
    fail++;
    console.log('\n❌ 测试异常中断：' + (e && e.stack || e));
  }

  try { srv.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})();
