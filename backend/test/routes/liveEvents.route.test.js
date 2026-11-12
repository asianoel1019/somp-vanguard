// Live Event Viewer: the default view never reads archives unless asked; searches walk the table backwards in
// windows and say whether they covered all of it; the manual rotation does not run inside the request; the Vacuum
// button refuses large SQLite files.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const db = require('../../services/scoutDb');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const OP = `Bearer ${signToken({ username: 'op1', domain: 'corp', role: 'Operator', groups: ['g'] })}`;
let app;
let monitor;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { monitorWinEvent: true, monitorLinuxLog: true } } },
    });
    monitor = require('../../routes/monitor');
    app = express();
    app.use(express.json());
    app.use('/api/monitor', monitor);
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { db.run('DELETE FROM windows_events'); });

function addEvents(n, prefix, message = 'logon ok') {
    for (let i = 0; i < n; i++) {
        db.run('INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [`${prefix}${i}`, 'host01', 'Information', 4624, 'p', typeof message === 'function' ? message(i) : message, '{}', new Date(Date.UTC(2026, 10, 12, 0, 0, i)).toISOString()]);
    }
}

test('default view: newest rows only; archives only with archives=1', async () => {
    addEvents(3, 'hot');
    const dir = path.join(process.env.DB_DATA_DIR, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive_windows_events_2026-10-01_1.json.gz'), zlib.gzipSync(JSON.stringify([{ id: 'cold0', message: 'old' }])));
    const r = await request(app).get('/api/monitor/winevent/live').set('Authorization', OP).expect(200);
    assert.deepEqual(r.body.map(e => e.id), ['hot2', 'hot1', 'hot0']);
    const withArchives = await request(app).get('/api/monitor/winevent/live').query({ archives: '1' }).set('Authorization', OP).expect(200);
    assert.deepEqual(withArchives.body.map(e => e.id), ['hot2', 'hot1', 'hot0', 'cold0']);
});

test('search walks the table backwards in windows, newest first, and says when it covered everything', async () => {
    addEvents(25, 'e', (i) => (i % 5 === 0 ? 'logon FAILED' : 'logon ok'));
    const { searchHotTable } = monitor._test;
    const all = await searchHotTable('windows_events', 'message LIKE ?', ['%FAILED%'], { limit: 10, windowRows: 4 });
    assert.deepEqual(all.rows.map(r => r.id), ['e20', 'e15', 'e10', 'e5', 'e0']);
    assert.equal(all.complete, true);
    const limited = await searchHotTable('windows_events', 'message LIKE ?', ['%FAILED%'], { limit: 2, windowRows: 4 });
    assert.deepEqual(limited.rows.map(r => r.id), ['e20', 'e15']);
    const outOfTime = await searchHotTable('windows_events', 'message LIKE ?', ['%nothing%'], { limit: 10, windowRows: 4, budgetMs: -1 });
    assert.equal(outOfTime.complete, false, 'stopped by the time budget before reaching the oldest row');

    const r = await request(app).get('/api/monitor/winevent/live').query({ search: 'FAILED' }).set('Authorization', OP).expect(200);
    assert.equal(r.body.length, 5);
    assert.equal(r.headers['x-search-complete'], 'true');
});

test('Run now returns at once; the rotation runs in the background', async () => {
    const r = await request(app).post('/api/monitor/logrotation/run').set('Authorization', OP).expect(200);
    assert.equal(r.body.started, 'local', 'no worker in tests: runs in this process, not inside the request');
    await require('../../services/logRotation').runLogRotation();
});

test('Vacuum refuses a large SQLite file', async (t) => {
    const driver = dbManager.getDriver();
    t.mock.method(fs, 'statSync', (p, ...rest) => (p === driver.dbFile ? { size: 24 * 1024 ** 3 } : fs.statSync.call(fs, p, ...rest)));
    const r = await request(app).post('/api/monitor/vacuum').set('Authorization', OP).expect(409);
    assert.match(r.body.error, /24\.0 GB.*scoutDbOptimize\.bat/);
});
