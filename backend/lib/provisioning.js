// Server Provision helpers: config parsing, request validation, PowerShell script generation and result parsing.
// Pure functions only (no I/O) so they can be unit tested without PowerShell or SSH.
const crypto = require('crypto');
const { isIpv4, psQuote, shellQuote } = require('./inventoryValidation');

const MAX_IPS = 50;
const VALID_OS = ['windows', 'linux'];

// Time budget (Windows): 5 min base + 3 min per package per host, capped at 2 h
const PS_BASE_TIMEOUT_MS = 5 * 60 * 1000;
const PS_PER_PACKAGE_TIMEOUT_MS = 3 * 60 * 1000;
const PS_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// How long the guest waits for one installer before killing it
const INSTALLER_WAIT_MS = 2 * 60 * 1000;
// Linux: total time budget per host (all packages + reboot)
const LINUX_HOST_TIMEOUT_MS = 15 * 60 * 1000;

// Installer exit codes treated as success (3010 = success, reboot required)
// 1641 (msiexec: reboot initiated) is treated like 3010
const OK_EXIT_CODES = [0, 3010, 1641];
const REBOOT_REQUIRED_CODE = 3010;
const REBOOT_EXIT_CODES = [3010, 1641];

const PKG_MARK = '@@PKG@@';
const HOST_MARK = '@@HOST@@';

function computeTimeoutMs(hostCount, packageCount) {
    const hosts = Math.max(1, Number(hostCount) || 1);
    const pkgs = Math.max(0, Number(packageCount) || 0);
    return Math.min(PS_MAX_TIMEOUT_MS, PS_BASE_TIMEOUT_MS + PS_PER_PACKAGE_TIMEOUT_MS * pkgs * hosts);
}

const {
    pick, splitLines, csv, parseMasterList, parseLinuxMasterList, loadInstallConfig, selectedNamesFor, resolveSoftware,
    detectErrors, validateMasterListText
} = require('./provisioningConfig');

/**
 * Validates the POST /execute body. Returns { error } (readable) or { value }.
 * IPs: array of 1..MAX_IPS IPv4 strings, de-duplicated. buType must be a configured template (or Basic).
 */
function validateExecuteBody(body, cfg) {
    const b = body || {};
    if (!Array.isArray(b.ips) || b.ips.length === 0) return { error: 'No IPs provided: ips must be a non-empty array' };
    if (b.ips.length > MAX_IPS) return { error: `Too many IPs: at most ${MAX_IPS} per request` };
    const ips = [];
    for (let i = 0; i < b.ips.length; i++) {
        const raw = b.ips[i];
        if (typeof raw !== 'string') return { error: `ips[${i}] must be a string` };
        const ip = raw.trim();
        if (!isIpv4(ip)) return { error: `Invalid IPv4 address at ips[${i}]: ${raw.slice(0, 40).replace(/[^\x20-\x7e]/g, '?')}` };
        if (!ips.includes(ip)) ips.push(ip);
    }
    const osType = b.osType === undefined || b.osType === null ? 'windows' : b.osType;
    if (!VALID_OS.includes(osType)) return { error: 'osType must be "windows" or "linux"' };
    const buType = b.buType === undefined || b.buType === null || b.buType === '' ? 'Basic' : b.buType;
    if (typeof buType !== 'string' || !(buType === 'Basic' || cfg.bus.includes(buType))) {
        return { error: `Unknown template (buType): ${String(buType).slice(0, 40).replace(/[^\x20-\x7e]/g, '?')}` };
    }
    // A legacy `setDisk` field (Disk Setup was removed: Nutanix Clone VM prepares the data disk) is ignored on purpose
    for (const k of ['reboot', 'forceReinstall', 'keepInstallers', 'allowUnknownTargets']) {
        if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'boolean') return { error: `${k} must be a boolean` };
    }
    return { value: { ips, osType, buType, reboot: b.reboot === true, forceReinstall: b.forceReinstall === true, keepInstallers: b.keepInstallers === true, allowUnknownTargets: b.allowUnknownTargets === true } };
}

