import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvs, resolveEnv, defaultEnv, envDisplayName, isProductionRef, validateEnvValue, unknownPromEnvValues, applyEnvValidation, UNASSIGNED } from './environments.js';

test('applyEnvValidation (Excel import): canonical name + id, unknown rows flagged (never defaulted), empty kept', () => {
    const envs = normalizeEnvs([{ id: '1', name: 'Others' }, { id: 't', name: 'TRUST' }]);
    const out = applyEnvValidation([{ IP: 'a', Env: 'trust' }, { IP: 'b', Env: 'Mars' }, { IP: 'c', Env: '' }], envs);
    assert.deepEqual([out[0].Env, out[0].envId], ['TRUST', 't']);
    assert.match(out[1].envError, /Unknown environment "Mars"/);
    assert.equal(out[1].Env, 'Mars');
    assert.equal(out[2].envError, undefined);
    assert.equal(out[2].envId, undefined);
});

const ENVS = normalizeEnvs([
    { id: '1', name: 'Others' },
    { id: 'p', name: 'Production', code: 'prd' },
    { id: 't', name: 'TRUST', isProduction: true }
]);

test('normalizeEnvs: one default (Others unless chosen), isProduction derived when missing', () => {
    assert.deepEqual(ENVS.map(e => e.isDefault), [true, false, false]);
    assert.deepEqual(ENVS.map(e => e.isProduction), [false, true, true]);
    const b = normalizeEnvs([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', isDefault: true }]);
    assert.equal(defaultEnv(b).id, 'b');
    assert.deepEqual(normalizeEnvs(null), []);
});

test('resolveEnv: id, name, code case-insensitively', () => {
    assert.equal(resolveEnv('p', ENVS).name, 'Production');
    assert.equal(resolveEnv(' production ', ENVS).id, 'p');
    assert.equal(resolveEnv('PRD', ENVS).id, 'p');
    assert.equal(resolveEnv('trust', ENVS).id, 't');
    assert.equal(resolveEnv('nope', ENVS), null);
    assert.equal(resolveEnv('', ENVS), null);
});

test('envDisplayName derives from the id, Unassigned when unknown (never a silent Production)', () => {
    assert.equal(envDisplayName('p', 'Old name', ENVS), 'Production');
    assert.equal(envDisplayName(null, 'trust', ENVS), 'TRUST');
    assert.equal(envDisplayName(null, 'Mars', ENVS), UNASSIGNED);
    assert.equal(envDisplayName(undefined, undefined, ENVS), UNASSIGNED);
});

test('isProductionRef follows the isProduction flag', () => {
    assert.equal(isProductionRef('t', ENVS), true);
    assert.equal(isProductionRef('1', ENVS), false);
    assert.equal(isProductionRef(null, ENVS, 'production'), true);
    assert.equal(isProductionRef('PRD-unknown', ENVS), false);
});

test('validateEnvValue: empty / unknown (lists allowed) / canonical', () => {
    assert.equal(validateEnvValue('  ', ENVS).empty, true);
    assert.match(validateEnvValue('Mars', ENVS).error, /Unknown environment "Mars". Allowed: Others, Production, TRUST/);
    assert.equal(validateEnvValue('prd', ENVS).env.name, 'Production');
});

test('unknownPromEnvValues flags label values that are not environment names', () => {
    assert.deepEqual(unknownPromEnvValues({ zone: 'Mars', env: 'trust' }, ENVS), [{ label: 'zone', value: 'Mars' }]);
    assert.deepEqual(unknownPromEnvValues({ zone: '-' }, ENVS), []);
    assert.deepEqual(unknownPromEnvValues({ zone: 'p' }, ENVS), [{ label: 'zone', value: 'p' }]); // an id is not a name
});
