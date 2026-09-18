/**
 * 端到端验证真实应用：用「桌面快捷方式同款参数」启动，连进渲染进程实测。
 *
 * 为什么必须这么测：快捷方式里带着 --disable-gpu --in-process-gpu，
 * 单独跑测试脚本验证不了「应用自己能不能把这些开关摘掉」。
 * 这里直接启动 electron-main.js 本体，再通过 Chrome DevTools Protocol
 * 连进渲染进程注入测量代码 —— 测的就是用户双击图标时的那份进程。
 *
 * 用法：node 测试脚本/测真实应用.js
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const EXE = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG = path.join(APP, '_real.log');
const PORT = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 与桌面快捷方式完全一致（含那两个「旧」开关），额外加调试端口用于连入
const ARGS = ['--no-sandbox', '--disable-gpu', '--in-process-gpu',
  '--remote-debugging-port=' + PORT, APP];

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIANGYONG_SOFT_RENDER;

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  return {
    ready,
    send(method, params) {
      const myId = ++id;
      return new Promise(res => { pend.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
    },
    close: () => ws.close(),
  };
}

(async () => {
  let pass = 0, fail = 0;
  const check = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✅ ' : '  ❌ ') + m); };

  // 清场
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }); } catch (e) {}
  await sleep(2500);
  try { fs.unlinkSync(LOG); } catch (e) {}

  console.log('启动真实应用（参数与桌面快捷方式一致：--no-sandbox --disable-gpu --in-process-gpu）');
  const out = fs.openSync(LOG, 'w');
  const p = spawn(EXE, ARGS, { env, stdio: ['ignore', out, out], detached: true });
  p.unref();
  await sleep(14000);

  try {
    // ---------- 连入渲染进程 ----------
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = list.find(t => t.type === 'page' && /localhost:4322/.test(t.url || ''));
    check(!!page, '已连上应用的渲染进程（' + (page ? page.url : '未找到页面') + '）');
    if (!page) throw new Error('拿不到调试目标');

    const c = cdp(page.webSocketDebuggerUrl);
    await c.ready;
    const evalJs = async (expr) => {
      const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : null;
    };

    // ---------- 1) 真的在用 GPU 吗 ----------
    const gpu = await evalJs(`(function(){
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { ok:false, reason:'拿不到 WebGL 上下文' };
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return { ok:true, vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '?',
               renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?' };
    })()`);
    console.log('      渲染器: ' + (gpu && gpu.renderer) + '  /  ' + (gpu && gpu.vendor));
    const isSoftware = /SwiftShader|Software|Basic Render/i.test(String(gpu && gpu.renderer));
    check(gpu && gpu.ok && !isSoftware, '用的是真实 GPU 而不是软件光栅化（SwiftShader）');

    // ---------- 2) 帧率 ----------
    const fps = await evalJs(`new Promise(function(res){
      var m = document.getElementById('main') || document.documentElement;
      var useWin = (m === document.documentElement);
      var gaps=[], last=performance.now(), i=0;
      function step(){
        if(i>=180){ if(useWin) window.scrollTo(0,0); else m.scrollTop=0; return res(gaps); }
        var now=performance.now(); gaps.push(Math.round(now-last)); last=now;
        if(useWin) window.scrollTo(0,(window.scrollY+24)%3000); else m.scrollTop=(m.scrollTop+24)%3000;
        i++; requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })`);
    if (fps && fps.length) {
      const s = fps.slice(1).sort((a, b) => a - b);
      const p50 = s[Math.floor(s.length / 2)];
      const max = s[s.length - 1];
      const jank = s.filter(x => x > 33).length;
      console.log('      列表页滚动：p50 ' + p50 + 'ms   最长 ' + max + 'ms   >33ms 的帧 ' + jank + ' 个');
      check(p50 <= 20, '列表页帧间隔 p50 = ' + p50 + 'ms（60fps 应 ≈16.7ms）');
      check(jank <= 3, '掉帧（>33ms）只有 ' + jank + ' 个');
    } else {
      check(false, '帧率采样失败');
    }

    // ---------- 3) 切到分析页再测（卡片最多、最吃性能）----------
    await evalJs(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(6000);
    const fps2 = await evalJs(`new Promise(function(res){
      var m = document.getElementById('main') || document.documentElement;
      var useWin = (m === document.documentElement);
      var gaps=[], last=performance.now(), i=0;
      function step(){
        if(i>=180){ if(useWin) window.scrollTo(0,0); else m.scrollTop=0; return res(gaps); }
        var now=performance.now(); gaps.push(Math.round(now-last)); last=now;
        if(useWin) window.scrollTo(0,(window.scrollY+24)%3000); else m.scrollTop=(m.scrollTop+24)%3000;
        i++; requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })`);
    if (fps2 && fps2.length) {
      const s = fps2.slice(1).sort((a, b) => a - b);
      const p50 = s[Math.floor(s.length / 2)];
      const p95 = s[Math.floor(s.length * 0.95)];
      const max = s[s.length - 1];
      const jank = s.filter(x => x > 33).length;
      console.log('      分析页滚动：p50 ' + p50 + 'ms   p95 ' + p95 + 'ms   最长 ' + max + 'ms   >33ms 的帧 ' + jank + ' 个');
      check(p50 <= 20, '分析页帧间隔 p50 = ' + p50 + 'ms');
      check(jank <= 5, '分析页掉帧（>33ms）只有 ' + jank + ' 个');
    }

    // ---------- 4) 控制台干净吗 ----------
    const errs = await evalJs(`(function(){
      return { prompt: typeof window.prompt, w: window.innerWidth, h: window.innerHeight };
    })()`);
    console.log('      窗口 ' + (errs && errs.w) + '×' + (errs && errs.h));

    c.close();
  } catch (e) {
    console.log('  ❌ ' + ((e && e.message) || e));
    fail++;
  }

  console.log('\n---- 应用日志 ----');
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  log.split('\n').filter(x => x.trim()).slice(0, 12).forEach(x => console.log('  ' + x.slice(0, 150)));
  const crash = /GPU 进程异常/.test(log);
  check(!crash, '日志里没有 GPU 异常');

  console.log('\n================ 结果 ================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('======================================');

  try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }); } catch (e) {}
  try { fs.unlinkSync(LOG); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
