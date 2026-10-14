/* ==========================================================================
 * 奶龙取图 / DragonGrab —— background.js（MV3 Service Worker）
 * 职责：
 *   1. 接收 content.js 提取到的图片列表，落盘到 chrome.storage，并打开画廊页
 *   2. 跨域取图 + 用 createImageBitmap + OffscreenCanvas 转成 PNG / JPG / WebP
 *      （在 Service Worker 里转码可以完全绕开页面 CORS 限制）
 *   3. 打包 ZIP：内置纯 JS 的「存储模式」ZIP 写入器（不依赖任何 CDN，MV3 CSP 禁止远程脚本）
 *   4. 生成 CSV 清单
 *   5. 消息转发、扩展图标点击、Alt+S 快捷键命令
 *
 * 设计说明（重要）：
 *   MV3 的 Service Worker 里没有 DOM，也没有 URL.createObjectURL()，所以
 *   「转码 + 二进制数据」由本文件负责，「把结果落盘成文件」这一步交给画廊页
 *   （gallery.js 用 Blob → createObjectURL → chrome.downloads.download），
 *   这样既能跨域转换，又不受 data: URL 长度限制影响。
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
const STORAGE_PENDING = 'dg_pending';    // 最近一次提取的图片列表
const STORAGE_HISTORY = 'dg_history';    // 提取历史记录
const STORAGE_SETTINGS = 'dg_settings';  // 画廊偏好（前缀、格式、深色模式等）

const GALLERY_PAGE = 'gallery.html';
const ZIP_NAME = 'dragongrab.zip';
const FETCH_TIMEOUT = 25000;             // 单张图片取图超时（毫秒）
const MAX_SIDE = 6000;                   // 转码时最长边上限，防止超大图爆内存
const MAX_ZIP_MESSAGE = 30 * 1024 * 1024;// 通过消息回传 zip 的体积上限（base64 会膨胀约 1/3）
const USE_SUBFOLDER = false;             // true：下载到「奶龙取图」子目录

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
};

/* ------------------------------------------------------------------ */
/* 安装 / 启动初始化                                                    */
/* ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get([STORAGE_HISTORY, STORAGE_SETTINGS], function (data) {
    const patch = {};
    if (!data[STORAGE_HISTORY]) {
      patch[STORAGE_HISTORY] = { lastTime: 0, lastCount: 0, lastUrl: '', lastTitle: '', totalRuns: 0 };
    }
    if (!data[STORAGE_SETTINGS]) {
      patch[STORAGE_SETTINGS] = {
        prefix: '奶龙图_',
        format: 'png',
        quality: 0.92,
        dark: false,
        minWidth: 100,
        category: 'all'
      };
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
  console.log('[奶龙取图] 嗷！插件已就绪，去商品详情页点右下角的「奶龙取图」吧～');
});

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 把 Map/对象转成安全对象（避免 null 报错） */
function safeObj(o) {
  return o && typeof o === 'object' ? o : {};
}

/** 规范化格式名 */
function normFormat(fmt) {
  const f = String(fmt || 'png').toLowerCase();
  if (f === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'webp'].indexOf(f) > -1 ? f : 'png';
}

/** 从 URL 推断原图格式 */
function formatFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.png$/.test(path)) return 'png';
    if (/\.webp$/.test(path)) return 'webp';
    if (/\.(jpe?g|jpg)$/.test(path)) return 'jpg';
  } catch (e) { /* 忽略 */ }
  return '';
}

/** 清理文件名里不合法的字符 */
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'image';
}

/** 序号补零：1 → 001 */
function padIndex(i, total) {
  const width = Math.max(3, String(total || 0).length);
  let s = String(i);
  while (s.length < width) s = '0' + s;
  return s;
}

