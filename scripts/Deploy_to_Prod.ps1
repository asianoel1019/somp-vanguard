<#
.SYNOPSIS
    Deploy_to_Prod.ps1 - Deploys files from staging directory (Path A) to production directory (Path B).
.DESCRIPTION
    1. Copies and replaces all non-excluded files from Path A (Source) to Path B (Target).
    2. Supports custom exclusion patterns configured in the variables section.
    3. Automatically detects if any backend files are updated.
    4. If backend files are updated, safely stops service before copy and restarts it afterwards.
    5. If only frontend static assets are updated, the service keeps running with zero downtime.
.EXAMPLE
    .\scripts\Deploy_to_Prod.ps1
#>

# ==============================================================================
# CONFIGURATION SETTINGS (Edit as needed)
# ==============================================================================
$PathA       = "C:\somp-staging"                       # Path A: Source staging directory (e.g. SCP upload target)
$PathB       = "C:\Program Files\somp-vanguard"        # Path B: Target production directory
$ServiceName = "somp-vanguard"                         # Windows Service name

# Files or folders to exclude from copying (Wildcard patterns supported)
$ExcludeList = @(
    "*node_modules*",
    "*.git*",
    "*.vscode*",
    "*.log",
    "*.tmp",
    ".last_scp_sync",
    "*SCP_to_Prod.ps1*",
    "*Deploy_to_Prod.ps1*",
    "*Update_Version.ps1*"
    # Add any additional files or folders to exclude here, for example:
    # "*.env*",
    # "*database.sqlite*"
)
# ==============================================================================

# Helper function to check if a relative path matches any pattern in $ExcludeList
function Test-IsExcluded {
    param(
        [string]$Path,
        [string[]]$Patterns
    )
    foreach ($pattern in $Patterns) {
        if ($pattern -and ($Path -like $pattern)) {
            return $true
        }
    }
    return $false
}

# 1. Administrator Privilege Check
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "[ERROR] Administrator privileges required. Please run PowerShell as Administrator." -ForegroundColor Red
    exit 1
}

