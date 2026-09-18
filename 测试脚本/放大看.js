/**
 * 放大看某个元素的渲染细节，并把它的计算样式打出来。
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/放大看.js
 * 环境变量：SHOT_URL（默认 http://localhost:4322）、ZOOM（默认 4）
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '放大');
fs.mkdirSync(OUT, { recursive: true });
const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const ZOOM = Number(process.env.ZOOM || 4);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960,
    show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(3000);

    // 选中「她」并滚到承诺卡片
    await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(4000);
    await js(`(function(){
      var m=document.getElementById('main'); var el=document.querySelector('.pm-card');
      if(el){ var r=el.getBoundingClientRect(); m.scrollTop = m.scrollTop + r.top - 130; }
      return 1;
    })()`);
    await sleep(1200);

    // 1) 打印样式对比
    const style = await js(`(function(){
      var pick = function(sel){
        var el = document.querySelector(sel); if(!el) return null;
        var c = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return {
          sel: sel,
          text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30),
          font: c.fontFamily.split(',')[0] + ' / ' + c.fontSize + ' / ' + c.fontWeight,
          ls: c.letterSpacing, color: c.color, num: c.fontVariantNumeric,
          box: Math.round(r.width) + 'x' + Math.round(r.height),
          baselineTop: Math.round(r.top)
        };
      };
      return {
        count: pick('.pm-card .pm-count'),
        secTitle: pick('.pm-card .sec-t'),
        gaugeBig: pick('.g .big'),
        tapCount: pick('.pm-count'),
        others: Array.prototype.slice.call(document.querySelectorAll('.g .big')).map(function(e){
          return e.textContent.trim() + ' :: ' + getComputedStyle(e).fontSize;
        }).slice(0,6)
      };
    })()`);
    console.log(JSON.stringify(style, null, 1));

    // 2) 截图放大
    // 注意：capturePage 的 rect 和 getBoundingClientRect 之间有几像素偏移（实测约 8px），
    // 按元素高度精确裁会把文字切掉头。所以上下都多留白，宁可多截。
    const rect = await js(`(function(){
      var el = document.querySelector('.pm-card'); if(!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x) - 10, y: Math.round(r.y) - 20,
               width: Math.round(r.width) + 20, height: Math.round(r.height) + 40 };
    })()`);
    if (rect) {
      const img = await win.capturePage(rect);
      const big = img.resize({ width: img.getSize().width * ZOOM, quality: 'best' });
      const f = path.join(OUT, 'pm-count-x' + ZOOM + '.png');
      fs.writeFileSync(f, big.toPNG());
      console.log('✅ ' + f + '  (' + big.getSize().width + 'x' + big.getSize().height + ')');
    } else {
      console.log('❌ 没找到 .pm-card .sec-t');
    }
  } catch (e) {
    console.log('❌ ' + (e && e.stack ? e.stack : e));
  }
  app.quit();
});
