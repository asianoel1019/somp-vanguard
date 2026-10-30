// Pure helpers for Settings -> RBAC -> AD Mappings and the feature editor.
// Constants mirror backend/lib/featureCatalog.js (keep both in sync).
export const BUILTIN_SUPERADMIN_MAPPING = 'SuperAdmin';
export const SUPERADMIN_LOCKED_FEATURES = ['settings', 'auditLog'];
export const BUILTIN_NOTE = 'Applies to all SuperAdmin users. The local admin account always has every feature.';
export const LOCKED_FEATURE_TOOLTIP = 'Always on for SuperAdmin so you cannot lock yourself out of Settings / RBAC / Audit log.';

export const FEATURE_CATEGORIES = [
    {
        label: 'General Features',
        items: [
            { key: 'dnsHub', label: '🌐 DNS Hub' },
            { key: 'adControl', label: '👤 AD Control' },
            { key: 'runbook', label: '📖 SOP Runbook Library' },
            { key: 'aiAgent', label: '🤖 AI Ops Agent' }
        ]
    },
    {
        label: '🖥️ Server Operation',
        items: [
            { key: 'serverList', label: '💻 Server List' },
            { key: 'serverCheck', label: '🔍 Server Check' },
            { key: 'remoteCmd', label: '⚡ Remote Command' },
            { key: 'install', label: '🚀 Server Provision' },
            { key: 'nutanix', label: '🏢 Nutanix' },
            { key: 'inventory', label: '📋 Server Inventory' },
            { key: 'scheduler', label: '⏱️ Task Scheduler' },
            { key: 'hmChecker', label: '📡 HostMonitor Checker' }
        ]
    },
    {
        label: '👁️ Monitor',
        items: [
            { key: 'monitorScout', label: '📊 Scout Monitor' },
            { key: 'monitorAlerts', label: '🔔 Alerts & Rules' },
            { key: 'monitorWinEvent', label: '📺 Live Event Viewer' },
            { key: 'monitorLinuxLog', label: '⚙️ Log Settings' },
            { key: 'monitorAgents', label: '🤖 Agents' }
        ]
    },
    {
        label: '🖧 Network Service',
        items: [
            { key: 'fortiProxy', label: '🛡️ FortiProxy Manager' },
            { key: 'squid', label: '🦑 Squid Proxy' },
            { key: 'ipam', label: '🌐 IPAM' },
            { key: 'networkDevice', label: '🖧 Network Device' },
            { key: 'sslMonitor', label: '🔑 SSL Certificate' },
            { key: 'netSearch', label: '🔍 NetSearch' }
        ]
    },
    {
        label: '⚙️ Service Platform',
        items: [
            { key: 'mail', label: '📧 Mail Relay' },
            { key: 'elk', label: '📊 ELK Manager' },
            { key: 'prometheus', label: '🎯 Prometheus Target' },
            { key: 'redisControl', label: '📕 Redis Control' },
            { key: 'kubernetes', label: '☸️ Kubernetes' },
            { key: 'nasControl', label: '💾 NAS Manager' },
            { key: 'workflow', label: '⚡ Workflow' },
            { key: 'sftpManager', label: '📁 SFTP Manager' }
        ]
    },
    {
        label: '🗄️ Data Center',
        items: [
            { key: 'dataCenter', label: '🏢 Data Centers' }
        ]
    },
    {
        label: '🛢️ Database',
        items: [
            { key: 'dbInventory', label: '🗂️ DB Connection Hub' },
            { key: 'dbPerformance', label: '🚦 Performance Dashboard' },
            { key: 'dbProvision', label: '🛡️ Self-Service Provisioning' },
            { key: 'dbBackup', label: '💾 Backup & Restore' },
            { key: 'dbSqlTerminal', label: '🔍 SQL Query Terminal' }
        ]
    }
];

const BUILTIN_LOCKED_CATEGORY = {
    label: '⚙️ Settings & Audit (always on)',
    items: [
        { key: 'settings', label: '⚙️ Settings (System Settings, Dev Tools, RBAC & AD Mappings)' },
        { key: 'auditLog', label: '📋 Audit log' }
    ]
};
const SELF_HEALING_ITEM = { key: 'manage_self_healing', label: '🩺 Self-Healing Scripts' };

/** Same comparison as backend/lib/rbac.js: NFKC, no zero-width / format chars, trimmed, lower-case. */
export function normalizeMappingName(name) {
    return String(name || '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
}

export function isReservedMappingName(name) {
    return normalizeMappingName(name) === BUILTIN_SUPERADMIN_MAPPING.toLowerCase();
}

export function isBuiltinMapping(name, mapping) {
    return name === BUILTIN_SUPERADMIN_MAPPING && !!mapping && mapping.builtin === true;
}

/** Editor rows. The built-in also shows the locked Settings/Audit rows and the self-healing switch. */
export function getEditorCategories(isBuiltin) {
    if (!isBuiltin) return FEATURE_CATEGORIES;
    return [
        BUILTIN_LOCKED_CATEGORY,
        ...FEATURE_CATEGORIES.map(c => (c.label === '👁️ Monitor' ? { ...c, items: [...c.items, SELF_HEALING_ITEM] } : c))
    ];
}

export function isFeatureLocked(isBuiltin, key) {
    return !!isBuiltin && SUPERADMIN_LOCKED_FEATURES.includes(key);
}

export function normalizeEditorFeatures(isBuiltin, features) {
    const out = { ...(features || {}) };
    if (isBuiltin) SUPERADMIN_LOCKED_FEATURES.forEach(k => { out[k] = true; });
    return out;
}

/** "Toggle all" for one category; locked keys are left on. */
export function toggleCategory(isBuiltin, features, category, checked) {
    const next = { ...(features || {}) };
    category.items.forEach(item => {
        next[item.key] = isFeatureLocked(isBuiltin, item.key) ? true : checked;
    });
    return next;
}

/** AD Mappings table rows: built-in first, then the others in their stored order; accounts hidden. */
export function listMappings(groups) {
    const entries = Object.entries(groups || {}).filter(([, g]) => g && g.type !== 'account');
    const first = entries.filter(([n, g]) => isBuiltinMapping(n, g));
    const rest = entries.filter(([n, g]) => !isBuiltinMapping(n, g));
    return [...first, ...rest];
}

/** Mappings offered in "Add Custom Role Override": the built-in is role-based, not an AD target. */
export function listAssignableMappings(groups) {
    return listMappings(groups).filter(([n, g]) => !isBuiltinMapping(n, g) && g.builtin !== true);
}

export function mappingActions(name, mapping) {
    const builtin = isBuiltinMapping(name, mapping);
    return { canEdit: true, canDelete: !builtin, canToggle: !builtin, canRename: false };
}

export function buildSaveFeaturesPayload(name, group, features, auditLogs) {
    if (isBuiltinMapping(name, group)) {
        return { name, features: normalizeEditorFeatures(true, features) };
    }
    return {
        name,
        type: group.type || 'ou',
        target: group.target || group.adOu,
        adOu: group.target || group.adOu,
        enabled: group.enabled !== false,
        features,
        auditLogs
    };
}

/**
 * Reserved-name check for a new mapping. An AD account literally named "SuperAdmin" is allowed when the
 * mapping name is empty or equals the account (the backend derives "SuperAdmin (account)").
 */
export function validateNewMappingName(name, type, target) {
    if (!isReservedMappingName(name)) return null;
    if (type === 'account' && normalizeMappingName(name) === normalizeMappingName(target)) return null;
    return `"${BUILTIN_SUPERADMIN_MAPPING}" is a reserved built-in mapping name.`;
}
