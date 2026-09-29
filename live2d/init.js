// 看板娘（猫）入口：加载 live2d-widgets 并使用本站自托管的 hijiki 模型。
// 组件文件由 scripts/live2d.js 从 node_modules/live2d-widgets 发布到 /live2d/，升级：npm update live2d-widgets
(async () => {
  if (window.innerWidth < 768) return; // 手机上不显示

  const base = '/live2d/';
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

  try {
    await Promise.all([load(base + 'waifu.css', 'css'), load(base + 'waifu-tips.js', 'js')]);
    window.initWidget({
      waifuPath: base + 'waifu-tips.json',
      cdnPath: base,                       // model_list.json 与 model/hijiki/ 都在这里
      cubism2Path: base + 'live2d.min.js', // hijiki 是 Cubism 2 模型
      tools: ['hitokoto', 'photo', 'quit'],
      logLevel: 'warn',
      drag: false,
    });
  } catch (e) {
    console.warn('[live2d]', e);
  }
})();
