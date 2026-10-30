const { encryptText, decryptText } = require('./crypto');
const { readDataSync, writeDataSync } = require('./db');
const { BUILTIN_SUPERADMIN_MAPPING, FEATURE_KEYS, LEGACY_CONFIG_FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES } = require('./featureCatalog');

const BUILTIN_DESCRIPTION = 'Applies to all SuperAdmin users. The local admin account always has every feature.';

/** Comparison form of a mapping name: NFKC (folds fullwidth etc.), no zero-width / format chars, trimmed, lower-case. */
function normalizeMappingName(name) {
    return String(name || '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
}

/** True for any spelling of the reserved built-in mapping name ("SuperAdmin", "superadmin ", "ＳｕｐｅｒＡｄｍｉｎ", ...). */
function isReservedMappingName(name) {
    return normalizeMappingName(name) === BUILTIN_SUPERADMIN_MAPPING.toLowerCase();
}

let warnedLocalAdDomain = false;
/**
 * ALLOWED_AD_DOMAIN without quotes. "local" is the break-glass account's domain and is never a valid
 * AD domain: it is ignored (returns '') so an AD user can never be classified as the local admin.
 */
function getAllowedAdDomain() {
    const value = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
    if (value.toLowerCase() === 'local') {
        if (!warnedLocalAdDomain) {
            warnedLocalAdDomain = true;
            console.warn('[RBAC] ALLOWED_AD_DOMAIN must not be "local" (reserved for the local admin account); AD login is disabled until it is changed.');
        }
        return '';
    }
    return value;
}

/** True only for the genuine built-in entry (reserved key + builtin flag). */
function isBuiltinMapping(name, mapping) {
    return name === BUILTIN_SUPERADMIN_MAPPING && !!mapping && mapping.builtin === true;
}

/**
 * Old effective SuperAdmin set, so upgrading changes nothing:
 *  - no enabled ordinary mapping -> every key on;
 *  - keys the old /api/auth/config filtered for SuperAdmin -> "any enabled mapping has it";
 *  - every other key was never hidden for SuperAdmin (sidebar, self-healing) -> on.
 */
function seedBuiltinFeatures(groups) {
    const enabled = Object.values(groups || {}).filter(g => g && g.enabled !== false && g.type !== 'account');
    const keys = [...new Set([...FEATURE_KEYS, ...LEGACY_CONFIG_FEATURE_KEYS])];
    const features = {};
    if (enabled.length === 0) {
        keys.forEach(k => { features[k] = true; });
    } else {
        keys.forEach(k => {
            features[k] = LEGACY_CONFIG_FEATURE_KEYS.includes(k)
                ? enabled.some(g => g.features && g.features[k] === true)
                : true;
        });
        enabled.forEach(g => Object.entries(g.features || {}).forEach(([k, v]) => { if (v === true) features[k] = true; }));
    }
    SUPERADMIN_LOCKED_FEATURES.forEach(k => { features[k] = true; });
    return features;
}

function uniqueLegacyName(groups, name) {
    // case-insensitive: role keys ("[group] <name>@local") are lower-cased, so names must differ beyond case
    const taken = new Set(Object.keys(groups).map(k => k.toLowerCase()));
    let candidate = `${name} (legacy)`;
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} (legacy ${i})`;
    return candidate;
}

/**
 * Ensures the built-in SuperAdmin mapping exists and keeps its invariants.
 * Mutates config; returns true when anything changed (so the caller can persist it).
 */
function ensureBuiltinSuperAdmin(config) {
    let changed = false;
    if (!config.groups || typeof config.groups !== 'object') { config.groups = {}; changed = true; }
    if (!config.users || typeof config.users !== 'object') config.users = {};
    const groups = config.groups;

    for (const name of Object.keys(groups)) {
        const g = groups[name];
        if (isBuiltinMapping(name, g)) continue;
        if (g && g.builtin !== undefined) { delete g.builtin; changed = true; }
        if (!isReservedMappingName(name)) continue;
        // A user-defined mapping using the reserved name: keep it, under a new name, with its role assignments.
        const newName = uniqueLegacyName(groups, name);
        groups[newName] = g;
        delete groups[name];
        const oldKey = `[group] ${name}@local`.toLowerCase();
        const newKey = `[group] ${newName}@local`.toLowerCase();
        for (const [uKey, uVal] of Object.entries(config.users)) {
            let val = uVal;
            if (val && typeof val === 'object' && typeof val.groupName === 'string'
                && val.groupName.toLowerCase() === name.toLowerCase()) val = { ...val, groupName: newName };
            if (uKey === oldKey) { delete config.users[uKey]; config.users[newKey] = val; } else { config.users[uKey] = val; }
        }
        console.warn(`[RBAC] Mapping "${name}" uses the reserved built-in name; renamed to "${newName}".`);
        changed = true;
    }

    let b = groups[BUILTIN_SUPERADMIN_MAPPING];
    if (!b) {
        b = { builtin: true, type: 'role', enabled: true, description: BUILTIN_DESCRIPTION, features: seedBuiltinFeatures(groups), auditLogs: {} };
        groups[BUILTIN_SUPERADMIN_MAPPING] = b;
        return true;
    }
    if (b.type !== 'role') { b.type = 'role'; changed = true; }
    if (b.enabled !== true) { b.enabled = true; changed = true; }
    for (const field of ['target', 'adOu']) {
        if (field in b) { delete b[field]; changed = true; }
    }
    if (!b.features || typeof b.features !== 'object') { b.features = {}; changed = true; }
    for (const k of SUPERADMIN_LOCKED_FEATURES) {
        if (b.features[k] !== true) { b.features[k] = true; changed = true; }
    }
    if (typeof b.description !== 'string') { b.description = BUILTIN_DESCRIPTION; changed = true; }
    return changed;
}

function readRbacConfig() {
    const makeDefault = () => {
        const cfg = { roles: ["SuperAdmin", "Operator", "Viewer", "None"], users: {}, defaultRole: "Viewer", groups: {} };
        ensureBuiltinSuperAdmin(cfg);
        return cfg;
    };
    try {
        const fileContent = readDataSync('system/rbac.json', null);
        if (fileContent === null) {
            return makeDefault();
        }

        // readDataSync might parse it as JSON if someone maliciously saved plain JSON.
        // We strictly enforce it to be an encrypted string.
        if (typeof fileContent === 'object' || !fileContent.includes(':') || fileContent.startsWith('{')) {
            console.error('[RBAC] Security Error: rbac.json is not encrypted or tampered. Falling back to default.');
            return makeDefault();
        }

        const decrypted = decryptText(fileContent);
        if (decrypted === fileContent) {
            console.error('[RBAC] Security Error: Decryption failed for rbac.json. Falling back to default.');
            return makeDefault();
        }

        const config = JSON.parse(decrypted);

        if (!Array.isArray(config.roles)) {
            config.roles = ["SuperAdmin", "Operator", "Viewer", "None"];
        } else if (!config.roles.includes('None')) {
            config.roles.push('None');
        }

        if (!config.groups) config.groups = {};
        // Upgrade: create / repair the built-in SuperAdmin mapping once and persist it,
        // so its initial switches are frozen and later group edits do not change them.
        if (ensureBuiltinSuperAdmin(config)) {
            writeRbacConfig(config);
        }
        return config;
    } catch (err) {
        console.error('[RBAC] Error reading rbac.json:', err);
        return makeDefault();
    }
}

function writeRbacConfig(config) {
    try {
        const plainText = JSON.stringify(config, null, 2);
        const cipherText = encryptText(plainText);
        writeDataSync('system/rbac.json', cipherText);
        return true;
    } catch (err) {
        console.error('[RBAC] Error writing rbac.json:', err);
        return false;
    }
}

function getUserRole(username, domain) {
    const config = readRbacConfig();
    
    // Always grant SuperAdmin to the configured local admin
    const localUser = (process.env.LOCAL_ADMIN_USER || 'admin').trim().toLowerCase();
    if (domain === 'local' && username.toLowerCase() === localUser) {
        return 'SuperAdmin';
    }

    const key = `${username}@${domain}`.toLowerCase();
    if (config.users && config.users[key]) {
        return typeof config.users[key] === 'string' ? config.users[key] : config.users[key].role;
    }
    return config.defaultRole || 'Viewer';
}

function updateUserRole(username, domain, role, groupName) {
    const config = readRbacConfig();
    if (!config.roles.includes(role)) {
        throw new Error(`Invalid role: ${role}`);
    }
    const key = `${username}@${domain}`.toLowerCase();
    config.users[key] = groupName ? { role, groupName } : role;
    return writeRbacConfig(config);
}

function removeUserRole(username, domain) {
    const config = readRbacConfig();
    const key = `${username}@${domain}`.toLowerCase();
    if (config.users[key]) {
        delete config.users[key];
        return writeRbacConfig(config);
    }
    return true;
}

module.exports = {
    readRbacConfig,
    writeRbacConfig,
    getUserRole,
    updateUserRole,
    removeUserRole,
    isReservedMappingName,
    normalizeMappingName,
    getAllowedAdDomain,
    isBuiltinMapping,
    ensureBuiltinSuperAdmin,
    BUILTIN_DESCRIPTION
};
