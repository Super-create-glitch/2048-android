/*
 * 静态检查资源引用与类名（不需要 Android SDK，就能提前抓出会中断构建的低级错误）
 *   node tools/check-resources.js
 *
 * 检查项：
 *   1. 所有 @drawable/@mipmap/@color/@string/@style/@xml 引用都有对应定义
 *   2. 所有 XML 都能被解析（格式合法）
 *   3. AndroidManifest 里的 .ClassName 能找到对应的 .java 文件
 *   4. 自适应图标引用的前景/背景/单色层齐全
 *   5. assets/www/index.html 存在（否则装出来是白屏）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'src', 'main');
const RES = path.join(SRC, 'res');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } return c; };

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* 解析矢量路径的包围盒：支持 M/h/v/a/z（生成器只用这几种指令）。
   注意：圆角矩形的弧是向内凹的，极值点就是 M 与各段端点，所以无需按半径外扩。 */
function pathBBox(d) {
  const tk = d.match(/[MHVAZmhvaz]|-?\d*\.?\d+/g) || [];
  let x = 0, y = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const put = (px, py) => {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };
  let i = 0;
  while (i < tk.length) {
    const t = tk[i++];
    if (t === 'M' || t === 'm') { x = Number(tk[i++]); y = Number(tk[i++]); put(x, y); }
    else if (t === 'H' || t === 'h') { x += Number(tk[i++]); put(x, y); }
    else if (t === 'V' || t === 'v') { y += Number(tk[i++]); put(x, y); }
    else if (t === 'A' || t === 'a') { i += 5; x += Number(tk[i++]); y += Number(tk[i++]); put(x, y); }
    else if (t === 'Z' || t === 'z') { /* 闭合，不改坐标 */ }
  }
  return { minX, maxX, minY, maxY };
}

/* ---------- 收集资源定义 ---------- */
const defined = new Set();
const valueFiles = walk(RES).filter(f => /[\\/]values[^\\/]*[\\/].*\.xml$/.test(f));
for (const f of valueFiles) {
  const xml = fs.readFileSync(f, 'utf8');
  for (const m of xml.matchAll(/<(color|string|style|string-array|integer|bool|dimen)\s+name="([^"]+)"/g)) {
    const type = m[1] === 'string-array' ? 'array' : m[1];
    defined.add(type + '/' + m[2]);
  }
}
/* 文件型资源：res/drawable-xxx/name.png|xml → drawable/name；mipmap 同理 */
for (const f of walk(RES)) {
  const rel = path.relative(RES, f).replace(/\\/g, '/');
  const m = rel.match(/^(drawable|mipmap|xml|layout|raw|anim)(-[^/]+)?\/(.+)\.(xml|png|jpg|webp|json|txt)$/);
  if (m) defined.add(m[1] + '/' + m[3]);
}

/* ---------- 收集引用 ---------- */
const files = walk(SRC).filter(f => f.endsWith('.xml') || f.endsWith('.java'));
const refs = [];
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/@(drawable|mipmap|color|string|style|xml|layout|array|raw)\/([A-Za-z0-9_.]+)/g)) {
    refs.push({ type: m[1], name: m[2], file: path.relative(ROOT, f) });
  }
}

console.log('【1】资源引用');
const missing = refs.filter(r => !defined.has(r.type + '/' + r.name));
if (missing.length === 0) {
  ok(true, refs.length + ' 处资源引用全部有定义');
} else {
  ok(false, missing.length + ' 处引用找不到定义：' +
    missing.map(m => m.file + ' → @' + m.type + '/' + m.name).join('；'));
}
const uniq = [...new Set(refs.map(r => r.type + '/' + r.name))].sort();
console.log('    引用：' + uniq.join(', '));
console.log('    定义总数：' + defined.size + '（' + valueFiles.length + ' 个 values 文件）');

