@echo off
REM IMARA LINKS - Developer ZIP launcher
REM Normal startup must not install dependencies. Run SETUP-DEV.bat once if needed.

setlocal
cd /d "%~dp0"

if not exist "node_modules\electron" (
    echo IMARA LINKS cannot start because developer dependencies are missing.
    echo.
    echo Run SETUP-DEV.bat once, then start the app again.
    echo For customer machines, build and share the installer instead of this ZIP.
    echo.
    pause
    exit /b 1
)

echo Starting IMARA LINKS...
npm run electron-dev
