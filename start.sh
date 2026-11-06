#!/usr/bin/env sh
# Browser mode for macOS/Linux: build the Rust service and MCP, then open the browser.
set -e
cd "$(dirname "$0")"

command -v cargo >/dev/null 2>&1 || { echo "找不到 Rust／Cargo，請先安裝 Rust 工具鏈：https://rustup.rs/"; exit 1; }
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin casegraph-server --bin casegraph-mcp

URL="http://127.0.0.1:${WALL_PORT:-3000}/"
# Open the page once the service has had a moment to start.
( sleep 2
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &
echo "CaseGraph 案件圖譜啟動中：$URL ，按 Ctrl+C 停止。"
exec ./src-tauri/target/debug/casegraph-server
