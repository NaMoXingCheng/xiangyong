/**
 * 承诺识别规则的边界用例。
 * 目的不是「过测试」，而是把误报/漏报摆出来看清楚 —— 真实聊天比演示数据脏得多。
 *
 * 用法：node 测试脚本/测承诺规则.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const a = src.indexOf('const PROMISE_RULES');
const b = src.indexOf('// 稳定 id：');
const detectPromises = new Function(src.slice(a, b) + '\nreturn detectPromises;')();

// [文本, 期望是否算承诺, 备注]
const CASES = [
  // ---------- 应该算承诺 ----------
  ['下周带你去吃那家火锅，说好了', true, '时间+带你'],
  ['明天陪你去医院，说好了', true, '时间+陪你'],
  ['我保证这次不迟到', true, '明确表态'],
  ['这周末陪你去看电影', true, '时间+陪你'],
  ['下次一定带你去看', true, '下次一定'],
  ['我请你吃饭', true, '请你+吃'],
  ['我明天给你买那个包', true, '时间+给你'],
  ['说好了的事我一定做到', true, '说好了+一定'],
  ['拉钩，不许变', true, '拉钩'],
  ['我会好好对你的', true, '我会好好'],
  ['改天约个时间见一面', true, '约时间'],
  ['我发誓以后不熬夜了', true, '我发誓'],
  ['下个月陪你去趟海边', true, '时间+陪你'],
  ['一言为定', true, '成语'],
  ['我答应你，周末一起去爬山', true, '我答应+一起'],
  ['我明天过来找你', true, '时间+上门'],
  ['晚点去找你', true, '时间+上门'],
  ['我晚点给你打电话', true, '给你+打'],
  ['我下周帮你搬家', true, '帮你+搬'],
  ['下班来接你', true, '时间+接你'],
  ['改天约个时间见一面', true, '约时间'],

  // ---------- 不该算承诺 ----------
  ['明天有空吗', false, '疑问句'],
  ['你明天带我去吃饭吗', false, '疑问句（而且是要求对方）'],
  ['我明天很忙', false, '陈述现状'],
  ['你要是来我就请你吃饭', false, '条件句，是谈判不是承诺'],
  ['你别当真，我开玩笑的', false, '玩笑'],
  ['算了，下次吧', false, '推托'],
  ['在吗', false, '招呼'],
  ['今天好累', false, '吐槽'],
  ['你自己看着办', false, '推卸'],
  ['谁带你去的？', false, '疑问'],
  ['我明天要开会', false, '陈述日程'],
  ['这个多少钱', false, '问价'],
  ['哈哈哈哈', false, '无意义'],
  ['我昨天去吃了火锅', false, '过去时，不是承诺'],
  ['上次你说带我去，结果没去', false, '翻旧账'],
  ['明天降温记得加衣服', false, '关心，不是承诺'],
  ['我想吃火锅', false, '表达愿望'],
  ['他明天来我家', false, '第三人称'],
  ['我昨天去找你了', false, '过去时'],
  ['下次再说吧', false, '推托'],
  ['你想约时间吗', false, '疑问'],
];

let pass = 0, fail = 0;
const fails = [];
for (const [text, want, note] of CASES) {
  const hit = detectPromises([{ c: text, me: 1, t: Math.floor(Date.now() / 1000) }]);
  const got = hit.length > 0;
  if (got === want) { pass++; }
  else { fail++; fails.push(`  ${got ? '误报' : '漏报'} | ${text}  （${note}）`); }
}

console.log(`用例 ${CASES.length} 条：通过 ${pass}，不通过 ${fail}\n`);
if (fails.length) {
  console.log('—— 需要关注的 ——');
  console.log(fails.join('\n'));
} else {
  console.log('✅ 全部符合预期');
}
