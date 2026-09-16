const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

// 关闭硬件加速，避免部分机器 GPU 进程反复崩溃
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const PORT = 4322;
const URL = `http://localhost:${PORT}`;

// 启动后端：server.js 在 Electron 主进程内运行（端口 4322，与自用版 4321 隔离）
require(path.join(__dirname, 'server.js'));

function waitForServer(retries, cb) {
  const req = http.get(URL + '/api/settings', (res) => { res.resume(); cb(); });
  req.on('error', () => {
    if (retries <= 0) { cb(); return; }
    setTimeout(() => waitForServer(retries - 1, cb), 400);
  });
  req.setTimeout(1500, () => { req.destroy(); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '相拥 · 关系分析室',
    autoHideMenuBar: true,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  waitForServer(20, () => { win.loadURL(URL); });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
