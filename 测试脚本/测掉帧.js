/**
 * 卡顿体感基准：不看平均帧率，看「帧间隔的分布」。
 * 平均 60fps 完全可能一边流畅一边卡 —— 只要偶尔有几帧耗时 100ms，
 * 用户就会觉得「卡了一下」。所以这里统计 p50 / p95 / 最长帧 / 掉帧次数。
 *
 * 同时测交互延迟：点击后画面多久才真的更新。
 *
 * 用法：
 *   软件渲染： env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/测掉帧.js
 *   硬件加速： HW=1 env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/测掉帧.js
 */
const { app, BrowserWindow } = require('electron');

const HW = process.env.HW === '1';
const ADV = process.env.HW === '2';   // 2 = 修复后 electron-main.js 的真实配置（多了两个 GPU 开关）
const FIX = process.env.FIX === '1';  // 1 = 模拟「命令行被传了 --disable-gpu」时，应用自己撤销它
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (FIX) {
  // 场景：桌面快捷方式/旧脚本传进来 --disable-gpu，应用自己把它摘掉
  for (const s of ['disable-gpu', 'in-process-gpu', 'disable-gpu-compositing']) {
    try { app.commandLine.removeSwitch(s); } catch (e) {}
  }
  app.commandLine.appendSwitch('enable-gpu-rasterization');
} else if (!HW && !ADV) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} else if (ADV) {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

// 页面内采样：记录 N 帧的间隔
const SAMPLER = (n, scroll) => `new Promise(function(res){
  var m = document.getElementById('main') || document.documentElement;
  var useWin = (m === document.documentElement);
  var gaps = [], last = performance.now(), i = 0;
  var startTop = useWin ? window.scrollY : m.scrollTop;
  window.__stop = false;
  function step(){
    if (window.__stop || i >= ${n}) {
      if (useWin) window.scrollTo(0, startTop); else m.scrollTop = startTop;
      return res(gaps);
    }
    var now = performance.now();
    gaps.push(Math.round(now - last));
    last = now;
    if (${scroll}) {
      if (useWin) window.scrollTo(0, (window.scrollY + 24) % 3000);
      else m.scrollTop = (m.scrollTop + 24) % 3000;
    }
    i++;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
})`;

function stats(gaps) {
  const s = gaps.slice(1).sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    jank33: s.filter(x => x > 33).length,   // 掉到 30fps 以下
    jank50: s.filter(x => x > 50).length,   // 明显卡顿
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);

  console.log('场景: ' + (FIX ? '命令行带 --disable-gpu，应用自行撤销' : (ADV ? '硬件加速+光栅化' : (HW ? '硬件加速' : '软件渲染（旧配置）'))));
  console.log('');
  console.log('  （帧间隔单位 ms；60fps=16.7，30fps=33。p95 和 max 越大越容易察觉卡顿）');
  console.log('');

  const run = async (name, n, scroll) => {
    const gaps = await js(SAMPLER(n, scroll));
    const s = stats(gaps);
    console.log('  ' + (name + '                          ').slice(0, 30) +
      '均 ' + String(s.avg).padStart(3) +
      '  p50 ' + String(s.p50).padStart(3) +
      '  p95 ' + String(s.p95).padStart(4) +
      '  最长 ' + String(s.max).padStart(4) +
      '  >33ms ' + String(s.jank33).padStart(3) + '帧' +
      '  >50ms ' + String(s.jank50).padStart(3) + '帧');
    return s;
  };

  try {
    await win.loadURL('http://localhost:4322');
    win.showInactive();
    await sleep(3000);

    console.log('———— 联系人列表页 ————');
    await run('静止', 180, false);
    await run('滚动', 180, true);

    // 关掉草地看看
    await js(`(function(){var s=document.createElement('style');s.textContent='.grass,.grass *{animation:none!important;display:none!important}';document.head.appendChild(s);return true})()`);
    await sleep(1000);
    await run('滚动 · 无草地/无动画', 180, true);
    await js(`(function(){var s=document.createElement('style');s.textContent='.card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';document.head.appendChild(s);return true})()`);
    await run('滚动 · 再去毛玻璃', 180, true);

    console.log('');
    console.log('———— 分析页 ————');
    await js(`(function(){var st=document.querySelectorAll('style');st[st.length-1]&&st[st.length-2]&&0;return true})()`);
    // 重新加载页面，拿回原始状态
    await win.loadURL('http://localhost:4322');
    await sleep(3000);
    await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(6000);

    await run('静止（原始）', 180, false);
    await run('滚动（原始）', 180, true);
    await js(`(function(){var s=document.createElement('style');s.textContent='.grass,.grass *{animation:none!important;display:none!important} .card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';document.head.appendChild(s);return true})()`);
    await sleep(1000);
    await run('滚动 · 去草地+毛玻璃', 180, true);

  } catch (e) {
    console.log('❌ ' + ((e && e.message) || e));
  }
  app.quit();
});
