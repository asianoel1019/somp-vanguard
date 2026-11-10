// GPO lifecycle and permissions for the GPMC-style Group Policy page: create, rename, copy, comment, delete,
// security filtering, delegation, WMI filter and backups / restore. Mounted by routes/gpo.js, which has already
// required sign-in and the adControl feature.
// Who may do what: Operator+ for everything that only changes a GPO's settings or scope; SuperAdmin for deleting a
// GPO (cannot be undone) and delegation (decides who can edit or take over a GPO).
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const {
    GUID_RE, BACKUP_PATH_RE, CONTROL_RE, sendError, onDc, GPMC_CHECK, TARGET_CHECK, parseJsonList, auditName,
} = require('../lib/gpoDc');
const gpoModel = require('../lib/gpoModel');

const operator = checkRole(['SuperAdmin', 'Operator']);
const superAdmin = checkRole(['SuperAdmin']);

const BRACED_GUID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
// sAMAccountName-like, optionally "DOMAIN\name"; spaces allowed ("Authenticated Users"), $ for computer accounts
const TRUSTEE_RE = /^(?:[^\\\x00-\x1f"/[\]:;|=,+*?<>]{1,64}\\)?[^\\\x00-\x1f"/[\]:;|=,+*?<>]{1,256}$/;
const TRUSTEE_TYPES = ['User', 'Group', 'Computer'];
const DELEGATION_LEVELS = ['GpoRead', 'GpoEdit', 'GpoEditDeleteModifySecurity'];
const MAX_BACKUPS = 500;
const DEFAULT_BACKUP_PATH = 'C:\\GPO_Backups';

const bareGuid = (g) => String(g).replace(/[{}]/g, '').toLowerCase();
const user = (req) => req.user.username;

/** A GPO name: 1-255 characters after trimming, no control characters. */
function cleanName(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s && s.length <= 255 && !CONTROL_RE.test(s) ? s : null;
}
/** A comment: up to 2048 characters; line breaks allowed. */
function cleanComment(v) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > 2048 || /[\x00-\x09\x0b\x0c\x0e-\x1f]/.test(v)) return null;
    return v;
}
const badGuid = (res, guid) => {
    if (GUID_RE.test(String(guid || ''))) return false;
    res.status(400).json({ error: 'Invalid GPO id' });
    return true;
};

