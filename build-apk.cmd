@echo off
rem 双击即可构建（默认 release）。等价于：node build-apk.js %*
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node，请先安装 Node.js
  pause
  exit /b 1
)
node build-apk.js %*
echo.
pause
