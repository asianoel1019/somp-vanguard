// Changing a password in Active Directory through PowerShell (ActiveDirectory module, RSAT).
// The scripts are fixed text: the account, both passwords, the service account and the OUs reach PowerShell only
// as environment variables of that one process, so nothing typed into the page can become script and no secret
// is ever on a command line or in a script file.
const { spawn } = require('child_process');

const TIMEOUT_MS = 30000;
const RESULT_PREFIX = 'PWC_RESULT ';

const PREAMBLE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:ADPS_LoadDefaultDrive = 0
Import-Module ActiveDirectory
$cred = New-Object System.Management.Automation.PSCredential ($env:PWC_SVC_USER, (ConvertTo-SecureString $env:PWC_SVC_PWD -AsPlainText -Force))
$p = @{ Credential = $cred }
if ($env:PWC_SERVER) { $p.Server = $env:PWC_SERVER }
function Out-Result($code, $data) {
    Write-Output ('${RESULT_PREFIX}' + ([PSCustomObject]@{ code = $code; data = $data } | ConvertTo-Json -Compress -Depth 3))
}
`;

// Finds the account, refuses protected / disabled / out-of-scope accounts, then changes the password with the old one.
const CHANGE_SCRIPT = `${PREAMBLE}
try {
    if ($env:PWC_KIND -eq 'upn') {
        $upn = $env:PWC_ACCOUNT.Replace("'", "''")
        $u = @(Get-ADUser -Filter "UserPrincipalName -eq '$upn'" -Properties adminCount, mail @p) | Select-Object -First 1
        if (-not $u) { Out-Result 'NOT_FOUND' $null; return }
    } else {
        $u = Get-ADUser -Identity $env:PWC_ACCOUNT -Properties adminCount, mail @p
    }
} catch [Microsoft.ActiveDirectory.Management.ADIdentityNotFoundException] {
    Out-Result 'NOT_FOUND' $null; return
} catch {
    Out-Result 'ERROR' ([string]$_.Exception.Message -replace '\\s+', ' '); return
}
$svcSam = (($env:PWC_SVC_USER -split '\\\\')[-1] -split '@')[0]
if ($u.adminCount -eq 1 -or $u.SamAccountName -eq 'krbtgt' -or $u.SamAccountName -eq $svcSam) { Out-Result 'PROTECTED' ([string]$u.SamAccountName); return }
if (-not $u.Enabled) { Out-Result 'DISABLED' ([string]$u.SamAccountName); return }
$scopes = @(([string]$env:PWC_SCOPES) -split "\`n" | Where-Object { $_ })
if ($scopes.Count -gt 0) {
    $parts = @($u.DistinguishedName -split '(?<!\\\\),' | ForEach-Object { $_.Trim().ToLowerInvariant() })
    $inside = $false
    foreach ($scope in $scopes) {
        $s = @($scope -split '(?<!\\\\),' | ForEach-Object { $_.Trim().ToLowerInvariant() })
        if ($s.Count -le $parts.Count) {
            $tail = @($parts[($parts.Count - $s.Count)..($parts.Count - 1)])
            if ($null -eq (Compare-Object -ReferenceObject $s -DifferenceObject $tail -SyncWindow 0)) { $inside = $true; break }
        }
    }
    if (-not $inside) { Out-Result 'OUT_OF_SCOPE' ([string]$u.SamAccountName); return }
}
try {
    $old = ConvertTo-SecureString $env:PWC_OLD -AsPlainText -Force
    $new = ConvertTo-SecureString $env:PWC_NEW -AsPlainText -Force
    Set-ADAccountPassword -Identity $u -OldPassword $old -NewPassword $new @p
    Out-Result 'OK' ([PSCustomObject]@{ sam = [string]$u.SamAccountName; name = [string]$u.Name; mail = [string]$u.mail })
} catch {
    Out-Result 'FAIL' ([PSCustomObject]@{ type = [string]$_.Exception.GetType().FullName; message = ([string]$_.Exception.Message -replace '\\s+', ' ') })
}
`;

const POLICY_SCRIPT = `${PREAMBLE}
$d = Get-ADDefaultDomainPasswordPolicy @p
Out-Result 'OK' ([PSCustomObject]@{
    minLength = [int]$d.MinPasswordLength
    complexity = [bool]$d.ComplexityEnabled
    history = [int]$d.PasswordHistoryCount
    minAgeDays = [double]$d.MinPasswordAge.TotalDays
    maxAgeDays = [double]$d.MaxPasswordAge.TotalDays
    lockoutThreshold = [int]$d.LockoutThreshold
})
`;

/** Runs a fixed script with extra environment variables; resolves to stdout. */
function runPowerShell(script, env, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
            env: { ...process.env, ...env },
            windowsHide: true,
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { ps.kill(); reject(new Error('PowerShell timed out')); }, timeoutMs);
        ps.stdout.on('data', d => { out += d.toString('utf8'); });
        ps.stderr.on('data', d => { err += d.toString('utf8'); });
        ps.on('error', e => { clearTimeout(timer); reject(e); });
        ps.on('close', code => {
            clearTimeout(timer);
            if (code === 0 || out.includes(RESULT_PREFIX)) resolve(out);
            else reject(new Error((err || `PowerShell exited with ${code}`).split(/\r?\n/).find(l => l.trim()) || 'PowerShell failed'));
        });
    });
}

/** The PWC_RESULT line of the output -> { code, data }; throws when there is none. */
function parseResult(out) {
    const line = String(out || '').split(/\r?\n/).reverse().find(l => l.startsWith(RESULT_PREFIX));
    if (!line) throw new Error('No result from PowerShell');
    return JSON.parse(line.slice(RESULT_PREFIX.length));
}

/**
 * What a change attempt means for the page:
 * - ok: changed
 * - invalid: unknown account, wrong current password, locked, disabled, protected or outside the OUs (one answer for
 *   all of them, so the page does not tell which accounts exist)
 * - policy: the new password breaks the domain policy (length, complexity, history, minimum age)
 * - error: anything else (AD unreachable, ...)
 */
function classify(result) {
    const code = result && result.code;
    if (code === 'OK') return { outcome: 'ok', reason: 'changed' };
    if (['NOT_FOUND', 'PROTECTED', 'DISABLED', 'OUT_OF_SCOPE'].includes(code)) return { outcome: 'invalid', reason: code.toLowerCase() };
    if (code === 'FAIL') {
        const d = result.data || {};
        const text = `${d.type || ''} ${d.message || ''}`;
        if (/PasswordComplexity|length, complexity, or history|password does not meet|密碼不符合/i.test(text)) return { outcome: 'policy', reason: 'policy' };
        if (/InvalidPassword|network password is not correct|password is incorrect|密碼不正確/i.test(text)) return { outcome: 'invalid', reason: 'wrong current password' };
        if (/locked out|已被鎖定/i.test(text)) return { outcome: 'invalid', reason: 'locked out' };
        if (/disabled|已停用/i.test(text)) return { outcome: 'invalid', reason: 'disabled' };
        return { outcome: 'error', reason: String(d.message || d.type || 'change failed').slice(0, 300) };
    }
    return { outcome: 'error', reason: String((result && result.data) || 'unknown result').slice(0, 300) };
}

function serviceEnv(config) {
    return { PWC_SVC_USER: config.serviceUser, PWC_SVC_PWD: config.servicePassword, PWC_SERVER: config.adServer };
}

/** Changes the password; resolves to { outcome, reason, account? } and never rejects. */
async function changePassword(config, { account, oldPassword, newPassword }, run = runPowerShell) {
    try {
        const out = await run(CHANGE_SCRIPT, {
            ...serviceEnv(config),
            PWC_KIND: account.kind,
            PWC_ACCOUNT: account.value,
            PWC_OLD: oldPassword,
            PWC_NEW: newPassword,
            PWC_SCOPES: config.ous.join('\n'),
        });
        const result = parseResult(out);
        const c = classify(result);
        return result.code === 'OK' ? { ...c, account: result.data } : c;
    } catch (err) {
        return { outcome: 'error', reason: String(err.message || err).slice(0, 300) };
    }
}

/** The domain's default password policy (shown on the page). */
async function passwordPolicy(config, run = runPowerShell) {
    const result = parseResult(await run(POLICY_SCRIPT, serviceEnv(config)));
    if (result.code !== 'OK') throw new Error('Could not read the password policy');
    return result.data;
}

module.exports = { CHANGE_SCRIPT, POLICY_SCRIPT, runPowerShell, parseResult, classify, changePassword, passwordPolicy };
