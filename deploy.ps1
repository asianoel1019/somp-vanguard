# 1. Administrator Privilege Check
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "[!] ERROR: Please run this script as Administrator." -ForegroundColor Red
    exit
}

# Configuration
$SourcePath = $PSScriptRoot
$TargetPath = "C:\Program Files\somp-vanguard"
$ServiceName = "somp-vanguard"

Write-Host "`n--- System Environment Check ---" -ForegroundColor Cyan

# 2. Check Node.js
try {
    $nodeVer = node -v
    Write-Host "[OK] Node.js is installed ($nodeVer)" -ForegroundColor Green
} catch {
    Write-Host "[!] ERROR: Node.js not found. Please install Node.js from https://nodejs.org/" -ForegroundColor Red
    exit
}

# 3. Check npm
try {
    $npmVer = npm -v
    Write-Host "[OK] npm is installed (v$npmVer)" -ForegroundColor Green
} catch {
    Write-Host "[!] ERROR: npm not found. Please ensure Node.js is correctly installed." -ForegroundColor Red
    exit
}

# 4. Check Windows Server RSAT Features (AD & DNS Server Tools)
if (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) {
    Write-Host "`n--- Checking Windows Server RSAT Features ---" -ForegroundColor Cyan
    
    $adFeature = Get-WindowsFeature -Name RSAT-AD-PowerShell -ErrorAction SilentlyContinue
    $dnsFeature = Get-WindowsFeature -Name RSAT-DNS-Server -ErrorAction SilentlyContinue
    $gpmcFeature = Get-WindowsFeature -Name GPMC -ErrorAction SilentlyContinue

    if ($adFeature -and $adFeature.Installed) {
        Write-Host "[OK] RSAT Active Directory PowerShell Module is installed." -ForegroundColor Green
    } else {
        Write-Host "[!] WARNING: RSAT Active Directory Tools are missing. AD User Control features may fail." -ForegroundColor Yellow
        Write-Host "    -> Action: Run 'Install-WindowsFeature RSAT-AD-PowerShell' to enable AD administration." -ForegroundColor Yellow
    }

    if ($dnsFeature -and $dnsFeature.Installed) {
        Write-Host "[OK] RSAT DNS Server Tools are installed." -ForegroundColor Green
    } else {
        Write-Host "[!] WARNING: RSAT DNS Server Tools are missing. DNS Hub management features may fail." -ForegroundColor Yellow
        Write-Host "    -> Action: Run 'Install-WindowsFeature RSAT-DNS-Server' to enable DNS administration." -ForegroundColor Yellow
    }

    if ($gpmcFeature -and $gpmcFeature.Installed) {
        Write-Host "[OK] RSAT Group Policy Management Tools (GPMC) are installed." -ForegroundColor Green
    } else {
        Write-Host "[!] WARNING: RSAT Group Policy Management Tools are missing. GPO Manager features may fail." -ForegroundColor Yellow
        Write-Host "    -> Action: Run 'Install-WindowsFeature GPMC' to enable GPO administration." -ForegroundColor Yellow
    }
}

# 3.5. Stop existing service to release file locks
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "`n--- Stopping Service to Release File Locks ---" -ForegroundColor Cyan
    Write-Host "[*] Stopping existing somp-vanguard service..."
    $exePath = Join-Path $TargetPath "somp-vanguard.exe"
    if (Test-Path $exePath) {
        Set-Location $TargetPath
        .\somp-vanguard.exe stop
        Start-Sleep -Seconds 2
    } else {
        Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n--- Starting Deployment: SOMP Vanguard ---" -ForegroundColor Cyan

# 4. Create Target Directory and Sync Files
if (-not (Test-Path $TargetPath)) {
    Write-Host "[*] Creating target directory: $TargetPath"
    New-Item -ItemType Directory -Path $TargetPath -Force | Out-Null
}

Write-Host "[*] Syncing files (excluding node_modules)..."
# Using -Exclude with Copy-Item is sometimes flaky, better to use Robocopy if available or simple exclusion
# For maximum compatibility, we use Copy-Item with a loop or filter
Get-ChildItem -Path $SourcePath -Exclude "node_modules", ".git", "deploy.ps1" | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $TargetPath -Recurse -Force
}

# 5. Frontend Build
Write-Host "[*] Building Frontend..."
Set-Location "$TargetPath\frontend"
Write-Host "    -> Aligning frontend dependencies (npm install)..."
npm install --no-audit --no-fund --silent
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] ERROR: Frontend build failed. Deployment aborted." -ForegroundColor Red
    exit
}

# 6. Backend Dependencies
Write-Host "[*] Configuring Backend dependencies..."
Set-Location "$TargetPath\backend"
Write-Host "    -> Aligning backend dependencies (npm install)..."
npm install --no-audit --no-fund --silent

# 7. Register/Restart Windows Service
Write-Host "[*] Configuring and starting Windows Service..."
Set-Location $TargetPath

# DYNAMIC XML UPDATE: Ensure paths in XML match the target directory
$xmlFile = Join-Path $TargetPath "somp-vanguard.xml"
if (Test-Path $xmlFile) {
    Write-Host "    -> Updating service configuration paths..."
    $xml = [xml](Get-Content $xmlFile)
    $xml.service.arguments = "--max-old-space-size=2048 `"$TargetPath\backend\index.js`""
    $xml.service.workingdirectory = "$TargetPath\backend"
    $xml.Save($xmlFile)
}

# If service exists, stop and uninstall it first to ensure clean update
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "    -> Existing service detected. Resetting..."
    .\somp-vanguard.exe stop
    .\somp-vanguard.exe uninstall
}

# WinSW Install and Start
.\somp-vanguard.exe install
if ($LASTEXITCODE -eq 0) {
    .\somp-vanguard.exe start
    Write-Host "[OK] Service installed and started successfully." -ForegroundColor Green
} else {
    Write-Host "[!] ERROR: Service installation failed." -ForegroundColor Red
}

# 8. Operation Summary
$separator = "=" * 50
Write-Host "`n$separator" -ForegroundColor Green
Write-Host "      Deployment Completed Successfully!" -ForegroundColor Green
Write-Host "$separator" -ForegroundColor Green
Write-Host "`nManagement Commands (run inside $TargetPath):"
Write-Host "  Start Service:   .\somp-vanguard.exe start"
Write-Host "  Stop Service:    .\somp-vanguard.exe stop"
Write-Host "  Restart Service: .\somp-vanguard.exe restart"
Write-Host "  View Status:     .\somp-vanguard.exe status"
Write-Host "  Uninstall:       .\somp-vanguard.exe uninstall"
Write-Host "`nAccess URL: http://localhost:8080" -ForegroundColor Yellow
Write-Host "$separator" -ForegroundColor Green
