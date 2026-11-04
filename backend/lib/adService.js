// Running Active Directory / GPO PowerShell as the AD service account (AD_ADMIN_USER / AD_ADMIN_PWD).
// - The service account is required: AD Control never falls back to the signed-in user's own password.
// - The password reaches PowerShell through an environment variable, never the script text: runPowerShell writes the
//   script to a temporary file, and PowerShell errors quote script lines.
// - Values from requests go into scripts only as single-quoted literals (psLit) or validated formats.
// through the module object, so tests can replace runPowerShell
const powershell = require('./powershell');
const { psSq } = require('./psQuote');

const PASSWORD_ENV = 'SOMP_AD_SERVICE_PWD';
const MAX_ERROR_LENGTH = 400;

class AdConfigError extends Error {
    constructor(message) { super(message); this.status = 503; this.userSafe = true; }
}

/** A PowerShell single-quoted literal: nothing inside expands. */
const psLit = (value) => `'${psSq(value)}'`;

/** @returns {{ username: string, domain: string, password: string }} */
function serviceAccount() {
    const raw = String(process.env.AD_ADMIN_USER || '').trim();
    const password = process.env.AD_ADMIN_PWD || '';
    if (!raw || !password) {
        throw new AdConfigError('AD service account is not configured: set AD_ADMIN_USER and AD_ADMIN_PWD in Settings > System Settings');
    }
    if (raw.includes('\\')) {
        const [domain, username] = raw.split('\\');
        return { username, domain, password };
    }
    const domain = String(process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
    return { username: raw, domain, password };
}

/** Domain controller to query ('' = let AD pick one). Read per call so Settings changes apply without a restart. */
function dcHost() {
    return String(process.env.AD_DC_HOST || process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
}

/** Script preamble: $global:AD_CRED for the service account, $dc / $dcArgs for the optional -Server. */
function preamble(account) {
    const user = account.domain && !account.username.includes('@') ? `${account.domain}\\${account.username}` : account.username;
    return `$ErrorActionPreference = "Stop"
$secPass = ConvertTo-SecureString $env:${PASSWORD_ENV} -AsPlainText -Force
$global:AD_CRED = New-Object System.Management.Automation.PSCredential (${psLit(user)}, $secPass)
$dc = ${psLit(dcHost())}
$dcArgs = @{}
if ($dc) { $dcArgs.Server = $dc }
`;
}

/** Run a script as the service account. The script may use $global:AD_CRED, $dc and splat @dcArgs. */
async function runAsService(body, timeoutMs = 60000) {
    const account = serviceAccount();
    return powershell.runPowerShell(`${preamble(account)}\n${body}`, timeoutMs, { env: { [PASSWORD_ENV]: account.password } });
}

/**
 * The part of a PowerShell failure worth showing: the first error lines, without the script position lines
 * ("At C:\...ps1:12 char:5", "+ ~~~") and with any configured secret removed.
 */
function adErrorMessage(e) {
    if (e && e.userSafe) return e.message;
    const raw = String((e && (e.stderr || (e.error && e.error.message) || e.message)) || e || 'PowerShell failed');
    const lines = raw.split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !/^At (line:|[A-Za-z]:\\|\\\\)/.test(l) && !/^\+/.test(l) && !/CategoryInfo|FullyQualifiedErrorId/.test(l));
    let text = lines.slice(0, 3).join(' ').slice(0, MAX_ERROR_LENGTH) || 'PowerShell failed';
    for (const secret of [process.env.AD_ADMIN_PWD]) {
        if (secret) text = text.split(secret).join('***');
    }
    return text;
}

module.exports = { AdConfigError, psLit, serviceAccount, dcHost, runAsService, adErrorMessage, PASSWORD_ENV };
