; Keep controls within 130 dialog units for the Traditional Chinese NSIS page.
; CaseGraph install choices. Included by installer.nsi after Tauri's definitions.
!include nsDialogs.nsh
!include "${__FILEDIR__}\installer-mcp.nsh"
Var CGRequest
Var CGInstall
Var CGPreviousInstall
Var CGRoot
Var CGProject
Var CGMode
Var CGOldRoot
Var CGOldProject
Var CGPort
Var CGWorkdir
Var CGClaude
Var CGCodex
Var CGMcp
Var CGScope
Var CGProposals
Var CGAdvanced
Var CGAppearance
Var CGTheme
Var CGStyle
Var CGMascot
Var CGMotion
Var CGDialog
Var CGRootControl
Var CGProjectControl
Var CGReuseControl
Var CGMoveControl
Var CGNewControl
Var CGControl1
Var CGControl2
Var CGControl3
Var CGControl4
Var CGControl5
Var CGControl6

!macro CGRead NAME VAR
  ReadINIStr ${VAR} $CGRequest "setup" "${NAME}"
!macroend
!macro CGWrite NAME VAR
  WriteINIStr $CGRequest "setup" "${NAME}" "${VAR}"
!macroend
!macro CGDialog TITLE SUBTITLE
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "${TITLE}" "${SUBTITLE}"
  nsDialogs::Create 1018
  Pop $CGDialog
  ${If} $CGDialog == error
    Abort
  ${EndIf}
!macroend

Function CGInitialize
  ${If} $CGInstall == $INSTDIR
    Return
  ${EndIf}
  InitPluginsDir
  StrCpy $CGRequest "$PLUGINSDIR\casegraph-request.ini"
  File /oname=$PLUGINSDIR\casegraph-setup.exe "${MAINBINARYSRCPATH}"
  ExecWait '"$PLUGINSDIR\casegraph-setup.exe" --installer inspect "$INSTDIR" "$CGRequest" "$CGPreviousInstall"' $0
  ${If} $0 != 0
    ReadINIStr $1 "$PLUGINSDIR\casegraph-request.result.ini" "setup" "error"
    MessageBox MB_OK|MB_ICONSTOP "無法讀取既有設定：$\r$\n$1"
    Abort
  ${EndIf}
  StrCpy $CGInstall $INSTDIR
  !insertmacro CGRead root $CGRoot
  !insertmacro CGRead project $CGProject
  !insertmacro CGRead oldRoot $CGOldRoot
  !insertmacro CGRead oldProject $CGOldProject
  !insertmacro CGRead mode $CGMode
  !insertmacro CGRead port $CGPort
  !insertmacro CGRead aiWorkdir $CGWorkdir
  !insertmacro CGRead claude $CGClaude
  !insertmacro CGRead codex $CGCodex
  !insertmacro CGRead registerMcp $CGMcp
  ; Explicit opt-in on every installation, including upgrades.
  StrCpy $CGProposals 0
  !insertmacro CGRead theme $CGTheme
  !insertmacro CGRead cardStyle $CGStyle
  !insertmacro CGRead mascotVisible $CGMascot
  !insertmacro CGRead reduceMotion $CGMotion
  StrCpy $CGAppearance 0
  StrCpy $CGAdvanced 0
  StrCpy $CGScope ""
FunctionEnd

