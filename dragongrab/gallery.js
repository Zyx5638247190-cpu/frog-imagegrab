/* ==========================================================================
 * 奶龙取图 / DragonGrab —— gallery.js
 * 画廊页逻辑：
 *   1. 从 background 读取最近一次提取结果并网格化展示
 *   2. 勾选 / 全选 / 反选、尺寸筛选、分类筛选
 *   3. 批量下载（PNG / JPG / WebP 转码）、ZIP 打包、CSV 导出
 *   4. 大图预览、悬停 2 倍放大、拖拽排序、相似图合并（感知哈希 dHash）
 *   5. 深色模式、历史记录（chrome.storage）
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */
const state = {
  images: [],            // 图片列表（顺序 = 用户拖拽后的顺序 = 下载编号顺序）
  history: {},           // 提取历史
  settings: {
    prefix: '奶龙图_',
    format: 'png',
    quality: 0.92,
    dark: false,
    minWidth: 100,
    category: 'all'
  },
  downloading: false,
  hashing: false,
  similarMerged: false,  // 本轮数据是否已经做过相似图合并
  lightboxId: null,      // 当前预览的图片 id
  dragId: null,          // 正在拖拽的图片 id
  dragJustEndedAt: 0,
  smallToastShown: false
};

/* DOM 快捷获取 */
const $ = function (id) { return document.getElementById(id); };

/* ------------------------------------------------------------------ */
/* 与 background 通信                                                  */
/* ------------------------------------------------------------------ */
function bg(msg) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res) {
          reject(new Error('后台没有响应，请在 chrome://extensions 重新加载插件'));
          return;
        }
        if (res.ok === false) {
          reject(new Error(res.error || '后台处理失败'));
          return;
        }
        resolve(res);
      });
    } catch (e) {
      reject(new Error('插件上下文已失效，请刷新本页（F5）'));
    }
  });
}

let saveTimer = null;
/** 把当前列表写回 storage（防抖，避免拖拽时疯狂写盘） */
function persistImages(immediate) {
  const doSave = function () {
    bg({
      type: 'DG_SAVE_IMAGES',
      payload: {
        images: state.images.map(function (it) {
          return {
            id: it.id, url: it.url, thumb: it.thumb, width: it.width, height: it.height,
            source: it.source, category: it.category, similarCount: it.similarCount,
            variants: it.variants, pageUrl: it.pageUrl
          };
        }),
        pageUrl: state.pageUrl || '',
        pageTitle: state.pageTitle || '',
        time: state.time || Date.now()
      }
    }).catch(function (e) { console.warn('[奶龙取图] 保存列表失败', e); });
  };
  if (immediate) { doSave(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 500);
}

let settingsTimer = null;
function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(function () {
    bg({ type: 'DG_SAVE_SETTINGS', settings: state.settings })
      .catch(function (e) { console.warn('[奶龙取图] 保存设置失败', e); });
  }, 300);
}

/* ------------------------------------------------------------------ */
/* 轻提示                                                              */
/* ------------------------------------------------------------------ */
function toast(text, isError, duration) {
  const wrap = $('dg-toast-wrap');
  const el = document.createElement('div');
  el.className = 'dg-toast' + (isError ? ' dg-toast-error' : '');
  el.innerHTML = '<span>' + (isError ? '🥺' : '🐲') + '</span><span>' + escapeHtml(text) + '</span>';
  wrap.appendChild(el);
  setTimeout(function () {
    el.classList.add('dg-toast-out');
    setTimeout(function () { el.remove(); }, 260);
  }, duration || 2800);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ------------------------------------------------------------------ */
/* 占位图（图片加载失败时使用，纯 SVG data URL）                        */
/* ------------------------------------------------------------------ */
const PLACEHOLDER_SVG =
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">' +
      '<rect width="240" height="240" fill="#FFF8E1"/>' +
      '<ellipse cx="120" cy="132" rx="62" ry="56" fill="#FFE082" stroke="#F9A825" stroke-width="5"/>' +
      '<ellipse cx="99" cy="118" rx="15" ry="17" fill="#FFFFFF"/>' +
      '<ellipse cx="145" cy="118" rx="15" ry="17" fill="#FFFFFF"/>' +
      '<path d="M89 118 h20 M135 118 h20" stroke="#4E342E" stroke-width="7" stroke-linecap="round"/>' +
      '<path d="M104 156 Q122 138 138 156" fill="none" stroke="#6D4C41" stroke-width="6" stroke-linecap="round"/>' +
      '<text x="120" y="220" text-anchor="middle" font-size="18" fill="#8D6E2F" font-family="sans-serif">嗷呜，这张图加载不出来</text>' +
    '</svg>'
  );

