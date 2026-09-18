/**
 * 只读探针：量各字体的「数字墨迹高度」，判断用的是老式数字（old-style / text figures）还是等高数字（lining）。
 * 老式数字的特征：不同数字的 ascent/descent 不一样（3、4、5、7、9 有降部，1、2、0 高度矮），
 * 混在中文里就会显得「大小不一、歪歪扭扭」。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 探数字字形.js
 */
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const PROBE = `(function(){
  var c = document.createElement('canvas').getContext('2d');
  var fonts = ['Constantia','Cambria','Georgia','Times New Roman','Noto Serif SC','serif'];
  var out = [];
  for (var f of fonts) {
    var c2 = document.createElement('canvas').getContext('2d');
    c2.font = '700 100px "' + f + '"';
    var asc = [], desc = [];
    for (var d of '0123456789') {
      var m = c2.measureText(d);
      asc.push(Math.round(m.actualBoundingBoxAscent));
      desc.push(Math.round(m.actualBoundingBoxDescent));
    }
    out.push({ font: f, asc: asc, desc: desc,
      ascSpread: Math.max.apply(null, asc) - Math.min.apply(null, asc),
      maxDesc: Math.max.apply(null, desc) });
  }
  // 再看 CSS 里真正用的那串 font-family 落到哪个字体
  var probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;font:700 100px ' + getComputedStyle(document.documentElement).getPropertyValue('--rs-serif');
  probe.textContent = '0123456789';
  document.body.appendChild(probe);
  var used = getComputedStyle(probe).fontFamily;
  probe.remove();
  return { rows: out, rsSerif: used };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  try {
    await win.loadURL(process.env.SHOT_URL || 'http://localhost:4322');
    await new Promise(r => setTimeout(r, 2500));
    const r = await js(PROBE);
    console.log('CSS --rs-serif 解析结果：', r.rsSerif, '\n');
    console.log('字体'.padEnd(18) + 'ascent(0-9)'.padEnd(34) + '降部最大值  ascent极差');
    for (const x of r.rows) {
      console.log(
        String(x.font).padEnd(18) +
        ('[' + x.asc.join(' ') + ']').padEnd(36) +
        String(x.maxDesc).padStart(6) + '    ' + String(x.ascSpread).padStart(6)
      );
    }
  } catch (e) {
    console.log('❌ ' + (e && e.message));
  }
  app.quit();
});
