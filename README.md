# CaseGraph 案件圖譜

**繁體中文** | [English](README.en.md)

![Release 0.1.0](https://img.shields.io/badge/release-0.1.0-2EA44F) ![Windows](https://img.shields.io/badge/desktop-Windows-0078D4) ![SQLite](https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

<p align="center">
  <img src="assets/icon/icon-256.png" alt="CaseGraph 案件圖譜圖示" width="128">
</p>

CaseGraph 是一款個人研究用的關係白板，讓你用卡片記錄資料、用疑問便利貼標記待查事項，再用連線串起線索。所有資料儲存在本機 SQLite 資料庫。

你可以自行整理，也可以讓 Claude Code 或 Codex 讀取牆面與你授權的資料夾，協助分析並提出修改。**AI 提案需經你確認才會套用，套用後也能復原。**

**[下載 Windows 安裝檔](https://github.com/xiangerwu/detective-wall/releases/download/v0.1.0/CaseGraph-Setup-0.1.0.exe)** · [發布說明](https://github.com/xiangerwu/detective-wall/releases/tag/v0.1.0) · [功能與限制](docs/FEATURES.md) · [備份與搬移](docs/MIGRATION.md)

目前發布版本為 **v0.1.0**。本文件依 2026-11-05 的儲存庫現況整理；日後主分支更新不代表已安裝的版本會自動更新。介面目前使用繁體中文。

## 安裝

### Windows 桌面版

從上方下載連結取得 `CaseGraph-Setup-0.1.0.exe`，執行後依安裝精靈操作。桌面版內含執行環境，不需要另外安裝 Node.js 或 Firefox。自行打包見 [桌面版開發與打包](docs/ELECTRON.md)。

- 安裝在目前使用者底下，不需要系統管理員權限；可以自選安裝位置，並建立開始功能表與桌面捷徑。
- 第一版沒有程式碼簽章，Windows SmartScreen 可能顯示警告；也沒有自動更新，新版本需要手動下載安裝。
- 資料、設定與紀錄都放在 `%APPDATA%\CaseGraph\CaseGraph\`：
  - `settings.json`：設定；
  - `projects\default\wall.db`：預設專案的資料庫；
  - `logs\main.log`：紀錄。
- 桌面版不會讀取瀏覽器版的 `data/wall.db`。要沿用原本的牆，請在瀏覽器版匯出，再到桌面版匯入。
- 關閉視窗會縮到系統匣；要結束，請在系統匣圖示按右鍵選「結束」。
- 左側齒輪選單的「啟動器設定」（或系統匣「設定…」）可以：
  - 修改服務埠；
  - 切換專案資料夾；
  - 設定 AI 工作資料夾；
  - 開啟 Claude／codex CLI；
  - 查看最近紀錄。

「專案資料夾」決定資料庫位置；「AI 工作資料夾」是 CLI 的工作目錄。要讓內建 AI 讀取材料，仍需在「資料夾」面板授權，設定工作目錄不會自動授權。

### 瀏覽器版與開發環境需求

- **Node.js 24 以上**（既有開發與測試基準為 v24.11.1）。
- **Firefox**：主要驗證的瀏覽器。
- **AI CLI（選用）**：要使用 AI 功能，需至少安裝並登入 [Claude Code](https://claude.com/claude-code) 或 Codex CLI 其中一個；桌面版也一樣需要。測試版本為 Claude Code 2.1.314、codex-cli 0.153.4；較舊版本可能不支援本專案使用的旗標。

### 瀏覽器版啟動方式

macOS／Linux 可以執行 `./start.sh`。也可以在專案目錄手動執行（Windows 也適用）：

```sh
npm ci
npm start
```

看到 `WALL_READY 3000` 後，用 Firefox 開啟 [CaseGraph 本機頁面](http://127.0.0.1:3000/)。第一次啟動會建立 `data/wall.db`，並放入 7 張示例卡片；之後啟動會沿用既有資料。服務只監聽本機位址 `127.0.0.1`。開發時也可以用 `npm run app` 直接開啟桌面版。

## 基本操作

### 卡片與連線

- **新增與編輯**：雙擊畫布空白處新增卡片，點擊卡片編輯標題、Markdown 筆記、標籤與來源。拖曳可移動卡片，也可自由調整寬高。
- **編輯視窗**：拖曳標題列移動，拖曳右下角把手調整寬高，按右上角關閉按鈕或 Esc 關閉。視窗會記住位置與尺寸；內容可獨立捲動，視窗外的畫布仍可操作。
- **卡片標籤**：在編輯器中選用現有標籤或建立新標籤，按標籤旁的 × 移除。
- **來源**：每行一筆，格式為 `名稱 | 路徑或網址 | 位置 | 摘錄`，後兩欄可省略。找不到的本機檔案會在卡片上標紅。
- **建立連線**：從卡片上緣的紅色圖釘或膠帶端點拖到另一張卡片。新線沿用上次使用的類型（預設「建立在其上」）；畫完後點線，在浮窗選「建立在其上」、「使用技術」或「待驗證疑問」，端點可自動定位或手動調整。

### 畫布與版面

- **瀏覽畫布**：拖曳空白處平移，滾輪縮放；畫布上方的浮動圓角島提供「−／百分比／＋／全覽」。
- **框選與批次操作**：在空白處按住 Shift 並以左鍵拖曳框選；拖曳已選卡片可整組移動，也可複製貼上或確認刪除。整批操作可一次復原。右鍵保留給瀏覽器與滑鼠手勢套件。
- **整理版面**：畫布上方另一個浮動圓角島提供「推開重疊、對齊格線、全部重排」三種模式；重排可依連線形成放射狀線索網。有選取卡片時只整理選取範圍，其餘卡片固定不動；未選取時整理整面牆。操作可用 Ctrl+Z 復原，分層線不會跟著卡片移動。
- **分層與錨點**：從左側齒輪選單開啟「分層／錨點」清單；錨點分為源頭／重點，可透過清單篩選與跳轉，分層也可用快捷鍵瀏覽。

### 牆面與側邊面板

- **多面牆**：透過上方膠囊分頁切換，雙擊改名、右鍵換色或刪除、拖曳排序。
- **搜尋**：「搜尋所有牆」可查找標題、筆記、標籤與連線文字，點擊結果會跳到對應卡片。
- **面板配置**：左側懸浮泡泡提供新增線索卡、疑問便利貼、圖片與分層；齒輪展開「分層／錨點、檔案、版本、範本、資料夾、標籤、外觀、說明」，桌面版另有「啟動器設定」。功能面板以浮窗開啟，按 Esc 可關閉。
- **AI 案件夾**：點右側 AI 把手或桌寵展開，四張紙張分頁為「對話、提案、紀錄、模型」。點關閉鈕或案件夾外側可收起。
- **標籤管理**：在左側「標籤」面板新增標籤、點名稱改名、用色筆換色，或點圓點篩選。刪除需按兩次，會移除所有卡片上的該標籤；這些變更均可復原。
- **資料夾授權**：在左側「資料夾」面板按「瀏覽…」選取資料夾，或輸入絕對路徑後按「新增」／Enter。新增與移除會立即保存；非絕對路徑或重複路徑會顯示提示。資料夾選擇視窗在 Windows 使用 PowerShell、macOS 使用 `osascript`；Linux 需安裝 `zenity` 或 `kdialog`。

### 外觀與保存

- **主題與卡片風格**：「外觀」面板提供白板色、木紋、書頁黃、軟木、月夜與賽博六種背景，以及「科技／擬真便利貼」兩種全域卡片風格。主題同步套用到分頁、浮動面板、編輯器、對話框、按鈕與輸入框。
- **桌寵與動畫**：桌寵會反映 AI 狀態，點擊可切換動作、顯示台詞並開啟 AI 案件夾；可調整大小。在「外觀」勾選「減少動畫」可使用靜止桌寵和立即切換的面板，適合遠端桌面連線。
- **紙張與裝飾**：擬真風格使用索引卡、便利貼翻角、膠帶固定的拍立得與柔和陰影；線索卡與疑問便利貼的圖釘或膠帶端點都能拉線，錨點徽章分為「源頭／重點」。
- **復原與重做**：Ctrl+Z 復原、Ctrl+Y 重做，最多 100 步。
- **自動保存**：上方顯示「已保存 HH:MM」。服務斷線或同一面牆在其他分頁被修改時，會提示重試或選擇保留的版本。

## 讓 AI 幫忙整理

AI 先提出修改，再由你在審核面板逐項勾選套用。未套用的提案不會改變牆面，每次套用也都能回復。

### 首次使用

1. 點右側 AI 把手或桌寵開啟案件夾，在「提案」紙張勾選 **允許 AI 提出修改**。預設關閉；關閉時 AI 仍可讀取授權資料，但不能送出提案。
2. 若要 AI 讀取程式碼或文件，在左側齒輪選單開啟「資料夾」面板，加入要授權的資料夾。
3. 在左側齒輪選單開啟「範本」，選一個起手範本：
   - 分析程式碼
   - 規劃論文
   - 整理推理線索
   - 設計遊戲支線

   範本會建立同名新牆與對應標籤，不會建立分層，並將提示詞填入右側「AI 對話」。提示詞要求中心卡、3～6 條主線、每條 2～5 張線索、跨主線連線及簡短卡片內容，位置由系統安排。若要撤銷這次起手，可從分頁選單刪除新牆。
4. **補充材料並送出**：在「對話」紙張貼上大綱、筆記或案情；分析程式碼時，說明要讀哪個授權資料夾。選擇 Claude Code 或 Codex 後送出。執行中會顯示耗時與工具進度，按「停止」可終止這次對話並保留停止狀態。
5. **審核提案**：切到「提案」紙張並按「檢視」。審核面板依新增卡片與分層、修改、連線、刪除分組，可展開 Markdown、來源與修改差異。勾選要保留的項目後按「套用所選」；刪除項目預設不勾選，畫布上的虛影僅供預覽。
6. **回復套用**：若結果不符合預期，在 AI 案件夾「紀錄」分頁按「回復這次套用」；一般牆面備份則從齒輪選單「版本」開啟。

自訂範本可新增、編輯與刪除。內建範本不能刪除，但可複製後修改。

### 日常對話

在 AI 案件夾的「對話」紙張直接問，例如「這面牆有哪些和方法 B 有關的卡片？」或「幫我提議一張卡記下這個疑問，連到應用示例 A」。

- 每面牆有自己的對話，AI 記得之前聊過的內容。按「開新對話」可以從頭開始。
- 對話越長，每則訊息耗的額度越多。
- 使用的是你 CLI 的登入狀態與訂閱額度，不需要 API 金鑰。
- Claude Code 要先登入：在終端機執行 `claude`，輸入 `/login`。
- 找不到或沒登入的 CLI，會在頁面上顯示為無法使用，或回報錯誤原因。

### 用其他 AI 客戶端（選用）

桌面版可從「啟動器設定」開啟已接好 MCP 的 CLI。原始碼使用者也可在支援 MCP 的客戶端設定下列 stdio 服務（需要 Node.js 24 以上）：

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

`WALL_DB` 必須指向實際資料庫，`WALL_PORT` 必須對應正在執行的服務。上例使用瀏覽器版預設位置；桌面版請先在「啟動器設定」確認資料庫與埠。路徑只是範例，Windows JSON 路徑可使用 `/` 或跳脫的 `\\`。

工具有九個：

- 讀牆：`list_boards`、`get_board`、`get_cards`、`search_cards`、`get_relations`
- 讀授權資料夾：`list_files`、`read_file`
- 提案：`propose_changes`、`get_change_status`

只有 `propose_changes` 會寫入，而且只寫待審提案。若客戶端要求工具核准，允許該工具即可；牆面的「允許 AI 提出修改」也必須開啟。外部客戶端自身的 shell、檔案與網路權限由該客戶端管理，不受內建對話的工具限制保護。

## 資料與備份

- 瀏覽器版資料預設在 `data/wall.db`，可用 `WALL_DB` 改位置；桌面版使用目前專案資料夾中的 `wall.db`。完整資料庫備份需先停止服務與使用它的 MCP 客戶端，再複製資料庫；若仍有 `wall.db-wal`／`wall.db-shm`，一併保留，勿只取主檔。
- 資料庫包含牆、圖片、備份與 AI 紀錄，但不包含桌面版 `settings.json`、瀏覽器外觀偏好、外部來源檔案或 CLI 登入資料。完整搬移步驟見 [搬移與資料保存](docs/MIGRATION.md)。
- 齒輪選單「檔案」面板中，「匯出整個專案」把所有牆、圖片與專案設定存成一個 `.json`；「還原整個專案」一次還原。單面牆可用「匯出 JSON」／「匯入 JSON」，匯入前會先顯示差異。
- 每面牆自動保留最多 20 份備份，在齒輪選單「版本」面板查看與還原。
- 標籤定義、顏色與卡片上的標籤關聯都會隨牆保存；刪除標籤會一次移除所有卡片上的關聯，並可復原。
- 內部備份、AI 提案、AI 紀錄、AI 對話紀錄不包含在專案 JSON 匯出檔。還原專案會取代所有牆、圖片與專案設定，並清除 AI 狀態，請先保存目的地資料。
- 從舊版本匯出的資料搬到新位置，見 [搬移說明](docs/MIGRATION.md)。

## 設定

以下以瀏覽器版與外部 MCP 為主。桌面版的專案位置由「啟動器設定」管理，主行程不使用 `WALL_DB` 選擇專案。

| 環境變數 | 用途 | 預設 |
|---|---|---|
| `WALL_DB` | SQLite 資料庫檔 | `data/wall.db` |
| `WALL_PORT` | 網頁服務的埠 | `3000` |
| `WALL_MCP_WALLS` | 在 MCP 子行程環境設定可讀牆 ID（逗號分隔） | 未設定時全部 |
| `WALL_CLAUDE_BIN` | Claude Code 執行檔路徑 | 從 PATH 找 |
| `WALL_CODEX_BIN` | codex 執行檔路徑 | 從 PATH 找 |
| `WALL_PICK_FOLDER_BIN` | 覆寫原生資料夾選擇器（測試用） | 依平台選擇 |

PowerShell 的設定方式：

```powershell
$env:WALL_DB='D:/my-research/wall.db'
npm start
```

macOS／Linux：

```sh
WALL_DB=/path/to/my-research/wall.db npm start
```

## 安全與限制

- 服務只綁 127.0.0.1，並拒絕其他網站送來的請求。
- 內建 AI 對話的 MCP 範圍限制為**目前這面牆**和**你授權的資料夾**。Claude 的啟動參數限制為案件圖譜工具；Codex 關閉 shell 並忽略使用者設定，其餘限制仍需依實際 CLI 版本與權限行為判斷。這些設定不等於作業系統層級的完整隔離。
- 授權資料夾的限制：
  - 不能用 `..` 或符號連結跳出授權範圍，也不讀網路共用路徑。
  - 只讀文字檔，單檔上限 1 MiB。
  - 固定排除目錄 `.ssh`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker`、`.password-store`、`gcloud`（包含 `.config/gcloud`）、`.terraform.d`、`.git`、`node_modules`、`.config/gh`。
  - 固定排除檔名 `.env*`、`.netrc`、`_netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.htpasswd`、`credentials`、`credentials.json`；SSH 金鑰 `id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`、`id_ecdsa_sk`、`id_ed25519_sk`、其 `.pub` 與底線延伸的備份名稱。
  - 固定排除副檔名 `*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`、`*.ppk`、`*.kdbx`、`*.gpg`、`*.pgp`、`*.asc`、`*.crt`、`*.cer`、`*.der`；名稱含 `secret` 或 `token` 的 `.json`／`.yaml`／`.yml`／`.toml`；`*.tfstate*`；資料庫及其 `*.db`、`*.sqlite*`、`*-wal`、`*-shm` 檔。
  - 檔名前 64 KiB 含 `-----BEGIN` 且含 `PRIVATE KEY` 的檔案也拒絕讀取。
  - 檔案和卡片裡寫的「指示」只當資料，不能改變權限。
- AI 只能提出修改。套用前會檢查目標有沒有被你改過；改過的項目標成衝突，不會覆蓋你的修改。
- 信任模型：服務只聽本機；同一台電腦上的其他程式視為可信。外部 MCP 預設可讀所有牆；要限制範圍，在客戶端 MCP 設定的 `env` 加入 `"WALL_MCP_WALLS": "w-main,w-other"`。這不限制 HTTP API，也不改變內建對話的目前牆範圍。
- 內建 Codex 對話由程式以 `--approve-for-me` 啟動。CLI 工具核准與牆面提案審核是兩個層次；CLI 自動核准不會自動套用牆面修改。
- 牆面儲存在本機；使用 AI 時，對話及工具讀取的材料會交由選用的 CLI 與模型服務處理，並非完全離線 AI。
- AI 回答的正確性（引用是否正確、有沒有把推論說成事實）沒有自動檢查，請自行判斷。

## 故障排查

- **畫面顯示「本機服務無法連線」**：桌面版在系統匣選「重新啟動服務」並查看紀錄；瀏覽器版確認 `npm start` 的終端機還開著，重新啟動後按「重試」。
- **AI 對話回報 `OAuth session expired` 或驗證失敗**：CLI 的登入過期了。執行 `claude`，再輸入 `/login`；codex 則照 codex 的登入方式重新登入。
- **AI 說提案被拒絕**：先確認「允許 AI 提出修改」有勾選。
- **`MCP database not found`**：先 `npm start` 一次建立資料庫，或把 `WALL_DB` 指向已存在的檔案。
- **`wall not in authorized scope`**：檢查 `WALL_MCP_WALLS`。不存在的牆也會回這個訊息，這是刻意的。
- **啟動時顯示埠已被占用**：桌面版選「改用空閒埠（本次）」或到設定改埠。瀏覽器版在 PowerShell 設 `$env:WALL_PORT='3001'` 後執行 `npm start`；macOS／Linux 可用 `WALL_PORT=3001 npm start`，再開啟對應埠。
- **切換桌面專案或埠後，外部 CLI 仍讀到舊牆**：關閉舊 CLI，從「啟動器設定」重新開啟，讓它取得新的資料庫與實際埠。
- **遠端桌面畫面更新緩慢**：在齒輪選單「外觀」開啟「減少動畫」。
- **localhost／127.0.0.1 混用**：兩者都只代表本機，請確認網址的埠和 `WALL_PORT` 一致。
- **改了程式或升級後功能沒出現**：重啟 `npm start`，瀏覽器重新整理。

## 開發與測試

```sh
npm ci
npm run typecheck
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
- `electron/`：Windows 桌面視窗、系統匣、設定與 CLI 啟動。

Windows 打包使用 `npm run dist`。打包後執行 `npm test -- electron-packaged`；產物缺少時會回報 `SKIP`，不代表安裝包已驗證。其他桌面版檢查見 [Electron 桌面版](docs/ELECTRON.md)。

## 文件

- [目前已有功能及限制](docs/FEATURES.md)
- [發布現況與後續方向](docs/ROADMAP.md)
- [搬移與資料保存](docs/MIGRATION.md)
- [Windows 桌面版、設定與打包](docs/ELECTRON.md)
- [第三方依賴說明](THIRD_PARTY_NOTICES.md)

## 授權

本專案採 MIT 授權，著作權人為 xiangerwu；詳見 [LICENSE](LICENSE)。
