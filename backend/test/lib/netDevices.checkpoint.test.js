// Check Point driver against Management API answers: read-only login, session reuse / renewal, gateway selection,
// normalized results.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTransportForTest } = require('../../lib/netDevices/httpClient');
const cp = require('../../lib/netDevices/drivers/checkpoint');
const responses = require('../fixtures/checkpoint/responses');

const PASSWORD = 'cp-password-xyz';
const base = { vendor: 'checkpoint', mgmtHost: '192.0.2.5', port: 443, scope: '', target: 'gw-lab-01', tlsVerify: false, username: 'apiuser', secrets: { password: PASSWORD } };

let calls = [];
function serve(overrides = {}) {
    calls = [];
    setTransportForTest(async (cfg) => {
        const cmd = cfg.url.replace(/^https:\/\/[^/]+\/web_api\//, '');
        calls.push({ cmd, cfg });
        if (overrides[cmd]) return overrides[cmd](cfg);
        if (!responses[cmd]) throw Object.assign(new Error('nf'), { response: { status: 404 } });
        return { status: 200, data: responses[cmd] };
    });
}
test.afterEach(() => { setTransportForTest(null); cp._resetSessions(); });

test('read-only login once, the session id goes in a header and is reused', async () => {
    serve();
    await cp.testConnection({ ...base, scope: 'Domain_A' });
    await cp.getSummary({ ...base, scope: 'Domain_A' });
    const logins = calls.filter(c => c.cmd === 'login');
    assert.equal(logins.length, 1);
    assert.deepEqual(
        { user: logins[0].cfg.data.user, ro: logins[0].cfg.data['read-only'], domain: logins[0].cfg.data.domain },
        { user: 'apiuser', ro: true, domain: 'Domain_A' },
    );
    const other = calls.find(c => c.cmd === 'show-api-versions');
    assert.equal(other.cfg.method, 'POST');
    assert.equal(other.cfg.headers['X-chkp-sid'], 'SID-0001');
    assert.ok(!other.cfg.url.includes(PASSWORD));
});

test('API key login', async () => {
    serve();
    await cp.testConnection({ ...base, username: '', secrets: { apiKey: 'cp-api-key-123456' } });
    assert.equal(calls[0].cfg.data['api-key'], 'cp-api-key-123456');
    assert.equal(calls[0].cfg.data.user, undefined);
});

test('a refused login is AUTH and never quotes the password; an expired session is renewed once', async () => {
    serve({ login: async () => { throw Object.assign(new Error(`bad ${PASSWORD}`), { response: { status: 400 } }); } });
    await assert.rejects(cp.testConnection(base), (e) => e.code === 'AUTH' && e.status === 502 && !e.message.includes(PASSWORD));

    let first = true;
    serve({ 'show-api-versions': async () => {
        if (first) { first = false; throw Object.assign(new Error('x'), { response: { status: 401 } }); }
        return { status: 200, data: responses['show-api-versions'] };
    } });
    await cp.testConnection(base);
    assert.equal(calls.filter(c => c.cmd === 'login').length, 2);
});

test('gateway selection: by name or IP; several gateways and no name is a clear error', async () => {
    serve();
    assert.equal((await cp.getSummary(base)).hostname, 'gw-lab-01');
    assert.equal((await cp.getSummary({ ...base, target: '192.0.2.20' })).hostname, 'cl-lab');
    await assert.rejects(cp.getSummary({ ...base, target: '' }), (e) => e.code === 'BAD_REQUEST' && /2 gateways.*gw-lab-01, cl-lab/.test(e.message));
    await assert.rejects(cp.getSummary({ ...base, target: 'nope' }), (e) => e.code === 'BAD_REQUEST');
    // the login test still succeeds without a gateway name and says why
    const facts = await cp.testConnection({ ...base, target: '' });
    assert.match(facts.note, /set the gateway name/);
});

test('summary', async () => {
    serve();
    const s = await cp.getSummary(base);
    assert.equal(s.version, 'R81.20');
    assert.equal(s.policy, 'Standard');
    assert.equal(s.policyInstalled, true);
    assert.equal(s.managementApi, '1.9');
    assert.equal(s.haMode, 'standalone');
    assert.deepEqual(s.gateways.map(g => g.name), ['gw-lab-01', 'cl-lab']);
});

test('interfaces from the gateway object', async () => {
    serve();
    const list = await cp.getInterfaces(base);
    assert.deepEqual(list.map(i => [i.name, i.ip, i.zone]), [['eth1', '203.0.113.2/29', 'external'], ['eth2', '192.0.2.1/24', 'internal']]);
    assert.equal(list[1].alias, 'LAN');
});

test('policies: installed package, first layer, sections flattened, names resolved, hits', async () => {
    serve();
    const r = await cp.getPolicies(base, {});
    const req = calls.find(c => c.cmd === 'show-access-rulebase').cfg.data;
    assert.equal(req.uid, 'layer-uid');
    assert.equal(req['show-hits'], true);
    assert.equal(r.layer, 'Network');
    assert.equal(r.total, 3);
    assert.deepEqual(r.items[0].service, ['https', 'http']);
    assert.equal(r.items[0].action, 'accept');
    assert.equal(r.items[0].section, 'Outbound');
    assert.equal(r.items[0].hitCount, 5120);
    assert.equal(r.items[0].lastHit, '2026-11-03T10:00:00.000Z');
    assert.deepEqual(r.items[1].destination, ['NOT LAN_192.0.2.0']);
    assert.equal(r.items[1].enabled, false);
    assert.equal(r.items[2].section, null);
    assert.deepEqual((await cp.getPolicies(base, { search: 'telnet' })).items.map(p => p.id), [2]);
});

test('ha: cluster members from the configuration (no live role)', async () => {
    serve();
    const ha = await cp.getHa({ ...base, target: 'cl-lab' });
    assert.equal(ha.mode, 'cluster-xl-ha');
    assert.deepEqual(ha.members.map(m => [m.hostname, m.mgmtIp, m.primary]), [['cl-member-a', '192.0.2.21', null], ['cl-member-b', '192.0.2.22', null]]);
    assert.equal((await cp.getHa(base)).mode, 'standalone');
});

test('routes, sessions and VPN are not offered', () => {
    assert.deepEqual(cp.capabilities, ['summary', 'interfaces', 'policies', 'ha']);
    assert.equal(cp.getRoutes, undefined);
});

test('config backup: gateway + installed package + layers as stable JSON without volatile fields', async () => {
    const withMeta = { ...responses['show-access-rulebase'], rulebase: responses['show-access-rulebase'].rulebase.map(r => ({ ...r, 'meta-info': { 'last-modify-time': { posix: Date.now() } } })) };
    serve({ 'show-access-rulebase': async () => ({ status: 200, data: withMeta }) });
    const a = await cp.backupConfig(base);
    assert.equal(a.format, 'json');
    const doc = JSON.parse(a.content);
    assert.equal(doc.gateway.name, 'gw-lab-01');
    assert.equal(doc.package.name, 'Standard');
    assert.equal(doc.accessLayers[0].name, 'Network');
    assert.ok(!a.content.includes('meta-info') && !a.content.includes('"hits"'));
    const req = calls.find(c => c.cmd === 'show-access-rulebase').cfg.data;
    assert.equal(req['show-hits'], undefined);
    const b = await cp.backupConfig(base);
    assert.equal(a.content, b.content, 'two backups of the same policy are identical');
});
