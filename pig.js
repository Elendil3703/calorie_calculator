/* 小猪彩蛋：每次只出现一只小猪，按 PIGS 顺序轮换，从页面四周（上下左右边缘）
   随机位置滑进来，整只停在屏幕内，待几秒再缩回去，隔一会儿换下一只。
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

  const rand = (a, b) => a + Math.random() * (b - a);

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
    /* 初始先藏在屏幕外，轮到它才出场 */
    el.style.transform = 'translateY(200vh)';
    document.body.appendChild(el);
    return el;
  });

  let turn = 0; // 按顺序轮换：0, 1, 0, 1, …

  function round() {
    const el = sprites[turn];
    turn = (turn + 1) % sprites.length;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 100;
    const h = el.offsetHeight || 100;

    const edge = EDGES[Math.floor(Math.random() * EDGES.length)];
    let x, y;
    if (edge === 'top' || edge === 'bottom') {
      x = rand(8, Math.max(9, vw - w - 8));
      y = edge === 'top' ? 0 : vh - h;
    } else {
      x = edge === 'left' ? 0 : vw - w;
      y = rand(60, Math.max(61, vh - h - 8));
    }

    el.style.top = y + 'px';
    el.style.left = x + 'px';
    el.style.right = el.style.bottom = 'auto';

    /* 先无动画地挪到屏幕外的起点，强制 reflow 后再滑入到完全露出 */
    el.style.transition = 'none';
    el.style.transform = HIDDEN[edge];
    el.getBoundingClientRect();
    el.style.transition = '';
    el.style.transform = 'translate(0, 0)';

    /* 待几秒缩回，隔一会儿换下一只 */
    setTimeout(() => {
      el.style.transform = HIDDEN[edge];
      setTimeout(() => setTimeout(round, rand(2500, 7000)), 900);
    }, rand(3200, 5500));
  }

  setTimeout(round, 1500);
})();
