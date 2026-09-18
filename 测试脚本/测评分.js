/**
 * 关系评分引擎的边界用例（纯 Node，不需要起 Electron）。
 *
 * 目的不是「跑通」，而是把三件事摆出来看清楚：
 *   1) 三个指数在极端关系上真的会动 —— 均衡 / 单方面追 / 被追，得分必须拉开
 *   2) 分数能解释 —— value 必须等于底分 + 各分项之和，parts 不许是装饰
 *   3) 口径一致 —— 整段历史算一次，和分段算八次的最后一个点，不能各说各话
 *
 * 用法：node 测试脚本/测评分.js
 */
const score = require('../score.js');

let pass = 0, fail = 0;
const fails = [];
function check(ok, label) {
  if (ok) pass++; else { fail++; fails.push('  ✗ ' + label); }
}

// ---------- 造数据：按「天」往下排，一天一段对话 ----------
const DAY = 86400, T0 = Date.UTC(2026, 0, 1) / 1000;
const say = (me, c, t) => ({ me, c, t });

// ① 均衡：隔天轮流开头，互相接话，睡前互道晚安
function balanced() {
  const out = [];
  for (let d = 0; d < 40; d++) {
    const t = T0 + d * DAY;
    if (d % 2 === 0) {
      out.push(say(1, '今天上班好累啊，你呢', t));
      out.push(say(0, '我也刚下班，吃饭了没', t + 180));
      out.push(say(1, '还没，随便煮点面', t + 400));
      out.push(say(0, '别老吃面，点个有菜的外卖', t + 600));
    } else {
      out.push(say(0, '在干嘛呢', t));
      out.push(say(1, '在改方案，头大', t + 150));
      out.push(say(0, '加油，忙完早点休息', t + 350));
      out.push(say(1, '好，你也早点睡', t + 500));
    }
    out.push(say(1, '晚安', t + 700));
    out.push(say(0, '晚安', t + 760));
  }
  return out;
}

// ② 单向：我每天开三次话连发，TA 回一个「嗯」。三种日子各占一部分：
//    d%5==0 → TA 干脆不回（被晾着）；d%5==1 → TA 一小时后才回（慢回）；其余 → 四分钟后回
function oneSided() {
  const out = [];
  for (let d = 0; d < 40; d++) {
    const t = T0 + d * DAY;
    out.push(say(1, '在忙吗，今天想你了', t));
    out.push(say(1, '刚看到一家新开的店', t + 90));
    out.push(say(1, '周末要不要一起去', t + 180));
    if (d % 5 === 0) continue;                 // TA 没回，这段就晾在这儿
    const back = d % 5 === 1 ? 3600 : 240;
    out.push(say(0, '嗯', t + back));
    out.push(say(1, '那就这么定啦，我订位子', t + back + 60));
    out.push(say(0, '哦', t + back + 180));
  }
  return out;
}

// ③ TA 主动：TA 每天先开口，回得快，还总念叨吃饭和加衣
function pursued() {
  const out = [];
  for (let d = 0; d < 40; d++) {
    const t = T0 + d * DAY;
    out.push(say(0, '早，早饭吃了吗', t));
    out.push(say(1, '刚起，随便对付', t + 120));
    out.push(say(0, '不行，多穿点，今天降温了', t + 300));
    out.push(say(1, '好', t + 420));
    out.push(say(0, '晚上早点休息，别熬夜', t + 600));
    out.push(say(1, '知道了', t + 700));
    out.push(say(0, '晚安', t + 900));
  }
  return out;
}

// ⑤ 偶尔把你晾着：TA 平时一分钟就回，前 5 次却拖了 5 小时。
//    门槛是 max(2 小时, TA 自己中位回复的 8 倍)，所以「拖」要相对 TA 自己的节奏来判
function sometimesSlow() {
  const out = [];
  for (let d = 0; d < 25; d++) {
    const t = T0 + d * DAY;
    const back = d < 5 ? 18000 : 60;          // 前 5 天像消失了一样
    out.push(say(1, '今天怎么样', t));
    out.push(say(0, '还行', t + back));
    out.push(say(1, '那就好', t + back + 60));
  }
  return out;
}

// ⑥ 一向就慢：TA 每次都在一小时后才回 —— 这是 TA 的节奏，不该被算成「被晾着」
function constantSlow() {
  const out = [];
  for (let d = 0; d < 10; d++) {
    const t = T0 + d * DAY;
    out.push(say(1, '在吗', t), say(0, '在的', t + 3600), say(1, '那说好了', t + 3660));
  }
  return out;
}

// ④ 空 / 单条 / 全是系统消息（不该崩）
const edge = [
  [[], '空数组'],
  [[say(1, '在吗', T0)], '只有一条'],
  [[say(1, '嗯', T0), say(0, '哦', T0 + 60)], '一条对一条'],
];

