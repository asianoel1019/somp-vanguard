@echo off
set GOENV=%USERPROFILE%\go-install\go\bin;%PATH%
set PATH=%GOENV%

echo Cleaning build directories...
if exist installer\payload rmdir /s /q installer\payload
mkdir installer\payload

echo 1. Compiling Scout Agent (Payload)...
go build -ldflags "-s -w" -o installer\payload\scout-agent.exe
if %ERRORLEVEL% NEQ 0 (
    echo Go build failed!
    exit /b %ERRORLEVEL%
)

echo 2. Copying Windows Service Wrapper...
if exist scout.exe (
    copy scout.exe installer\payload\scout.exe
) else (
    echo [ERROR] scout.exe not found!
    exit /b 1
)

echo 3. Generating scout.xml (WinSW config)...
echo ^<service^> > installer\payload\scout.xml
echo   ^<id^>ScoutAgent^</id^> >> installer\payload\scout.xml
echo   ^<name^>ScoutAgent^</name^> >> installer\payload\scout.xml
echo   ^<description^>Vanguard System Operation Manager Scout Agent.^</description^> >> installer\payload\scout.xml
echo   ^<executable^>%%BASE%%\scout-agent.exe^</executable^> >> installer\payload\scout.xml
echo   ^<log mode="roll-by-size"^> >> installer\payload\scout.xml
echo     ^<sizeThreshold^>102400^</sizeThreshold^> >> installer\payload\scout.xml
echo     ^<keepFiles^>10^</keepFiles^> >> installer\payload\scout.xml
echo   ^</log^> >> installer\payload\scout.xml
echo   ^<onfailure action="restart" delay="10 sec"/^> >> installer\payload\scout.xml
echo ^</service^> >> installer\payload\scout.xml

echo 4. Copying default config.json...
if exist config.json (
    copy config.json installer\payload\config.json
) else (
    echo { > installer\payload\config.json
    echo   "apiKey": "CHANGE_ME", >> installer\payload\config.json
    echo   "backendUrl": "http://localhost:8080", >> installer\payload\config.json
    echo   "reportInterval": 60, >> installer\payload\config.json
    echo   "pingTargets": [], >> installer\payload\config.json
    echo   "tcpTargets": [], >> installer\payload\config.json
    echo   "watchServices": [], >> installer\payload\config.json
    echo   "watchProcesses": [] >> installer\payload\config.json
    echo } >> installer\payload\config.json
)

echo 5. Compiling Installer...
cd installer
go mod init installer 2>nul
go build -ldflags "-s -w" -o ..\scout-win-installer.exe installer.go
cd ..

echo ========================================
echo Build complete! 
echo 
echo File generated: scout-win-installer.exe (Self-Extracting Service Installer)
echo You can copy this file directly to any target server and run it.
echo ========================================
