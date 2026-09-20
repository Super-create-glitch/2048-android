/*
 * 一键构建 APK
 *   node build-apk.js              构建 release（默认）
 *   node build-apk.js --debug      构建 debug（可用 chrome://inspect 调试页面）
 *   node build-apk.js --clean      先清理再构建
 *   node build-apk.js --skip-sync  不重新同步网页资源
 *
 * 流程：同步内置网页 → 生成图标 → Gradle 打包 → 校验 APK
 * 装好工具链后（node tools/setup-toolchain.js）本机即可完成全部步骤。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const z = require('./tools/ziplib');
const axml = require('./tools/axml');

const ROOT = __dirname;
const TC = path.join(ROOT, 'toolchain');
const SDK_DIR = path.join(TC, 'android-sdk');
const JDK_DIR = path.join(TC, 'jdk');
const BUILD_TOOLS = path.join(SDK_DIR, 'build-tools', '34.0.0');

const argv = process.argv.slice(2);
const DEBUG = argv.includes('--debug');
const CLEAN = argv.includes('--clean');
const SKIP_SYNC = argv.includes('--skip-sync');
const VARIANT = DEBUG ? 'debug' : 'release';
const TASK = DEBUG ? 'assembleDebug' : 'assembleRelease';

const banner = t => console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));
const step = t => console.log('\n【' + t + '】');

function runNode(script, args, label) {
  console.log('  $ node ' + path.relative(ROOT, script) + ' ' + (args || []).join(' '));
  execFileSync(process.execPath, [script].concat(args || []), { cwd: ROOT, stdio: 'inherit' });
}

/* 找 Gradle：优先用本目录工具链里的，其次 PATH */
function findGradle() {
  const local = path.join(TC, 'gradle-8.7', 'bin', 'gradle.bat');
  if (fs.existsSync(local)) return local;
  return 'gradle';
}

function gradleEnv() {
  const env = Object.assign({}, process.env);
  if (fs.existsSync(path.join(JDK_DIR, 'bin', 'java.exe'))) {
    env.JAVA_HOME = JDK_DIR;
    env.PATH = path.join(JDK_DIR, 'bin') + path.delimiter + env.PATH;
  }
  if (fs.existsSync(SDK_DIR)) env.ANDROID_HOME = SDK_DIR;
  return env;
}

/* 让 Gradle 找到 SDK（CI 上是环境变量，本机是 local.properties） */
function ensureLocalProperties() {
  if (!fs.existsSync(SDK_DIR)) return false;
  const lp = path.join(ROOT, 'local.properties');
  const want = 'sdk.dir=' + SDK_DIR.replace(/\\/g, '\\\\') + '\n';
  if (!fs.existsSync(lp) || fs.readFileSync(lp, 'utf8') !== want) {
    fs.writeFileSync(lp, want, 'utf8');
    console.log('  已写入 local.properties → ' + SDK_DIR);
  }
  return true;
}

function findApk() {
  const dir = path.join(ROOT, 'app', 'build', 'outputs', 'apk', VARIANT);
  if (!fs.existsSync(dir)) return null;
  const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk'))
    .map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return apks[0] || null;
}

/* 用 aapt2 交叉核对二进制清单（验证自研 AXML 解析器是否读对了） */
function crossCheckManifest(apk) {
  const aapt2 = path.join(BUILD_TOOLS, 'aapt2.exe');
  if (!fs.existsSync(aapt2)) {
    console.log('  （未找到 aapt2，跳过交叉核对；装好工具链后会自动启用）');
    return;
  }
  const outFile = path.join(ROOT, 'build', 'aapt2-badging.txt');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  execFileSync('cmd', ['/c', '"' + aapt2 + '" dump badging "' + apk + '" > "' + outFile + '" 2>&1'], { stdio: 'inherit' });
  const txt = fs.readFileSync(outFile, 'utf8');
  const grab = re => { const m = txt.match(re); return m ? m[1] : null; };
  const aaptPkg = grab(/package: name='([^']+)'/);
  const aaptMin = grab(/sdkVersion:'(\d+)'/);
  const aaptTarget = grab(/targetSdkVersion:'(\d+)'/);
  const aaptPerm = (txt.match(/uses-permission: name='([^']+)'/g) || []).map(s => s.replace(/.*name='([^']+)'.*/, '$1'));
  const aaptLaunch = grab(/launchable-activity: name='([^']+)'/);
  console.log('  aapt2 读出：package=' + aaptPkg + ' minSdk=' + aaptMin + ' targetSdk=' + aaptTarget);
  console.log('             权限=' + (aaptPerm.join(', ') || '无') + ' 入口=' + aaptLaunch);

  // 自研解析器的结果
  const buf = fs.readFileSync(apk);
  const zip = z.readZip(buf);
  const mf = zip.entries.find(e => e.name === 'AndroidManifest.xml');
  const mine = axml.summarize(z.readEntry(buf, mf));
  console.log('  自研解析器：package=' + mine.package + ' minSdk=' + mine.minSdk + ' targetSdk=' + mine.targetSdk);
  console.log('             权限=' + (mine.permissions.join(', ') || '无') + ' 入口=' + (mine.activities.find(a => a.isLauncher) || {}).name);

  const same = aaptPkg === mine.package && String(aaptMin) === String(mine.minSdk) &&
    String(aaptTarget) === String(mine.targetSdk) &&
    aaptPerm.length === mine.permissions.length &&
    aaptPerm.every(p => mine.permissions.includes(p));
  if (same) {
    console.log('  ✓ 自研 AXML 解析器与 aapt2 结果完全一致（解析器可信）');
  } else {
    console.log('  ✗ 自研解析器与 aapt2 结果不一致！请检查 tools/axml.js');
    process.exitCode = 1;
  }
}