/* ------------------------------------------------------------------ */
/* 读取状态 & 初始化                                                   */
/* ------------------------------------------------------------------ */
async function loadState() {
  const res = await bg({ type: 'DG_GET_STATE' });
  state.settings = Object.assign({}, state.settings, res.settings || {});
  state.history = res.history || {};

  const pending = res.pending || {};
  state.pageUrl = pending.pageUrl || '';
  state.pageTitle = pending.pageTitle || '';
  state.time = pending.time || 0;
  state.similarMerged = false;

  const list = Array.isArray(pending.images) ? pending.images : [];
  state.images = list.map(function (it, i) {
    return {
      id: it.id || ('dg_' + i + '_' + Math.random().toString(36).slice(2, 8)),
      url: it.url || '',
      thumb: it.thumb || it.url || '',
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      source: it.source || 'img',
      category: it.category || '细节图',
      similarCount: Number(it.similarCount) || 1,
      variants: Array.isArray(it.variants) ? it.variants : [],
      selected: typeof it.selected === 'boolean' ? it.selected : true, // 默认全选，方便直接下载
      broken: false,
      tooSmall: false
    };
  });
}

function initUiFromSettings() {
  $('dg-prefix').value = state.settings.prefix || '奶龙图_';
  $('dg-format').value = state.settings.format || 'png';
  $('dg-quality').value = String(Math.round((state.settings.quality || 0.92) * 100));
  $('dg-quality-value').textContent = $('dg-quality').value + '%';
  $('dg-minwidth').value = String(state.settings.minWidth || 100);
  $('dg-minwidth-value').textContent = $('dg-minwidth').value;
  setDark(!!state.settings.dark, true);
  toggleQualityField();
}

function toggleQualityField() {
  const f = state.settings.format;
  $('dg-quality-field').hidden = (f === 'png');
}

function setDark(dark, silent) {
  document.body.classList.toggle('dg-dark', !!dark);
  $('dg-dark-toggle').textContent = dark ? '☀️ 浅色模式' : '🌙 深色模式';
  state.settings.dark = !!dark;
  if (!silent) persistSettings();
}

/* ------------------------------------------------------------------ */
/* 渲染：分类标签 / 网格 / 统计 / 历史                                  */
/* ------------------------------------------------------------------ */
const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: '主图', label: '主图' },
  { key: '细节图', label: '细节图' },
  { key: 'SKU图', label: 'SKU图' }
];

/** 当前分类 + 尺寸筛选后可见的图片 */
function visibleImages() {
  const cat = state.settings.category || 'all';
  const minW = Number(state.settings.minWidth) || 0;
  return state.images.filter(function (it) {
    if (it.tooSmall) return false;
    if (cat !== 'all' && it.category !== cat) return false;
    if (minW > 100 && it.width && it.width < minW) return false;
    return true;
  });
}

function renderCategoryTabs() {
  const box = $('dg-category-tabs');
  const counts = { all: 0, '主图': 0, '细节图': 0, 'SKU图': 0 };
  state.images.forEach(function (it) {
    if (it.tooSmall) return;
    counts.all++;
    if (counts[it.category] === undefined) counts[it.category] = 0;
    counts[it.category]++;
  });

  box.innerHTML = '';
  CATEGORIES.forEach(function (c) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dg-cat-tab' + ((state.settings.category || 'all') === c.key ? ' active' : '');
    btn.dataset.cat = c.key;
    btn.innerHTML = escapeHtml(c.label) + ' <i>' + (counts[c.key] || 0) + '</i>';
    btn.addEventListener('click', function () {
      state.settings.category = c.key;
      persistSettings();
      renderCategoryTabs();
      renderGrid();
    });
    box.appendChild(btn);
  });
}

function formatSize(it) {
  if (it.width && it.height) return it.width + ' × ' + it.height;
  return '尺寸未知';
}

function categoryClass(cat) {
  if (cat === '主图') return 'dg-tag-main';
  if (cat === 'SKU图') return 'dg-tag-sku';
  return 'dg-tag-detail';
}

