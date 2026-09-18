/**
 * 离屏截图：用 Electron 把运行中的界面渲染出来存成 PNG，用来核对视觉效果。
 * 必须用 env -u ELECTRON_RUN_AS_NODE 启动，否则 Electron 会以纯 Node 模式跑（不认 chromium 开关）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox _shot.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图');
fs.mkdirSync(OUT, { recursive: true });
const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

async function save(win, name) {
  const img = await win.capturePage();
  const buf = img.toPNG();
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  console.log('  ✅ ' + name + '  (' + Math.round(buf.length / 1024) + ' KB)');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960,
    show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  try {
    console.log('打开 ' + TARGET);
    await win.loadURL(TARGET);
    // 必须让窗口真正参与渲染：show:false 时渲染帧被节流，requestAnimationFrame 迟迟不执行，
    // 会截到「点了没反应」的半成品画面（踩过）。showInactive 不抢焦点。
    win.showInactive();
    await sleep(3000);
    await save(win, '01-联系人列表');

    const ok = await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el){el.click();return true}return false})()`);
    console.log('  选中「她」: ' + ok);
    await sleep(4000);
    await save(win, '02-分析页顶部');

    await js(`(function(){
      var el=document.querySelector('.pm-card'); if(!el) return false;
      var r=el.getBoundingClientRect();
      window.scrollTo(0, r.top + window.scrollY - 140);
      var m=document.getElementById('main');
      if(m && m.scrollHeight > m.clientHeight) m.scrollTop = m.scrollTop + r.top - 140;
      return true;
    })()`);
    await sleep(1500);
    await save(win, '03-承诺追踪');

    await js(`(function(){var el=document.querySelector('#reportEntry');if(el){el.click();return true}return false})()`);
    await sleep(1800);
    await save(win, '04-年度报告-封面');
    await sleep(4000);
    await save(win, '05-年度报告-第2页');
    await sleep(4000);
    await save(win, '06-年度报告-第3页');
    await sleep(4600);
    await save(win, '07-年度报告-第4页');

    await js(`(function(){var el=document.querySelector('#rsClose');if(el)el.click();return true})()`);
    await sleep(900);
    console.log('完成');
  } catch (e) {
    console.log('❌ ' + (e && e.message));
  }
  app.quit();
});
