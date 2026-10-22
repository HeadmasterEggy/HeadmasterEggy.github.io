// 看板娘（猫）入口：加载 live2d-widgets 并使用本站自托管的 hijiki 模型。
// 组件文件由 scripts/live2d.js 从 node_modules/live2d-widgets 发布到 /live2d/，升级：npm update live2d-widgets
(async () => {
  if (window.innerWidth < 768) return; // 手机上不显示

  const base = '/live2d/';
  // 猫 agent 的后端地址（workers/cat-agent 部署后填这里，形如 https://cat-agent.<账号>.workers.dev/chat）。
  // 留空则不显示聊天按钮；本地调试可在控制台执行 localStorage.setItem('cat-agent-url', '<地址>') 覆盖。
  const AGENT_URL = 'https://cat-agent.headmastereggy.workers.dev/chat';
  try { window.CAT_AGENT_URL = localStorage.getItem('cat-agent-url') || AGENT_URL; } catch (e) { window.CAT_AGENT_URL = AGENT_URL; }
  // 避免模型贴图的跨域问题
  const OriginalImage = window.Image;
  window.Image = function (...args) {
    const img = new OriginalImage(...args);
    img.crossOrigin = 'anonymous';
    return img;
  };
  window.Image.prototype = OriginalImage.prototype;

  const load = (url, type) => new Promise((resolve, reject) => {
    const tag = document.createElement(type === 'css' ? 'link' : 'script');
    if (type === 'css') tag.rel = 'stylesheet', tag.href = url;
    else tag.type = 'module', tag.src = url;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error('failed to load ' + url));
    document.head.appendChild(tag);
  });

  // ───── 拖动猫：按住猫身体拖到想要的位置，位置记在浏览器里 ─────
  function enableDrag() {
    const root = document.documentElement;
    const KEY = 'cat-pos';
    const SIZE = { w: 180, h: 190, dockPad: 56, edge: 8 }; // 猫占位、脚下工具条需要的底部空间、留边
    const DEFAULT = { r: 72, b: 72 };
    let pos = { ...DEFAULT };
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Number.isFinite(s.r) && Number.isFinite(s.b)) pos = { r: s.r, b: s.b };
    } catch (e) { /* 无痕模式等 */ }

    const apply = () => {
      pos.r = Math.min(Math.max(pos.r, SIZE.edge), Math.max(SIZE.edge, innerWidth - SIZE.w - SIZE.edge));
      pos.b = Math.min(Math.max(pos.b, SIZE.dockPad), Math.max(SIZE.dockPad, innerHeight - SIZE.h - SIZE.edge));
      root.style.setProperty('--cat-r', pos.r + 'px');
      root.style.setProperty('--cat-b', pos.b + 'px');
      window.dispatchEvent(new Event('cat:move')); // 聊天面板据此重新定位
    };
    apply();
    setTimeout(() => root.classList.add('cat-ready'), 3600); // 入场动画（3s）结束之后
    window.addEventListener('resize', apply);

    // 猫的画布由组件异步创建，出现后再绑定拖动
    const bind = canvas => {
      let drag = null;
      canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, r: pos.r, b: pos.b, moved: false };
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return; // 小幅抖动算点击，不算拖动
        if (!drag.moved) { drag.moved = true; root.classList.add('cat-dragging'); }
        pos.r = drag.r - dx;
        pos.b = drag.b - dy;
        apply();
      });
      const end = () => {
        if (!drag) return;
        if (drag.moved) { try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ } }
        root.classList.remove('cat-dragging');
        drag = null;
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      // 双击猫：回到默认位置（带一小段滑动动画）
      canvas.title = '拖动可以移动，双击回到原位';
      canvas.addEventListener('dblclick', () => {
        pos = { r: DEFAULT.r, b: DEFAULT.b };
        try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
        root.classList.add('cat-anim');
        apply();
        setTimeout(() => root.classList.remove('cat-anim'), 500);
      });
    };
    const found = document.getElementById('live2d');
    if (found) return bind(found);
    const timer = setInterval(() => {
      const c = document.getElementById('live2d');
      if (c) { clearInterval(timer); bind(c); }
    }, 200);
    setTimeout(() => clearInterval(timer), 20000);
  }

  try {
    await Promise.all([load(base + 'waifu.css', 'css'), load(base + 'cat.css', 'css'), load(base + 'waifu-tips.js', 'js')]);
    window.initWidget({
      waifuPath: base + 'waifu-tips.json',
      cdnPath: base,                       // model_list.json 与 model/hijiki/ 都在这里
      cubism2Path: base + 'live2d.min.js', // hijiki 是 Cubism 2 模型
      tools: [], // 不用自带工具按钮；入口是 agent.js 里的工具条
      logLevel: 'warn',
      drag: false,
    });
    enableDrag();
    if (window.CAT_AGENT_URL) {
      const s = document.createElement('script');
      s.src = base + 'agent.js';
      document.head.appendChild(s);
    }
  } catch (e) {
    console.warn('[live2d]', e);
  }
})();
