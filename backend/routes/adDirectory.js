// AD Control: the OU tree mode, maintenance reports, batch account actions and the exact last logon of a user.
// Mounted by routes/ad.js, which has already required sign-in and the adControl feature. Request values reach
// PowerShell only as single-quoted literals (psLit) after their format is checked.
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { runAsService, psLit, adErrorMessage, serviceAccount } = require('../lib/adService');
const adModel = require('../lib/adModel');
const { guardScript, guardRefusal } = require('../lib/adGuard');

const MAX_TREE_OUS = 2000;
const MAX_OBJECTS = 2000; // per object type in one OU
const MAX_REPORT = 2000;
const MAX_BATCH = 100;
const MAX_DCS = 50;
const REPORTS = ['locked', 'inactive', 'pwdExpiring'];
const OBJECT_TYPES = ['all', 'user', 'group', 'computer'];
const BATCH_ACTIONS = {
    unlock: { cmdlet: 'Unlock-ADAccount', verb: 'Unlocked' },
    enable: { cmdlet: 'Enable-ADAccount', verb: 'Enabled' },
    disable: { cmdlet: 'Disable-ADAccount', verb: 'Disabled' },
};
// Containers directly under the domain that the tree leaves out (as Active Directory Users and Computers does)
const HIDDEN_CONTAINERS = ['System', 'Program Data'];

function sendAdError(res, e) {
    res.status(e && e.status ? e.status : 500).json({ error: adErrorMessage(e) });
}

// a date property as ISO text, or '' (ConvertTo-Json would otherwise write "/Date(...)/")
const isoOf = (expr) => `$(if (${expr}) { ([datetime]${expr}).ToUniversalTime().ToString('o') } else { '' })`;
const searchBaseArg = () => (process.env.AD_OU_SEARCH ? `-SearchBase ${psLit(process.env.AD_OU_SEARCH)}` : '');

// GET /ou-tree — the domain, its OUs and the top-level containers (Users, Computers, ...)
router.get('/ou-tree', async (req, res) => {
    try {
        const output = await runAsService(`
$d = Get-ADDomain -Credential $global:AD_CRED @dcArgs
$ous = @(Get-ADOrganizationalUnit -Filter * -ResultSetSize ${MAX_TREE_OUS + 1} -Credential $global:AD_CRED @dcArgs)
$hidden = @(${HIDDEN_CONTAINERS.map(psLit).join(', ')})
$cns = @(Get-ADObject -SearchBase $d.DistinguishedName -SearchScope OneLevel -LDAPFilter '(objectClass=container)' -Credential $global:AD_CRED @dcArgs | Where-Object { $hidden -notcontains $_.Name })
[PSCustomObject]@{
    dn = [string]$d.DistinguishedName; name = [string]$d.DNSRoot
    ous = @($ous | ForEach-Object { [PSCustomObject]@{ dn = [string]$_.DistinguishedName; name = [string]$_.Name } })
    containers = @($cns | ForEach-Object { [PSCustomObject]@{ dn = [string]$_.DistinguishedName; name = [string]$_.Name } })
} | ConvertTo-Json -Depth 4 -Compress
`);
        const raw = String(output || '').trim();
        if (!raw) return res.status(502).json({ error: 'The domain controller returned no data' });
        res.json(adModel.shapeOuTree(JSON.parse(raw), MAX_TREE_OUS));
    } catch (e) {
        sendAdError(res, e);
    }
});

