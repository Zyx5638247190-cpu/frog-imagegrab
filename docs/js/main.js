/* ==========================================================================
   奶龙取图 / DragonGrab —— 官网交互脚本（原生 JS，无任何依赖）
   --------------------------------------------------------------------------
   包含 7 个模块：
     1. 深色模式切换（localStorage 记忆 + 跟随系统）
     2. 顶部导航：滚动加阴影、移动端汉堡菜单、滚动高亮当前区块
     3. 滚动出场动画（IntersectionObserver，只播一次）
     4. 数据区数字增长动画（easeOutCubic）
     5. 手风琴折叠（FAQ + 更新日志，带无障碍属性）
     6. 回到顶部按钮
     7. 锚点跳转（补偿吸顶导航高度）+ 轻提示 Toast
   说明：Hero / 演示区的动画全部由 CSS 完成，JS 不参与，保证流畅。
   ========================================================================== */

(function () {
  'use strict';

  /* 标记 JS 可用：CSS 里只有 .js .reveal 才会先把元素隐藏起来，
     这样即使浏览器禁用 JS，页面内容也依然完整可见 */
  document.documentElement.classList.add('js');

  /* ---------- 小工具 ---------- */
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  // 用户是否在系统层面要求「减少动态效果」
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ========================================================================
     1. 深色模式
     ======================================================================== */
  const THEME_KEY = 'dg-theme';
  const themeToggle = $('#themeToggle');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  /** 读取保存的主题；没保存过就跟随系统偏好 */
  function getStoredTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {
      // 隐私模式 / 禁用本地存储时读取会抛错，忽略即可
    }
    return systemDark.matches ? 'dark' : 'light';
  }

  /** 应用主题；persist 为 true 时写入 localStorage 记住用户选择 */
  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);

    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    }

    // 同步移动端浏览器地址栏的配色
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#15130C' : '#FFCA28');

    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 写入失败忽略 */ }
    }
  }

  applyTheme(getStoredTheme(), false);

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark', true);
    });
  }

  // 用户没手动选过主题时，跟随系统日夜切换
  const onSystemThemeChange = function (e) {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* 忽略 */ }
    if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
  };
  if (typeof systemDark.addEventListener === 'function') {
    systemDark.addEventListener('change', onSystemThemeChange);
  } else if (typeof systemDark.addListener === 'function') {
    systemDark.addListener(onSystemThemeChange);   // 兼容老版 Chrome
  }

  /* ========================================================================
     2. 顶部导航
     ======================================================================== */
  const nav = $('#nav');
  const menuToggle = $('#menuToggle');
  const navMenu = $('#navMenu');

  /** 收起移动端菜单，并把无障碍状态同步回去 */
  function closeMenu() {
    if (!navMenu || !menuToggle) return;
    navMenu.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '打开菜单');
  }

  if (menuToggle && navMenu) {
    // 汉堡按钮：点一下展开，再点一下收起
    menuToggle.addEventListener('click', function () {
      const isOpen = navMenu.classList.toggle('is-open');
      menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      menuToggle.setAttribute('aria-label', isOpen ? '关闭菜单' : '打开菜单');
    });

    // 点击菜单里的链接后自动收起
    $$('.nav__link', navMenu).forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });

    // 点击页面其它地方 / 按 ESC 也收起
    document.addEventListener('click', function (e) {
      if (!navMenu.classList.contains('is-open')) return;
      if (navMenu.contains(e.target) || menuToggle.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    // 窗口拉宽回到桌面布局时，重置菜单状态
    window.addEventListener('resize', function () {
      if (window.innerWidth > 767) closeMenu();
    });
  }

  /* ---------- 滚动时：导航加阴影 + 高亮当前区块 + 显示回到顶部 ---------- */
  const sections = $$('section[id]');
  const navLinks = $$('.nav__link[href^="#"]');
  const toTop = $('#toTop');
  let ticking = false;

  /* 只有「有对应导航链接」的区块才参与高亮判断，
     这样滚动经过 stats / demo / compare 这类没有导航链接的区块时，
     高亮会停留在上一个经过的导航区块上，不会闪一下消失 */
  const navTargets = sections.filter(function (sec) {
    return navLinks.some(function (link) {
      return link.getAttribute('href') === '#' + sec.id;
    });
  });

  function onScroll() {
    const y = window.scrollY;

    // 吸顶导航滚过一段距离后加深阴影
    if (nav) nav.classList.toggle('is-scrolled', y > 12);
    // 向下滚动一定距离后出现「回到顶部」按钮
    if (toTop) toTop.classList.toggle('is-visible', y > 600);

    // 滚动高亮：取当前视口上方最近的一个导航区块
    let currentId = '';
    const line = y + 120;   // 吸顶导航的高度补偿
    navTargets.forEach(function (sec) {
      if (sec.offsetTop <= line) currentId = sec.id;
    });

    // 已经滚到页面最底部时，强制高亮最后一个导航区块。
    // 底部 CTA 区块很高，「下载插件」这一项否则永远等不到进入高亮区间。
    if (navTargets.length && y + window.innerHeight >= document.documentElement.scrollHeight - 4) {
      currentId = navTargets[navTargets.length - 1].id;
    }

    navLinks.forEach(function (link) {
      const isActive = currentId !== '' && link.getAttribute('href') === '#' + currentId;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    ticking = false;
  }

  // 用 requestAnimationFrame 节流，滚动事件本身设为 passive 提升性能
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(onScroll);
  }, { passive: true });

  onScroll();   // 首屏先跑一次（处理刷新后停在页面中间的情况）

  /* ========================================================================
     3. 滚动出场动画（淡入上移）
     ======================================================================== */
  const revealItems = $$('.reveal');

  if (!('IntersectionObserver' in window) || prefersReducedMotion) {
    // 不支持 IntersectionObserver 或用户要求减少动画：直接全部显示
    revealItems.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    const revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);   // 每块只播一次
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    revealItems.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ========================================================================
     4. 数字增长动画
     ======================================================================== */
  /** 千分位格式化：10000 → 10,000 */
  function withComma(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function countUp(el) {
    const target = parseInt(el.getAttribute('data-count'), 10) || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    const useComma = el.getAttribute('data-format') === 'comma';
    const duration = 1500;

    if (prefersReducedMotion) {
      el.textContent = (useComma ? withComma(target) : target) + suffix;
      return;
    }

    const start = performance.now();
    function frame(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);   // easeOutCubic：先快后稳
      const value = Math.round(target * eased);
      el.textContent = (useComma ? withComma(value) : value) + suffix;
      if (progress < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  const counters = $$('[data-count]');
  if (counters.length) {
    if (!('IntersectionObserver' in window)) {
      counters.forEach(countUp);   // 降级：直接开始数
    } else {
      const countObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          countUp(entry.target);
          countObserver.unobserve(entry.target);
        });
      }, { threshold: 0.5 });
      counters.forEach(function (el) { countObserver.observe(el); });
    }
  }

  /* ========================================================================
     5. 手风琴折叠（FAQ + 更新日志）
     用 max-height 过渡实现平滑展开 / 收起
     ======================================================================== */
  $$('.acc').forEach(function (acc) {
    $$('.acc__item', acc).forEach(function (item) {
      const btn = $('.acc__btn', item);
      const panel = $('.acc__panel', item);
      if (!btn || !panel) return;

      btn.addEventListener('click', function () {
        const isOpen = btn.getAttribute('aria-expanded') === 'true';

        if (isOpen) {
          // 收起：先把当前实际高度固定住（否则从 none 跳回 0 不会过渡）
          panel.style.maxHeight = panel.scrollHeight + 'px';
          window.requestAnimationFrame(function () {
            panel.style.maxHeight = '0px';
          });
          btn.setAttribute('aria-expanded', 'false');
          item.classList.remove('is-open');
          return;
        }

        // 展开
        panel.style.maxHeight = panel.scrollHeight + 'px';
        btn.setAttribute('aria-expanded', 'true');
        item.classList.add('is-open');

        // 动画结束后释放高度限制，内容变化（换行、缩放）也不会被裁掉
        const onEnd = function (e) {
          if (e.target !== panel || e.propertyName !== 'max-height') return;
          panel.style.maxHeight = 'none';
          panel.removeEventListener('transitionend', onEnd);
        };
        panel.addEventListener('transitionend', onEnd);
      });
    });
  });

  // 窗口尺寸变化时，已展开的面板重新计算高度
  let resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      $$('.acc__item.is-open .acc__panel').forEach(function (panel) {
        if (panel.style.maxHeight && panel.style.maxHeight !== 'none') {
          panel.style.maxHeight = panel.scrollHeight + 'px';
        }
      });
    }, 150);
  });

  /* ========================================================================
     6. 回到顶部
     ======================================================================== */
  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion ? 'auto' : 'smooth'
      });
    });
  }

  /* ========================================================================
     7. 锚点跳转
     让所有页内链接都滚动到位，并为吸顶导航留出间距
     由于导航是 fixed，直接跳到锚点会被挡住，所以手动计算偏移量
     ======================================================================== */
  $$('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      const href = link.getAttribute('href');

      // 占位链接（GitHub 仓库等）不跳转
      if (!href || href === '#') {
        e.preventDefault();
        return;
      }

      const target = document.getElementById(href.slice(1));
      if (!target) return;

      e.preventDefault();

      const navHeight = nav ? nav.getBoundingClientRect().height : 0;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 14;

      window.scrollTo({
        top: Math.max(top, 0),
        behavior: prefersReducedMotion ? 'auto' : 'smooth'
      });

      // 同步地址栏，方便复制当前定位（用 replaceState 不产生多余历史记录）
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', href);
      }
    });
  });

  /* ========================================================================
     下载按钮
     真实下载交给浏览器默认行为（href 指向打包好的 zip），这里只补一句引导提示
     ======================================================================== */
  const downloadBtn = document.getElementById('downloadBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      showToast('嗷！压缩包开始下载啦，解压后按下面四步安装～');
    });
  }

  /* ========================================================================
     小工具：轻提示 Toast（占位链接、后续扩展用）
     ======================================================================== */
  let toastEl = null;
  let toastTimer = null;

  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');   // 屏幕阅读器会播报
      toastEl.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:28px',
        'z-index:80',
        'transform:translateX(-50%) translateY(14px)',
        'max-width:min(90vw,26rem)',
        'padding:.7em 1.2em',
        'border:2px solid var(--primary-2)',
        'border-radius:999px',
        'background:var(--surface)',
        'color:var(--brown)',
        'font-size:.86rem',
        'font-weight:700',
        'text-align:center',
        'box-shadow:var(--shadow-lg)',
        'opacity:0',
        'transition:opacity .24s ease, transform .24s ease',
        'pointer-events:none'
      ].join(';');
      document.body.appendChild(toastEl);
    }

    toastEl.textContent = text;
    window.requestAnimationFrame(function () {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translateX(-50%) translateY(0)';
    });

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(14px)';
    }, 3200);
  }
})();
