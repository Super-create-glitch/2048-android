/*
 * ZIP 库自测：
 *   1) makeZip 写出 → readZip 读回 → 逐条 CRC/长度校验（往返一致）
 *   2) 若传入一个外部 zip 路径，则解析它并校验全部条目的 CRC（用真实 deflate 数据验证解压路径）
 * 用法：node tools/test-ziplib.js [外部.zip]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const z = require('./ziplib');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 1) 往返测试 ---------- */
const payload = [
  { name: 'assets/www/index.html', data: '<!DOCTYPE html><html><body>2048 测试 🎮</body></html>' },
  { name: 'AndroidManifest.xml', data: Buffer.from([0x03, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0xfe]) },
  { name: 'empty.txt', data: '' },
  { name: 'big.bin', data: Buffer.alloc(70000, 0x5a) }
];
const zbuf = z.makeZip(payload);
ok(zbuf.length > 0, 'makeZip 生成 ' + zbuf.length + ' 字节');

const zr = z.readZip(zbuf);
ok(zr.entries.length === payload.length, 'readZip 读回 ' + zr.entries.length + ' 个条目（期望 ' + payload.length + '）');

let allOk = true;
for (const p of payload) {
  const e = zr.entries.find(x => x.name === p.name);
  if (!e) { allOk = false; console.log('  ✗ 缺少条目 ' + p.name); continue; }
  const { data, problems } = z.verifyEntry(zbuf, e);
  const want = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, 'utf8');
  if (problems.length) { allOk = false; console.log('  ✗ ' + p.name + ' CRC/长度问题：' + problems.join('; ')); }
  else if (!data.equals(want)) { allOk = false; console.log('  ✗ ' + p.name + ' 内容不一致'); }
}
ok(allOk, '全部条目内容与 CRC 校验通过（含空文件与 70KB 大文件、非 UTF-8 二进制）');

/* 故意破坏数据区里的一个字节，确认能查出 CRC 错误
 * 注意：数据区起点要按本地文件头实际长度算（30 字节头 + 文件名 + 扩展区），
 * 直接猜偏移会改到文件名而不是数据，那样是测不出问题的。 */
const bad = Buffer.from(zbuf);
const victim = zr.entries.find(e => e.name === 'assets/www/index.html');
const victimStart = z.rawData(zbuf, victim).start;
bad[victimStart + 10] ^= 0xff;
let detected = false;
try {
  const r = z.verifyEntry(bad, victim);
  detected = r.problems.length > 0;
} catch (e) { detected = true; }
ok(detected, '篡改数据后能检出 CRC 错误（校验真的在读数据）');

/* ---------- 2) 解析外部真实 zip ---------- */
const ext = process.argv[2];
if (ext && fs.existsSync(ext)) {
  const buf = fs.readFileSync(ext);
  const r = z.readZip(buf);
  const names = r.entries.map(e => e.name);
  console.log('\n  外部归档 ' + path.basename(ext) + '：' + r.entries.length + ' 个条目，' + buf.length + ' 字节');
  console.log('    压缩方式分布: ' + JSON.stringify(
    r.entries.reduce((a, e) => { a[e.method === 0 ? '存储' : (e.method === 8 ? 'deflate' : '其它(' + e.method + ')')] = (a[e.method === 0 ? '存储' : (e.method === 8 ? 'deflate' : '其它(' + e.method + ')')] || 0) + 1; return a; }, {})
  ));
  console.log('    前 5 个条目: ' + names.slice(0, 5).join(', '));
  let badCount = 0, checked = 0;
  for (const e of r.entries) {
    if (e.isDir) continue;
    checked++;
    try {
      const res = z.verifyEntry(buf, e);
      if (res.problems.length) { badCount++; if (badCount <= 3) console.log('    ✗ ' + e.name + '：' + res.problems.join('; ')); }
    } catch (err) { badCount++; if (badCount <= 3) console.log('    ✗ ' + e.name + '：' + err.message); }
  }
  ok(badCount === 0, '外部归档 ' + checked + ' 个文件全部解压并通过 CRC 校验');
}

console.log('\n' + (fail === 0 ? '== ZIP 库自测全部通过 ==' : '== ZIP 库自测失败 ' + fail + ' 项 =='));
process.exit(fail === 0 ? 0 : 1);
