@echo off
REM IMARA LINKS - Start Application (Hidden Mode)
REM This file runs silently without showing the console window to users

setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Check if dependencies are installed
if not exist "node_modules" (
    call npm install >nul 2>&1
    if errorlevel 1 (
        echo Error: npm install failed. Make sure Node.js is installed from https://nodejs.org
        timeout /t 5 >nul
        exit /b 1
    )
)

REM Check backend dependencies
if not exist "backend\node_modules" (
    cd backend
    call npm install >nul 2>&1
    cd ..
    if errorlevel 1 (
        echo Error: backend npm install failed.
        timeout /t 5 >nul
        exit /b 1
    )
)

REM Start the app (npm will open Electron window directly, no cmd window)
npm run electron-dev >nul 2>&1
