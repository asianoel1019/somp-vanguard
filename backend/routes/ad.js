const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { runPowerShell, getADCredentialHeader, sanitizePsString } = require('../lib/powershell');
const { auditLog } = require('../lib/logger');
const http = require('http');

const AD_DC_HOST = process.env.AD_DC_HOST || process.env.ALLOWED_AD_DOMAIN || '';

router.use(requireAuth);
router.use(checkFeature('adControl'));

// ---- Dynamic AD OU Configuration Engine ----
// Reads company list, BU lists, and OU paths entirely from .env
// To add a new company/BU, just edit .env — zero code changes needed.
//
// .env format:
//   AD_COMPANIES=Xuenn,YT
//   AD_BUS_Xuenn=188,APP,B2B,...
//   AD_BUS_YT=YT-CEM,QA,...
//   AD_OU_Xuenn_188=OU=188,...
//   AD_OU_YT_YT_CEM=OU=CEM,...
//   (BU name: replace "-" with "_" in the env key)

function getCompanies() {
    return (process.env.AD_COMPANIES || '').split(',').map(c => c.trim()).filter(Boolean);
}

function getBUsForCompany(company) {
    const raw = process.env[`AD_BUS_${company}`];
    if (!raw) return [];
    return raw.split(',').map(b => b.trim()).filter(Boolean);
}

function buToEnvKey(company, bu) {
    // BU "TRS-TW" → env key "AD_OU_Xuenn_TRS_TW"
    return `AD_OU_${company}_${bu.replace(/-/g, '_')}`;
}

function getTargetOU(company, bu) {
    return process.env[buToEnvKey(company, bu)] || null;
}

function getGrantCompanies() {
    return (process.env.AD_GRANT_COMPANIES || '').split(',').map(c => c.trim()).filter(Boolean);
}

// GET /mappings — returns { companies: [...], companyName: [bu1, bu2, ...], ... }
router.get('/mappings', (req, res) => {
    const companies = getCompanies();
    const grantCompanies = getGrantCompanies();
    const result = { companies, grantCompanies };
    for (const c of companies) {
        const bus = getBUsForCompany(c).filter(bu => process.env[buToEnvKey(c, bu)]);
        result[c] = bus;
    }
    res.json(result);
});

