const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { runAsService, psLit, adErrorMessage, dcHost, serviceAccount } = require('../lib/adService');
const gpoModel = require('../lib/gpoModel');

router.use(requireAuth);
router.use(checkFeature('adControl'));

// Every value a request sends is checked against its format here and reaches PowerShell only as a single-quoted
// literal (psLit), so nothing typed into the page can become script.
const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const GPO_STATUSES = ['AllSettingsEnabled', 'AllSettingsDisabled', 'UserSettingsDisabled', 'ComputerSettingsDisabled'];
const REG_TYPES = ['String', 'ExpandString', 'DWord', 'QWord', 'MultiString', 'Binary'];
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

function parseJsonList(output) {
    const raw = String(output || '').trim();
    if (!raw || raw === '[]' || raw === 'null') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
}

// GET /list
router.get('/list', async (req, res) => {
    try {
        const domain = String(process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
        const output = await onDc(`
        param($d)
${GPMC_CHECK}
        $gpos = $null
        try {
            $gpos = Get-GPO -All -Server localhost
        } catch {
            if ($d) { $gpos = Get-GPO -All -Domain $d -Server localhost } else { throw }
        }
        if ($gpos) {
            @($gpos) | Select-Object DisplayName, Id, GpoStatus, CreationTime, ModificationTime | ConvertTo-Json -Compress
        } else {
            Write-Output "[]"
        }`, [domain]);
        let gpos = [];
        try {
            gpos = parseJsonList(output);
        } catch (jsonErr) {
            console.error(`[GPO List] Could not parse the GPO list (${String(output || '').length} chars): ${jsonErr.message}`);
        }
        res.json({ gpos });
    } catch (e) {
        console.error('[GPO List] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// GET /registry-list
router.get('/registry-list', async (req, res) => {
    const { guid } = req.query;
    if (!guid) return res.status(400).json({ error: 'Missing guid parameter' });
    if (!GUID_RE.test(String(guid))) return res.status(400).json({ error: 'Invalid GPO id' });

    try {
        const output = await onDc(`
        param($gId)
${GPMC_CHECK}
        [xml]$xml = Get-GPOReport -Guid $gId -ReportType Xml -Server localhost
        $nodes = $xml.SelectNodes("//*[local-name()='RegistrySetting']")
        $settings = @()
        foreach ($node in $nodes) {
            $hive = "HKLM"
            $parent = $node.ParentNode
            while ($parent -and $parent.Name -ne "Computer" -and $parent.Name -ne "User") {
                $parent = $parent.ParentNode
            }
            if ($parent -and $parent.Name -eq "User") {
                $hive = "HKCU"
            }
            $settings += [PSCustomObject]@{
                hive = $hive
                key = $node.Key.InnerText
                valueName = $(if ($node.ValueName) { $node.ValueName.InnerText } else { "" })
                type = $(if ($node.ValueType) { $node.ValueType.InnerText } else { "" })
                value = $(if ($node.Value) { $node.Value.InnerText } else { "" })
            }
        }
        if ($settings.Count -gt 0) { $settings | ConvertTo-Json -Compress } else { Write-Output "[]" }`, [String(guid)]);
        let settings = [];
        try {
            settings = parseJsonList(output);
        } catch (jsonErr) {
            console.error(`[GPO Reg List] Could not parse the registry settings: ${jsonErr.message}`);
        }
        res.json({ settings });
    } catch (e) {
        console.error('[GPO Reg List] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// ---- GPMC-style views (read-only) ----

const MAX_TREE_OUS = 2000;
const MAX_REPORT_CHARS = 5 * 1024 * 1024;

function parseJsonObject(output) {
    const raw = String(output || '').trim();
    return raw ? JSON.parse(raw) : null;
}

// GET /tree — the domain, its OUs with their GPO links and inheritance blocking, and every GPO
router.get('/tree', async (req, res) => {
    try {
        const output = await onDc(`
        param($max)
${GPMC_CHECK}
        Import-Module ActiveDirectory
        $d = Get-ADDomain -Server localhost
        $root = Get-ADObject -Identity $d.DistinguishedName -Properties gPLink, gPOptions -Server localhost
        $ous = @(Get-ADOrganizationalUnit -Filter * -Properties gPLink, gPOptions -ResultSetSize ([int]$max + 1) -Server localhost)
        $gpos = @(Get-GPO -All -Server localhost)
        [PSCustomObject]@{
            domain = [PSCustomObject]@{ dn = [string]$d.DistinguishedName; dns = [string]$d.DNSRoot; gPLink = [string]$root.gPLink; gPOptions = [string]$root.gPOptions }
            ous = @($ous | ForEach-Object { [PSCustomObject]@{ dn = [string]$_.DistinguishedName; name = [string]$_.Name; gPLink = [string]$_.gPLink; gPOptions = [string]$_.gPOptions } })
            gpos = @($gpos | ForEach-Object { [PSCustomObject]@{ id = [string]$_.Id; name = [string]$_.DisplayName; status = [string]$_.GpoStatus; wmi = $(if ($_.WmiFilter) { [string]$_.WmiFilter.Name } else { '' }); created = $_.CreationTime.ToString('o'); modified = $_.ModificationTime.ToString('o') } })
        } | ConvertTo-Json -Depth 4 -Compress`, [String(MAX_TREE_OUS)]);
        const raw = parseJsonObject(output);
        if (!raw) return res.status(502).json({ error: 'The domain controller returned no data' });
        res.json(gpoModel.shapeTree(raw, MAX_TREE_OUS));
    } catch (e) {
        console.error('[GPO Tree] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// GET /detail?guid= — Details, security filtering and delegation of one GPO
router.get('/detail', async (req, res) => {
    const guid = String(req.query.guid || '');
    if (!GUID_RE.test(guid)) return res.status(400).json({ error: 'Invalid GPO id' });
    try {
        const output = await onDc(`
        param($gId)
${GPMC_CHECK}
        $g = Get-GPO -Guid $gId -Server localhost
        $perms = @(Get-GPPermission -Guid $gId -All -Server localhost)
        [PSCustomObject]@{
            id = [string]$g.Id; name = [string]$g.DisplayName; domain = [string]$g.DomainName; owner = [string]$g.Owner
            status = [string]$g.GpoStatus; description = [string]$g.Description
            created = $g.CreationTime.ToString('o'); modified = $g.ModificationTime.ToString('o')
            userVersion = [PSCustomObject]@{ ds = [int]$g.User.DSVersion; sysvol = [int]$g.User.SysvolVersion }
            computerVersion = [PSCustomObject]@{ ds = [int]$g.Computer.DSVersion; sysvol = [int]$g.Computer.SysvolVersion }
            wmiFilter = $(if ($g.WmiFilter) { [PSCustomObject]@{ name = [string]$g.WmiFilter.Name; description = [string]$g.WmiFilter.Description } } else { $null })
            permissions = @($perms | ForEach-Object { [PSCustomObject]@{ trustee = [string]$_.Trustee.Name; domain = [string]$_.Trustee.Domain; sidType = [string]$_.Trustee.SidType; permission = [string]$_.Permission; inherited = [bool]$_.Inherited; denied = [bool]$_.Denied } })
        } | ConvertTo-Json -Depth 4 -Compress`, [guid]);
        const detail = parseJsonObject(output);
        if (!detail) return res.status(404).json({ error: 'GPO not found' });
        detail.id = String(detail.id || '').replace(/[{}]/g, '').toLowerCase();
        detail.permissions = Array.isArray(detail.permissions) ? detail.permissions : detail.permissions ? [detail.permissions] : [];
        res.json(detail);
    } catch (e) {
        console.error('[GPO Detail] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// GET /report?guid= — the GPMC settings report (HTML). Operator+: Group Policy Preferences can carry stored passwords.
router.get('/report', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const guid = String(req.query.guid || '');
    if (!GUID_RE.test(guid)) return res.status(400).json({ error: 'Invalid GPO id' });
    try {
        const output = await onDc(`
        param($gId)
${GPMC_CHECK}
        Get-GPOReport -Guid $gId -ReportType Html -Server localhost`, [guid], 120000);
        let html = String(output || '');
        if (html.length > MAX_REPORT_CHARS) return res.status(413).json({ error: 'The settings report is too large to show here' });
        // shown in a sandboxed frame that runs no script; scripts are removed here as well
        html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
        res.json({ html });
    } catch (e) {
        console.error('[GPO Report] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// GET /wmi-filters — the domain's WMI filters
router.get('/wmi-filters', async (req, res) => {
    try {
        const output = await onDc(`
        $ErrorActionPreference = "Stop"
        Import-Module ActiveDirectory
        $d = Get-ADDomain -Server localhost
        $base = "CN=SOM,CN=WMIPolicy,CN=System," + $d.DistinguishedName
        $f = @(Get-ADObject -SearchBase $base -Filter "objectClass -eq 'msWMI-Som'" -Properties 'msWMI-ID', 'msWMI-Name', 'msWMI-Parm1', 'msWMI-Parm2', 'whenChanged' -Server localhost)
        ConvertTo-Json -Compress -Depth 3 -InputObject @($f | ForEach-Object { [PSCustomObject]@{ id = [string]$_.'msWMI-ID'; name = [string]$_.'msWMI-Name'; description = [string]$_.'msWMI-Parm1'; parm2 = [string]$_.'msWMI-Parm2'; modified = $_.whenChanged.ToString('o') } })`);
        const filters = parseJsonList(output).map(f => ({
            id: String(f.id || ''), name: String(f.name || ''), description: String(f.description || ''),
            modified: String(f.modified || ''), queries: gpoModel.parseWmiQueries(f.parm2),
        }));
        res.json({ filters });
    } catch (e) {
        console.error('[GPO WMI] Failed:', adErrorMessage(e));
        sendError(res, e);
    }
});

// ---- Link management (Operator+) ----

const MAX_LINK_ORDER = 999;
const auditName = (name, fallback) => String(name || fallback).replace(/[\x00-\x1f]/g, ' ').slice(0, 256);
const yesNoArg = (v) => (v === undefined || v === null ? '' : v ? 'Yes' : 'No');

// Only the domain root or an OU can take a link or block inheritance; checked again on the DC.
const TARGET_CHECK = `
        Import-Module ActiveDirectory
        $o = Get-ADObject -Identity $t -Server localhost
        if (@('organizationalUnit', 'domainDNS') -notcontains [string]$o.ObjectClass) { throw "The target must be the domain or an OU" }`;

function badTarget(res, target) {
    if (!gpoModel.isContainerDn(target)) {
        res.status(400).json({ error: 'target must be the distinguished name of the domain or an OU' });
        return true;
    }
    return false;
}

// POST /link — link an existing GPO to the domain or an OU (the new link is enabled, last in link order)
router.post('/link', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, target, name } = req.body || {};
    if (!GUID_RE.test(String(guid || ''))) return res.status(400).json({ error: 'Invalid GPO id' });
    if (badTarget(res, target)) return;
    try {
        await onDc(`
        param($gId, $t)
${GPMC_CHECK}
${TARGET_CHECK}
        New-GPLink -Guid $gId -Target $t -LinkEnabled Yes -Server localhost | Out-Null`, [String(guid), String(target)]);
        auditLog(req.user.username, 'GPO Manager', `Linked GPO '${auditName(name, guid)}' to ${target}`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /link/delete — remove a link (the GPO itself stays)
router.post('/link/delete', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, target, name } = req.body || {};
    if (!GUID_RE.test(String(guid || ''))) return res.status(400).json({ error: 'Invalid GPO id' });
    if (badTarget(res, target)) return;
    try {
        await onDc(`
        param($gId, $t)
${GPMC_CHECK}
        Remove-GPLink -Guid $gId -Target $t -Server localhost | Out-Null`, [String(guid), String(target)]);
        auditLog(req.user.username, 'GPO Manager', `Deleted the link of GPO '${auditName(name, guid)}' from ${target}`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /link/set — Enforced, Link Enabled and / or Link Order of one link
router.post('/link/set', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, target, name, enforced, enabled, order } = req.body || {};
    if (!GUID_RE.test(String(guid || ''))) return res.status(400).json({ error: 'Invalid GPO id' });
    if (badTarget(res, target)) return;
    for (const [label, v] of [['enforced', enforced], ['enabled', enabled]]) {
        if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: `${label} must be true or false` });
    }
    if (order !== undefined && !(Number.isInteger(order) && order >= 1 && order <= MAX_LINK_ORDER)) {
        return res.status(400).json({ error: `order must be a whole number from 1 to ${MAX_LINK_ORDER}` });
    }
    if (enforced === undefined && enabled === undefined && order === undefined) {
        return res.status(400).json({ error: 'Nothing to change: send enforced, enabled or order' });
    }
    try {
        await onDc(`
        param($gId, $t, $enf, $en, $ord)
${GPMC_CHECK}
        $p = @{ Guid = $gId; Target = $t; Server = 'localhost' }
        if ($enf) { $p.Enforced = $enf }
        if ($en) { $p.LinkEnabled = $en }
        if ($ord) { $p.Order = [int]$ord }
        Set-GPLink @p | Out-Null`, [String(guid), String(target), yesNoArg(enforced), yesNoArg(enabled), order === undefined ? '' : String(order)]);
        const changes = [
            enforced !== undefined ? `Enforced=${yesNoArg(enforced)}` : '',
            enabled !== undefined ? `LinkEnabled=${yesNoArg(enabled)}` : '',
            order !== undefined ? `Order=${order}` : '',
        ].filter(Boolean).join(', ');
        auditLog(req.user.username, 'GPO Manager', `Changed the link of GPO '${auditName(name, guid)}' on ${target}: ${changes}`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /inheritance — block or unblock inheritance on the domain or an OU
router.post('/inheritance', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { target, blocked } = req.body || {};
    if (badTarget(res, target)) return;
    if (typeof blocked !== 'boolean') return res.status(400).json({ error: 'blocked must be true or false' });
    try {
        await onDc(`
        param($t, $b)
${GPMC_CHECK}
${TARGET_CHECK}
        Set-GPInheritance -Target $t -IsBlocked $b -Server localhost | Out-Null`, [String(target), yesNoArg(blocked)]);
        auditLog(req.user.username, 'GPO Manager', `${blocked ? 'Blocked' : 'Unblocked'} inheritance on ${target}`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/status', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, status, name } = req.body;
    if (!guid || !status) return res.status(400).json({ error: 'Missing guid or status' });
    if (!GUID_RE.test(String(guid))) return res.status(400).json({ error: 'Invalid GPO id' });
    if (!GPO_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${GPO_STATUSES.join(', ')}` });

    try {
        await onDc(`
        param($gId, $s)
${GPMC_CHECK}
        $gpo = Get-GPO -Guid $gId -Server localhost
        $gpo.GpoStatus = $s`, [String(guid), status]);
        auditLog(req.user.username, 'GPO Manager', `Changed GPO '${name || guid}' status to ${status}`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/backup', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, name, nasPath } = req.body;
    if (guid && !GUID_RE.test(String(guid))) return res.status(400).json({ error: 'Invalid GPO id' });
    // a path on the domain controller (C:\...) or a share (\\server\share\...)
    const targetPath = nasPath || 'C:\\GPO_Backups';
    if (!BACKUP_PATH_RE.test(targetPath)) {
        return res.status(400).json({ error: 'Backup path must be a local path (C:\\...) or a UNC share (\\\\server\\share\\...) without * ? " < > |' });
    }

    try {
        const result = await onDc(`
        param($gId, $path)
${GPMC_CHECK}
        if (!(Test-Path $path)) {
            New-Item -ItemType Directory -Force -Path $path | Out-Null
        }
        if ($gId -eq "ALL") {
            Backup-GPO -All -Path $path | Out-Null
        } else {
            Backup-GPO -Guid $gId -Path $path | Out-Null
        }
        return "Backup saved to $path"`, [guid ? String(guid) : 'ALL', targetPath]);
        auditLog(req.user.username, 'GPO Manager', `Backed up GPO '${name || 'ALL'}' to ${targetPath}`);
        res.json({ success: true, message: String(result || '').trim() });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /security
// Very basic implementation: modify Registry values (Administrative Templates) inside a GPO
// Real Security Settings (GptTmpl.inf) require advanced logic which we'll expand later.
router.post('/security', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, name, key, valueName, type, value, action } = req.body;
    if (!guid || !key || !action) return res.status(400).json({ error: 'Missing required parameters' });
    if (!GUID_RE.test(String(guid))) return res.status(400).json({ error: 'Invalid GPO id' });
    if (!['Set', 'Remove'].includes(action)) return res.status(400).json({ error: 'action must be Set or Remove' });
    const regType = type || 'String';
    if (!REG_TYPES.includes(regType)) return res.status(400).json({ error: `type must be one of: ${REG_TYPES.join(', ')}` });
    for (const [label, v, max] of [['key', key, 512], ['valueName', valueName || '', 256], ['value', value === undefined || value === null ? '' : value, 4096]]) {
        if (typeof v !== 'string' && typeof v !== 'number') return res.status(400).json({ error: `${label} must be text` });
        if (String(v).length > max || CONTROL_RE.test(String(v))) return res.status(400).json({ error: `${label} is too long or contains control characters` });
    }

    const safeKeyPattern = /Software\\(Policies|Microsoft\\Windows\\CurrentVersion\\Policies)\\/i;
    const unsafeKeyPattern = /\\(Run|RunOnce|RunServices|RunServicesOnce|RunEx)\b/i;

    if (!safeKeyPattern.test(key) || unsafeKeyPattern.test(key)) {
        return res.status(403).json({ error: 'Registry key path is not permitted for modification.' });
    }

    try {
        await onDc(`
        param($gId, $act, $k, $vName, $t, $v)
${GPMC_CHECK}
        if ($act -eq "Set") {
            Set-GPRegistryValue -Guid $gId -Key $k -ValueName $vName -Type $t -Value $v | Out-Null
        } else {
            Remove-GPRegistryValue -Guid $gId -Key $k -ValueName $vName | Out-Null
        }`, [String(guid), action, key, String(valueName || ''), regType, String(value === undefined || value === null ? '' : value)]);
        auditLog(req.user.username, 'GPO Manager', `Edited Security/Registry Policy '${key}' for GPO '${name || guid}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
