/**
 * Feature catalogue shared by RBAC storage (lib/rbac.js) and evaluation (lib/permissions.js).
 * Keep FEATURE_KEYS in sync with the feature editor in
 * frontend/src/components/SettingsGroup/rbacBuiltinUtils.js.
 */

// Reserved key of the built-in, non-deletable mapping that holds the SuperAdmin feature switches.
const BUILTIN_SUPERADMIN_MAPPING = 'SuperAdmin';

// Every switchable feature key (feature editor + manage_self_healing, which SuperAdmin always had).
const FEATURE_KEYS = Object.freeze([
    'dnsHub', 'adControl', 'runbook', 'aiAgent',
    'serverList', 'serverCheck', 'remoteCmd', 'install', 'nutanix', 'inventory', 'scheduler', 'hmChecker',
    'monitorScout', 'monitorAlerts', 'monitorWinEvent', 'monitorLinuxLog', 'monitorAgents', 'manage_self_healing',
    'fortiProxy', 'squid', 'ipam', 'networkDevice', 'sslMonitor', 'netSearch',
    'mail', 'elk', 'prometheus', 'redisControl', 'kubernetes', 'nasControl', 'workflow', 'sftpManager',
    'dataCenter',
    'dbInventory', 'dbPerformance', 'dbProvision', 'dbBackup', 'dbSqlTerminal',
]);

// Keys the pre-built-in /api/auth/config returned and filtered for SuperAdmin by "any enabled group".
// Upgrade seeding uses that result for these keys; every other key was always visible to SuperAdmin
// (sidebar never hid it), so it is seeded ON.
const LEGACY_CONFIG_FEATURE_KEYS = Object.freeze([
    'dnsHub', 'adControl', 'serverList', 'serverCheck', 'remoteCmd', 'fortiProxy', 'squid', 'mail', 'elk',
    'install', 'prometheus', 'nutanix', 'dataCenter', 'redisControl', 'inventory', 'ipam', 'sslMonitor',
    'scheduler', 'netSearch', 'kubernetes', 'workflow', 'runbook', 'dbInventory', 'dbSqlTerminal',
    'dbPerformance', 'dbProvision', 'dbBackup', 'scoutMonitor', 'aiAgent',
]);

// Lock-out guard: always on for SuperAdmin whatever the switches say
// ('settings' = System Settings / Dev Tools / RBAC & AD Mappings screens, 'auditLog' = Audit log viewer).
const SUPERADMIN_LOCKED_FEATURES = Object.freeze(['settings', 'auditLog']);

// Feature keys accepted when storing switches (no prototype-ish or free-form keys).
const FEATURE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

module.exports = { BUILTIN_SUPERADMIN_MAPPING, FEATURE_KEYS, LEGACY_CONFIG_FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES, FEATURE_KEY_PATTERN };
