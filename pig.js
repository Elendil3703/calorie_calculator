/* 小猪彩蛋：每一轮所有小猪同时从页面四周（上下左右边缘）滑进来，整只停在屏幕内，
   位置随机但互不重叠，待几秒后一起缩回去，隔一会儿再来下一轮。
   完全独立于 app.js —— 想整体移除时删掉 index.html 里对应的 <script> 即可。
   PIGS 里每个图片一只小猪；数组留空则退回 🐷 emoji。 */
(() => {
  const PIGS = ['pig.png?v=20260707a', 'pig2.png?v=20260707c'];

  const style = document.createElement('style');
  style.textContent = `
    .pig-sprite {
      position: fixed;
      z-index: 50; /* 低于 .overlay(100) / #initOverlay(200)，登录和弹窗永远盖住它 */
      pointer-events: none;
      user-select: none;
      transition: transform 0.7s cubic-bezier(.34, 1.56, .64, 1);
      filter: drop-shadow(0 2px 5px rgba(0, 0, 0, .18));
    }
    .pig-sprite .pig-inner {
      display: block;
      font-size: 46px;
      line-height: 1;
      animation: pig-wiggle 1.6s ease-in-out infinite;
    }
    .pig-sprite .pig-inner img {
      height: 96px;
      width: auto;
      max-width: 150px;
      object-fit: contain;
      display: block;
    }
    @keyframes pig-wiggle {
      0%, 100% { transform: rotate(-4deg); }
      50%      { transform: rotate(4deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .pig-sprite { transition: none; }
      .pig-sprite .pig-inner { animation: none; }
    }
  `;
  document.head.appendChild(style);

  /* 缩回时整个移出屏幕外（fixed 元素不会撑出滚动条），探头时整只都在屏幕内 */
  const HIDDEN = {
    top: 'translateY(-130%)',
    bottom: 'translateY(130%)',
    left: 'translateX(-130%)',
    right: 'translateX(130%)',
  };
  const EDGES = ['top', 'right', 'bottom', 'left'];
  const GAP = 24; // 小猪之间至少留的空隙 (px)

  const rand = (a, b) => a + Math.random() * (b - a);
  const overlaps = (a, b) =>
    a.left < b.right + GAP && a.right > b.left - GAP &&
    a.top < b.bottom + GAP && a.bottom > b.top - GAP;

  const sprites = (PIGS.length ? PIGS : ['']).map(src => {
    const el = document.createElement('div');
    el.className = 'pig-sprite';
    const inner = document.createElement('span');
    inner.className = 'pig-inner';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '小猪';
      inner.appendChild(img);
    } else {
      inner.textContent = '🐷';
    }
    el.appendChild(inner);
    document.body.appendChild(el);
    return { el, edge: 'bottom' };
  });

  /* 一轮：给每只猪挑一个不和已挑位置重叠的随机位置，然后一起滑进来 */
  function round() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const taken = [];

    sprites.forEach((s, i) => {
      const w = s.el.offsetWidth || 100;
      const h = s.el.offsetHeight || 100;
      let edge, x, y, rect;
      for (let attempt = 0; attempt < 20; attempt++) {
        edge = EDGES[Math.floor(Math.random() * EDGES.length)];
        if (edge === 'top' || edge === 'bottom') {
          x = rand(8, Math.max(9, vw - w - 8));
          y = edge === 'top' ? 0 : vh - h;
        } else {
          x = edge === 'left' ? 0 : vw - w;
          y = rand(60, Math.max(61, vh - h - 8));
        }
        rect = { left: x, top: y, right: x + w, bottom: y + h };
        if (!taken.some(r => overlaps(rect, r))) break;
      }
      taken.push(rect);
      s.edge = edge;

      const el = s.el;
      el.style.top = y + 'px';
      el.style.left = x + 'px';
      el.style.right = el.style.bottom = 'auto';

      /* 先无动画地挪到屏幕外的起点，强制 reflow 后再滑入；
         第二只略微晚一点点出发，更有生气但仍算“同时” */
      el.style.transition = 'none';
      el.style.transform = HIDDEN[edge];
      el.getBoundingClientRect();
      setTimeout(() => {
        el.style.transition = '';
        el.style.transform = 'translate(0, 0)';
      }, 30 + i * 220);
    });

    /* 待几秒后一起缩回，再排下一轮 */
    setTimeout(() => {
      sprites.forEach(s => { s.el.style.transform = HIDDEN[s.edge]; });
      setTimeout(() => setTimeout(round, rand(2500, 7000)), 900);
    }, rand(3200, 5500));
  }

  setTimeout(round, 1500);
})();
