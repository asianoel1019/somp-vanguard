require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeRbacConfig } = require('../../lib/rbac');
const { hasFeature, isFeatureGloballyDisabled, isSuperAdminUser } = require('../../lib/permissions');

const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
const rbac = (groups) => writeRbacConfig({ roles: ROLES, users: {}, defaultRole: 'Viewer', groups });

test('no user -> false', () => {
    assert.equal(hasFeature(null, 'aiAgent'), false);
});

test('isSuperAdminUser: role SuperAdmin or local admin account', () => {
    assert.equal(isSuperAdminUser({ role: 'SuperAdmin', username: 'x', domain: 'corp' }), true);
    assert.equal(isSuperAdminUser({ role: 'Viewer', username: 'Admin', domain: 'local' }), true);
    assert.equal(isSuperAdminUser({ role: 'Operator', username: 'bob', domain: 'corp' }), false);
});

test('SuperAdmin allowed when no RBAC groups exist', () => {
    rbac({});
    assert.equal(hasFeature({ role: 'SuperAdmin', username: 'boss', domain: 'corp', groups: [] }, 'aiAgent'), true);
});

test('non-admin without groups is denied', () => {
    rbac({});
    assert.equal(hasFeature({ role: 'Operator', username: 'op', domain: 'corp', groups: [] }, 'aiAgent'), false);
});

test('group member gets only features enabled on enabled groups', () => {
    rbac({ ops: { enabled: true, features: { aiAgent: true } }, off: { enabled: false, features: { workflow: true } } });
    const user = { role: 'Operator', username: 'op', domain: 'corp', groups: ['ops', 'off'] };
    assert.equal(hasFeature(user, 'aiAgent'), true);
    assert.equal(hasFeature(user, 'workflow'), false);
});

test('SuperAdmin follows the union of enabled groups once groups exist', () => {
    rbac({ ops: { enabled: true, features: { aiAgent: true } } });
    const boss = { role: 'SuperAdmin', username: 'boss', domain: 'corp', groups: [] };
    assert.equal(hasFeature(boss, 'aiAgent'), true);
    assert.equal(hasFeature(boss, 'workflow'), false);
});

test('APP_ENABLE_<KEY>=false disables the feature for everyone', (t) => {
    rbac({});
    process.env.APP_ENABLE_AIAGENT = 'false';
    t.after(() => { delete process.env.APP_ENABLE_AIAGENT; });
    assert.equal(isFeatureGloballyDisabled('aiAgent'), true);
    assert.equal(hasFeature({ role: 'SuperAdmin', username: 'boss', domain: 'corp' }, 'aiAgent'), false);
});

// ---- Built-in "SuperAdmin" mapping ----
const { buildFeatureMap, isLocalAdminUser } = require('../../lib/permissions');
const { FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES } = require('../../lib/featureCatalog');

const builtin = (features, groups = {}) => rbac({
    ...groups,
    SuperAdmin: { builtin: true, type: 'role', enabled: true, features },
});
const boss = { role: 'SuperAdmin', username: 'boss', domain: 'corp', groups: ['ops'] };
const localAdmin = { role: 'SuperAdmin', username: 'admin', domain: 'local' };
const op = { role: 'Operator', username: 'op', domain: 'corp', groups: ['ops'] };

test('isLocalAdminUser only matches the local break-glass account', () => {
    assert.equal(isLocalAdminUser(localAdmin), true);
    assert.equal(isLocalAdminUser({ role: 'SuperAdmin', username: 'admin', domain: 'corp' }), false);
    assert.equal(isLocalAdminUser(boss), false);
});

test('SuperAdmin features follow the built-in mapping exclusively, not other groups', () => {
    builtin({ aiAgent: true, workflow: false }, { ops: { type: 'group', target: 'ops', enabled: true, features: { workflow: true } } });
    assert.equal(hasFeature(boss, 'aiAgent'), true);
    assert.equal(hasFeature(boss, 'workflow'), false);
    assert.equal(hasFeature({ ...boss, groups: [] }, 'workflow'), false);
});

test('turning a built-in switch on grants it to SuperAdmin', () => {
    builtin({ workflow: true });
    assert.equal(hasFeature(boss, 'workflow'), true);
    builtin({ workflow: false });
    assert.equal(hasFeature(boss, 'workflow'), false);
});

test('lock-out guard: Settings / Audit keys are always on for SuperAdmin, never for others', () => {
    builtin({ settings: false, auditLog: false });
    for (const k of SUPERADMIN_LOCKED_FEATURES) {
        assert.equal(hasFeature(boss, k), true, k);
        assert.equal(hasFeature(op, k), false, k);
    }
});

test('local admin break-glass keeps every feature even when the built-in turns them off', () => {
    builtin({});
    for (const k of FEATURE_KEYS) assert.equal(hasFeature(localAdmin, k), true, k);
    assert.equal(hasFeature(boss, 'aiAgent'), false);
});

test('global kill switch still wins for SuperAdmin and the local admin', (t) => {
    builtin({ aiAgent: true });
    process.env.APP_ENABLE_AIAGENT = 'false';
    t.after(() => { delete process.env.APP_ENABLE_AIAGENT; });
    assert.equal(hasFeature(boss, 'aiAgent'), false);
    assert.equal(hasFeature(localAdmin, 'aiAgent'), false);
});

test('non-SuperAdmin unchanged: group union only, built-in never applies (even with a stale token group)', () => {
    builtin({ aiAgent: true, dnsHub: true }, { ops: { type: 'group', target: 'ops', enabled: true, features: { workflow: true } } });
    assert.equal(hasFeature(op, 'workflow'), true);
    assert.equal(hasFeature(op, 'aiAgent'), false);
    const stale = { role: 'Viewer', username: 'v', domain: 'corp', groups: ['SuperAdmin', 'ops'] };
    assert.equal(hasFeature(stale, 'dnsHub'), false);
    assert.equal(hasFeature(stale, 'workflow'), true);
});

test('buildFeatureMap agrees with hasFeature for every key and user', () => {
    builtin({ aiAgent: true, dnsHub: false, manage_self_healing: true }, { ops: { type: 'group', target: 'ops', enabled: true, features: { dnsHub: true, extra: true } } });
    for (const u of [boss, localAdmin, op, { role: 'Viewer', username: 'v', domain: 'corp' }]) {
        const map = buildFeatureMap(u);
        for (const k of [...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]) assert.equal(map[k], hasFeature(u, k), `${u.username}:${k}`);
    }
    assert.equal(buildFeatureMap(op).extra, true, 'keys from the user groups are included');
    assert.deepEqual(buildFeatureMap(null), {});
    const limited = buildFeatureMap(boss, ['aiAgent', 'dnsHub']);
    assert.deepEqual(limited, { aiAgent: true, dnsHub: false });
});
