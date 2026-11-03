// Settings-area security fixes: secrets not sent to the browser, X-Forwarded-For trust, token-bound logout,
// one-line audit entries always written, DevTools limited to the local API, role changes revoking old tokens,
// authenticated incoming webhooks, PowerShell-safe NAS share names.
const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const dbManager = require('../../services/db');
const { signToken, TEST_JWT_SECRET } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readEnv } = require('../../lib/envEditor');
const logger = require('../../lib/logger');
const { clientIp } = require('../../lib/clientIp');
const sessionRevocation = require('../../lib/sessionRevocation');
const webhookService = require('../../services/webhookService');
const { psDq } = require('../../services/nasDrivers');

const tok = (username, role, extra = {}) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'], ...extra })}`;
const admin = tok('root', 'SuperAdmin');
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
let app;

// no test may reach a real webhook target
webhookService.triggerWebhooks = () => {};

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { settings: true, nasControl: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/settings', require('../../routes/apiSettings'));
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/devtools', require('../../routes/devTools'));
    app.use('/api/rbac', require('../../routes/rbac'));
    app.use('/api/webhooks', require('../../routes/webhooks'));
    app.use('/api/nas', require('../../routes/nas'));
});
test.after(async () => { await dbManager.closeDB(); });

const auditFileText = () => {
    const f = logger.getTodayLogFile();
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

test('System Settings: secrets are masked, JWT_SECRET never leaves the server, the mask keeps the stored value', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\nJWT_SECRET=topsecret\nAD_ADMIN_PWD=adpw\nPROXY_PWD=pp\nAD_ADMIN_USER=svc\n');
    const got = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
    assert.equal(got.JWT_SECRET, undefined);
    assert.equal(got.AD_ADMIN_PWD, '********');
    assert.equal(got.AD_ADMIN_USER, 'svc', 'account names are not secrets');
    assert.ok(!JSON.stringify(got).includes('adpw'));

    // save the page back unchanged except one field, with an attempt to overwrite JWT_SECRET
    await request(app).post('/api/settings/save').set('Authorization', admin)
        .send({ ...got, FOO: '2', PROXY_PWD: '', JWT_SECRET: 'attacker' }).expect(200);
    const env = readEnv();
    assert.equal(env.FOO, '2');
    assert.equal(env.AD_ADMIN_PWD, 'adpw', 'masked secret kept');
    assert.equal(env.PROXY_PWD, '', 'cleared field clears');
    assert.equal(env.JWT_SECRET, 'topsecret', 'JWT_SECRET not writable from the UI');
});

test('client IP: X-Forwarded-For is only believed from a trusted proxy, and the right-most untrusted hop wins', () => {
    const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    assert.equal(clientIp(req('203.0.113.5', '127.0.0.1')), '203.0.113.5', 'direct caller cannot claim localhost');
    assert.equal(clientIp(req('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7', 'local reverse proxy');
    assert.equal(clientIp(req('127.0.0.1', '127.0.0.1, 198.51.100.7')), '198.51.100.7', 'forged first hop ignored');
    process.env.TRUSTED_PROXY_IPS = '192.0.2.10';
    try {
        assert.equal(clientIp(req('192.0.2.10', '198.51.100.8')), '198.51.100.8');
    } finally {
        delete process.env.TRUSTED_PROXY_IPS;
    }
});

test('logout: the token decides who is logged out; a body username alone does nothing', async () => {
    await request(app).post('/api/auth/logout').send({ username: 'alice@corp', type: 'logout' }).expect(401);
    const before = auditFileText();
    const token = jwt.sign({ username: 'bob', domain: 'corp', role: 'Viewer', iat: Math.floor(Date.now() / 1000) - 90000 }, TEST_JWT_SECRET, { expiresIn: 1 });
    await request(app).post('/api/auth/logout').send({ username: 'alice@corp', token, type: 'logout' }).expect(200);
    const added = auditFileText().slice(before.length);
    assert.match(added, /User: bob@corp \| Module: Auth/, 'expired but genuine token still identifies its owner');
    assert.doesNotMatch(added, /alice/);
});

test('audit file: always written, one line per entry, no field injection', () => {
    const before = auditFileText();
    // Remote Command is a module whose notification the group toggle controls; the file line must still be written
    logger.auditLog('mallory\n[2026-01-01T00:00:00] [Audit] User: alice | Module: RBAC | Action: Granted', 'Remote Command', 'ran\r\nsecond line');
    const added = auditFileText().slice(before.length).trim().split('\n');
    assert.equal(added.length, 1);
    assert.match(added[0], /^\[[^\]]+\] \[Audit\] User: mallory .* \/ Module: RBAC \/ Action: Granted \| Module: Remote Command \| Action: ran .* second line$/);
});

test('audit log endpoint of the auth route is SuperAdmin only', async () => {
    await request(app).get('/api/auth/logs').set('Authorization', viewer).expect(403);
    await request(app).get('/api/auth/logs').set('Authorization', admin).expect(200);
});

test('DevTools: only this server\'s /api paths; absolute and protocol-relative URLs are refused', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    for (const p of ['https://attacker.example/x', '//attacker.example/x', '/api/../../etc', '/health', '/api/devtools/execute']) {
        const r = await request(app).post('/api/devtools/execute').set('Authorization', admin).send({ method: 'GET', path: p });
        assert.equal(r.status, 400, p);
    }
    await request(app).post('/api/devtools/execute').set('Authorization', op).send({ path: '/api/health' }).expect(403);
});

