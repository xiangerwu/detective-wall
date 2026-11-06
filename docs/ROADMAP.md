# 發布現況與後續方向

[回 README](../README.md) · [功能與限制](FEATURES.md) · [Tauri／Rust 桌面版](TAURI.md)

更新日期：2026-11-06。CaseGraph **v0.2.0** 改用 Tauri 2 與 Rust，安裝檔見 [GitHub Release](https://github.com/xiangerwu/detective-wall/releases/tag/v0.2.0)。Electron／Node 後端與專用測試已移除，舊版保留於 `v0.1.0` tag／release。

## 已提供

- Windows 桌面：Tauri 視窗、Rust 本機服務與 MCP、系統匣、單一實例、專案切換、AI 工作資料夾、CLI 啟動、紀錄與 NSIS 安裝檔。
- 白板：卡片、圖片、疑問便利貼、連線、分層、錨點、標籤、多牆、搜尋、框選、批次操作與版面整理。
- AI：Claude Code／Codex CLI 對話、MCP 讀牆與授權讀檔、待審提案、逐項套用、衝突檢查與回復。
- 保存：SQLite、自動保存、內部備份、單牆／專案 JSON、JSON Canvas 匯入匯出；沿用既有資料格式。
- 外觀：六種背景、兩種卡片風格、浮動新增泡泡與齒輪選單、AI 案件夾、桌寵與減少動畫。

## 後續方向與驗證缺口

以下沒有承諾時程，也不代表已授權開發。

| 方向 | 現況與待處理事項 |
| --- | --- |
| Windows 安裝與效能 | 已提供 NSIS 安裝包；乾淨 Windows 的完整安裝、升級、解除安裝矩陣及同條件 RAM／啟動速度量測尚未完成。 |
| 真實 AI 客戶端 | 自動化使用 fake CLI，真實登入狀態、CLI 版本、訂閱情境須依實際使用核對；引用與模型回答品質由使用者判斷。 |
| 自訂關係 | 目前三種固定類型；新增自訂功能需同步處理匯入、匯出與 MCP。 |
| JSON Canvas 互通 | 正式跨工具往返驗證、私有欄位文字優先順序與降級限制仍待處理。 |
| 簽章與自動更新 | 安裝檔未簽章，使用手動下載安裝；後續方案未決定。 |
| macOS／Linux 桌面包 | 目前只提供 Windows 打包設定；其他平台的桌面包尚未交付。 |
| 跨電腦服務 | 目前服務僅綁本機，沒有帳號或遠端同步。 |

## 驗證入口

`npm test` 執行 Rust 單元、HTTP／MCP／fake CLI 整合及瀏覽器測試，全部使用 Rust 後端。`npm run typecheck` 檢查 Rust targets 和共用 JavaScript。`npm run dist` 後執行 `npm run test:desktop`，測試實際 Tauri release EXE；這不等於安裝精靈或真實 AI 服務驗收。

測試檔存在不代表目前全數通過，請依該次執行輸出與 `test-results/` 紀錄判讀。詳細步驟見 [TAURI.md](TAURI.md)，操作與支援範圍見 [README](../README.md) 和 [FEATURES](FEATURES.md)。
