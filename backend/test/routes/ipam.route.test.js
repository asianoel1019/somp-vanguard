// IPAM routes + syncs: CIDR validation, ips never replaced by a subnet edit, summaries, gateway / reserved /
// reservations, system-managed IPs, single-IP validation, guarded delete, DNS sync zones, private-only auto-create.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const core = require('../../lib/ipamCore');

const IPAM_KEY = 'network_service/ipam/subnets.json';
const ENV_KEY = 'system/environments.json';

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const SA = tok('SuperAdmin'), OP = tok('Operator'), VIEWER = tok('Viewer');

let app;
let ipamSync;
const audits = [];

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { ipam: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { ipam: true } },
        },
    });
    writeDataSync(ENV_KEY, [{ id: 'def', name: 'Default', isDefault: true }, { id: 'prod', name: 'Production' }]);
    // stub before routes/ipam and lib/ipamSync destructure auditLog
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    ipamSync = require('../../lib/ipamSync');
    app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/ipam', require('../../routes/ipam'));
});
test.after(async () => { await dbManager.closeDB(); });

function call(method, url, token, body) {
    const r = request(app)[method](`/api/ipam${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
}

const stored = () => readDataSync(IPAM_KEY, []);
const storedSubnet = (id) => stored().find(s => s.id === id);
const ipOf = (id, address) => storedSubnet(id).ips.find(i => i.address === address);
function subnet(id, cidr, extra = {}) {
    return { id, name: id, cidr, vlan: '', envId: 'def', environment: 'Default', ips: core.generateIPs(cidr, { envId: 'def', environment: 'Default' }), createdAt: 'x', ...extra };
}

// ---------------------------------------------------------------- create / CIDR validation
test('create: normalised cidr, mask range, duplicate, overlap, default gateway; Viewer 403', async () => {
    writeDataSync(IPAM_KEY, [subnet('big', '10.50.0.0/16')]);
    await call('post', '/subnets', VIEWER, { name: 'v', cidr: '10.1.0.0/24' }).expect(403);

    const ok = await call('post', '/subnets', OP, { name: 'n1', cidr: '10.1.0.77/24' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.cidr, '10.1.0.0/24');
    assert.equal(ok.body.cidrNormalizedFrom, '10.1.0.77/24');
    assert.equal(ok.body.gateway, '10.1.0.1');
    assert.deepEqual(ok.body.reserved, []);
    assert.equal(ok.body.ips.length, 254);
    assert.equal(storedSubnet(ok.body.id).cidr, '10.1.0.0/24');

    for (const cidr of ['10.2.0.0/19', '10.2.0.0/16', '10.2.0.0/31', '10.2.0.0/32', '10.2.0/24', 'x']) {
        const r = await call('post', '/subnets', OP, { name: 'bad', cidr });
        assert.equal(r.status, 400, cidr);
    }
    assert.match((await call('post', '/subnets', OP, { name: 'b', cidr: '10.2.0.0/19' })).body.error, /\/20 to \/30/);
    assert.match((await call('post', '/subnets', OP, { name: 'dup', cidr: '10.1.0.0/24' }).expect(400)).body.error, /already exists/);
    assert.match((await call('post', '/subnets', OP, { name: 'dup2', cidr: '10.1.0.5/24' }).expect(400)).body.error, /already exists/);
    const ov = await call('post', '/subnets', OP, { name: 'ov', cidr: '10.50.3.0/24' }).expect(400);
    assert.match(ov.body.error, /overlaps existing subnet big \(10\.50\.0\.0\/16\)/);
    await call('post', '/subnets', OP, { name: 'ov2', cidr: '10.1.0.128/25' }).expect(400);
    await call('post', '/subnets', OP, { name: 'gw', cidr: '10.3.0.0/24', gateway: '10.4.0.1' }).expect(400);
    const noGw = await call('post', '/subnets', OP, { name: 'nogw', cidr: '10.3.0.0/24', gateway: '', reserved: ['10.3.0.10-10.3.0.20'] }).expect(201);
    assert.equal(noGw.body.gateway, '');
    assert.deepEqual(noGw.body.reserved, ['10.3.0.10-10.3.0.20']);
    assert.equal(stored().length, 3);
});

test('batch create: per-row rejection with reasons, valid rows added', async () => {
    writeDataSync(IPAM_KEY, [subnet('a', '10.60.0.0/24')]);
    const r = await call('post', '/subnets/batch', OP, { subnets: [
        { name: 'ok1', cidr: '10.61.0.0/24' },
        { name: 'dup', cidr: '10.60.0.0/24' },
        { name: 'ovl-row', cidr: '10.61.0.0/25' },
        { name: 'mask', cidr: '10.62.0.0/18' },
        { name: 'env', cidr: '10.63.0.0/24', environment: 'Mars' },
        { cidr: '10.64.0.0/24' },
        { name: 'ok2', cidr: '10.65.0.9/30' }
    ] }).expect(201);
    assert.equal(r.body.added, 2);
    const reasons = Object.fromEntries(r.body.rejected.map(x => [x.cidr, x.error]));
    assert.match(reasons['10.60.0.0/24'], /already exists/);
    assert.match(reasons['10.61.0.0/25'], /overlaps existing subnet ok1/);
    assert.match(reasons['10.62.0.0/18'], /\/20 to \/30/);
    assert.match(reasons['10.63.0.0/24'], /Unknown environment "Mars"/);
    assert.match(reasons['10.64.0.0/24'], /Name and CIDR required/);
    assert.deepEqual(stored().map(s => s.cidr), ['10.60.0.0/24', '10.61.0.0/24', '10.65.0.8/30']);
});

// ---------------------------------------------------------------- editing never replaces ips
test('PUT /subnets/:id ignores ips and cidr; edits name / vlan / env / gateway / reserved', async () => {
    const s = subnet('e1', '10.70.0.0/24');
    s.ips[4] = { ...s.ips[4], status: 'used', hostname: 'keep-me' };
    writeDataSync(IPAM_KEY, [s]);
    const r = await call('put', '/subnets/e1', OP, {
        ...s, name: 'renamed', vlan: '42', envId: 'prod', cidr: '10.99.0.0/24',
        gateway: '10.70.0.254', reserved: ['10.70.0.2', '10.70.0.100-10.70.0.110'],
        ips: [{ address: '10.70.0.1', status: 'used' }] // old client sending a (stale) list
    }).expect(200);
    assert.equal(r.body.ips, undefined);
    const after = storedSubnet('e1');
    assert.deepEqual([after.name, after.vlan, after.envId, after.environment, after.cidr], ['renamed', '42', 'prod', 'Production', '10.70.0.0/24']);
    assert.equal(after.gateway, '10.70.0.254');
    assert.deepEqual(after.reserved, ['10.70.0.2', '10.70.0.100-10.70.0.110']);
    assert.equal(after.ips.length, 254);
    assert.equal(after.ips[4].hostname, 'keep-me');
    assert.equal(after.ips[0].status, 'free');

    await call('put', '/subnets/e1', OP, { gateway: '10.71.0.1' }).expect(400);
    await call('put', '/subnets/e1', OP, { reserved: ['10.70.1.1'] }).expect(400);
    await call('put', '/subnets/e1', OP, { name: '' }).expect(400);
    await call('put', '/subnets/nope', OP, { name: 'x' }).expect(404);
    assert.equal(storedSubnet('e1').gateway, '10.70.0.254');
});

test('PUT /subnets/batch reaches the batch route and ignores ips', async () => {
    writeDataSync(IPAM_KEY, [subnet('b1', '10.72.0.0/30'), subnet('b2', '10.72.0.4/30')]);
    await call('put', '/subnets/batch', OP, { updates: [{ id: 'b1', name: 'x', ips: [] }, { id: 'b2', vlan: '9' }] }).expect(200);
    assert.deepEqual(stored().map(s => [s.name, s.vlan, s.ips.length]), [['x', '', 2], ['b2', '9', 2]]);
    const bad = await call('put', '/subnets/batch', OP, { updates: [{ id: 'b1', name: 'y' }, { id: 'b2', environment: 'Mars' }] }).expect(400);
    assert.match(bad.body.error, /Unknown environment/);
    assert.equal(storedSubnet('b1').name, 'x', 'nothing written');
});

// ---------------------------------------------------------------- summaries / payload size
test('GET /subnets: summaries without ips + counts; include=ips full; GET /subnets/:id; truncated legacy /16', async () => {
    const s = subnet('g1', '10.80.0.0/29');
    s.ips[0].status = 'used'; s.ips[1].status = 'vip'; s.ips[2].reservedUntil = new Date(Date.now() + 60000).toISOString();
    writeDataSync(IPAM_KEY, [s, subnet('g16', '10.81.0.0/16')]);
    const list = (await call('get', '/subnets', VIEWER).expect(200)).body;
    assert.equal(list.length, 2);
    assert.equal(list[0].ips, undefined);
    assert.deepEqual(
        [list[0].counts.total, list[0].counts.free, list[0].counts.used, list[0].counts.vip, list[0].counts.reserved, list[0].counts.reservations, list[0].counts.truncated],
        [6, 4, 1, 1, 0, 1, false]);
    assert.equal(list[0].gateway, '10.80.0.1');
    assert.equal(list[0].gatewayDefault, true);
    assert.equal(list[0].environment, 'Default');
    assert.deepEqual([list[1].truncated, list[1].hostCount, list[1].counts.total], [true, 65534, 4094]);

    const full = (await call('get', '/subnets?include=ips', VIEWER).expect(200)).body;
    assert.equal(full[0].ips.length, 6);
    assert.equal(full[0].ips[0].environment, 'Default');
    assert.equal(full[0].counts.used, 1);

    const one = (await call('get', '/subnets/g1', VIEWER).expect(200)).body;
    assert.equal(one.ips.length, 6);
    assert.equal(one.counts.vip, 1);
    await call('get', '/subnets/nope', VIEWER).expect(404);
});

// ---------------------------------------------------------------- single IP update
test('PUT /ips: validation of status / tags / lengths / address; address past a truncated /16 is materialised', async () => {
    writeDataSync(IPAM_KEY, [subnet('t16', '10.82.0.0/16')]);
    const bad = [
        [{ address: '10.82.0.1', status: 'bogus' }, /Unknown status "bogus"/],
        [{ address: '10.82.0.1', tags: 'x' }, /tags/],
        [{ address: '10.82.0.1', tags: Array(51).fill('t') }, /tags/],
        [{ address: '10.82.0.1', tags: ['x'.repeat(65)] }, /tag/],
        [{ address: '10.82.0.1', hostname: 'h'.repeat(254) }, /hostname/],
        [{ address: '10.82.0.1', hostname: 5 }, /hostname/],
        [{ address: '10.82.0.1', fqdn: `a.b,${'f'.repeat(254)}` }, /fqdn/],
        [{ address: '10.82.0.1', assignedTo: 'o'.repeat(201) }, /assignedTo/],
        [{ address: '10.82.0.1', service: ['x'] }, /service/],
        [{ address: 'nope' }, /valid IPv4/],
        [{ address: '10.83.0.1' }, /not inside subnet/],
        [{ address: '10.82.255.255' }, /not a usable host/]
    ];
    for (const [body, re] of bad) {
        const r = await call('put', '/subnets/t16/ips', OP, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, re);
    }
    for (const st of ['free', 'used', 'vip', 'reserved', 'static', 'conflict']) {
        await call('put', '/subnets/t16/ips', OP, { address: '10.82.0.9', status: st }).expect(200);
    }
    const r = await call('put', '/subnets/t16/ips', OP, { address: '10.82.200.7', status: 'used', hostname: 'far', tags: ['a'] }).expect(200);
    assert.equal(r.body.hostname, 'far');
    const after = storedSubnet('t16');
    assert.equal(after.ips.length, 4095);
    const i = after.ips.findIndex(x => x.address === '10.82.200.7');
    assert.equal(i, 4094, 'inserted in address order (after the materialised .0.1 - .15.254)');
    assert.equal(after.ips[i].envId, 'def');
});

test('system-managed IPs: status / hostname / assignedTo -> 409 unless SuperAdmin + force (audited); fqdn allowed', async () => {
    const s = subnet('m1', '10.84.0.0/24');
    Object.assign(s.ips[9], { status: 'used', hostname: 'sw-01', assignedTo: 'Network Device' });
    Object.assign(s.ips[10], { status: 'vip', assignedTo: 'VIP of 10.84.0.1' });
    writeDataSync(IPAM_KEY, [s]);
    const r1 = await call('put', '/subnets/m1/ips', OP, { address: '10.84.0.10', status: 'free' }).expect(409);
    assert.equal(r1.body.managedBy, 'Network Device');
    await call('put', '/subnets/m1/ips', OP, { address: '10.84.0.10', hostname: 'other', force: true }).expect(409);
    await call('put', '/subnets/m1/ips', SA, { address: '10.84.0.10', assignedTo: 'me' }).expect(409);
    assert.equal((await call('put', '/subnets/m1/ips', OP, { address: '10.84.0.11', status: 'used' }).expect(409)).body.managedBy, 'VIP Linkage');
    // unchanged values + fqdn / service / tags edits are fine (what the assignment drawer sends back)
    await call('put', '/subnets/m1/ips', OP, { address: '10.84.0.10', status: 'used', hostname: 'sw-01', assignedTo: 'Network Device', fqdn: 'sw-01.corp', service: 'core', tags: ['x'] }).expect(200);
    assert.equal(ipOf('m1', '10.84.0.10').fqdn, 'sw-01.corp');

    audits.length = 0;
    await call('put', '/subnets/m1/ips', SA, { address: '10.84.0.10', status: 'free', hostname: '', assignedTo: '', force: true }).expect(200);
    assert.equal(ipOf('m1', '10.84.0.10').status, 'free');
    assert.ok(audits.some(a => /FORCED change of system-managed IP 10\.84\.0\.10 \(managed by Network Device\)/.test(a[2])));
});

// ---------------------------------------------------------------- next available / reservations
test('next-available skips gateway / reserved / used / reservations; reserve-next gives distinct IPs; expiry; PUT clears', async () => {
    writeDataSync(IPAM_KEY, [subnet('n1', '10.85.0.0/28', { reserved: ['10.85.0.2-10.85.0.3'] })]);
    // legacy subnet without a gateway field -> .1 is the gateway
    assert.equal((await call('get', '/subnets/n1/next-available', VIEWER).expect(200)).body.address, '10.85.0.4');
    await call('post', '/subnets/n1/reserve-next', VIEWER).expect(403);
    const a = (await call('post', '/subnets/n1/reserve-next', OP).expect(200)).body;
    const b = (await call('post', '/subnets/n1/reserve-next', SA).expect(200)).body;
    assert.deepEqual([a.address, b.address], ['10.85.0.4', '10.85.0.5']);
    assert.equal(a.reservedBy, 'operator');
    assert.equal(a.status, 'free', 'a reservation keeps status free');
    assert.ok(new Date(a.reservedUntil).getTime() > Date.now() + 9 * 60000);
    assert.equal((await call('get', '/subnets/n1/next-available', VIEWER).expect(200)).body.address, '10.85.0.6');

    // expired reservation is ignored
    const doc = stored();
    doc[0].ips.find(i => i.address === '10.85.0.4').reservedUntil = new Date(Date.now() - 1000).toISOString();
    writeDataSync(IPAM_KEY, doc);
    assert.equal((await call('get', '/subnets/n1/next-available', VIEWER).expect(200)).body.address, '10.85.0.4');

    // setting the IP ends its reservation
    await call('put', '/subnets/n1/ips', OP, { address: '10.85.0.5', status: 'used', hostname: 'h' }).expect(200);
    const e = ipOf('n1', '10.85.0.5');
    assert.deepEqual([e.reservedBy, e.reservedUntil, e.status], [undefined, undefined, 'used']);

    // explicit '' = no gateway
    await call('put', '/subnets/n1', OP, { gateway: '' }).expect(200);
    assert.equal((await call('get', '/subnets/n1/next-available', VIEWER).expect(200)).body.address, '10.85.0.1');
    await call('get', '/subnets/nope/next-available', VIEWER).expect(404);

    writeDataSync(IPAM_KEY, [subnet('full', '10.85.1.0/30')]); // .1 gateway, .2 the only one
    await call('post', '/subnets/full/reserve-next', OP).expect(200);
    assert.equal((await call('post', '/subnets/full/reserve-next', OP).expect(404)).body.error, 'No available IPs');
});

// ---------------------------------------------------------------- delete
test('delete: 404 when missing; non-empty needs SuperAdmin + confirmCidr; empty subnet Operator ok', async () => {
    const used = subnet('d1', '10.86.0.0/30');
    used.ips[0].hostname = 'h';
    writeDataSync(IPAM_KEY, [used, subnet('d2', '10.86.0.4/30')]);
    await call('delete', '/subnets/nope', OP).expect(404);
    await call('delete', '/subnets/d1', VIEWER).expect(403);
    const op = await call('delete', '/subnets/d1', OP, { confirmCidr: '10.86.0.0/30' }).expect(403);
    assert.match(op.body.error, /only a SuperAdmin/);
    await call('delete', '/subnets/d1', SA).expect(400);
    await call('delete', '/subnets/d1', SA, { confirmCidr: '10.86.0.4/30' }).expect(400);
    assert.equal(stored().length, 2);
    await call('delete', '/subnets/d1?confirmCidr=10.86.0.0/30', SA).expect(200);
    await call('delete', '/subnets/d2', OP).expect(200);
    assert.equal(stored().length, 0);
});

// ---------------------------------------------------------------- DNS sync
test('DNS sync: only FQDNs of listed zones are cleared, other zones kept; no zones -> nothing cleared', async () => {
    const s = subnet('z1', '10.87.0.0/24');
    s.ips[0].fqdn = 'a.corp.local';                 // .1 listed zone, gone from DNS -> cleared
    s.ips[1].fqdn = 'b.other.local';                // .2 other zone -> kept
    s.ips[2].fqdn = 'c.corp.local,c.other.local';   // .3 mixed -> corp part removed, other kept
    s.ips[3].fqdn = 'old.corp.local,x.other.local'; // .4 in DNS again -> corp from DNS + other kept
    writeDataSync(IPAM_KEY, [s]);

    const none = await ipamSync.syncDnsToIpam([{ ip: '10.87.0.4', fqdn: 'new.corp.local' }], 'u');
    assert.deepEqual(none, { updated: 1, cleared: 0, skipped: 0 });
    assert.equal(ipOf('z1', '10.87.0.1').fqdn, 'a.corp.local', 'no zones: nothing cleared');
    assert.equal(ipOf('z1', '10.87.0.4').fqdn, 'new.corp.local,old.corp.local,x.other.local', 'no zones: additions only');

    const r = await call('post', '/subnets/dns-sync', OP, { records: [{ ip: '10.87.0.4', fqdn: 'new.corp.local' }], zones: ['Corp.Local.'] }).expect(200);
    assert.deepEqual([r.body.updated, r.body.cleared, r.body.skipped], [2, 1, 0]);
    assert.equal(ipOf('z1', '10.87.0.1').fqdn, '');
    assert.equal(ipOf('z1', '10.87.0.2').fqdn, 'b.other.local');
    assert.equal(ipOf('z1', '10.87.0.3').fqdn, 'c.other.local');
    assert.equal(ipOf('z1', '10.87.0.4').fqdn, 'new.corp.local,x.other.local');

    await call('post', '/subnets/dns-sync', OP, { records: [], zones: 'corp.local' }).expect(400);
    await call('post', '/subnets/dns-sync', VIEWER, { records: [] }).expect(403);
});

test('DNS sync: public IP without subnet skipped (no write); private auto-created; longest prefix; truncated /16 materialised', async () => {
    writeDataSync(IPAM_KEY, [subnet('wide', '10.200.0.0/16'), subnet('narrow', '10.200.5.0/24')]);
    const r = await ipamSync.syncDnsToIpam([
        { ip: '8.8.8.8', fqdn: 'dns.google' },
        { ip: '192.168.77.5', fqdn: 'p.corp' },
        { ip: '10.200.5.9', fqdn: 'n.corp' },
        { ip: '10.200.99.9', fqdn: 'far.corp' },
        { ip: 'fe80::1', fqdn: 'v6.corp' }
    ], 'u');
    assert.deepEqual(r, { updated: 3, cleared: 0, skipped: 2 });
    const doc = stored();
    assert.deepEqual(doc.map(s => s.cidr), ['10.200.0.0/16', '10.200.5.0/24', '192.168.77.0/24']);
    assert.equal(ipOf('narrow', '10.200.5.9').fqdn, 'n.corp');
    assert.equal(ipOf('wide', '10.200.5.9').fqdn, '', 'most specific subnet only');
    assert.equal(ipOf('wide', '10.200.99.9').fqdn, 'far.corp');
    assert.equal(doc[2].envId, 'def');

    const before = JSON.stringify(stored());
    const pub = await ipamSync.syncDnsToIpam([{ ip: '1.2.3.4', fqdn: 'x.example' }], 'u');
    assert.deepEqual(pub, { updated: 0, cleared: 0, skipped: 1 });
    assert.equal(JSON.stringify(stored()), before);
});

test('rack / device IP sync: private auto-create only, public skipped, longest prefix, materialise, free', () => {
    writeDataSync(IPAM_KEY, [subnet('w', '10.89.0.0/16'), subnet('n', '10.89.1.0/24')]);
    const r = ipamSync.batchSyncIpsToIpam([
        { ip: '10.89.1.20', hostname: 'srv-a', username: 'u', action: 'use', source: 'Server Rack' },
        { ip: '10.89.250.1', hostname: 'srv-b', username: 'u', action: 'use', source: 'Server Rack' },
        { ip: '172.20.3.4', hostname: 'srv-c', username: 'u', action: 'use', source: 'Server Rack' },
        { ip: '203.0.113.9', hostname: 'pub', username: 'u', action: 'use', source: 'Server Rack' }
    ]);
    assert.deepEqual(r, { changed: true, created: 1, skipped: 1 });
    assert.equal(ipOf('n', '10.89.1.20').assignedTo, 'Server Rack');
    assert.equal(ipOf('w', '10.89.1.20').status, 'free');
    assert.equal(ipOf('w', '10.89.250.1').hostname, 'srv-b');
    assert.deepEqual(stored().map(s => s.cidr), ['10.89.0.0/16', '10.89.1.0/24', '172.20.3.0/24']);
    ipamSync.syncIpToIpam('10.89.1.20', '', 'u', 'free', 'Server Rack');
    assert.deepEqual([ipOf('n', '10.89.1.20').status, ipOf('n', '10.89.1.20').assignedTo], ['free', '']);
    assert.deepEqual(ipamSync.syncIpToIpam('9.9.9.9', 'x', 'u', 'use', 'Network Device'), { changed: false, created: 0, skipped: 1 });
});
