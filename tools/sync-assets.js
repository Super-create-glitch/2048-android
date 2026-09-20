/*
 * 把游戏文件同步进 APK 的内置资源目录（app/src/main/assets/www）。
 * 默认来源是 ../2048-app（本会话产出的 PWA 构建结果），可用参数换成别的实现：
 *   node tools/sync-assets.js                     使用默认来源
 *   node tools/sync-assets.js --from D:\some\dir  指定目录（需含 index.html）
 *   node tools/sync-assets.js --game D:\some\2048.html   只放一个单文件游戏
 * 同步会记录每个文件的 SHA-256 到 .asset-source.json，供 verify_apk.js 核对。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const DEST = path.join(APP, 'app', 'src', 'main', 'assets', 'www');
const INFO = path.join(APP, '.asset-source.json');
const DEFAULT_SRC = path.join(APP, '..', '2048-app');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--game') out.game = argv[++i];
  }
  return out;
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/* 收集要打包的文件：单文件模式就是 index.html，目录模式是目录下所有文件（跳过 README 与子目录） */
function collect(args) {
  if (args.game) {
    const p = path.resolve(args.game);
    if (!fs.existsSync(p)) throw new Error('找不到游戏文件：' + p);
    return { source: p, files: [{ name: 'index.html', from: p }] };
  }
  const src = path.resolve(args.from || DEFAULT_SRC);
  if (!fs.existsSync(path.join(src, 'index.html'))) {
    throw new Error('来源目录里没有 index.html：' + src + '\n（如果是单文件游戏，请用 --game <文件>)');
  }
  const files = [];
  for (const name of fs.readdirSync(src)) {
    const full = path.join(src, name);
    if (fs.statSync(full).isDirectory()) continue;
    if (/^README\.md$/i.test(name)) continue;      // 说明文档不必进包
    files.push({ name, from: full });
  }
  return { source: src, files };
}

const args = parseArgs(process.argv.slice(2));
const { source, files } = collect(args);

/* 清空目标目录，避免旧残留混进 APK */
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const hashes = {};
let total = 0;
for (const f of files) {
  const buf = fs.readFileSync(f.from);
  fs.writeFileSync(path.join(DEST, f.name), buf);
  hashes[f.name] = sha(buf);
  total += buf.length;
  console.log('  ' + f.name.padEnd(28) + String(buf.length).padStart(8) + ' 字节  sha256 ' + hashes[f.name].slice(0, 16) + '…');
}

/* 回读校验：确保写进去的和源文件逐字节一致 */
let mismatch = 0;
for (const f of files) {
  const a = fs.readFileSync(f.from);
  const b = fs.readFileSync(path.join(DEST, f.name));
  if (!a.equals(b)) { mismatch++; console.log('  ✗ ' + f.name + ' 复制后内容不一致！'); }
}

fs.writeFileSync(INFO, JSON.stringify({
  source, files: hashes, totalBytes: total, syncedAt: new Date().toISOString()
}, null, 2) + '\n', 'utf8');

console.log('\n已同步 ' + files.length + ' 个文件（共 ' + total + ' 字节）到 assets/www');
console.log('  来源：' + source);
console.log('  回读比对：' + (mismatch === 0 ? '全部逐字节一致' : mismatch + ' 个文件不一致！'));
console.log('  记录：.asset-source.json（APK 校验时用它核对内置网页是否被改过）');
if (mismatch) process.exit(1);
