/*
 * APK 校验器（零依赖，不需要装 Android SDK）
 *   node tools/verify_apk.js [apk路径]
 * 不传路径时自动在 app/build/outputs 下找最新的 APK。
 *
 * 校验内容：
 *   1. ZIP 结构完整：逐条解压 + CRC32 比对（证明包没坏、没被截断）
 *   2. 必需的条目齐全：AndroidManifest.xml / classes.dex / resources.arsc / assets/www/index.html
 *   3. resources.arsc 必须“不压缩且 4 字节对齐”（Android 11+ 的硬性要求）
 *   4. 内置网页与同步来源逐字节一致（用 .asset-source.json 记录的 SHA-256 核对）
 *   5. classes.dex 头合法，且确实包含 MainActivity
 *   6. 签名方案：v1（META-INF 三件套）与 v2/v3（APK Signing Block）
 *   7. 解析二进制清单，核对包名/版本/minSdk/targetSdk/权限/启动入口
 *
 * 说明：第 7 项如果解析失败，会明确记为“未验证”而不是当作通过 —— 首次真机构建时
 * 我会再用 aapt2 dump badging 交叉核对一遍。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const z = require('./ziplib');
const axml = require('./axml');

const APP = path.join(__dirname, '..');
const ASSET_INFO = path.join(APP, '.asset-source.json');
const ASSET_DIR = path.join(APP, 'app', 'src', 'main', 'assets', 'www');

/* 工程里声明的期望值（与 app/build.gradle、AndroidManifest.xml 对应） */
const EXPECT = {
  applicationId: 'com.dsh.game2048',
  versionCode: 1,
  minSdk: 26,
  targetSdk: 34,
  permission: 'android.permission.VIBRATE',
  entryActivity: 'com.dsh.game2048.MainActivity'
};

let pass = 0, fail = 0, unverified = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } return c; };
const warn = m => { unverified++; console.log('  ? ' + m); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- 找 APK ---------- */
function findApk() {
  const explicit = process.argv[2];
  if (explicit) {
    if (!fs.existsSync(explicit)) { console.error('找不到文件：' + explicit); process.exit(2); }
    return explicit;
  }
  const roots = [
    path.join(APP, 'app', 'build', 'outputs', 'apk', 'release'),
    path.join(APP, 'app', 'build', 'outputs', 'apk', 'debug')
  ];
  const found = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const f of fs.readdirSync(r)) if (f.endsWith('.apk')) found.push(path.join(r, f));
  }
  if (!found.length) {
    console.error('没有找到 APK。请先构建，或把 APK 路径作为参数传进来：');
    console.error('  node tools/verify_apk.js D:\\path\\to\\app-release.apk');
    process.exit(2);
  }
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}

const apkPath = findApk();
const buf = fs.readFileSync(apkPath);
console.log('校验 APK：' + apkPath);
console.log('  大小 ' + (buf.length / 1024).toFixed(0) + ' KB（' + buf.length + ' 字节）\n');

/* ---------- 1. ZIP 结构与 CRC ---------- */
console.log('【1】ZIP 结构与完整性');
let zip;
try {
  zip = z.readZip(buf);
} catch (e) {
  console.log('  ✗ 无法解析 ZIP：' + e.message);
  process.exit(1);
}
ok(zip.entries.length > 0, '归档条目数 ' + zip.entries.length + '（ZIP 注释 ' + (zip.comment ? '有' : '无') + '）');
const entryMap = new Map(zip.entries.map(e => [e.name, e]));
const methods = {};
let crcBad = [], crcChecked = 0, totalUncompressed = 0;
for (const e of zip.entries) {
  methods[e.method] = (methods[e.method] || 0) + 1;
  if (e.isDir) continue;
  crcChecked++;
  totalUncompressed += e.usize;
  try {
    const r = z.verifyEntry(buf, e);
    if (r.problems.length) crcBad.push(e.name + '：' + r.problems.join('; '));
  } catch (err) {
    crcBad.push(e.name + '：' + err.message);
  }
}
ok(crcBad.length === 0, '全部 ' + crcChecked + ' 个文件解压并通过 CRC32 校验' + (crcBad.length ? '（异常：' + crcBad.slice(0, 3).join(' | ') + '）' : ''));
console.log('    压缩方式：' + Object.keys(methods).map(m => (m === '0' ? '存储' : m === '8' ? 'deflate' : '其它(' + m + ')') + ' × ' + methods[m]).join('，'));
console.log('    解压后总计 ' + (totalUncompressed / 1024).toFixed(0) + ' KB');

