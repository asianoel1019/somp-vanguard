require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { decryptText } = require('../../lib/crypto');
const { readRbacConfig, writeRbacConfig, isReservedMappingName, isBuiltinMapping } = require('../../lib/rbac');
const {
    BUILTIN_SUPERADMIN_MAPPING, FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES,
} = require('../../lib/featureCatalog');

const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
const rawConfig = () => JSON.parse(decryptText(readDataSync('system/rbac.json', null)));

// Order matters: must run before anything writes system/rbac.json
test('fresh install: built-in SuperAdmin mapping exists with every known feature on, without writing a file', () => {
    const cfg = readRbacConfig();
    const b = cfg.groups[BUILTIN_SUPERADMIN_MAPPING];
    assert.ok(b);
    assert.equal(b.builtin, true);
    assert.equal(b.type, 'role');
    assert.equal(b.enabled, true);
    for (const k of FEATURE_KEYS) assert.equal(b.features[k], true, k);
    for (const k of SUPERADMIN_LOCKED_FEATURES) assert.equal(b.features[k], true, k);
    assert.equal(readDataSync('system/rbac.json', null), null);
});

test('reserved name helpers are case-insensitive', () => {
    assert.equal(BUILTIN_SUPERADMIN_MAPPING, 'SuperAdmin');
    assert.equal(isReservedMappingName('superadmin'), true);
    assert.equal(isReservedMappingName(' SUPERADMIN '), true);
    assert.equal(isReservedMappingName('SuperAdmins'), false);
    assert.equal(isReservedMappingName(''), false);
    // lookalikes: NFKC folds fullwidth letters; zero-width / format characters are ignored
    assert.equal(isReservedMappingName('ＳｕｐｅｒＡｄｍｉｎ'), true);
    assert.equal(isReservedMappingName('Super​Admin'), true);
    assert.equal(isReservedMappingName('﻿superadmin⁠'), true);
    assert.equal(isReservedMappingName('Super Admin'), false);
    assert.equal(isBuiltinMapping('SuperAdmin', { builtin: true }), true);
    assert.equal(isBuiltinMapping('ops', { builtin: true }), false);
    assert.equal(isBuiltinMapping('SuperAdmin', { type: 'group' }), false);
});

test('upgrade with groups: initial features = old effective SuperAdmin set, persisted', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            ops: { type: 'group', target: 'ops', enabled: true, features: { aiAgent: true, workflow: false, customKey: true } },
            off: { type: 'ou', target: 'ou=x', enabled: false, features: { dnsHub: true } },
        },
    });
    const b = readRbacConfig().groups.SuperAdmin;
    assert.equal(b.features.aiAgent, true);
    assert.equal(b.features.customKey, true);
    assert.equal(b.features.workflow, false);
    assert.equal(b.features.dnsHub, false, 'disabled groups do not count');
    assert.equal(b.features.manage_self_healing, true, 'SuperAdmin always had self-healing');
    for (const k of SUPERADMIN_LOCKED_FEATURES) assert.equal(b.features[k], true);
    // persisted, so later group edits do not reseed it
    assert.equal(rawConfig().groups.SuperAdmin.builtin, true);
    assert.equal(rawConfig().groups.SuperAdmin.features.aiAgent, true);
});

test('creation is idempotent: an existing built-in is never reseeded', () => {
    const cfg = readRbacConfig();
    cfg.groups.SuperAdmin.features.aiAgent = false;
    cfg.groups.ops.features.workflow = true;
    writeRbacConfig(cfg);
    const again = readRbacConfig().groups.SuperAdmin;
    assert.equal(again.features.aiAgent, false);
    assert.equal(again.features.workflow, false);
    assert.deepEqual(readRbacConfig().groups.SuperAdmin, again);
});

test('upgrade without enabled groups: all known features on', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            off: { type: 'ou', target: 'ou=x', enabled: false, features: { dnsHub: false } },
        },
    });
    const b = readRbacConfig().groups.SuperAdmin;
    for (const k of FEATURE_KEYS) assert.equal(b.features[k], true, k);
});

test('built-in invariants are restored on read (always enabled, type role, no AD target, locked keys on)', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'group', target: 'Domain Users', adOu: 'Domain Users', enabled: false, features: { aiAgent: true, settings: false } },
        },
    });
    const b = readRbacConfig().groups.SuperAdmin;
    assert.equal(b.enabled, true);
    assert.equal(b.type, 'role');
    assert.equal(b.target, undefined);
    assert.equal(b.adOu, undefined);
    assert.equal(b.features.aiAgent, true);
    assert.equal(b.features.settings, true);
    assert.equal(rawConfig().groups.SuperAdmin.enabled, true);
});

test('a legacy user-defined mapping using the reserved name is renamed with its role assignments', () => {
    writeRbacConfig({
        roles: ROLES, defaultRole: 'Viewer',
        users: { '[group] superadmin@local': { role: 'SuperAdmin', groupName: 'superadmin' }, 'bob@corp': { role: 'Operator', groupName: 'superadmin' } },
        groups: { superadmin: { type: 'group', target: 'SOMP-Admins', enabled: true, features: { dnsHub: true } } },
    });
    const cfg = readRbacConfig();
    assert.equal(cfg.groups.superadmin, undefined);
    const legacy = cfg.groups['superadmin (legacy)'];
    assert.ok(legacy);
    assert.equal(legacy.target, 'SOMP-Admins');
    assert.equal(legacy.builtin, undefined);
    assert.equal(cfg.users['[group] superadmin@local'], undefined);
    assert.deepEqual(cfg.users['[group] superadmin (legacy)@local'], { role: 'SuperAdmin', groupName: 'superadmin (legacy)' });
    assert.equal(cfg.users['bob@corp'].groupName, 'superadmin (legacy)');
    // the legacy group counted toward the old effective set
    assert.equal(cfg.groups.SuperAdmin.features.dnsHub, true);
    assert.equal(cfg.groups.SuperAdmin.features.aiAgent, false);
});

