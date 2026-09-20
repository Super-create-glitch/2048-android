@echo off
rem 双击即可安装工具链（JDK + Android SDK + Gradle，约 580 MB）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node，请先安装 Node.js
  pause
  exit /b 1
)
node tools\setup-toolchain.js %*
echo.
pause
