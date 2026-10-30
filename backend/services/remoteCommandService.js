// Remote Command (POST /api/ops/command): request validation and per-host execution.
// Targets and secrets never reach a PowerShell script as text: everything goes through stdin (base64 JSON).

const { runPowerShell } = require('../lib/powershell');
const { executeSSH } = require('../lib/ssh');
const { readDefaultCredentials } = require('../lib/inventoryCredentials');

const MAX_TARGETS = 200;
const MAX_COMMAND_LENGTH = 20000;
const MAX_OUTPUT_CHARS = 512 * 1024;
const WINDOWS_TIMEOUT_MS = 120000;
const LINUX_EXEC_TIMEOUT_MS = 120000;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** An IPv4 address or a DNS host name: the only target text ever handed to PowerShell / SSH. */
function isValidTarget(t) {
    if (typeof t !== 'string') return false;
    if (/^[0-9.]+$/.test(t)) return IPV4.test(t);
    return HOSTNAME.test(t);
}

const DANGEROUS_COMMANDS = ['rm -rf', 'format-volume', 'clear-disk', 'remove-item -recurse -force c:\\', 'mkfs', 'del /f /s /q c:\\', 'set-executionpolicy bypass'];

// Guards against slips only (easy to bypass on purpose): not a security boundary
function isCommandDangerous(cmd) {
    if (!cmd) return false;
    const lowerCmd = cmd.toLowerCase();
    return DANGEROUS_COMMANDS.some(bad => lowerCmd.includes(bad));
}

/**
 * Validates the request body. Returns { error } (400 text) or { targets, winCommand, nixCommand, linuxPassword, winPassword }.
 * Targets are trimmed and de-duplicated (case-insensitive), at most MAX_TARGETS.
 */
function validateCommandRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (!Array.isArray(b.ips)) return { error: 'ips must be a list of IP addresses or host names' };
    for (const key of ['winCommand', 'nixCommand', 'linuxPassword', 'winPassword']) {
        if (b[key] !== undefined && b[key] !== null && typeof b[key] !== 'string') return { error: `${key} must be a string` };
    }
    const winCommand = b.winCommand || '';
    const nixCommand = b.nixCommand || '';
    if (!winCommand.trim() && !nixCommand.trim()) return { error: 'Enter a Windows or Linux command' };
    if (winCommand.length > MAX_COMMAND_LENGTH || nixCommand.length > MAX_COMMAND_LENGTH) {
        return { error: `A command may be at most ${MAX_COMMAND_LENGTH} characters` };
    }

    const seen = new Set();
    const targets = [];
    const invalid = [];
    for (const raw of b.ips) {
        if (typeof raw !== 'string') { invalid.push(String(raw)); continue; }
        const t = raw.trim();
        if (!t) continue;
        if (!isValidTarget(t)) { invalid.push(t); continue; }
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(t);
    }
    if (invalid.length > 0) {
        const shown = invalid.slice(0, 5).map(t => t.slice(0, 64).replace(/[^\x20-\x7e]/g, '?')).join(', ');
        return { error: `Invalid IP / host name: ${shown}${invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ''}` };
    }
    if (targets.length === 0) return { error: 'Enter at least one target IP / host name' };
    if (targets.length > MAX_TARGETS) return { error: `At most ${MAX_TARGETS} targets per run (got ${targets.length})` };

    return { targets, winCommand, nixCommand, linuxPassword: b.linuxPassword || '', winPassword: b.winPassword || '' };
}

function truncateOutput(text) {
    const s = String(text || '');
    if (s.length <= MAX_OUTPUT_CHARS) return s;
    return s.slice(0, MAX_OUTPUT_CHARS) + `\n... (output truncated at ${MAX_OUTPUT_CHARS / 1024} KB)`;
}

/**
 * Windows credentials for one run: the signed-in AD user (only when a password was typed; never for the local
 * break-glass account) and the Settings service account (AD_ADMIN_*, bare name qualified with ALLOWED_AD_DOMAIN).
 */
function resolveWindowsCredentials(user, winPassword, deps = {}) {
    const creds = (deps.readDefaultCredentials || readDefaultCredentials)();
    let userCred = null;
    if (user && user.username && user.domain && user.domain !== 'local' && winPassword) {
        userCred = { name: `${user.domain}\\${user.username}`, password: winPassword };
    }
    let serviceCred = null;
    if (creds.winUser && creds.winPassword) {
        let name = creds.winUser;
        const domain = creds.allowedAdDomain || creds.adDomain;
        if (domain && !name.includes('\\') && !name.includes('@')) name = `${domain}\\${name}`;
        serviceCred = { name, password: creds.winPassword };
    }
    return { userCred, serviceCred };
}

