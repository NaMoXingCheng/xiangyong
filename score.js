// ---------- 关系评分引擎 ----------
// 构成参照开源 skill「她不一样」(she-love-me)：
//   🔥 主动指数 = 主动发起占比 · 连续轰炸 · 回复速度差 · 消息长度比
//   💜 被爱指数 = 对方主动次数 · 晚安/早安 · 关心频率 · 对方响应速度
//   🧊 冷淡指数 = 「嗯/哦/好」单字占比 · 长时间已读不回 · 慢回率
//
// 两条纪律（也是原实现最缺的）：
// 1) 每个指数由多个信号合成，并记下每个信号贡献了多少分（parts）。
//    分数必须能解释——用户点开「关系指数」要能看到这 71 分是怎么来的。
// 2) 所有信号都做成与消息量无关的比值。整段历史算一次、按八分之一分段再算一次，
//    两个口径可以直接比大小：趋势折线的末端不会和仪表盘上的大数字互相打架。
//
// 原实现的问题：active 只看发起占比 + 消息占比；loved 只看消息占比 + 回复速度；
// cold 直接等于单字回复率。于是「话少但每天道晚安」会被评成冷淡，
// 「连发十条刷屏」和「平等地多聊几句」拿到一样的主动分，分数的来历也说不清。

'use strict';

// ---------- 词典 ----------
// 单字/短回复：判定「敷衍」的基本盘
const SHORT_WORDS = /^(嗯|哦|好|哈|行|是|对|啊|噢|诶|哦哦|嗯嗯|好的|好哒|可以|知道|没事|嗯嗯嗯|好吧|哈哈|呵呵|ok|OK|好的呀|嗯呢|嗯那|好滴|晓得|收到|知道啦|行吧)$/;
// 晚安/睡前：一天结束时还想着你，是最低成本的在意（所以比总消息量更能说明温度）
const NIGHT_RE = /晚安|好梦|梦里见|我先睡|睡了|睡觉了|该睡了|早点休息|早点睡|安啦/;
// 早安/晨间：醒来第一个想到的人
const MORN_RE = /早安|早上好|早呀|早啊|起床了|早饭|早餐|醒了没/;
// 关心：不是「聊得开心」，是「惦记你」。都是多字搭配，避免误伤
const CARE_RE = /吃饭了吗|吃饭了没|吃了饭没|吃了没|吃饭没|吃了吗|多穿|加件衣|注意保暖|注意身体|别感冒|别熬夜|少熬夜|照顾自己|注意安全|路上小心|到家了|到家没|到了吗|多喝热水|喝点热水|记得吃药|吃药了|感冒了|生病了|别太累|别累着|注意休息|休息一下|天冷了|降温|带把伞|别着凉/;

const SEG_GAP_MS = 5 * 60 * 1000;    // 5 分钟无消息视为新的一段对话
const IGNORE_MS = 2 * 3600 * 1000;   // 我发完话被晾 2 小时以上，才算「长时间已读不回」
const NOON = 86400 * 1000;

function ts2ms(t) { return t > 1e12 ? t : t * 1000; }

// 系统/卡片文本（撤回提示、XML、[链接] 等）不参与任何文本特征分析
function isSys(m) {
  const s = String(m.c || '');
  return m.sys || /^\[|^<\?xml|revokemsg|撤回了一条消息|^你撤回/.test(s);
}

// ---------- 小工具 ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = v => Math.round(v * 10) / 10;
const pct = v => Math.round(v * 100) + '%';
const sum = parts => parts.reduce((a, p) => a + p.delta, 0);
const score = v => Math.max(0, Math.min(100, Math.round(v)));

// 回复速度档位：秒回才给高分，数值越大越慢
function gradeOf(sec) {
  if (sec <= 30) return 100;
  if (sec <= 120) return 85;
  if (sec <= 600) return 65;
  if (sec <= 1800) return 45;
  if (sec <= 7200) return 25;
  return 10;
}

// 时长文案：420 → "7 分钟"
function dur(sec) {
  if (sec < 60) return Math.round(sec) + ' 秒';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟';
  if (sec < 86400) return (sec / 3600).toFixed(1).replace(/\.0$/, '') + ' 小时';
  return Math.round(sec / 86400) + ' 天';
}

const median = arr => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);

// ---------- 分段：5 分钟无消息算新的一段对话 ----------
function splitSegs(msgs) {
  const segs = [[msgs[0]]];
  for (let i = 1; i < msgs.length; i++) {
    const cur = segs[segs.length - 1];
    if (ts2ms(msgs[i].t) - ts2ms(cur[cur.length - 1].t) > SEG_GAP_MS) segs.push([msgs[i]]);
    else cur.push(msgs[i]);
  }
  return segs;
}

/**
 * 从一段消息里抽出关系信号。全都是比值/比率，与消息量无关。
 * msgs: [{ me: 0|1, c, t }]，已按时间升序
 * opts.segs: 已经分好的段，复用可省一次遍历
 */
