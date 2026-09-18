/**
 * 验证「替代 prompt/confirm 的自绘对话框」是否真的能用。
 * 背景：Electron 里 window.prompt() 直接抛异常，所以「添加喜好 / 纪念日」原本是坏的。
 * 这里走一遍完整交互：弹出 → 输入 → 确定 → 落库 → 取消 → Esc 关闭。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测试脚本/测对话框.js
 */
const { app, BrowserWindow, session } = require('electron');

const TARGET = process.env.SHOT_URL || 'http://localhost:4322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const errs = [];
let step = '';

app.whenReady().then(async () => {
  // 与 electron-main.js 完全一致的 CSP，用来验证两件事：
  //   1) 加上它之后 Electron 的安全警告确实消失
  //   2) 它不会误伤页面（内联 style、动态 innerHTML、fetch 都还能用）
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

  const win = new BrowserWindow({
    width: 1500, height: 960, show: false,
    backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  win.webContents.on('console-message', (e, level, message, line, src) => {
    if (level >= 2) errs.push('[' + step + '] console: ' + message + ' @ ' + String(src || '').split('/').pop() + ':' + line);
  });

  const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m);
  let pass = 0, fail = 0;
  const check = (c, m) => { c ? pass++ : fail++; ok(c, m); };

  try {
    await win.loadURL(TARGET);
    win.showInactive();
    await sleep(2500);

    step = '打开联系人';
    await js(`(function(){var el=document.querySelector('.person[data-id="p-d"]');if(el)el.click();return !!el})()`);
    await sleep(3500);

    // 记录操作前的喜好条数
    const before = await js(`document.querySelectorAll('.lk-tag').length`);

    // ---------- 1) askText：添加喜好 ----------
    step = '点「添加喜好」';
    console.log('\n【1】添加喜好（askText）');
    const clicked = await js(`(function(){var b=document.querySelector('.lk-add[data-side="me"]');if(!b)return false;b.click();return true})()`);
    check(clicked, '找到「+ 添加」按钮并点击');
    await sleep(700);

    let dlg = await js(`(function(){var d=document.querySelector('.dlg-mask');
      if(!d)return null;
      var inp=d.querySelector('.dlg-inp');
      return {title:(d.querySelector('.m-head')||{}).textContent||'', sub:(d.querySelector('.m-sub')||{}).textContent||'',
              hasInput:!!inp, hasCancel:!!d.querySelector('.dlg-no')};})()`);
    check(!!dlg, '对话框已弹出（不再抛 prompt 异常）');
    if (dlg) {
      console.log('      标题: ' + dlg.title + ' | 说明: ' + dlg.sub);
      check(dlg.hasInput, '含输入框');
      check(dlg.hasCancel, '含取消按钮');
    }

    // 空内容不应提交
    step = '空内容点确定';
    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-yes').click();return true})()`);
    await sleep(500);
    const stillOpen = await js(`!!document.querySelector('.dlg-mask')`);
    check(stillOpen, '内容为空时拒绝提交、对话框保持打开');

    // 填入内容并确认
    step = '输入并确定';
    await js(`(function(){var i=document.querySelector('.dlg-inp');if(!i)return false;i.value='测试喜好-露营';return true})()`);
    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-yes').click();return true})()`);
    await sleep(2500);
    const closed = await js(`!document.querySelector('.dlg-mask')`);
    check(closed, '确定后对话框关闭');
    const after = await js(`document.querySelectorAll('.lk-tag').length`);
    check(after === before + 1, '喜好已写入（' + before + ' → ' + after + ' 条）');

    // ---------- 2) askOk 取消 ----------
    step = '删除喜好-取消';
    console.log('\n【2】删除喜好（askOk，选取消）');
    await js(`(function(){var t=[].slice.call(document.querySelectorAll('.lk-tag')).filter(function(x){return (x.dataset.text||'').indexOf('测试喜好')>=0})[0];
      if(!t)return false;var b=t.querySelector('.lk-del');if(!b)return false;b.click();return true})()`);
    await sleep(700);
    dlg = await js(`(function(){var d=document.querySelector('.dlg-mask');
      if(!d)return null;var y=d.querySelector('.dlg-yes');
      return {title:(d.querySelector('.m-head')||{}).textContent||'', danger:!!(y&&y.className.indexOf('danger')>=0)};})()`);
    check(!!dlg, '确认框已弹出');
    if (dlg) check(dlg.danger, '危险操作按钮变红（danger 样式生效）');

    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-no').click();return true})()`);
    await sleep(1200);
    const kept = await js(`document.querySelectorAll('.lk-tag').length`);
    check(kept === after, '点取消后条目保留（' + kept + ' 条）');

    // ---------- 3) askOk 确认 ----------
    step = '删除喜好-确认';
    await js(`(function(){var t=[].slice.call(document.querySelectorAll('.lk-tag')).filter(function(x){return (x.dataset.text||'').indexOf('测试喜好')>=0})[0];
      if(!t)return false;t.querySelector('.lk-del').click();return true})()`);
    await sleep(700);
    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-yes').click();return true})()`);
    await sleep(2500);
    const back = await js(`document.querySelectorAll('.lk-tag').length`);
    check(back === before, '点删除后条目真的被删（回到 ' + before + ' 条）');

    // ---------- 4) Esc 关闭 ----------
    step = 'Esc 关闭';
    console.log('\n【3】Esc 关闭对话框');
    await js(`(function(){var b=document.querySelector('.lk-add[data-side="me"]');if(b)b.click();return true})()`);
    await sleep(1200);
    const opened = await js(`!!document.querySelector('.dlg-mask')`);
    check(opened, '对话框已打开（准备测 Esc）');
    await js(`(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
    await sleep(900);
    const escClosed = await js(`!document.querySelector('.dlg-mask')`);
    check(escClosed, 'Esc 能关掉对话框');
    if (!escClosed) {
      // 兜底清场，别让残留对话框影响后面的步骤
      await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.remove();return true})()`);
    }

    // ---------- 5) 纪念日：连续两个对话框 ----------
    step = '纪念日添加';
    console.log('\n【4】添加纪念日（连续两次 askText）');
    const anvBefore = await js(`document.querySelectorAll('.anv').length`);
    await js(`(function(){var b=document.querySelector('#addAnniv');if(b)b.click();return !!b})()`);
    await sleep(700);
    const d1 = await js(`(function(){var d=document.querySelector('.dlg-mask');return d?((d.querySelector('.m-head')||{}).textContent||''):null})()`);
    check(!!d1, '第一步对话框弹出：' + d1);
    await js(`(function(){var i=document.querySelector('.dlg-inp');if(i)i.value='测试纪念日';return true})()`);
    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-yes').click();return true})()`);
    await sleep(700);
    const d2 = await js(`(function(){var d=document.querySelector('.dlg-mask');return d?((d.querySelector('.m-head')||{}).textContent||''):null})()`);
    check(!!d2, '第二步对话框自动弹出：' + d2);
    // 故意输错格式，验证校验
    await js(`(function(){var i=document.querySelector('.dlg-inp');if(i)i.value='08/15';return true})()`);
    await js(`(function(){var d=document.querySelector('.dlg-mask');if(d)d.querySelector('.dlg-yes').click();return true})()`);
    await sleep(1000);
    const anvAfterBad = await js(`document.querySelectorAll('.anv').length`);
    check(anvAfterBad === anvBefore, '日期格式错误时不写入（' + anvBefore + ' → ' + anvAfterBad + '）');
    const dlgGone = await js(`!document.querySelector('.dlg-mask')`);
    check(dlgGone, '校验失败后对话框已收起');

    // ---------- 6) 缩略图接口 ----------
    step = '缩略图接口';
    console.log('\n【5】缩略图接口（原 404 已改为透明占位）');
    const codes = await js(`(function(){
      var ts=[].slice.call(document.querySelectorAll('.tl-img')).map(function(i){return i.src});
      if(!ts.length) return 'no-img';
      return Promise.all(ts.slice(0,5).map(function(u){return fetch(u).then(function(r){return r.status})})).then(function(a){return a.join(',')});
    })()`);
    console.log('      取样 ' + codes);
    check(codes === 'no-img' || /^200(,200)*$/.test(String(codes)), '缩略图请求全部返回 200（无 404 红字）');
  } catch (e) {
    console.log('  ❌ 脚本异常: ' + ((e && e.message) || e));
    fail++;
  }

  console.log('\n================ 结果 ================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (errs.length) {
    console.log('\n  控制台 warn/error（' + errs.length + ' 条）:');
    [...new Set(errs)].forEach(x => console.log('    ' + x));
  } else {
    console.log('  控制台干净：没有任何 warn/error ✅');
  }
  console.log('======================================');
  app.quit();
});
