!ifndef CASEGRAPH_MCP_INCLUDED
!define CASEGRAPH_MCP_INCLUDED
!include LogicLib.nsh
!include x64.nsh
!define CG_MCP_SCRIPT "${__FILEDIR__}\installer-mcp.ps1"

!macro CGStopMcp INSTALLDIR
  InitPluginsDir
  File /oname=$PLUGINSDIR\casegraph-mcp-stop.ps1 "${CG_MCP_SCRIPT}"
  ; NSIS is 32-bit; use native PowerShell to inspect the 64-bit MCP image.
  StrCpy $7 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    StrCpy $7 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToStack '"$7" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\casegraph-mcp-stop.ps1" -InstallDir "${INSTALLDIR}"'
  Pop $8
  Pop $9
  ${If} $8 == 2
    IfSilent +4
    MessageBox MB_OKCANCEL|MB_DEFBUTTON2|MB_ICONEXCLAMATION "CaseGraph MCP 仍由 Codex、Claude 或其他用戶端維持連線；關閉白板不會結束 MCP。$\r$\n按確定會中斷此安裝目錄的 MCP 連線，再繼續安裝或移除。" IDOK +3
    SetErrorLevel 1
    Abort
    nsExec::ExecToStack '"$7" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\casegraph-mcp-stop.ps1" -InstallDir "${INSTALLDIR}" -Stop'
    Pop $8
    Pop $9
    ${If} $8 == 0
      ; A host may reconnect immediately. Do not continue with a locked executable.
      nsExec::ExecToStack '"$7" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\casegraph-mcp-stop.ps1" -InstallDir "${INSTALLDIR}"'
      Pop $8
      Pop $9
    ${EndIf}
  ${EndIf}
  ${If} $8 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "無法結束此安裝目錄的 MCP，或用戶端已重新連線。請在 Codex／Claude 停用 CaseGraph MCP 後重試。$\r$\n$9"
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
!endif