/** 组装最终文件名 */
function buildFilename(prefix, index, total, format, subfolder) {
  const name = sanitizeName(prefix || '奶龙图_') + padIndex(index, total) + '.' + format;
  return (subfolder || USE_SUBFOLDER ? '奶龙取图/' : '') + name;
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, options, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeout || FETCH_TIMEOUT);
  try {
    const opt = Object.assign({ signal: ctrl.signal }, options || {});
    return await fetch(url, opt);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取图片二进制数据
 * 先带 cookie（部分 CDN 校验登录态/Referer），失败后再用 no-cors 方式重试一次
 */
async function fetchImageBlob(url) {
  const attempts = [
    { credentials: 'include', cache: 'force-cache' },
    { credentials: 'omit' },
    { credentials: 'omit', referrerPolicy: 'no-referrer' }
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await fetchWithTimeout(url, attempts[i]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob || blob.size < 64) throw new Error('返回内容为空');
      return blob;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('图片下载失败');
}

/**
 * 转码：任意格式 → png/jpg/webp
 * @returns {Promise<{blob:Blob,width:number,height:number,transcoded:boolean}>}
 */
async function transcodeBlob(blob, targetFormat, quality) {
  const wantMime = MIME_BY_FORMAT[targetFormat] || 'image/png';
  const srcMime = (blob.type || '').toLowerCase();

  // 不需要转码的情况：格式已经一致（且不是需要铺白底的 jpg）
  const bitmap = await createImageBitmap(blob);

  let w = bitmap.width, h = bitmap.height;
  // 超长边等比缩小，避免超大 canvas 内存溢出
  const longSide = Math.max(w, h);
  if (longSide > MAX_SIDE) {
    const scale = MAX_SIDE / longSide;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const srcW = bitmap.width, srcH = bitmap.height;
  const needResize = w !== srcW || h !== srcH;
  const formatSame = srcMime === wantMime || (wantMime === 'image/jpeg' && srcMime === 'image/jpg');

  // 格式一致且不需要缩放 → 直接用原始二进制，避免二次压缩让画质变差
  if (formatSame && !needResize) {
    if (bitmap.close) bitmap.close();
    return { blob: blob, width: srcW, height: srcH, transcoded: false };
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布初始化失败');

  // JPG 不支持透明通道，先铺白底，避免透明区变黑
  if (wantMime === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const out = await canvas.convertToBlob({
    type: wantMime,
    quality: wantMime === 'image/png' ? undefined : (typeof quality === 'number' ? quality : 0.92)
  });
  return { blob: out, width: w, height: h, transcoded: true };
}

/** Blob → data URL（用于通过消息回传给画廊页） */
function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error('读取图片数据失败')); };
    reader.readAsDataURL(blob);
  });
}

/** Uint8Array → base64（分块处理，避免超长字符串栈溢出） */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ */
/* ZIP 打包器（纯 JS，存储模式；不依赖 CDN，MV3 CSP 也不允许远程脚本）    */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 把 Date 转成 DOS 时间/日期 */
function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const day = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

/**
 * 生成 ZIP 文件字节
 * @param {Array<{name:string, bytes:Uint8Array}>} entries
 * @returns {Uint8Array}
 */
