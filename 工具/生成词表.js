/**
 * 生成随包词表 wordlist.txt（每行「词 频次」，首行 #总频次）。
 *
 * 为什么要它：热词原来靠 2/3/4-gram 滑窗挖，「我今天早起跑了三公里」会切出
 * 「天早起跑」「跑了三公」这种跨词碎片——靠统计筛不掉，只有词典能判词边界。
 * 有了词表就能做最大概率分词，出来的才是「早起 / 三公里 / 干爹 / 橘猫」这种真词。
 *
 * 词源：cppjieba 附带的 jieba.dict.utf8（结巴分词词典，MIT），格式「词 频次 词性」。
 * 用法：node 工具/生成词表.js <jieba.dict.utf8 路径> [保留词数]
 * 产出：<项目根>/wordlist.txt，约 400KB，随包分发，运行时不依赖 node_modules。
 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const KEEP = Number(process.argv[3]) || 40000;
const OUT = path.join(__dirname, '..', 'wordlist.txt');

if (!SRC || !fs.existsSync(SRC)) {
  console.log('用法：node 工具/生成词表.js <jieba.dict.utf8 路径> [保留词数]');
  process.exit(1);
}

const rows = [];
for (const line of fs.readFileSync(SRC, 'utf8').split('\n')) {
  const sp = line.trim().split(/\s+/);
  if (sp.length < 2) continue;
  const w = sp[0], f = Number(sp[1]) || 0;
  // 只留纯中文 1~6 字：单字要留着当分词兜底，多字才是热词候选
  if (!/^[\u4e00-\u9fa5]{1,6}$/.test(w) || f <= 1) continue;
  rows.push([w, f]);
}
rows.sort((a, b) => b[1] - a[1]);
const kept = rows.slice(0, KEEP);

let total = 0;
for (const [, f] of kept) total += f;
const body = ['#' + total].concat(kept.map(([w, f]) => w + ' ' + f)).join('\n');
fs.writeFileSync(OUT, body, 'utf8');

console.log('词典可用条目 ' + rows.length + ' → 保留 ' + kept.length + ' 条');
console.log('输出 ' + OUT + '  ' + (Buffer.byteLength(body, 'utf8') / 1024).toFixed(0) + ' KB');
console.log('最高频 ' + kept.slice(0, 10).map(x => x[0]).join(' ') + ' …');
