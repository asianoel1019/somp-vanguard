const express = require('express');
const router = express.Router();
const { authMiddleware, checkRole } = require('../middleware/auth');
const { readRbacConfig, updateUserRole, removeUserRole, writeRbacConfig, isReservedMappingName, normalizeMappingName, getAllowedAdDomain } = require('../lib/rbac');
const { runPowerShell, getADCredentialHeader } = require('../lib/powershell');
const { auditLog } = require('../lib/logger');
const { BUILTIN_SUPERADMIN_MAPPING, FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES } = require('../lib/featureCatalog');

const RESERVED_NAME_ERROR = `"${BUILTIN_SUPERADMIN_MAPPING}" is a reserved built-in mapping name`;
// Exactly the keys the built-in editor shows (frontend rbacBuiltinUtils getEditorCategories(true))
const BUILTIN_EDITABLE_KEYS = new Set([...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]);

/** Keeps only boolean switches for keys the built-in editor shows. */
function sanitizeBuiltinFeatures(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    for (const [k, v] of Object.entries(input)) {
        if (BUILTIN_EDITABLE_KEYS.has(k) && typeof v === 'boolean') out[k] = v;
    }
    return out;
}

/** Edit of the built-in SuperAdmin mapping: only its feature switches (and description) may change. */
function updateBuiltinMapping(req, res) {
    const body = req.body || {};
    if (body.type !== undefined && body.type !== 'role') {
        return res.status(400).json({ error: 'The built-in SuperAdmin mapping type cannot be changed' });
    }
    if ((body.target !== undefined && String(body.target).trim() !== '') || (body.adOu !== undefined && String(body.adOu).trim() !== '')) {
        return res.status(400).json({ error: 'The built-in SuperAdmin mapping is not bound to an AD OU / group' });
    }
    if (body.enabled !== undefined && body.enabled !== true) {
        return res.status(400).json({ error: 'The built-in SuperAdmin mapping is always enabled' });
    }
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 500)) {
        return res.status(400).json({ error: 'description must be a string of at most 500 characters' });
    }

    const config = readRbacConfig(); // guarantees the built-in exists
    const builtin = config.groups[BUILTIN_SUPERADMIN_MAPPING];
    const before = { ...(builtin.features || {}) };
    const next = { ...before, ...sanitizeBuiltinFeatures(body.features) };
    SUPERADMIN_LOCKED_FEATURES.forEach(k => { next[k] = true; }); // lock-out guard

    const turnedOn = Object.keys(next).filter(k => next[k] === true && before[k] !== true);
    const turnedOff = Object.keys(next).filter(k => next[k] !== true && before[k] === true);
    builtin.features = next;
    let descriptionChanged = false;
    if (typeof body.description === 'string') {
        const desc = body.description.trim();
        descriptionChanged = desc !== builtin.description;
        builtin.description = desc;
    }
    if (!writeRbacConfig(config)) {
        return res.status(500).json({ error: 'Failed to save RBAC configuration' });
    }
    auditLog(req.user.username, 'RBAC',
        `Updated built-in SuperAdmin mapping feature switches (on: ${turnedOn.join(', ') || 'none'}; off: ${turnedOff.join(', ') || 'none'})`
        + (descriptionChanged ? `; description changed to "${builtin.description.slice(0, 200)}"` : ''));
    return res.json({ success: true, groups: config.groups });
}

// All RBAC routes require SuperAdmin
router.use(authMiddleware);
router.use(checkRole(['SuperAdmin']));

