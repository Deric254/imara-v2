@echo off
REM IMARA LINKS - Developer setup
REM Run this once after cloning or unzipping the source project.

setlocal
cd /d "%~dp0"

echo Installing IMARA LINKS developer dependencies...
echo This can take a few minutes the first time.
echo.

call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo Setup failed. Check your internet connection and Node.js installation.
    pause
    exit /b 1
)

echo.
echo Setup complete. You can now run START.bat or START.vbs.
pause
