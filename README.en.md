<img src="assets/icon/icon-256.png" alt="CaseGraph icon" width="128" align="right">

# CaseGraph

[繁體中文](README.md) | **English**

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF) ![Firefox first](https://img.shields.io/badge/browser-Firefox%20first-FF7139?logo=firefoxbrowser&logoColor=white) ![Tests](https://img.shields.io/badge/tests-42%20suites-2EA44F) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A relationship whiteboard for personal research. Organize clues with cards, question sticky notes, and connections; data is stored in local SQLite. AI (Claude Code or codex) can read the board and folders you authorize, and propose changes; each change takes effect only after you confirm it on screen.

## Installation

Requirements:

- **Node.js 24** (development and testing use v24.11.1).
- **Firefox**: the primary validation browser.
- **CLI (optional)**: tested with Claude Code 2.1.314 and codex-cli 0.153.4; older versions may not recognize the flags used here.
- Optional, only needed when having AI help: a logged-in [Claude Code](https://claude.com/claude-code) or codex CLI, at least one.

Quickest: on Windows double-click `start.cmd` to open the CaseGraph launcher; on macOS/Linux run `./start.sh`. The Windows launcher checks the Node version, installs packages in the background on the first run, starts the service and opens the browser.

Or run it by hand:

```sh
npm install
npm start
```

After seeing `WALL_READY 3000`, open http://127.0.0.1:3000/ in Firefox. The first startup creates `data/wall.db` and adds 7 sample cards.

The service listens only on the local machine (127.0.0.1). Closing the Windows launcher hides it in the system tray; its context menu can show the window, open the web app/CLI/log, stop the service, or exit. The launcher stops only services it started; it asks for confirmation before stopping or restarting an externally started CaseGraph service. The window can add a Start Menu shortcut, but does not create a desktop shortcut. Runtime logs and launcher files are in `data/launcher/`; the database remains in `data/wall.db` and is reused next time.

## Basic operations

- **Cards**: Double-click an empty area to add one; click a card to edit its title, notes (Markdown supported), tags, and sources; drag cards to move them. The editor tag picker selects existing tags or creates new ones, and assigned tags have × buttons.
- **Canvas**: Drag an empty area to pan and use the wheel to zoom. The floating rounded islands at the top of the canvas provide −, the percentage, +, and 「全覽」(fit entire board). Hold Shift and left-drag an empty area to marquee-select cards (the right button is left to the browser and mouse-gesture extensions), and dragging one selected card moves the group.
- **Connections**: Drag the red pin or tape endpoint on a card to another card. A new connection reuses the last-used type (default 建立在其上 / builds on); click the line to choose 建立在其上, 使用技術, or 待驗證疑問 in the string popup, edit its text, or delete it.
- **Sources**: One per line, in the format `name | path or URL | location | excerpt` (page, section, or timestamp for location); the last two fields are optional. Missing local files are marked red on the card.
- **Multiple boards**: Switch using the tabs at the top; double-click to rename, right-click to change color or delete, and drag to reorder.
- **Search**: 「搜尋所有牆」(search all boards) at the top searches titles, notes, tags, and connection text. Click a result to jump to that card.
- **Undo/redo**: Ctrl+Z／Ctrl+Y, up to 100 steps.
- **Saving**: Saving is automatic; the top shows 「已保存 HH:MM」(saved HH:MM). If the service disconnects or the same board is changed in another tab, a prompt appears with options to retry or choose which version to keep.
- **Layout**: The floating rounded island at the top of the canvas provides 「整理版面」 with push-apart, grid-align, and full-reflow modes. With no marquee or selected card it lays out the whole board; with a selection it moves only those cards and leaves the rest fixed. It is one Ctrl+Z-able change; if the board has bands, the band lines do not move with the cards.
- **Rail and AI clipboard**: The left rail has three states—collapsed, icon, and full—and opens the File, Version, Template, Folder, Tag, Appearance, and Help panels. The left panel and AI sidebar have independent resize handles. The AI sidebar is a dark clipboard with four paper sheets: 對話 (chat), 提案 (proposals), 紀錄 (history), and 模型 (model); the active sheet is reachable by click or keyboard.
- **Appearance**: The Appearance panel switches six backgrounds—whiteboard grid, wood grain, ruled paper, cork, moon-dark, and cyber-dark—and the global 「科技／擬真便利貼」 (technology / paper sticky note) card styles. Each theme restyles the wall, pill tabs, rail, editor, dialogs, buttons, and inputs. Paper style uses index cards, sticky-note curls, tape-mounted Polaroids, pins, soft shadows, and clipped 源頭／重點 (source/key) badges.
- **Tag management**: The Tag panel adds tags, renames them by clicking the name, changes colours with the palette button, and requires two clicks to delete. Deletion removes that tag from every card and can be undone; the dot button still filters cards.
- **Folders**: The Folder panel manages authorized absolute paths as a list. 「瀏覽…」 opens the operating system's folder chooser, while the Add button or Enter uses the existing path validation; removal saves immediately, and relative or duplicate paths show an inline error. Windows uses a native PowerShell dialog, macOS uses `osascript`, and Linux needs `zenity` or `kdialog`.
- **Card editor**: Clicking a card opens a floating editor. Drag its title bar, resize it from the bottom-right handle, or close it with the top-right button or Escape. Its position and size are remembered; the title bar stays fixed while the body scrolls.

### Recent P14/P15 features

- Marquee selections can be deleted with confirmation or copied and pasted, with each batch represented by one undo step.
- Bands have an in-canvas list and keyboard navigation; anchor cards have source/key levels with lists, filters, and jump-to navigation.
- Cards can be freely resized; connection endpoints can be automatic or manually positioned; each card can use a pin or tape mount.
- Paper style adds realistic sticky-note shadows, grain, and curled corners; image cards use a deterministic Polaroid treatment.
- The AI mascot follows conversation state; layout offers push-apart, grid-align, and full-reflow modes.
- P15 covers a six-theme, two-card-style feature tour and consistency report.

## Getting AI to help organize

AI does not directly change your board: it can only **propose changes**, which you apply by checking items one by one; every application can be reverted.

### First time: start from a blank board

1. In the right sidebar 「AI 提案」(AI proposals), check **允許 AI 提出修改** (allow AI to propose changes). It is off by default; when off, AI can only read the board.
2. If you want AI to read code or documents: open 「資料夾」(Folder) from the three-state left rail, enter an absolute path, then click 「新增」(Add) or press Enter; the list is saved immediately.
3. Open 「範本」(Template) from the left rail and choose a starter template:
   - 「分析程式碼」(analyze code)
   - 「規劃論文」(plan a paper)
   - 「整理推理線索」(organize reasoning clues)
   - 「設計遊戲支線」(design game side quests)

   The template opens a new board named after the template, containing only that template's tags (no bands), and fills a prompt for one center, 3–6 branches, 2–5 clues per branch, cross-branch labelled edges, and short cards into the right-side 「AI 對話」(AI conversation) input. To undo the starter operation, delete the new board from its tab menu.
4. Add material in the AI clipboard's 對話 (chat) sheet: paste an outline, notes, or case details; when using the 「分析程式碼」 template, say which authorized folder to inspect. Then choose Claude Code or codex and click submit. While it runs, the UI shows elapsed time and tool progress; click 「停止」(stop) to terminate the conversation and record its stopped status.
5. After the reply, open the 提案 (proposals) sheet. Click 「檢視」(view) to open the dedicated review panel, grouped by new-card bands, modifications, connections, and deletions. Expand an item for Markdown, sources, or diffs, check what you want, and click 「套用所選」(apply selected). Deletions are labeled and unchecked by default; canvas ghosts are preview-only and do not change data before applying.
6. If you are not satisfied: open 「版本」(Version) from the left rail and click 「回復這次套用」(revert this application) in 「AI 紀錄」(AI history).

Templates can also be customized: add, edit, or delete them; built-in templates cannot be deleted, but can be copied and modified.

### Everyday use

Ask directly in the right sidebar 「AI 對話」(AI conversation), for example, “Which cards on this board are related to method B?” or “Suggest a card to record this question and connect it to application example A.”

- Each board has its own conversation, and AI remembers what was discussed before. Click 「開新對話」(start a new conversation) to start over.
- The longer the conversation, the more quota each message uses.
- Your CLI's login state and subscription quota are used; no API key is required.
- Claude Code must be logged in first: run `claude` in a terminal, then enter `/login`.
- A CLI that cannot be found or is not logged in is shown as unavailable on the page, or reports the reason for the error.

### Using other AI clients (optional)

Any MCP-compatible client (for example, another Claude Code session) can connect to CaseGraph:

```json
{
  "mcpServers": {
    "detective-wall": {
      "command": "node",
      "args": ["<absolute project path>/server/mcp.js"],
      "env": {
        "WALL_DB": "<absolute project path>/data/wall.db",
        "WALL_PORT": "3000"
      }
    }
  }
}
```

`WALL_DB` must point to the actual SQLite database file you intend to use. The path in the example is a placeholder; do not copy it unchanged.

There are nine tools:

- Read the board: `list_boards`, `get_board`, `get_cards`, `search_cards`, `get_relations`
- Read authorized folders: `list_files`, `read_file`
- Proposals: `propose_changes`, `get_change_status`

Only `propose_changes` writes data, and it writes only pending proposals. Some clients (such as codex) block tools requiring approval by default; to let them submit proposals, allow that tool or enable automatic approval.

## Data and backups

- Data is stored in `data/wall.db` by default; use `WALL_DB` to change the location. This file is all your data, so copying it is a complete backup.
- 「檔案」(File) in the left rail contains 「匯出整個專案」(export entire project), which saves all boards, images, and settings as one `.json`, and 「還原整個專案」(restore entire project), which restores them all at once. An individual board can use 「匯出 JSON」(export JSON)／「匯入 JSON」(import JSON); differences are shown before importing.
- Each board automatically keeps up to 20 backups, available under 「版本」(Version) → 「備份」(backups) in the left rail.
- Tag definitions, colours, and card assignments are saved with the board; deleting a tag removes all assignments in one undoable change.
- AI proposals, AI history, and AI conversation history are internal service data and are not included in the project export file.
- To move an export from an older version to a new location, see [Migration instructions](docs/MIGRATION.md) (Chinese).

## Configuration

| Environment variable | Purpose | Default |
|---|---|---|
| `WALL_DB` | SQLite database file | `data/wall.db` |
| `WALL_PORT` | Web service port | `3000` |
| `WALL_MCP_WALLS` | Show only these boards to external MCP clients (comma-separated board IDs) | All |
| `WALL_CLAUDE_BIN` | Claude Code executable path | Found from PATH |
| `WALL_CODEX_BIN` | codex executable path | Found from PATH |
| `WALL_PICK_FOLDER_BIN` | Override the native folder picker (for tests) | Platform default |

PowerShell configuration:

```powershell
$env:WALL_DB='D:/my-research/wall.db'; npm start
```

macOS/Linux:

```sh
WALL_DB=/path/to/my-research/wall.db npm start
```

## Security and limitations

- The service binds only to 127.0.0.1 and rejects requests sent by other websites.
- AI can read only **the current board** and **the folders you authorized** through CaseGraph tools; it cannot execute shell commands or use the CLI's own file-reading or web tools.
- Authorized-folder restrictions:
  - It cannot use `..` or symlinks to escape the authorized scope, and does not read network shares.
  - Only text files are read, with a per-file limit of 1 MiB.
  - These directories are always excluded: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`, `gcloud` (including `.config/gcloud`), `.terraform.d`, `.git`, `node_modules`, and `.config/gh`.
  - These names are always excluded: `.env*`, `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd`, `credentials`, `credentials.json`, and SSH keys `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk` with their `.pub` files and underscore-suffixed backup names.
  - These extensions and patterns are always excluded: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `*.kdbx`, `*.gpg`, `*.pgp`, `*.asc`, `*.crt`, `*.cer`, `*.der`; `.json`/`.yaml`/`.yml`/`.toml` names containing `secret` or `token`; `*.tfstate*`; and database files `*.db`, `*.sqlite*`, `*-wal`, and `*-shm`.
  - A file is also refused when its first 64 KiB contains both `-----BEGIN` and `PRIVATE KEY`.
  - “Instructions” written in files and cards are treated as data and cannot change permissions.
- AI can only propose changes. Before applying them, the target is checked for changes you made; changed items are marked as conflicts and do not overwrite your changes.
- Trust model: the service listens only on the local machine, and other programs on that machine are treated as trusted. External MCP clients can read all boards by default; use `WALL_MCP_WALLS='w-main,w-other' npm start` to limit their scope.
- To submit proposals, codex must run in automatic approval mode. The shell is disabled, but this is still workspace-write approval mode, which is the remaining risk.
- The correctness of AI answers (whether citations are accurate and whether inferences are presented as facts) is not checked automatically; judge it yourself.

## Troubleshooting

- **The screen shows 「本機服務無法連線」(local service cannot connect)**: Confirm that the terminal running `npm start` is still open. Restart, then click 「重試」(retry).
- **AI conversation reports `OAuth session expired` or an authentication failure**: The CLI login has expired. Run `claude`, then enter `/login`; for codex, log in again using codex's login method.
- **AI says the proposal was rejected**: First confirm that **允許 AI 提出修改** (allow AI to propose changes) is checked.
- **`MCP database not found`**: Run `npm start` once to create the database, or point `WALL_DB` to an existing file.
- **`wall not in authorized scope`**: Check `WALL_MCP_WALLS`. A nonexistent board also returns this message; this is intentional.
- **The port is already in use**: choose another port, for example `WALL_PORT=3001 npm start`; open either `http://localhost:3001/` or `http://127.0.0.1:3001/`.
- **Mixing localhost and 127.0.0.1**: both names refer to this machine; make sure the URL port matches `WALL_PORT`.
- **A feature does not appear after changing code or upgrading**: Restart `npm start`, then refresh the browser.

## Development and testing

```sh
npm install
npx playwright-core install firefox  # add --with-deps on Linux
npm test
```

- `npm test` starts an independent service, temporary database, and free port for each test group, and does not touch `data/wall.db`.
- The test runner uses 2–4 workers based on CPU count by default; use `npm test -- --jobs 2` to cap concurrency.
- Run one test group: `npm test -- tabs`.
- Test results are written to `test-results/` by default; use `WALL_TEST_ROOT` to change the location. Use `WALL_TEST_BROWSER` to switch browsers; Firefox is the default.
- After tests pass, the temporary database and Firefox profile for that group are deleted, leaving only screenshots and logs; a failed group keeps these files for debugging.
- AI conversation tests use a fake CLI and do not call a real model.
- Markdown tests require cdnjs; offline, this test group fails explicitly, while the canvas itself remains usable.

Architecture:

- The interface is a single `index.html` (native JavaScript) that reads and writes through a same-origin API. The interface is currently Traditional Chinese only.
- `server/layout.js`: deterministic clue-wall layout engine shared by Node and the browser for proposal previews, application, and 「整理版面」.
- `server/server.js`: web and API service, plus in-page AI conversations.
- `server/db.js`: SQLite data layer.
- `server/mcp.js`: MCP server.

## Documentation

- [Existing features and limitations](docs/FEATURES.md) (Chinese)
- [Feature roadmap](docs/ROADMAP.md) (Chinese)
- [Migration and data preservation](docs/MIGRATION.md) (Chinese)
- [Electron embedding assessment](docs/ELECTRON.md) (Chinese)
- [Third-party dependency notices](THIRD_PARTY_NOTICES.md) (Chinese)

## Release status

This project is released under the MIT License, copyright xiangerwu. See [LICENSE](LICENSE).