/** 渲染网格 */
function renderGrid() {
  const grid = $('dg-grid');
  const list = visibleImages();
  grid.innerHTML = '';

  if (!state.images.length) {
    $('dg-empty').style.display = '';
    updateStats();
    return;
  }
  $('dg-empty').style.display = 'none';

  const frag = document.createDocumentFragment();

  list.forEach(function (it, idx) {
    // 卡片序号用「在完整列表里的位置」，和下载顺序（勾选后的顺序）保持一致
    const globalIndex = state.images.indexOf(it) + 1;
    const card = document.createElement('article');
    card.className = 'dg-card' + (it.selected ? ' selected' : '');
    card.dataset.id = it.id;
    card.draggable = true;

    // ---- 缩略图区 ----
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'dg-card-thumb';
    thumbWrap.title = '点击查看大图';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '商品图 ' + globalIndex;
    img.src = it.thumb || it.url;

    // 兜底：原图地址加载失败 → 换回页面上的缩略地址 → 再失败就显示奶龙占位图
    img.addEventListener('error', function onErr() {
      if (!img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.src = it.url;
        return;
      }
      img.classList.add('dg-failed');
      img.src = PLACEHOLDER_SVG;
      it.broken = true;
      img.removeEventListener('error', onErr);
    });

    // 加载完成后校验真实尺寸，过滤掉小图（避免把图标算进结果）
    img.addEventListener('load', function () {
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      if (nw && nh && nw < 100 && nh < 100 && !it._verifiedOriginal) {
        it.tooSmall = true;
        it.selected = false;
        card.remove();
        updateStats();
        if (!state.smallToastShown) {
          state.smallToastShown = true;
          toast('已自动过滤掉小于 100×100 的小图', true);
        }
        return;
      }
      // 用真实尺寸修正元数据
      if (nw && nh && (!it.width || !it.height)) {
        it.width = nw;
        it.height = nh;
      }
      it._verifiedOriginal = true;
      const metaEl = card.querySelector('.dg-card-meta');
      if (metaEl) metaEl.querySelector('b').textContent = formatSize(it);
    });

    thumbWrap.appendChild(img);

    // 勾选框
    const checkWrap = document.createElement('label');
    checkWrap.className = 'dg-card-check';
    checkWrap.title = '勾选 / 取消勾选';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!it.selected;
    check.addEventListener('change', function () {
      it.selected = check.checked;
      card.classList.toggle('selected', check.checked);
      updateStats();
      persistImages();
    });
    checkWrap.appendChild(check);
    thumbWrap.appendChild(checkWrap);

    // 标签（分类 + 相似合并数量）
    const tags = document.createElement('div');
    tags.className = 'dg-card-tags';
    const catTag = document.createElement('span');
    catTag.className = 'dg-tag ' + categoryClass(it.category);
    catTag.textContent = it.category;
    tags.appendChild(catTag);
    if (it.similarCount > 1) {
      const mergeTag = document.createElement('span');
      mergeTag.className = 'dg-tag dg-tag-merge';
      mergeTag.textContent = '已合并' + it.similarCount + '张相似图';
      mergeTag.title = '同一张图的不同尺寸 / 轻微裁剪版本已合并显示';
      tags.appendChild(mergeTag);
    }
    thumbWrap.appendChild(tags);

    // 序号
    const indexTag = document.createElement('span');
    indexTag.className = 'dg-card-index';
    indexTag.textContent = '#' + globalIndex;
    thumbWrap.appendChild(indexTag);

    // 点击缩略图 → 大图预览
    thumbWrap.addEventListener('click', function (e) {
      if (e.target.closest('.dg-card-check')) return;
      if (Date.now() - state.dragJustEndedAt < 300) return; // 刚拖拽完不触发预览
      openLightbox(it.id);
    });

    // 悬停 2 倍放大预览
    thumbWrap.addEventListener('mouseenter', function (e) { showHoverPreview(e, it, thumbWrap); });
    thumbWrap.addEventListener('mousemove', function (e) { moveHoverPreview(e); });
    thumbWrap.addEventListener('mouseleave', hideHoverPreview);

    card.appendChild(thumbWrap);

    // ---- 信息 + 操作区 ----
    const body = document.createElement('div');
    body.className = 'dg-card-body';

    const meta = document.createElement('div');
    meta.className = 'dg-card-meta';
    meta.innerHTML = '<b>' + escapeHtml(formatSize(it)) + '</b>' +
      '<span>' + escapeHtml(it.source || 'img') + ' · 第 ' + globalIndex + ' 张</span>';

    const actions = document.createElement('div');
    actions.className = 'dg-card-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'dg-mini-btn';
    copyBtn.textContent = '复制链接';
    copyBtn.title = '复制图片原始地址到剪贴板';
    copyBtn.addEventListener('click', function () { copyUrl(it, copyBtn); });

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'dg-mini-btn';
    viewBtn.textContent = '预览';
    viewBtn.addEventListener('click', function () { openLightbox(it.id); });

    actions.appendChild(copyBtn);
    actions.appendChild(viewBtn);
    body.appendChild(meta);
    body.appendChild(actions);
    card.appendChild(body);

    // ---- 拖拽排序 ----
    card.addEventListener('dragstart', function (e) {
      state.dragId = it.id;
      card.classList.add('dg-dragging');
      try { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* 忽略 */ }
    });
    card.addEventListener('dragend', function () {
      card.classList.remove('dg-dragging');
      state.dragId = null;
      state.dragJustEndedAt = Date.now();
      Array.prototype.forEach.call(grid.querySelectorAll('.dg-drop-target'), function (el) {
        el.classList.remove('dg-drop-target');
      });
    });
    card.addEventListener('dragover', function (e) {
      if (!state.dragId || state.dragId === it.id) return;
      e.preventDefault();
      card.classList.add('dg-drop-target');
    });
    card.addEventListener('dragleave', function () { card.classList.remove('dg-drop-target'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('dg-drop-target');
      const fromId = state.dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      if (!fromId || fromId === it.id) return;
      reorderImages(fromId, it.id);
    });

    frag.appendChild(card);
  });

  grid.appendChild(frag);
  updateStats();
}

/** 拖拽排序：把 fromId 移动到 toId 的位置 */
function reorderImages(fromId, toId) {
  const from = state.images.findIndex(function (x) { return x.id === fromId; });
  const to = state.images.findIndex(function (x) { return x.id === toId; });
  if (from < 0 || to < 0 || from === to) return;
  const moved = state.images.splice(from, 1)[0];
  state.images.splice(to, 0, moved);
  renderGrid();
  persistImages(true);
  toast('嗷！顺序已调整，下载编号会跟着变～', false, 1800);
}

/** 更新统计（已选数量、历史记录） */
function updateStats() {
  const list = visibleImages();
  const selected = state.images.filter(function (it) { return it.selected && !it.tooSmall; });
  $('dg-selected-count').textContent = '已选 ' + selected.length + ' / ' + state.images.filter(function (i) { return !i.tooSmall; }).length;

  const main = state.images.filter(function (i) { return !i.tooSmall && i.category === '主图'; }).length;
  const detail = state.images.filter(function (i) { return !i.tooSmall && i.category === '细节图'; }).length;
  const sku = state.images.filter(function (i) { return !i.tooSmall && i.category === 'SKU图'; }).length;
  $('dg-subtitle').textContent = state.images.length
    ? '嗷！当前列表共 ' + state.images.filter(function (i) { return !i.tooSmall; }).length + ' 张图（主图 ' + main + ' · 细节图 ' + detail + ' · SKU图 ' + sku + '），筛选后可见 ' + list.length + ' 张'
    : '嗷！奶龙帮你把商品图都叼回来～';

  const mergedCount = state.images.reduce(function (sum, it) {
    return sum + Math.max(0, (it.similarCount || 1) - 1);
  }, 0);
  $('dg-merge-count').textContent = String(mergedCount);

  renderHistory();
}

function renderHistory() {
  const h = state.history || {};
  const el = $('dg-history-text');
  if (!h.lastTime) {
    el.textContent = '奶龙还没有搬过图哦～去商品详情页叫我吧！';
    return;
  }
  const d = new Date(h.lastTime);
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  const timeStr = d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  el.innerHTML = '最近一次提取：<b>' + escapeHtml(timeStr) + '</b> · 共 <b>' + (h.lastCount || 0) +
    '</b> 张图 · 累计提取 <b>' + (h.totalRuns || 0) + '</b> 次' +
    (h.lastTitle ? ' · 来源：' + escapeHtml(String(h.lastTitle).slice(0, 40)) : '');
}

/* ------------------------------------------------------------------ */
/* 复制图片 URL                                                        */
/* ------------------------------------------------------------------ */
async function copyUrl(item, btn) {
  const text = item.url || item.thumb || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1500);
    }
  } catch (e) {
    try {
      fallbackCopy(text);
      if (btn) {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = '复制链接'; btn.classList.remove('copied'); }, 1500);
      }
    } catch (err) {
      toast('复制失败，请手动选中链接复制', true);
    }
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('execCommand copy failed');
}

