// ai.js —— 本地小 AI（双后端）
//
// 后端一 ollama  ：本机已装 Ollama → 零下载，直接复用它的模型（本机首选）
// 后端二 builtin ：内置 node-llama-cpp + GGUF，三档可选、首次下载（分发给别人走这条）
//
// 提示词全部内置在本文件（ROAST_SYSTEM 等），模型一就绪自动套用，用户不需要输入任何 prompt。
// 全程本地，不联网上传聊天内容。

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ==================== 一、内置模型档位（内置下载用）====================
// 均为 Qwen2.5-Instruct GGUF（Q4_K_M），单文件、免登录、国内直连。
// 主源 ModelScope（阿里，国内快），备源为另一仓库；sources 按顺序重试。
// minVRAM 是「建议显存下限」：低于它模型会部分挤进内存，明显变慢但还能跑。
// sizeGB 为实测文件体积（1 GB = 1024³ 字节）。
const TIERS = [
  {
    key: 'lite', label: '轻量', params: '3B',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeGB: 2.0, minVRAM: 4,
    desc: '核显 / 老笔记本也能跑，出字最快',
    sources: [
      'https://modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q4_k_m.gguf',
      'https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    ],
  },
  {
    key: 'std', label: '标准', params: '7B',
    file: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    sizeGB: 4.4, minVRAM: 6,
    desc: '主流独显，锐评质量与速度平衡（推荐）',
    sources: [
      'https://modelscope.cn/models/QuantFactory/Qwen2.5-7B-Instruct-GGUF/resolve/master/Qwen2.5-7B-Instruct.Q4_K_M.gguf',
      'https://modelscope.cn/models/second-state/Qwen2.5-7B-Instruct-GGUF/resolve/master/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    ],
  },
  {
    key: 'pro', label: '增强', params: '14B',
    file: 'qwen2.5-14b-instruct-q4_k_m.gguf',
    sizeGB: 8.4, minVRAM: 11,
    desc: '大显存专用，更懂话里的弦外之音',
    sources: [
      'https://modelscope.cn/models/QuantFactory/Qwen2.5-14B-Instruct-GGUF/resolve/master/Qwen2.5-14B-Instruct.Q4_K_M.gguf',
      'https://modelscope.cn/models/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/master/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    ],
  },
];
const DEFAULT_TIER = 'std';
const CONTEXT_SIZE = 4096;

// ==================== 二、内置提示词 ====================
// 提示词写死在这里：模型准备好就自动生效，用户不用填、也不会每次被问。
// 核心约束是「必须引用真实数字 + 不许编造聊天内容」——小模型最容易在这里翻车。

const ROAST_SYSTEM = `你是一个中文关系观察者，专门看情侣的聊天统计数据，写「人间清醒」式的锐评。

【风格】
- 毒舌但不刻薄，像朋友饭桌上那种一针见血
- 说人话、接地气，不要心理咨询师腔调
- 短句为主，一句一个意思

【铁律】
1. 必须引用给你的真实数字（消息数/天数/秒回/占比/次数），不许自己编造数字
2. 不许编造聊天内容、人名、具体事件——你只有统计数据，没有聊天原文
3. 不做道德判断，不劝分不劝和，只描述你看到的模式
4. 不写「建议你们多沟通」这类正确的废话
5. 直接输出锐评正文，不要开场白、不要标题、不要编号、不要解释
6. 不涉及性、身体、外貌；不用「舔狗」「备胎」「废料」「炮友」这类贬低人的词
7. 可以毒舌，但落点是「帮你看清相处模式」，不是羞辱当事人；读完要让人会心一笑，不是难受
8. 不要把统计念一遍。挑 2 到 3 个最能说明问题的数字，用它们支撑你的观点；
   像「X 天、Y 条、Z 分、W%」这样挨个报数是流水账，不算锐评
9. 分清楚「我」和「TA」是两个人。谁主动、谁回得快、谁发表情，别张冠李戴

【示例】
数据：消息 8421 条，跨度 400 天，TA 平均 45 秒回我，我平均 12 分钟回 TA；我主动发起 78 分，TA 敷衍度 12 分。
锐评：8421 条消息里，你回一条要 12 分钟，TA 回你只花 45 秒。78 分的主动度摆在这儿，这场对话谁更用力，数据比你诚实。好消息是 TA 敷衍度只有 12 分，人没跑，就是腿长在你身上。

【反例（别这样写）】
聊天 8421 条，跨度 400 天，TA 45 秒回我，我 12 分钟回 TA，我主动 78 分，TA 敷衍 12 分。
——这是报菜名，不是锐评。数字要用来证明一个观点，不是清单。`;

const MOOD_SYSTEM = `你是中文聊天关系分析助手，语气毒舌但友好、接地气。
不涉及性、身体、外貌，不用贬低人的词；毒舌的落点是帮人看清相处状态，不是羞辱。
只输出被要求的内容，不要开场白、不要解释、不要编号。`;

const INSIGHT_SYSTEM = `你是中文关系观察者，能点破双方都没意识到的相处模式。
不涉及性、身体、外貌，不用贬低人的词。
只输出被要求的内容，不要解释、不要编号、不要用「多沟通」这类空话。`;

// ==================== 三、运行时状态 ====================
const state = {
  backend: 'none',        // 'ollama' | 'builtin' | 'none'
  ready: false,           // 模型已就绪、可生成
  downloading: false,
  progress: 0,
  recvBytes: 0,           // 已下载字节（用于显示 MB 进度）
  totalBytes: 0,
  error: null,
  tier: DEFAULT_TIER,     // 内置模式当前档位
  model: null,            // 当前实际使用的模型名
  installed: false,       // 内置模式下模型文件是否已存在
  ollamaModels: [],       // Ollama 可用模型
  ollamaReady: false,
};

let modelDir = null;

// 内置 llama.cpp 资源
let llama = null, model = null, context = null;
let loadPromise = null, setupPromise = null;
let loadedTier = null;

// ==================== 四、工具 ====================
function tierOf(key) { return TIERS.find(t => t.key === key) || TIERS.find(t => t.key === DEFAULT_TIER); }
function modelPath(tier) { return path.join(modelDir, tierOf(tier).file); }
function installed(tier) {
  try { return fs.existsSync(modelPath(tier || state.tier)); } catch (e) { return false; }
}
function installedTiers() { return TIERS.filter(t => installed(t.key)).map(t => t.key); }

function requestJSON(url, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' ' + buf.slice(0, 200)));
        }
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回不是 JSON')); }
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

// ==================== 五、Ollama 后端 ====================
function ollamaBase() {
  const h = (process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '');
  return 'http://' + h;
}

// 这些模型不适合做锐评：推理型会把正文写进 thinking，视觉型不是纯文本模型
const OLLAMA_BAD = [
  { re: /deepseek-r1|qwq|reasoning/i, why: '推理型模型，正文会被思考过程吃掉' },
  { re: /llava|minicpm-v|vision|-vl|bakllava/i, why: '视觉模型，不是纯文本对话模型' },
];
// 中文锐评表现更好的系列，UI 上标「推荐」
const OLLAMA_GOOD = /qwen|glm|gemma|yi-|internlm|baichuan|phi-4|minicpm3/i;

async function detectOllama() {
  try {
    const j = await requestJSON(ollamaBase() + '/api/tags', null, 2500);
    const list = (j && j.models) || [];
    state.ollamaModels = list.map(m => {
      const name = m.name || m.model || '';
      const bad = OLLAMA_BAD.find(b => b.re.test(name));
      return {
        name,
        sizeGB: Math.round(((m.size || 0) / 1073741824) * 10) / 10,
        params: (m.details && m.details.parameter_size) || '',
        quant: (m.details && m.details.quantization_level) || '',
        usable: !bad,
        note: bad ? bad.why : (OLLAMA_GOOD.test(name) ? '中文锐评推荐' : ''),
      };
    });
    state.ollamaReady = true;
    return state.ollamaModels;
  } catch (e) {
    state.ollamaReady = false;
    state.ollamaModels = [];
    return [];
  }
}

// 从本机 Ollama 里挑一个适合做锐评的默认模型：中文好的系列优先，其次看体积。
// 太大（>10GB）出词慢，太小质量不够，3–10GB 是甜点区间。
function pickBestOllama() {
  const usable = state.ollamaModels.filter(m => m.usable && !/cloud/i.test(m.name));
  if (!usable.length) return null;
  const score = (m) => {
    let s = 0;
    if (/qwen/i.test(m.name)) s += 100;
    else if (/glm/i.test(m.name)) s += 90;
    else if (/gemma|yi-|internlm|baichuan/i.test(m.name)) s += 80;
    else s += 50;
    const gb = m.sizeGB || 0;
    if (gb >= 3 && gb <= 10) s += 50;
    else if (gb > 10) s -= 40;
    else if (gb > 0) s += 10;
    return s;
  };
  return usable.slice().sort((a, b) => score(b) - score(a))[0];
}

// 预热：发一个极短请求把模型加载进显存，免得用户第一次点锐评干等二十秒
async function warmup() {
  if (state.backend !== 'ollama' || !state.model) return;
  try {
    const body = JSON.stringify({
      model: state.model,
      stream: false,
      think: false,
      messages: [{ role: 'user', content: '你好' }],
      options: { num_predict: 1, num_ctx: 512 },
      keep_alive: '15m',
    });
    await requestJSON(ollamaBase() + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    }, 300000);
  } catch (e) { /* 预热失败不影响主流程 */ }
}

