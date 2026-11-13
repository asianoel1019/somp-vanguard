// Spare parts: validated fields, movement reasons with optional serial numbers, stock counts, the restock rule,
// catalog bulk add, category rename / guarded removal, delete rules and stale edits.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const model = require('../../lib/sparePartModel');

const tok = (name, role) => `Bearer ${signToken({ username: name, domain: 'corp', role, groups: ['g'] })}`;
const OP = tok('alice', 'Operator'), BOB = tok('bob', 'Operator'), VIEWER = tok('vic', 'Viewer'), ROOT = tok('root', 'SuperAdmin');
const KEY = 'data_center/spare_parts.json';
let app;
const audits = [];

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } },
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dataCenter: true } },
        },
    });
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    app = express();
    app.use(express.json());
    app.use('/api/rack', require('../../routes/rack'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { writeDataSync(KEY, { categories: ['Memory', 'SSD'], items: [] }); audits.length = 0; });

const call = (method, url, token, body) => {
    const r = request(app)[method](`/api/rack${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
};
const doc = () => readDataSync(KEY, {});
const part = (id) => doc().items.find(i => i.id === id);
const RAM = { name: '32GB DDR4-3200 RDIMM', category: 'Memory', vendor: 'Dell', partNumber: 'P/N-1', condition: 'New', currency: 'USD', unitPrice: '120', minStock: 2, reorderQty: 4, compatibleWith: 'R650, R750' };

test('create: fields cleaned, stamps set, initial stock with serials recorded as the first movement', async () => {
    const r = await call('post', '/spare-parts/items', OP, { ...RAM, quantity: 3, serials: 'S1, S2\nS2', history: [{ forged: 1 }], updatedBy: 'x', evil: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const i = r.body.item;
    assert.equal(i.quantity, 3);
    assert.equal(i.unitPrice, 120);
    assert.equal(i.currency, 'USD');
    assert.equal(i.createdBy, 'alice');
    assert.deepEqual(i.serials, ['S1', 'S2']);
    assert.equal(i.history.length, 1);
    assert.deepEqual([i.history[0].type, i.history[0].reason, i.history[0].before, i.history[0].after], ['IN', 'Initial stock', 0, 3]);
    assert.ok(!('evil' in i));
    assert.ok(doc().categories.includes('Memory'));

    const bad = [
        [{ ...RAM, condition: 'Broken' }, /condition must be one of/],
        [{ ...RAM, currency: 'BTC' }, /currency must be one of/],
        [{ ...RAM, minStock: -1 }, /minStock must be a whole number/],
        [{ ...RAM, notes: 'x'.repeat(2001) }, /notes is limited/],
        [{ ...RAM, quantity: 1, serials: 'A,B' }, /2 serial numbers given for 1/],
    ];
    for (const [body, re] of bad) {
        const res = await call('post', '/spare-parts/items', OP, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.body.error, re);
    }
    assert.equal((await call('post', '/spare-parts/items', VIEWER, RAM)).status, 403);
});

test('movements: reasons per direction, serials in and out, linked issue', async () => {
    const id = (await call('post', '/spare-parts/items', OP, { ...RAM, quantity: 2, serials: ['S1'] })).body.item.id;
    const inn = await call('post', `/spare-parts/${id}/stock`, OP, { type: 'IN', qty: 2, reason: 'RMA replacement', serials: ['S9'], note: 'case 123' });
    assert.equal(inn.status, 200, JSON.stringify(inn.body));
    assert.deepEqual(part(id).serials, ['S1', 'S9']);
    assert.equal(part(id).history.at(-1).reason, 'RMA replacement');

    assert.match((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'IN', qty: 1, reason: 'Repair' })).body.error, /reason must be one of/);
    assert.match((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'IN', qty: 1, serials: ['S1'] })).body.error, /S1 is already in stock/);
    assert.match((await call('post', `/spare-parts/${id}/stock`, OP, { type: 'OUT', qty: 1, serials: ['NOPE'] })).body.error, /NOPE is not in stock/);

    const out = await call('post', `/spare-parts/${id}/stock`, OP, { type: 'OUT', qty: 1, reason: 'Repair', issueId: 'hw-1', serials: ['S9'] });
    assert.equal(out.status, 200);
    const h = part(id).history.at(-1);
    assert.deepEqual([h.type, h.reason, h.issueId, h.before, h.after], ['OUT', 'Repair', 'hw-1', 4, 3]);
    assert.deepEqual(h.serials, ['S9']);
    assert.deepEqual(part(id).serials, ['S1']);
    assert.equal(part(id).updatedBy, 'alice');
});

test('stock count: the counted quantity replaces the stored one and the difference is recorded', async () => {
    const id = (await call('post', '/spare-parts/items', OP, { ...RAM, quantity: 5, serials: ['A', 'B', 'C'] })).body.item.id;
    const r = await call('post', `/spare-parts/${id}/count`, BOB, { actual: 2, note: 'Q4 count' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = part(id).history.at(-1);
    assert.deepEqual([h.type, h.qty, h.before, h.after, h.user, h.note], ['COUNT', -3, 5, 2, 'bob', 'Q4 count']);
    assert.equal(part(id).serials.length, 2, 'serial list trimmed to the count');
    await call('post', `/spare-parts/${id}/count`, BOB, { actual: '4', serials: 'X1,X2' });
    assert.deepEqual([part(id).quantity, part(id).serials], [4, ['X1', 'X2']]);
    assert.equal((await call('post', `/spare-parts/${id}/count`, BOB, { actual: -1 })).status, 400);
    assert.equal((await call('post', '/spare-parts/nope/count', BOB, { actual: 1 })).status, 404);
});

test('restock rule: at or below the minimum is low, none left is out', () => {
    assert.equal(model.stockStatus({ quantity: 0, minStock: 0 }), 'Out');
    assert.equal(model.stockStatus({ quantity: 2, minStock: 2 }), 'Low');
    assert.equal(model.stockStatus({ quantity: 3, minStock: 2 }), 'OK');
    assert.equal(model.needsRestock({ quantity: 2, minStock: 2 }), true);
    assert.equal(model.needsRestock({ quantity: 0, minStock: 0 }), false, 'no minimum set: nothing to reorder');
});

test('bulk add from the catalog: all or nothing, new categories added', async () => {
    const bad = await call('post', '/spare-parts/items/bulk', OP, { items: [RAM, { ...RAM, name: '' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Part 2: name is required/);
    assert.equal(doc().items.length, 0);

    const r = await call('post', '/spare-parts/items/bulk', OP, { items: [RAM, { name: 'SFP+ 10G SR', category: 'Transceiver', minStock: 4 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 2);
    assert.notEqual(r.body.items[0].id, r.body.items[1].id);
    assert.ok(doc().categories.includes('Transceiver'));
    assert.equal((await call('post', '/spare-parts/items/bulk', OP, { items: [] })).status, 400);
});

test('categories: rename moves items; a category with items cannot be removed', async () => {
    const id = (await call('post', '/spare-parts/items', OP, RAM)).body.item.id;
    const drop = await call('put', '/spare-parts/categories', OP, { categories: ['SSD'] });
    assert.equal(drop.status, 400);
    assert.match(drop.body.error, /"Memory" still has spare parts/);

    const r = await call('post', '/spare-parts/categories/rename', OP, { from: 'Memory', to: 'RAM' });
    assert.equal(r.status, 200);
    assert.equal(r.body.moved, 1);
    assert.equal(part(id).category, 'RAM');
    assert.deepEqual(doc().categories, ['RAM', 'SSD']);
    const merge = await call('post', '/spare-parts/categories/rename', OP, { from: 'RAM', to: 'SSD' });
    assert.deepEqual(merge.body.categories, ['SSD']);
    assert.equal((await call('post', '/spare-parts/categories/rename', OP, { from: 'Nope', to: 'X' })).status, 404);
});

test('edit: stale expectedUpdatedAt -> 409 with the current item; delete with stock needs a SuperAdmin', async () => {
    const item = (await call('post', '/spare-parts/items', OP, { ...RAM, quantity: 1 })).body.item;
    const ok = await call('patch', `/spare-parts/${item.id}`, BOB, { location: 'Cage 2 Bin 4', expectedUpdatedAt: item.updatedAt });
    assert.equal(ok.status, 200);
    const stale = await call('patch', `/spare-parts/${item.id}`, OP, { location: 'x', expectedUpdatedAt: item.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.item.location, 'Cage 2 Bin 4');

    assert.equal((await call('delete', `/spare-parts/${item.id}`, OP)).status, 403);
    assert.equal((await call('delete', `/spare-parts/${item.id}`, VIEWER)).status, 403);
    assert.equal((await call('delete', `/spare-parts/${item.id}`, ROOT)).status, 200);
    assert.equal(part(item.id), undefined);

    const empty = (await call('post', '/spare-parts/items', OP, RAM)).body.item;
    assert.equal((await call('delete', `/spare-parts/${empty.id}`, OP)).status, 200);
    assert.equal((await call('delete', '/spare-parts/nope', OP)).status, 404);
});

test('hardware issue usage is booked as a repair with the issue id; the issue keeps the part name', async () => {
    writeDataSync('data_center/hw_issues.json', []);
    const id = (await call('post', '/spare-parts/items', OP, { ...RAM, quantity: 3 })).body.item.id;
    const r = await call('post', '/issues/single', OP, { deviceName: 'srv1', sparePartUsage: { partId: id, qty: 1, usageId: 'u-9' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = part(id).history.at(-1);
    assert.deepEqual([h.type, h.reason, h.issueId], ['OUT', 'Repair', r.body.issue.id]);
    assert.equal(r.body.issue.sparePartUsages[0].partName, RAM.name);
});
