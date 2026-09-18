// sound.js —— 界面音效 + 年度报告背景音乐
//
// 为什么全部用 Web Audio 现场合成，而不是放 mp3：
//   1) 零音频文件：不用下载、不进安装包、不存在版权问题（可分发）
//   2) 音效本来就是「几十毫秒的包络」，采样文件反而更重、还容易糊
//   3) 背景音乐可以做**无缝循环**——它是一段和弦进行在按时间轴铺，不是剪辑出来的
//
// 两个独立通道都汇到 master，master 之上再统一受「静音」开关控制：
//   sfxGain ──┐
//             ├── master ── destination
//   musicGain ┘        └── reverb（只给音乐用）
//
// 浏览器/Electron 的自动播放策略要求 AudioContext 必须由用户手势创建或恢复，
// 所以这里全部懒初始化：第一次点/敲键才真正建上下文。

'use strict';

(function () {
  const LS_KEY = 'ta_sound_cfg';

  // ---------- 配置（持久化）----------
  // vol 是「响度」倍率：0 = 静音、1 = 设计电平、2 = 上限。
  // 各家扬声器差太多，与其把电平写死不如给一个可调的（默认就是设计电平）。
  let cfg = { on: true, music: true, vol: 1 };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
  } catch (e) {}
  if (typeof cfg.vol !== 'number' || !isFinite(cfg.vol)) cfg.vol = 1;
  cfg.vol = Math.max(0, Math.min(2, cfg.vol));
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  let ctx = null, master = null, sfxBus = null, musicBus = null, reverb = null, reverbSend = null, limiter = null;
  let unlocked = false;

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = cfg.on ? cfg.vol : 0;
      // 兜底限幅：音量拉满 + 音效和音乐同时响时，峰值可能越过 0 dBFS。
      // 硬削顶会发出「滋啦」的破音（听着像音色很怪，其实是削波）——
      // 挂一个阈值 -3dB 的压缩器，正常音量下它完全不介入。
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 6;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.005;
      limiter.release.value = 0.25;
      master.connect(limiter);
      limiter.connect(ctx.destination);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);

      musicBus = ctx.createGain();
      musicBus.gain.value = 0;          // 音乐从 0 淡入
      musicBus.connect(master);

      // 只给音乐用的混响：程序生成的脉冲响应（噪声 × 指数衰减），
      // 比找 IR 文件省事，听着也够「空间感」。
      reverb = ctx.createConvolver();
      reverb.buffer = makeIR(2.6, 2.2);
      reverbSend = ctx.createGain();
      reverbSend.gain.value = 0.5;
      reverbSend.connect(reverb);
      reverb.connect(master);
      return true;
    } catch (e) {
      ctx = null;
      return false;
    }
  }

  // 生成一段混响脉冲响应：白噪声乘指数衰减
  function makeIR(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // 用户第一次动手时把上下文唤醒
  function unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    unlocked = true;
  }

  // ---------- 基础音源 ----------
  // 一个「音符」：支持多个泛音、独立的起音/衰减。
  // 木质/钢琴类的听感全靠泛音比例 + 指数衰减，纯 sine 会像电子门铃。
  function note(t0, freq, opts) {
    const o = opts || {};
    const dur = o.dur || 0.5;
    const vel = (o.gain == null ? 0.2 : o.gain);
    const partials = o.partials || [1];
    const pg = o.partialsGain || partials.map((_, i) => 1 / (i + 1));
    const types = o.partialsType || [];
    const bus = o.bus || sfxBus;

    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.cutoff || 4200;
    lp.Q.value = 0.6;
    g.connect(lp);
    lp.connect(bus);
    if (o.reverb) { const rs = ctx.createGain(); rs.gain.value = o.reverb; lp.connect(rs); rs.connect(reverbSend); }

    for (let i = 0; i < partials.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = types[i] || 'sine';
      // 极轻的失谐：完全整数倍会听着发"死"，人耳对细微拍频很敏感
      osc.frequency.value = freq * partials[i] * (1 + i * 0.0007);
      const og = ctx.createGain();
      og.gain.value = pg[i];
      osc.connect(og);
      og.connect(g);
      osc.start(t0);
      osc.stop(t0 + dur + 0.15);
    }

    const atk = o.attack == null ? 0.006 : o.attack;
    const peak = vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    // 先快落到 30%，再慢拖尾 —— 这是「敲击类」乐器的包络形状
    if (o.sustain === false) {
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.3), t0 + atk + dur * 0.18);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }

  // 噪声（纸张、翻页那类）：带通扫频 + 快速衰减
  function noise(t0, opts) {
    const o = opts || {};
    const dur = o.dur || 0.22;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, o.decay || 2.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = o.q == null ? 1.1 : o.q;
    const f0 = o.freq || 1400, f1 = o.freqTo || 700;
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.value = o.gain == null ? 0.12 : o.gain;
    src.connect(bp); bp.connect(g); g.connect(o.bus || sfxBus);
    if (o.reverb) { const rs = ctx.createGain(); rs.gain.value = o.reverb; g.connect(rs); rs.connect(reverbSend); }
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  const t = () => ctx.currentTime;
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);   // MIDI 音高 → 频率

  // ---------- 音效 ----------
  // 设计原则：短、轻、偏木质与纸感。
  //
  // 踩过的两个坑（「声音太小」「音色好奇怪」就是这么来的）：
  //   1) 泛音**只能用整数倍**。之前写的 2.01 / 3.01 / 2.98 / 5.4 全是非整数倍，
  //      那是不谐音（inharmonic）——听起来是金属味、锣味、说不清的怪，
  //      而不是"更厚"。凡是"奇怪"的合成音色，先看泛音是不是整数倍。
  //   2) 基频不能低于约 300Hz。笔记本内置喇叭对 250Hz 以下几乎不响应，
  //      写在 200Hz 附近等于"提示没响"。宁可高八度也要让它听得见。
  //
  // 电平：单次 0.10~0.17。之前是 0.05~0.12，实测偏小 —— 界面音效"刚好听得见"
  // 的区间比想象中高，太保守用户第一反应就是"声音太小"。
  const WOOD = [1, 2, 3];             // 木质音的泛音配方（整数倍）
  const WOOD_G = [1, 0.16, 0.05];     // 高次泛音压得很低，才像木头而不是铃

  const PRESETS = {
    // 通用点击：一声干净的木质小点。
    // 基频从 1180 降到 900 —— 高基频叠非整数倍泛音会发尖发金属，低一点才像敲木头
    tap() {
      note(t(), 900, { dur: 0.075, gain: 0.14, partials: [1, 2], partialsGain: [1, 0.12], cutoff: 3200 });
    },
    // 切视图 / 换标签：比 tap 稍低稍长，带一点尾
    nav() {
      const t0 = t();
      note(t0, 620, { dur: 0.15, gain: 0.15, partials: WOOD, partialsGain: WOOD_G, cutoff: 3000, reverb: 0.08 });
      note(t0 + 0.03, 930, { dur: 0.12, gain: 0.10, partials: [1], cutoff: 3400, reverb: 0.06 });
    },
    // 打开：两个音上行（E5 → B5）
    open() {
      const t0 = t();
      note(t0, hz(76), { dur: 0.26, gain: 0.15, partials: WOOD, partialsGain: WOOD_G, cutoff: 3200, reverb: 0.10 });
      note(t0 + 0.06, hz(83), { dur: 0.30, gain: 0.13, partials: [1, 2], partialsGain: [1, 0.13], cutoff: 3400, reverb: 0.12 });
    },
    // 关闭：两个音下行（G5 → C5）
    close() {
      const t0 = t();
      note(t0, hz(79), { dur: 0.22, gain: 0.14, partials: WOOD, partialsGain: WOOD_G, cutoff: 2900, reverb: 0.10 });
      note(t0 + 0.055, hz(72), { dur: 0.28, gain: 0.13, partials: [1, 2], partialsGain: [1, 0.12], cutoff: 2700, reverb: 0.11 });
    },
    // 成功：上行大三度（A5 → C#6）
    ok() {
      const t0 = t();
      note(t0, hz(81), { dur: 0.24, gain: 0.16, partials: WOOD, partialsGain: WOOD_G, cutoff: 3400, reverb: 0.12 });
      note(t0 + 0.08, hz(85), { dur: 0.38, gain: 0.16, partials: WOOD, partialsGain: WOOD_G, cutoff: 3600, reverb: 0.14 });
    },
    // 失败：下行小二度（G4 → F#4）。
    // 原来落在 294/311Hz —— 笔记本喇叭这个频段已经很弱，"报错音"等于没响，所以整体抬上来
    err() {
      const t0 = t();
      note(t0, hz(67), { dur: 0.20, gain: 0.16, partials: [1, 2, 3], partialsGain: [1, 0.20, 0.06], cutoff: 2200, partialsType: ['triangle', 'sine', 'sine'], reverb: 0.08 });
      note(t0 + 0.07, hz(66), { dur: 0.40, gain: 0.15, partials: [1, 2], partialsGain: [1, 0.18], cutoff: 1900, partialsType: ['triangle', 'sine'], reverb: 0.10 });
    },
    // 报告翻页：纸张摩擦，一段带通扫频的短噪声
    page() {
      const t0 = t();
      noise(t0, { dur: 0.24, gain: 0.17, freq: 2400, freqTo: 800, q: 0.9, decay: 2.2, reverb: 0.08 });
      note(t0 + 0.02, 620, { dur: 0.09, gain: 0.06, partials: [1, 2], partialsGain: [1, 0.10], cutoff: 2400 });
    },
    // 报告开始：一声轻铃。泛音原本有个 5.4 倍，那是最明显的非整数倍 → 换成 6（整数倍）
    start() {
      const t0 = t();
      note(t0, hz(88), { dur: 1.0, gain: 0.16, partials: [1, 2, 3, 4, 6], partialsGain: [1, 0.40, 0.20, 0.11, 0.05], cutoff: 6000, reverb: 0.34 });
      noise(t0, { dur: 0.45, gain: 0.03, freq: 6000, freqTo: 2400, q: 0.7, decay: 3, reverb: 0.22 });
    },
    // 报告结束：一个柔和的上行三和弦
    end() {
      const t0 = t();
      [60, 64, 67, 72].forEach((n, i) => {
        note(t0 + i * 0.055, hz(n), { dur: 1.5, gain: 0.13, partials: WOOD, partialsGain: WOOD_G, cutoff: 3000, reverb: 0.30 });
      });
    },
    // 唤醒（闲置后模型重新装回显存）：一声很轻的上升
    wake() {
      const t0 = t();
      note(t0, hz(69), { dur: 0.18, gain: 0.12, partials: [1, 2], partialsGain: [1, 0.14], cutoff: 3000, reverb: 0.08 });
      note(t0 + 0.055, hz(76), { dur: 0.28, gain: 0.12, partials: [1, 2], partialsGain: [1, 0.14], cutoff: 3200, reverb: 0.10 });
    },
  };

  function play(name) {
    if (!cfg.on) return;
    if (!ensure()) return;
    if (!unlocked) return;
    if (ctx.state !== 'running') {
      // 被挂起了就顺手恢复（点按钮本身就是一次用户手势，恢复是合规的）。
      // 这一次先不出声 —— 恢复要几毫秒，赶不上眼前这一下，硬放会丢音。
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    const fn = PRESETS[name];
    if (!fn) return;
    try { fn(); } catch (e) {}
  }

  // ---------- 背景音乐 ----------
  // 一段可无缝循环的慢速钢琴 + 铺底。和弦走 vi–IV–I–V，
  // 是最能兜住「回望一段关系」这种情绪的进行，不甜也不苦。
  const PROG = [
    { root: 45, notes: [57, 60, 64, 67] },   // Am7   A C E G
    { root: 41, notes: [53, 57, 60, 64] },   // Fmaj7 F A C E
    { root: 48, notes: [55, 59, 64, 67] },   // Cmaj7 G B E G（低音给 C）
    { root: 43, notes: [55, 59, 62, 67] },   // G     G B D G
  ];
  const CHORD_BEATS = 8;          // 每个和弦 8 拍
  const BPM = 52;
  const BEAT = 60 / BPM;          // ≈1.154s
  const CHORD_DUR = CHORD_BEATS * BEAT;   // ≈9.2s，整圈 ≈37s

  let musicOn = false, musTimer = null, nextT = 0, step = 0;
  // 音乐的整体电平。原来 0.16 实测偏小（背景音乐小到"要刻意去找才能听见"，
  // 那就失去意义了）。0.30 配合下面各声部的增益，峰值约 -18dB，是"背景"该有的位置。
  let musicLevel = 0.30;
  // 「淡出走完就停掉调度」的那个定时器。必须是可撤销的：
  // 用户在半路上又把音乐点回来时，如果它还挂着，就会在音乐已经重新放起来之后
  // 把调度器和 musicOn 一起清掉 —— 表现是「开关是开的，但没声音」，极难查。
  let offTimer = null;
  function cancelOff() {
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
  }

  // 钢琴音色：泛音按 1/n 递减、快速起音 + 长指数衰减。
  // 6 个泛音是听感与开销的折中——再往上加基本听不出来，却要多开一堆振荡器。
  function piano(t0, midi, gain, dur) {
    note(t0, hz(midi), {
      dur: dur || 2.2,
      gain: gain,
      partials: [1, 2, 3, 4, 6, 8],
      partialsGain: [1, 0.4, 0.19, 0.1, 0.045, 0.02],
      partialsType: ['sine', 'sine', 'sine', 'triangle', 'sine', 'sine'],
      cutoff: 2800,
      attack: 0.004,
      bus: musicBus,
      reverb: 0.6,
    });
  }
  // 铺底：慢起音、只留低次泛音，负责厚度不抢戏
  // 这里 2.005 的非整数倍是**故意的** —— 长音需要轻微失谐产生的拍频才「厚」，
  // 这是 pad 的标准做法。上面音效那边要整数倍是因为音效短促，不谐音会听成金属味。
  function pad(t0, midi, gain, dur) {
    note(t0, hz(midi), {
      dur: dur,
      gain: gain,
      partials: [1, 2.005],
      partialsGain: [1, 0.18],
      partialsType: ['triangle', 'sine'],
      cutoff: 1400,
      attack: dur * 0.45,
      sustain: false,
      bus: musicBus,
      reverb: 0.7,
    });
  }
  // 低音：整段的根
  function bass(t0, midi, gain, dur) {
    note(t0, hz(midi), {
      dur: dur,
      gain: gain,
      partials: [1, 2.0, 3.0],
      partialsGain: [1, 0.22, 0.07],
      partialsType: ['triangle', 'sine', 'sine'],
      cutoff: 900,
      attack: 0.02,
      bus: musicBus,
      reverb: 0.28,
    });
  }

  // 铺一个和弦（含它的琶音）。t0 是这一小节的起点。
  function playChord(t0, i) {
    const c = PROG[i % PROG.length];
    const n = c.notes;

    // 铺底：整小节
    pad(t0, n[0], 0.07, CHORD_DUR * 0.98);
    pad(t0, n[2] + 12, 0.04, CHORD_DUR * 0.9);
    // 低音用 c.root（A2 ≈ 110Hz），不用 c.root - 12（≈55Hz）——
    // 55Hz 在笔记本喇叭上基本放不出来，等于整段音乐没有低频支撑，
    // 听着就是"又小又飘"。抬一个八度，靠基频本身就够，不指望泛音救。
    bass(t0, c.root, 0.11, CHORD_DUR * 0.85);

    // 琶音：音符落在拍点附近，力度有起伏 —— 机械等分听着最像八音盒
    const seq = [0, 1, 2, 3, 2, 3, 1, 2];
    const oct = [0, 0, 0, 12, 0, 12, 0, 0];
    for (let k = 0; k < CHORD_BEATS; k++) {
      const tAt = t0 + k * BEAT;
      const idx = seq[k % seq.length];
      // 力度：小节内前重后轻，再叠一点随机，避免听出循环
      const sway = 0.75 + 0.25 * Math.sin(k * 1.1);
      const vel = (k % 2 === 0 ? 0.08 : 0.058) * sway * (0.85 + Math.random() * 0.3);
      piano(tAt, n[idx] + oct[k % oct.length], vel, 2.4);
      // 每两拍补一个高八度的回声，像房间里的一点亮
      if (k % 2 === 1) piano(tAt + BEAT * 0.52, n[(idx + 2) % 4] + 12, 0.035 * sway, 2.0);
    }
    // 小节尾巴上偶尔留一个高音，把两小节缝起来
    if (i % 4 === 3) piano(t0 + CHORD_DUR - BEAT * 0.5, n[1] + 24, 0.04, 2.6);
  }

  function schedule() {
    if (!musicOn || !ctx) return;
    const horizon = ctx.currentTime + 1.5;   // 提前铺 1.5 秒，够扛住一次主线程卡顿
    let guard = 0;
    while (nextT < horizon && guard++ < 8) {
      playChord(nextT, step);
      nextT += CHORD_DUR;
      step++;
    }
  }

  function fade(gn, to, sec) {
    const now = ctx.currentTime;
    try {
      gn.gain.cancelScheduledValues(now);
      gn.gain.setValueAtTime(Math.max(0.0001, gn.gain.value), now);
      gn.gain.linearRampToValueAtTime(to, now + sec);
    } catch (e) { gn.gain.value = to; }
  }

  function musicStart() {
    if (!cfg.on || !cfg.music) return;
    if (!ensure()) return;
    if (!unlocked) return;
    // 上下文可能是被挂起的（切后台、系统休眠、省电策略……）。
    // 用户点「放音乐」是明确意图，应该把它恢复回来，而不是静默失败 ——
    // 恢复是异步的，所以真正的调度要放进 then 里。
    if (ctx.state === 'suspended') {
      ctx.resume().then(beginMusic).catch(() => {});
      return;
    }
    beginMusic();
  }

  function beginMusic() {
    if (!cfg.on || !cfg.music || !ctx) return;
    if (ctx.state !== 'running') return;
    cancelOff();        // 撤销上一次「淡出后停调度」——否则它稍后会把刚放起来的音乐掐掉
    if (musicOn) { fade(musicBus, musicLevel, 1.2); return; }   // 已经在放就只把音量推回去
    musicOn = true;
    step = 0;
    nextT = ctx.currentTime + 0.12;
    fade(musicBus, musicLevel, 2.4);        // 慢慢进来，别一开报告就吓一跳
    schedule();
    musTimer = setInterval(schedule, 300);
    if (musTimer.unref) musTimer.unref();
  }

  function musicStop(fadeSec) {
    if (!musicOn) return;
    // 已经在停了就不再受理：同一轮里音乐可能被连叫停两次（设置面板 setMusic 一次、
    // 界面的 stopMusic 一次）。若每次都重排定时器，会出现「淡出早就走完、调度器还在空转」，
    // 而且定时器叠罗汉 —— 先到的那个会在音乐被重新放起来之后才到点，把调度器掐掉。
    if (offTimer) return;
    const wait = fadeSec == null ? 1.6 : fadeSec;
    fade(musicBus, 0, wait);
    offTimer = setTimeout(() => {
      // 音量真的到 0 了才停调度，避免淡出中途还在铺新音符
      offTimer = null;
      if (!musicOn) return;
      clearInterval(musTimer); musTimer = null;
      musicOn = false;
    }, wait * 1000 + 60);
    if (offTimer.unref) offTimer.unref();
  }

  function musicPause() {
    if (!musicOn) return;
    fade(musicBus, 0, 0.6);
  }
  function musicResume() {
    if (!musicOn || !cfg.on || !cfg.music) return;
    // 从后台切回来时上下文可能也已经被挂起了，一并恢复
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    fade(musicBus, musicLevel, 1.0);
  }

  // 页面切到后台就别出声了（既不打扰，也省点 CPU）
  document.addEventListener('visibilitychange', () => {
    if (!musicOn) return;
    if (document.hidden) musicPause(); else musicResume();
  });

  // 用户手势解锁 + 通用点击音效
  // 用捕获阶段：这样即便某个 handler 提前 stopPropagation，点击音也不会丢
  document.addEventListener('pointerdown', unlock, { capture: true, once: false });
  document.addEventListener('keydown', unlock, { capture: true, once: false });

  // ---------- 对外 ----------
  window.SOUND = {
    sfx: play,
    music: {
      start: musicStart,
      stop: musicStop,
      pause: musicPause,
      resume: musicResume,
      playing: () => musicOn,
    },
    get on() { return cfg.on; },
    get musicOn() { return cfg.music; },
    get vol() { return cfg.vol; },
    // 总开关：关掉时所有声音立即静音
    setOn(v) {
      cfg.on = !!v;
      saveCfg();
      if (ensure()) fade(master, cfg.on ? cfg.vol : 0, 0.25);
      if (!cfg.on) musicStop(0.3);
      return cfg;
    },
    // 响度：0~2 的倍率。各家扬声器差太多，给个旋钮胜过猜一个"标准电平"
    setVol(v) {
      const n = Number(v);
      cfg.vol = Math.max(0, Math.min(2, isFinite(n) ? n : 1));
      saveCfg();
      if (ensure() && cfg.on) fade(master, cfg.vol, 0.15);
      return cfg;
    },
    // 背景音乐单独开关（报告里用）
    setMusic(v) {
      cfg.music = !!v;
      saveCfg();
      if (!cfg.music) musicStop(1.0);
      else cancelOff();     // 刚被勾回来，把还挂着的「停调度」撤掉
      return cfg;
    },
    unlock,
    cfg: () => ({ on: cfg.on, music: cfg.music, vol: cfg.vol }),
    // 给测试用：看上下文到底建了没、醒着没
    _state: () => (ctx ? ctx.state : 'none'),
    _unlocked: () => unlocked,
  };
})();
