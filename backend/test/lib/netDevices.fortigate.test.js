// FortiGate driver against recorded FortiOS answers: request shape (token, VDOM) and normalized results.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTransportForTest } = require('../../lib/netDevices/httpClient');
const fgt = require('../../lib/netDevices/drivers/fortigate');
const responses = require('../fixtures/fortigate/responses.json');

const TOKEN = 'fgt-token-0123456789';
const profile = { vendor: 'fortigate', mgmtHost: '192.0.2.254', port: 443, scope: 'root', tlsVerify: false, secrets: { token: TOKEN } };

let calls = [];
function serve(overrides = {}) {
    calls = [];
    setTransportForTest(async (cfg) => {
        const path = cfg.url.replace(/^https:\/\/[^/]+\/api\/v2\//, '');
        calls.push({ path, cfg });
        if (overrides[path]) return overrides[path](cfg);
        if (!responses[path]) throw Object.assign(new Error('nf'), { response: { status: 404 } });
        return { status: 200, data: responses[path] };
    });
}
test.afterEach(() => setTransportForTest(null));

test('requests carry the token and the VDOM', async () => {
    serve();
    await fgt.testConnection(profile);
    assert.equal(calls[0].cfg.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].cfg.params.vdom, 'root');
    assert.equal(calls[0].cfg.url, 'https://192.0.2.254:443/api/v2/monitor/system/status');
});

test('summary', async () => {
    serve();
    const s = await fgt.getSummary(profile);
    assert.equal(s.model, 'FortiGate 60F');
    assert.equal(s.hostname, 'fw-lab-01');
    assert.equal(s.version, 'v7.4.3');
    assert.equal(s.serial, 'FGT60FTK00000000');
    assert.deepEqual([s.cpu, s.memory, s.disk, s.sessions], [7, 41, 12, 1834]);
    assert.equal(s.haMode, 'a-p');
});

test('summary survives a missing resource permission', async () => {
    serve({ 'monitor/system/resource/usage': async () => { throw Object.assign(new Error('x'), { response: { status: 403 } }); } });
    const s = await fgt.getSummary(profile);
    assert.equal(s.cpu, null);
    assert.equal(s.model, 'FortiGate 60F');
});

test('interfaces merge monitor, config and zones', async () => {
    serve();
    const list = await fgt.getInterfaces(profile);
    const by = Object.fromEntries(list.map(i => [i.name, i]));
    assert.equal(by.wan1.ip, '203.0.113.2/29');
    assert.equal(by.wan1.status, 'up');
    assert.equal(by.internal.zone, 'LAN');
    assert.equal(by.vlan10.ip, '198.51.100.1/24'); // monitor has no address: taken from the config
    assert.equal(by.vlan10.status, 'down');
    assert.equal(by.vlan10.vlan, 10);
});

test('policies: hit counts, search and paging', async () => {
    serve();
    let r = await fgt.getPolicies(profile, {});
    assert.equal(r.total, 2);
    assert.equal(r.items[0].hitCount, 5120);
    assert.equal(r.items[0].lastHit, new Date(1762200000 * 1000).toISOString());
    assert.equal(r.items[1].enabled, false);
    assert.deepEqual(r.items[1].service, ['TELNET']);
    r = await fgt.getPolicies(profile, { search: 'srv-web' });
    assert.deepEqual(r.items.map(p => p.id), [7]);
    r = await fgt.getPolicies(profile, { page: 2, limit: 1 });
    assert.deepEqual(r.items.map(p => p.id), [7]);
    r = await fgt.getPolicies(profile, { limit: 9999 });
    assert.equal(r.limit, 200);
});

test('routes', async () => {
    serve();
    const r = await fgt.getRoutes(profile);
    assert.deepEqual(r.map(x => [x.destination, x.gateway, x.interface, x.type]), [
        ['0.0.0.0/0', '203.0.113.1', 'wan1', 'static'],
        ['192.0.2.0/24', null, 'internal', 'connect'],
    ]);
});

test('sessions need a filter, validate it, and pass it on', async () => {
    serve();
    await assert.rejects(fgt.getSessions(profile, {}), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(fgt.getSessions(profile, { src: 'not-an-ip' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(fgt.getSessions(profile, { dport: 0 }), (e) => e.code === 'BAD_REQUEST');
    const r = await fgt.getSessions(profile, { src: '192.0.2.10', dport: '443' });
    assert.equal(calls[0].cfg.params.srcaddr, '192.0.2.10');
    assert.equal(calls[0].cfg.params.dport, 443);
    assert.equal(calls[0].cfg.params.count, 500);
    assert.equal(r.total, 2);
    assert.equal(r.truncated, true);
    assert.equal(r.items[0].bytes, 1000);
});

test('vpn and ha', async () => {
    serve();
    const v = await fgt.getVpn(profile);
    assert.equal(v.tunnels[0].status, 'partial');
    assert.equal(v.tunnels[0].peer, '198.51.100.200');
    assert.equal(v.users[0].user, 'remote-user');
    const ha = await fgt.getHa(profile);
    assert.equal(ha.mode, 'a-p');
    assert.equal(ha.members.length, 2);
    assert.equal(ha.members[0].primary, true);
});

test('a 401 is AUTH (502) and the error never quotes the token', async () => {
    serve({ 'monitor/system/status': async () => { throw Object.assign(new Error(`bad Bearer ${TOKEN}`), { response: { status: 401 } }); } });
    await assert.rejects(fgt.testConnection(profile), (e) => e.code === 'AUTH' && e.status === 502 && !e.message.includes(TOKEN));
});

test('cidr helper', () => {
    assert.equal(fgt._cidr('192.0.2.1 255.255.255.0'), '192.0.2.1/24');
    assert.equal(fgt._cidr('192.0.2.1', 30), '192.0.2.1/30');
    assert.equal(fgt._cidr('0.0.0.0 0.0.0.0'), null);
});

test('config backup: GET, falling back to POST on FortiOS 7.6; an error answer is refused', async () => {
    const conf = '#config-version=FGT60F-7.4.3-FW-build2573:opmode=0:vdom=0\nconfig system global\nend\n';
    serve({ 'monitor/system/config/backup': async (cfg) => ({ status: 200, data: conf }) });
    let r = await fgt.backupConfig({ ...profile, scope: '' });
    assert.equal(r.content, conf);
    assert.equal(r.format, 'conf');
    assert.deepEqual(calls[0].cfg.params, { scope: 'global' });
    assert.equal(calls[0].cfg.responseType, 'text');

    serve({ 'monitor/system/config/backup': async (cfg) => {
        if (cfg.method === 'GET') throw Object.assign(new Error('x'), { response: { status: 405 } });
        return { status: 200, data: conf };
    } });
    r = await fgt.backupConfig(profile);
    assert.equal(calls[1].cfg.method, 'POST');
    assert.deepEqual(calls[1].cfg.data, { destination: 'file', scope: 'vdom', vdom: 'root' });

    serve({ 'monitor/system/config/backup': async () => ({ status: 200, data: { status: 'error', http_status: 403 } }) });
    await assert.rejects(fgt.backupConfig(profile), (e) => e.code === 'OTHER');
});
