@echo off
rem Start the OpenICQ server and open the client. Windows.

setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=5190

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on your PATH.
  echo.
  echo   Install it with:  winget install OpenJS.NodeJS.LTS
  echo   Or download from: https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)

start "" http://localhost:%PORT%
node "%~dp0server\index.js" --port %PORT% %*

endlocal
