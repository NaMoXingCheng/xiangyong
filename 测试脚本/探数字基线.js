/**
 * 一次性探针：把 .rs-num 的字体度量原样打出来，用来校准「数字墨迹是否偏上」的补偿量。
 * 不修改任何界面，只读。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const PROBE = `(function(){
  var el = document.querySelector('.rs-num');
  if (!el) return { err: 'no .rs-num' };
  var cs = getComputedStyle(el);
  var c = document.createElement('canvas').getContext('2d');
  c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  var m = c.measureText(el.textContent);
  // canvas 像素扫描：真实墨迹框（不做任何字体度量假设）
  var W = Math.ceil(m.width) + 8, H = Math.ceil(parseFloat(cs.fontSize) * 1.6);
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var g = cv.getContext('2d');
  g.font = c.font; g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  var baseY = H * 0.8;
  g.fillText(el.textContent, 4, baseY);
  var d = g.getImageData(0, 0, W, H).data, top = -1, bot = -1;
  for (var y = 0; y < H; y++) {
    var hit = false;
    for (var x = 0; x < W; x++) { if (d[(y * W + x) * 4 + 3] > 40) { hit = true; break; } }
    if (hit) { if (top < 0) top = y; bot = y; }
  }
  var tf = cs.transform, ty = 0;
  if (tf && tf !== 'none') { var mm = tf.match(/matrix\\(([^)]+)\\)/); if (mm) ty = parseFloat(mm[1].split(',')[5]) || 0; }
  return {
    text: el.textContent,
    fontSize: parseFloat(cs.fontSize),
    lineHeight: parseFloat(cs.lineHeight),
    fontFamilyUsed: cs.fontFamily.split(',')[0],
    rectH: +el.getBoundingClientRect().height.toFixed(2),
    transformTY: ty,
    fontAsc: m.fontBoundingBoxAscent, fontDesc: m.fontBoundingBoxDescent,
    inkAsc: m.actualBoundingBoxAscent, inkDesc: m.actualBoundingBoxDescent,
    canvasInkAsc: top < 0 ? null : +(baseY - top).toFixed(2),
    canvasInkDesc: bot < 0 ? null : +(bot - baseY).toFixed(2)
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 960, show: false, backgroundColor: '#000',
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  try {
    await win.loadURL(process.env.SHOT_URL || 'http://localhost:4322');
    win.showInactive();
    await sleep(2500);
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(3200);
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    await sleep(600);
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);  // 暂停
    await sleep(300);
    await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);  // 走到第 2 页（有数字）
    await sleep(1600);
    console.log(JSON.stringify(await js(PROBE), null, 2));
  } catch (e) { console.log('❌ ' + e.message); }
  app.quit();
});
