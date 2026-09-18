// ai.js —— 本地小 AI（内置后端）
//
// 一台机器上跑推理，只有「随包带上推理引擎」这一条路是可控的：
//   内置 node-llama-cpp + GGUF，三档可选、首次下载。
// 之前还支持「复用本机已装的 Ollama」，打包分发时那条路是纯负担 ——
// 用户机器上多半没有 Ollama，留着它只会多一套探测/预热/卸载分支和一个永远探测失败的状态字段。
// 现在只留内置这一条，AI_IDLE_SEC 那条「闲置归还显存」的逻辑也一条路走到底。
//
// 提示词全部内置在本文件（ROAST_SYSTEM 等），模型一就绪自动套用，用户不需要输入任何 prompt。
// 全程本地，不联网上传聊天内容（只有首次下载模型时会联网）。

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ==================== 一、内置模型档位（内置下载用）====================
// 均为 Qwen2.5-Instruct GGUF（Q4_K_M），单文件、免登录、国内直连。
// 主源 ModelScope（阿里，国内快），备源为另一仓库；sources 按顺序重试。
// minVRAM 是「建议显存下限」：低于它模型会部分挤进内存，明显变慢但还能跑。
// sizeGB 为实测文件体积（1 GB = 1024³ 字节）。
//
// 每条源都带 sha256，下完流式校验一遍，对不上就删掉换下一条源。
// 它拦得住的是「传输/拼装层出的错」：分段重连时某一段写错位、被 CDN 塞了错误页、
// 或者源地址指向了另一个文件——这些大小和 HTTP 200 都看不出来。
// 它拦不住的是「仓库里发的那个文件本身就有毛病」：那种文件的哈希也是对的。
// 后者只能靠选可信的转换方来规避——我们用 bartowski（llama.cpp 生态最主流、可复现的转换仓库）。
// 这两件事要分开看，别指望哈希能兜住模型质量。
const TIERS = [
  {
    key: 'lite', label: '轻量', params: '3B',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeGB: 2.0, minVRAM: 4,
    desc: '核显 / 老笔记本也能跑，出字最快',
    sources: [
      { url: 'https://modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q4_k_m.gguf',
        sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d' },
      { url: 'https://modelscope.cn/models/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/master/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
        sha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94' },
    ],
  },
  {
    key: 'std', label: '标准', params: '7B',
    file: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    sizeGB: 4.4, minVRAM: 6,
    desc: '主流独显，锐评质量与速度平衡（推荐）',
    sources: [
      { url: 'https://modelscope.cn/models/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/master/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423' },
      { url: 'https://modelscope.cn/models/second-state/Qwen2.5-7B-Instruct-GGUF/resolve/master/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        sha256: 'a30c3c08ca3284a7b59fa35cd835ec50b4a54e211379692b0e48a34bdb72c2fb' },
    ],
  },
  {
    key: 'pro', label: '增强', params: '14B',
    file: 'qwen2.5-14b-instruct-q4_k_m.gguf',
    sizeGB: 8.4, minVRAM: 11,
    desc: '大显存专用，更懂话里的弦外之音',
    sources: [
      { url: 'https://modelscope.cn/models/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/master/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
        sha256: 'e47ad95dad6ff848b431053b375adb5d39321290ea2c638682577dafca87c008' },
      { url: 'https://modelscope.cn/models/second-state/Qwen2.5-14B-Instruct-GGUF/resolve/master/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
        sha256: '298cb13fa9435de353bb788d37f88e7efae62155ebeff6197a0f4938813ca02c' },
    ],
  },
];
const DEFAULT_TIER = 'std';
const CONTEXT_SIZE = 4096;

// 显存闲置上限：多久没人用 AI，就把模型从显存里卸下来。
// 本机 8.55 GB 显存要和游戏共存，模型挂着不动也一直占着，所以一闲就还回去。
// 到点我们自己 dispose，下次要用再从磁盘 mmap 装回来（秒级）。
const AI_IDLE_SEC = 120;

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
  backend: 'none',        // 'builtin' | 'none'
  ready: false,           // 模型已就绪、可生成
  downloading: false,
  progress: 0,
  recvBytes: 0,           // 已下载字节（用于显示 MB 进度）
  totalBytes: 0,
  speedBps: 0,            // 平滑后的下载速度，用来估剩余时间
  etaSec: 0,
  verifying: false,       // 下完了正在算 sha256
  error: null,
  tier: DEFAULT_TIER,     // 当前档位
  model: null,            // 当前实际使用的模型文件
  installed: false,       // 模型文件是否已存在（且哈希对得上）
  // ---- 显存治理 ----
  // evicted: 模型已从显存卸下（ready 仍为 true —— 对用户来说它还是「可用」的，
  //   只是下次调用要先装回来）。用它区分「没启用」和「用了但闲时已归还显存」。
  evicted: false,
  evictedAt: 0,           // 卸下时刻，前端算「闲置多久了」
  evictReason: '',        // 'idle' | 'manual'
  lastLoadMs: 0,          // 上次装回显存耗时，量一下才知道「要不要等」
  lastUsedAt: 0,          // 最后一次真正跑推理的时刻
};

let modelDir = null;

// 内置 llama.cpp 资源
let llama = null, model = null;
let loadPromise = null, setupPromise = null;
let loadedTier = null;
let idleTimer = null;

// ==================== 显存治理：闲置到点就把模型还回去 ====================
// 用户诉求原话是「搬到内存并压缩体积」。实测下来的结论是：
// 权重搬进内存反而多占 4 GB 常驻，而显存该占的还是占（Vulkan 后端本身也要显存）；
// 真正有效且无损体验的做法是「卸下 → 用时从磁盘 mmap 装回」，
// 因为文件内容早就在 OS 页缓存里，重装是秒级的（见 status().lastLoadMs）。
function touchIdle() {
  state.lastUsedAt = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { unload('idle'); }, AI_IDLE_SEC * 1000);
  // 别让这个定时器成为进程存活的唯一理由（测试里会被它拖住）
  if (idleTimer.unref) idleTimer.unref();
}

// 把模型从显存里清干净
async function unload(reason) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (state.backend !== 'builtin' || !model) return false;
  // context 是每次生成临时建的，这里要放的是 model 和 llama 后端本身
  // —— Vulkan 后端自己就占一块显存，只 dispose model 是不够的。
  try { await model.dispose(); } catch (e) {}
  model = null;
  try { if (llama) await llama.dispose(); } catch (e) {}
  llama = null;
  loadPromise = null;
  loadedTier = null;
  state.evicted = true;
  state.evictedAt = Date.now();
  state.evictReason = reason || 'idle';
  return true;
}

