@echo off
REM IMARA LINKS - Build Windows installer for users

setlocal
cd /d "%~dp0"

if not exist "node_modules\electron-builder" (
    echo Build tools are missing.
    echo Run SETUP-DEV.bat first, then run this file again.
    echo.
    pause
    exit /b 1
)

echo Building IMARA LINKS Windows installer...
echo.

call npm run build:win
if errorlevel 1 (
    echo.
    echo Build failed. Check the messages above.
    pause
    exit /b 1
)

echo.
echo Build complete. Check the dist folder for the installer.
pause
