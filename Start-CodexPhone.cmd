@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-SharedCodex.ps1" -WaitForDesktopExit
if errorlevel 1 pause
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Show-Connection.ps1"
pause