function buildZipBytes(entries) {
  const enc = new TextEncoder();
  const now = dosDateTime(new Date());
  const prepared = entries.map(function (e) {
    const nameBytes = enc.encode(e.name);
    return {
      nameBytes: nameBytes,
      bytes: e.bytes,
      crc: crc32(e.bytes),
      size: e.bytes.length
    };
  });

  let localSize = 0;
  let centralSize = 0;
  prepared.forEach(function (p) {
    localSize += 30 + p.nameBytes.length + p.size;
    centralSize += 46 + p.nameBytes.length;
  });
  const eocdSize = 22;
  const out = new Uint8Array(localSize + centralSize + eocdSize);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets = [];

  // ---- 本地文件头 + 数据 ----
  prepared.forEach(function (p) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);   // 签名
    view.setUint16(offset + 4, 20, true);       // 解压所需版本
    view.setUint16(offset + 6, 0x0800, true);   // 标记：文件名 UTF-8
    view.setUint16(offset + 8, 0, true);        // 压缩方式：0 = 仅存储
    view.setUint16(offset + 10, now.time, true);
    view.setUint16(offset + 12, now.date, true);
    view.setUint32(offset + 14, p.crc, true);
    view.setUint32(offset + 18, p.size, true);  // 压缩后大小
    view.setUint32(offset + 22, p.size, true);  // 原始大小
    view.setUint16(offset + 26, p.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);       // 扩展字段长度
    out.set(p.nameBytes, offset + 30);
    out.set(p.bytes, offset + 30 + p.nameBytes.length);
    offset += 30 + p.nameBytes.length + p.size;
  });

  // ---- 中央目录 ----
  const centralStart = offset;
  prepared.forEach(function (p, i) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);       // 创建版本
    view.setUint16(offset + 6, 20, true);       // 解压所需版本
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, now.time, true);
    view.setUint16(offset + 14, now.date, true);
    view.setUint32(offset + 16, p.crc, true);
    view.setUint32(offset + 20, p.size, true);
    view.setUint32(offset + 24, p.size, true);
    view.setUint16(offset + 28, p.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);       // 扩展
    view.setUint16(offset + 32, 0, true);       // 注释
    view.setUint16(offset + 34, 0, true);       // 磁盘号
    view.setUint16(offset + 36, 0, true);       // 内部属性
    view.setUint32(offset + 38, 0, true);       // 外部属性
    view.setUint32(offset + 42, offsets[i], true);
    out.set(p.nameBytes, offset + 46);
    offset += 46 + p.nameBytes.length;
  });

  // ---- 中央目录结束记录 ----
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);

  return out;
}

/* ------------------------------------------------------------------ */
/* 消息处理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统一的消息路由：所有 handler 返回 Promise，自动 sendResponse + 错误捕获
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  const handlers = {
    DG_PING: function () { return Promise.resolve({ ok: true, pong: Date.now() }); },

    // 内容脚本提取完成 → 存起来 + 打开画廊
    DG_EXTRACTED: function () { return handleExtracted(msg.payload, sender); },

    // 打开画廊（扩展图标 / 画廊内部使用）
    DG_OPEN_GALLERY: function () { return openGallery(); },

    // 画廊读取状态
    DG_GET_STATE: function () { return getState(); },

    // 画廊保存偏好（前缀/格式/深色模式等）
    DG_SAVE_SETTINGS: function () {
      return new Promise(function (resolve) {
        chrome.storage.local.set({ [STORAGE_SETTINGS]: safeObj(msg.settings) }, function () {
          resolve({ ok: true });
        });
      });
    },

    // 保存画廊当前的图片列表（拖拽排序、相似图合并后的结果）
    DG_SAVE_IMAGES: function () {
      return new Promise(function (resolve) {
        const pending = safeObj(msg.payload);
        chrome.storage.local.set({ [STORAGE_PENDING]: pending }, function () { resolve({ ok: true }); });
      });
    },

    // 单图取图 + 转码（画廊批量下载时逐个调用）
    DG_PREPARE_IMAGE: function () { return handlePrepareImage(msg.payload); },

    // 批量取图 + 转码 + 打包 ZIP
    DG_BUILD_ZIP: function () { return handleBuildZip(msg.payload, sender); },

    // 生成 CSV 文本
    DG_EXPORT_CSV: function () { return Promise.resolve(handleExportCsv(msg.payload)); }
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  Promise.resolve()
    .then(function () { return handler(); })
    .then(function (result) { sendResponse(result); })
    .catch(function (err) {
      console.error('[奶龙取图] 消息处理失败', msg.type, err);
      sendResponse({ ok: false, error: (err && err.message) || '未知错误' });
    });

  return true; // 异步响应
});

/* ------------------------------------------------------------------ */
/* Handler 实现                                                        */
/* ------------------------------------------------------------------ */

/** 提取完成：写入 storage，更新历史，打开（或复用）画廊标签页 */
function handleExtracted(payload, sender) {
  const data = safeObj(payload);
  const images = Array.isArray(data.images) ? data.images : [];
  const record = {
    images: images,
    pageUrl: data.pageUrl || '',
    pageTitle: data.pageTitle || '',
    host: data.host || '',
    time: data.time || Date.now()
  };

  return new Promise(function (resolve) {
    chrome.storage.local.get([STORAGE_HISTORY], function (stored) {
      const history = safeObj(stored[STORAGE_HISTORY]);
      const nextHistory = {
        lastTime: record.time,
        lastCount: images.length,
        lastUrl: record.pageUrl,
        lastTitle: record.pageTitle,
        totalRuns: (history.totalRuns || 0) + 1
      };
      chrome.storage.local.set({ [STORAGE_PENDING]: record, [STORAGE_HISTORY]: nextHistory }, function () {
        openGallery().then(function () { resolve({ ok: true, count: images.length }); });
      });
    });
  });
}