// 闲置多少秒了（前端拿它显示「已归还显存 · 闲置 N 分钟」）
function idleSec() {
  if (!state.evicted) return 0;
  return Math.round((Date.now() - state.evictedAt) / 1000);
}

// ==================== 四、工具 ====================
function tierOf(key) { return TIERS.find(t => t.key === key) || TIERS.find(t => t.key === DEFAULT_TIER); }
function modelPath(tier) { return path.join(modelDir, tierOf(tier).file); }

// 下载完成、哈希校验通过后落一个同名 .sha256 小文件当「合格证」。
// 之后判断「装没装」只看这个证，不用每次去重算 4.6 GB——那要十几秒。
function stampPath(tier) { return modelPath(tier) + '.sha256'; }
function readStamp(tier) { try { return fs.readFileSync(stampPath(tier), 'utf8').trim(); } catch (e) { return ''; } }

// 流式算哈希：4~8 GB 的文件不能整个读进内存
function sha256File(p, onTick) {
  return new Promise((resolve, reject) => {
    const h = require('crypto').createHash('sha256');
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    let bytes = 0;
    rs.on('data', (c) => { bytes += c.length; if (onTick) onTick(bytes); h.update(c); });
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

// 装没装 = 模型文件在 且 有合格证 且 合格证对得上这个档位声明过的任一哈希。
// 注意必须比「所有源的哈希」而不是只比第一条：走了备源下载时，合格证上写的是备源的哈希，
// 只比主源就会永远判定为没装，然后每次启动都重下一遍 4.6 GB。
function installed(tier) {
  const t = tierOf(tier || state.tier);
  try {
    if (!fs.existsSync(modelPath(t.key))) return false;
    const want = t.sources.map(s => s.sha256).filter(Boolean);
    if (!want.length) return true;              // 没声明哈希的档位：文件在就算装
    return want.indexOf(readStamp(t.key)) >= 0;
  } catch (e) { return false; }
}
function installedTiers() { return TIERS.filter(t => installed(t.key)).map(t => t.key); }

// ==================== 五、内置 llama.cpp 后端 ====================
// 大文件下载（2~8.4 GB）。三条保命机制：
//   1) 断点续传：一切从 .part 的当前大小接着下
//   2) 分段重连：换新连接来摆脱劣化的老连接（长时间单连接实测会掉到 0.2 MB/s）
//   3) 卡死自愈：超过 STALL_MS 没有新数据就断掉重连，而不是傻等
// 这三条都是为了「没人看着的时候也能自己下完」。
//
// 换连接的判据有两条，缺一不可：
//   - 下满 SEGMENT：兜底，防止连接一直不温不火地拖着
//   - 跑够 WARMUP_MS 后平均速度仍低于 MIN_BPS：这才是真正救「还活着但掉速」的那种连接，
//     光靠 STALL_MS 拦不住它——那种连接一直在滴数据，永远不会触发「没数据」判定。
// SEGMENT 定 64MB 是实测值：这个设置能跑到 5.7 MB/s，和同网络下 curl 单连接（5.2 MB/s）
// 一致，说明已经顶到源站/网络的上限了。曾怀疑「换太勤会反复吃 TCP 慢启动」，实测不成立，
// 别把段调大——段越大，遇到劣化连接的恢复越慢。
function downloadFile(url, dest, onProgress) {
  const tmp = dest + '.part';
  const SEGMENT = 64 * 1024 * 1024;   // 每 64 MB 换一次连接（实测已顶到网络上限）
  const STALL_MS = 20000;             // 20 秒没有新数据 = 这条连接废了
  const MIN_BPS = 1024 * 1024;        // 段平均速度低于 1 MB/s 也判为劣化
  const WARMUP_MS = 45000;            // 给新连接 45 秒的爬坡期再判速度
  const MAX_STALLS = 5;               // 连续 5 次「重连后一点没下动」才判失败

  return new Promise((resolve, reject) => {
    let stallRounds = 0;
    let finished = false;

    const fileSize = () => { try { return fs.statSync(tmp).size; } catch (e) { return 0; } };

    const done = () => {
      if (finished) return;
      finished = true;
      try { fs.renameSync(tmp, dest); resolve(); }
      catch (e) { reject(e); }
    };

    // 一段下完（正常结束 / 下满 SEGMENT / 卡死）→ 记录进度并决定下一步
    // 注意：下一段的起点一律重新读 .part 的真实大小，不信任内存里的计数——
    // 缓冲区没落盘时它会偏大，读磁盘最保险。
    const advance = (sawProgress, total) => {
      const have = fileSize();
      if (total && have >= total) return done();
      if (!sawProgress) {
        if (++stallRounds >= MAX_STALLS) {
          return reject(new Error('连接反复卡住，已下载 ' + Math.round(have / 1048576) + ' MB，再点一次可以接着下'));
        }
      } else {
        stallRounds = 0;
      }
      setTimeout(() => step(), 300);   // 稍等一下再重连，别把服务端打急
    };

    const step = () => {
      const from = fileSize();
      let sawProgress = false;
      // 重定向计数必须按「段」重置：ModelScope 每次请求都会 302 到 OSS，
      // 放在外层会随着分段重连一路累加，下到一半就误报「重定向次数过多」。
      let redirects = 0;

      const go = (u, off) => {
        const lib = u.startsWith('https') ? https : http;
        const headers = { 'User-Agent': 'xiangyong-app/0.4' };
        if (off > 0) headers['Range'] = 'bytes=' + off + '-';

        let settled = false;
        let ws = null, timer = null, resRef = null;
        let received = off, total = 0, lastData = Date.now(), segBytes = 0;
        const segStart = Date.now();   // 这条连接的起始时刻，用来算段平均速度

        // 结束这一段：先把写流 flush 干净，再决定是否重连
        const cut = () => {
          if (settled) return;
          settled = true;
          if (timer) clearInterval(timer);
          const after = () => {
            try { if (resRef) resRef.destroy(); } catch (e) {}
            advance(sawProgress, total);
          };
          if (ws) { try { ws.end(after); } catch (e) { after(); } } else after();
        };

        const req = lib.get(u, { headers }, (res) => {
          resRef = res;
          // 跟随重定向（ModelScope 会 302 到 OSS）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            settled = true;
            if (++redirects > 8) return reject(new Error('重定向次数过多'));
            return go(new URL(res.headers.location, u).toString(), off);
          }
          // 416 = 请求区间超出文件长度，说明本地已经下完
          if (res.statusCode === 416) { res.resume(); settled = true; return done(); }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            // 4xx 是地址本身的问题（换源才有用），交给上层抛错；5xx/429 是暂时性的，当卡住重试
            const code = res.statusCode;
            if (code === 404 || code === 403 || code === 401) {
              settled = true;
              return reject(new Error('HTTP ' + code));
            }
            return cut();
          }

          const base = res.statusCode === 206 ? off : 0;   // 服务端不认 Range 就从头写
          const len = parseInt(res.headers['content-length'] || '0', 10);
          total = len ? len + base : 0;
          received = base;
          if (onProgress) onProgress(received, total);

          ws = fs.createWriteStream(tmp, { flags: base > 0 ? 'a' : 'w' });
          timer = setInterval(() => {
            const now = Date.now();
            if (now - lastData > STALL_MS) return cut();          // 彻底不动了
            // 还活着但爬得太慢：跑过爬坡期后段平均速度仍不达标 → 换连接
            const el = now - segStart;
            if (el >= WARMUP_MS && segBytes / (el / 1000) < MIN_BPS) cut();
          }, 3000);

          res.on('data', (c) => {
            if (settled) return;
            received += c.length;
            segBytes += c.length;
            lastData = Date.now();
            sawProgress = true;
            if (onProgress) onProgress(received, total);
            if (segBytes >= SEGMENT) cut();              // 下满一段就换连接
          });
          res.on('end', cut);
          res.on('error', cut);
          ws.on('error', (e) => {
            if (settled) return;
            settled = true;
            if (timer) clearInterval(timer);
            reject(e);
          });
          res.pipe(ws);
        });

        req.on('error', cut);
      };

      go(url, from);
    };

    step();
  });
}

// 让出错信息带上「可续传」的提示
function friendlyDownloadError(e) {
  const m = (e && e.message) || '未知错误';
  if (/哈希|校验|换源/.test(m)) return m;
  if (/中断|超时|卡住|ECONNRESET|socket hang up|ETIMEDOUT/i.test(m)) {
    return '下载中断（' + m + '）。已下载的部分保留着，再点一次会接着下。';
  }
  return '下载失败：' + m;
}

async function downloadTier(tierKey, onProgress) {
  const t = tierOf(tierKey);
  const dest = modelPath(t.key);
  if (installed(t.key)) return dest;

  // 文件在、但没有合格证（老版本装下来的，或者下到一半留下的半成品）。
  // 先就地算一遍哈希：对得上就直接补发合格证，不用重下 4.6 GB；
  // 对不上说明是坏文件，删掉——留着它会挡住续传逻辑，永远修不好。
  const declared = t.sources.map(s => s.sha256).filter(Boolean);
  if (fs.existsSync(dest) && declared.length) {
    try {
      state.verifying = true;
      const got = await sha256File(dest);
      state.verifying = false;
      if (declared.indexOf(got) >= 0) { fs.writeFileSync(stampPath(t.key), got); return dest; }
      fs.unlinkSync(dest);
    } catch (e) {
      state.verifying = false;
      try { fs.unlinkSync(dest); } catch (e2) {}
    }
  } else if (fs.existsSync(dest) && !declared.length) {
    return dest;
  }

  let lastErr = null;
  for (let i = 0; i < t.sources.length; i++) {
    const src = t.sources[i];
    const url = src.url;
    try {
      await downloadFile(url, dest, onProgress);
    } catch (e) { lastErr = e; continue; }

    // 下完了不等于下对了：流式算一遍 sha256 才认。
    // 实测 4.4 GB 约 4 秒，前端显示「校验中…」就够，不会让人以为卡死。
    if (src.sha256) {
      try {
        if (state) state.verifying = true;
        const got = await sha256File(dest);
        state.verifying = false;
        if (got !== src.sha256) {
          // 内容对不上 → 删掉重来，换下一条源。
          // 不删的话 .part 续传逻辑会以为「已经下完了」，永远卡在坏文件上。
          try { fs.unlinkSync(dest); } catch (e) {}
          lastErr = new Error('文件校验失败（源 ' + (i + 1) + ' 的文件本身有问题），已自动换源重下');
          continue;
        }
        fs.writeFileSync(stampPath(t.key), src.sha256);
      } catch (e) {
        state.verifying = false;
        lastErr = e; continue;
      }
    }
    try { fs.unlinkSync(dest + '.part'); } catch (e) {}
    return dest;
  }
  throw new Error(friendlyDownloadError(lastErr));
}

async function loadBuiltin(tierKey) {
  const t = tierOf(tierKey);
  // model 必须真的在手上才算「已加载」——空闲卸下之后 ready 仍是 true，
  // 只认 ready 会让 chat() 拿着空 model 直接崩。
  if (state.ready && loadedTier === t.key && state.backend === 'builtin' && model) return;
  if (loadPromise && loadedTier === t.key) return loadPromise;
  loadedTier = t.key;
  loadPromise = (async () => {
    const t0 = Date.now();
    const { getLlama } = await import('node-llama-cpp');
    // GPU 选择顺序：Vulkan 优先（一个 95MB 的包就通吃 NVIDIA / AMD / Intel，不需要用户装 CUDA 工具链），
    // 不行再交给 auto，最后退回 CPU。注意别让 auto 去试 CUDA——那会触发 cmake 现场编译，包给用户必然失败。
    try {
      llama = await getLlama({ gpu: 'vulkan' });
    } catch (e1) {
      try { llama = await getLlama({ gpu: 'auto' }); }
      catch (e2) { llama = await getLlama({ gpu: false }); }
    }
    if (model) { try { await model.dispose(); } catch (e) {} model = null; }
    model = await llama.loadModel({ modelPath: modelPath(t.key) });
    // 后端/模型名在这里一起落定：以「真正加载成功的东西」为准，避免并发时状态错位
    state.backend = 'builtin';
    state.ready = true;
    state.model = t.file;
    state.evicted = false;
    state.lastLoadMs = Date.now() - t0;
  })();
  return loadPromise;
}

async function builtinChat(system, user, maxTokens, temperature) {
  const { LlamaChatSession } = await import('node-llama-cpp');
  // 每次生成开一个独立 context，用完即弃。
  // 不要共用 context 再手动回收序列——只要有一次生成中途异常，序列就漏在那里，
  // 之后所有请求都会以「No sequences left」失败。独立 context 没有这个隐患。
  const ctx = await model.createContext({ contextSize: CONTEXT_SIZE });
  try {
    const session = new LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: system,
    });
    return (await session.prompt(user, {
      maxTokens: maxTokens || 400, temperature: temperature || 0.8, topP: 0.9,
    })).trim();
  } finally {
    try { await ctx.dispose(); } catch (e) {}
  }
}

