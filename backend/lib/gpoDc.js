// Shared plumbing of the GPO routes: running a script block on the domain controller as the AD service account,
// the common script preambles, input formats and error replies.
// Every value a request sends is checked against its format and reaches PowerShell only as a single-quoted literal
// (psLit), so nothing typed into the page can become script.
const { runAsService, psLit, adErrorMessage, dcHost, serviceAccount } = require('./adService');

const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
// a path on the domain controller (C:\...) or a share (\\server\share\...)
const BACKUP_PATH_RE = /^(?:[A-Za-z]:\\|\\\\[^\\/:*?"<>|\x00-\x1f]+\\)[^:*?"<>|\x00-\x1f]{0,240}$/;
const CONTROL_RE = /[\x00-\x1f]/;

function sendError(res, e) {
    res.status(e && e.status ? e.status : 500).json({ error: adErrorMessage(e) });
}

/**
 * Run a GPO script block on the domain controller: $session is opened with the service account, the block gets the
 * listed literal arguments.
 */
function onDc(block, args = [], timeoutMs = 60000) {
    const dc = dcHost();
    if (!dc) {
        const err = new Error('AD_DC_HOST (or ALLOWED_AD_DOMAIN) is not configured');
        err.status = 503; err.userSafe = true;
        throw err;
    }
    serviceAccount(); // throws the readable "not configured" error before any PowerShell starts
    return runAsService(`
$session = New-PSSession -ComputerName $dc -Credential $global:AD_CRED -ErrorAction Stop
try {
    Invoke-Command -Session $session -ScriptBlock {
${block}
    }${args.length ? ` -ArgumentList ${args.map(psLit).join(', ')}` : ''}
} finally {
    Remove-PSSession -Session $session
}
`, timeoutMs);
}

const GPMC_CHECK = `
        $ErrorActionPreference = "Stop"
        if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
        Import-Module GroupPolicy`;

// Only the domain root or an OU can take a link or block inheritance; checked again on the DC ($t = the DN).
const TARGET_CHECK = `
        Import-Module ActiveDirectory
        $o = Get-ADObject -Identity $t -Server localhost
        if (@('organizationalUnit', 'domainDNS') -notcontains [string]$o.ObjectClass) { throw "The target must be the domain or an OU" }`;

function parseJsonList(output) {
    const raw = String(output || '').trim();
    if (!raw || raw === '[]' || raw === 'null') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonObject(output) {
    const raw = String(output || '').trim();
    return raw ? JSON.parse(raw) : null;
}

/** A name for an audit line: no control characters (no forged lines), at most 256 characters. */
const auditName = (name, fallback) => String(name || fallback).replace(/[\x00-\x1f]/g, ' ').slice(0, 256);

module.exports = {
    GUID_RE, BACKUP_PATH_RE, CONTROL_RE, sendError, onDc, GPMC_CHECK, TARGET_CHECK,
    parseJsonList, parseJsonObject, auditName,
};
