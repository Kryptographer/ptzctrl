@echo off
setlocal
title PTZ Controller - Build

echo ============================================
echo  PTZ Controller - Windows build script
echo ============================================
echo.

rem Run from the folder this script lives in
cd /d "%~dp0"

rem ---- Check prerequisites -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this system.
    echo         Download and install it from https://nodejs.org/
    echo         then run this script again.
    goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found. Reinstall Node.js from https://nodejs.org/
    goto :fail
)

for /f "delims=" %%v in ('node --version') do set NODE_VERSION=%%v
echo [1/3] Node.js %NODE_VERSION% found.
echo.

rem ---- Install dependencies ------------------------------------------------
echo [2/3] Installing dependencies (this can take a few minutes the first time)...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    goto :fail
)
echo.

rem ---- Build the installer -------------------------------------------------
echo [3/3] Building the Windows installer...
call npm run dist
if errorlevel 1 (
    echo [ERROR] Build failed. See the messages above for details.
    goto :fail
)
echo.

echo ============================================
echo  BUILD SUCCESSFUL
echo ============================================
echo.
echo  The installer is in the "dist" folder:
if exist "dist" (
    for %%f in ("dist\*.exe") do echo    %%f
)
echo.
echo  Run it to install PTZ Controller.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