// POST /users
router.post('/users', async (req, res) => {
    const { category, bu } = req.body;
    if (!category || !bu) return res.status(400).json({ error: 'Missing parameters' });

    const targetOU = getTargetOU(category, bu);
    if (!targetOU) return res.status(400).json({ error: 'Invalid Category or BU' });

    try {
        // Use global AD_ADMIN if configured, else fallback to logged-in user session
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
        const credHdr = getADCredentialHeader(username, domain, password);

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
$dcTarget = "${AD_DC_HOST}"
try {
    if ($dcTarget) {
        $users = Get-ADUser -Filter * -SearchBase "${targetOU}" -Properties Enabled, LockedOut, Description -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop
    } else {
        $users = Get-ADUser -Filter * -SearchBase "${targetOU}" -Properties Enabled, LockedOut, Description -Credential $global:AD_CRED -ErrorAction Stop
    }
} catch {
    $users = Get-ADUser -Filter * -SearchBase "${targetOU}" -Properties Enabled, LockedOut, Description -Credential $global:AD_CRED -ErrorAction Stop
}
if ($users) {
    $users | Select-Object Name, SamAccountName, Enabled, LockedOut, Description | ConvertTo-Json
} else {
    Write-Output "[]"
}
        `;

        const output = await runPowerShell(script);
        const rawJson = output.trim();
        let users = [];
        if (rawJson && rawJson !== '[]') {
            users = JSON.parse(rawJson);
            if (!Array.isArray(users)) users = [users];
        }
        res.json({ users });
    } catch (e) {
        const errMsg = e.stderr || (e.error && e.error.message) || String(e);
        res.status(500).json({ error: errMsg });
    }
});

// POST /action
router.post('/action', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { category, bu, sam, action } = req.body;
    if (!sam || !action) return res.status(400).json({ error: 'Missing parameters' });
    if (action === 'grant' && (!category || !bu)) return res.status(400).json({ error: 'Missing Category or BU parameters for Grant action' });

    try {
        // Use global AD_ADMIN if configured, else fallback to logged-in user session
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
        const credHdr = getADCredentialHeader(username, domain, password);

        const safeSam = sanitizePsString(sam);
        let actionScript = '';
        let actionDesc = '';

        if (action === 'enable') {
            actionScript = `Enable-ADAccount -Identity '${safeSam}' -Server ${AD_DC_HOST} -Credential $global:AD_CRED`;
            actionDesc = `Enabled AD Account: ${sam}`;
        } else if (action === 'disable') {
            actionScript = `Disable-ADAccount -Identity '${safeSam}' -Server ${AD_DC_HOST} -Credential $global:AD_CRED`;
            actionDesc = `Disabled AD Account: ${sam}`;
        } else if (action === 'unlock') {
            actionScript = `Unlock-ADAccount -Identity '${safeSam}' -Server ${AD_DC_HOST} -Credential $global:AD_CRED`;
            actionDesc = `Unlocked AD Account: ${sam}`;
        } else if (action === 'reset_password') {
            const crypto = require('crypto');
            const randomPass = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'A1!';
            const safeRandomPass = sanitizePsString(randomPass);
            actionScript = `
$secPass = ConvertTo-SecureString '${safeRandomPass}' -AsPlainText -Force
Set-ADAccountPassword -Identity '${safeSam}' -NewPassword $secPass -Reset -Server ${AD_DC_HOST} -Credential $global:AD_CRED
Set-ADUser -Identity '${safeSam}' -PasswordNeverExpires $false -Server ${AD_DC_HOST} -Credential $global:AD_CRED
Set-ADUser -Identity '${safeSam}' -ChangePasswordAtLogon $true -Server ${AD_DC_HOST} -Credential $global:AD_CRED
            `;
            actionDesc = `Reset Password for AD Account: ${sam}`;
            res.locals.generatedPassword = randomPass;
        } else if (action === 'grant') {
            const grantCompanies = getGrantCompanies();
            const targetOU = getTargetOU(category, bu);
            if (!targetOU) return res.status(400).json({ error: 'Invalid Category or BU for Grant action' });
            if (!grantCompanies.includes(category)) {
                return res.status(400).json({ error: `Grant Permission is not available for ${category}` });
            }
            actionScript = `
$targetGroup = Get-ADGroup -Filter "Name -like '*${sanitizePsString(bu)}*'" -SearchBase "${targetOU}" -Server ${AD_DC_HOST} -Credential $global:AD_CRED | Select-Object -First 1
if ($targetGroup) {
    Add-ADGroupMember -Identity $targetGroup -Members '${safeSam}' -Server ${AD_DC_HOST} -Credential $global:AD_CRED
} else {
    throw "Target group not found in OU"
}`;
            actionDesc = `Granted Permission for AD Account: ${sam}`;
        } else {
            return res.status(400).json({ error: 'Unknown action' });
        }

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    ${actionScript}
} catch {
    throw $_
}
        `;

        await runPowerShell(script);
        
        auditLog(username, 'AD User Control', actionDesc);
        const responseData = { success: true };
        if (res.locals.generatedPassword) responseData.password = res.locals.generatedPassword;
        res.json(responseData);

    } catch (e) {
        const errMsg = e.stderr || (e.error && e.error.message) || String(e);
        res.status(500).json({ error: errMsg });
    }
});

