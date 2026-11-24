@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo [AnchorWheel] ERROR: Node.js ^>= 22 was not found in PATH.
  echo [AnchorWheel] Install Node.js from https://nodejs.org/ and run this script again.
  if /i not "%~1"=="--no-pause" pause
  exit /b 1
)
node "%~dp0scripts\install-plugin.mjs"
if errorlevel 1 (
  echo [AnchorWheel] Installation failed.
  if /i not "%~1"=="--no-pause" pause
  exit /b 1
)
echo [AnchorWheel] Deployed cleanly! Toggle AnchorWheel off and on in Antigravity plugins if it is already running.
if /i not "%~1"=="--no-pause" pause
exit /b 0
