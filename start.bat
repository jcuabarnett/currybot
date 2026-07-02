@echo off
title CurryBot
echo.
echo  ============================================
echo    CurryBot - Starting up...
echo  ============================================
echo.
cd /d "%~dp0"

echo  [1/2] Checking dependencies...
call npm install --silent 2>nul
if errorlevel 1 (
    echo  ERROR: npm install failed. Is Node.js installed?
    pause
    exit /b 1
)
echo  [1/2] Dependencies OK.
echo.
echo  [2/2] Starting server...
echo.

:: Open browser after a short delay (server needs ~2 seconds to start)
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the server (this stays open — closing this window stops the app)
node server.js

echo.
echo  Server stopped.
pause
