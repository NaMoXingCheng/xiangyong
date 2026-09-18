// 端到端测锐评：真数据 → 提示词 → 输出
const ai = require('../ai.js');
ai.init(__dirname + '/../data');

// 一份贴近真实抓取产物的数据
const d = {
  name: '她',
  msgCount: 10348,
  spans: { days: 1610 },
  dailyMsg: 6.4,
  coldDays: 3,
  sentiment: { positivePct: 41 },
  gauges: [
    { key: 'active', value: 71 },
    { key: 'loved', value: 58 },
    { key: 'cold', value: 24 },
  ],
  reply: { taMid: 187, meMid: 720 },
  topWords: {
    me: [{ w: '在吗' }, { w: '吃饭' }, { w: '晚安' }],
    ta: [{ w: '嗯' }, { w: '好的' }, { w: '忙' }],
  },
  imgStats: { emojiTotal: 866, taImg: 42, taEmoji: 511 },
  likes: { me: [{ text: '火锅' }, { text: '猫' }], ta: [{ text: '火锅' }, { text: '旅行' }] },
  nextAnniversary: { label: '她的生日', days: 12 },
};

(async () => {
  const t0 = Date.now();
  await ai.setup({ backend: 'builtin', tier: process.argv[2] || 'lite' });
  console.log('[准备]', ((Date.now() - t0) / 1000).toFixed(1), 's  model=', ai.status().model);

  const t1 = Date.now();
  const r = await ai.roast(d);
  console.log('[锐评]', ((Date.now() - t1) / 1000).toFixed(1), 's');
  console.log('backend =', r.backend, '| model =', r.model);
  console.log('cited   =', JSON.stringify(r.cited));
  console.log('grounded=', r.grounded);
  console.log('---------- 锐评正文 ----------');
  console.log(r.roast);
  process.exit(0);
})().catch(e => { console.error('失败:', e); process.exit(1); });
