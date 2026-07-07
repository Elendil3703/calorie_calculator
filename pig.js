/* 小猪彩蛋：几只小猪各自随机从页面四周（上下左右边缘）滑进来，整只停在屏幕内，
   待几秒再缩回去。位置随机，但互相不重叠。
   完全独立于 app.js —— 想整体移除时删掉 index.html 里对应的 <script> 即可。
   PIGS 里每个图片各生成一只独立行动的小猪；数组留空则退回 🐷 emoji。 */
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
  const GAP = 24; // 两只小猪之间至少留的空隙 (px)

  const rand = (a, b) => a + Math.random() * (b - a);
  const overlaps = (a, b) =>
    a.left < b.right + GAP && a.right > b.left - GAP &&
    a.top < b.bottom + GAP && a.bottom > b.top - GAP;

  /* 所有小猪的登记表，用来做“随机但不重叠” */
  const active = [];

  function spawnPig(src, firstDelay) {
    const pig = document.createElement('div');
    pig.className = 'pig-sprite';
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
    pig.appendChild(inner);
    document.body.appendChild(pig);

    const me = { rect: null, visible: false };
    active.push(me);

    function showOnce() {
      const w = pig.offsetWidth || 100;
      const h = pig.offsetHeight || 100;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      /* 随机挑边和位置，撞上别的小猪就重挑几次 */
      let edge, x, y, rect;
      for (let attempt = 0; attempt < 12; attempt++) {
        edge = EDGES[Math.floor(Math.random() * EDGES.length)];
        if (edge === 'top' || edge === 'bottom') {
          x = rand(8, Math.max(9, vw - w - 8));
          y = edge === 'top' ? 0 : vh - h;
        } else {
          x = edge === 'left' ? 0 : vw - w;
          y = rand(60, Math.max(61, vh - h - 8));
        }
        rect = { left: x, top: y, right: x + w, bottom: y + h };
        if (!active.some(o => o !== me && o.visible && o.rect && overlaps(rect, o.rect))) break;
      }
      me.rect = rect;
      me.visible = true;

      pig.style.top = y + 'px';
      pig.style.left = x + 'px';
      pig.style.right = pig.style.bottom = 'auto';

      /* 先无动画地挪到屏幕外的起点，强制 reflow 后再开启过渡滑入到完全露出 */
      pig.style.transition = 'none';
      pig.style.transform = HIDDEN[edge];
      pig.getBoundingClientRect();
      pig.style.transition = '';
      pig.style.transform = 'translate(0, 0)';

      setTimeout(() => {
        pig.style.transform = HIDDEN[edge];
        setTimeout(() => {
          me.visible = false; // 完全缩回去了才让出位置
          schedule();
        }, 800);
      }, rand(3000, 5000));
    }

    function schedule() {
      setTimeout(showOnce, rand(2500, 7000));
    }

    setTimeout(showOnce, firstDelay);
  }

  if (PIGS.length === 0) PIGS.push('');
  /* 错开出场时间，别两只同时冒出来 */
  PIGS.forEach((src, i) => spawnPig(src, 1500 + i * 3000));
})();