// ================= 开始跑 =================
const BAL = score.signalsOf(balanced());
const ONE = score.signalsOf(oneSided());
const PUR = score.signalsOf(pursued());
const SLOW = score.signalsOf(sometimesSlow());
const CSLOW = score.signalsOf(constantSlow());
const gB = score.gaugesOf(BAL), gO = score.gaugesOf(ONE), gP = score.gaugesOf(PUR);

console.log('【信号】均衡   ', fmt(BAL));
console.log('【信号】单向   ', fmt(ONE));
console.log('【信号】被追   ', fmt(PUR));
console.log('【指数】均衡   ', gv(gB));
console.log('【指数】单向   ', gv(gO));
console.log('【指数】被追   ', gv(gP));
console.log('');
function fmt(s) {
  return [
    '发起占比 ' + Math.round(s.startRatio * 100) + '%',
    '连发 ' + s.bombN + ' 段(最长' + s.bombMax + ')',
    '短回 ' + Math.round(s.shortPct) + '%',
    '晾 ' + s.ignoredN + '/' + s.replyN + ' 次',
    '长度比 ' + s.lenRatio.toFixed(2),
    '晚安 ' + s.nightN,
    '关心 ' + s.careN,
    'TA均回 ' + Math.round(s.midTaReply) + 's',
  ].join(' | ');
}
function gv(g) {
  return '主动 ' + g.active.value + ' / 被爱 ' + g.loved.value + ' / 冷淡 ' + g.cold.value;
}

// ---------- 1. 极端关系必须拉开差距 ----------
check(gB.active.value >= 38 && gB.active.value <= 62, `均衡关系主动指数居中（${gB.active.value}）`);
check(gB.loved.value >= 55, `均衡关系被爱指数不低（${gB.loved.value}）`);
check(gB.cold.value <= 15, `均衡关系冷淡指数很低（${gB.cold.value}）`);
check(score.symmetry(BAL) >= 80, `均衡关系对称性高（${score.symmetry(BAL)}）`);

check(gO.active.value >= 70, `单向关系主动指数偏高（${gO.active.value}）`);
check(gO.loved.value <= 45, `单向关系被爱指数偏低（${gO.loved.value}）`);
check(gO.cold.value >= 40, `单向关系冷淡指数偏高（${gO.cold.value}）`);
check(score.symmetry(ONE) <= 50, `单向关系对称性低（${score.symmetry(ONE)}）`);
check(gO.cold.value > gB.cold.value + 30, '冷淡指数：单向明显高于均衡');

check(gP.loved.value >= 62, `被追时被爱指数高（${gP.loved.value}）`);
check(gP.active.value <= 45, `被追时主动指数低（${gP.active.value}）`);
check(gP.cold.value <= 20, `被追时冷淡指数低（${gP.cold.value}）`);
check(gP.loved.value > gO.loved.value + 20, '被爱指数：被追明显高于单向');

// ---------- 2. 信号层算得对不对 ----------
check(ONE.startRatio >= 0.8, `单向：绝大多数对话是我开的（${Math.round(ONE.startRatio * 100)}%）`);
check(ONE.bombN === 40, `单向：每天那段三连发都被计到（${ONE.bombN} 段）`);
check(ONE.bombMax === 3, `单向：最长连发 3 条，跨天不累加（实测 ${ONE.bombMax}）`);
check(ONE.replyN === 64, `单向：TA 回我的次数统计到（${ONE.replyN}）`);
check(ONE.taSlowR >= 0.1, `单向：慢回率被算到（${Math.round(ONE.taSlowR * 100)}%）`);
check(BAL.bombN === 0, '均衡：没有连发段');
check(BAL.ignoredN === 0, '均衡：没有被晾着的段');
check(BAL.nightN >= 40, `均衡：TA 的晚安类语句被数到（实测 ${BAL.nightN}，「早点休息」也该算）`);
check(PUR.nightN >= 40, `被追：晚安+早起问候被数到（实测 ${PUR.nightN}）`);
check(PUR.careN >= 80, `被追：关心类语句被数到（实测 ${PUR.careN}）`);
check(BAL.careN >= 20, `均衡：「吃饭了没」这类算关心（实测 ${BAL.careN}）`);
check(ONE.careN === 0, '单向：TA 的「嗯/哦」不算关心');
check(ONE.shortPct >= 99, `单向：TA 全是单字回复（${Math.round(ONE.shortPct)}%）`);
check(BAL.lenRatio < 1.2, `均衡：消息长度比接近 1（${BAL.lenRatio.toFixed(2)}）`);
check(ONE.lenRatio > 3, `单向：我说得明显更长（${ONE.lenRatio.toFixed(2)}x）`);

