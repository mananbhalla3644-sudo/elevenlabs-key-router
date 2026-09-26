@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:3000'"
echo Eleven KeyFlow is starting at http://127.0.0.1:3000
echo Keep this window open while using the dashboard. Press Ctrl+C to stop.
node server.js

if errorlevel 1 (
  echo.
  echo The server stopped because of an error.
  pause
)
