// ai.js —— 本地小AI（node-llama-cpp + Qwen2.5-1.5B GGUF）
// 职责：首次启动下载模型、懒加载到内存、做「情感基调 / AI锐评 / 关系洞察」三件事。
// 全程本地，不联网上传。node-llama-cpp 是 ESM，这里用动态 import 加载（server.js 是 CommonJS）。
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const MODEL_FILE = 'qwen2.5-3b-instruct-q4_k_m.gguf';
// 下载源：国内镜像优先，官方源兜底（会跟随 302 跳转到真实 CDN）
const MODEL_MIRRORS = [
  'https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/' + MODEL_FILE,
  'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/' + MODEL_FILE,
];
const CONTEXT_SIZE = 2048; // 足够三段短生成；1.5B Q4 下 KV 缓存占用可控

let modelDir = null;
const state = { ready: false, downloading: false, progress: 0, error: null };
let llama = null, model = null, context = null;
let loadPromise = null, setupPromise = null;

function init(dataDir) {
  modelDir = path.join(dataDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
}
function modelPath() { return path.join(modelDir, MODEL_FILE); }
function installed() { return fs.existsSync(modelPath()); }
function status() {
  return {
    ready: state.ready,
    downloading: state.downloading,
    progress: Math.round(state.progress * 100),
    installed: installed(),
    model: MODEL_FILE,
    error: state.error,
  };
}

// ---- 下载（跟随重定向 + 进度回调）----
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const tmp = dest + '.part';
    const attempt = (u) => {
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, { headers: { 'User-Agent': 'xiangyong-app/0.3' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (++redirects > 8) return reject(new Error('重定向次数过多'));
          return attempt(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const ws = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          received += c.length;
          if (total && onProgress) onProgress(received / total);
        });
        res.pipe(ws);
        ws.on('finish', () => { ws.close(() => { fs.renameSync(tmp, dest); resolve(); }); });
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
    };
    attempt(url);
  });
}

function ensureModel(onProgress) {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      state.downloading = true;
      state.error = null;
      state.progress = 0;
      if (!installed()) {
        let lastErr = null;
        for (const m of MODEL_MIRRORS) {
          try { await downloadFile(m, modelPath(), (p) => { state.progress = p; if (onProgress) onProgress(p); }); lastErr = null; break; }
          catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
      }
      state.progress = 1;
      await loadModel();
      state.downloading = false;
      state.ready = true;
      return status();
    } catch (e) {
      state.downloading = false;
      state.error = e && e.message ? e.message : String(e);
      return status();
    }
  })();
  return setupPromise;
}

async function loadModel() {
  if (state.ready) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { getLlama } = await import('node-llama-cpp');
    llama = await getLlama({ gpu: false }); // ponytail: 强制 CPU，避免依赖 CUDA/Vulkan 二进制，1.5B 够快
    model = await llama.loadModel({ modelPath: modelPath() });
    context = await model.createContext({ contextSize: CONTEXT_SIZE });
    state.ready = true;
  })();
  return loadPromise;
}

// 生成一段文本：每次新建独立会话（自动释放序列），互不污染上下文
async function gen(systemPrompt, userPrompt, maxTokens) {
  const { LlamaChatSession } = await import('node-llama-cpp');
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt,
    autoDisposeSequence: true,
  });
  try {
    return (await session.prompt(userPrompt, { maxTokens, temperature: 0.7, topP: 0.9 })).trim();
  } finally {
    session.dispose({ disposeSequence: true });
  }
}

// 把分析结果压成一段紧凑统计，供模型阅读
function buildSummary(d) {
  const g = {};
  for (const x of (d.gauges || [])) g[x.key] = x.value;
  const words = (arr) => (arr || []).slice(0, 3).map((w) => w.w).join('、');
  const likeArr = [...(d.likes && d.likes.me || []), ...(d.likes && d.likes.ta || [])];
  const likes = likeArr.slice(0, 5).map((l) => l.text).join('、');
  const p = [];
  p.push(`昵称「${d.name || 'TA'}」`);
  p.push(`消息 ${d.msgCount || 0} 条，跨度 ${Math.round((d.spans && d.spans.days) || 0)} 天，日均 ${Math.round(d.dailyMsg || 0)} 条`);
  if (d.coldDays >= 0) p.push(`已 ${d.coldDays} 天没联系`);
  p.push(`正向情绪占比 ${Math.round((d.sentiment && d.sentiment.positivePct) || 0)}%`);
  p.push(`我主动发起 ${Math.round(g.active || 0)} 分(越高我越主动)，TA回应热情 ${Math.round(g.loved || 0)} 分(越高越热情)，TA敷衍度 ${Math.round(g.cold || 0)} 分(越高越敷衍)`);
  const rp = d.reply || {};
  if (rp.taMid) p.push(`TA 平均 ${Math.round(rp.taMid)} 秒回我，我平均 ${Math.round((rp.meMid || 0) / 60)} 分钟回 TA`);
  if (words(d.topWords && d.topWords.me) || words(d.topWords && d.topWords.ta)) p.push(`高频词：我「${words(d.topWords && d.topWords.me) || '无'}」 TA「${words(d.topWords && d.topWords.ta) || '无'}」`);
  const is = d.imgStats || {};
  if ((is.emojiTotal || 0) > 0) p.push(`表情 ${is.emojiTotal} 个，TA 发图 ${is.taImg || 0} 张、表情 ${is.taEmoji || 0} 个`);
  if (likes) p.push(`共同喜好：${likes}`);
  if (d.nextAnniversary) p.push(`临近：${d.nextAnniversary.label} 还有 ${d.nextAnniversary.days} 天`);
  return p.join('；');
}

// 两段生成：情感基调 / 关系洞察（锐评保留服务端精修模板，小模型不适合做数据精准的毒舌锐评）
async function aiAnalyze(d) {
  if (!state.ready) throw new Error('AI 未就绪');
  const s = buildSummary(d);
  const mood = await gen(
    '你是一个中文聊天关系分析助手，语气毒舌但友好、接地气、一针见血。只输出被要求的内容，不解释。',
    `以下是 TA 与「我」的聊天统计：${s}\n请用一句话（不超过40字）概括这段关系的整体情感基调与相处状态，必须引用至少一个具体数字。`,
    80
  );
  const insightText = await gen(
    '你是中文关系观察者，能点破双方都没意识到的相处模式。只输出被要求的内容，不要解释、不要编号。',
    `聊天统计：${s}\n请写 2 到 3 条关系洞察：要具体、有依据、可执行，必须基于上面数字，避免空泛的「多沟通」，每条不超过 45 字，每条单独一行。`,
    220
  );
  const toLines = (t) => t.split(/\r?\n/).map((l) => l.replace(/^[\s\d\.、\-*·]+/, '').trim()).filter((l) => l.length >= 4);
  return {
    ok: true,
    mood: mood.replace(/^[\s\d\.、\-*·]+/, '').trim(),
    insights: toLines(insightText).slice(0, 3),
  };
}

module.exports = { init, status, ensureModel, aiAnalyze, installed };