// GET /ou-objects?dn=&type= — users, groups and computers directly in one OU / container
router.get('/ou-objects', async (req, res) => {
    const dn = String(req.query.dn || '');
    const type = String(req.query.type || 'all');
    if (!adModel.isBrowsableDn(dn)) return res.status(400).json({ error: 'dn must be the distinguished name of the domain, an OU or a container' });
    if (!OBJECT_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${OBJECT_TYPES.join(', ')}` });
    const want = (t) => type === 'all' || type === t;
    const common = `-Filter * -SearchBase $base -SearchScope OneLevel -ResultSetSize ${MAX_OBJECTS + 1} -Credential $global:AD_CRED @dcArgs`;
    try {
        const output = await runAsService(`
$base = ${psLit(dn)}
$out = @()
${want('user') ? `$out += @(Get-ADUser ${common} -Properties Enabled, LockedOut, Description, LastLogonDate, adminCount | ForEach-Object {
    [PSCustomObject]@{ kind = 'user'; Name = [string]$_.Name; SamAccountName = [string]$_.SamAccountName; Description = [string]$_.Description
        Enabled = [bool]$_.Enabled; LockedOut = [bool]$_.LockedOut; LastLogonDate = ${isoOf('$_.LastLogonDate')}; Protected = ($_.adminCount -eq 1) } })` : ''}
${want('group') ? `$out += @(Get-ADGroup ${common} -Properties Description | ForEach-Object {
    [PSCustomObject]@{ kind = 'group'; Name = [string]$_.Name; SamAccountName = [string]$_.SamAccountName; Description = [string]$_.Description
        GroupScope = [string]$_.GroupScope; GroupCategory = [string]$_.GroupCategory } })` : ''}
${want('computer') ? `$out += @(Get-ADComputer ${common} -Properties Enabled, OperatingSystem, LastLogonDate, Description | ForEach-Object {
    [PSCustomObject]@{ kind = 'computer'; Name = [string]$_.Name; SamAccountName = [string]$_.SamAccountName; Description = [string]$_.Description
        Enabled = [bool]$_.Enabled; OperatingSystem = [string]$_.OperatingSystem; LastLogonDate = ${isoOf('$_.LastLogonDate')} } })` : ''}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`);
        const all = adModel.parseList(output);
        const result = { users: [], groups: [], computers: [], truncated: [] };
        for (const [kind, key] of [['user', 'users'], ['group', 'groups'], ['computer', 'computers']]) {
            const list = all.filter(o => o.kind === kind).sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
            if (list.length > MAX_OBJECTS) result.truncated.push(kind);
            result[key] = list.slice(0, MAX_OBJECTS);
        }
        res.json({ ...result, limit: MAX_OBJECTS });
    } catch (e) {
        sendAdError(res, e);
    }
});

// GET /report?type=locked|inactive|pwdExpiring&days= — maintenance lists of user accounts
router.get('/report', async (req, res) => {
    const type = String(req.query.type || '');
    if (!REPORTS.includes(type)) return res.status(400).json({ error: `type must be one of: ${REPORTS.join(', ')}` });
    const days = req.query.days === undefined ? (type === 'pwdExpiring' ? 14 : 90) : Number(req.query.days);
    if (type !== 'locked' && !(Number.isInteger(days) && days >= 1 && days <= 3650)) {
        return res.status(400).json({ error: 'days must be a whole number from 1 to 3650' });
    }
    const row = (extra = '') => `[PSCustomObject]@{ Name = [string]$_.Name; SamAccountName = [string]$_.SamAccountName; Enabled = [bool]$_.Enabled
        LockedOut = [bool]$_.LockedOut; LastLogonDate = ${isoOf('$_.LastLogonDate')}; DistinguishedName = [string]$_.DistinguishedName${extra} }`;
    let script;
    if (type === 'locked') {
        script = `$r = @(Search-ADAccount -LockedOut -UsersOnly ${searchBaseArg()} -Credential $global:AD_CRED @dcArgs | Select-Object -First ${MAX_REPORT + 1} | ForEach-Object { ${row()} })`;
    } else if (type === 'inactive') {
        script = `$r = @(Search-ADAccount -AccountInactive -TimeSpan (New-TimeSpan -Days ${days}) -UsersOnly ${searchBaseArg()} -Credential $global:AD_CRED @dcArgs | Select-Object -First ${MAX_REPORT + 1} | ForEach-Object { ${row()} })`;
    } else {
        script = `
$limit = (Get-Date).AddDays(${days})
$r = @(Get-ADUser -Filter "Enabled -eq 'True' -and PasswordNeverExpires -eq 'False'" ${searchBaseArg()} -Properties 'msDS-UserPasswordExpiryTimeComputed', LockedOut, LastLogonDate -Credential $global:AD_CRED @dcArgs | ForEach-Object {
    $ft = [int64]$_.'msDS-UserPasswordExpiryTimeComputed'
    if ($ft -gt 0 -and $ft -lt [int64]::MaxValue) {
        $exp = [DateTime]::FromFileTime($ft)
        if ($exp -le $limit) { ${row("; PasswordExpires = $exp.ToUniversalTime().ToString('o')")} }
    }
} | Select-Object -First ${MAX_REPORT + 1})`;
    }
    try {
        const output = await runAsService(`${script}\nConvertTo-Json -InputObject $r -Compress -Depth 3`);
        let rows = adModel.parseList(output);
        const truncated = rows.length > MAX_REPORT;
        rows = rows.slice(0, MAX_REPORT);
        if (type === 'pwdExpiring') rows.sort((a, b) => String(a.PasswordExpires).localeCompare(String(b.PasswordExpires)));
        else rows.sort((a, b) => String(a.SamAccountName).localeCompare(String(b.SamAccountName)));
        res.json({ type, days: type === 'locked' ? null : days, rows, truncated, limit: MAX_REPORT });
    } catch (e) {
        sendAdError(res, e);
    }
});

// POST /batch-action { action: unlock|enable|disable, sams: [...] } — one result per account
router.post('/batch-action', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { action, sams } = req.body || {};
    const spec = BATCH_ACTIONS[action];
    if (!spec) return res.status(400).json({ error: `action must be one of: ${Object.keys(BATCH_ACTIONS).join(', ')}` });
    if (!Array.isArray(sams) || sams.length === 0) return res.status(400).json({ error: 'sams must be a non-empty list' });
    const unique = [...new Set(sams)];
    if (unique.length > MAX_BATCH) return res.status(400).json({ error: `At most ${MAX_BATCH} accounts at a time` });
    if (!unique.every(adModel.isSam)) return res.status(400).json({ error: 'Every entry must be an account name' });
    try {
        const output = await runAsService(`${guardScript()}
$sams = @(${unique.map(psLit).join(', ')})
$out = @(foreach ($s in $sams) {
    try {
        $t = Get-ManagedUser $s
        ${spec.cmdlet} -Identity $t -Credential $global:AD_CRED @dcArgs
        [PSCustomObject]@{ sam = $s; ok = $true; error = '' }
    } catch {
        [PSCustomObject]@{ sam = $s; ok = $false; error = [string]$_.Exception.Message }
    }
})
ConvertTo-Json -InputObject $out -Compress
`, 300000);
        const byName = new Map(adModel.parseList(output).map(r => [String(r.sam), r]));
        const svc = serviceAccount().username;
        const results = unique.map(sam => {
            const r = byName.get(sam);
            if (!r) return { sam, ok: false, error: 'No result returned' };
            if (r.ok) auditLog(req.user.username, 'AD User Control', `${spec.verb} AD Account: ${sam} (batch, via service account ${svc})`);
            if (r.ok) return { sam, ok: true, error: '' };
            const refused = guardRefusal(r.error);
            return { sam, ok: false, refused: !!refused, error: refused ? refused.error : adErrorMessage({ message: String(r.error || 'Failed') }).slice(0, 300) };
        });
        res.json({ action, results, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
    } catch (e) {
        const refused = guardRefusal(e && (e.stderr || e.message));
        if (refused) return res.status(refused.status).json({ error: refused.error });
        sendAdError(res, e);
    }
});

// GET /user/:sam/last-logon — the newest lastLogon over every domain controller (lastLogon is not replicated)
router.get('/user/:sam/last-logon', async (req, res) => {
    const { sam } = req.params;
    if (!adModel.isSam(sam)) return res.status(400).json({ error: 'Invalid account name' });
    try {
        const output = await runAsService(`
$dcs = @(Get-ADDomainController -Filter * -Credential $global:AD_CRED @dcArgs | Select-Object -First ${MAX_DCS})
$out = @(foreach ($d in $dcs) {
    try {
        $u = Get-ADUser -Identity ${psLit(sam)} -Properties lastLogon -Server $d.HostName -Credential $global:AD_CRED
        [PSCustomObject]@{ dc = [string]$d.HostName; lastLogon = [string]$u.lastLogon; error = '' }
    } catch {
        [PSCustomObject]@{ dc = [string]$d.HostName; lastLogon = ''; error = 'unreachable' }
    }
})
ConvertTo-Json -InputObject $out -Compress
`, 180000);
        res.json(adModel.newestLogon(adModel.parseList(output)));
    } catch (e) {
        sendAdError(res, e);
    }
});

module.exports = router;
