require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const realSnmp = require('net-snmp');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const SA = tok('SuperAdmin'), OP = tok('Operator'), VIEWER = tok('Viewer');

const SNMP_FILE = 'network_service/snmp_settings.json';
const MASK = '●●●●●●';

let app;
let rackStore;
let ndRouter;
let crypto;
const ipamActions = [];
const audits = [];
// Every SNMP session the route tries to open (no packet is ever sent)
const sessions = [];

function fakeSnmp() {
    const make = (kind) => (target, authOrCommunity, options) => {
        const s = {
            kind, target, authOrCommunity, options, closed: false,
            subtree(oid, feed, done) {
                if (oid === '1.3.6.1.2.1.2.2.1.8') feed([{ oid: `${oid}.1`, value: 1 }, { oid: `${oid}.2`, value: 2 }]);
                done();
            },
            close() { this.closed = true; },
        };
        sessions.push(s);
        return s;
    };
    return { ...realSnmp, isVarbindError: () => false, createSession: make('v1/v2c'), createV3Session: make('v3') };
}

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { networkDevice: true, dataCenter: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { networkDevice: true, dataCenter: true } },
        },
    });
    // stubs must be in place before the routes destructure auditLog
    require('../../lib/ipamSync').batchSyncIpsToIpam = (actions) => { ipamActions.push(...actions); };
    require('../../lib/ipamSync').syncIpToIpam = (ip, hostname, username, action) => { ipamActions.push({ ip, hostname, username, action }); };
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    rackStore = require('../../lib/rackStore');
    crypto = require('../../lib/crypto');
    ndRouter = require('../../routes/networkDevice');
    ndRouter._testHooks.snmp = fakeSnmp();
    app = express();
    app.use(express.json());
    app.use('/api/network-device', ndRouter);
    seed();
});
test.after(async () => { await dbManager.closeDB(); });

