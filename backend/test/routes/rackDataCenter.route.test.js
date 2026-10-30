require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const SA = tok('SuperAdmin'), OP = tok('Operator'), VIEWER = tok('Viewer');

let app;
let rackStore;
const ipamActions = [];
const audits = [];

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dataCenter: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } },
        },
    });
    // stubs must be in place before routes/rack destructures auditLog
    require('../../lib/ipamSync').batchSyncIpsToIpam = (actions) => { ipamActions.push(...actions); };
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    rackStore = require('../../lib/rackStore');
    app = express();
    app.use(express.json());
    app.use('/api/rack', require('../../routes/rack'));
});
test.after(async () => { await dbManager.closeDB(); });

function call(method, url, token, body) {
    let r = request(app)[method](`/api/rack${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
}

async function createDc(name) {
    const r = await call('post', '/datacenters/item', OP, { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.dataCenter.id;
}

async function revisionOf(dcId) {
    const r = await call('get', `/?dcId=${dcId}`, VIEWER);
    assert.equal(r.status, 200);
    return Number(r.headers['x-rack-revision']);
}

const rack = (id, devices = [], extra = {}) => ({ id, name: id, height: 42, devices, ...extra });
const dev = (id, startU, sizeU = 1, extra = {}) => ({ id, type: 'Server', hostname: id, startU, sizeU, ...extra });

// ---------------------------------------------------------------- roles

test('Viewer gets 403 on every write route; Operator on DC delete and contract force delete', async () => {
    const writes = [
        ['post', '/datacenters', []],
        ['post', '/datacenters/item', { name: 'x' }],
        ['put', '/datacenters/default', { name: 'x' }],
        ['delete', '/datacenters/dc-x', { confirmName: 'x' }],
        ['post', '/?dcId=default&rev=0', [rack('r1')]],
        ['patch', '/?dcId=default&rev=0', [rack('r1')]],
        ['post', '/move-device', {}],
        ['post', '/issues/single', { deviceName: 'x' }],
        ['put', '/issues/hw-1', {}],
        ['delete', '/issues/hw-1'],
        ['post', '/spare-parts', { categories: ['RAM'] }],
        ['put', '/spare-parts/categories', { categories: ['RAM'] }],
        ['post', '/spare-parts/items', { name: 'x', category: 'RAM' }],
        ['patch', '/spare-parts/sp-1', { name: 'x' }],
        ['post', '/spare-parts/sp-1/stock', { type: 'IN', qty: 1 }],
        ['post', '/contracts', { name: 'x' }],
        ['delete', '/contracts/c-1'],
        ['delete', '/contracts/c-1/force'],
        ['post', '/contracts/c-1/restore'],
    ];
    for (const [method, url, body] of writes) {
        const r = await call(method, url, VIEWER, body);
        assert.equal(r.status, 403, `Viewer ${method.toUpperCase()} ${url} -> ${r.status}`);
    }
    assert.equal((await call('delete', '/datacenters/dc-x', OP, { confirmName: 'x' })).status, 403);
    assert.equal((await call('delete', '/contracts/c-1/force', OP)).status, 403);
    // the bulk issue replace had no caller and is gone
    assert.equal((await call('post', '/issues', SA, [])).status, 404);
});

// ---------------------------------------------------------------- data centers

test('DC create / update whitelist fields, drop computed usedRacks, and validate the name', async () => {
    assert.equal((await call('post', '/datacenters/item', OP, { name: '   ' })).status, 400);
    const c = await call('post', '/datacenters/item', OP, {
        id: 'client-id', name: '  Taipei DC  ', address: 'A', usedRacks: 9, totalRacks: '10', acl: [{ name: 'n', phone: 'p', extra: 1 }], evil: 'x',
    });
    assert.equal(c.status, 200);
    const dc = c.body.dataCenter;
    assert.match(dc.id, /^dc-\d+-[0-9a-f]+$/);
    assert.equal(dc.name, 'Taipei DC');
    assert.equal(dc.totalRacks, 10);
    assert.deepEqual(dc.acl, [{ name: 'n', phone: 'p' }]);
    assert.equal(dc.usedRacks, undefined);
    assert.equal(dc.evil, undefined);

    const u = await call('put', `/datacenters/${dc.id}`, OP, { name: 'Taipei DC 2', usedRacks: 5, contact: 'Bob' });
    assert.equal(u.status, 200);
    const stored = readDataSync('data_center/datacenters.json', []).find(d => d.id === dc.id);
    assert.equal(stored.name, 'Taipei DC 2');
    assert.equal(stored.contact, 'Bob');
    assert.equal(stored.address, 'A');
    assert.ok(!('usedRacks' in stored));
    assert.equal((await call('put', '/datacenters/dc-nope', OP, { name: 'x' })).status, 404);
    assert.equal((await call('put', `/datacenters/${dc.id}`, OP, { name: '' })).status, 400);
});

test('legacy POST /datacenters is upsert-only: a missing DC and its racks survive', async () => {
    const dcId = await createDc('Keep Me');
    const save = await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('k1', [dev('k-d1', 1, 1, { ip: '10.7.0.1' })])]);
    assert.equal(save.status, 200, JSON.stringify(save.body));

    const others = readDataSync('data_center/datacenters.json', []).filter(d => d.id !== dcId).map(d => ({ ...d, usedRacks: 3 }));
    others.push({ id: 'dc-legacy-new', name: 'Legacy New', usedRacks: 1 });
    const legacy = await call('post', '/datacenters', OP, others);
    assert.equal(legacy.status, 200);
    const all = readDataSync('data_center/datacenters.json', []);
    assert.ok(all.some(d => d.id === dcId), 'missing DC is not deleted');
    assert.ok(all.some(d => d.id === 'dc-legacy-new'), 'new DC is added');
    assert.ok(all.every(d => !('usedRacks' in d)), 'usedRacks is never stored');
    assert.equal((await call('get', `/?dcId=${dcId}`, OP)).body.length, 1, 'racks survive');

    // empty array is a no-op, not a delete-all
    assert.equal((await call('post', '/datacenters', OP, [])).status, 200);
    assert.equal(readDataSync('data_center/datacenters.json', []).length, all.length);
});

test('DELETE /datacenters/:id requires SuperAdmin + exact confirmName, then clears racks (cache) and frees IPs', async () => {
    const dcId = await createDc('Doomed DC');
    writeDataSync('network_service/snmp_settings.json', { 'doom-d1': { version: 'v2c' }, other: { version: 'v2c' } });
    const save = await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('d1', [dev('doom-d1', 1, 2, { ip: '10.8.0.1' })])]);
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal((await call('get', `/?dcId=${dcId}`, OP)).body.length, 1);

    assert.equal((await call('delete', `/datacenters/${dcId}`, OP, { confirmName: 'Doomed DC' })).status, 403);
    assert.equal((await call('delete', `/datacenters/${dcId}`, SA, {})).status, 400);
    assert.equal((await call('delete', `/datacenters/${dcId}`, SA, { confirmName: 'doomed dc' })).status, 400);
    assert.equal((await call('delete', '/datacenters/default', SA, { confirmName: 'Default Data Center' })).status, 400);
    assert.equal((await call('delete', '/datacenters/dc-nope', SA, { confirmName: 'x' })).status, 404);

    ipamActions.length = 0;
    const del = await call('delete', `/datacenters/${dcId}?confirmName=${encodeURIComponent('Doomed DC')}`, SA);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(!readDataSync('data_center/datacenters.json', []).some(d => d.id === dcId));
    const after = await call('get', `/?dcId=${dcId}`, OP);
    assert.deepEqual(after.body, []);
    assert.equal(after.headers['x-rack-revision'], '0');
    assert.equal(readDataSync(rackStore.rackKey(dcId), 'gone'), 'gone', 'document removed from cache and DB');
    assert.ok(ipamActions.some(a => a.ip === '10.8.0.1' && a.action === 'free'));
    const snmp = readDataSync('network_service/snmp_settings.json', {});
    assert.ok(!snmp['doom-d1'] && snmp.other);
    // writes to the deleted DC are refused
    assert.equal((await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('d1')])).status, 404);
});

// ---------------------------------------------------------------- revisions

test('rack POST / PATCH need the current revision: 428 missing, 409 stale, success increments', async () => {
    const dcId = await createDc('Rev DC');
    assert.equal(await revisionOf(dcId), 0);
    assert.equal((await call('post', `/?dcId=${dcId}`, OP, [rack('a')])).status, 428);

    const first = await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('a'), rack('b')]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true, revision: 1 });
    assert.equal(await revisionOf(dcId), 1);

    const stale = await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('a')]);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 1);
    assert.equal(stale.body.error, '資料已被其他人修改，請重新載入');

    assert.equal((await call('patch', `/?dcId=${dcId}`, OP, [rack('a')])).status, 428);
    assert.equal((await call('patch', `/?dcId=${dcId}&rev=0`, OP, [rack('a')])).status, 409);
    const patch = await request(app).patch(`/api/rack?dcId=${dcId}`).set('Authorization', OP).set('If-Match', '"1"')
        .send([{ id: 'a', name: 'A renamed' }]);
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.revision, 2);
    const racks = (await call('get', `/?dcId=${dcId}`, OP)).body;
    assert.equal(racks.find(r => r.id === 'a').name, 'A renamed');
    assert.equal(racks.length, 2);

    assert.deepEqual((await call('get', `/revision?dcId=${dcId}`, VIEWER)).body, { revision: 2 });
    assert.equal((await call('post', '/?dcId=dc-unknown&rev=0', OP, [rack('a')])).status, 404);
    assert.equal((await call('patch', '/?dcId=dc-unknown&rev=0', OP, [rack('a')])).status, 404);
});

test('move-device bumps the revision and returns it', async () => {
    const dcId = await createDc('Move DC');
    await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('m1', [dev('mv-1', 1, 2)]), rack('m2')]);
    const r = await call('post', '/move-device', OP, { dcId, deviceId: 'mv-1', sourceRackId: 'm1', targetRackId: 'm2', targetU: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revision, 2);
    assert.equal(await revisionOf(dcId), 2);

    // same validation as rack saves: crossing a split boundary is refused
    await call('patch', `/?dcId=${dcId}&rev=2`, OP, [{ id: 'm1', isSplitDesign: true, upperU: 20, lowerU: 22, height: 42 }]);
    const cross = await call('post', '/move-device', OP, { dcId, deviceId: 'mv-1', sourceRackId: 'm2', targetRackId: 'm1', targetU: 22 });
    assert.equal(cross.status, 400);
    assert.match(cross.body.error, /split/i);

    // cross-DC move reports both revisions
    const other = await createDc('Move DC 2');
    await call('post', `/?dcId=${other}&rev=0`, OP, [rack('o1')]);
    const x = await call('post', '/move-device', OP, { dcId, targetDcId: other, deviceId: 'mv-1', sourceRackId: 'm2', targetRackId: 'o1', targetU: 1 });
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.equal(x.body.revision, 4);
    assert.equal(x.body.targetRevision, 2);
});

// ---------------------------------------------------------------- validation

test('rack validation: overlap, height, split crossing, duplicate device id -> 400', async () => {
    const dcId = await createDc('Valid DC');
    const post = (racks) => call('post', `/?dcId=${dcId}&rev=0`, OP, racks);

    let r = await post([rack('v1', [dev('a', 1, 2), dev('b', 2, 1)])]);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /v1.*overlap/);

    r = await post([rack('v1', [dev('a', 41, 3)])]);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /exceeds rack height/);

    r = await post([rack('v1', [dev('a', 21, 3)], { isSplitDesign: true, upperU: 20, lowerU: 22, height: 42 })]);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /split/i);

    r = await post([rack('v1', [dev('same', 1)]), rack('v2', [dev('same', 1)])]);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Duplicate device id "same"/);

    r = await post([rack('v1', [dev('a', 0)])]);
    assert.equal(r.status, 400);
    r = await post([rack('v1', [], { height: 0 })]);
    assert.equal(r.status, 400);
    r = await post([rack('v1'), rack('v1')]);
    assert.equal(r.status, 400);

    // a vertical (side-mounted) power bar does not take U space; split racks may be taller than 100U
    r = await post([
        rack('v1', [dev('pdu', 1, 20, { type: 'PowerBar', orientation: 'vertical', side: 'left' }), dev('srv', 3, 2)]),
        rack('v2', [], { isSplitDesign: true, upperU: 60, lowerU: 60, height: 120 }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await revisionOf(dcId), 1);
});

test('an untouched legacy rack with overlapping devices does not block saving another rack', async () => {
    const dcId = await createDc('Legacy DC');
    const legacy = rack('old', [dev('x1', 1, '2'), dev('x2', 2, 2)], { viewMode: undefined });
    delete legacy.viewMode;
    const rev = rackStore.saveRacks(dcId, [legacy, rack('other')]);

    // the client echoes the legacy rack with its UI-only viewMode and edits the other one
    const echoed = { ...legacy, viewMode: 'front' };
    const r = await call('post', `/?dcId=${dcId}&rev=${rev}`, OP, [echoed, rack('other', [dev('n1', 1)])]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await call('patch', `/?dcId=${dcId}&rev=${r.body.revision}`, OP, [rack('other', [dev('n1', 1), dev('n2', 2)])]);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    // but touching a legacy device in that rack is validated
    const bad = await call('patch', `/?dcId=${dcId}&rev=${p.body.revision}`, OP, [{ ...legacy, devices: [dev('x1', 1, 2), dev('x2', 2, 3)] }]);
    assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- PATCH parity

test('PATCH removes SNMP settings of removed devices, syncs IPAM, audits; unknown rack id -> 400', async () => {
    const dcId = await createDc('Patch DC');
    await call('post', `/?dcId=${dcId}&rev=0`, OP, [rack('p1', [dev('sw-1', 1, 1, { type: 'Switch', ip: '10.9.0.1' }), dev('sw-2', 2, 1, { ip: '10.9.0.2' })])]);
    writeDataSync('network_service/snmp_settings.json', { 'sw-1': { version: 'v2c' }, 'sw-2': { version: 'v2c' } });

    ipamActions.length = 0;
    audits.length = 0;
    const r = await call('patch', `/?dcId=${dcId}&rev=1`, OP, [rack('p1', [dev('sw-2', 2, 1, { ip: '10.9.0.3' })])]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const snmp = readDataSync('network_service/snmp_settings.json', {});
    assert.ok(!snmp['sw-1'], 'removed device SNMP settings dropped');
    assert.ok(snmp['sw-2'], 'kept device SNMP settings stay');
    assert.ok(ipamActions.some(a => a.ip === '10.9.0.1' && a.action === 'free'));
    assert.ok(ipamActions.some(a => a.ip === '10.9.0.2' && a.action === 'free'));
    assert.ok(ipamActions.some(a => a.ip === '10.9.0.3' && a.action === 'use'));
    assert.ok(audits.some(([, mod, msg]) => mod === 'Data Centers' && /p1/.test(msg)));

    const unknown = await call('patch', `/?dcId=${dcId}&rev=2`, OP, [rack('nope')]);
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown rack id/);
    assert.equal(await revisionOf(dcId), 2, 'rejected PATCH changes nothing');
});

// ---------------------------------------------------------------- spare parts

test('spare part stock movements adjust quantity on the server; OUT beyond stock -> 400', async () => {
    const c = await call('post', '/spare-parts/items', OP, { name: 'DDR4', category: 'RAM', quantity: 5, unitPrice: '100' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const id = c.body.item.id;
    assert.equal(c.body.item.quantity, 5);
    assert.equal((await call('post', '/spare-parts/items', OP, { name: 'x', category: 'RAM', quantity: -1 })).status, 400);
    assert.equal((await call('post', '/spare-parts/items', OP, { category: 'RAM' })).status, 400);

    const over = await call('post', `/spare-parts/${id}/stock`, OP, { type: 'OUT', qty: 6 });
    assert.equal(over.status, 400);
    const part = () => readDataSync('data_center/spare_parts.json', {}).items.find(i => i.id === id);
    assert.equal(part().quantity, 5);

    assert.equal((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'IN', qty: 3, note: 'PO#1' })).body.item.quantity, 8);
    const out = await call('post', `/spare-parts/${id}/stock`, OP, { type: 'OUT', qty: 2 });
    assert.equal(out.body.item.quantity, 6);
    const last = out.body.item.history.at(-1);
    assert.equal(last.type, 'OUT');
    assert.equal(last.user, 'operator');
    assert.ok(!Number.isNaN(Date.parse(last.date)));
    assert.equal((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'IN', qty: 1.5 })).status, 400);
    assert.equal((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'X', qty: 1 })).status, 400);
    assert.equal((await call('post', '/spare-parts/nope/stock', OP, { type: 'IN', qty: 1 })).status, 404);

    // PATCH edits metadata only
    const p = await call('patch', `/spare-parts/${id}`, OP, { name: 'DDR4 16G', quantity: 999, history: [] });
    assert.equal(p.status, 200);
    assert.equal(part().name, 'DDR4 16G');
    assert.equal(part().quantity, 6);
    assert.equal(part().history.length, 3);
    assert.equal((await call('patch', '/spare-parts/nope', OP, { name: 'x' })).status, 404);

    const cats = await call('put', '/spare-parts/categories', OP, { categories: ['RAM', ' SSD ', 'RAM'] });
    assert.deepEqual(cats.body.categories, ['RAM', 'SSD']);
    // legacy whole-document save only takes the categories
    await call('post', '/spare-parts', OP, { categories: ['RAM'], items: [] });
    assert.ok(part(), 'legacy POST does not replace items');
});

test('legacy spare part items with qty: null / stock normalise to a finite quantity', async () => {
    writeDataSync('data_center/spare_parts.json', {
        categories: ['RAM'],
        items: [
            { id: 'leg-1', name: 'Old A', category: 'RAM', qty: null },
            { id: 'leg-2', name: 'Old B', category: 'RAM', stock: '4' },
            { id: 'leg-3', name: 'Old C', category: 'RAM', quantity: 'abc', qty: 2 },
        ],
    });
    const g = await call('get', '/spare-parts', VIEWER);
    const byId = Object.fromEntries(g.body.items.map(i => [i.id, i]));
    assert.equal(byId['leg-1'].quantity, 0);
    assert.equal(byId['leg-2'].quantity, 4);
    assert.equal(byId['leg-3'].quantity, 2);
    for (const i of g.body.items) assert.ok(Number.isFinite(i.quantity));

    const r = await call('post', '/spare-parts/leg-2/stock', OP, { type: 'IN', qty: 1 });
    assert.equal(r.body.item.quantity, 5);
    const stored = readDataSync('data_center/spare_parts.json', {}).items;
    assert.ok(stored.every(i => !('qty' in i) && !('stock' in i)), 'bogus keys dropped on save');
});

test('hardware issue spare-part usage deducts quantity once per usageId; insufficient stock -> issue not saved', async () => {
    const c = await call('post', '/spare-parts/items', OP, { name: 'Fan X', category: 'Fan', quantity: 3 });
    const partId = c.body.item.id;
    const qty = () => readDataSync('data_center/spare_parts.json', {}).items.find(i => i.id === partId).quantity;
    const issueCount = () => readDataSync('data_center/hw_issues.json', []).length;

    const created = await call('post', '/issues/single', OP, { deviceName: 'srv1', status: 'Open', sparePartUsage: { partId, qty: 2, usageId: 'u-1' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const issue = created.body.issue;
    assert.equal(qty(), 1);
    assert.equal(issue.sparePartUsages.length, 1);
    assert.equal(issue.sparePartUsages[0].usageId, 'u-1');
    assert.equal(issue.processNotes[0].status, 'Spare Part Used');
    assert.ok(!('sparePartUsage' in issue));
    const hist = readDataSync('data_center/spare_parts.json', {}).items.find(i => i.id === partId).history.at(-1);
    assert.equal(hist.type, 'OUT');
    assert.equal(hist.note, `Hardware Issue ${issue.id}`);

    // a retried create with the same usageId returns the issue already created: no second issue, no second deduction
    const issuesBeforeRetry = issueCount();
    const retried = await call('post', '/issues/single', OP, { deviceName: 'srv1', status: 'Open', sparePartUsage: { partId, qty: 2, usageId: 'u-1' } });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.issue.id, issue.id);
    assert.equal(issueCount(), issuesBeforeRetry);
    assert.equal(qty(), 1);

    // the same usage sent again (retry / second save) does not deduct again, other fields still save
    const again = await call('put', `/issues/${issue.id}`, OP, { ...issue, status: 'Processing', sparePartUsage: { partId, qty: 2, usageId: 'u-1' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.issue.status, 'Processing');
    assert.equal(qty(), 1);
    assert.equal(again.body.issue.sparePartUsages.length, 1);

    // the client cannot rewrite the recorded usages or the id
    const tamper = await call('put', `/issues/${issue.id}`, OP, { id: 'hw-other', sparePartUsages: [] });
    assert.equal(tamper.body.issue.id, issue.id);
    assert.equal(tamper.body.issue.sparePartUsages.length, 1);

    // insufficient stock: 400 and nothing saved
    const before = issueCount();
    const short = await call('post', '/issues/single', OP, { deviceName: 'srv2', sparePartUsage: { partId, qty: 5, usageId: 'u-2' } });
    assert.equal(short.status, 400);
    assert.equal(issueCount(), before);
    assert.equal(qty(), 1);
    const shortPut = await call('put', `/issues/${issue.id}`, OP, { status: 'Closed', sparePartUsage: { partId, qty: 5, usageId: 'u-3' } });
    assert.equal(shortPut.status, 400);
    assert.equal(readDataSync('data_center/hw_issues.json', []).find(i => i.id === issue.id).status, 'Processing');

    // unknown part -> 400
    assert.equal((await call('post', '/issues/single', OP, { deviceName: 'srv3', sparePartUsage: { partId: 'nope', qty: 1 } })).status, 400);

    // no usageId (old client): deducts, with a server-generated id
    const old = await call('put', `/issues/${issue.id}`, OP, { sparePartUsage: { partId, qty: 1 } });
    assert.equal(old.status, 200);
    assert.equal(qty(), 0);
    assert.equal(old.body.issue.sparePartUsages.length, 2);
    assert.ok(old.body.issue.sparePartUsages[1].usageId);
});
