<#
.SYNOPSIS
    SCP_to_Prod.ps1 - Copies modified code files and replaces frontend dist\assets on remote server via SCP.
.DESCRIPTION
    1. Selectively copies only modified files (via Git status, sync timestamp, or custom since parameter).
    2. Completely replaces the entire frontend\dist\assets directory and index.html.
    3. Excludes node_modules, .git, .vscode, logs, and temporary files via configurable $ExcludeList.
    4. Supports automatic password authentication via OpenSSH SSH_ASKPASS or passwordless SSH Key.
.EXAMPLE
    .\scripts\SCP_to_Prod.ps1
    .\scripts\SCP_to_Prod.ps1 -All
    .\scripts\SCP_to_Prod.ps1 -Since "2026-09-17"
#>

param(
    [switch]$All,           # Force copy all files (skip modified check)
    [string]$Since = "",    # Custom modified reference time (e.g. "2026-09-17" or "2026-09-17 12:00")
    [int]$Days = 2,         # Fallback modified days when no sync history exists (Default: 2)
    [switch]$SkipTests,     # Emergency only: skip backend test gate
    [switch]$SkipBuildCheck # Emergency only: skip the "frontend\dist is older than frontend\src" check
)

# ==============================================================================
# CONFIGURATION SETTINGS (Edit as needed)
# ==============================================================================
$RemoteHost     = "your-prod-server"                       # Remote server IP or Hostname
$RemotePort     = 22                                   # SSH / SCP port (Default: 22)
$RemoteUser     = "deploy-user"                             # Remote login username
$RemotePassword = ""                       # Remote login password (Leave empty if using SSH Key)
# Local project root path (Auto-detects parent if script is inside scripts/ directory)
if (Test-Path (Join-Path $PSScriptRoot "backend")) {
    $LocalPath  = $PSScriptRoot
} else {
    $LocalPath  = Split-Path -Parent $PSScriptRoot
}
$RemotePath     = "/path/to/somp-staging" # Remote staging directory (Please use forward slashes /)

