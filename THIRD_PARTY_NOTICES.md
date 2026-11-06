# 第三方依賴與素材

[回 README](README.md) · [Tauri／Rust 打包](docs/TAURI.md)

核對日期：2026-11-06；版本依據為儲存庫的 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、已安裝套件資訊及 `index.html` 的 CDN 引用。

原始碼儲存庫不提交 `node_modules/` 或 Rust 建置產物。**v0.2.0 使用 Tauri／Rust 與系統 WebView2，不附帶 Electron 或 Node.js。** 外部 AI CLI 仍可能需要自己的 Node.js 環境。開發與測試工具不作為應用程式正式依賴打包；Markdown 程式庫則由 CDN 載入。

## npm 直接依賴與前端素材

| 項目 | 版本 | 授權標示 | 著作權人／來源 | 用途 |
| --- | --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | Anthropic PBC and contributors | 開發／測試用 MCP 客戶端；正式 MCP 服務使用 Rust rmcp |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT | Tauri Programme within The Commons Conservancy | 桌面開發與安裝檔建置工具 |
| marked | 12.0.2 | MIT | Christopher Jeffrey | Markdown，從 cdnjs 載入 |
| DOMPurify | 3.1.6 | MPL-2.0 OR Apache-2.0 | Cure53 and contributors | Markdown HTML 清理，從 cdnjs 載入 |
| Playwright Core | 1.60.0 | Apache-2.0 | Microsoft Corporation | 開發測試工具 |
| TypeScript | 5.5.2 | Apache-2.0 | Microsoft Corporation | JavaScript 型別檢查工具 |
| Cork004 | 無版本編號 | CC0 1.0 | ambientCG | `assets/cork.jpg` 軟木主題貼圖；[素材來源](https://ambientcg.com/view?id=Cork004) |

## 隨附聲明與版本依據

Rust 正式執行元件包含 Tauri 與其官方插件、Tokio、Axum、Serde、rusqlite、rmcp 等套件；完整解析版本見 [Cargo.lock](src-tauri/Cargo.lock)，直接依賴與功能見 [Cargo.toml](src-tauri/Cargo.toml)。各元件的授權以下載套件中的 `LICENSE`／`NOTICE` 為準。`rusqlite` 啟用 bundled SQLite；WebView2 由系統提供，缺少時由安裝精靈下載其安裝程式。

- 舊 v0.1.0 Electron 安裝檔仍適用該版本隨附的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 與其他元件聲明；目前原始碼不再使用 Electron／electron-builder 作為依賴。
- npm 直接依賴的固定版本見 [package.json](package.json)，完整解析版本與間接依賴見 [package-lock.json](package-lock.json)。授權全文以各套件隨附的 `LICENSE`／`NOTICE` 為準，本表是索引，不取代原文。
- marked 與 DOMPurify 使用固定 CDN URL 與 SRI。無法載入時會顯示純文字，並非已隨安裝檔內嵌。
- CaseGraph 自身的授權與著作權聲明見 [LICENSE](LICENSE)。