/** 打开或聚焦画廊页 */
function openGallery() {
  const url = chrome.runtime.getURL(GALLERY_PAGE);
  return new Promise(function (resolve) {
    chrome.tabs.query({ url: url + '*' }, function (tabs) {
      if (chrome.runtime.lastError) {
        // 查询失败就直接新建
        chrome.tabs.create({ url: url }, function () { resolve({ ok: true, created: true }); });
        return;
      }
      if (tabs && tabs.length) {
        const tab = tabs[0];
        chrome.tabs.update(tab.id, { active: true, url: url }, function () {
          chrome.windows.update(tab.windowId, { focused: true }, function () {
            resolve({ ok: true, reused: true });
          });
        });
      } else {
        chrome.tabs.create({ url: url }, function () { resolve({ ok: true, created: true }); });
      }
    });
  });
}

/** 读取画廊需要的全部状态 */
function getState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([STORAGE_PENDING, STORAGE_HISTORY, STORAGE_SETTINGS], function (data) {
      resolve({
        ok: true,
        pending: safeObj(data[STORAGE_PENDING]),
        history: safeObj(data[STORAGE_HISTORY]),
        settings: safeObj(data[STORAGE_SETTINGS])
      });
    });
  });
}

/**
 * 单张图片：取图 → 转码 → 回传 data URL
 * payload: { url, thumb, format, quality, prefix, index, total }
 */
async function handlePrepareImage(payload) {
  const p = safeObj(payload);
  const url = String(p.url || '');
  if (!url) throw new Error('图片地址为空');

  const format = normFormat(p.format);
  const quality = typeof p.quality === 'number' ? p.quality : 0.92;
  const filename = buildFilename(p.prefix, p.index, p.total, format, p.subfolder);
  const srcFormat = formatFromUrl(url);

  // 不需要转码时直接下载原图：省一次网络往返，也避免二次压缩
  if (!p.forceTranscode && srcFormat && srcFormat === format) {
    return { ok: true, mode: 'direct', url: url, filename: filename, format: format };
  }

  try {
    const blob = await fetchImageBlob(url);
    const result = await transcodeBlob(blob, format, quality);
    const dataUrl = await blobToDataUrl(result.blob);
    return {
      ok: true,
      mode: 'converted',
      dataUrl: dataUrl,
      filename: filename,
      format: format,
      width: result.width,
      height: result.height,
      transcoded: result.transcoded,
      bytes: result.blob.size
    };
  } catch (err) {
    // 转码失败（跨域被拦、格式不支持、网络抖动…）→ 降级为按原格式直接下载
    console.warn('[奶龙取图] 转码失败，降级为原格式下载：', url, err && err.message);
    const fallbackFormat = srcFormat || 'jpg';
    return {
      ok: true,
      mode: 'direct',
      url: url,
      filename: buildFilename(p.prefix, p.index, p.total, fallbackFormat, p.subfolder),
      format: fallbackFormat,
      degraded: true,
      reason: (err && err.message) || '转码失败'
    };
  }
}

/**
 * 批量打包 ZIP
 * payload: { items:[{url,thumb}], format, quality, prefix, zipName }
 */