// ==================== 七、统一对外接口 ====================
function init(dir) {
  modelDir = path.join(dir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  state.installed = installed(state.tier);
}

function status() {
  return {
    backend: state.backend,
    ready: state.ready,
    downloading: state.downloading,
    verifying: state.verifying,
    progress: Math.round(state.progress * 100),
    downloadedMB: Math.round((state.recvBytes || 0) / 1048576),
    totalMB: Math.round((state.totalBytes || 0) / 1048576),
    speedMBps: state.downloading ? Math.round((state.speedBps || 0) / 104857.6) / 10 : 0,
    etaSec: state.downloading ? (state.etaSec || 0) : 0,
    installed: state.installed,
    error: state.error,
    tier: state.tier,
    model: state.model,
    tiers: TIERS.map(t => ({
      key: t.key, label: t.label, params: t.params, sizeGB: t.sizeGB,
      minVRAM: t.minVRAM, desc: t.desc, installed: installed(t.key),
    })),
    installedTiers: installedTiers(),
    // ---- 显存治理：前端据此显示「已归还显存 · 闲置 N 分钟，下次调用自动装回」----
    idleLimit: AI_IDLE_SEC,
    idleSec: idleSec(),
    evicted: state.evicted,
    evictReason: state.evictReason,
    lastLoadMs: state.lastLoadMs,
    // 显存当下到底占没占：没启用 = free，启用且没卸下 = held，卸下了 = released
    vram: !state.ready ? 'free' : (state.evicted ? 'released' : 'held'),
  };
}

// 准备模型：选定档位 → 必要时下载 → 载入显存
async function setup(opts) {
  const o = opts || {};
  state.error = null;
  if (o.tier) state.tier = tierOf(o.tier).key;

  state.backend = 'builtin';
  if (setupPromise && loadedTier === state.tier) return setupPromise;
  // 换档位时先把 ready 放下——旧模型还在显存里，
  // 但它不是用户现在要用的那个，留着 ready=true 会让界面谎报「已就绪」。
  if (loadedTier !== state.tier) state.ready = false;
  setupPromise = (async () => {
    try {
      state.downloading = true;
      state.progress = 0;
      state.recvBytes = 0;
      state.totalBytes = 0;
      if (!installed(state.tier)) {
        // 大文件要下十几分钟，得让用户看见速度和剩余时间，不然像卡死了
        let lastT = 0, lastB = 0;
        state.speedBps = 0;
        state.etaSec = 0;
        await downloadTier(state.tier, (recv, total) => {
          state.recvBytes = recv;
          state.totalBytes = total;
          state.progress = total ? recv / total : 0;
          const now = Date.now();
          // 第一个回调只当基线：续传时起点不是 0，直接算会得出一个虚高的速度
          if (!lastT) { lastT = now; lastB = recv; return; }
          if (now - lastT >= 1000) {
            const inst = (recv - lastB) / ((now - lastT) / 1000);
            // 指数平滑，避免速度数字疯狂跳动
            state.speedBps = state.speedBps > 0 ? Math.round(state.speedBps * 0.6 + inst * 0.4) : Math.round(inst);
            lastT = now; lastB = recv;
            state.etaSec = (state.speedBps > 0 && total > recv) ? Math.round((total - recv) / state.speedBps) : 0;
          }
        });
      }
      state.progress = 1;
      await loadBuiltin(state.tier);
      state.installed = true;
      state.model = tierOf(state.tier).file;
      state.ready = true;
      touchIdle();
    } catch (e) {
      state.error = (e && e.message) ? e.message : String(e);
      state.ready = false;
      setupPromise = null;   // 允许用户再点一次重试（已下载的部分会续传）
    } finally {
      state.downloading = false;
      // 兜底复位：万一校验中途抛了奇怪的异常，界面不能永远停在「校验中…」
      state.verifying = false;
    }
    return status();
  })();
  return setupPromise;
}

// 兼容旧调用
async function ensureModel() {
  if (state.ready) return status();
  // 已有一次「准备」在进行中（模型正在下载/加载），等它，不要再发起一次——
  // 并发起第二次会把第一次的进度状态冲掉。
  if (setupPromise) return setupPromise;
  return setup({});
}

// 统一生成
async function chat(system, user, maxTokens, temperature) {
  if (!state.ready) await ensureModel();
  // 空闲把模型卸下过 —— 这里就是「下次激活再搬回显存」那一步。
  // 文件内容还在 OS 页缓存里，实测是秒级（status().lastLoadMs 会告诉用户实际花了多久）。
  if (state.ready && state.evicted) await loadBuiltin(state.tier);
  if (!state.ready || !model) throw new Error(state.error || '模型未就绪');
  touchIdle();
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
// 正文里「像统计量」的多位数。年份不算 —— 模型写「2025 年」很正常，
// 而 buildSummary 里并不含年份，拿它当编造会天天误报。
function statedNumbers(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || [])
    .filter(n => !/^(?:19|20)\d{2}$/.test(n.replace(/\.\d+$/, '')));
}
// 反向校验：不是「有没有引用数字」，而是「有没有编造数字」。
// 寄语、结语这类创作性文本，数字本来就是可选的（BLESSING_SYSTEM 铁律 1 写的是「可以引用…最多两个」），
// 用「至少引用一个」当判据会把一段合格的祝福判成不合格。这里只抓真问题：说了统计里没有的数。
function noFabricatedNumbers(text, summary) {
  const said = statedNumbers(text);
  return said.every(n => hasNumber(summary, n) || numbersIn(summary).includes(n));
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

// ---- 主接口三：热词榜话题归纳 ----
// 规则选出来的候选词能给「哪些词热」，但给不了「这俩人在聊什么」。
// 让模型把候选词归成几个话题；候选词表一并传回去做白名单，模型编的词一律不收。
const TOPIC_SYSTEM = `你是一个中文聊天话题归纳器。用户会给你一批从两个人的聊天记录里统计出来的高频词组（带出现次数）。

【任务】
把它们归纳成 4 到 6 个「话题」，每个话题起一个 4 到 10 个字的中文标签，并把属于这个标签的词组列出来。

【铁律】
1. 只能使用用户给你的词组，一个都不许自己编
2. 每个词组只能归到一个话题里，不要重复出现
3. 标签要具体、像人话，例如「约饭和吃啥」「周末出去玩」「深夜emo」，不要「日常交流」这种放在哪都成立的废话
4. 归纳不出来就别硬凑，宁可只给 3 个话题

【输出格式】
每个话题单独一行，标签和词组之间用竖线隔开，词组之间用顿号隔开。不要写任何多余的字、不要编号、不要解释。
例如：
约饭和吃啥|火锅、烧烤、吃啥、外卖`;

// 「标签|内容」这种一行一条的格式，模型最容易照做，也最容易解析。
// 三个能力（话题归纳 / 待办锐评）都用它，所以只在这里拆一次。
function parsePairs(text, max) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.replace(LEAD_NOISE, '').trim();
    const m = /^([^|｜]{1,16})\s*[|｜]\s*(.+)$/.exec(s);
    if (m) out.push({ k: m[1].trim(), v: m[2].trim() });
    if (max && out.length >= max) break;
  }
  return out;
}

