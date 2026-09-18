/**
 * 本轮四件事的验证：控制条静止后是否真隐身、放映结束是否有提示、节奏是否居中、待办是否默认折叠。
 * 用法：env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测报告收尾.js
 * 说明：节奏和「结束」两项都要等真实计时器走完，整个脚本约 40 秒。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '收尾');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '　实测: ' + JSON.stringify(extra) : '')); }
};

const CTRL = `(function(){
  var s = document.getElementById('reportStage'), c = document.querySelector('.rs-ctrl');
  if (!s || !c) return { err: 'no stage' };
  var cs = getComputedStyle(c);
  return { idle: s.classList.contains('idle'), opacity: +cs.opacity,
           bg: cs.backgroundColor, border: cs.borderTopColor, pe: cs.pointerEvents };
})()`;
const IDX = `(function(){var e=document.querySelector('.rs-idx');return e?e.textContent.trim():''})()`;
const ENDED = `(function(){
  var s = document.getElementById('reportStage');
  var d = document.querySelector('.rs-done'), p = document.getElementById('rsPlay');
  if (!s) return { err: 'no stage' };
  return { ended: s.classList.contains('ended'), doneText: d ? d.textContent.trim() : '',
           doneOpacity: d ? +getComputedStyle(d).opacity : -1, play: p ? p.textContent.trim() : '' };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await win.capturePage()).toPNG());
  const waitFor = async (cond, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await js(cond)) return Date.now() - t; await sleep(120); }
    return -1;
  };

  try {
    await win.loadURL(process.env.SHOT_URL || 'http://localhost:4322');
    win.showInactive();
    await sleep(3000);
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(3500);

    // ---------- 待办默认折叠 ----------
    console.log('【待办默认折叠】');
    // 先清掉用户偏好，模拟「第一次打开」
    await js(`try{localStorage.removeItem('ta_love_todo_folded')}catch(e){}`);
    await win.webContents.reload();
    await sleep(2600);
    const t0 = await js(`(function(){
      var p = document.getElementById('todoPanel');
      return { has: !!p, collapsed: p ? p.classList.contains('collapsed') : null,
               w: p ? Math.round(p.getBoundingClientRect().width) : 0,
               bodyOpacity: p ? +getComputedStyle(p.querySelector('.todo-body')).opacity : -1,
               stored: (function(){try{return localStorage.getItem('ta_love_todo_folded')}catch(e){return 'err'}})() };
    })()`);
    ok(t0.has && t0.collapsed === true, '首次打开待办面板就是折叠的', t0);
    ok(t0.bodyOpacity < .1, '折叠时内容区透明（opacity=' + t0.bodyOpacity + '）', t0);
    ok(t0.w > 0 && t0.w < 70, '折叠后只留一条窄边（' + t0.w + 'px）', t0);
    await shot('收尾-01-待办默认折叠');

    await js(`(function(){var e=document.getElementById('todoCollapse');if(e)e.click();})()`);
    await sleep(600);
    const t1 = await js(`(function(){
      var p = document.getElementById('todoPanel');
      return { collapsed: p.classList.contains('collapsed'), w: Math.round(p.getBoundingClientRect().width),
               stored: (function(){try{return localStorage.getItem('ta_love_todo_folded')}catch(e){return 'err'}})() };
    })()`);
    ok(t1.collapsed === false, '点一下能展开', t1);
    ok(t1.stored === '0', '展开选择被记住（localStorage=0）', t1);
    ok(t1.w > t0.w, '展开后确实变宽（' + t0.w + ' → ' + t1.w + 'px）', t1);
    await shot('收尾-02-待办展开');

    await js(`(function(){var e=document.getElementById('todoCollapse');if(e)e.click();})()`);
    await sleep(500);
    const t2 = await js(`(function(){return {collapsed:document.getElementById('todoPanel').classList.contains('collapsed'),
      stored:(function(){try{return localStorage.getItem('ta_love_todo_folded')}catch(e){return 'err'}})()}})()`);
    ok(t2.collapsed === true && t2.stored === '1', '再点收回折叠，且记成 1', t2);

    // ---------- 报告：节奏 ----------
    console.log('\n【放映节奏】');
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(3200);
    const T0 = Date.now();
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    const dt = await waitFor(`document.querySelector('.rs-idx').textContent.trim().startsWith('2 ')`, 9000);
    ok(dt > 0, '第 1 页自动翻到第 2 页', dt);
    // 首页 dur 5800 × RS_PACE .78 ≈ 4524ms（开页本身还有 ~600ms 的加载/入场）
    ok(dt >= 3800 && dt <= 5600, '首页停留落在「适中」区间（实测 ' + dt + 'ms，原 6800 / 更快时 3800）', dt);
    ok(Date.now() - T0 > 0, '总耗时 ' + (Date.now() - T0) + 'ms');

    // ---------- 自动翻页不该惊动控制条 ----------
    // 之前 rsGo 里顺手 rsWake()，结果每 5 秒自动翻页时控制条连着页码都亮一次 —— 用户看到的
    // 就是「页码每换一页闪一下」。控制条只该被人的操作唤醒。
    console.log('\n【自动翻页不惊动控制条】');
    const auto = await js(CTRL);
    ok(auto.idle === true, '自动翻到第 2 页后仍处于隐身态', auto);
    ok(auto.opacity <= .1, '控制条没被自动翻页点亮（opacity=' + auto.opacity + '）', auto);
    const pw = await js(`(function(){var p=document.querySelector('.rs-pager');return p?Math.round(p.getBoundingClientRect().width):-1})()`);
    ok(pw <= 2, '页码同样没冒出来（宽度 ' + pw + 'px）', pw);
    await shot('收尾-02b-自动翻页后仍隐身');

    // ---------- 控制条隐身 ----------
    console.log('\n【控制条静止隐身】');
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);  // 暂停，免得翻页
    await sleep(700);
    const c0 = await js(CTRL);
    ok(c0.err === undefined, '取到控制条', c0);
    ok(c0.idle === false, '刚操作过，还没进入隐身态', c0);

    // 停手 2.6 秒（RS_IDLE = 2200ms）
    await sleep(2700);
    const c1 = await js(CTRL);
    ok(c1.idle === true, '鼠标静止 2.2 秒后进入隐身态', c1);
    ok(c1.opacity <= .1, '隐身时整条几乎看不见（opacity=' + c1.opacity + '，改前是 .34）', c1);
    ok(/rgba\(0, 0, 0, 0\)|transparent/.test(c1.bg), '隐身时底色也撤掉，不留深色板子（' + c1.bg + '）', c1);
    ok(c1.pe === 'none', '隐身时不接收点击，避免点到看不见的按钮', c1);
    await shot('收尾-03-控制条隐身');

    move(300, 300);
    await sleep(700);
    const c2 = await js(CTRL);
    ok(c2.idle === false, '鼠标一动就退出隐身态', c2);
    ok(c2.opacity > .9, '退出隐身后控制条恢复清晰（opacity=' + c2.opacity + '）', c2);
    ok(c2.pe !== 'none', '恢复时可点击', c2);

    // 移出窗口范围 → 也该收掉
    move(2, 2);
    await sleep(120);
    await js(`window.dispatchEvent(new Event('blur'))`);
    await sleep(2600);
    const c3 = await js(CTRL);
    ok(c3.idle === true, '鼠标停着不动（哪怕在窗口内），一样收掉', c3);

    // ---------- 放映结束：提示 ----------
    console.log('\n【放映结束提示】');
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);  // 恢复播放，同时唤醒
    await sleep(400);
    // 快进到最后一页。页数是动态的（9~15），所以末页号从 .rs-idx 里读，不写死。
    const total = await js(`(function(){var m=/(\\d+)\\s*\\/\\s*(\\d+)/.exec(document.querySelector('.rs-idx').textContent);return m?+m[2]:0})()`);
    const lastRe = () => new RegExp('^' + total + '\\s*/\\s*' + total + '$');
    ok(total >= 9 && total <= 15, '页数落在 9~15（实测 ' + total + ' 页）', total);
    for (let k = 0; k < 18; k++) {
      const cur = await js(IDX);
      if (lastRe().test(cur)) break;
      await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`);
      await sleep(150);
    }
    const atEnd = await js(IDX);
    ok(lastRe().test(atEnd), '已翻到最后一页（' + atEnd + '）', atEnd);
    const before = await js(ENDED);
    ok(before.ended === false, '最后页还在放，尚未结束', before);

    const got = await waitFor(`document.getElementById('reportStage').classList.contains('ended')`, 16000);
    ok(got > 0, '最后一页走完会进入「已结束」态（等了 ' + got + 'ms）', got);
    await sleep(900);   // 提示条 0.55s 淡入
    const e1 = await js(ENDED);
    ok(e1.ended === true, 'stage 挂上 .ended', e1);
    ok(e1.doneOpacity > .9, '结束提示条浮出来了（opacity=' + e1.doneOpacity + '）', e1);
    ok(/放映结束/.test(e1.doneText), '提示文案里有「放映结束」（' + e1.doneText + '）', e1);
    ok(e1.play === '↻', '播放键变成重播 ↻（' + e1.play + '）', e1);
    const stillOpen = await js(`document.getElementById('reportStage').classList.contains('on')`);
    ok(stillOpen === true, '不再自动关掉放映（人还在看结尾页）', stillOpen);
    // 结束态下控制条必须亮着：提示条写着「点 ↻」，按钮不能藏起来
    const ec = await js(CTRL);
    ok(ec.idle === true, '此时鼠标早已静止（控制条本来是隐身态）', ec);
    ok(ec.opacity > .9, '结束态下控制条被强制点亮（opacity=' + ec.opacity + '）', ec);
    ok(ec.pe !== 'none', '结束态下控制条可点击', ec);
    const gap = await js(`(function(){
      var d = document.querySelector('.rs-done'), c = document.querySelector('.rs-ctrl');
      if (!d || !c) return { gap: -1 };
      var rd = d.getBoundingClientRect(), rc = c.getBoundingClientRect();
      return { gap: Math.round(rc.top - rd.bottom) };
    })()`);
    ok(gap.gap >= 6, '提示条与控制条不贴在一起（间距 ' + gap.gap + 'px）', gap);
    await shot('收尾-04-结束提示');

    // ---------- 结尾页：分析 + 寄语 + 落款 ----------
    console.log('\n【结尾页的鼓励与祝福】');
    const endPage = await js(`(function(){
      var p = document.querySelector('.rs-slide.k-end');
      if (!p) return { err: 'no end slide' };
      var b = p.querySelector('#rsBless'), s = p.querySelector('.rs-sign'), seal = p.querySelector('.end-seal');
      return { has: true,
        bless: b ? b.textContent.trim() : '',
        blessSize: b ? parseFloat(getComputedStyle(b).fontSize).toFixed(0) : '0',
        sign: s ? s.textContent.trim() : '',
        seal: !!seal };
    })()`);
    ok(endPage.has === true, '最后一页是结尾版式（k-end）', endPage);
    ok((endPage.bless || '').length >= 30, '结尾页有一段寄语（' + (endPage.bless || '').length + ' 字）', endPage.bless);
    ok(/愿|记得|别|慢慢|谢谢|记着/.test(endPage.bless || ''), '寄语里有鼓励/祝福的语气', endPage.bless);
    ok(parseFloat(endPage.blessSize) >= 17, '寄语字号够大、是这一页主角（' + endPage.blessSize + 'px）', endPage.blessSize);
    ok(!!endPage.sign, '有落款（' + endPage.sign + '）', endPage.sign);
    ok(endPage.seal === true, '印章还在', endPage.seal);
    // 内容不能溢出：这一页东西最多，寄语一长就会把印章和落款顶出屏幕、撞上控制条
    const fit = await js(`(function(){
      var p = document.querySelector('.rs-slide.k-end');
      var s = p && p.querySelector('.rs-sign'), b = p && p.querySelector('#rsBless'), c = document.querySelector('.rs-ctrl');
      if (!s || !b || !c) return { ok: false };
      var rb = b.getBoundingClientRect(), rs = s.getBoundingClientRect(), rc = c.getBoundingClientRect();
      return { ok: true, blessW: Math.round(rb.width), blessH: Math.round(rb.height),
               signBottom: Math.round(rs.bottom), ctrlTop: Math.round(rc.top), vh: window.innerHeight, vw: window.innerWidth };
    })()`);
    ok(fit.ok && fit.signBottom < fit.ctrlTop - 6,
      '结尾页内容没撞上控制条（落款底 ' + fit.signBottom + 'px / 控制条顶 ' + fit.ctrlTop + 'px）', fit);
    ok(fit.blessW < fit.vw * .55, '寄语没有被拉成超长横幅（宽 ' + fit.blessW + 'px / 屏宽 ' + fit.vw + 'px）', fit);
    ok(fit.blessH < fit.vh * .4, '寄语高度不失控（' + fit.blessH + 'px / 屏高 ' + fit.vh + 'px）', fit);
    // 落款还得避开「放映结束」那条提示，不然演完的一瞬间两者会压在一起
    const hint = await js(`(function(){
      var s = document.querySelector('.rs-slide.k-end .rs-sign'), d = document.querySelector('.rs-done');
      if (!s || !d) return { gap: -1 };
      return { gap: Math.round(d.getBoundingClientRect().top - s.getBoundingClientRect().bottom) };
    })()`);
    ok(hint.gap >= 10, '落款与「放映结束」提示留了间距（' + hint.gap + 'px）', hint);
    await shot('收尾-04b-结尾寄语');

    // ---------- 重播 ----------
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);
    await sleep(1000);
    const e2 = await js(ENDED);
    const idx2 = await js(IDX);
    ok(e2.ended === false, '点 ↻ 后退出结束态', e2);
    ok(e2.doneOpacity < .1, '提示条收回', e2);
    ok(/^1\s*\/\s*\d+$/.test(idx2), '重播从头开始（' + idx2 + '）', idx2);
    ok(e2.play === '❚❚', '播放键回到播放中 ❚❚（' + e2.play + '）', e2);
    await shot('收尾-05-重播');

    // Escape 退出
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(900);
    const gone = await js(`document.getElementById('reportStage').classList.contains('on')`);
    ok(gone === false, 'Esc 仍能正常退出放映', gone);

    console.log('\n图在 ' + OUT);
  } catch (e) {
    fail++;
    console.log('❌ ' + (e && e.stack || e));
  }
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  app.quit();
});
