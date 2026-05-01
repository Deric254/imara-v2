@echo off
REM IMARA LINKS - Publish an update to GitHub Releases
REM Requires GH_TOKEN with permission to create releases/upload release assets.

setlocal
cd /d "%~dp0"

if "%GH_TOKEN%"=="" (
    echo GH_TOKEN is not set.
    echo.
    echo Create a GitHub token with release permission, then run:
    echo set GH_TOKEN=your_token_here
    echo PUBLISH-UPDATE.bat
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\electron-builder" (
    echo Build tools are missing.
    echo Run SETUP-DEV.bat first, then run this file again.
    echo.
    pause
    exit /b 1
)

echo Publishing IMARA LINKS update to GitHub Releases...
echo.

call npm run publish:win
if errorlevel 1 (
    echo.
    echo Publish failed. Check the messages above.
    pause
    exit /b 1
)

echo.
echo Publish complete. Installed apps can now find this version from Help - Check for Updates.
pause