Function CGData
  Call CGInitialize
  !insertmacro CGDialog "資料位置與舊資料" "程式與資料位置都由你決定；升級前請保存並結束 CaseGraph 與使用它的 MCP。"
  ${NSD_CreateLabel} 0 0 100% 20u "WebView2 用來顯示白板；若尚未安裝，稍後會顯示下載與安裝進度。"
  Pop $0
  ${If} $CGOldRoot != ""
    ${NSD_CreateRadioButton} 0 17u 100% 12u "沿用舊資料（保留原位置）"
    Pop $CGReuseControl
    ${NSD_CreateRadioButton} 0 30u 100% 12u "搬移目前專案與設定（保留來源作為備份）"
    Pop $CGMoveControl
    ${NSD_CreateRadioButton} 0 42u 100% 12u "建立新資料（舊資料保留）"
    Pop $CGNewControl
    ${If} $CGMode == "reuse"
      ${NSD_Check} $CGReuseControl
    ${ElseIf} $CGMode == "move"
      ${NSD_Check} $CGMoveControl
    ${Else}
      ${NSD_Check} $CGNewControl
    ${EndIf}
    ${NSD_OnClick} $CGReuseControl CGChangeMode
    ${NSD_OnClick} $CGMoveControl CGChangeMode
    ${NSD_OnClick} $CGNewControl CGChangeMode
  ${Else}
    ${NSD_CreateLabel} 0 19u 100% 27u "未發現舊資料。預設集中在安裝目錄的 data 資料夾；也可選 AppData 或自訂位置。"
    Pop $0
  ${EndIf}
  ${NSD_CreateLabel} 0 56u 100% 10u "設定與日誌資料夾"
  Pop $0
  ${NSD_CreateText} 0 67u 83% 14u "$CGRoot"
  Pop $CGRootControl
  ${NSD_CreateBrowseButton} 85% 67u 15% 14u "瀏覽…"
  Pop $0
  ${NSD_OnClick} $0 CGBrowseRoot
  ${NSD_CreateLabel} 0 81u 100% 10u "白板資料夾（內含 wall.db、聊天與備份）"
  Pop $0
  ${NSD_CreateText} 0 92u 83% 14u "$CGProject"
  Pop $CGProjectControl
  ${NSD_CreateBrowseButton} 85% 92u 15% 14u "瀏覽…"
  Pop $0
  ${NSD_OnClick} $0 CGBrowseProject
  ${NSD_CreateButton} 0 109u 47% 15u "使用安裝目錄下的 data"
  Pop $0
  ${NSD_OnClick} $0 CGUseInstall
  ${NSD_CreateButton} 51% 109u 49% 15u "使用目前帳號的 AppData"
  Pop $0
  ${NSD_OnClick} $0 CGUseAppData
  nsDialogs::Show
FunctionEnd
Function CGChangeMode
  Pop $0
  ${NSD_GetState} $CGReuseControl $1
  ${If} $1 == 1
    StrCpy $CGMode "reuse"
    StrCpy $CGRoot $CGOldRoot
    StrCpy $CGProject $CGOldProject
  ${Else}
    ${NSD_GetState} $CGMoveControl $1
    ${If} $1 == 1
      StrCpy $CGMode "move"
    ${Else}
      StrCpy $CGMode "new"
    ${EndIf}
    StrCpy $CGRoot "$INSTDIR\data"
    StrCpy $CGProject "$CGRoot\projects\default"
  ${EndIf}
  ${NSD_SetText} $CGRootControl $CGRoot
  ${NSD_SetText} $CGProjectControl $CGProject
FunctionEnd
Function CGBrowseRoot
  Pop $0
  nsDialogs::SelectFolderDialog "設定與日誌資料夾" "$CGRoot"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $CGRootControl $0
  ${EndIf}
FunctionEnd
Function CGBrowseProject
  Pop $0
  nsDialogs::SelectFolderDialog "白板資料夾" "$CGProject"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $CGProjectControl $0
  ${EndIf}
FunctionEnd
Function CGUseInstall
  Pop $0
  ${NSD_SetText} $CGRootControl "$INSTDIR\data"
  ${NSD_SetText} $CGProjectControl "$INSTDIR\data\projects\default"
FunctionEnd
Function CGUseAppData
  Pop $0
  ${NSD_SetText} $CGRootControl "$APPDATA\CaseGraph\CaseGraph"
  ${NSD_SetText} $CGProjectControl "$APPDATA\CaseGraph\CaseGraph\projects\default"
FunctionEnd
Function CGDataLeave
  ${NSD_GetText} $CGRootControl $CGRoot
  ${NSD_GetText} $CGProjectControl $CGProject
FunctionEnd