test('legacy rename matches groupName references case-insensitively and avoids case-only collisions', () => {
    writeRbacConfig({
        roles: ROLES, defaultRole: 'Viewer',
        users: { 'carol@corp': { role: 'Operator', groupName: 'SUPERADMIN' } },
        groups: {
            superadmin: { type: 'group', target: 'A', enabled: true, features: {} },
            'SuperAdmin (LEGACY)': { type: 'group', target: 'B', enabled: true, features: {} },
        },
    });
    const cfg = readRbacConfig();
    assert.equal(cfg.users['carol@corp'].groupName, 'superadmin (legacy 2)');
    assert.equal(cfg.groups['superadmin (legacy 2)'].target, 'A');
    assert.equal(cfg.groups['SuperAdmin (LEGACY)'].target, 'B');
});

test('getAllowedAdDomain never returns "local" (break-glass cannot be reached through AD)', (t) => {
    const { getAllowedAdDomain } = require('../../lib/rbac');
    const saved = process.env.ALLOWED_AD_DOMAIN;
    t.after(() => { if (saved === undefined) delete process.env.ALLOWED_AD_DOMAIN; else process.env.ALLOWED_AD_DOMAIN = saved; });
    process.env.ALLOWED_AD_DOMAIN = '"corp.test"';
    assert.equal(getAllowedAdDomain(), 'corp.test');
    for (const v of ['local', ' LOCAL ', "'Local'"]) {
        process.env.ALLOWED_AD_DOMAIN = v;
        assert.equal(getAllowedAdDomain(), '', v);
    }
    delete process.env.ALLOWED_AD_DOMAIN;
    assert.equal(getAllowedAdDomain(), '');
});

test('builtin flag on a non-reserved key is stripped', () => {
    writeRbacConfig({ roles: ROLES, users: {}, defaultRole: 'Viewer', groups: { ops: { builtin: true, type: 'group', target: 'ops', enabled: true, features: {} } } });
    const cfg = readRbacConfig();
    assert.equal(cfg.groups.ops.builtin, undefined);
    assert.equal(cfg.groups.SuperAdmin.builtin, true);
});

test('tampered file falls back to default without overwriting it', () => {
    writeDataSync('system/rbac.json', 'aa:bb:cc');
    const cfg = readRbacConfig();
    assert.equal(cfg.groups.SuperAdmin.builtin, true);
    assert.equal(readDataSync('system/rbac.json', null), 'aa:bb:cc');
});

test('upgrade changes nothing: built-in reproduces the old effective SuperAdmin visibility (sidebar + API)', () => {
    const { hasFeature } = require('../../lib/permissions');
    const { LEGACY_CONFIG_FEATURE_KEYS } = require('../../lib/featureCatalog');
    const fixtureGroups = {
        ops: { type: 'group', target: 'ops', enabled: true, features: { dnsHub: true, workflow: false, monitorScout: false, nasControl: true } },
        net: { type: 'ou', target: 'ou=net', enabled: true, features: { ipam: true, aiAgent: true } },
        off: { type: 'group', target: 'off', enabled: false, features: { elk: true, mail: true, hmChecker: true } },
    };
    const groupsCopy = () => JSON.parse(JSON.stringify(fixtureGroups));

    // --- old semantics (pre built-in), reimplemented verbatim ---
    const enabled = Object.values(fixtureGroups).filter(g => g.enabled !== false);
    const anyGroup = (k) => enabled.some(g => g.features && g.features[k] === true);
    // old /api/auth/config for a SuperAdmin without groups: listed keys filtered by "any enabled group";
    // keys absent from /config were never hidden in the sidebar (featureFlags[k] !== false)
    const oldSidebar = (k) => (LEGACY_CONFIG_FEATURE_KEYS.includes(k) ? anyGroup(k) : true);
    // old lib/permissions hasFeature for a SuperAdmin: any enabled group
    const oldApi = (k) => anyGroup(k);
    const oldVisible = (k) => oldSidebar(k) || oldApi(k);

    writeRbacConfig({ roles: ROLES, users: {}, defaultRole: 'Viewer', groups: groupsCopy() });
    const boss = { role: 'SuperAdmin', username: 'boss', domain: 'corp', groups: [] };
    const keys = [...new Set([...FEATURE_KEYS, ...LEGACY_CONFIG_FEATURE_KEYS])];
    for (const k of keys) assert.equal(hasFeature(boss, k), oldVisible(k), k);
    // spot checks
    assert.equal(hasFeature(boss, 'dnsHub'), true);
    assert.equal(hasFeature(boss, 'workflow'), false);
    assert.equal(hasFeature(boss, 'elk'), false, 'disabled group did not count');
    assert.equal(hasFeature(boss, 'monitorScout'), true, 'never filtered for SuperAdmin -> on');
    assert.equal(hasFeature(boss, 'hmChecker'), true);
    assert.equal(hasFeature(boss, 'manage_self_healing'), true);
    assert.equal(hasFeature(boss, 'scoutMonitor'), false, 'old /config key, no group had it');
});

test('backend feature catalogue matches the frontend feature editor', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../../frontend/src/components/SettingsGroup/rbacBuiltinUtils.js'), 'utf8');
    const editorKeys = new Set([...src.matchAll(/key: '([A-Za-z_]+)'/g)].map(m => m[1]));
    const backendKeys = new Set([...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]);
    assert.deepEqual([...editorKeys].sort(), [...backendKeys].sort());
});