function crossCheckSignature(apk) {
  const apksigner = path.join(BUILD_TOOLS, 'apksigner.bat');
  if (!fs.existsSync(apksigner)) return;
  const env = gradleEnv();
  console.log('  $ apksigner verify --print-certs');
  try {
    execFileSync(apksigner, ['verify', '--print-certs', '--verbose', apk], { stdio: 'inherit', env: env });
    console.log('  ✓ apksigner 校验通过');
  } catch (e) {
    console.log('  ✗ apksigner 校验失败');
    process.exitCode = 1;
  }
}

/* ============================ 主流程 ============================ */
banner('构建 2048 APK（' + VARIANT + '）');

step('0/5 环境检查');
const javaHome = fs.existsSync(path.join(JDK_DIR, 'bin', 'java.exe')) ? JDK_DIR : (process.env.JAVA_HOME || '(未设置)');
console.log('  JDK：    ' + javaHome);
console.log('  SDK：    ' + (fs.existsSync(SDK_DIR) ? SDK_DIR : '未找到 ' + SDK_DIR));
console.log('  Gradle： ' + findGradle());
if (!fs.existsSync(SDK_DIR)) {
  console.error('\n没有找到 SDK。请先运行：node tools/setup-toolchain.js');
  process.exit(2);
}
ensureLocalProperties();

step('1/5 同步内置网页');
if (SKIP_SYNC) {
  console.log('  已按 --skip-sync 跳过');
} else {
  runNode(path.join(ROOT, 'tools', 'sync-assets.js'), [], 'sync-assets');
}

step('2/5 生成图标');
runNode(path.join(ROOT, 'tools', 'gen-icon.js'), [], 'gen-icon');

step('3/5 Gradle 打包（首次会下载 AGP 依赖，约 200~350 MB，需要几分钟）');
if (CLEAN) {
  execFileSync(findGradle(), ['clean'], { cwd: ROOT, stdio: 'inherit', env: gradleEnv() });
}
const gradleArgs = [TASK, '--no-daemon', '--console=plain'];
if (!DEBUG) gradleArgs.push('-x', 'lint');
console.log('  $ gradle ' + gradleArgs.join(' '));
execFileSync(findGradle(), gradleArgs, { cwd: ROOT, stdio: 'inherit', env: gradleEnv() });

step('4/5 定位产物');
const apk = findApk();
if (!apk) {
  console.error('  构建结束但没找到 APK（期望目录：app/build/outputs/apk/' + VARIANT + '）');
  process.exit(1);
}
console.log('  ' + apk);
console.log('  ' + (fs.statSync(apk).size / 1024).toFixed(0) + ' KB');

step('5/5 校验 APK');
runNode(path.join(ROOT, 'tools', 'verify_apk.js'), [apk], 'verify-apk');
console.log('\n--- 与 aapt2 / apksigner 交叉核对 ---');
crossCheckManifest(apk);
crossCheckSignature(apk);

banner('完成');
console.log('APK：' + apk);
console.log('传到手机：数据线拷贝 / 微信文件传输 / 网盘均可，点击安装时若提示"未知来源"，');
console.log('在系统设置里允许该来源安装即可。');
console.log('\n安装命令（手机开启 USB 调试并插上数据线后）：');
console.log('  "' + path.join(SDK_DIR, 'platform-tools', 'adb.exe') + '" install -r "' + apk + '"');
if (process.exitCode) console.log('\n注意：上面有检查未通过，请查看输出。');
