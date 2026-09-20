/*
 * 打一个可以直接上传到 GitHub 的仓库包
 *   node tools/pack-upload.js [输出路径]
 * 默认输出：<工作区>/2048-android-apk.zip
 *
 * 目的：把 android/ 下需要入库的文件收集起来，并保证
 *   - 不漏（关键文件必须在包里）
 *   - 不脏（工具链、本机配置、构建产物、签名密钥一律排除）
 *   - 路径用标准正斜杠（Windows 的 Compress-Archive 会写成反斜杠，不够规范）
 * 打完会重新读回来逐条校验 CRC。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const z = require('./ziplib');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, '..', '2048-android-apk.zip');

/* 排除规则：这些东西不该进仓库 */
const EXCLUDE_DIRS = ['toolchain', 'build', '.gradle', 'node_modules', '_tmp-test', '__pycache__'];
const EXCLUDE_FILES = [
  /^local\.properties$/,
  /^keystore\.properties$/,
  /\.jks$/i, /\.keystore$/i, /\.apk$/i, /\.aab$/i, /\.part$/, /\.zip$/i
];

/* 必须存在的关键文件（少一个构建就会失败，所以要在这里拦住） */
const REQUIRED = [
  '.github/workflows/build-apk.yml',
  '.gitignore',
  'settings.gradle',
  'build.gradle',
  'gradle.properties',
  'app/build.gradle',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/dsh/game2048/MainActivity.java',
  'app/src/main/assets/www/index.html',
  'app/src/main/res/values/themes.xml',
  'app/src/main/res/drawable/ic_launcher_foreground.xml',
  'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
  'app/src/main/res/mipmap/ic_launcher.xml',
  'tools/gen-icon.js',
  'tools/sync-assets.js',
  'tools/verify_apk.js',
  'tools/check-resources.js',
  'tools/ziplib.js',
  'tools/axml.js',
  'tools/test-ziplib.js',
  'tools/setup-toolchain.js',
  'build-apk.js'
];

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relPath = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.includes(name)) continue;
      walk(full, relPath, out);
    } else {
      if (EXCLUDE_FILES.some(re => re.test(name))) continue;
      out.push({ name: relPath, full, size: st.size });
    }
  }
  return out;
}

const files = walk(ROOT, '', []).sort((a, b) => a.name.localeCompare(b.name));
const names = files.map(f => f.name);

const missing = REQUIRED.filter(r => !names.includes(r));
if (missing.length) {
  console.error('缺少关键文件，打包中止：\n  ' + missing.join('\n  '));
  process.exit(1);
}

const payload = files.map(f => ({ name: f.name, data: fs.readFileSync(f.full) }));
const zipBuf = z.makeZip(payload);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zipBuf);

/* ---- 回读校验 ---- */
const back = z.readZip(fs.readFileSync(OUT));
let crcBad = 0, slashBad = 0, dirty = 0;
for (const e of back.entries) {
  if (e.isDir) continue;
  if (e.name.includes('\\')) slashBad++;
  const v = z.verifyEntry(fs.readFileSync(OUT), e);
  if (v.problems.length) crcBad++;
  const base = e.name.split('/').pop();
  if (EXCLUDE_DIRS.some(d => e.name.startsWith(d + '/')) || EXCLUDE_FILES.some(re => re.test(base))) dirty++;
}

console.log('已生成：' + OUT);
console.log('  ' + files.length + ' 个文件，' + (zipBuf.length / 1024).toFixed(1) + ' KB');
console.log('  回读校验：条目 ' + back.entries.filter(e => !e.isDir).length + ' 个，CRC 异常 ' + crcBad + ' 个');
console.log('  路径分隔符：' + (slashBad ? '✗ 有 ' + slashBad + ' 条用了反斜杠' : '✓ 全部为正斜杠'));
console.log('  排除规则：' + (dirty ? '✗ 有 ' + dirty + ' 个不该入库的文件' : '✓ 未混入工具链/本机配置/构建产物/密钥'));
console.log('  最大文件：' + files.slice().sort((a, b) => b.size - a.size).slice(0, 3)
  .map(f => f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)').join('，'));

if (crcBad || slashBad || dirty) process.exit(1);
console.log('\n可以直接上传：解压后把里面的所有内容（含 .github 文件夹）拖进 GitHub 仓库即可。');