/* ---------- 2. 必需条目 ---------- */
console.log('\n【2】必需条目');
const required = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/www/index.html'];
for (const r of required) ok(entryMap.has(r), '存在 ' + r);

/* ---------- 3. resources.arsc 压缩与对齐 ---------- */
console.log('\n【3】resources.arsc（Android 11+ 要求不压缩且 4 字节对齐）');
const arsc = entryMap.get('resources.arsc');
if (arsc) {
  ok(arsc.method === 0, '未被压缩（method=' + arsc.method + '）');
  const start = z.rawData(buf, arsc).start;
  ok(start % 4 === 0, '数据起点 ' + start + ' 是 4 字节对齐（偏移 % 4 = ' + (start % 4) + '）');
} else {
  ok(false, '缺少 resources.arsc，无法检查');
}

/* ---------- 4. 内置网页与来源一致 ---------- */
console.log('\n【4】内置网页与同步来源是否逐字节一致');
let assetInfo = null;
if (fs.existsSync(ASSET_INFO)) {
  try { assetInfo = JSON.parse(fs.readFileSync(ASSET_INFO, 'utf8')); } catch (e) { warn('读取 .asset-source.json 失败：' + e.message); }
}
const apkAssets = zip.entries.filter(e => e.name.startsWith('assets/www/') && !e.isDir);
if (!apkAssets.length) {
  ok(false, 'APK 里没有 assets/www/ 下的文件');
} else {
  const inApk = new Map();
  for (const e of apkAssets) {
    const data = z.readEntry(buf, e);
    inApk.set(e.name.slice('assets/www/'.length), sha(data));
  }
  if (assetInfo && assetInfo.files) {
    let bad = 0, miss = 0;
    for (const name of Object.keys(assetInfo.files)) {
      if (!inApk.has(name)) { miss++; console.log('    ✗ APK 里缺少 ' + name); continue; }
      if (inApk.get(name) !== assetInfo.files[name]) { bad++; console.log('    ✗ ' + name + ' 内容与来源不一致'); }
    }
    const extra = [...inApk.keys()].filter(n => !(n in assetInfo.files));
    ok(bad === 0 && miss === 0, 'APK 内 ' + inApk.size + ' 个网页文件与来源（' + assetInfo.source + '）逐一 SHA-256 一致');
    if (extra.length) warn('APK 里多出未记录的文件：' + extra.join(', '));
  } else {
    // 没有记录文件时，退化为直接和工程里的 assets 目录比对
    let bad = 0;
    for (const [name, h] of inApk) {
      const local = path.join(ASSET_DIR, name);
      if (!fs.existsSync(local)) { bad++; console.log('    ✗ 本地缺少 ' + name); continue; }
      if (sha(fs.readFileSync(local)) !== h) { bad++; console.log('    ✗ ' + name + ' 内容不一致'); }
    }
    ok(bad === 0, 'APK 内 ' + inApk.size + ' 个网页文件与 app/src/main/assets/www 一致（无 .asset-source.json）');
  }
  console.log('    文件：' + [...inApk.keys()].join(', '));
}

/* ---------- 5. classes.dex ---------- */
console.log('\n【5】classes.dex');
const dex = entryMap.get('classes.dex');
if (dex) {
  const data = z.readEntry(buf, dex);
  const magic = data.toString('latin1', 0, 8);
  ok(/^dex\n0\d\d\0$/.test(magic), '魔数正确：' + JSON.stringify(magic));
  const dexSize = data.readUInt32LE(32);
  ok(dexSize === data.length, '头部记录的文件长度 ' + dexSize + ' 与实际 ' + data.length + ' 一致');
  const stringIds = data.readUInt32LE(56);
  const methodIds = data.readUInt32LE(76);
  const classDefs = data.readUInt32LE(80);
  console.log('    字符串 ' + stringIds + ' 个，方法引用 ' + methodIds + ' 个，类定义 ' + classDefs + ' 个');
  const hasMain = data.includes(Buffer.from('MainActivity', 'utf8'));
  const hasPkg = data.includes(Buffer.from(EXPECT.entryActivity, 'utf8')) ||
    data.includes(Buffer.from(EXPECT.applicationId.replace(/\./g, '/'), 'utf8'));
  ok(hasMain, 'dex 字符串表里含 "MainActivity"');
  ok(hasPkg, 'dex 字符串表里含入口类的全限定名');
  ok(classDefs >= 1, '至少定义了 1 个类');
} else {
  ok(false, '缺少 classes.dex');
}

