require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeDataSync } = require('../../lib/db');
const {
    readRbacConfig, writeRbacConfig, getUserRole, updateUserRole, removeUserRole,
} = require('../../lib/rbac');

const DEFAULT_ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];

// Order matters: this must run before anything writes system/rbac.json
test('returns default config when rbac.json does not exist', () => {
    const cfg = readRbacConfig();
    assert.deepEqual(cfg.roles, DEFAULT_ROLES);
    assert.equal(cfg.defaultRole, 'Viewer');
    assert.deepEqual(cfg.users, {});
});

test('write then read round-trips through encryption', () => {
    assert.equal(writeRbacConfig({ roles: DEFAULT_ROLES, users: { 'bob@corp': 'Operator' }, defaultRole: 'Viewer', groups: {} }), true);
    assert.equal(readRbacConfig().users['bob@corp'], 'Operator');
});

test('plain JSON (tampered) rbac.json is rejected and falls back to default', () => {
    writeDataSync('system/rbac.json', { roles: DEFAULT_ROLES, users: { 'evil@corp': 'SuperAdmin' }, defaultRole: 'SuperAdmin' });
    const cfg = readRbacConfig();
    assert.equal(cfg.users['evil@corp'], undefined);
    assert.equal(cfg.defaultRole, 'Viewer');
});

test('garbage ciphertext falls back to default', () => {
    writeDataSync('system/rbac.json', 'aa:bb:cc');
    assert.equal(readRbacConfig().defaultRole, 'Viewer');
});

test('adds missing "None" role and groups on read', () => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Viewer'], users: {}, defaultRole: 'Viewer' });
    const cfg = readRbacConfig();
    assert.ok(cfg.roles.includes('None'));
    // only the built-in SuperAdmin mapping is added
    assert.deepEqual(Object.keys(cfg.groups), ['SuperAdmin']);
    assert.equal(cfg.groups.SuperAdmin.builtin, true);
});

test('local admin is always SuperAdmin regardless of config', () => {
    writeRbacConfig({ roles: DEFAULT_ROLES, users: { 'admin@local': 'Viewer' }, defaultRole: 'None', groups: {} });
    assert.equal(getUserRole('Admin', 'local'), 'SuperAdmin');
});

test('same username on AD domain is NOT auto SuperAdmin', () => {
    writeRbacConfig({ roles: DEFAULT_ROLES, users: {}, defaultRole: 'Viewer', groups: {} });
    assert.equal(getUserRole('admin', 'corp.local'), 'Viewer');
});

test('updateUserRole is case-insensitive and supports groupName', () => {
    writeRbacConfig({ roles: DEFAULT_ROLES, users: {}, defaultRole: 'Viewer', groups: {} });
    updateUserRole('Alice', 'CORP', 'Operator', 'ops-team');
    assert.deepEqual(readRbacConfig().users['alice@corp'], { role: 'Operator', groupName: 'ops-team' });
    assert.equal(getUserRole('alice', 'corp'), 'Operator');
});

test('updateUserRole rejects unknown role', () => {
    assert.throws(() => updateUserRole('x', 'corp', 'God'), /Invalid role: God/);
});

test('removeUserRole falls back to defaultRole', () => {
    updateUserRole('carol', 'corp', 'Operator');
    removeUserRole('carol', 'corp');
    assert.equal(getUserRole('carol', 'corp'), 'Viewer');
    assert.equal(removeUserRole('nobody', 'corp'), true);
});
