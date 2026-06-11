@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
set EXITCODE=%ERRORLEVEL%

echo.
pause
exit /b %EXITCODE%