function signalsOf(msgs, opts) {
  const o = opts || {};
  const s = {
    N: msgs.length,
    meCnt: 0, taCnt: 0, segN: 0, meStarts: 0, taStarts: 0,
    meRatio: 0, taRatio: 0, startRatio: 0.5, taStartRatio: 0.5,
    bombN: 0, bombMax: 0, bombShare: 0,
    midReply: 7200, midTaReply: 7200, replyGrade: 25,
    meAvgLen: 0, taAvgLen: 0, lenRatio: 1,
    nightN: 0, careN: 0,
    shortN: 0, shortPct: 0, replyN: 0, ignoredN: 0, ignoredThr: 0, ignoredRate: 0, taSlowR: 0
  };
  if (!msgs.length) return s;

  const segs = o.segs || splitSegs(msgs);
  s.segN = segs.length;

  let meChars = 0, meTextN = 0, taChars = 0, taTextN = 0;
  let taShort = 0, runMe = 0, prevT = 0;
  // 结算一段连发。跨段（隔了 5 分钟以上）也要结算 —— 今天连发 3 条、明天再连发 3 条，
  // 那是两次头铁，不是一次连发 6 条
  const settle = () => {
    if (runMe >= 3) s.bombN++;
    if (runMe > s.bombMax) s.bombMax = runMe;
    runMe = 0;
  };
  for (const m of msgs) {
    const c = String(m.c || '').trim();
    const sys = isSys(m);
    const t = ts2ms(m.t);
    if (prevT && t - prevT > SEG_GAP_MS) settle();
    prevT = t;
    if (m.me === 1) {
      runMe++;
      s.meCnt++;
      if (!sys && c) { meChars += c.length; meTextN++; }
      continue;
    }
    settle();          // 被 TA 打断 → 结算一次连发
    s.taCnt++;
    if (c.length <= 4 && SHORT_WORDS.test(c.replace(/[，。！？!?,.~～\s]/g, ''))) taShort++;
    if (!sys && c) { taChars += c.length; taTextN++; }
    if (!sys && (NIGHT_RE.test(c) || MORN_RE.test(c))) s.nightN++;
    if (!sys && CARE_RE.test(c)) s.careN++;
  }
  settle();                                  // 结尾那段也算

  for (const seg of segs) {
    if (seg[0].me === 1) s.meStarts++; else s.taStarts++;
  }

  const replies = [], taReplies = [];
  let taSlow = 0;
  for (let i = 0; i < msgs.length - 1; i++) {
    const gap = (ts2ms(msgs[i + 1].t) - ts2ms(msgs[i].t)) / 1000;
    if (gap < 0 || gap >= 86400) continue;        // 超过一天不算"回复"，是另起一段
    if (msgs[i].me === 1 && msgs[i + 1].me === 0) { replies.push(gap); if (gap > 1800) taSlow++; }
    if (msgs[i].me === 0 && msgs[i + 1].me === 1) taReplies.push(gap);
  }
  replies.sort((a, b) => a - b);
  taReplies.sort((a, b) => a - b);

  s.meRatio = s.meCnt / msgs.length;
  s.taRatio = s.taCnt / msgs.length;
  s.startRatio = s.meStarts / Math.max(1, s.segN);
  s.taStartRatio = 1 - s.startRatio;
  s.bombShare = s.bombN / Math.max(1, s.segN);
  s.midReply = replies.length ? median(replies) : 7200;
  s.midTaReply = taReplies.length ? median(taReplies) : 7200;
  s.replyGrade = gradeOf(s.midTaReply);
  s.meAvgLen = meChars / Math.max(1, meTextN);
  s.taAvgLen = taChars / Math.max(1, taTextN);
  s.lenRatio = s.meAvgLen / Math.max(2, s.taAvgLen);          // 对方短到没话说时别除爆
  s.shortN = taShort;
  s.shortPct = (s.taCnt ? taShort / s.taCnt : 0) * 100;
  s.taSlowR = replies.length ? taSlow / replies.length : 0;

  // 长时间已读不回（TA 那边的「被晾着」）
  // 一开始按「一段对话以我发的话结尾、隔了两小时才有人接」来算，结果真实数据上
  // 三个联系人全被算成 60%+ —— 因为「说完这句今天就聊完了、明天再回」是长跑关系的
  // 常态，不是被晾。实测真实回复间隔：中位数只有 38-60 秒，≥2 小时的只占 2%-5.5%。
  // 所以改成看「间隔本身」：门槛取 max(2 小时, TA 自己中位回复的 8 倍) ——
  // 平时 40 秒就回的人让你等两小时，和平时两小时才回的人让你等两小时，不是一回事。
  s.replyN = replies.length;
  const thr = Math.max(IGNORE_MS / 1000, s.midTaReply * 8);
  s.ignoredN = replies.filter(g => g >= thr).length;
  s.ignoredThr = Math.round(thr);
  s.ignoredRate = s.replyN ? s.ignoredN / s.replyN : 0;
  return s;
}

// ---------- 三个指数 ----------
// 每项返回 { value, parts }，parts 里记着「哪个信号、实际多少、贡献几分」

