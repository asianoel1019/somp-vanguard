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

test('switch tabs, transport fields, interface filters', async () => {
    const m = await import('./mgmtTabs.js');
    const ios = { id: 'cisco-ios', available: true, auth: 'password', transports: ['api', 'ssh'], enable: true, defaultPort: 443 };
    const profile = { vendor: 'cisco-ios', mgmtHost: '192.0.2.30', port: 443, sshPort: 22, transport: 'ssh', username: 'netro', enabled: true, secrets: { password: m.SECRET_MASK, enableSecret: m.SECRET_MASK } };
    const caps = ['summary', 'interfaces', 'vlans', 'mac'];
    assert.deepEqual(m.capabilityTabs({ profile, capabilities: caps, device: { type: 'Switch' } }).map(t => t.key), caps);
    assert.deepEqual(m.capabilityTabs({ profile, capabilities: caps, device: { type: 'Router' } }).map(t => t.key), ['summary', 'interfaces']);
    const f = m.formFromProfile(profile, [ios]);
    assert.deepEqual([f.transport, f.sshPort, f.enableSecret], ['ssh', 22, m.SECRET_MASK]);
    const body = m.payloadFromForm({ ...f, sshPort: '2222' }, ios);
    assert.deepEqual([body.transport, body.sshPort, body.enableSecret, body.username], ['ssh', 2222, m.SECRET_MASK, 'netro']);
    assert.equal(m.targetChanged(profile, { ...f, sshPort: 2222 }), true);
    assert.equal(m.targetChanged(profile, f), false);
    const fw = m.payloadFromForm(m.formFromProfile(null, [{ id: 'fortigate', available: true, auth: 'token' }]), { id: 'fortigate', auth: 'token' });
    assert.equal(fw.transport, undefined);
    assert.equal(fw.enableSecret, undefined);

    const list = [{ name: 'a', status: 'up', crcErrors: 0 }, { name: 'b', status: 'up', crcErrors: 3 }, { name: 'c', status: 'err-disabled', inErrors: 0 }];
    assert.deepEqual(m.filterInterfaces(list, { errorsOnly: true }).map(i => i.name), ['b']);
    assert.deepEqual(m.filterInterfaces(list, { downOnly: true }).map(i => i.name), ['c']);
    assert.equal(m.formatBps(34000), '34.0 kb/s');
    assert.equal(m.formatBps(999), '999 b/s');
    assert.equal(m.statusTone('err-disabled'), 'danger');
    assert.match(m.describeError({ response: { data: { error: 'x', code: 'HOSTKEY' } } }), /重設主機金鑰/);
});

test('API names and connection hints per switch vendor', async () => {
    const m = await import('./mgmtTabs.js');
    assert.equal(m.apiName('cisco-ios'), 'RESTCONF');
    assert.equal(m.apiName('cisco-nxos'), 'NX-API');
    assert.equal(m.apiName('juniper'), 'REST API');
    assert.equal(m.apiName('other'), 'API');
    assert.match(m.transportHint('juniper'), /3443.*display json/);
    assert.match(m.transportHint('cisco-nxos'), /feature nxapi/);
    assert.match(m.transportHint('other'), /不會改試/);
});