Function CGAi
  !insertmacro CGDialog "AI 與 Codex 連線" "選項可略過；不會替你安裝 AI CLI 或登入帳號。"
  ${NSD_CreateCheckbox} 0 4u 100% 16u "替 Codex 設定 CaseGraph MCP 連線"
  Pop $CGControl1
  ${NSD_SetState} $CGControl1 $CGMcp
  ${NSD_CreateLabel} 12u 21u 95% 23u "勾選後會建立或更新 Codex 的 detective-wall 連線，指向本次選擇的資料庫與執行檔。"
  Pop $0
  ${NSD_CreateCheckbox} 0 49u 100% 16u "允許 AI 提出白板修改（仍需逐項審核才能套用）"
  Pop $CGControl2
  ${NSD_SetState} $CGControl2 $CGProposals
  ${NSD_CreateCheckbox} 0 78u 100% 16u "顯示進階設定：服務埠、CLI 路徑與 AI 工作資料夾"
  Pop $CGControl3
  ${NSD_SetState} $CGControl3 $CGAdvanced
  ${NSD_CreateLabel} 0 100u 100% 23u "AI 讀取資料夾的授權在程式內設定；AI 工作資料夾不代表讀取授權。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function CGAiLeave
  ${NSD_GetState} $CGControl1 $CGMcp
  ${NSD_GetState} $CGControl2 $CGProposals
  ${NSD_GetState} $CGControl3 $CGAdvanced
FunctionEnd

Function CGAdvancedPage
  ${If} $CGAdvanced != 1
    Abort
  ${EndIf}
  !insertmacro CGDialog "進階設定" "CLI 路徑留空會自動從 PATH 尋找；AI 工作資料夾留空會使用專案下的 chat-workdir。"
  ${NSD_CreateLabel} 0 0 100% 12u "本機服務埠（1024–65535）"
  Pop $0
  ${NSD_CreateText} 0 11u 100% 14u "$CGPort"
  Pop $CGControl1
  ${NSD_CreateLabel} 0 27u 100% 10u "Claude Code 執行檔完整路徑（留空自動偵測）"
  Pop $0
  ${NSD_CreateText} 0 38u 83% 14u "$CGClaude"
  Pop $CGControl2
  ${NSD_CreateBrowseButton} 85% 38u 15% 14u "瀏覽…"
  Pop $0
  ${NSD_OnClick} $0 CGBrowseClaude
  ${NSD_CreateLabel} 0 55u 100% 10u "Codex CLI 執行檔完整路徑（留空自動偵測）"
  Pop $0
  ${NSD_CreateText} 0 65u 83% 14u "$CGCodex"
  Pop $CGControl3
  ${NSD_CreateBrowseButton} 85% 65u 15% 14u "瀏覽…"
  Pop $0
  ${NSD_OnClick} $0 CGBrowseCodex
  ${NSD_CreateLabel} 0 82u 100% 10u "AI 工作資料夾完整路徑（可留空）"
  Pop $0
  ${NSD_CreateText} 0 93u 83% 14u "$CGWorkdir"
  Pop $CGControl4
  ${NSD_CreateBrowseButton} 85% 93u 15% 14u "瀏覽…"
  Pop $0
  ${NSD_OnClick} $0 CGBrowseWorkdir
  nsDialogs::Show
FunctionEnd
Function CGBrowseClaude
  Pop $0
  nsDialogs::SelectFileDialog open "" "CLI 執行檔|*.exe;*.cmd;*.bat;*.js;*.cjs;*.mjs|所有檔案|*.*"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $CGControl2 $0
  ${EndIf}
FunctionEnd
Function CGBrowseCodex
  Pop $0
  nsDialogs::SelectFileDialog open "" "CLI 執行檔|*.exe;*.cmd;*.bat;*.js;*.cjs;*.mjs|所有檔案|*.*"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $CGControl3 $0
  ${EndIf}
FunctionEnd
Function CGBrowseWorkdir
  Pop $0
  nsDialogs::SelectFolderDialog "AI 工作資料夾" "$CGWorkdir"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $CGControl4 $0
  ${EndIf}
FunctionEnd
Function CGAdvancedLeave
  ${NSD_GetText} $CGControl1 $CGPort
  ${NSD_GetText} $CGControl2 $CGClaude
  ${NSD_GetText} $CGControl3 $CGCodex
  ${NSD_GetText} $CGControl4 $CGWorkdir
FunctionEnd

