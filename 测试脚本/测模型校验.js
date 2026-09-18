// 测试：对已存在但无合格证的模型文件，是否走「就地校验 → 补证」而不是重下
const ai = require('../ai.js');

const tier = process.argv[2] || 'lite';
ai.init(__dirname + '/../data');
console.log('初始 installed =', ai.installed(tier));
console.log('初始 status.tiers =', JSON.stringify(ai.status().tiers.map(t => t.key + ':' + t.installed)));

const t0 = Date.now();
ai.setup({ backend: 'builtin', tier }).then((s) => {
  console.log('setup 完成', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log('backend=', s.backend, 'ready=', s.ready, 'model=', s.model);
  console.log('error=', s.error);
  console.log('installed(' + tier + ') =', ai.installed(tier));
  process.exit(0);
}).catch(e => { console.error('失败:', e); process.exit(1); });
