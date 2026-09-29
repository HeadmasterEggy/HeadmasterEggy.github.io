// 看板猫聊天面板：在猫的工具栏加一个“聊天”按钮，对话由 Cloudflare Worker（workers/cat-agent）转给 DeepSeek。
// 用法：window.CAT_AGENT_URL 指向 Worker 的 /chat 地址（见 init.js）。样式在 cat.css。
// 所有内容都用 DOM API 构建（不用 innerHTML 渲染模型输出），markdown 由下面的 md() 安全渲染。
(() => {
  const url = window.CAT_AGENT_URL;
  if (!url || window.__catAgentLoaded) return;
  window.__catAgentLoaded = true;

  const STORE = 'cat-chat-history';
  const GREETING = '喵～我是这个博客的看板喵。想找哪方面的笔记，或者想聊聊当前这页，都可以问我。';
  const CHIPS = ['推荐几篇值得看的笔记', '总结一下当前这页', '有哪些关于算法的笔记？', '你是谁？']; // 生成失败时的兜底
  const SUGGEST_URL = url.replace(/\/chat$/, '/suggest');

  const svg = (paths, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${paths}</svg>`;
  const ICONS = {
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    clear: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
    send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    chatBtn: svg('<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    shuffle: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    // 头像：自绘的黑猫（source/live2d/avatar.svg）
    cat: '<img src="/live2d/avatar.svg" alt="" draggable="false">'
  };

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  // ───────────── Markdown（安全子集）─────────────
  // 支持：段落/换行、# 标题、**粗体**、*斜体*、~~删除线~~、`代码`、```代码块```、有序/无序列表（可嵌套）、
  //       > 引用、--- 分隔线、| 表格 |、[链接](url)。链接只允许站内或 https。
  const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|(?<![*\w])\*([^*\s][^*\n]*?)\*(?!\*)|(?<![_\w])_([^_\s][^_\n]*?)_(?![_\w])/g;

  function inline(parent, text) {
    let last = 0, m;
    const re = new RegExp(INLINE.source, 'g'); // 每次调用一个新实例：递归解析时共用 lastIndex 会死循环
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] != null) parent.append(h('code', '', m[1]));
      else if (m[2] != null) {
        let u = null;
        try { u = new URL(m[3], location.href); } catch (e) { /* bad url */ }
        if (u && (u.origin === location.origin || u.protocol === 'https:')) {
          const a = h('a');
          a.href = m[3];
          if (u.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          inline(a, m[2]);
          parent.append(a);
        } else parent.append(m[2]);
      } else {
        const tag = (m[4] ?? m[5]) != null ? 'strong' : m[6] != null ? 'del' : 'em';
        const el = h(tag);
        inline(el, m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8]);
        parent.append(el);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
  const startsBlock = (line, next) =>
    /^\s*```/.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || LIST_RE.test(line) || /^\s*>/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes('|') && next != null && TABLE_SEP.test(next));

  function codeBlock(root, lang, code) {
    const pre = h('pre');
    const bar = h('div', 'bar');
    bar.append(h('span', '', lang || 'code'));
    const btn = h('button', '', '复制');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      await copyText(code);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1400);
    });
    bar.append(btn);
    pre.append(bar, h('code', '', code));
    root.append(pre);
  }

  function md(text) {
    const root = h('div', 'md');
    const lines = text.replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (m) { // 代码块（缺少结尾围栏时到末尾为止）
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        codeBlock(root, m[1], buf.join('\n'));
        continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        const p = h('p', `md-h md-h${Math.min(m[1].length, 3)}`);
        inline(p, m[2]);
        root.append(p); i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        const q = h('blockquote');
        q.append(...md(buf.join('\n')).childNodes);
        root.append(q); continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const wrap = h('div', 'tbl'), table = h('table'), thead = h('thead'), tbody = h('tbody');
        const head = h('tr');
        cells(line).forEach(c => { const th = h('th'); inline(th, c); head.append(th); });
        thead.append(head);
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const tr = h('tr');
          cells(lines[i++]).forEach(c => { const td = h('td'); inline(td, c); tr.append(td); });
          tbody.append(tr);
        }
        table.append(thead, tbody); wrap.append(table); root.append(wrap); continue;
      }
      if (LIST_RE.test(line)) { i = list(root, lines, i); continue; }

      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(lines[i], lines[i + 1]))) buf.push(lines[i++]);
      const p = h('p');
      buf.forEach((l, k) => { if (k) p.append(h('br')); inline(p, l.trim()); });
      root.append(p);
    }
    return root;
  }

  function list(root, lines, i) {
    const items = [];
    while (i < lines.length) {
      let m = lines[i].match(LIST_RE);
      if (!m && !lines[i].trim()) { // 列表项之间允许空一行
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && LIST_RE.test(lines[j])) { i = j; m = lines[i].match(LIST_RE); }
      }
      if (!m) break;
      items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
      i++;
    }
    const mk = it => { const l = h(it.ordered ? 'ol' : 'ul'); if (it.ordered && it.start > 1) l.start = it.start; return l; };
    const first = mk(items[0]);
    root.append(first);
    const stack = [{ indent: items[0].indent, el: first }];
    for (const it of items) {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (it.indent > top.indent) {
        const nested = mk(it);
        (top.el.lastElementChild || top.el).append(nested);
        top = { indent: it.indent, el: nested };
        stack.push(top);
      }
      const li = h('li');
      inline(li, it.text);
      top.el.append(li);
    }
    return i;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch (e) { /* 回退 */ }
    const ta = h('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ───────────── 状态 ─────────────
  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]').filter(m => m && typeof m.content === 'string'); } catch (e) { /* 无痕模式等 */ }
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))); } catch (e) { /* ignore */ } };

  // ───────────── 面板 DOM ─────────────
  const panel = h('div');
  panel.id = 'cat-chat';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '和看板喵聊天');
  panel.innerHTML = `
    <div class="cc-head">
      <div class="cc-avatar">${ICONS.cat}</div>
      <div class="cc-title"><b>看板喵</b><span>可以帮你翻笔记、聊聊这一页</span></div>
      <button type="button" class="cc-icon" data-act="clear" title="清空对话" aria-label="清空对话">${ICONS.clear}</button>
      <button type="button" class="cc-icon" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="msgs" aria-live="polite"></div>
    <div class="chips"></div>
    <form>
      <div class="box">
        <textarea rows="1" maxlength="800" placeholder="问问喵…" aria-label="消息"></textarea>
        <button type="submit" class="send" title="发送" aria-label="发送">${ICONS.send}</button>
      </div>
    </form>`;
  document.body.appendChild(panel);
  const msgs = panel.querySelector('.msgs');
  const chips = panel.querySelector('.chips');
  const form = panel.querySelector('form');
  const input = panel.querySelector('textarea');
  const sendBtn = panel.querySelector('.send');
  let busy = false;

  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90;
  const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };

  function addRow(role, opts = {}) {
    const row = h('div', `row ${role}${opts.err ? ' err' : ''}`);
    if (role === 'cat') { const av = h('div', 'cc-mini'); av.innerHTML = ICONS.cat; row.append(av); }
    const bubble = h('div', 'msg');
    row.append(bubble);
    msgs.append(row);
    toBottom();
    return { row, bubble };
  }

  function catMessage(text, opts = {}) {
    const { row, bubble } = addRow('cat', opts);
    bubble.append(opts.err ? document.createTextNode(text) : md(text));
    if (!opts.err) {
      const btn = h('button', 'copy-all');
      btn.type = 'button'; btn.title = '复制回答'; btn.setAttribute('aria-label', '复制回答');
      btn.innerHTML = ICONS.copy;
      btn.addEventListener('click', async () => {
        await copyText(text);
        btn.innerHTML = ICONS.check;
        setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1400);
      });
      bubble.append(btn);
    }
    return { row, bubble };
  }

  // 打字机：先整体渲染 markdown，再按字符顺序把文字节点“放出来”，所以过程中排版不会抖动
  async function reveal(bubble) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const nodes = [];
    const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('.copy-all,.bar') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n; (n = walk.nextNode());) nodes.push({ n, full: n.data });
    const total = nodes.reduce((s, x) => s + x.full.length, 0);
    if (!total || total > 700) return;
    nodes.forEach(x => { x.n.data = ''; });
    const step = Math.max(1, Math.ceil(total / 70));
    let shown = 0;
    while (shown < total) {
      shown = Math.min(total, shown + step);
      let left = shown;
      for (const x of nodes) { const k = Math.min(left, x.full.length); x.n.data = x.full.slice(0, k); left -= k; }
      if (nearBottom()) toBottom();
      await new Promise(r => setTimeout(r, 20));
    }
  }

  // 推荐提问：由后端根据随机几篇笔记（和当前页面）用 DeepSeek 现场生成，每次都不一样；失败时用 CHIPS 兜底
  let suggestFor = '', suggestion = null;
  function fetchSuggestions(force = false) {
    const key = location.pathname;
    if (!force && suggestion && suggestFor === key) return suggestion;
    suggestFor = key;
    suggestion = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const res = await fetch(SUGGEST_URL, {
          method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: { title: document.title.slice(0, 100), url: location.pathname } })
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.suggestions) || data.suggestions.length < 3) return null;
        return data.suggestions.slice(0, 4).map(s => String(s).slice(0, 40));
      } catch (e) { return null; } finally { clearTimeout(timer); }
    })();
    return suggestion;
  }

  let chipToken = 0;
  async function renderChips(force = false) {
    const token = ++chipToken;
    chips.textContent = '';
    if (history.length) return;
    const widths = [128, 92, 116, 100];
    widths.forEach((w, i) => { // 生成期间显示骨架占位
      const s = h('span', 'skel');
      s.style.cssText = `--w:${w}px;--i:${i}`;
      chips.append(s);
    });
    const list = (await fetchSuggestions(force)) || CHIPS;
    if (token !== chipToken || history.length) return; // 期间用户已经发了消息 / 又重新渲染过
    chips.textContent = '';
    list.forEach((text, i) => {
      const b = h('button', '', text);
      b.type = 'button';
      b.style.setProperty('--i', i);
      b.addEventListener('click', () => { if (!busy) send(text); });
      chips.append(b);
    });
  }

  function renderAll(force = false, withChips = true) {
    msgs.textContent = '';
    if (!history.length) catMessage(GREETING);
    history.forEach(m => (m.role === 'user' ? (addRow('me').bubble.textContent = m.content) : catMessage(m.content)));
    if (withChips) renderChips(force);
    toBottom();
  }
  renderAll(false, false); // 页面加载时不生成推荐提问（省 API 调用），首次打开面板时才生成

  async function send(text) {
    busy = true; sendBtn.disabled = true;
    chips.textContent = '';
    addRow('me').bubble.textContent = text;
    history.push({ role: 'user', content: text });

    const { row, bubble } = addRow('cat');
    const dots = h('span', 'dots');
    dots.innerHTML = '<i></i><i></i><i></i>';
    bubble.append(dots);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const fail = msg => { row.remove(); catMessage(msg, { err: true }); history.pop(); };
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-10), page: { title: document.title.slice(0, 100), url: location.pathname } })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.reply) {
        fail(res.status === 429 ? '喵…问得太快啦，等一分钟再来吧。' : '喵…我这边出了点问题，稍后再试试。');
      } else {
        row.remove();
        const done = catMessage(data.reply);
        history.push({ role: 'assistant', content: data.reply });
        await reveal(done.bubble);
      }
    } catch (e) {
      fail(e.name === 'AbortError' ? '喵…等太久了，再试一次吧。' : '喵…网络好像断了。');
    } finally {
      clearTimeout(timer); busy = false; sendBtn.disabled = !input.value.trim(); save(); input.focus();
    }
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
  input.addEventListener('input', () => { autosize(); sendBtn.disabled = busy || !input.value.trim(); });
  sendBtn.disabled = true;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = ''; autosize();
    send(text);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } // isComposing：输入法选字时的回车不发送
  });

  // 面板放在猫旁边：优先猫的左边，放不下就放右边；上下按猫脚下的工具条对齐并限制在窗口内
  function placePanel() {
    const w = document.getElementById('waifu');
    if (!w) return;
    const c = w.getBoundingClientRect();
    const pw = Math.min(372, innerWidth - 16), ph = Math.min(540, innerHeight - 16);
    const gap = 12, edge = 8;
    let left = c.left - gap - pw, origin = 'bottom right';
    if (left < edge) { left = c.right + gap; origin = 'bottom left'; }
    if (left + pw > innerWidth - edge) left = Math.max(edge, innerWidth - pw - edge);
    let top = c.bottom + 34 - ph;
    top = Math.max(edge, Math.min(top, innerHeight - ph - edge));
    Object.assign(panel.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto', transformOrigin: origin });
  }
  window.addEventListener('cat:move', () => { if (panel.classList.contains('open')) placePanel(); });
  window.addEventListener('resize', () => { if (panel.classList.contains('open')) placePanel(); });

  let button;
  const setOpen = open => {
    if (open) placePanel();
    if (open && !history.length && !chips.childElementCount) renderChips();
    panel.classList.toggle('open', open);
    button && button.classList.toggle('active', open);
    if (open) { toBottom(); setTimeout(() => input.focus(), 120); }
  };
  panel.querySelector('[data-act="close"]').addEventListener('click', () => setOpen(false));
  panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
    if (busy) return;
    history = []; save(); renderAll(true); input.focus();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false); });

  // 入口：猫脚下的胶囊工具条（等猫出现后再显示）：聊天 | 随机一篇笔记
  const dock = h('div');
  dock.id = 'cat-dock';
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', '看板喵工具');
  dock.innerHTML = `<button type="button" data-act="chat" title="和喵聊聊" aria-label="和喵聊聊">${ICONS.chatBtn}</button><span class="sep"></span><button type="button" data-act="random" title="随机一篇笔记" aria-label="随机一篇笔记">${ICONS.shuffle}</button>`;
  document.body.appendChild(dock);
  button = dock.querySelector('[data-act="chat"]');
  button.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  button.addEventListener('pointerenter', () => { if (!history.length) fetchSuggestions(); }, { once: true }); // 鼠标靠近就预取，点开时基本已经生成好

  let notes = null;
  dock.querySelector('[data-act="random"]').addEventListener('click', async () => {
    try {
      notes = notes || (await (await fetch('/graph/data.json')).json()).nodes.filter(n => n.url && n.published);
      const cur = location.pathname;
      const pool = notes.filter(n => n.url !== cur);
      location.assign(pool[Math.floor(Math.random() * pool.length)].url);
    } catch (e) { /* 拿不到索引就什么都不做 */ }
  });

  const sync = () => {
    const w = document.getElementById('waifu');
    const visible = !!w && w.classList.contains('waifu-active') && !w.classList.contains('waifu-hidden');
    dock.classList.toggle('show', visible);
    if (w && w.classList.contains('waifu-hidden')) setOpen(false);
  };
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  sync();
})();