async function handleBuildZip(payload, sender) {
  const p = safeObj(payload);
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error('没有选中任何图片');

  const format = normFormat(p.format);
  const quality = typeof p.quality === 'number' ? p.quality : 0.92;
  const prefix = p.prefix || '奶龙图_';
  const zipName = sanitizeName(p.zipName || ZIP_NAME.replace(/\.zip$/i, '')) + '.zip';
  const total = items.length;
  const entries = [];
  const failed = [];
  let totalBytes = 0;
  let aborted = false;

  for (let i = 0; i < total; i++) {
    const item = safeObj(items[i]);
    const index = i + 1;
    const entryName = buildFilename(prefix, index, total, format, false);
    broadcast({ type: 'DG_PROGRESS', scope: 'zip', current: index, total: total, name: entryName });

    try {
      const blob = await fetchImageBlob(item.url);
      const result = await transcodeBlob(blob, format, quality);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());

      // 体积超过消息回传上限就中断，避免把浏览器内存打爆
      if (totalBytes + bytes.length > MAX_ZIP_MESSAGE) {
        aborted = true;
        break;
      }
      totalBytes += bytes.length;
      entries.push({ name: entryName, bytes: bytes });
    } catch (err) {
      console.warn('[奶龙取图] 打包时跳过一张图', item.url, err && err.message);
      failed.push({ url: item.url, error: (err && err.message) || '失败' });
    }
  }

  if (aborted) {
    throw new Error('选中图片超过 ' + Math.round(MAX_ZIP_MESSAGE / 1024 / 1024) + 'MB，打包包体过大会失败，请改用「下载选中」分批下载');
  }
  if (!entries.length) throw new Error('所有图片都处理失败了，请检查网络或改用单张下载');

  broadcast({ type: 'DG_PROGRESS', scope: 'zip', current: total, total: total, name: '正在压缩…' });
  const zipBytes = buildZipBytes(entries);
  const base64 = bytesToBase64(zipBytes);

  return {
    ok: true,
    zipName: zipName,
    base64: base64,
    count: entries.length,
    failed: failed,
    bytes: zipBytes.length
  };
}

/** 生成 CSV 文本（带 BOM，Excel 打开中文不乱码） */
function handleExportCsv(payload) {
  const p = safeObj(payload);
  const items = Array.isArray(p.items) ? p.items : [];
  const esc = function (v) {
    const s = v === undefined || v === null ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [['序号', '分类', '宽度', '高度', '相似图数量', '图片地址', '来源页面'].map(esc).join(',')];
  items.forEach(function (item, i) {
    const it = safeObj(item);
    rows.push([
      esc(i + 1),
      esc(it.category || ''),
      esc(it.width || ''),
      esc(it.height || ''),
      esc(it.similarCount || 1),
      esc(it.url || ''),
      esc(p.pageUrl || '')
    ].join(','));
  });
  const csv = '\ufeff' + rows.join('\r\n');
  return {
    ok: true,
    csv: csv,
    filename: sanitizeName((p.prefix || '奶龙图_')) + '清单_' + new Date().toISOString().slice(0, 10) + '.csv',
    count: items.length
  };
}

/** 向所有扩展页面广播进度（画廊页监听后更新进度条） */
function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message, function () {
      // 没有监听者时会报 lastError，忽略即可
      void chrome.runtime.lastError;
    });
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ */
/* 扩展图标点击 & 快捷键                                                */
/* ------------------------------------------------------------------ */
chrome.action.onClicked.addListener(function (tab) {
  // 在当前页尝试提取（若是商品详情页才有 content script 响应），同时打开画廊
  if (tab && tab.id && /^https?:/i.test(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { type: 'DG_EXTRACT_NOW' }, function () {
      if (chrome.runtime.lastError) {
        // 当前页没有内容脚本（不是支持的电商页面），直接打开图库看历史
        openGallery();
      }
    });
  } else {
    openGallery();
  }
});

chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'dragon-extract') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'DG_EXTRACT_NOW' }, function () {
      if (chrome.runtime.lastError) {
        console.warn('[奶龙取图] 当前页面无法提取（不是支持的电商详情页）');
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/* 下载完成事件：给画廊页一个回执（可选，用于报错提示）                  */
/* ------------------------------------------------------------------ */
chrome.downloads.onChanged.addListener(function (delta) {
  if (!delta || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    broadcast({
      type: 'DG_DOWNLOAD_STATE',
      id: delta.id,
      state: delta.state.current,
      error: delta.error ? delta.error.current : ''
    });
  }
});
