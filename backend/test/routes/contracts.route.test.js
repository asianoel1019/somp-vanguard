// Contracts & Warranties: validated fields, server-owned stamps, stale edits refused, renewal links, trash rules,
// files stored by detected type, the device list of every data center, and the expiry notice selection / worker tick.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const model = require('../../lib/contractModel');

const tok = (name, role) => `Bearer ${signToken({ username: name, domain: 'corp', role, groups: ['g'] })}`;
const ALICE = tok('alice', 'Operator'), BOB = tok('bob', 'Operator'), VIEWER = tok('vic', 'Viewer'), ROOT = tok('root', 'SuperAdmin');
const KEY = 'data_center/contracts.json';
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;
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
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/rack', require('../../routes/rack'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { writeDataSync(KEY, []); audits.length = 0; });

const call = (method, url, token, body) => {
    const r = request(app)[method](`/api/rack${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
};
const stored = (id) => readDataSync(KEY, []).find(c => c.id === id);
const HW = { type: 'Hardware Warranties', name: 'ProSupport', vendor: 'Dell', serialNumber: 'SN1', startDate: '2026-01-01', endDate: '2027-01-01', cost: '1200', currency: 'USD', linkedDevices: ['dev-1', 'dev-1'] };
const SW = { type: 'Software Licenses', name: 'Windows Server', vendor: 'Microsoft', startDate: '2026-01-01', endDate: '2026-12-31', seats: '10', seatsUsed: '4', licenseKey: 'AAAA-BBBB' };

test('create: fields cleaned, server-owned keys dropped, creator and times stamped', async () => {
    const r = await call('post', '/contracts', ALICE, { ...HW, evil: 1, createdBy: 'mallory', savedFileName: '../x.pdf', renewedTo: 'x', licenseKey: 'only for software', seats: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.contract;
    assert.match(c.id, /^contract-/);
    assert.equal(c.createdBy, 'alice');
    assert.equal(c.updatedAt, c.createdAt);
    assert.equal(c.cost, 1200);
    assert.deepEqual(c.linkedDevices, ['dev-1'], 'duplicates removed');
    assert.equal(c.licenseKey, '', 'license fields cleared on a warranty');
    assert.equal(c.seats, '');
    assert.equal(c.savedFileName, null);
    assert.ok(!('evil' in c) && !('renewedTo' in c));
    assert.deepEqual(stored(c.id), c);
    assert.match(audits[0][2], /Added contract: ProSupport \(Dell\), 2026-01-01 to 2027-01-01/);
});

test('validation: type, required text, real dates in order, numbers, currency; Viewers cannot write', async () => {
    const bad = [
        [{ ...HW, type: 'license' }, /type must be one of/],
        [{ ...HW, name: '  ' }, /name is required/],
        [{ ...HW, vendor: '' }, /vendor is required/],
        [{ ...HW, startDate: '2026-02-30' }, /startDate must be a valid date/],
        [{ ...HW, endDate: '2025-12-31' }, /endDate must not be before startDate/],
        [{ ...HW, cost: '-1' }, /cost must be a number/],
        [{ ...SW, seats: '1.5' }, /seats must be a whole number/],
        [{ ...HW, currency: 'BTC' }, /currency must be one of/],
        [{ ...HW, linkedDevices: 'dev-1' }, /linkedDevices must be a list/],
        [{ ...HW, notes: 'x'.repeat(2001) }, /notes is limited to 2000/],
    ];
    for (const [body, re] of bad) {
        const r = await call('post', '/contracts', ALICE, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, re);
    }
    assert.equal((await call('post', '/contracts', VIEWER, HW)).status, 403);
    assert.deepEqual(readDataSync(KEY, []), []);
});

test('update: stale expectedUpdatedAt -> 409 with the current contract; unknown id -> 404; stamps kept', async () => {
    const c = (await call('post', '/contracts', ALICE, SW)).body.contract;
    const ok = await call('post', '/contracts', BOB, { ...c, seatsUsed: 6, expectedUpdatedAt: c.updatedAt, createdBy: 'mallory' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.contract.seatsUsed, 6);
    assert.equal(ok.body.contract.createdBy, 'alice');
    assert.equal(ok.body.contract.updatedBy, 'bob');

    const stale = await call('post', '/contracts', ALICE, { ...c, seatsUsed: 1, expectedUpdatedAt: c.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.contract.seatsUsed, 6);
    assert.equal(stored(c.id).seatsUsed, 6, 'nothing overwritten');

    assert.equal((await call('post', '/contracts', ALICE, { ...SW, id: 'contract-nope' })).status, 404);
});

test('renewal: the new term links back, the old one is marked renewed, and a second renewal is refused', async () => {
    const old = (await call('post', '/contracts', ALICE, HW)).body.contract;
    const r = await call('post', '/contracts', ALICE, { ...HW, startDate: '2027-01-02', endDate: '2028-01-01', renewedFrom: old.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.contract.renewedFrom, old.id);
    assert.equal(stored(old.id).renewedTo, r.body.contract.id);
    assert.match(audits.at(-1)[2], /Renewed contract ProSupport/);
    assert.equal((await call('post', '/contracts', ALICE, { ...HW, renewedFrom: old.id })).status, 409);
    assert.equal((await call('post', '/contracts', ALICE, { ...HW, renewedFrom: 'missing' })).status, 404);
});

test('trash: 404 for unknown ids, editing a trashed contract refused, force delete only from the trash by SuperAdmin', async () => {
    const old = (await call('post', '/contracts', ALICE, HW)).body.contract;
    const renewed = (await call('post', '/contracts', ALICE, { ...HW, startDate: '2027-01-02', endDate: '2028-01-01', renewedFrom: old.id })).body.contract;
    assert.equal((await call('delete', '/contracts/nope', ALICE)).status, 404);
    assert.equal((await call('post', '/contracts/nope/restore', ALICE)).status, 404);
    assert.equal((await call('delete', `/contracts/${renewed.id}/force`, ROOT)).status, 400, 'not in the trash yet');

    const t = await call('delete', `/contracts/${renewed.id}`, ALICE);
    assert.equal(t.status, 200);
    assert.ok(stored(renewed.id).deletedAt);
    assert.equal(stored(renewed.id).deletedBy, 'alice');
    assert.equal((await call('post', '/contracts', ALICE, { ...renewed })).status, 400, 'restore first');

    assert.equal((await call('delete', `/contracts/${renewed.id}/force`, ALICE)).status, 403);
    assert.equal((await call('delete', `/contracts/${renewed.id}/force`, ROOT)).status, 200);
    assert.equal(stored(renewed.id), undefined);
    assert.equal(stored(old.id).renewedTo, undefined, 'the renewed contract is current again');

    await call('delete', `/contracts/${old.id}`, ALICE);
    const back = await call('post', `/contracts/${old.id}/restore`, BOB);
    assert.equal(back.status, 200);
    assert.equal(stored(old.id).deletedAt, undefined);
});

test('files: stored under an ASCII name with the detected type, original name kept, replaced file removed, wrong type refused', async () => {
    const dir = path.join(process.env.DB_DATA_DIR, 'data_center', 'licenses');
    const bad = await call('post', '/contracts', ALICE, { ...SW, fileBase64: `data:text/plain;base64,${Buffer.from('-----BEGIN CERT').toString('base64')}`, originalFileName: 'key.pem' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Only PDF, DOCX, PNG and JPG/);

    const r = await call('post', '/contracts', ALICE, { ...SW, fileBase64: PDF, originalFileName: 'C:\\docs\\授權合約 2026' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.contract;
    assert.match(c.savedFileName, /^\d+_[0-9a-f]{8}\.pdf$/);
    assert.equal(c.originalFileName, '授權合約 2026');
    assert.equal(c.fileType, 'application/pdf');
    assert.ok(fs.existsSync(path.join(dir, c.savedFileName)));

    const dl = await call('get', `/contracts/download/${c.savedFileName}`, VIEWER);
    assert.equal(dl.status, 200);
    assert.equal((await call('get', '/contracts/download/123_unknown.pdf', VIEWER)).status, 404);

    const r2 = await call('post', '/contracts', ALICE, { ...c, fileBase64: PDF, originalFileName: 'new.pdf', expectedUpdatedAt: c.updatedAt });
    assert.equal(r2.status, 200);
    assert.notEqual(r2.body.contract.savedFileName, c.savedFileName);
    assert.ok(!fs.existsSync(path.join(dir, c.savedFileName)), 'the replaced file is removed');

    const r3 = await call('post', '/contracts', ALICE, { ...r2.body.contract, removeFile: true });
    assert.equal(r3.body.contract.savedFileName, null);
    assert.ok(!fs.existsSync(path.join(dir, r2.body.contract.savedFileName)));
});

test('devices: every data center, with rack and DC names; shelves and patch panels left out', async () => {
    writeDataSync('data_center/datacenters.json', [{ id: 'default', name: 'Main DC' }, { id: 'dc2', name: 'Backup DC' }]);
    writeDataSync('data_center/server_rack.json', [{ id: 'r1', name: 'A01', devices: [{ id: 'd1', hostname: 'SRV01', sn: 'SN1', u: 10, type: 'Server' }, { id: 'p1', type: 'PatchPanel', u: 1 }] }]);
    writeDataSync('data_center/server_rack_dc2.json', [{ id: 'r9', name: 'B01', devices: [{ id: 'd2', hostname: 'SW01', model: 'X', u: 40, type: 'Switch' }] }]);
    const r = await call('get', '/contracts/devices', VIEWER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(d => [d.id, d.hostname, d.dcName, d.rackName]), [['d1', 'SRV01', 'Main DC', 'A01'], ['d2', 'SW01', 'Backup DC', 'B01']]);
});

// ---- expiry notices ---------------------------------------------------------------------------------------------

const NOW = new Date(2026, 10, 13, 10, 0);
const ymd = (offset) => { const d = new Date(2026, 10, 13 + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const C = (id, endOffset, extra = {}) => ({ id, name: id, vendor: 'V', type: 'Hardware Warranties', startDate: '2020-01-01', endDate: ymd(endOffset), ...extra });

test('daysLeft: calendar days, 0 on the last day, invalid dates -> null', () => {
    assert.equal(model.daysLeft(ymd(0), NOW), 0);
    assert.equal(model.daysLeft(ymd(30), NOW), 30);
    assert.equal(model.daysLeft(ymd(-2), NOW), -2);
    assert.equal(model.daysLeft('2026-13-01', NOW), null);
    assert.deepEqual(model.parseNotifyDays(''), [60, 30, 7]);
    assert.deepEqual(model.parseNotifyDays('7, 30,x,30'), [30, 7]);
    assert.deepEqual(model.parseNotifyDays('off'), []);
});

test('dueNotices: one notice per contract at the closest day reached, never repeated, restarted by a new end date', () => {
    const days = [60, 30, 7];
    const list = [C('a', 45), C('b', 5), C('c', 90), C('d', -3), C('e', -30), C('f', 5, { renewedTo: 'x' }), C('g', 5, { deletedAt: 'x' })];
    const first = model.dueNotices(list, {}, NOW, days);
    assert.deepEqual(first.notices.map(n => [n.contract.id, n.kind, n.threshold]), [['a', 'expiring', 60], ['b', 'expiring', 7], ['d', 'expired', 0]]);
    assert.deepEqual(first.state.b.sent, [60, 30, 7]);
    assert.equal(first.state.e.expired, true, 'an old expiry is recorded silently');
    assert.ok(!first.state.f && !first.state.g);

    const again = model.dueNotices(list, first.state, NOW, days);
    assert.equal(again.notices.length, 0);
    assert.equal(again.changed, false);

    const later = model.dueNotices(list, first.state, new Date(2026, 10, 13 + 16, 10), days);
    // 16 days on: a (29 left) reaches 30; b expired 11 days ago, beyond the expired-notice window, so it stays quiet
    assert.deepEqual(later.notices.map(n => [n.contract.id, n.threshold]), [['a', 30]]);
    assert.equal(later.state.b.expired, true);

    const moved = model.dueNotices([C('b', 400)], first.state, NOW, days);
    assert.equal(moved.notices.length, 0);
    assert.deepEqual(moved.state.b.sent, [], 'a new end date starts over');
    assert.equal(moved.changed, true);
    assert.match(model.noticeMessage(first.notices), /3 contract\(s\) need renewal\n⛔[^\n]*d \(V\): expired[\s\S]*b \(V\): ends/);
});

test('notifier tick: sends one message, records it, skips before the hour and when disabled', async () => {
    const logger = require('../../lib/logger');
    const sent = [];
    const orig = logger.sendTelegramAlert;
    logger.sendTelegramAlert = async (msg, mod) => { sent.push([mod, msg]); };
    const notifier = require('../../services/contractExpiryNotifier');
    try {
        writeDataSync(KEY, [C('a', 7), C('b', 100)]);
        writeDataSync(notifier.STATE_KEY, {});
        process.env.CONTRACT_NOTIFY_DAYS = '';
        delete process.env.CONTRACT_NOTIFY_HOUR;
        assert.deepEqual(await notifier.tick(new Date(2026, 10, 13, 8, 0)), { skipped: 'too-early' });
        assert.deepEqual(await notifier.tick(NOW), { notices: 1 });
        assert.equal(sent.length, 1);
        assert.equal(sent[0][0], 'Contracts & Warranties');
        assert.match(sent[0][1], /a \(V\).*7 day\(s\) left/);
        assert.deepEqual(await notifier.tick(NOW), { notices: 0 });
        assert.deepEqual(readDataSync(notifier.STATE_KEY, {}).a.sent, [60, 30, 7]);
        process.env.CONTRACT_NOTIFY_DAYS = 'off';
        assert.deepEqual(await notifier.tick(NOW), { skipped: 'disabled' });
    } finally {
        logger.sendTelegramAlert = orig;
        delete process.env.CONTRACT_NOTIFY_DAYS;
    }
});
