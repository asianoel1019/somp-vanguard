const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { runPowerShell, getADCredentialHeader } = require('../lib/powershell');
const { auditLog } = require('../lib/logger');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AD_DC_HOST = process.env.AD_DC_HOST || process.env.ALLOWED_AD_DOMAIN || '';

router.use(requireAuth);
router.use(checkFeature('adControl'));

function getCredentials(req) {
    let username = process.env.AD_ADMIN_USER || req.user.username;
    const password = process.env.AD_ADMIN_PWD || req.user.password;
    let domain = req.user.domain;

    if (process.env.AD_ADMIN_USER && username.includes('\\')) {
        const parts = username.split('\\');
        domain = parts[0];
        username = parts[1];
    } else if (process.env.AD_ADMIN_USER && !username.includes('\\')) {
        domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
    }
    return { username, domain, password };
}

// GET /list
router.get('/list', async (req, res) => {
    try {
        const { username, domain, password } = getCredentials(req);
        const credHdr = getADCredentialHeader(username, domain, password);
        
        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $session = New-PSSession -ComputerName ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
    try {
        $result = Invoke-Command -Session $session -ScriptBlock {
            param($d)
            $ErrorActionPreference = "Continue"
        if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
        Import-Module GroupPolicy
        
        $gpos = $null
        try {
            $gpos = Get-GPO -All -Server localhost -ErrorAction Stop
        } catch {
            try {
                $gpos = Get-GPO -All -Domain $d -Server localhost -ErrorAction Stop
            } catch {
                try {
                    $gpos = Get-GPO -All -Domain $d -Server ${AD_DC_HOST} -ErrorAction Stop
                } catch {
                    try {
                        $gpos = Get-GPO -All -Server ${AD_DC_HOST} -ErrorAction Stop
                    } catch {
                        throw $_
                    }
                }
            }
        }

        if ($gpos) {
            $gpos | Select-Object DisplayName, Id, GpoStatus, CreationTime, ModificationTime | ConvertTo-Json -Compress
        } else {
            if ($Error.Count -gt 0) { throw $Error[0] }
            Write-Output "[]"
        }
    } -ArgumentList "${domain}"
        Write-Output $result
    } finally {
        Remove-PSSession -Session $session
    }
} catch {
    throw $_
}
`;

        console.log(`[GPO List] Invoking PowerShell script with user: ${username}, domain: ${domain}`);
        const output = await runPowerShell(script);
        console.log(`[GPO List] PowerShell stdout: "${output}"`);
        const rawJson = output.trim();
        let gpos = [];
        if (rawJson && rawJson !== '[]') {
            try {
                gpos = JSON.parse(rawJson);
                if (!Array.isArray(gpos)) gpos = [gpos];
                console.log(`[GPO List] Parsed ${gpos.length} GPOs successfully.`);
            } catch (jsonErr) {
                console.error(`[GPO List] Failed to parse JSON: "${rawJson}". Error: ${jsonErr.message}`);
            }
        } else {
            console.log('[GPO List] Received empty list or no output.');
        }
        res.json({ gpos });
    } catch (e) {
        console.error('[GPO List] Error running PowerShell script:', e);
        res.status(500).json({ error: e.stderr || e.message || String(e) });
    }
});

// GET /registry-list
router.get('/registry-list', async (req, res) => {
    const { guid } = req.query;
    if (!guid) return res.status(400).json({ error: 'Missing guid parameter' });

    try {
        const { username, domain, password } = getCredentials(req);
        const credHdr = getADCredentialHeader(username, domain, password);

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $session = New-PSSession -ComputerName ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
    try {
        $result = Invoke-Command -Session $session -ScriptBlock {
        param($gId)
        $ErrorActionPreference = "Stop"
        if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
        Import-Module GroupPolicy

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
            
            $key = $node.Key.InnerText
            $valueName = ""
            if ($node.ValueName) {
                $valueName = $node.ValueName.InnerText
            }
            $type = ""
            if ($node.ValueType) {
                $type = $node.ValueType.InnerText
            }
            $val = ""
            if ($node.Value) {
                $val = $node.Value.InnerText
            }
            
            $settings += [PSCustomObject]@{
                hive = $hive
                key = $key
                valueName = $valueName
                type = $type
                value = $val
            }
        }
        
        $jsonSettings = "[]"
        if ($settings.Count -gt 0) {
            $jsonSettings = $settings | ConvertTo-Json -Compress
        }
        
        return "$jsonSettings|||$($xml.OuterXml)"
    } -ArgumentList "${guid}"
        Write-Output $result
    } finally {
        Remove-PSSession -Session $session
    }
} catch {
    throw $_
}
`;

        const output = await runPowerShell(script);
        const parts = output.trim().split('|||');
        const rawJson = parts[0] ? parts[0].trim() : '[]';
        const rawXml = parts[1] ? parts[1].trim() : '';

        if (rawXml) {
            try {
                const debugPath = path.join(os.tmpdir(), 'gpo_report_debug.xml');
                fs.writeFileSync(debugPath, rawXml);
                console.log(`[GPO Reg List] Wrote raw XML report to ${debugPath} (Length: ${rawXml.length})`);
            } catch (fsErr) {
                console.error('[GPO Reg List] Failed to write debug XML file:', fsErr);
            }
        }

        let settings = [];
        if (rawJson && rawJson !== '[]') {
            try {
                settings = JSON.parse(rawJson);
                if (!Array.isArray(settings)) settings = [settings];
            } catch (jsonErr) {
                console.error(`[GPO Reg List] Failed to parse JSON: "${rawJson}". Error: ${jsonErr.message}`);
            }
        }
        res.json({ settings });
    } catch (e) {
        console.error('[GPO Reg List] Error:', e);
        res.status(500).json({ error: e.stderr || e.message || String(e) });
    }
});

