@echo off
setlocal
rem Starts the password change page from this folder (settings in .env next to this file).
rem Installs the packages on the first run and again whenever package-lock.json changes (after an update).
cd /d "%~dp0"
title pwdchange

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js not found. Install Node.js 20 or later and run this file again.
    pause
    exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number),[x,y]=[20,0];process.exit(a>x||(a===x&&b>=y)?0:1)"
if errorlevel 1 (
    for /f %%v in ('node -v') do echo Node.js %%v is too old: 20 or later is required.
    pause
    exit /b 1
)

set "MARK=node_modules\.installed-package-lock.json"
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if not exist "%MARK%" set "NEED_INSTALL=1"
if not defined NEED_INSTALL (
    fc /b package-lock.json "%MARK%" >nul 2>&1
    if errorlevel 1 set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
    echo Installing packages...
    call npm ci --omit=dev
    if errorlevel 1 (
        echo Package installation failed. Check the network or proxy settings and run this file again.
        pause
        exit /b 1
    )
    copy /y package-lock.json "%MARK%" >nul
)

node src\server.js
set "RC=%errorlevel%"
if not "%RC%"=="0" pause
exit /b %RC%
