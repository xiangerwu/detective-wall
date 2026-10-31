@echo off
rem Quick start for Windows: check Node, install packages once, start the service, open the browser.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo 找不到 Node.js，請先安裝 Node.js 24 以上：https://nodejs.org/ & pause & exit /b 1)
node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" || (echo 需要 Node.js 24 以上，目前版本： & node -v & pause & exit /b 1)

if not exist node_modules (
  echo 第一次執行，正在安裝套件……
  call npm ci || (pause & exit /b 1)
)

if not defined WALL_PORT set WALL_PORT=3000
rem Open the page once the service has had a moment to start.
start "" /b powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%WALL_PORT%/'"
echo CaseGraph 案件圖譜啟動中：http://127.0.0.1:%WALL_PORT%/ ，關閉這個視窗或按 Ctrl+C 停止。
node server/server.js
pause
