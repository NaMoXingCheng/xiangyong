/**
 * 卡顿消融实验：逐项关掉可疑的视觉效果，看 CPU 占用怎么变。
 * 只看帧率会被骗 —— 机器强的时候帧率能顶住，但 CPU 一直满载，用户就会觉得
 * 风扇狂转、切窗口卡、点一下要等。所以这里测的是 CPU。
 *
 * 每个场景静置 5 秒，取该进程组的平均 CPU 占用（app.getAppMetrics 是「距上次调用」的均值）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/测消融.js
 *       HW=1 ... 同上，对比硬件加速
 */
const { app, BrowserWindow } = require('electron');

const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const HW = process.env.HW === '1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!HW) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 采样 CPU：getAppMetrics 返回的是「上次调用以来」的平均值，所以先调一次清空窗口
  async function cpu(sec) {
    app.getAppMetrics();
    await sleep(sec * 1000);
    const m = app.getAppMetrics();
    let total = 0;
    const byType = {};
    for (const x of m) {
      const p = (x.cpu && x.cpu.percentCPUUsage) || 0;
      total += p;
      const t = x.type || '?';
      byType[t] = (byType[t] || 0) + p;
    }
    return { total: Math.round(total), byType, procs: m.length };
  }

  const rows = [];
  const scene = async (name, css, scroll) => {
    if (css) {
      await js(`(function(){
        var s=document.getElementById('perf-off')||document.createElement('style');
        s.id='perf-off'; s.textContent=${JSON.stringify(css)};
        document.head.appendChild(s); return true;})()`);
    }
    // 滚动场景：让页面持续滚，模拟用户滑动
    let stop = null;
    if (scroll) {
      await js(`(function(){ window.__stopScroll=false;
        var m=document.getElementById('main')||document.documentElement;
        (function loop(){ if(window.__stopScroll) return;
          if(m===document.documentElement) window.scrollTo(0,(window.scrollY+22)%3000);
          else m.scrollTop=(m.scrollTop+22)%3000;
          requestAnimationFrame(loop); })();
        return true;})()`);
      stop = () => js(`(function(){window.__stopScroll=true;return true})()`);
    }
    const r = await cpu(5);
    if (stop) await stop();
    console.log('  ' + (name + '                         ').slice(0, 34) + r.total + '%   ' +
      Object.keys(r.byType).map(k => k + ':' + Math.round(r.byType[k]) + '%').join('  '));
    rows.push([name, r.total]);
    return r.total;
  };

  console.log('渲染模式: ' + (HW ? '硬件加速（GPU）' : '软件渲染（CPU，当前配置）'));
  console.log('');

  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(3000);

    console.log('———— 联系人列表页 ————');
    const a1 = await scene('① 列表页 · 静止', null, false);
    await scene('② 列表页 · 关掉卡片毛玻璃', '.card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}', false);
    await scene('③ 列表页 · 关掉所有动画', '*,*::before,*::after{animation:none!important}', false);

    console.log('');
    console.log('———— 分析页（卡片最多）————');
    // 重置覆盖样式
    await js(`(function(){var s=document.getElementById('perf-off');if(s)s.textContent='';return true})()`);
    await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(6000);
    const domN = await js(`document.querySelectorAll('*').length`);
    const cardN = await js(`document.querySelectorAll('.card').length`);
    console.log('  （DOM ' + domN + ' 节点，其中 .card ' + cardN + ' 张）');

    const b1 = await scene('④ 分析页 · 静止（原始）', null, false);
    const b2 = await scene('⑤ 分析页 · 滚动（原始）', null, true);
    await scene('⑥ 分析页 · 滚动 + 关毛玻璃', '.card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}', true);
    await scene('⑦ 分析页 · 滚动 + 关无限动画', '*,*::before,*::after{animation:none!important}', true);
    await scene('⑧ 分析页 · 两者都关', '.card{backdrop-filter:none!important;-webkit-backdrop-filter:none!important} *,*::before,*::after{animation:none!important}', true);

    // 草地彩蛋单独测
    console.log('');
    console.log('———— 绿色彩蛋「草地」————');
    await js(`(function(){document.getElementById('perf-off').textContent='';document.body.classList.add('grass-on');return true})()`);
    await sleep(2500);
    const g1 = await scene('⑨ 草地开启 · 静止', null, false);
    const g2 = await scene('⑩ 草地开启 · 滚动', null, true);
    const g3 = await scene('⑪ 草地开启 · 关掉草地动画', '.grass *{animation:none!important}', true);
    await js(`(function(){document.body.classList.remove('grass-on');return true})()`);

    console.log('\n================ 结论 ==================');
    console.log('  基线（分析页滚动，原始）  ' + b2 + '%');
    console.log('  关掉卡片毛玻璃后          ' + rows[5][1] + '%   省 ' + Math.max(0, b2 - rows[5][1]) + ' 个百分点');
    console.log('  关掉无限动画后            ' + rows[6][1] + '%   省 ' + Math.max(0, b2 - rows[6][1]) + ' 个百分点');
    console.log('  两者都关                  ' + rows[7][1] + '%   省 ' + Math.max(0, b2 - rows[7][1]) + ' 个百分点');
    console.log('  草地彩蛋（滚动）额外开销  ' + Math.max(0, g2 - b2) + ' 个百分点');
    console.log('========================================');
  } catch (e) {
    console.log('❌ ' + ((e && e.message) || e));
  }
  app.quit();
});
