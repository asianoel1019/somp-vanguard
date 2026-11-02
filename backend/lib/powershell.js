const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Validates Active Directory credentials using PowerShell.
 * @param {string} username Username without domain
 * @param {string} domain Domain name
 * @param {string} password Password
 * @returns {Promise<boolean>}
 */
function validateADCredentials(username, domain, password) {
    return new Promise((resolve, reject) => {
        const safePassword = password ? password.replace(/'/g, "''") : '';
        const safeUser = username ? username.replace(/'/g, "''") : '';
        const safeDomain = domain ? domain.replace(/'/g, "''") : '';
        const script = `
            Add-Type -AssemblyName System.DirectoryServices.AccountManagement;
            try {
                $context = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Domain, '${safeDomain}');
                $result = $context.ValidateCredentials('${safeUser}', '${safePassword}');
                Write-Output $result;
            } catch {
                Write-Output "Error: $($_.Exception.Message)";
            }
        `;
        const b64Script = Buffer.from(script, 'utf16le').toString('base64');

        exec(`powershell.exe -EncodedCommand ${b64Script}`, (error, stdout, stderr) => {
            if (error) {
                console.error('[PowerShell] AD Auth Error:', error, stderr);
                return resolve(stderr || error.message); 
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Sanitizes a string for safe inclusion in PowerShell scripts.
 * Escapes single quotes, backticks, and dollar signs to prevent breakout attacks.
 * @param {string} input The raw string to sanitize
 * @returns {string} The sanitized string safe to use inside single quotes.
 */
function sanitizePsString(input) {
    if (!input) return '';
    return String(input)
        .replace(/'/g, "''")      // Escape single quotes for PS literal strings
        .replace(/`/g, '``')      // Escape backticks (PS escape char)
        .replace(/\$/g, '`$');    // Escape dollar signs (PS variable char)
}

/**
 * Executes a PowerShell command using stdin to avoid command-line length limits.
 * Secrets must NOT be interpolated into `command` (it is written to a temp .ps1):
 * pass them through options.env (read as $env:NAME) or options.stdin ([Console]::In.ReadToEnd()).
 * @param {string} command PowerShell command
 * @param {number} timeoutMs Optional timeout in milliseconds (default: 60000ms)
 * @param {{ env?: object, stdin?: string, spawnImpl?: Function }} options
 * @returns {Promise<string>}
 */
function runPowerShell(command, timeoutMs = 60000, options = {}) {
    return new Promise((resolve, reject) => {
        const tempFileName = `temp_run_${crypto.randomBytes(6).toString('hex')}.ps1`;
        const tempFilePath = path.join(__dirname, '..', tempFileName);
        
        try {
            // Prepend UTF-8 BOM (\ufeff) to ensure Windows PowerShell 5.1 correctly parses UTF-8 without Big5/ANSI corruptions
            fs.writeFileSync(tempFilePath, '\ufeff' + command, 'utf8');
        } catch (err) {
            return reject({ error: err, stderr: 'Failed to write temp PowerShell file: ' + err.message });
        }

        const psCmd = `& '${tempFilePath}'`;
        const spawnFn = options.spawnImpl || spawn;
        const spawnOpts = options.env ? { env: { ...process.env, ...options.env } } : {};
        const ps = spawnFn('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-NonInteractive',
            '-NoProfile',
            '-Command', psCmd
        ], spawnOpts);
        if (ps.stdin) {
            // Always close stdin so PowerShell never waits on it; optionally feed a payload
            try {
                ps.stdin.on && ps.stdin.on('error', () => {});
                ps.stdin.end(options.stdin !== undefined && options.stdin !== null ? String(options.stdin) : undefined);
            } catch (e) {}
        }
        
        let stdout = '';
        let stderr = '';

        // Decode as a stream so a multi-byte character split across chunks is not corrupted
        if (typeof ps.stdout.setEncoding === 'function') ps.stdout.setEncoding('utf8');
        if (typeof ps.stderr.setEncoding === 'function') ps.stderr.setEncoding('utf8');
        ps.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        ps.stderr.on('data', (data) => {
            const errStr = data.toString();
            stderr += errStr;
            console.error('[PowerShell STDERR]', errStr.trim());
        });

        let isKilled = false;
        let timeoutTimer = null;
        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                isKilled = true;
                try {
                    ps.kill();
                    if (process.platform === 'win32' && ps.pid) {
                        require('child_process').exec(`taskkill /pid ${ps.pid} /T /F`, () => {});
                    }
                } catch(e) {}
                try {
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                } catch(e) {}
                reject({
                    error: new Error(`PowerShell execution timed out after ${timeoutMs}ms`),
                    stdout: stdout.trim(),
                    stderr: (stderr || stdout || 'Timeout').trim()
                });
            }, timeoutMs);
        }

        ps.on('error', (err) => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            try {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            } catch(e) {}
            reject({ error: err, stderr: err.message });
        });

        let hasClosed = false;
        const finalize = (code) => {
            if (hasClosed) return;
            hasClosed = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (isKilled) return;

            // Clean up temp file
            try {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            } catch (cleanupErr) {
                console.error('[PowerShell CleanUp Error]', cleanupErr.message);
            }

            if (code !== 0 && code !== null) {
                // stdout is included so callers can still use partial output (added field, backward compatible)
                return reject({ error: new Error(`Process exited with code ${code}`), stderr, stdout });
            }
            resolve(stdout);
        };

        ps.on('exit', (code) => {
            // Process has exited. Wait at most 500ms for remaining stdio buffers to flush, then finalize
            setTimeout(() => finalize(code), 500);
        });

        ps.on('close', (code) => {
            finalize(code);
        });
    });
}

// PowerShell snippet that builds $global:AD_CRED from SOMP_CRED_USER / SOMP_CRED_PWD (see buildCredentialEnv)
// so that no secret is ever written into a script file.
const ENV_CREDENTIAL_HEADER = `
$global:AD_CRED = $null;
if ($env:SOMP_CRED_USER -and $env:SOMP_CRED_PWD) {
    $secPass = ConvertTo-SecureString $env:SOMP_CRED_PWD -AsPlainText -Force;
    $global:AD_CRED = New-Object System.Management.Automation.PSCredential ($env:SOMP_CRED_USER, $secPass);
}
Remove-Item Env:SOMP_CRED_PWD -ErrorAction SilentlyContinue;
`;

function buildCredentialEnv(user, password) {
    if (!user || !password) return {};
    return { SOMP_CRED_USER: String(user), SOMP_CRED_PWD: String(password) };
}

function getADCredentialHeader(username, domain, password) {
    if (!password || domain === 'local') return '';
    const safePass = (password || '').replace(/'/g, "''");
    const safeUsername = (username || '').replace(/'/g, "''");
    const safeDomain = (domain || '').replace(/'/g, "''");
    
    let credUser = safeUsername;
    if (safeDomain && !safeUsername.includes('\\') && !safeUsername.includes('@')) {
        credUser = `${safeDomain}\\${safeUsername}`;
    }

    return `
$secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force;
$global:AD_CRED = New-Object System.Management.Automation.PSCredential ('${credUser}', $secPass);
    `;
}

function getCimSessionHeader(targetHost) {
    return `
$global:CIM_SESS = $null;
try { Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "*" -Force -ErrorAction SilentlyContinue } catch {}
$optWsman = New-CimSessionOption -Protocol Wsman;
$optDcom = New-CimSessionOption -Protocol Dcom;
try {
    if ($global:AD_CRED) {
        $global:CIM_SESS = New-CimSession -ComputerName "${targetHost}" -Credential $global:AD_CRED -SessionOption $optWsman -OperationTimeoutSec 5 -ErrorAction Stop;
    } else {
        $global:CIM_SESS = New-CimSession -ComputerName "${targetHost}" -SessionOption $optWsman -OperationTimeoutSec 5 -ErrorAction Stop;
    }
} catch {
    try {
        if ($global:AD_CRED) {
            $global:CIM_SESS = New-CimSession -ComputerName "${targetHost}" -Credential $global:AD_CRED -SessionOption $optDcom -OperationTimeoutSec 5 -ErrorAction Stop;
        } else {
            $global:CIM_SESS = New-CimSession -ComputerName "${targetHost}" -SessionOption $optDcom -OperationTimeoutSec 5 -ErrorAction Stop;
        }
    } catch {
        $global:CIM_SESS = $null;
    }
}
    `;
}

function getCimSessionCleanup() {
    return `
if ($global:CIM_SESS) { Remove-CimSession $global:CIM_SESS -ErrorAction SilentlyContinue }
    `;
}

module.exports = {
    validateADCredentials,
    runPowerShell,
    ENV_CREDENTIAL_HEADER,
    buildCredentialEnv,
    sanitizePsString,
    getADCredentialHeader,
    getCimSessionHeader,
    getCimSessionCleanup
};
