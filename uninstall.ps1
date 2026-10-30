# 1. Administrator Privilege Check
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "[!] ERROR: Please run this script as Administrator." -ForegroundColor Red
    exit
}

$ServiceName = "somp-vanguard"
$TargetPath = "C:\Program Files\somp-vanguard"

Write-Host "`n--- Starting Uninstallation: $ServiceName ---" -ForegroundColor Cyan

# 2. Stop and Uninstall Service
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "[*] Stopping existing $ServiceName service..."
    $exePath = Join-Path $TargetPath "somp-vanguard.exe"
    
    if (Test-Path $exePath) {
        Set-Location $TargetPath
        .\somp-vanguard.exe stop
        Start-Sleep -Seconds 2
        
        Write-Host "[*] Uninstalling $ServiceName service..."
        .\somp-vanguard.exe uninstall
        Start-Sleep -Seconds 2
    } else {
        Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
        Write-Host "[!] Warning: somp-vanguard.exe not found. You may need to manually remove the service via 'sc delete somp-vanguard'." -ForegroundColor Yellow
    }
} else {
    Write-Host "[*] Service $ServiceName is not installed or already removed." -ForegroundColor Yellow
}

# 3. Backup Configuration
$envPath = Join-Path $TargetPath "backend\.env"
if (Test-Path $envPath) {
    $backupPath = Join-Path [Environment]::GetFolderPath("Desktop") "somp-vanguard-backup.env"
    Copy-Item -Path $envPath -Destination $backupPath -Force
    Write-Host "[*] Backed up backend\.env to your Desktop: $backupPath" -ForegroundColor Green
}

# 4. Remove Files
Set-Location "C:\" # Move out of the directory to release file locks
Start-Sleep -Seconds 2

if (Test-Path $TargetPath) {
    Write-Host "[*] Removing installation directory: $TargetPath..."
    try {
        Remove-Item -Path $TargetPath -Recurse -Force -ErrorAction Stop
        Write-Host "[OK] Directory removed successfully." -ForegroundColor Green
    } catch {
        Write-Host "[!] Warning: Could not completely remove $TargetPath. Files might be in use." -ForegroundColor Yellow
        Write-Host "    Please manually delete the folder after closing any open files." -ForegroundColor Yellow
    }
}

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "      Uninstallation Completed Successfully!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "You can now proceed to deploy the new project 'somp-vanguard'." -ForegroundColor Cyan