// 给 Ollama 发一次对话请求。think:false 关掉思考过程（对不支持该参数的模型无害）
async function ollamaChat(modelName, system, user, maxTokens, temperature) {
  const body = JSON.stringify({
    model: modelName,
    stream: false,
    think: false,
    keep_alive: '15m',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    options: { temperature: temperature || 0.8, top_p: 0.9, num_ctx: CONTEXT_SIZE, num_predict: maxTokens || 400 },
  });
  const j = await requestJSON(ollamaBase() + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  }, 180000);
  const msg = (j && j.message) || {};
  const text = (msg.content || '').trim();
  if (!text && msg.thinking) {
    throw new Error('这个模型把正文写进了思考过程（推理型模型），换一个对话模型试试，比如 qwen 或 glm 系列');
  }
  return text;
}

// ==================== 六、内置 llama.cpp 后端 ====================
// 支持断点续传：中断后重来会从 .part 的已有大小接着下（14B 有 8.4 GB，重头下太伤）。
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    let redirects = 0;
    let resumeFrom = 0;
    try { resumeFrom = fs.statSync(tmp).size; } catch (e) { resumeFrom = 0; }

    const attempt = (u, from) => {
      const lib = u.startsWith('https') ? https : http;
      const headers = { 'User-Agent': 'xiangyong-app/0.4' };
      if (from > 0) headers['Range'] = 'bytes=' + from + '-';
      const req = lib.get(u, { headers }, (res) => {
        // 跟随重定向（ModelScope 会 302 到 OSS）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (++redirects > 8) return reject(new Error('重定向次数过多'));
          return attempt(new URL(res.headers.location, u).toString(), from);
        }
        // 416 = 请求的区间超出文件长度，说明本地已下完
        if (res.statusCode === 416) {
          res.resume();
          try { fs.renameSync(tmp, dest); return resolve(); }
          catch (e) { return reject(e); }
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const partial = res.statusCode === 206;
        const base = partial ? from : 0;                 // 服务端不支持 Range 时从头写
        const len = parseInt(res.headers['content-length'] || '0', 10);
        const total = len ? len + base : 0;
        let received = base;
        const ws = fs.createWriteStream(tmp, { flags: base > 0 ? 'a' : 'w' });
        res.on('data', (c) => {
          received += c.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(ws);
        ws.on('finish', () => {
          ws.close(() => {
            if (total && received < total) return reject(new Error('连接中断，已下载 ' + received + '/' + total));
            try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
          });
        });
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    };
    attempt(url, resumeFrom);
  });
}

// 让出错信息带上「可续传」的提示
function friendlyDownloadError(e) {
  const m = (e && e.message) || '未知错误';
  if (/中断|超时|ECONNRESET|socket hang up|ETIMEDOUT/i.test(m)) {
    return '下载中断（' + m + '）。已下载的部分保留着，再点一次会接着下。';
  }
  return '下载失败：' + m;
}

async function downloadTier(tierKey, onProgress) {
  const t = tierOf(tierKey);
  const dest = modelPath(t.key);
  if (fs.existsSync(dest)) return dest;
  let lastErr = null;
  for (const url of t.sources) {
    try { await downloadFile(url, dest, onProgress); return dest; }
    catch (e) { lastErr = e; }
  }
  throw new Error(friendlyDownloadError(lastErr));
}

async function loadBuiltin(tierKey) {
  const t = tierOf(tierKey);
  if (state.ready && loadedTier === t.key && state.backend === 'builtin') return;
  if (loadPromise && loadedTier === t.key) return loadPromise;
  loadedTier = t.key;
  loadPromise = (async () => {
    const { getLlama } = await import('node-llama-cpp');
    // GPU 选择顺序：Vulkan 优先（一个 95MB 的包就通吃 NVIDIA / AMD / Intel，不需要用户装 CUDA 工具链），
    // 不行再交给 auto，最后退回 CPU。注意别让 auto 去试 CUDA——那会触发 cmake 现场编译，包给用户必然失败。
    try {
      llama = await getLlama({ gpu: 'vulkan' });
    } catch (e1) {
      try { llama = await getLlama({ gpu: 'auto' }); }
      catch (e2) { llama = await getLlama({ gpu: false }); }
    }
    if (model) { try { await model.dispose(); } catch (e) {} model = null; context = null; }
    model = await llama.loadModel({ modelPath: modelPath(t.key) });
    context = await model.createContext({ contextSize: CONTEXT_SIZE });
    // 后端/模型名在这里一起落定：以「真正加载成功的东西」为准，避免并发时状态错位
    state.backend = 'builtin';
    state.ready = true;
    state.model = t.file;
  })();
  return loadPromise;
}

async function builtinChat(system, user, maxTokens, temperature) {
  const { LlamaChatSession } = await import('node-llama-cpp');
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: system,
    autoDisposeSequence: true,
  });
  try {
    return (await session.prompt(user, {
      maxTokens: maxTokens || 400, temperature: temperature || 0.8, topP: 0.9,
    })).trim();
  } finally {
    session.dispose({ disposeSequence: true });
  }
}

