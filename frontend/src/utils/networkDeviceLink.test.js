import test from 'node:test';
import assert from 'node:assert/strict';
import { setFeatureFlags, canOpenInNetworkDevice, parseTarget } from './networkDeviceLink.js';

test('links only for network devices and users with the Network Device feature', () => {
    setFeatureFlags({ networkDevice: true });
    assert.equal(canOpenInNetworkDevice({ id: 'dev-1', type: 'Firewall' }), true);
    assert.equal(canOpenInNetworkDevice({ id: 'dev-1', type: 'Server' }), false);
    assert.equal(canOpenInNetworkDevice({ type: 'Switch' }), false);
    assert.equal(canOpenInNetworkDevice(null), false);
    setFeatureFlags({ networkDevice: false });
    assert.equal(canOpenInNetworkDevice({ id: 'dev-1', type: 'Switch' }), false);
    setFeatureFlags(null);
    assert.equal(canOpenInNetworkDevice({ id: 'dev-1', type: 'Switch' }), true, 'unknown flags: shown (the server still checks)');
});

test('pending target: fresh only, well-formed only', () => {
    const now = 1_000_000;
    assert.deepEqual(parseTarget(JSON.stringify({ id: 'dev-1', tab: 'cap:summary', at: now - 1000 }), now), { id: 'dev-1', tab: 'cap:summary' });
    assert.deepEqual(parseTarget(JSON.stringify({ id: 'dev-1', at: now }), now), { id: 'dev-1', tab: null });
    assert.equal(parseTarget(JSON.stringify({ id: 'dev-1', at: now - 61_000 }), now), null);
    assert.equal(parseTarget(JSON.stringify({ id: '', at: now }), now), null);
    assert.equal(parseTarget('not json', now), null);
    assert.equal(parseTarget(null, now), null);
});
