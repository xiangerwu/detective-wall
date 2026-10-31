#!/usr/bin/env sh
# Quick start for macOS/Linux: check Node, install packages once, start the service, open the browser.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "找不到 Node.js，請先安裝 Node.js 24 以上：https://nodejs.org/"; exit 1; }
node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" || { echo "需要 Node.js 24 以上，目前版本：$(node -v)"; exit 1; }

if [ ! -d node_modules ]; then
  echo "第一次執行，正在安裝套件……"
  npm ci
fi

URL="http://127.0.0.1:${WALL_PORT:-3000}/"
# Open the page once the service has had a moment to start.
( sleep 2
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &
echo "CaseGraph 案件圖譜啟動中：$URL ，按 Ctrl+C 停止。"
exec node server/server.js
