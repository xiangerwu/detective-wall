# 論文偵探牆 / Detective Wall

**繁體中文** | [English](README.en.md)

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF) ![Firefox first](https://img.shields.io/badge/browser-Firefox%20first-FF7139?logo=firefoxbrowser&logoColor=white) ![Tests](https://img.shields.io/badge/tests-32%20suites-2EA44F) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

個人研究用的關係白板。用卡片、疑問便利貼和連線整理線索，資料存在本機的 SQLite。AI（Claude Code 或 codex）可以讀牆、讀你授權的資料夾，並提出修改；每一項修改都要你在畫面上確認後才會生效。

## 安裝

需要：

- **Node.js 24**（開發與測試使用 v24.11.1）。
- **Firefox**：主要驗證的瀏覽器。
- **CLI（選用）**：測試過 Claude Code 2.1.314、codex-cli 0.153.4；較舊版本可能不認得本專案使用的旗標。
- 選用，要讓 AI 幫忙時才需要：已登入的 [Claude Code](https://claude.com/claude-code) 或 codex CLI，至少一個。

```sh
npm install
npm start
```

看到 `WALL_READY 3000` 後，用 Firefox 開 http://127.0.0.1:3000/ 。第一次啟動會建立 `data/wall.db`，並放入 7 張示例卡片。

服務只聽本機（127.0.0.1），關掉終端機或按 Ctrl+C 就會停止。資料都在資料庫裡，下次 `npm start` 會接著用。

## 基本操作

- **卡片**：雙擊空白處新增；點卡片編輯標題、筆記（支援 Markdown）、標籤與來源；拖曳卡片移動。編輯器的標籤選擇器可選現有標籤或建立新標籤，已貼標籤可用 × 移除。
- **畫布**：拖空白處平移，滾輪縮放，「全覽」把整面牆放進畫面；在空白處按住 Shift 用左鍵拖曳框選（右鍵留給瀏覽器與滑鼠手勢套件），拖曳其中一張已選卡會整組移動。
- **連線**：從卡片的紅色圖釘拖到另一張卡片。連線有三種類型：建立在其上、使用技術、待驗證疑問。點連線可以改類型、文字或刪除。
- **來源**：每行一個，格式是 `名稱 | 路徑或網址 | 位置 | 摘錄`，後兩欄可省略。找不到的本機檔案會在卡片上標紅。
- **多面牆**：上方分頁切換；雙擊改名，右鍵換顏色或刪除，拖曳排序。
- **搜尋**：上方「搜尋所有牆」可以找標題、筆記、標籤和連線文字。點結果會跳到那張卡。
- **復原**：Ctrl+Z／Ctrl+Y，最多 100 步。
- **保存**：自動保存，上方顯示「已保存 HH:MM」。服務斷線或同一面牆在別的分頁被改過時，會出現提示，並提供重試或選擇保留哪一版。
- **版面**：按上方「整理版面」會依連線排成放射狀線索網；沒有框選時整理整面牆，有框選或點選卡片時只整理選取卡片，其餘卡片固定不動。這是一次可 Ctrl+Z 復原的變更；牆上若有分層，分層線不會跟著卡片移動。最左側活動列用圖示切換檔案、版本、範本、資料夾、標籤、外觀與說明面板；左面板和右側欄各有自己的拖曳把手。右側只放 AI 對話與 AI 提案，待審數量會顯示在「AI 提案」旁。
- **外觀**：在「外觀」面板切換六種背景，以及「科技／擬真便利貼」兩種全域卡片風格。主題會一起套用到頂列、左右欄、編輯器、對話框、按鈕與輸入框；擬真風格依卡片顏色使用淡色紙張，線索卡保留圖釘，疑問便利貼使用膠帶與紙角。
- **標籤管理**：左側「標籤」面板可新增、點名稱直接改名、用色筆換色，刪除需按兩次且會從所有卡片移除；這些變更都能 Ctrl+Z 復原，圓點仍可用來篩選。
- **資料夾**：左側「資料夾」面板以清單管理授權的絕對路徑；用「瀏覽…」叫出作業系統的資料夾選擇視窗，或用「新增」／Enter 加入，移除按鈕會立即保存，非絕對路徑與重複路徑會直接提示。Windows 使用 PowerShell 原生視窗，macOS 使用 `osascript`；Linux 需要安裝 `zenity` 或 `kdialog`。
- **卡片編輯**：點卡片會開啟浮動編輯視窗；拖曳標題列移動，右下角把手調整寬高，按右上角關閉或 Esc 關閉。位置與尺寸會記住，標題列固定而內容區獨立捲動，且不會擋住視窗外的畫布。

## 讓 AI 幫忙整理

AI 不會直接改你的牆：它只能**提出修改**，由你逐項勾選套用，而且每次套用都能回復。

### 第一次：從空白牆開始

1. 右側「AI 提案」勾選 **允許 AI 提出修改**。預設關閉；關閉時 AI 只能讀牆。
2. 如果要 AI 讀程式碼或文件：在左側活動列開啟「資料夾」，輸入資料夾的絕對路徑後按「新增」或 Enter；清單會立即保存授權。
3. 在左側活動列開啟「範本」，選一個起手範本：
   - 分析程式碼
   - 規劃論文
   - 整理推理線索
   - 設計遊戲支線

   範本會開一面以範本命名的新牆，只建立該範本的標籤，不建立分層，並把提示詞填進右側「AI 對話」輸入框；提示詞要求中心卡、3～6 條主線、每條 2～5 張線索、跨主線連線與短卡片，位置交給系統；要撤銷這次起手，可在分頁選單刪掉新牆。
4. 在右側輸入框補上材料：貼上大綱、筆記或案情；用分析程式碼範本時，說明要看哪個授權資料夾。然後選 Claude Code 或 codex，按送出。執行中會顯示耗時與工具進度；需要時按「停止」會終止這次對話並留下停止狀態。
5. 回覆後，右側「AI 提案」會出現一筆提案。按「檢視」開啟獨立審核面板，依新增卡片分層、修改、連線、刪除分組；可展開 Markdown、來源與修改差異，勾選要的項目後按「套用所選」。刪除類項目會標明，預設不勾，畫布上的虛影只是預覽，不會提前改資料。
6. 不滿意：在左側活動列的「版本」按「回復這次套用」。

範本也可以自訂：新增、編輯、刪除都行；內建範本不能刪，但可以複製後修改。

### 平常使用

在右側「AI 對話」直接問，例如「這面牆有哪些和方法 B 有關的卡片？」或「幫我提議一張卡記下這個疑問，連到應用示例 A」。

- 每面牆有自己的對話，AI 記得之前聊過的內容。按「開新對話」可以從頭開始。
- 對話越長，每則訊息耗的額度越多。
- 使用的是你 CLI 的登入狀態與訂閱額度，不需要 API 金鑰。
- Claude Code 要先登入：在終端機執行 `claude`，輸入 `/login`。
- 找不到或沒登入的 CLI，會在頁面上顯示為無法使用，或回報錯誤原因。

### 用其他 AI 客戶端（選用）

任何支援 MCP 的客戶端（例如另開一個 Claude Code session）都能連上偵探牆：

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
- AI 只能透過偵探牆工具讀取**目前這面牆**和**你授權的資料夾**，不能執行 shell、不能用 CLI 自己的讀檔或上網工具。
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
- 單組測試：`npm test -- tabs`。
- 測試結果預設寫在 `test-results/`，可用 `WALL_TEST_ROOT` 改位置；可用 `WALL_TEST_BROWSER` 換瀏覽器，預設 Firefox。Linux 可用 `WALL_TEST_BROWSER=chromium`。
- 測試通過後，會刪掉該組的暫存資料庫與 Firefox 設定檔，只留截圖與紀錄；失敗的那組會保留這些檔案，方便除錯。
- AI 對話的測試用假的 CLI，不會呼叫真模型。
- Markdown 測試需要連 cdnjs；離線時這組測試會明確失敗，畫布本身仍可用。

架構：

- 介面是單一 `index.html`（原生 JavaScript），透過同源 API 讀寫。
- `server/layout.js`：Node 與瀏覽器共用的確定性線索牆布局引擎，供提案預覽、套用與「整理版面」使用。
- `server/server.js`：網頁與 API 服務，以及網頁內 AI 對話。
- `server/db.js`：SQLite 資料層。
- `server/mcp.js`：MCP 伺服器。

## 文件

- [目前已有功能及限制](docs/FEATURES.md)
- [功能路線圖](docs/ROADMAP.md)
- [搬移與資料保存](docs/MIGRATION.md)
- [第三方依賴說明](THIRD_PARTY_NOTICES.md)

## 發布狀態

本專案採 MIT 授權，著作權人為 xiangerwu；詳見 [LICENSE](LICENSE)。