// 🔥 主动指数：你在推进这段关系上用了多少力。
// 注意它不等于「关系好不好」——分高也可能是你一个人在推，得跟被爱指数一起看。
function scoreActive(s) {
  const parts = [];
  const add = (label, text, delta) => parts.push({ label, text, delta: r1(delta) });
  // 谁先开口：一段对话总得有人开头，你开的比例高就是你在推
  add('你先开口', pct(s.startRatio), (s.startRatio - 0.5) * 46);
  // 消息占比：话多的一方通常也是更在意的一方
  add('消息占比', pct(s.meRatio), (s.meRatio - 0.5) * 36);
  // 连续轰炸：对方没接话你还在发。这是「投入方式」，跟「发得多」是两件事
  add('连发', s.bombN + ' 段 · 最长 ' + s.bombMax + ' 条',
    Math.min(s.bombShare / 0.5, 1) * 14 + (s.bombMax >= 8 ? 6 : 0));
  // 回复速度差：你比 TA 回得快，说明你手机屏幕一直停在 TA 的对话上
  add('回复速度', 'TA ' + dur(s.midTaReply) + ' · 我 ' + dur(s.midReply),
    clamp(Math.log2(Math.max(1, s.midTaReply) / Math.max(1, s.midReply)) * 5, -10, 10));
  // 消息长度比：你打字的量是 TA 的几倍
  add('话更长', s.lenRatio.toFixed(2) + '×', clamp((s.lenRatio - 1) * 8, -8, 8));
  return { value: score(50 + sum(parts)), parts };
}

// 💜 被爱指数：TA 给你的温度。
// 底分 40，不设「聊两句就 50 分」的虚高锚点，要多重强信号一起上扬才给高分。
function scoreLoved(s) {
  const parts = [];
  const add = (label, text, delta) => parts.push({ label, text, delta: r1(delta) });
  add('TA 消息占比', pct(s.taRatio), (s.taRatio - 0.5) * 46);
  add('TA 先开口', pct(s.taStartRatio), (s.taStartRatio - 0.5) * 26);
  add('TA 回复速度', dur(s.midTaReply), (s.replyGrade - 50) * 0.5);
  // 晚安/早安：TA 每 100 条消息里有 5 条是道晚安/早安，就算稳定习惯
  add('晚安/早安', s.nightN + ' 次', Math.min(s.nightN / Math.max(1, s.taCnt) / 0.05, 1) * 12);
  // 关心频率：每 100 条里有 4 条在惦记你
  add('关心你', s.careN + ' 次', Math.min(s.careN / Math.max(1, s.taCnt) / 0.04, 1) * 12);
  // 单向打折：你一个人撑起的对话，不能算成 TA 的热情
  add('单向打折', '你撑起 ' + pct(s.startRatio), -Math.abs(s.startRatio - 0.5) * 24);
  return { value: score(40 + sum(parts)), parts };
}

// 🧊 冷淡指数：TA 的敷衍与回避
function scoreCold(s) {
  const parts = [];
  const add = (label, text, delta) => parts.push({ label, text, delta: r1(delta) });
  // 字少：三个「嗯」抵不上一句「我在忙但想你了」。shortPct 已经是百分数，别再乘 100
  add('单字短回', Math.round(s.shortPct) + '%', Math.min(66, s.shortPct * 0.75));
  // 晾着：TA 回我的次数里，有多少次让我等了异常久（超过它自己节奏的 8 倍）
  add('被晾着', s.ignoredN + ' / ' + s.replyN + ' 次', Math.min(24, s.ignoredRate / 0.15 * 24));
  // 慢回：超过半小时才回的占比
  add('慢回', pct(s.taSlowR), Math.min(10, s.taSlowR / 0.5 * 10));
  return { value: score(sum(parts)), parts };
}

/**
 * 三指数总入口。
 * 返回 { active: {value, parts}, loved: {...}, cold: {...} }
 */
function gaugesOf(s) {
  return { active: scoreActive(s), loved: scoreLoved(s), cold: scoreCold(s) };
}

/**
 * 对称性（0-100）：这段关系是不是两个人在共同经营。
 * 100 = 轮流开口、消息量对等；0 = 一个人全包。
 * 借鉴 she-love-me 的「单相思强制提醒」。
 * 特意用原始信号算，而不是拿两个指数的差 —— 主动和被爱各有各的中心值（50 / 40），
 * 差值本身不衡量"对等"；信号还能直接说出不对等在哪。
 */
function symmetry(s) {
  const imbStart = Math.abs(s.startRatio - 0.5) * 2;   // 谁在开头：0 = 轮流，1 = 全包
  const imbMsg = Math.abs(s.taRatio - 0.5) * 2;        // 谁在说话：0 = 对等，1 = 全包
  return score(100 - (imbStart * 0.6 + imbMsg * 0.4) * 100);
}

module.exports = {
  SHORT_WORDS, NIGHT_RE, MORN_RE, CARE_RE,
  SEG_GAP_MS, IGNORE_MS,
  ts2ms, isSys, splitSegs, signalsOf,
  gradeOf, dur, gaugesOf, symmetry,
  scoreActive, scoreLoved, scoreCold
};
