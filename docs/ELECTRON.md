# Windows 桌面版與打包

[回 README](../README.md) · [備份與搬移](MIGRATION.md) · [第三方依賴](../THIRD_PARTY_NOTICES.md)

目前發布版本為 [v0.1.0](https://github.com/xiangerwu/detective-wall/releases/tag/v0.1.0)。本文依 2026-11-05 的 `package.json`、`electron/` 與打包測試整理。

## 安裝與日常操作

下載 `CaseGraph-Setup-0.1.0.exe`，依精靈選擇位置並安裝。NSIS 使用目前使用者安裝，建立開始功能表與桌面捷徑；內含 Electron 執行環境，不需另外安裝 Node.js 或瀏覽器。AI 功能仍需自行安裝並登入 Claude Code 或 Codex CLI。

- 關閉視窗會隱藏到系統匣；完整退出請選系統匣「結束」。再次啟動會顯示既有實例。
- 由左側齒輪選單「啟動器設定」或系統匣「設定…」修改埠、專案資料夾與 AI 工作資料夾，查看紀錄或開啟 CLI。
- 設定埠範圍為 1024–65535，預設 3000。埠被占用時可選「改用空閒埠（本次）」；不會結束占用埠的其他程式，也不會把臨時埠寫成偏好。
- 套用埠或專案變更會重啟本機服務；已開啟的外部 CLI 需關閉再從設定重開。
- 系統匣也提供啟動、停止、重新啟動服務，以及開啟紀錄資料夾。

v0.1.0 未簽章，Windows SmartScreen 可能警告；沒有自動更新。請從專案 Release 下載新版，先備份並完整退出，再手動安裝。升級與換電腦見 [搬移說明](MIGRATION.md)。

## 三種資料夾的用途

| 設定 | 用途 |
| --- | --- |
| 專案資料夾 | 放置 `wall.db`；決定目前的牆、圖片、備份、提案與聊天紀錄 |
| AI 工作資料夾 | 每專案設定的 CLI 工作目錄；未指定時使用專案內的 `chat-workdir/` |
| 牆面「資料夾」面板 | 設定 MCP `list_files`／`read_file` 可以讀取的材料範圍 |

設定 AI 工作目錄不會自動新增 MCP 授權。外部終端 CLI 的其他工具權限仍由該客戶端控制。

## 資料與紀錄位置

可寫資料位於 `app.getPath('userData')/CaseGraph/`，不寫入安裝資料夾或 `app.asar`：

| 相對位置 | 內容 |
| --- | --- |
| `settings.json` | 埠、目前專案、最多 10 個最近專案及各專案 AI 工作資料夾 |
| `projects/default/wall.db` | 預設專案資料庫；選用其他專案時改用該資料夾的 `wall.db` |
| `logs/main.log` | 主行程與服務啟停紀錄；設定頁顯示最近內容 |
| `runtime/` | 開啟 CLI 產生的 `claude-mcp.json` 與 `open-<client>.ps1` |

Windows 的 `userData` 根目錄：安裝版為 `%APPDATA%\CaseGraph`，原始碼 `npm run app` 為 `%APPDATA%\detective-wall`。因此安裝版預設資料庫完整路徑有兩層 `CaseGraph`：`%APPDATA%\CaseGraph\CaseGraph\projects\default\wall.db`。

桌面主行程從設定選擇專案，不使用 `WALL_DB` 覆蓋；瀏覽器版的 `data/wall.db` 不會自動遷移。測試可用 `CASEGRAPH_USER_DATA` 指定隔離目錄、`WALL_PORT=0` 要求空閒埠。

## 執行架構與 CLI

Electron 主行程透過 `createWallServer` 啟動本機服務，單一視窗載入 `http://127.0.0.1:<實際埠>/`。目前鎖定 Electron 45.2.1，使用內建 Node.js 24 與 `node:sqlite`。

聊天與「開啟 CLI」呼叫外部 `claude`／`codex`，可用 `WALL_CLAUDE_BIN`／`WALL_CODEX_BIN` 指定位置。MCP helper 使用桌面程式自己的執行檔搭配 `ELECTRON_RUN_AS_NODE=1` 執行 `server/mcp.js`，打包後從 `app.asar` 讀取。

在 Electron 中執行 CLI 的 Node 入口時會預載 `server/hidden-console.js`，避免內建對話的子行程跳出主控台；使用者按「開啟 CLI」則會開啟互動終端機。

## 開發、打包與檢查

在 Windows 專案根目錄執行，開發環境需 Node.js 24 以上：

```sh
npm ci
npm run app
```

關閉開發版後，可執行檢查與打包：

```sh
npm run typecheck
npm test -- cli-launch electron launcher-ui
npm run dist
npm test -- electron-packaged
```

瀏覽器測試需先執行 `npx playwright-core install firefox`。完整測試入口是 `npm test`，結果與紀錄位於 `test-results/`；測試使用暫存資料庫和空閒埠。

- `npm run dist` 使用 electron-builder 26.18.0，產生 `dist/CaseGraph-Setup-<版本>.exe` 與 `dist/win-unpacked/`。
- `electron-packaged` 檢查 `dist/win-unpacked` 的內建 SQLite、牆面、MCP 與可寫資料位置；未先打包會 `SKIP`，不算驗證成功。
- 打包測試不等於安裝精靈或真實登入 CLI 的乾淨 Windows 驗證。
- `app.asar` 放入 `electron/`、`server/`、`index.html`、`assets/`、套件資訊及正式依賴，不包含使用者 `data/`、`tests/` 或 `test-results/`。
- `build.appId` 與 `app.setAppUserModelId` 必須同為 `tw.casegraph.app`，Windows 才能對應捷徑與工作列圖示。原始碼執行可能顯示 Electron 圖示，打包後才使用 CaseGraph 圖示。

目前 `dist` 命令只設定 Windows；macOS／Linux 桌面安裝包尚未提供。

## 既有容量紀錄

以下為原有 0.1.0 打包紀錄（2026-11-04），本次文件整理未重新打包測量；重建後容量可能不同。

| 項目 | 大小 |
| --- | --- |
| `CaseGraph-Setup-0.1.0.exe` | 122.4 MB |
| `win-unpacked` | 375.4 MB |
| `app.asar` | 18.6 MB |
| `app.asar` 內正式執行套件 | 12.7 MB |

版本與檔案選擇以 [package.json](../package.json)／[package-lock.json](../package-lock.json) 為準；第三方聲明見 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。
