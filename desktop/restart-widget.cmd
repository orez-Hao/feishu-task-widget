@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 结束旧实例 ===
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-widget.ps1"
timeout /t 1 /nobreak >nul
echo === 启动新实例 ===
start "" wscript.exe "%~dp0start-widget.vbs"
timeout /t 3 /nobreak >nul
set "LOGFILE=%USERPROFILE%\.feishu-task-widget\state\widget.log"
if defined FEISHU_TASK_DATA set "LOGFILE=%FEISHU_TASK_DATA%\state\widget.log"
if exist "%LOGFILE%" (echo --- widget.log 最后 12 行 --- & powershell.exe -NoProfile -Command "Get-Content -Tail 12 -Encoding UTF8 '%LOGFILE%'")
echo.
pause