Function CGScopePage
  ${If} $CGMcp != 1
    Abort
  ${EndIf}
  !insertmacro CGDialog "Codex MCP 白板範圍" "連接 MCP 時確認白板讀取範圍；來源資料夾仍須另外授權。"
  ${NSD_CreateLabel} 0 4u 100% 30u "指定允許讀取的白板 ID，以逗號分隔。留空代表允許讀取目前專案的全部白板，包括之後新增的白板。"
  Pop $0
  ${NSD_CreateText} 0 38u 100% 15u "$CGScope"
  Pop $CGControl1
  ${NSD_CreateLabel} 0 61u 100% 34u "這只限制外部 MCP 的白板範圍，不改變本機 HTTP API。AI 修改提案仍依上一頁的選擇，且必須經過審核。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function CGScopeLeave
  ${NSD_GetText} $CGControl1 $CGScope
FunctionEnd

Function CGAppearancePage
  !insertmacro CGDialog "外觀（可略過）" "不勾選時保留既有偏好；全新安裝使用書頁黃、擬真便利貼、顯示桌寵與完整動畫。"
  ${NSD_CreateCheckbox} 0 0 100% 15u "套用以下外觀選擇（不勾選即略過）"
  Pop $CGControl1
  ${NSD_SetState} $CGControl1 $CGAppearance
  ${NSD_CreateLabel} 0 21u 100% 10u "背景"
  Pop $0
  ${NSD_CreateDropList} 0 31u 100% 100u ""
  Pop $CGControl2
  ${NSD_CB_AddString} $CGControl2 "白板色"
  ${NSD_CB_AddString} $CGControl2 "木紋"
  ${NSD_CB_AddString} $CGControl2 "書頁黃"
  ${NSD_CB_AddString} $CGControl2 "軟木"
  ${NSD_CB_AddString} $CGControl2 "月夜"
  ${NSD_CB_AddString} $CGControl2 "賽博"
  StrCpy $0 2
  ${Switch} $CGTheme
    ${Case} "whiteboard"
      StrCpy $0 0
      ${Break}
    ${Case} "wood"
      StrCpy $0 1
      ${Break}
    ${Case} "cork"
      StrCpy $0 3
      ${Break}
    ${Case} "moon"
      StrCpy $0 4
      ${Break}
    ${Case} "cyber"
      StrCpy $0 5
      ${Break}
  ${EndSwitch}
  SendMessage $CGControl2 ${CB_SETCURSEL} $0 0
  ${NSD_CreateLabel} 0 52u 100% 10u "卡片風格"
  Pop $0
  ${NSD_CreateDropList} 0 62u 100% 60u ""
  Pop $CGControl3
  ${NSD_CB_AddString} $CGControl3 "擬真便利貼"
  ${NSD_CB_AddString} $CGControl3 "科技"
  StrCpy $0 0
  ${If} $CGStyle == "tech"
    StrCpy $0 1
  ${EndIf}
  SendMessage $CGControl3 ${CB_SETCURSEL} $0 0
  ${NSD_CreateCheckbox} 0 85u 100% 16u "顯示 AI 桌寵"
  Pop $CGControl4
  ${NSD_SetState} $CGControl4 $CGMascot
  ${NSD_CreateCheckbox} 0 104u 100% 16u "減少動畫"
  Pop $CGControl5
  ${NSD_SetState} $CGControl5 $CGMotion
  ${NSD_OnChange} $CGControl2 CGAppearanceChanged
  ${NSD_OnChange} $CGControl3 CGAppearanceChanged
  ${NSD_OnClick} $CGControl4 CGAppearanceChanged
  ${NSD_OnClick} $CGControl5 CGAppearanceChanged
  nsDialogs::Show
FunctionEnd
Function CGAppearanceChanged
  Pop $0
  ${NSD_Check} $CGControl1