# 2. Directory Existence Check
if (-not (Test-Path $PathA)) {
    Write-Host ""
    Write-Host "[ERROR] Source staging directory (Path A) not found: $PathA" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $PathB)) {
    Write-Host "[INFO] Target directory does not exist. Creating: $PathB" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $PathB -Force | Out-Null
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " SOMP Vanguard - Production Deployment Script (Deploy_to_Prod)" -ForegroundColor Cyan
Write-Host " Source Path (A) : $PathA"
Write-Host " Target Path (B) : $PathB"
Write-Host " Service Name    : $ServiceName"
Write-Host " Exclude Rules   : $($ExcludeList.Count) patterns configured"
Write-Host "========================================================"
Write-Host ""

# 3. Scan all files in Path A (applying exclusion filter)
$sourceFiles = Get-ChildItem -Path $PathA -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($PathA.Length).TrimStart('\', '/')
    $excluded = Test-IsExcluded -Path $rel -Patterns $ExcludeList
    if ($excluded) {
        return $false
    }
    return $true
}

if ($sourceFiles.Count -eq 0) {
    Write-Host "[WARNING] Source directory ($PathA) contains no eligible files to deploy." -ForegroundColor Yellow
    exit 0
}

$backendFilesChanged = @()
$frontendFilesChanged = @()
$otherFilesChanged = @()

# Compare files between Path A and Path B
foreach ($file in $sourceFiles) {
    $relPath = $file.FullName.Substring($PathA.Length).TrimStart('\', '/')
    $destFile = Join-Path $PathB $relPath

    $isChanged = $true
    if (Test-Path $destFile) {
        $destItem = Get-Item $destFile
        # If size and last write time match, mark as unchanged
        if ($destItem.Length -eq $file.Length -and $destItem.LastWriteTime -eq $file.LastWriteTime) {
            $isChanged = $false
        }
    }

    if ($isChanged) {
        if ($relPath -like "backend\*" -or $relPath -like "backend/*" -or $relPath -eq "package.json") {
            $backendFilesChanged += $relPath
        } elseif ($relPath -like "frontend\*" -or $relPath -like "frontend/*") {
            $frontendFilesChanged += $relPath
        } else {
            $otherFilesChanged += $relPath
        }
    }
}

$hasBackendChanges = ($backendFilesChanged.Count -gt 0)
$totalChanged = $backendFilesChanged.Count + $frontendFilesChanged.Count + $otherFilesChanged.Count

Write-Host "[INFO] File Change Analysis Summary:" -ForegroundColor Cyan
$backendColor = "Gray"
if ($hasBackendChanges) { $backendColor = "Yellow" }
$frontendColor = "Gray"
if ($frontendFilesChanged.Count -gt 0) { $frontendColor = "Green" }
$otherColor = "Gray"
if ($otherFilesChanged.Count -gt 0) { $otherColor = "Cyan" }

Write-Host "  - Backend files modified : $($backendFilesChanged.Count)" -ForegroundColor $backendColor
Write-Host "  - Frontend files modified: $($frontendFilesChanged.Count)" -ForegroundColor $frontendColor
Write-Host "  - Other files modified   : $($otherFilesChanged.Count)" -ForegroundColor $otherColor
Write-Host "  - Total changed files    : $totalChanged" -ForegroundColor White

# --- Show changed file list ---
if ($totalChanged -eq 0) {
    Write-Host ""
    Write-Host "[INFO] No file changes detected between staging and production. Nothing to deploy." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
Write-Host " Changed Files to be Deployed ($totalChanged total):" -ForegroundColor White
Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray

if ($backendFilesChanged.Count -gt 0) {
    Write-Host "  [Backend]" -ForegroundColor Yellow
    foreach ($f in $backendFilesChanged) {
        Write-Host "    + $f" -ForegroundColor Yellow
    }
}
if ($frontendFilesChanged.Count -gt 0) {
    Write-Host "  [Frontend]" -ForegroundColor Green
    foreach ($f in $frontendFilesChanged) {
        Write-Host "    + $f" -ForegroundColor Green
    }
}
if ($otherFilesChanged.Count -gt 0) {
    Write-Host "  [Other]" -ForegroundColor Cyan
    foreach ($f in $otherFilesChanged) {
        Write-Host "    + $f" -ForegroundColor Cyan
    }
}
Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# --- Confirmation Prompt (default: Yes) ---
$confirm = Read-Host "Proceed with deployment? [Y/n] (default: Y)"
if ($confirm -eq '' ) { $confirm = 'Y' }
if ($confirm -notmatch '^[Yy]$') {
    Write-Host ""
    Write-Host "[CANCELLED] Deployment aborted by user." -ForegroundColor Red
    exit 0
}
Write-Host ""

# 4. If backend files are updated and service is running, stop it to prevent file locks
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$wasRunning = ($svc -and ($svc.Status -eq "Running"))

if ($hasBackendChanges -and $wasRunning) {
    Write-Host ""
    Write-Host "[INFO] Backend changes detected. Stopping service '$ServiceName' to release file locks..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 5. Copy and overwrite files from Path A to Path B
Write-Host ""
Write-Host "[INFO] Copying and overwriting files from Path A to Path B..." -ForegroundColor Cyan
$copiedCount = 0
foreach ($file in $sourceFiles) {
    $relPath = $file.FullName.Substring($PathA.Length).TrimStart('\', '/')
    $destFile = Join-Path $PathB $relPath
    $destDir = Split-Path $destFile -Parent

    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    Copy-Item -Path $file.FullName -Destination $destFile -Force
    $copiedCount++
}
Write-Host "[OK] File copy complete. Processed $copiedCount file(s)." -ForegroundColor Green

# 6. Service restart determination
if ($hasBackendChanges) {
    Write-Host ""
    Write-Host "[INFO] Restarting Windows Service: $ServiceName (Restart-Service)..." -ForegroundColor Yellow
    if ($svc) {
        Restart-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 3
        $currentStatus = (Get-Service -Name $ServiceName).Status
        if ($currentStatus -eq "Running") {
            Write-Host "[OK] Service '$ServiceName' restarted successfully! (Status: $currentStatus)" -ForegroundColor Green
        } else {
            Write-Host "[WARNING] Service status after restart: $currentStatus. Please inspect system logs." -ForegroundColor Yellow
        }
    } else {
        Write-Host "[WARNING] Service '$ServiceName' not found. Please verify service name." -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "[INFO] Only frontend static files were updated (no backend changes). Service '$ServiceName' kept running with zero downtime!" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " Production deployment completed successfully!" -ForegroundColor Green
Write-Host "========================================================"
Write-Host ""
