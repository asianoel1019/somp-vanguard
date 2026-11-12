@echo off
rem Starts the password change page from this folder (settings in .env next to this file).
cd /d "%~dp0"
if not exist node_modules (
    echo Installing packages...
    call npm install --omit=dev
    if errorlevel 1 exit /b 1
)
node src\server.js
