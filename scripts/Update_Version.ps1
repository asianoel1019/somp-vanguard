<#
.SYNOPSIS
    SOMP Vanguard 一鍵全域版本號同步更新工具 (Update_Version.ps1)
.DESCRIPTION
    自動將新版本號同步更新至 backend/package.json、frontend/package.json、
    README.md、Update_Version.ps1（執行時版本號一律讀取 backend/package.json）
    以及系統手冊 (docs/index.html, docs/api_documentation.html)。
.PARAMETER Version
    目標版本號 (例如 1.7.0 或 1.7.1)
.PARAMETER Date
    發布更新日期 (選填，格式 YYYY-MM-DD，預設為當天)
.EXAMPLE
    .\scripts\Update_Version.ps1
    .\scripts\Update_Version.ps1 -Version "1.7.0"
    .\scripts\Update_Version.ps1 -Version "1.7.1" -Date "2026-09-25"
#>

[CmdletBinding()]
param(
    [Parameter(Position=0, Mandatory=$false)]
    [string]$Version,

    [Parameter(Position=1, Mandatory=$false)]
    [string]$Date
)

$ErrorActionPreference = "Stop"

# 解析腳本所在目錄與專案根目錄
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $ScriptDir "backend")) {
    $ProjectRoot = $ScriptDir
} else {
    $ProjectRoot = Split-Path -Parent $ScriptDir
}
Set-Location $ProjectRoot

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  SOMP Vanguard - 一鍵全域版本同步工具 (Version Manager)   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 若未帶參數則進行互動式提示
if ([string]::IsNullOrWhiteSpace($Version)) {
    $backendPkg = Join-Path $ProjectRoot "backend\package.json"
    $currentVer = "v1.7.7"
    if (Test-Path $backendPkg) {
        try {
            $pkg = Get-Content $backendPkg -Raw | ConvertFrom-Json
            if ($pkg.version) { $currentVer = "v$($pkg.version)" }
        } catch {}
    }
    
    Write-Host ""
    Write-Host "[CURRENT] 目前系統版本: $currentVer" -ForegroundColor Yellow

    $inputVer = Read-Host "請輸入新版本號 (例如 1.7.1 或 1.8.0)"
    if ([string]::IsNullOrWhiteSpace($inputVer)) {
        Write-Host "[CANCEL] 未輸入版本號，操作已取消。" -ForegroundColor Red
        exit 1
    }
    $Version = $inputVer.Trim()
}

# 檢查 Node.js 是否安裝
try {
    $nodeVer = & node -v 2>$null
    if (-not $nodeVer) {
        Write-Host "[ERROR] 找不到 Node.js 執行檔，請確認已安裝 Node.js 並加入 PATH 環境變數。" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] 執行 Node.js 失敗: $_" -ForegroundColor Red
    exit 1
}

$updateScript = Join-Path $ScriptDir "update_version.js"
if (-not (Test-Path $updateScript)) {
    $updateScript = Join-Path $ProjectRoot "scripts\update_version.js"
}
if (-not (Test-Path $updateScript)) {
    Write-Host "[ERROR] 找不到版本更新核心引擎: $updateScript" -ForegroundColor Red
    exit 1
}

# 執行更新
if ([string]::IsNullOrWhiteSpace($Date)) {
    & node $updateScript $Version
} else {
    & node $updateScript $Version $Date
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "[SUCCESS] 所有模組、環境變數與對外文件版本號已同步完畢！" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[ERROR] 版本更新過程發生錯誤 (Exit Code: $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}
