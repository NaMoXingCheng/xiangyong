/**
 * 造一份「看起来像真的」聊天数据，用于本地看效果。
 * 数据结构与 server.js 的剪贴板导入完全一致：
 *   data/persons.json          [{ id, name, msgs, first, last }]
 *   data/messages/<id>.json    { v: 5, list: [{ t, s, me, c, _id }] }
 * t = 秒级时间戳，me = 1 是我 / 0 是对方，s = 同秒内排序序号。
 *
 * 用法：node 测试脚本/造演示数据.js
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const MSG_DIR = path.join(DATA, 'messages');
fs.mkdirSync(MSG_DIR, { recursive: true });

// 可复现的伪随机
let seed = 20260917;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }
function chance(p) { return rnd() < p; }

// ---------------- 语料池 ----------------
// 我主动开场
const ME_OPEN = [
  '在吗', '在干嘛呢', '下班了吗', '吃饭了没', '今天怎么样',
  '想你了', '刚忙完，累瘫了', '那个剧更新了，看吗', '周末有空吗',
  '今天天气特别好', '我给你点了杯奶茶', '睡了吗', '在忙吗',
  '刚才路过那家店，想起你了', '今天开会开到怀疑人生', '晚上想吃什么',
];
// 对方回应（偏短、偏敷衍 —— 这是要锐的点）
const TA_COLD = [
  '嗯', '哦', '好的', '刚在忙', '知道了', '晚点说', '困了',
  '在开会', '嗯嗯', '明天吧', '哈哈', '看到了', '行',
];
// 对方偶尔热情
const TA_WARM = [
  '刚忙完！在的在的', '今天也累死了，抱抱', '刚看到，想你了',
  '好啊好啊，几点', '我刚到家，你吃了吗', '那你早点休息呀',
  '我今天也遇到个离谱的事，跟你说', '好呀，周末我都行',
];
// 我的追问
const ME_FOLLOW = [
  '那你先忙', '好，等你', '记得吃饭', '早点休息', '嗯，我也睡了',
  '那我先不打扰你了', '明天聊', '抱抱，晚安', '好，那你忙完了跟我说一声',
  '哦……好吧', '行吧', '知道啦',
];
// 我吐槽/分享（长句，用于长聊日）
const ME_STORY = [
  '今天我们组那个需求又改了，第三次了，我当场就想站起来走人',
  '你猜怎么着，我楼下那只橘猫今天主动蹭我腿，我怀疑它认我做干爹了',
  '我最近在学做饭，今天炒了个蛋炒饭，卖相一般但味道居然还行',
  '刚看完那个电影，结局我有点没缓过来，明天跟你说细节',
  '我今天早起跑了三公里，现在腿废了，你千万别学我',
];
const TA_STORY = [
  '哈哈哈你太惨了', '真的假的，拍张照给我看看', '我也想看那个电影',
  '你好厉害呀', '那你可得坚持', '我最近也想运动，但起不来',
  '我这边也挺忙的，甲方又改方案', '先说好，下次带我去',
];
// 对方偶尔也发长消息（否则「TA 长消息占比」永远是 0，图表会很难看）
const TA_LONG = [
  '今天开会开到八点，回来还要改方案，真的累',
  '我最近睡得很晚，白天一直昏昏沉沉的',
  '那个店我去过，环境挺好的，就是有点远',
  '我妈今天又催我了，我都不知道怎么回她',
  '我最近在想要不要换个工作，感觉没什么意思',
  '刚跟同事吃了顿好的，突然觉得上班也没那么难熬',
];
// 承诺 / 邀约（以后做承诺追踪时的素材）
const PROMISE = [
  '下周带你去吃那家火锅，说好了', '我保证这次不迟到', '下个月陪你去趟海边',
  '这个周末我陪你去逛街，一定', '下次一定带你去看',
];
// 晚安结束
const GOODNIGHT_ME = ['那我睡啦，晚安', '晚安，做个好梦', '我先睡了，明天聊', '晚安呀'];
const GOODNIGHT_TA = ['晚安', '嗯，晚安', '好梦', '你也是'];

const EMOJI = ['[表情]', '[表情]', '[表情]'];

function tsOf(y, mo, d, h, mi, s) { return Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000); }

// ---------------- 生成一个人的聊天 ----------------
function genPerson(id, name, startY, startM, startD, endY, endM, endD, profile) {
  const list = [];
  let s = 0;
  const start = new Date(startY, startM - 1, startD);
  const end = new Date(endY, endM - 1, endD);

  for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const y = cur.getFullYear(), mo = cur.getMonth() + 1, d = cur.getDate();
    const dow = cur.getDay();
    const isWeekend = dow === 0 || dow === 6;

    // 冷场期：整段不聊
    const dayIdx = Math.floor((cur - start) / 86400000);
    if (profile.coldRanges.some(([a, b]) => dayIdx >= a && dayIdx <= b)) continue;
    const silenceP = isWeekend ? profile.silenceWeekend : profile.silenceWeekday;
    if (chance(silenceP)) continue;

    // 一天分几个「会话块」：早上 / 中午 / 晚上 / 深夜
    const blocks = [];
    if (chance(0.45)) blocks.push([7, 9]);
    if (chance(0.5)) blocks.push([12, 14]);
    blocks.push([19, 22]);                                   // 晚上基本都有
    if (chance(profile.lateNightP)) blocks.push([0, 3]);     // 深夜

    for (const [h0, h1] of blocks) {
      // 「热火朝天」的日子：一口气几十条，且间隔要短
      // —— 否则会被服务端「5 分钟无消息即新段」的规则切成好几段，报告里就统计不出来
      const isLong = profile.longChatP > 0 && chance(profile.longChatP);
      const n = isLong ? 32 + Math.floor(rnd() * 30) : 1 + Math.floor(rnd() * 3);
      let h = h0 + Math.floor(rnd() * Math.max(1, h1 - h0));
      let mi = Math.floor(rnd() * 60);
      const late = h0 === 0;

      // 我发起（profile.meOpenP 概率我主动）
      let meTurn = chance(profile.meOpenP);
      for (let i = 0; i < n; i++) {
        let msg;
        if (meTurn) {
          if (isLong && chance(0.4)) msg = { c: pick(ME_STORY) };
          else if (chance(0.1)) msg = { c: pick(PROMISE) };
          else if (chance(0.07)) msg = { c: '[表情]', img: true, emoji: true };
          else if (chance(0.04)) msg = { c: '[图片]', img: true };
          else msg = { c: pick(ME_OPEN) };
        } else {
          if (isLong && chance(0.35)) msg = { c: pick(TA_LONG) };
          else if (isLong && chance(0.4)) msg = { c: pick(TA_STORY) };
          else if (chance(0.06)) msg = { c: '[表情]', img: true, emoji: true };
          else if (chance(0.3)) msg = { c: pick(TA_WARM) };
          else msg = { c: pick(TA_COLD) };
        }
        // 图片/表情要写成真正的 img 标记（跟剪贴板导入解析出来的结构一致），否则统计不到
        list.push(Object.assign({ t: tsOf(y, mo, d, h, mi, Math.floor(rnd() * 60)), s: s++, me: meTurn ? 1 : 0 }, msg));

        // 推进时间：热聊时十几秒一条；平时我回得慢、TA 回得快
        const gap = isLong
          ? (meTurn ? 12 + Math.floor(rnd() * 90) : 8 + Math.floor(rnd() * 130))
          : (meTurn ? 40 + Math.floor(rnd() * 400) : 20 + Math.floor(rnd() * 900));
        mi += Math.floor(gap / 60); h += Math.floor(mi / 60); mi %= 60;
        if (h > 23) { h = 23; mi = 59; }
        meTurn = !meTurn;
      }
      // 晚安收尾
      if (!late && chance(0.5)) {
        list.push({ t: tsOf(y, mo, d, h, mi, 0), s: s++, me: 1, c: pick(GOODNIGHT_ME) });
        list.push({ t: tsOf(y, mo, d, h, Math.min(59, mi + 1), 0), s: s++, me: 0, c: pick(GOODNIGHT_TA) });
      }
    }
  }

  list.sort((a, b) => (a.t - b.t) || (a.s - b.s));
  list.forEach((m, i) => { m._id = 'm' + i.toString(36) + Math.random().toString(36).slice(2, 6); });

  fs.writeFileSync(path.join(MSG_DIR, id + '.json'), JSON.stringify({ v: 5, list }), 'utf8');
  return {
    id, name,
    msgs: list.length,
    first: list.length ? list[0].t : 0,
    last: list.length ? list[list.length - 1].t : 0,
  };
}

// ---------------- 三个人 ----------------
const persons = [];

// 主对象：她（数据最多，也最值得锐）
persons.push(genPerson('p-d', '她', 2025, 9, 17, 2026, 9, 14, {
  meOpenP: 0.78,          // 我主动多
  lateNightP: 0.28,       // 深夜聊天频率
  longChatP: 0.14,        // 热火朝天的日子
  silenceWeekday: 0.18,
  silenceWeekend: 0.1,
  coldRanges: [[40, 44], [150, 156], [268, 271]],   // 三段时间几乎断联
}));

// 老妈（对比用，短）
persons.push(genPerson('p-mom', '老妈', 2025, 9, 17, 2026, 9, 15, {
  meOpenP: 0.35,
  lateNightP: 0.02,
  longChatP: 0.05,
  silenceWeekday: 0.45,
  silenceWeekend: 0.3,
  coldRanges: [[100, 108]],
}));

// 一个普通朋友
persons.push(genPerson('p-friend', '老周', 2026, 1, 1, 2026, 9, 13, {
  meOpenP: 0.5,
  lateNightP: 0.12,
  longChatP: 0.2,
  silenceWeekday: 0.5,
  silenceWeekend: 0.4,
  coldRanges: [[60, 70], [130, 145]],
}));

fs.writeFileSync(path.join(DATA, 'persons.json'), JSON.stringify(persons, null, 1), 'utf8');

console.log('已生成：');
for (const p of persons) {
  const days = Math.round((p.last - p.first) / 86400) + 1;
  console.log(`  ${p.name.padEnd(6)} ${String(p.msgs).padStart(5)} 条  跨度 ${days} 天  日均 ${(p.msgs / days).toFixed(1)}`);
}
console.log('路径：' + MSG_DIR);
