# Electron 相容性評估

評估日期：2026-11-02。這份文件只評估嵌入方向，不安裝 Electron，也不新增 Electron 啟動器。

## 結論

截至評估日，Electron stable 是 45.2.1，內建 Node.js 24.22.1。Node 的 `node:sqlite`／`DatabaseSync` 自 v22.5.0 提供；`database.setAuthorizer()` 自 v24.10.0 提供，因此這個 Electron stable 版本具備本專案未來可能需要的兩個 API。Node 文件仍將 SQLite 標為 release candidate，是否採用 `setAuthorizer` 仍應由日後的嵌入需求決定。

- [Electron stable releases](https://releases.electronjs.org/?channel=stable)
- [Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)

## 主行程嵌入方式

目前 `server/server.js` 已輸出可程式化使用的 `createWallServer`，支援 `port: 0`，並將靜態檔案基準固定在伺服器檔案位置，不依賴 `process.cwd()`。日後主行程可採用下列模式：

```js
const path = require('node:path');
const { app } = require('electron');
const { createWallServer } = require('./server/server.js');

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'casegraph', 'wall.db');
  const server = createWallServer({dbPath, port: 0});
  server.once('listening', () => {
    const {port} = server.address();
    // BrowserWindow 載入 http://127.0.0.1:${port}/
  });
});
```

`createDatabase` 會建立資料庫父目錄；資料庫、SQLite WAL/SHM 與聊天工作目錄都應留在 `userData`，不要寫入唯讀的 ASAR。現有程式也接受 `WALL_DB`，所以另一種做法是在建立服務前設定絕對路徑的 `process.env.WALL_DB`。

靜態檔案仍需在打包時把專案根目錄與 `server/` 放進應用程式內容；Electron 的 ASAR 可由 Node 檔案 API 讀取，但打包工具的檔案清單仍須包含 `index.html`、`server/layout.js` 與既有素材。

## E1 開發執行方式

在專案根目錄執行 `npm run app`。Electron 的 `app.getPath('userData')` 是本機使用者資料根目錄；E1 會在其下使用 `CaseGraph/settings.json`、`CaseGraph/projects/default/wall.db` 與 `CaseGraph/logs/main.log`。測試可用 `CASEGRAPH_USER_DATA` 指定暫存 userData，並用 `WALL_PORT=0` 要求本次啟動使用空閒埠。

## 聊天 CLI

聊天功能不是 Electron 內建模型：服務會啟動外部 `claude` 或 `codex` CLI。打包後必須確認使用者已安裝並登入 CLI，或由 `WALL_CLAUDE_BIN`／`WALL_CODEX_BIN` 提供絕對路徑；僅把 CaseGraph 打包成桌面程式不會自動帶入 CLI、登入狀態或訂閱額度。若產品要免 CLI 執行，需另行決定模型整合方式，本次不實作。

## 打包大小與簽章

Electron 發行物會攜帶平台專用的 Chromium、Node.js 與應用程式內容，實際大小取決於平台、素材、依賴與是否使用 ASAR；本次未安裝 Electron，因此沒有可報告的實測大小。應在選定 Electron Forge 或其他打包流程後，對 Windows、macOS、Linux 分別量測安裝檔與解壓後大小。

正式發行應簽章：Windows 的安裝程式／發行物需要 Windows 程式碼簽章，macOS 需要程式碼簽章並進一步 notarize。憑證、CI 簽章方式與自動更新尚未決定，留待桌面產品方案確認後處理。

- [Electron application distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

## P16-2 範圍

本次已完成伺服器預設路徑不依賴目前工作目錄，以及 `createWallServer({dbPath, port: 0})` 所需的基礎；沒有加入 Electron 依賴、主行程檔案、BrowserWindow、打包設定或 CLI 安裝流程。
