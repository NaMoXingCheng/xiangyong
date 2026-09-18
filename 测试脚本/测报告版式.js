/**
 * 报告版式的客观巡检：封面日期、背景页码、动态页数、结尾寄语。
 *
 * 重点是用「像素」而不是肉眼判断数字字形：
 * 老式数字（old-style figures）会让同一行数字高低不齐，而这件事肉眼很容易归因成
 * 「字体不好看」。这里把数字渲染成图，直接量每个数字的墨迹高度，齐不齐一目了然。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测报告版式.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '版式');
fs.mkdirSync(OUT, { recursive: true });
const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '　实测: ' + JSON.stringify(extra) : '')); }
};

const IDX = `(function(){var e=document.querySelector('.rs-idx');return e?e.textContent.trim():''})()`;

// 造一排单字探针，字体/字号/数字特性全部照抄封面上真实的那个日期节点。
// 文字用「纯绿」画：整页只有这里有这个颜色，后面就能靠颜色把字找出来，
// 完全不需要知道探针在屏幕上的坐标（按坐标裁图很容易被窗口边框和缩放搞错，踩过）。
const PROBE = (fam, plain) => `(function(){
  var real = document.querySelector('.rs-slide.k-cover .cv-date');
  if (!real) return { err: 'no cover date' };
  var cs = getComputedStyle(real);
  var old = document.getElementById('fontProbe'); if (old) old.remove();
  var box = document.createElement('div');
  box.id = 'fontProbe';
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000;'
    + 'padding:20px;display:flex;gap:48px;align-items:flex-start';
  var fam = ${fam ? JSON.stringify(fam) : 'cs.fontFamily'};
  var fvn = ${plain ? "'normal'" : 'cs.fontVariantNumeric'};
  var ffs = ${plain ? "'normal'" : 'cs.fontFeatureSettings'};
  ['0','6','8','3','7'].forEach(function (t) {
    var s = document.createElement('span');
    s.textContent = t;
    s.style.cssText = 'display:inline-block;color:#00ff00;'
      + 'font-family:' + fam + ';font-size:72px;font-weight:700;line-height:1.3;'
      + 'font-variant-numeric:' + fvn + ';font-feature-settings:' + ffs;
    box.appendChild(s);
  });
  document.body.appendChild(box);
  return { n: box.children.length, fam: cs.fontFamily, fvn: fvn, ffs: ffs };
})()`;

// 全页截图 → 按「纯绿」聚类找到每个数字 → 量它的墨迹高度。
// 返回值是 CSS 像素高度，直接和字号对照着看。
function greenInkHeights(img, innerW) {
  const bmp = img.toBitmap();
  const W = img.getSize().width, H = img.getSize().height;
  const scale = W / innerW;
  const isInk = (x, y) => {
    const i = (y * W + x) * 4;              // BGRA
    return bmp[i + 1] > 190 && bmp[i + 2] < 130 && bmp[i] < 130;
  };
  // 先按列聚类：探针之间留了 48px 的缝，不同数字的列区间不会连在一起
  const cols = new Array(W).fill(0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { if (isInk(x, y)) { cols[x] = 1; break; } }
  }
  const groups = [];
  let cur = null;
  for (let x = 0; x < W; x++) {
    if (cols[x]) { if (!cur) { cur = { x0: x, x1: x }; groups.push(cur); } else cur.x1 = x; }
    else cur = null;
  }
  return groups.map((g) => {
    let top = -1, bot = -1;
    for (let y = 0; y < H; y++) {
      for (let x = g.x0; x <= g.x1; x++) {
        if (isInk(x, y)) { if (top < 0) top = y; bot = y; break; }
      }
    }
    return top < 0 ? 0 : Math.round((bot - top + 1) / scale);
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await win.capturePage()).toPNG());

  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(3000);
    await js(`(function(){var e=document.querySelector('.person[data-id="p-mom"]')||document.querySelector('.person');if(e)e.click();})()`);
    await sleep(3600);
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    await sleep(2200);
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);   // 暂停，逐页手动走
    await sleep(500);

    // ---------- 页数动态 ----------
    console.log('【页数按记录厚度决定】');
    const total = await js(`(function(){var m=/(\\d+)\\s*\\/\\s*(\\d+)/.exec(document.querySelector('.rs-idx').textContent);return m?+m[2]:0})()`);
    ok(total >= 9 && total <= 15, '页数落在 9~15 之间（实测 ' + total + ' 页，原来固定 12）', total);
    const dots = await js(`document.querySelectorAll('.rs-dot').length`);
    ok(dots === total, '圆点轨道页数与总页数一致（' + dots + '）', dots);

    // 逐页记下版式序列
    const seq = [];
    for (let i = 0; i < total; i++) {
      if (i > 0) { await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`); await sleep(560); }
      seq.push(await js(`(function(){var p=document.querySelector('.rs-slide:not(.leaving)');return p?p.className.replace('rs-slide ','').trim():'?'})()`));
    }
    console.log('     版式序列：' + seq.join(' → '));
    ok(seq[0] === 'k-cover', '第一页是封面', seq[0]);
    ok(seq[seq.length - 1] === 'k-end', '最后一页是结尾', seq[seq.length - 1]);
    const coreSet = ['k-cover', 'k-split', 'k-num', 'k-bars', 'k-word'];
    ok(coreSet.every(k => seq.indexOf(k) >= 0), '核心版式都出现过（封面/数字/对照/排行/大字词）', seq);

    // ---------- 背景页码 ----------
    console.log('\n【背景页码（左侧大号数字）】');
    await js(`(function(){var e=document.querySelector('#rsPrev');if(e)e.click();})()`);
    await sleep(200);
    const ord = await js(`(function(){
      var o = document.querySelector('.d-ord');
      if (!o) return { err: 'no ord' };
      var cs = getComputedStyle(o);
      return { text: o.textContent, len: o.dataset.len, anim: cs.animationName, dur: cs.animationDuration,
               fvn: cs.fontVariantNumeric, fam: cs.fontFamily };
    })()`);
    ok(!ord.err, '背景页码节点存在', ord);
    ok(/^\d\d$/.test(ord.text), '页码是两位补零（' + ord.text + '）', ord.text);
    ok(ord.anim === 'rsOrd', '页码带了换页动画（animation-name=' + ord.anim + '）', ord);
    ok(ord.len === '2', '带 data-len 分档（' + ord.len + '）', ord.len);
    ok(/lining-nums/.test(ord.fvn || ''), '页码用等高数字（font-variant-numeric=' + ord.fvn + '）', ord.fvn);

    // 换一页，确认动画真的被重新触发（animation 没被清空就无法重放）
    const t0 = await js(`(function(){return document.querySelector('.d-ord').textContent})()`);
    await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);
    await sleep(160);
    const t1 = await js(`(function(){
      var o = document.querySelector('.d-ord');
      return { text: o.textContent, anims: o.getAnimations ? o.getAnimations().length : -1 };
    })()`);
    ok(t1.text !== t0, '翻页后页码文字变了（' + t0 + ' → ' + t1.text + '）', t1);
    ok(t1.anims !== 0, '翻页瞬间动画在跑（在跑的动画数=' + t1.anims + '）', t1.anims);
    await shot('版式-01-背景页码');

    // ---------- 封面日期 ----------
    console.log('\n【封面日期】');
    // 直接点第一个圆点跳回第 1 页（点 rsPrev 要按 15 次，还容易数错）
    await js(`(function(){var d=document.querySelector('.rs-dot[data-k="0"]');if(d)d.click();})()`);
    await sleep(900);
    const cover = await js(`(function(){
      var p = document.querySelector('.rs-slide.k-cover');
      if (!p) return { err: 'no cover' };
      var y = p.querySelector('.cv-year'), d = p.querySelector('.cv-date');
      return { year: y ? y.textContent.trim() : '', rng: y ? y.classList.contains('rng') : null,
               yearSize: y ? parseFloat(getComputedStyle(y).fontSize).toFixed(0) : '0',
               dateText: d ? d.textContent.trim() : '',
               parts: d ? d.querySelectorAll('span').length : 0,
               dash: d ? !!d.querySelector('.dash') : false,
               dateSize: d ? parseFloat(getComputedStyle(d).fontSize).toFixed(0) : '0' };
    })()`);
    ok(!cover.err, '取到封面', cover);
    // 跨年的记录：年份必须是区间，不能只写起始那一年
    ok(/—/.test(cover.year), '跨年时年份显示成区间（' + cover.year + '）', cover.year);
    ok(cover.rng === true && parseFloat(cover.yearSize) <= 160, '区间年份降到合适字号，不会顶到屏幕边（' + cover.yearSize + 'px）', cover.yearSize);
    ok((cover.dateText.match(/\d{4}\.\d{2}\.\d{2}/g) || []).length === 2, '日期是年鉴式点分写法、起止各一段（' + cover.dateText + '）', cover.dateText);
    ok(cover.parts === 2 && cover.dash === true, '日期拆成「起 — 止」两段 + 中间横线', cover);
    ok(parseFloat(cover.dateSize) >= 14, '日期字号不比原来更小（' + cover.dateSize + 'px，原 13.5px）', cover.dateSize);
    await shot('版式-02-封面');

    const realFam = await js(`(function(){var d=document.querySelector('.rs-slide.k-cover .cv-date');return d?getComputedStyle(d).fontFamily:''})()`);
    ok(!/Constantia|Georgia/i.test(realFam), '字体栈里已经没有 Constantia / Georgia（老式数字的源头）', realFam);

    // ---------- 数字字形：用像素量墨迹高度 ----------
    console.log('\n【数字字形（像素实测）】');
    const probe = await js(PROBE(null, false));
    ok(!probe.err, '探针已插入', probe.err);
    const innerW = await js(`window.innerWidth`);
    await sleep(700);                       // 等一帧画完再截图，否则截到的是没有探针的画面
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '版式-03-字形探针.png'), img.toPNG());
    const now = greenInkHeights(img, innerW);
    console.log('     当前字体墨迹高度：' + now.join(' / '));
    ok(now.length === 5, '按颜色找到了 5 个数字探针（' + now.length + '）', now);
    const spread = now.length ? Math.max.apply(null, now) - Math.min.apply(null, now) : 999;
    ok(now.length === 5 && spread <= 5, '当前字体五个数字墨迹高度一致（极差 ' + spread + 'px）', now);

    // 对照组：换成 Constantia 并关掉 lnum（= 修复前的状态：字体栈第一位是 Constantia，日期那处又漏了 lnum）。
    // 一个连「坏情况」都测不出来的断言等于没测，所以这里必须让老毛病复现出来。
    const bad = await js(PROBE('Constantia', true));
    ok(!bad.err, '对照组探针已插入', bad.err);
    await sleep(700);
    const img2 = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '版式-04-字形对照-修复前.png'), img2.toPNG());
    const bad2 = greenInkHeights(img2, innerW);
    console.log('     Constantia（修复前那种）：' + bad2.join(' / '));
    const badSpread = bad2.length ? Math.max.apply(null, bad2) - Math.min.apply(null, bad2) : 0;
    ok(badSpread >= 10, '对照组能测出老式数字的毛病（极差 ' + badSpread + 'px），说明这项检查真的有效', bad2);
    await js(`(function(){var e=document.getElementById('fontProbe');if(e)e.remove();})()`);

    console.log('\n图在 ' + OUT);
  } catch (e) {
    fail++;
    console.log('❌ ' + (e && e.stack || e));
  }
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  app.quit();
});
