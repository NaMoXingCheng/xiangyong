const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ai = require('./ai');
const score = require('./score');   // 关系评分引擎（三指数 · 多信号合成，见 score.js 顶部注释）

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// 数据目录：抓取版独立目录（环境变量 TA_LOVE_DATA 优先，否则用应用目录下 data/）
const DATA = (process.env.TA_LOVE_DATA && process.env.TA_LOVE_DATA.trim()) || path.join(ROOT, 'data');
const MSG_DIR = path.join(DATA, 'messages');
const AVATAR_DIR = path.join(DATA, 'avatars');
ai.init(DATA);
// 确保数据目录存在（首次运行自动创建）
for (const d of [DATA, MSG_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
// 聊天数据根目录：环境变量 TA_LOVE_WX > 当前用户 Documents\xwechat_files（仅用于读聊天软件自己生成的明文图片缩略图缓存）
const XWECHAT_ROOT = (process.env.TA_LOVE_WX && process.env.TA_LOVE_WX.trim())
  || path.join(os.homedir(), 'Documents', 'xwechat_files');
const PORT = Number(process.env.TA_LOVE_PORT) || 4322;   // 可用环境变量换端口，方便开一个隔离实例做测试

// 1×1 全透明 GIF（43 字节）。用于「图片缩略图没缓存到」的场景占位，
// 比返回 404 干净：浏览器不会在控制台报 resource 加载失败。
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// ---------- 最后活跃时间缓存（实时化冷场天数） ----------
// 剪贴板导入写消息缓存时同步更新；服务启动时异步预热历史缓存
const lastCache = new Map();
const firstCache = new Map();
const countCache = new Map();
let lastReady = false;
function warmLastCache() {
  try {
    const files = fs.readdirSync(MSG_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const id = f.slice(0, -5);
      try {
        const st = fs.statSync(path.join(MSG_DIR, f));
        if (st.size < 2) continue;
        const j = JSON.parse(fs.readFileSync(path.join(MSG_DIR, f), 'utf8'));
        const list = j && Array.isArray(j.list) ? j.list : null;
        if (list && list.length) {
          const last = list[list.length - 1].t;
          const first = list[0].t;
          if (last) lastCache.set(id, last);
          if (first) firstCache.set(id, first);
          countCache.set(id, list.length);
        }
      } catch (e) { /* 单文件损坏跳过 */ }
    }
  } catch (e) { /* 目录不存在跳过 */ }
  lastReady = true;
  console.log(`[warm] lastCache ready: ${lastCache.size} persons`);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// 表情名称映射：emoji md5 -> 中文名称（来自 emoticon.db，实时查询用，无需重导缓存）
let emojiNameMap = null;
function emojiName(md5) {
  if (!md5) return '';
  if (!emojiNameMap) {
    emojiNameMap = readJson(path.join(ROOT, 'emoji_name_map.json')) || {};
    console.log('[emoji] name map ready: ' + Object.keys(emojiNameMap).length);
  }
  return emojiNameMap[String(md5).toLowerCase()] || '';
}

// ---------- 分析引擎（启发式） ----------
const COLORS = {
  active: '#4fd0ff',
  loved: '#e0bc72',
  cold: '#c26a5a'
};
// 短回复/晚安/关心这类词典已收进 score.js（评分引擎自带口径，避免两处各写一份）

// ---------- 情绪词典（轻量启发式） ----------
const POS_WORDS = ['开心','高兴','哈哈','嘻嘻','嘿嘿','可爱','喜欢','爱你','想你','宝贝','亲爱的','棒','赞','漂亮','帅','甜','幸福','快乐','期待','加油','抱抱','么么','晚安','早安','耶','哇','心动','温柔','靠谱','给力','真好','太好','不错','惊喜','感动','浪漫','舒服','幸运','珍惜','暖心','贴心','hhh','lol','嘻嘻嘻','哈哈哈哈','超爱','好喜欢','真棒','好棒','美滋滋','甜甜的','爱死','么么哒'];
const NEG_WORDS = ['烦','生气','难过','伤心','哭','讨厌','郁闷','崩溃','气死','烦死','无语','失望','焦虑','委屈','吵架','冷战','分手','滚','恨','害怕','担心','压力','疲惫','累死','饿死','困死','烦躁','心累','难受','糟糕','垃圾','恶心','嫌弃','冷漠','敷衍','无聊','烦人','上火','头疼','生病','疼','痛','唉','算了','随便','尴尬','丢人','完蛋','糟了','糟糕透','气人','讨厌死'];

// ---------- 热词统计（话题词模式：2/3/4-gram + 短语加权，过滤拆词噪音） ----------
const STOP_WORDS = new Set(['我们','你们','他们','自己','今天','明天','昨天','现在','时候','觉得','真的','还是','但是','因为','所以','如果','就是','这样','那样','这个','那个','之后','之前','一下','一点','一些','什么','为什么','可以','知道','没有','一个','怎么','怎么样','不是','不会','不要','已经','还有','然后','可是','只是','不过','虽然','可能','应该','其实','一直','一样','每次','最近','晚上','早上','中午','下午','说话','消息','聊天','感觉','有点','哈哈哈','哈哈','嘿嘿','嘻嘻','宝贝','亲爱的','晚安','早安','开心','喜欢','想你','爱你','在吗','在干嘛','吃饭','睡觉','上班','下班','工作','学校','老师','同学','朋友','家里','妈妈','爸爸','憨笑','捂脸','发呆','流泪','大哭','微笑','呲牙','撇嘴','色','酷','闭嘴','惊恐','发怒','疑问','嘘','晕','衰','骷髅','敲打','再见','擦汗','抠鼻','鼓掌','糗大了','坏笑','左哼哼','右哼哼','哈欠','鄙视','委屈','快哭了','阴险','亲亲','吓','可怜','菜刀','西瓜','啤酒','篮球','乒乓','咖啡','饭','猪头','玫瑰','凋谢','嘴唇','爱心','心碎','蛋糕','闪电','炸弹','刀','足球','钞票','便便','月亮','太阳','礼物','拥抱','强','弱','握手','胜利','抱拳','勾引','拳头','差劲','爱你','NO','OK','我去','我靠','我觉','我不','是你','是我','你的','我的','跟他','跟她','跟你','跟我','给他','给她','给你','给我','他觉','你觉','她了','他了','那些','这些','没事','问题','一起','而且','人家','个人','东西','行了','对啊','意思','死了','事情','呜呜','哎呀','反正','总之','以及','或者','接着','后来','以前','以后','同时','另外','除了','包括','比如','例如','好了','算了','明白','懂了','好吧','行吧','嗯嗯','啊啊','哦哦','么样','么办','一条','撤回','条消','记录','链接','聊天','天记','抹煋','消息','revokemsg','xml','sysmsg','对方','电话','视频','语音','图片','表情','文件','收到','看到','知道','回复','回你','回我','哈哈哈哈','哈哈哈','哈哈','哈哈哈','haha','hhh','hh','那么','起来','还要','想要','一般','千万','怎么着','去过']);
// 说明：原来还有 BAD_START / BAD_END / DROP_TRIPLE_START / TOPIC_VERBS 四张表，
// 都是给 n-gram 滑窗擦屁股用的（把「我的XX」「今天XX」这类跨词碎片挡掉）。
// 换成词典分词后碎片根本不会产生，留着反而误伤真词（「对不起」「了不起」都是好词），已删。
// STOP_WORDS 里补了几个分词后才冒出来的高频虚词（那么/起来/还要/想要/一般）——
// 它们是真词但没内容，靠词频也分不出来（实测 idf 和好词完全重叠），只能点名列黑。
// 口水整词：即使出现多次也不作为话题上榜
const CHATTER_WORDS = new Set(['但是我','所以我','因为你','然后我','然后你','呜呜呜','呜呜呜呜','哈哈哈哈哈哈','哈哈哈','嘿嘿嘿','嘻嘻嘻','怎么说','一个人','原来如此','原来如','来如此','感觉你','没有什么','没事没事','没事没','事没事','怎么办','好不好','行不行','在不在','对不对','是不是','有没有','喜不喜欢','哈哈哈','好叭','好吧','行吧','哦哦','嗯嗯','啊啊啊','啊哈哈','我我我','你你你','真的吗','真的呀','好吧那','算了算了','就这样','这个样子','什么鬼','为什么呀','天哪','天呐','我的天','救命','无语了','醉了','绝了','笑死','笑死我','哈哈笑死','哎呦','哎哟','哈哈哈啊','笑死我了','哈哈哈','笑哭','笑不活','蚌埠住','yyds','哈哈哈','嘻嘻哈哈','但是我觉']);
// 英文/拼音碎片黑名单（extractWords 已对小写英文，故 STOP/CHATTER 需同时按小写匹配；并补常见聊天语气词）
const STOP_WORDS_LC = new Set([...STOP_WORDS].map(s => s.toLowerCase()));
const CHATTER_LC = new Set([...CHATTER_WORDS].map(s => s.toLowerCase()));
const CHATTER_EXTRA = new Set(['ok','okok','wc','emmm','emm','woc','oi','lol','lmao','omg','u1s1','awsl','emo','mm','xjj','gg','xd','dbq','bhys','nsdd','yysy','yyds','bs','srds','pljj','xm','xdm']);

// ---------- 词表 + 最大概率分词 ----------
// 热词的候选必须先是一个「词」。原先用 2/3/4-gram 滑窗挖，「我今天早起跑了三公里」会挖出
// 「天早起跑」「跑了三公」「起跑了三」这种跨词碎片——纯统计筛不掉，只有词典能判词边界。
// 所以随包带一份词表（工具/生成词表.js 从结巴词典裁出来的 4 万高频词，MIT，452KB），
// 分词后再挑词，口径才对得上「说得最多的词」这句话。
const WORD_FREQ = new Map();
let WORD_TOTAL = 1;
try {
  for (const line of fs.readFileSync(path.join(ROOT, 'wordlist.txt'), 'utf8').split('\n')) {
    if (line[0] === '#') { WORD_TOTAL = Number(line.slice(1)) || 1; continue; }
    const sp = line.lastIndexOf(' ');
    if (sp > 0) WORD_FREQ.set(line.slice(0, sp), Number(line.slice(sp + 1)) || 0);
  }
} catch (e) {
  console.error('读不到 wordlist.txt，热词会退化成单字：' + e.message);
}
const LOG_TOTAL = Math.log(WORD_TOTAL);
const WORD_MAX = 6;                       // 词表最长 6 字，超过的不可能是词
const UNK_LOG = Math.log(0.5) - LOG_TOTAL; // 表外单字的兜底分：很小但大于 0，保证句子切得开

// 最大概率路径分词（结巴的核心）。从右往左算「从这里到句尾」的最优得分，
// 每步只试 6 种切法，最后顺着 step 走一遍就切好了。
function cutWord(s) {
  const n = s.length;
  const best = new Array(n + 1).fill(-Infinity);
  const step = new Array(n + 1).fill(1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    const end = Math.min(n, i + WORD_MAX);
    for (let j = i + 1; j <= end; j++) {
      const f = WORD_FREQ.get(s.slice(i, j));
      if (!f && j - i > 1) continue;                 // 表外多字组合不成词
      const sc = (f ? Math.log(f) - LOG_TOTAL : UNK_LOG) + best[j];
      if (sc > best[i]) { best[i] = sc; step[i] = j; }
    }
  }
  const out = [];
  for (let i = 0; i < n;) { const j = step[i]; out.push(s.slice(i, j)); i = j; }
  return out;
}

// 分词 → 候选词。只留 2 字以上：单字基本都是虚词，进榜只会是噪音。
function extractWords(text) {
  const out = [];
  const clean = String(text || '').replace(/\[[^\]]+\]/g, ' ');
  // 标点处断开：跨标点拼出来的词一定是假的
  for (const run of clean.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (const w of cutWord(run)) if (w.length >= 2) out.push(w);
  }
  for (const w of clean.match(/[a-zA-Z]{2,}/g) || []) out.push(w.toLowerCase());
  return out;
}

// 人名/昵称污染：把名字的 2 字以上片段收起来，含这些片段的候选词直接扔掉。
// 只收 2 字以上，「小雨」不会误伤「下雨天」（「下雨」不是「小雨」的子串）。
function nameStems(names) {
  const out = new Set();
  for (const n of names) {
    const s = String(n || '').replace(/[\s·・\-_]/g, '');
    if (s.length < 2) continue;
    for (let i = 0; i < s.length; i++) for (let j = i + 2; j <= s.length; j++) out.add(s.slice(i, j));
  }
  return out;
}
// 这个候选词该不该扔
function badWord(w, drop) {
  if (STOP_WORDS.has(w) || CHATTER_WORDS.has(w) || STOP_WORDS_LC.has(w) || CHATTER_LC.has(w) || CHATTER_EXTRA.has(w)) return true;
  if (drop && drop.size) for (const s of drop) if (w.includes(s)) return true;
  return false;
}

// 热词统计（话题词模式：2/3/4-gram + 短语加权，过滤拆词噪音）
//
// 打分主轴是 df（出现在多少条消息里），不是出现总次数。
// 原来用总次数，一个人连刷 20 遍同一个词就能把它顶到榜首，可那个词往往只是口头禅；
// 换成 df 之后，跨很多条消息反复出现的词才算「热」，刷屏刷不出来。
// taken 是「已经被挑走的词」，跨两次调用共享（我先、TA 后）。
// 不共享的话两边会各自独立挑一遍，「开会」和「天开会开」就同时出现在两个人的榜上。
function topWords(msgs, me, limit, drop, taken) {
  const df = new Map();    // 出现在多少条消息里
  const tf = new Map();    // 一共出现多少次
  for (const m of msgs) {
    if ((m.me === 1) !== me) continue;
    if (String(m.c || '').replace(/\[[^\]]+\]/g, ' ').replace(/[，。！？!?,.~～、；;：:\s]/g, '').length < 2) continue;
    const seen = new Set();
    for (const w of extractWords(m.c)) {
      tf.set(w, (tf.get(w) || 0) + 1);
      if (!seen.has(w)) { seen.add(w); df.set(w, (df.get(w) || 0) + 1); }
    }
  }
  const scored = [];
  for (const [w, d] of df) {
    if (badWord(w, drop)) continue;
    if (d < (w.length >= 4 ? 2 : 3)) continue;   // 长碎片至少出现在 2 条、短词至少 3 条消息里，压低一次性噪音
    scored.push({ w, n: tf.get(w) || d, df: d });
  }
  // 排序即选词策略，两条规则：
  // 1) 先看 df。出现在越多条消息里越热，跟长度无关。
  // 2) df 打平时**选短的**。这条是关键：中文里一个 4 字窗口十有八九是跨词切的
  //    （「我今天早起跑了三公里」会切出「天早起跑」「跑了三公」「起跑了三」），
  //    而它们的 2 字组成部分（早起 / 跑了）出现的次数只会**大于等于**它们。
  //    所以长词只有在 df 严格更高时才配当「一个词」——这就是最大短语判据。
  //    反过来（给长词加权）会把整屏切成跨词碎片，正是之前那版的问题。
  //    df 相同再按出现次数、最后按字典序，保证结果稳定可复现。
  scored.sort((a, b) => b.df - a.df || a.w.length - b.w.length || b.n - a.n || (a.w < b.w ? -1 : 1));
  // 去重叠：已选的和候选的只要互相包含就跳过。短词先入选 → 跨词的长窗口自然被这条挡掉。
  const picked = [];
  const clash = (w) =>
    picked.some(p => p.w.includes(w) || w.includes(p.w)) ||
    (taken && [...taken].some(t => t.includes(w) || w.includes(t)));
  for (const s of scored) {
    if (picked.length >= limit) break;
    if (clash(s.w)) continue;
    picked.push({ w: s.w, n: s.n, df: s.df });
    if (taken) taken.add(s.w);
  }
  // 挑谁进来按上面的规则，但排出来的顺序按真实出现次数 ——
  // 否则界面上会看到「179 排在 212 前面」，数字和顺序对不上，像 bug。
  return picked.sort((a, b) => b.n - a.n || b.df - a.df);
}
// 情绪基调：每条消息正负词计数 → 逐段正向占比（与趋势段对齐）
function sentimentSeries(msgs, segRanges) {
  const series = [];
  let posAll = 0, negAll = 0;
  for (const [from, to] of segRanges) {
    let pos = 0, neg = 0;
    for (let i = from; i < to; i++) {
      const c = String(msgs[i].c || '');
      let p = 0, n = 0;
      for (const w of POS_WORDS) if (c.includes(w)) p++;
      for (const w of NEG_WORDS) if (c.includes(w)) n++;
      if (p > n) pos++; else if (n > p) neg++;
      posAll += p; negAll += n;
    }
    series.push(pos + neg ? Math.round(pos / (pos + neg) * 100) : 50);
  }
  const positivePct = posAll + negAll ? Math.round(posAll / (posAll + negAll) * 100) : 50;
  return { positivePct, series };
}
// 纪念日倒计时：支持 "MM-DD" 或 "YYYY-MM-DD"，返回距下次的天数
function anniversaryDays(anniv) {
  if (!anniv) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anniv) || /^(\d{2})-(\d{2})$/.exec(anniv);
  if (!m) return null;
  const now = new Date();
  const y = m[1] && m[1].length === 4 ? Number(m[1]) : now.getFullYear();
  const mm = Number(m[2]), dd = Number(m[3]);
  if (Number.isNaN(mm) || Number.isNaN(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  let next = new Date(y, mm - 1, dd);
  if (next.getTime() - now.getTime() < 0) next = new Date(now.getFullYear() + 1, mm - 1, dd);
  return Math.round((next.getTime() - now.getTime()) / 86400000);
}

function ts2ms(t) { return t > 1e12 ? t : t * 1000; }
function fmtTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}-${md}` : md;
}
function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 时间线：双方各自最近的 30 条合并（保证双方都有发言，且是最近的对话）
// 若其中图片/表情消息偏少，则从全局尾部补入图片消息，让时间线可直观看到图片与表情
function buildTimeline(msgs) {
  const me = [], ta = [];
  for (let i = msgs.length - 1; i >= 0 && (me.length < 30 || ta.length < 30); i--) {
    const m = msgs[i];
    if (m.sys) continue;
    if (m.me === 1) { if (me.length < 30) me.push(m); }
    else { if (ta.length < 30) ta.push(m); }
  }
  let pool = me.concat(ta);
  const have = pool.filter(x => x.img).length;
  if (have < 6) {
    for (let i = msgs.length - 1; i >= 0 && pool.length < 90; i--) {
      const m = msgs[i];
      if (m.img && !pool.includes(m)) pool.push(m);
    }
  }
  // 语音优先保留：所有已转写语音（最多 10 条）+ 最近的未转写语音补足到 20 条
  const voiceKeep = [];
  for (let i = 0; i < msgs.length && voiceKeep.length < 10; i++) {
    const m = msgs[i];
    if (m.voice && m.vt) voiceKeep.push(m);
  }
  for (let i = msgs.length - 1; i >= 0 && voiceKeep.length < 20; i--) {
    const m = msgs[i];
    if (m.voice && !m.vt) voiceKeep.push(m);
  }
  voiceKeep.sort((a, b) => ((b.vt ? 1 : 0) - (a.vt ? 1 : 0)) || (a.t - b.t));
  const keepSet = new Set(voiceKeep.map(m => m));
  const rest = pool.filter(m => !keepSet.has(m)).sort((a, b) => a.t - b.t).slice(-(80 - voiceKeep.length));
  pool = voiceKeep.concat(rest).sort((a, b) => a.t - b.t);
  return pool.map((m, i) => ({
    id: 'r' + i,
    _id: m._id || '',
    edited: !!m.edited,
    time: fmtTime(ts2ms(m.t)),
    t: m.t,
    from: m.me === 1 ? 'me' : 'ta',
    text: (m.voice && m.vt ? (m.c || '') + ' ' + m.vt : (m.c || '')).slice(0, 200),
    full: (m.c || ''),
    img: !!m.img,
    emoji: !!m.emoji,
    en: m.emoji ? emojiName(m.f) : '',
    md5: m.f || '',
    voice: !!m.voice,
    video: /\[视频/.test(m.c || ''),
    link: /\[链接/.test(m.c || ''),
    svr: m.svr || '',
    vt: m.vt || ''
  }));
}

// ---------- 喜好自动提取：偏好词库 + 喜好语境匹配，分 me/ta 统计 ----------
const LIKE_LIB = ['火锅','烧烤','奶茶','咖啡','蛋糕','甜品','巧克力','炸鸡','薯条','麻辣烫','螺蛳粉','小龙虾','日料','烤肉','披萨','汉堡','饺子','汤圆','粽子','月饼','西瓜','草莓','樱桃','芒果','榴莲','葡萄','苹果','香蕉','冰淇淋','酸奶','果茶','柠檬茶','可乐','啤酒','白酒','红酒','茶叶','零食','泡面','煎饼','包子','面条','米饭','蛋挞','布丁','芝士','臭豆腐','烤串','关东煮','辣','香菜','甜品','看电影','追剧','打游戏','玩游戏','看小说','看漫画','听歌','唱歌','跳舞','旅游','旅行','爬山','露营','钓鱼','摄影','拍照','画画','看书','读书','健身','跑步','游泳','打篮球','打羽毛球','滑雪','滑板','骑行','手工','做饭','烘焙','逛街','购物','散步','熬夜','演唱会','音乐节','剧本杀','密室逃脱','桌游','动漫','电影','电视剧','综艺','纪录片','悬疑','科幻','恐怖','喜剧','古装','武侠','玄幻','蓝色','红色','黑色','白色','粉色','紫色','复古','简约','古风','汉服','洛丽塔','香水','口红','包包','首饰','手办','盲盒','玩偶','鲜花','玫瑰','向日葵','郁金香','周杰伦','林俊杰','陈奕迅','五月天','邓紫棋','王一博','肖战','杨幂','数学','物理','化学','生物','历史','地理','编程','设计','猫','狗','兔子','熊猫','仓鼠','猫咪','狗狗','小动物'];
const LIKE_CTX = /喜欢|爱吃|爱喝|爱看|爱玩|最爱|想去|想买|种草|想吃|想喝|超爱|好爱|特别喜欢|很喜欢|挺喜欢/;
function extractLikes(msgs) {
  const res = { me: new Map(), ta: new Map() };
  for (const m of msgs) {
    const txt = String(m.c || '');
    if (!LIKE_CTX.test(txt)) continue;
    // 说话者必须陈述自己的偏好（含"我"），排除转发文/泛化询问/第三人称
    if (!/我/.test(txt)) continue;
    // 否定语境："我不喜欢吃辣" / "我喜欢的可不是数学" 不是喜好
    if (/(?:不|没|别|少|讨厌|戒)(?:是|太|很|会|想|要|怎)?(?:.{0,3})(?:喜欢|爱吃|爱喝|爱看|爱玩|想去|想吃|想喝|想买|种草|好爱|超爱)|(?:可不是|并不是|但不|才不是|其实不|真的不|一点都不|不一定)(?:喜欢|爱吃|爱喝|爱看|爱玩|想去|想吃|想喝|想买|种草|好爱|超爱|爱|想)|讨厌|戒了|别吃|别买/.test(txt)) continue;
    // 疑似转发长文（整段故事/文章）
    if (txt.length > 100) continue;
    const map = res[m.me === 1 ? 'me' : 'ta'];
    for (const w of LIKE_LIB) {
      if (txt.includes(w)) map.set(w, (map.get(w) || 0) + 1);
    }
  }
  const fmt = map => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([text, count]) => ({ text, count }));
  return { me: fmt(res.me), ta: fmt(res.ta) };
}

// ---------- 纪念日自动提取：含日期 + 关系关键词的消息 → 候选纪念日 ----------
// 只接受"我/我们"为主语的关系陈述；排除第三人称、追星/游戏语境
const ANNIV_KW = /在一起|纪念日|周年|确定关系|表白|交往|脱单|牵手|初吻|领证|结婚|认识|生日/;
const ANNIV_DATE = /(?:(\d{4})[年./-])?(\d{1,2})[月./-](\d{1,2})[日号]?/;
const ANNIV_EXCLUDE = /(他|她|他们|她们|老公|老婆|朋友|同学|同事|老板|抽卡|纸片人|偶像|游戏|群里|给.*(?:他|她|朋友|同学|同事))/;
const ANNIV_SELF = /(我和|我们和|我的生日|我生日|我们生日|我们在一起|我们认识|我们纪念|我们交往|我们结婚|我们牵手|我们表白|我们确定|我们脱单|我领证|我们领证|我们初吻)/;
function extractAnniversaries(msgs) {
  const out = [];
  const seen = new Set();
  for (const m of msgs) {
    const txt = String(m.c || '');
    // 主语必须是"我/我们"
    if (!/(我|我们)/.test(txt)) continue;
    const kw = ANNIV_KW.exec(txt);
    if (!kw) continue;
    // 排除第三人称/追星/游戏语境（除非明确是"我/我们"的关系陈述）
    if (ANNIV_EXCLUDE.test(txt) && !ANNIV_SELF.test(txt)) continue;
    // "生日"必须带"我/我的/我们"（"我老公过生日"被上面的 EXCLUDE 排除；"你什么时候生日"无"我"已跳过）
    if (kw[0] === '生日' && !/(我的生日|我生日|我们生日|生日是|生日那天|生日快|快生日|过生日)/.test(txt)) continue;
    const dm = txt.match(ANNIV_DATE);
    if (!dm) continue;
    const y = dm[1] || String(new Date().getFullYear());
    const date = `${y}-${String(Number(dm[2])).padStart(2, '0')}-${String(Number(dm[3])).padStart(2, '0')}`;
    const label = kw[0];
    const key = date + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, date, auto: true, sample: txt.slice(0, 30) });
  }
  return out.slice(0, 8);
}

// ---------- 承诺识别：从聊天里挑出「答应过的事」 ----------
// 原则是「宁缺毋滥」：漏掉几条无所谓，但把「明天有空吗」认成承诺会很扫兴。
// 计分制：命中条目权重累加，够阈值才收；疑问句/玩笑/转述直接排除。
// 承诺的典型结构是「未来时间词 + 给对方好处」，所以时间词那两条权重最高。
const PROMISE_RULES = [
  // —— 明确表态 ——
  { re: /我(?:保证|发誓|承诺|答应你|肯定会|一定会)/, w: 3 },
  { re: /说好(?:了|的)|一言为定|拉钩|说话算话|绝不食言|说到做到/, w: 3 },
  { re: /(?:下次|改天|回头)(?:一定|肯定|必须)/, w: 2 },
  // —— 未来时间 + 给予动作（最典型的承诺句式）——
  { re: /(?:明天|后天|下周|下星期|下个月|(?:这|本|下)?(?:个)?周末|下次|改天|过几天)[^。！？\n]{0,14}(?:带你|陪你|请你|帮你|给你|买给|送给)/, w: 3 },
  { re: /(?:带你|陪你|请你|帮你|给你|送你)[^。！？\n]{0,10}(?:去|吃|玩|看|喝|买|走|打|搬|修|弄|办|寄|带)/, w: 2 },
  // —— 未来时间 + 上门动作（"我明天过去找你" 这类，不带"带你"也是承诺）——
  { re: /(?:明天|后天|今晚|待会|等会|晚点|下班|周末)(?:我)?(?:过来|过去|来|去)[^。！？\n]{0,6}(?:找你|看你|接你|陪你)/, w: 2 },
  // —— 弱信号：一起做某事 / 约定 ——
  { re: /(?:我|咱)(?:们)?(?:一起|一块)(?:去|吃|玩|看|走|做)/, w: 1.2 },
  { re: /(?:约|定)(?:好|个)(?:时间|地方|日子)/, w: 1.5 },
  { re: /(?:改天|下次|回头)(?:约|见|一起|带你|陪你)/, w: 1 },   // 单说"改天约"也算——它至少是句口头约定
  { re: /我会(?:好好|认真|努力|改|注意)/, w: 2 },
];
// 明显不是承诺的：疑问、反问、玩笑、推托、转述
const PROMISE_NO = /[吗麼么?？]\s*$|算了|开玩笑|逗你|骗你的|别当真|你自己|问你呢|有空吗|在吗|干嘛呢|好不好$/;
// 条件句常是谈判不是承诺（"你要是来我就请你吃饭"），降权但不当成噪声
const PROMISE_COND = /(?:如果|要是|假如|除非)[^。！？\n]{0,20}(?:就|才)/;

function detectPromises(msgs) {
  const out = [];
  const seen = new Set();
  for (const m of msgs) {
    const txt = String(m.c || '').trim();
    if (!txt || txt.length < 4 || txt.length > 60) continue;   // 太短没信息量，太长多是转发段子
    if (m.sys) continue;
    if (/^\[|^<\?xml/.test(txt)) continue;                     // 图片/表情/系统卡片
    if (PROMISE_NO.test(txt)) continue;
    let score = 0;
    for (const r of PROMISE_RULES) if (r.re.test(txt)) score += r.w;
    if (PROMISE_COND.test(txt)) score -= 1;
    if (score < 2) continue;
    const key = txt.toLowerCase();
    if (seen.has(key)) continue;                               // 同一句话刷多次只留一条
    seen.add(key);
    out.push({
      text: txt,
      who: m.me === 1 ? 'me' : 'ta',
      at: m.t > 1e12 ? Math.floor(m.t / 1000) : m.t,
      score,                                                   // 留着重算 id 用
    });
  }
  // 最近的排在最前；上限 40 条，避免话痨把面板撑爆
  return out.sort((a, b) => b.at - a.at).slice(0, 40);
}

// 稳定 id：同一条承诺每次分析都算出同一个 id，用户的「已兑现/已删除」才不会丢
function promiseId(p) {
  return 'pm' + md5hex((p.text || '') + '|' + (p.at || 0)).slice(0, 10);
}

// ---------- 承诺存储（data/promises.json）----------
// 结构：{ "<personId>": { keepForever: bool, items: [...] } }
// items 里 auto=true 是自动识别的，false 是用户自己加的；两种都能改文字 / 标兑现 / 删除。
// 用户动过的自动项必须留痕（edited / deleted），否则下次重算分析它又原样冒出来 —— 这是最烦人的点。
const PROMISE_PATH = path.join(DATA, 'promises.json');
const PROMISE_KEEP_DAYS = 15;   // 已兑现默认保留天数（与 To Do 保持一致）

function readPromiseStore() {
  const j = readJson(PROMISE_PATH);
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}
function writePromiseStore(store) {
  try { fs.writeFileSync(PROMISE_PATH, JSON.stringify(store || {}, null, 1), 'utf8'); } catch (e) {}
}

// 把「这次分析识别出的」和「用户改过的」合成一份
function mergePromises(personId, autoItems) {
  const store = readPromiseStore();
  const box = store[personId] || { keepForever: false, items: [] };
  const known = new Map((box.items || []).map(it => [it.id, it]));
  const merged = [];
  for (const a of autoItems) {
    const id = promiseId(a);
    const old = known.get(id);
    if (old) {
      merged.push(Object.assign({}, old, {
        text: old.edited ? old.text : a.text,   // 用户改过就别覆盖回去
        who: old.edited && old.who ? old.who : a.who,
        at: a.at,
        auto: true,
      }));
      known.delete(id);
    } else {
      merged.push({ id, text: a.text, who: a.who, at: a.at, auto: true, done: false, doneAt: 0, edited: false, deleted: false });
    }
  }
  for (const it of known.values()) merged.push(it);   // 手动加的 + 删除留痕的
  merged.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { keepForever: !!box.keepForever, items: merged };
}

function savePromises(personId, box) {
  const store = readPromiseStore();
  // 删除留痕超 60 天的清掉，免得文件无限长大（那时对应消息也早翻不到了）
  const items = (box.items || []).filter(it => !(it.deleted && it.auto && (Date.now() / 1000 - (it.at || 0)) > 60 * 86400));
  store[personId] = { keepForever: !!box.keepForever, items };
  writePromiseStore(store);
  return store[personId];
}

// 已兑现清理：开了永久保留就一条不动
function pruneDonePromises(box) {
  if (box.keepForever) return 0;
  const before = (box.items || []).length;
  box.items = (box.items || []).filter(it => !(it.done && it.doneAt && (Date.now() - it.doneAt) > PROMISE_KEEP_DAYS * 86400000));
  return before - box.items.length;
}

// 被爱指数的算法已移到 score.js（scoreLoved）——它现在由多路信号合成，不再是单一公式。

// ---------- AI 锐评（毒舌但友好）：规则模板 + 联系人种子变体
// 同一联系人评语稳定（种子确定）；不同联系人即使触发同一规则也拿到不同措辞，消除同质化
function buildRoast(d) {
  const lines = [];
  const g = {};
  for (const x of d.gauges) g[x.key] = x.value;
  const cold = g.cold || 0, active = g.active || 0, loved = g.loved || 0;
  // 信号层：文案里的数字必须来自真实信号。指数分值（0-100 的合成分）和
  // 「单字回复率 31%」这种原始比率是两码事，混着念出来的话就是假数字。
  const sg = d.signals || {};
  const S = (k, fb) => (typeof sg[k] === 'number' ? sg[k] : fb);
  const startPct = Math.round(S('startRatio', 0.5) * 100);
  const shortPct = Math.round(S('shortPct', 0));
  const taPct = Math.round(S('taRatio', 0.5) * 100);
  const bombN = S('bombN', 0), bombMax = S('bombMax', 0);
  const lenRatio = S('lenRatio', 1), nightN = S('nightN', 0), careN = S('careN', 0);
  const ignoredN = S('ignoredN', 0), replyN = S('replyN', 0), ignoredRate = S('ignoredRate', 0);
  const taMidSec = Math.round(S('midTaReply', 7200)), meMidSec = Math.round(S('midReply', 7200));
  const daily = d.dailyMsg || 0;
  const pp = d.sentiment.positivePct;
  const is = d.imgStats || {};
  const st = d.sternberg || { labels: [], me: [], ta: [] };
  const sb = {};
  st.labels.forEach((lab, i) => { sb[lab] = { me: st.me[i] || 0, ta: st.ta[i] || 0 }; });
  const rp = d.reply || { meMid: 7200, taMid: 7200 };
  const pickWords = arr => {
    const long = (arr || []).filter(x => x.w.length >= 3);
    return (long.length ? long : (arr || [])).slice(0, 3).map(x => x.w);
  };
  const meWords = pickWords(d.topWords.me);
  const taWords = pickWords(d.topWords.ta);
  // 联系人种子：同一联系人评语稳定，不同联系人措辞不同
  let seed = 0;
  const seedStr = String(d.id || '') + ':' + String(d.name || '');
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const pick2 = (arr, salt) => (arr && arr.length ? arr[(seed + salt) % arr.length] : '');

  // 候选池：每条规则带权重（数值越极端权重越高），最后取最显著特征 + 该规则的种子变体
  const pool = [];
  const add = (ok, weight, templates) => { if (ok && templates && templates.length) pool.push({ w: weight, t: templates }); };
  add(cold >= 45, 100, [`对方单字回复率 ${shortPct}%，这敷衍程度快赶上银行客服了。建议下次直接发选择题，别发填空题。`, `TA 的单字回复率 ${shortPct}%，每个"嗯"字都像在给聊天室上锁。要不咱换个会开锁的人聊？`, `${shortPct}% 的单字回复率，跟 TA 聊天像在跟 ATM 机对话——只有确认键和取消键。`]);
  add(cold >= 26, 88, [`TA 的短回复占比 ${shortPct}%，聊天温度堪比冷库。多问两句"你觉得呢"，比发十个表情包有用。`, `短回复占了 ${shortPct}%，TA 的聊天风格像极了期末监考老师：惜字如金，句句致命。`, `TA 的回复短到可以当弹幕刷屏（${shortPct}%），建议下次发个"收到请扣1"测试一下。`]);
  // 被晾着：比"回复短"更硬的证据 —— TA 平均几十秒就回，却有那么几次让你等了两小时以上
  add(ignoredN >= 8 && ignoredRate >= 0.04, 94, [`TA 平时 ${score.dur(taMidSec)} 就回你，但有 ${ignoredN} 次让你等了两个钟头以上（${replyN} 次回复里占 ${Math.round(ignoredRate * 100)}%）。偶尔一次是忙，这个比例就是态度了。`, `${ignoredN}/${replyN} 次回复，TA 拖过了两小时。按 TA 平时的速度，这已经不是"没看到"，是"看到了没急着回"。`, `你被晾了两个小时以上的次数是 ${ignoredN}（一共 ${replyN} 次回复，占 ${Math.round(ignoredRate * 100)}%）。别急着自我反思，先把这几次摆出来看看有没有规律。`]);
  // 连续轰炸：你发的不是一条消息，是一串
  add(bombN >= 3 && bombMax >= 6, 90, [`你有 ${bombN} 段对话在连发，最长一次连着发了 ${bombMax} 条没人接。屏幕这头是急，屏幕那头是难回。`, `连发 ${bombMax} 条的战绩出现了 ${bombN} 次。对方不是不想回，是一时不知道该先回哪条。`, `${bombN} 次连发、最长 ${bombMax} 条——你的表达欲比这条通道的带宽大得多。攒成一条说，回的概率反而高。`]);
  // 消息长度比：谁在认真打字
  add(lenRatio >= 1.8, 78, [`你的消息平均长度是 TA 的 ${lenRatio.toFixed(1)} 倍。你写小作文，TA 回关键词，这不对等是长期的。`, `长度比 ${lenRatio.toFixed(1)}:1，你打的字能出书，TA 打的字够发弹幕。热情没错，但值得被接住。`, `你平均每条消息是 TA 的 ${lenRatio.toFixed(1)} 倍长。不是要你也变短，是这份认真得有人接。`]);
  // 晚安/早安：低成本高频的仪式感，比消息量更能说明关系稳不稳
  add(nightN >= 20, 84, [`TA 对你说过 ${nightN} 次晚安/早安这类话。别小看这几个字，愿意每天花十秒惦记你的，不多。`, `累计 ${nightN} 次晚安/早安——仪式感这东西，比说一百句"喜欢你"更扛时间。`, `${nightN} 次晚安或早安。这种每天准点出现的在意，属于关系的底噪，安静但一直在。`]);
  // 关心频率：不是聊得开心，是惦记你
  add(careN >= 15, 82, [`TA 关心过你 ${careN} 次（吃饭没、多穿点、别熬夜这类）。话不甜，但都是实心儿的。`, `${careN} 次"吃饭了吗""早点睡"——中国式关心从来不说爱，只说别着凉。`, `TA 的关心出现 ${careN} 次。这种絮叨式的在意，比甜言蜜语值钱。`]);
  add(active >= 72 && loved < 45, 92, [`你开的话头占 ${startPct}%，像个永动机；TA 的被爱指数只有 ${loved} 分，像个节能灯。一个发电一个省电，这组合挺环保。`, `你先开口 ${startPct}%，TA 那边被爱指数 ${loved} 分。一个在开演唱会，一个在打盹。建议把话筒递过去试试。`]);
  add(loved >= 78 && active >= 60, 95, [`双向奔赴，甜度 ${Math.round((loved + active) / 2)} 分。建议保持点距离，防止血糖超标。`, `你主动 ${active} 分、TA 被爱 ${loved} 分，双向奔赴实锤。聊天记录已经替你官宣了，就差你开口了。`]);
  add(loved >= 72, 90, [`TA 的热情值 ${loved} 分，回你中位数只要 ${score.dur(taMidSec)}。这波明显是 TA 先动的心，你偷着乐吧。`, `TA 被爱指数 ${loved}，回消息平均 ${score.dur(taMidSec)}，比抢红包还积极。这反应速度，说没好感谁信？`, `TA 的回应热度 ${loved} 分，这热情指数放在股市是要被监管问询的。`, `被爱指数 ${loved} 分：TA 平均 ${score.dur(taMidSec)} 就回你，你回 TA 要 ${score.dur(meMidSec)}——请问你俩谁在追谁？这剧本拿反了都。`]);
  add(d.coldDays >= 5, 96, [`你们已经 ${d.coldDays} 天没联系了，再冷下去可以申报极地科考项目了。`, `${d.coldDays} 天没动静，这段关系已经进入冬眠模式。建议下个节气前解冻，不然真要长蘑菇了。`, `${d.coldDays} 天零对话，这记录够格入选"冷战名人堂"了。`]);
  add(d.coldDays >= 3, 82, [`${d.coldDays} 天没说话了，这关系比秋天的落叶还冷。主动发个"在吗"，成本为零。`, `${d.coldDays} 天没聊了，再冷下去聊天记录都要结冰。发个表情包破冰，稳赚不赔。`]);
  add(daily >= 80, 90, [`日均 ${daily} 条消息，你们是把聊天软件当对讲机，还是怕对方一秒钟就消失？`, `日均 ${daily} 条，这聊天密度堪比连续剧更新。建议留点悬念，别一集全播完。`, `日均 ${daily} 条消息，手机电量一半都是聊 TA 聊没的。`]);
  add(daily >= 40, 76, [`日均 ${daily} 条消息，话痨程度鉴定完毕。建议偶尔发条语音，给文字消息放个假。`, `日均 ${daily} 条消息，键盘都要冒火星了。少打几个字，让手指也歇歇。`]);
  add(daily < 3, 80, [`日均 ${daily.toFixed(1)} 条消息，这段关系的消息密度堪比沙漠降雨。`, `日均 ${daily.toFixed(1)} 条，聊天频率低到可以入选"佛系关系"非遗名录。`]);
  add(pp >= 70, 78, [`对话正向浓度 ${pp}%，甜得发齁。建议配一杯无糖茶，中和一下。`, `正向情绪占比 ${pp}%，这聊天记录甜度超标，建议自带血糖仪。`]);
  add(pp <= 35, 84, [`对话负能量浓度 ${100 - pp}%，建议互发猫猫图进行空气净化。`, `情绪值 ${pp}%，负能量浓度偏高。建议整点猫图狗图，把画风拉回来。`]);
  add(is.emojiTotal >= 100, 72, [`表情包往来 ${is.emojiTotal} 个，你们把聊天玩成了斗图大赛。建议评个年度最佳表情包奖。`, `累计互发表情 ${is.emojiTotal} 个，文字不够表情凑，这届网友的嘴都长在表情包上。`]);
  add((is.taEmoji || 0) >= 60 && (is.taImg || 0) < (is.taEmoji || 0), 70, [`TA 发来表情 ${is.taEmoji} 个，比发的字还多。表情包就是 TA 的千言万语，建议逐张背诵。`, `TA 的聊天里表情包占比惊人（${is.taEmoji} 个），属于"表情包文学家"，建议收藏夹扩容。`]);
  add((is.taImg || 0) >= 50, 74, [`TA 发过 ${is.taImg} 张图，聊天记录像摄影展。文字靠脑补，图片全靠 TA 的日常。`, `TA 图片轰炸 ${is.taImg} 张，堪称行走的图库。建议给 TA 开个个人影展。`]);
  add(sb['亲密'] && sb['亲密'].ta >= 80, 78, [`深夜时段 TA 的消息密度很高（亲密分 ${sb['亲密'].ta}），这种"夜聊体质"通常意味着足够的安全感。`, `TA 的深夜出没率偏高（亲密分 ${sb['亲密'].ta}），凌晨的分享欲最藏不住。`]);
  add(sb['责任'] && sb['责任'].ta >= 95 && sb['责任'].me <= 60, 86, [`TA 回你平均 ${Math.round(rp.taMid)} 秒，你回 TA 要 ${Math.round(rp.meMid / 60)} 分钟。这速度差，建议反思一下是不是在吊人家胃口。`, `TA 秒回（${Math.round(rp.taMid)} 秒），你让 TA 等 ${Math.round(rp.meMid / 60)} 分钟。冷战冠军非你莫属。`]);
  add(sb['责任'] && sb['责任'].ta >= 95, 80, [`TA 的回消息速度平均 ${Math.round(rp.taMid)} 秒，这响应速度在人类里属于罕见物种。`, `TA 平均 ${Math.round(rp.taMid)} 秒就回你，比你外卖骑手还快。`]);
  add(sb['激情'] && sb['激情'].ta >= 70, 74, [`TA 的激情指数 ${sb['激情'].ta}，聊天主动性拉满。这段关系的火花，基本都是 TA 先擦的。`, `激情维度 TA 拿了 ${sb['激情'].ta} 分，电火花直冒，建议备好灭火器（不是）。`]);
  add(d.spans && d.spans.days >= 365, 72, [`这段关系已经走过 ${Math.round(d.spans.days)} 天，跨过了一年的门槛。纪念日建议安排上，别只会说"改天"。`, `聊天跨度 ${Math.round(d.spans.days)} 天，够写一部长篇小说了。建议出个精选集。`]);

  if (d.nextAnniversary && d.nextAnniversary.days <= 7) {
    add(true, 93, [
      `距离${d.nextAnniversary.label || '纪念日'}还有 ${d.nextAnniversary.days} 天，礼物买了吗？没买的话现在打开购物软件还来得及（大概）。`,
      `${d.nextAnniversary.label || '纪念日'}还有 ${d.nextAnniversary.days} 天就到，TA 嘴上不说，心里可能已经记了一百遍。`
    ]);
  }
  pool.sort((a, b) => b.w - a.w);
  // 主行：权重最高的异常特征
  if (pool[0]) lines.push(pick2(pool[0].t, 3));
  // 补充行：取不同规则的候选，凑足 3 行（去同质化：每条来自不同维度，文本不重复）
  for (let i = 1; i < pool.length && lines.length < 3; i++) {
    const txt = pick2(pool[i].t, 7 + i);
    if (!lines.includes(txt)) lines.push(txt);
  }
  // 话题呼应行（不占规则位，丰富"多说几句"）
  if (lines.length < 3 && meWords.length && taWords.length) {
    lines.push(pick2([
      `你最近挂在嘴边：${meWords.join('、')}；TA 那边：${taWords.join('、')}。聊得这么有来有回，确定只是普通朋友？`,
      `你高频词：${meWords.join('、')}；TA 高频词：${taWords.join('、')}。这话题重合度，说是巧合谁信？`
    ], 11));
  } else if (lines.length < 3 && (meWords.length || taWords.length)) {
    lines.push(`最近的高频话题：${(meWords.length ? meWords : taWords).join('、')}。`);
  }
  if (!lines.length) {
    lines.push(`记录在案 ${d.spans ? Math.round(d.spans.msgN) : 0} 条消息，暂无特别突出的相处模式。平平淡淡才是真，倒也不赖。`);
  }

  // 狗头军师 · 相处建议（战略式、反套路，依主导特征出谋）
  const advicePick = (conds) => { for (const c of conds) { if (c.ok) return pick2(c.t, c.salt || 5); } return ''; };
  const advice = advicePick([
    // 被晾着：最硬的一条证据，优先给建议
    // 措辞不预设关系是恋爱 —— 这个入口也会用在父母、老友身上
    { ok: ignoredN >= 8 && ignoredRate >= 0.05, salt: 12, t: [
      `TA 平时 ${score.dur(taMidSec)} 就回，却有 ${ignoredN} 次让你等了两小时以上。先别急着追问"在忙吗"，做个实验：连三次只发一条、不带问句、不需要回应，看 TA 会不会自己回来找你。会，说明只是忙；不会，你也拿到了答案。`,
      `${ignoredN} 次异常长的等待（占 ${Math.round(ignoredRate * 100)}%）。追问换不来回应，把节奏慢下来反而更清楚：发完就放下手机，让沉默自己说话。`
    ]},
    // 连发：不是缺点，是方式不对
    { ok: bombN >= 3 && bombMax >= 6, salt: 13, t: [
      `试过连发 ${bombMax} 条吗？对面看着一屏消息，第一反应是"等会儿一起回"，然后就忘了。把三句话压成一句，回的概率翻倍。`,
      `连发 ${bombN} 段的习惯改一改：发一条，等回应，再发下一条。留个气口，对话才转得起来。`
    ]},
    // 长度不对等：认真被辜负的方式有很多种，这是最安静的一种
    { ok: lenRatio >= 1.8, salt: 14, t: [
      `你的消息是 TA 的 ${lenRatio.toFixed(1)} 倍长。别把字数当诚意证明——试着用一句轻的换一句轻的，节奏对上了，人才愿意多说。`,
      `长度比 ${lenRatio.toFixed(1)}:1 说明什么？你在交付，TA 在签收。降低单条信息量，反而更容易等到真心话。`
    ]},
    // TA 有仪式感 → 得接住，别当成理所当然
    { ok: nightN >= 20 || careN >= 15, salt: 15, t: [
      `TA 累计 ${nightN} 次晚安/早安、${careN} 次关心你。这些都不是自动回复，是有人在花心思。下次轮到你起头，把这份在意接住。`,
      `别只收不发。TA 的 ${nightN + careN} 次问候说明在意是真的，你也固定给 TA 一条——两个人都在经营的才叫关系。`
    ]},
    { ok: active >= 70 && loved < 50, salt: 1, t: [
      `你这发起频率像在给关系打肾上腺素。偶尔战略性沉默 48 小时，看 TA 会不会主动找你——不找，你心里就有数了。`,
      `单方面狂发等于替两个人谈恋爱。把"在干嘛"换成一件你正在经历的小事，把球踢给 TA，看接不接。`
    ]},
    { ok: cold >= 30, salt: 2, t: [
      `别再用问句轰炸了。把填空题换成分享——丢一件你正在做的事，让人接得住话，比十个"在吗"强。`,
      `TA 在惜字如金，你越追问越冷。先停三天，再用一条不带期待的分享破冰，反而勾人。`
    ]},
    { ok: loved >= 70 && active >= 55, salt: 3, t: [
      `温度够了，差临门一脚。趁热打铁把线上梗延续到线下——约顿饭，比多发 200 条消息管用。`,
      `双向热情别浪费在表情包里。找个由头把 TA 约出来，线下的好感是文字堆不出来的。`
    ]},
    { ok: d.spans && d.spans.days >= 365, salt: 4, t: [
      `能聊这么久说明底子稳。别因为熟了就懒得经营，老夫老妻也得偶尔整点仪式感。`,
      `长跑关系最容易死于"理所当然"。每月制造一次新体验，比每天报平安更扛时间。`
    ]},
    { ok: pp <= 38, salt: 6, t: [
      `最近画风有点丧。先别聊正事，扔个双方都懂的梗把气氛暖起来，负能量最怕冷笑话。`,
      `情绪低落期别硬聊深度。用猫狗图和低成本的陪伴顶着，等情绪回温再谈正事。`
    ]},
    { ok: sb['亲密'] && sb['亲密'].ta >= 75, salt: 8, t: [
      `深夜是真话高发期。下次 TA 半夜找你，别只回"早点睡"，接住情绪比劝睡更拉好感。`,
      `TA 的夜聊体质说明对你有安全感。少说教多倾听，亲密值会自己涨。`
    ]},
    { ok: daily < 3, salt: 9, t: [
      `低频不等于没戏，但容易凉。固定一个微小仪式（比如每晚一句晚安），成本低、存在感稳。`,
      `联系稀疏就别搞大动作。每周一次有质量的对话，比一个月憋一条长语音强。`
    ]},
    { ok: true, salt: 0, t: [
      `关系像植物，不浇水的都会枯。每周至少制造一次有质量的对话，别让记录只剩"收到"。`,
      `别把默契当理所当然。偶尔主动制造一点小惊喜，比天天报平安更能保鲜。`
    ]}
  ]);

  return {
    title: '人间清醒 AI 锐评',
    sub: '毒舌预警 · 玻璃心慎入',
    lines: lines.slice(0, 3),
    adviceTitle: '狗头军师 · 相处建议',
    advice: advice
  };
}

function analyze(id, name, msgs, isGroup) {
  if (!msgs || !msgs.length) return null;
  // 排序（按时间戳）
  msgs = msgs.slice().sort((a, b) => a.t - b.t);
  let N = msgs.length;
  const now = Date.now();

  // 图片/表情统计（图片类消息不参与文本特征分析）
  let meImg = 0, taImg = 0, meEmoji = 0, taEmoji = 0;
  // 系统/卡片文本（撤回提示、revokemsg XML、[链接]/[语音]/[名片] 等）不参与任何文本特征分析
  const isSysText = score.isSys;
  const textMsgs = [];
  for (const m of msgs) {
    if (m.img) {
      if (m.emoji) { if (m.me === 1) meEmoji++; else taEmoji++; }
      else { if (m.me === 1) meImg++; else taImg++; }
    } else if (m.voice) {
      // 语音消息：已有转写文本则注入为正文参与分析；未转写的暂不参与文本特征
      if (m.vt && m.vt.trim()) textMsgs.push(Object.assign({}, m, { c: m.vt }));
    } else if (!isSysText(m)) {
      textMsgs.push(m);
    }
  }
  const imgStats = { meImg, taImg, meEmoji, taEmoji, total: meImg + taImg, emojiTotal: meEmoji + taEmoji };
  if (!textMsgs.length) return null;

  // 群聊：不做关系指数分析，只提供时间线
  const tlMsgs = msgs.filter(m => !m.sys).slice(-60);
  if (isGroup) {
    const timeline = tlMsgs.map((m, i) => ({
      id: 'r' + i,
      time: fmtTime(ts2ms(m.t)),
      from: m.me === 1 ? 'me' : 'ta',
      text: (m.voice && m.vt ? (m.c || '') + ' ' + m.vt : (m.c || '')).slice(0, 200),
      img: !!m.img,
      emoji: !!m.emoji,
      en: m.emoji ? emojiName(m.f) : '',
      md5: m.f || '',
      voice: !!m.voice,
      svr: m.svr || '',
      vt: m.vt || ''
    }));
    return {
      person: { id, name },
      group: true,
      msgCount: N,
      imgStats,
      gauges: [],
      trend: { dates: [], series: [] },
      sternberg: { labels: [], me: [], ta: [] },
      timeline,
      conclusions: []
    };
  }

  // 文本消息参与后续特征分析
  const totalN = N;
  const origMsgs = msgs;
  msgs = textMsgs;
  N = msgs.length;

  // 会话切分：5 分钟无消息视为新段
  const segs = score.splitSegs(msgs);

  // 信号层：发起占比、连发、回复速度差、消息长度比、晚安/早安、关心频率、被晾着的次数……
  // 统计口径全在 score.js，这里和趋势分段共用同一份实现，避免两处各算一套、数字对不上
  const sig = score.signalsOf(msgs, { segs });
  const { meStarts, taStarts, meCnt, taCnt, meRatio, taRatio, startRatio } = sig;

  let meLate = 0, taLate = 0;        // 22:00-02:00 双方各自深夜消息
  let meLong = 0, taLong = 0;        // >20 字 双方各自长消息
  const replies = [];                // 我发→TA下一条 间隔
  const taReplies = [];              // TA发→我下一条 间隔
  const totalSpan = ts2ms(msgs[N - 1].t) - ts2ms(msgs[0].t);
  const totalDays = Math.max(1, totalSpan / 86400000);

  for (const m of msgs) {
    const c = (m.c || '').trim();
    const h = new Date(ts2ms(m.t)).getHours();
    const late = h >= 22 || h < 2, long = c.length > 20;
    if (m.me === 1) { if (late) meLate++; if (long) meLong++; }
    else { if (late) taLate++; if (long) taLong++; }
  }
  // 双向回复间隔：我发→TA下一条 / TA发→我下一条（24h 内）
  let meSlow = 0, taSlow = 0;
  for (let i = 0; i < N - 1; i++) {
    const gap = (ts2ms(msgs[i + 1].t) - ts2ms(msgs[i].t)) / 1000;
    if (gap < 0 || gap >= 86400) continue;
    if (msgs[i].me === 1 && msgs[i + 1].me === 0) { replies.push(gap); if (gap > 1800) taSlow++; }
    if (msgs[i].me === 0 && msgs[i + 1].me === 1) { taReplies.push(gap); if (gap > 1800) meSlow++; }
  }
  replies.sort((a, b) => a - b);
  taReplies.sort((a, b) => a - b);
  const midReply = replies.length ? replies[Math.floor(replies.length / 2)] : 7200;
  const midTaReply = taReplies.length ? taReplies[Math.floor(taReplies.length / 2)] : 7200;
  const replyScore = Math.max(0, Math.min(100, 100 - (midReply / 60) * 1.2));
  const taReplyScore = Math.max(0, Math.min(100, 100 - (midTaReply / 60) * 1.2));

  // 关系指数：三个指数各自由多路信号合成，parts 记着每一路贡献了几分（前端可展开看）
  const gs = score.gaugesOf(sig);
  const activeScore = gs.active.value, lovedScore = gs.loved.value, coldScore = gs.cold.value;
  const symScore = score.symmetry(sig);

  // 趋势：按消息条数均分 8 段（每段必有数据，折线保持连续）
  const BUCKET = Math.min(8, Math.max(2, msgs.length));
  const bucketSize = Math.ceil(msgs.length / BUCKET);
  const weeks = [], segDates = [];
  for (let b = 0; b < BUCKET; b++) {
    const from = b * bucketSize, to = Math.min(msgs.length, from + bucketSize);
    const wm = msgs.slice(from, to);
    // 分段走同一套信号与评分函数（不传 now：历史段的"段尾"不该按此刻判断有没有被晾着）。
    // 这样折线的最后一个点 ≈ 上面仪表盘的大数字，两处不会各说各话。
    const wg = score.gaugesOf(score.signalsOf(wm));
    weeks.push({ active: wg.active.value, loved: wg.loved.value, cold: wg.cold.value });
    if (wm.length) segDates.push(fmtDate(ts2ms(wm[Math.floor(wm.length / 2)].t)));
    else if (segDates.length) segDates.push(segDates[segDates.length - 1]);
    else segDates.push(fmtDate(ts2ms(msgs[0].t)));
  }

  // Sternberg 5 维（双向独立：me=你，ta=TA，承诺为双方共享的历史跨度）
  const tShare = Math.min(100, (taCnt / Math.max(1, meCnt + taCnt)) * 100); // TA 消息占比
  const mShare = 100 - tShare;
  const passion = {
    me: Math.round(mShare * 0.5 + startRatio * 50),
    ta: Math.round(tShare * 0.5 + (1 - startRatio) * 50)
  };
  const intimacy = {
    me: Math.min(100, Math.round((meLate / Math.max(1, meCnt)) * 400)),
    ta: Math.min(100, Math.round((taLate / Math.max(1, taCnt)) * 400))
  };
  const commit = { me: Math.min(100, Math.round((totalDays / 365) * 100)), ta: Math.min(100, Math.round((totalDays / 365) * 100)) };
  // 责任：谁更快回对方——ta 维=TA 回你（replyScore），me 维=你回 TA（taReplyScore）
  // 区分度增强：超过 30 分钟才回复的"拖延占比"按 0.6 系数惩罚，避免双方都秒回时双双饱和 100
  const meSlowR = taReplies.length ? meSlow / taReplies.length : 0;
  const taSlowR = replies.length ? taSlow / replies.length : 0;
  const respon = {
    me: Math.max(0, Math.min(100, Math.round(taReplyScore * (1 - meSlowR * 0.6)))),
    ta: Math.max(0, Math.min(100, Math.round(replyScore * (1 - taSlowR * 0.6))))
  };
  // 信任：谁更愿意敞开心扉——长消息(>20字)占比为主 + 深夜陪伴为辅
  const trust = {
    me: Math.min(100, Math.round((meLong / Math.max(1, meCnt)) * 500 + (meLate / Math.max(1, meCnt)) * 200)),
    ta: Math.min(100, Math.round((taLong / Math.max(1, taCnt)) * 500 + (taLate / Math.max(1, taCnt)) * 200))
  };
  const sternberg = {
    labels: ['激情', '亲密', '承诺', '责任', '信任'],
    me: [passion.me, intimacy.me, commit.me, respon.me, trust.me],
    ta: [passion.ta, intimacy.ta, commit.ta, respon.ta, trust.ta]
  };

  // 时间线：最近 60 条（保证双方都有；含图片/表情消息）
  const timeline = buildTimeline(origMsgs);

  // 结论（启发式）
  const conclusions = [];
  const lastGapDays = (now - ts2ms(msgs[N - 1].t)) / 86400000;
  // 冷淡：不再只念一个百分比，把三个信号一起摆出来（分是怎么来的，结论里也要看得见）
  if (coldScore >= 25) {
    const why = [`「嗯/哦/好」类短回复 ${Math.round(sig.shortPct)}%（${Math.round(sig.shortN)} 条）`];
    if (sig.ignoredN) why.push(`${sig.ignoredN}/${sig.replyN} 次回复让你等了两小时以上`);
    if (sig.taSlowR >= 0.2) why.push(`超过半小时才回占 ${Math.round(sig.taSlowR * 100)}%`);
    conclusions.push({
      level: 'warn', tag: '冷淡', title: `对方敷衍信号明显（冷淡指数 ${coldScore}）`,
      score: coldScore,
      summary: `${why.join('、')}。回应长度偏低、回得偏慢，需关注对话热情。`,
      refs: timeline.slice(-6).filter(x => x.from === 'ta').map(x => x.id).slice(0, 4)
    });
  }
  if (activeScore >= 65) {
    const why = [`你开的话头占 ${Math.round(startRatio * 100)}%`];
    if (sig.bombN) why.push(`有 ${sig.bombN} 段是你在连发（最长 ${sig.bombMax} 条没人接）`);
    if (sig.lenRatio >= 1.3) why.push(`你的消息平均是 TA 的 ${sig.lenRatio.toFixed(2)} 倍长`);
    conclusions.push({
      level: 'info', tag: '主动', title: `你发起对话占 ${Math.round(startRatio * 100)}%`,
      score: activeScore,
      summary: `${why.join('、')}。会话中你推进得更多，可适当放缓节奏观察对方主动频率。`,
      refs: timeline.filter(x => x.from === 'me').slice(-4).map(x => x.id)
    });
  }
  // 单向投入：主动高、被爱低——她不一样 里这条是「强制高亮」，不管排第几都要说
  if (activeScore >= 68 && lovedScore <= 45) {
    conclusions.unshift({
      level: 'warn', tag: '单向', title: `单向投入预警（对称性 ${symScore}）`,
      score: 100 - symScore,
      summary: `你的主动指数 ${activeScore}，却只换回 ${lovedScore} 的被爱指数。不是谁不够好，是这段对话目前主要由你一个人在推——先看清楚，再决定要不要继续加码。`,
      refs: timeline.filter(x => x.from === 'me').slice(-4).map(x => x.id)
    });
  }
  // 反过来：TA 一直在找你，别装看不见
  if (lovedScore >= 68 && activeScore <= 45) {
    conclusions.unshift({
      level: 'good', tag: '被在意', title: `TA 在主动，而你回应得少（对称性 ${symScore}）`,
      score: lovedScore,
      summary: `TA 的被爱侧信号很强（${lovedScore} 分）：主动找你、回得快${sig.nightN ? '、' + sig.nightN + ' 次晚安/早安' : ''}${sig.careN ? '、' + sig.careN + ' 次关心' : ''}。这种热度会被冷落耗尽的。`,
      refs: timeline.filter(x => x.from === 'ta').slice(-4).map(x => x.id)
    });
  }
  if (intimacy.ta >= 15) {
    const tlTimes = msgs.slice(-60).map(m => ts2ms(m.t));
    const lateIds = timeline.filter((x, i) => {
      const h = new Date(tlTimes[i]).getHours();
      return h >= 22 || h < 2;
    }).map(x => x.id).slice(0, 4);
    conclusions.push({
      level: 'good', tag: '深夜', title: `深夜（22点-2点）消息占比 ${Math.round((meLate + taLate) / N * 100)}%`,
      score: Math.round(intimacy.ta),
      summary: `你们存在深夜交流习惯，通常代表较高的亲密程度与安全感。`,
      refs: lateIds
    });
  }
  if (commit.me >= 50) {
    conclusions.push({
      level: 'good', tag: '长情', title: `这段对话已持续 ${Math.round(totalDays / 30)} 个月`,
      score: Math.round(commit.me),
      summary: `历史跨度超过半年，关系具备长期沉淀基础。`,
      refs: [timeline[0]?.id, timeline[timeline.length - 1]?.id].filter(Boolean)
    });
  }
  if (lastGapDays <= 3) {
    conclusions.push({
      level: 'info', tag: '活跃', title: `最近一次对话在 ${lastGapDays < 1 ? '今天' : lastGapDays < 2 ? '昨天' : Math.round(lastGapDays) + ' 天前'}`,
      score: Math.max(0, Math.round(100 - lastGapDays * 10)),
      summary: `关系处于活跃期，适合保持当前互动节奏。`,
      refs: timeline.slice(-2).map(x => x.id)
    });
  }

  // 信任开放度：谁更愿意敞开心扉
  const trustDiff = trust.me - trust.ta;
  if (trust.me >= 60 && trust.ta >= 60) {
    conclusions.push({
      level: 'good', tag: '交心', title: '双向都在敞开心扉',
      score: Math.round((trust.me + trust.ta) / 2),
      summary: `你的长消息/深夜倾诉占比 ${trust.me}%，TA 为 ${trust.ta}%，深度交流充分，信任基础稳固。`,
      refs: timeline.filter(x => x.text.length > 20).slice(-4).map(x => x.id)
    });
  } else if (trustDiff <= -20) {
    conclusions.push({
      level: 'good', tag: '被信任', title: 'TA 更愿意向你敞开心扉',
      score: trust.ta,
      summary: `TA 长消息/深夜倾诉占比 ${trust.ta}%（你 ${trust.me}%），TA 在你面前安全感高，会主动分享心事。`,
      refs: timeline.filter(x => x.from === 'ta' && x.text.length > 20).slice(-4).map(x => x.id)
    });
  } else if (trustDiff >= 20) {
    conclusions.push({
      level: 'info', tag: '主动倾诉', title: '你在单方面分享心事',
      score: trust.me,
      summary: `你的长消息/深夜倾诉占比 ${trust.me}%，高于 TA（${trust.ta}%）。你主动打开心扉，对方回应深度尚未跟上，可引导 TA 多分享。`,
      refs: timeline.filter(x => x.from === 'me' && x.text.length > 20).slice(-4).map(x => x.id)
    });
  } else if (trust.me < 40 && trust.ta < 40) {
    conclusions.push({
      level: 'info', tag: '浅层', title: '对话多停留在日常浅层',
      score: Math.round((trust.me + trust.ta) / 2),
      summary: `双方长消息占比都偏低（你 ${trust.me}% / TA ${trust.ta}%），话题偏事务性。想加深关系，可从分享感受与经历开始。`,
      refs: timeline.slice(-4).map(x => x.id)
    });
  }

  // 回应速度对比：谁回得更快
  const respDiff = respon.ta - respon.me;
  if (Math.abs(respDiff) >= 8) {
    conclusions.push({
      level: respDiff > 0 ? 'good' : 'info',
      tag: '回响', title: `${respDiff > 0 ? '你' : 'TA'}回复明显更快`,
      score: Math.max(respon.me, respon.ta),
      summary: `TA 回你的响应分 ${respon.ta}，你回 TA ${respon.me}，${respDiff > 0 ? '你' : 'TA'}平均回复间隔更短${respDiff > 0 ? '，承接积极' : '，需留意是否单方面热络'}。`,
      refs: timeline.filter(x => x.from === (respDiff > 0 ? 'me' : 'ta')).slice(-3).map(x => x.id)
    });
  }

  // 关系热度趋势：前后半段主动+被爱均值对比
  const half = Math.floor(weeks.length / 2);
  if (half >= 1 && weeks.length - half >= 1) {
    const avg2 = arr => arr.reduce((s, w) => s + w.active + w.loved, 0) / arr.length / 2;
    const a1 = avg2(weeks.slice(0, half)), a2 = avg2(weeks.slice(half));
    const delta = a2 - a1;
    if (delta >= 8) {
      conclusions.push({
        level: 'good', tag: '升温', title: '关系热度近期明显上升',
        score: Math.min(100, Math.round(60 + delta)),
        summary: `后半段互动均值 ${a2.toFixed(0)} 分，比前半段（${a1.toFixed(0)}）高 ${delta.toFixed(0)} 分，近期频率与回应热情都在增强。`,
        refs: timeline.slice(-4).map(x => x.id)
      });
    } else if (delta <= -8) {
      conclusions.push({
        level: 'warn', tag: '降温', title: '关系热度近期有所回落',
        score: Math.max(0, Math.round(60 + delta)),
        summary: `后半段互动均值 ${a2.toFixed(0)} 分，比前半段（${a1.toFixed(0)}）低 ${Math.abs(delta).toFixed(0)} 分，值得主动制造一次高质量对话。`,
        refs: timeline.slice(-4).map(x => x.id)
      });
    }
  }

  // 日均消息密度
  const dailyMsg = N / totalDays;
  if (dailyMsg >= 60) {
    conclusions.push({
      level: 'good', tag: '热络', title: `日均 ${dailyMsg.toFixed(0)} 条消息`,
      score: Math.min(100, Math.round(dailyMsg / 2.4)),
      summary: `这段关系日均消息约 ${dailyMsg.toFixed(0)} 条，互动密度高，属于高频沟通状态。`,
      refs: timeline.slice(-4).map(x => x.id)
    });
  } else if (dailyMsg < 3) {
    conclusions.push({
      level: 'info', tag: '低频', title: `日均不足 ${dailyMsg.toFixed(1)} 条消息`,
      score: Math.max(0, Math.round(dailyMsg * 12)),
      summary: `日均消息量约 ${dailyMsg.toFixed(1)} 条，联系偏稀疏。关系维系需要稳定交流节奏，可尝试固定话题或约定式互动。`,
      refs: timeline.slice(-4).map(x => x.id)
    });
  }

  if (!conclusions.length) {
    conclusions.push({
      level: 'info', tag: '平稳', title: '整体关系平稳',
      score: 50,
      summary: '各项指标处于中等水平，未见明显波动。',
      refs: []
    });
  }

  // 趋势：按消息时间均分 8 段，每段必有数据（折线连续）
  const dates = segDates;
  const sActive = weeks.map(v => v ? v.active : null);
  const sLoved = weeks.map(v => v ? v.loved : null);
  const sCold = weeks.map(v => v ? v.cold : null);

  // 热词榜：双方各自高频词。把联系人和我的昵称当噪音源屏蔽掉，
  // 否则「小雨」「老周」这类称呼会稳稳占着榜首，看着像词榜其实是通讯录。
  const wordDrop = nameStems([name, readSettings().myNick]);
  const wordTaken = new Set();
  const topWordsMe = topWords(msgs, true, 14, wordDrop, wordTaken);
  const topWordsTa = topWords(msgs, false, 14, wordDrop, wordTaken);

  // 情绪基调：逐段正向占比 + 总体正向率
  const segRanges = [];
  for (let b = 0; b < BUCKET; b++) segRanges.push([b * bucketSize, Math.min(msgs.length, (b + 1) * bucketSize)]);
  const senti = sentimentSeries(msgs, segRanges);

  // 喜好 + 纪念日：合并手动条目与自动提取（自动条目可被手动编辑/删除屏蔽）
  const personsNow = readJson(path.join(DATA, 'persons.json')) || [];
  const pNow = personsNow.find(x => x.id === id) || {};
  const manLikes = Array.isArray(pNow.likes) ? pNow.likes : [];
  const delLikes = new Set(Array.isArray(pNow.deletedLikes) ? pNow.deletedLikes : []);
  const autoLikes = isGroup ? { me: [], ta: [] } : extractLikes(msgs);
  const likes = {
    me: manLikes.filter(x => x.side === 'me').concat(autoLikes.me.filter(x => !delLikes.has(x.text) && !manLikes.some(m => m.text === x.text))).map(x => ({ id: x.id || ('auto:' + x.text), text: x.text, count: x.count || 1, tag: x.tag || '自动', manual: !!x.manual })),
    ta: manLikes.filter(x => x.side === 'ta').concat(autoLikes.ta.filter(x => !delLikes.has(x.text) && !manLikes.some(m => m.text === x.text))).map(x => ({ id: x.id || ('auto:' + x.text), text: x.text, count: x.count || 1, tag: x.tag || '自动', manual: !!x.manual }))
  };
  const manAnniv = Array.isArray(pNow.anniversaries) ? pNow.anniversaries : [];
  if (pNow.anniversary && !manAnniv.some(a => a.date === pNow.anniversary)) manAnniv.unshift({ id: 'anniv-manual-0', label: '纪念日', date: pNow.anniversary, manual: true });
  const autoAnniv = isGroup ? [] : extractAnniversaries(msgs);
  const delAnniv = Array.isArray(pNow.deletedAnniversaries) ? pNow.deletedAnniversaries : [];
  const annivSeen = new Set(manAnniv.map(a => a.date + '|' + a.label));
  const anniversaries = manAnniv.concat(autoAnniv.filter(a => !annivSeen.has(a.date + '|' + a.label) && !delAnniv.some(d => d.date === a.date && d.label === a.label))).map(a => ({
    id: a.id || ('auto:' + a.date + ':' + a.label),
    label: a.label,
    date: a.date,
    auto: !!a.auto,
    manual: !!a.manual,
    days: anniversaryDays(a.date)
  })).slice(0, 10);
  let nextAnniversary = null;
  for (const a of anniversaries) {
    if (a.days !== null && (nextAnniversary === null || a.days < nextAnniversary.days)) nextAnniversary = a;
  }
  if (nextAnniversary) nextAnniversary = { date: nextAnniversary.date, days: nextAnniversary.days, label: nextAnniversary.label };

  // ---------- 年度报告统计 ----------
  // 用「会话段」（5 分钟断段）当一次聊天来数，比按天更贴近体感：
  // 一天里断断续续聊三次就是三次，而不是笼统算成一天。
  let lateSegs = 0, hotSegs = 0, maxSegN = 0, maxSegAt = 0;
  for (const s of segs) {
    const h0 = new Date(ts2ms(s[0].t)).getHours();
    if (h0 >= 22 || h0 < 2) lateSegs++;            // 深夜开聊
    if (s.length >= 20) hotSegs++;                 // 热火朝天：一口气 20 条以上
    if (s.length > maxSegN) { maxSegN = s.length; maxSegAt = s[0].t; }
  }
  // 连续聊天天数：把「有消息的日期」排成序号，找最长连号；中间的断档就是最长沉默
  const dayNums = [...new Set(msgs.map(m => Math.floor(ts2ms(m.t) / 86400000)))].sort((a, b) => a - b);
  let streak = 1, maxStreak = 1, maxSilence = 0;
  for (let i = 1; i < dayNums.length; i++) {
    const gap = dayNums[i] - dayNums[i - 1];
    if (gap === 1) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else { streak = 1; if (gap - 1 > maxSilence) maxSilence = gap - 1; }
  }
  // 「最快回复」要排除同秒连发：gap=0 只是语速快，不是"秒回"，写进报告很怪
  const firstReal = (arr) => {
    const v = (arr || []).find(x => x >= 1);
    return v === undefined ? 0 : Math.round(v);
  };
  const report = {
    spanDays: Math.round(totalDays),
    totalMsgs: totalN,
    textMsgs: N,
    dailyMsg: N / totalDays,
    chatTimes: segs.length,                        // 一共聊了多少次
    lateSegs, hotSegs,
    lateNightMsgs: meLate + taLate,
    meLate, taLate,
    maxSegN, maxSegAt,
    meStarts, taStarts,
    maxStreak, maxSilence,
    taFastest: firstReal(replies),                 // TA 回得最快的一次（秒）
    meFastest: firstReal(taReplies),               // 我回得最快的一次（秒）
    taMidReply: Math.round(midReply),                             // TA 回我的中位数（秒）
    meMidReply: Math.round(midTaReply),
    meMsgs: meCnt, taMsgs: taCnt,
    meLong, taLong,
    firstAt: msgs[0] && msgs[0].t,
    lastAt: msgs[N - 1] && msgs[N - 1].t,
    imgStats
  };

  return {
    person: { id, name },
    msgCount: totalN,
    dailyMsg: N / totalDays,
    spans: { days: totalDays, msgN: totalN },
    imgStats,
    coldDays: Math.max(0, Math.round(lastGapDays)),
    nextAnniversary,
    anniversaries,
    likes,
    roast: buildRoast({ id, name, gauges: [
      { key: 'active', label: '主动指数', value: activeScore },
      { key: 'loved', label: '被爱指数', value: lovedScore },
      { key: 'cold', label: '冷淡指数', value: coldScore }
    ], signals: sig, symmetry: symScore, coldDays: Math.max(0, Math.round(lastGapDays)), dailyMsg: N / totalDays, sentiment: { positivePct: senti.positivePct }, topWords: { me: topWordsMe, ta: topWordsTa }, nextAnniversary, imgStats, sternberg, reply: { meMid: midTaReply, taMid: midReply }, spans: { days: totalDays, msgN: totalN } }),
    topWords: { me: topWordsMe, ta: topWordsTa },
    sentiment: { positivePct: senti.positivePct, series: senti.series },
    // 指数的颜色 + 构成（parts：每路信号实际是多少、贡献了几分）
    gauges: [
      Object.assign({ key: 'active', label: '主动指数', color: COLORS.active }, gs.active),
      Object.assign({ key: 'loved', label: '被爱指数', color: COLORS.loved }, gs.loved),
      Object.assign({ key: 'cold', label: '冷淡指数', color: COLORS.cold }, gs.cold)
    ],
    signals: sig,
    symmetry: symScore,
    trend: {
      dates,
      series: [
        { key: 'active', label: '主动指数', color: COLORS.active, values: sActive },
        { key: 'loved', label: '被爱指数', color: COLORS.loved, values: sLoved },
        { key: 'cold', label: '冷淡指数', color: COLORS.cold, values: sCold }
      ]
    },
    sternberg,
    timeline,
    conclusions: conclusions.slice(0, 8),
    report
  };
}

function md5hex(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

const MSG_VERSION = 5; // v5: 系统消息（撤回/revokemsg/lt=10000）打 sys 标记，不参与文本特征分析；v4: server_id/local_id 唯一键去重

function ensureMessages(person) {
  const dest = path.join(MSG_DIR, `${person.id}.json`);
  const cached = readJson(dest);
  if (cached && Array.isArray(cached.list)) return cached.list;
  if (Array.isArray(cached)) return cached;
  return null;
}

// ---------- 应用设置（持久化到 DATA/settings.json） ----------
const SETTINGS_PATH = path.join(DATA, 'settings.json');
function readSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) { s = {}; }
  return s || {};
}
function writeSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s || {}, null, 1), 'utf8'); } catch (e) {}
}

// ---------- HTTP 服务 ----------

// ---------- 全自动抓取（剪贴板监听导入） ----------
let grabSession = null; // { running, personId, lastText, raw, count, nicksSet, startedAt }

// 解析「多选→复制」文本格式：
//   昵称
//   2026年08月26日 15:32
//   内容
//   （空行分隔下一条）
// 每块 3 行（昵称/时间/内容）；内容可为多行（时间行之后到空行前的行全算内容）。
const CN_TIME_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{1,2})$/;
function parseCnTime(s) {
  const m = CN_TIME_RE.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
  return Math.floor(new Date(y, mo - 1, d, hh, mm).getTime() / 1000); // 按本地时区解析
}
function parseClipboardText(text, myNick) {
  const list = [];
  const nicks = new Set();
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  let cur = [];
  for (const ln of lines) {
    if (ln.trim() === '') { if (cur.length) { blocks.push(cur); cur = []; } continue; }
    cur.push(ln);
  }
  if (cur.length) blocks.push(cur);
  let si = 0;
  for (const b of blocks) {
    if (b.length < 3) continue;
    const nick = b[0].trim();
    const t = parseCnTime(b[1]);
    if (!t || !nick) continue;
    const content = b.slice(2).join('\n').trim();
    if (!content) continue;
    nicks.add(nick);
    const me = (myNick && nick === myNick) ? 1 : 0;
    const base = { t, s: si++, me };
    let item;
    if (/^\[图片\]/.test(content)) {
      const m2 = /^\[图片\]\s*(.+)$/.exec(content);
      item = Object.assign({ c: '[图片]', img: true }, base);
      if (m2 && m2[1]) {
        item.f = m2[1].trim();
        // 从图片文件名提取秒级时间戳，用于匹配明文缩略图缓存（注意：正则仍匹配真实文件名前缀）
        const tsM = /微信图片_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(item.f);
        if (tsM) {
          const y = +tsM[1], mo = +tsM[2], d = +tsM[3], hh = +tsM[4], mm = +tsM[5], ss = +tsM[6];
          const ts = Math.floor(new Date(y, mo - 1, d, hh, mm, ss).getTime() / 1000);
          if (ts) { item.t = ts; item.imgTs = ts; }
        }
      }
    } else if (/^\[表情\]/.test(content)) {
      item = Object.assign({ c: '[表情]', img: true, emoji: true }, base);
    } else if (/^\[语音/.test(content)) {
      item = Object.assign({ c: content, voice: true }, base);
    } else {
      item = Object.assign({ c: content }, base);
    }
    list.push(item);
  }
  list.sort((a, b) => (a.t - b.t) || (a.s - b.s));
  return { list, nicks: [...nicks] };
}

// 把解析出的消息并入某联系人的消息缓存（去重、排序、回写缓存与 persons 元数据）
function importClipboardIntoPerson(personId, list) {
  const personsPath = path.join(DATA, 'persons.json');
  const persons = readJson(personsPath) || [];
  const person = persons.find(x => x.id === personId);
  if (!person) return { error: '联系人不存在' };
  const dest = path.join(MSG_DIR, `${personId}.json`);
  const cached = readJson(dest);
  const existing = (cached && Array.isArray(cached.list)) ? cached.list : [];
  const seen = new Set();
  const merged = [];
  const genId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  for (const m of existing) { const k = `${m.me}|${m.t}|${m.c}`; if (!seen.has(k)) { if (!m._id) m._id = genId(); seen.add(k); merged.push(m); } }
  let added = 0;
  for (const m of list) { const k = `${m.me}|${m.t}|${m.c}`; if (!seen.has(k)) { m._id = genId(); seen.add(k); merged.push(m); added++; } }
  merged.sort((a, b) => (a.t - b.t) || ((a.s || 0) - (b.s || 0)));
  fs.writeFileSync(dest, JSON.stringify({ v: MSG_VERSION, list: merged }), 'utf8');
  if (merged.length) {
    countCache.set(personId, merged.length);
    lastCache.set(personId, merged[merged.length - 1].t);
    firstCache.set(personId, merged[0].t);
    person.msgs = merged.length;
    person.first = merged[0].t;
    person.last = merged[merged.length - 1].t;
  }
  fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
  return { added, total: merged.length };
}

// 异步读剪贴板文字（PowerShell Get-Clipboard，UTF-8 输出，不阻塞事件循环）
function readClipboardAsync(cb) {
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw'], { windowsHide: true });
  } catch (e) { cb(''); return; }
  let out = '';
  let done = false;
  const finish = v => { if (!done) { done = true; cb(v); } };
  child.stdout.on('data', d => { out += d.toString(); });
  child.on('close', () => finish(out.replace(/\r\n/g, '\n').trim()));
  child.on('error', () => finish(''));
  setTimeout(() => { try { child.kill(); } catch (e) {} finish(out.replace(/\r\n/g, '\n').trim()); }, 3000);
}
// 轮询剪贴板：检测到新内容 → 累积原文 + 记录昵称（导入在停止时统一执行，以便先用 myNick 正确归属）
function pollClipboard() {
  if (!grabSession || !grabSession.running) return;
  readClipboardAsync(text => {
    if (grabSession && grabSession.running) {
      if (text && text !== grabSession.lastText) {
        grabSession.lastText = text;
        grabSession.count++;
        if (grabSession.raw) grabSession.raw += '\n\n';
        grabSession.raw += text;
        const { nicks } = parseClipboardText(text, '');
        for (const n of nicks) grabSession.nicksSet.add(n);
      }
      setTimeout(pollClipboard, 700);
    }
  });
}

// ---------- 明文缩略图缓存（不解密）：本地已解码的 _thumb.jpg，按消息秒级时间戳匹配 ----------
let thumbIndex = null; // 秒级 unix 时间戳 -> 缩略图绝对路径
function buildThumbIndex() {
  if (thumbIndex) return thumbIndex;
  thumbIndex = new Map();
  let accounts;
  try { accounts = fs.readdirSync(XWECHAT_ROOT); } catch (e) { return thumbIndex; }
  for (const acc of accounts) {
    const cacheDir = path.join(XWECHAT_ROOT, acc, 'cache');
    let months;
    try { months = fs.readdirSync(cacheDir); } catch (e) { continue; }
    for (const mo of months) {
      const msgDir = path.join(cacheDir, mo, 'Message');
      let contacts;
      try { contacts = fs.readdirSync(msgDir); } catch (e) { continue; }
      for (const c of contacts) {
        const thumbDir = path.join(msgDir, c, 'Thumb');
        let files;
        try { files = fs.readdirSync(thumbDir); } catch (e) { continue; }
        for (const f of files) {
          const m = /^(\d+)_(\d{10})_thumb\.jpg$/.exec(f);
          if (m) { const ts = parseInt(m[2], 10); if (!thumbIndex.has(ts)) thumbIndex.set(ts, path.join(thumbDir, f)); }
        }
      }
    }
  }
  return thumbIndex;
}
function thumbPath(ts) {
  const t = Number(ts);
  if (!t) return null;
  buildThumbIndex();
  // 先精确匹配，再 ±2 秒容差兜底
  if (thumbIndex.has(t)) return thumbIndex.get(t);
  for (let d = 1; d <= 2; d++) {
    if (thumbIndex.has(t - d)) return thumbIndex.get(t - d);
    if (thumbIndex.has(t + d)) return thumbIndex.get(t + d);
  }
  return null;
}

// 访问口令（opt-in）：存在 temp/access_pwd.txt 时，所有 /api 请求需 Basic 认证或 ?pwd=
const ACCESS_PWD = (() => { try { return fs.readFileSync(path.join(__dirname, 'temp', 'access_pwd.txt'), 'utf8').trim(); } catch (e) { return ''; } })();
function authOk(req, url) {
  if (!ACCESS_PWD) return true;
  const ah = req.headers['authorization'] || '';
  if (ah.startsWith('Basic ')) {
    try { if (Buffer.from(ah.slice(6), 'base64').toString('utf8') === 'ta-love-app:' + ACCESS_PWD) return true; } catch (e) {}
  }
  try { if (url.searchParams.get('pwd') === ACCESS_PWD) return true; } catch (e) {}
  return false;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p.startsWith('/api/') && !authOk(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="ta-love-app"' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized', needPassword: true }));
  }

  if (p === '/api/persons') {
    const list = readJson(path.join(DATA, 'persons.json')) || [];
    // 动态计算冷场天数（不落盘，仅返回）：优先用消息缓存实时 last，缺省回退 persons.json 的 last
    const now = Date.now();
    for (const it of list) {
      const realLast = lastReady && lastCache.has(it.id) ? lastCache.get(it.id) : it.last;
      const realFirst = lastReady && firstCache.has(it.id) ? firstCache.get(it.id) : it.first;
      const gap = realLast ? Math.floor((now - ts2ms(realLast)) / 86400000) : 0;
      it.coldDays = gap;
      it.last = realLast || it.last;
      it.first = realFirst || it.first;
      if (lastReady && countCache.has(it.id)) it.msgs = countCache.get(it.id);
    }
    return json(res, list);
  }

  // ---------- 承诺追踪：自动识别 + 用户手动维护合成一份 ----------
  if (p.startsWith('/api/promises/')) {
    const pid = decodeURIComponent(p.slice('/api/promises/'.length));
    const persons = readJson(path.join(DATA, 'persons.json')) || [];
    const person = persons.find(x => x.id === pid);
    if (!person) return err(res, 404, '联系人不存在');
    const msgs = ensureMessages(person) || [];
    const autoItems = person.group ? [] : detectPromises(msgs);
    const box = mergePromises(pid, autoItems);
    const out = () => json(res, {
      ok: true,
      keepForever: box.keepForever,
      keepDays: PROMISE_KEEP_DAYS,
      items: box.items.filter(it => !it.deleted),
    });

    if (req.method === 'GET') {
      // 打开卡片时顺手把超期的已兑现项清掉（和 To Do 同一套规则）
      if (pruneDonePromises(box)) savePromises(pid, box);
      return out();
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(body || '{}'); } catch (e) {}
        const op = String(b.op || '');
        if (op === 'add') {
          const text = String(b.text || '').trim().slice(0, 120);
          if (!text) return err(res, 400, '内容不能为空');
          box.items.unshift({
            id: 'pm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
            text,
            who: b.who === 'ta' ? 'ta' : 'me',
            at: Math.floor(Date.now() / 1000),
            auto: false, done: false, doneAt: 0, edited: true, deleted: false,
          });
        } else if (op === 'update') {
          const it = box.items.find(x => x.id === b.id);
          if (!it) return err(res, 404, '这条承诺已经不在了');
          if (b.text != null) {
            const t = String(b.text).trim().slice(0, 120);
            if (!t) return err(res, 400, '内容不能为空');
            it.text = t; it.edited = true;   // 打了 edited 标记，之后重算分析不会被识别结果覆盖回去
          }
          if (b.who != null) { it.who = b.who === 'ta' ? 'ta' : 'me'; it.edited = true; }
          if (b.done != null) { it.done = !!b.done; it.doneAt = it.done ? Date.now() : 0; }
        } else if (op === 'delete') {
          const it = box.items.find(x => x.id === b.id);
          if (!it) return err(res, 404, '这条承诺已经不在了');
          it.deleted = true;   // 留痕，否则下次重算又被识别出来
        } else if (op === 'keep') {
          box.keepForever = !!b.value;
        } else if (op === 'clearDone') {
          box.items = box.items.filter(x => !x.done);
        }
        savePromises(pid, box);
        return out();
      });
      return;
    }
  }

  // ---------- 应用设置：读取 / 保存（自动导入模式等） ----------
  if (req.method === 'GET' && p === '/api/settings') {
    return json(res, readSettings());
  }
  if (req.method === 'PUT' && p === '/api/settings') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const cur = readSettings();
      if (b.myNick != null) cur.myNick = String(b.myNick).trim(); // 我的昵称（用于剪贴板导入时区分我/TA）
      writeSettings(cur);
      return json(res, { ok: true, settings: cur });
    });
    return;
  }

  // ---------- 本地小AI：状态 / 后端探测 / 准备模型 / 生成 ----------
  // 就绪守卫：没准备好就立刻回话，绝不顺着 ensureModel() 一路走到「下载几个 GB 内置模型」
  // ——一个 HTTP 请求就那么挂着（实测挂死过 5 分钟）。四个 AI 接口共用这一份判定。
  const aiReadyOr503 = (res) => {
    const st = ai.status();
    if (st.ready) return true;
    err(res, 503, st.downloading
      ? ('模型正在下载（' + Math.round(st.progress || 0) + '%），下完再点')
      : ('本地 AI 还没就绪' + (st.error ? '：' + st.error : '，先在左侧「本地小AI」里启用')));
    return false;
  };
  // AI 接口统一入口：读 JSON 体 → 廉价前置校验 → 就绪守卫 → 交给 handler。
  // 六个接口原先各自抄一遍「读 body + 守卫 + try/catch」，这里收成一处，
  // 免得以后加接口时漏掉守卫（漏一次就是一个挂死 5 分钟的请求）。
  // 顺序很关键：先做**不碰模型**的校验（比如「这个联系人存在吗」），再查模型就绪。
  // 反过来的话，查一个不存在的联系人会得到 503，语义就撒谎了。
  // 需要 4xx 而不是 500 的场合，用 bad(code, msg) 抛。
  const bad = (code, msg) => Object.assign(new Error(msg), { code });
  const aiRoute = (req, res, handler, validate) => {
    readBodyJson(req, (b) => {
      let pre;
      if (validate) {
        try { pre = validate(b || {}); }
        catch (e) { return err(res, (e && e.code) || 400, (e && e.message) || '参数不对'); }
      }
      if (!aiReadyOr503(res)) return;
      Promise.resolve(handler(b || {}, pre))
        .then((out) => json(res, out))
        .catch((e) => {
          const code = (e && e.code >= 400 && e.code < 600) ? e.code : 500;
          err(res, code, (e && e.message) ? e.message : 'AI 生成失败');
        });
    });
  };

  if (req.method === 'GET' && p === '/api/ai/status') {
    return json(res, ai.status());
  }
  if (req.method === 'POST' && p === '/api/ai/setup') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      // b.tier 指定档位，不传就用上次的
      // 注意：内置档位首次要下几个 GB，不能让 HTTP 请求一直挂着等——1.2 秒没完成就先回
      // 当前状态（含 downloading/progress），前端继续轮询 /api/ai/status 看进度。
      let done = false;
      const reply = () => { if (done) return; done = true; json(res, ai.status()); };
      ai.setup(b).then(reply).catch(e => {
        if (done) return;
        done = true;
        err(res, 500, (e && e.message) ? e.message : '准备失败');
      });
      setTimeout(reply, 1200);
    });
    return;
  }
  // 真·AI 锐评
  if (req.method === 'POST' && p === '/api/ai/roast') {
    return aiRoute(req, res, (b) => {
      if (!b.d || typeof b.d !== 'object') throw new Error('缺少分析数据');
      return ai.roast(b.d);
    });
  }
  // 情感基调 + 关系洞察
  if (req.method === 'POST' && p === '/api/ai/enrich') {
    return aiRoute(req, res, (b) => {
      if (!b.d || typeof b.d !== 'object') throw new Error('缺少分析数据');
      return ai.aiAnalyze(b.d);
    });
  }
  // 狗头军师 · 相处建议（真 AI）：把服务端模板建议换成模型按真实统计现写的
  if (req.method === 'POST' && p === '/api/ai/advice') {
    return aiRoute(req, res, (b) => {
      if (!b.d || typeof b.d !== 'object') throw new Error('缺少分析数据');
      return ai.advice(b.d);
    });
  }
  // 年度报告结尾寄语（真 AI）
  if (req.method === 'POST' && p === '/api/ai/blessing') {
    return aiRoute(req, res, (b) => {
      if (!b.d || typeof b.d !== 'object') throw new Error('缺少分析数据');
      return ai.blessing(b.d);
    });
  }
  // To Do 清单锐评（真 AI）：清单是用户自己写的，本地模型跑，不外传
  if (req.method === 'POST' && p === '/api/ai/todo') {
    return aiRoute(req, res, (b) => {
      const todos = Array.isArray(b.todos) ? b.todos : [];
      if (!todos.length) throw bad(400, '还没有待办，先加两条再让它评');
      if (todos.length > 60) throw bad(400, '待办太多了，先清理一下再让它评');
      return ai.todoRoast({ todos });
    });
  }

  // 热词榜 AI 归纳：把规则选出的候选词交给本地模型归类。
  // 结果按「联系人 + 消息条数」缓存 —— 同一个数据不重复跑模型，省算力也省等待。
  if (req.method === 'POST' && p === '/api/topwords/ai') {
    return aiRoute(req, res, async (b) => {
      const person = (readJson(path.join(DATA, 'persons.json')) || []).find(x => x.id === String(b.personId || ''));
      if (!person) throw bad(404, '联系人不存在');

      const msgs = ensureMessages(person) || [];
      if (!msgs.length) throw bad(400, '还没有聊天记录');

      const cachePath = path.join(DATA, 'ai_topics.json');
      const cache = readJson(cachePath) || {};
      const hit = cache[person.id];
      if (hit && hit.n === msgs.length && b.force !== true) return hit.out;

      const drop = nameStems([person.name, readSettings().myNick]);
      // 双方各取前 20 个，合并去重后给模型；给太多它反而抓不住重点
      const merged = new Map();
      const seenW = new Set();
      for (const w of [...topWords(msgs, true, 20, drop, seenW), ...topWords(msgs, false, 20, drop, seenW)]) {
        merged.set(w.w, Math.max(merged.get(w.w) || 0, w.n));
      }
      const cands = [...merged.entries()].map(([w, n]) => ({ w, n })).sort((a, b2) => b2.n - a.n).slice(0, 40);
      if (!cands.length) throw bad(400, '高频词太少，归纳不出话题');

      const out = await ai.topics(person.name, cands);
      if (out.topics && out.topics.length) {
        cache[person.id] = { n: msgs.length, out };
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1), 'utf8');
      }
      return out;
    }, (b) => {
      const person = (readJson(path.join(DATA, 'persons.json')) || []).find(x => x.id === String(b.personId || ''));
      if (!person) throw bad(404, '联系人不存在');
      return person;   // 传给 handler 用，省得再查一遍
    });
  }

  // ---------- 全自动抓取（剪贴板监听导入） ----------
  if (req.method === 'POST' && p === '/api/grab/start') {
    if (grabSession && grabSession.running) return json(res, { ok: false, running: true });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const personId = String(b.personId || '').trim();
      if (!personId) return err(res, 400, '缺少联系人 ID');
      grabSession = { running: true, personId, lastText: '', raw: '', count: 0, nicksSet: new Set(), startedAt: Date.now() };
      readClipboardAsync(t => { if (grabSession) grabSession.lastText = t; }); // 记录当前剪贴板，避免把旧内容当新复制
      setTimeout(pollClipboard, 700);
      return json(res, { ok: true, running: true, personId });
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/grab/stop') {
    const g = grabSession;
    if (!g) return json(res, { ok: true, count: 0, raw: '', nicks: [] });
    g.running = false;
    return json(res, { ok: true, count: g.count, raw: g.raw, nicks: [...(g.nicksSet || [])] });
  }
  if (req.method === 'GET' && p === '/api/grab/status') {
    const g = grabSession;
    return json(res, { running: g && g.running, count: g ? g.count : 0, nicks: g ? [...(g.nicksSet || [])] : [] });
  }
  // 手动粘贴导入：把一段「多选→复制」文本直接解析并入某联系人（不依赖剪贴板轮询）
  if (req.method === 'POST' && p === '/api/grab/import') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const personId = String(b.personId || '').trim();
      const text = String(b.text || '');
      if (!personId || !text) return err(res, 400, '缺少联系人 ID 或文本');
      const myNick = String(b.myNick || readSettings().myNick || '').trim();
      const { list, nicks } = parseClipboardText(text, myNick);
      const r = importClipboardIntoPerson(personId, list);
      if (r.error) return err(res, 404, r.error);
      return json(res, { ok: true, added: r.added, total: r.total, nicks, needMyNick: !myNick && nicks.length > 1 });
    });
    return;
  }

  // 手动 AI 评估：重新运行完整分析，返回最新 AI 结论（前端刷新结论卡）
  if (req.method === 'POST' && /^\/api\/person\/[^/]+\/reanalyze$/.test(p)) {
    const id = p.split('/')[3];
    const persons = readJson(path.join(DATA, 'persons.json')) || [];
    const person = persons.find(x => x.id === id);
    if (!person) return err(res, 404, '未找到该联系人');
    const msgs = ensureMessages(person);
    if (!msgs) return err(res, 404, '该联系人无有效消息');
    const data = analyze(id, person.name, msgs, !!(person.group));
    if (!data) return err(res, 404, '该联系人无有效消息');
    return json(res, { ok: true, msgCount: data.msgCount, conclusions: data.conclusions, analyzedAt: Date.now() });
  }

  // 明文缩略图缓存：按消息秒级时间戳返回本地已解码的 _thumb.jpg（无需解密）
  if (p === '/api/img-thumb') {
    const ts = url.searchParams.get('ts') || '';
    const file = thumbPath(ts);
    let buf = null;
    if (file) { try { buf = fs.readFileSync(file); } catch (e) { buf = null; } }
    if (!buf) {
      // 没缓存到就回一张 1×1 透明 GIF，不要回 404。
      // 原因：<img> 收到 404 会让浏览器在控制台刷一条「Failed to load resource」红字，
      // 而「这张图没缩略图」是完全正常的情况（只有点开过的图才会生成），不该当成错误报出来。
      // 前端拿到空图会自己把节点摘掉，视觉上等同没有。
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store',
        'Content-Length': BLANK_GIF.length
      });
      return res.end(BLANK_GIF);
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    return res.end(buf);
  }

  // 喜好条目维护：add / edit / del（自动条目删除进黑名单，编辑则转手动）
  if (req.method === 'PUT' && /^\/api\/person\/[^/]+\/likes$/.test(p)) {
    const id = p.split('/')[3];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const action = b.action, item = b.item || {};
      const personsPath = path.join(DATA, 'persons.json');
      const persons = readJson(personsPath) || [];
      const person = persons.find(x => x.id === id);
      if (!person) return err(res, 404, '未找到该联系人');
      person.likes = Array.isArray(person.likes) ? person.likes : [];
      person.deletedLikes = Array.isArray(person.deletedLikes) ? person.deletedLikes : [];
      if (action === 'add') {
        const text = String(item.text || '').trim().slice(0, 12);
        const side = item.side === 'me' ? 'me' : 'ta';
        if (!text) return err(res, 400, '内容不能为空');
        if (!person.likes.some(x => x.text === text && x.side === side)) {
          person.likes.push({ id: 'likes-' + Date.now(), side, text, tag: item.tag || '手动', manual: true });
        }
      } else if (action === 'edit') {
        const text = String(item.text || '').trim().slice(0, 12);
        if (!text) return err(res, 400, '内容不能为空');
        const idx = person.likes.findIndex(x => x.id === item.id);
        if (idx >= 0) { person.likes[idx].text = text; if (item.tag) person.likes[idx].tag = item.tag; }
        else {
          const autoText = String(item.id || '').startsWith('auto:') ? String(item.id).slice(5) : '';
          if (autoText) person.deletedLikes.push(autoText);
          person.likes.push({ id: 'likes-' + Date.now(), side: item.side === 'me' ? 'me' : 'ta', text, tag: item.tag || '手动', manual: true });
        }
      } else if (action === 'del') {
        const idx = person.likes.findIndex(x => x.id === item.id);
        if (idx >= 0) person.likes.splice(idx, 1);
        else if (String(item.id || '').startsWith('auto:')) person.deletedLikes.push(String(item.id).slice(5));
      } else return err(res, 400, '未知操作');
      fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
      return json(res, { ok: true, id });
    });
    return;
  }

  // 纪念日条目维护：add / edit / del（自动条目删除进黑名单）
  if (req.method === 'PUT' && /^\/api\/person\/[^/]+\/anniversaries$/.test(p)) {
    const id = p.split('/')[3];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const action = b.action, item = b.item || {};
      const personsPath = path.join(DATA, 'persons.json');
      const persons = readJson(personsPath) || [];
      const person = persons.find(x => x.id === id);
      if (!person) return err(res, 404, '未找到该联系人');
      person.anniversaries = Array.isArray(person.anniversaries) ? person.anniversaries : [];
      person.deletedAnniversaries = Array.isArray(person.deletedAnniversaries) ? person.deletedAnniversaries : [];
      const validDate = s => /^(\d{4}-)?\d{2}-\d{2}$/.test(s);
      if (action === 'add') {
        const date = String(item.date || '').trim();
        const label = String(item.label || '纪念日').trim().slice(0, 10);
        if (!validDate(date)) return err(res, 400, '日期格式应为 MM-DD 或 YYYY-MM-DD');
        person.anniversaries.push({ id: 'anniv-' + Date.now(), label, date, manual: true });
      } else if (action === 'edit') {
        const date = String(item.date || '').trim();
        const label = String(item.label || '纪念日').trim().slice(0, 10);
        if (!validDate(date)) return err(res, 400, '日期格式应为 MM-DD 或 YYYY-MM-DD');
        const idx = person.anniversaries.findIndex(x => x.id === item.id);
        if (idx >= 0) {
          person.anniversaries[idx].date = date;
          person.anniversaries[idx].label = label;
          // 编辑的是旧版 anniversary 字段派生的手动条目时，同步更新顶层字段
          if (item.id === 'anniv-manual-0') person.anniversary = date;
        } else {
          const key = String(item.id || '').startsWith('auto:') ? String(item.id).slice(5) : '';
          const [ad, al] = key.split(':');
          if (ad && al) person.deletedAnniversaries.push({ date: ad, label: al });
          person.anniversaries.push({ id: 'anniv-' + Date.now(), label, date, manual: true });
          if (String(item.id || '') === 'anniv-manual-0') person.anniversary = date;
        }
      } else if (action === 'del') {
        const idx = person.anniversaries.findIndex(x => x.id === item.id);
        if (idx >= 0) {
          person.anniversaries.splice(idx, 1);
          // 删除旧版 anniversary 派生的手动条目时，同步清除顶层字段
          if (item.id === 'anniv-manual-0') delete person.anniversary;
        }
        else if (String(item.id || '').startsWith('auto:')) {
          const key = String(item.id).slice(5);
          const [ad, al] = key.split(':');
          if (ad && al) person.deletedAnniversaries.push({ date: ad, label: al });
        }
      } else return err(res, 400, '未知操作');
      fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
      return json(res, { ok: true, id });
    });
    return;
  }

  // 自定义头像：三选一 —— 上传图片 / 用 emoji或文字 / 恢复默认（昵称首字）
  // 图片落盘到 data/avatars/<id>.<ext>，persons.json 只存文件名，避免把 base64 塞进 JSON 里越滚越大。
  if (req.method === 'PUT' && /^\/api\/person\/[^/]+\/avatar$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    const personsPath = path.join(DATA, 'persons.json');
    const persons = readJson(personsPath) || [];
    const person = persons.find(x => x.id === id);
    if (!person) return err(res, 404, '未找到该联系人');
    let body = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;                       // 已经超限就不再往内存里堆
      body += c;
      if (body.length > 9e6) { tooBig = true; body = ''; }
    });
    req.on('end', () => {
      // 超限要好好回一个 413 再断开。直接 req.destroy() 会让客户端只看到连接被掐，
      // 拿不到任何说明（测试里就是这么暴露出来的）。
      if (tooBig) return err(res, 413, '图片太大了（限 4MB），先压一下再传');
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const old = person.avatarImg;
      const save = (patch) => {
        Object.assign(person, patch);
        fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
        if (old && old !== person.avatarImg) { try { fs.unlinkSync(path.join(AVATAR_DIR, old)); } catch (e) {} }
        return json(res, { ok: true, id, avatar: person.avatar, avatarImg: person.avatarImg || '', url: person.avatarImg ? '/api/avatar/' + id + '?v=' + Date.now() : '' });
      };

      if (b.reset) return save({ avatar: (person.name || '?')[0] || '?', avatarImg: '' });

      if (b.img != null) {
        // 只认这几种位图，扩展名由我们自己定，绝不采信客户端给的文件名
        const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.img));
        if (!m) return err(res, 400, '只支持 PNG / JPG / WebP / GIF 图片');
        const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
        const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
        if (!buf.length) return err(res, 400, '图片是空的');
        if (buf.length > 4 * 1024 * 1024) return err(res, 413, '图片太大了（限 4MB），先压一下再传');
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
        const file = id + '.' + ext;
        const dest = path.join(AVATAR_DIR, file);
        fs.writeFileSync(dest, buf);
        return save({ avatarImg: file });
      }

      const text = String(b.text == null ? '' : b.text).trim().slice(0, 4);
      if (!text) return err(res, 400, '内容不能为空');
      return save({ avatar: text, avatarImg: '' });
    });
    return;
  }

  // 取联系人头像图。文件名从 persons.json 里读，不接受 URL 传参，避免路径穿越。
  if (req.method === 'GET' && /^\/api\/avatar\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    const person = (readJson(path.join(DATA, 'persons.json')) || []).find(x => x.id === id);
    const file = person && person.avatarImg;
    if (!file || !/^[A-Za-z0-9_.-]+$/.test(file)) return err(res, 404, '没有自定义头像');
    const full = path.join(AVATAR_DIR, file);
    if (!full.startsWith(AVATAR_DIR) || !fs.existsSync(full)) return err(res, 404, '头像文件不在了');
    const type = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[file.split('.').pop()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(full).pipe(res);
  }

  // 置顶/取消置顶联系人：持久化到 persons.json 的 pinned 字段
  if (req.method === 'PUT' && /^\/api\/person\/[^/]+\/pin$/.test(p)) {
    const id = p.split('/')[3];
    const personsPath = path.join(DATA, 'persons.json');
    const persons = readJson(personsPath) || [];
    const person = persons.find(x => x.id === id);
    if (!person) return err(res, 404, '未找到该联系人');
    person.pinned = person.pinned ? false : true;
    fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
    return json(res, { ok: true, id, pinned: person.pinned });
  }


  // 删除联系人：从 persons.json 移除并删除消息缓存（写入备份，可恢复）
  if (req.method === 'DELETE' && /^\/api\/person\/[^/]+$/.test(p)) {
    const id = p.split('/').pop();
    const personsPath = path.join(DATA, 'persons.json');
    const persons = readJson(personsPath) || [];
    const idx = persons.findIndex(x => x.id === id);
    if (idx < 0) return err(res, 404, '未找到该联系人');
    const removed = persons.splice(idx, 1)[0];
    // 备份到 trash.json，避免误删不可恢复
    const trashPath = path.join(DATA, 'trash.json');
    const trash = readJson(trashPath) || [];
    trash.push(Object.assign({ deletedAt: Date.now() }, removed));
    fs.writeFileSync(trashPath, JSON.stringify(trash, null, 1), 'utf8');
    fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
    // 删除消息缓存文件（unlink 失败不致命，仅跳过）
    try {
      const msgFile = path.join(MSG_DIR, `${id}.json`);
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
    } catch (e) {}
    return json(res, { ok: true, removed: removed.name });
  }

  // 新建联系人（仅按昵称建立）
  if (req.method === 'POST' && p === '/api/person') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const name = String(b.name || '').trim();
      if (!name) return err(res, 400, '请输入联系人昵称');
      const personsPath = path.join(DATA, 'persons.json');
      const persons = readJson(personsPath) || [];
      if (persons.some(x => (x.name || '') === name)) return err(res, 409, '已存在同名联系人：' + name);
      const id = md5hex('name:' + name);
      const person = {
        id, user: 'name:' + name, name, avatar: (name[0] || '?'),
        msgs: 0, active: '', pct: 0, group: false,
        last: 0, first: 0, pinned: false,
        likes: [], deletedLikes: [], anniversaries: [], deletedAnniversaries: []
      };
      persons.push(person);
      fs.writeFileSync(personsPath, JSON.stringify(persons, null, 1), 'utf8');
      return json(res, { ok: true, id, name });
    });
    return;
  }

  // 编辑某条消息文字（编辑后打「已编辑」标记）
  if (req.method === 'PUT' && /^\/api\/person\/[^/]+\/message$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body || '{}'); } catch (e) {}
      const msgId = String(b._id || '').trim();
      const nc = String(b.c == null ? '' : b.c).trim();
      if (!msgId) return err(res, 400, '缺少消息 ID');
      if (!nc) return err(res, 400, '内容不能为空');
      const dest = path.join(MSG_DIR, `${id}.json`);
      const cached = readJson(dest);
      if (!cached || !Array.isArray(cached.list)) return err(res, 404, '无消息缓存');
      const msg = cached.list.find(x => x._id === msgId);
      if (!msg) return err(res, 404, '消息不存在');
      msg.c = nc;
      msg.edited = true;
      // 编辑后视为纯文本，清除图片/表情/语音等占位标记
      delete msg.img; delete msg.emoji; delete msg.voice; delete msg.svr; delete msg.f; delete msg.vt;
      fs.writeFileSync(dest, JSON.stringify({ v: MSG_VERSION, list: cached.list }), 'utf8');
      return json(res, { ok: true, edited: true, c: nc });
    });
    return;
  }

  const m = p.match(/^\/api\/person\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const persons = readJson(path.join(DATA, 'persons.json')) || [];
    const person = persons.find(x => x.id === id);
    // 读取消息缓存
    const msgs = person ? ensureMessages(person) : readJson(path.join(MSG_DIR, `${id}.json`));
    if (!msgs) return err(res, 404, '未找到该联系人的聊天数据');
    const name = person ? person.name : id;
    const isGroup = !!(person && person.group);
    const data = analyze(id, name, msgs, isGroup);
    if (!data) return err(res, 404, '该联系人无有效消息');
    return json(res, data);
  }

  let fp = path.normalize(path.join(PUBLIC, p));
  if (!fp.startsWith(PUBLIC)) return err(res, 403, 'Forbidden');
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) return err(res, 404, 'Not Found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(fp).pipe(res);
});

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
// 读请求体并解析成 JSON。全服务里「读 body」都是这五行，收一处省得每处各写一遍。
function readBodyJson(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let o = {};
    try { o = JSON.parse(body || '{}'); } catch (e) {}
    cb(o);
  });
}
// 出错统一回 JSON。原来回的是纯文本，但前端一律按 r.json() 去读，
// 于是下面 50 处调用给出的具体原因全被吞成一句通用的「操作失败」。
// 改在这一处，所有调用方的报错内容一起恢复可读。
function err(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: String(msg == null ? '' : msg) }));
}

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

// 端口被占用时不要抛未捕获异常把进程崩掉。
// 正常双击启动走的是 Electron 单例锁，轮不到这里；但手动 `node server.js`
// 再开应用、或上一次进程没退干净时，会撞上。给一句人话提示即可。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log('⚠ 端口 ' + PORT + ' 已被占用，服务没能启动。');
    console.log('  通常是「相拥」已经开着，或者有另一个 node 进程在跑。');
    console.log('  请先关掉已打开的窗口，或在任务管理器里结束 node.exe / electron.exe 后重试。');
    console.log('');
    return;
  }
  console.log('服务启动失败：' + ((e && e.message) || e));
});

server.listen(PORT, () => {
  console.log('相拥 · 关系分析室');
  console.log('  数据目录: ' + DATA);
  console.log('  本机访问:  http://localhost:' + PORT);
  console.log('  局域网访问: http://' + lanIP() + ':' + PORT + '  （手机同 Wi-Fi 可开）');
  setImmediate(warmLastCache);
});
