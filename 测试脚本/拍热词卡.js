const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, '截图', '验收');
fs.mkdirSync(OUT, { recursive: true });
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const js = c => win.webContents.executeJavaScript(c, true);
  await win.loadURL('http://localhost:4322'); win.showInactive(); await sleep(3200);
  await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
  await sleep(4200);
  await js(`(function(){
    var c=[...document.querySelectorAll('.card')].find(x=>x.querySelector('#wcAi')); if(!c) return;
    var m=document.getElementById('main'); var r=c.getBoundingClientRect();
    if(m) m.scrollTop = m.scrollTop + r.top - 90; else window.scrollTo(0, r.top+window.scrollY-90);
  })()`);
  await sleep(1500);
  fs.writeFileSync(path.join(OUT, '06-热词榜卡片.png'), (await win.capturePage()).toPNG());
  console.log('ok'); app.quit();
});
