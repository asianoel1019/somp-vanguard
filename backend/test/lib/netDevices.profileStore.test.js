// Management connection store: validation, encrypted secrets, masking, secrets dropped when the target changes.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbMod = require('../../lib/db');
const dbManager = require('../../services/db');
const store = require('../../lib/netDevices/profileStore');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => dbMod.writeDataSync(store.KEY, {}));

const TOKEN = 'fgt-token-0123456789';
const base = { vendor: 'fortigate', mgmtHost: '192.0.2.1', port: 443, token: TOKEN };

test('save stores the token encrypted and returns it masked', () => {
    const pub = store.saveProfile('d1', 'Firewall', base, 'alice');
    assert.equal(pub.secrets.token, store.MASK);
    assert.equal(pub.updatedBy, 'alice');
    const raw = dbMod.readDataSync(store.KEY, {}).d1;
    assert.ok(raw.secrets.token && !JSON.stringify(raw).includes(TOKEN));
    assert.equal(store.getProfile('d1').secrets.token, TOKEN);
    assert.equal(store.publicProfile(store.getProfile('d1')).secrets.token, store.MASK);
});

test('blank or masked token keeps the stored one for the same target', () => {
    store.saveProfile('d1', 'Firewall', base, 'a');
    store.saveProfile('d1', 'Firewall', { ...base, token: store.MASK, scope: 'root' }, 'a');
    assert.equal(store.getProfile('d1').secrets.token, TOKEN);
    assert.equal(store.getProfile('d1').scope, 'root');
    store.saveProfile('d1', 'Firewall', { ...base, token: '' }, 'a');
    assert.equal(store.getProfile('d1').secrets.token, TOKEN);
});

test('changing the address or port requires the token again', () => {
    store.saveProfile('d1', 'Firewall', base, 'a');
    assert.throws(() => store.saveProfile('d1', 'Firewall', { ...base, mgmtHost: '192.0.2.2', token: '' }, 'a'), (e) => e.code === 'BAD_REQUEST' && /again/.test(e.message));
    assert.throws(() => store.saveProfile('d1', 'Firewall', { ...base, port: 8443, token: store.MASK }, 'a'), (e) => e.code === 'BAD_REQUEST');
    store.saveProfile('d1', 'Firewall', { ...base, port: 8443, token: 'new-token-xyz' }, 'a');
    assert.equal(store.getProfile('d1').secrets.token, 'new-token-xyz');
});

test('clearSecrets drops the stored token', () => {
    store.saveProfile('d1', 'Firewall', base, 'a');
    assert.throws(() => store.saveProfile('d1', 'Firewall', { ...base, token: '', clearSecrets: true }, 'a'), (e) => e.code === 'BAD_REQUEST');
});

test('validation: vendor, device type, host, port, scope, CA', () => {
    const bad = [
        ['Firewall', { ...base, vendor: 'nope' }],
        ['Firewall', { ...base, vendor: 'f5' }], // not a firewall vendor
        ['Firewall', { ...base, target: 'gw1' }], // FortiGate has no gateway target
        ['Firewall', { vendor: 'checkpoint', mgmtHost: '192.0.2.1', apiKey: 'k-123456', target: '<gw>' }],
        ['Firewall', { vendor: 'paloalto', mgmtHost: '192.0.2.1' }], // no API key, no user + password
        ['Switch', base], // FortiGate is a firewall
        ['Firewall', { ...base, mgmtHost: 'bad host;rm' }],
        ['Firewall', { ...base, mgmtHost: '' }],
        ['Firewall', { ...base, port: 70000 }],
        ['Firewall', { ...base, scope: 'root vdom' }],
        ['Firewall', { ...base, tlsVerify: true, caCert: 'not a pem' }],
        ['Firewall', { ...base, token: '' }],
    ];
    for (const [type, input] of bad) assert.throws(() => store.buildProfile(type, input, null), (e) => e.code === 'BAD_REQUEST', JSON.stringify(input));
    const ok = store.buildProfile('Firewall', { ...base, port: '', mgmtHost: 'fw01.example.test' }, null);
    assert.equal(ok.port, 443);
    assert.equal(store.buildProfile('Firewall', { ...base, mgmtHost: '2001:db8::1' }, null).mgmtHost, '2001:db8::1');
    assert.equal(store.buildProfile('Firewall', { vendor: 'paloalto', mgmtHost: '192.0.2.1', apiKey: 'k-123456', scope: 'vsys1' }, null).secrets.apiKey, 'k-123456');
    assert.equal(store.buildProfile('Firewall', { vendor: 'paloalto', mgmtHost: '192.0.2.1', username: 'api', password: 'p-123456' }, null).username, 'api');
    const cp = store.buildProfile('Firewall', { vendor: 'checkpoint', mgmtHost: '192.0.2.1', username: 'api', password: 'p-123456', scope: 'Domain_A', target: ' gw-lab-01 ' }, null);
    assert.deepEqual([cp.scope, cp.target], ['Domain_A', 'gw-lab-01']);
});

