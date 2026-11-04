# 第三方依賴與素材

[回 README](README.md) · [Windows 桌面版打包](docs/ELECTRON.md)

核對日期：2026-11-05；版本依據為儲存庫的 `package.json`、`package-lock.json`、已安裝套件資訊及 `index.html` 的 CDN 引用。

原始碼儲存庫不提交 `node_modules/`。**Windows 安裝檔會包含 Electron 執行環境（Chromium、Node.js）和應用程式所需正式依賴。** 開發與測試工具不作為應用程式正式依賴打包；Markdown 程式庫則由 CDN 載入。

## 直接依賴與素材

| 項目 | 版本 | 授權標示 | 著作權人／來源 | 用途 |
| --- | --- | --- | --- | --- |
| Electron | 45.2.1 | MIT；內含元件各有授權 | Electron contributors、GitHub Inc. | 桌面執行環境，隨安裝檔提供 |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | Anthropic PBC and contributors | MCP stdio server，正式依賴 |
| zod | 4.6.7 | MIT | Colin McDonnell and contributors | MCP 輸入驗證，正式依賴 |
| marked | 12.0.2 | MIT | Christopher Jeffrey | Markdown，從 cdnjs 載入 |
| DOMPurify | 3.1.6 | MPL-2.0 OR Apache-2.0 | Cure53 and contributors | Markdown HTML 清理，從 cdnjs 載入 |
| electron-builder | 26.18.0 | MIT | Loopline Systems and contributors | 安裝檔建置工具 |
| Playwright Core | 1.60.0 | Apache-2.0 | Microsoft Corporation | 開發測試工具 |
| TypeScript | 5.5.2 | Apache-2.0 | Microsoft Corporation | JavaScript 型別檢查工具 |
| Cork004 | 無版本編號 | CC0 1.0 | ambientCG | `assets/cork.jpg` 軟木主題貼圖；[素材來源](https://ambientcg.com/view?id=Cork004) |

## 隨附聲明與版本依據

- Electron 發行目錄隨附 `LICENSE.electron.txt` 與 `LICENSES.chromium.html`；後者涵蓋 Chromium 所使用的第三方元件，不應將全部內容一概視為 MIT。
- Node.js 與 Electron 內其他元件的授權，以其發行版隨附聲明為準；不要只依應用程式本身的 MIT 授權判斷。
- npm 直接依賴的固定版本見 [package.json](package.json)，完整解析版本與間接依賴見 [package-lock.json](package-lock.json)。授權全文以各套件隨附的 `LICENSE`／`NOTICE` 為準，本表是索引，不取代原文。
- marked 與 DOMPurify 使用固定 CDN URL 與 SRI。無法載入時會顯示純文字，並非已隨安裝檔內嵌。
- CaseGraph 自身的授權與著作權聲明見 [LICENSE](LICENSE)。
