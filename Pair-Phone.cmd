@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Show-Connection.ps1" -RenewPairing
pause
