/*
 * 一键安装 Android 构建工具链到 android/toolchain/（不污染系统，不需要管理员权限）
 *   node tools/setup-toolchain.js           下载并安装全部
 *   node tools/setup-toolchain.js --check   只检查现状，不下载
 *
 * 安装内容（体积为实测值）：
 *   Temurin JDK 17        约 182 MB
 *   Android cmdline-tools 约 148 MB
 *   Gradle 8.7            约 128 MB
 *   SDK 组件 platform-tools + platforms;android-34 + build-tools;34.0.0  约 124 MB
 *   合计约 580 MB（不含首次构建时 Gradle 再拉的 AGP 依赖）
 *
 * 脚本可重复执行：已完成的步骤会跳过，下载中断后重跑即可。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const z = require('./ziplib');

const ROOT = path.join(__dirname, '..');
const TC = path.join(ROOT, 'toolchain');
const CHECK_ONLY = process.argv.includes('--check');

const JDK_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse';
const CMDLINE_URL = 'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip';
const GRADLE_URL = 'https://services.gradle.org/distributions/gradle-8.7-bin.zip';

const JDK_DIR = path.join(TC, 'jdk');
const SDK_DIR = path.join(TC, 'android-sdk');
const GRADLE_DIR = path.join(TC, 'gradle-8.7');

const MB = n => (n / 1048576).toFixed(1) + ' MB';

/* ---------- 下载（跟随重定向，带进度与大小校验） ---------- */
function download(url, dest, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    let received = 0, total = 0, lastPrint = 0;
    const req = https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 6) {
        file.close();
        fs.unlinkSync(tmp);
        return resolve(download(new URL(res.headers.location, url).href, dest, depth + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmp); } catch (e) {}
        return reject(new Error('HTTP ' + res.statusCode + '：' + url));
      }
      total = Number(res.headers['content-length'] || 0);
      const started = Date.now();
      res.on('data', c => {
        received += c.length;
        const now = Date.now();
        if (now - lastPrint > 1500) {
          lastPrint = now;
          const pct = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
          const speed = received / 1048576 / ((now - started) / 1000);
          process.stdout.write('\r    ' + pct + '  ' + MB(received) + ' / ' + (total ? MB(total) : '?') +
            '  ' + speed.toFixed(2) + ' MB/s      ');
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\r    ' + MB(received) + ' 下载完成（' + ((Date.now() - started) / 1000).toFixed(0) + ' 秒）' + ' '.repeat(30) + '\n');
          if (total && received !== total) return reject(new Error('大小不符：收到 ' + received + '，声明 ' + total));
          fs.renameSync(tmp, dest);
          resolve(dest);
        });
      });
    });
    req.setTimeout(60000, () => { req.destroy(new Error('下载超时（60 秒无响应）')); });
    req.on('error', err => { file.close(); try { fs.unlinkSync(tmp); } catch (e) {} reject(err); });
  });
}

/* ---------- 解压（用自研 ZIP 库，无需外部工具） ---------- */
function extractZipTo(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const zip = z.readZip(buf);
  fs.mkdirSync(destDir, { recursive: true });
  let files = 0, dirs = 0;
  for (const e of zip.entries) {
    const target = path.join(destDir, e.name);
    if (!target.startsWith(destDir)) throw new Error('归档里出现越界路径：' + e.name);
    if (e.isDir) { fs.mkdirSync(target, { recursive: true }); dirs++; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, z.readEntry(buf, e));
    files++;
  }
  return { files, dirs, bytes: buf.length };
}

/* ---------- 运行外部命令（stdio 继承，不捕获管道） ---------- */
function run(exe, args, extraEnv, label) {
  console.log('  $ ' + label);
  execFileSync(exe, args, {
    stdio: 'inherit',
    env: Object.assign({}, process.env, extraEnv || {})
  });
}

const jdkEnv = () => ({
  JAVA_HOME: JDK_DIR,
  PATH: path.join(JDK_DIR, 'bin') + path.delimiter + process.env.PATH,
  ANDROID_HOME: SDK_DIR
});

