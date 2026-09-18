/**
 * 音效 / 背景音乐验收。
 *
 * 声音本身听不到，但「有没有真的发出声音、发的是什么音」是**可以量**的：
 * 劫持 AudioContext.prototype.createOscillator 和 OscillatorNode.prototype.start，
 * 把所有振荡器的「频率 + 预定发声时刻」记下来，再回头做音乐分析。
 *
 * 这样能逮到的真问题：
 *   - 点击根本没接上音效（振荡器计数不涨）
 *   - 静音开关是摆设（关了还在造振荡器）
 *   - 和弦表写错音（把 Fmaj7 写成 F A C F 这种）—— 用音级集合比对
 *   - 音乐停不掉（stop 之后计数还在涨）
 *
 * 用法：SHOT_URL=http://127.0.0.1:4399 env -u ELECTRON_RUN_AS_NODE electron.exe --no-sandbox 测音效.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '　' + JSON.stringify(extra) : '')); }
};

// 频率 → MIDI → 音级（0=C, 9=A …）。
// 合成时会乘一个极小的失谐系数（1+i*0.0007），所以取整前先四舍五入。
const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
const pcOf = (f) => Math.round(midiOf(f)) % 12;
const PC_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false, backgroundColor: '#0d2036',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const js = (c) => win.webContents.executeJavaScript(c, true);

  try {
    await win.loadURL(process.env.SHOT_URL || 'http://127.0.0.1:4399');
    win.showInactive();
    await sleep(2600);

    // 第一次运行会弹使用声明遮罩，点掉它，否则后面所有点击都被它吃掉
    await js(`(function(){var ov=document.querySelector('.ta-login-ov');
      if(!ov) return 'none'; var b=ov.querySelector('#ta-login-ok')||ov.querySelector('button');
      if(b) b.click(); return 'clicked';})()`);
    await sleep(800);

    console.log('【1 · 音频引擎就位】');
    const has = await js(`(function(){
      if(!window.SOUND) return {ok:false};
      var c = window.SOUND.cfg();
      return {ok:true, on:c.on, music:c.music,
        hasSfx: typeof window.SOUND.sfx==='function',
        hasStart: typeof window.SOUND.music.start==='function',
        hasStop: typeof window.SOUND.music.stop==='function'};
    })()`);
    ok(has.ok, 'sound.js 已加载并暴露 window.SOUND');
    ok(has.hasSfx && has.hasStart && has.hasStop, '音效 / 音乐接口齐全');
    ok(has.on === true, '音效默认开着');
    ok(has.music === true, '背景音乐默认开着');

    // 装探针
    const spy = await js(`(function(){
      var AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return 'no-audio-context';
      if(AC.__spied) return 'already';
      AC.__spied = true;
      window.__osc = [];
      var co = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function(){
        var o = co.call(this);
        try { window.__osc.push(o); } catch(e){}
        return o;
      };
      // 预定发声时刻 —— 靠它把振荡器归到「第几个小节」
      try {
        var st = window.OscillatorNode.prototype.start;
        window.OscillatorNode.prototype.start = function(when){ this.__when = when; return st.call(this, when); };
      } catch(e){}
      window.__zero = function(){ window.__osc = []; };
      // 取一份快照：频率 + 预定时刻（频率是创建后才赋值的，必须延后读）
      window.__dump = function(){
        return window.__osc.map(function(o){
          var f = 0; try { f = o.frequency.value; } catch(e){}
          return { f: f, when: (o.__when == null ? -1 : o.__when) };
        }).filter(function(x){ return x.f > 0; });
      };
      return 'ok';
    })()`);
    ok(spy === 'ok', '振荡器探针装好了', spy);

    console.log('\n【2 · 真实鼠标手势就能出声（自动播放策略没挡住）】');
    await js(`window.__zero(); 1`);
    const box = await js(`(function(){
      var b=document.querySelector('#settingsBtn'); if(!b) return null;
      var r=b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    ok(!!box, '拿到「设置」按钮的位置', box);
    // 关键：**不调 unlock()**，纯粹靠真实手势把音频上下文唤醒。
    // 只在 JS 里 b.click() 是造不出 pointerdown 的，那样测不出这条真实路径。
    if (box) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(500);
    const gestureNotes = await js(`window.__dump()`);
    ok(gestureNotes.length > 0,
      '真手势点按钮 → 直接出声（' + gestureNotes.length + ' 个振荡器），说明手势解锁这条路是通的',
      gestureNotes.length);

    console.log('\n【3 · 音效本身合不合理】');
    const sfxFreqs = gestureNotes.map(x => x.f);
    ok(sfxFreqs.every(f => f > 100 && f < 12000),
      '音效频率都在可听范围内（' + Math.round(Math.min(...sfxFreqs)) + '–' + Math.round(Math.max(...sfxFreqs)) + ' Hz）');

    // 同一个音效重复播两次，应该造出同样数量的振荡器（说明是确定性的，不是碰巧）
    await js(`window.__zero(); 1`);
    await js(`window.SOUND.unlock(); window.SOUND.sfx('ok'); 1`);
    await sleep(200);
    const a1 = (await js(`window.__dump()`)).length;
    await js(`window.__zero(); window.SOUND.sfx('ok'); 1`);
    await sleep(200);
    const a2 = (await js(`window.__dump()`)).length;
    ok(a1 > 0 && a1 === a2, '同一个音效每次发声一致（' + a1 + ' / ' + a2 + ' 个振荡器）', [a1, a2]);

    // err 应该比 ok 低沉 —— 用最低那个泛音的基频比
    const lowOf = async (name) => {
      await js(`window.__zero(); window.SOUND.sfx('${name}'); 1`);
      await sleep(200);
      const f = (await js(`window.__dump()`)).map(x => x.f);
      return f.length ? Math.min(...f) : 0;
    };
    const fOk = await lowOf('ok'), fErr = await lowOf('err');
    ok(fErr > 0 && fOk > 0 && fErr < fOk,
      '错误音比成功音低沉（' + Math.round(fErr) + ' Hz < ' + Math.round(fOk) + ' Hz）', [fErr, fOk]);

    // ---- 3b · 泛音必须是整数倍 --------------------------------------------
    // 「音色好奇怪」的根因就是这里：之前写过 2.01 / 3.01 / 2.98 / 5.4 这些
    // **非整数倍**泛音，那是不谐音（inharmonic），听感是金属味 / 锣味。
    //
    // 怎么精确判：note() 给每个泛音加了 i*0.0007 的渐进失谐（i 是泛音下标），
    // 所以第 i 个泛音的频率 = 基频 × 部分数 × (1 + i×0.0007)。
    // 反推：sorted[i] / (sorted[0] × (1 + i×0.0007)) 必须落在整数上。
    // 这个式子对旧代码和新代码都验算过：旧代码的 2.01/2.98/5.4 全被抓出，
    // 新代码的整数倍全部为 0 误差。所以 0.1% 的容差是够严的。
    const PRESET_NAMES = ['tap', 'nav', 'open', 'close', 'ok', 'err', 'page', 'start', 'end', 'wake'];
    const bad = [];
    let noteGroups = 0;
    for (const nm of PRESET_NAMES) {
      await js(`window.__zero(); window.SOUND.sfx('${nm}'); 1`);
      await sleep(140);
      const ns = await js(`window.__dump()`);
      // 同一个起始时刻的振荡器 = 同一个「音」（note() 里所有泛音共用 t0）
      const groups = {};
      ns.forEach((x) => {
        const k = Math.round((x.when || 0) * 1000);
        (groups[k] = groups[k] || []).push(x.f);
      });
      Object.keys(groups).forEach((k) => {
        const fs2 = groups[k].slice().sort((a, b) => a - b);
        if (fs2.length < 2) return;
        noteGroups++;
        for (let i = 1; i < fs2.length; i++) {
          const r = fs2[i] / (fs2[0] * (1 + i * 0.0007));
          const near = Math.round(r);
          if (near < 2) continue;
          const err = Math.abs(r - near) / near;
          if (err > 0.001) bad.push({ preset: nm, ratio: Number(r.toFixed(4)), nearest: near, err: Number(err.toFixed(4)) });
        }
      });
    }
    ok(noteGroups >= 8, '取到了 ' + noteGroups + ' 个多泛音的音（够做泛音分析）', noteGroups);
    ok(bad.length === 0,
      '所有泛音都是整数倍（非整数倍 = 不谐音 = 金属怪声，' + noteGroups + ' 个音全部合规）',
      bad.slice(0, 6));

    // ---- 3c · 电平不许再退回去 --------------------------------------------
    // 这条是**防回退**，不是听感判断：单次音效的电平曾经被压到 0.05~0.12，
    // 用户第一反应就是「声音太小」。没有哪个自动化测试能替你"听"，
    // 但可以钉住下限，避免下次重构又悄悄调小。
    //
    // 注意判的是**每个音效的主声部**（该音效里最大的那个 gain），不是所有 gain ——
    // page 底下的轻触音、start 底下的气声噪声本来就该很小，它们是装饰层不是主音。
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sound.js'), 'utf8');
    const presetBlock = src.slice(src.indexOf('const PRESETS'), src.indexOf('function play('));
    const gainOf = {};
    for (const nm of PRESET_NAMES) {
      const at = presetBlock.indexOf('\n    ' + nm + '() {');
      if (at < 0) { gainOf[nm] = null; continue; }
      const later = PRESET_NAMES
        .map((o) => presetBlock.indexOf('\n    ' + o + '() {', at + 6))
        .filter((i) => i > at);
      const seg = presetBlock.slice(at, later.length ? Math.min(...later) : presetBlock.length);
      const gs = (seg.match(/gain:\s*([0-9.]+)/g) || []).map((s) => Number(s.replace(/gain:\s*/, '')));
      gainOf[nm] = gs.length ? Math.max(...gs) : null;
    }
    const parsed = Object.keys(gainOf).filter((k) => gainOf[k] != null);
    const weakest = parsed.sort((a, b) => gainOf[a] - gainOf[b])[0];
    ok(parsed.length === PRESET_NAMES.length,
      '十个音效的电平都从源码里读到了（' + parsed.length + '/' + PRESET_NAMES.length + '）', parsed.length);
    ok(weakest && gainOf[weakest] >= 0.12,
      '每个音效的主声部都不低于 0.12（最小的是 ' + weakest + ' = ' + (weakest ? gainOf[weakest] : '?') + '，曾经低到 0.05）',
      gainOf);

    // 关掉设置面板
    await js(`(function(){var p=document.querySelector('#settingsPanel'); if(p){var x=p.querySelector('.sp-x'); if(x) x.click();} return 1;})()`);
    await sleep(300);

    console.log('\n【4 · 静音开关不是摆设】');
    await js(`window.SOUND.setOn(false); window.__zero(); 1`);
    await js(`(function(){var b=document.querySelector('#settingsBtn'); if(b) b.click(); return 1;})()`);
    await sleep(350);
    const muted = (await js(`window.__dump()`)).length;
    ok(muted === 0, '静音后点击不再产生任何振荡器', muted);
    await js(`window.SOUND.setOn(true); 1`);
    await sleep(200);
    await js(`(function(){var p=document.querySelector('#settingsPanel'); if(p){var x=p.querySelector('.sp-x'); if(x) x.click();} return 1;})()`);
    await sleep(250);

    console.log('\n【5 · 背景音乐：和弦进行对不对】');
    // 和弦表（要和 sound.js 里的 PROG 一致）
    const EXPECT = [
      { name: 'Am7',   pcs: [9, 0, 4, 7] },   // A C E G
      { name: 'Fmaj7', pcs: [5, 9, 0, 4] },   // F A C E
      { name: 'Cmaj7', pcs: [7, 11, 4] },     // G B E（低音给 C）
      { name: 'G',     pcs: [7, 11, 2] },     // G B D
    ];
    const CHORD_DUR = (60 / 52) * 8;          // ≈9.23s

    await js(`window.__zero(); window.SOUND.unlock(); window.SOUND.music.start(); 1`);
    ok(await js(`window.SOUND.music.playing()`), '音乐已进入播放态');

    // 测量期间把界面音效换成**记录器**（不是空函数）——应用自己弹的提示音
    // 会被同一个探针收进来，混进和弦分析里（第一版就是这么误报了两个音）。
    // 记录而不是丢弃，是因为顺便能看出应用在测量期间是不是偷偷报错了。
    await js(`window.__sfxlog = []; window.__realsfx = window.SOUND.sfx;
      window.SOUND.sfx = function(n){ try { window.__sfxlog.push(n); } catch(e){} }; 1`);

    // 等两个小节，够验和弦 0 和和弦 1
    await sleep(10500);
    const notes = await js(`window.__dump()`);
    const sfxLog = await js(`window.__sfxlog`);
    await js(`window.SOUND.sfx = window.__realsfx; 1`);
    ok(notes.length > 40, '两个小节内排了 ' + notes.length + ' 个振荡器（铺底+琶音+低音）', notes.length);
    if (sfxLog.length) console.log('    （测量期间界面自己响过：' + sfxLog.join('、') + '）');

    // 按「预定发声时刻」归到小节。
    // 基准必须取**实际最早的那个时刻**，不能拿常数 0.12 去套 ——
    // AudioContext 是在用户手势时才建的，currentTime 早就不是 0 了
    //（第一版就是这么错位的，把相邻两个和弦混进同一个桶里）
    const whens = notes.map(x => x.when).filter(w => w >= 0).sort((a, b) => a - b);
    const base = whens[0];
    const byChord = {};
    for (const x of notes) {
      if (x.when < 0) continue;
      const idx = Math.floor((x.when - base + 0.05) / CHORD_DUR);
      (byChord[idx] = byChord[idx] || []).push(x.f);
    }
    console.log('    小节分布：' + Object.keys(byChord).sort().map(k => '#' + k + '×' + byChord[k].length).join('  '));

    for (const k of Object.keys(byChord).map(Number).sort((a, b) => a - b).slice(0, 2)) {
      const exp = EXPECT[((k % 4) + 4) % 4];
      const got = [...new Set(byChord[k].map(pcOf))].sort((a, b) => a - b);
      const want = [...new Set(exp.pcs)].sort((a, b) => a - b);

      // 注意：探针收的是**每一个振荡器**，而一个钢琴音本身是「基频 + 泛音」叠出来的。
      // 泛音按 2/3/4/6/8 倍生成 → 音级只可能偏移 0 或 +7 个半音
      // （3 倍是 +19.02 半音，19 mod 12 = 7）。所以「允许出现的音级」是
      // 和弦音 ∪ 和弦音+7 —— 不是只有和弦音本身。第一版没算这一层，把泛音
      // 当成跑调的音，误报了两处。
      const allowed = new Set();
      want.forEach(p => { allowed.add(p); allowed.add((p + 7) % 12); });
      const extra = got.filter(p => !allowed.has(p));
      const missing = want.filter(p => got.indexOf(p) < 0);

      ok(extra.length === 0,
        '小节 #' + k + ' 没有和弦外的音（' + exp.name + '，含泛音允许集 '
          + [...allowed].sort((a, b) => a - b).map(p => PC_NAME[p]).join(' ') + '）'
          + (extra.length ? '，多出：' + extra.map(p => PC_NAME[p]).join(' ') : ''),
        got.map(p => PC_NAME[p]));
      ok(missing.length === 0,
        '小节 #' + k + ' 的 ' + exp.name + ' 和弦音一个不少（' + want.map(p => PC_NAME[p]).join(' ') + '）',
        missing.map(p => PC_NAME[p]));
    }

    // 反面验证：不许出现「测到的这几个和弦」允许集之外的音级。
    // 这条是真正有区分度的 —— 和弦表要是写错音，这里立刻就炸。
    const measuredAllowed = new Set();
    Object.keys(byChord).forEach((k) => {
      const exp = EXPECT[((Number(k) % 4) + 4) % 4];
      exp.pcs.forEach((p) => { measuredAllowed.add(p); measuredAllowed.add((p + 7) % 12); });
    });
    const allPcs = new Set(Object.keys(byChord).flatMap((k) => byChord[k].map(pcOf)));
    const stray = [...allPcs].filter((p) => !measuredAllowed.has(p));
    ok(stray.length === 0,
      '整段没有一个跑调的音（' + EXPECT.slice(0, 2).map((e) => e.name).join(' / ') + ' 之外一律不许出现）',
      stray.map((p) => PC_NAME[p]));

    console.log('\n【6 · 停得掉】');
    await js(`window.SOUND.music.stop(); 1`);
    await sleep(2200);          // 淡出 1.6s + 余量
    await js(`window.__zero(); 1`);
    await sleep(1600);
    const afterStop = (await js(`window.__dump()`)).length;
    ok(!(await js(`window.SOUND.music.playing()`)), '音乐已退出播放态');
    ok(afterStop === 0, '停止后不再排新音符', afterStop);

    console.log('\n【7 · 音乐单独开关】');
    await js(`window.SOUND.setMusic(false); window.__zero(); window.SOUND.music.start(); 1`);
    await sleep(600);
    ok((await js(`window.__dump()`)).length === 0, '关掉背景音乐后 start() 不出声');
    ok(!(await js(`window.SOUND.music.playing()`)), '也不会进入播放态');
    await js(`window.SOUND.setMusic(true); 1`);

    console.log('\n【8 · 设置面板里的开关接对了】');
    // 先把面板整个删掉再点开 —— 否则拿到的是**上一次渲染**的 DOM，
    // 勾选态是陈旧的，测试会"通过"得莫名其妙。
    const wired = await js(`(function(){
      var old=document.querySelector('#settingsPanel'); if(old) old.remove();
      var b=document.querySelector('#settingsBtn'); if(!b) return {err:'no-settings-btn'};
      b.click();
      var p=document.querySelector('#settingsPanel'); if(!p) return {err:'no-panel'};
      var a=p.querySelector('#spSfx'), m=p.querySelector('#spBgm'), t=p.querySelector('#spBgmTry'), v=p.querySelector('#spVol');
      return { sfx: !!a, bgm: !!m, tryBtn: !!t, vol: !!v,
               volVal: v ? Number(v.value) : null, cfgVol: window.SOUND.vol,
               volOn: v ? !v.disabled : null,
               sfxChecked: a ? a.checked : null, bgmChecked: m ? m.checked : null };
    })()`);
    ok(wired.sfx && wired.bgm, '设置里有「界面音效」和「背景音乐」两个开关', wired);
    ok(wired.tryBtn === true, '有「试听 8 秒」按钮');
    ok(wired.vol === true, '有「响度」滑杆', wired);
    // 不断言"等于 1"——localStorage 在多次测试之间是留存的，断言绝对数值会偶发假失败；
    // 真正要钉的是「滑杆显示 = 引擎当前响度」这个不变量。
    ok(wired.volVal === wired.cfgVol, '响度滑杆的初始值 = 引擎当前响度（' + wired.volVal + '）', wired);
    ok(wired.sfxChecked === true && wired.bgmChecked === true, '两个开关的初始态跟当前配置一致', wired);

    // 拖一下滑杆：配置要真的变，而且能持久化（刷新后还在）
    const volRes = await js(`(function(){
      var v=document.querySelector('#spVol'); if(!v) return {err:'no-slider'};
      v.value='1.6'; v.dispatchEvent(new Event('input',{bubbles:true}));
      var label=document.querySelector('#spVolV');
      var raw=null; try{ raw=JSON.parse(localStorage.getItem('ta_sound_cfg')||'{}'); }catch(e){}
      return { soundVol: window.SOUND.vol, label: label?label.textContent:null, stored: raw ? raw.vol : null };
    })()`);
    ok(volRes.soundVol === 1.6 && volRes.stored === 1.6 && volRes.label === '160%',
      '拖滑杆 → 引擎响度、显示、localStorage 三处一起变', volRes);
    await js(`(function(){var v=document.querySelector('#spVol'); if(v){v.value='1'; v.dispatchEvent(new Event('input',{bubbles:true}));} return 1;})()`);

    // 拨一下总开关，看 bgm 是否跟着禁用
    await js(`(function(){var a=document.querySelector('#spSfx'); a.checked=false;
      a.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
    await sleep(250);
    const afterOff = await js(`(function(){var m=document.querySelector('#spBgm');
      return {disabled: m.disabled, checked: m.checked, on: window.SOUND.cfg().on};})()`);
    ok(afterOff.on === false, '拨掉总开关后配置真的变成关');
    ok(afterOff.disabled === true && afterOff.checked === false, '总开关关掉时，音乐开关跟着禁用并取消勾选', afterOff);
    await js(`(function(){var a=document.querySelector('#spSfx'); a.checked=true;
      a.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
    await sleep(250);
    await js(`(function(){var p=document.querySelector('#settingsPanel'); if(p){var x=p.querySelector('.sp-x'); if(x) x.click();} return 1;})()`);
    await sleep(400);

    console.log('\n【9 · 报告里的音乐键】');
    // 进报告：先选一个联系人（报告入口在分析页上），再点报告入口
    await js(`(function(){var p=document.querySelector('#person-list .person'); if(p) p.click(); return 1;})()`);
    await sleep(2500);
    const entered = await js(`(function(){
      var e=document.querySelector('#reportEntry'); if(!e) return 'no-entry'; e.click(); return 'ok';
    })()`);
    await sleep(1600);
    ok(entered === 'ok', '能进到年度报告', entered);

    const hasMusic = await js(`!!document.querySelector('#reportStage #rsMusic')`);
    ok(hasMusic === true, '报告控制条上有背景音乐键');

    // 控制条平时是隐藏的（RS_IDLE = 2200ms 不动就收起来）。
    // 原来直接"晃两下鼠标 → 等 700ms → 断言亮着"，刚好卡在 2200ms 的边界上：
    // 从这里到断言之间的真实耗时（若干次 executeJavaScript 往返 + 1600 + 700）
    // 一超过 2200ms 就假失败过一次。
    // 改成先等它真的收起来（顺带验了"会藏"这个前提），再晃鼠标**立刻**复查 ——
    // 测的是"藏起来→晃一下亮回来"这个真行为，不是谁跑得快。
    await sleep(2600);
    // 顺带把状态打全：.rs-ctrl 的**基础**透明度就是 .34，只有 :hover 才到 1，
    // 所以"亮着"实际等于"hover 生效"。只见 0.34 说明既没 .idle 也没 hover。
    const probeBar = () => js(`(function(){
      var st=document.getElementById('reportStage');
      var b=document.querySelector('#reportStage #rsMusic');
      var c=b&&b.closest('.rs-ctrl');
      return { cls: st?st.className:null, hover: st?st.matches(':hover'):null,
               op: c?Number(getComputedStyle(c).opacity):null };
    })()`);
    const barHidden = await probeBar();
    ok(barHidden.op != null && barHidden.op < 0.5,
      '人不动之后控制条收下去（opacity ' + barHidden.op + '）', barHidden);

    win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 });
    await sleep(120);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 720, y: 505 });
    await sleep(320);
    const barShown = await probeBar();
    ok(barShown.op != null && barShown.op > 0.5,
      '晃一下鼠标就亮回来（音乐键看得见）', barShown);

    const shot = await win.capturePage();
    fs.mkdirSync(path.join(__dirname, '截图', '验收'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '截图', '验收', '10-报告-音乐键.png'), shot.toPNG());
    ok(true, '已截图 测试脚本/截图/验收/10-报告-音乐键.png');

    // 点一下音乐键，确认它能关（图标切到 .off）
    const off = await js(`(function(){
      var b=document.querySelector('#reportStage #rsMusic'); if(!b) return {err:'no-btn'};
      b.click();
      return { off: b.classList.contains('off'), musicOn: window.SOUND.musicOn, playing: window.SOUND.music.playing() };
    })()`);
    await sleep(1300);
    const afterOffMusic = await js(`window.SOUND.music.playing()`);
    ok(off.off === true && off.musicOn === false, '点一下音乐键：开关变成关、图标进 .off 态', off);
    ok(afterOffMusic === false, '音乐真的停了', afterOffMusic);

    // 再点回来。注意：离屏窗口有可能让 AudioContext 进 suspended（页面被判为不可见），
    // 所以这里同时报出上下文状态 —— 万一失败，一眼看得出是"没恢复"还是"没接线"
    await js(`(function(){var b=document.querySelector('#reportStage #rsMusic'); b.click(); return 1;})()`);
    await sleep(600);
    const reOn = await js(`(function(){
      var b=document.querySelector('#reportStage #rsMusic');
      return { off: b.classList.contains('off'), musicOn: window.SOUND.musicOn,
               playing: window.SOUND.music.playing(),
               ctx: window.SOUND._state(), unlocked: window.SOUND._unlocked() };
    })()`);
    ok(reOn.off === false && reOn.musicOn === true && reOn.playing === true, '再点一下能开回来', reOn);

    // 别只看点开后那一下 —— 曾经有个 bug 是「淡出走完才停调度」的定时器没被撤销，
    // 它会在音乐已经重新放起来之后才到点，把调度器清掉（开关开着却没声音）。
    // 所以要跨过任何可能的淡出期限，再确认一次真的还在放。
    await sleep(2600);
    const stillOn = await js(`window.SOUND.music.playing()`);
    ok(stillOn === true, '开回来之后一直放着（没有迟到的定时器把它掐掉）', stillOn);

  } catch (e) {
    fail++;
    console.log('  ❌ 脚本异常：' + (e && e.stack ? e.stack : e));
  }

  console.log('\n──────────────────────────────────────────────');
  console.log((fail === 0 ? '✅ 全部通过：' : '❌ 有失败：') + pass + ' 项通过，' + fail + ' 项不通过');
  app.exit(fail === 0 ? 0 : 1);
});
