@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 兼容模式：关掉 DWM 毛玻璃（窗口发黑/整块透明时用）
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0desk-widget.ps1" -NoGlass