// 「被晾着」：门槛是 max(2 小时, TA 中位回复 × 8)，得能区分「偶尔失联」和「一向就慢」
check(SLOW.ignoredN === 5, `被晾着：平时 1 分钟回、突然拖 5 小时的 5 次被抓到（实测 ${SLOW.ignoredN}/${SLOW.replyN}）`);
check(Math.abs(SLOW.ignoredRate - 0.2) < 0.01, `被晾着：比例 20%（实测 ${(SLOW.ignoredRate * 100).toFixed(0)}%）`);
check(SLOW.ignoredThr === 7200, `被晾着：门槛落在 2 小时（实测 ${SLOW.ignoredThr}s）`);
check(CSLOW.taSlowR >= 0.9, `慢回率：TA 每次都超过半小时才回（实测 ${Math.round(CSLOW.taSlowR * 100)}%）`);
check(CSLOW.ignoredN === 0, `一向就慢的人不算「被晾着」——门槛抬到自己节奏的 8 倍（实测 ${CSLOW.ignoredN}）`);
check(ONE.ignoredN === 0, '单向（TA 一小时后回）没被误判成被晾着');
check(score.scoreCold(SLOW).value > score.scoreCold(BAL).value + 10,
  `偶尔失联会推高冷淡指数（${score.scoreCold(SLOW).value} vs 均衡 ${score.scoreCold(BAL).value}）`);
check(score.scoreCold(BAL).value === 0, '均衡关系不会被慢回冤枉（冷淡 0）');

// ---------- 3. 分数必须能解释（value = 底分 + 分项和） ----------
for (const [key, g] of [['主动', gB.active], ['被爱', gB.loved], ['冷淡', gB.cold],
  ['主动', gO.active], ['被爱', gO.loved], ['冷淡', gO.cold]]) {
  const base = key === '主动' ? 50 : key === '被爱' ? 40 : 0;
  const s = base + g.parts.reduce((a, p) => a + p.delta, 0);
  check(Math.abs(Math.round(s) - g.value) <= 1, `${key}指数：分项之和能还原总分（${Math.round(s)} vs ${g.value}）`);
  check(g.parts.every(p => p.label && typeof p.delta === 'number' && !Number.isNaN(p.delta)), `${key}指数：每项都带标签和分值`);
  check(g.value >= 0 && g.value <= 100, `${key}指数在 0-100 内（${g.value}）`);
}

// ---------- 4. 口径一致：分段算出来的最后一段，不能和整体差一个量级 ----------
function bucketOf(msgs) {
  const B = 8, size = Math.ceil(msgs.length / B);
  const last = msgs.slice((B - 1) * size);
  return score.gaugesOf(score.signalsOf(last));
}
for (const [label, msgs, g] of [['均衡', balanced(), gB], ['单向', oneSided(), gO]]) {
  const b = bucketOf(msgs);
  for (const k of ['active', 'loved', 'cold']) {
    check(Math.abs(b[k].value - g[k].value) <= 30,
      `${label}：趋势末段与整体同口径（${k} ${b[k].value} vs ${g[k].value}）`);
  }
}

// ---------- 5. 边界情况 ----------
for (const [msgs, label] of edge) {
  try {
    const s = score.signalsOf(msgs);
    const g = score.gaugesOf(s);
    const ok = ['active', 'loved', 'cold'].every(k => g[k].value >= 0 && g[k].value <= 100 && !Number.isNaN(g[k].value));
    check(ok, `${label}：不炸且分数合法`);
  } catch (e) {
    check(false, `${label}：不炸（实际抛了 ${e.message}）`);
  }
}

// ---------- 6. 词典：该识别的识别，不该误伤的别误伤 ----------
const DIC = [
  ['晚安', true, '晚安'], ['好梦', true, '晚安'], ['我睡了', true, '晚安'],
  ['早安', true, '早安'], ['早上好', true, '早安'],
  ['吃饭了吗', true, '关心'], ['多穿点，降温了', true, '关心'], ['记得吃药', true, '关心'],
  ['周末去爬山吧', false, '约玩，不是关心'], ['今天好累', false, '吐槽'],
  ['我在开会', false, '事务'], ['哈哈哈哈', false, '无意义'],
  ['这个多少钱', false, '问价'], ['我到家了', true, '关心'],
];
for (const [text, want, note] of DIC) {
  const s = score.signalsOf([say(0, text, T0), say(1, '收到', T0 + 60)]);
  const got = s.nightN > 0 || s.careN > 0;
  check(got === want, `词典「${text}」（${note}）${got ? '识别' : '不识别'}，预期${want ? '识别' : '不识别'}`);
}

// TA 从来没回过我 —— 没有回复就谈不上「回复慢」，不该凭空扣分
const noReply = score.signalsOf([say(1, '在吗', T0), say(1, '想你了', T0 + 60), say(1, '算了', T0 + 120)]);
check(noReply.ignoredN === 0 && noReply.ignoredRate === 0, 'TA 从没回过：不计「被晾着」，也不除零');
check(noReply.replyN === 0, 'TA 从没回过：回复次数为 0');

console.log(`用例 ${pass + fail} 条：通过 ${pass}，不通过 ${fail}\n`);
if (fails.length) { console.log('—— 需要关注的 ——'); console.log(fails.join('\n')); }
else console.log('✅ 全部符合预期');
process.exit(fail ? 1 : 0);
