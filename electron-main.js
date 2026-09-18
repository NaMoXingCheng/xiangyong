const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const http = require('http');

// ==================== 先摘掉外来的 GPU 禁用开关 ====================
// 桌面快捷方式、旧的启动脚本、甚至上一版遗留的调用习惯，都可能传 --disable-gpu 进来
// （本机快捷方式里就带着 --disable-gpu --in-process-gpu）。只要它在命令行里，
// Chromium 就会禁用 GPU、整个界面退回 CPU 软件渲染。
//
// 渲染模式由下面那段统一决定，所以这里先把旧的开关摘掉。
// 实测（分析页滚动，帧间隔中位数）：带 --disable-gpu 时 57ms（≈17fps），
// 摘掉之后 6ms（≈166fps）。差 10 倍，这一步不能省。
for (const sw of ['disable-gpu', 'disable-gpu-compositing', 'in-process-gpu']) {
  try { app.commandLine.removeSwitch(sw); } catch (e) {}
}

// ==================== 渲染模式 ====================
// 这里原本无条件禁用了硬件加速（disableHardwareAcceleration + disable-gpu
// + disable-gpu-compositing），代价是整个界面改用 CPU 软件渲染。
// 实测（1400×900，本机）：
//     分析页滚动   软件渲染 63ms/帧（≈16fps，最长一帧 159ms）  →  开 GPU 后 6ms/帧（≈166fps）
// 差 10 倍。原因不难理解：界面上有 13 张 22px 半径的毛玻璃卡片，
// 加上绿色彩蛋那 240 个一直在摆动的草叶/萤火虫元素，全都靠 CPU 逐像素算。
//
// 所以默认走硬件加速。只有真的碰上 GPU 进程崩溃 / 白屏这类驱动问题时才回退：
//   1) 命令行临时试：  set XIANGYONG_SOFT_RENDER=1  （PowerShell: $env:XIANGYONG_SOFT_RENDER=1）
//   2) 程序自己判定：  下面会在检测到 GPU 进程崩溃后写一个标记，之后启动自动降级
const GPU_FLAG = path.join(require('os').homedir(), '.xiangyong-gpu-flag');
const gpuKeepsCrashing = (() => { try { return require('fs').existsSync(GPU_FLAG); } catch (e) { return false; } })();
const FORCE_SOFT = process.env.XIANGYONG_SOFT_RENDER === '1' || gpuKeepsCrashing;

if (FORCE_SOFT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  if (gpuKeepsCrashing) console.log('检测到上次 GPU 进程崩溃，本次改用软件渲染（想重试硬件加速就删掉 ' + GPU_FLAG + '）');
} else {
  // 硬件加速下让光栅化也走 GPU，并把界面渲染交给合成器（列表滚动明显更稳）
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

const PORT = 4322;
const URL = `http://localhost:${PORT}`;

let win = null;
let gpuCrashSeen = 0;
let quitting = false;   // 应用正在退出。退出时 GPU 进程会被一起收掉，那不是崩溃。

// GPU 进程崩了两次以上才认定为「这台机器的驱动扛不住」，写标记，下次自动软件渲染。
// 崩一次不算数：偶发的驱动重置重启一下就好，没必要牺牲整个界面的流畅度。
//
// 有个坑踩过：应用正常关闭时，系统会给 GPU 进程发 SIGTERM（exit_code=143），
// Electron 把这个也报成 reason='crashed'。要是不排除掉，用户正常开关两次应用
// 就会被记成「GPU 一直崩」，下次启动悄悄降级成软件渲染 —— 白卡一场。
app.on('child-process-gone', (e, details) => {
  if (quitting) return;
  if (!details || details.type !== 'GPU') return;
  if (details.reason !== 'crashed' && details.reason !== 'abnormal-exit') return;
  if (details.exitCode === 143 || details.exitCode === 15) return;   // 143/15 = SIGTERM，是被外部结束的
  gpuCrashSeen++;
  console.log('GPU 进程异常（' + details.reason + ' / exit=' + details.exitCode + '），累计 ' + gpuCrashSeen + ' 次');
  if (gpuCrashSeen >= 2 && !FORCE_SOFT) {
    try { require('fs').writeFileSync(GPU_FLAG, new Date().toISOString()); } catch (e) {}
    console.log('已记录：下次启动将自动改用软件渲染，避免界面反复白屏。');
    console.log('（想重新试硬件加速，删掉这个文件即可：' + GPU_FLAG + '）');
  }
});

// ==================== 防多开 ====================
// 必须卡在 require('server.js') 之前。server.js 在被 require 的那一刻就会
// listen(4322)，第二个实例会撞端口、抛 EADDRINUSE 把进程崩掉，
// 拦在前面才不至于白崩一次、也不会出现两个窗口抢同一份数据。
// 拿不到锁 = 已经有实例在跑：本进程立刻退出，并把已有窗口唤到最前。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);   // 同步退出，确保下面的 require 不会执行
}

// 已有实例收到「有人又双击了一次」→ 把窗口拉到前台，而不是开新的
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();   // 窗口被关掉但进程还在（macOS 常见）
  }
});

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
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '相拥 · 关系分析室',
    autoHideMenuBar: true,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.on('closed', () => { win = null; });
  waitForServer(20, () => { if (win && !win.isDestroyed()) win.loadURL(URL); });
}

app.whenReady().then(() => {
  // 明确声明内容安全策略，替代 Electron 默认的「未设置 CSP」警告。
  // 故意用 http 头而不是 <meta>：改这里不用动 index.html，也不会影响内联 style。
  // 注意 script-src 里不能放 'unsafe-eval'，否则 Electron 依旧报警告。
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: Object.assign({}, details.responseHeaders, {
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self' data:; " +
            "connect-src 'self'; " +
            "object-src 'none'; " +
            "base-uri 'self'"
          ]
        })
      });
    });
  } catch (e) { /* 拿不到 session（极端情况）就算了，不影响功能 */ }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// 应用开始退出 → 之后 GPU 进程的消失都是正常的，不再计为崩溃
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  quitting = true;
  if (process.platform !== 'darwin') app.quit();
});
