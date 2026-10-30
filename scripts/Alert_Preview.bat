@echo off
setlocal
set "_NODE=node"
where node >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "_NODE=%ProgramFiles%\nodejs\node.exe"
    ) else (
        echo Node.js not found. Install Node.js or add it to PATH.
        exit /b 1
    )
)
for /f "tokens=2 delims=:." %%a in ('chcp') do set _OLDCP=%%a
chcp 65001 >nul
"%_NODE%" "%~dp0alert_preview.js" %*
set _RC=%errorlevel%
chcp %_OLDCP% >nul
endlocal & exit /b %_RC%
