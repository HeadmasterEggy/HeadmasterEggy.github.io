// 看板猫聊天面板：在猫的工具栏加一个“聊天”按钮，对话由 Cloudflare Worker（workers/cat-agent）转给 DeepSeek。
// 用法：window.CAT_AGENT_URL 指向 Worker 的 /chat 地址（见 init.js）。
(() => {
  const url = window.CAT_AGENT_URL;
  if (!url || window.__catAgentLoaded) return;
  window.__catAgentLoaded = true;

  const STORE = 'cat-chat-history';
  const GREETING = '喵～我是这个博客的看板猫。想找哪方面的笔记，或者想聊聊当前这页，都可以问我。';
  const ICON = '<svg viewBox="0 0 512 512" aria-label="chat"><path d="M256 32C114.6 32 0 125.1 0 240c0 49.6 21.4 95 57 130.7C44.5 421.1 2.7 466 2.2 466.5c-2.2 2.3-2.8 5.7-1.5 8.7S4.8 480 8 480c66.3 0 116-31.8 140.6-51.4 32.7 12.3 69 19.4 107.4 19.4 141.4 0 256-93.1 256-208S397.4 32 256 32z"/></svg>';

  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]').filter(m => m && typeof m.content === 'string'); } catch (e) { /* 无痕模式等 */ }
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))); } catch (e) { /* ignore */ } };

  // ───── 面板 ─────
  const panel = document.createElement('div');
  panel.id = 'cat-chat';
  panel.innerHTML = `<header><span>和猫聊聊</span><button type="button" aria-label="关闭">×</button></header>
    <div class="msgs" aria-live="polite"></div>
    <form><textarea rows="1" maxlength="800" placeholder="想问点什么？Enter 发送" aria-label="消息"></textarea><button type="submit">发送</button></form>
    <small>由 DeepSeek 驱动，可能出错；请不要输入隐私信息。</small>`;
  document.body.appendChild(panel);
  const msgs = panel.querySelector('.msgs');
  const form = panel.querySelector('form');
  const input = panel.querySelector('textarea');
  const sendBtn = form.querySelector('button');
  let busy = false;

  // 极简且安全的渲染：只支持 **粗体**、`代码` 和站内/https 链接，其余一律按纯文本
  function render(el, text) {
    el.textContent = '';
    const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      el.append(text.slice(last, m.index));
      if (m[1]) {
        let ok = false;
        try { const u = new URL(m[2], location.href); ok = u.origin === location.origin || u.protocol === 'https:'; } catch (e) { /* bad url */ }
        if (ok) { const a = document.createElement('a'); a.textContent = m[1]; a.href = m[2]; if (!m[2].startsWith('/')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } el.append(a); }
        else el.append(m[1]);
      } else if (m[3]) { const b = document.createElement('strong'); b.textContent = m[3]; el.append(b); }
      else { const c = document.createElement('code'); c.textContent = m[4]; el.append(c); }
      last = re.lastIndex;
    }
    el.append(text.slice(last));
  }

  function add(role, text, cls = '') {
    const el = document.createElement('div');
    el.className = `msg ${role} ${cls}`.trim();
    render(el, text);
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // 打字机效果（尊重“减少动画”偏好）
  async function typewriter(el, text) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || text.length > 400) return render(el, text);
    const step = Math.max(1, Math.ceil(text.length / 60));
    for (let i = step; i < text.length; i += step) {
      el.textContent = text.slice(0, i);
      msgs.scrollTop = msgs.scrollHeight;
      await new Promise(r => setTimeout(r, 22));
    }
    render(el, text);
  }

  history.forEach(m => add(m.role === 'user' ? 'me' : 'cat', m.content));
  if (!history.length) add('cat', GREETING);

  async function send(text) {
    busy = true; sendBtn.disabled = true;
    add('me', text);
    history.push({ role: 'user', content: text });
    const pending = add('cat', '', 'typing');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-10), page: { title: document.title.slice(0, 100), url: location.pathname } })
      });
      const data = await res.json().catch(() => ({}));
      pending.classList.remove('typing');
      if (!res.ok || !data.reply) {
        pending.classList.add('err');
        pending.textContent = res.status === 429 ? '喵…问得太快啦，等一分钟再来吧。' : '喵…我这边出了点问题，稍后再试试。';
        history.pop();
      } else {
        await typewriter(pending, data.reply);
        history.push({ role: 'assistant', content: data.reply });
      }
    } catch (e) {
      pending.classList.remove('typing'); pending.classList.add('err');
      pending.textContent = e.name === 'AbortError' ? '喵…等太久了，再试一次吧。' : '喵…网络好像断了。';
      history.pop();
    } finally {
      clearTimeout(timer); busy = false; sendBtn.disabled = false; save(); input.focus();
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } // isComposing：输入法选字时的回车不发送
  });

  let button;
  const setOpen = open => {
    panel.classList.toggle('open', open);
    button && button.classList.toggle('active', open);
    if (open) { msgs.scrollTop = msgs.scrollHeight; input.focus(); }
  };
  panel.querySelector('header button').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false); });

  // 等猫的工具栏出现后加“聊天”按钮；猫被关闭时同时收起面板
  const mount = () => {
    const tool = document.getElementById('waifu-tool');
    if (!tool || document.getElementById('waifu-tool-chat')) return !!tool;
    button = document.createElement('span');
    button.id = 'waifu-tool-chat';
    button.title = '和猫聊聊';
    button.innerHTML = ICON;
    button.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    tool.insertBefore(button, tool.firstChild);
    return true;
  };
  const obs = new MutationObserver(() => {
    mount();
    const w = document.getElementById('waifu');
    if (w && w.classList.contains('waifu-hidden')) setOpen(false);
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  mount();
})();
