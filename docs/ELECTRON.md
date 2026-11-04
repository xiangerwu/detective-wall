# Electron 桌面版

CaseGraph 的 Windows 桌面版是 Electron 45.2.1，內建 Node.js 24，不需要另外安裝 Node.js。服務在主行程以 `createWallServer` 執行，單一視窗載入 `http://127.0.0.1:<埠>/` 的牆面。

## 開發與打包

- `npm run app`：從原始碼開啟桌面版。
- `npm run dist`：用 electron-builder 26.18.0 產生 `dist/CaseGraph-Setup-<版本>.exe`（NSIS、目前使用者安裝、可自選資料夾）與未封裝的 `dist/win-unpacked/`。
- `node tests/run.cjs electron-packaged`：對 `dist/win-unpacked` 做 smoke test；沒有先打包時會略過。

`build.appId`（`tw.casegraph.app`）必須和 `electron/main.js` 的 `app.setAppUserModelId` 相同：安裝檔建立的捷徑帶著這個 ID，Windows 用它對應工作列圖示。從原始碼執行時，工作列顯示的是 electron.exe 的圖示，打包後才是 CaseGraph 的圖示。

## 資料位置

所有可寫資料都在 `app.getPath('userData')` 底下的 `CaseGraph/`，不寫進安裝資料夾或 `app.asar`：

- `settings.json`：服務埠、目前專案、最近專案與各專案的 AI 工作資料夾。
- `projects/default/wall.db`：預設專案。每個專案資料夾放一個 `wall.db`，以及它的 WAL／SHM 與 `chat-workdir`。
- `logs/main.log`：主行程紀錄。
- `runtime/`：開啟 CLI 時產生的 `claude-mcp.json` 與 `open-<client>.ps1`。

`userData` 的根目錄：
- 安裝版：`%APPDATA%\CaseGraph`；
- 從原始碼執行：`%APPDATA%\detective-wall`。

測試可以用 `CASEGRAPH_USER_DATA` 指定暫存目錄，用 `WALL_PORT=0` 要求空閒埠。

## CLI 與 MCP

聊天與「開啟 CLI」都會使用外部的 `claude`／`codex` CLI，使用者必須自行安裝並登入；也可以用 `WALL_CLAUDE_BIN`／`WALL_CODEX_BIN` 指定路徑。

MCP 服務以桌面版自己的執行檔加上 `ELECTRON_RUN_AS_NODE=1` 執行 `server/mcp.js`，打包後直接從 `app.asar` 讀取。在 Electron 裡執行 CLI 的 Node 入口時（例如 `codex.js`），會用 `-r server/hidden-console.js` 預載，讓它啟動的主控台程式不跳出終端機視窗。

## 實測大小（0.1.0，2026-11-04）

| 項目 | 大小 |
|---|---|
| 安裝檔 `CaseGraph-Setup-0.1.0.exe` | 122.4 MB |
| 安裝後（`win-unpacked`） | 375.4 MB |
| `app.asar` | 18.6 MB |
| `app.asar` 內的正式執行套件 | 12.7 MB |

`app.asar` 不含 `data/`、`tests/` 或 `test-results/`。

## 簽章與更新

第一版不簽章，也不做自動更新，公開發佈前再決定。

- [Electron application distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
