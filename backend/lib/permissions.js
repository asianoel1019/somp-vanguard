/**
 * Feature permission checks shared by Express middleware, the AI Agent tools and every
 * login / session feature map in routes/auth.js (single source of truth).
 *
 * Evaluation order:
 *   1. lock-out guard   - SUPERADMIN_LOCKED_FEATURES are always on for SuperAdmin users
 *   2. global kill switch APP_ENABLE_<KEY>=false wins for everyone else
 *   3. break-glass       - the local admin account (LOCAL_ADMIN_USER, domain local) has every feature
 *   4. SuperAdmin        - exactly the switches of the built-in "SuperAdmin" mapping
 *   5. everyone else     - union of their enabled (non built-in) AD mappings
 */
const { readRbacConfig, isBuiltinMapping, isReservedMappingName } = require('./rbac');
const { BUILTIN_SUPERADMIN_MAPPING, FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES } = require('./featureCatalog');

function isFeatureGloballyDisabled(featureKey) {
    return process.env[`APP_ENABLE_${String(featureKey).toUpperCase()}`] === 'false';
}

function isLocalAdminUser(user) {
    if (!user) return false;
    const localAdmin = (process.env.LOCAL_ADMIN_USER || 'admin').trim().toLowerCase();
    return user.domain === 'local' && String(user.username || '').toLowerCase() === localAdmin;
}

function isSuperAdminUser(user) {
    if (!user) return false;
    return user.role === 'SuperAdmin' || isLocalAdminUser(user);
}

function evaluateFeature(user, featureKey, rbac) {
    if (!user) return false;
    if (isSuperAdminUser(user) && SUPERADMIN_LOCKED_FEATURES.includes(featureKey)) return true;
    if (isFeatureGloballyDisabled(featureKey)) return false;
    if (isLocalAdminUser(user)) return true;

    const groups = (rbac && rbac.groups) || {};
    if (user.role === 'SuperAdmin') {
        const b = groups[BUILTIN_SUPERADMIN_MAPPING];
        return !!(isBuiltinMapping(BUILTIN_SUPERADMIN_MAPPING, b) && b.features && b.features[featureKey] === true);
    }
    return (user.groups || []).some(gName => {
        if (isReservedMappingName(gName)) return false; // the built-in never applies through group membership
        const g = Object.prototype.hasOwnProperty.call(groups, gName) ? groups[gName] : null;
        return !!(g && g.builtin !== true && g.enabled !== false && g.features && g.features[featureKey] === true);
    });
}

function hasFeature(user, featureKey) {
    if (!user) return false;
    return evaluateFeature(user, featureKey, readRbacConfig());
}

/**
 * Feature map for login / session responses. Default keys: every catalogue key, the lock-out keys
 * and any key present on the user's own mappings. Values always equal hasFeature(user, key).
 */
function buildFeatureMap(user, keys, rbac) {
    if (!user) return {};
    const cfg = rbac || readRbacConfig();
    let list = keys;
    if (!list) {
        const set = new Set([...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]);
        for (const gName of user.groups || []) {
            const g = Object.prototype.hasOwnProperty.call(cfg.groups || {}, gName) ? cfg.groups[gName] : null;
            if (g && g.features) Object.keys(g.features).forEach(k => set.add(k));
        }
        list = [...set];
    }
    const map = {};
    for (const k of list) map[k] = evaluateFeature(user, k, cfg);
    return map;
}

module.exports = { hasFeature, buildFeatureMap, evaluateFeature, isFeatureGloballyDisabled, isSuperAdminUser, isLocalAdminUser };