/* ---------- 步骤 ---------- */
async function main() {
  fs.mkdirSync(TC, { recursive: true });
  console.log('工具链目录：' + TC + (CHECK_ONLY ? '（仅检查）' : ''));
  console.log('磁盘可用空间需约 3 GB（下载 + 解压 + 首次构建缓存）\n');

  /* 1. JDK */
  const javaExe = path.join(JDK_DIR, 'bin', 'java.exe');
  console.log('【1/4】Temurin JDK 17');
  if (fs.existsSync(javaExe)) {
    console.log('  已存在，跳过：' + javaExe);
  } else if (CHECK_ONLY) {
    console.log('  未安装');
  } else {
    const zipPath = path.join(TC, 'jdk.zip');
    if (!fs.existsSync(zipPath)) await download(JDK_URL, zipPath);
    else console.log('  已有安装包 ' + zipPath + '，直接解压');
    console.log('  解压中…');
    fs.mkdirSync(JDK_DIR, { recursive: true });
    const r = extractZipTo(zipPath, JDK_DIR);
    console.log('  解压 ' + r.files + ' 个文件');
    // zip 里通常有一层 jdk-17.x.x+x 目录，把它拍平
    const inner = fs.readdirSync(JDK_DIR).filter(n => n.startsWith('jdk-') && fs.statSync(path.join(JDK_DIR, n)).isDirectory());
    if (inner.length === 1 && !fs.existsSync(javaExe)) {
      const nested = path.join(JDK_DIR, inner[0]);
      for (const n of fs.readdirSync(nested)) fs.renameSync(path.join(nested, n), path.join(JDK_DIR, n));
      fs.rmdirSync(nested);
    }
    if (!fs.existsSync(javaExe)) throw new Error('解压后没找到 ' + javaExe);
    fs.unlinkSync(zipPath);
  }

  /* 2. Android cmdline-tools */
  console.log('\n【2/4】Android SDK 命令行工具');
  const sdkManager = path.join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
  if (fs.existsSync(sdkManager)) {
    console.log('  已存在，跳过：' + sdkManager);
  } else if (CHECK_ONLY) {
    console.log('  未安装');
  } else {
    const zipPath = path.join(TC, 'cmdline-tools.zip');
    if (!fs.existsSync(zipPath)) await download(CMDLINE_URL, zipPath);
    else console.log('  已有安装包 ' + zipPath + '，直接解压');
    console.log('  解压中…');
    const r = extractZipTo(zipPath, path.join(SDK_DIR, 'cmdline-tools', 'latest'));
    console.log('  解压 ' + r.files + ' 个文件');
    fs.unlinkSync(zipPath);
    if (!fs.existsSync(sdkManager)) throw new Error('解压后没找到 sdkmanager.bat');
  }

  /* 3. SDK 组件 */
  console.log('\n【3/4】SDK 组件（platform-tools / platforms;android-34 / build-tools;34.0.0）');
  const sentinel = path.join(SDK_DIR, 'build-tools', '34.0.0', 'aapt2.exe');
  if (fs.existsSync(sentinel)) {
    console.log('  已安装，跳过');
  } else if (CHECK_ONLY) {
    console.log('  未安装');
  } else {
    // 先写入许可接受记录，等价于运行 sdkmanager --licenses 并全部回答 y
    const licDir = path.join(SDK_DIR, 'licenses');
    fs.mkdirSync(licDir, { recursive: true });
    fs.writeFileSync(path.join(licDir, 'android-sdk-license'),
      '8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n');
    fs.writeFileSync(path.join(licDir, 'android-sdk-preview-license'),
      '84831b9409646a918e30573bab4c9c91346d8abd\n');
    console.log('  已写入 SDK 许可接受记录（等同于 sdkmanager --licenses 全选 y）');
    run(sdkManager, ['--sdk_root=' + SDK_DIR, '--channel=0',
      'platform-tools', 'platforms;android-34', 'build-tools;34.0.0'], jdkEnv(),
      'sdkmanager --sdk_root=... platform-tools platforms;android-34 build-tools;34.0.0');
    if (!fs.existsSync(sentinel)) throw new Error('SDK 组件安装后仍未找到 ' + sentinel);
  }

  /* 4. Gradle */
  console.log('\n【4/4】Gradle 8.7');
  const gradleBat = path.join(GRADLE_DIR, 'bin', 'gradle.bat');
  if (fs.existsSync(gradleBat)) {
    console.log('  已存在，跳过：' + gradleBat);
  } else if (CHECK_ONLY) {
    console.log('  未安装');
  } else {
    const zipPath = path.join(TC, 'gradle.zip');
    if (!fs.existsSync(zipPath)) await download(GRADLE_URL, zipPath);
    else console.log('  已有安装包 ' + zipPath + '，直接解压');
    console.log('  解压中…');
    const r = extractZipTo(zipPath, TC);
    console.log('  解压 ' + r.files + ' 个文件');
    fs.unlinkSync(zipPath);
    if (!fs.existsSync(gradleBat)) throw new Error('解压后没找到 gradle.bat');
  }

  /* 写 local.properties，告诉 Gradle 去哪找 SDK */
  if (!CHECK_ONLY && fs.existsSync(SDK_DIR)) {
    const lp = path.join(ROOT, 'local.properties');
    const want = 'sdk.dir=' + SDK_DIR.replace(/\\/g, '\\\\') + '\n';
    if (!fs.existsSync(lp) || fs.readFileSync(lp, 'utf8') !== want) {
      fs.writeFileSync(lp, want, 'utf8');
      console.log('\n已写入 local.properties：' + want.trim());
    }
  }

  console.log('\n' + (CHECK_ONLY ? '检查完毕' : '工具链就绪'));
  console.log('  JDK：   ' + (fs.existsSync(javaExe) ? JDK_DIR : '未安装'));
  console.log('  SDK：   ' + (fs.existsSync(sdkManager) ? SDK_DIR : '未安装'));
  console.log('  Gradle：' + (fs.existsSync(gradleBat) ? GRADLE_DIR : '未安装'));
  console.log('\n下一步：node build-apk.js        （或用 build-apk.cmd 双击运行）');
}

main().catch(e => {
  console.error('\n安装失败：' + e.message);
  console.error('可以直接重跑本脚本，已完成的步骤会自动跳过。');
  process.exit(1);
});
