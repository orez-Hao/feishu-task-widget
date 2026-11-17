@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 飞书任务便签 诊断启动 ===
echo 出错信息会直接显示在下面，也会写进数据目录的 state\widget.log
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desk-widget.ps1" 2>&1
echo.
echo === 退出码 %ERRORLEVEL% ===
set "LOGFILE=%USERPROFILE%\.feishu-task-widget\state\widget.log"
if defined FEISHU_TASK_DATA set "LOGFILE=%FEISHU_TASK_DATA%\state\widget.log"
if exist "%LOGFILE%" (echo --- widget.log 最后 20 行 --- & powershell.exe -NoProfile -Command "Get-Content -Tail 20 -Encoding UTF8 '%LOGFILE%'")
pause