// Opens the session with the user's credential first and falls back to the service account only when the user's
// session cannot be opened (logon / access / WinRM errors). The command itself runs at most once.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$in = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
function New-SompCred($c) {
    New-Object System.Management.Automation.PSCredential ($c.name, (ConvertTo-SecureString $c.password -AsPlainText -Force))
}
$opt = New-PSSessionOption -OperationTimeout 30000 -OpenTimeout 20000
$result = @{ runAs = ''; userError = ''; serviceError = ''; output = ''; error = '' }
$session = $null
if ($in.user) {
    try { $session = New-PSSession -ComputerName $in.target -Credential (New-SompCred $in.user) -SessionOption $opt; $result.runAs = 'user' }
    catch { $result.userError = $_.Exception.Message }
}
if (-not $session -and $in.service) {
    try { $session = New-PSSession -ComputerName $in.target -Credential (New-SompCred $in.service) -SessionOption $opt; $result.runAs = 'service' }
    catch { $result.serviceError = $_.Exception.Message }
}
$in.user = $null; $in.service = $null
if ($session) {
    try {
        $result.output = Invoke-Command -Session $session -ScriptBlock ([ScriptBlock]::Create($in.script)) | Out-String
    } catch {
        $result.error = $_.Exception.Message
    } finally {
        Remove-PSSession $session -ErrorAction SilentlyContinue
    }
}
$json = $result | ConvertTo-Json -Compress
Write-Output ('@@SOMP_RESULT@@' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
`;

function parseWindowsResult(stdout) {
    const line = String(stdout || '').split(/\r?\n/).reverse().find(l => l.startsWith('@@SOMP_RESULT@@'));
    if (!line) return null;
    try {
        return JSON.parse(Buffer.from(line.slice('@@SOMP_RESULT@@'.length).trim(), 'base64').toString('utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Runs a PowerShell command on one Windows host. Returns { ip, status, os, runAs, output }.
 * runAs: 'user' | 'service' | '' (no session).
 */
async function runWindowsCommand(target, command, { userCred, serviceCred }, deps = {}) {
    const base = { ip: target, status: 'Online', os: 'Windows', runAs: '' };
    if (!userCred && !serviceCred) {
        return { ...base, status: 'Failed', output: 'WinRM Error: enter your Windows password, or configure the service account (AD_ADMIN_USER / AD_ADMIN_PWD) in Settings.' };
    }
    const payload = Buffer.from(JSON.stringify({ target, script: command, user: userCred, service: serviceCred }), 'utf8').toString('base64');
    let stdout;
    try {
        stdout = await (deps.runPowerShell || runPowerShell)(WINDOWS_SCRIPT, WINDOWS_TIMEOUT_MS, { stdin: payload });
    } catch (err) {
        const reason = (err && (err.stderr || (err.error && err.error.message) || err.message)) || 'unknown error';
        return { ...base, status: 'Failed', output: 'WinRM Error: ' + truncateOutput(reason) };
    }
    const r = parseWindowsResult(stdout);
    if (!r) return { ...base, status: 'Failed', output: 'WinRM Error: unexpected PowerShell output' };

    const notes = [];
    if (r.runAs === 'service' && userCred) notes.push(`[已改用服務帳號執行：個人帳號 ${userCred.name} 連線失敗 — ${r.userError}]`);
    if (!r.runAs) {
        const reasons = [];
        if (userCred) reasons.push(`個人帳號 ${userCred.name}: ${r.userError}`);
        if (serviceCred) reasons.push(`服務帳號 ${serviceCred.name}: ${r.serviceError}`);
        return { ...base, status: 'Failed', output: 'WinRM Error: 無法建立連線\n' + reasons.join('\n') };
    }
    const runAsName = r.runAs === 'user' ? userCred.name : serviceCred.name;
    if (r.error) {
        return { ...base, status: 'Failed', runAs: r.runAs, runAsName, output: truncateOutput([...notes, 'Command error: ' + r.error].join('\n')) };
    }
    const out = String(r.output || '').trim() || '(No output)';
    return { ...base, runAs: r.runAs, runAsName, output: truncateOutput([...notes, out].join('\n')) };
}

/** Runs a shell command on one Linux host as LINUX_ADMIN_USER. */
async function runLinuxCommand(target, command, password, deps = {}) {
    const base = { ip: target, status: 'Online', os: 'Linux' };
    if (!password) return { ...base, status: 'Failed', output: 'Missing Linux password' };
    try {
        const { stdout, stderr } = await (deps.executeSSH || executeSSH)(
            target, process.env.LINUX_ADMIN_USER || 'xyuser', password, command,
            { timeout: 10000, execTimeoutMs: LINUX_EXEC_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_CHARS }
        );
        return { ...base, output: truncateOutput(stdout + (stderr ? '\nERR:' + stderr : '')) };
    } catch (err) {
        return { ...base, status: 'Failed', output: 'SSH Error: ' + (err && err.message) };
    }
}

module.exports = {
    MAX_TARGETS,
    MAX_COMMAND_LENGTH,
    MAX_OUTPUT_CHARS,
    isValidTarget,
    isCommandDangerous,
    validateCommandRequest,
    resolveWindowsCredentials,
    runWindowsCommand,
    runLinuxCommand,
    parseWindowsResult,
    truncateOutput,
    WINDOWS_SCRIPT
};