async function topics(pname, cands) {
  if (!state.ready) await ensureModel();
  if (!state.ready) throw new Error(state.error || 'AI 未就绪');
  const list = cands.map(c => `${c.w}(${c.n}次)`).join('、');
  const ask = `联系人叫「${pname}」。以下是高频词组：\n${list}\n\n请按格式归纳成 4 到 6 个话题。`;

  const parse = (t) => {
    const allow = new Set(cands.map(c => c.w));
    const out = [];
    for (const p of parsePairs(t, 6)) {
      // 只留确实在候选表里的词，模型自己发挥出来的直接丢掉
      const words = p.v.split(/[、,，\/\s]+/).map(x => x.trim()).filter(w => w && allow.has(w));
      if (words.length) out.push({ label: p.k, words: words.slice(0, 8) });
    }
    return out;
  };

  let text = await chat(TOPIC_SYSTEM, ask, 520, 0.35);
  let out = parse(text);
  // 一行都没解析出来，多半是格式跑偏了，再要一次（只重试一次，不无限等）
  if (!out.length) {
    text = await chat(TOPIC_SYSTEM, ask + '\n\n注意：必须严格用「标签|词、词」的格式，一行一个话题。', 520, 0.2);
    out = parse(text);
  }
  return { ok: true, topics: out, backend: state.backend, model: state.model };
}

