/**
 * 报告放映的交互验证：页码是否真的「鼠标移上去才显示」、换页是否真的是两页并存的转场。
 * CSS 的 :hover 没法用 JS 直接触发，只能发真实的鼠标事件。
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测报告交互.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '报告');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '　实测: ' + JSON.stringify(extra) : '')); }
};

const PAGER = `(function(){
  var c = document.getElementById('rsCtrl') || document.querySelector('.rs-ctrl');
  var p = document.querySelector('.rs-pager');
  if (!p || !c) return { err: 'no pager' };
  var cs = getComputedStyle(p);
  return { opacity: +cs.opacity, maxWidth: cs.maxWidth, width: Math.round(p.getBoundingClientRect().width),
           ctrlOpacity: +getComputedStyle(c).opacity };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await win.capturePage()).toPNG());

  try {
    await win.loadURL(process.env.SHOT_URL || 'http://localhost:4322');
    win.showInactive();
    await sleep(3000);
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(3500);
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    await sleep(600);
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);  // 暂停自动翻页
    await sleep(1200);

    console.log('【页码显隐】');
    // 先把鼠标挪到角落，确保不在控制条上
    move(40, 40);
    await sleep(700);
    let a = await js(PAGER);
    ok(a.opacity === 0, '鼠标不在控制条上时，页码完全隐藏（opacity=' + a.opacity + '）', a);
    ok(a.width === 0 || a.maxWidth === '0px', '隐藏时宽度也收成 0，不占位', a);
    await shot('交互-01-页码隐藏');

    // 移到控制条正中
    const box = await js(`(function(){var c=document.querySelector('.rs-ctrl');if(!c)return null;var r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    ok(!!box, '取到控制条位置', box);
    move(box.x, box.y);
    await sleep(900);
    const b = await js(PAGER);
    ok(b.opacity > 0.9, '鼠标移到控制条上时，页码浮现（opacity=' + b.opacity + '）', b);
    ok(b.width > 20, '浮现后真的有宽度，页码露出来了（' + b.width + 'px）', b);
    const idx = await js(`(function(){var e=document.querySelector('.rs-idx');return e?e.textContent:''})()`);
    ok(/^\d+\s*\/\s*\d+$/.test(String(idx).trim()), '页码内容形如 n / m（' + idx + '）', idx);
    const dots = await js(`document.querySelectorAll('.rs-dot').length`);
    ok(dots >= 10, '圆点轨道按页数生成（' + dots + ' 个点）', dots);
    await shot('交互-02-页码显示');

    // 移开 → 再收起
    move(60, 60);
    await sleep(900);
    const c2 = await js(PAGER);
    ok(c2.opacity === 0, '鼠标移开后页码重新隐藏', c2);

    // ---- 转场：换页瞬间应该同时存在两页（旧的退场 + 新的入场）----
    console.log('\n【换页转场】');
    await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);
    await sleep(180);
    const during = await js(`document.querySelectorAll('.rs-slide').length`);
    ok(during === 2, '换页中途新旧两页并存（数到 ' + during + ' 层）', during);
    await shot('交互-03-转场中途');
    await sleep(1800);
    const after = await js(`document.querySelectorAll('.rs-slide').length`);
    ok(after === 1, '转场结束后只剩新页（' + after + ' 层）', after);

    // ---- 装饰层是否随页位移（元素联动）----
    console.log('\n【装饰层联动】');
    const d1 = await js(`(function(){var s=document.getElementById('reportStage');return {x:getComputedStyle(s).getPropertyValue('--rs-dx').trim(),r:getComputedStyle(s).getPropertyValue('--rs-rot').trim(),o:(document.querySelector('.d-ord')||{}).textContent}})()`);
    await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);
    await sleep(1400);
    const d2 = await js(`(function(){var s=document.getElementById('reportStage');return {x:getComputedStyle(s).getPropertyValue('--rs-dx').trim(),r:getComputedStyle(s).getPropertyValue('--rs-rot').trim(),o:(document.querySelector('.d-ord')||{}).textContent}})()`);
    ok(d1.x !== d2.x || d1.r !== d2.r, '装饰参数随页变化（' + JSON.stringify(d1) + ' → ' + JSON.stringify(d2) + '）');
    ok(d1.o !== d2.o, '侧边页码水印跟着翻（' + d1.o + ' → ' + d2.o + '）');

    console.log('\n图在 ' + OUT);
  } catch (e) {
    fail++;
    console.log('❌ ' + (e && e.stack || e));
  }
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  app.quit();
});
