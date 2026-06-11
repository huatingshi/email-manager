@echo off
setlocal
chcp 65001 >nul
title Mail Collector

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js。
  echo        请前往 https://nodejs.org/ 下载并安装最新 LTS 版本，然后重试。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launcher.mjs"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo 启动器已退出 ^(code=%EXITCODE%^)。按任意键关闭窗口...
  pause >nul
)

exit /b %EXITCODE%