/* ------------------------------------------------------------------ */
/* 悬停 2 倍放大预览                                                   */
/* ------------------------------------------------------------------ */
let hoverTimer = null;
let lastHoverPoint = { x: 0, y: 0 };

function showHoverPreview(e, item, thumbWrap) {
  clearTimeout(hoverTimer);
  const box = $('dg-hover-preview');
  const img = $('dg-hover-preview-img');
  const meta = $('dg-hover-preview-meta');
  const rect = thumbWrap.getBoundingClientRect();
  // 2 倍大小，最大 520px，避免大屏上过分夸张
  const width = Math.min(Math.max(rect.width * 2, 240), 520);
  box.style.width = width + 'px';
  img.src = item.thumb || item.url;
  meta.textContent = formatSize(item) + ' · ' + item.category + (item.similarCount > 1 ? ' · 已合并' + item.similarCount + '张' : '');
  lastHoverPoint = { x: e.clientX, y: e.clientY };
  // 轻微延迟：鼠标快速划过时不弹出，减少干扰
  hoverTimer = setTimeout(function () {
    box.hidden = false;
    moveHoverPreview(lastHoverPoint); // 显示后再按真实尺寸定位，避免贴边时闪一下
  }, 120);
}

function moveHoverPreview(e) {
  const box = $('dg-hover-preview');
  // 统一记录鼠标位置（兼容直接传 MouseEvent 或传坐标对象）
  if (e && typeof e.clientX === 'number') lastHoverPoint = { x: e.clientX, y: e.clientY };
  else if (e && typeof e.x === 'number') lastHoverPoint = { x: e.x, y: e.y };
  if (box.hidden) return;

  const point = lastHoverPoint;
  const w = box.offsetWidth || 320;
  const h = box.offsetHeight || 320;
  const gap = 18;
  let left = point.x + gap;
  // 右侧放不下就翻到左边
  if (left + w > window.innerWidth - 12) left = Math.max(12, point.x - gap - w);
  let top = point.y - h / 2;
  top = Math.min(Math.max(12, top), Math.max(12, window.innerHeight - h - 12));
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}