test('recordStatus keeps facts for the list; a target change resets them', () => {
    store.saveProfile('d1', 'Firewall', base, 'a');
    store.recordStatus('d1', { ok: true, facts: { model: 'FGT60F', version: 'v7.4.3' } });
    let s = store.listSummaries().d1;
    assert.equal(s.lastStatus, 'ok');
    assert.equal(s.model, 'FGT60F');
    store.recordStatus('d1', { ok: false, error: 'boom' });
    assert.equal(store.listSummaries().d1.lastError, 'boom');
    store.saveProfile('d1', 'Firewall', { ...base, mgmtHost: '192.0.2.9', token: 'other-token-1' }, 'a');
    s = store.listSummaries().d1;
    assert.equal(s.model, null);
    assert.equal(s.lastStatus, 'unknown');
});

test('recordTransport remembers the way that works on auto; saving forgets it', () => {
    const ios = { vendor: 'cisco-ios', mgmtHost: '192.0.2.20', username: 'netro', password: 'pw-123456' };
    store.saveProfile('sw1', 'Switch', ios, 'a');
    store.recordTransport('sw1', 'ssh');
    assert.equal(store.getProfile('sw1').lastTransport, 'ssh');
    assert.equal(store.publicProfile(store.getProfile('sw1')).lastTransport, 'ssh');
    store.recordTransport('sw1', 'telnet');
    assert.equal(store.getProfile('sw1').lastTransport, 'ssh', 'unknown ways are ignored');
    store.recordTransport('sw1', null);
    assert.equal(store.getProfile('sw1').lastTransport, undefined);
    store.recordTransport('sw1', 'api');
    store.saveProfile('sw1', 'Switch', { ...ios, password: store.MASK }, 'a');
    assert.equal(store.getProfile('sw1').lastTransport, undefined, 'a saved connection decides afresh');
    store.recordTransport('nope', 'api');
    assert.equal(store.getProfile('nope'), null);
});

test('removeProfile', () => {
    store.saveProfile('d1', 'Firewall', base, 'a');
    assert.equal(store.removeProfile('d1'), true);
    assert.equal(store.getProfile('d1'), null);
    assert.equal(store.removeProfile('d1'), false);
});

test('switch vendors: connection method, SSH port, enable secret', () => {
    const ios = { vendor: 'cisco-ios', mgmtHost: '192.0.2.20', username: 'netro', password: 'pw-123456', enableSecret: 'en-123456' };
    const p = store.saveProfile('sw1', 'Switch', ios, 'a');
    assert.equal(p.transport, 'auto');
    assert.equal(p.sshPort, 22);
    assert.equal(p.secrets.enableSecret, store.MASK);
    assert.equal(store.getProfile('sw1').secrets.enableSecret, 'en-123456');
    // same target: masked secrets kept
    store.saveProfile('sw1', 'Switch', { ...ios, password: store.MASK, enableSecret: store.MASK, transport: 'ssh' }, 'a');
    assert.equal(store.getProfile('sw1').secrets.enableSecret, 'en-123456');
    assert.equal(store.getProfile('sw1').transport, 'ssh');
    // a different SSH port is a different target
    assert.throws(() => store.saveProfile('sw1', 'Switch', { ...ios, password: store.MASK, enableSecret: store.MASK, sshPort: 2222 }, 'a'), (e) => /enter the password again/.test(e.message));
    for (const bad of [{ transport: 'telnet' }, { sshPort: 0 }, { sshPort: 70000 }]) {
        assert.throws(() => store.buildProfile('Switch', { ...ios, ...bad }, null), (e) => e.code === 'BAD_REQUEST', JSON.stringify(bad));
    }
    assert.equal(store.buildProfile('Router', ios, null).vendor, 'cisco-ios');
    // vendors without transports / enable ignore those fields
    const fgt = store.buildProfile('Firewall', { ...base, transport: 'ssh', sshPort: 2222, enableSecret: 'x-123456' }, null);
    assert.equal(fgt.transport, undefined);
    assert.equal(fgt.sshPort, undefined);
    assert.equal(fgt.secrets.enableSecret, undefined);
});