console.log('\n【2】XML 格式');
let xmlBad = [];
for (const f of [...files.filter(f => f.endsWith('.xml')), path.join(SRC, 'AndroidManifest.xml')]) {
  const txt = fs.readFileSync(f, 'utf8');
  if (txt.trim().startsWith('<?xml') === false) { xmlBad.push(path.relative(ROOT, f) + '（缺 XML 声明）'); continue; }
  const opens = (txt.match(/<[A-Za-z]/g) || []).length;
  const closes = (txt.match(/<\//g) || []).length + (txt.match(/\/>/g) || []).length;
  const decls = (txt.match(/<\?/g) || []).length + (txt.match(/<!--/g) || []).length;
  if (closes < opens - decls) xmlBad.push(path.relative(ROOT, f) + '（标签未闭合：<' + opens + ' vs </>' + closes + '）');
}
ok(xmlBad.length === 0, xmlBad.length === 0 ? 'XML 声明与标签闭合检查通过' : '异常：' + xmlBad.join('；'));

console.log('\n【3】清单里的类名');
const manifest = fs.readFileSync(path.join(SRC, 'AndroidManifest.xml'), 'utf8');
/* AGP 8 之后包名写在 app/build.gradle 的 namespace 里，清单里不再有 package 属性，
   所以解析 .ClassName 必须优先用 namespace，否则会找错路径 */
const gradle = fs.readFileSync(path.join(ROOT, 'app', 'build.gradle'), 'utf8');
const namespace = (gradle.match(/namespace\s+['"]([^'"]+)['"]/) || [])[1] ||
  (manifest.match(/package="([^"]+)"/) || [])[1];
ok(!!namespace, '解析出包名（namespace）= ' + namespace);
const classes = [...manifest.matchAll(/android:name="([A-Za-z0-9_.]+)"/g)].map(m => m[1])
  .filter(n => !n.startsWith('android.'));
let classBad = [];
for (const c of classes) {
  const full = c.startsWith('.') ? namespace + c : (c.includes('.') ? c : namespace + '.' + c);
  const rel = path.join(SRC, 'java', full.replace(/\./g, '/') + '.java');
  if (!fs.existsSync(rel)) classBad.push(c + ' → ' + full + '（找不到 ' + path.relative(ROOT, rel) + '）');
}
ok(classBad.length === 0, '清单引用的 ' + classes.length + ' 个类都能找到对应 .java：' +
  classes.map(c => (c.startsWith('.') ? namespace + c : c)).join(', '));
if (classBad.length) console.log('    ' + classBad.join('；'));

console.log('\n【4】图标资源链');
const adaptive = path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml');
ok(fs.existsSync(adaptive), '存在自适应图标 ' + path.relative(ROOT, adaptive));
if (fs.existsSync(adaptive)) {
  const a = fs.readFileSync(adaptive, 'utf8');
  ok(/<background[^>]*@color\/ic_launcher_background/.test(a), '背景层指向 @color/ic_launcher_background');
  ok(/<foreground[^>]*@drawable\/ic_launcher_foreground/.test(a), '前景层指向 @drawable/ic_launcher_foreground');
  ok(/<monochrome[^>]*@drawable\/ic_launcher_monochrome/.test(a), '单色层指向 @drawable/ic_launcher_monochrome（Android 13+ 主题图标）');
  const fg = path.join(RES, 'drawable', 'ic_launcher_foreground.xml');
  if (fs.existsSync(fg)) {
    const t = fs.readFileSync(fg, 'utf8');
    const paths = (t.match(/<path/g) || []).length;
    ok(paths >= 2, '前景含 ' + paths + ' 个路径（方块 + 数字）');
    /* 自适应图标安全区：Android 会把图标裁成圆形/水滴形，图案必须落在中间区域，
       否则数字会被切掉。这里按路径坐标算包围盒（生成的路径都是 M/h/v/a 的绝对或相对端点，
       圆角矩形的极值点正好就是这些端点，所以算出来是精确的）。 */
    let min = Infinity, max = -Infinity;
    for (const m of t.matchAll(/android:pathData="([^"]+)"/g)) {
      const b = pathBBox(m[1]);
      min = Math.min(min, b.minX, b.minY);
      max = Math.max(max, b.maxX, b.maxY);
    }
    ok(min >= 18 && max <= 90, '图案包围盒 ' + min.toFixed(1) + '~' + max.toFixed(1) + ' 落在安全区内（自适应图标画布 108，安全区约 18~90）');
  }
}

console.log('\n【5】内置网页');
const idx = path.join(SRC, 'assets', 'www', 'index.html');
ok(fs.existsSync(idx), '存在 assets/www/index.html');
if (fs.existsSync(idx)) {
  const html = fs.readFileSync(idx, 'utf8');
  console.log('    ' + (fs.statSync(idx).size / 1024).toFixed(1) + ' KB，标题：' +
    ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '(无)'));
  ok(/id="board"/.test(html) || /class="board"/.test(html), '包含棋盘元素');
  ok(!/src=["']https?:/i.test(html) && !/href=["']https?:/i.test(html), '没有引用任何外部地址（离线可用）');
}

console.log('\n== 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ==');
process.exit(fail === 0 ? 0 : 1);
