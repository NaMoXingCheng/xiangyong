/**
 * 显存治理（闲置 120 秒归还显存）+ AI 接口就绪守卫的验证。
 *
 * 分两段：
 *   A. 模块级 —— 接口契约与「归还显存」状态机。**不需要加载模型**，所以秒跑、不占显存。
 *      这里专门钉住「不再有 Ollama 那套东西」：删掉双后端之后，最容易出的问题不是崩，
 *      而是 status() 里悄悄留着永远为 null 的 ollama 字段、或者某处还在引用已删的函数。
 *   B. 接口级 —— 起隔离实例，确认五个 AI 接口在模型没就绪时都是快速失败（503 + 可读 JSON），
 *      而不是挂在那儿顺着 ensureModel() 去下几个 GB 的模型。
 *
 * 注意：「闲置 120 秒 → 真的卸下来 → 下次调用自动装回」这条完整链路必须**加载真模型**才测得动，
 * 归 测寄语真AI.js 那类端到端测试管，别在这里用假服务端假装证明了。
 *
 * 用法：node 测AI显存.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4398;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangyong-ai-'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '\n       实测: ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = async (m, p, body) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; const t = r.headers.get('content-type') || '';
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j, type: t };
};

// ---------------- 假 Ollama 服务端（已随双后端一起退役）----------------
// 这一段原来是用假服务端截下请求体、验 keep_alive 到底发了什么 ——
// 那是当时唯一能证明「闲置后显存真会还回去」的办法。现在 Ollama 后端整个删掉了，
// 那段协议也就没得可验；归还显存改成由 ai.js 自己的闲置定时器触发（dispose 模型 + llama 后端）。
// 完整链路（闲置 120 秒 → 真的卸下 → 下次自动装回）要加载真模型才测得动，见文件头说明。

(async () => {
  // ==================== A. 模块级：契约 + 归还显存的状态机 ====================
  // 全段不加载模型：不碰显存、不下载、秒级跑完。
  console.log('【A. 模块级：接口契约与显存归还状态机】');
  const ai = require(path.join(ROOT, 'ai.js'));
  ai.init(TMP);

  ok(ai.AI_IDLE_SEC === 120, '闲置上限就是 120 秒（实测 ' + ai.AI_IDLE_SEC + '）', ai.AI_IDLE_SEC);

  // ---- 防回退：Ollama 那套必须彻底不在 ----
  // 删双后端最容易留的尾巴就是「字段还在、永远是 null」，UI 照着它渲染就会出鬼。
  const keys = Object.keys(ai.status());
  const leftover = keys.filter(k => /ollama/i.test(k));
  ok(leftover.length === 0, 'status() 里没有任何 ollama 字段（' + keys.length + ' 个字段已核）', leftover);
  ok(typeof ai.detectOllama === 'undefined', 'detectOllama 已从导出里移除', typeof ai.detectOllama);
  ok(typeof ai.setup === 'function' && typeof ai.chat === 'function' && typeof ai.unload === 'function',
    '模型准备 / 生成 / 卸载 三个接口都在');

  // ---- 冷启动状态 ----
  const s0 = ai.status();
  ok(s0.backend === 'none', '没启用时 backend = none（' + s0.backend + '）', s0.backend);
  ok(s0.ready === false, '没启用时 ready = false', s0.ready);
  ok(s0.idleLimit === 120, 'status() 带出 idleLimit（' + s0.idleLimit + '）', s0.idleLimit);
  ok(s0.evicted === false && s0.vram === 'free', '还没启用时 vram = free', { evicted: s0.evicted, vram: s0.vram });
  ok(s0.installed === false, '空模型目录里 installed = false', s0.installed);

  // ---- 三档元数据齐全（面板直接照着渲染，缺字段会画成空白）----
  const t3 = s0.tiers || [];
  ok(t3.length === 3, '三档模型都在（' + t3.length + ' 档）', t3.length);
  ok(t3.every(t => t.key && t.label && t.params && t.sizeGB > 0 && t.minVRAM > 0 && t.desc && 'installed' in t),
    '每档的 key/label/params/sizeGB/minVRAM/desc/installed 都不缺',
    t3.map(t => Object.keys(t).filter(k => !t[k] && t[k] !== false)));
  ok(t3.map(t => t.key).join(',') === 'lite,std,pro', '档位顺序是 轻量→标准→增强', t3.map(t => t.key));

  // ---- 没加载模型时，卸载要安全（不能抛、不能谎报成功）----
  let threw = null;
  let freed = null;
  try { freed = await ai.unload('idle'); } catch (e) { threw = e && e.message; }
  ok(threw === null, '没加载模型时 unload() 不抛异常', threw);
  ok(freed === false, '没加载模型时 unload() 老实返回 false（不谎报已释放）', freed);
  ok(ai.idleSec() === 0, '没 evict 时 idleSec() = 0', ai.idleSec());

  // 连续调用两次也不该出问题（定时器和手动调用可能撞上）
  let second = null;
  try { second = await ai.unload('manual'); } catch (e) { second = 'throw:' + e.message; }
  ok(second === false, '重复 unload() 依然安全', second);

  // ==================== B. 接口级：就绪守卫 ====================
  console.log('\n【B. 五个 AI 接口的就绪守卫】');
  fs.mkdirSync(path.join(TMP, 'messages'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'persons.json'), path.join(TMP, 'persons.json'));
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'messages'))) {
    fs.copyFileSync(path.join(ROOT, 'data', 'messages', f), path.join(TMP, 'messages', f));
  }
  // 模型没就绪就够了：不需要也不能靠"没有 Ollama"来达成这个前提
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      TA_LOVE_DATA: TMP, TA_LOVE_PORT: String(PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  srv.stderr.on('data', d => { srvErr += d.toString(); });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/persons')).ok) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (!up) { console.log('❌ 隔离实例起不来：' + srvErr.slice(0, 400)); srv.kill(); process.exit(1); }

  const ast = await api('GET', '/api/ai/status');
  ok(ast.status === 200 && ast.json && ast.json.ready === false, '隔离实例里 AI 没就绪', ast.json && ast.json.ready);
  ok(ast.json.idleLimit === 120 && 'evicted' in ast.json && 'vram' in ast.json,
    '/api/ai/status 带出了显存治理的新字段', Object.keys(ast.json).filter(k => /idle|evict|vram/.test(k)));

  const d = await api('GET', '/api/person/p-d');
  const payload = (d.json && (d.json.data || d.json)) || {};

  const cases = [
    ['/api/ai/advice', { d: payload }, '狗头军师建议'],
    ['/api/ai/blessing', { d: payload }, '报告结尾寄语'],
    ['/api/ai/todo', { todos: [{ text: '给老妈打电话', done: false }] }, '待办锐评'],
    ['/api/ai/roast', { d: payload }, '锐评（原有的）'],
    ['/api/ai/enrich', { d: payload }, '情感洞察（原有的）'],
  ];
  for (const [p, body, label] of cases) {
    const t0 = Date.now();
    const r = await api('POST', p, body);
    const ms = Date.now() - t0;
    ok(r.status === 503 && /AI|模型/.test(String(r.json && r.json.error)),
      label + '：未就绪时快速失败（' + r.status + ' + 可读提示，' + ms + 'ms）',
      { status: r.status, err: r.json && r.json.error });
    ok(/application\/json/.test(r.type) && r.json && r.json.ok === false && typeof r.json.error === 'string',
      label + '：错误体是结构化 JSON（不再是 null）', { type: r.type, json: r.json });
    ok(ms < 3000, label + '：没有挂住（' + ms + 'ms）', ms);
  }

  // 参数校验只有在「就绪」之后才轮得到，这里只能确认它没有抢在守卫前面
  const empty = await api('POST', '/api/ai/todo', { todos: [] });
  ok(empty.status === 503, '空清单也先走就绪守卫，不会先报参数错（' + empty.status + '）', empty.status);

  const badRoute = await api('POST', '/api/ai/nothing', {});
  ok(badRoute.status === 404, '不存在的 AI 接口不冒充成功', badRoute.status);

  srv.kill();
  await sleep(400);
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})();
