// Palo Alto driver against PAN-OS XML answers: key handling (header, keygen by POST), vsys, normalized results.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTransportForTest } = require('../../lib/netDevices/httpClient');
const pan = require('../../lib/netDevices/drivers/paloalto');
const responses = require('../fixtures/paloalto/responses');

const KEY = 'pan-api-key-0123456789';
const PASSWORD = 'pan-password-xyz';
const keyProfile = { vendor: 'paloalto', mgmtHost: '192.0.2.250', port: 443, scope: '', tlsVerify: false, secrets: { apiKey: KEY } };
const pwProfile = { ...keyProfile, username: 'apiuser', secrets: { password: PASSWORD } };

let calls = [];
function serve(overrides = {}) {
    calls = [];
    setTransportForTest(async (cfg) => {
        const body = new URLSearchParams(cfg.data || '');
        const what = body.get('type') === 'keygen' ? 'keygen' : (body.get('cmd') || body.get('xpath') || '');
        calls.push({ cfg, body, what });
        for (const [k, fn] of Object.entries(overrides)) if (what.includes(k)) return fn(cfg, body);
        const hit = Object.keys(responses).find(k => what.includes(k));
        if (!hit) return { status: 200, data: '<response status="error" code="17"><msg><line>unknown command</line></msg></response>' };
        return { status: 200, data: responses[hit] };
    });
}
test.afterEach(() => { setTransportForTest(null); pan._resetKeys(); });

test('the API key goes in a header, the command in a POST body, never in the URL', async () => {
    serve();
    const facts = await pan.testConnection({ ...keyProfile, scope: 'vsys2' });
    const c = calls[0];
    assert.equal(c.cfg.method, 'POST');
    assert.equal(c.cfg.url, 'https://192.0.2.250:443/api/');
    assert.equal(c.cfg.headers['X-PAN-KEY'], KEY);
    assert.ok(!c.cfg.url.includes(KEY) && !String(c.cfg.data).includes(KEY));
    assert.equal(c.body.get('type'), 'op');
    assert.equal(c.body.get('vsys'), 'vsys2');
    assert.deepEqual(facts, { model: 'PA-440', hostname: 'pa-lab-01', version: '11.1.2', serial: '0123456789AB' });
});

test('user and password: one keygen (POST), the key is reused and renewed once when rejected', async () => {
    serve();
    await pan.testConnection(pwProfile);
    await pan.testConnection(pwProfile);
    const keygens = calls.filter(c => c.what === 'keygen');
    assert.equal(keygens.length, 1);
    assert.equal(keygens[0].body.get('password'), PASSWORD);
    assert.ok(!keygens[0].cfg.url.includes(PASSWORD));
    assert.equal(calls[1].cfg.headers['X-PAN-KEY'], 'GENERATED-KEY-abcdef');

    let rejected = 0;
    serve({ '<show><system><info>': async () => {
        rejected += 1;
        if (rejected === 1) throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
        return { status: 200, data: responses['<show><system><info>'] };
    } });
    await pan.testConnection(pwProfile);
    assert.equal(calls.filter(c => c.what === 'keygen').length, 1, 'renewed after the 403');
    assert.equal(rejected, 2);
});

test('a rejected key is AUTH (502) and never quoted', async () => {
    serve({ '<show><system><info>': async () => { throw Object.assign(new Error(`bad key ${KEY}`), { response: { status: 403 } }); } });
    await assert.rejects(pan.testConnection(keyProfile), (e) => e.code === 'AUTH' && e.status === 502 && !e.message.includes(KEY));
    serve({ '<show><system><info>': async () => ({ status: 200, data: '<response status="error" code="403"><result><msg>Invalid Credential</msg></result></response>' }) });
    await assert.rejects(pan.testConnection(keyProfile), (e) => e.code === 'AUTH');
});

test('device errors and non-XML answers are classified', () => {
    assert.throws(() => pan._parseResponse('<response status="error" code="17"><msg><line>unknown command</line></msg></response>'), (e) => e.code === 'UNSUPPORTED');
    assert.throws(() => pan._parseResponse('<response status="error" code="13"><msg><line>boom</line></msg></response>'), (e) => e.code === 'OTHER' && /boom/.test(e.message));
    assert.throws(() => pan._parseResponse('<html>login</html>'), (e) => e.code === 'OTHER');
});

test('summary', async () => {
    serve();
    const s = await pan.getSummary(keyProfile);
    assert.equal(s.model, 'PA-440');
    assert.equal(s.vsys, 'vsys1');
    assert.equal(s.cpu, 5);
    assert.equal(s.memory, 40);
    assert.equal(s.sessions, 1834);
    assert.equal(s.haMode, 'Active-Passive');
});

