/**
 * 年度报告逐页巡检：把每一页截成 PNG，并量出大数字的真实字号 / 居中偏差 / 是否溢出。
 * 用来客观定位「数字大小和位置不对」，而不是靠肉眼猜。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 截报告.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '报告');
fs.mkdirSync(OUT, { recursive: true });
const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const save = async (win, name) => {
  const buf = (await win.capturePage()).toPNG();
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  return Math.round(buf.length / 1024);
};

// 只读诊断：不改界面，只把关键盒模型量出来。
// 数字那一项用 canvas 的 TextMetrics 算「墨迹真实重心」跟容器中心的差 ——
// 衬线数字的墨迹比行盒偏上 0.08em 左右，光看 getBoundingClientRect 是看不出来的。
const MEASURE = `(function(){
  var p = document.querySelector('.rs-slide:not(.leaving)');
  if (!p) return { err: 'no slide' };
  var num = p.querySelector('.rs-num');
  var unit = p.querySelector('.rs-unit');
  var out = { kind: (p.className||'').replace('rs-slide ',''), num: num?num.textContent:'', unit: unit?unit.textContent:'' };
  if (num) {
    var r = num.getBoundingClientRect(), cs = getComputedStyle(num);
    out.fontSize = parseFloat(cs.fontSize).toFixed(0)+'px';
    out.fontFamily = cs.fontFamily.split(',')[0].replace(/["']/g,'');
    out.w = Math.round(r.width);
    out.inkOff = null;
    try {
      var c = document.createElement('canvas').getContext('2d');
      c.font = cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;
      var m = c.measureText(num.textContent);
      var asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
      if (asc != null) {
        // 基线在行盒里的位置
        var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize);
        var base = (lh - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
        // 由变换带来的额外位移（我们用了 translateY 补偿）
        var tf = cs.transform;
        var ty = 0;
        if (tf && tf !== 'none') { var mm = tf.match(/matrix\\(([^)]+)\\)/); if (mm) ty = parseFloat(mm[1].split(',')[5]) || 0; }
        var inkCenter = base - asc + (asc + desc) / 2 + ty;   // 墨迹中心（相对行盒顶）
        out.inkOff = +(inkCenter - lh / 2).toFixed(1);        // 与行盒中心的偏差，正=偏下
        out.capH = Math.round(asc);
      }
    } catch (e) {}
    out.leftGap = Math.round(r.left);
    out.rightGap = Math.round(window.innerWidth - r.right);
  }
  if (unit) out.unitSize = parseFloat(getComputedStyle(unit).fontSize).toFixed(0)+'px';
  out.winW = window.innerWidth; out.winH = window.innerHeight;
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(3000);
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(3500);
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    await sleep(2000);
    // 暂停自动放映，逐页手动走，避免截图截到翻页动画中途
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);
    await sleep(400);

    const total = await js(`(function(){var t=document.querySelector('.rs-idx');if(!t)return 0;var m=/(\\d+)\\s*\\/\\s*(\\d+)/.exec(t.textContent);return m?+m[2]:0})()`);
    console.log('共 ' + total + ' 页\n');

    for (let i = 0; i < total; i++) {
      if (i > 0) {
        await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);
        await sleep(2300);   // 等退场(.56s)+入场(.9s)+元素错峰浮现(.82s+.62s)全部走完，别截到转场中途
      }
      const m = await js(MEASURE);
      await save(win, '报告-' + String(i + 1).padStart(2, '0'));
      console.log(
        String(i + 1).padStart(2, '0') + ' ' + String(m.kind || '').padEnd(9) +
        (String(m.num || '').padEnd(9) + String(m.unit || '').slice(0, 10)).padEnd(22) +
        '字号=' + String(m.fontSize || '-').padEnd(7) +
        '宽=' + String(m.w || '-').padStart(4) +
        ' 两侧留白=' + String(m.leftGap).padStart(4) + '/' + String(m.rightGap).padStart(5) +
        ' 墨迹偏移=' + String(m.inkOff == null ? '-' : m.inkOff).padStart(6) + 'px' +
        ' 单位=' + String(m.unitSize || '-')
      );
    }
    console.log('\n图在 ' + OUT);
  } catch (e) {
    console.log('❌ ' + (e && e.message));
  }
  app.quit();
});
