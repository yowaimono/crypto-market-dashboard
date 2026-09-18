@echo off
setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>&1
  echo   ???????? %%a
  set FOUND=1
)
if "!FOUND!"=="0" echo   8787 ???????????§Ö????
timeout /t 3 >nul
