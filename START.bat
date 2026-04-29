@echo off
REM IMARA LINKS - Start Application
REM This file automatically runs the app

cd /d "%~dp0"

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies... (this only happens once)
    call npm install
    if errorlevel 1 (
        echo Error: npm install failed. Make sure Node.js is installed.
        echo Download from: https://nodejs.org
        pause
        exit /b 1
    )
)

REM Check backend dependencies
if not exist "backend\node_modules" (
    echo Installing backend dependencies...
    cd backend
    call npm install
    cd ..
    if errorlevel 1 (
        echo Error: backend npm install failed.
        pause
        exit /b 1
    )
)

REM Start the app
echo Starting IMARA LINKS...
npm run electron-dev
pause
