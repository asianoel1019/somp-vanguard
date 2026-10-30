require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeDataSync } = require('../../lib/db');
const reg = require('../../lib/environmentRegistry');

const ENVS = [
    { id: '1', name: 'Others', purpose: '' },
    { id: 'p-1', name: 'Production', code: 'prd' },
    { id: 'u-2', name: 'TRUST' }
];

test('normalizeEnvList: exactly one isDefault (Others unless chosen), isProduction derived when missing', () => {
    const a = reg.normalizeEnvList(ENVS);
    assert.deepEqual(a.map(e => e.isDefault), [true, false, false]);
    assert.deepEqual(a.map(e => e.isProduction), [false, true, false]);
    const b = reg.normalizeEnvList([{ ...ENVS[0] }, { ...ENVS[1], isProduction: false }, { ...ENVS[2], isDefault: true, isProduction: true }]);
    assert.deepEqual(b.map(e => e.isDefault), [false, false, true]);
    assert.deepEqual(b.map(e => e.isProduction), [false, false, true]);
    const c = reg.normalizeEnvList([{ id: 'x', name: 'X', isDefault: true }, { id: 'y', name: 'Y', isDefault: true }]);
    assert.deepEqual(c.map(e => e.isDefault), [true, false]);
    const d = reg.normalizeEnvList([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]);
    assert.deepEqual(d.map(e => e.isDefault), [true, false]); // no Others: first entry
    assert.deepEqual(reg.normalizeEnvList(null), []);
});

test('resolveEnv matches id, name and code case-insensitively; unknown/empty -> null', () => {
    const envs = reg.normalizeEnvList(ENVS);
    assert.equal(reg.resolveEnv('p-1', envs).id, 'p-1');
    assert.equal(reg.resolveEnv('P-1', envs).id, 'p-1');
    assert.equal(reg.resolveEnv(' production ', envs).id, 'p-1');
    assert.equal(reg.resolveEnv('PRD', envs).id, 'p-1');
    assert.equal(reg.resolveEnv('trust', envs).id, 'u-2');
    assert.equal(reg.resolveEnv('nope', envs), null);
    assert.equal(reg.resolveEnv('', envs), null);
    assert.equal(reg.resolveEnv(null, envs), null);
});

test('resolveRecordEnv: valid envId wins, then name-like envId, then name', () => {
    const envs = reg.normalizeEnvList(ENVS);
    assert.equal(reg.resolveRecordEnv('u-2', 'Production', envs).id, 'u-2');
    assert.equal(reg.resolveRecordEnv('production', '', envs).id, 'p-1');
    assert.equal(reg.resolveRecordEnv('', 'trust', envs).id, 'u-2');
    assert.equal(reg.resolveRecordEnv('gone', 'gone', envs), null);
});

test('displayFor derives the name from the id; unknown -> Unassigned', () => {
    const envs = reg.normalizeEnvList(ENVS);
    assert.deepEqual(reg.displayFor('p-1', envs), { envId: 'p-1', envName: 'Production', isProduction: true, assigned: true });
    assert.equal(reg.displayFor('Production', envs).envName, 'Unassigned'); // names are not ids
    assert.equal(reg.displayFor(null, envs).envName, reg.UNASSIGNED);
});

test('validateEnvInput: empty, unknown with allowed names, canonical match', () => {
    const envs = reg.normalizeEnvList(ENVS);
    assert.equal(reg.validateEnvInput('', envs).empty, true);
    const bad = reg.validateEnvInput('Staging', envs);
    assert.match(bad.error, /Unknown environment "Staging".*Others, Production, TRUST/);
    assert.equal(reg.validateEnvInput('trust', envs).env.name, 'TRUST');
});

test('getEnvironments / getDefaultEnv read the global list', () => {
    writeDataSync(reg.ENV_KEY, ENVS);
    assert.equal(reg.getEnvironments().length, 3);
    assert.equal(reg.getDefaultEnv().name, 'Others');
    assert.equal(reg.canonicalName('production'), 'Production');
    assert.equal(reg.canonicalName('x'), null);
});
