// Settings saves that used to lose data: AI key cleared by an unrelated save, stale or empty settings pages
// overwriting .env, DB_DATA_DIR moved away from its encryption key, "Add mapping" replacing an existing mapping.
const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig, readRbacConfig } = require('../../lib/rbac');
const { readEnv, envVersion } = require('../../lib/envEditor');
const aiRouter = require('../../routes/ai');

const admin = `Bearer ${signToken({ username: 'root', domain: 'corp', role: 'SuperAdmin', groups: ['g'] })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { settings: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/settings', require('../../routes/apiSettings'));
    app.use('/api/ai', aiRouter);
    app.use('/api/rbac', require('../../routes/rbac'));
});
test.after(async () => { await dbManager.closeDB(); });

test('AI config: saving with an empty key keeps the stored key; clearApiKey removes it', async () => {
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ enabled: true, provider: 'openai', apiKey: 'sk-test-1' }).expect(200);
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ enabled: true, provider: 'openai', apiKey: '', temperature: 0.2 }).expect(200);
    assert.ok(aiRouter.getAiConfig().apiKey_enc, 'key kept after an unrelated save');
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ apiKey: '', clearApiKey: true }).expect(200);
    assert.equal(aiRouter.getAiConfig().apiKey_enc, '', 'explicit clear');
});

test('settings save needs the version it was built from: empty or stale pages are refused', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\nFORTI_HOST_PROD=fw1\nMAIL_RELAY_HOST=mx\n');
    // the page failed to load: nothing to send back, and the repeatable sections must survive
    const empty = await request(app).post('/api/settings/save').set('Authorization', admin).send({ FOO: '2' }).expect(409);
    assert.equal(empty.body.code, 'SETTINGS_NOT_LOADED');
    assert.equal(readEnv().FORTI_HOST_PROD, 'fw1');

    const pageA = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
    const pageB = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
    const saved = (await request(app).post('/api/settings/save').set('Authorization', admin).send({ ...pageB, MAIL_RELAY_HOST: 'mx2' }).expect(200)).body;
    assert.equal(saved.__version, envVersion(), 'new version returned for the next save');
    const stale = await request(app).post('/api/settings/save').set('Authorization', admin).send({ ...pageA, FOO: '3' }).expect(409);
    assert.equal(stale.body.code, 'SETTINGS_CHANGED');
    assert.equal(readEnv().MAIL_RELAY_HOST, 'mx2', 'the other admin\'s save is not overwritten');
    assert.equal(readEnv().__version, undefined, 'the version is never written to .env');
});

test('DB_DATA_DIR may only move to a directory that already holds .system_key', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, `DB_DATA_DIR=${dataDir}\n`);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-nokey-'));
    const withKey = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-key-'));
    fs.writeFileSync(path.join(withKey, '.system_key'), 'k');
    try {
        let page = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
        const r = await request(app).post('/api/settings/save').set('Authorization', admin).send({ ...page, DB_DATA_DIR: empty }).expect(400);
        assert.match(r.body.error, /\.system_key/);
        await request(app).post('/api/settings/save').set('Authorization', admin).send({ ...page, DB_DATA_DIR: withKey }).expect(200);
        assert.equal(readEnv().DB_DATA_DIR, withKey);
        page = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
        await request(app).post('/api/settings/save').set('Authorization', admin).send(page).expect(200);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
        fs.rmSync(withKey, { recursive: true, force: true });
    }
});

test('Add mapping refuses an existing name (any case); editing the mapping still works', async () => {
    const body = { name: 'Ops', type: 'group', target: 'CN=Ops', enabled: true, features: { dnsHub: true }, auditLogs: {} };
    await request(app).post('/api/rbac/groups').set('Authorization', admin).send({ ...body, mode: 'create' }).expect(200);
    const dup = await request(app).post('/api/rbac/groups').set('Authorization', admin).send({ ...body, name: 'ops', target: 'CN=Other', features: {}, mode: 'create' }).expect(409);
    assert.match(dup.body.error, /already exists/);
    assert.equal(readRbacConfig().groups.Ops.target, 'CN=Ops');
    assert.equal(readRbacConfig().groups.Ops.features.dnsHub, true, 'features not reset');
    await request(app).post('/api/rbac/groups').set('Authorization', admin).send({ ...body, target: 'CN=Ops2' }).expect(200);
    assert.equal(readRbacConfig().groups.Ops.target, 'CN=Ops2');
});
