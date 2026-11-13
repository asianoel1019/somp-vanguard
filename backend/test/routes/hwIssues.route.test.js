// Hardware issues: the server owns the timeline (time and user stamped here, entries only added), status changes are
// always recorded, fields are validated, a stale edit is refused instead of overwriting, closedAt follows the status.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');

const tok = (name, role) => `Bearer ${signToken({ username: name, domain: 'corp', role, groups: ['g'] })}`;
const ALICE = tok('alice', 'Operator'), BOB = tok('bob', 'Operator'), VIEWER = tok('vic', 'Viewer');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
let app;
const audits = [];

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } } },
    });
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    app = express();
    app.use(express.json());
    app.use('/api/rack', require('../../routes/rack'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { writeDataSync('data_center/hw_issues.json', []); });

const call = (method, url, token, body) => {
    const r = request(app)[method](`/api/rack${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
};
const stored = (id) => readDataSync('data_center/hw_issues.json', []).find(i => i.id === id);
const BASE = { date: '2026-11-13', datacenter: 'DC-A', deviceName: 'SRV01', sn: 'SN123', rackLoc: 'R1 - U10', failedParts: 'PSU', urgency: 'H' };

test('create: unknown and server-owned fields are dropped, defaults filled, creator and times recorded', async () => {
    const r = await call('post', '/issues/single', ALICE, {
        ...BASE, id: 'hw-chosen', reporter: '', status: undefined, evil: 1, createdBy: 'mallory', closedAt: 'x',
        processNotes: [{ timestamp: '2020-01-01', user: 'ceo', status: 'Closed', note: 'forged' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const i = r.body.issue;
    assert.notEqual(i.id, 'hw-chosen');
    assert.equal(i.reporter, 'alice', 'empty reporter -> the signed-in user');
    assert.equal(i.status, 'Open');
    assert.equal(i.createdBy, 'alice');
    assert.match(i.createdAt, ISO);
    assert.equal(i.updatedAt, i.createdAt);
    assert.deepEqual(i.processNotes, [], 'no client timeline');
    assert.ok(!('evil' in i) && !('closedAt' in i));
});

test('validation: required device, enums, date format and lengths; Viewers cannot write', async () => {
    const bad = [
        [{ ...BASE, deviceName: '  ' }, /deviceName is required/],
        [{ ...BASE, urgency: 'X' }, /urgency/],
        [{ ...BASE, status: 'Done' }, /status/],
        [{ ...BASE, date: '13/11/2026' }, /YYYY-MM-DD/],
        [{ ...BASE, failedParts: 'x'.repeat(1001) }, /failedParts is limited/],
        [{ ...BASE, sn: { $ne: 1 } }, /sn must be text/],
    ];
    for (const [body, msg] of bad) {
        const r = await call('post', '/issues/single', ALICE, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, msg);
    }
    assert.equal((await call('post', '/issues/single', VIEWER, BASE)).status, 403);
    assert.equal(readDataSync('data_center/hw_issues.json', []).length, 0);
});

test('timeline: entries stamped by the server, only added; a forged timeline in an edit is ignored', async () => {
    const id = (await call('post', '/issues/single', ALICE, BASE)).body.issue.id;
    const n1 = await call('post', `/issues/${id}/notes`, BOB, { type: 'Note', note: 'Vendor called', user: 'ceo', timestamp: '1999' });
    assert.equal(n1.status, 200, JSON.stringify(n1.body));
    const e = n1.body.issue.processNotes[0];
    assert.equal(e.user, 'bob');
    assert.equal(e.status, 'General Note');
    assert.equal(e.note, 'Vendor called');
    assert.match(e.timestamp, ISO);

    // a full-form save carrying an edited / emptied timeline keeps the stored one
    const edit = await call('put', `/issues/${id}`, ALICE, { ...n1.body.issue, failedParts: 'PSU + fan', processNotes: [] });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.issue.failedParts, 'PSU + fan');
    assert.equal(stored(id).processNotes.length, 1);
    assert.equal(stored(id).processNotes[0].user, 'bob');

    for (const [body, code] of [[{ type: 'Note', note: '  ' }, 400], [{ type: 'Bogus', note: 'x' }, 400], [{ note: 'x'.repeat(2001) }, 400]]) {
        assert.equal((await call('post', `/issues/${id}/notes`, ALICE, body)).status, code, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await call('post', '/issues/hw-none/notes', ALICE, { note: 'x' })).status, 404);
    assert.equal((await call('post', `/issues/${id}/notes`, VIEWER, { note: 'x' })).status, 403);
});

test('two people adding notes at once both keep theirs (the server appends to the stored issue)', async () => {
    const id = (await call('post', '/issues/single', ALICE, BASE)).body.issue.id;
    await Promise.all([
        call('post', `/issues/${id}/notes`, ALICE, { note: 'from alice' }),
        call('post', `/issues/${id}/notes`, BOB, { note: 'from bob' }),
    ]);
    assert.deepEqual(stored(id).processNotes.map(n => n.note).sort(), ['from alice', 'from bob']);
});

test('status: changes are recorded on the timeline; closedAt is set on close and cleared on reopen', async () => {
    const id = (await call('post', '/issues/single', ALICE, BASE)).body.issue.id;
    const p = await call('post', `/issues/${id}/notes`, BOB, { type: 'Processing', note: 'RMA opened' });
    assert.equal(p.body.issue.status, 'Processing');
    assert.deepEqual([p.body.issue.processNotes[0].status, p.body.issue.processNotes[0].note], ['Processing', 'RMA opened']);
    assert.ok(!('closedAt' in p.body.issue));

    const c = await call('post', `/issues/${id}/notes`, BOB, { type: 'Closed', note: 'PSU replaced' });
    assert.equal(c.body.issue.status, 'Closed');
    assert.match(c.body.issue.closedAt, ISO);

    // a status change through the form is recorded too
    const reopen = await call('put', `/issues/${id}`, ALICE, { status: 'Open' });
    assert.equal(reopen.body.issue.status, 'Open');
    assert.ok(!('closedAt' in reopen.body.issue));
    const e = reopen.body.issue.processNotes[0];
    assert.deepEqual([e.user, e.status, e.note], ['alice', 'Open', 'Status changed from Closed to Open']);
    // saving the form without a status change adds nothing
    const same = await call('put', `/issues/${id}`, ALICE, { status: 'Open', rackLoc: 'R2 - U1' });
    assert.equal(same.body.issue.processNotes.length, reopen.body.issue.processNotes.length);
});

test('a stale edit is refused with 409 and the current issue; a fresh one saves', async () => {
    const created = (await call('post', '/issues/single', ALICE, BASE)).body.issue;
    const bobSaved = await call('put', `/issues/${created.id}`, BOB, { failedParts: 'Disk', expectedUpdatedAt: created.updatedAt });
    assert.equal(bobSaved.status, 200);
    const stale = await call('put', `/issues/${created.id}`, ALICE, { failedParts: 'Fan', expectedUpdatedAt: created.updatedAt });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed by someone else/);
    assert.equal(stale.body.issue.failedParts, 'Disk');
    assert.equal(stored(created.id).failedParts, 'Disk');
    const fresh = await call('put', `/issues/${created.id}`, ALICE, { failedParts: 'Fan', expectedUpdatedAt: stale.body.issue.updatedAt });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.issue.failedParts, 'Fan');
    // issues saved before updatedAt existed (and old clients without expectedUpdatedAt) still save
    writeDataSync('data_center/hw_issues.json', [{ id: 'hw-legacy', deviceName: 'OLD', status: 'Open', processNotes: '[2024/1/2 10:00] Processing: RMA sent\nfree text line' }]);
    const legacy = await call('put', '/issues/hw-legacy', ALICE, { failedParts: 'RAM', expectedUpdatedAt: 'whatever' });
    assert.equal(legacy.status, 200);
    assert.match(legacy.body.issue.updatedAt, ISO);
    // the old text timeline is kept, as entries
    assert.deepEqual(legacy.body.issue.processNotes.map(n => [n.status, n.note]), [['Processing', 'RMA sent'], ['Legacy Note', 'free text line']]);
    const noted = await call('post', '/issues/hw-legacy/notes', ALICE, { note: 'new' });
    assert.deepEqual(noted.body.issue.processNotes.map(n => n.note), ['new', 'RMA sent', 'free text line']);
});

test('assignee, RMA number, due date, device / rack ids are kept; due date and resolution are validated', async () => {
    const r = await call('post', '/issues/single', ALICE, { ...BASE, assignee: 'bob', rmaNumber: 'RMA-778', dueDate: '2026-11-20', deviceId: 'dev-1', rackId: 'rack-9' });
    assert.equal(r.status, 200);
    const i = r.body.issue;
    assert.deepEqual([i.assignee, i.rmaNumber, i.dueDate, i.deviceId, i.rackId], ['bob', 'RMA-778', '2026-11-20', 'dev-1', 'rack-9']);
    assert.match((await call('post', '/issues/single', ALICE, { ...BASE, dueDate: 'next week' })).body.error, /dueDate must be YYYY-MM-DD/);
    assert.match((await call('put', `/issues/${i.id}`, ALICE, { resolution: 'Magic' })).body.error, /resolution must be one of/);
});

test('closing records the resolution; reopening clears it; it can only be given when closing', async () => {
    const id = (await call('post', '/issues/single', ALICE, BASE)).body.issue.id;
    assert.match((await call('post', `/issues/${id}/notes`, BOB, { type: 'Processing', note: 'x', resolution: 'Part replaced' })).body.error, /only set when closing/);
    assert.equal((await call('post', `/issues/${id}/notes`, BOB, { type: 'Closed', note: 'swapped', resolution: 'Bogus' })).status, 400);
    assert.equal(stored(id).status, 'Open', 'a refused close changes nothing');
    const c = await call('post', `/issues/${id}/notes`, BOB, { type: 'Closed', note: 'swapped', resolution: 'Part replaced' });
    assert.equal(c.body.issue.resolution, 'Part replaced');
    const r = await call('post', `/issues/${id}/notes`, ALICE, { type: 'Open', note: 'failed again' });
    assert.equal(r.body.issue.status, 'Open');
    assert.ok(!('resolution' in r.body.issue));
    // an open issue cannot carry a resolution through the form either
    const f = await call('put', `/issues/${id}`, ALICE, { resolution: 'Other' });
    assert.ok(!('resolution' in f.body.issue));
});

test('audit / Telegram lines describe the issue; High urgency is flagged; closing gives the resolution and days open', async () => {
    audits.length = 0;
    const id = (await call('post', '/issues/single', ALICE, { ...BASE, assignee: 'bob' })).body.issue.id;
    assert.match(audits.at(-1)[2], new RegExp(`^Reported Issue ${id}: 🚨 SRV01 \\(DC-A, R1 - U10\\): PSU; urgency High; assignee bob$`));
    await call('post', `/issues/${id}/notes`, BOB, { type: 'Closed', note: 'PSU replaced', resolution: 'Part replaced' });
    assert.match(audits.at(-1)[2], new RegExp(`^Closed Issue ${id}: SRV01 \\(DC-A\\); resolution Part replaced; open 0 day\\(s\\); PSU replaced$`));
    const low = (await call('post', '/issues/single', ALICE, { ...BASE, urgency: 'L' })).body.issue.id;
    assert.ok(!audits.at(-1)[2].includes('🚨'), 'only High is flagged');
    await call('post', `/issues/${low}/notes`, ALICE, { note: 'checked' });
    assert.equal(audits.at(-1)[2], `Added a note to Issue ${low} (SRV01)`);
});
