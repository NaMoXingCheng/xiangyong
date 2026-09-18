/**
 * 抓「点击时报的错」。
 * 挂上控制台监听 + 页内 error/unhandledrejection + 网络失败监听，
 * 然后模拟一轮真实点击，把每次点击后新增的报错按「触发动作」归因。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/抓点击报错.js
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// 每条记录：{ at: 当前动作名, kind, text }
const logs = [];
let currentAction = '(启动)';
const push = (kind, text) => logs.push({ at: currentAction, kind, text: String(text).slice(0, 400) });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960,
    show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---------- 1) 主进程侧：控制台 + 加载失败 ----------
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const lv = ['debug', 'info', 'warn', 'error'][level] || ('level' + level);
    if (lv === 'debug' || lv === 'info') return;           // 只关心 warn / error
    const src = sourceId ? ' @ ' + String(sourceId).split('/').pop() + ':' + line : '';
    push('console.' + lv, message + src);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    push('did-fail-load', code + ' ' + desc + '  ' + url);
  });
  win.webContents.on('render-process-gone', (e, d) => push('崩溃', JSON.stringify(d)));

  // ---------- 2) 主进程侧：网络请求异常 ----------
  session.defaultSession.webRequest.onErrorOccurred((d) => {
    if (d.error === 'net::ERR_ABORTED') return;            // 正常中断，噪声
    push('网络失败', d.error + '  ' + d.url);
  });
  session.defaultSession.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) push('HTTP ' + d.statusCode, d.method + ' ' + d.url);
  });

  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(2500);

    // ---------- 3) 页面侧：补上 window.onerror / promise 未捕获 ----------
    await js(`(function(){
      window.__errs = [];
      window.addEventListener('error', function(e){
        window.__errs.push('error: ' + (e.message||'') + ' @ ' + (e.filename||'').split('/').pop() + ':' + e.lineno);
      }, true);
      window.addEventListener('unhandledrejection', function(e){
        var r = e.reason; window.__errs.push('unhandledrejection: ' + ((r && r.message) || r));
      });
      return true;
    })()`);

    // 每步之间把页面侧收集到的错误取出来归因，再清空
    const drain = async (label) => {
      const got = await js(`(function(){var a=window.__errs||[];window.__errs=[];return a})()`).catch(() => []);
      for (const g of got || []) push('页面异常', g);
      // 同时取一次主进程侧新增（console-message 是实时的，这里不用管）
      void label;
    };

    const act = async (label, code, wait = 900) => {
      currentAction = label;
      let r = null;
      try { r = await js(code); } catch (e) { push('执行失败', (e && e.message) || e); }
      await sleep(wait);
      await drain(label);
      console.log('  · ' + label + (r === false ? '  (未找到元素)' : ''));
    };

    console.log('开始逐项点击…');

    // ---- 一轮覆盖所有可点位置 ----
    await act('点空白处', `(function(){var e=document.querySelector('#main')||document.body;e.click();return true})()`);
    await act('点联系人「她」', `(function(){var el=document.querySelector('.person[data-id="p-d"]');if(!el)return false;el.click();return true})()`, 3500);
    await act('滚动分析页', `(function(){window.scrollTo(0,600);return true})()`);

    await act('点锐评卡片', `(function(){var el=document.querySelector('.roast-card');if(!el)return false;el.click();return true})()`);
    await act('点「AI 重写」按钮', `(function(){var el=document.querySelector('.roast-ai');if(!el)return false;el.click();return true})()`, 2500);
    await act('关 AI 面板', `(function(){var ov=document.querySelector('.ai-ov');if(!ov)return false;var x=ov.querySelector('#apClose')||ov.querySelector('.ap-x');if(x){x.click();return true}ov.click();return true})()`);

    await act('点雷达图', `(function(){var el=document.querySelector('.radar-card');if(!el)return false;el.click();return true})()`);
    await act('点指标卡', `(function(){var el=document.querySelector('.gauge');if(!el)return false;el.click();return true})()`);
    await act('点趋势/情绪卡', `(function(){var el=document.querySelector('.trend-card')||document.querySelector('.sentiment-card');if(!el)return false;el.click();return true})()`);

    await act('点 AI 状态栏', `(function(){var el=document.querySelector('.ai-bar');if(!el)return false;el.click();return true})()`, 2000);
    await act('关档位面板', `(function(){var ov=document.querySelector('.ai-ov');if(!ov)return false;var x=ov.querySelector('#apClose')||ov.querySelector('.ap-x');if(x){x.click();return true}ov.click();return true})()`);

    await act('点承诺「勾选兑现」', `(function(){var el=document.querySelector('.pm-check:not(.on)');if(!el)return false;el.click();return true})()`, 1800);
    await act('点承诺「编辑」', `(function(){var el=document.querySelector('.pm-edit');if(!el)return false;el.click();return true})()`, 1200);
    await act('点「保存」编辑', `(function(){var el=document.querySelector('#pmSave');if(!el)return false;el.click();return true})()`, 1500);
    await act('点承诺「删除」', `(function(){var el=document.querySelector('.pm-del');if(!el)return false;el.click();return true})()`, 1500);
    await act('点承诺「添加」', `(function(){var el=document.querySelector('#pmAdd');if(!el)return false;el.click();return true})()`, 1200);

    await act('点 To Do「添加」', `(function(){var el=document.querySelector('.tl-addtodo');if(!el)return false;el.click();return true})()`, 1200);
    await act('点 To Do 勾选', `(function(){var el=document.querySelector('.todo-check:not(.on)');if(!el)return false;el.click();return true})()`, 1500);

    await act('点喜好「编辑」', `(function(){var el=document.querySelector('.lk-edit');if(!el)return false;el.click();return true})()`, 1200);
    await act('点喜好「删除」', `(function(){var el=document.querySelector('.lk-del');if(!el)return false;el.click();return true})()`, 1500);
    await act('点喜好「添加」', `(function(){var el=document.querySelector('.lk-add');if(!el)return false;el.click();return true})()`, 1200);

    await act('点纪念日卡片', `(function(){var el=document.querySelector('.anv-date');if(!el)return false;el.click();return true})()`, 1500);
    await act('点「结论」折叠', `(function(){var el=document.querySelector('.q');if(!el)return false;el.click();return true})()`);
    await act('点「开关」', `(function(){var el=document.querySelector('.tog');if(!el)return false;el.click();return true})()`, 1200);

    await act('打开年度报告', `(function(){var el=document.querySelector('#reportEntry');if(!el)return false;el.click();return true})()`, 2500);
    await act('报告翻页', `(function(){var el=document.querySelector('#rsNext');if(!el)return false;el.click();return true})()`, 900);
    await act('报告上一页', `(function(){var el=document.querySelector('#rsPrev');if(!el)return false;el.click();return true})()`, 900);
    await act('报告暂停/播放', `(function(){var el=document.querySelector('#rsPlay');if(!el)return false;el.click();return true})()`, 900);
    await act('关闭报告', `(function(){var el=document.querySelector('#rsClose');if(!el)return false;el.click();return true})()`, 900);

    await act('点设置按钮', `(function(){var el=document.querySelector('#setBtn');if(!el)return false;el.click();return true})()`, 1800);
    await act('关设置面板', `(function(){var el=document.querySelector('.sp-x');if(!el)return false;el.click();return true})()`);
    await act('点导入按钮', `(function(){var el=document.querySelector('#importBtn');if(!el)return false;el.click();return true})()`, 1500);
    await act('关导入框', `(function(){var el=document.querySelector('#ioCancel');if(!el)return false;el.click();return true})()`);

    await drain('结束');
  } catch (e) {
    push('脚本异常', (e && e.message) || e);
  }

  // ---------- 输出报告 ----------
  console.log('\n================ 报错汇总 ================');
  if (!logs.length) {
    console.log('（没有任何 warn/error 记录）');
  } else {
    const byKind = {};
    for (const l of logs) { (byKind[l.kind] = byKind[l.kind] || []).push(l); }
    for (const k of Object.keys(byKind)) {
      console.log('\n【' + k + '】 共 ' + byKind[k].length + ' 条');
      const seen = new Set();
      for (const l of byKind[k]) {
        const key = l.text.slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);
        console.log('   触发于: ' + l.at);
        console.log('     ' + l.text);
      }
      const others = byKind[k].length - seen.size;
      if (others > 0) console.log('   （另有 ' + others + ' 条同类型重复，已折叠）');
    }
  }
  console.log('\n==========================================');
  app.quit();
});
