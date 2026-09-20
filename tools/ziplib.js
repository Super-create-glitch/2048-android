/*
 * 极简 ZIP 读写库（零依赖，只用 Node 内置 zlib）
 * 用途：
 *   1) verify_apk.js 解析 APK（APK 就是 ZIP），校验条目、CRC、压缩方式与对齐
 *   2) setup-toolchain.js 解压 JDK / Android cmdline-tools / Gradle 的官方 zip
 */
'use strict';
const zlib = require('zlib');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- 定位 EOCD（末尾中央目录） ---------- */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到 EOCD 记录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff) {
    throw new Error('暂不支持 ZIP64（APK 通常不会用到）');
  }
  if (p + cdSize > buf.length) throw new Error('中央目录越界，文件可能被截断');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录第 ' + i + ' 项签名错误');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const mtime = buf.readUInt16LE(p + 12);
    const mdate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({
      name, flags, method, crc, csize, usize, localOffset, externalAttrs,
      mtime, mdate, isDir: name.endsWith('/')
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, comment: buf.toString('utf8', eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20)) };
}

/* 取某个条目的原始（可能已压缩）数据区 */
function rawData(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(entry.name + ' 的本地文件头签名错误');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const slice = buf.subarray(start, start + entry.csize);
  if (slice.length !== entry.csize) throw new Error(entry.name + ' 数据被截断');
  return { start, slice };
}

/* 取解压后的内容（method 0 = 存储，8 = deflate） */
function readEntry(buf, entry) {
  const { slice } = rawData(buf, entry);
  if (entry.method === 0) return Buffer.from(slice);
  if (entry.method === 8) return zlib.inflateRawSync(slice);
  throw new Error(entry.name + ' 使用了不支持的压缩方式 ' + entry.method);
}

/* 校验 CRC 与长度是否与中央目录一致 */
function verifyEntry(buf, entry) {
  const data = readEntry(buf, entry);
  const problems = [];
  if (data.length !== entry.usize) problems.push('解压长度 ' + data.length + ' ≠ 记录值 ' + entry.usize);
  const c = crc32(data);
  if (c !== entry.crc) problems.push('CRC32 ' + c.toString(16) + ' ≠ 记录值 ' + entry.crc.toString(16));
  return { data, problems };
}

/* ---------- 写 ZIP（存储方式，不压缩；用于自测与生成简单归档） ---------- */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0, 6);               // flags
    lh.writeUInt16LE(0, 8);               // method: stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, data);
    central.push({ nameBuf, crc, size: data.length, offset });
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20);
    ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    cdParts.push(ch, c.nameBuf);
    cdSize += ch.length + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...cdParts, end]);
}

module.exports = { crc32, readZip, readEntry, rawData, verifyEntry, makeZip };
