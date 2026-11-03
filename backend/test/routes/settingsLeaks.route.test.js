// Settings-area injection and secret leaks: AD target and NAS values quoted for PowerShell / shell, the stored AI key
// bound to its endpoint, Gemini key out of the URL, masked webhook and SFTP credentials that survive an edit.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const axios = require('axios');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readEnv, envVersion } = require('../../lib/envEditor');
const { decryptText } = require('../../lib/crypto');
const { psSq, psDq } = require('../../lib/psQuote');
const webhookService = require('../../services/webhookService');
const nasDevices = require('../../services/nasDevices');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const admin = tok('root', 'SuperAdmin');
const op = tok('op1', 'Operator');
let app;

webhookService.triggerWebhooks = () => {};

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { settings: true, monitorAlerts: true, sftpManager: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/rbac', require('../../routes/rbac'));
    app.use('/api/ai', require('../../routes/ai'));
    app.use('/api/webhooks', require('../../routes/webhooks'));
    app.use('/api/settings', require('../../routes/apiSettings'));
    app.use('/api/sftp', require('../../routes/sftp'));
});
test.after(async () => { await dbManager.closeDB(); });

test('PowerShell / shell quoting helpers', () => {
    assert.equal(psSq("O'Brien’s"), "O''Brien’’s");
    assert.equal(psDq('a$(b)"`'), 'a`$(b)`"``');
});

test('RBAC AD user lookup refuses targets with control characters', async () => {
    await request(app).get('/api/rbac/ad-users').query({ target: 'Ops\nWrite-Host x' }).set('Authorization', admin).expect(400);
});

test('AI: the stored key never goes to another provider or URL; writes are SuperAdmin only', async () => {
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ provider: 'openai', baseUrl: '', apiKey: 'sk-stored' }).expect(200);
    for (const url of ['/api/ai/fetch-models', '/api/ai/test']) {
        const r = await request(app).post(url).set('Authorization', admin).send({ provider: 'openai', baseUrl: 'https://attacker.example/v1' }).expect(400);
        assert.match(r.body.error, /API Key/);
    }
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ provider: 'openai', baseUrl: 'https://attacker.example/v1' }).expect(400);
    await request(app).post('/api/ai/config').set('Authorization', admin).send({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', temperature: 0.4 }).expect(200);
    await request(app).post('/api/ai/config').set('Authorization', op).send({ temperature: 0.1 }).expect(403);
});

test('AI: Gemini gets its key in a header, never in the URL', async () => {
    const realGet = axios.get;
    let seen;
    axios.get = async (url, opts) => { seen = { url, opts }; return { data: { models: [] } }; };
    try {
        await request(app).post('/api/ai/fetch-models').set('Authorization', admin).send({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'g-key' }).expect(200);
    } finally {
        axios.get = realGet;
    }
    assert.doesNotMatch(seen.url, /g-key/);
    assert.equal(seen.opts.headers['x-goog-api-key'], 'g-key');
});

test('webhooks: list masks credentials; saving the masked form keeps them, a new value replaces them', async () => {
    webhookService.saveWebhooks([{ id: 'wh_m', name: 'teams', url: 'https://hooks.example.test/x?token=abc123', method: 'POST', headers: { Authorization: 'Bearer s3cr3t', 'X-Env': 'prod' }, enabled: false }]);
    const [shown] = (await request(app).get('/api/webhooks').set('Authorization', op).expect(200)).body;
    assert.doesNotMatch(JSON.stringify(shown), /s3cr3t|abc123/);
    await request(app).put('/api/webhooks/wh_m').set('Authorization', op).send({ url: shown.url, headers: { ...shown.headers, 'X-Env': 'dr' } }).expect(200);
    let [stored] = webhookService.loadWebhooks();
    assert.equal(stored.url, 'https://hooks.example.test/x?token=abc123');
    assert.equal(stored.headers.Authorization, 'Bearer s3cr3t');
    assert.equal(stored.headers['X-Env'], 'dr');
    await request(app).put('/api/webhooks/wh_m').set('Authorization', op).send({ headers: { Authorization: 'Bearer new' } }).expect(200);
    [stored] = webhookService.loadWebhooks();
    assert.equal(stored.headers.Authorization, 'Bearer new');
});

test('SFTP servers: API keys masked towards the page, encrypted at rest, kept by an unchanged save', async () => {
    const servers = [{ id: 's1', name: 'a', host: 'sftp01', apiPort: 8443, protocol: 'https', apiKey: 'plain-key' }];
    fs.writeFileSync(process.env.SOMP_ENV_PATH, `SFTP_SERVERS=${JSON.stringify(servers)}\n`);
    const page = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
    assert.doesNotMatch(page.SFTP_SERVERS, /plain-key/);
    await request(app).post('/api/settings/save').set('Authorization', admin).send(page).expect(200);
    const saved = JSON.parse(readEnv().SFTP_SERVERS)[0];
    assert.match(saved.apiKey, /^enc:/);
    assert.equal(decryptText(saved.apiKey.slice(4)), 'plain-key');

    const page2 = (await request(app).get('/api/settings').set('Authorization', admin).expect(200)).body;
    const edited = JSON.parse(page2.SFTP_SERVERS);
    edited[0].apiKey = 'rotated';
    await request(app).post('/api/settings/save').set('Authorization', admin).send({ ...page2, SFTP_SERVERS: JSON.stringify(edited), __version: envVersion() }).expect(200);
    assert.equal(decryptText(JSON.parse(readEnv().SFTP_SERVERS)[0].apiKey.slice(4)), 'rotated');
});

test('SFTP test connection: host must be a host name, and the masked key is never sent to a new address', async () => {
    const r = await request(app).post('/api/sftp/test-connection').set('Authorization', op).send({ host: 'evil.example/x?', apiPort: 8443 }).expect(400);
    assert.match(r.body.message, /host/i);
    process.env.SFTP_SERVERS = JSON.stringify([{ id: 's1', name: 'a', host: 'sftp01', apiPort: 8443, protocol: 'https', apiKey: 'k' }]);
    try {
        const m = await request(app).post('/api/sftp/test-connection').set('Authorization', op)
            .send({ host: 'other-host', apiPort: 8443, protocol: 'https', apiKey: '********', serverId: 's1' }).expect(400);
        assert.match(m.body.message, /API Key/);
    } finally {
        delete process.env.SFTP_SERVERS;
    }
});

test('NAS device usernames cannot carry script characters', () => {
    assert.throws(() => nasDevices.validateDeviceInput({ name: 'n', type: 'windows', ip: '192.0.2.5', username: 'a$(calc)' }, { partial: true }), /Username may only contain/);
    for (const ok of ['svc', 'CORP\\svc', 'svc@corp.local']) {
        assert.doesNotThrow(() => nasDevices.validateDeviceInput({ username: ok }, { partial: true }), ok);
    }
});
