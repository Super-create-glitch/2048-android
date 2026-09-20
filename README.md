# 2048 Android APK（WebView 外壳，零第三方依赖）

把 2048 打包成安卓安装包。游戏本体是纯静态网页，所以这里只是一个极简外壳：
全屏 WebView 加载内置在 `assets` 里的页面。**不依赖 Capacitor / Cordova / AndroidX**，
因此 APK 只有 1 MB 左右，首次构建需要下载的东西也少得多。

游戏页面不联网、不申请网络权限，装好后**飞行模式也能玩**。

## 目录结构

```
android/
├── app/
│   ├── build.gradle                    应用配置（包名、版本、minSdk=26、签名）
│   └── src/main/
│       ├── AndroidManifest.xml         只申请 VIBRATE 一项权限
│       ├── java/com/dsh/game2048/
│       │   └── MainActivity.java       WebView 外壳（本地存储、禁止网络、后台暂停）
│       ├── assets/www/                 内置的游戏网页（由 tools/sync-assets.js 同步）
│       └── res/                        主题、字符串、矢量启动图标
├── tools/
│   ├── setup-toolchain.js              下载安装 JDK + Android SDK + Gradle
│   ├── sync-assets.js                  把游戏网页同步进 assets（可切换来源）
│   ├── gen-icon.js                     生成矢量启动图标（含自适应图标与单色主题图标）
│   ├── check-resources.js              静态检查资源引用/类名/图标安全区（不需要 SDK）
│   ├── verify_apk.js                   APK 校验器（零依赖，不需要 Android SDK）
│   ├── axml.js                         Android 二进制清单解析器
│   ├── ziplib.js                       极简 ZIP 读写库（构建解压与 APK 校验共用）
│   └── test-ziplib.js                  ZIP 库自测
├── build-apk.js / build-apk.cmd        一键构建
├── setup-toolchain.cmd                 一键装工具链
└── .github/workflows/build-apk.yml     云端构建（不用本机装任何东西）
```

## 路线一：本机构建

```bash
node tools/setup-toolchain.js     # 首次：下载约 580 MB（JDK 182 + cmdline-tools 148 + Gradle 128 + SDK 组件 124）
node build-apk.js                 # 构建 release 并校验
```

Windows 上也可以直接双击 `setup-toolchain.cmd`、`build-apk.cmd`。

- 装到 `android/toolchain/`，**不改系统环境变量、不需要管理员权限**
- 首次 `build-apk.js` 还会由 Gradle 再下载约 200~350 MB 的 AGP 依赖
- 构建前建议关掉浏览器：Gradle 需要约 2 GB 内存

产物：`app/build/outputs/apk/release/app-release.apk`

## 路线二：GitHub 云端构建（本机零安装）

把本目录作为仓库根目录推上去，Actions 自动构建，在 Artifacts 里下载 APK。
细节见 `.github/workflows/build-apk.yml` 顶部的注释。

## 装到手机上

1. **数据线/微信/网盘传输**：把 APK 拷到手机，点开安装；若提示"未知来源"，在系统设置里允许该来源即可。
2. **adb 安装**（手机开启 USB 调试后，可以在电脑上一条命令装好，还能看日志确认运行正常）：

   ```bash
   toolchain\android-sdk\platform-tools\adb.exe install -r app\build\outputs\apk\release\app-release.apk
   ```

 装好后可以顺手确认它真的跑起来了：

   ```bash
   adb shell dumpsys window | findstr mCurrentFocus     # 应显示 com.dsh.game2048
   adb logcat -d | findstr /i "chromium AndroidRuntime" # 不应有崩溃堆栈
   ```

## 校验都查了什么

构建前（不需要 Android SDK，本机与 CI 都会跑）：

```bash
node tools/check-resources.js   # 15 处资源引用是否都有定义、XML 是否合法、
                                # 清单里的类能否找到 .java、图标图案是否落在自适应安全区内
node tools/test-ziplib.js       # ZIP 库自测（含篡改检测的反向用例）
```

构建后：

`node tools/verify_apk.js [apk]`（不传路径自动找最新的包）：

1. ZIP 结构：逐条解压并核对 CRC32，证明包完整未损坏
2. 必需条目：`AndroidManifest.xml`、`classes.dex`、`resources.arsc`、`assets/www/index.html`
3. `resources.arsc` 未压缩且 4 字节对齐（Android 11+ 的硬性要求）
4. APK 里的网页文件与同步来源**逐字节（SHA-256）一致**——确保打进包的正是验证过的版本
5. `classes.dex` 头合法、字符串表里确有 `MainActivity`
6. 签名：v1（META-INF 三件套）与 v2/v3（APK Signing Block，会解析出具体方案）
7. 解析二进制清单，核对包名 / versionCode / minSdk / targetSdk / 权限 / 启动入口

清单解析用的是自研的 `tools/axml.js`。**解析失败时会明确标注"未验证"，不会当成通过**；
本机构建时 `build-apk.js` 还会调用 aapt2 与 apksigner 交叉核对，确保解析结果与官方工具一致。

## 换一个游戏版本

`assets` 里的网页来自 `../2048-app`（本会话产出的 PWA 构建结果）。想换成别的实现：

```bash
node tools/sync-assets.js --from "D:\别的目录"            # 目录里要有 index.html
node tools/sync-assets.js --game "D:\某个\2048.html"      # 或者单个 HTML 文件
node build-apk.js --skip-sync                            # 复用当前 assets 直接打包
```

同步后 `build-apk.js` 会自动重新打包；`.asset-source.json` 会记录来源与每个文件的
SHA-256，校验时据此核对，所以"打进包的是不是指定那一版"是可验证的。

## 一些设计取舍

- **minSdk 26（Android 8.0）**：这样只需自适应图标（矢量），不必再塞 5 套 PNG，
  图标在任何分辨率下都清晰。Android 8.0 以下的设备已经很罕见。
- **不锁方向**：旋转屏幕时 Activity 不重建（`configChanges`），页面自己重排，
  正在进行的棋局不会因为转屏而丢失。
- **切后台即暂停 WebView**：音乐停止、定时器不再空转，省电。
- **不用 Capacitor**：本游戏不需要任何原生插件，套一层 Capacitor 只会让 APK 变大、
  依赖变多、版本冲突面变大。
- **release 包在没配置密钥时用 debug 证书签名**：保证第一次构建一定能装。
  想正式签名就照 `keystore.properties.example` 配置（注意：换签名后需要先卸载旧版本）。
