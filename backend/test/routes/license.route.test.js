require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { setPaid, setFree, PAID_TEXT } = require('../helpers/license');
const lic = require('../../lib/license');
const la = require('../../lib/localAccounts');

const ADMIN = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
const OPERATOR = `Bearer ${signToken({ username: 'ops', domain: 'local', role: 'Operator' })}`;
let app;
const audits = [];

test.before(async () => {
    await dbManager.initDB();
    la._resetForTest();
    setFree(); // free-created so the account is active on both editions
    la.createAccount({ username: 'ops', role: 'Operator', password: 'Correct-horse-42' }, 'admin'); // page account for the local-domain token
    setPaid();
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use('/api/license', require('../../routes/license'));
});
test.after(async () => { setPaid(); la._resetForTest(); await dbManager.closeDB(); });

test('GET returns the public state to any signed-in user; unauthenticated is 401', async () => {
    setFree();
    const r = await request(app).get('/api/license').set('Authorization', OPERATOR);
    assert.equal(r.status, 200);
    assert.equal(r.body.edition, 'free');
    assert.ok(r.body.locked.includes('aiAgent'));
    assert.equal((await request(app).get('/api/license')).status, 401);
});

test('POST: SuperAdmin only, invalid licenses are not stored, a valid one is stored and audited', async () => {
    setFree();
    audits.length = 0;
    assert.equal((await request(app).post('/api/license').set('Authorization', OPERATOR).send({ text: PAID_TEXT })).status, 403);
    let r = await request(app).post('/api/license').set('Authorization', ADMIN).send({ text: '{"payload":{}}' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /payload or signature|format version/);
    assert.equal(lic.isPaid(), false);
    r = await request(app).post('/api/license').set('Authorization', ADMIN).send({ text: 'x'.repeat(17000) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /16 KB/);
    r = await request(app).post('/api/license').set('Authorization', ADMIN).send({ text: PAID_TEXT });
    assert.equal(r.status, 200);
    assert.equal(r.body.edition, 'paid');
    assert.equal(lic.isPaid(), true);
    assert.deepEqual(audits.map(a => a[1]), ['License']);
    assert.match(audits[0][2], /L-TEST-0001/);
});

test('DELETE: SuperAdmin removes the license (free edition), audited', async () => {
    setPaid();
    audits.length = 0;
    assert.equal((await request(app).delete('/api/license').set('Authorization', OPERATOR)).status, 403);
    const r = await request(app).delete('/api/license').set('Authorization', ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.edition, 'free');
    assert.equal(audits.length, 1);
});

test('upload and removal tell the worker to drop its cached license document', async () => {
    const saved = global.sendWorkerMessage;
    const msgs = [];
    global.sendWorkerMessage = (m) => { msgs.push(m); };
    try {
        setFree();
        await request(app).post('/api/license').set('Authorization', ADMIN).send({ text: PAID_TEXT });
        const afterPost = msgs.filter(m => m && m.type === 'INVALIDATE_DOC_CACHE' && m.key === 'system/license.json').length;
        assert.ok(afterPost >= 1);
        await request(app).delete('/api/license').set('Authorization', ADMIN);
        const afterDelete = msgs.filter(m => m && m.type === 'INVALIDATE_DOC_CACHE' && m.key === 'system/license.json').length;
        assert.ok(afterDelete > afterPost);
    } finally {
        global.sendWorkerMessage = saved;
    }
});
