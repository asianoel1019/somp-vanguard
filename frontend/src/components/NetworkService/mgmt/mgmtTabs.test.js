import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SECRET_MASK, capabilityTabs, formFromProfile, targetChanged, payloadFromForm, dataQuery,
    formatBytes, formatDuration, statusTone, describeError,
} from './mgmtTabs.js';

const fortigate = { id: 'fortigate', available: true, defaultPort: 443, auth: 'token', scope: 'vdom' };
const paloalto = { id: 'paloalto', available: false, defaultPort: 443, auth: 'apiKey', scope: 'vsys' };
const profile = { vendor: 'fortigate', mgmtHost: '192.0.2.1', port: 443, scope: 'root', enabled: true, secrets: { token: SECRET_MASK, password: '', apiKey: '' } };

test('capability tabs only for a saved, enabled connection, in fixed order', () => {
    assert.deepEqual(capabilityTabs(null), []);
    assert.deepEqual(capabilityTabs({ profile: null, capabilities: ['summary'] }), []);
    assert.deepEqual(capabilityTabs({ profile: { ...profile, enabled: false }, capabilities: ['summary'] }), []);
    assert.deepEqual(capabilityTabs({ profile, capabilities: ['ha', 'summary', 'routes'] }).map(t => t.key), ['summary', 'routes', 'ha']);
});

test('form from profile keeps the mask; new form picks the first available vendor', () => {
    const f = formFromProfile(profile, [fortigate]);
    assert.equal(f.token, SECRET_MASK);
    assert.equal(f.scope, 'root');
    const n = formFromProfile(null, [paloalto, fortigate]);
    assert.equal(n.vendor, 'fortigate');
    assert.equal(n.port, 443);
    assert.equal(n.token, '');
});

test('target change detection', () => {
    const f = formFromProfile(profile, [fortigate]);
    assert.equal(targetChanged(profile, f), false);
    assert.equal(targetChanged(profile, { ...f, mgmtHost: ' 192.0.2.1 ' }), false);
    assert.equal(targetChanged(profile, { ...f, port: '8443' }), true);
    assert.equal(targetChanged(null, f), false);
});

test('payload carries only the vendor auth fields', () => {
    const f = { ...formFromProfile(profile, [fortigate]), password: 'x', caCert: 'pem', tlsVerify: false };
    const p = payloadFromForm(f, fortigate);
    assert.equal(p.token, SECRET_MASK);
    assert.equal(p.password, undefined);
    assert.equal(p.caCert, '');
    assert.equal(p.scope, 'root');
    const q = payloadFromForm({ ...f, apiKey: 'k' }, paloalto);
    assert.equal(q.apiKey, 'k');
    assert.equal(q.token, undefined);
});

test('query string', () => {
    assert.equal(dataQuery({}), '');
    assert.equal(dataQuery({ src: ' 192.0.2.1 ', dst: '', dport: 443 }, true), '?src=192.0.2.1&dport=443&refresh=1');
});

test('formatters', () => {
    assert.equal(formatBytes(null), '-');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatDuration(42), '42s');
    assert.equal(formatDuration(3700), '1h 1m');
    assert.equal(formatDuration(90000), '1d 1h');
    assert.equal(statusTone('UP'), 'success');
    assert.equal(statusTone('deny'), 'danger');
    assert.equal(statusTone('partial'), 'warning');
    assert.equal(statusTone('x'), 'muted');
});

test('error message adds a hint by code', () => {
    const e = { response: { data: { error: 'The device rejected the credentials (401)', code: 'AUTH' } } };
    assert.match(describeError(e), /401.*token/);
    assert.equal(describeError(new Error('boom')), 'boom');
});

test('gateway target only for vendors that have one', () => {
    const checkpoint = { id: 'checkpoint', available: true, auth: 'apiKey', scope: 'domain', target: 'gateway' };
    const f = formFromProfile({ vendor: 'checkpoint', mgmtHost: '192.0.2.5', port: 443, target: 'gw-lab-01', secrets: {} }, [checkpoint]);
    assert.equal(f.target, 'gw-lab-01');
    assert.equal(payloadFromForm({ ...f, target: ' gw-2 ' }, checkpoint).target, 'gw-2');
    assert.equal(payloadFromForm({ ...f, target: 'gw-2' }, fortigate).target, '');
});

test('two selected backups are compared older -> newer', async () => {
    const { orderPair } = await import('./mgmtTabs.js');
    const list = [{ id: 'b', at: '2026-11-04T02:00:00Z' }, { id: 'a', at: '2026-11-04T01:00:00Z' }];
    assert.deepEqual(orderPair(list, ['b', 'a']), ['a', 'b']);
    assert.deepEqual(orderPair(list, ['a', 'b']), ['a', 'b']);
});
