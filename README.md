# CaseGraph 案件圖譜

**繁體中文** | [English](README.en.md)

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF) ![Firefox first](https://img.shields.io/badge/browser-Firefox%20first-FF7139?logo=firefoxbrowser&logoColor=white) ![Tests](https://img.shields.io/badge/tests-42%20suites-2EA44F) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

<p align="center">
  <img src="assets/icon/icon-256.png" alt="CaseGraph 案件圖譜圖示" width="128">
</p>

CaseGraph 是一款個人研究用的關係白板，讓你用卡片記錄資料、用疑問便利貼標記待查事項，再用連線串起線索。所有資料儲存在本機 SQLite 資料庫。

你可以自行整理，也可以讓 Claude Code 或 Codex 讀取牆面與你授權的資料夾，協助分析並提出修改。**AI 提案需經你確認才會套用，套用後也能復原。**

## 安裝

### 環境需求

- **Node.js 24**（開發與測試使用 v24.11.1）。
- **Firefox**：主要驗證的瀏覽器。
- **AI CLI（選用）**：要使用 AI 功能，需至少安裝並登入 [Claude Code](https://claude.com/claude-code) 或 Codex CLI 其中一個。測試版本為 Claude Code 2.1.314、codex-cli 0.153.4；較舊版本可能不支援本專案使用的旗標。

### 啟動方式

- **Windows**：雙擊 `start.cmd` 開啟 CaseGraph 啟動器。它會檢查 Node.js 版本、首次啟動時在背景安裝套件，接著啟動服務並開啟瀏覽器。
- **macOS／Linux**：執行 `./start.sh`。

也可以在專案目錄手動執行：

```sh
npm install
npm start
```

看到 `WALL_READY 3000` 後，用 Firefox 開啟 [CaseGraph 本機頁面](http://127.0.0.1:3000/)。第一次啟動會建立 `data/wall.db`，並放入 7 張示例卡片；之後啟動會沿用既有資料。服務只監聽本機位址 `127.0.0.1`。

### Windows 啟動器

- 關閉視窗會縮到系統匣。右鍵點擊系統匣圖示，可顯示視窗、開啟網頁／CLI／紀錄、停止服務或結束啟動器。
- 啟動器只會停止自己啟動的服務；偵測到外部服務時，重啟或停止前會先確認。
- 視窗底部可將啟動器加入開始功能表，不會建立桌面捷徑。
- 服務紀錄與啟動器執行期檔案位於 `data/launcher/`；資料庫位於 `data/wall.db`。

## 基本操作

### 卡片與連線

- **新增與編輯**：雙擊畫布空白處新增卡片，點擊卡片編輯標題、Markdown 筆記、標籤與來源。拖曳可移動卡片，也可自由調整寬高。
- **編輯視窗**：拖曳標題列移動，拖曳右下角把手調整寬高，按右上角關閉按鈕或 Esc 關閉。視窗會記住位置與尺寸；內容可獨立捲動，視窗外的畫布仍可操作。
- **卡片標籤**：在編輯器中選用現有標籤或建立新標籤，按標籤旁的 × 移除。
- **來源**：每行一筆，格式為 `名稱 | 路徑或網址 | 位置 | 摘錄`，後兩欄可省略。找不到的本機檔案會在卡片上標紅。
- **建立連線**：從卡片的紅色圖釘拖到另一張卡片。可選「建立在其上」、「使用技術」或「待驗證疑問」三種類型；點擊連線可修改類型、文字或刪除，端點可自動定位或手動調整。

### 畫布與版面

- **瀏覽畫布**：拖曳空白處平移，滾輪縮放，按「全覽」讓整面牆顯示在畫面中。
- **框選與批次操作**：在空白處按住 Shift 並以左鍵拖曳框選；拖曳已選卡片可整組移動，也可複製貼上或確認刪除。整批操作可一次復原。右鍵保留給瀏覽器與滑鼠手勢套件。
- **整理版面**：上方「整理版面」提供推開重疊、對齊格線、全部重排三種模式；重排可依連線形成放射狀線索網。有選取卡片時只整理選取範圍，其餘卡片固定不動；未選取時整理整面牆。操作可用 Ctrl+Z 復原，分層線不會跟著卡片移動。
- **分層與錨點**：分層提供畫布內清單與快捷鍵；錨點分為源頭／重點，可透過清單篩選與跳轉。

### 牆面與側邊面板

- **多面牆**：透過上方分頁切換，雙擊改名、右鍵換色或刪除、拖曳排序。
- **搜尋**：「搜尋所有牆」可查找標題、筆記、標籤與連線文字，點擊結果會跳到對應卡片。
- **面板配置**：最左側活動列可切換檔案、版本、範本、資料夾、標籤、外觀與說明。左面板和右側欄各有拖曳把手；右側集中顯示 AI 對話與 AI 提案，提案旁會標示待審數量。
- **標籤管理**：在左側「標籤」面板新增標籤、點名稱改名、用色筆換色，或點圓點篩選。刪除需按兩次，會移除所有卡片上的該標籤；這些變更均可復原。
- **資料夾授權**：在左側「資料夾」面板按「瀏覽…」選取資料夾，或輸入絕對路徑後按「新增」／Enter。新增與移除會立即保存；非絕對路徑或重複路徑會顯示提示。資料夾選擇視窗在 Windows 使用 PowerShell、macOS 使用 `osascript`；Linux 需安裝 `zenity` 或 `kdialog`。

### 外觀與保存

- **主題與卡片風格**：「外觀」面板提供六種背景，以及「科技／擬真便利貼」兩種全域卡片風格。主題同步套用到頂列、側欄、編輯器、對話框、按鈕與輸入框。
- **紙張與裝飾**：擬真風格依卡片顏色使用淡色紙張，搭配陰影、紙紋與翻角；線索卡保留圖釘，疑問便利貼使用膠帶與紙角，每張卡也可選大頭釘或膠帶。圖片卡呈現固定角度的拍立得照片，AI 桌寵會隨狀態變化。
- **復原與重做**：Ctrl+Z 復原、Ctrl+Y 重做，最多 100 步。
- **自動保存**：上方顯示「已保存 HH:MM」。服務斷線或同一面牆在其他分頁被修改時，會提示重試或選擇保留的版本。

## 讓 AI 幫忙整理

AI 先提出修改，再由你在審核面板逐項勾選套用。未套用的提案不會改變牆面，每次套用也都能回復。

### 首次使用

1. 右側「AI 提案」勾選 **允許 AI 提出修改**。預設關閉；關閉時 AI 只能讀牆。
2. 若要 AI 讀取程式碼或文件，在左側「資料夾」面板加入要授權的資料夾。
3. 在左側活動列開啟「範本」，選一個起手範本：
   - 分析程式碼
   - 規劃論文
   - 整理推理線索
   - 設計遊戲支線

   範本會建立同名新牆與對應標籤，不會建立分層，並將提示詞填入右側「AI 對話」。提示詞要求中心卡、3～6 條主線、每條 2～5 張線索、跨主線連線及簡短卡片內容，位置由系統安排。若要撤銷這次起手，可從分頁選單刪除新牆。
4. **補充材料並送出**：貼上大綱、筆記或案情；分析程式碼時，說明要讀哪個授權資料夾。選擇 Claude Code 或 Codex 後送出。執行中會顯示耗時與工具進度，按「停止」可終止這次對話並保留停止狀態。
5. **審核提案**：有提案時，在右側「AI 提案」按「檢視」。審核面板依新增卡片與分層、修改、連線、刪除分組，可展開 Markdown、來源與修改差異。勾選要保留的項目後按「套用所選」；刪除項目預設不勾選，畫布上的虛影僅供預覽。
6. **回復套用**：若結果不符合預期，在左側「版本」面板按「回復這次套用」。

自訂範本可新增、編輯與刪除。內建範本不能刪除，但可複製後修改。

### 日常對話

在右側「AI 對話」直接問，例如「這面牆有哪些和方法 B 有關的卡片？」或「幫我提議一張卡記下這個疑問，連到應用示例 A」。

- 每面牆有自己的對話，AI 記得之前聊過的內容。按「開新對話」可以從頭開始。
- 對話越長，每則訊息耗的額度越多。
- 使用的是你 CLI 的登入狀態與訂閱額度，不需要 API 金鑰。
- Claude Code 要先登入：在終端機執行 `claude`，輸入 `/login`。
- 找不到或沒登入的 CLI，會在頁面上顯示為無法使用，或回報錯誤原因。

### 用其他 AI 客戶端（選用）

任何支援 MCP 的客戶端（例如另開一個 Claude Code session）都能連上案件圖譜：

```json
{
  "mcpServers": {
    "detective-wall": {
      "command": "node",
      "args": ["<專案絕對路徑>/server/mcp.js"],
      "env": {
        "WALL_DB": "<專案絕對路徑>/data/wall.db",
        "WALL_PORT": "3000"
      }
    }
  }
}
```

`WALL_DB` 必須指向你實際要使用的 SQLite 資料庫檔案絕對路徑；上例的路徑只是範例，請勿直接照抄。

工具有九個：

- 讀牆：`list_boards`、`get_board`、`get_cards`、`search_cards`、`get_relations`
- 讀授權資料夾：`list_files`、`read_file`
- 提案：`propose_changes`、`get_change_status`

只有 `propose_changes` 會寫入，而且只寫待審提案。有些客戶端（例如 codex）預設會擋需要核准的工具；要讓它送提案，需允許該工具或開啟自動核准。

## 資料與備份

- 資料預設在 `data/wall.db`，可用 `WALL_DB` 改位置。這個檔案就是你的全部資料，複製它就是完整備份。
- 左側活動列的「檔案」面板中，「匯出整個專案」把所有牆、圖片與設定存成一個 `.json`；「還原整個專案」一次還原。單面牆可用「匯出 JSON」／「匯入 JSON」，匯入前會先顯示差異。
- 每面牆自動保留最多 20 份備份，在左側活動列的「版本」面板查看與還原。
- 標籤定義、顏色與卡片上的標籤關聯都會隨牆保存；刪除標籤會一次移除所有卡片上的關聯，並可復原。
- AI 提案、AI 紀錄、AI 對話紀錄是服務內部資料，不包含在專案匯出檔。
- 從舊版本匯出的資料搬到新位置，見 [搬移說明](docs/MIGRATION.md)。

## 設定

| 環境變數 | 用途 | 預設 |
|---|---|---|
| `WALL_DB` | SQLite 資料庫檔 | `data/wall.db` |
| `WALL_PORT` | 網頁服務的埠 | `3000` |
| `WALL_MCP_WALLS` | 只讓外部 MCP 客戶端看到這些牆（逗號分隔牆 ID） | 全部 |
| `WALL_CLAUDE_BIN` | Claude Code 執行檔路徑 | 從 PATH 找 |
| `WALL_CODEX_BIN` | codex 執行檔路徑 | 從 PATH 找 |
| `WALL_PICK_FOLDER_BIN` | 覆寫原生資料夾選擇器（測試用） | 依平台選擇 |

PowerShell 的設定方式：

```powershell
$env:WALL_DB='D:/my-research/wall.db'; npm start
```

macOS／Linux：

```sh
WALL_DB=/path/to/my-research/wall.db npm start
```

## 安全與限制

- 服務只綁 127.0.0.1，並拒絕其他網站送來的請求。
- AI 只能透過案件圖譜工具讀取**目前這面牆**和**你授權的資料夾**，不能執行 shell、不能用 CLI 自己的讀檔或上網工具。
- 授權資料夾的限制：
  - 不能用 `..` 或符號連結跳出授權範圍，也不讀網路共用路徑。
  - 只讀文字檔，單檔上限 1 MiB。
  - 固定排除目錄 `.ssh`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker`、`.password-store`、`gcloud`（包含 `.config/gcloud`）、`.terraform.d`、`.git`、`node_modules`、`.config/gh`。
  - 固定排除檔名 `.env*`、`.netrc`、`_netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.htpasswd`、`credentials`、`credentials.json`；SSH 金鑰 `id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`、`id_ecdsa_sk`、`id_ed25519_sk`、其 `.pub` 與底線延伸的備份名稱。
  - 固定排除副檔名 `*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`、`*.ppk`、`*.kdbx`、`*.gpg`、`*.pgp`、`*.asc`、`*.crt`、`*.cer`、`*.der`；名稱含 `secret` 或 `token` 的 `.json`／`.yaml`／`.yml`／`.toml`；`*.tfstate*`；資料庫及其 `*.db`、`*.sqlite*`、`*-wal`、`*-shm` 檔。
  - 檔名前 64 KiB 含 `-----BEGIN` 且含 `PRIVATE KEY` 的檔案也拒絕讀取。
  - 檔案和卡片裡寫的「指示」只當資料，不能改變權限。
- AI 只能提出修改。套用前會檢查目標有沒有被你改過；改過的項目標成衝突，不會覆蓋你的修改。
- 信任模型：服務只聽本機；同一台電腦上的其他程式視為可信。外部 MCP 客戶端預設可讀所有牆；可用 `WALL_MCP_WALLS='w-main,w-other' npm start` 限定牆的範圍。
- codex 為了能送出提案，必須用自動核准模式執行。shell 已關閉，但仍屬 workspace-write 核准模式，這是剩下的風險。
- AI 回答的正確性（引用是否正確、有沒有把推論說成事實）沒有自動檢查，請自行判斷。

## 故障排查

- **畫面顯示「本機服務無法連線」**：確認 `npm start` 的終端機還開著。重新啟動後按「重試」。
- **AI 對話回報 `OAuth session expired` 或驗證失敗**：CLI 的登入過期了。執行 `claude`，再輸入 `/login`；codex 則照 codex 的登入方式重新登入。
- **AI 說提案被拒絕**：先確認「允許 AI 提出修改」有勾選。
- **`MCP database not found`**：先 `npm start` 一次建立資料庫，或把 `WALL_DB` 指向已存在的檔案。
- **`wall not in authorized scope`**：檢查 `WALL_MCP_WALLS`。不存在的牆也會回這個訊息，這是刻意的。
- **啟動時顯示埠已被占用**：改用其他埠，例如 `WALL_PORT=3001 npm start`；瀏覽器可用 `http://localhost:3001/` 或 `http://127.0.0.1:3001/`。
- **localhost／127.0.0.1 混用**：兩者都只代表本機，請確認網址的埠和 `WALL_PORT` 一致。
- **改了程式或升級後功能沒出現**：重啟 `npm start`，瀏覽器重新整理。

## 開發與測試

```sh
npm install
npx playwright-core install firefox  # Linux 可加 --with-deps
npm test
```

- `npm test` 會替每組測試啟動獨立的服務、暫存資料庫與空閒埠，不會碰到 `data/wall.db`。
- 測試 runner 預設依 CPU 使用 2–4 個並行工作；需要限制並行時可用 `npm test -- --jobs 2`。
- 單組測試：`npm test -- tabs`。
- 測試結果預設寫在 `test-results/`，可用 `WALL_TEST_ROOT` 改位置；可用 `WALL_TEST_BROWSER` 換瀏覽器，預設 Firefox。Linux 可用 `WALL_TEST_BROWSER=chromium`。
- 測試通過後，會刪掉該組的暫存資料庫與 Firefox 設定檔，只留截圖與紀錄；失敗的那組會保留這些檔案，方便除錯。
- AI 對話的測試用假的 CLI，不會呼叫真模型。
- Markdown 測試需要連 cdnjs；離線時這組測試會明確失敗，畫布本身仍可用。

### 專案架構

- 介面是單一 `index.html`（原生 JavaScript），透過同源 API 讀寫。
- `server/layout.js`：Node 與瀏覽器共用的確定性線索牆布局引擎，供提案預覽、套用與「整理版面」使用。
- `server/server.js`：網頁與 API 服務，以及網頁內 AI 對話。
- `server/db.js`：SQLite 資料層。
- `server/mcp.js`：MCP 伺服器。

P15 提供六種主題、兩種卡片風格的功能巡檢與一致性報告。

## 文件

- [目前已有功能及限制](docs/FEATURES.md)
- [功能路線圖](docs/ROADMAP.md)
- [搬移與資料保存](docs/MIGRATION.md)
- [Electron 嵌入評估](docs/ELECTRON.md)
- [第三方依賴說明](THIRD_PARTY_NOTICES.md)

## 授權

本專案採 MIT 授權，著作權人為 xiangerwu；詳見 [LICENSE](LICENSE)。