function hideHoverPreview() {
  clearTimeout(hoverTimer);
  const box = $('dg-hover-preview');
  box.hidden = true;
  $('dg-hover-preview-img').src = '';
}

/* ------------------------------------------------------------------ */
/* 大图预览（Lightbox）                                                 */
/* ------------------------------------------------------------------ */
function lightboxList() { return visibleImages(); }

function openLightbox(id) {
  state.lightboxId = id;
  const box = $('dg-lightbox');
  box.hidden = false;
  renderLightbox();
}

function closeLightbox() {
  $('dg-lightbox').hidden = true;
  $('dg-lightbox-img').src = '';
  state.lightboxId = null;
  hideHoverPreview();
}

function renderLightbox() {
  const list = lightboxList();
  const idx = list.findIndex(function (x) { return x.id === state.lightboxId; });
  if (idx < 0) { closeLightbox(); return; }

  const item = list[idx];
  const img = $('dg-lightbox-img');
  const loading = $('dg-lightbox-loading');
  loading.hidden = false;
  img.src = item.url || item.thumb;
  img.onload = function () { loading.hidden = true; };
  img.onerror = function () {
    // 原图失败 → 换缩略图 → 再失败给占位图
    if (img.dataset.fb !== '1' && item.thumb && img.src !== item.thumb) {
      img.dataset.fb = '1';
      img.src = item.thumb;
      return;
    }
    loading.hidden = true;
    img.src = PLACEHOLDER_SVG;
  };
  img.dataset.fb = '';

  $('dg-lightbox-meta').textContent =
    '第 ' + (idx + 1) + ' / ' + list.length + ' 张 · ' + formatSize(item) + ' · ' + item.category +
    ' · 来源 ' + (item.source || 'img') + (item.similarCount > 1 ? ' · 已合并 ' + item.similarCount + ' 张相似图' : '');

  $('dg-lightbox-prev').disabled = idx <= 0;
  $('dg-lightbox-next').disabled = idx >= list.length - 1;
}

function stepLightbox(delta) {
  const list = lightboxList();
  const idx = list.findIndex(function (x) { return x.id === state.lightboxId; });
  const next = idx + delta;
  if (next < 0 || next >= list.length) return;
  state.lightboxId = list[next].id;
  renderLightbox();
}

/* ------------------------------------------------------------------ */
/* 选择操作                                                            */
/* ------------------------------------------------------------------ */
function applySelectionToVisible(fn) {
  const visible = visibleImages();
  visible.forEach(function (it) { it.selected = fn(it); });
  renderGrid();
  persistImages();
}

function selectAll() {
  const n = visibleImages().length;
  applySelectionToVisible(function () { return true; });
  toast('嗷！已全选当前可见的 ' + n + ' 张图', false, 1800);
}

function selectNone() {
  applySelectionToVisible(function () { return false; });
  toast('已取消全部勾选', false, 1500);
}

function invertSelection() {
  applySelectionToVisible(function (it) { return !it.selected; });
}

/* ------------------------------------------------------------------ */
/* 下载相关                                                            */
/* ------------------------------------------------------------------ */
function selectedItems() {
  return state.images.filter(function (it) { return it.selected && !it.tooSmall && !it.broken; });
}

function showProgress(scope, current, total, name) {
  const wrap = $('dg-progress-wrap');
  wrap.hidden = false;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  $('dg-progress-bar').style.width = percent + '%';
  $('dg-progress-percent').textContent = percent + '%';
  const label = scope === 'zip' ? '奶龙正在打包' : (scope === 'hash' ? '奶龙正在找相似图' : '奶龙正在下载');
  $('dg-progress-text').textContent = label + ' ' + current + '/' + total + (name ? ' · ' + name : '');
}

function hideProgress(delay) {
  setTimeout(function () { $('dg-progress-wrap').hidden = true; }, delay || 1600);
}

/** 设置下载的文件名与格式参数 */
function currentNaming() {
  return {
    prefix: ($('dg-prefix').value || '奶龙图_').trim() || '奶龙图_',
    format: $('dg-format').value || 'png',
    quality: (Number($('dg-quality').value) || 92) / 100
  };
}