// POST /create — a new GPO; with linkTo, also link it there (Create a GPO in this domain, and Link it here)
router.post('/create', operator, async (req, res) => {
    const { name, comment, linkTo } = req.body || {};
    const n = cleanName(name);
    if (!n) return res.status(400).json({ error: 'name must be 1 to 255 characters without control characters' });
    const c = cleanComment(comment);
    if (c === null) return res.status(400).json({ error: 'comment must be text of at most 2048 characters' });
    if (linkTo && !gpoModel.isContainerDn(linkTo)) return res.status(400).json({ error: 'linkTo must be the distinguished name of the domain or an OU' });
    try {
        const out = await onDc(`
        param($n, $c, $t)
${GPMC_CHECK}
        if ($t) {
${TARGET_CHECK}
        }
        $g = New-GPO -Name $n -Comment $c -Server localhost
        if ($t) { New-GPLink -Guid $g.Id -Target $t -LinkEnabled Yes -Server localhost | Out-Null }
        [string]$g.Id`, [n, c, linkTo ? String(linkTo) : '']);
        const id = bareGuid(String(out || '').trim());
        auditLog(user(req), 'GPO Manager', `Created GPO '${auditName(n)}' {${id}}${linkTo ? ` and linked it to ${linkTo}` : ''}`);
        res.json({ success: true, id });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /rename
router.post('/rename', operator, async (req, res) => {
    const { guid, name, newName } = req.body || {};
    if (badGuid(res, guid)) return;
    const n = cleanName(newName);
    if (!n) return res.status(400).json({ error: 'newName must be 1 to 255 characters without control characters' });
    try {
        await onDc(`
        param($gId, $n)
${GPMC_CHECK}
        Rename-GPO -Guid $gId -TargetName $n -Server localhost | Out-Null`, [String(guid), n]);
        auditLog(user(req), 'GPO Manager', `Renamed GPO '${auditName(name, guid)}' to '${auditName(n)}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /copy — a new GPO with the same settings (and, with copyAcl, the same permissions); links are not copied
router.post('/copy', operator, async (req, res) => {
    const { guid, name, newName, copyAcl } = req.body || {};
    if (badGuid(res, guid)) return;
    const n = cleanName(newName);
    if (!n) return res.status(400).json({ error: 'newName must be 1 to 255 characters without control characters' });
    if (copyAcl !== undefined && typeof copyAcl !== 'boolean') return res.status(400).json({ error: 'copyAcl must be true or false' });
    try {
        const out = await onDc(`
        param($gId, $n, $acl)
${GPMC_CHECK}
        $p = @{ SourceGuid = $gId; TargetName = $n }
        if ($acl -eq 'Yes') { $p.CopyAcl = $true }
        $g = Copy-GPO @p
        [string]$g.Id`, [String(guid), n, copyAcl ? 'Yes' : 'No'], 120000);
        const id = bareGuid(String(out || '').trim());
        auditLog(user(req), 'GPO Manager', `Copied GPO '${auditName(name, guid)}' to '${auditName(n)}' {${id}}${copyAcl ? ' with its permissions' : ''}`);
        res.json({ success: true, id });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /comment
router.post('/comment', operator, async (req, res) => {
    const { guid, name, comment } = req.body || {};
    if (badGuid(res, guid)) return;
    const c = cleanComment(comment);
    if (c === null) return res.status(400).json({ error: 'comment must be text of at most 2048 characters' });
    try {
        await onDc(`
        param($gId, $c)
${GPMC_CHECK}
        $g = Get-GPO -Guid $gId -Server localhost
        $g.Description = $c`, [String(guid), c]);
        auditLog(user(req), 'GPO Manager', `Changed the comment of GPO '${auditName(name, guid)}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /delete — SuperAdmin; the caller repeats the GPO name, which must still be the GPO's name on the DC.
// Remove-GPO also deletes the GPO's links in the domain.
router.post('/delete', superAdmin, async (req, res) => {
    const { guid, name, confirmName } = req.body || {};
    if (badGuid(res, guid)) return;
    const n = cleanName(name);
    if (!n || confirmName !== n) return res.status(400).json({ error: 'Type the GPO name exactly to confirm the deletion' });
    try {
        await onDc(`
        param($gId, $n)
${GPMC_CHECK}
        $g = Get-GPO -Guid $gId -Server localhost
        if ($g.DisplayName -cne $n) { throw "The GPO is now named '$($g.DisplayName)'; refresh and try again" }
        Remove-GPO -Guid $gId -Server localhost | Out-Null`, [String(guid), n]);
        auditLog(user(req), 'GPO Manager', `Deleted GPO '${auditName(n)}' {${bareGuid(guid)}} and its links`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

function badTrustee(res, trustee, trusteeType) {
    if (typeof trustee !== 'string' || !TRUSTEE_RE.test(trustee.trim())) {
        res.status(400).json({ error: 'trustee must be an account or group name (optionally DOMAIN\\name)' });
        return true;
    }
    if (!TRUSTEE_TYPES.includes(trusteeType)) {
        res.status(400).json({ error: `trusteeType must be one of: ${TRUSTEE_TYPES.join(', ')}` });
        return true;
    }
    return false;
}

const SET_PERMISSION = `
        param($gId, $tn, $tt, $lvl)
${GPMC_CHECK}
        Set-GPPermission -Guid $gId -TargetName $tn -TargetType $tt -PermissionLevel $lvl -Replace -Server localhost | Out-Null`;

// POST /filtering — Security Filtering: add gives Apply; remove keeps Read only (GPOs must stay readable)
router.post('/filtering', operator, async (req, res) => {
    const { guid, name, action, trustee, trusteeType } = req.body || {};
    if (badGuid(res, guid)) return;
    if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'action must be add or remove' });
    if (badTrustee(res, trustee, trusteeType)) return;
    const level = action === 'add' ? 'GpoApply' : 'GpoRead';
    try {
        await onDc(SET_PERMISSION, [String(guid), trustee.trim(), trusteeType, level]);
        auditLog(user(req), 'GPO Manager', `${action === 'add' ? 'Added' : 'Removed'} '${auditName(trustee.trim())}' ${action === 'add' ? 'to' : 'from'} the security filtering of GPO '${auditName(name, guid)}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /delegation — SuperAdmin: set a trustee's permission (Read / Edit / Edit, delete, modify security) or remove it
router.post('/delegation', superAdmin, async (req, res) => {
    const { guid, name, action, trustee, trusteeType, permission } = req.body || {};
    if (badGuid(res, guid)) return;
    if (!['set', 'remove'].includes(action)) return res.status(400).json({ error: 'action must be set or remove' });
    if (badTrustee(res, trustee, trusteeType)) return;
    if (action === 'set' && !DELEGATION_LEVELS.includes(permission)) {
        return res.status(400).json({ error: `permission must be one of: ${DELEGATION_LEVELS.join(', ')}` });
    }
    const level = action === 'set' ? permission : 'None';
    try {
        await onDc(SET_PERMISSION, [String(guid), trustee.trim(), trusteeType, level]);
        auditLog(user(req), 'GPO Manager', action === 'set'
            ? `Set the permission of '${auditName(trustee.trim())}' on GPO '${auditName(name, guid)}' to ${level}`
            : `Removed the permissions of '${auditName(trustee.trim())}' from GPO '${auditName(name, guid)}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /wmi-filter — link the GPO to a WMI filter ({ID} from /wmi-filters) or to none (filterId null / '')
router.post('/wmi-filter', operator, async (req, res) => {
    const { guid, name, filterId } = req.body || {};
    if (badGuid(res, guid)) return;
    if (filterId && !BRACED_GUID_RE.test(String(filterId))) return res.status(400).json({ error: 'Invalid WMI filter id' });
    try {
        await onDc(`
        param($gId, $fid)
${GPMC_CHECK}
        Import-Module ActiveDirectory
        $d = Get-ADDomain -Server localhost
        $gpoDn = "CN={" + $gId + "},CN=Policies,CN=System," + $d.DistinguishedName
        if ($fid) {
            $som = "CN=SOM,CN=WMIPolicy,CN=System," + $d.DistinguishedName
            $f = @(Get-ADObject -SearchBase $som -LDAPFilter "(msWMI-ID=$fid)" -Server localhost)
            if ($f.Count -ne 1) { throw "WMI filter $fid was not found" }
            Set-ADObject -Identity $gpoDn -Replace @{ gPCWQLFilter = "[" + $d.DNSRoot + ";" + $fid + ";0]" } -Server localhost
        } else {
            Set-ADObject -Identity $gpoDn -Clear gPCWQLFilter -Server localhost
        }`, [bareGuid(guid), filterId ? String(filterId) : '']);
        auditLog(user(req), 'GPO Manager', filterId
            ? `Linked GPO '${auditName(name, guid)}' to WMI filter ${filterId}`
            : `Removed the WMI filter of GPO '${auditName(name, guid)}'`);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// Text of a bkupInfo.xml element: PowerShell gives a text-only element as a string, others as XmlElement.
const XML_TEXT = `
        $text = { param($e) if ($null -eq $e) { '' } elseif ($e -is [string]) { $e } else { [string]$e.InnerText } }`;

function backupPath(v) {
    const p = v ? String(v) : DEFAULT_BACKUP_PATH;
    return BACKUP_PATH_RE.test(p) ? p : null;
}

// GET /backups?path= — GPO backups in a folder (newest first, at most 500)
router.get('/backups', operator, async (req, res) => {
    const path = backupPath(req.query.path);
    if (!path) return res.status(400).json({ error: 'path must be a local path (C:\\...) or a UNC share (\\\\server\\share\\...)' });
    try {
        const output = await onDc(`
        param($path)
        $ErrorActionPreference = "Stop"
        if (!(Test-Path -LiteralPath $path)) { Write-Output "[]"; return }
${XML_TEXT}
        $out = @(Get-ChildItem -LiteralPath $path -Directory | ForEach-Object {
            $f = Join-Path $_.FullName 'bkupInfo.xml'
            if (Test-Path -LiteralPath $f) {
                [xml]$x = Get-Content -LiteralPath $f -Raw
                $b = $x.BackupInst
                [PSCustomObject]@{
                    id = (& $text $b.ID); gpoId = (& $text $b.GPOGuid); name = (& $text $b.GPODisplayName)
                    domain = (& $text $b.GPODomain); time = (& $text $b.BackupTime); comment = (& $text $b.Comment)
                }
            }
        })
        ConvertTo-Json -InputObject $out -Compress -Depth 3`, [path]);
        const backups = parseJsonList(output)
            .map(b => ({ id: String(b.id || ''), gpoId: bareGuid(b.gpoId || ''), name: String(b.name || ''), domain: String(b.domain || ''), time: String(b.time || ''), comment: String(b.comment || '') }))
            .filter(b => BRACED_GUID_RE.test(b.id))
            .sort((a, b) => b.time.localeCompare(a.time));
        res.json({ path, backups: backups.slice(0, MAX_BACKUPS), truncated: backups.length > MAX_BACKUPS });
    } catch (e) {
        sendError(res, e);
    }
});

// POST /restore — restore a backup into its GPO; when that GPO no longer exists, import it into a new GPO of the
// backed-up name (new id, no links)
router.post('/restore', operator, async (req, res) => {
    const { backupId, path: rawPath, name } = req.body || {};
    if (!BRACED_GUID_RE.test(String(backupId || ''))) return res.status(400).json({ error: 'Invalid backup id' });
    const path = backupPath(rawPath);
    if (!path) return res.status(400).json({ error: 'path must be a local path (C:\\...) or a UNC share (\\\\server\\share\\...)' });
    try {
        const out = await onDc(`
        param($bid, $path)
${GPMC_CHECK}
        $info = Join-Path (Join-Path $path $bid) 'bkupInfo.xml'
${XML_TEXT}
        [xml]$x = Get-Content -LiteralPath $info -Raw
        $gid = & $text $x.BackupInst.GPOGuid
        $n = & $text $x.BackupInst.GPODisplayName
        $existing = $null
        try { $existing = Get-GPO -Guid $gid -Server localhost } catch { $existing = $null }
        if ($existing) {
            Restore-GPO -BackupId $bid -Path $path -Server localhost | Out-Null
            Write-Output "Restored"
        } else {
            Import-GPO -BackupId $bid -Path $path -TargetName $n -CreateIfNeeded -Server localhost | Out-Null
            Write-Output "Imported"
        }`, [String(backupId), path], 180000);
        const result = /Imported/.test(String(out || '')) ? 'Imported' : 'Restored';
        auditLog(user(req), 'GPO Manager', `${result} GPO '${auditName(name, backupId)}' from backup ${backupId} in ${path}`);
        res.json({ success: true, result });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
module.exports.TRUSTEE_RE = TRUSTEE_RE;