function call(method, url, token, body) {
    let r = request(app)[method](`/api/network-device${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
}

const rack = (id, devices = [], extra = {}) => ({ id, name: id, height: 42, devices, ...extra });
const dev = (id, startU, extra = {}) => ({ id, type: 'Switch', hostname: id, startU, sizeU: 1, ...extra });

function addDc(id, name) {
    const dcs = readDataSync('data_center/datacenters.json', []);
    if (!dcs.some(d => d.id === id)) writeDataSync('data_center/datacenters.json', [...dcs, { id, name }]);
}

// Stored (encrypted) SNMP settings for one device, as the route saves them
function storeSnmp(id, settings) {
    const all = readDataSync(SNMP_FILE, {}) || {};
    const copy = { ...settings };
    ['community', 'v3AuthPass', 'v3PrivPass'].forEach(k => { if (copy[k]) copy[k] = crypto.encryptText(copy[k]); });
    all[id] = copy;
    writeDataSync(SNMP_FILE, all);
}

function storedSnmp(id) {
    const s = (readDataSync(SNMP_FILE, {}) || {})[id];
    if (!s) return s;
    const out = { ...s };
    ['community', 'v3AuthPass', 'v3PrivPass'].forEach(k => { if (out[k]) out[k] = crypto.decryptText(out[k]); });
    return out;
}

function findDevice(dcId, id) {
    for (const r of rackStore.getRacks(dcId)) {
        const d = (r.devices || []).find(x => x.id === id);
        if (d) return { rack: r, device: d };
    }
    return null;
}

function seed() {
    addDc('dc-nd', 'ND DC');
    rackStore.saveRacks('default', [rack('def-r1', [
        dev('poll-sw', 1, { ip: '10.20.0.1' }),
        dev('noip-sw', 2, { ip: '' }),
        dev('v1-sw', 3, { ip: '10.20.0.3' }),
        dev('off-sw', 4, { ip: '10.20.0.4' }),
        dev('none-sw', 5, { ip: '10.20.0.5' }),
        dev('legacy-sw', 6, { ip: '10.20.0.6' }),
        dev('v3-sw', 7, { ip: '10.20.0.7' }),
        { id: 'srv-1', type: 'Server', hostname: 'srv-1', startU: 10, sizeU: 2 },
    ])]);
    rackStore.saveRacks('dc-nd', [
        rack('nd-r1', [dev('put-sw', 1, { ip: '10.30.0.1', hostname: 'put-host' }), dev('del-sw', 5, { ip: '10.30.0.5' })]),
        rack('nd-r2', [dev('other-sw', 1, { ip: '10.30.1.1' })]),
    ]);
}

// ---------------------------------------------------------------- roles

test('Viewer: 403 on POST / PUT / DELETE devices and POST snmp; GET routes allowed', async () => {
    const writes = [
        ['post', '/devices', { datacenterId: 'dc-nd', rackId: 'nd-r1', device: { type: 'Switch', startU: 20, sizeU: 1 } }],
        ['put', '/devices/put-sw', { hostname: 'x' }],
        ['delete', '/devices/put-sw'],
        ['post', '/put-sw/snmp', { enabled: false }],
    ];
    for (const [method, url, body] of writes) {
        const r = await call(method, url, VIEWER, body);
        assert.equal(r.status, 403, `Viewer ${method.toUpperCase()} ${url} -> ${r.status}`);
    }
    assert.equal((await call('get', '/devices', VIEWER)).status, 200);
    assert.equal((await call('get', '/put-sw/snmp', VIEWER)).status, 200);
    assert.ok(findDevice('dc-nd', 'put-sw'), 'nothing deleted');
});

// ---------------------------------------------------------------- GET /devices

test('GET /devices reads racks through rackStore (all DCs), emits fileKey and the SNMP switch state', async () => {
    storeSnmp('put-sw', { version: 'v2c', community: 'secret-c', port: 161 }); // legacy: no enabled key
    storeSnmp('other-sw', { enabled: false, version: 'v2c', community: '', port: 161 });
    const r = await call('get', '/devices', OP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const byId = Object.fromEntries(r.body.map(d => [d.id, d]));
    assert.ok(byId['poll-sw'] && byId['put-sw'] && byId['other-sw']);
    assert.ok(!byId['srv-1'], 'servers are not network devices');
    assert.equal(byId['poll-sw'].fileKey, 'data_center/server_rack.json');
    assert.equal(byId['poll-sw'].datacenter, 'Default Data Center');
    assert.equal(byId['put-sw'].fileKey, rackStore.rackKey('dc-nd'));
    assert.equal(byId['put-sw'].datacenter, 'ND DC');
    assert.equal(byId['put-sw'].rackId, 'nd-r1');
    assert.equal(byId['put-sw'].enabled, true, 'legacy settings count as enabled');
    assert.equal(byId['put-sw'].snmp.community, MASK);
    assert.equal(byId['other-sw'].enabled, false);
    assert.equal(byId['none-sw'].enabled, false, 'no settings -> disabled');
    assert.equal(byId['none-sw'].snmp.community, '', 'never a public fallback');
    // GET /:id/snmp agrees
    const g = await call('get', '/none-sw/snmp', VIEWER);
    assert.deepEqual(g.body, { enabled: false, version: 'v2c', community: '', port: 161 });
    assert.equal((await call('get', '/put-sw/snmp', VIEWER)).body.enabled, true);
});

// ---------------------------------------------------------------- poll

test('poll ignores ?ip= and uses the rack IP; v2c -> Version2c; unknown 404; no IP 400', async () => {
    storeSnmp('poll-sw', { enabled: true, version: 'v2c', community: 'c-poll', port: 1161 });
    sessions.length = 0;
    const r = await call('get', '/poll-sw/poll?ip=203.0.113.9', VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.live, true);
    assert.equal(r.body.ports.length, 2);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].target, '10.20.0.1');
    assert.equal(sessions[0].authOrCommunity, 'c-poll');
    assert.equal(sessions[0].options.version, realSnmp.Version2c);
    assert.equal(sessions[0].options.port, 1161);
    assert.ok(sessions[0].closed);

    assert.equal((await call('get', '/nope/poll?ip=10.0.0.1', OP)).status, 404);
    storeSnmp('noip-sw', { enabled: true, version: 'v2c', community: 'c', port: 161 });
    const noIp = await call('get', '/noip-sw/poll?ip=10.0.0.1', OP);
    assert.equal(noIp.status, 400);
    assert.equal(sessions.length, 1, 'no session for 404 / 400');
});

test('poll with v1 settings creates the session with Version1', async () => {
    storeSnmp('v1-sw', { enabled: true, version: 'v1', community: 'c-v1', port: 161 });
    sessions.length = 0;
    const r = await call('get', '/v1-sw/poll', OP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sessions[0].options.version, realSnmp.Version1);
});

test('SNMP switch: explicit disabled -> 409 without a session; no settings -> disabled; legacy -> allowed', async () => {
    storeSnmp('off-sw', { enabled: false, version: 'v2c', community: 'c-off', port: 161 });
    sessions.length = 0;
    const off = await call('get', '/off-sw/poll', OP);
    assert.equal(off.status, 409);
    assert.deepEqual(off.body, { success: false, disabled: true, error: '此設備未啟用 SNMP 查詢' });

    const none = await call('get', '/none-sw/poll', OP);
    assert.equal(none.status, 409);
    assert.equal(none.body.disabled, true);
    assert.equal(sessions.length, 0, 'the session factory is never called for disabled devices');

    storeSnmp('legacy-sw', { version: 'v2c', community: 'c-legacy', port: 161 });
    const legacy = await call('get', '/legacy-sw/poll', OP);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].target, '10.20.0.6');
});

// ---------------------------------------------------------------- PUT

test('PUT: ip change frees the old IP and uses the new one; absent hostname is kept; bad input 400', async () => {
    ipamActions.length = 0;
    const revBefore = rackStore.getRackRevision('dc-nd');
    const r = await call('put', '/devices/put-sw', OP, { ip: '10.30.0.2', fileKey: rackStore.rackKey('dc-nd'), rackId: 'nd-r1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = findDevice('dc-nd', 'put-sw').device;
    assert.equal(stored.ip, '10.30.0.2');
    assert.equal(stored.hostname, 'put-host', 'absent hostname keeps its value');
    assert.equal(rackStore.getRackRevision('dc-nd'), revBefore + 1);
    assert.ok(ipamActions.some(a => a.ip === '10.30.0.1' && a.action === 'free'));
    assert.ok(ipamActions.some(a => a.ip === '10.30.0.2' && a.action === 'use' && a.hostname === 'put-host'));

    // hostname only -> 'use' with the new hostname, ip untouched
    ipamActions.length = 0;
    const h = await call('put', '/devices/put-sw', OP, { hostname: 'put-host-2' });
    assert.equal(h.status, 200);
    assert.equal(findDevice('dc-nd', 'put-sw').device.ip, '10.30.0.2');
    assert.deepEqual(ipamActions.map(a => [a.ip, a.action, a.hostname]), [['10.30.0.2', 'use', 'put-host-2']]);

    assert.equal((await call('put', '/devices/put-sw', OP, { ip: '10.30.0.999' })).status, 400);
    assert.equal((await call('put', '/devices/put-sw', OP, { ip: 'abc' })).status, 400);
    assert.equal((await call('put', '/devices/put-sw', OP, { hostname: 'x'.repeat(254) })).status, 400);
    // the device is in nd-r1 of dc-nd, not where the client says
    assert.equal((await call('put', '/devices/put-sw', OP, { hostname: 'y', fileKey: 'data_center/server_rack.json' })).status, 400);
    assert.equal((await call('put', '/devices/put-sw', OP, { hostname: 'y', rackId: 'nd-r2' })).status, 400);
    assert.equal((await call('put', '/devices/nope', OP, { hostname: 'y' })).status, 404);
    assert.equal(findDevice('dc-nd', 'put-sw').device.hostname, 'put-host-2', 'rejected PUTs change nothing');

    // empty ip clears and frees
    ipamActions.length = 0;
    const clear = await call('put', '/devices/put-sw', OP, { ip: '' });
    assert.equal(clear.status, 200);
    assert.equal(findDevice('dc-nd', 'put-sw').device.ip, '');
    assert.deepEqual(ipamActions.map(a => [a.ip, a.action]), [['10.30.0.2', 'free']]);
});

// ---------------------------------------------------------------- DELETE

test('DELETE removes the device, its SNMP settings, and frees its IP', async () => {
    storeSnmp('del-sw', { enabled: true, version: 'v2c', community: 'c-del', port: 161 });
    ipamActions.length = 0;
    const wrongKey = await call('delete', '/devices/del-sw?fileKey=data_center/server_rack.json', OP);
    assert.equal(wrongKey.status, 400);
    const r = await call('delete', `/devices/del-sw?fileKey=${encodeURIComponent(rackStore.rackKey('dc-nd'))}`, OP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(findDevice('dc-nd', 'del-sw'), null);
    assert.equal(storedSnmp('del-sw'), undefined);
    assert.ok(storedSnmp('poll-sw'), 'other SNMP settings stay');
    assert.ok(ipamActions.some(a => a.ip === '10.30.0.5' && a.action === 'free'));
    assert.equal((await call('delete', '/devices/del-sw', OP)).status, 404);
});

// ---------------------------------------------------------------- POST /devices

test('POST /devices: server id, validation 400 / 404, no ip -> no IPAM call, revision bumped', async () => {
    const post = (body) => call('post', '/devices', OP, body);
    const base = (device, extra = {}) => ({ datacenterId: 'dc-nd', rackId: 'nd-r2', device: { type: 'Switch', hostname: 'new-sw', startU: 10, sizeU: 1, ...device }, ...extra });

    assert.equal((await post(base({ type: 'Server' }))).status, 400);
    assert.equal((await post(base({ ip: '1.2.3' }))).status, 400);
    assert.equal((await post(base({ startU: 0 }))).status, 400);
    assert.equal((await post(base({ sizeU: 1.5 }))).status, 400);
    assert.equal((await post(base({ hostname: 5 }))).status, 400);
    const overlap = await post(base({ startU: 1 }));
    assert.equal(overlap.status, 400);
    assert.match(overlap.body.error, /overlap/);
    const tall = await post(base({ startU: 41, sizeU: 3 }));
    assert.equal(tall.status, 400);
    assert.match(tall.body.error, /exceeds rack height/);
    assert.equal((await post(base({}, { datacenterId: 'dc-nope' }))).status, 404);
    assert.equal((await post(base({}, { rackId: 'nope' }))).status, 404);

    ipamActions.length = 0;
    const revBefore = rackStore.getRackRevision('dc-nd');
    const ok = await post(base({ id: 'client-id', ip: '' }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.device.id, /^dev-\d+-[0-9a-f]+$/);
    assert.notEqual(ok.body.device.id, 'client-id');
    assert.equal(ok.body.revision, revBefore + 1);
    assert.equal(rackStore.getRackRevision('dc-nd'), revBefore + 1);
    assert.equal(ipamActions.length, 0, 'no ip -> no IPAM call');
    const placed = findDevice('dc-nd', ok.body.device.id);
    assert.equal(placed.rack.id, 'nd-r2');
    assert.equal(placed.device.startU, 10);

    const withIp = await post(base({ startU: 12, ip: '10.30.1.12' }));
    assert.equal(withIp.status, 200);
    assert.deepEqual(ipamActions.map(a => [a.ip, a.action]), [['10.30.1.12', 'use']]);
    assert.ok(audits.some(([, mod, msg]) => mod === 'Network Device' && /Added Switch/.test(msg)));

    // default DC works without datacenterId
    const def = await call('post', '/devices', OP, { rackId: 'def-r1', device: { type: 'Router', hostname: 'r', startU: 20, sizeU: '2' } });
    assert.equal(def.status, 200, JSON.stringify(def.body));
    assert.equal(def.body.device.sizeU, 2);
});

// ---------------------------------------------------------------- POST /:id/snmp

test('POST snmp: validation, whitelist, mask keeps the old secret, disabled may be incomplete', async () => {
    const save = (id, body) => call('post', `/${id}/snmp`, OP, body);
    assert.equal((await save('nope', { enabled: false })).status, 404);

    assert.equal((await save('v3-sw', { enabled: true, version: 'v2c', community: '' })).status, 400);
    assert.equal((await save('v3-sw', { enabled: true, version: 'v2' , community: 'c' })).status, 400);
    assert.equal((await save('v3-sw', { enabled: true, version: 'v2c', community: 'c', port: 70000 })).status, 400);
    assert.equal((await save('v3-sw', { enabled: 'yes', version: 'v2c', community: 'c' })).status, 400);
    assert.equal((await save('v3-sw', { enabled: true, version: 'v3', v3User: 'u', v3AuthPass: 'short', v3PrivPass: 'longenough' })).status, 400);
    assert.equal((await save('v3-sw', { enabled: true, version: 'v3', v3User: 'u', v3AuthPass: 'longenough', v3PrivPass: 'short' })).status, 400);
    assert.equal((await save('v3-sw', { enabled: true, version: 'v3', v3User: '', v3AuthPass: 'longenough', v3PrivPass: 'longenough' })).status, 400);
    assert.equal(storedSnmp('v3-sw'), undefined, 'rejected saves store nothing');

    const ok = await save('v3-sw', { enabled: true, version: 'v3', v3User: 'u', v3AuthPass: 'auth-pass-1', v3PrivPass: 'priv-pass-1', port: '1161', evil: 'x', id: 'other' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    let s = storedSnmp('v3-sw');
    assert.equal(s.evil, undefined, 'unknown keys dropped');
    assert.equal(s.id, undefined);
    assert.equal(s.port, 1161);
    assert.equal(s.v3AuthPass, 'auth-pass-1');
    const raw = readDataSync(SNMP_FILE, {})['v3-sw'];
    assert.notEqual(raw.v3AuthPass, 'auth-pass-1', 'secrets are stored encrypted');

    // the masked value from GET keeps the old secrets
    const g = (await call('get', '/v3-sw/snmp', OP)).body;
    assert.equal(g.v3AuthPass, MASK);
    const again = await save('v3-sw', { ...g, v3User: 'u2' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    s = storedSnmp('v3-sw');
    assert.equal(s.v3User, 'u2');
    assert.equal(s.v3AuthPass, 'auth-pass-1');
    assert.equal(s.v3PrivPass, 'priv-pass-1');

    // v3 poll uses the stored user
    sessions.length = 0;
    assert.equal((await call('get', '/v3-sw/poll', OP)).status, 200);
    assert.equal(sessions[0].kind, 'v3');
    assert.equal(sessions[0].authOrCommunity.name, 'u2');

    // disabled settings may be saved incomplete, and then block polling
    const off = await save('v3-sw', { enabled: false, version: 'v2c', community: '' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(storedSnmp('v3-sw').enabled, false);
    sessions.length = 0;
    assert.equal((await call('get', '/v3-sw/poll', OP)).status, 409);
    assert.equal(sessions.length, 0);

    // a save without the enabled key (older client) keeps the switch state
    await save('v3-sw', { version: 'v2c', community: 'c' });
    assert.equal(storedSnmp('v3-sw').enabled, false);
    // a new device saved by an older client is enabled
    await save('noip-sw', { version: 'v2c', community: 'c2' });
    assert.equal(storedSnmp('noip-sw').enabled, true);
});

test('SNMP settings are saved by Server Rack users too (dataCenter feature only)', async () => {
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } } },
    });
    try {
        // srv-1 is a Server: Server Rack also configures SNMP for non-network types
        const r = await call('post', '/srv-1/snmp', OP, { enabled: true, version: 'v2c', community: 'c' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((await call('get', '/devices', OP)).status, 403);
    } finally {
        writeRbacConfig({
            roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
            groups: {
                SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { networkDevice: true, dataCenter: true } },
                g: { type: 'group', target: 'g', enabled: true, features: { networkDevice: true, dataCenter: true } },
            },
        });
    }
});
