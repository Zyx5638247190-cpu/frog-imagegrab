/* ==========================================================================
 * 奶龙取图 / DragonGrab —— content.js
 * 职责：
 *   1. 在电商商品详情页注入「奶龙取图」悬浮按钮（可拖拽，右下角默认 20px）
 *   2. 触发懒加载 + 全维度扫描页面图片（img / srcset / data-* / 背景图 / og:image）
 *   3. 过滤垃圾图、补全绝对地址、去重、相似图合并、自动分类（主图/细节图/SKU图）
 *   4. 通过 chrome.runtime.sendMessage 把结果交给 background，由它打开 gallery.html
 *   5. 监听 Alt+S 快捷键（页面内兜底 + background 的 commands 双通道）
 * ========================================================================== */

(function () {
  'use strict';

  // 防止同一页面被重复注入（SPA 路由切换、脚本重复执行等情况）
  if (window.__DG_CONTENT_LOADED__) return;
  window.__DG_CONTENT_LOADED__ = true;

  /* ------------------------------------------------------------------ */
  /* 常量与配置                                                          */
  /* ------------------------------------------------------------------ */

  const FAB_ID = 'dg-fab';
  const TOAST_WRAP_ID = 'dg-toast-wrap';
  const POS_KEY = 'dg_fab_pos';           // 按钮拖拽位置（localStorage，仅本页生效）
  const MIN_SIDE = 100;                   // 小于 100x100 的图片视为图标/装饰，过滤掉

  // 商品详情页 URL 规则：只有这些页面才注入按钮
  const PRODUCT_PAGE_RULES = [
    /item\.taobao\.com\/item\.htm/i,
    /detail\.tmall\.com\/item\.htm/i,
    /detail\.tmall\.hk\/item\.htm/i,
    /item\.jd\.com\/\d+\.html/i,
    /item\.m\.jd\.com\/product/i,
    /mobile\.yangkeduo\.com\/goods/i,
    /mobile\.pinduoduo\.com\/goods/i,
    /mms\.pinduoduo\.com\/.*(goods|edit)/i,
    /\/goods\.html/i,
    /\/goods_detail/i,
    /\/product\/detail/i
  ];

  // 明显不是商品图的 URL 关键字（图标、logo、占位图、水印、二维码等）
  const JUNK_URL_RE = new RegExp([
    'sprite', 'iconfont', 'favicon', '\\/icon', 'icons?\\/', 'logo', 'watermark', 'qrcode', 'qr-code',
    'avatar', 'headimg', 'placeholder', 'blank\\.', 'spacer', 'loading', '1x1', 'pixel\\.gif',
    'transparent', 'no_img', 'noimg', 'default_img', 'defaultimg', 'grey\\.gif', 'grey\\.png',
    'btn_', 'arrow', 'bullet', 'dot\\.gif', 'shoplogo', 'emoji', 'static\\.taobao\\.com'
  ].join('|'), 'i');

  // 懒加载属性名（淘宝用 data-ks-lazyload，京东用 data-lazy-img，通用 data-src/data-original…）
  const LAZY_ATTRS = [
    'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload', 'data-lazy-img',
    'data-img', 'data-image', 'data-url', 'data-echo', 'data-original-src', 'data-srcset',
    'data-lazyload', 'data-actualsrc', 'data-real-src', 'data-imgurl', 'data-big', 'data-large'
  ];

  // 分类容器特征：SKU 图 / 主图 / 细节图
  const SKU_BOX_RE = /(sku|spec|specification|guige|variation|colour|color-?list|style-?list|prop-?list|J_Sku|tb-sku)/i;
  const MAIN_BOX_RE = /(main-?pic|mainpic|mainsrc|gallery|thumbnail|thumb|preview|pic-?list|piclist|imglist|imagelist|J_UlThumb|J_ImgBooth|J_Thumb|swiper|carousel|slideshow|banner|photo|ivy-|tb-gallery|item-?pic|productpic|product-?pic|bigpic|big-?pic)/i;
  const DETAIL_BOX_RE = /(detail|desc|description|introduce|TDetail|J_DivItemDesc|J_ItemDesc|rich-?text|richtext|editor|parameter|module)/i;

  let isExtracting = false;   // 提取中标记，防止重复触发
  let lastStartAt = 0;        // 上一次触发时间（用于识别 Alt+S 双通道的重复触发）

  /* ------------------------------------------------------------------ */
  /* 小奶龙 SVG（黄色 Q 版恐龙）                                          */
  /* ------------------------------------------------------------------ */
  function dragonSvg(gid) {
    return (
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<defs>' +
          '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#FFE082"/>' +
            '<stop offset="1" stop-color="#FFB300"/>' +
          '</linearGradient>' +
        '</defs>' +
        // 尾巴
        '<path d="M13 47 C3 47 5 34 14 35" fill="none" stroke="#FFB300" stroke-width="5" stroke-linecap="round"/>' +
        // 两只小角
        '<path d="M22 17 L19.5 8 L28 13.5 Z" fill="#FF8F00"/>' +
        '<path d="M42 17 L44.5 8 L36 13.5 Z" fill="#FF8F00"/>' +
        // 圆滚滚的头 / 身体
        '<ellipse cx="32" cy="36" rx="22" ry="20" fill="url(#' + gid + ')" stroke="#F9A825" stroke-width="2"/>' +
        // 肚皮
        '<ellipse cx="32" cy="45" rx="13" ry="9.5" fill="#FFF8E1" opacity="0.9"/>' +
        // 大眼睛
        '<ellipse cx="24" cy="30" rx="5.6" ry="6.2" fill="#FFFFFF"/>' +
        '<ellipse cx="41" cy="30" rx="5.6" ry="6.2" fill="#FFFFFF"/>' +
        '<circle cx="25" cy="31" r="3.1" fill="#4E342E"/>' +
        '<circle cx="42" cy="31" r="3.1" fill="#4E342E"/>' +
        '<circle cx="26.2" cy="29.4" r="1.1" fill="#FFFFFF"/>' +
        '<circle cx="43.2" cy="29.4" r="1.1" fill="#FFFFFF"/>' +
        // 腮红
        '<ellipse cx="15" cy="39" rx="4" ry="2.6" fill="#FFAB91" opacity="0.75"/>' +
        '<ellipse cx="49" cy="39" rx="4" ry="2.6" fill="#FFAB91" opacity="0.75"/>' +
        // 嘴巴
        '<path d="M28 40.5 Q32.5 45 37 40.5" fill="none" stroke="#6D4C41" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  /* ------------------------------------------------------------------ */
  /* 提示气泡                                                            */
  /* ------------------------------------------------------------------ */
  function getToastWrap() {
    let wrap = document.getElementById(TOAST_WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = TOAST_WRAP_ID;
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  /**
   * 页面内轻提示
   * @param {string} text 文案
   * @param {number} duration 毫秒
   * @param {boolean} isError 是否错误样式
   */
  function toast(text, duration, isError) {
    try {
      const wrap = getToastWrap();
      const el = document.createElement('div');
      el.className = 'dg-toast' + (isError ? ' dg-toast-error' : '');
      el.innerHTML =
        '<span class="dg-toast-emoji">' + (isError ? '🥺' : '🐲') + '</span>' +
        '<span class="dg-toast-text">' + escapeHtml(text) + '</span>';
      wrap.appendChild(el);
      setTimeout(function () {
        el.classList.add('dg-toast-out');
        setTimeout(function () { el.remove(); }, 260);
      }, duration || 2600);
    } catch (e) {
      // 提示失败不影响主流程
      console.warn('[奶龙取图] toast 失败', e);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* 悬浮按钮                                                            */
  /* ------------------------------------------------------------------ */
  function isProductPage() {
    const href = location.href;
    for (let i = 0; i < PRODUCT_PAGE_RULES.length; i++) {
      if (PRODUCT_PAGE_RULES[i].test(href)) return true;
    }
    // 兜底：URL 里带 item / goods / detail 关键字也认为可能是详情页
    return /(item|goods|detail|product)/i.test(href);
  }

  function createFab() {
    if (document.getElementById(FAB_ID)) return;

    const fab = document.createElement('div');
    fab.id = FAB_ID;
    fab.setAttribute('role', 'button');
    fab.setAttribute('tabindex', '0');
    fab.setAttribute('title', '奶龙取图：一键提取本页所有商品图片（快捷键 Alt+S）');
    fab.innerHTML =
      '<span class="dg-fab-icon">' + dragonSvg('dgFabGrad') + '</span>' +
      '<span class="dg-fab-text">奶龙取图</span>';

    document.body.appendChild(fab);
    restoreFabPosition(fab);
    bindFabEvents(fab);
  }

  /** 恢复上次拖拽的位置 */
  function restoreFabPosition(fab) {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
      placeFab(fab, pos.left, pos.top);
    } catch (e) { /* 忽略损坏的本地数据 */ }
  }

  function placeFab(fab, left, top) {
    const w = fab.offsetWidth || 120;
    const h = fab.offsetHeight || 44;
    const maxLeft = Math.max(4, window.innerWidth - w - 4);
    const maxTop = Math.max(4, window.innerHeight - h - 4);
    const x = Math.min(Math.max(4, left), maxLeft);
    const y = Math.min(Math.max(4, top), maxTop);
    fab.classList.add('dg-dragged');
    fab.style.setProperty('left', x + 'px', 'important');
    fab.style.setProperty('top', y + 'px', 'important');
  }

  function bindFabEvents(fab) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    fab.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      try { fab.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return; // 抖动阈值，避免影响点击
      moved = true;
      fab.classList.add('dg-dragging');
      placeFab(fab, originLeft + dx, originTop + dy);
    });

    fab.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove('dg-dragging');
      try { fab.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

      if (!moved) {
        // 视为点击
        startExtraction();
      } else {
        // 拖动结束后记住位置
        const rect = fab.getBoundingClientRect();
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
        } catch (err) { /* 忽略存储失败 */ }
      }
    });

    fab.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startExtraction();
      }
    });
  }

  function setFabBusy(busy, text) {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    const textEl = fab.querySelector('.dg-fab-text');
    if (busy) {
      fab.classList.add('dg-busy');
      if (textEl) textEl.textContent = text || '奶龙搬图中…';
    } else {
      fab.classList.remove('dg-busy');
      if (textEl) textEl.textContent = '奶龙取图';
    }
  }

  /* ------------------------------------------------------------------ */
  /* 图片提取核心                                                        */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 滚动页面触发懒加载（淘宝/京东/拼多多详情页大量图片是懒加载的）
   * 全程有耗时上限，避免超长页面把页面卡死。
   */
  async function triggerLazyLoad() {
    const t0 = Date.now();
    const startY = window.scrollY;
    const maxScroll = Math.min(
      Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight),
      14000
    );
    const step = Math.max(320, Math.round(window.innerHeight * 0.85));

    for (let y = 0; y <= maxScroll; y += step) {
      window.scrollTo(0, y);
      await sleep(110);
      if (Date.now() - t0 > 5000) break; // 最多滚 5 秒
    }
    window.scrollTo(0, maxScroll);
    await sleep(300);
    window.scrollTo(0, startY);
    await sleep(350);
  }

  /** 相对路径补全为绝对地址 */
  function absUrl(u) {
    if (!u) return '';
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return '';
    }
  }

  /** 判断是否是垃圾图/不可用图 */
  function isJunkUrl(url) {
    if (!url) return true;
    const u = url.toLowerCase();
    if (u.indexOf('data:') === 0) return true;             // base64 内联图
    if (u.indexOf('blob:') === 0) return true;             // 临时 blob
    if (u.indexOf('chrome-extension:') === 0) return true; // 扩展自身资源
    if (/\.svg(\?|#|$)/i.test(u)) return true;             // svg 图标
    if (u.indexOf('javascript:') === 0) return true;
    if (u.length < 16) return true;
    if (!/^https?:\/\//i.test(u)) return true;
    if (JUNK_URL_RE.test(u)) return true;
    if (/[?&](w|h|width|height)=([1-9]|[1-9]\d)\b/i.test(u)) return true; // w=1 / h=12 之类的小图
    return false;
  }

  /**
   * 从 URL 里解析出图片尺寸（很多 CDN 会把尺寸写在路径/参数里）
   * 例：xxx_400x400.jpg → 400x400 ；?imageView2/2/w/800 → 800 宽
   */
  function sizeFromUrl(url) {
    const out = { w: 0, h: 0 };
    try {
      let m = url.match(/_(\d{2,5})x(\d{2,5})(?:xz)?\.(?:jpe?g|png|webp|jpg_)/i);
      if (!m) m = url.match(/[?&_](\d{2,5})x(\d{2,5})(?:\.|_|\/|$)/i);
      if (m) {
        out.w = parseInt(m[1], 10) || 0;
        out.h = parseInt(m[2], 10) || 0;
        return out;
      }
      m = url.match(/[?&](?:imageView2\/\d+\/)?w\/(\d{2,5})/i) || url.match(/[?&]width=(\d{2,5})/i);
      if (m) out.w = parseInt(m[1], 10) || 0;
      m = url.match(/[?&]h\/(\d{2,5})/i) || url.match(/[?&]height=(\d{2,5})/i);
      if (m) out.h = parseInt(m[1], 10) || 0;
      // 京东 n0~n12 缩略规格：n5 = 800x800，n0 为原图
      m = url.match(/\/n(\d{1,2})\//i);
      if (m) {
        const table = { 0: 0, 1: 350, 2: 160, 3: 240, 4: 320, 5: 800, 6: 1200, 7: 640, 8: 400, 9: 280, 10: 200, 11: 120, 12: 800 };
        const s = table[m[1]];
        if (s) { out.w = out.w || s; out.h = out.h || s; }
      }
      // 京东 s450x450_jfs 规格
      m = url.match(/s(\d{2,4})x(\d{2,4})_jfs/i);
      if (m) { out.w = out.w || parseInt(m[1], 10); out.h = out.h || parseInt(m[2], 10); }
    } catch (e) { /* 忽略解析异常 */ }
    return out;
  }

  /**
   * 把缩略图 URL 升级为大图 / 原图 URL
   * 兼容：淘宝/天猫 alicdn、京东 360buyimg、拼多多 pddpic
   */
  function upgradeUrl(url) {
    let out = url;
    try {
      // 淘宝/天猫：xxx.jpg_400x400.jpg / xxx.jpg_400x400xz.jpg / xxx.jpg_.webp / _q75.jpg
      out = out.replace(/(\.(?:jpe?g|png|webp))_\d{2,5}x\d{2,5}(?:xz|q\d+)?\.(?:jpe?g|png|webp)(?=$|\?)/i, '$1');
      out = out.replace(/(\.(?:jpe?g|png|webp))_q\d+\.(?:jpe?g|png|webp)(?=$|\?)/i, '$1');
      out = out.replace(/(\.(?:jpe?g|png|webp))_\d{2,5}x\d{2,5}(?:xz)?(?=$|\?)/i, '$1');
      out = out.replace(/\.jpg_\.webp(?=$|\?)/i, '.jpg');
      out = out.replace(/\.png_\.webp(?=$|\?)/i, '.png');
      out = out.replace(/_\d{2,5}x\d{2,5}q\d+\.jpg(?=$|\?)/i, '.jpg');
      out = out.replace(/(\.jpg)_sum\.jpg(?=$|\?)/i, '$1');

      // 京东：/s450x450_jfs/ → /jfs/ ，/n5/ → /n0/（n0 是原图）
      out = out.replace(/\/s\d{2,5}x\d{2,5}_(jfs)\//i, '/$1/');
      out = out.replace(/\/n([1-9]\d?)\//i, '/n0/');
      out = out.replace(/!q\d+(?:\.dpg)?(?=$|\?)/i, '');

      // 拼多多 / 阿里 OSS：去掉缩放处理参数（用 URLSearchParams 精确删除，避免留下多余的 & 或 ?）
      out = stripResizeParams(out);
    } catch (e) {
      return url;
    }
    return out || url;
  }

  /**
   * 删除 URL 里只跟「显示尺寸」相关的查询参数
   * 例：?imageView2/2/w/400&foo=1、?x-oss-process=image/resize,w_400、?quality=75
   */
  function stripResizeParams(url) {
    const SIZE_KEY_RE = /^(imageview2|imagemogr2|x-oss-process|thumbnail|resize|resize-\w+|quality|q|w|h|width|height|watermark|watermark\w*|crop)/i;
    try {
      const u = new URL(url);
      if (!u.search) return url;
      const keys = [];
      u.searchParams.forEach(function (value, key) { keys.push(key); });
      let changed = false;
      keys.forEach(function (k) {
        if (SIZE_KEY_RE.test(k)) { u.searchParams.delete(k); changed = true; }
      });
      if (!changed) return url;
      // 参数被删空时不要留下孤零零的 "?"
      return u.searchParams.toString() ? u.href : u.href.replace(/\?(?=$|#)/, '');
    } catch (e) {
      // 兜底：正则清理（处理 URL 解析失败的极端情况）
      return url
        .replace(/[?&]imageView2\/[^&]*/gi, '')
        .replace(/[?&]x-oss-process=[^&]*/gi, '')
        .replace(/[?&](?:thumbnail|resize|quality|q)=[^&]*/gi, '')
        .replace(/[?&]+$/, '');
    }
  }

  /**
   * 相似图 / 同图不同尺寸的归一化 key
   * 去掉尺寸标记和无关查询参数后相同的，视为同一张图
   */
  function similarKey(url) {
    let s = url.toLowerCase().split('#')[0];
    try {
      const u = new URL(s);
      u.search = '';
      s = u.host + u.pathname;
    } catch (e) { /* 保留原串 */ }
    s = s.replace(/(\.(?:jpe?g|png|webp))_\d{2,5}x\d{2,5}(?:xz|q\d+)?\.(?:jpe?g|png|webp)$/i, '$1');
    s = s.replace(/_\d{2,5}x\d{2,5}(?:xz|q\d+)?(?=\.(?:jpe?g|png|webp)$)/i, '');
    s = s.replace(/\/s\d{2,5}x\d{2,5}_jfs\//i, '/jfs/');
    s = s.replace(/\/n([1-9]\d?)\//i, '/n0/');
    s = s.replace(/_\d+x\d+(?:z)?(?=\.)/i, '');
    s = s.replace(/(\.(?:jpe?g|png|webp))_\1$/i, '$1');
    return s;
  }

  /** 解析 srcset，返回所有候选 URL */
  function parseSrcset(srcset) {
    const list = [];
    if (!srcset) return list;
    // srcset 里可能混入 data: 内联图（它自带逗号，会干扰「按逗号切分」），先整体剔除
    const cleaned = String(srcset).replace(/data:[^\s,]+,[^\s,]*(\s+\d+(?:\.\d+)?[wx])?/gi, ' ');
    cleaned.split(',').forEach(function (part) {
      const u = part.trim().split(/\s+/)[0];
      if (!u) return;
      if (u.indexOf('data:') === 0) return;
      // 只接受看起来像 URL / 路径的候选，避免把描述符碎片（如 "2x" 被截断的残留）当成图片地址
      if (!/^(https?:)?\/\//i.test(u) && !/^\//.test(u) &&
          !/^[^\s,]+\.(?:jpe?g|png|webp|gif|bmp|avif|jfif)/i.test(u)) return;
      list.push(u);
    });
    return list;
  }

  /** 取元素所在的容器类名/ID 链，用于分类判断（只看最近 5 层，避免被页面级容器误判） */
  function containerChain(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      const cls = typeof node.className === 'string' ? node.className : '';
      const testid = node.getAttribute ? (node.getAttribute('data-testid') || '') : '';
      parts.push(cls + ' ' + (node.id || '') + ' ' + testid);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' | ');
  }

  /** 计算元素上图片的可信尺寸（取最大可信值，避免把 SKU 小缩略图误杀） */
  function measure(el, url) {
    const fromUrl = sizeFromUrl(url);
    let nw = 0, nh = 0;
    if (el && el.tagName === 'IMG') {
      nw = el.naturalWidth || 0;
      nh = el.naturalHeight || 0;
    }
    let rw = 0, rh = 0;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      rw = Math.round(r.width) || 0;
      rh = Math.round(r.height) || 0;
    }
    const attrW = (el && el.getAttribute && parseInt(el.getAttribute('width'), 10)) || 0;
    const attrH = (el && el.getAttribute && parseInt(el.getAttribute('height'), 10)) || 0;

    const w = Math.max(fromUrl.w, nw, rw, attrW);
    const h = Math.max(fromUrl.h, nh, rh, attrH);
    return { w: w, h: h, natural: nw, rendered: rw, fromUrl: fromUrl };
  }

  /** 判断是否隐藏元素 */
  function isHidden(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return true;
    try {
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /**
   * 自动分类：SKU图 / 主图 / 细节图
   * @param {string} chain 容器特征串
   * @param {number} areaRank 面积排名（0 表示最大）
   */
  function classify(chain, areaRank) {
    if (SKU_BOX_RE.test(chain)) return 'SKU图';
    if (MAIN_BOX_RE.test(chain)) return '主图';
    if (DETAIL_BOX_RE.test(chain)) return '细节图';
    // 没有容器线索时：面积最大的前 5 张视为 主图
    if (areaRank >= 0 && areaRank < 5) return '主图';
    return '细节图';
  }

  /**
   * 全量扫描页面图片
   * @returns {Array} 候选图片（已过滤垃圾图 / 去重 / 合并相似图 / 分类）
   */
  function scanDom() {
    const found = new Map(); // key: 归一化 URL，value: 记录

    /** 统一登记一个候选图 */
    function push(rawUrl, el, sourceType, forcedCategory) {
      const url = absUrl(rawUrl);
      if (!url || isJunkUrl(url)) return;
      const upgraded = upgradeUrl(url);
      if (!upgraded || isJunkUrl(upgraded)) return;

      // 站点头尾的 logo/广告一律排除
      if (el && el.closest && el.closest('header,footer,nav,aside,.header,.footer,#header,#footer')) return;
      if (el && isHidden(el)) return;

      const size = measure(el, url);
      const fromUrl = size.fromUrl;
      const chain = el ? containerChain(el) : '';
      const upgradedBig = upgraded !== url;   // URL 里带尺寸标记，说明存在更大的原图

      // 尺寸判断：小于 100x100 且不像「有大图原址的缩略图」就直接丢掉
      const bestW = Math.max(size.w, fromUrl.w);
      const bestH = Math.max(size.h, fromUrl.h);
      const isLikelyOriginal = upgradedBig || SKU_BOX_RE.test(chain) || MAIN_BOX_RE.test(chain);
      if (!isLikelyOriginal && bestW > 0 && bestW < MIN_SIDE) return;
      if (!isLikelyOriginal && bestH > 0 && bestH < MIN_SIDE) return;

      const key = similarKey(upgraded);
      const rec = {
        url: upgraded,                       // 用于下载的大图地址
        thumb: url,                          // 页面上真实出现的地址，用于画廊显示兜底
        width: fromUrl.w || size.natural || size.rendered || size.w || 0,
        // 高度必须取「高」的候选：size.natural / size.rendered 是宽（naturalWidth / 渲染宽），
        // 拿它们兜底会把高写成宽（例如 750x1000 的详情图被记成 750x750），所以这里用 size.h
        height: fromUrl.h || size.h || 0,
        source: sourceType,
        category: forcedCategory || null,
        chainKey: chain.slice(0, 200),
        areaRank: -1,
        variants: []
      };

      const exist = found.get(key);
      if (exist) {
        // 同一张图的不同尺寸：保留更大的那个，并累加相似数量
        exist.variants.push({ url: rec.url, width: rec.width, height: rec.height });
        const existPixels = (exist.width || 0) * (exist.height || 0);
        const recPixels = (rec.width || 0) * (rec.height || 0);
        if (recPixels > existPixels) {
          exist.url = rec.url;
          exist.width = rec.width || exist.width;
          exist.height = rec.height || exist.height;
        }
        if (!exist.thumb) exist.thumb = rec.thumb;
        return;
      }
      found.set(key, rec);
    }

    // ---------- 1) <img> 标签（含所有懒加载属性、srcset） ----------
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const urls = [];

      // srcset 里带宽度的候选，优先取最大的那张
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const best = parseSrcset(srcset)
          .map(function (u) { return { u: u, w: sizeFromUrl(u).w || 0 }; })
          .sort(function (a, b) { return b.w - a.w; })[0];
        if (best) urls.push(best.u);
      }

      LAZY_ATTRS.forEach(function (attr) {
        const v = img.getAttribute(attr);
        if (!v) return;
        if (attr === 'data-srcset') { urls.push.apply(urls, parseSrcset(v)); return; }
        // 有些站点把一个元素上塞了多个地址，用逗号隔开
        if (v.indexOf(',') > -1 && v.indexOf('http') === 0) {
          urls.push.apply(urls, v.split(',').map(function (s) { return s.trim(); }));
        } else {
          urls.push(v);
        }
      });

      if (img.currentSrc) urls.push(img.currentSrc);
      urls.push.apply(urls, parseSrcset(srcset));
      const src = img.getAttribute('src');
      if (src) urls.push(src);

      urls.forEach(function (u) { push(u, img, 'img'); });
    }

    // ---------- 2) <source srcset>（<picture> 里的高清图） ----------
    document.querySelectorAll('picture source[srcset], source[data-srcset]').forEach(function (s) {
      const list = parseSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset') || '');
      list.forEach(function (u) { push(u, s, 'picture'); });
    });

    // ---------- 3) 背景图 background-image ----------
    const bgCandidates = [];
    // 3.1 内联样式里写了 background 的元素（覆盖大部分场景，代价低）
    document.querySelectorAll('[style*="background"]').forEach(function (el) { bgCandidates.push(el); });
    // 3.2 常见图墙容器，抽样检查计算样式（限制数量，避免卡顿）
    const probe = document.querySelectorAll('div,a,span,li,i,em,figure,section,b');
    let probed = 0;
    for (let i = 0; i < probe.length && probed < 3000; i++) {
      const el = probe[i];
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || r.width < MIN_SIDE || r.height < MIN_SIDE) continue; // 小元素不可能承载大图
      probed++;
      bgCandidates.push(el);
    }
    bgCandidates.forEach(function (el) {
      let bg = '';
      try { bg = window.getComputedStyle(el).backgroundImage || ''; } catch (e) { return; }
      if (!bg || bg === 'none' || bg.indexOf('url(') === -1) return;
      const matches = bg.match(/url\((['"]?)(.*?)\1\)/g) || [];
      matches.forEach(function (m) {
        const u = m.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '');
        push(u, el, 'background');
      });
    });

    // ---------- 4) og:image / 页面 meta 主图 ----------
    document.querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[itemprop="image"], link[rel="image_src"]').forEach(function (m) {
      const u = m.getAttribute('content') || m.getAttribute('href');
      if (u) push(u, null, 'meta', '主图');
    });

    // ---------- 5) 面积排名 → 用于兜底分类 ----------
    const list = Array.from(found.values());
    list
      .map(function (rec, idx) { return { idx: idx, area: (rec.width || 0) * (rec.height || 0) }; })
      .sort(function (a, b) { return b.area - a.area; })
      .forEach(function (item, rank) { list[item.idx].areaRank = rank; });

    // ---------- 6) 分类 + 相似数量 ----------
    return list.map(function (rec) {
      return {
        url: rec.url,
        thumb: rec.thumb || rec.url,
        width: rec.width || 0,
        height: rec.height || 0,
        source: rec.source,
        category: rec.category || classify(rec.chainKey, rec.areaRank),
        similarCount: 1 + rec.variants.length,
        variants: rec.variants.slice(0, 8)
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* 提交流程                                                            */
  /* ------------------------------------------------------------------ */
  async function startExtraction() {
    const now = Date.now();
    if (isExtracting) {
      // Alt+S 有「页面内监听」和「浏览器命令」两条通道，短时间内重复触发是正常的，静默忽略
      if (now - lastStartAt > 2500) {
        toast('嗷！奶龙还在搬图，稍等一下下～', 1800);
      }
      return;
    }
    isExtracting = true;
    lastStartAt = now;
    setFabBusy(true, '奶龙搬图中…');

    try {
      await triggerLazyLoad();

      let images = scanDom();

      // 兜底：如果什么都没扫到，再等图片加载一会儿重扫一次
      if (images.length === 0) {
        await sleep(800);
        images = scanDom();
      }

      if (images.length === 0) {
        toast('嗷呜…本页没找到符合条件的大图，换个商品页试试？', 4200, true);
        return;
      }

      // 大图优先排序：像素面积从大到小
      images.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
      images.forEach(function (img, i) {
        img.id = 'dg_' + i + '_' + Math.random().toString(36).slice(2, 8);
      });

      await sendToBackground({
        type: 'DG_EXTRACTED',
        payload: {
          images: images,
          pageUrl: location.href,
          pageTitle: document.title || '',
          host: location.host,
          time: Date.now()
        }
      });

      toast('嗷！找到 ' + images.length + ' 张图啦，正在打开图库…', 2800);
    } catch (err) {
      console.error('[奶龙取图] 提取失败', err);
      toast('嗷呜…提取出错了：' + (err && err.message ? err.message : '未知错误'), 4200, true);
    } finally {
      isExtracting = false;
      setFabBusy(false);
    }
  }

  /** 发送消息给 background（Promise 化 + 错误捕获） */
  function sendToBackground(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        // 扩展被重新加载 / 上下文失效时会走到这里
        reject(new Error('与插件后台通信失败，请刷新页面后重试'));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 快捷键 & 消息监听                                                    */
  /* ------------------------------------------------------------------ */
  // 页面内 Alt+S 兜底（manifest 的 commands 也会触发一次，靠 isExtracting 互斥保护）
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.code === 'KeyS' || (e.key && e.key.toLowerCase() === 's')) {
      e.preventDefault();
      startExtraction();
    }
  }, true);

  // background 通过 commands / 扩展图标按钮通知本页提取
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'DG_EXTRACT_NOW') return;
    startExtraction();
    sendResponse({ ok: true });
  });

  /* ------------------------------------------------------------------ */
  /* 初始化                                                             */
  /* ------------------------------------------------------------------ */
  function init() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    if (isProductPage()) {
      createFab();
      // 窗口尺寸变化时把按钮重新约束到视口内
      window.addEventListener('resize', function () {
        const fab = document.getElementById(FAB_ID);
        if (!fab || !fab.classList.contains('dg-dragged')) return;
        const rect = fab.getBoundingClientRect();
        placeFab(fab, rect.left, rect.top);
      });
    }
  }

  init();
})();