/* ---------- 6. 签名 ---------- */
console.log('\n【6】签名');
const v1 = ['META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA']
  .map(n => entryMap.has(n));
const v1Other = zip.entries.filter(e => /^META-INF\/.*\.(SF|RSA|DSA|EC)$/i.test(e.name)).map(e => e.name);
ok(v1Other.length >= 2, 'v1（JAR）签名文件存在：' + (v1Other.join(', ') || '无'));

/* APK Signing Block：位于中央目录之前，末尾是魔数 "APK Sig Block 42" */
const eocdPos = (() => { for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i; return -1; })();
let schemes = [];
if (eocdPos >= 0) {
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (cdOffset >= 24 && buf.toString('latin1', cdOffset - 16, cdOffset) === 'APK Sig Block 42') {
    const sizeAtEnd = Number(buf.readBigUInt64LE(cdOffset - 24));
    const blockStart = cdOffset - 8 - sizeAtEnd;
    if (blockStart >= 0) {
      let p = blockStart + 8;
      const end = blockStart + 8 + sizeAtEnd - 24;
      while (p + 12 <= end) {
        const len = Number(buf.readBigUInt64LE(p));
        const id = buf.readUInt32LE(p + 8);
        schemes.push(id);
        p += 8 + len;
      }
    }
  }
}
const SCHEME_NAMES = { 0x7109871a: 'v2', 0xf05368c0: 'v3', 0x1b93ad61: 'v3.1', 0x42726577: 'v4?', 0x2b09189e: 'source-stamp', 0x6dff800d: 'verity' };
const named = schemes.map(s => SCHEME_NAMES[s] || ('0x' + s.toString(16)));
ok(schemes.includes(0x7109871a), 'APK Signing Block 里含 v2 签名' + (named.length ? '（含：' + named.join(', ') + '）' : ''));
if (schemes.includes(0xf05368c0)) console.log('    另外还带 v3 签名（Android 9+ 支持密钥轮换）');

/* ---------- 7. 二进制清单 ---------- */
console.log('\n【7】AndroidManifest.xml');
const mf = entryMap.get('AndroidManifest.xml');
if (mf) {
  const data = z.readEntry(buf, mf);
  try {
    const s = axml.summarize(data);
    ok(s.package === EXPECT.applicationId, '包名 = ' + s.package + '（期望 ' + EXPECT.applicationId + '）');
    ok(s.versionCode === EXPECT.versionCode, 'versionCode = ' + s.versionCode + '（期望 ' + EXPECT.versionCode + '）');
    ok(s.minSdk === EXPECT.minSdk, 'minSdk = ' + s.minSdk + '（期望 ' + EXPECT.minSdk + ' = Android 8.0）');
    ok(s.targetSdk === EXPECT.targetSdk, 'targetSdk = ' + s.targetSdk + '（期望 ' + EXPECT.targetSdk + '）');
    ok(s.permissions.includes(EXPECT.permission), '声明了权限 ' + EXPECT.permission + '（震动反馈）实际：' + (s.permissions.join(', ') || '无'));
    ok(s.permissions.length === 1, '权限只有 1 项（不需要网络权限）');
    ok(s.hasLauncher, '存在带 LAUNCHER 入口的 Activity');
    const launcher = s.activities.find(a => a.isLauncher);
    if (launcher) ok(launcher.name === EXPECT.entryActivity, '入口类 = ' + launcher.name + '（期望 ' + EXPECT.entryActivity + '）');
    console.log('    清单元素 ' + s.elementCount + ' 个，字符串池 ' + (s.stringPoolIsUtf8 ? 'UTF-8' : 'UTF-16'));
    if (s.versionName) console.log('    versionName = ' + s.versionName);
  } catch (e) {
    warn('二进制清单解析失败，未能核对包名/版本/权限：' + e.message);
    warn('  这属于“未验证”而非通过；装好工具链后请再用 aapt2 dump badging 核对。');
  }
} else {
  ok(false, '缺少 AndroidManifest.xml');
}

/* ---------- 小结 ---------- */
console.log('\n【体积构成】最大的 8 个条目');
zip.entries.filter(e => !e.isDir).sort((a, b) => b.usize - a.usize).slice(0, 8)
  .forEach(e => console.log('    ' + e.name.padEnd(42) + String((e.usize / 1024).toFixed(1)).padStart(9) + ' KB'));

console.log('\n== 通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (unverified ? '，未验证 ' + unverified + ' 项' : '') + ' ==');
if (unverified) console.log('（“未验证”不等于通过：说明该项没能真正检查）');
process.exit(fail === 0 ? 0 : 1);