// POST /search
router.post('/search', async (req, res) => {
    const { type, q } = req.body;
    if (!type || !q) return res.status(400).json({ error: 'Missing parameters' });

    const searchBase = process.env.AD_OU_SEARCH || '';
    const searchBaseArg = searchBase ? `-SearchBase "${searchBase}"` : '';

    try {
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
        const credHdr = getADCredentialHeader(username, domain, password);

        const safeQ = sanitizePsString(q);
        let psScript = '';

        if (type === 'User') {
            psScript = `
                $dcTarget = "${AD_DC_HOST}"
                try {
                    if ($dcTarget) {
                        $users = Get-ADUser -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Enabled, LockedOut, Description -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop
                    } else {
                        $users = Get-ADUser -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Enabled, LockedOut, Description -Credential $global:AD_CRED -ErrorAction Stop
                    }
                } catch {
                    $users = Get-ADUser -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Enabled, LockedOut, Description -Credential $global:AD_CRED -ErrorAction Stop
                }
                if ($users) {
                    $users | Select-Object Name, SamAccountName, Enabled, LockedOut, Description | ConvertTo-Json
                } else {
                    Write-Output "[]"
                }
            `;
        } else if (type === 'Group') {
            psScript = `
                $dcTarget = "${AD_DC_HOST}"
                try {
                    if ($dcTarget) {
                        $groups = Get-ADGroup -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Description -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop
                    } else {
                        $groups = Get-ADGroup -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Description -Credential $global:AD_CRED -ErrorAction Stop
                    }
                } catch {
                    $groups = Get-ADGroup -Filter "Name -like '*${safeQ}*' -or SamAccountName -like '*${safeQ}*'" ${searchBaseArg} -Properties Description -Credential $global:AD_CRED -ErrorAction Stop
                }
                if ($groups) {
                    $res = @()
                    foreach ($g in $groups) {
                        try {
                            $members = Get-ADGroupMember -Identity $g.DistinguishedName -Credential $global:AD_CRED -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
                            $memberList = @()
                            if ($members) {
                                if ($members -is [array]) { $memberList = $members } else { $memberList = @($members) }
                            }
                            $res += [PSCustomObject]@{
                                Name = $g.Name
                                SamAccountName = $g.SamAccountName
                                DistinguishedName = $g.DistinguishedName
                                Members = $memberList
                            }
                        } catch {
                            $res += [PSCustomObject]@{
                                Name = $g.Name
                                SamAccountName = $g.SamAccountName
                                DistinguishedName = $g.DistinguishedName
                                Members = @("Error loading members")
                            }
                        }
                    }
                    $res | ConvertTo-Json -Depth 10
                } else {
                    Write-Output "[]"
                }
            `;
        } else if (type === 'Computer') {
            psScript = `
                $computers = Get-ADComputer -Filter "Name -like '*${safeQ}*'" ${searchBaseArg} -Server ${AD_DC_HOST} -Credential $global:AD_CRED -ErrorAction Stop
                if ($computers) {
                    $res = @()
                    foreach ($c in $computers) {
                        $dn = $c.DistinguishedName
                        $ou = $dn -replace '^CN=[^,]+,', ''
                        $res += [PSCustomObject]@{
                            Name = $c.Name
                            SamAccountName = $c.SamAccountName
                            DistinguishedName = $dn
                            OU = $ou
                        }
                    }
                    $res | ConvertTo-Json -Depth 10
                } else {
                    Write-Output "[]"
                }
            `;
        } else {
            return res.status(400).json({ error: 'Invalid search type' });
        }

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    ${psScript}
} catch {
    throw $_
}
        `;

        const output = await runPowerShell(script);
        const rawJson = output.trim();
        let results = [];
        if (rawJson && rawJson !== '[]') {
            results = JSON.parse(rawJson);
            if (!Array.isArray(results)) results = [results];
        }
        res.json({ results });
    } catch (e) {
        const errMsg = e.stderr || (e.error && e.error.message) || String(e);
        res.status(500).json({ error: errMsg });
    }
});

// GET /user/:sam
router.get('/user/:sam', async (req, res) => {
    const { sam } = req.params;
    if (!sam) return res.status(400).json({ error: 'Missing SAM account name' });

    try {
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
        const credHdr = getADCredentialHeader(username, domain, password);

        const props = 'Description,EmailAddress,Title,Department,Company,Manager,MemberOf,Enabled,LockedOut,PasswordLastSet,LastLogonDate,AccountExpirationDate,BadLogonCount,Created,Modified,pwdLastSet';
        
        const psScript = `
            $dcTarget = "${AD_DC_HOST}"
            try {
                if ($dcTarget) {
                    $user = Get-ADUser -Identity "${sanitizePsString(sam)}" -Properties ${props} -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop
                } else {
                    $user = Get-ADUser -Identity "${sanitizePsString(sam)}" -Properties ${props} -Credential $global:AD_CRED -ErrorAction Stop
                }
            } catch {
                $user = Get-ADUser -Identity "${sanitizePsString(sam)}" -Properties ${props} -Credential $global:AD_CRED -ErrorAction Stop
            }
            if ($user) {
                # Clean up MemberOf to just group names
                $groups = @()
                if ($user.MemberOf) {
                    foreach ($group in $user.MemberOf) {
                        $groups += ($group -replace '^CN=([^,]+),.*', '$1')
                    }
                }
                
                # Format Manager
                $managerName = ""
                if ($user.Manager) {
                    $managerName = ($user.Manager -replace '^CN=([^,]+),.*', '$1')
                }

                $res = [PSCustomObject]@{
                    Name = $user.Name
                    SamAccountName = $user.SamAccountName
                    UserPrincipalName = $user.UserPrincipalName
                    Description = $user.Description
                    EmailAddress = $user.EmailAddress
                    Title = $user.Title
                    Department = $user.Department
                    Company = $user.Company
                    Manager = $managerName
                    Enabled = $user.Enabled
                    LockedOut = $user.LockedOut
                    PasswordLastSet = $user.PasswordLastSet
                    LastLogonDate = $user.LastLogonDate
                    AccountExpirationDate = $user.AccountExpirationDate
                    BadLogonCount = $user.BadLogonCount
                    Created = $user.Created
                    Modified = $user.Modified
                    MemberOf = $groups
                }
                $res | ConvertTo-Json -Depth 10
            } else {
                Write-Output "{}"
            }
        `;

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    ${psScript}
} catch {
    throw $_
}
        `;

        const output = await runPowerShell(script);
        const rawJson = output.trim();
        let userInfo = {};
        if (rawJson && rawJson !== '{}' && rawJson !== 'null') {
            userInfo = JSON.parse(rawJson);
        }
        res.json({ userInfo });
    } catch (e) {
        const errMsg = e.stderr || (e.error && e.error.message) || String(e);
        res.status(500).json({ error: errMsg });
    }
});

module.exports = router;
