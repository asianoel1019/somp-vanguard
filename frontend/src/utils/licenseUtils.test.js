import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PAID_FEATURE_INFO, readStoredLicense, storeLicense, isLockedFlag, isFree, licenseLabel, isLicenseError,
} from './licenseUtils.js';

const memoryStorage = (init = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('PAID_FEATURE_INFO covers the paid feature keys', () => {
    assert.deepEqual(Object.keys(PAID_FEATURE_INFO).sort(), ['adControl', 'aiAgent', 'dataCenter', 'install', 'ipam', 'manage_self_healing', 'monitorAgents', 'monitorAlerts', 'monitorLinuxLog', 'monitorScout', 'monitorWinEvent', 'netSearch', 'networkDevice', 'nutanixClone', 'remoteCmd', 'scheduler', 'workflow']);
    for (const v of Object.values(PAID_FEATURE_INFO)) assert.ok(v.name && v.desc);
});

test('read / store the license kept with the signed-in user', () => {
    const s = memoryStorage({ user: JSON.stringify({ username: 'admin', license: { edition: 'free', locked: ['ipam'] } }) });
    assert.deepEqual(readStoredLicense(s), { edition: 'free', locked: ['ipam'] });
    storeLicense({ edition: 'paid', customer: 'Example Test Co.', locked: [] }, s);
    assert.equal(JSON.parse(s.getItem('user')).username, 'admin');
    assert.equal(readStoredLicense(s).edition, 'paid');
    assert.equal(readStoredLicense(memoryStorage()), null);
    assert.equal(readStoredLicense(memoryStorage({ user: 'not json' })), null);
});

test('locks, labels and errors', () => {
    const free = { edition: 'free', locked: ['ipam', 'dataCenter'] };
    assert.equal(isLockedFlag('ipam', free), true);
    assert.equal(isLockedFlag('serverList', free), false);
    assert.equal(isLockedFlag('ipam', null), false); // unknown -> no lock shown (the API still enforces)
    assert.equal(isFree(free), true);
    assert.equal(isFree(null), false);
    assert.equal(licenseLabel(free), 'Free');
    assert.equal(licenseLabel({ edition: 'paid', customer: 'Example Test Co.' }), 'Licensed to Example Test Co.');
    assert.equal(licenseLabel(null), '');
    assert.equal(isLicenseError({ response: { data: { code: 'LICENSE_REQUIRED' } } }), true);
    assert.equal(isLicenseError(new Error('x')), false);
});
