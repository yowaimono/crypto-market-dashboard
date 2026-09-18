@echo off
cd /d "%~dp0"
title crypto-market-dashboard

netstat -ano | findstr ":8787" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo   服务已经在运行，直接打开看板...
  start "" http://127.0.0.1:8787
  exit /b 0
)

echo.
echo   crypto-market-dashboard
echo   ---------------------------------------
echo   正在启动   http://127.0.0.1:8787
echo   首次启动要先扫全市场，约 10-20 秒后出数
echo   关闭本窗口 = 停止服务
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:8787'"
node server.js
echo.
echo   服务已退出，按任意键关闭窗口。
pause >nul
