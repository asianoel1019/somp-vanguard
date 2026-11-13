<#
.SYNOPSIS
    Deploy_to_Prod.ps1 - Deploys files from staging directory (Path A) to production directory (Path B).
.DESCRIPTION
    1. Copies the non-excluded files of Path A (Source) that differ from Path B (Target).
    2. Supports custom exclusion patterns configured in the variables section.
    3. Automatically detects if any backend files are updated.
    4. If backend files (or files the running service holds open: *.exe, *.dll, *.node) are updated, stops the
       service before the copy, waits for it to exit and restarts it afterwards.
    5. Only the changed files are copied; if only frontend static assets changed, the service keeps running.
    6. -Backup : before deploying, saves a copy of the current production files (same exclusions as the deploy,
                 plus databases / logs) to $BackupRoot\<yyyyMMdd-HHmmss>. Keeps the newest $BackupKeep copies.
    7. -Recover: lists the copies in $BackupRoot, lets you pick one and restores it to Path B (no deploy).
.EXAMPLE
    .\scripts\Deploy_to_Prod.ps1
.EXAMPLE
    .\scripts\Deploy_to_Prod.ps1 -Backup
.EXAMPLE
    .\scripts\Deploy_to_Prod.ps1 -Recover
#>
param(
    [switch]$Backup,   # Back up the current production files before deploying
    [switch]$Recover   # Restore production from one of the backups (asks which one)
)

# ==============================================================================
# CONFIGURATION SETTINGS (Edit as needed)
# ==============================================================================
$PathA       = "C:\somp-staging"                       # Path A: Source staging directory (e.g. SCP upload target)
$PathB       = "C:\Program Files\somp-vanguard"        # Path B: Target production directory
$ServiceName = "somp-vanguard"                         # Windows Service name
$BackupRoot  = "C:\somp-backups"                       # Where -Backup stores copies and -Recover looks for them
$BackupKeep  = 10                                      # Number of backups kept (oldest are deleted)

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

# Additionally left out of backups: runtime data that is not part of a release
$BackupExtraExclude = @(
    "*.sqlite",
    "*.sqlite-wal",
    "*.sqlite-shm",
    "*.db",
    "*.bak",
    "logs\*",
    "*\logs\*"
)

# Restored by -Recover only when you confirm it (settings may have changed since the backup)
$RecoverAskFiles = @("backend\.env")
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