# Files or folders to exclude from syncing (Wildcard patterns supported)
$ExcludeList = @(
    "*node_modules*",
    "*.git*",
    "*.vscode*",
    "*.log",
    "*.tmp",
	"*.env*",
    ".last_scp_sync",
    "*SCP_to_Prod.ps1*",
    "*Deploy_to_Prod.ps1*",
    "*Update_Version.ps1*",
    "*\test\*",                 # Automated tests (backend\test) are not needed in production
    "dist_backup*",             # Local frontend\dist backups
    "docs\superpowers\*"        # Development plans
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

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " SOMP Vanguard - Remote Code Transfer Tool (SCP)" -ForegroundColor Cyan
Write-Host " Local Path : $LocalPath"
Write-Host " Remote Host: ${RemoteUser}@${RemoteHost}:${RemotePort}"
Write-Host " Remote Path: $RemotePath"
Write-Host " Exclude Rules: $($ExcludeList.Count) patterns configured"
Write-Host "========================================================"
Write-Host ""

# 1. Verify SSH / SFTP / SCP command availability
$hasSftp = [bool](Get-Command sftp.exe -ErrorAction SilentlyContinue)
$hasScp  = [bool](Get-Command scp.exe -ErrorAction SilentlyContinue)
if (-not $hasSftp -and -not $hasScp) {
    Write-Host ""
    Write-Host "[ERROR] OpenSSH client (sftp.exe / scp.exe) not found. Please ensure OpenSSH Client is installed." -ForegroundColor Red
    exit 1
}

# 1.5 Run backend test suite before transferring anything
if ($SkipTests) {
    Write-Host "[WARNING] -SkipTests specified. Backend tests were NOT run." -ForegroundColor Yellow
} else {
    Write-Host "[INFO] Running backend tests (npm test)..." -ForegroundColor Cyan
    Push-Location (Join-Path $LocalPath "backend")
    npm test
    $testExit = $LASTEXITCODE
    Pop-Location
    if ($testExit -ne 0) {
        Write-Host ""
        Write-Host "[ERROR] Backend tests failed. Deployment aborted. Fix the tests or rerun with -SkipTests (emergency only)." -ForegroundColor Red
        exit 1
    }
    Write-Host "[INFO] All backend tests passed." -ForegroundColor Green
}

# 1.6 Make sure frontend\dist was rebuilt after the latest frontend source change
if ($SkipBuildCheck) {
    Write-Host "[WARNING] -SkipBuildCheck specified. frontend\dist freshness was NOT verified." -ForegroundColor Yellow
} else {
    $distIndex = Join-Path $LocalPath "frontend\dist\index.html"
    if (Test-Path $distIndex) {
        $builtAt = (Get-Item $distIndex).LastWriteTime
        $sourceItems = @(
            (Join-Path $LocalPath "frontend\src"),
            (Join-Path $LocalPath "frontend\public"),
            (Join-Path $LocalPath "frontend\index.html"),
            (Join-Path $LocalPath "frontend\vite.config.js"),
            (Join-Path $LocalPath "frontend\package.json")
        ) | Where-Object { Test-Path $_ }
        $newerSources = @(Get-ChildItem -Path $sourceItems -Recurse -File | Where-Object { $_.LastWriteTime -gt $builtAt })
        if ($newerSources.Count -gt 0) {
            Write-Host ""
            Write-Host "[ERROR] frontend\dist is older than $($newerSources.Count) frontend source file(s). Deployment aborted." -ForegroundColor Red
            $newerSources | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | ForEach-Object {
                Write-Host "  -> $($_.FullName.Substring($LocalPath.Length).TrimStart('\', '/'))  ($($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))" -ForegroundColor Yellow
            }
            Write-Host "  Run 'npm run build' in the frontend directory first (or rerun with -SkipBuildCheck, emergency only)." -ForegroundColor Red
            exit 1
        }
        Write-Host "[INFO] frontend\dist is up to date (built $($builtAt.ToString('yyyy-MM-dd HH:mm:ss')))." -ForegroundColor Green
    }
}

# 2. Create temporary local staging directory
$StagingDir = Join-Path $env:TEMP "somp_scp_staging_$(Get-Random)"
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

$SyncRecordFile = Join-Path $LocalPath ".last_scp_sync"
$modifiedFiles = @()

# 3. Collect modified file list
if ($All) {
    Write-Host "[INFO] Mode: Force copy all project files (-All)" -ForegroundColor Yellow
    $allFiles = Get-ChildItem -Path $LocalPath -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($LocalPath.Length).TrimStart('\', '/')
        if ($rel -like "frontend\dist\*" -or $rel -like "frontend/dist/*" -or $rel -eq "frontend\dist" -or $rel -eq "frontend/dist") {
            return $false
        }
        if (Test-IsExcluded -Path $rel -Patterns $ExcludeList) {
            return $false
        }
        return $true
    }
    foreach ($f in $allFiles) {
        $rel = $f.FullName.Substring($LocalPath.Length).TrimStart('\', '/')
        $modifiedFiles += $rel
    }
} else {
    # The file list is the UNION of
    #   a) files modified on disk since the last sync (or -Since / the past $Days day(s)), and
    #   b) uncommitted git changes (git status, every untracked file listed one by one).
    # Git status alone is NOT enough: a file committed after the last sync is clean in git but was never uploaded.
    $referenceTime = [DateTime]::MinValue
    if ($Since) {
        $referenceTime = [DateTime]::Parse($Since)
        Write-Host "[INFO] Mode: Files modified since $Since (+ uncommitted git changes)" -ForegroundColor Cyan
    } elseif (Test-Path $SyncRecordFile) {
        $rawTime = Get-Content $SyncRecordFile -ErrorAction SilentlyContinue
        if (-not [DateTime]::TryParse($rawTime, [ref]$referenceTime)) {
            $referenceTime = (Get-Item $SyncRecordFile).LastWriteTime
        }
        Write-Host "[INFO] Mode: Files modified since last sync ($($referenceTime.ToString('yyyy-MM-dd HH:mm:ss'))) (+ uncommitted git changes)" -ForegroundColor Cyan
    } else {
        # First run / no sync history: default to files modified in the past $Days day(s)
        $referenceTime = (Get-Date).AddDays(-$Days)
        Write-Host "[INFO] No sync history found: Defaulting to files modified in the past $Days day(s) (+ uncommitted git changes)..." -ForegroundColor Yellow
    }

    $seen = @{}
    $allFiles = Get-ChildItem -Path $LocalPath -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($LocalPath.Length).TrimStart('\', '/')
        if ($rel -like "frontend\dist\*" -or $rel -like "frontend/dist/*" -or $rel -eq "frontend\dist" -or $rel -eq "frontend/dist") {
            return $false
        }
        if (Test-IsExcluded -Path $rel -Patterns $ExcludeList) {
            return $false
        }
        if ($_.LastWriteTime -le $referenceTime) {
            return $false
        }
        return $true
    }
    foreach ($f in $allFiles) {
        $rel = $f.FullName.Substring($LocalPath.Length).TrimStart('\', '/')
        $seen[$rel.ToLower()] = $true
        $modifiedFiles += $rel
    }

    $hasGit = Test-Path (Join-Path $LocalPath ".git")
    if ($hasGit) {
        try {
            $gitStatus = git -C $LocalPath status --porcelain --untracked-files=all 2>$null
            if ($LASTEXITCODE -eq 0 -and $gitStatus) {
                foreach ($line in ($gitStatus -split "\r?\n")) {
                    if ($line.Length -gt 3) {
                        $filePath = $line.Substring(3).Trim().Trim('"')
                        # renames are listed as "old -> new"
                        if ($filePath -like "* -> *") { $filePath = ($filePath -split " -> ")[-1].Trim('"') }
                        $filePath = $filePath -replace '/', '\'
                        if ($filePath -and -not $seen.ContainsKey($filePath.ToLower())) {
                            $isDist = ($filePath -like "frontend\dist\*" -or $filePath -eq "frontend\dist")
                            $isEx = (Test-IsExcluded -Path $filePath -Patterns $ExcludeList)
                            if (-not $isDist -and -not $isEx) {
                                $full = Join-Path $LocalPath $filePath
                                if (Test-Path $full -PathType Leaf) {
                                    $seen[$filePath.ToLower()] = $true
                                    $modifiedFiles += $filePath
                                }
                            }
                        }
                    }
                }
            }
        } catch {}
    }
}

Write-Host "[INFO] Detected $($modifiedFiles.Count) modified code file(s) to synchronize." -ForegroundColor Cyan

# 4. Copy modified files to staging directory (preserving folder hierarchy)
foreach ($rel in $modifiedFiles) {
    $src = Join-Path $LocalPath $rel
    $dest = Join-Path $StagingDir $rel
    $destParent = Split-Path $dest -Parent
    if (-not (Test-Path $destParent)) {
        New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    }
    Copy-Item -Path $src -Destination $dest -Force
    Write-Host "  -> [Modified] $rel" -ForegroundColor Gray
}

# 5. Handle full frontend\dist directory (Completely replaced with latest build)
$frontendDistDir = Join-Path $LocalPath "frontend\dist"
if (Test-Path $frontendDistDir) {
    $targetDistStaging = Join-Path $StagingDir "frontend\dist"
    if (-not (Test-Path $targetDistStaging)) {
        New-Item -ItemType Directory -Path $targetDistStaging -Force | Out-Null
    }
    Copy-Item -Path "$frontendDistDir\*" -Destination $targetDistStaging -Recurse -Force
    Write-Host "[INFO] Packaged entire frontend\dist directory (all latest build chunks, assets & index.html)" -ForegroundColor Green
} else {
    Write-Host "[WARNING] frontend\dist not found. Run 'npm run build' in frontend directory first." -ForegroundColor Yellow
}

# 6. Verify if there is anything to transmit
$stagedItems = Get-ChildItem -Path $StagingDir
if ($stagedItems.Count -eq 0) {
    Write-Host ""
    Write-Host "[OK] No files require synchronization. Process finished." -ForegroundColor Green
    Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# 7. Execute transmission to remote host
$cleanRemotePath = $RemotePath.Replace('\', '/').TrimEnd('/')
$remoteDest = "${RemoteUser}@${RemoteHost}:${cleanRemotePath}/"

Write-Host ""
Write-Host "[INFO] Starting transfer to: $remoteDest ..." -ForegroundColor Cyan

# Automatic password authentication support (OpenSSH SSH_ASKPASS)
$askPassCmd = $null
if ($RemotePassword -and $RemotePassword.Trim() -ne "" -and $RemotePassword -ne "YourPasswordHere") {
    $askPassCmd = Join-Path $env:TEMP "ssh_askpass_$(Get-Random).cmd"
    "@echo $RemotePassword" | Out-File -FilePath $askPassCmd -Encoding ascii
    $env:SSH_ASKPASS = $askPassCmd
    $env:SSH_ASKPASS_REQUIRE = "force"
}

try {
    # Prefer OpenSSH sftp.exe pipeline for AsyncSSH / modern SSH server compatibility, fallback to scp.exe
    if ($hasSftp) {
        Write-Host "[INFO] Engine: OpenSSH SFTP Pipeline (AsyncSSH compatible)" -ForegroundColor Cyan
        $sftpCommands = @()
        $sftpCommands += "cd `"$cleanRemotePath`""
        foreach ($item in $stagedItems) {
            $itemEscaped = $item.FullName.Replace('\', '/')
            if ($item.PSIsContainer) {
                $sftpCommands += "put -r `"$itemEscaped`""
            } else {
                $sftpCommands += "put `"$itemEscaped`""
            }
        }
        $sftpCommands += "quit`n"
        $sftpInput = ($sftpCommands -join "`n")

        $sftpOutput = $sftpInput | & sftp.exe -P $RemotePort -o StrictHostKeyChecking=no "${RemoteUser}@${RemoteHost}" 2>&1
        $hasFatalError = $false
        foreach ($line in $sftpOutput) {
            $lineStr = "$line"
            if ($lineStr -like "*Uploading*" -or $lineStr -like "*Entering*") {
                Write-Host "  -> $lineStr" -ForegroundColor Gray
            } elseif ($lineStr -match "Permission denied|Connection refused|No such file|Connection closed") {
                Write-Host "  [!] $lineStr" -ForegroundColor Yellow
                $hasFatalError = $true
            }
        }

        if ($LASTEXITCODE -ne 0 -or $hasFatalError) {
            throw "SFTP transfer failed with exit code: $LASTEXITCODE"
        }
    } else {
        Write-Host "[INFO] Engine: OpenSSH SCP" -ForegroundColor Cyan
        $scpArgs = @("-P", $RemotePort, "-r", "-o", "StrictHostKeyChecking=no")
        foreach ($item in $stagedItems) {
            $itemPath = $item.FullName
            & scp.exe @scpArgs "$itemPath" "$remoteDest"
            if ($LASTEXITCODE -ne 0) {
                throw "SCP upload failed on $($item.Name) with exit code: $LASTEXITCODE"
            }
        }
    }

    # Record latest sync timestamp
    (Get-Date).ToString("o") | Out-File -FilePath $SyncRecordFile -Encoding ascii
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host " [OK] Code and assets successfully transferred!" -ForegroundColor Green
    Write-Host " Remote Host   : $RemoteHost" -ForegroundColor Green
    Write-Host " Remote Path   : $cleanRemotePath" -ForegroundColor Green
    Write-Host " Next Step     : Run .\scripts\Deploy_to_Prod.ps1 on remote host to finish deployment" -ForegroundColor Green
    Write-Host "========================================================"
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "[ERROR] Transfer failed: $_" -ForegroundColor Red
    exit 1
} finally {
    # Cleanup AskPass temporary script
    if ($askPassCmd -and (Test-Path $askPassCmd)) {
        Remove-Item -Path $askPassCmd -Force -ErrorAction SilentlyContinue
    }
    $env:SSH_ASKPASS = $null
    $env:SSH_ASKPASS_REQUIRE = $null

    # Cleanup local staging directory
    if (Test-Path $StagingDir) {
        Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