// Get all roles and users
router.get('/', (req, res) => {
    try {
        const config = readRbacConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get AD users from specific OU or AD Group
router.get('/ad-users', async (req, res) => {
    try {
        const type = req.query.type || (req.query.group ? 'group' : 'ou');
        const target = req.query.target || req.query.group || req.query.ou || '';
        if (!target) {
            return res.json([]);
        }

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

        const dcHost = process.env.AD_DC_HOST || process.env.ALLOWED_AD_DOMAIN || domain || '';
        const credHdr = getADCredentialHeader(username, domain, password);

        const isGroupQuery = type === 'group' || (!target.toLowerCase().startsWith('ou=') && !target.toLowerCase().startsWith('cn='));

        let queryScript = '';
        if (isGroupQuery) {
            queryScript = `
$target = "${target}"
try {
    if ($dcTarget) {
        $members = Get-ADGroupMember -Identity $target -Recursive -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop | Where-Object { $_.objectClass -eq 'user' }
    } else {
        $members = Get-ADGroupMember -Identity $target -Recursive -Credential $global:AD_CRED -ErrorAction Stop | Where-Object { $_.objectClass -eq 'user' }
    }
} catch {
    $members = Get-ADGroupMember -Identity $target -Recursive -Credential $global:AD_CRED -ErrorAction Stop | Where-Object { $_.objectClass -eq 'user' }
}
if ($members) {
    $members | Select-Object -ExpandProperty SamAccountName | ConvertTo-Json
} else {
    Write-Output "[]"
}
            `;
        } else {
            queryScript = `
$target = "${target}"
try {
    if ($dcTarget) {
        $users = Get-ADUser -Filter * -SearchBase $target -Properties SamAccountName -Server $dcTarget -Credential $global:AD_CRED -ErrorAction Stop
    } else {
        $users = Get-ADUser -Filter * -SearchBase $target -Properties SamAccountName -Credential $global:AD_CRED -ErrorAction Stop
    }
} catch {
    $users = Get-ADUser -Filter * -SearchBase $target -Properties SamAccountName -Credential $global:AD_CRED -ErrorAction Stop
}
if ($users) {
    $users | Select-Object -ExpandProperty SamAccountName | ConvertTo-Json
} else {
    Write-Output "[]"
}
            `;
        }

        const script = `
$ErrorActionPreference = "Stop"
${credHdr}
$dcTarget = "${dcHost}"
${queryScript}
        `;

        const output = await runPowerShell(script);
        const rawJson = output.trim();
        let users = [];
        if (rawJson && rawJson !== '[]') {
            users = JSON.parse(rawJson);
            if (!Array.isArray(users)) users = [users];
        }
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Get all groups
router.get('/groups', (req, res) => {
    try {
        const config = readRbacConfig();
        res.json(config.groups || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add or update an AD mapping (OU, Group, or Account)
router.post('/groups', (req, res) => {
    try {
        const { type, target, adOu, enabled, features, auditLogs, role } = req.body || {};
        let { name } = req.body || {};
        if (isReservedMappingName(name)) {
            // Exactly "SuperAdmin" (non-account) edits the built-in.
            if (name === BUILTIN_SUPERADMIN_MAPPING && type !== 'account') return updateBuiltinMapping(req, res);
            // An AD account literally named "SuperAdmin" whose mapping name defaulted to the account itself:
            // derive a non-reserved mapping name instead of rejecting it.
            const accountTarget = target || adOu || '';
            if (type === 'account' && normalizeMappingName(name) === normalizeMappingName(accountTarget)) {
                name = `${String(name).trim()} (account)`;
            } else {
                // any other spelling / lookalike / type is a duplicate of the built-in
                return res.status(400).json({ error: RESERVED_NAME_ERROR });
            }
        }
        const mappingType = type || (adOu ? 'ou' : 'group');
        if (!['ou', 'group', 'account'].includes(mappingType)) {
            return res.status(400).json({ error: 'type must be one of: ou, group, account' });
        }
        const mappingTarget = (target || adOu || name || '').trim();

        if (mappingType === 'account') {
            // Type 3: Direct Account Mapping (Supports DN format like CN=ait80192,OU=... or SamAccountName)
            if (!mappingTarget) {
                return res.status(400).json({ error: 'AD Account Username or Distinguished Name is required' });
            }

            let accountName = mappingTarget;
            const cnMatch = mappingTarget.match(/^CN=([^,]+)/i);
            if (cnMatch) {
                accountName = cnMatch[1].trim();
            } else if (mappingTarget.includes('\\')) {
                accountName = mappingTarget.split('\\')[1].trim();
            } else if (mappingTarget.includes('@')) {
                accountName = mappingTarget.split('@')[0].trim();
            }

            const domain = getAllowedAdDomain() || req.user.domain || 'local';
            const userRole = role || 'None';
            updateUserRole(accountName, domain, userRole, name || '');
            auditLog(req.user.username, 'AD User Control', `Defined AD Account Mapping: ${accountName}@${domain} (Input: ${mappingTarget}, Default Role: ${userRole})`);
            try { require('../lib/websocket').broadcastEvent('USER_ROLE_CHANGED', { username: accountName, domain, role: userRole }); } catch(e) {}
            const config = readRbacConfig();
            return res.json({ success: true, isAccount: true, accountName, users: config.users, groups: config.groups || {} });
        }

        // Type 1 (OU) & Type 2 (Group)
        if (!name || !mappingTarget) {
            return res.status(400).json({ error: 'Mapping Name and Target are required' });
        }
        const config = readRbacConfig();
        if (!config.groups) config.groups = {};
        config.groups[name] = {
            type: mappingType,
            target: mappingTarget,
            adOu: mappingTarget, // for backward compat
            enabled: enabled !== false,
            features: features || {},
            auditLogs: auditLogs || {}
        };
        writeRbacConfig(config);
        auditLog(req.user.username, 'AD User Control', `Added/Updated AD Mapping (${mappingType}): ${name} -> ${mappingTarget}`);
        res.json({ success: true, groups: config.groups });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a group
router.delete('/groups/:name', (req, res) => {
    try {
        const name = req.params.name;
        if (isReservedMappingName(name)) {
            auditLog(req.user.username, 'RBAC', `Rejected attempt to delete the built-in SuperAdmin mapping (${name})`);
            return res.status(403).json({ error: 'The built-in mapping cannot be deleted' });
        }
        const config = readRbacConfig();
        if (config.groups && config.groups[name]) {
            delete config.groups[name];
            writeRbacConfig(config);
            auditLog(req.user.username, 'AD User Control', `Deleted Group: ${name}`);
        }
        res.json({ success: true, groups: config.groups || {} });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update or add a user role
router.post('/', (req, res) => {
    try {
        let { username, domain, role, groupName } = req.body;
        domain = domain || getAllowedAdDomain();
        if (!username || !domain || !role) {
            return res.status(400).json({ error: 'username, domain, and role are required' });
        }
        // The built-in mapping is role-based, never an AD group: no role assignment may target it.
        const groupKeyName = String(username).match(/^\[group\]\s*(.*)$/i);
        if ((groupKeyName && isReservedMappingName(groupKeyName[1])) || (groupName && isReservedMappingName(groupName))) {
            return res.status(400).json({ error: RESERVED_NAME_ERROR });
        }
        updateUserRole(username, domain, role, groupName);
        auditLog(req.user.username, 'AD User Control', `Assigned role ${role} to ${username}@${domain}`);
        try { require('../lib/websocket').broadcastEvent('USER_ROLE_CHANGED', { username, domain, role }); } catch(e) {}
        res.json({ success: true, message: `Updated ${username}@${domain} to ${role}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Remove a user role override
router.delete('/', (req, res) => {
    try {
        let { username, domain } = req.body;
        domain = domain || getAllowedAdDomain();
        if (!username || !domain) {
            return res.status(400).json({ error: 'username and domain are required' });
        }
        removeUserRole(username, domain);
        auditLog(req.user.username, 'AD User Control', `Removed custom role for ${username}@${domain}`);
        try { require('../lib/websocket').broadcastEvent('USER_ROLE_CHANGED', { username, domain, role: null }); } catch(e) {}
        res.json({ success: true, message: `Removed custom role for ${username}@${domain}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
