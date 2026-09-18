/**
 * 界面视觉验收：右键换头像、热词榜 AI 入口、年度报告成品页。
 * 对着隔离实例跑，不动用户正在用的窗口。
 * 用法：SHOT_URL=http://127.0.0.1:4399 env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 验收界面.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '截图', '验收');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '　' + JSON.stringify(extra) : '')); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 960, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await win.capturePage()).toPNG());
  const click = (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  // 读「这一次点击」产生的提示条。
  // 直接 sleep 一阵再 querySelector 是不行的：提示条活 3-4 秒且会叠着，
  // 读到上一节残留的那条就会**假通过**（本脚本真栽过一次 —— 待办那节读到的其实是
  // 狗头军师的提示）。所以：先等旧提示条散尽 → 再点 → 等新提示条出现。
  const clickAndReadToast = async (sel) => {
    for (let i = 0; i < 40; i++) {
      if (!(await js(`!!document.querySelector('#toast-box .toast')`))) break;
      await sleep(150);
    }
    const clicked = await js(`(function(){var b=document.querySelector('${sel}');
      if(!b) return 'no-btn'; if(b.disabled) return 'disabled'; b.click(); return 'ok';})()`);
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const t = await js(`(function(){var t=document.querySelector('#toast-box .toast');return t?t.textContent.trim():''})()`);
      if (t) return { clicked, toast: t };
    }
    return { clicked, toast: '' };
  };

  try {
    await win.loadURL(process.env.SHOT_URL || 'http://127.0.0.1:4399');
    win.showInactive();
    await sleep(3200);

    // 首次运行会弹「使用声明」，它盖在所有东西上面（localStorage 记同意状态，
    // 测试用的是全新配置所以每次都弹）。不点掉它后面所有点击都会被它吃掉。
    const agreed = await js(`(function(){
      var ov=document.querySelector('.ta-login-ov'); if(!ov) return 'no-overlay';
      var b=ov.querySelector('#ta-login-ok') || ov.querySelector('button');
      if(!b) return 'no-button';
      b.click(); return 'clicked:' + b.textContent.trim();
    })()`);
    console.log('首次浮层处理：' + agreed);
    await sleep(900);

    console.log('【联系人列表 · 头像】');
    const av = await js(`(function(){
      var els=[...document.querySelectorAll('.person .ava')];
      return { n: els.length, shown: els.filter(e=>{var f=e.querySelector('.avfallback');return f&&getComputedStyle(f).display!=='none'}).length,
               txt: els.map(e=>{var f=e.querySelector('.avfallback');return f?f.textContent:''}) };
    })()`);
    ok(av.n > 0 && av.shown === av.n, '所有联系人头像都显示了回退字样（' + av.txt.join('/') + '）', av);
    ok(!av.txt.includes('?'), '没有出现问号占位（说明取到了昵称首字）', av.txt);
    await shot('01-联系人列表');

    console.log('\n【右键菜单 · 自定义头像】');
    // 用派发 contextmenu 事件来驱动 —— Electron 的 sendInputEvent 发右键不会生成 DOM 的 contextmenu 事件。
    // 派发的就是页面里那个 addEventListener('contextmenu') 处理器，走的路径和真右键完全一致。
    const pos = await js(`(function(){var e=document.querySelector('.person[data-id="p-d"] .ava');if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    ok(!!pos, '取到联系人头像位置', pos);
    await js(`(function(){
      var el=document.querySelector('.person[data-id="p-d"] .ava');
      el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${pos.x},clientY:${pos.y}}));
    })()`);
    await sleep(600);
    const menu = await js(`(function(){var m=document.getElementById('ava-menu');if(!m)return null;var r=m.getBoundingClientRect();
      return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top),
              emoji:m.querySelectorAll('.am-g b').length, items:[...m.querySelectorAll('.am-i')].map(i=>i.textContent.trim()),
              inView:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`);
    ok(!!menu, '右键弹出了菜单', menu);
    if (menu) {
      ok(menu.emoji >= 16, '菜单里有表情网格（' + menu.emoji + ' 个）');
      ok(menu.items.length === 3, '有上传图片 / 用文字 / 恢复默认三个入口', menu.items);
      ok(menu.inView, '菜单完整落在窗口内', menu);
    }
    await shot('02-右键菜单');

    // 点第一个表情。
    // 拆两步验：elementFromPoint 证明「这个坐标真能命中表情」（真鼠标点得着），
    // 再 .click() 走完 处理器 → 接口 → 重绘 的全链路。
    const em = await js(`(function(){
      var b=document.querySelector('#ava-menu .am-g b'); if(!b) return null;
      var r=b.getBoundingClientRect();
      var x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
      var hit=document.elementFromPoint(x,y);
      return { x:x, y:y, t:b.textContent, hitIsEmoji: hit===b || b.contains(hit), hitTag: hit?hit.tagName+'.'+hit.className:'' };
    })()`);
    ok(!!em, '取到第一个表情按钮', em);
    ok(em && em.hitIsEmoji, '该坐标确实命中表情（真鼠标点得着）', em);
    await js(`document.querySelector('#ava-menu .am-g b').click()`);
    await sleep(1500);
    const after = await js(`(function(){var f=document.querySelector('.person[data-id="p-d"] .avfallback');return f?f.textContent:''})()`);
    ok(after === em.t, '点头像后列表里的头像真的换了（' + em.t + '）', { got: after, want: em.t });
    ok(await js(`!document.getElementById('ava-menu')`), '点完菜单自动收起');
    const persisted = await js(`fetch('/api/persons').then(r=>r.json()).then(l=>l.find(x=>x.id==='p-d').avatar)`);
    ok(persisted === em.t, '头像已经写回服务端（刷新也不会丢）', { got: persisted, want: em.t });
    await shot('03-换完头像');

    // ---------- 照片头像 ----------
    // 重点验两件事：① 大图会被前端裁方 + 缩到 512（不然手机照片一定撞 4MB 上限）
    // ② 拖入 / 粘贴 两条非文件框入口也能落到同一个保存链路
    console.log('\n【头像照片 · 拖入 / 粘贴】');
    const dropped = await js(`(function(){
      var c=document.createElement('canvas'); c.width=1600; c.height=900;
      var g=c.getContext('2d');
      g.fillStyle='#c33'; g.fillRect(0,0,1600,900);
      g.fillStyle='#3c6'; g.fillRect(0,450,1600,450);
      return new Promise(function(res){
        c.toBlob(function(b){
          var dt=new DataTransfer();
          dt.items.add(new File([b],'试.png',{type:'image/png'}));
          var row=document.querySelector('.person[data-id="p-d"]');
          row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
          var hl=row.classList.contains('drop-ava');
          row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
          res({ hl:hl, bytes:b.size });
        },'image/png');
      });
    })()`);
    ok(dropped && dropped.hl === true, '拖到联系人上会高亮落点（drop-ava）', dropped);
    await sleep(2200);
    const photo = await js(`(function(){
      if(!document.querySelector('.person[data-id="p-d"] .avimg')) return { img:false };
      return fetch('/api/avatar/p-d').then(r=>r.blob()).then(function(b){
        var n=new Image();
        return new Promise(function(res){
          n.onload=function(){ res({ img:true, type:b.type, size:b.size, w:n.naturalWidth, h:n.naturalHeight }); };
          n.onerror=function(){ res({ img:true, err:'decode fail' }); };
          n.src=URL.createObjectURL(b);
        });
      });
    })()`);
    ok(photo && photo.img, '拖入图片后列表里换成了照片头像', photo);
    ok(photo && photo.w === 512 && photo.h === 512, '落盘的是裁好的正方形 512×512（实测 ' + photo.w + '×' + photo.h + '）', photo);
    ok(photo && photo.size < 400 * 1024, '体积压到 400KB 以内（' + Math.round((photo.size || 0) / 1024) + 'KB，原图 ' + Math.round(dropped.bytes / 1024) + 'KB）', photo);
    await shot('04-照片头像');

    // 粘贴：先右键开菜单记下目标，再派发 paste
    await js(`(function(){
      var a=document.querySelector('.person[data-id="p-mom"] .ava');var r=a.getBoundingClientRect();
      a.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+10,clientY:r.top+10}));
    })()`);
    await sleep(500);
    const pasted = await js(`(function(){
      var c=document.createElement('canvas'); c.width=300; c.height=300;
      var g=c.getContext('2d'); g.fillStyle='#36c'; g.fillRect(0,0,300,300);
      return new Promise(function(res){
        c.toBlob(function(b){
          var dt=new DataTransfer();
          dt.items.add(new File([b],'贴.png',{type:'image/png'}));
          var okEv=false;
          try { document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt})); okEv=true; } catch(e) {}
          res(okEv);
        },'image/png');
      });
    })()`);
    ok(pasted === true, '能在页面里派发带图片的 paste 事件', pasted);
    await sleep(2200);
    const mom = await js(`fetch('/api/persons').then(r=>r.json()).then(function(l){
      var p=l.find(x=>x.id==='p-mom');
      return { img: !!(p && p.avatarImg), inList: !!document.querySelector('.person[data-id="p-mom"] .avimg') };
    })`);
    ok(mom.img && mom.inList, 'Ctrl+V 粘贴的图片设到了右键选中的那个联系人', mom);
    await shot('05-粘贴头像');

    // 恢复默认
    await js(`(function(){
      var a=document.querySelector('.person[data-id="p-d"] .ava');var r=a.getBoundingClientRect();
      a.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+10,clientY:r.top+10}));
    })()`);
    await sleep(500);
    const rst = await js(`(function(){var m=document.getElementById('ava-menu');if(!m)return null;var i=[...m.querySelectorAll('.am-i')].find(x=>x.dataset.a==='reset');if(!i)return null;var r=i.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    if (rst) {
      click(rst.x, rst.y);
      await sleep(1200);
      const back = await js(`(function(){var f=document.querySelector('.person[data-id="p-d"] .avfallback');return f?f.textContent:''})()`);
      ok(back === '她', '恢复默认后回到昵称首字（' + back + '）', back);
    } else { ok(false, '没找到「恢复默认」入口'); }

    console.log('\n【热词榜 · AI 入口】');
    await js(`(function(){var e=document.querySelector('.person[data-id="p-d"]');if(e)e.click();})()`);
    await sleep(4000);
    const wc = await js(`(function(){
      var card=[...document.querySelectorAll('.card')].find(c=>c.querySelector('#wcAi'));
      if(!card)return null;
      var r=card.getBoundingClientRect(); var m=document.getElementById('main');
      if(m) m.scrollTop = m.scrollTop + r.top - 120; else window.scrollTo(0, r.top+window.scrollY-120);
      return { btn:!!document.getElementById('wcAi'), label:(document.getElementById('wcAi')||{}).textContent };
    })()`);
    ok(!!wc, '热词卡里有 AI 归纳按钮', wc);
    await sleep(1200);
    await shot('04-热词榜AI入口');

    // 点一下：AI 未就绪应给出提示而不是崩
    const wcToast = await clickAndReadToast('#wcAi');
    ok(/AI|模型|启用/.test(String(wcToast.toast)), 'AI 未就绪时点了会给出可读提示：' + wcToast.toast, wcToast);
    await shot('05-AI未就绪提示');

    // ---------- 关系指数：分数构成 ----------
    // 三指数由多路信号合成，「分数怎么算的」必须真能摊开给人看：
    // 每一项是个什么信号、实际值多少、贡献了几分，而且要能对上总分。
    console.log('\n【关系指数 · 分数构成】');
    const gg = await js(`(function(){
      var card=[...document.querySelectorAll('.card')].find(function(c){return c.querySelector('.gauges')});
      if(!card) return {err:'找不到关系指数卡'};
      var det=card.querySelector('.note-f'); if(det) det.open=true;
      var gauges=[...card.querySelectorAll('.g')].map(function(g){
        return { lbl:((g.querySelector('.lbl')||{}).textContent||'').trim(),
                 val:parseInt(((g.querySelector('.big')||{}).textContent||'0'),10) };
      });
      var parts=[...card.querySelectorAll('.g-parts .gp')].map(function(p){
        var b=p.querySelector('b'), i=p.querySelector('i');
        return { label:p.childNodes[0]?p.childNodes[0].textContent.trim():'',
                 text:b?b.textContent.trim():'',
                 delta:i?parseInt(i.textContent.replace('+',''),10):NaN };
      });
      var sym=card.querySelector('.g-sym');
      var m=document.getElementById('main'), r=card.getBoundingClientRect();
      if(m) m.scrollTop=m.scrollTop+r.top-120; else window.scrollTo(0, r.top+window.scrollY-120);
      return { summary:det?(det.querySelector('summary')||{}).textContent:'', gauges:gauges, parts:parts,
               sym:sym?sym.textContent.trim():'' };
    })()`);
    ok(!gg.err, '找得到关系指数卡', gg.err);
    ok(gg.gauges && gg.gauges.length === 3, '三个指数都在（' + (gg.gauges || []).map(g => g.lbl + g.val).join(' / ') + '）', gg.gauges);
    ok(gg.gauges && gg.gauges.every(g => g.val >= 0 && g.val <= 100), '每个指数都在 0-100 内');
    ok(/分数怎么算的/.test(gg.summary || ''), '折叠入口写着「分数怎么算的」：' + gg.summary, gg.summary);
    ok(gg.parts && gg.parts.length === 14, '展开后摊出全部 14 个分项（主动 5 + 被爱 6 + 冷淡 3，实测 ' + (gg.parts || []).length + '）', (gg.parts || []).length);
    ok(gg.parts && gg.parts.every(p => p.label && !Number.isNaN(p.delta)), '每个分项都带「信号名 + 贡献分」');
    ok(gg.parts && gg.parts.every(p => p.text && p.text.length), '每个分项都带真实数值（不是只写个标签）', (gg.parts || []).slice(0, 3).map(p => p.label + '=' + p.text));
    // 分项之和要能还原总分 —— 这条挂了说明「构成」是装饰，分数还是黑盒
    const base = { '主动指数': 50, '被爱指数': 40, '冷淡指数': 0 };
    const sumBy = {};
    // 在页面上按顺序切：前 5 项属主动、再 6 项属被爱、最后 3 项属冷淡（与 score.js 一致）
    const SPLIT = [['主动指数', 0, 5], ['被爱指数', 5, 11], ['冷淡指数', 11, 14]];
    for (const [lbl, a, b] of SPLIT) sumBy[lbl] = gg.parts.slice(a, b).reduce((s, p) => s + p.delta, 0) + base[lbl];
    for (const g of gg.gauges) {
      const calc = sumBy[g.lbl];
      ok(calc !== undefined && Math.abs(Math.round(calc) - g.val) <= 1,
        `${g.lbl}：分项之和能还原总分（${Math.round(calc)} vs ${g.val}）`);
    }
    ok(/对称性\s*\d+\s*分/.test(gg.sym || ''), '有对称性一行：' + gg.sym, gg.sym);
    // 数字字体：Georgia 的老式数字是歪的，这里必须落在 Cambria 上
    const figFont = await js(`(function(){var b=document.querySelector('.g .big');if(!b)return null;
      var cs=getComputedStyle(b);return {fam:cs.fontFamily,num:cs.fontVariantNumeric,feat:cs.fontFeatureSettings}})()`);
    ok(figFont && !/Georgia|Constantia/.test(figFont.fam), '指数数字不再用 Georgia/Constantia：' + figFont.fam, figFont);
    ok(figFont && /lining-nums/.test(figFont.num + ' ' + figFont.feat), '指数数字声明了等高数字（lining-nums）', figFont);
    await shot('06-关系指数分数构成');

    // ---------- 狗头军师：真 AI 入口 ----------
    console.log('\n【狗头军师 · AI 入口】');
    const adv = await js(`(function(){
      var head = document.querySelector('.roast-advice .ra-head');
      var btn = document.getElementById('adviceAiBtn');
      var body = document.getElementById('adviceBody');
      if (!btn || !body) return { err: 'no advice ai' };
      var card = btn.closest('.roast'), m = document.getElementById('main');
      var r = (head || btn).getBoundingClientRect();
      if (m) m.scrollTop = m.scrollTop + r.top - 140; else window.scrollTo(0, r.top + window.scrollY - 140);
      return { label: btn.textContent.trim(), bodyLen: body.textContent.trim().length,
               title: (function(){var t=document.querySelector('.roast-advice .ra-tt');return t?t.textContent.trim():''})(),
               sameRow: !!head };
    })()`);
    ok(!adv.err, '狗头军师那块有「AI 建议」按钮', adv);
    ok(adv.bodyLen >= 20, '模板建议还在（' + adv.bodyLen + ' 字），AI 失败时不会空着', adv);
    ok(/相处建议|军师/.test(adv.title || ''), '标题仍是狗头军师（' + adv.title + '）', adv.title);
    await sleep(900);
    await shot('07-狗头军师AI入口');

    const advToast = await clickAndReadToast('#adviceAiBtn');
    ok(/AI|模型|启用/.test(String(advToast.toast)), 'AI 未就绪时点「AI 建议」给出可读提示：' + advToast.toast, advToast);
    const advBack = await js(`(function(){var b=document.getElementById('adviceBody');return b?b.textContent.trim().length:0})()`);
    ok(advBack >= 20, '点完不会把模板建议弄丢（还能读 ' + advBack + ' 字）', advBack);

    // ---------- 待办：AI 锐评入口 ----------
    console.log('\n【To Do · AI 锐评入口】');
    // 待办存在 localStorage（不是服务端），隔离实例里默认空的；
    // 而空清单时「AI 锐评」按钮是 disabled（没东西可评，这是有意的）。
    // 用**界面自己的入口**加一条 —— 走用户真会走的那条路，而不是往 localStorage 里硬塞。
    const added = await js(`(function(){
      var b=document.querySelector('.tl-addtodo');
      if(!b) return { err:'时间线上没有「＋」按钮' };
      var t=(b.dataset.todo||'').slice(0,24); b.click(); return { text:t };
    })()`);
    ok(!added.err, '从时间线「＋」加一条待办：' + (added.text || ''), added);
    await sleep(1400);
    const todo = await js(`(function(){
      var el = document.getElementById('todoRoast'), b = document.getElementById('todoAiBtn');
      if (!b) return { err: 'no todo ai btn', html: el ? el.className : '' };
      return { label: b.textContent.trim(), head: !!el.querySelector('.tr-head'),
               body: (el.querySelector('.tr-body')||{}).textContent || '',
               advice: (el.querySelector('.tr-advice')||{}).textContent || '', disabled: b.disabled };
    })()`);
    ok(!todo.err, '待办锐评上有「AI 锐评」按钮', todo);
    ok(todo.head === true, '标题和按钮排在一行（.tr-head）', todo);
    ok(String(todo.body).length >= 10, '模板锐评仍在（' + String(todo.body).slice(0, 18) + '…）', todo);
    ok(todo.disabled === false, '有待办时按钮是可点的（空清单才 disabled）', todo);
    await shot('08-待办AI入口');

    const todoToast = await clickAndReadToast('#todoAiBtn');
    ok(/AI|模型|启用/.test(String(todoToast.toast)), 'AI 未就绪时点「AI 锐评」给出可读提示：' + todoToast.toast, todoToast);
    const todoStill = await js(`(function(){var b=document.querySelector('#todoRoast .tr-body');return b?b.textContent.trim().length:0})()`);
    ok(todoStill >= 10, '点完模板锐评还在，没有被清空（' + todoStill + ' 字）', todoStill);

    console.log('\n【年度报告】');
    await js(`(function(){var m=document.getElementById('main');if(m)m.scrollTop=0;})()`);
    await sleep(600);
    await js(`(function(){var e=document.querySelector('#reportEntry');if(e)e.click();})()`);
    await sleep(2400);
    await shot('06-报告-封面');
    await js(`(function(){var e=document.querySelector('#rsPlay');if(e)e.click();})()`);  // 暂停
    await sleep(400);
    const total = await js(`(function(){var m=/(\\d+)\\s*\\/\\s*(\\d+)/.exec(document.querySelector('.rs-idx').textContent);return m?+m[2]:0})()`);
    ok(total >= 9 && total <= 15, '报告页数按记录厚度动态决定（' + total + ' 页，上限 15）', total);
    const kinds = [];
    for (let i = 0; i < total; i++) {
      if (i > 0) { await js(`(function(){var e=document.querySelector('#rsNext');if(e)e.click();})()`); await sleep(2300); }
      const k = await js(`(function(){var s=document.querySelector('.rs-slide:not(.leaving)');return s?s.className.replace('rs-slide ','').trim():''})()`);
      kinds.push(k);
      if (i < 12) await shot('报告-' + String(i + 1).padStart(2, '0'));
    }
    console.log('     版式序列：' + kinds.join(' → '));
    ok(new Set(kinds).size >= 5, '用了至少 5 种不同版式（' + new Set(kinds).size + ' 种）', kinds);
    ok(kinds.filter(k => k === 'k-num').length < kinds.length, '不是所有页都长一个样');
    ok(kinds[kinds.length - 1] === 'k-end', '最后一页是结尾页', kinds[kinds.length - 1]);
    const endHas = await js(`(function(){var p=document.querySelector('.rs-slide.k-end');return p?{bless:(p.querySelector('#rsBless')||{}).textContent,sign:(p.querySelector('.rs-sign')||{}).textContent}:null})()`);
    ok(endHas && String(endHas.bless || '').length >= 30, '结尾页有鼓励与祝福（' + String(endHas && endHas.bless).length + ' 字）', endHas);
    await shot('09-报告-结尾寄语');

    console.log('\n图在 ' + OUT);
  } catch (e) {
    fail++;
    console.log('❌ ' + (e && e.stack || e));
  }
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  app.quit();
});