/** Splits an argument string on whitespace outside double quotes; quotes are kept so the joined result is unchanged. */
function tokenizeArgs(str) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (const ch of String(str || '')) {
        if (ch === '"') { inQ = !inQ; cur += ch; continue; }
        if (!inQ && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

function psStringArray(items) {
    return `[string[]]@(${items.map(psQuote).join(', ')})`;
}

function windowsPackageSpec(sw, nasPath) {
    const raw = String(sw.path || '').replace(/\//g, '\\');
    const isAbs = raw.startsWith('\\\\') || raw.includes(':');
    const base = String(nasPath || '').replace(/\\+$/, '');
    const fullPath = isAbs ? raw : `${base}\\${raw}`;
    const idx = fullPath.lastIndexOf('\\');
    const leaf = idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
    const parent = idx >= 0 ? fullPath.slice(0, idx) : '';
    const pIdx = parent.lastIndexOf('\\');
    const folder = pIdx >= 0 ? parent.slice(pIdx + 1) : parent;
    return {
        name: sw.name,
        safeName: String(sw.name).replace(/[^a-zA-Z0-9]/g, '_'),
        fullPath, leaf, parent, folder,
        isScript: /\.(bat|cmd|ps1)$/i.test(leaf),
        args: tokenizeArgs(sw.args)
    };
}

const GUEST_BLOCK = String.raw`
$guestRun = {
    param($Dest, $WorkDir, $ArgList, $WaitMs)
    $tag = [guid]::NewGuid().ToString('N')
    $result = @{ ExitCode = $null; TimedOut = $false; Error = ''; Stdout = ''; Stderr = '' }
    $so = $null
    $se = $null
    $msiLog = ''
    function Get-TailText($t) {
        if (-not $t) { return '' }
        if ($t.Length -gt 1500) { return $t.Substring($t.Length - 1500) }
        return $t
    }
    try {
        $argStr = ''
        if ($ArgList) { $argStr = (@($ArgList) -join ' ') }
        if ($Dest -match '\.(bat|cmd)$') {
            $file = 'cmd.exe'
            $inner = '"' + $Dest + '"'
            if ($argStr) { $inner = $inner + ' ' + $argStr }
            $argLine = '/d /s /c "' + $inner + '"'
        } elseif ($Dest -match '\.ps1$') {
            $file = 'powershell.exe'
            $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $Dest + '"'
            if ($argStr) { $argLine = $argLine + ' ' + $argStr }
        } elseif ($Dest -match '\.msi$') {
            $file = 'msiexec.exe'
            $msiLog = Join-Path $env:TEMP ('somp_msi_' + $tag + '.log')
            $argLine = '/i "' + $Dest + '" /qn /norestart /l*v "' + $msiLog + '"'
            if ($argStr) { $argLine = $argLine + ' ' + $argStr }
        } else {
            $file = $Dest
            $argLine = $argStr
        }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $file
        $psi.Arguments = $argLine
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
        $p = [System.Diagnostics.Process]::Start($psi)
        $so = $p.StandardOutput.ReadToEndAsync()
        $se = $p.StandardError.ReadToEndAsync()
        if ($p.WaitForExit($WaitMs)) {
            $p.WaitForExit()
            $result.ExitCode = $p.ExitCode
            try { $null = $so.Wait(5000); $null = $se.Wait(5000) } catch {}
        } else {
            $result.TimedOut = $true
            try { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null } catch {}
            try { $p.Kill() } catch {}
        }
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        if ($so -and $so.IsCompleted -and -not $so.IsFaulted) { $result.Stdout = Get-TailText $so.Result }
        if ($se -and $se.IsCompleted -and -not $se.IsFaulted) { $result.Stderr = Get-TailText $se.Result }
        if ($msiLog) {
            if (-not $result.Stdout -and (Test-Path -LiteralPath $msiLog)) { $result.Stdout = Get-TailText (Get-Content -LiteralPath $msiLog -Raw -ErrorAction SilentlyContinue) }
            Remove-Item -LiteralPath $msiLog -Force -ErrorAction SilentlyContinue
        }
    }
    [pscustomobject]$result
}
`;

// Detection on the guest ("is this package already installed?"): returns { Found, Version, Error }.
// The rule (type / value / minimum version) always arrives as an argument: it is never part of the script text.
const GUEST_DETECT_BLOCK = String.raw`
$guestDetect = {
    param($Type, $Value, $MinVer)
    $res = @{ Found = $false; Version = ''; Error = '' }
    # [ and ] are literal characters in a DisplayName pattern; only * and ? stay wildcards
    $bt = [string][char]96
    $pat = ([string]$Value).Replace('[', $bt + '[').Replace(']', $bt + ']')
    function Test-VerAtLeast($v, $min) {
        if (-not $min) { return $true }
        try {
            $a = ([string]$v) -replace '[^\d\.].*$', ''
            $b = [string]$min
            if ($a -notmatch '^\d+(\.\d+){0,3}$' -or $b -notmatch '^\d+(\.\d+){0,3}$') { return $false }
            # Pad both sides to 4 components: [version]'1.2' is NOT -ge [version]'1.2.0' (unset parts are -1)
            while (($a -split '\.').Count -lt 4) { $a = $a + '.0' }
            while (($b -split '\.').Count -lt 4) { $b = $b + '.0' }
            return ([version]$a -ge [version]$b)
        } catch { return $false }
    }
    try {
        if ($Type -eq 'file') {
            if (Test-Path -LiteralPath $Value -PathType Leaf) {
                $res.Found = $true
                try { $res.Version = [string](Get-Item -LiteralPath $Value).VersionInfo.FileVersion } catch { }
            }
        } elseif ($Type -eq 'reg') {
            $versions = @()
            $roots = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
            foreach ($root in $roots) {
                if (-not (Test-Path -LiteralPath $root)) { continue }
                foreach ($k in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
                    $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
                    if ($p -and $p.DisplayName -and ([string]$p.DisplayName -like $pat)) {
                        $ver = [string]$p.DisplayVersion
                        if (Test-VerAtLeast $ver $MinVer) { $res.Found = $true; if ($ver -and $versions -notcontains $ver) { $versions += $ver } }
                    }
                }
            }
            $res.Version = ($versions -join ', ')
        } else {
            $res.Error = 'Unknown detect type'
        }
    } catch {
        $res.Error = $_.Exception.Message
    }
    [pscustomobject]$res
}
`;

// Guest-side cleanup helpers (arguments only: no interpolated values)
const GUEST_LOGS_BLOCK = String.raw`
$guestReadLogs = {
    param($Dir)
    $out = @()
    if (Test-Path -LiteralPath $Dir) {
        foreach ($f in (Get-ChildItem -LiteralPath $Dir -Recurse -Filter 'install_*.log' -File -ErrorAction SilentlyContinue | Select-Object -First 5)) {
            $t = ''
            try { $t = [string](Get-Content -LiteralPath $f.FullName -Raw -ErrorAction Stop) } catch { }
            if ($t.Length -gt 1500) { $t = $t.Substring($t.Length - 1500) }
            $out += @{ Name = $f.FullName.Substring($Dir.Length).TrimStart('\'); Tail = $t }
        }
    }
    ,$out
}
$guestRemove = {
    param($Dir, $Root)
    # Only the job's own work directory below the SOMP_Provision root may ever be removed
    $d = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
    $r = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $d.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to delete outside the job work directory' }
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop }
    # The shared root is removed only when nothing else is in it
    if ((Test-Path -LiteralPath $r) -and -not (Get-ChildItem -LiteralPath $r -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        Remove-Item -LiteralPath $r -Force -ErrorAction SilentlyContinue
    }
}
`;

// Removes job folders left behind by a killed run: only direct children of the root whose name looks like a job id,
// not the current job, untouched for more than $Days days. Errors are ignored.
const GUEST_SWEEP_BLOCK = String.raw`
$guestSweep = {
    param($Root, $Current, $Days)
    $removed = @()
    try {
        $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
        if (Test-Path -LiteralPath $rootFull) {
            $limit = (Get-Date).AddDays(-1 * [int]$Days)
            foreach ($dir in @(Get-ChildItem -LiteralPath $rootFull -Directory -ErrorAction SilentlyContinue)) {
                if ($dir.Name -notmatch '^[A-Za-z0-9_-]{1,64}$') { continue }
                if ($dir.Name -ieq $Current) { continue }
                if ($dir.LastWriteTime -ge $limit) { continue }
                if (-not $dir.FullName.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
                $removed += $dir.Name
            }
        }
    } catch { }
    ,$removed
}
`;

const PROVISION_ROOT = 'X:\\SOMP_Provision';
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function packageDetect(sw) {
    const d = sw && sw.detect;
    return d && typeof d === 'object' ? { type: d.type, value: d.value, min: d.minVersion || '' } : { type: '', value: '', min: '' };
}

/**
 * Builds the PowerShell script for ONE Windows host.
 * Every interpolated value is a psQuote'd literal; the credential comes from the environment (credentialHeader).
 * Single installers (.exe / .msi) are copied below X:\SOMP_Provision\<jobId>\<n>\ and that folder, and nothing else, is
 * removed afterwards unless keepInstallers is set (kept folders are swept after 7 days by a later run). Script packages
 * (.bat / .cmd / .ps1 folders) stay in X:\<folder> and "copy" packages (folder deliveries) in X:\<name>: never cleaned up.
 */
function buildWindowsHostScript({ ip, nasPath, packages, reboot, forceReinstall, keepInstallers, jobId, credentialHeader, installerWaitMs = INSTALLER_WAIT_MS }) {
    const job = jobId === undefined || jobId === null ? crypto.randomUUID() : String(jobId);
    if (!JOB_ID_RE.test(job)) throw new Error('Invalid job id');
    const specs = packages.map(sw => ({ ...windowsPackageSpec(sw, nasPath), detect: packageDetect(sw) }));
    const pkgLiterals = specs.map(s => `    @{ Name = ${psQuote(s.name)}; Path = ${psQuote(s.fullPath)}; ParentPath = ${psQuote(s.parent)}; FolderName = ${psQuote(s.folder)}; Leaf = ${psQuote(s.leaf)}; SafeName = ${psQuote(s.safeName)}; IsScript = ${s.isScript ? '$true' : '$false'}; Args = ${psStringArray(s.args)}; DetectType = ${psQuote(s.detect.type)}; DetectValue = ${psQuote(s.detect.value)}; DetectMin = ${psQuote(s.detect.min)} }`).join(',\n');
    const okCodes = OK_EXIT_CODES.join(', ');
    return String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { Write-Output ('WARN|OutputEncoding|' + $_.Exception.Message) }
${credentialHeader}
$ip = ${psQuote(ip)}
$nasPath = ${psQuote(nasPath)}
$jobRoot = ${psQuote(PROVISION_ROOT)}
$jobDir = ${psQuote(`${PROVISION_ROOT}\\${job}`)}
$doReboot = ${reboot ? '$true' : '$false'}
$forceReinstall = ${forceReinstall ? '$true' : '$false'}
$keepInstallers = ${keepInstallers ? '$true' : '$false'}
$waitMs = ${Number(installerWaitMs) || INSTALLER_WAIT_MS}
$okCodes = @(${okCodes})
$packages = @(
${pkgLiterals}
)
$credArgs = @{}
if ($global:AD_CRED) { $credArgs.Credential = $global:AD_CRED }

function Emit-Pkg($o) { Write-Output ('${PKG_MARK}' + (ConvertTo-Json -Compress -InputObject $o)) }
function Emit-Host($o) { Write-Output ('${HOST_MARK}' + (ConvertTo-Json -Compress -InputObject $o)) }
function Resolve-Src($full) {
    $nasRoot = $nasPath.TrimEnd('\')
    $isUnder = $nasRoot -and (($full.TrimEnd('\') -ieq $nasRoot) -or $full.StartsWith(($nasRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase))
    if ($isUnder -and (Get-PSDrive -Name 'NASDrive' -ErrorAction SilentlyContinue)) {
        $rel = $full.Substring($nasRoot.Length).TrimStart('\')
        if (-not $rel) { return 'NASDrive:\' }
        return (Join-Path 'NASDrive:\' $rel)
    }
    return $full
}
function Copy-Children($srcDir, $destDir) {
    foreach ($c in (Get-ChildItem -LiteralPath $srcDir -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath (Join-Path $srcDir $c.Name) -Destination $destDir -Recurse -ToSession $session -Force -ErrorAction Stop
    }
}
${GUEST_BLOCK}
${GUEST_DETECT_BLOCK}
${GUEST_LOGS_BLOCK}
${GUEST_SWEEP_BLOCK}
$script:jobDirUsed = $false
$script:cleaned = $false
# Keeps the content of install_*.log files in the job result, then removes the job's work directory (warning only on failure)
function Invoke-Cleanup {
    if ($script:cleaned -or -not $script:jobDirUsed -or -not $session) { return }
    $script:cleaned = $true
    if ($keepInstallers) { Write-Output ('Installers kept on the guest (keepInstallers): ' + $jobDir); return }
    try {
        $logs = Invoke-Command -Session $session -ScriptBlock $guestReadLogs -ArgumentList $jobDir -ErrorAction Stop
        foreach ($l in @($logs)) {
            if ($l -and $l.Name) {
                Write-Output ('--- ' + $l.Name + ' ---')
                # Indented so that log text can never look like a result marker line
                foreach ($ln in [regex]::Split([string]$l.Tail, '\r?\n')) { Write-Output ('    ' + $ln) }
            }
        }
    } catch {
        Write-Output ('WARN|Cleanup|install logs could not be read: ' + $_.Exception.Message)
    }
    try {
        Invoke-Command -Session $session -ScriptBlock $guestRemove -ArgumentList $jobDir, $jobRoot -ErrorAction Stop
        Write-Output ('Cleanup: removed ' + $jobDir)
    } catch {
        Write-Output ('WARN|Cleanup|could not remove ' + $jobDir + ': ' + $_.Exception.Message)
    }
}

$session = $null
$allOk = $true
$anyInstalled = $false
try {
    if ($nasPath -and $nasPath.StartsWith('\\')) {
        try {
            if (Get-PSDrive -Name 'NASDrive' -ErrorAction SilentlyContinue) { Remove-PSDrive -Name 'NASDrive' -Force -ErrorAction SilentlyContinue }
            $null = New-PSDrive -Name 'NASDrive' -PSProvider FileSystem -Root $nasPath @credArgs -ErrorAction Stop
        } catch {
            Write-Output ('Warning: NAS share authentication failed: ' + $_.Exception.Message)
        }
    }

    Write-Output ('Connecting to guest VM at ' + $ip + ' ...')
    $session = New-PSSession -ComputerName $ip @credArgs -ErrorAction Stop
    Write-Output 'WinRM session established [OK]'
    Emit-Host @{ connected = $true }

    $hasX = [bool](Invoke-Command -Session $session -ScriptBlock { Test-Path 'X:\' })

    # Housekeeping: job folders of earlier runs that were killed before their cleanup (older than 7 days)
    if ($hasX) {
        try {
            $stale = Invoke-Command -Session $session -ScriptBlock $guestSweep -ArgumentList $jobRoot, '${job}', 7 -ErrorAction Stop
            foreach ($n in @($stale)) { if ($n) { Write-Output ('Cleanup: removed stale job folder ' + $n) } }
        } catch { }
    }

    for ($i = 0; $i -lt $packages.Count; $i++) {
        $pkg = $packages[$i]
        # idx is ASCII-only and is what the backend matches on (names may be non-ASCII)
        $r = @{ idx = $i; name = $pkg.Name; kind = 'installer'; exitCode = $null; timedOut = $false; error = ''; stdout = ''; stderr = ''; skipped = $false; version = '' }
        try {
            Write-Output ('=== package ' + ($i + 1) + ' of ' + $packages.Count + ' ===')
            if ($pkg.DetectType -and -not $forceReinstall) {
                $det = $null
                $dj = $null
                try {
                    # Own 30 s budget: a detect problem or timeout means "not installed" and never fails the host
                    $dj = Invoke-Command -Session $session -ScriptBlock $guestDetect -ArgumentList @($pkg.DetectType, $pkg.DetectValue, $pkg.DetectMin) -AsJob
                    if (Wait-Job -Job $dj -Timeout 30) {
                        $det = Receive-Job -Job $dj -ErrorAction Stop
                    } else {
                        Write-Output 'Detect check timed out after 30 s, installing anyway'
                        Stop-Job -Job $dj -ErrorAction SilentlyContinue
                    }
                } catch {
                    Write-Output ('Detect check failed, installing anyway: ' + $_.Exception.Message)
                } finally {
                    if ($dj) { Remove-Job -Job $dj -Force -ErrorAction SilentlyContinue }
                }
                if ($det -and $det.Error) { Write-Output ('Detect check problem, installing anyway: ' + $det.Error) }
                if ($det -and $det.Found) {
                    $r.skipped = $true
                    $r.version = [string]$det.Version
                    Emit-Pkg $r
                    continue
                }
            }
            if (-not $hasX) { throw 'Guest drive X: not found - prepare the data disk (Nutanix Clone VM does this)' }
            $src = Resolve-Src $pkg.Path
            if (-not (Test-Path -LiteralPath $src)) { throw ('Source not found: ' + $pkg.Path) }
            if (Test-Path -LiteralPath $src -PathType Leaf) {
                if ($pkg.IsScript) {
                    # Script packages keep the old location X:\<folder> and are never deleted (they may keep running from there)
                    $pkgDir = 'X:\' + $pkg.FolderName
                } else {
                    $pkgDir = $jobDir + '\' + $i
                    $script:jobDirUsed = $true
                }
                Invoke-Command -Session $session -ScriptBlock { param($p) if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } } -ArgumentList $pkgDir -ErrorAction Stop
                if ($pkg.IsScript) {
                    # Never copy a whole share / drive: the script's folder must not be a UNC share root or a drive root
                    if ($pkg.ParentPath -match '^\\\\[^\\]+\\[^\\]+\\?$' -or $pkg.ParentPath -match '^[A-Za-z]:\\?$' -or $pkg.ParentPath.TrimEnd('\') -ieq $nasPath.TrimEnd('\')) { throw 'Script packages cannot sit directly in a share or drive root; put them in a sub-folder' }
                    Copy-Children (Resolve-Src $pkg.ParentPath) $pkgDir
                } else {
                    Copy-Item -LiteralPath $src -Destination ($pkgDir + '\' + $pkg.Leaf) -ToSession $session -Force -ErrorAction Stop
                }
                $destFile = $pkgDir + '\' + $pkg.Leaf
                # The installer runs inside its own folder (single installers: the per-job folder, cleaned up with it)
                $g = Invoke-Command -Session $session -ScriptBlock $guestRun -ArgumentList @($destFile, $pkgDir, [string[]]$pkg.Args, $waitMs) -ErrorAction Stop
                if ($g.Error) { $r.error = [string]$g.Error }
                $r.timedOut = [bool]$g.TimedOut
                if ($null -ne $g.ExitCode) { $r.exitCode = [int]$g.ExitCode }
                $r.stdout = [string]$g.Stdout
                $r.stderr = [string]$g.Stderr
            } else {
                $r.kind = 'copy'
                $destDir = 'X:\' + $pkg.SafeName
                Invoke-Command -Session $session -ScriptBlock { param($p) if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } } -ArgumentList $destDir -ErrorAction Stop
                Copy-Children $src $destDir
            }
        } catch {
            $r.error = $_.Exception.Message
        }
        $pkgOk = (-not $r.error) -and (-not $r.timedOut) -and (($r.kind -eq 'copy') -or ($null -ne $r.exitCode -and $okCodes -contains $r.exitCode))
        if (-not $pkgOk) { $allOk = $false } else { $anyInstalled = $true }
        Emit-Pkg $r
    }

    Invoke-Cleanup

    if ($doReboot) {
        if ($allOk -and $anyInstalled) {
            Write-Output 'Rebooting guest VM...'
            Invoke-Command -Session $session -ScriptBlock { Restart-Computer -Force } -ErrorAction SilentlyContinue
        } elseif ($allOk) {
            Write-Output 'Reboot skipped because nothing was installed.'
        } else {
            Write-Output 'Reboot skipped because at least one package failed.'
        }
    }
    Emit-Host @{ done = $true }
} catch {
    Emit-Host @{ error = $_.Exception.Message }
} finally {
    try { Invoke-Cleanup } catch { }
    if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
    if (Get-PSDrive -Name 'NASDrive' -ErrorAction SilentlyContinue) { Remove-PSDrive -Name 'NASDrive' -Force -ErrorAction SilentlyContinue }
}
# Results are carried by the marker lines above; never let a stray $? decide the process exit code
exit 0
`;
}

function oneLine(s, max = 300) {
    return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Package result of a package whose detect rule found it installed. */
function skippedPackage(name, version) {
    const v = oneLine(version, 60);
    return { name: String(name || ''), exitCode: null, ok: true, skipped: true, rebootRequired: false, message: v ? `Already installed (${v})` : 'Already installed' };
}

/** Turns the raw facts reported for a package into { name, exitCode, ok, message, rebootRequired }. */
function evaluatePackage(raw) {
    const name = String(raw.name || '');
    const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
    const base = { name, exitCode };
    if (raw.error) return { ...base, ok: false, rebootRequired: false, message: oneLine(raw.error) };
    if (raw.skipped === true) return skippedPackage(name, raw.version);
    if (raw.timedOut) return { ...base, ok: false, rebootRequired: false, message: `Installer did not finish within ${Math.round(INSTALLER_WAIT_MS / 60000)} minutes and was terminated` };
    if (raw.kind === 'copy') return { ...base, ok: true, rebootRequired: false, message: 'Folder copied' };
    if (exitCode === null) return { ...base, ok: false, rebootRequired: false, message: 'Installer did not report an exit code' };
    if (REBOOT_EXIT_CODES.includes(exitCode)) return { ...base, ok: true, rebootRequired: true, message: `Installed, reboot required (exit code ${exitCode})` };
    if (OK_EXIT_CODES.includes(exitCode)) return { ...base, ok: true, rebootRequired: false, message: 'Installed (exit code 0)' };
    const tail = oneLine(raw.stderr || raw.stdout, 160);
    return { ...base, ok: false, rebootRequired: false, message: `Installer exited with code ${exitCode}${tail ? `: ${tail}` : ''}` };
}

/**
 * Parses the output of a Windows host script. expectedNames = packages that should have reported.
 * Packages without a result line are failures. The host is ok only if connected, finished and every package is ok.
 */
function parseHostOutput(output, ip, expectedNames, extraError) {
    // Results are matched by package INDEX (ASCII); the display name always comes from the configured list
    const byIdx = [];
    const logLines = [];
    let hostError = extraError || '';
    let done = false;
    for (const line of String(output || '').split(/\r?\n/)) {
        if (line.startsWith(PKG_MARK) || line.startsWith(HOST_MARK)) {
            let obj = null;
            try { obj = JSON.parse(line.slice(line.startsWith(PKG_MARK) ? PKG_MARK.length : HOST_MARK.length)); } catch (_) { /* ignored: treated as a missing result */ }
            if (!obj) continue;
            if (line.startsWith(PKG_MARK)) {
                const idx = obj.idx;
                if (!Number.isInteger(idx) || idx < 0 || idx >= (expectedNames || []).length) continue;
                const p = evaluatePackage({ ...obj, name: expectedNames[idx] });
                byIdx[idx] = p;
                logLines.push(`[${p.skipped ? 'SKIP' : p.ok ? 'OK' : 'FAIL'}] ${p.name}: ${p.message}`);
                const detail = oneLine(obj.stderr || obj.stdout, 400);
                if (!p.ok && detail) logLines.push(`      ${detail}`);
            } else {
                if (obj.error && !hostError) hostError = oneLine(obj.error);
                if (obj.done) done = true;
            }
        } else if (line.startsWith('WARN|Cleanup|')) {
            // A failed cleanup is a warning only: it never changes the result
            logLines.push(`Warning: cleanup problem: ${oneLine(line.slice('WARN|Cleanup|'.length), 300)}`);
        } else if (line.trim()) {
            logLines.push(line.trimEnd());
        }
    }
    const packages = (expectedNames || []).map((n, i) => byIdx[i] || { name: n, exitCode: null, ok: false, rebootRequired: false, message: 'Not executed (no result reported)' });
    if (!hostError && !done) hostError = 'Script ended before reporting completion';
    if (hostError) logLines.push(`ERROR: ${hostError}`);
    const ok = !hostError && packages.every(p => p.ok);
    return {
        ip, ok, packages, error: hostError || undefined,
        rebootRequired: packages.some(p => p.rebootRequired),
        log: logLines.join('\n')
    };
}

// ---------------------------------------------------------------------------------------------
// Job settings (provision.* keys live next to the REMOTE_INSTALL_* ones in the settings file / environment)
// ---------------------------------------------------------------------------------------------
const DEFAULT_HOST_CONCURRENCY = 4;
const MAX_HOST_CONCURRENCY = 10;
const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 730;
const DEFAULT_MIN_FREE_GB = 5;
const MAX_MIN_FREE_GB = 500;
const LOG_MAX_CHARS = 64 * 1024;

function clampInt(v, dflt, lo, hi) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

/** provision.hostConcurrency / historyRetentionDays / minFreeGB (PROVISION_HOST_CONCURRENCY, ...). */
function loadProvisionSettings(config, env = process.env) {
    return {
        hostConcurrency: clampInt(pick(config, env, 'PROVISION_HOST_CONCURRENCY'), DEFAULT_HOST_CONCURRENCY, 1, MAX_HOST_CONCURRENCY),
        historyRetentionDays: clampInt(pick(config, env, 'PROVISION_HISTORY_RETENTION_DAYS'), DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
        minFreeGB: clampInt(pick(config, env, 'PROVISION_MIN_FREE_GB'), DEFAULT_MIN_FREE_GB, 1, MAX_MIN_FREE_GB)
    };
}

const PRE_MARK = '@@PRE@@';
const NAS_MARK = '@@NAS@@';

/**
 * Read-only WinRM probe of ONE host: hostname, X: drive existence and free space and, for packages with a detect rule,
 * whether they are already installed (detects = [{ idx, type, value, minVersion }]). Never installs or changes anything.
 */
function buildWindowsPrecheckScript({ ip, credentialHeader, detects = [] }) {
    const rules = (detects || []).map(d => `    @{ Idx = ${Number(d.idx) | 0}; Type = ${psQuote(d.type)}; Value = ${psQuote(d.value)}; Min = ${psQuote(d.minVersion || '')} }`).join(',\n');
    return String.raw`
$ErrorActionPreference = 'Stop'
${credentialHeader}
$ip = ${psQuote(ip)}
$detects = @(
${rules}
)
$credArgs = @{}
if ($global:AD_CRED) { $credArgs.Credential = $global:AD_CRED }
${detects && detects.length ? GUEST_DETECT_BLOCK : ''}
$o = @{ ok = $false; hostname = ''; hasX = $false; freeGB = $null; error = ''; installed = @(); detectError = '' }
try {
    $r = Invoke-Command -ComputerName $ip @credArgs -ScriptBlock {
        $free = $null
        $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='X:'" -ErrorAction SilentlyContinue
        if ($d -and $d.FreeSpace -ne $null) { $free = [math]::Round($d.FreeSpace / 1GB, 1) }
        @{ hostname = [string]$env:COMPUTERNAME; hasX = [bool](Test-Path 'X:\'); freeGB = $free }
    } -ErrorAction Stop
    $o.ok = $true
    $o.hostname = [string]$r.hostname
    $o.hasX = [bool]$r.hasX
    $o.freeGB = $r.freeGB
} catch {
    $o.error = $_.Exception.Message
}
if ($o.ok -and $detects.Count -gt 0) {
    $ps = $null
    try {
        $ps = New-PSSession -ComputerName $ip @credArgs -ErrorAction Stop
        foreach ($d in $detects) {
            $x = Invoke-Command -Session $ps -ScriptBlock $guestDetect -ArgumentList @($d.Type, $d.Value, $d.Min) -ErrorAction Stop
            $o.installed += @{ idx = $d.Idx; found = [bool]$x.Found; version = [string]$x.Version }
        }
    } catch {
        $o.detectError = $_.Exception.Message
    } finally {
        if ($ps) { Remove-PSSession $ps -ErrorAction SilentlyContinue }
    }
}
Write-Output ('${PRE_MARK}' + (ConvertTo-Json -Compress -Depth 4 -InputObject $o))
exit 0
`;
}

/** Read-only check that the NAS share is reachable from the SOMP server with the operator credential. */
function buildNasCheckScript({ nasPath, credentialHeader }) {
    return String.raw`
$ErrorActionPreference = 'Stop'
${credentialHeader}
$nasPath = ${psQuote(nasPath)}
$credArgs = @{}
if ($global:AD_CRED) { $credArgs.Credential = $global:AD_CRED }
$o = @{ ok = $false; error = '' }
try {
    if ($nasPath.StartsWith('\\')) {
        $null = New-PSDrive -Name 'NASCheck' -PSProvider FileSystem -Root $nasPath @credArgs -ErrorAction Stop
        $o.ok = [bool](Test-Path -LiteralPath 'NASCheck:\')
    } else {
        $o.ok = [bool](Test-Path -LiteralPath $nasPath)
    }
    if (-not $o.ok) { $o.error = 'Path not found' }
} catch {
    $o.error = $_.Exception.Message
} finally {
    if (Get-PSDrive -Name 'NASCheck' -ErrorAction SilentlyContinue) { Remove-PSDrive -Name 'NASCheck' -Force -ErrorAction SilentlyContinue }
}
Write-Output ('${NAS_MARK}' + (ConvertTo-Json -Compress -InputObject $o))
exit 0
`;
}

function parseMarked(output, mark) {
    for (const line of String(output || '').split(/\r?\n/)) {
        if (line.startsWith(mark)) {
            try { return JSON.parse(line.slice(mark.length)); } catch (_) { /* treated as missing */ }
        }
    }
    return null;
}
const parsePrecheckOutput = (output) => parseMarked(output, PRE_MARK);
const parseNasOutput = (output) => parseMarked(output, NAS_MARK);

/** Shell command that reports whether a Linux package rule is satisfied (interpreted by parseLinuxDetect). */
function buildLinuxDetectCommand(detect) {
    if (detect.type === 'rpm') return `rpm -q --qf ${shellQuote('%{VERSION}-%{RELEASE}\\n')} ${shellQuote(detect.value)}`;
    if (detect.type === 'dpkg') return `dpkg-query -W -f=${shellQuote('${Status}|${Version}\\n')} ${shellQuote(detect.value)}`;
    return detect.value;
}

/** Interprets the SSH result of buildLinuxDetectCommand: { found, version } (several instances: versions joined by ", "). */
function parseLinuxDetect(detect, r) {
    const code = r && Number.isInteger(r.code) ? r.code : null;
    const lines = String((r && r.stdout) || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (code !== 0) return { found: false, version: '' };
    if (detect.type === 'rpm') return { found: true, version: lines.join(', ').slice(0, 80) };
    if (detect.type === 'dpkg') {
        const versions = lines.map(l => /^install ok installed\|(.*)$/.exec(l)).filter(Boolean).map(m => m[1].trim());
        return versions.length ? { found: true, version: versions.join(', ').slice(0, 80) } : { found: false, version: '' };
    }
    return { found: true, version: '' };
}

/** Log text kept in the job table: at most 64 KB. */
function truncateLog(text, max = LOG_MAX_CHARS) {
    const t = String(text === undefined || text === null ? '' : text);
    if (t.length * 3 <= max) return t;
    const buf = Buffer.from(t, 'utf8');
    if (buf.length <= max) return t;
    // cut on a UTF-8 character boundary
    let end = max;
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
    return `${buf.subarray(0, end).toString('utf8')}\n...[log truncated]`;
}

/**
 * Validates the PROVISION_* values of a settings save (strings or numbers; empty = default). Returns [] or readable errors.
 * Ranges: concurrency 1-10, retention 30-730 days, minimum free space 1-500 GB.
 */
function validateProvisionSettings(values) {
    const rules = [
        ['PROVISION_HOST_CONCURRENCY', 1, MAX_HOST_CONCURRENCY],
        ['PROVISION_HISTORY_RETENTION_DAYS', MIN_RETENTION_DAYS, MAX_RETENTION_DAYS],
        ['PROVISION_MIN_FREE_GB', 1, MAX_MIN_FREE_GB]
    ];
    const errors = [];
    for (const [key, lo, hi] of rules) {
        if (!values || values[key] === undefined || values[key] === null || String(values[key]).trim() === '') continue;
        const t = String(values[key]).trim();
        const n = Number(t);
        if (!/^\d+$/.test(t) || !Number.isInteger(n) || n < lo || n > hi) errors.push(`${key} must be a whole number between ${lo} and ${hi}`);
    }
    return errors;
}

function linuxSudoWrap(command, user, password) {
    if (user === 'root') return { cmd: command, stdin: undefined };
    // `sudo -k` forgets any cached timestamp so sudo itself always consumes the password from stdin; the command then
    // runs with stdin from /dev/null (exec </dev/null), so the password can never reach it. stdin is never logged.
    return { cmd: `sudo -k; sudo -S -p '' sh -c ${shellQuote(`exec </dev/null; ${command}`)}`, stdin: `${password}\n` };
}

/** Removes known secret values from text that is returned or logged (defence in depth; secrets are only in env/stdin). */
function scrubSecrets(text, secrets) {
    let out = String(text === undefined || text === null ? '' : text);
    for (const s of secrets || []) {
        if (s && String(s).length >= 3) out = out.split(String(s)).join('***');
    }
    return out;
}

module.exports = {
    MAX_IPS, PS_BASE_TIMEOUT_MS, PS_PER_PACKAGE_TIMEOUT_MS, PS_MAX_TIMEOUT_MS, INSTALLER_WAIT_MS, LINUX_HOST_TIMEOUT_MS,
    OK_EXIT_CODES, REBOOT_REQUIRED_CODE, PKG_MARK, HOST_MARK,
    computeTimeoutMs, parseMasterList, parseLinuxMasterList, loadInstallConfig, resolveSoftware,
    validateExecuteBody, tokenizeArgs, buildWindowsHostScript, evaluatePackage, parseHostOutput, linuxSudoWrap, oneLine,
    scrubSecrets, splitLines, REBOOT_EXIT_CODES, PROVISION_ROOT, GUEST_DETECT_BLOCK,
    DEFAULT_HOST_CONCURRENCY, MAX_HOST_CONCURRENCY, DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, DEFAULT_MIN_FREE_GB, LOG_MAX_CHARS,
    buildLinuxDetectCommand, parseLinuxDetect, skippedPackage, validateProvisionSettings, detectErrors, validateMasterListText, MAX_MIN_FREE_GB,
    PRE_MARK, NAS_MARK, isIpv4, clampInt, loadProvisionSettings, buildWindowsPrecheckScript, buildNasCheckScript, parsePrecheckOutput, parseNasOutput, truncateLog
};