// ==================== 四、三个「一次生成」能力 ====================
// 狗头军师建议 / 待办锐评 / 报告结尾寄语，流程完全一样：
// 就绪 → 调模型 → 清理 → 兜底解析。差别只在提示词和怎么收尾，
// 所以用一个极小的工厂收口，而不是把 chat() 那几行抄三遍。

const ADVICE_SYSTEM = `你是一个中文关系军师，外号「狗头军师」——给的建议要反套路、能落地、带点损友的机灵劲儿。

【铁律】
1. 只写一条建议，60 到 120 字，不要分点、不要编号、不要标题
2. 必须落在「下一件具体能做的事」上，例如「周四晚上发一条不带问题的分享」
3. 禁止「多沟通」「多理解」「用心经营」这类放到哪都对、其实什么都没说的话
4. 你只有统计数据，没有聊天原文，不许编造人名、事件、聊天内容
5. 不涉及性、身体、外貌；不用贬低人的词；毒舌的落点是让人看得更清楚，不是让人难受
6. 分清「我」和「TA」是两个人，别把主动方说反
7. 直接输出建议正文，不要「建议：」这样的前缀`;

const TODO_SYSTEM = `你是一个中文效率伙伴，帮人看自己的待办清单执行情况，语气毒舌但友好、接地气。

【任务】
根据用户给的待办清单（已完成 / 未完成），写一句锐评（35 到 70 字）和一条建议（30 到 70 字）。

【铁律】
1. 锐评要引用真实数字（总数 / 已完成 / 未完成），不许编数字
2. 建议要具体到「先做哪一件事」，可以直接点名清单里的某一条
3. 不许写成「加油你可以的」这类空话；也不许羞辱当事人
4. 严格按下面的格式输出两行，不要多余的字、不要编号、不要解释

【输出格式】
锐评|这里是锐评
建议|这里是建议`;

