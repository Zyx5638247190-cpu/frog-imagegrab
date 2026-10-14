/* ==========================================================================
 * 打包扩展为可下载的 zip
 *   node tools/pack-extension.js
 * 输出：docs/download/dragongrab-v<manifest 里的版本号>.zip
 *
 * 说明：不用 PowerShell 的 Compress-Archive —— 它在 Windows 上会把条目名写成
 * 反斜杠（dragongrab\manifest.json），在 macOS / Linux 上解压会得到一个名字里
 * 带反斜杠的怪文件，Chrome 加载会失败。这里自己写 zip，条目名统一用正斜杠，
 * 并对内容做 deflate 压缩（方法 8），符合 zip 规范。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dragongrab');
const OUT_DIR = path.join(ROOT, 'docs', 'download');

/* ---------------- zip 基础件 ---------------- */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 收集目录下所有文件，返回 { name, full }，name 用正斜杠 */
function walk(dir, prefix, out) {
  fs.readdirSync(dir, { withFileTypes: true })
    .sort(function (a, b) { return a.name.localeCompare(b.name); })
    .forEach(function (entry) {
      const full = path.join(dir, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(full, name + '/', out);
      else out.push({ name: name, full: full });
    });
  return out;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach(function (f) {
    const data = fs.readFileSync(f.full);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压缩后更大就用存储方式（方法 0）
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 解压所需版本
    local.writeUInt16LE(0x0800, 6);       // 通用标志位：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // 修改时间
    local.writeUInt16LE(0x21, 12);        // 修改日期（2026-01-01 之类，固定值保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 扩展字段长度

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // 中央目录签名
    cd.writeUInt16LE(20, 4);              // 创建版本
    cd.writeUInt16LE(20, 6);              // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // 扩展字段
    cd.writeUInt16LE(0, 32);              // 注释
    cd.writeUInt16LE(0, 34);              // 磁盘号
    cd.writeUInt16LE(0, 36);              // 内部属性
    cd.writeUInt32LE(0, 38);              // 外部属性
    cd.writeUInt32LE(offset, 42);         // 本地文件头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // 中央目录结束记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

/* ---------------- 执行 ---------------- */
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const version = manifest.version;
const files = walk(SRC, 'dragongrab/', []);
const zip = buildZip(files);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'dragongrab-v' + version + '.zip');
fs.writeFileSync(outPath, zip);

console.log('已打包 ' + manifest.name + ' v' + version);
console.log('输出：' + path.relative(ROOT, outPath) + '（' + zip.length + ' 字节 / ' +
  (zip.length / 1024).toFixed(1) + ' KB）');
files.forEach(function (f) {
  console.log('  ' + f.name.padEnd(34) + fs.statSync(f.full).size + ' B');
});