router.post('/status', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, status, name } = req.body;
    if (!guid || !status) return res.status(400).json({ error: 'Missing guid or status' });

    try {
        const { username, domain, password } = getCredentials(req);
        const credHdr = getADCredentialHeader(username, domain, password);

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $session = New-PSSession -ComputerName ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
    try {
        Invoke-Command -Session $session -ScriptBlock {
            param($gId, $s)
            $ErrorActionPreference = "Stop"
            if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
            Import-Module GroupPolicy
            Set-GPO -Guid $gId -Status $s
        } -ArgumentList "${guid}", "${status}"
    } finally {
        Remove-PSSession -Session $session
    }
} catch {
    throw $_
}
`;

        await runPowerShell(script);
        auditLog(req.user.username, 'GPO Manager', `Changed GPO '${name || guid}' status to ${status}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.stderr || e.message });
    }
});

router.post('/backup', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, name, nasPath } = req.body;
    
    try {
        const { username, domain, password } = getCredentials(req);
        const credHdr = getADCredentialHeader(username, domain, password);

        // Determine backup path. If nasPath is provided, use it.
        // Otherwise, use a default path on the DC.
        const targetPath = nasPath || "C:\\GPO_Backups";

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $session = New-PSSession -ComputerName ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
    
    try {
        $backupResult = Invoke-Command -Session $session -ScriptBlock {
            param($gId, $path)
            $ErrorActionPreference = "Stop"
            if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
            Import-Module GroupPolicy
            if (!(Test-Path $path)) {
                New-Item -ItemType Directory -Force -Path $path | Out-Null
            }
            if ($gId -eq "ALL") {
                Backup-GPO -All -Path $path
            } else {
                Backup-GPO -Guid $gId -Path $path
            }
            return "Backup saved to $path"
        } -ArgumentList "${guid || 'ALL'}", "${targetPath}"
        
        Write-Output $backupResult
    } finally {
        Remove-PSSession -Session $session
    }
} catch {
    throw $_
}
`;

        const result = await runPowerShell(script);
        auditLog(req.user.username, 'GPO Manager', `Backed up GPO '${name || 'ALL'}' to ${targetPath}`);
        res.json({ success: true, message: result.trim() });
    } catch (e) {
        res.status(500).json({ error: e.stderr || e.message });
    }
});

// POST /security
// Very basic implementation: modify Registry values (Administrative Templates) inside a GPO
// Real Security Settings (GptTmpl.inf) require advanced logic which we'll expand later.
router.post('/security', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { guid, name, key, valueName, type, value, action } = req.body;
    if (!guid || !key || !action) return res.status(400).json({ error: 'Missing required parameters' });

    const safeKeyPattern = /Software\\(Policies|Microsoft\\Windows\\CurrentVersion\\Policies)\\/i;
    const unsafeKeyPattern = /\\(Run|RunOnce|RunServices|RunServicesOnce|RunEx)\b/i;
    
    if (!safeKeyPattern.test(key) || unsafeKeyPattern.test(key)) {
        return res.status(403).json({ error: 'Registry key path is not permitted for modification.' });
    }

    try {
        const { username, domain, password } = getCredentials(req);
        const credHdr = getADCredentialHeader(username, domain, password);

        // action can be Set or Remove
        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $session = New-PSSession -ComputerName ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
    try {
        Invoke-Command -Session $session -ScriptBlock {
            param($gId, $act, $k, $vName, $t, $v)
            $ErrorActionPreference = "Stop"
            if (!(Get-Module -ListAvailable -Name GroupPolicy)) { throw "RSAT_GPMC_MISSING" }
            Import-Module GroupPolicy
            if ($act -eq "Set") {
                Set-GPRegistryValue -Guid $gId -Key $k -ValueName $vName -Type $t -Value $v
            } else {
                Remove-GPRegistryValue -Guid $gId -Key $k -ValueName $vName
            }
        } -ArgumentList "${guid}", "${action}", "${key}", "${valueName || ''}", "${type || 'String'}", "${value || ''}"
    } finally {
        Remove-PSSession -Session $session
    }
} catch {
    throw $_
}
`;

        await runPowerShell(script);
        auditLog(req.user.username, 'GPO Manager', `Edited Security/Registry Policy '${key}' for GPO '${name || guid}'`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.stderr || e.message });
    }
});

module.exports = router;
