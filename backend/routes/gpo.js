const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { runAsService, psLit, adErrorMessage, dcHost, serviceAccount } = require('../lib/adService');

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
function onDc(block, args = []) {
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
`);
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
