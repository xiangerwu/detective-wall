@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "%~dp0launcher\CaseGraph.ps1" %*
exit /b %errorlevel%
