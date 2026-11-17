@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js 20 or newer.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found. Run this command first:
  echo   npm install -g pnpm
  pause
  exit /b 1
)

if not exist "node_modules\.pnpm" (
  echo Installing dependencies for the first time. Please wait...
  call pnpm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed. Check your network and try again.
    pause
    exit /b 1
  )
)

echo Starting Yisi Image Tool...
call pnpm dev --open
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. See the messages above.
  pause
)

endlocal