test('interfaces: logical + hardware, sub-interfaces take the parent link', async () => {
    serve();
    const by = Object.fromEntries((await pan.getInterfaces(keyProfile)).map(i => [i.name, i]));
    assert.equal(by['ethernet1/1'].ip, '203.0.113.2/29');
    assert.equal(by['ethernet1/1'].zone, 'untrust');
    assert.equal(by['ethernet1/2.10'].status, 'up');
    assert.equal(by['ethernet1/2.10'].vlan, 10);
    assert.equal(by['ethernet1/3'].ip, null);
    assert.equal(by['ethernet1/3'].status, 'down');
    assert.equal(by['ethernet1/2'].status, 'up');
});

test('policies: running rulebase of the vsys, hit counts, search, paging', async () => {
    serve();
    let r = await pan.getPolicies(keyProfile, {});
    const conf = calls.find(c => c.body.get('type') === 'config');
    assert.equal(conf.body.get('action'), 'show');
    assert.match(conf.body.get('xpath'), /vsys\/entry\[@name='vsys1'\]\/rulebase\/security\/rules$/);
    assert.equal(r.total, 2);
    assert.equal(r.items[0].name, 'Allow-Web');
    assert.deepEqual(r.items[0].application, ['web-browsing', 'ssl']);
    assert.equal(r.items[0].comment, 'outbound & web');
    assert.equal(r.items[0].hitCount, 5120);
    assert.equal(r.items[1].enabled, false);
    assert.equal(r.items[1].hitCount, null);
    r = await pan.getPolicies(keyProfile, { search: 'telnet' });
    assert.deepEqual(r.items.map(p => p.name), ['Deny-Telnet']);
    r = await pan.getPolicies(keyProfile, { page: 2, limit: 1 });
    assert.deepEqual(r.items.map(p => p.id), [2]);
});

test('vsys names are escaped in the xpath', async () => {
    serve();
    await pan.getPolicies({ ...keyProfile, scope: "v'1" }, {});
    assert.ok(calls.some(c => (c.body.get('xpath') || '').includes("v&apos;1")));
});

test('routes', async () => {
    serve();
    const r = await pan.getRoutes(keyProfile);
    assert.deepEqual(r.map(x => [x.destination, x.gateway, x.interface, x.type, x.metric]), [
        ['0.0.0.0/0', '203.0.113.1', 'ethernet1/1', 'static', 10],
        ['192.0.2.0/24', null, 'ethernet1/2.10', 'connect', 0],
    ]);
});

test('sessions need a valid filter, which goes into the command', async () => {
    serve();
    await assert.rejects(pan.getSessions(keyProfile, {}), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(pan.getSessions(keyProfile, { dst: '<x/>' }), (e) => e.code === 'BAD_REQUEST');
    const r = await pan.getSessions(keyProfile, { src: '192.0.2.10', dport: 443 });
    assert.match(calls[0].body.get('cmd'), /<filter><source>192\.0\.2\.10<\/source><destination-port>443<\/destination-port><\/filter>/);
    assert.equal(r.items[0].protocol, 'tcp');
    assert.equal(r.items[0].policyId, 'Allow-Web');
    assert.equal(r.items[0].destinationPort, 443);
});

test('vpn and ha', async () => {
    serve();
    const v = await pan.getVpn(keyProfile);
    assert.deepEqual(v.tunnels.map(t => [t.name, t.status]), [['to-branch', 'up'], ['to-dr', 'down']]);
    assert.equal(v.users[0].user, 'corp\\remote-user');
    assert.equal(v.users[0].tunnelIp, '192.0.2.200');
    const ha = await pan.getHa(keyProfile);
    assert.equal(ha.mode, 'Active-Passive');
    assert.deepEqual(ha.members.map(m => [m.state, m.primary]), [['active', true], ['passive', false]]);
});

test('resources text parsing', () => {
    assert.deepEqual(pan._parseResources('%Cpu(s):  10.0 us, 85.5 id\nMiB Mem :  1000.0 total,  500.0 free,  250.0 used'), { cpu: 14.5, memory: 25 });
    assert.deepEqual(pan._parseResources(null), { cpu: null, memory: null });
});

test('config backup: export of the running configuration; error answers are classified', async () => {
    serve({ '': async (cfg, body) => {
        if (body.get('type') === 'export') return { status: 200, data: '<config version="11.1.0"><devices/></config>' };
        return { status: 200, data: responses['<show><system><info>'] };
    } });
    const r = await pan.backupConfig(keyProfile);
    assert.equal(r.format, 'xml');
    assert.match(r.content, /^<config version/);
    const c = calls.find(x => x.body.get('type') === 'export');
    assert.equal(c.body.get('category'), 'configuration');
    assert.equal(c.cfg.headers['X-PAN-KEY'], KEY);

    serve({ '': async () => ({ status: 200, data: '<response status="error" code="403"><result><msg>Invalid Credential</msg></result></response>' }) });
    await assert.rejects(pan.backupConfig(keyProfile), (e) => e.code === 'AUTH');
});
