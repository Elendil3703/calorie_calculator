/* 小猪彩蛋：一只小猪随机从页面四周（上下左右边缘）探出头来，待几秒再缩回去。
   完全独立于 app.js —— 想整体移除时删掉 index.html 里对应的 <script> 即可。
   目前用 🐷 emoji 占位；换成真图时把下面 PIG_IMG 填上图片路径即可。 */
(() => {
  const PIG_IMG = 'pig.png?v=20260707a'; // 留空则退回 emoji 占位

  const style = document.createElement('style');
  style.textContent = `
    #pigSprite {
      position: fixed;
      z-index: 50; /* 低于 .overlay(100) / #initOverlay(200)，登录和弹窗永远盖住它 */
      pointer-events: none;
      user-select: none;
      transition: transform 0.7s cubic-bezier(.34, 1.56, .64, 1);
      filter: drop-shadow(0 2px 5px rgba(0, 0, 0, .18));
    }
    #pigSprite .pig-inner {
      display: block;
      font-size: 46px;
      line-height: 1;
      animation: pig-wiggle 1.6s ease-in-out infinite;
    }
    #pigSprite .pig-inner img {
      width: 96px;
      height: 96px;
      object-fit: contain;
      display: block;
    }
    @keyframes pig-wiggle {
      0%, 100% { transform: rotate(-6deg); }
      50%      { transform: rotate(6deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      #pigSprite { transition: none; }
      #pigSprite .pig-inner { animation: none; }
    }
  `;
  document.head.appendChild(style);

  const pig = document.createElement('div');
  pig.id = 'pigSprite';
  const inner = document.createElement('span');
  inner.className = 'pig-inner';
  if (PIG_IMG) {
    const img = document.createElement('img');
    img.src = PIG_IMG;
    img.alt = '小猪';
    inner.appendChild(img);
  } else {
    inner.textContent = '🐷';
  }
  pig.appendChild(inner);
  document.body.appendChild(pig);

  /* 探头时几乎整只露出（只藏 8%），缩回时整个移出屏幕外（fixed 元素不会撑出滚动条） */
  const HIDDEN = {
    top: 'translateY(-120%)',
    bottom: 'translateY(120%)',
    left: 'translateX(-120%)',
    right: 'translateX(120%)',
  };
  const PEEK = {
    top: 'translateY(-8%)',
    bottom: 'translateY(8%)',
    left: 'translateX(-8%)',
    right: 'translateX(8%)',
  };
  const EDGES = ['top', 'right', 'bottom', 'left'];

  const rand = (a, b) => a + Math.random() * (b - a);

  function showOnce() {
    const edge = EDGES[Math.floor(Math.random() * EDGES.length)];
    pig.style.top = pig.style.bottom = pig.style.left = pig.style.right = 'auto';
    pig.style[edge] = '0';
    if (edge === 'top' || edge === 'bottom') {
      pig.style.left = rand(6, 82) + '%';
    } else {
      pig.style.top = rand(10, 80) + '%';
    }

    /* 先无动画地挪到屏幕外的起点，强制 reflow 后再开启过渡滑入 */
    pig.style.transition = 'none';
    pig.style.transform = HIDDEN[edge];
    pig.getBoundingClientRect();
    pig.style.transition = '';
    pig.style.transform = PEEK[edge];

    setTimeout(() => {
      pig.style.transform = HIDDEN[edge];
      setTimeout(schedule, 800); // 等滑出动画走完再排下一次
    }, rand(3000, 5000));
  }

  function schedule() {
    setTimeout(showOnce, rand(2500, 7000));
  }

  /* 首次出现快一点，让人注意到它 */
  setTimeout(showOnce, 1500);
})();