const BLESSING_SYSTEM = `你在为一段关系写年度报告的结尾寄语。这份报告是根据两个人一整年的聊天记录生成的。

【风格】
- 温暖、克制、有分量，像一封不长的信的最后一段
- 有文学感但不堆砌辞藻，不用「亲爱的」这种称呼
- 中文，2 到 4 句，总共 45 到 110 字

【铁律】
1. 可以引用给你的真实数字（消息数 / 天数 / 次数），但最多引用两个，不要报菜名
2. 不许编造具体事件、人名、聊天内容——你只有统计数据
3. 不劝分不劝和，不做道德判断；落点是祝福与鼓励，不是评判
4. 不涉及性、身体、外貌；不用贬低人的词
5. 分清「我」和「TA」，别把谁更主动说反
6. 直接输出寄语正文，不要标题、不要致辞格式、不要引号包裹`;

function oneShot(system, makeAsk, maxTokens, temperature, finish) {
  return async (arg) => {
    if (!state.ready) await ensureModel();
    if (!state.ready) throw new Error(state.error || 'AI 未就绪');
    const text = await chat(system, makeAsk(arg), maxTokens, temperature);
    return finish(text, arg);
  };
}

// 狗头军师：把模板建议换成模型按真实数据现写的
const advice = oneShot(ADVICE_SYSTEM,
  (d) => `聊天统计：${buildSummary(d)}\n请按上面的要求给一条相处建议。`,
  260, 0.85,
  (text, d) => {
    const s = buildSummary(d);
    // 判据同 blessing：ADVICE_SYSTEM 从没要求报数字（它给的范例就不含数字），
    // 所以这里只抓「编造了统计里没有的数」，不拿「没引用数字」当罪。
    const cited = citedNumbers(text, numbersIn(s).filter(n => n.length >= 2));
    return { ok: true, advice: stripLead(text), grounded: noFabricatedNumbers(text, s), cited: cited.slice(0, 6), backend: state.backend, model: state.model };
  });

