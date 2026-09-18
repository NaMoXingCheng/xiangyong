/**
 * 承诺识别效果实测。
 * 直接从 server.js 里截取识别逻辑来跑（不是复制一份），保证测的就是实际生效的代码。
 *
 * 用法：node 测试脚本/测承诺识别.js [personId]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// 截取 [PROMISE_RULES ... 稳定 id 之前] 这一段，即全部识别相关代码
const a = src.indexOf('const PROMISE_RULES');
const b = src.indexOf('// 稳定 id：');
if (a < 0 || b < 0 || b <= a) { console.error('❌ 没能从 server.js 里定位到识别逻辑'); process.exit(1); }
const detectPromises = new Function(src.slice(a, b) + '\nreturn detectPromises;')();

const pid = process.argv[2] || 'p-d';
const msgsPath = path.join(ROOT, 'data', 'messages', pid + '.json');
const raw = JSON.parse(fs.readFileSync(msgsPath, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.list;

const hits = detectPromises(list);
const me = hits.filter(h => h.who === 'me');
const ta = hits.filter(h => h.who === 'ta');

const fmt = (t) => {
  const d = new Date((t > 1e12 ? t : t * 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

console.log(`共 ${list.length} 条消息 → 识别出 ${hits.length} 条承诺（我 ${me.length} / TA ${ta.length}）\n`);
console.log('—— 我说的 ——');
for (const h of me) console.log(`  [${h.score}] ${fmt(h.at)}  ${h.text}`);
console.log('\n—— TA 说的 ——');
for (const h of ta) console.log(`  [${h.score}] ${fmt(h.at)}  ${h.text}`);

// 反向检查：识别结果里有没有明显不该算的（疑问/玩笑）
console.log('\n—— 误报自查（含疑问词的应接近 0）——');
const bad = hits.filter(h => /[吗么?？]/.test(h.text));
console.log(bad.length ? bad.map(h => '  ⚠ ' + h.text).join('\n') : '  ✅ 无');
