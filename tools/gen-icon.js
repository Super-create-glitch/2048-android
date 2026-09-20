/*
 * 生成 Android 启动图标（纯矢量 XML，零二进制依赖）
 *   res/drawable/ic_launcher_foreground.xml   自适应图标前景：琥珀色圆角方块 + 点阵 "2048"
 *   res/drawable/ic_launcher_monochrome.xml   Android 13+ 主题图标用的单色剪影
 *   res/mipmap-anydpi-v26/ic_launcher.xml     自适应图标（背景色 + 前景）
 *   res/mipmap-anydpi-v26/ic_launcher_round.xml
 *   res/values/ic_launcher_background.xml     背景色资源
 *
 * 自适应图标画布 108dp，系统可能裁成圆形/方形/水滴形，只有中间 66~72dp 一定可见，
 * 所以图案按 64dp 居中绘制。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'app', 'src', 'main', 'res');
const CANVAS = 108;          // 自适应图标画布（dp）
const TILE = 64;             // 方块边长（dp），落在安全区内
const FILL = '#3d3418';      // 方块上的数字颜色（深棕，和 PWA 图标一致）
const TILE_COLOR = '#edc22e';// 琥珀色方块
const BG_COLOR = '#0b1220';  // 背景深蓝

/* 5x7 点阵字形：与 PWA 图标用的是同一套，保证视觉一致 */
const GLYPHS = {
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '4': ['00110', '01010', '10010', '11111', '00010', '00010', '00010'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110']
};
const TEXT = '2048';

const f = n => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

/* 圆角矩形路径 */
function roundRect(x, y, w, h, r) {
  return 'M' + f(x + r) + ',' + f(y) +
    'h' + f(w - 2 * r) +
    'a' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(r) + ',' + f(r) +
    'v' + f(h - 2 * r) +
    'a' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(-r) + ',' + f(r) +
    'h' + f(-(w - 2 * r)) +
    'a' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(-r) + ',' + f(-r) +
    'v' + f(-(h - 2 * r)) +
    'a' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(r) + ',' + f(-r) + 'z';
}

/* 把 "2048" 画成一组实心小矩形（每个点亮的点阵格一个矩形） */
function digitPaths(cell, originX, originY) {
  const parts = [];
  for (let g = 0; g < TEXT.length; g++) {
    const rows = GLYPHS[TEXT[g]];
    for (let py = 0; py < 7; py++) {
      for (let px = 0; px < 5; px++) {
        if (rows[py][px] !== '1') continue;
        const x = originX + (g * 6 + px) * cell;
        const y = originY + py * cell;
        parts.push('M' + f(x) + ',' + f(y) + 'h' + f(cell) + 'v' + f(cell) + 'h' + f(-cell) + 'z');
      }
    }
  }
  return parts.join('');
}

/* 圆形路径 */
function circle(cx, cy, r) {
  return 'M' + f(cx - r) + ',' + f(cy) +
    'a' + f(r) + ',' + f(r) + ' 0 1 0 ' + f(2 * r) + ',0' +
    'a' + f(r) + ',' + f(r) + ' 0 1 0 ' + f(-2 * r) + ',0z';
}

function vector(viewport, paths) {
  const body = paths.map(p =>
    '  <path\n    android:fillColor="' + p.color + '"\n    android:pathData="' + p.d + '" />'
  ).join('\n');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!-- 由 tools/gen-icon.js 生成，请勿手改 -->\n' +
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n' +
    '  android:width="' + viewport + 'dp"\n' +
    '  android:height="' + viewport + 'dp"\n' +
    '  android:viewportWidth="' + viewport + '"\n' +
    '  android:viewportHeight="' + viewport + '">\n' + body + '\n</vector>\n';
}

/* ---- 布局计算：方块居中，数字占方块宽度的 62% ---- */
const tileX = (CANVAS - TILE) / 2;
const tileY = (CANVAS - TILE) / 2;
const cell = (TILE * 0.62) / 23;              // 23 = 4 字 × 5 列 + 3 个间隔
const textW = 23 * cell, textH = 7 * cell;
const textX = tileX + (TILE - textW) / 2;
const textY = tileY + (TILE - textH) / 2;

const tilePath = roundRect(tileX, tileY, TILE, TILE, TILE * 0.17);
const digits = digitPaths(cell, textX, textY);

const files = {};

/* 前景：只有方块和数字，背景由 background 层提供 */
files['drawable/ic_launcher_foreground.xml'] = vector(CANVAS, [
  { color: TILE_COLOR, d: tilePath },
  { color: FILL, d: digits }
]);

/* 单色层：整个图案一个颜色，交给系统着色（Android 13+ 主题图标） */
files['drawable/ic_launcher_monochrome.xml'] = vector(CANVAS, [
  { color: '#ffffff', d: tilePath + digits }
]);

/* 自适应图标：背景色 + 前景 */
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<!-- 由 tools/gen-icon.js 生成，请勿手改 -->\n' +
  '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  '  <background android:drawable="@color/ic_launcher_background" />\n' +
  '  <foreground android:drawable="@drawable/ic_launcher_foreground" />\n' +
  '  <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n' +
  '</adaptive-icon>\n';
files['mipmap-anydpi-v26/ic_launcher.xml'] = adaptive;
files['mipmap-anydpi-v26/ic_launcher_round.xml'] = adaptive;

/* 兜底图标：再给 mipmap 的默认配置（不带 -v26 限定符）一份普通矢量图标。
   自适应图标只能放在 -v26 目录里，"只有 v26 一个配置"会让 AAPT2 抱怨资源缺少默认配置，
   直接构建失败。minSdk 26 时运行时永远用不到它（任何设备都会选中 anydpi-v26），
   但它能彻底消掉这个构建风险，而且依然是矢量、不需要任何 PNG。 */
const legacyBg = roundRect(0, 0, CANVAS, CANVAS, CANVAS * 0.22);
const legacyCircle = circle(CANVAS / 2, CANVAS / 2, CANVAS / 2);
files['mipmap/ic_launcher.xml'] = vector(CANVAS, [
  { color: BG_COLOR, d: legacyBg },
  { color: TILE_COLOR, d: tilePath },
  { color: FILL, d: digits }
]);
files['mipmap/ic_launcher_round.xml'] = vector(CANVAS, [
  { color: BG_COLOR, d: legacyCircle },
  { color: TILE_COLOR, d: tilePath },
  { color: FILL, d: digits }
]);

files['values/ic_launcher_background.xml'] =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<!-- 由 tools/gen-icon.js 生成，请勿手改 -->\n' +
  '<resources>\n  <color name="ic_launcher_background">' + BG_COLOR + '</color>\n</resources>\n';

let written = 0;
for (const rel of Object.keys(files)) {
  const target = path.join(RES, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, files[rel], 'utf8');
  console.log('  写入 res/' + rel.replace(/\\/g, '/') + '  (' + Buffer.byteLength(files[rel], 'utf8') + ' 字节)');
  written++;
}
console.log('\n图标生成完成：' + written + ' 个文件');
console.log('  画布 ' + CANVAS + 'dp，方块 ' + TILE + 'dp，点阵格 ' + cell.toFixed(3) + 'dp，数字区域 ' +
  textW.toFixed(2) + 'x' + textH.toFixed(2) + 'dp，点亮格数 ' +
  ['2', '0', '4', '8'].reduce((n, c) => n + GLYPHS[c].join('').split('').filter(x => x === '1').length, 0));