test('role changes refuse tokens issued before them, for a user and for a mapping group', async () => {
    sessionRevocation.resetForTest();
    const old = Math.floor(Date.now() / 1000) - 60;
    const bob = `Bearer ${jwt.sign({ username: 'bob', domain: 'corp', role: 'SuperAdmin', groups: [], iat: old }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
    const carol = `Bearer ${jwt.sign({ username: 'carol', domain: 'corp', role: 'SuperAdmin', groups: ['Ops'], iat: old }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
    await request(app).get('/api/auth/logs').set('Authorization', bob).expect(200);

    await request(app).post('/api/rbac').set('Authorization', admin).send({ username: 'bob', domain: 'corp', role: 'Viewer' }).expect(200);
    const r = await request(app).get('/api/auth/logs').set('Authorization', bob).expect(401);
    assert.equal(r.body.code, 'SESSION_REVOKED');
    await request(app).get('/api/auth/logs').set('Authorization', carol).expect(200);

    await request(app).post('/api/rbac').set('Authorization', admin).send({ username: '[group] Ops', domain: 'corp', role: 'Viewer' }).expect(200);
    await request(app).get('/api/auth/logs').set('Authorization', carol).expect(401);
    // a fresh login after the change works
    const fresh = `Bearer ${jwt.sign({ username: 'bob', domain: 'corp', role: 'Viewer', groups: [], iat: Math.floor(Date.now() / 1000) + 1 }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
    await request(app).get('/api/auth/logs').set('Authorization', fresh).expect(403);
});

test('incoming webhook: unknown id, no secret, wrong secret are refused; the right secret works; calls are rate limited', async () => {
    webhookService.saveWebhooks([{ id: 'wh_1', name: 'hook', url: 'https://example.test/x', method: 'POST', headers: {}, enabled: false }]);
    await request(app).post('/api/webhooks/incoming/nope').send({}).expect(404);
    await request(app).post('/api/webhooks/incoming/wh_1').send({}).expect(403);

    const gen = (await request(app).post('/api/webhooks/wh_1/incoming-secret').set('Authorization', op).expect(200)).body;
    assert.match(gen.secret, /^[0-9a-f]{48}$/);
    const list = (await request(app).get('/api/webhooks').set('Authorization', op).expect(200)).body;
    assert.equal(list[0].incomingEnabled, true);
    assert.equal(list[0].incomingSecretHash, undefined);

    await request(app).post('/api/webhooks/incoming/wh_1').set('X-Webhook-Secret', 'wrong').send({}).expect(401);
    for (let i = 0; i < 30; i++) {
        await request(app).post('/api/webhooks/incoming/wh_1').set('X-Webhook-Secret', gen.secret).send({ n: i }).expect(200);
    }
    await request(app).post('/api/webhooks/incoming/wh_1').set('X-Webhook-Secret', gen.secret).send({}).expect(429);
});

test('NAS: share names that could break out of PowerShell are refused, and driver strings are escaped', async () => {
    const r = await request(app).post('/api/nas/get-permissions').set('Authorization', viewer)
        .send({ deviceId: 'd1', shareName: '$(Start-Process calc)' });
    assert.equal(r.status, 400);
    assert.equal(psDq('a$(b)"c`d“e'), 'a`$(b)`"c``d`“e');
});
