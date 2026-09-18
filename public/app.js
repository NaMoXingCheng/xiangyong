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

  // 缩略图加载失败就把节点摘掉。用全局捕获监听代替内联 onerror="..."，
  // 一是为了能开严格的 CSP（内联事件处理器会被 script-src 'self' 拦掉），
  // 二是不用给每次 render 的 innerHTML 都挂一遍。
  // 说明：缩略图没缓存时服务端会回一张透明占位图，正常走不到这里；
  // 真正会失败的是网络中断 / 缓存被清那类情况，兜一下免得留一个破图图标。
  document.addEventListener('error', function (e) {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.classList.contains('tl-img')) t.remove();
  }, true);

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
  // ---------- 音效 ----------
  // 统一从这一处发声。sound.js 没加载成功 / 用户关了声音 / 音频上下文还没被
  // 用户手势唤醒 —— 三种情况都必须静默收场，绝不能因为放个音效把功能搞挂。
  const sfx = (n) => { try { if (window.SOUND) window.SOUND.sfx(n); } catch (e) {} };

  // 通用点击音：可点的东西点一下就有回应。
  // 挂在**冒泡**阶段（document 上最后跑），这样：
  //   - 具体交互可以先把自己的声音放掉，再设 e.__sfx 把通用 tap 拦掉，不会两声叠一起
  //   - 元素上写 data-sfx="page" 可以换一个音；写 "none" 则完全不出声
  const CLICKABLE = 'button, [role="button"], .person, .chip, .tl-item, .gd-card';
  document.addEventListener('click', (e) => {
    if (e.__sfx) return;
    const el = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null;
    if (!el || el.disabled) return;
    const want = el.getAttribute && el.getAttribute('data-sfx');
    if (want === 'none') return;
    sfx(want || 'tap');
  });

  // 报告背景音乐。和音效一样，关了开关 / 没解锁时都得静默收场。
  const startMusic = () => { try { if (window.SOUND) window.SOUND.music.start(); } catch (e) {} };
  const stopMusic = () => { try { if (window.SOUND) window.SOUND.music.stop(); } catch (e) {} };

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
    // 结果类提示配声音，纯信息类不配 —— 提示条本来就密，每条都响会烦
    if (type === 'ok') sfx('ok');
    else if (type === 'error' || type === 'warn') sfx('err');
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  // ---------- 通用对话框（替代 prompt / confirm / alert） ----------
  // 三个原生弹窗在 Electron 里都不能用或不该用：
  //   · prompt()  直接抛 "prompt() is and will not be supported"，功能全废
  //   · confirm() 能用，但会同步阻塞渲染进程，且是系统白框，跟暗色界面割裂
  //   · alert()   同上，而且只是通知，用 toast 更轻
  // 所以统一走这里：自绘的暗色直角卡片，Promise 化，不阻塞。
  //   askText(标题, 默认值, 说明) → 返回去掉首尾空格的字符串；取消返回 null
  //   askOk(标题, 说明, {danger}) → 返回 true / false
  //   say(标题, 说明)             → 纯通知，无返回值
  function dlg(o) {
    o = o || {};
    return new Promise(resolve => {
      const mode = o.mode || 'confirm';           // text | confirm | say
      const mask = document.createElement('div');
      mask.className = 'modal-mask dlg-mask';
      mask.innerHTML = `<div class="modal dlg">
        <div class="m-head">${o.title || ''}</div>
        ${o.sub ? `<div class="m-sub">${o.sub}</div>` : ''}
        ${mode === 'text' ? '<input class="m-inp dlg-inp" type="text" autocomplete="off">' : ''}
        <div class="m-actions">
          ${mode === 'say' ? '' : `<button class="m-cancel dlg-no" type="button">取消</button>`}
          <button class="m-ok dlg-yes${o.danger ? ' danger' : ''}" type="button">${o.okText || '确定'}</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('open'));
      sfx('open');

      const inp = mask.querySelector('.dlg-inp');
      if (inp) inp.value = o.value == null ? '' : String(o.value);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        // 取消/ESC/点遮罩才出「关闭」声；确认走的是后续动作（多半自己有提示音），
        // 两声叠在一起会糊成一团
        if (!val) sfx('close');
        mask.classList.remove('open');
        setTimeout(() => mask.remove(), 220);
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(mode === 'text' ? null : false); }
        else if (e.key === 'Enter' && (!inp || document.activeElement === inp)) { e.preventDefault(); submit(); }
      };
      const submit = () => {
        if (mode === 'text') {
          const v = inp.value.trim();
          if (!v) { toast('内容不能为空', 'warn', 2000); inp.focus(); return; }
          finish(v);
        } else if (mode === 'say') { finish(true); }
        else { finish(true); }
      };

      mask.querySelector('.dlg-yes').addEventListener('click', submit);
      const noBtn = mask.querySelector('.dlg-no');
      if (noBtn) noBtn.addEventListener('click', () => finish(mode === 'text' ? null : false));
      mask.addEventListener('click', e => { if (e.target === mask) finish(mode === 'text' ? null : false); });
      document.addEventListener('keydown', onKey, true);
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    });
  }
  const askText = (title, value, sub) => dlg({ mode: 'text', title, value, sub, okText: '保存' })
    .then(v => (v === null || v === false ? null : String(v).trim()));
  const askOk = (title, sub, extra) => dlg(Object.assign({ mode: 'confirm', title, sub }, extra || {}))
    .then(v => v === true);
  const say = (title, sub) => dlg({ mode: 'say', title, sub, okText: '知道了' });

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
  // ---------- 联系人右键菜单：自定义头像 ----------
  // 三个入口（图片 / 表情 / 文字）+ 恢复默认。图片走 FileReader 转 dataURL 传给服务端落盘，
  // 前端不存 base64，persons.json 里只留文件名。
  const AVATAR_EMOJI = ['🌸', '🌙', '🍀', '⭐', '🐱', '🐰', '🦊', '🐻', '🐼', '🐧', '🍓', '🍰',
    '☕', '🎧', '🎈', '💐', '🌊', '🔥', '❄️', '🍁', '🌻', '🫧', '🕊️', '💫'];

  // 当前右键点开的是谁。菜单一关就作废，避免「刚给 A 设完，回头粘一下却设到了 B」。
  let avaTarget = null;

  function closeAvatarMenu() {
    const m = document.getElementById('ava-menu');
    if (m) m.remove();
    avaTarget = null;
  }
  // 常驻的收起逻辑：点菜单外面、滚轮、Esc 都收。不来回挂载/解绑监听器，少一处漏解绑的坑。
  if (!window.__avaGlobal) {
    window.__avaGlobal = true;
    document.addEventListener('mousedown', e => {
      if (!e.target.closest || !e.target.closest('#ava-menu')) closeAvatarMenu();
    }, true);
    window.addEventListener('scroll', closeAvatarMenu, true);
    window.addEventListener('resize', closeAvatarMenu);
  }

  function saveAvatar(p, body) {
    return fetch('/api/person/' + p.id + '/avatar', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || '设置头像失败', 'err'); return; }
      p.avatar = d.avatar;
      p.avatarImg = d.avatarImg;
      renderList();
      toast('头像已更新', 'ok', 1800);
    }).catch(() => toast('设置头像失败', 'err'));
  }

  // 图片统一走这里：居中裁成正方形 + 缩到 512，再转 dataURL。
  // 手机照片动辄 6~10MB，直传会撞服务端 4MB 上限（用户只看到「图片太大」）；裁方是因为
  // 头像是圆形，不裁的话长图会被压成一条。白底 + jpeg 是刻意的：照片用不上透明通道，
  // 而 png 的 dataURL 体积会翻好几倍。
  const AVATAR_PX = 512;
  function readAvatarImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('这不是图片'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (fn, v) => { URL.revokeObjectURL(url); fn(v); };
      img.onload = () => {
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          if (!side) throw new Error('图片读不出来');
          const c = document.createElement('canvas');
          c.width = c.height = AVATAR_PX;
          const g = c.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
          g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
          done(resolve, c.toDataURL('image/jpeg', .88));
        } catch (e) { done(reject, e); }
      };
      img.onerror = () => done(reject, new Error('读不出这张图'));
      img.src = url;
    });
  }

  // 任何来源的图片都收口到这里（选文件 / 拖进来 / 粘贴），少三份重复的错误提示
  function useAvatarImage(p, file) {
    readAvatarImage(file)
      .then(dataUrl => saveAvatar(p, { img: dataUrl }))
      .catch(e => toast(e.message || '这张图用不了', 'err'));
  }

  function pickAvatarFile(p) {
    let inp = document.getElementById('ava-file');
    if (!inp) {
      inp = document.createElement('input');
      inp.id = 'ava-file';
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = () => { if (inp.files && inp.files[0]) useAvatarImage(p, inp.files[0]); };
    inp.click();
  }

  function openAvatarMenu(p, x, y) {
    closeAvatarMenu();
    const menu = document.createElement('div');
    menu.id = 'ava-menu';
    menu.className = 'ava-menu';
    menu.innerHTML = `
      <div class="am-t">${esc(p.name)} · 头像</div>
      <div class="am-g" id="amEmoji">${AVATAR_EMOJI.map(e => `<b data-e="${e}">${e}</b>`).join('')}</div>
      <div class="am-i" data-a="img">🖼　上传照片（或拖进窗口 / Ctrl+V）</div>
      <div class="am-i" data-a="text">✎　用文字（1～2 个字）</div>
      <div class="am-i" data-a="reset">↺　恢复默认</div>`;
    document.body.appendChild(menu);
    avaTarget = p;   // 供 Ctrl+V 粘贴用
    // 贴边不越界：先量再摆
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';

    menu.querySelectorAll('.am-g b').forEach(b => b.addEventListener('click', () => {
      closeAvatarMenu();
      saveAvatar(p, { text: b.dataset.e });
    }));
    menu.querySelectorAll('.am-i').forEach(it => it.addEventListener('click', async () => {
      const a = it.dataset.a;
      closeAvatarMenu();
      if (a === 'img') return pickAvatarFile(p);
      if (a === 'reset') return saveAvatar(p, { reset: true });
      const v = await askText('用文字做头像', p.avatar || '', '1～2 个字最合适，中文英文 emoji 都行');
      if (v) saveAvatar(p, { text: v });
    }));
  }

  // ---------- 拖照片 / 粘贴照片换头像 ----------
  // 粘贴走 avaTarget（菜单开着才生效）；拖拽直接认拖到哪一行，不用先右键。
  const anyImage = (dt) => {
    if (!dt) return null;
    for (const f of dt.files || []) if (/^image\//.test(f.type || '')) return f;
    for (const it of dt.items || []) if (it.kind === 'file' && /^image\//.test(it.type || '')) return it.getAsFile();
    return null;
  };
  if (!window.__avaDrop) {
    window.__avaDrop = true;
    document.addEventListener('paste', e => {
      if (!avaTarget) return;
      const f = anyImage(e.clipboardData);
      if (!f) return;
      e.preventDefault();
      const p = avaTarget;
      closeAvatarMenu();
      useAvatarImage(p, f);
    });
    // 拖到联系人那一条上就换那一条，拖到别处不拦（别把整窗拖放行为都吃掉）
    const row = (t) => t && t.closest && t.closest('.person');
    document.addEventListener('dragover', e => {
      const el = row(e.target);
      if (!el || !anyImage(e.dataTransfer)) return;
      e.preventDefault();
      el.classList.add('drop-ava');
    });
    document.addEventListener('dragleave', e => {
      const el = row(e.target);
      if (el) el.classList.remove('drop-ava');
    });
    document.addEventListener('drop', e => {
      const el = row(e.target);
      if (el) el.classList.remove('drop-ava');
      const f = el && anyImage(e.dataTransfer);
      if (!f) return;
      e.preventDefault();
      const p = persons.find(x => x.id === el.dataset.id);
      if (p && !p.group) useAvatarImage(p, f);
    });
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
          : `<div class="ava${p.avatarImg ? ' hasimg' : ''}" title="右键换头像">
              ${p.avatarImg ? `<img class="avimg" src="/api/avatar/${p.id}" alt="">` : ''}
              <span class="avfallback">${esc(p.avatar || (p.name || '?')[0] || '?')}</span>
            </div>`}
        <div class="nm-wrap"><div class="nm" title="${p.name}">${p.name}${p.group ? ' <span class="grp">群聊</span>' : ''}</div><div class="sub">${p.msgs || 0} 条消息${!p.group && p.coldDays >= 3 ? ` <span class="cold">已 ${p.coldDays} 天未联系</span>` : ''}</div></div>
        <div class="ops">
          <span class="op pin ${pins.includes(p.id) ? 'on' : ''}" title="置顶">${pins.includes(p.id) ? '★' : '☆'}</span>
          <span class="op del" title="删除">×</span>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('.person').forEach(el => {
      el.addEventListener('click', (e) => {
        // 换联系人是个「大动作」，用 nav 而不是通用 tap。
        // 标记 e.__sfx 让 document 上那个通用点击音闭嘴，别两声叠一起。
        e.__sfx = 1;
        sfx('nav');
        selectPerson(el.dataset.id);
      });
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const p = persons.find(x => x.id === el.dataset.id);
        if (p && !p.group) openAvatarMenu(p, e.clientX, e.clientY);
      });
      const img = el.querySelector('.avimg');
      if (img) img.addEventListener('error', () => { img.parentNode.classList.remove('hasimg'); });
      el.querySelector('.pin').addEventListener('click', e => {
        e.stopPropagation();
        const id = el.dataset.id;
        fetch('/api/person/' + id + '/pin', { method: 'PUT' }).then(r => {
          if (!r.ok) { toast('置顶失败', 'err'); return; }
          const p = persons.find(x => x.id === id);
          p.pinned = !p.pinned;
          renderList();
        });
      });
      el.querySelector('.del').addEventListener('click', async e => {
        e.stopPropagation();
        const p = persons.find(x => x.id === el.dataset.id);
        const yes = await askOk(
          `删除联系人「${p.name}」？`,
          '将同时移除其聊天缓存。可恢复的备份会保留在 trash.json，需要时能找回。',
          { okText: '删除', danger: true }
        );
        if (!yes) return;
        fetch('/api/person/' + el.dataset.id, { method: 'DELETE' }).then(r => {
          if (!r.ok) { toast('删除失败', 'err'); return; }
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
      ${reportEntry(d)}
      ${d.roast && d.roast.lines && d.roast.lines.length ? roastCard(d) : ''}
      <div class="row">
        <div class="card col">${gaugesCard(d)}</div>
        <div class="card col radar-card">${radarCard(d)}</div>
      </div>
      <div class="row">
        <div class="card col">${likesCard(d)}</div>
        <div class="card col">${anniversariesCard(d)}</div>
      </div>
      <div class="card pm-card">${promisesCard(d)}</div>
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
    bindRoastAi(d);
    bindAdviceAi(d);
    bindReportEntry(d);
    mountPromises(d);            // 承诺是异步读的（要跟服务端要最新状态），回来再补画卡片
    bindWordsAi(d);
    if (aiState.ready) tryEnrichAi(d, id); // 本地AI 就绪时自动补「情感基调 / 关系洞察」
    // 联系人切换后右侧自动回到顶部，避免用户手动上翻
    window.scrollTo({ top: 0, behavior: 'smooth' });
    main.scrollTop = 0;
  }

  // ---------- AI 锐评（模板打底 + 可一键让本地模型重写） ----------
  function roastCard(d) {
    const r = d.roast;
    const rows = r.lines.map(l => `<div class="roast-line">${esc(l)}</div>`).join('');
    // 狗头军师也走真 AI：和锐评一样给一个按钮，各写各的，互不影响
    const advice = r.advice ? `<div class="roast-advice">
        <div class="ra-head"><span class="ra-tt">${esc(r.adviceTitle || '狗头军师 · 相处建议')}</span>
          <button class="roast-ai-btn" id="adviceAiBtn" title="让本地 AI 按真实统计现写一条建议，每次都不一样">✦ AI 建议</button></div>
        <div class="ra-body" id="adviceBody">${esc(r.advice)}</div></div>` : '';
    return `<div class="roast" data-roast-id="${esc(d.id || '')}">
      <div class="roast-head">
        <span class="roast-tt">${esc(r.title)}</span><span class="roast-sub">${esc(r.sub)}</span>
        <button class="roast-ai-btn" id="roastAiBtn" title="用本地 AI 重新写一版，每次都不一样">✦ AI 重写</button>
      </div>
      <div class="roast-lines">${rows}</div>
      ${advice}
    </div>`;
  }
  // 狗头军师建议：独立按钮、独立接口。模板那条一直留着当兜底，模型失败就退回它。
  function bindAdviceAi(d) {
    const btn = document.getElementById('adviceAiBtn');
    const body = document.getElementById('adviceBody');
    if (!btn || !body) return;
    const backup = body.textContent;
    btn.addEventListener('click', async () => {
      if (!aiState.ready) {
        toast('先选一个本地 AI 模型，再让它出主意', 'info', 3200);
        openAiPanel();
        return;
      }
      btn.disabled = true;
      btn.textContent = '想主意中…';
      const card = btn.closest('.roast');
      if (card) card.classList.add('ai-thinking');
      try {
        const resp = await fetch('/api/ai/advice', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ d }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
        body.innerHTML = esc(j.advice)
          + (j.grounded === false ? '<div class="ra-caveat">这版出现了统计里没有的数字，参考着看</div>' : '');
        btn.textContent = '✦ 换个主意';
      } catch (e) {
        body.textContent = backup;
        btn.textContent = '✦ AI 建议';
        toast('生成失败：' + (e && e.message ? e.message : '未知错误'), 'error', 4200);
      } finally {
        btn.disabled = false;
        if (card) card.classList.remove('ai-thinking');
      }
    });
  }
  // 「AI 重写」：把模板锐评换成模型现场写的，内容只在本机生成
  function bindRoastAi(d) {
    const btn = document.getElementById('roastAiBtn');
    if (!btn) return;
    const original = btn.textContent;
    btn.addEventListener('click', async () => {
      if (!aiState.ready) {
        toast('先选一个本地 AI 模型，再让它写锐评', 'info', 3200);
        openAiPanel();
        return;
      }
      const card = btn.closest('.roast');
      if (!card) return;
      const holder = card.querySelector('.roast-lines');
      const backup = holder ? holder.innerHTML : '';
      btn.disabled = true;
      btn.textContent = '生成中…';
      card.classList.add('ai-thinking');
      try {
        const resp = await fetch('/api/ai/roast', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ d }),
        });
        const j = await resp.json();
        if (!resp.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
        if (holder) {
          // 模型没引用到真实数字时明确说出来——编造的数据比模板更误导人
          const caveat = j.grounded === false
            ? '<div class="roast-line ai-caveat">这一版模型没引用到统计里的真实数字，参考着看，别当真。</div>'
            : '';
          holder.innerHTML = `<div class="roast-line ai-made">${esc(j.roast)}</div>${caveat}`;
        }
        const sub = card.querySelector('.roast-sub');
        if (sub) sub.textContent = 'AI 现场生成 · ' + (j.model || '');
        btn.textContent = '✦ 换一版';
        toast('已由 ' + (j.model || '本地模型') + ' 生成', 'info', 2400);
      } catch (e) {
        if (holder) holder.innerHTML = backup;
        btn.textContent = original;
        toast('生成失败：' + (e && e.message ? e.message : '未知错误'), 'error', 4200);
      } finally {
        btn.disabled = false;
        card.classList.remove('ai-thinking');
      }
    });
  }

  // ---------- 本地小AI：状态条 / 模型选择 / 生成 ----------
  function aiModelLabel() {
    const s = aiState;
    if (!s.ready) return '';
    // 只剩内置后端了，所以不再按 backend 分岔：
    // 优先用档位元数据说人话（「内置 3B」），拿不到才退回模型文件名。
    const t = (s.tiers || []).find(x => x.key === s.tier);
    return t ? ('内置 ' + t.params) : (s.model || '内置模型');
  }
  // 剩余时间说人话：秒 → 「不到 1 分钟 / 12 分钟 / 1 小时 5 分」
  function fmtEta(sec) {
    if (!sec || sec <= 0) return '';
    if (sec < 60) return '不到 1 分钟';
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  // 已经闲置多久了（显存那栏用）
  const fmtIdle = sec => (!sec || sec < 60 ? Math.round(sec || 0) + ' 秒' : Math.round(sec / 60) + ' 分钟');
  function renderAiBar() {
    const bar = $('#aiBar');
    if (!bar) return;
    const s = aiState;
    let cls = 'ai-bar', html;
    if (s.verifying) {
      // 算哈希就几秒，但必须给个说法，否则用户会以为卡死了
      cls += ' busy';
      html = '🧠 正在校验模型完整性…<span class="ai-bar-sub">校验通过才会启用，防止用到损坏的文件</span>';
    } else if (s.downloading) {
      cls += ' busy';
      const mb = s.downloadedMB || 0, tot = s.totalMB || 0;
      const size = tot
        ? (mb >= 1024 ? (mb / 1024).toFixed(2) : mb) + ' / ' + (tot / 1024).toFixed(1) + ' GB'
        : '';
      const spd = s.speedMBps ? ' · ' + s.speedMBps + ' MB/s' : '';
      const eta = s.etaSec > 0 ? ' · 还剩 ' + fmtEta(s.etaSec) : '';
      html = '🧠 下载内置模型 ' + (s.progress || 0) + '%<span class="ai-bar-sub">' + esc(size + spd + eta) + '</span>';
    } else if (s.ready) {
      cls += ' ok';
      // 模型还在，但闲下来就把显存还回去了 —— 这事必须说出来，
      // 否则用户看到「就绪」却觉得自己显存被动过，反而更慌。
      const back = s.evicted
        ? '已归还显存（闲置 ' + fmtIdle(s.idleSec) + '）· 下次使用自动装回，不用你管'
        : '正在占用显存 · 闲置 ' + (s.idleLimit || 120) + ' 秒后自动归还';
      html = '🧠 内置模型 · ' + esc(aiModelLabel())
        + '<span class="ai-bar-sub">' + esc(back) + '</span>';
    } else if (s.installed) {
      cls += ' ok';
      html = '🧠 内置模型已下载 · 点此加载';
    } else {
      cls += ' off';
      html = '🧠 本地AI 未启用 · 点此选择模型';
    }
    const title = s.ready
      ? ('当前模型：' + (s.model || '') + '　点击更换')
      : '点击选择本地 AI 模型';
    // 这个函数挂在 3 秒轮询上，而「未启用」「已下载未加载」正是最常见的两个长期状态，
    // 它们每次算出来的输出完全一样。innerHTML 赋值不比较内容 —— 传进去的字符串哪怕
    // 一模一样，也会把整棵子树拆了重建：过渡动画从头开始、用户选中的文字被清掉。
    // 所以先比签名，没变就彻底不动。
    const sig = cls + '\u0000' + title + '\u0000' + html;
    if (bar._sig === sig) return;
    bar._sig = sig;
    bar.className = cls;
    bar.title = title;
    bar.innerHTML = html;
  }
  function pollAiStatus() {
    return fetch('/api/ai/status').then(r => r.json()).then(s => { aiState = s; renderAiBar(); return s; }).catch(() => null);
  }
  // 下载期间持续轮询（每 1.2 秒），下完自动停，并提示用户
  let aiPollTimer = null;
  function startAiPolling() {
    if (aiPollTimer) return;
    aiPollTimer = setInterval(async () => {
      const s = await pollAiStatus();
      if (!s) return;
      if (!s.downloading && !s.verifying) {
        clearInterval(aiPollTimer); aiPollTimer = null;
        if (s.ready) {
          toast('本地 AI 已就绪 · ' + aiModelLabel(), 'info', 4000);
          if (current) tryEnrichAi(current, current.id);
        } else if (s.error) {
          toast(s.error, 'error', 6000);
        }
      }
    }, 1200);
  }
  function bindAi() {
    const bar = $('#aiBar');
    if (bar) bar.addEventListener('click', openAiPanel);
  }

  // 模型选择面板：三档内置模型
  function openAiPanel() {
    const old = document.getElementById('aiPanel');
    if (old) { old.remove(); return; }
    const s = aiState;

    const tiersHtml = (s.tiers || []).map(t => `
      <button class="ai-opt${t.installed ? ' inst' : ''}${s.backend === 'builtin' && s.tier === t.key ? ' cur' : ''}" data-tier="${t.key}">
        <span class="ao-name">${esc(t.label)} · ${esc(t.params)}${t.installed ? '<i>已下载</i>' : ''}</span>
        <span class="ao-meta">下载 ${t.sizeGB} GB · 建议显存 ≥ ${t.minVRAM} GB · ${esc(t.desc)}</span>
      </button>`).join('');

    const ov = document.createElement('div');
    ov.id = 'aiPanel';
    ov.className = 'ai-panel-mask';
    ov.innerHTML = `<div class="ai-panel">
      <div class="ai-panel-head">
        <span class="ap-tt">本地 AI 模型</span>
        <button class="ap-close" id="apClose">×</button>
      </div>
      <div class="ai-panel-body">
        <div class="ap-sec">
          <div class="ap-sec-tt">选择档位<span class="ap-tag gray">按显存挑</span></div>
          <div class="ap-grid">${tiersHtml}</div>
        </div>
        <div class="ap-foot">
          锐评提示词已内置，模型选好就自动生效，你不用填任何东西。所有推理都在本机完成，聊天内容不会上传。<br>
          下载中断不要紧，再点一次会接着下（断点续传）。显存不够也能跑，只是会慢一些。
        </div>
      </div>
    </div>`;
    document.body.appendChild(ov);

    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.id === 'apClose') ov.remove();
    });

    ov.querySelectorAll('.ai-opt[data-tier]').forEach(btn => btn.addEventListener('click', async () => {
      const key = btn.dataset.tier;
      const t = (aiState.tiers || []).find(x => x.key === key) || {};
      toast('正在准备内置模型 · ' + (t.params || '') + '（约 ' + (t.sizeGB || '') + ' GB，仅首次需要下载）', 'info', 4500);
      const p = document.getElementById('aiPanel'); if (p) p.remove();
      try {
        const r = await fetch('/api/ai/setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: key }),
        });
        aiState = await r.json();
        renderAiBar();
        startAiPolling();       // 下载中：持续刷新进度，下完自动提示
      } catch (e) { toast('准备失败：' + e.message, 'error', 3200); }
    }));
  }
  function aiExtrasCard(d, ai) {
    const mood = ai.mood ? `<div class="ai-mood"><span class="ai-mood-tt">情感基调</span><span class="ai-mood-body">${esc(ai.mood)}</span></div>` : '';
    const insights = (ai.insights && ai.insights.length) ? `<div class="ai-insight"><span class="ra-tt">关系洞察</span>${ai.insights.map(l => `<div class="ai-insight-line">${esc(l)}</div>`).join('')}</div>` : '';
    if (!mood && !insights) return '';
    return `<div class="roast ai-extras">
      <div class="roast-head"><span class="roast-tt">本地AI · 情感与洞察</span><span class="roast-sub">${esc(ai.model || '本地生成')}</span></div>
      ${mood}
      ${insights}
    </div>`;
  }
  async function tryEnrichAi(d, id) {
    if (d.group || !aiState.ready) return; // 没启用本地AI 就不自动跑，省算力
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
  // 三个指数的构成（口径见 score.js）。注释要跟实现说同一件事，
  // 不然用户点开「分数怎么算的」看到的是一套早就改过的旧说法。
  const GAUGE_HINT = {
    active: '你在推进这段关系上用了多少力：谁先开口 · 消息占比 · 连发 · 回复速度差 · 消息长度比。分数高不等于关系好，也可能只是你一个人在推',
    loved: 'TA 给你的温度：TA 的消息占比与主动次数 · 回复速度 · 晚安/早安 · 关心你的频率，再按「是不是你单方面撑起对话」打折',
    cold: 'TA 的敷衍与回避：「嗯/哦/好」这类单字短回 · 你发完话两小时内没人接 · 超过半小时才回的比例'
  };
  // 分数构成：每一路信号实际是多少、贡献了几分。分数必须能解释。
  function partsHtml(g) {
    if (!g || !g.parts || !g.parts.length) return '';
    return `<div class="g-parts">` + g.parts.map(p => {
      const sign = p.delta > 0 ? '+' : '';
      const cls = p.delta > 0 ? ' up' : p.delta < 0 ? ' dn' : '';
      return `<span class="gp${cls}">${p.label} <b>${p.text}</b> <i>${sign}${p.delta}</i></span>`;
    }).join('') + `</div>`;
  }
  // 对称性：两个人在共同经营，还是一个人在推（借鉴「她不一样」的单相思提醒）
  function symLine(d) {
    if (typeof d.symmetry !== 'number') return '';
    const s = d.symmetry;
    const word = s >= 75 ? '两个人在共同经营' : s >= 50 ? '略有倾斜，还算平衡' : '基本是单方面在推';
    return `<div class="g-sym">对称性 <b>${s}</b> 分 · ${word}</div>`;
  }
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
    }).join('') + symLine(d) + `<details class="note-f"><summary>分数怎么算的</summary>${d.gauges.map(g => `<div class="nh"><b>${g.label}</b>${GAUGE_HINT[g.key] || ''}</div>${partsHtml(g)}`).join('')}</details></div>`;
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
      // 雷达图上的分值：字体和 SVG 里的趋势轴一个口径（Cambria + 等高数字），
      // Georgia 的老式数字在这里会让「74」和「18」看起来不一样高
      return `<text x="${xm.toFixed(1)}" y="${ym.toFixed(1)}" text-anchor="middle" fill="#4fd0ff" font-size="8" font-family="Cambria,Times New Roman,serif" font-variant-numeric="lining-nums tabular-nums">${st.me[i]}</text>` +
             `<text x="${xt.toFixed(1)}" y="${yt.toFixed(1)}" text-anchor="middle" fill="#e0bc72" font-size="8" font-family="Cambria,Times New Roman,serif" font-variant-numeric="lining-nums tabular-nums">${st.ta[i]}</text>`;
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
    return `<div class="wc-head">
        <div class="sec-t">热词榜 · 话题画像</div>
        <button class="wc-ai" id="wcAi" type="button" title="用本地模型把高频词归纳成几个话题，全部在本机跑">✦ AI 归纳话题</button>
      </div>
      <div class="wc">${col('你常说的', wm, maxN(wm), 'me')}${col(`${d.person.name}常说的`, wt, maxN(wt), 'ta')}</div>
      <div class="wc-topics" id="wcTopics"></div>`;
  }

  // AI 话题结果渲染（词表由服务端白名单过滤过，这里直接画）
  function paintTopics(list, d) {
    const box = $('#wcTopics');
    if (!box) return;
    box.innerHTML = `<div class="wt-h"><span class="wt-t">AI 归纳的话题</span>
        <span class="wt-again" id="wtAgain">换一批</span></div>` +
      list.map(t => `<div class="wt-row">
          <span class="wt-k">${esc(t.label)}</span>
          <span class="wt-w">${t.words.map(w => `<b>${esc(w)}</b>`).join('')}</span>
        </div>`).join('');
    const again = box.querySelector('#wtAgain');
    if (again) again.addEventListener('click', () => runTopicsAi(d, true));
  }

  function runTopicsAi(d, force) {
    const btn = $('#wcAi');
    const box = $('#wcTopics');
    if (!aiState.ready) { toast('本地 AI 还没启用 · 在左侧「本地小AI」里开一下再回来', 'warn', 4200); return; }
    if (btn) { btn.classList.add('busy'); btn.textContent = '正在归纳…'; }
    fetch('/api/topwords/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: d.person.id, force: !!force })
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || 'AI 归纳失败', 'err', 4200); return; }
      if (!j.topics || !j.topics.length) { toast('这次没归纳出话题，再点一次试试', 'warn', 3600); return; }
      paintTopics(j.topics, d);
    }).catch(() => toast('AI 归纳失败', 'err'))
      .then(() => { if (btn) { btn.classList.remove('busy'); btn.textContent = '✦ AI 归纳话题'; } });
  }

  function bindWordsAi(d) {
    const btn = $('#wcAi');
    if (btn) btn.addEventListener('click', () => runTopicsAi(d, false));
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
      const thumb = m.img && !m.emoji && m.t ? `<img class="tl-img" src="${_taImgUrl('/api/img-thumb?ts=' + m.t)}" loading="lazy" alt="图片">` : '';
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

  // ==================== 承诺追踪 ====================
  // 数据由服务端合成（自动识别 + 用户手动维护），所以每次改动都要回服务端再重绘，
  // 不在这里做本地乐观更新 —— 免得和后端的 id 对不上。
  let promiseState = null;

  function fmtDayShort(ts) {
    if (!ts) return '';
    const d2 = new Date(ts > 1e12 ? ts : ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return p(d2.getMonth() + 1) + '-' + p(d2.getDate());   // 统一两位，免得出现「10-01 / 9-23」这样参差不齐
  }
  // 秒 → 人话（"3 秒" / "12 分钟" / "2 小时"）
  function fmtDur(sec) {
    if (!sec) return '—';
    if (sec < 60) return Math.round(sec) + ' 秒';
    if (sec < 3600) return Math.round(sec / 60) + ' 分钟';
    return (sec / 3600).toFixed(1) + ' 小时';
  }

  function promisesCard(d) {
    const st = promiseState;
    if (!st) return `<div class="sec-t">承诺追踪</div><div class="pm-empty">读取中…</div>`;
    const items = st.items || [];
    const doneN = items.filter(x => x.done).length;
    const taName = (d.person && d.person.name) || 'TA';
    const rows = items.map(it => `
      <div class="pm-item ${it.done ? 'done' : ''}" data-id="${esc(it.id)}">
        <button class="pm-check" title="${it.done ? '取消兑现' : '标记已兑现'}">${it.done ? '✓' : ''}</button>
        <span class="pm-who ${it.who === 'me' ? 'me' : 'ta'}">${it.who === 'me' ? '我' : esc(taName)}</span>
        <span class="pm-mid"><span class="pm-text">${esc(it.text)}<svg class="pm-strike" viewBox="0 0 100 10" preserveAspectRatio="none">
          <path class="s1" pathLength="100" d="M1 5 C 25 2.5, 60 7, 99 5"/>
          <path class="s2" pathLength="100" d="M3 6.5 C 40 8.5, 75 3.5, 97 6.5"/>
        </svg></span></span>
        <span class="pm-date">${fmtDayShort(it.at)}</span>
        <i class="pm-edit" title="改内容">✎</i>
        <button class="pm-del" title="删除（之后重新分析也不会再出现）">×</button>
      </div>`).join('');
    const arch = doneN ? `<div class="pm-archive">
        <span class="pa-tip">已兑现 ${doneN} · ${st.keepForever ? '永久保留' : `完成满 ${st.keepDays} 天自动清空`}</span>
        <button class="pa-btn pa-keep${st.keepForever ? ' on' : ''}" id="pmKeep" title="${st.keepForever ? '已永久保留 · 点击恢复自动清理' : '开启后已兑现的永久保留'}">保留</button>
        <button class="pa-btn pa-clear" id="pmClear" title="立即清空所有已兑现">清空</button>
      </div>` : '';
    return `<div class="sec-t">承诺追踪<span class="pm-count">兑现 <b>${doneN}</b><span class="pm-slash">/</span><b>${items.length}</b></span></div>
      <div class="pm-list">${rows || '<div class="pm-empty">还没认出承诺。<br>说过「下周带你去…」这类话就会被记下来。</div>'}</div>
      <div class="pm-add">
        <select class="pm-who-sel" title="这条是谁许的">
          <option value="me">我</option>
          <option value="ta">${esc(taName)}</option>
        </select>
        <input class="pm-input" type="text" placeholder="加一条承诺…" autocomplete="off">
        <button class="pm-add-btn" title="添加">＋</button>
      </div>
      ${arch}`;
  }

  function pmPost(pid, body) {
    return fetch('/api/promises/' + pid, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json()).then(s => { if (s && s.ok) promiseState = s; return s; }).catch(() => null);
  }

  async function mountPromises(d) {
    const card = main.querySelector('.pm-card');
    if (!card) return;
    try {
      const r = await fetch('/api/promises/' + d.person.id);
      const s = await r.json();
      promiseState = (s && s.ok) ? s : { items: [], keepDays: 15, keepForever: false };
    } catch (e) {
      promiseState = { items: [], keepDays: 15, keepForever: false };
    }
    paintPromises(d);
  }

  function paintPromises(d) {
    const card = main.querySelector('.pm-card');
    if (!card) return;
    card.innerHTML = promisesCard(d);
    wirePromises(d);
  }

  function wirePromises(d) {
    const pid = d.person.id;
    const card = main.querySelector('.pm-card');
    if (!card) return;

    card.querySelectorAll('.pm-item').forEach(item => {
      const id = item.dataset.id;
      const cur = (promiseState.items || []).find(x => x.id === id);

      const check = item.querySelector('.pm-check');
      if (check) check.addEventListener('click', async () => {
        const wasDone = !!(cur && cur.done);
        await pmPost(pid, { op: 'update', id, done: !wasDone });
        if (!wasDone) toast('已兑现 ✓ 说好的事做到了', 'info', 2400);
        paintPromises(d);
      });

      const del = item.querySelector('.pm-del');
      if (del) del.addEventListener('click', async () => {
        await pmPost(pid, { op: 'delete', id });
        toast('已删掉这条', 'info', 1800);
        paintPromises(d);
      });

      const edit = item.querySelector('.pm-edit');
      if (edit) edit.addEventListener('click', () => startPmEdit(d, item, id));
    });

    const addBtn = card.querySelector('.pm-add-btn');
    const input = card.querySelector('.pm-input');
    const whoSel = card.querySelector('.pm-who-sel');
    const doAdd = async () => {
      const t = (input && input.value || '').trim();
      if (!t) { if (input) input.focus(); return; }
      await pmPost(pid, { op: 'add', text: t, who: whoSel ? whoSel.value : 'me' });
      toast('已加进承诺清单', 'info', 2000);
      paintPromises(d);
    };
    if (addBtn) addBtn.addEventListener('click', doAdd);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

    const keep = card.querySelector('#pmKeep');
    if (keep) keep.addEventListener('click', async () => {
      const on = !(promiseState.keepForever);
      await pmPost(pid, { op: 'keep', value: on });
      toast(on ? '已开启永久保留：兑现过的不会再被清掉' : '已恢复自动清理：完成满 15 天自动移除', 'info', 3000);
      paintPromises(d);
    });
    const clr = card.querySelector('#pmClear');
    if (clr) clr.addEventListener('click', async () => {
      const n = (promiseState.items || []).filter(x => x.done).length;
      await pmPost(pid, { op: 'clearDone' });
      toast(`已清空 ${n} 条已兑现`, 'info', 2200);
      paintPromises(d);
    });
  }

  // 就地改文字：回车确认，Esc 放弃。改过的条目在后端打 edited 标记，重算分析不会再被覆盖
  function startPmEdit(d, item, id) {
    const span = item.querySelector('.pm-text');
    if (!span || item.querySelector('.pm-edit-input')) return;
    const cur = (promiseState.items || []).find(x => x.id === id);
    const old = cur ? cur.text : span.textContent;
    const inp = document.createElement('input');
    inp.className = 'pm-edit-input';
    inp.value = old;
    span.replaceWith(inp);
    inp.focus();
    inp.select();
    let settled = false;
    const commit = async (save) => {
      if (settled) return;
      settled = true;
      const t = (inp.value || '').trim();
      if (save && t && t !== old) {
        await pmPost(d.person.id, { op: 'update', id, text: t });
        toast('已改好 · 之后重新分析不会被覆盖', 'info', 2600);
      }
      paintPromises(d);
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', () => commit(true));
  }

  // ==================== 年度报告：折叠入口 + 全屏自动放映 ====================
  // 节奏：3.8 秒太快来不及看，6.8 秒又太长，取中间值。每页 dur 是「原始权重」，
  // 实际停留 = (本页 dur 或 RS_BASE) × RS_PACE —— 想整体调快调慢只动 RS_PACE 一个数。
  // 转场：旧页淡出 + 新页淡入，两层短暂并存（容器绝对定位，不会互相挤位），不再一次性 innerHTML 硬切。
  // 每页版式不同（封面 / 巨型数字 / 左右对照 / 排行 / 大字词 / 结尾），靠 .k-* 类切换。
  const RS_PACE = .78, RS_BASE = 6800, RS_OUT = 560, RS_IDLE = 2200;
  // 页数按「这份聊天记录撑得起多少内容」走，不再固定 12 页：最少 9 页，最多 15 页。
  const RS_MIN = 9, RS_MAX = 15;
  const rs = { slides: [], i: 0, timer: null, paused: false, ended: false, idle: null, aiBless: null, blessSeq: 0 };

  const rsNum = v => Number(v || 0).toLocaleString();
  // 光学字号只数数字位数：「6,633」按 4 位算，逗号不算。
  const rsLen = s => Math.min(10, Math.max(1, String(s == null ? '' : s).replace(/\D/g, '').length || 1));
  const rsTs = v => new Date(v > 1e12 ? v : (v || 0) * 1000);
  // 年鉴式日期：2025.09.18。
  // 原来写「2025 年 9 月 18 日」，中文一多整行又扁又长还爱折行；
  // 点分写法短一半，配上衬线等宽数字排出来才像年鉴。
  const rsDate = v => {
    if (!v) return '';
    const d2 = rsTs(v), p = n => String(n).padStart(2, '0');
    return d2.getFullYear() + '.' + p(d2.getMonth() + 1) + '.' + p(d2.getDate());
  };
  // 秒 → {数量, 单位}。拆开是为了让单位单独成节点按基线对齐（混在一个节点里字号和基线都对不齐）。
  const rsDur = sec => {
    if (!sec) return { n: '—', u: '' };
    if (sec < 60) return { n: String(Math.round(sec)), u: '秒' };
    if (sec < 3600) return { n: String(Math.round(sec / 60)), u: '分钟' };
    return { n: (sec / 3600).toFixed(1), u: '小时' };
  };

  // ---------- 结尾寄语：先由数据出「分析」，再给一段「祝福」 ----------
  // 规则版是保底（打开就有、不依赖 AI）；AI 就绪时前台看到的是模型现写的那版。
  // 每句都必须挂在真实数字上 —— 否则一封通用祝福信放在哪份报告里都一样，那就没意义了。
  //
  // 只留「一句分析 + 一句祝福」。试过三句：在 1500×960 下直接把印章和落款挤出屏幕了，
  // 结尾页是收尾，不是把统计再念一遍。
  function rsBless(d, r, items, done) {
    const name = (d.person && d.person.name) || 'TA';
    const g = {};
    for (const x of (d.gauges || [])) g[x.key] = x.value;
    const head = [];
    // 按「最该被说出来」排序：先冷落，再主动度，最后才是细节
    if (d.coldDays >= 7) head.push(`已经 ${d.coldDays} 天没说话了。距离从来不是问题，习惯沉默才是。`);
    else if (d.coldDays >= 3) head.push(`有 ${d.coldDays} 天没联系了，别等一个"合适的时机"，一句话就够了。`);
    else if (g.active >= 65) head.push(`这一年多数话头是你先开的（${rsNum(r.meStarts)} 次），肯先开口的人不多，别把这份主动磨没了。`);
    else if (g.active <= 35) head.push(`这一年多数话头是${name}先开的，能被人惦记着、主动找你 ${rsNum(r.taStarts)} 次，挺难得的。`);
    else head.push(`你开了 ${rsNum(r.meStarts)} 次话，${name} 开了 ${rsNum(r.taStarts)} 次，有来有回比一时的热烈更扛时间。`);

    if (r.spanDays >= 300) head.push(`聊了 ${rsNum(r.spanDays)} 天，长跑最怕的不是争吵，是"理所当然"，记得偶尔说声谢谢。`);
    else if (r.lateNightMsgs >= 80) head.push(`有 ${rsNum(r.lateNightMsgs)} 条消息发在 22 点以后，愿意在困的时候陪你说几句的人，要记着。`);
    else if (items.length) {
      const rest = items.length - done;
      head.push(rest === 0
        ? `记下的 ${items.length} 件事全做到了，说到做到的人，日子不会差。`
        : `还有 ${rest} 件答应过的事在路上，不用急，一件一件来。`);
    }

    const tail = '愿你们说话一直不用斟酌措辞，也愿你想开口的时候，那头永远有人接得住。';
    // 第一句分析（最重要那条）固定带上；后面那句只在还放得下时才加
    let out = head[0] || '';
    if (head[1] && out.length + head[1].length + tail.length <= 104) out += head[1];
    return out + tail;
  }

  function reportEntry(d) {
    const r = d.report || {};
    return `<div class="report-entry" id="reportEntry" title="点开像放映一样自动翻页（全屏 · Esc 退出）">
      <span class="re-rhombus"></span>
      <span class="re-tt">年度报告</span>
      <span class="re-sub">${r.spanDays || 0} 天 · ${(r.totalMsgs || 0).toLocaleString()} 条消息 · 自动放映</span>
      <span class="re-play">▶</span>
    </div>`;
  }

  // 页数：由「这份记录有多厚」决定，最少 RS_MIN 页、最多 RS_MAX 页。
  // 固定 12 页的问题是两头都别扭：聊得少的被硬塞几页空数据，聊得多的又把好内容砍了。
  function slideTarget(d) {
    const r = d.report || {};
    const items = (promiseState && promiseState.items) || [];
    const likes = ((d.likes && d.likes.me) || []).length + ((d.likes && d.likes.ta) || []).length;
    const is = r.imgStats || {};
    // 六个侧面各算一分，加满 6：够不够厚，看的是「有没有东西可讲」，不是消息越多越好
    const rich =
      (r.totalMsgs >= 3000 ? 2 : r.totalMsgs >= 800 ? 1 : 0) +
      (r.spanDays >= 300 ? 2 : r.spanDays >= 90 ? 1 : 0) +
      (r.chatTimes >= 400 ? 2 : r.chatTimes >= 100 ? 1 : 0) +
      (items.length ? 1 : 0) +
      (likes >= 3 ? 1 : 0) +
      ((is.emojiTotal || 0) >= 100 ? 1 : 0);
    return Math.max(RS_MIN, Math.min(RS_MAX, RS_MIN + rich));
  }

  // 每页一条数据。数字都来自后端 report，不在这里现算，免得和别处口径不一致。
  //
  // 取舍规则：core 页任何记录都成立，永远保留；score 页按「这份数据够不够撑起它」打分，
  // 目标页数装不下时就砍分最低的那几页。ord 只决定讲故事的顺序，不参与取舍
  // —— 按分数重排会把叙事线打乱，报告就不像一个故事了。
  function buildSlides(d, pm) {
    const r = d.report || {};
    const name = (d.person && d.person.name) || 'TA';
    const items = (pm && pm.items) || [];
    const done = items.filter(x => x.done).length;
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
    const pool = [];
    const add = o => pool.push(o);

    const y1 = rsTs(r.firstAt).getFullYear(), y2 = rsTs(r.lastAt).getFullYear();
    add({ ord: 10, core: true, layout: 'cover',
      year: y1 === y2 ? String(y1) : (y1 + ' — ' + y2),
      rng: y1 !== y2,
      big: name, sub: '与你的第 ' + rsNum(r.spanDays) + ' 天',
      d1: rsDate(r.firstAt), d2: rsDate(r.lastAt), dur: 5800 });

    add({ ord: 20, core: true, layout: 'num', kicker: '你们一共说了', num: rsNum(r.totalMsgs), unit: '条消息',
      note: '平均每天 ' + (r.dailyMsg || 0).toFixed(1) + ' 条 · 一共聊了 ' + rsNum(r.chatTimes) + ' 次' });

    // 最猛的一次：条数越大越值得单开一页
    if (r.maxSegN) add({ ord: 30, score: 3 + Math.min(5, (r.maxSegN || 0) / 20), layout: 'num',
      kicker: '最猛的一次', num: rsNum(r.maxSegN), unit: '条消息',
      note: rsDate(r.maxSegAt) + ' 那天，一口气聊到停不下来', dur: 7600 });

    const starts = (r.meStarts || 0) + (r.taStarts || 0);
    add({ ord: 40, core: true, layout: 'split', kicker: '谁先开口', dur: 6600,
      pair: [
        { k: name + '先找你', v: r.taStarts || 0, p: '占 ' + pct(r.taStarts || 0, starts) + '%', dim: (r.taStarts || 0) < (r.meStarts || 0) },
        { k: '你先找 ' + name, v: r.meStarts || 0, p: '占 ' + pct(r.meStarts || 0, starts) + '%', dim: (r.meStarts || 0) < (r.taStarts || 0) },
      ],
      bar: pct(r.taStarts || 0, starts),
      note: starts ? '一共开了 ' + rsNum(starts) + ' 次话头 · 热火朝天 ' + rsNum(r.hotSegs) + ' 次' : '' });

    // 谁话更多：两边都没说话的记录没得比
    const meN = r.meMsgs || 0, taN = r.taMsgs || 0;
    if (meN && taN) add({ ord: 50, score: 2 + Math.min(4, Math.min(meN, taN) / 250), layout: 'bars',
      kicker: '谁说得更多', dur: 6400,
      bars: [
        { k: '你', v: meN, w: pct(meN, meN + taN) },
        { k: name, v: taN, w: pct(taN, meN + taN), g: 'ta' },
      ],
      note: meN === taN ? '一模一样多，这默契有点东西'
        : ((meN > taN ? '你' : name) + '多说了 ' + rsNum(Math.abs(meN - taN)) + ' 条') });

    if (r.lateNightMsgs) add({ ord: 60, score: 2 + Math.min(4, (r.lateNightMsgs || 0) / 40), layout: 'num',
      kicker: '深夜时段', num: rsNum(r.lateNightMsgs), unit: '条消息发在 22 点后',
      note: '深夜开始聊的有 ' + rsNum(r.lateSegs) + ' 次' });

    // 深夜是谁在熬：只有两边都沾过深夜才值得对照
    if (r.meLate && r.taLate) add({ ord: 70, score: 2 + Math.min(3, Math.min(r.meLate, r.taLate) / 12), layout: 'split',
      kicker: '谁在熬夜陪你', dur: 6400,
      pair: [
        { k: '你发的深夜消息', v: rsNum(r.meLate), p: '22 点以后' },
        { k: name + '发的深夜消息', v: rsNum(r.taLate), p: '22 点以后', dim: (r.taLate || 0) < (r.meLate || 0) },
      ],
      bar: pct(r.taLate || 0, (r.meLate || 0) + (r.taLate || 0)),
      note: (r.taLate || 0) > (r.meLate || 0)
        ? (name + ' 比你更能熬，夜里的那点心事多半是 TA 先开的口')
        : '深夜的对话框里多半是你先冒的头' });

    add({ ord: 80, core: true, layout: 'split', kicker: '回消息的速度', dur: 6600,
      pair: [
        { k: name + '回你的中位数', v: fmtDur(r.taMidReply), p: '平时大概这么久' },
        { k: '你回 ' + name, v: fmtDur(r.meMidReply), p: '平时大概这么久', dim: true },
      ], note: '中位数比平均值更贴近体感，偶尔一条隔夜消息不会带偏它' });

    // 最快的一次：只有真的很快（≤60 秒）才值得拿来说
    if (r.taFastest && r.taFastest <= 60) add({ ord: 90, score: 2 + (r.taFastest <= 5 ? 3 : 0), layout: 'num',
      kicker: name + '回得最快的一次', num: rsDur(r.taFastest).n, unit: rsDur(r.taFastest).u + '就回了你',
      note: '最快的那一下，几乎是你刚发完', dur: 6400 });

    add({ ord: 100, core: true, layout: 'num', kicker: '最长的一段连续', num: rsNum(r.maxStreak), unit: '天，天天都说了话',
      note: r.maxSilence ? ('中间断得最久的一次是 ' + r.maxSilence + ' 天') : '一次都没断过' });

    if (r.maxSilence >= 5) add({ ord: 110, score: 1 + Math.min(4, r.maxSilence / 15), layout: 'num',
      kicker: '断得最久的一次', num: rsNum(r.maxSilence), unit: '天没说话',
      note: '再长的沉默也接上了，这本身就算数', dur: 6400 });

    if (items.length) add({ ord: 120, score: 4 + Math.min(3, items.length / 4), layout: 'bars', kicker: '说好的事', dur: 6800,
      bars: [
        { k: '已兑现', v: done, w: pct(done, items.length) },
        { k: '还在路上', v: items.length - done, w: 100 - pct(done, items.length) },
      ],
      note: '一共记下 ' + items.length + ' 条 · ' + (done === items.length ? '全都做到了' : '慢慢来，别催') });

    const wm = ((d.topWords && d.topWords.me) || []).slice(0, 3);
    const wt = ((d.topWords && d.topWords.ta) || []).slice(0, 3);
    if (wm.length || wt.length) add({ ord: 130, score: 4 + Math.min(3, (wm.length + wt.length) / 2), layout: 'bars',
      kicker: '说得最多的词', dur: 7200,
      bars: [...wm.map(x => ({ k: '你 · ' + x.w, v: x.n, w: 0, g: 'me' })),
             ...wt.map(x => ({ k: name + ' · ' + x.w, v: x.n, w: 0, g: 'ta' }))],
      max: Math.max(1, ...[...wm, ...wt].map(x => x.n)),
      note: '把两个人一整年的话压成几个词，大致就长这样' });

    if (wm[0]) add({ ord: 140, score: 3, layout: 'word', kicker: '你最爱说的', big: wm[0].w, dur: 6800,
      note: '你：' + (wm.map(x => x.w).join(' · ') || '—') + '　' + name + '：' + (wt.map(x => x.w).join(' · ') || '—') });

    const lk = [...((d.likes && d.likes.me) || []), ...((d.likes && d.likes.ta) || [])].slice(0, 4).map(x => x.text);
    if (lk.length) add({ ord: 150, score: 3 + Math.min(3, lk.length), layout: 'word', kicker: '你们都提过',
      big: lk[0], dur: 6800, note: lk.join(' · ') });

    // 图与表情：只有发得够多才有单独一页的价值
    const is = r.imgStats || {};
    if ((is.emojiTotal || 0) >= 30 || (is.total || 0) >= 10) add({ ord: 160, score: 2 + Math.min(4, (is.emojiTotal || 0) / 60), layout: 'bars',
      kicker: '不靠文字的那些话', dur: 6400,
      bars: [
        { k: '你发表情', v: is.meEmoji || 0, w: 0 },
        { k: name + '发表情', v: is.taEmoji || 0, w: 0, g: 'ta' },
        { k: '你发图片', v: is.meImg || 0, w: 0 },
        { k: name + '发图片', v: is.taImg || 0, w: 0, g: 'ta' },
      ],
      note: '一共 ' + rsNum((is.emojiTotal || 0) + (is.total || 0)) + ' 个表情和图片，都算在聊天的份量里' });

    if (d.nextAnniversary) add({ ord: 170, score: 3, layout: 'num', kicker: '下一件要记住的事',
      num: rsNum(d.nextAnniversary.days), unit: '天后 · ' + d.nextAnniversary.label,
      note: d.nextAnniversary.date, dur: 6200 });

    // 结尾页：分数 → 分析 → 寄语 → 落款。core，永远最后。
    const love = (d.gauges || []).find(g => g.key === 'loved');
    add({ ord: 999, core: true, layout: 'end', kicker: '这一年',
      num: love ? rsNum(love.value) : '—', unit: '分',
      note: d.coldDays >= 3 ? ('不过已经 ' + d.coldDays + ' 天没联系了') : '是被爱的程度 · 还在继续',
      bless: rsBless(d, r, items, done),
      sign: (y1 === y2 ? String(y1) : y1 + '—' + y2) + ' · 相拥',
      dur: 11000 });

    // 装不下就砍 score 最低的（core 页一页不砍），最后按 ord 还原叙事顺序
    const target = slideTarget(d);
    const core = pool.filter(s => s.core);
    const opt = pool.filter(s => !s.core).sort((a, b) => b.score - a.score);
    const room = Math.max(0, target - core.length);
    const keep = new Set(core.concat(opt.slice(0, room)));
    return pool.filter(s => keep.has(s)).sort((a, b) => a.ord - b.ord);
  }

  // ---------- 每页的 DOM（版式在这里分叉） ----------
  function pageHtml(s) {
    const kick = s.kicker ? `<div class="rs-kicker up" style="--i:0">${esc(s.kicker)}</div>` : '';
    const note = s.note ? `<div class="rs-note up" style="--i:3">${esc(s.note)}</div>` : '';
    const UP = (i) => `class="up" style="--i:${i}"`;

    if (s.layout === 'cover') {
      // 日期拆两段 + 中间一条横线：单个长中文串又扁又小还爱折行，点分写法才像年鉴
      const date = (s.d1 || s.d2)
        ? `<div class="cv-date up" style="--i:4"><span>${esc(s.d1 || '')}</span><i class="dash"></i><span>${esc(s.d2 || '')}</span></div>`
        : '';
      return `<div class="cv-year${s.rng ? ' rng' : ''} up" style="--i:0">${esc(s.year)}</div>
        <div class="cv-name up" style="--i:1">${esc(s.big)}</div>
        <div class="cv-sub up" style="--i:2">${esc(s.sub || '')}</div>
        <div class="cv-hr up" style="--i:3"></div>
        ${date}`;
    }
    if (s.layout === 'num' || s.layout === 'end') {
      const seal = s.layout === 'end' ? '<div class="end-seal up" style="--i:4"></div>' : '';
      // 结尾页：分数之后接「分析 + 寄语 + 落款」，这一页是整份报告真正的收尾
      const bless = s.layout === 'end'
        ? `<div class="rs-bless up" id="rsBless" style="--i:4">${esc(s.bless || '')}</div>`
        : '';
      const sign = s.layout === 'end'
        ? `<div class="rs-sign up" style="--i:5">${esc(s.sign || '')}</div>`
        : '';
      return `${kick}
        <div class="rs-numrow up" data-len="${rsLen(s.num)}" style="--i:1">
          <span class="rs-num">${esc(s.num)}</span><span class="rs-unit">${esc(s.unit || '')}</span>
        </div>
        <div class="rs-under up" style="--i:2"></div>${note}${bless}${seal}${sign}`;
    }
    if (s.layout === 'split') {
      const col = (c, i) => `<div class="sp-col${c.dim ? ' dim' : ''}">
          <div class="sp-k up" style="--i:${i}">${esc(c.k)}</div>
          <div class="sp-v up" style="--i:${i + 1}">${esc(String(c.v))}</div>
          <div class="sp-p up" style="--i:${i + 2}">${esc(c.p || '')}</div>
        </div>`;
      const b = s.bar == null ? '' :
        `<div class="sp-track up" style="--i:2"><i style="width:${s.bar}%"></i><i class="r" style="width:${100 - s.bar}%"></i></div>`;
      return `${kick}
        <div class="rs-split up" style="--i:1">${col(s.pair[0], 1)}<div class="sp-mid"></div>${col(s.pair[1], 2)}</div>
        ${b}${note}`;
    }
    if (s.layout === 'bars') {
      const max = s.max || Math.max(1, ...s.bars.map(x => x.v));
      const rows = s.bars.map(x => `<div class="b-row${x.g === 'ta' ? ' ta' : ''}">
          <span class="b-k" title="${esc(x.k)}">${esc(x.k)}</span>
          <div class="b-track"><i style="width:${x.w != null && x.w > 0 ? x.w : Math.max(3, Math.round(x.v / max * 100))}%"></i></div>
          <span class="b-v">${esc(rsNum(x.v))}</span>
        </div>`).join('');
      return `${kick}<div class="rs-bars up" style="--i:1">${rows}</div>${note}`;
    }
    if (s.layout === 'word') {
      return `${kick}<div class="rs-word up" style="--i:1">${esc(s.big)}</div>
        <div class="rs-side up" style="--i:2">${esc(s.note || '')}</div>`;
    }
    return `${kick}<div class="rs-note up" style="--i:1">${esc(s.big || '')}</div>`;
  }

  // ---------- 装饰层：靠 CSS 变量在页间平滑位移，形成「元素联动」 ----------
  // 用索引推位移而不是写死一张表：页号一走，菱形/光晕/刻度线就连续地游过去。
  // 幅度刻意收得小（±5vw/±4vh）：漂太远会被视口边缘裁掉，菱形只剩一条斜边，看着像脏块。
  function rsDeco(dir) {
    const st = document.getElementById('reportStage');
    if (!st) return;
    st.style.setProperty('--rs-dx', (Math.sin(rs.i * 0.7) * 5).toFixed(1) + 'vw');
    st.style.setProperty('--rs-dy', (Math.cos(rs.i * 0.9) * 4).toFixed(1) + 'vh');
    st.style.setProperty('--rs-rot', (Math.sin(rs.i * 1.1) * 26).toFixed(0) + 'deg');
    st.style.setProperty('--rs-sc', (0.9 + Math.abs(Math.sin(rs.i * 1.3)) * 0.24).toFixed(2));
    rsOrd(dir);
  }

  // 背景那个大页码：换页时要「翻过去」，不是直接换个字。
  // 原来只写 textContent，数字硬切；而且没有 lnum，用的是老式数字（6/8 高一半）。
  // 现在：按位数分档 + 用 translate 属性做一次自下（或自上）的进出。
  // 重启 CSS 动画必须把 animation 清空再强制回流，否则浏览器把它合批，什么都不会发生。
  function rsOrd(dir) {
    const st = document.getElementById('reportStage');
    const ord = st && st.querySelector('.d-ord');
    if (!ord) return;
    const txt = String(rs.i + 1).padStart(2, '0');
    ord.dataset.len = String(txt.replace(/\D/g, '').length);
    st.style.setProperty('--ord-dir', dir < 0 ? '-1' : '1');
    if (ord.textContent === txt) return;
    ord.textContent = txt;
    ord.style.animation = 'none';
    void ord.offsetWidth;
    ord.style.animation = '';
  }

  // 上一页的数字留在角落当残影滑走。这是最直白的一处页间联动。
  function rsGhost(text) {
    const g = document.querySelector('#reportStage .d-ghost');
    if (!g || !text) return;
    g.textContent = String(text);
    g.dataset.len = String(rsLen(text));
    g.style.transition = 'none';
    g.style.setProperty('--gh-x', '0px');
    g.style.setProperty('--gh-y', '0px');
    g.style.setProperty('--gh-o', '.5');
    void g.offsetWidth;                    // 强制回流，否则下面改回去时浏览器会合并成一次，看不到起点
    g.style.transition = '';
    requestAnimationFrame(() => {
      g.style.setProperty('--gh-x', '-54px');
      g.style.setProperty('--gh-y', '-36px');
      g.style.setProperty('--gh-o', '0');
    });
  }

  function rsBar() {
    const i = document.querySelector('#reportStage .rs-bar i');
    if (i) i.style.width = ((rs.i + 1) / rs.slides.length * 100) + '%';
  }

  // 页码 + 圆点轨道：都塞在 .rs-pager 里，那个盒子默认 max-width:0，鼠标移上控制条才展开。
  function rsPager() {
    const st = document.getElementById('reportStage');
    if (!st) return;
    const idx = st.querySelector('.rs-idx'), dots = st.querySelector('.rs-dots');
    if (idx) idx.textContent = (rs.i + 1) + ' / ' + rs.slides.length;
    if (!dots) return;
    if (dots.children.length !== rs.slides.length) {
      dots.innerHTML = rs.slides.map((_, k) => `<span class="rs-dot" data-k="${k}"></span>`).join('');
      dots.querySelectorAll('.rs-dot').forEach(el => el.addEventListener('click', () => rsGo(+el.dataset.k, +el.dataset.k > rs.i ? 1 : -1)));
    }
    [...dots.children].forEach((el, k) => el.classList.toggle('on', k === rs.i));
  }

  function rsArm() {
    clearTimeout(rs.timer);
    if (rs.paused || rs.ended) return;
    const s = rs.slides[rs.i] || {};
    rs.timer = setTimeout(() => {
      // 最后一页不再直接关掉（突然没了像程序崩了）→ 停在结尾态给提示，等手动退出或重播
      if (rs.i + 1 >= rs.slides.length) return rsDone(true);
      rsGo(rs.i + 1, 1);
    }, Math.round((s.dur || RS_BASE) * RS_PACE));
  }

  // 放映结束态。提示条和控制条态都挂在 stage 上，靠 CSS 切，不用额外建/删元素。
  function rsDone(on) {
    rs.ended = !!on;
    // 自动放映走到结尾就把音乐收掉 —— 人都停在「放映结束」的提示上了，
    // 背景还在自顾自弹下去会很怪
    if (rs.ended) { stopMusic(); sfx('end'); }
    const st = document.getElementById('reportStage');
    if (st) st.classList.toggle('ended', rs.ended);
    rsPlayBtn();
  }
  // 播放键三种态：暂停 ▶ / 播放中 ❚❚ / 已结束 ↻
  function rsPlayBtn() {
    const b = document.querySelector('#reportStage #rsPlay');
    if (!b) return;
    b.textContent = rs.ended ? '↻' : (rs.paused ? '▶' : '❚❚');
    b.title = rs.ended ? '重播（空格）' : '暂停 / 继续（空格）';
  }
  // 背景音乐开关的态。关掉时加 .off（CSS 里划一道斜线），一眼看得出没在放
  function rsMusicBtn() {
    const b = document.querySelector('#reportStage #rsMusic');
    if (!b) return;
    const on = !!(window.SOUND && window.SOUND.musicOn);
    b.classList.toggle('off', !on);
    b.title = on ? '背景音乐：开（点击关闭）' : '背景音乐：关（点击打开）';
  }

  // 鼠标停住 RS_IDLE 毫秒就把控制条收干净。只靠 :hover 不行——stage 铺满整屏，
  // 鼠标在窗口里任何位置都算 hover，等于一直显示，所以才"藏不起来"。
  function rsWake() {
    const st = document.getElementById('reportStage');
    if (st) st.classList.remove('idle');
    clearTimeout(rs.idle);
    rs.idle = setTimeout(() => {
      if (st && st.classList.contains('on')) st.classList.add('idle');
    }, RS_IDLE);
  }

  // dir=1 下一句，-1 上一句；只用来决定装饰和残影往哪边走
  function rsGo(i, dir) {
    const st = document.getElementById('reportStage');
    const box = st && st.querySelector('.rs-slides');
    if (!box || !rs.slides.length) return;
    const prevNum = (rs.slides[rs.i] || {}).num;   // 赋值前取，才是「上一页」
    const old = box.querySelector('.rs-slide:not(.leaving)');
    if (old) {
      old.classList.add('leaving');
      setTimeout(() => old.remove(), RS_OUT + 80);
      sfx('page');    // 只有真的从上一页翻过来才响；开场那次 rsGo 不算翻页
    }
    rs.i = Math.max(0, Math.min(rs.slides.length - 1, i));
    const s = rs.slides[rs.i] || {};
    const el = document.createElement('section');
    el.className = 'rs-slide k-' + (s.layout || 'num');
    el.innerHTML = pageHtml(s);
    box.appendChild(el);
    rsDeco(dir);
    if (dir > 0 && rs.i > 0) rsGhost(prevNum);
    rsBar();
    rsPager();
    rsDone(false);   // 手动翻页就退出「已结束」态
    // 走到结尾页时，如果模型版寄语已经回来了就补上去（没回来就用规则版，绝不空着）
    if (s.layout === 'end') applyAiBless();
    // 这里**故意不叫 rsWake()**：自动翻页每 5 秒一次，一 wake 就等于控制条连着页码
    // 每页闪一下。控制条只该被人自己的操作唤醒（openReport / mousemove / keydown）。
    rsArm();
  }

  // ---------- 结尾寄语的 AI 版：后台先要，不挡放映 ----------
  // 报告是自动翻页的，绝不能为了等模型把幻灯片卡住；
  // 所以这里只管「提前下单」，回来得早就换上，回来得晚就当没这回事。
  function rsBlessAi(d, seq) {
    if (!aiState.ready || d.group) return;
    fetch('/api/ai/blessing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d }) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (seq !== rs.blessSeq || !r.ok || !j || !j.ok || !j.blessing) return;
        rs.aiBless = j.blessing;
        applyAiBless();   // 人可能已经翻到结尾页了，直接补上去
      }).catch(() => { /* 失败就继续用规则版，不打扰用户 */ });
  }

  function applyAiBless() {
    const el = document.getElementById('rsBless');
    if (!el || !rs.aiBless || el.classList.contains('ai-made')) return;
    el.classList.add('ai-made');
    el.innerHTML = esc(rs.aiBless) + '<span class="ai-tag">AI 现写</span>';
  }

  function openReport(d) {
    rs.slides = buildSlides(d, promiseState);
    rs.i = 0;
    rs.paused = false;
    rs.ended = false;
    let st = document.getElementById('reportStage');
    if (!st) {
      st = document.createElement('div');
      st.id = 'reportStage';
      document.body.appendChild(st);
    }
    st.className = 'report-stage';
    st.innerHTML = `<div class="rs-deco">
        <div class="d-grid"></div><div class="d-noise"></div><div class="d-glow"></div>
        <div class="d-ring"></div><div class="d-mark"></div><div class="d-rule"></div>
        <div class="d-ord"></div><div class="d-ghost"></div>
        <div class="d-corner tl"></div><div class="d-corner tr"></div>
        <div class="d-corner bl"></div><div class="d-corner br"></div>
      </div>
      <div class="rs-slides"></div>
      <div class="rs-bar"><i></i></div>
      <div class="rs-done">放映结束 · 点 <b>↻</b> 再看一遍，或按 <b>Esc</b> 退出</div>
      <div class="rs-ctrl">
        <button class="rs-btn" id="rsPrev" title="上一页（←）" data-sfx="none">‹</button>
        <button class="rs-btn rs-play" id="rsPlay" title="暂停 / 继续（空格）">❚❚</button>
        <button class="rs-btn" id="rsNext" title="下一页（→）" data-sfx="none">›</button>
        <button class="rs-btn rs-music" id="rsMusic" title="背景音乐" data-sfx="none">♪</button>
        <div class="rs-pager"><span class="rs-idx"></span><div class="rs-dots"></div></div>
        <button class="rs-btn rs-close" id="rsClose" title="退出（Esc）" data-sfx="none">✕</button>
      </div>`;
    const q = (id) => st.querySelector(id);
    q('#rsPrev').addEventListener('click', () => rsGo(rs.i - 1, -1));
    q('#rsNext').addEventListener('click', () => (rs.i + 1 >= rs.slides.length ? closeReport() : rsGo(rs.i + 1, 1)));
    q('#rsPlay').addEventListener('click', () => {
      if (rs.ended) { rs.paused = false; startMusic(); return rsGo(0, 1); }   // 结束态下就是重播
      rs.paused = !rs.paused;
      rsPlayBtn();
      if (rs.paused) { clearTimeout(rs.timer); stopMusic(); } else { rsArm(); startMusic(); }
    });
    q('#rsClose').addEventListener('click', closeReport);
    // 报告里就地关音乐 —— 不想听了不该还得退出去翻设置
    q('#rsMusic').addEventListener('click', () => {
      const on = !(window.SOUND && window.SOUND.musicOn);
      try { if (window.SOUND) window.SOUND.setMusic(on); } catch (e) {}
      if (on) startMusic(); else stopMusic();
      rsMusicBtn();
    });
    // 鼠标动、或者点一下（bubbles 到 stage），都算「人还在」，把控制条亮回来
    st.addEventListener('mousemove', rsWake);
    st.addEventListener('click', rsWake);
    rsMusicBtn();       // 按当前设置初始化音乐键的态
    document.body.classList.add('report-lock');
    // 显示用的是 rAF：等一帧再上 .on，入场过渡才走得出来。
    // 但 rAF 在**窗口被遮挡 / 最小化**时会停摆（离屏截图的窗口里就是这样），
    // 那样报告会「打开了却一直不显示」。补一个定时器兜底，顺带让自动化测试变确定。
    // 用 token 而不是 clearTimeout：rAF 和定时器两条路都要能作废，
    // 否则刚 closeReport、迟到的 show() 又把 .on 加回来，报告就"关不干净"。
    rs.openToken = (rs.openToken || 0) + 1;
    const tok = rs.openToken;
    const show = () => { if (rs.openToken === tok) st.classList.add('on'); };
    requestAnimationFrame(show);
    setTimeout(show, 140);
    rsWake();
    startMusic();        // 背景音乐从 0 淡入（约 2.4 秒），不抢开场那声铃
    sfx('start');
    rsGo(0, 1);
    rsBlessAi(d, seq);   // 后台先要一段结尾寄语，不等它
  }

  function closeReport() {
    clearTimeout(rs.timer);
    clearTimeout(rs.idle);
    rs.openToken = (rs.openToken || 0) + 1;   // 作废还没跑的 show()，别让它把 .on 加回来
    stopMusic();          // 音乐 1.6 秒淡出，别硬切
    sfx('end');
    const st = document.getElementById('reportStage');
    if (st) {
      st.classList.remove('on');
      setTimeout(() => { if (!st.classList.contains('on')) st.innerHTML = ''; }, 460);
    }
    document.body.classList.remove('report-lock');
  }

  function bindReportKeys() {
    if (window.__reportKeys) return;
    window.__reportKeys = true;
    document.addEventListener('keydown', e => {
      const st = document.getElementById('reportStage');
      if (!st || !st.classList.contains('on')) return;
      const last = rs.i + 1 >= rs.slides.length;
      rsWake();   // 敲键也算人还在，控制条该亮
      if (e.key === 'Escape') { e.preventDefault(); closeReport(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); last ? closeReport() : rsGo(rs.i + 1, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); rsGo(rs.i - 1, -1); }
      else if (e.key === ' ') {
        e.preventDefault();
        if (rs.ended) { rs.paused = false; startMusic(); return rsGo(0, 1); }
        rs.paused = !rs.paused;
        rsPlayBtn();
        if (rs.paused) { clearTimeout(rs.timer); stopMusic(); } else { rsArm(); startMusic(); }
      }
    });
  }

  function bindReportEntry(d) {
    const el = $('#reportEntry');
    if (!el) return;
    el.addEventListener('click', () => { bindReportKeys(); openReport(d); });
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
    main.querySelectorAll('.lk-add[data-side]').forEach(b => b.addEventListener('click', async () => {
      const side = b.dataset.side;
      const text = await askText(`添加${side === 'me' ? '我' : 'TA'}的喜好`, '', '例如：吃火锅、看科幻片');
      if (!text) return;
      fetch('/api/person/' + pid + '/likes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', item: { side, text } })
      }).then(r => { if (!r.ok) { toast('保存失败', 'err'); return; } selectPerson(pid); });
    }));
    // 喜好：编辑 / 删除（事件委托）
    main.querySelectorAll('.lk-tag').forEach(tag => {
      tag.querySelector('.lk-edit').addEventListener('click', async e => {
        e.stopPropagation();
        const text = await askText('编辑喜好内容', tag.dataset.text);
        if (!text) return;
        fetch('/api/person/' + pid + '/likes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: tag.dataset.id, side: tag.dataset.side, text } })
        }).then(r => { if (!r.ok) { toast('保存失败', 'err'); return; } selectPerson(pid); });
      });
      tag.querySelector('.lk-del').addEventListener('click', async e => {
        e.stopPropagation();
        const yes = await askOk(`删除喜好「${tag.dataset.text}」？`, '删掉后这条不会再被自动识别补回来。', { okText: '删除', danger: true });
        if (!yes) return;
        fetch('/api/person/' + pid + '/likes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'del', item: { id: tag.dataset.id, side: tag.dataset.side } })
        }).then(r => { if (!r.ok) { toast('删除失败', 'err'); return; } selectPerson(pid); });
      });
    });
    // 纪念日：添加
    const addAnniv = main.querySelector('#addAnniv');
    if (addAnniv) addAnniv.addEventListener('click', async () => {
      const label = await askText('纪念日名称', '', '例如：在一起、生日');
      if (!label) return;
      const date = await askText('日期', '', '格式 YYYY-MM-DD 或 MM-DD，例如 2024-08-15');
      if (!date) return;
      if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { toast('日期格式应为 YYYY-MM-DD 或 MM-DD', 'warn', 4000); return; }
      fetch('/api/person/' + pid + '/anniversaries', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', item: { label, date } })
      }).then(r => { if (!r.ok) { toast('保存失败', 'err'); return; } selectPerson(pid); });
    });
    // 纪念日：编辑 / 删除
    main.querySelectorAll('.anv').forEach(anv => {
      // 点击日期：仅修改时间
      anv.querySelector('.anv-date').addEventListener('click', async e => {
        e.stopPropagation();
        const date = await askText('修改日期', anv.dataset.date, '格式 YYYY-MM-DD 或 MM-DD');
        if (!date) return;
        if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { toast('日期格式应为 YYYY-MM-DD 或 MM-DD', 'warn', 4000); return; }
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: anv.dataset.id, label: anv.dataset.label, date } })
        }).then(r => { if (!r.ok) { toast('保存失败', 'err'); return; } selectPerson(pid); });
      });
      anv.querySelector('.lk-edit').addEventListener('click', async e => {
        e.stopPropagation();
        const label = await askText('纪念日名称', anv.dataset.label);
        if (!label) return;
        const date = await askText('日期', anv.dataset.date, '格式 YYYY-MM-DD 或 MM-DD');
        if (!date) return;
        if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) { toast('日期格式应为 YYYY-MM-DD 或 MM-DD', 'warn', 4000); return; }
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', item: { id: anv.dataset.id, label, date } })
        }).then(r => { if (!r.ok) { toast('保存失败', 'err'); return; } selectPerson(pid); });
      });
      anv.querySelector('.lk-del').addEventListener('click', async e => {
        e.stopPropagation();
        const yes = await askOk(`删除纪念日「${anv.dataset.label} · ${anv.dataset.date}」？`, '删除后不再计入倒计时。', { okText: '删除', danger: true });
        if (!yes) return;
        fetch('/api/person/' + pid + '/anniversaries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'del', item: { id: anv.dataset.id } })
        }).then(r => { if (!r.ok) { toast('删除失败', 'err'); return; } selectPerson(pid); });
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
        const sndCfg = (window.SOUND && window.SOUND.cfg()) || { on: true, music: true, vol: 1 };
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
          <div><div class="sp-sec">声音</div>
            <label class="sp-opt"><input type="checkbox" id="spSfx" ${sndCfg.on ? 'checked' : ''}> 界面音效</label>
            <label class="sp-opt"><input type="checkbox" id="spBgm" ${sndCfg.music ? 'checked' : ''} ${sndCfg.on ? '' : 'disabled'}> 年度报告背景音乐</label>
            <div class="sp-vol">
              <span class="sp-vol-lb">响度</span>
              <input type="range" id="spVol" min="0" max="2" step="0.1" value="${sndCfg.vol}" ${sndCfg.on ? '' : 'disabled'}>
              <span class="sp-vol-v" id="spVolV">${Math.round(sndCfg.vol * 100)}%</span>
            </div>
            <div class="sp-hint">全部由设备现场合成，不占体积、无版权问题。报告放映时也能随时关。</div>
            <div class="sp-colors"><button class="sp-reset" id="spBgmTry">试听 8 秒</button></div>
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
        const sfxEl = panel.querySelector('#spSfx');
        if (sfxEl) sfxEl.addEventListener('change', e => {
          if (window.SOUND) window.SOUND.setOn(e.target.checked);
          const bgm = panel.querySelector('#spBgm');
          if (bgm) { bgm.disabled = !e.target.checked; if (!e.target.checked) bgm.checked = false; }
          const vol = panel.querySelector('#spVol');
          if (vol) vol.disabled = !e.target.checked;
          if (e.target.checked) sfx('ok');   // 打开时给一声确认，顺便让人听到音量
        });
        // 响度滑杆：拖动实时生效，松手时补一声 tap，等于"这就是调整后的音量"
        const volEl = panel.querySelector('#spVol');
        if (volEl) {
          const lbl = panel.querySelector('#spVolV');
          const put = (v) => { if (lbl) lbl.textContent = Math.round(v * 100) + '%'; };
          put(Number(volEl.value));
          volEl.addEventListener('input', e => {
            const v = Number(e.target.value);
            if (window.SOUND) window.SOUND.setVol(v);
            put(v);
          });
          volEl.addEventListener('change', e => {
            const v = Number(e.target.value);
            if (window.SOUND) window.SOUND.setVol(v);
            put(v);
            sfx('tap');
          });
        }
        const bgmEl = panel.querySelector('#spBgm');
        if (bgmEl) bgmEl.addEventListener('change', e => {
          if (window.SOUND) window.SOUND.setMusic(e.target.checked);
          if (e.target.checked) sfx('ok');
        });
        const tryEl = panel.querySelector('#spBgmTry');
        if (tryEl) tryEl.addEventListener('click', () => {
          if (!window.SOUND) { toast('这台设备的音频不可用', 'warn', 2200); return; }
          if (!sndCfg.on) { toast('先把「界面音效」总开关打开', 'warn', 2200); return; }
          window.SOUND.unlock();
          startMusic();
          toast('试听中 · 8 秒后自动停', 'info', 2400);
          clearTimeout(window.__bgmTry);
          window.__bgmTry = setTimeout(() => {
            if (!document.getElementById('reportStage')) stopMusic();   // 这期间进了报告就别停
          }, 8000);
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
  const TODO_KEEP_KEY = 'ta_love_todo_keep';   // '1' = 永久保留已完成，不自动清理
  const TODO_FOLD_KEY = 'ta_love_todo_folded'; // '1' = 折叠；没存过按折叠算
  const TODO_KEEP_DAYS = 15;                   // 已完成项默认保留天数
  const DAY_MS = 86400000;
  let todoKeepForever = false;
  // AI 锐评的缓存：{ sig, body, advice, model }。null = 还没让模型写过，界面上显示模板版。
  // 缓存是必须的 —— renderTodos() 每次勾选/新增都会跑，没有缓存就等于每勾一下烧一次算力。
  let todoAi = null;
  let todoPrunedOnBoot = 0;                    // 本次启动自动清理了几条（用于提示）

  function loadTodoKeep() {
    try { todoKeepForever = localStorage.getItem(TODO_KEEP_KEY) === '1'; } catch (e) { todoKeepForever = false; }
  }
  function saveTodoKeep() {
    try { localStorage.setItem(TODO_KEEP_KEY, todoKeepForever ? '1' : '0'); } catch (e) {}
  }
  // 已完成项超过保留期 → 自动清空（永久保留模式直接跳过）
  function pruneDoneTodos() {
    if (todoKeepForever) return 0;
    const now = Date.now();
    const before = todos.length;
    todos = todos.filter(t => {
      if (!t.done) return true;
      if (!t.doneAt) { t.doneAt = now; return true; }  // 老数据没有完成时间，从现在起算
      return now - t.doneAt <= TODO_KEEP_DAYS * DAY_MS;
    });
    const removed = before - todos.length;
    if (removed) saveTodos();
    return removed;
  }
  function loadTodos() {
    loadTodoKeep();
    try { todos = JSON.parse(localStorage.getItem(TODO_KEY) || '[]'); } catch (e) { todos = []; }
    if (!Array.isArray(todos)) todos = [];
    todoPrunedOnBoot = pruneDoneTodos();
  }
  function saveTodos() {
    try { localStorage.setItem(TODO_KEY, JSON.stringify(todos)); } catch (e) {}
  }
  function addTodo(text) {
    const t = String(text || '').trim();
    if (!t) return;
    todos.unshift({ id: 'td-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), text: t, done: false, doneAt: 0, ts: Date.now() });
    saveTodos();
    renderTodos();
  }
  // 已完成项「最早那一条」还剩几天被清掉
  function daysLeftForDone() {
    const done = todos.filter(t => t.done && t.doneAt);
    if (!done.length) return null;
    const oldest = Math.min(...done.map(t => t.doneAt));
    return Math.max(0, Math.ceil((oldest + TODO_KEEP_DAYS * DAY_MS - Date.now()) / DAY_MS));
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
          if (t) { t.done = !t.done; t.doneAt = t.done ? Date.now() : 0; saveTodos(); renderTodos(); }
        });
        item.querySelector('.todo-del').addEventListener('click', () => {
          todos = todos.filter(x => x.id !== item.dataset.id);
          saveTodos(); renderTodos();
        });
      });
    }
    if (roastEl) {
      const sig = todoSig();
      // 清单变了就把旧的 AI 锐评作废 —— 拿旧清单的评价糊在新清单上是最刺眼的一种错
      if (todoAi && todoAi.sig !== sig) todoAi = null;
      const tpl = todoRoast();
      const useAi = !!todoAi;
      const body = useAi ? todoAi.body : tpl.body;
      const tip = useAi ? todoAi.advice : tpl.advice;
      roastEl.innerHTML =
        `<div class="tr-head"><span class="tr-tt">${esc(useAi ? 'AI 锐评 · ' + (todoAi.model || '本地模型') : tpl.title)}</span>
           <button class="roast-ai-btn tr-ai" id="todoAiBtn"${todos.length ? '' : ' disabled'}>${useAi ? '✦ 换一版' : '✦ AI 锐评'}</button></div>
         <div class="tr-body">${esc(body)}</div>
         ${tip ? `<span class="tr-advice">狗头军师：${esc(tip)}</span>` : ''}`;
      const aiBtn = roastEl.querySelector('#todoAiBtn');
      // 只有点了才跑模型。renderTodos 被勾选/新增频繁触发，绝不能在这里自动调 AI。
      if (aiBtn && todos.length) aiBtn.addEventListener('click', () => runTodoAi(aiBtn));
    }
    renderTodoArchive();
  }

  // 清单签名：只跟「内容 + 完成状态」有关，用来判断缓存的锐评还作不作数
  function todoSig() {
    return todos.map(t => (t.done ? '1' : '0') + t.text).join('|');
  }

  // To Do 的 AI 锐评（真 AI）。清单是用户自己写的，本地模型跑，不外传。
  async function runTodoAi(btn) {
    if (!aiState.ready) { toast('先选一个本地 AI 模型，再让它评', 'info', 3200); openAiPanel(); return; }
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const resp = await fetch('/api/ai/todo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todos: todos.map(t => ({ text: t.text, done: !!t.done })) }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
      todoAi = { sig: todoSig(), body: j.body, advice: j.advice || '', model: j.model || '' };
      renderTodos();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = old;
      toast('生成失败：' + (e && e.message ? e.message : '未知错误'), 'error', 4200);
    }
  }
  // ---------- 已完成归档条：只在有已完成项时出现 ----------
  function renderTodoArchive() {
    const el = $('#todoArchive');
    if (!el) return;
    const doneItems = todos.filter(t => t.done);
    if (!doneItems.length) { el.classList.add('hide'); el.innerHTML = ''; return; }
    const n = doneItems.length;
    const left = daysLeftForDone();
    const tip = todoKeepForever
      ? `已完成 ${n} · 永久保留`
      : (left === null ? `已完成 ${n}` : `已完成 ${n} · 最早 ${left} 天后清空`);
    el.classList.remove('hide');
    el.innerHTML = `<span class="ta-tip">${tip}</span>` +
      `<button class="ta-btn ta-keep${todoKeepForever ? ' on' : ''}" id="todoKeepBtn" title="${todoKeepForever ? '已开启永久保留 · 点击恢复自动清理' : `开启后已完成项永久保留，不再 ${TODO_KEEP_DAYS} 天自动清空`}">保留</button>` +
      `<button class="ta-btn ta-clear" id="todoClearDone" title="立即清空所有已完成">清空</button>`;
    const keepBtn = el.querySelector('#todoKeepBtn');
    const clearBtn = el.querySelector('#todoClearDone');
    if (keepBtn) keepBtn.addEventListener('click', () => {
      todoKeepForever = !todoKeepForever;
      saveTodoKeep();
      if (todoKeepForever) {
        toast('已开启永久保留：已完成的待办不再自动清空', 'info', 3000);
      } else {
        const removed = pruneDoneTodos();
        toast(removed ? `已恢复自动清理，顺手清掉 ${removed} 项超期项` : `已恢复自动清理：完成满 ${TODO_KEEP_DAYS} 天自动移除`, 'info', 3000);
      }
      renderTodos();
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      const k = doneItems.length;
      todos = todos.filter(t => !t.done);
      saveTodos();
      renderTodos();
      toast(`已清空 ${k} 项已完成的待办`, 'info', 2400);
    });
  }
  function bindTodo() {
    const addBtn = $('#todoAdd');
    const input = $('#todoInput');
    const collapse = $('#todoCollapse');
    const panel = $('#todoPanel');
    if (addBtn) addBtn.addEventListener('click', () => { const v = input.value; if (v.trim()) { addTodo(v); input.value = ''; } });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = input.value; if (v.trim()) { addTodo(v); input.value = ''; } } });
    if (collapse && panel) collapse.addEventListener('click', () => {
      const folded = panel.classList.toggle('collapsed');
      try { localStorage.setItem(TODO_FOLD_KEY, folded ? '1' : '0'); } catch (e) {}
    });
    // 默认折叠：把左边让给内容。只有用户明确展开过（存了 '0'）才默认摊开。
    if (panel) {
      let folded = true;
      try { const v = localStorage.getItem(TODO_FOLD_KEY); if (v !== null) folded = v === '1'; } catch (e) {}
      panel.classList.toggle('collapsed', folded);
    }
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
      // 先停轮询、再发请求。原来这两句在 .then() 里，而下面的 .catch 是空的 ——
      // 只要停止请求失败一次，轮询就再也清不掉，变成每 800ms 一次的僵尸请求，
      // 直到窗口关闭。清定时器这种事不该依赖网络成功。
      clearInterval(timer); timer = null;
      fetch('/api/grab/stop', { method: 'POST' }).then(r => r.json()).then(d => {
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
  if (todoPrunedOnBoot) {
    setTimeout(() => toast(`已按 ${TODO_KEEP_DAYS} 天规则自动清空 ${todoPrunedOnBoot} 项已完成的待办`, 'info', 3600), 900);
  }
  bindSettings();
  bindGrab();
  bindAi();
  pollAiStatus();
  // 轮询模型下载进度/就绪态。窗口不可见时跳过 —— 最小化挂着时没人看，白问一遍。
  // 切回窗口立刻补一次，所以隐藏期间的状态变化不会被漏掉。
  setInterval(() => { if (!document.hidden) pollAiStatus(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAiStatus(); });
  loadPersons();
  bindImportOne();
})();