/**
 * 触发一次 chrome.downloads 下载
 * - mode=direct：直接用原图地址下载（浏览器自己取图，不受 CORS 限制）
 * - mode=converted：把 background 转码好的 base64 变成 blob URL 再下载
 *   （MV3 的 Service Worker 里没有 URL.createObjectURL，所以这一步必须在页面里做）
 */
async function triggerDownload(prepared) {
  if (prepared.mode === 'converted') {
    const blob = dataUrlToBlob(prepared.dataUrl);
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chromeDownload(objectUrl, prepared.filename);
    } finally {
      // 下载需要 URL 在一段时间内保持有效，稍后回收内存
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 180000);
    }
    return;
  }
  await chromeDownload(prepared.url, prepared.filename);
}

function chromeDownload(url, filename) {
  return new Promise(function (resolve, reject) {
    chrome.downloads.download({
      url: url,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false
    }, function (id) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
}

/** data URL → Blob（自己解码，避免 fetch data: 带来的 CSP 不确定性） */
function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl).split(',');
  const meta = parts[0] || '';
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const isBase64 = /base64/i.test(meta);
  const data = parts[1] || '';
  if (!isBase64) {
    return new Blob([decodeURIComponent(data)], { type: mime });
  }
  const binary = atob(data);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 批量下载选中图片 */
async function downloadSelected() {
  if (state.downloading) { toast('嗷！奶龙还在下载，等它一下～', true); return; }
  const items = selectedItems();
  if (!items.length) { toast('先勾选几张图吧～', true); return; }

  const naming = currentNaming();
  state.downloading = true;
  setBusy(true);

  let done = 0, failed = 0, degraded = 0;
  const total = items.length;
  showProgress('download', 0, total, '');

  for (let i = 0; i < total; i++) {
    const item = items[i];
    showProgress('download', i, total, naming.prefix + pad(i + 1, total) + '.' + naming.format);
    try {
      const payload = {
        url: item.url,
        thumb: item.thumb,
        format: naming.format,
        quality: naming.quality,
        prefix: naming.prefix,
        index: i + 1,
        total: total
      };
      const res = await bg({ type: 'DG_PREPARE_IMAGE', payload: payload });
      if (res.degraded) degraded++;
      try {
        await triggerDownload(res);
      } catch (downloadErr) {
        // 直接下载原图失败（常见于 CDN 防盗链、链接过期）→ 强制走转码通道再试一次
        if (res.mode !== 'direct') throw downloadErr;
        const retry = await bg({
          type: 'DG_PREPARE_IMAGE',
          payload: Object.assign({}, payload, { forceTranscode: true })
        });
        if (retry.degraded) degraded++;
        await triggerDownload(retry);
      }
      done++;
    } catch (e) {
      console.warn('[奶龙取图] 下载失败', item.url, e);
      failed++;
    }
    showProgress('download', done + failed, total, '');
  }

  state.downloading = false;
  setBusy(false);
  showProgress('download', total, total, '');
  hideProgress(1800);

  let msg = '嗷！全部下好了（' + done + '/' + total + ' 张，' + naming.format.toUpperCase() + ' 格式）';
  if (degraded) msg += '，其中 ' + degraded + ' 张转码失败已按原格式保存';
  if (failed) msg += '，失败 ' + failed + ' 张';
  toast(msg, failed > 0, 5000);
}

function pad(i, total) {
  const width = Math.max(3, String(total || 0).length);
  let s = String(i);
  while (s.length < width) s = '0' + s;
  return s;
}

/** 打包 ZIP 下载 */
async function downloadZip() {
  if (state.downloading) { toast('嗷！奶龙还在忙，等它一下～', true); return; }

  const selected = selectedItems();
  const items = selected.length ? selected : visibleImages();
  if (!items.length) { toast('没有可以打包的图片哦', true); return; }

  const naming = currentNaming();
  state.downloading = true;
  setBusy(true);
  showProgress('zip', 0, items.length, '');

  try {
    const res = await bg({
      type: 'DG_BUILD_ZIP',
      payload: {
        items: items.map(function (it) { return { url: it.url, thumb: it.thumb }; }),
        format: naming.format,
        quality: naming.quality,
        prefix: naming.prefix,
        zipName: 'dragongrab'
      }
    });

    const blob = base64ToBlob(res.base64, 'application/zip');
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chromeDownload(objectUrl, res.zipName);
    } finally {
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 180000);
    }

    showProgress('zip', items.length, items.length, '');
    hideProgress(1800);
    let msg = '嗷！打包完成，共 ' + res.count + ' 张图（约 ' + (res.bytes / 1024 / 1024).toFixed(1) + 'MB）';
    if (res.failed && res.failed.length) msg += '，' + res.failed.length + ' 张处理失败已跳过';
    toast(msg, false, 5200);
  } catch (e) {
    hideProgress(0);
    toast('打包失败：' + (e.message || '未知错误'), true, 5200);
  } finally {
    state.downloading = false;
    setBusy(false);
  }
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 导出 CSV 清单 */
async function exportCsv() {
  const items = state.images.filter(function (it) { return !it.tooSmall; });
  if (!items.length) { toast('还没有图片可以导出哦', true); return; }
  try {
    const res = await bg({
      type: 'DG_EXPORT_CSV',
      payload: { items: items, pageUrl: state.pageUrl || '', prefix: currentNaming().prefix }
    });
    const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chromeDownload(objectUrl, res.filename);
    } finally {
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 120000);
    }
    toast('嗷！清单导出成功，共 ' + res.count + ' 条', false, 3200);
  } catch (e) {
    toast('导出 CSV 失败：' + (e.message || '未知错误'), true, 4200);
  }
}

