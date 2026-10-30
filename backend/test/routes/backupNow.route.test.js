const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');

process.env.DB_BACKUP_PATH = path.join(dataDir, 'route_backups');

const dbManager = require('../../services/db');
const { encryptText } = require('../../lib/crypto');
const { LAST_RESULT_KEY, readLastResult, writeLastResult } = require('../../services/backupService');
const settingsRouter = require('../../routes/apiSettings');

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);
const superAdmin = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
const viewer = `Bearer ${signToken({ username: 'bob', domain: 'local', role: 'User' })}`;

test.before(async () => {
    await dbManager.initDB();
    encryptText('make sure .system_key exists');
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=enc:abc\n');
});
test.beforeEach(async () => { await writeLastResult({}); });
test.after(async () => { delete global.sendWorkerMessage; await dbManager.closeDB(); });

async function waitForFinish(timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const s = await readLastResult();
        if (s.finishedAt) return s;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('backup did not finish in time');
}

test('POST /backup-now returns 202, records the started status and sends the IPC message', async () => {
    const sent = [];
    global.sendWorkerMessage = (msg) => { if (msg.type === 'RUN_BACKUP_NOW') sent.push(msg); return true; };
    const res = await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
    assert.ok(res.body.requestId && res.body.startedAt);
    assert.deepEqual(sent, [{ type: 'RUN_BACKUP_NOW', requestId: res.body.requestId, requestedBy: 'admin' }]);

    const status = await request(app).get('/api/settings/backup-status').set('Authorization', superAdmin).expect(200);
    assert.equal(status.body.requestId, res.body.requestId);
    assert.equal(status.body.startedAt, res.body.startedAt);
    assert.equal(status.body.finishedAt, null);
    assert.equal(status.body.requestedBy, 'admin');
});

test('a second POST while a backup is running returns 409 and sends nothing', async () => {
    const sent = [];
    global.sendWorkerMessage = (msg) => { if (msg.type === 'RUN_BACKUP_NOW') sent.push(msg); return true; };
    await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
    const res = await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(409);
    assert.equal(res.body.error, 'A backup is already running.');
    assert.equal(sent.length, 1);
});

test('a stale "running" status (older than 30 minutes) does not block a new backup', async () => {
    global.sendWorkerMessage = () => true;
    await writeLastResult({ requestId: 'old', requestedBy: 'x', startedAt: new Date(Date.now() - 31 * 60000).toISOString(), finishedAt: null });
    await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
});

test('GET /backup-status returns {} when nothing has run', async () => {
    const res = await request(app).get('/api/settings/backup-status').set('Authorization', superAdmin).expect(200);
    assert.deepEqual(res.body, {});
});

test('with ENABLE_EMBEDDED_WORKER=false the backup runs in-process and the status gets finishedAt and items', async (t) => {
    delete global.sendWorkerMessage;
    process.env.ENABLE_EMBEDDED_WORKER = 'false';
    t.after(() => { delete process.env.ENABLE_EMBEDDED_WORKER; });
    const res = await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
    const done = await waitForFinish();
    assert.equal(done.requestId, res.body.requestId);
    assert.equal(done.requestedBy, 'admin');
    assert.equal(done.dir, process.env.DB_BACKUP_PATH);
    assert.ok(done.items.length >= 3);
    assert.deepEqual(done.items.filter(i => !i.ok), []);
    const viaApi = await request(app).get('/api/settings/backup-status').set('Authorization', superAdmin).expect(200);
    assert.ok(viaApi.body.finishedAt);
});

test('non-SuperAdmin is rejected with 403', async () => {
    await request(app).post('/api/settings/backup-now').set('Authorization', viewer).expect(403);
    await request(app).get('/api/settings/backup-status').set('Authorization', viewer).expect(403);
});

test('status written only by another process (scout document_store, no RAM cache) is visible and clears the running state', async () => {
    global.sendWorkerMessage = () => true;
    const res = await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
    // what the worker does: write through dbManager only
    await dbManager.upsert({ table: 'document_store', conflictKeys: ['key'], data: {
        key: LAST_RESULT_KEY,
        value: JSON.stringify({ requestId: res.body.requestId, requestedBy: 'admin', startedAt: res.body.startedAt, finishedAt: new Date().toISOString(), items: [], dir: 'x' }),
        updatedAt: new Date().toISOString(),
    } });
    const status = await request(app).get('/api/settings/backup-status').set('Authorization', superAdmin).expect(200);
    assert.equal(status.body.requestId, res.body.requestId);
    assert.ok(status.body.finishedAt);
    await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
});

test('worker unavailable (message not delivered): 503, status finished with an error, nothing runs in the web process', async () => {
    global.sendWorkerMessage = () => false;
    const res = await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(503);
    assert.equal(res.body.error, 'Background worker unavailable, please retry in a few seconds.');
    const st = await readLastResult();
    assert.ok(st.finishedAt);
    assert.equal(st.error, res.body.error);
    assert.deepEqual(st.items, []);
    // a retry is accepted right away (status is finished, not "running")
    global.sendWorkerMessage = () => true;
    await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(202);
});

test('missing global.sendWorkerMessage without ENABLE_EMBEDDED_WORKER=false is also 503', async () => {
    delete global.sendWorkerMessage;
    await request(app).post('/api/settings/backup-now').set('Authorization', superAdmin).expect(503);
});
