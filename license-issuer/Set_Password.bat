@echo off
rem Sets the sign-in password of the license issuer (writes PASSWORD_HASH to .env next to this file).
cd /d "%~dp0"
node src\setPassword.js
if errorlevel 1 pause