// ==================== 七、统一对外接口 ====================
function init(dir) {
  modelDir = path.join(dir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  state.installed = installed(state.tier);
  detectOllama(); // 异步探测，结果写回 state
}

function status() {
  return {
    backend: state.backend,
    ready: state.ready,
    downloading: state.downloading,
    progress: Math.round(state.progress * 100),
    downloadedMB: Math.round((state.recvBytes || 0) / 1048576),
    totalMB: Math.round((state.totalBytes || 0) / 1048576),
    installed: state.installed,
    error: state.error,
    tier: state.tier,
    model: state.model,
    tiers: TIERS.map(t => ({
      key: t.key, label: t.label, params: t.params, sizeGB: t.sizeGB,
      minVRAM: t.minVRAM, desc: t.desc, installed: installed(t.key),
    })),
    installedTiers: installedTiers(),
    ollamaReady: state.ollamaReady,
    ollamaModels: state.ollamaModels,
  };
}

// 准备模型：优先挑本机 Ollama，其次用内置档位下载
async function setup(opts) {
  const o = opts || {};
  state.error = null;
  if (o.tier) state.tier = tierOf(o.tier).key;

  // 明确指定 Ollama
  if (o.backend === 'ollama' || o.model) {
    if (!state.ollamaReady) await detectOllama();
    if (state.ollamaReady) {
      let name = o.model;
      if (!name) {
        const best = pickBestOllama();
        name = best && best.name;
      }
      if (!name) { state.error = 'Ollama 里没有可用的对话模型'; return status(); }
      state.backend = 'ollama';
      state.model = name;
      state.ready = true;
      warmup(); // 后台预热，用户第一次点锐评就不用干等
      return status();
    }
    if (o.backend === 'ollama') { state.error = '没有检测到 Ollama 服务'; return status(); }
  }

  // 没指定后端：先看 Ollama 在不在，在就直接用（零下载）
  if (!o.backend) {
    if (!state.ollamaReady) await detectOllama();
    if (state.ollamaReady) {
      const best = pickBestOllama();
      if (best) {
        state.backend = 'ollama';
        state.model = best.name;
        state.ready = true;
        warmup();
        return status();
      }
    }
  }

  // 内置模式
  state.backend = 'builtin';
  if (setupPromise && loadedTier === state.tier) return setupPromise;
  setupPromise = (async () => {
    try {
      state.downloading = true;
      state.progress = 0;
      state.recvBytes = 0;
      state.totalBytes = 0;
      if (!installed(state.tier)) {
        await downloadTier(state.tier, (recv, total) => {
          state.recvBytes = recv;
          state.totalBytes = total;
          state.progress = total ? recv / total : 0;
        });
      }
      state.progress = 1;
      await loadBuiltin(state.tier);
      state.installed = true;
      state.model = tierOf(state.tier).file;
      state.ready = true;
    } catch (e) {
      state.error = (e && e.message) ? e.message : String(e);
      state.ready = false;
      setupPromise = null;   // 允许用户再点一次重试（已下载的部分会续传）
    } finally {
      state.downloading = false;
    }
    return status();
  })();
  return setupPromise;
}

// 兼容旧调用
async function ensureModel() {
  if (state.ready) return status();
  // 已有一次「准备」在进行中（典型是内置模型正在下载/加载），等它，不要再发起一次——
  // 否则会自动挑 Ollama 并把下载好的内置模型状态冲掉。
  if (setupPromise) return setupPromise;
  return setup({});
}

// 统一生成：自动走当前后端
async function chat(system, user, maxTokens, temperature) {
  if (state.backend === 'ollama') {
    if (!state.ollamaReady) await detectOllama();
    if (!state.ollamaReady) throw new Error('Ollama 服务不可用，请先启动 Ollama');
    return ollamaChat(state.model, system, user, maxTokens, temperature);
  }
  if (!state.ready) await ensureModel();
  if (!state.ready) throw new Error(state.error || '模型未就绪');
  return builtinChat(system, user, maxTokens, temperature);
}

// 把分析结果压成一段紧凑统计，供模型阅读
function buildSummary(d) {
  const g = {};
  for (const x of (d.gauges || [])) g[x.key] = x.value;
  const words = (arr) => (arr || []).slice(0, 3).map((w) => w.w).join('、');
  const likeArr = [...((d.likes && d.likes.me) || []), ...((d.likes && d.likes.ta) || [])];
  const likes = likeArr.slice(0, 5).map((l) => l.text).join('、');
  const p = [];
  p.push(`昵称「${d.name || 'TA'}」`);
  p.push(`消息 ${d.msgCount || 0} 条，跨度 ${Math.round((d.spans && d.spans.days) || 0)} 天，日均 ${Math.round(d.dailyMsg || 0)} 条`);
  if (d.coldDays >= 0) p.push(`已 ${d.coldDays} 天没联系`);
  p.push(`正向情绪占比 ${Math.round((d.sentiment && d.sentiment.positivePct) || 0)}%`);
  p.push(`我主动发起 ${Math.round(g.active || 0)} 分(越高我越主动)，TA回应热情 ${Math.round(g.loved || 0)} 分(越高越热情)，TA敷衍度 ${Math.round(g.cold || 0)} 分(越高越敷衍)`);
  const rp = d.reply || {};
  if (rp.taMid) p.push(`TA 平均 ${Math.round(rp.taMid)} 秒回我，我平均 ${Math.round((rp.meMid || 0) / 60)} 分钟回 TA`);
  const wMe = words(d.topWords && d.topWords.me), wTa = words(d.topWords && d.topWords.ta);
  if (wMe || wTa) p.push(`高频词：我「${wMe || '无'}」 TA「${wTa || '无'}」`);
  const is = d.imgStats || {};
  if ((is.emojiTotal || 0) > 0) p.push(`表情 ${is.emojiTotal} 个，TA 发图 ${is.taImg || 0} 张、表情 ${is.taEmoji || 0} 个`);
  if (likes) p.push(`共同喜好：${likes}`);
  if (d.nextAnniversary) p.push(`临近：${d.nextAnniversary.label} 还有 ${d.nextAnniversary.days} 天`);
  return p.join('；');
}

// 只清「列表序号 / 项目符号 / 标题符号」这类噪音。
// 关键：序号限定 1-2 位数字，否则「10348 条消息…」开头的数字会被整段吃掉。
const LEAD_NOISE = /^\s*(?:(?:[1-9]\d?\s*[.、)）]\s*)|(?:[-*·•]\s+)|(?:#+\s*))+/;
const trimQuote = (s) => String(s || '').replace(/^[「『"“']+/, '').replace(/[」』"”']+$/, '');
const stripLead = (t) => trimQuote(String(t || '')
  .replace(LEAD_NOISE, '')
  .replace(/^\s*(?:锐评|点评|一句话概括|总结)\s*[:：]\s*/, '')
  .trim());
const toLines = (t) => String(t || '').split(/\r?\n/)
  .map(l => trimQuote(l.replace(LEAD_NOISE, '').trim()))
  .filter(l => l.length >= 4);

// 防编造：把摘要里的数字抠出来，回头校验模型有没有真的引用。
// 用「前后不能再挨着数字」的边界匹配，否则「6」会在「1610」里误命中。
function numbersIn(s) {
  return [...new Set(String(s || '').match(/\d+(?:\.\d+)?/g) || [])];
}
function hasNumber(text, n) {
  try {
    return new RegExp('(?<!\\d)' + String(n).replace(/\./g, '\\.') + '(?!\\d)').test(text);
  } catch (e) {
    return String(text).includes(n);   // 老 Node 不支持 lookbehind 时降级
  }
}
function citedNumbers(text, nums) {
  return nums.filter(n => hasNumber(text, n));
}

// ---- 主接口一：AI 锐评（原本被模板顶替、现在真正接上模型的那块）----
async function roast(d) {
  if (!state.ready) await ensureModel();
  if (!state.ready) throw new Error(state.error || 'AI 未就绪');
  const s = buildSummary(d);
  const nums = numbersIn(s);
  const strong = nums.filter(n => n.length >= 2);   // 单数字容易巧合命中，只拿两位以上的当证据
  const ask = `以下是 TA 与「我」的聊天统计：${s}\n请写一段锐评，90 到 150 字，必须引用至少两个上面出现过的具体数字。`;

  let text = await chat(ROAST_SYSTEM, ask, 420, 0.85);
  let cited = citedNumbers(text, strong);

  // 小模型偶尔会自己编数字（编出来的数字比模板更糟），给它一次纠正机会。
  // 只在「一个真数字都没引用到」时才重来——那基本等于在瞎编；引用到 1 个就放过，避免白白多等一轮。
  if (strong.length >= 2 && cited.length === 0) {
    const retry = await chat(
      ROAST_SYSTEM,
      `${ask}\n\n注意：你上一次的回答没有引用到足够的真实数字。你只允许使用这些数字：${strong.join('、')}。除此之外一个数字都不许写，不许编造。`,
      420, 0.7
    );
    const c2 = citedNumbers(retry, strong);
    if (c2.length > cited.length) { text = retry; cited = c2; }
  }

  return {
    ok: true,
    roast: stripLead(text),
    backend: state.backend,
    model: state.model,
    cited: cited.slice(0, 8),
    grounded: cited.length >= 2,   // 前端据此决定要不要加一句「这次没引用到真实数字」
  };
}

// ---- 主接口二：情感基调 + 关系洞察 ----
async function aiAnalyze(d) {
  if (!state.ready) await ensureModel();
  if (!state.ready) throw new Error(state.error || 'AI 未就绪');
  const s = buildSummary(d);
  const mood = await chat(
    MOOD_SYSTEM,
    `以下是 TA 与「我」的聊天统计：${s}\n请用一句话（不超过40字）概括这段关系的整体情感基调与相处状态，必须引用至少一个具体数字。`,
    90, 0.8
  );
  const insightText = await chat(
    INSIGHT_SYSTEM,
    `聊天统计：${s}\n请写 2 到 3 条关系洞察：要具体、有依据、可执行，必须基于上面数字，避免空泛的「多沟通」，每条不超过 45 字，每条单独一行。`,
    260, 0.8
  );
  return {
    ok: true,
    mood: stripLead(mood),
    insights: toLines(insightText).slice(0, 3),
    backend: state.backend,
    model: state.model,
  };
}

module.exports = {
  init, status, ensureModel, setup, detectOllama, roast, aiAnalyze, chat, installed, TIERS,
};