/** 下载期间的按钮禁用 */
function setBusy(busy) {
  ['dg-download-selected', 'dg-download-zip', 'dg-export-csv', 'dg-select-all', 'dg-invert'].forEach(function (id) {
    const el = $(id);
    if (el) el.disabled = !!busy;
  });
}

/* ------------------------------------------------------------------ */
/* 相似图合并（感知哈希 dHash）                                         */
/* ------------------------------------------------------------------ */
/**
 * 计算一张图的 dHash（64 位，转成 16 位十六进制字符串）
 * 用扩展页自己的 fetch + createImageBitmap 取图，因此不会被 canvas 跨域污染。
 */
async function computeDHash(url) {
  const blob = await fetchWithTimeout(url, 12000);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = 9;   // 9x8 → 横向 8 组比较 → 64 位
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  if (bitmap.close) bitmap.close();
  const data = ctx.getImageData(0, 0, 9, 8).data;
  const gray = [];
  for (let i = 0; i < 72; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return hash;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function fetchWithTimeout(url, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeout || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 相似图合并：把同一张图的轻微裁剪 / 不同尺寸版本合并成一项
 * 只处理前 MAX 张（默认 120，避免请求过多），失败的图直接跳过。
 */
async function runSimilarMerge(silent) {
  if (state.hashing) return;
  const MAX = 120;
  const candidates = state.images.filter(function (it) { return !it.tooSmall && !it.broken; }).slice(0, MAX);
  if (candidates.length < 2) {
    if (!silent) toast('图片太少啦，不用合并～', true);
    return;
  }

  state.hashing = true;
  const total = candidates.length;
  showProgress('hash', 0, total, '');
  const queue = candidates.slice();
  let finished = 0;
  let hashedCount = 0;

  // 并发 4 个 worker 计算哈希
  const workers = new Array(4).fill(0).map(async function () {
    while (queue.length) {
      const item = queue.shift();
      try {
        const urls = [item.thumb, item.url].filter(Boolean);
        for (let i = 0; i < urls.length; i++) {
          try {
            item.hash = await computeDHash(urls[i]);
            hashedCount++;
            break;
          } catch (e) {
            if (i === urls.length - 1) item.hash = '';
          }
        }
      } catch (e) {
        item.hash = '';
      }
      finished++;
      if (finished % 3 === 0 || finished === total) showProgress('hash', finished, total, '');
    }
  });
  await Promise.all(workers);

  // O(n²) 比较，n ≤ 120，开销可忽略
  const removed = [];
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!a.hash || removed.indexOf(a) > -1) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!b.hash || removed.indexOf(b) > -1) continue;
      // 汉明距离 ≤ 6 认为是「几乎一样的图」
      if (hamming(a.hash, b.hash) <= 6) {
        a.similarCount = (a.similarCount || 1) + (b.similarCount || 1);
        a.variants = (a.variants || []).concat([{ url: b.url, width: b.width, height: b.height }]).slice(0, 12);
        // 保留分辨率更高的那一张作为主图
        if ((b.width * b.height) > (a.width * a.height)) {
          a.url = b.url;
          a.thumb = b.thumb || b.url;
          a.width = b.width;
          a.height = b.height;
        }
        removed.push(b);
      }
    }
  }

  if (removed.length) {
    state.images = state.images.filter(function (it) { return removed.indexOf(it) < 0; });
  }

  state.similarMerged = true;
  state.hashing = false;
  showProgress('hash', total, total, '');
  hideProgress(1400);

  if (removed.length) {
    renderCategoryTabs();
    renderGrid();
    persistImages(true);
    toast('嗷！合并了 ' + removed.length + ' 张相似图（成功比对 ' + hashedCount + ' 张）', false, 4200);
  } else if (!silent) {
    toast('检查完成，没有发现重复/相似图（成功比对 ' + hashedCount + ' 张）', false, 3600);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */
function bindEvents() {
  /* 顶部按钮 */
  $('dg-dark-toggle').addEventListener('click', function () {
    setDark(!state.settings.dark);
  });

  $('dg-rescan').addEventListener('click', async function () {
    try {
      await loadState();
      initUiFromSettings();
      renderCategoryTabs();
      renderGrid();
      toast('列表已刷新', false, 1600);
    } catch (e) {
      toast('刷新失败：' + e.message, true);
    }
  });

  $('dg-clear').addEventListener('click', async function () {
    if (!confirm('清空列表和提取历史？已下载到本地的图片文件不会被删除。')) return;
    state.images = [];
    state.history = {};
    renderCategoryTabs();
    renderGrid();
    try {
      await clearStorageKeys(['dg_pending', 'dg_history']);
      persistImages(true);
      toast('已清空，嗷！', false, 1800);
    } catch (e) {
      toast('清空失败：' + e.message, true);
    }
  });

  /* 选择 */
  $('dg-select-all').addEventListener('click', selectAll);
  $('dg-invert').addEventListener('click', invertSelection);
  $('dg-select-none').addEventListener('click', selectNone);

  /* 前缀 / 格式 / 画质 */
  $('dg-prefix').addEventListener('input', function () {
    state.settings.prefix = $('dg-prefix').value;
    persistSettings();
  });
  $('dg-format').addEventListener('change', function () {
    state.settings.format = $('dg-format').value;
    toggleQualityField();
    persistSettings();
  });
  $('dg-quality').addEventListener('input', function () {
    state.settings.quality = (Number($('dg-quality').value) || 92) / 100;
    $('dg-quality-value').textContent = $('dg-quality').value + '%';
    persistSettings();
  });

  /* 最小宽度筛选 */
  $('dg-minwidth').addEventListener('input', function () {
    const v = Number($('dg-minwidth').value) || 100;
    $('dg-minwidth-value').textContent = String(v);
    state.settings.minWidth = v;
    renderGrid();
    persistSettings();
  });

  /* 排序 & 相似合并 */
  $('dg-sort-size').addEventListener('click', function () {
    state.images.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
    renderGrid();
    persistImages(true);
    toast('已按尺寸从大到小排序', false, 1800);
  });
  $('dg-merge-similar').addEventListener('click', function () { runSimilarMerge(false); });

  /* 下载 / 打包 / CSV */
  $('dg-download-selected').addEventListener('click', downloadSelected);
  $('dg-download-zip').addEventListener('click', function () {
    const selected = selectedItems();
    if (!selected.length && visibleImages().length > 40) {
      if (!confirm('没有勾选任何图片，将打包当前可见的 ' + visibleImages().length + ' 张图，继续吗？')) return;
    }
    downloadZip();
  });
  $('dg-export-csv').addEventListener('click', exportCsv);

  /* 大图预览 */
  $('dg-lightbox-close').addEventListener('click', closeLightbox);
  $('dg-lightbox-mask').addEventListener('click', closeLightbox);
  $('dg-lightbox-prev').addEventListener('click', function () { stepLightbox(-1); });
  $('dg-lightbox-next').addEventListener('click', function () { stepLightbox(1); });

  /* 键盘：ESC 关闭预览，← → 切换 */
  document.addEventListener('keydown', function (e) {
    if ($('dg-lightbox').hidden) return;
    if (e.key === 'Escape') { closeLightbox(); }
    else if (e.key === 'ArrowLeft') { stepLightbox(-1); }
    else if (e.key === 'ArrowRight') { stepLightbox(1); }
  });

  /* 后台广播：ZIP 进度 / 下载状态 */
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'DG_PROGRESS' && msg.scope === 'zip') {
      showProgress('zip', msg.current, msg.total, msg.name);
    }
    if (msg.type === 'DG_DOWNLOAD_STATE' && msg.state === 'interrupted') {
      toast('有一张图下载中断了：' + (msg.error || '未知原因'), true, 3600);
    }
  });

  /* 离开页面前把顺序/勾选状态存好 */
  window.addEventListener('beforeunload', function () { persistImages(true); });
}

/* chrome.storage 局部清空封装（不动用户的前缀/格式等偏好设置） */
function clearStorageKeys(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(keys, function () {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  try {
    await loadState();
  } catch (e) {
    console.error('[奶龙取图] 读取状态失败', e);
    toast('读取数据失败：' + e.message + '（可尝试重新加载插件）', true, 6000);
  }

  initUiFromSettings();
  bindEvents();
  renderCategoryTabs();
  renderGrid();

  // 首次打开展示引导
  if (!state.images.length) {
    toast('嗷！先去商品详情页提取图片吧～', false, 3600);
  } else if (state.images.length <= 40 && !state.similarMerged) {
    // 图片数量不多时自动跑一次相似图合并（要逐张取图算哈希，图多时改为手动点按钮，省流量）
    setTimeout(function () { runSimilarMerge(true); }, 900);
  }
}

main();
