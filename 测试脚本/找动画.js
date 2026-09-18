/**
 * 找出「到底哪些元素一直在跑无限动画」。
 * 计算样式里 animation-iteration-count:infinite 的元素可能有一大堆，
 * 但 display:none 的那些其实不消耗任何东西（不发帧）。
 * 所以要分开数：真正参与渲染的才是成本。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/找动画.js
 */
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const PROBE = `(function(){
  // 真正在渲染的判断：元素有布局盒且可见
  function visible(el){
    if (!el.getClientRects().length) return false;
    var n = el;
    while (n && n.nodeType === 1) {
      var s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity) === 0) return false;
      n = n.parentElement;
    }
    return true;
  }
  function sig(el){
    var c = el.getAttribute('class') || '';
    return el.tagName.toLowerCase() + (c ? '.' + c.trim().split(/\\s+/).join('.') : '');
  }
  var running = {}, dead = 0, deadBy = {};
  document.querySelectorAll('*').forEach(function(el){
    var s = getComputedStyle(el);
    var it = s.animationIterationCount || '';
    var nm = (s.animationName || '');
    if (it.indexOf('infinite') < 0 || nm === 'none') return;
    var k = sig(el) + '  ⇢  ' + nm + ' (' + s.animationDuration + ')';
    if (visible(el)) { running[k] = (running[k] || 0) + 1; }
    else {
      dead++;
      var k2 = sig(el);
      deadBy[k2] = (deadBy[k2] || 0) + 1;
    }
  });
  return {running:running, dead:dead, deadBy:deadBy};
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);

  const report = (title, r) => {
    console.log('\n===== ' + title + ' =====');
    const keys = Object.keys(r.running).sort((a, b) => r.running[b] - r.running[a]);
    if (!keys.length) console.log('  ✅ 没有正在渲染的无限动画');
    for (const k of keys) console.log('  ' + String(r.running[k]).padStart(3) + ' 个   ' + k);
    const liveTotal = keys.reduce((s, k) => s + r.running[k], 0);
    console.log('  —— 真正在跑: ' + liveTotal + ' 个元素；被 display/opacity 藏起来的: ' + r.dead + ' 个');
  };

  try {
    await win.loadURL('http://localhost:4322');
    win.showInactive();
    await sleep(3000);
    report('联系人列表页（静止）', await js(PROBE));

    await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(6000);
    report('分析页（静止）', await js(PROBE));

    // 绿色彩蛋
    await js(`document.body.classList.add('grass-on');true`);
    await sleep(2500);
    const g = await js(PROBE);
    report('草地彩蛋开启后', g);
    const gsum = Object.keys(g.running).reduce((s, k) => s + g.running[k], 0);
    console.log('  ⚠ 草地开启后新增正在渲染的动画元素: ' + gsum + ' 个');
    await js(`document.body.classList.remove('grass-on');true`);

    // 骨架屏形态（加载中）
    console.log('\n===== 补充：骨架屏 skelwave 只在加载时出现，属于短时开销 =====');

  } catch (e) {
    console.log('❌ ' + ((e && e.message) || e));
  }
  app.quit();
});
