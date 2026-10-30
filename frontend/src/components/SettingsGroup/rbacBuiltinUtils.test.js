import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BUILTIN_SUPERADMIN_MAPPING, SUPERADMIN_LOCKED_FEATURES, BUILTIN_NOTE, LOCKED_FEATURE_TOOLTIP,
    isBuiltinMapping, isReservedMappingName, getEditorCategories, isFeatureLocked, normalizeEditorFeatures,
    toggleCategory, listMappings, listAssignableMappings, mappingActions, buildSaveFeaturesPayload, validateNewMappingName,
} from './rbacBuiltinUtils.js';

const builtin = { builtin: true, type: 'role', enabled: true, features: { aiAgent: true } };
const ops = { type: 'group', target: 'ops', enabled: false, features: {} };

test('constants mirror the backend catalogue', () => {
    assert.equal(BUILTIN_SUPERADMIN_MAPPING, 'SuperAdmin');
    assert.deepEqual(SUPERADMIN_LOCKED_FEATURES, ['settings', 'auditLog']);
    assert.equal(BUILTIN_NOTE, 'Applies to all SuperAdmin users. The local admin account always has every feature.');
    assert.match(LOCKED_FEATURE_TOOLTIP, /always on/i);
});

test('isBuiltinMapping needs the reserved key and the builtin flag', () => {
    assert.equal(isBuiltinMapping('SuperAdmin', builtin), true);
    assert.equal(isBuiltinMapping('SuperAdmin', ops), false);
    assert.equal(isBuiltinMapping('ops', builtin), false);
    assert.equal(isReservedMappingName(' superADMIN '), true);
    assert.equal(isReservedMappingName('ops'), false);
});

test('editor categories: built-in adds the locked Settings/Audit rows and self-healing; others unchanged', () => {
    const normal = getEditorCategories(false);
    const keysNormal = normal.flatMap(c => c.items.map(i => i.key));
    assert.ok(!keysNormal.includes('settings'));
    assert.ok(!keysNormal.includes('manage_self_healing'));
    assert.ok(keysNormal.includes('dnsHub'));
    const b = getEditorCategories(true);
    const keysB = b.flatMap(c => c.items.map(i => i.key));
    for (const k of SUPERADMIN_LOCKED_FEATURES) assert.ok(keysB.includes(k), k);
    assert.ok(keysB.includes('manage_self_healing'));
    assert.equal(keysB.length, keysNormal.length + 3);
});

test('locked keys are locked only on the built-in', () => {
    assert.equal(isFeatureLocked(true, 'settings'), true);
    assert.equal(isFeatureLocked(true, 'auditLog'), true);
    assert.equal(isFeatureLocked(true, 'dnsHub'), false);
    assert.equal(isFeatureLocked(false, 'settings'), false);
});

test('normalizeEditorFeatures forces locked keys on for the built-in only', () => {
    assert.deepEqual(normalizeEditorFeatures(true, { settings: false, dnsHub: false }), { settings: true, auditLog: true, dnsHub: false });
    assert.deepEqual(normalizeEditorFeatures(false, { settings: false }), { settings: false });
    assert.deepEqual(normalizeEditorFeatures(true, undefined), { settings: true, auditLog: true });
});

test('toggleCategory never turns a locked key off', () => {
    const cat = { items: [{ key: 'settings' }, { key: 'auditLog' }] };
    assert.deepEqual(toggleCategory(true, { settings: true, auditLog: true }, cat, false), { settings: true, auditLog: true });
    const cat2 = { items: [{ key: 'dnsHub' }, { key: 'ipam' }] };
    assert.deepEqual(toggleCategory(true, {}, cat2, true), { dnsHub: true, ipam: true });
    assert.deepEqual(toggleCategory(false, { settings: true }, cat, false), { settings: false, auditLog: false });
});

test('listMappings puts the built-in first and hides account entries', () => {
    const list = listMappings({ ops, acc: { type: 'account' }, SuperAdmin: builtin, zeta: { type: 'ou', target: 'ou=z' } });
    assert.deepEqual(list.map(([n]) => n), ['SuperAdmin', 'ops', 'zeta']);
    assert.deepEqual(listMappings(undefined), []);
});

test('the built-in is not offered for role overrides', () => {
    const list = listAssignableMappings({ ops, SuperAdmin: builtin });
    assert.deepEqual(list.map(([n]) => n), ['ops']);
});

test('mappingActions: built-in can only be edited', () => {
    assert.deepEqual(mappingActions('SuperAdmin', builtin), { canEdit: true, canDelete: false, canToggle: false, canRename: false });
    assert.deepEqual(mappingActions('ops', ops), { canEdit: true, canDelete: true, canToggle: true, canRename: false });
});

test('buildSaveFeaturesPayload: built-in sends only name + features (locked on); others keep the old payload', () => {
    assert.deepEqual(buildSaveFeaturesPayload('SuperAdmin', builtin, { settings: false, dnsHub: true }, { x: true }),
        { name: 'SuperAdmin', features: { settings: true, auditLog: true, dnsHub: true } });
    assert.deepEqual(buildSaveFeaturesPayload('ops', ops, { dnsHub: true }, { dnsHub: true }), {
        name: 'ops', type: 'group', target: 'ops', adOu: 'ops', enabled: false, features: { dnsHub: true }, auditLogs: { dnsHub: true },
    });
});

test('validateNewMappingName rejects the reserved name in any case / lookalike form', () => {
    assert.match(validateNewMappingName('superadmin'), /reserved/i);
    assert.match(validateNewMappingName('ＳｕｐｅｒＡｄｍｉｎ'), /reserved/i);
    assert.match(validateNewMappingName('Super​Admin'), /reserved/i);
    assert.equal(validateNewMappingName('Super Admin'), null);
    assert.equal(validateNewMappingName('ops'), null);
});

test('an AD account literally named SuperAdmin is allowed (backend derives the mapping name)', () => {
    assert.equal(validateNewMappingName('', 'account', 'SuperAdmin'), null);
    assert.equal(validateNewMappingName('SuperAdmin', 'account', 'superadmin'), null);
    assert.match(validateNewMappingName('SuperAdmin', 'account', 'bob'), /reserved/i);
    assert.match(validateNewMappingName('SuperAdmin', 'group', 'SuperAdmin'), /reserved/i);
});