FunctionEnd
Function CGAppearanceLeave
  ${NSD_GetState} $CGControl1 $CGAppearance
  SendMessage $CGControl2 ${CB_GETCURSEL} 0 0 $0
  ${Switch} $0
    ${Case} 0
      StrCpy $CGTheme "whiteboard"
      ${Break}
    ${Case} 1
      StrCpy $CGTheme "wood"
      ${Break}
    ${Case} 2
      StrCpy $CGTheme "paper"
      ${Break}
    ${Case} 3
      StrCpy $CGTheme "cork"
      ${Break}
    ${Case} 4
      StrCpy $CGTheme "moon"
      ${Break}
    ${Case} 5
      StrCpy $CGTheme "cyber"
      ${Break}
  ${EndSwitch}
  SendMessage $CGControl3 ${CB_GETCURSEL} 0 0 $0
  StrCpy $CGStyle "paper"
  ${If} $0 == 1
    StrCpy $CGStyle "tech"
  ${EndIf}
  ${NSD_GetState} $CGControl4 $CGMascot
  ${NSD_GetState} $CGControl5 $CGMotion
FunctionEnd

Function CGSaveRequest
  !insertmacro CGWrite root $CGRoot
  !insertmacro CGWrite project $CGProject
  !insertmacro CGWrite mode $CGMode
  !insertmacro CGWrite port $CGPort
  !insertmacro CGWrite aiWorkdir $CGWorkdir
  !insertmacro CGWrite claude $CGClaude
  !insertmacro CGWrite codex $CGCodex
  !insertmacro CGWrite registerMcp $CGMcp
  !insertmacro CGWrite scope $CGScope
  !insertmacro CGWrite aiProposals $CGProposals
  !insertmacro CGWrite appearance $CGAppearance
  !insertmacro CGWrite theme $CGTheme
  !insertmacro CGWrite cardStyle $CGStyle
  !insertmacro CGWrite mascotVisible $CGMascot
  !insertmacro CGWrite reduceMotion $CGMotion
FunctionEnd
Function CGSummary
  !insertmacro CGDialog "確認安裝設定" "按安裝前會檢查路徑與權限。解除安裝預設保留資料，可另行選擇刪除。"
  ${NSD_CreateLabel} 0 0 100% 30u "程式：$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 24u 100% 23u "設定與日誌：$CGRoot"
  Pop $0
  ${NSD_CreateLabel} 0 49u 100% 23u "資料庫：$CGProject\wall.db"
  Pop $0
  StrCpy $1 "不設定"
  StrCpy $2 "關閉"
  ${If} $CGMcp == 1
    StrCpy $1 "設定"
  ${EndIf}
  ${If} $CGProposals == 1
    StrCpy $2 "開啟"
  ${EndIf}
  ${NSD_CreateLabel} 0 74u 100% 15u "服務埠：$CGPort　Codex MCP：$1　AI 提案：$2"
  Pop $0
  ${NSD_CreateLabel} 0 96u 100% 27u "請先保存並完整結束 CaseGraph 及連接它的 MCP。搬移會保留舊資料作為備份；其他專案與來源檔案不搬移。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function CGSummaryLeave
  Call CGSaveRequest
  ExecWait '"$PLUGINSDIR\casegraph-setup.exe" --installer validate "$CGRequest"' $0
  ${If} $0 != 0
    ReadINIStr $1 "$PLUGINSDIR\casegraph-request.result.ini" "setup" "error"
    MessageBox MB_OK|MB_ICONSTOP "請返回修改設定：$\r$\n$1"
    Abort
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  Call CGInitialize
  Call CGSaveRequest
  DetailPrint "正在建立資料與設定…"
  ExecWait '"$PLUGINSDIR\casegraph-setup.exe" --installer apply "$CGRequest"' $0
  ${If} $0 != 0
    ReadINIStr $1 "$PLUGINSDIR\casegraph-request.result.ini" "setup" "error"
    MessageBox MB_OK|MB_ICONSTOP "設定未完成，請保留錯誤訊息：$\r$\n$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState == 1
  ${AndIf} $UpdateMode != 1
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "確定刪除本次安裝設定中最近專案的白板資料庫、聊天紀錄、備份、設定與日誌？$\r$\n不會刪除來源檔案與舊版搬移備份。此動作無法復原。" IDYES +2
    Abort
    ExecWait '"$INSTDIR\casegraph.exe" --installer remove-data "$INSTDIR"' $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "資料無法完整刪除。請確認 CaseGraph 與 MCP 已結束，再重試；程式尚未移除。"
      Abort
    ${EndIf}
  ${EndIf}
!macroend
