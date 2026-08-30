(() => {
  const $ = s => document.querySelector(s);
  const main = $('#main');
  const listEl = $('#person-list');
  let persons = [];
  let current = null;
  let searchQ = ''; // 联系人搜索词
  let todos = []; // 待办列表（localStorage 持久化）
  let settings = { importMode: 'all', importTimeDays: 365, importCount: 500 }; // 后端应用设置缓存
  let aiState = { ready: false, downloading: false, progress: 0, installed: false, error: null }; // 本地小AI 状态缓存
  let enrichSeq = 0; // 单调序号：只让最新一次请求生效，避免切换联系人时结果错位

  // ---------- 访问口令（局域网明文聊天保护，opt-in） ----------
  const _TA_PWD_KEY = 'ta_love_pwd';
  const _taPwd = () => sessionStorage.getItem(_TA_PWD_KEY) || '';
  const _taAuthHeader = () => { const p = _taPwd(); return p ? 'Basic ' + btoa(unescape(encodeURIComponent('ta-love-app:' + p))) : ''; };
  const _taImgUrl = u => { const p = _taPwd(); return p ? u + (u.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(p) : u; };
  const _api = p => p; // 占位：API 路径原样返回（鉴权由全局 fetch 包装器注入）
  (function () {
    const _f = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      opts = opts || {};
      const h = _taAuthHeader();
      if (h) opts.headers = Object.assign({}, opts.headers, { Authorization: h });
      return _f(url, opts).then(res => { if (res.status === 401) _taShowLogin(); return res; });
    };
  })();
  function _taShowLogin() {
    if (document.getElementById('ta-login')) return;
    const ov = document.createElement('div');
    ov.id = 'ta-login';
    ov.className = 'ta-login-ov';
    ov.innerHTML = '<div class="ta-login"><div class="ta-login-t">🔒 访问口令</div>' +
      '<div class="ta-login-s">本机聊天数据含明文，局域网访问需输入口令</div>' +
      '<input id="ta-pwd" class="ta-login-in" type="password" placeholder="请输入访问口令" autocomplete="off">' +
      '<div id="ta-login-err" class="ta-login-err"></div>' +
      '<button id="ta-login-ok" class="ta-login-btn">进入</button></div>';
    document.body.appendChild(ov);
    const inp = ov.querySelector('#ta-pwd');
    const err = ov.querySelector('#ta-login-err');
    const ok = () => {
      const v = inp.value;
      if (!v) { err.textContent = '请输入口令'; return; }
      sessionStorage.setItem(_TA_PWD_KEY, v);
      window.fetch('/api/persons', { headers: { Authorization: _taAuthHeader() } }).then(r => {
        if (r.ok) { ov.remove(); location.reload(); }
        else { sessionStorage.removeItem(_TA_PWD_KEY); err.textContent = '口令错误，请重试'; }
      }).catch(() => { sessionStorage.removeItem(_TA_PWD_KEY); err.textContent = '验证失败，请重试'; });
    };
    ov.querySelector('#ta-login-ok').addEventListener('click', ok);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    setTimeout(() => inp.focus(), 50);
  }

  // ---------- Toast（替代关键操作 alert） ----------
  function toast(msg, type = 'info', ms = 3800) {
    let box = $('#toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }
  // 骨架屏占位
  function skeleton() {
    return `<div class="skel" aria-hidden="true">
      <div class="sk-row" style="width:38%"><i></i></div>
      <div class="sk-grid"><i></i><i></i><i></i></div>
      <div class="sk-row" style="width:64%"><i></i></div>
      <div class="sk-row" style="width:82%"><i></i></div>
      <div class="sk-row" style="width:56%"><i></i></div>
      <div class="sk-row" style="width:74%"><i></i></div>
    </div>`;
  }

  // ---------- 空状态引导（联系人尚无聊天记录时） ----------
  function emptyState(p) {
    const name = esc(p ? p.name : '');
    return `<div class="card empty-state">
      <div class="es-ic">💬</div>
      <div class="es-t">「${name}」还没有聊天记录</div>
      <div class="es-s">导入方法：<br>① 确认左侧已选中本联系人<br>② 点左侧「📋 导入聊天记录」按钮<br>③ 在电脑聊天软件打开与 TA 的聊天窗口，右键「多选」→ 勾选一批 → 「复制」<br>④ 工具会自动抓取并导入，重复几次即可覆盖更多历史</div>
      <div class="es-tip">提示：电脑端记录不全时，先用手机聊天软件「聊天记录迁移」到电脑，再回来导入。</div>
    </div>`;
  }

  // ---------- 联系人列表 ----------
  async function loadPersons() {
    try {
      const r = await fetch('/api/persons');
      if (r.ok) persons = await r.json();
    } catch (e) { persons = persons || []; }
    const si = $('#searchInput');
    if (si) {
      si.addEventListener('input', () => {
        searchQ = si.value.trim().toLowerCase();
        renderList();
      });
    }
    renderList();
  }
  function pinnedIds() {
    return persons.filter(x => x.pinned).map(x => x.id);
  }
  function renderList() {
    const pins = pinnedIds();
    // 置顶优先；其余按消息同步顺序（最近消息时间 last 降序），无 last 的兜底按消息数
    const sorted = [...persons]
      .filter(p => !searchQ || (p.name || '').toLowerCase().includes(searchQ) || (p.user || '').toLowerCase().includes(searchQ))
      .sort((a, b) => {
        const ap = pins.includes(a.id) ? 0 : 1, bp = pins.includes(b.id) ? 0 : 1;
        return ap - bp || ((b.last || 0) - (a.last || 0)) || (b.msgs - a.msgs);
      });
    if (!persons.length) {
      listEl.innerHTML = `<div class="list-empty">
        <div class="le-ic">👥</div>
        <div class="le-t">还没有联系人</div>
        <div class="le-s">点上方「＋ 新建」创建一个<br>再选中它，用「📋 导入聊天记录」把聊天记录导进来</div>
      </div>`;
      return;
    }
    listEl.innerHTML = sorted.map(p => `
      <div class="person ${current && current.id === p.id ? 'on' : ''}" data-id="${p.id}">
        ${p.group
          ? `<div class="ava">群</div>`
          : `<div class="ava"><span class="avfallback">${p.avatar || '?'}</span></div>`}
        <div class="nm-wrap"><div class="nm" title="${p.name}">${p.name}${p.group ? ' <span class="grp">群聊</span>' : ''}</div><div class="sub">${p.msgs || 0} 条消息${!p.group && p.coldDays >= 3 ? ` <span class="cold">已 ${p.coldDays} 天未联系</span>` : ''}</div></div>
        <div class="ops">
          <span class="op pin ${pins.includes(p.id) ? 'on' : ''}" title="置顶">${pins.includes(p.id) ? '★' : '☆'}</span>
          <span class="op del" title="删除">×</span>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('.person').forEach(el => {
      el.addEventListener('click', () => selectPerson(el.dataset.id));
      el.querySelector('.pin').addEventListener('click', e => {
        e.stopPropagation();
        const id = el.dataset.id;
        fetch('/api/person/' + id + '/pin', { method: 'PUT' }).then(r => {
          if (!r.ok) { alert('置顶失败'); return; }
          const p = persons.find(x => x.id === id);
          p.pinned = !p.pinned;
          renderList();
        });
      });
      el.querySelector('.del').addEventListener('click', e => {
        e.stopPropagation();
        const p = persons.find(x => x.id === el.dataset.id);
        if (!confirm(`删除联系人「${p.name}」？\n将同时移除其聊天缓存，可恢复备份保留在 trash.json。`)) return;
        fetch('/api/person/' + el.dataset.id, { method: 'DELETE' }).then(r => {
          if (!r.ok) { alert('删除失败'); return; }
          persons = persons.filter(x => x.id !== el.dataset.id);
          if (current && current.id === el.dataset.id) { current = null; main.innerHTML = `<div class="ph">← 选择左侧联系人查看分析</div>`; }
          renderList();
        });
      });
    });
  }

  // ---------- 主区渲染 ----------
  async function selectPerson(id) {
    current = persons.find(x => x.id === id);
    renderList();
    // 骨架屏 + 内容切换动画
    main.innerHTML = `<div class="view">${skeleton()}</div>`;
    const resp = await fetch('/api/person/' + id);
    if (!resp.ok) {
      main.innerHTML = `<div class="view" id="viewRoot">${emptyState(current)}</div>`;
      const v = $('#viewRoot');
      if (v) v.classList.add('in');
      return;
    }
    const d = await resp.json();
    let html;
    if (d.group) {
      // 群聊：仅展示时间线，不渲染指数/雷达/趋势
      html = `
        <div class="card"><div class="sec-t">群聊 · 不参与关系指数分析</div><div class="grp-note">共 ${d.msgCount} 条消息</div></div>
        <div class="card">${timelineCard(d)}</div>`;
    } else {
      html = `
      ${d.coldDays >= 3 ? `<div class="warn"><b>冷场预警</b> · 已 ${d.coldDays} 天没有联系了，主动发条消息吧</div>` : ''}
      ${d.roast && d.roast.lines && d.roast.lines.length ? roastCard(d) : ''}
      <div class="row">
        <div class="card col">${gaugesCard(d)}</div>
        <div class="card col radar-card">${radarCard(d)}</div>
      </div>
      <div class="row">
        <div class="card col">${likesCard(d)}</div>
        <div class="card col">${anniversariesCard(d)}</div>
      </div>
      ${imgCard(d)}
      <div class="card trend-card">${trendCard(d)}</div>
      <div class="card">${wordsCard(d)}</div>
      <div class="card">${sentimentCard(d)}</div>
      <div class="card">${timelineCard(d)}</div>
      <div class="card">${conclCard(d)}</div>`;
    }
    // 丝滑切换：淡入 + 轻微上移
    main.innerHTML = `<div class="view" id="viewRoot">${html}</div>`;
    const v = $('#viewRoot');
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.add('in')));
    bindMain(d);
    if (aiState.installed) tryEnrichAi(d, id); // 本地AI 已安装时自动生成锐评/洞察
    // 联系人切换后右侧自动回到顶部，避免用户手动上翻
    window.scrollTo({ top: 0, behavior: 'smooth' });
    main.scrollTop = 0;
  }

  // ---------- AI 锐评（毒舌但友好 + 狗头军师建议） ----------
  function roastCard(d) {
    const r = d.roast;
    const rows = r.lines.map(l => `<div class="roast-line">${esc(l)}</div>`).join('');
    const advice = r.advice ? `<div class="roast-advice"><span class="ra-tt">${esc(r.adviceTitle || '狗头军师 · 相处建议')}</span><div class="ra-body">${esc(r.advice)}</div></div>` : '';
    return `<div class="roast">
      <div class="roast-head"><span class="roast-tt">${esc(r.title)}</span><span class="roast-sub">${esc(r.sub)}</span></div>
      ${rows}
      ${advice}
    </div>`;
  }

  // ---------- 本地小AI：状态条 / 下载 / 生成 ----------
  function renderAiBar() {
    const bar = $('#aiBar');
    if (!bar) return;
    const s = aiState;
    let cls = 'ai-bar', html;
    if (s.ready) { cls += ' ok'; html = '🧠 本地AI 已就绪'; }
    else if (s.downloading) { cls += ' busy'; html = '🧠 正在下载本地AI ' + (s.progress || 0) + '%'; }
    else if (s.installed) { cls += ' ok'; html = '🧠 本地AI 已安装 · 加载中'; }
    else { cls += ' off'; html = '🧠 本地AI 未安装 · 点此下载（约 2GB，仅首次）'; }
    bar.className = cls;
    bar.innerHTML = html;
  }
  function pollAiStatus() {
    fetch('/api/ai/status').then(r => r.json()).then(s => { aiState = s; renderAiBar(); }).catch(() => {});
  }
  function bindAi() {
    const bar = $('#aiBar');
    if (bar) bar.addEventListener('click', () => {
      if (aiState.downloading || aiState.ready) return;
      toast('开始下载本地AI模型，请稍候（仅首次，之后完全离线）', 'info', 5000);
      fetch('/api/ai/setup', { method: 'POST' }).then(r => r.json()).then(s => { aiState = s; renderAiBar(); }).catch(() => {});
    });
  }
  function aiExtrasCard(d, ai) {
    const mood = ai.mood ? `<div class="ai-mood"><span class="ai-mood-tt">情感基调</span><span class="ai-mood-body">${esc(ai.mood)}</span></div>` : '';
    const insights = (ai.insights && ai.insights.length) ? `<div class="ai-insight"><span class="ra-tt">关系洞察</span>${ai.insights.map(l => `<div class="ai-insight-line">${esc(l)}</div>`).join('')}</div>` : '';
    if (!mood && !insights) return '';
    return `<div class="roast ai-extras">
      <div class="roast-head"><span class="roast-tt">本地AI · 情感与洞察</span><span class="roast-sub">Qwen2.5-3B · 本地生成</span></div>
      ${mood}
      ${insights}
    </div>`;
  }
  async function tryEnrichAi(d, id) {
    if (!aiState.installed || d.group) return;
    const seq = ++enrichSeq;
    const roast = document.querySelector('.roast');
    if (roast) roast.classList.add('ai-thinking');
    try {
      const resp = await fetch('/api/ai/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d }) });
      if (!resp.ok) return;
      const ai = await resp.json();
      if (!ai || !ai.ok) return;
      if (seq !== enrichSeq || (current && current.id !== id)) return; // 期间切走/又触发，丢弃
      const card = aiExtrasCard(d, ai);
      if (!card) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = card;
      const node = tmp.firstElementChild;
      const cur = document.querySelector('.roast');
      if (cur) cur.insertAdjacentElement('afterend', node);
      else { const v = $('#viewRoot'); if (v) v.insertAdjacentHTML('afterbegin', card); }
    } catch (e) {} finally {
      if (seq === enrichSeq) { const r = document.querySelector('.roast'); if (r) r.classList.remove('ai-thinking'); }
    }
  }

  // ---------- 半圆仪表盘 ----------
  const GAUGE_HINT = {
    active: '谁更常发起对话：你主动发起的占比越高分越高',
    loved: 'TA 的回应热情：TA 消息占比 + 回复速度',
    cold: 'TA 的敷衍程度：单字/短回复占比越高越冷'
  };
  function gaugesCard(d) {
    return `<div class="sec-t">关系指数</div><div class="gauges">` + d.gauges.map(g => {
      const v = g.value;
      const phi = Math.PI * (180 - v * 1.8) / 180;            // 进度弧终点角
      const ex = 60 + 48 * Math.cos(phi), ey = 70 - 48 * Math.sin(phi);
      const rot = v * 1.8 - 79.4;                              // 指针角
      const progress = v > 0 ? `<path d="M12 70 A48 48 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${g.color}" stroke-width="9" stroke-linecap="round"/>` : '';
      return `<div class="g">
        <svg width="120" height="78" viewBox="0 0 120 78">
          <path d="M12 70 A48 48 0 0 1 108 70" fill="none" stroke="#16314f" stroke-width="9" stroke-linecap="round"/>
          ${progress}
          <g transform="rotate(${rot.toFixed(1)} 60 70)"><line x1="60" y1="70" x2="60" y2="34" stroke="#e0bc72" stroke-width="3" stroke-linecap="round"/><circle cx="60" cy="70" r="5" fill="#c9a35c"/></g>
        </svg>
        <div class="big">${v}</div><div class="lbl">${g.label}</div>
      </div>`;
    }).join('') + `<details class="note-f"><summary>指标注释</summary>${d.gauges.map(g => `<div class="nh">${g.label}：${GAUGE_HINT[g.key] || ''}</div>`).join('')}</details></div>`;
  }

  // ---------- 趋势平滑折线 ----------
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    const P = [pts[0], ...pts, pts[pts.length - 1]];
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      d += ` C ${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }
  // 将数值序列按 null 拆分成连续段（坐标已换算到 SVG 空间）
  function segments(values, xs, yOf) {
    const segs = [];
    let cur = [];
    values.forEach((v, i) => {
      if (v === null || v === undefined) {
        if (cur.length) { segs.push(cur); cur = []; }
      } else {
        cur.push([xs[i], yOf(v), v]);
      }
    });
    if (cur.length) segs.push(cur);
    return segs;
  }
  function trendCard(d) {
    const tr = d.trend;
    const W = 580, H = 210, L = 46, R = 540, T = 20, B = 170;
    const xs = tr.dates.map((_, i) => L + (R - L) * i / (tr.dates.length - 1));
    // 动态 Y 轴：按当前联系人所有数值区间缩放，避免折线挤成水平线
    const allVals = tr.series.flatMap(s => s.values.filter(v => v !== null && v !== undefined));
    let yMin = Math.min(...allVals), yMax = Math.max(...allVals);
    let span = yMax - yMin;
    if (span < 20) { const pad = (20 - span) / 2; yMin = Math.max(0, yMin - pad); yMax = Math.min(100, yMax + pad); }
    else { const pad = span * 0.12; yMin = Math.max(0, yMin - pad); yMax = Math.min(100, yMax + pad); }
    yMin = Math.floor(yMin / 5) * 5;
    yMax = Math.ceil(yMax / 5) * 5;
    if (yMax - yMin < 20) yMax = yMin + 20;
    const yOf = v => B - (v - yMin) / (yMax - yMin) * (B - T);
    const step = Math.max(5, Math.ceil((yMax - yMin) / 4 / 5) * 5);
    const ticks = [];
    for (let v = yMin; v <= yMax; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] !== yMax) ticks.push(yMax);
    let grid = '';
    for (const gv of ticks) {
      const y = yOf(gv);
      grid += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}"/>`;
    }
    const yLabels = ticks.map((v) =>
      `<text x="${L - 6}" y="${(yOf(v) + 3).toFixed(0)}" text-anchor="end">${v}</text>`).join('');
    const xLabels = tr.dates.map((dd, i) => `<text x="${xs[i]}" y="188" text-anchor="middle">${dd}</text>`).join('');
    const legend = tr.series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    const bodies = tr.series.map((s, si) => {
      // 每段独立绘制：≥2 点画平滑线+渐变面积，单点仅画点（水平无数据周不硬连）
      return segments(s.values, xs, yOf).map(seg => {
        const line = smoothPath(seg);
        const area = line ? line + ` L ${seg[seg.length - 1][0]} ${B} L ${seg[0][0]} ${B} Z` : '';
        const dots = seg.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.4" fill="${s.color}" stroke="#0d2036" stroke-width="1.2"/>`).join('');
        const numLabels = seg.map(p => `<text x="${p[0]}" y="${p[1] - 8}" text-anchor="middle" fill="${s.color}" font-size="10.5" font-weight="bold">${Math.round(p[2])}</text>`).join('');
        return `${area ? `<path fill="url(#grad-${s.key})" stroke="none" d="${area}"/>` : ''}
          ${line ? `<path fill="none" stroke="${s.color}" stroke-width="3" filter="url(#glowT)" d="${line}"/>` : ''}
          ${dots}
          ${numLabels}`;
      }).join('');
    }).join('');
    const defs = tr.series.map(s =>
      `<linearGradient id="grad-${s.key}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity=".28"/>
        <stop offset="1" stop-color="${s.color}" stop-opacity="0"/>
      </linearGradient>`).join('');
    return `<div class="sec-t">指数趋势 · 时间线</div>
      <div class="legend">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}">
        <defs>
          <filter id="glowT" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          ${defs}
        </defs>
        <g stroke="rgba(120,180,220,.18)" stroke-width="1" fill="none">${grid}</g>
        <g fill="#7fa8c9" font-size="9">${yLabels}</g>
        <g fill="#7fa8c9" font-size="9">${xLabels}</g>
        ${bodies}
      </svg>`;
  }

  // ---------- Sternberg 雷达 ----------
  function radarCard(d) {
    const st = d.sternberg;
    const cx = 130, cy = 100, rMax = 72;
    const pt = (v, i) => {
      const a = Math.PI * (-90 + i * 360 / st.labels.length) / 180;
      const r = v / 100 * rMax;
      return [(cx + r * Math.cos(a)).toFixed(1), (cy + r * Math.sin(a)).toFixed(1)];
    };
    const poly = vals => vals.map((v, i) => pt(v, i).join(',')).join(' ');
    const lines = st.labels.map((_, i) => {
      const [x, y] = pt(100, i);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a6a96" stroke-dasharray="2 3"/>`;
    }).join('');
    const labels = st.labels.map((lb, i) => {
      const a = Math.PI * (-90 + i * 360 / st.labels.length) / 180;
      const x = cx + 86 * Math.cos(a), y = cy + 86 * Math.sin(a);
      return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle" fill="#9db8d0" font-size="10">${lb}</text>`;
    }).join('');
    const hex = (vals, fill, stroke) =>
      `<polygon points="${poly(vals)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    const numTexts = st.labels.map((lb, i) => {
      const a = Math.PI * (-90 + i * 360 / st.labels.length) / 180;
      const rm = st.me[i] / 100 * rMax, rt = st.ta[i] / 100 * rMax;
      const xm = cx + (rm - 7) * Math.cos(a), ym = cy + (rm - 7) * Math.sin(a) + 2.5;
      const xt = cx + (rt + 8) * Math.cos(a), yt = cy + (rt + 8) * Math.sin(a) + 2.5;
      return `<text x="${xm.toFixed(1)}" y="${ym.toFixed(1)}" text-anchor="middle" fill="#4fd0ff" font-size="8" font-family="Georgia,serif" font-variant-numeric="tabular-nums">${st.me[i]}</text>` +
             `<text x="${xt.toFixed(1)}" y="${yt.toFixed(1)}" text-anchor="middle" fill="#e0bc72" font-size="8" font-family="Georgia,serif" font-variant-numeric="tabular-nums">${st.ta[i]}</text>`;
    }).join('');
    const explain = {
      '激情': '谁更主动投入：蓝色=你发起对话/发消息的占比，黄色=TA主动的占比。分越高越主动',
      '亲密': '深夜陪伴：22点-2点聊天的占比。蓝色=你深夜陪TA聊的比例，黄色=TA深夜陪你聊的比例',
      '承诺': '关系跨度：从第一天聊到今天持续了多久。蓝色与黄色为同一数值（双方共同经历）',
      '责任': '回应速度：对方发消息后多久回复。蓝色=你回TA的速度，黄色=TA回你的速度。分越高回得越快',
      '信任': '敞开心扉：长消息(>20字)与深夜倾诉的占比。蓝色=你信任TA（你向TA说心里话），黄色=TA信任你（TA向你倾诉）'
    };
    return `<div class="sec-t">Sternberg 爱情三角</div>
      <div class="radar-legend"><span><i style="background:#4fd0ff"></i>蓝色 = 你（你对TA的付出）</span><span><i style="background:#e0bc72"></i>黄色 = TA（TA对你的付出）</span></div>
      <svg viewBox="0 0 260 200">
        ${st.labels.map((_, i) => { const [x, y] = pt(100, i); return `<circle cx="${x}" cy="${y}" r="1.6" fill="#3a6a96"/>`; }).join('')}
        ${lines}
        ${hex(st.me, 'rgba(79,208,255,.18)', '#4fd0ff')}
        ${hex(st.ta, 'rgba(224,188,114,.12)', '#e0bc72')}
        ${numTexts}
        ${labels}
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#eaf4fc" font-size="10">你</text>
      </svg>
      <details class="note-f radar-note"><summary>维度注释（点击展开）</summary>
        <div class="radar-tip">图中每个维度都有蓝色与黄色两枚值：蓝是你的方向，黄是TA的方向，谁的颜色圈更大，谁在这个维度付出更多</div>
        ${st.labels.map((lb, i) => `<div class="rn"><b>${lb}</b> ${explain[lb]}<div class="rv"><span class="rv-me">蓝·你 ${st.me[i]}</span><span class="rv-ta">黄·TA ${st.ta[i]}</span></div></div>`).join('')}
      </details>`;
  }

  // ---------- 热词榜 ----------
  function wordsCard(d) {
    const maxN = arr => arr.length ? Math.max(...arr.map(x => x.n)) : 1;
    const tag = (w, n, max, cls) => {
      const f = 0.82 + (n / max) * 0.42;
      return `<span class="wd ${cls}" style="font-size:${f.toFixed(2)}em"><em>${n}</em>${w}</span>`;
    };
    const wm = d.topWords.me || [], wt = d.topWords.ta || [];
    const col = (title, arr, max, cls) => `
      <div class="wc-col"><div class="wc-t">${title}</div><div class="wc-tags">${
        arr.length ? arr.map(x => tag(x.w, x.n, max, cls)).join('') : '<span class="wd empty">暂无数据</span>'
      }</div></div>`;
    return `<div class="sec-t">热词榜 · 话题画像</div>
      <div class="wc">${col('你常说的', wm, maxN(wm), 'me')}${col(`${d.person.name}常说的`, wt, maxN(wt), 'ta')}</div>`;
  }

  // ---------- 情绪基调 ----------
  function sentimentCard(d) {
    const s = d.sentiment;
    const pp = s.positivePct;
    const tone = pp >= 60 ? '正向为主' : pp >= 40 ? '起伏中性' : '负向偏多';
    const bars = s.series.map((v, i) => {
      const h = Math.max(4, v / 100 * 56);
      const c = v >= 60 ? '#4fd0ff' : v >= 40 ? '#e0bc72' : '#c26a5a';
      return `<div class="sb" title="第${i + 1}段 正向 ${v}%"><i style="height:${h.toFixed(0)}px;background:${c}"></i></div>`;
    }).join('');
    return `<div class="sec-t">情绪基调</div>
      <div class="st-head"><span class="st-num">${pp}%</span><span class="st-tone ${pp >= 60 ? 'up' : pp >= 40 ? 'mid' : 'down'}">${tone}</span><span class="st-sub">整体正向情绪占比（按 8 段时间切片）</span></div>
      <div class="st-bars">${bars}</div>`;
  }

  // ---------- 时间线（气泡式） ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function voiceBody(m) {
    const svr = m.svr || '';
    if (m.vFail) {
      return `<div class="vox dead" data-svr="${svr}"><span class="vox-ic">♪</span><span class="vox-t">${esc(m.text)}</span><span class="vox-dead">语音已失效（数据已被清理）</span></div>`;
    }
    const vt = m.vt ? `<div class="vox-vt"><span class="vt-txt">${esc(m.vt)}</span></div>` : '';
    return `<div class="vox" data-svr="${svr}"><span class="vox-head"><span class="vox-ic">♪</span><span class="vox-t">${esc(m.text)}</span></span>${vt}</div>`;
  }
  function timelineCard(d) {
    const items = d.timeline.map(m => {
      const emojiChip = m.emoji && m.en ? `<span class="img-badge emoji-chip">${esc(m.en)}</span>` : '';
      const badge = m.img ? (m.emoji ? (emojiChip || '<span class="img-badge">表情</span>') : '<span class="img-badge">图片</span>') : '';
      const videoBadge = m.video ? '<span class="img-badge video">▶ 视频</span>' : '';
      const linkBadge = m.link ? '<span class="img-badge link">🔗 链接</span>' : '';
      const thumb = m.img && !m.emoji && m.t ? `<img class="tl-img" src="${_taImgUrl('/api/img-thumb?ts=' + m.t)}" loading="lazy" onerror="this.remove()" alt="图片">` : '';
      const linkText = m.link ? (m.text || '').replace(/^\[链接\]\s*/, '') : (m.text || '');
      const body = m.voice ? voiceBody(m)
        : m.video ? (videoBadge + '<span class="vox-t">' + esc(m.text) + '</span>')
        : (m.img ? (thumb + badge) : (badge + videoBadge + linkBadge + (m.emoji && m.en ? '' : esc(linkText))));
      const _todoRaw = (m.text || '').replace(/^\[链接\]\s*/, '').replace(/^\[图片\]$/, '').replace(/^\[表情\]$/, '').replace(/^\[视频\]$/, '').replace(/^\[语音[^\]]*\]$/, '').trim();
      const todoBtn = _todoRaw ? `<button class="tl-addtodo" data-todo="${esc(_todoRaw.slice(0, 60))}" title="加入待办">＋</button>` : '';
      const editBtn = `<button class="tl-edit" title="编辑这条消息">✎</button>`;
      const editedMark = m.edited ? `<span class="tl-edited">已编辑</span>` : '';
      const fullText = m.full || m.text || '';
      return `
      <div class="tl-item ${m.from === 'me' ? 'me' : ''}" data-id="${m.id}" data-_id="${esc(m._id || '')}" data-full="${esc(fullText)}">
        <div class="t">${m.time}</div>
        <div class="bub">${body}</div>
        ${editBtn}${editedMark}${todoBtn}
      </div>`;
    }).join('');
    return `<div class="sec-t">对话时间线 · 可溯源</div><div class="tl" id="tl">${items}</div>`;
  }

  // ---------- 图片/表情统计卡 ----------
  function imgCard(d) {
    const s = d.imgStats;
    if (!s || !s.total) return '';
    return `<div class="card img-card"><div class="sec-t">图片 / 表情记录</div>
      <div class="img-stats">
        <span>图片 <b>${s.total}</b> 张</span>
        <span>我发 <b>${s.meImg}</b> · TA 发 <b>${s.taImg}</b></span>
        ${s.emojiTotal ? `<span>表情 <b>${s.emojiTotal}</b> 个</span>` : ''}
      </div></div>`;
  }

  // ---------- 喜好档案卡（自动分析 + 手动维护） ----------
  function likesCard(d) {
    const col = (side, label) => `<div class="lk-col">
      <div class="lk-t ${side}">${label}</div>
      <div class="lk-tags">${(d.likes[side] || []).map(x => `
        <span class="lk-tag ${x.manual ? 'man' : 'auto'}" data-id="${x.id}" data-side="${side}" data-text="${x.text.replace(/"/g, '&quot;')}">
          ${x.text}<em>×${x.count}</em><i class="lk-edit" title="编辑">✎</i><i class="lk-del" title="删除">×</i>
        </span>`).join('') || '<span class="lk-empty">暂无记录</span>'}
      </div>
      <button class="ab lk-add" data-side="${side}">+ 添加${label}的喜好</button>
    </div>`;
    return `<div class="sec-t">喜好档案 <span class="hint">自动分析聊天记录 · 可编辑/删除</span></div>
      <div class="lk">${col('me', '我')}${col('ta', 'TA')}</div>`;
  }

  // ---------- 纪念日卡（自动分析 + 手动维护） ----------
  function anniversariesCard(d) {
    const items = (d.anniversaries || []).map(a => `
      <div class="anv ${a.auto ? 'auto' : 'man'}" data-id="${a.id}" data-label="${(a.label || '').replace(/"/g, '&quot;')}" data-date="${a.date}">
        <div class="anv-d"><b class="anv-date" title="点击修改日期">${a.date}</b><span>${a.label}${a.auto ? ' · 自动' : ' · 手动'}</span></div>
        <div class="anv-c">${a.days === 0 ? '就是今天' : `还有 <b>${a.days}</b> 天`}</div>
        <i class="lk-edit" title="编辑">✎</i><i class="lk-del" title="删除">×</i>
      </div>`).join('');
    return `<div class="sec-t">纪念日 <span class="hint">自动分析聊天记录 · 可编辑/删除</span></div>
      <div class="anv-list">${items || '<div class="anv-empty">暂无纪念日，可手动添加</div>'}</div>
      <button class="ab lk-add" id="addAnniv">+ 添加纪念日</button>`;
  }

  // ---------- 结论卡 ----------
  function conclCard(d) {
    return `<div class="sec-t">AI 结论 · 依据可溯源</div>` + d.conclusions.map((c, ci) => `
      <div class="concl" data-i="${ci}">
        <div class="head"><span class="b ${c.level}">${c.tag}</span> ${c.title}<span class="sc">${c.score}</span></div>
        <p>${c.summary}</p>
        <span class="tog">查看依据 ↓</span>
        <div class="src">${c.refs.map(rid => {
          const m = d.timeline.find(x => x.id === rid);
          if (!m) return '';
          return `<div class="q" data-ref="${rid}">“${m.text}”<span class="t">${m.time} · ${m.from === 'me' ? '你' : d.person.name}</span></div>`;
        }).join('')}</div>
      </div>`).join('');
  }

  // ---------- 交互绑定 ----------
  function bindMain(d) {
    const pid = d.person.id;
    // 时间线「加入待办」按钮
    main.querySelectorAll('.tl-addtodo').forEach(b => b.addEventListener('click', () => {
      addTodo(b.dataset.todo);
      toast('已加入 To Do', 'ok', 2000);
    }));
    // 时间线「编辑消息」按钮：就地编辑，保存后打「已编辑」标记
    function startInlineEdit(item, mid, cur) {
      const bub = item.querySelector('.bub');
      const old = bub.innerHTML;
      bub.innerHTML = `<div class="tl-edit-box">
        <textarea class="tl-edit-ta" rows="3" placeholder="输入消息内容…">${esc(cur)}</textarea>
        <div class="tl-edit-acts"><button class="te-cancel" type="button">取消</button><button class="te-save" type="button">保存</button></div>
      </div>`;
      const ta = bub.querySelector('.tl-edit-ta');
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const cancel = () => { bub.innerHTML = old; };
      bub.querySelector('.te-cancel').addEventListener('click', cancel);
      bub.querySelector('.te-save').addEventListener('click', () => {
        const nc = ta.value.trim();
        if (!nc) { toast('内容不能为空', 'warn'); return; }
        fetch('/api/person/' + pid + '/message', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _id: mid, c: nc })
        }).then(r => r.json()).then(d => {
          if (!d.ok) { toast('保存失败：' + (d.message || '未知错误'), 'err'); return; }
          bub.textContent = nc;
          item.dataset.full = nc;
          let mark = item.querySelector('.tl-edited');
          if (!mark) { mark = document.createElement('span'); mark.className = 'tl-edited'; mark.textContent = '已编辑'; item.appendChild(mark); }
          toast('已保存', 'ok', 1500);
          refreshConclusions();
        }).catch(() => toast('保存请求失败', 'err'));
      });
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bub.querySelector('.te-save').click(); }
        if (e.key === 'Escape') cancel();
      });
    }
    main.querySelectorAll('.tl-edit').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const item = b.closest('.tl-item');
      startInlineEdit(item, item.dataset._id, item.dataset.full || '');
    }));
    // 喜好：添加
    main.querySelectorAll('.lk-add[data-side]').forEach(b => b.addEventListener('click', () => {
      const side = b.dataset.side;
      const val = prompt(`添加${side === 'me' ? '我' : 'TA'}的喜好，例如：吃火锅、看科幻片`);
      if (!val) return;
      const text = val.trim();
      if (!text) return;
      fetch('/api/person/' + pid + '/likes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', item: { side, text } })
      }).then(r => { if (!r.ok) { alert('保存失败'); return; } selectPerson(pid); });
    }));
    // 喜好：编辑 / 删除（事件委托）
    main.querySelectorAll('.lk-tag').forEach(tag => {
      tag.querySelector('.lk-edit').addEventListener('click', e => {
        e.stopPropagation();
        const val = prompt('编辑喜好内容：', tag.dataset.text);
        if (!val) return;
        const text = val.trim();
        if (!text) return;
        fetch('/api/person/' + pid + '/likes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: tag.dataset.id, side: tag.dataset.side, text } })
        }).then(r => { if (!r.ok) { alert('保存失败'); return; } selectPerson(pid); });
      });
      tag.querySelector('.lk-del').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`删除喜好「${tag.dataset.text}」？`)) return;
        fetch('/api/person/' + pid + '/likes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'del', item: { id: tag.dataset.id, side: tag.dataset.side } })
        }).then(r => { if (!r.ok) { alert('删除失败'); return; } selectPerson(pid); });
      });
    });
    // 纪念日：添加
    const addAnniv = main.querySelector('#addAnniv');
    if (addAnniv) addAnniv.addEventListener('click', () => {
      const label = prompt('纪念日名称（例如：在一起、生日）：', '纪念日');
      if (!label) return;
      const val = prompt('日期（格式 YYYY-MM-DD 或 MM-DD，例如 2024-08-15）：');
      if (!val) return;
      const date = val.trim();
      if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 YYYY-MM-DD 或 MM-DD'); return; }
      fetch('/api/person/' + pid + '/anniversaries', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', item: { label, date } })
      }).then(r => { if (!r.ok) { alert('保存失败'); return; } selectPerson(pid); });
    });
    // 纪念日：编辑 / 删除
    main.querySelectorAll('.anv').forEach(anv => {
      // 点击日期：仅修改时间
      anv.querySelector('.anv-date').addEventListener('click', e => {
        e.stopPropagation();
        const val = prompt('修改日期（YYYY-MM-DD 或 MM-DD）：', anv.dataset.date);
        if (!val) return;
        const date = val.trim();
        if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 YYYY-MM-DD 或 MM-DD'); return; }
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: anv.dataset.id, label: anv.dataset.label, date } })
        }).then(r => { if (!r.ok) { alert('保存失败'); return; } selectPerson(pid); });
      });
      anv.querySelector('.lk-edit').addEventListener('click', e => {
        e.stopPropagation();
        const label = prompt('纪念日名称：', anv.dataset.label);
        if (!label) return;
        const val = prompt('日期（YYYY-MM-DD 或 MM-DD）：', anv.dataset.date);
        if (!val) return;
        const date = val.trim();
        if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 YYYY-MM-DD 或 MM-DD'); return; }
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: anv.dataset.id, label, date } })
        }).then(r => { if (!r.ok) { alert('保存失败'); return; } selectPerson(pid); });
      });
      anv.querySelector('.lk-del').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`删除纪念日「${anv.dataset.label} · ${anv.dataset.date}」？`)) return;
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'del', item: { id: anv.dataset.id } })
        }).then(r => { if (!r.ok) { alert('删除失败'); return; } selectPerson(pid); });
      });
    });
    main.querySelectorAll('.tog').forEach(t => t.addEventListener('click', () => {
      const c = t.closest('.concl');
      c.classList.toggle('open');
      t.textContent = c.classList.contains('open') ? '收起依据 ↑' : '查看依据 ↓';
    }));
    main.querySelectorAll('.q').forEach(q => q.addEventListener('click', () => {
      const id = q.dataset.ref;
      const item = $('#tl').querySelector(`.tl-item[data-id="${id}"]`);
      if (!item) return;
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item.classList.add('flash');
      setTimeout(() => item.classList.remove('flash'), 1700);
      main.querySelectorAll('.tl-item.hl').forEach(x => x.classList.remove('hl'));
      item.classList.add('hl');
    }));

    // ---------- 语音：折叠 / 转写 / 编辑（局部更新，不整页刷新） ----------
    let reanalyzing = false;
    function refreshConclusions() {
      // 静默重算 AI 结论 + 锐评，仅局部替换对应区块
      if (reanalyzing) return;
      reanalyzing = true;
      fetch('/api/person/' + pid + '/reanalyze', { method: 'POST' })
        .then(r => r.json()).then(() => fetch('/api/person/' + pid).then(r => r.json()))
        .then(d2 => {
          const roastEl = document.querySelector('.roast');
          if (roastEl && d2.roast && d2.roast.lines && d2.roast.lines.length) {
            const div = document.createElement('div');
            div.innerHTML = roastCard(d2);
            roastEl.replaceWith(div.firstElementChild);
          }
          const cw = document.querySelector('#conclCardWrap');
          if (cw && d2.conclusions) {
            const div = document.createElement('div');
            div.innerHTML = `<div class="card">${conclCard(d2)}</div>`;
            cw.replaceWith(div.firstElementChild);
          }
        })
        .catch(() => {})
        .finally(() => { reanalyzing = false; });
    }


  }


  // ---------- 新建联系人（抓取版：仅按昵称） ----------
  function bindImportOne() {
    const btn = $('#importOne');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if ($('#importOneModal')) return;
      const box = document.createElement('div');
      box.id = 'importOneModal';
      box.className = 'modal-mask';
      box.innerHTML = `<div class="modal">
        <div class="m-head">新建联系人<b class="m-x" title="关闭">×</b></div>
        <div class="m-sub">只需输入对方昵称（备注名），聊天记录通过「多选→复制」导入，无需账号 ID。</div>
        <label class="m-lab">昵称</label>
        <input id="ioName" class="m-inp" type="text" placeholder="例如：那抹煋铖" autocomplete="off">
        <div class="m-actions"><button class="m-cancel" id="ioCancel">取消</button><button class="m-ok" id="ioOk">创建</button></div>
      </div>`;
      document.body.appendChild(box);
      requestAnimationFrame(() => box.classList.add('open'));
      const close = () => box.remove();
      box.querySelector('.m-x').addEventListener('click', close);
      box.querySelector('#ioCancel').addEventListener('click', close);
      box.addEventListener('click', e => { if (e.target === box) close(); });
      const submit = () => {
        const nm = $('#ioName').value.trim();
        if (!nm) { toast('请输入联系人昵称', 'warn'); return; }
        const ok = $('#ioOk'); ok.disabled = true; ok.textContent = '创建中…';
        fetch('/api/person', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) })
          .then(async r => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { toast('创建失败：' + (d.message || '该昵称可能已存在'), 'err', 5000); ok.disabled = false; ok.textContent = '创建'; return; }
            close();
            toast(`已创建「${d.name}」，点「📋 导入聊天记录」开始导入`, 'ok', 5000);
            loadPersons().then(() => selectPerson(d.id));
          })
          .catch(() => { toast('创建失败，请重试', 'err'); ok.disabled = false; ok.textContent = '创建'; });
      };
      box.querySelector('#ioOk').addEventListener('click', submit);
      $('#ioName').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      $('#ioName').focus();
    });
  }

  // ---------- 全量批量语音转写（全局触发） ----------

  // 数据完整性审计：启动 + 轮询 + 汇总提示

  // 审计结果面板


  // ================= 主题色 + 设置 =================
  const THEMES = [
    { id: 'blue', name: '蓝', c1: '#4fd0ff', c2: '#e0bc72', grass: false },
    { id: 'green', name: '绿', c1: '#7ee0a3', c2: '#b7d97a', grass: true },
    { id: 'purple', name: '紫', c1: '#c08bff', c2: '#d9b8ff', grass: false },
    { id: 'rose', name: '粉', c1: '#ff7ba0', c2: '#ffb3c6', grass: false },
    { id: 'amber', name: '橙', c1: '#ffb54a', c2: '#ffd27a', grass: false },
    { id: 'teal', name: '青', c1: '#5fe0c8', c2: '#8fe0cf', grass: false }
  ];
  function hexToRgb(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(hex, pct) { // pct>0 向白，pct<0 向黑
    const r = hexToRgb(hex);
    if (!r) return hex;
    const f = pct > 0 ? (v => Math.round(v + (255 - v) * pct)) : (v => Math.round(v * (1 + pct)));
    return '#' + r.map(f).map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  function getC1() {
    try { return localStorage.getItem('ta_love_custom_c1') || getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || '#4fd0ff'; }
    catch (e) { return '#4fd0ff'; }
  }
  function getC2() {
    try { return localStorage.getItem('ta_love_custom_c2') || getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#e0bc72'; }
    catch (e) { return '#e0bc72'; }
  }
  function applyCustomColor(c1, c2) {
    const root = document.documentElement;
    const r1 = hexToRgb(c1), r2 = hexToRgb(c2);
    if (r1) { root.style.setProperty('--cyan', c1); root.style.setProperty('--accent-rgb', r1.join(',')); root.style.setProperty('--cyan-deep', shade(c1, -0.28)); }
    if (r2) { root.style.setProperty('--gold', c2); root.style.setProperty('--gold-rgb', r2.join(',')); root.style.setProperty('--gold-hi', shade(c2, 0.18)); }
    try { localStorage.setItem('ta_love_custom_c1', c1); localStorage.setItem('ta_love_custom_c2', c2); } catch (e) {}
    buildGrass();
  }
  function clearCustomColor() {
    const root = document.documentElement;
    ['--cyan', '--accent-rgb', '--cyan-deep', '--gold', '--gold-rgb', '--gold-hi'].forEach(v => root.style.removeProperty(v));
    try { localStorage.removeItem('ta_love_custom_c1'); localStorage.removeItem('ta_love_custom_c2'); } catch (e) {}
  }
  function applyTheme(id) {
    const t = THEMES.find(x => x.id === id) ? id : 'blue';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('ta_love_theme', t); } catch (e) {}
    buildGrass();
  }
  // 长草彩蛋：仅在绿色主题下、且开关打开时显示
  // 用像素坐标画细草叶（避免 preserveAspectRatio 横向拉伸把草叶拉成宽扁带子）
  function buildGrass() {
    const field = $('#grassField');
    if (!field) return;
    let on = false;
    try { on = localStorage.getItem('ta_love_grass') === '1'; } catch (e) {}
    const isGreen = document.documentElement.getAttribute('data-theme') === 'green';
    const show = on && isGreen;
    document.body.classList.toggle('grass-on', show);
    if (!show) { field.innerHTML = ''; return; }

    const W = Math.max(320, document.documentElement.clientWidth || 1200);
    const H = 46;
    // 确定性伪随机（同一种子结果稳定，避免每次渲染抖动）
    const rnd = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

    // 一片叶：从 (x,H) 起、向上弯曲到 (x+lean*1.4, H-h)，细 1.4~1.7px
    const blade = (x, h, lean, hue, light, w, fd) =>
      `<path class="blade" style="--fd:${(rnd(fd) * 1.5).toFixed(2)}s" d="M${x.toFixed(1)} ${H} q ${lean.toFixed(1)} ${(-h * 0.55).toFixed(1)} ${(lean * 1.4).toFixed(1)} ${(-h).toFixed(1)}" stroke="hsl(${hue}, ${60 + rnd(fd) * 12}%, ${light}%)" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;

    // 一层草：n 丛、每丛 3 片叶（独立弯曲/颜色/相位）；后排暗矮，前排亮高
    const layer = (n, hMin, hMax, hue, light, w) => {
      let out = '';
      const step = W / n;
      for (let i = 0; i < n; i++) {
        const x = i * step + step * 0.5 + (rnd(i * 13 + 1) - 0.5) * step * 0.75;
        const h = hMin + rnd(i * 3 + 1) * (hMax - hMin);
        const lean = (rnd(i * 7 + 2) - 0.5) * 11;
        const ph = (rnd(i * 23 + 7) * 2.6).toFixed(2);
        const gd = (rnd(i * 31 + 5) * 0.85).toFixed(2);
        out += `<g class="tuft" style="--sway:${(3.6 + rnd(i * 41) * 3).toFixed(2)}s;--ph:${ph}s;--gd:${gd}s">
          ${blade(x - 2.5, h, lean, hue, light, w, i * 53)}
          ${blade(x, h * 0.82, lean + 3, hue, light + 9, w * 0.9, i * 61 + 3)}
          ${blade(x + 2.5, h * 0.62, lean - 3, hue, light - 7, w, i * 71 + 6)}
        </g>`;
      }
      return `<g class="row">${out}</g>`;
    };

    // 萤火虫：尾灯 + 呼吸光晕 + 拖尾（HTML 元素定位，避免 SVG 拉伸）
    let fireflies = '';
    for (let i = 0; i < 7; i++) {
      const fx = (3 + rnd(i * 53 + 11) * 94).toFixed(1);
      const fd = (5 + rnd(i * 67) * 6).toFixed(2);
      const fdl = (rnd(i * 83) * 5).toFixed(2);
      fireflies += `<span class="firefly" style="left:${fx}%;--fd:${fd}s;--fdl:${fdl}s"><i class="ff-glow"></i><i class="ff-core"></i><i class="ff-tail"></i></span>`;
    }

    field.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      ${layer(32, 15, 25, 118, 44, 1.6)}
      ${layer(21, 22, 34, 127, 58, 1.5)}
    </svg>${fireflies}`;
  }
  // 窗口尺寸变化时重画（防抖），避免草被拉伸错位
  let _grassRsz = null;
  window.addEventListener('resize', () => {
    clearTimeout(_grassRsz);
    _grassRsz = setTimeout(buildGrass, 160);
  });
  function bindSettings() {
    const btn = $('#settingsBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      let panel = $('#settingsPanel');
      if (panel) { panel.classList.toggle('open'); return; }
      panel = document.createElement('div');
      panel.id = 'settingsPanel';
      panel.className = 'settings-panel';
      document.body.appendChild(panel);
      const render = () => {
        const curTheme = document.documentElement.getAttribute('data-theme') || 'blue';
        let grassOn = false; try { grassOn = localStorage.getItem('ta_love_grass') === '1'; } catch (e) {}
        // 彩蛋仅在绿色主题下出现（不直白提示，当隐藏彩蛋）
        const easterSection = curTheme === 'green'
          ? `<div><div class="sp-sec">小彩蛋</div>
              <label class="sp-opt"><input type="checkbox" id="spGrass" ${grassOn ? 'checked' : ''}> 在底部种点什么</label>
            </div>`
          : '';
        panel.innerHTML = `<div class="sp-head"><b>设置</b><span class="sp-x">×</span></div>
          <div><div class="sp-sec">主题颜色（预设）</div><div class="sp-themes">${THEMES.map(t => `<span class="sp-swatch ${curTheme === t.id ? 'on' : ''}" data-theme="${t.id}" title="${t.name}" style="background:linear-gradient(135deg,${t.c1},${t.c2})"><i>${t.name}</i></span>`).join('')}</div></div>
          <div><div class="sp-sec">自定义颜色（自由取色）</div>
            <div class="sp-colors">
              <label class="sp-color">主色 <input type="color" id="spC1" value="${getC1()}"></label>
              <label class="sp-color">辅色 <input type="color" id="spC2" value="${getC2()}"></label>
              <button class="sp-reset" id="spColorReset">恢复预设</button>
            </div>
            <div class="sp-hint">主色=标题/你的方向色，辅色=TA 的方向色。选预设主题会清除自定义色。</div>
          </div>
          ${easterSection}
          <div><div class="sp-sec">我的昵称</div>
            <div class="sp-hint">剪贴板导入时，昵称等于此项的消息记为「我」，其余记为「TA」。</div>
            <input id="spMyNick" class="m-inp" type="text" value="${esc(settings.myNick || '')}" placeholder="例如：那抹煋铖">
          </div>
          <div class="sp-actions"><button class="sp-save" id="spSave">保存</button></div>`;
        panel.querySelector('.sp-x').addEventListener('click', () => panel.classList.remove('open'));
        panel.querySelectorAll('.sp-swatch').forEach(sw => sw.addEventListener('click', () => {
          clearCustomColor();
          applyTheme(sw.dataset.theme);
          render();
        }));
        panel.querySelector('#spC1').addEventListener('input', e => applyCustomColor(e.target.value, getC2()));
        panel.querySelector('#spC2').addEventListener('input', e => applyCustomColor(getC1(), e.target.value));
        panel.querySelector('#spColorReset').addEventListener('click', () => {
          clearCustomColor();
          applyTheme(document.documentElement.getAttribute('data-theme') || 'blue');
          render();
        });
        const grassEl = panel.querySelector('#spGrass');
        if (grassEl) grassEl.addEventListener('change', e => {
          try { localStorage.setItem('ta_love_grass', e.target.checked ? '1' : '0'); } catch (err) {}
          buildGrass();
        });
        panel.querySelector('#spSave').addEventListener('click', () => {
          const myNick = panel.querySelector('#spMyNick').value.trim();
          const btn2 = panel.querySelector('#spSave');
          btn2.disabled = true; btn2.textContent = '保存中…';
          fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myNick }) })
            .then(r => r.json())
            .then(d => { if (d.ok) { settings = d.settings || settings; toast('设置已保存', 'ok', 2000); panel.classList.remove('open'); } else toast('保存失败', 'err'); })
            .catch(() => toast('保存失败', 'err'))
            .finally(() => { btn2.disabled = false; btn2.textContent = '保存'; });
        });
      };
      render();
      panel.classList.add('open');
    });
  }
  function loadSettings() {
    fetch('/api/settings').then(r => r.json()).then(s => { if (s && typeof s === 'object') settings = Object.assign(settings, s); }).catch(() => {});
  }
  function loadTheme() {
    let t = 'blue';
    try { t = localStorage.getItem('ta_love_theme') || 'blue'; } catch (e) {}
    applyTheme(t);
    let c1 = '', c2 = '';
    try { c1 = localStorage.getItem('ta_love_custom_c1') || ''; c2 = localStorage.getItem('ta_love_custom_c2') || ''; } catch (e) {}
    if (c1 || c2) applyCustomColor(c1 || getC1(), c2 || getC2());
    buildGrass();
  }

  // ================= 左侧 To-Do =================
  const TODO_KEY = 'ta_love_todos';
  function loadTodos() {
    try { todos = JSON.parse(localStorage.getItem(TODO_KEY) || '[]'); } catch (e) { todos = []; }
    if (!Array.isArray(todos)) todos = [];
  }
  function saveTodos() {
    try { localStorage.setItem(TODO_KEY, JSON.stringify(todos)); } catch (e) {}
  }
  function addTodo(text) {
    const t = String(text || '').trim();
    if (!t) return;
    todos.unshift({ id: 'td-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), text: t, done: false, ts: Date.now() });
    saveTodos();
    renderTodos();
  }
  function todoRoast() {
    const total = todos.length;
    const done = todos.filter(t => t.done).length;
    const open = total - done;
    if (!total) return { title: 'AI 锐评', body: '一个待办都没有？要么是人生赢家，要么是拖延症早期，选一个吧。', advice: '从右侧聊天记录点「＋」，把答应过 TA 的事记下来，别光靠脑子。' };
    const rate = done / total;
    let body, advice;
    if (rate === 1) {
      body = `全部 ${total} 件都清空了，执行力堪比投喂自己收藏夹却一个没看的反义词。`;
      advice = '干得漂亮。继续保持，或者给自己留点喘息，别把日程塞太满。';
    } else if (rate >= 0.5) {
      body = `已完成 ${done}/${total}（${Math.round(rate * 100)}%），剩下 ${open} 件在等你宠幸。`;
      advice = `优先啃最上面的「${(todos.find(t => !t.done) || {}).text || '待办'}」，先难后易，收尾会快很多。`;
    } else if (done === 0) {
      body = `${total} 件待办一件都没动，flag 立得比朋友圈的减肥宣言还快。`;
      advice = `别贪多，先挑 1 件 5 分钟内能做完的，勾掉它，惯性就起来了。`;
    } else {
      body = `才完成 ${done}/${total}（${Math.round(rate * 100)}%），进展慢得像 2G 加载。`;
      advice = `先把最老的那件处理掉，越攒越沉，越沉越想拖。`;
    }
    return { title: 'AI 锐评 · 执行进度', body, advice };
  }
  function renderTodos() {
    const listEl = $('#todoList');
    const countEl = $('#todoCount');
    const roastEl = $('#todoRoast');
    if (countEl) {
      const open = todos.filter(t => !t.done).length;
      countEl.textContent = open ? open + ' 待办' : (todos.length ? '全清 ✓' : '');
    }
    if (!listEl) return;
    if (!todos.length) {
      listEl.innerHTML = '<div class="todo-empty">还没有待办<br>右侧聊天记录点「＋」<br>或在上方手动输入</div>';
    } else {
      listEl.innerHTML = todos.map(t => `
        <div class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
          <span class="todo-text">${esc(t.text)}</span>
          <svg class="todo-strike" viewBox="0 0 100 10" preserveAspectRatio="none">
            <path class="s1" pathLength="100" d="M1 5 C 25 2.5, 60 7, 99 5"/>
            <path class="s2" pathLength="100" d="M3 6.5 C 40 8.5, 75 3.5, 97 6.5"/>
          </svg>
          <span class="todo-check" title="完成">${t.done ? '✓' : ''}</span>
          <button class="todo-del" title="删除">×</button>
        </div>`).join('');
      listEl.querySelectorAll('.todo-item').forEach(item => {
        item.querySelector('.todo-check').addEventListener('click', () => {
          const t = todos.find(x => x.id === item.dataset.id);
          if (t) { t.done = !t.done; saveTodos(); renderTodos(); }
        });
        item.querySelector('.todo-del').addEventListener('click', () => {
          todos = todos.filter(x => x.id !== item.dataset.id);
          saveTodos(); renderTodos();
        });
      });
    }
    if (roastEl) {
      const r = todoRoast();
      roastEl.innerHTML = `<span class="tr-tt">${esc(r.title)}</span>${esc(r.body)}<span class="tr-advice">狗头军师：${esc(r.advice)}</span>`;
    }
  }
  function bindTodo() {
    const addBtn = $('#todoAdd');
    const input = $('#todoInput');
    const collapse = $('#todoCollapse');
    const panel = $('#todoPanel');
    if (addBtn) addBtn.addEventListener('click', () => { const v = input.value; if (v.trim()) { addTodo(v); input.value = ''; } });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = input.value; if (v.trim()) { addTodo(v); input.value = ''; } } });
    if (collapse && panel) collapse.addEventListener('click', () => panel.classList.toggle('collapsed'));
  }

  // ---------- 剪贴板抓取导入 ----------
  function promptMyNick(nicks, onDone) {
    if (document.getElementById('myNickModal')) return;
    const box = document.createElement('div');
    box.id = 'myNickModal';
    box.className = 'modal-mask open';
    const opts = (nicks || []).map(n => `<button class="mn-opt" data-nick="${esc(n)}">${esc(n)}</button>`).join('');
    box.innerHTML = `<div class="modal">
      <div class="m-head">哪个是你自己？<b class="m-x" title="关闭">×</b></div>
      <div class="m-sub">复制的内容里有这些昵称，选一个代表「你」，其余会记为「TA」。</div>
      <div class="mn-opts">${opts}</div>
      <label class="m-lab">或手动输入你的昵称</label>
      <input id="mnInput" class="m-inp" type="text" placeholder="我的昵称" autocomplete="off">
      <div class="m-actions"><button class="m-cancel" id="mnCancel">跳过</button><button class="m-ok" id="mnOk">确定</button></div>
    </div>`;
    document.body.appendChild(box);
    const close = () => { box.remove(); if (onDone) onDone(); };
    const save = v => {
      const val = (v || '').trim();
      if (!val) { toast('请输入昵称或选择一个', 'warn'); return; }
      settings.myNick = val;
      fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myNick: val }) })
        .then(r => r.json()).then(() => { toast('已记住你的昵称', 'ok', 2000); box.remove(); if (onDone) onDone(val); })
        .catch(() => { toast('保存失败', 'err'); box.remove(); if (onDone) onDone(); });
    };
    box.querySelector('.m-x').addEventListener('click', close);
    box.querySelector('#mnCancel').addEventListener('click', close);
    box.querySelectorAll('.mn-opt').forEach(o => o.addEventListener('click', () => save(o.dataset.nick)));
    box.querySelector('#mnOk').addEventListener('click', () => save($('#mnInput').value));
    box.querySelector('#mnInput').addEventListener('keydown', e => { if (e.key === 'Enter') save($('#mnInput').value); });
  }
  function bindGrab() {
    const btn = $('#grabBtn');
    const status = $('#grabStatus');
    if (!btn) return;
    let timer = null;
    const doImport = (raw) => {
      if (!raw || !current) return;
      const myNick = settings.myNick || '';
      fetch('/api/grab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: current.id, text: raw, myNick })
      }).then(r => r.json()).then(d => {
        if (!d.ok) { toast('导入失败：' + (d.message || '未知错误'), 'err'); return; }
        status.textContent = `已导入 ${d.added} 条新消息（共 ${d.total} 条）`;
        toast(`导入完成：新增 ${d.added} 条消息`, 'ok', 4000);
        loadPersons().then(() => { if (current) selectPerson(current.id); });
      }).catch(() => toast('导入请求失败', 'err'));
    };
    const stop = () => {
      fetch('/api/grab/stop', { method: 'POST' }).then(r => r.json()).then(d => {
        clearInterval(timer); timer = null;
        btn.classList.remove('running');
        btn.textContent = '📋 导入聊天记录';
        status.classList.remove('running');
        if (!d.count) { status.textContent = '未捕获到内容，请先在聊天软件里多选→复制'; toast('未捕获到内容', 'warn', 4000); return; }
        const raw = d.raw || '';
        const nicks = d.nicks || [];
        // 未设置我的昵称且有多个昵称 → 先问哪个是你，再导入
        if (!settings.myNick && nicks.length > 1) {
          promptMyNick(nicks, () => doImport(raw));
        } else {
          doImport(raw);
        }
      }).catch(() => {});
    };
    btn.addEventListener('click', () => {
      if (btn.classList.contains('running')) { stop(); return; }
      if (!current) { toast('请先在左侧选中一个联系人', 'warn'); return; }
      fetch('/api/grab/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId: current.id }) })
        .then(r => r.json()).then(d => {
          if (!d.ok) { toast('启动失败', 'err'); return; }
          btn.classList.add('running');
          btn.textContent = '⏹ 停止并导入';
          status.textContent = `监听中… 去聊天软件对「${current.name}」多选→复制（每次复制自动累积）`;
          status.classList.add('running');
          timer = setInterval(() => {
            fetch('/api/grab/status').then(r => r.json()).then(s => {
              if (s.running) btn.textContent = '⏹ 停止并导入（已捕获 ' + s.count + ' 段）';
            }).catch(() => {});
          }, 800);
        }).catch(() => toast('启动失败', 'err'));
    });
  }

  // 首次启动：使用声明弹窗（须同意后才能使用；同意后记入 localStorage，下次不再弹）
  (function showDisclaimer() {
    try { if (localStorage.getItem('ta_love_disclaimer') === '1') return; } catch (e) {}
    const ov = document.createElement('div');
    ov.id = 'disclaimer-ov';
    ov.innerHTML = `<div class="ta-login-ov" style="z-index:20000">
      <div class="ta-login" style="width:480px;max-width:94vw">
        <div class="ta-login-t">使用声明</div>
        <div class="ta-login-s" style="text-align:left;line-height:1.75;max-height:46vh;overflow:auto">
          本工具<strong>仅供学习、技术研究使用</strong>，仅限个人 / 家庭内部自用，禁止任何商业用途或违法违规用途。<br><br>
          请在<strong>你自己的电脑、你自己的聊天数据</strong>上使用，不得用于查看、分析、导出或传播他人的聊天记录与个人信息。<br><br>
          本软件仅处理你<strong>主动复制 / 提供的聊天文字</strong>与本地图片缓存，不做破解、不联网上传。<br><br>
          所有数据仅在你本机处理，不会上传到任何服务器。<br><br>
          <strong>二次转载、传播本软件或其衍生版本，由转载 / 传播者自行承担由此产生的一切法律责任。</strong>
        </div>
        <div class="ta-login-err" id="disclaimer-err"></div>
        <button class="ta-login-btn" id="disclaimer-ok">我已阅读并同意</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#disclaimer-ok').addEventListener('click', () => {
      try { localStorage.setItem('ta_love_disclaimer', '1'); } catch (e) {}
      ov.remove();
    });
  })();
  loadTheme();
  loadSettings();
  loadTodos();
  renderTodos();
  bindTodo();
  bindSettings();
  bindGrab();
  bindAi();
  pollAiStatus();
  setInterval(pollAiStatus, 3000); // 轮询模型下载进度/就绪态
  loadPersons();
  bindImportOne();
})();