# Files under $Root (relative paths) that match none of $Patterns. Excluded folders (node_modules, .git, logs ...)
# are not entered at all, so a large node_modules in production does not slow the scan down.
function Get-RelativeFiles {
    param(
        [string]$Root,
        [string[]]$Patterns
    )
    $rootFull = (Resolve-Path $Root).Path.TrimEnd('\')
    $result = New-Object System.Collections.Generic.List[object]
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($rootFull)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        foreach ($entry in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            $rel = $entry.FullName.Substring($rootFull.Length).TrimStart('\', '/')
            if ($entry.PSIsContainer) {
                if (-not (Test-IsExcluded -Path $rel -Patterns $Patterns) -and -not (Test-IsExcluded -Path "$rel\" -Patterns $Patterns)) {
                    $pending.Push($entry.FullName)
                }
            } elseif (-not (Test-IsExcluded -Path $rel -Patterns $Patterns)) {
                $result.Add([pscustomobject]@{ Rel = $rel; Item = $entry })
            }
        }
    }
    return $result.ToArray()   # callers wrap the call in @() so 0 or 1 file is still an array
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ("{0:N2} GB" -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ("{0:N1} MB" -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ("{0:N0} KB" -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

# Version in backend\package.json of a directory, or '?'
function Get-AppVersion {
    param([string]$Root)
    $pkg = Join-Path $Root "backend\package.json"
    if (Test-Path $pkg) {
        try { return (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { }
    }
    return "?"
}

function Test-IsBackendPath {
    param([string]$Rel)
    return ($Rel -like "backend\*" -or $Rel -like "backend/*" -or $Rel -eq "package.json")
}

# Files the running service keeps open (the service executable, native modules): replacing them needs a stop
function Test-IsLockedByService {
    param([string]$Rel)
    $ext = [System.IO.Path]::GetExtension($Rel).ToLower()
    return ($ext -eq ".exe" -or $ext -eq ".dll" -or $ext -eq ".node")
}

# A change that needs the service stopped during the copy and restarted afterwards
function Test-NeedsServiceStop {
    param([string]$Rel)
    return ((Test-IsBackendPath $Rel) -or (Test-IsLockedByService $Rel))
}

# Stops the service and waits (up to $TimeoutSec) until it reports Stopped and no process started from Path B
# is left, so their files are no longer locked. Returns $true when it stopped in time.
function Stop-ProdService {
    param([int]$TimeoutSec = 60)
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $prodRoot = (Resolve-Path -LiteralPath $PathB -ErrorAction SilentlyContinue)
    while ((Get-Date) -lt $deadline) {
        $status = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
        $running = @()
        if ($prodRoot) {
            $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
                try { $_.Path -and $_.Path.StartsWith($prodRoot.Path, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
            })
        }
        if ($status -ne "Running" -and $status -ne "StopPending" -and $running.Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "[WARNING] Service '$ServiceName' or its processes did not exit within $TimeoutSec seconds." -ForegroundColor Yellow
    return $false
}

# Copies one file, retrying while it is locked (a process may take a moment to release it). Throws on failure.
function Copy-WithRetry {
    param([string]$Source, [string]$Dest, [int]$Attempts = 5)
    $destDir = Split-Path $Dest -Parent
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Dest -Force -ErrorAction Stop
            return
        } catch [System.IO.IOException] {
            if ($i -eq $Attempts) { throw }
            Start-Sleep -Seconds $i
        }
    }
}

# Copies the production files (deploy exclusions + backup exclusions) to a new folder in $BackupRoot.
# Returns the folder path; throws on failure so the caller can stop before touching production.
function New-ProdBackup {
    param([string]$Reason)
    if (-not (Test-Path $PathB)) { throw "Production directory not found: $PathB" }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dest = Join-Path $BackupRoot $stamp
    $n = 1
    while (Test-Path $dest) { $dest = Join-Path $BackupRoot "$stamp-$n"; $n++ }

    Write-Host "[INFO] Backing up production files to $dest ..." -ForegroundColor Cyan
    $files = @(Get-RelativeFiles -Root $PathB -Patterns ($ExcludeList + $BackupExtraExclude))
    if ($files.Count -eq 0) { throw "No files to back up in $PathB" }

    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $bytes = 0
    foreach ($f in $files) {
        $target = Join-Path $dest $f.Rel
        $dir = Split-Path $target -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item -LiteralPath $f.Item.FullName -Destination $target -Force -ErrorAction Stop
        $bytes += $f.Item.Length
    }

    $manifest = [ordered]@{
        createdAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        version   = Get-AppVersion -Root $PathB
        reason    = $Reason
        files     = $files.Count
        bytes     = $bytes
        source    = $PathB
        computer  = $env:COMPUTERNAME
        user      = $env:USERNAME
    }
    [IO.File]::WriteAllText((Join-Path $dest "_backup_manifest.json"), ($manifest | ConvertTo-Json))
    Write-Host "[OK] Backup complete: $($files.Count) file(s), $(Format-Size $bytes), version $($manifest.version)." -ForegroundColor Green

    # Retention: keep the newest $BackupKeep backups (only folders this script created, i.e. with a manifest)
    $all = @(Get-ChildItem -Path $BackupRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName "_backup_manifest.json") } | Sort-Object Name -Descending)
    if ($all.Count -gt $BackupKeep) {
        foreach ($old in $all[$BackupKeep..($all.Count - 1)]) {
            Write-Host "[INFO] Removing old backup (keep $BackupKeep): $($old.Name)" -ForegroundColor DarkGray
            Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    return $dest
}

# Restarts the service after file changes (starts it when it was running before, or when asked to).
function Restart-ProdService {
    param($Svc, [bool]$WasRunning)
    if (-not $Svc) {
        Write-Host "[WARNING] Service '$ServiceName' not found. Please verify service name." -ForegroundColor Yellow
        return
    }
    Write-Host ""
    Write-Host "[INFO] Restarting Windows Service: $ServiceName ..." -ForegroundColor Yellow
    if ($WasRunning) { Restart-Service -Name $ServiceName -Force } else { Start-Service -Name $ServiceName }
    Start-Sleep -Seconds 3
    $currentStatus = (Get-Service -Name $ServiceName).Status
    if ($currentStatus -eq "Running") {
        Write-Host "[OK] Service '$ServiceName' restarted successfully! (Status: $currentStatus)" -ForegroundColor Green
    } else {
        Write-Host "[WARNING] Service status after restart: $currentStatus. Please inspect system logs." -ForegroundColor Yellow
    }
}

if ($Backup -and $Recover) {
    Write-Host ""
    Write-Host "[ERROR] Use either -Backup (deploy with a backup first) or -Recover (restore a backup), not both." -ForegroundColor Red
    exit 1
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

# ==============================================================================
# RECOVER MODE: restore one backup to Path B, then exit (Path A is not used)
# ==============================================================================
if ($Recover) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host " SOMP Vanguard - Restore Production from Backup" -ForegroundColor Cyan
    Write-Host " Backup Folder   : $BackupRoot"
    Write-Host " Target Path (B) : $PathB"
    Write-Host " Service Name    : $ServiceName"
    Write-Host "========================================================"
    Write-Host ""

    $backups = @()
    if (Test-Path $BackupRoot) {
        $backups = @(Get-ChildItem -Path $BackupRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName "_backup_manifest.json") } | Sort-Object Name -Descending)
    }
    if ($backups.Count -eq 0) {
        Write-Host "[INFO] No backups found in $BackupRoot. Run with -Backup to create one." -ForegroundColor Yellow
        exit 0
    }

    Write-Host " Available backups (newest first):" -ForegroundColor White
    Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ("  {0,-4} {1,-20} {2,-10} {3,8} {4,10}  {5}" -f "No.", "Created", "Version", "Files", "Size", "Reason")
    $infos = @()
    for ($i = 0; $i -lt $backups.Count; $i++) {
        $m = $null
        try { $m = Get-Content (Join-Path $backups[$i].FullName "_backup_manifest.json") -Raw | ConvertFrom-Json } catch { }
        $infos += $m
        if ($m) {
            Write-Host ("  {0,-4} {1,-20} {2,-10} {3,8} {4,10}  {5}" -f ($i + 1), $m.createdAt, $m.version, $m.files, (Format-Size $m.bytes), $m.reason)
        } else {
            Write-Host ("  {0,-4} {1,-20} (manifest unreadable)" -f ($i + 1), $backups[$i].Name) -ForegroundColor DarkGray
        }
    }
    Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ("  Current production version: {0}" -f (Get-AppVersion -Root $PathB)) -ForegroundColor White
    Write-Host ""

    $choice = Read-Host "Enter the number of the backup to restore (Enter to cancel)"
    if ($choice -eq '') {
        Write-Host "[CANCELLED] Restore aborted by user." -ForegroundColor Red
        exit 0
    }
    $idx = 0
    if (-not [int]::TryParse($choice, [ref]$idx) -or $idx -lt 1 -or $idx -gt $backups.Count) {
        Write-Host "[ERROR] Invalid choice: $choice" -ForegroundColor Red
        exit 1
    }
    $chosen = $backups[$idx - 1]
    $chosenInfo = $infos[$idx - 1]

    # Compare the backup with production: only files that differ are copied
    $backupFiles = @(Get-RelativeFiles -Root $chosen.FullName -Patterns @("_backup_manifest.json"))
    $restoreAsk = $false
    $askPresent = @($backupFiles | Where-Object { $RecoverAskFiles -contains $_.Rel })
    if ($askPresent.Count -gt 0) {
        $ans = Read-Host "Also restore the settings file(s) $(($askPresent | ForEach-Object { $_.Rel }) -join ', ') from the backup? Settings saved since then would be lost. [y/N]"
        $restoreAsk = ($ans -match '^[Yy]$')
    }

    $toRestore = @()
    foreach ($f in $backupFiles) {
        if (($RecoverAskFiles -contains $f.Rel) -and -not $restoreAsk) { continue }
        $destFile = Join-Path $PathB $f.Rel
        $same = $false
        if (Test-Path -LiteralPath $destFile) {
            $d = Get-Item -LiteralPath $destFile
            $same = ($d.Length -eq $f.Item.Length -and $d.LastWriteTime -eq $f.Item.LastWriteTime)
        }
        if (-not $same) { $toRestore += $f }
    }
    $backendRestore = @($toRestore | Where-Object { Test-NeedsServiceStop $_.Rel })

    # Files deployed after the backup are left in place (listing only); old code does not load them
    $backupSet = @{}
    foreach ($f in $backupFiles) { $backupSet[$f.Rel.ToLower()] = $true }
    $newer = @(Get-RelativeFiles -Root $PathB -Patterns ($ExcludeList + $BackupExtraExclude + $RecoverAskFiles) | Where-Object { -not $backupSet.ContainsKey($_.Rel.ToLower()) })

    Write-Host ""
    Write-Host "[INFO] Restore summary for backup $($chosen.Name) (version $($chosenInfo.version)):" -ForegroundColor Cyan
    Write-Host "  - Files that differ and will be restored : $($toRestore.Count) (backend: $($backendRestore.Count))"
    Write-Host "  - Files not in the backup (left as they are): $($newer.Count)" -ForegroundColor DarkGray
    if ($toRestore.Count -eq 0) {
        Write-Host ""
        Write-Host "[INFO] Production already matches this backup. Nothing to restore." -ForegroundColor Green
        exit 0
    }
    if ($toRestore.Count -le 50) {
        foreach ($f in $toRestore) { Write-Host "    < $($f.Rel)" -ForegroundColor Yellow }
    }
    Write-Host ""

    $ans = Read-Host "Back up the current production files before restoring? [Y/n] (default: Y)"
    if ($ans -eq '' -or $ans -match '^[Yy]$') {
        try {
            New-ProdBackup -Reason "before restore of $($chosen.Name)" | Out-Null
        } catch {
            Write-Host "[ERROR] Backup failed, nothing was restored: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
        Write-Host ""
    }

    $confirm = Read-Host "Restore $($toRestore.Count) file(s) from $($chosen.Name) to production now? [y/N]"
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host "[CANCELLED] Restore aborted by user." -ForegroundColor Red
        exit 0
    }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $wasRunning = ($svc -and ($svc.Status -eq "Running"))
    if ($backendRestore.Count -gt 0 -and $wasRunning) {
        Write-Host "[INFO] Stopping service '$ServiceName' to release file locks..." -ForegroundColor Yellow
        Stop-ProdService | Out-Null
    }

    $restored = 0
    $failed = 0
    foreach ($f in $toRestore) {
        $destFile = Join-Path $PathB $f.Rel
        $destDir = Split-Path $destFile -Parent
        try {
            Copy-WithRetry -Source $f.Item.FullName -Dest $destFile
            $restored++
        } catch {
            $failed++
            Write-Host "[ERROR] $($f.Rel): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    if ($failed -gt 0) {
        Write-Host "[WARNING] Restored $restored file(s), $failed failed." -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Restored $restored file(s)." -ForegroundColor Green
    }

    if ($backendRestore.Count -gt 0) {
        Restart-ProdService -Svc $svc -WasRunning $wasRunning
        Write-Host "[INFO] If package.json dependencies differ between versions, run 'npm install --omit=dev' in $PathB\backend." -ForegroundColor DarkGray
    } else {
        Write-Host "[INFO] Only frontend / other files were restored. Service '$ServiceName' kept running." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host " Restore of $($chosen.Name) completed." -ForegroundColor Green
    Write-Host "========================================================"
    Write-Host ""
    exit 0
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

$backupText = "No (use -Backup to keep a copy first)"
if ($Backup) { $backupText = "Yes -> $BackupRoot (keep $BackupKeep)" }

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " SOMP Vanguard - Production Deployment Script (Deploy_to_Prod)" -ForegroundColor Cyan
Write-Host " Source Path (A) : $PathA"
Write-Host " Target Path (B) : $PathB"
Write-Host " Service Name    : $ServiceName"
Write-Host " Exclude Rules   : $($ExcludeList.Count) patterns configured"
Write-Host " Backup First    : $backupText"
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
$changedFiles = @()       # only these are copied
$lockedFilesChanged = @() # other files the running service holds open (service executable, native modules)

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
        $changedFiles += $file
        if (Test-IsLockedByService $relPath) { $lockedFilesChanged += $relPath }
        if (Test-IsBackendPath $relPath) {
            $backendFilesChanged += $relPath
        } elseif ($relPath -like "frontend\*" -or $relPath -like "frontend/*") {
            $frontendFilesChanged += $relPath
        } else {
            $otherFilesChanged += $relPath
        }
    }
}

$hasBackendChanges = ($backendFilesChanged.Count -gt 0)
$needsServiceStop = ($hasBackendChanges -or $lockedFilesChanged.Count -gt 0)
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

# 3b. Optional backup of the current production files (-Backup); a failed backup stops the deployment
if ($Backup) {
    try {
        New-ProdBackup -Reason "before deploy of version $(Get-AppVersion -Root $PathA)" | Out-Null
    } catch {
        Write-Host "[ERROR] Backup failed, deployment stopped (production unchanged): $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    Write-Host ""
}

# 4. If backend files (or files the service holds open) changed and the service is running, stop it and wait for
#    its processes to exit so no file stays locked
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$wasRunning = ($svc -and ($svc.Status -eq "Running"))

if ($needsServiceStop -and $wasRunning) {
    Write-Host ""
    if ($lockedFilesChanged.Count -gt 0 -and -not $hasBackendChanges) {
        Write-Host "[INFO] Service files changed ($($lockedFilesChanged -join ', ')). Stopping service '$ServiceName' to release file locks..." -ForegroundColor Yellow
    } else {
        Write-Host "[INFO] Backend changes detected. Stopping service '$ServiceName' to release file locks..." -ForegroundColor Yellow
    }
    if (Stop-ProdService) {
        Write-Host "[OK] Service stopped." -ForegroundColor Green
    }
}

# 5. Copy the changed files from Path A to Path B. Unchanged files are left alone, so the running service's
#    executable is never touched when only frontend files changed.
Write-Host ""
Write-Host "[INFO] Copying $($changedFiles.Count) changed file(s) from Path A to Path B..." -ForegroundColor Cyan
$copiedCount = 0
$copyFailed = @()
foreach ($file in $changedFiles) {
    $relPath = $file.FullName.Substring($PathA.Length).TrimStart('\', '/')
    $destFile = Join-Path $PathB $relPath
    try {
        Copy-WithRetry -Source $file.FullName -Dest $destFile
        $copiedCount++
    } catch {
        $copyFailed += $relPath
        Write-Host "[ERROR] $relPath : $($_.Exception.Message)" -ForegroundColor Red
    }
}
if ($copyFailed.Count -gt 0) {
    Write-Host "[WARNING] Copied $copiedCount file(s), $($copyFailed.Count) failed." -ForegroundColor Yellow
} else {
    Write-Host "[OK] File copy complete. Copied $copiedCount file(s)." -ForegroundColor Green
}

# 6. Service restart determination (also after a partial copy, so the service is never left stopped)
if ($needsServiceStop) {
    Restart-ProdService -Svc $svc -WasRunning $wasRunning
} else {
    Write-Host ""
    Write-Host "[INFO] Only frontend static files were updated (no backend changes). Service '$ServiceName' kept running with zero downtime!" -ForegroundColor Green
}

if ($copyFailed.Count -gt 0) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host " Deployment finished with $($copyFailed.Count) file(s) NOT copied:" -ForegroundColor Red
    foreach ($f in $copyFailed) { Write-Host "   - $f" -ForegroundColor Red }
    Write-Host " Production may be partly updated. Fix the cause and run the deployment again" -ForegroundColor Red
    Write-Host " (only the files still different are copied)." -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " Production deployment completed successfully!" -ForegroundColor Green
Write-Host "========================================================"
Write-Host ""