// 待办锐评：输入是用户自己的清单（本地模型跑，不外传）
const todoRoast = oneShot(TODO_SYSTEM,
  (t) => {
    const list = (t.todos || []).slice(0, 20);
    const done = list.filter(x => x.done).length;
    const open = list.filter(x => !x.done);
    const lines = list.map(x => (x.done ? '✔ ' : '· ') + String(x.text || '').slice(0, 40)).join('\n');
    return `一共 ${list.length} 条待办，已完成 ${done} 条，未完成 ${open.length} 条。\n清单：\n${lines}\n\n请按格式给一句锐评和一条建议。`;
  },
  220, 0.85,
  (text, t) => {
    const pairs = parsePairs(text, 3);
    const get = (k) => (pairs.find(p => p.k.indexOf(k) >= 0) || {}).v || '';
    let body = get('锐评'), tip = get('建议');
    // 模型没按格式走时退回「取前两行」——总比给用户一片空白强
    if (!body) {
      const ls = toLines(text);
      body = ls[0] || '';
      tip = tip || ls[1] || '';
    }
    if (!body) throw new Error('模型这次没写出内容，再点一次试试');
    const nums = numbersIn(`一共 ${(t.todos || []).length} 条`);
    return { ok: true, body, advice: tip, grounded: citedNumbers(body, nums).length > 0, backend: state.backend, model: state.model };
  });

// 报告结尾寄语：模板兜底在前端，这里给出模型版本
const blessing = oneShot(BLESSING_SYSTEM,
  // 字数要求必须在这儿再说一遍。BLESSING_SYSTEM 里写着「2 到 4 句、45 到 110 字」，
  // 但 3B 这种小模型对远在 system 里的格式约束遵守得很差 —— 实测只写出 28 字就收尾，
  // 年度报告最后一页看着很单薄。roast 那边当初就是靠这招压住字数的，这里照做。
  (d) => `聊天统计：${buildSummary(d)}\n请写这段年度报告的结尾寄语。3 到 4 句话，总共 60 到 100 字，不要一两句就结束。`,
  300, 0.9,
  (text, d) => {
    const s = buildSummary(d);
    const clean = noFabricatedNumbers(text, s);
    return { ok: true, blessing: stripLead(text), grounded: clean, backend: state.backend, model: state.model };
  });

module.exports = {
  init, status, ensureModel, setup, chat, installed, TIERS,
  roast, aiAnalyze, topics, advice, todoRoast, blessing,
  // 给测试用：防编造数字的反向校验
  _noFabricatedNumbers: noFabricatedNumbers,
  unload, idleSec, AI_IDLE_SEC,
};
