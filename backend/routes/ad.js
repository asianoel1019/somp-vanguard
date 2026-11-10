const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { runAsService, psLit, adErrorMessage, serviceAccount } = require('../lib/adService');
const { isSam, parseList, groupNames, rdnValue } = require('../lib/adModel');
const { guardScript, guardRefusal } = require('../lib/adGuard');

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

// Limits on what one request may pull out of the directory
const MAX_SEARCH_RESULTS = 200;
const MAX_OU_USERS = 2000;

function sendAdError(res, e) {
    res.status(e && e.status ? e.status : 500).json({ error: adErrorMessage(e) });
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

// POST /users — accounts of one configured OU (at most MAX_OU_USERS; truncated says when there are more)
router.post('/users', async (req, res) => {
    const { category, bu } = req.body;
    if (!category || !bu) return res.status(400).json({ error: 'Missing parameters' });

    const targetOU = getTargetOU(category, bu);
    if (!targetOU) return res.status(400).json({ error: 'Invalid Category or BU' });

    try {
        const output = await runAsService(`
$users = Get-ADUser -Filter * -SearchBase ${psLit(targetOU)} -ResultSetSize ${MAX_OU_USERS + 1} -Properties Enabled, LockedOut, Description, adminCount -Credential $global:AD_CRED @dcArgs
if ($users) {
    @($users) | Select-Object Name, SamAccountName, Enabled, LockedOut, Description, @{ n = 'Protected'; e = { $_.adminCount -eq 1 } } | ConvertTo-Json
} else {
    Write-Output "[]"
}
`);
        const users = parseList(output);
        res.json({ users: users.slice(0, MAX_OU_USERS), truncated: users.length > MAX_OU_USERS, limit: MAX_OU_USERS });
    } catch (e) {
        sendAdError(res, e);
    }
});

/** 16 characters from a set without look-alikes, at least one of each class, chosen with a CSPRNG */
function generatePassword(length = 16) {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%^*-_=+?'];
    const all = sets.join('');
    const chars = sets.map(s => s[crypto.randomInt(s.length)]);
    while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// POST /action
router.post('/action', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { category, bu, sam, action } = req.body;
    if (!sam || !action) return res.status(400).json({ error: 'Missing parameters' });
    if (!isSam(sam)) return res.status(400).json({ error: 'Invalid account name' });
    if (action === 'grant' && (!category || !bu)) return res.status(400).json({ error: 'Missing Category or BU parameters for Grant action' });

    try {
        const id = psLit(sam);
        let actionScript = '';
        let actionDesc = '';
        let generatedPassword = null;

        if (action === 'enable') {
            actionScript = `Enable-ADAccount -Identity $target -Credential $global:AD_CRED @dcArgs`;
            actionDesc = `Enabled AD Account: ${sam}`;
        } else if (action === 'disable') {
            actionScript = `Disable-ADAccount -Identity $target -Credential $global:AD_CRED @dcArgs`;
            actionDesc = `Disabled AD Account: ${sam}`;
        } else if (action === 'unlock') {
            actionScript = `Unlock-ADAccount -Identity $target -Credential $global:AD_CRED @dcArgs`;
            actionDesc = `Unlocked AD Account: ${sam}`;
        } else if (action === 'reset_password') {
            generatedPassword = generatePassword();
            // the new password also travels as a literal; it is random and only made of the characters above
            actionScript = `
$newPass = ConvertTo-SecureString ${psLit(generatedPassword)} -AsPlainText -Force
Set-ADAccountPassword -Identity $target -NewPassword $newPass -Reset -Credential $global:AD_CRED @dcArgs
Set-ADUser -Identity $target -PasswordNeverExpires $false -Credential $global:AD_CRED @dcArgs
Set-ADUser -Identity $target -ChangePasswordAtLogon $true -Credential $global:AD_CRED @dcArgs
`;
            actionDesc = `Reset Password for AD Account: ${sam}`;
        } else if (action === 'grant') {
            const grantCompanies = getGrantCompanies();
            const targetOU = getTargetOU(category, bu);
            if (!targetOU) return res.status(400).json({ error: 'Invalid Category or BU for Grant action' });
            if (!grantCompanies.includes(category)) {
                return res.status(400).json({ error: `Grant Permission is not available for ${category}` });
            }
            actionScript = `
$buName = ${psLit(bu)}.Replace("'", "''")
$targetGroup = Get-ADGroup -Filter "Name -like '*$buName*'" -SearchBase ${psLit(targetOU)} -Credential $global:AD_CRED @dcArgs | Select-Object -First 1
if ($targetGroup) {
    Add-ADGroupMember -Identity $targetGroup -Members $target -Credential $global:AD_CRED @dcArgs
} else {
    throw "Target group not found in OU"
}`;
            actionDesc = `Granted Permission for AD Account: ${sam}`;
        } else {
            return res.status(400).json({ error: 'Unknown action' });
        }

        // the account is re-read and checked (protected accounts, managed OUs) right before the change
        await runAsService(`${guardScript()}\n$target = Get-ManagedUser ${id}\n${actionScript}`);

        // who did it is the signed-in user; the service account only carries it out
        auditLog(req.user.username, 'AD User Control', `${actionDesc} (via service account ${serviceAccount().username})`);
        const responseData = { success: true };
        if (generatedPassword) {
            responseData.password = generatedPassword;
            res.set('Cache-Control', 'no-store');
        }
        res.json(responseData);
    } catch (e) {
        const refused = guardRefusal(e && (e.stderr || e.message));
        if (refused) return res.status(refused.status).json({ error: refused.error });
        sendAdError(res, e);
    }
});

// POST /search — at least 2 characters, wildcards added by the server, at most MAX_SEARCH_RESULTS results
router.post('/search', async (req, res) => {
    const { type, q } = req.body;
    if (!type || !q) return res.status(400).json({ error: 'Missing parameters' });
    const term = String(q).trim();
    if (term.length < 2 || term.length > 64 || /[\x00-\x1f*]/.test(term)) {
        return res.status(400).json({ error: 'Search text must be 2-64 characters, without * or control characters' });
    }
    if (!['User', 'Group', 'Computer'].includes(type)) return res.status(400).json({ error: 'Invalid search type' });

    const searchBase = process.env.AD_OU_SEARCH || '';
    const searchBaseArg = searchBase ? `-SearchBase ${psLit(searchBase)}` : '';
    const size = `-ResultSetSize ${MAX_SEARCH_RESULTS + 1}`;
    // the term is a literal; inside the AD filter its quotes are doubled
    const termSetup = `$term = ${psLit(term)}.Replace("'", "''")`;

    let psScript = '';
    if (type === 'User') {
        psScript = `
${termSetup}
$users = Get-ADUser -Filter "Name -like '*$term*' -or SamAccountName -like '*$term*'" ${searchBaseArg} ${size} -Properties Enabled, LockedOut, Description, adminCount -Credential $global:AD_CRED @dcArgs
if ($users) {
    @($users) | Select-Object Name, SamAccountName, Enabled, LockedOut, Description, @{ n = 'Protected'; e = { $_.adminCount -eq 1 } } | ConvertTo-Json
} else {
    Write-Output "[]"
}
`;
    } else if (type === 'Group') {
        psScript = `
${termSetup}
$groups = Get-ADGroup -Filter "Name -like '*$term*' -or SamAccountName -like '*$term*'" ${searchBaseArg} ${size} -Properties Description -Credential $global:AD_CRED @dcArgs
if ($groups) {
    $res = @()
    foreach ($g in @($groups)) {
        try {
            $members = Get-ADGroupMember -Identity $g.DistinguishedName -Credential $global:AD_CRED @dcArgs -ErrorAction Stop | Select-Object -ExpandProperty Name
            $res += [PSCustomObject]@{ Name = $g.Name; SamAccountName = $g.SamAccountName; DistinguishedName = $g.DistinguishedName; Members = @($members) }
        } catch {
            $res += [PSCustomObject]@{ Name = $g.Name; SamAccountName = $g.SamAccountName; DistinguishedName = $g.DistinguishedName; Members = @("Error loading members") }
        }
    }
    $res | ConvertTo-Json -Depth 10
} else {
    Write-Output "[]"
}
`;
    } else {
        psScript = `
${termSetup}
$computers = Get-ADComputer -Filter "Name -like '*$term*'" ${searchBaseArg} ${size} -Properties Enabled, OperatingSystem, LastLogonDate, Description -Credential $global:AD_CRED @dcArgs
if ($computers) {
    $res = @()
    foreach ($c in @($computers)) {
        $dn = $c.DistinguishedName
        $res += [PSCustomObject]@{ Name = $c.Name; SamAccountName = $c.SamAccountName; DistinguishedName = $dn; OU = ($dn -replace '^CN=[^,]+,', '')
            Enabled = [bool]$c.Enabled; OperatingSystem = [string]$c.OperatingSystem; Description = [string]$c.Description
            LastLogonDate = $(if ($c.LastLogonDate) { $c.LastLogonDate.ToUniversalTime().ToString('o') } else { '' }) }
    }
    $res | ConvertTo-Json -Depth 10
} else {
    Write-Output "[]"
}
`;
    }

    try {
        const results = parseList(await runAsService(psScript));
        res.json({ results: results.slice(0, MAX_SEARCH_RESULTS), truncated: results.length > MAX_SEARCH_RESULTS, limit: MAX_SEARCH_RESULTS });
    } catch (e) {
        sendAdError(res, e);
    }
});

// GET /user/:sam
router.get('/user/:sam', async (req, res) => {
    const { sam } = req.params;
    if (!sam) return res.status(400).json({ error: 'Missing SAM account name' });
    if (!isSam(sam)) return res.status(400).json({ error: 'Invalid account name' });

    const props = 'Description,EmailAddress,Title,Department,Company,Manager,MemberOf,PrimaryGroup,Enabled,LockedOut,PasswordLastSet,LastLogonDate,AccountExpirationDate,BadLogonCount,Created,Modified,pwdLastSet';
    try {
        const output = await runAsService(`
$user = Get-ADUser -Identity ${psLit(sam)} -Properties ${props} -Credential $global:AD_CRED @dcArgs
if ($user) {
    [PSCustomObject]@{
        Name = $user.Name
        SamAccountName = $user.SamAccountName
        UserPrincipalName = $user.UserPrincipalName
        Description = $user.Description
        EmailAddress = $user.EmailAddress
        Title = $user.Title
        Department = $user.Department
        Company = $user.Company
        ManagerDn = [string]$user.Manager
        PrimaryGroupDn = [string]$user.PrimaryGroup
        Enabled = $user.Enabled
        LockedOut = $user.LockedOut
        PasswordLastSet = $user.PasswordLastSet
        LastLogonDate = $user.LastLogonDate
        AccountExpirationDate = $user.AccountExpirationDate
        BadLogonCount = $user.BadLogonCount
        Created = $user.Created
        Modified = $user.Modified
        MemberOfDns = @($user.MemberOf | ForEach-Object { [string]$_ })
    } | ConvertTo-Json -Depth 10
} else {
    Write-Output "{}"
}
`);
        const raw = String(output || '').trim();
        const userInfo = raw && raw !== '{}' && raw !== 'null' ? JSON.parse(raw) : {};
        if (userInfo.Name) {
            // names come from the DNs here, so escaped commas ("CN=Sales\, East,...") stay inside the name
            userInfo.MemberOf = groupNames(userInfo.MemberOfDns);
            userInfo.PrimaryGroup = rdnValue(userInfo.PrimaryGroupDn);
            userInfo.Manager = rdnValue(userInfo.ManagerDn);
            delete userInfo.MemberOfDns; delete userInfo.PrimaryGroupDn; delete userInfo.ManagerDn;
        }
        res.json({ userInfo });
    } catch (e) {
        sendAdError(res, e);
    }
});

// OU tree mode, reports, batch actions and the exact last logon
router.use(require('./adDirectory'));

// Test hooks
router._test = { generatePassword, isSam };

module.exports = router;
