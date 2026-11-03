// Small Settings-area fixes: audit timestamps with offset, Telegram listener restarted only on real changes,
// NAS share names validated instead of silently rewritten.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const nasDrivers = require('../../services/nasDrivers');
const logger = require('../../lib/logger');
const { signToken } = require('../helpers/http');
const { writeDataSync } = require('../../lib/db');
const { writeRbacConfig } = require('../../lib/rbac');
const { envVersion } = require('../../lib/envEditor');

const admin = `Bearer ${signToken({ username: 'root', domain: 'corp', role: 'SuperAdmin', groups: ['g'] })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { nasControl: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/settings', require('../../routes/apiSettings'));
    app.use('/api/nas', require('../../routes/nas'));
});
test.after(async () => { await dbManager.closeDB(); });

test('audit timestamps carry milliseconds and the UTC offset of SYSTEM_TIMEZONE', () => {
    const at = new Date(Date.UTC(2026, 10, 3, 6, 5, 9, 42));
    process.env.SYSTEM_TIMEZONE = 'Asia/Taipei';
    try {
        assert.equal(logger.getLocaleTimestamp(at), '2026-11-03T14:05:09.042+08:00');
        process.env.SYSTEM_TIMEZONE = 'UTC';
        assert.equal(logger.getLocaleTimestamp(at), '2026-11-03T06:05:09.042+00:00');
        process.env.SYSTEM_TIMEZONE = 'America/New_York';
        assert.equal(logger.getLocaleTimestamp(at), '2026-11-03T01:05:09.042-05:00');
        assert.equal(new Date(logger.getLocaleTimestamp(at)).getTime(), at.getTime(), 'parses back to the same instant');
    } finally {
        delete process.env.SYSTEM_TIMEZONE;
    }
});

test('the Telegram listener restarts only when one of its settings really changes', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'TELEGRAM_BOT_TOKEN=abc\nTELEGRAM_CHAT_ID=1\nFOO=1\n');
    const sent = [];
    global.sendWorkerMessage = (msg) => { sent.push(msg.type); return true; };
    try {
        // the page sends every key back, unchanged Telegram values included
        await request(app).post('/api/settings/save').set('Authorization', admin)
            .send({ TELEGRAM_BOT_TOKEN: '********', TELEGRAM_CHAT_ID: '1', FOO: '2', __version: envVersion() }).expect(200);
        assert.equal(sent.includes('RELOAD_TELEGRAM_LISTENER'), false, 'unchanged Telegram values');
        sent.length = 0;
        await request(app).post('/api/settings/save').set('Authorization', admin)
            .send({ TELEGRAM_BOT_TOKEN: '********', TELEGRAM_CHAT_ID: '2', FOO: '2', __version: envVersion() }).expect(200);
        assert.equal(sent.includes('RELOAD_TELEGRAM_LISTENER'), true, 'chat id changed');
    } finally {
        delete global.sendWorkerMessage;
    }
});

test('NAS share names: other languages and brackets allowed as typed; script characters refused, nothing rewritten', async (t) => {
    writeDataSync('service_platform/nas_config.json', [{ id: 'd1', name: 'A', type: 'windows', ip: '192.0.2.30', shares: [] }]);
    const created = [];
    t.mock.method(nasDrivers, 'getDriver', () => ({
        createShare: async (name, path) => { created.push({ name, path }); return true; },
        deleteShare: async (name) => { created.push({ deleted: name }); return true; },
    }));
    await request(app).post('/api/nas/create-share').set('Authorization', admin).send({ deviceId: 'd1', name: '財務 (2026)', path: 'D:\\Shares\\財務' }).expect(200);
    assert.deepEqual(created[0], { name: '財務 (2026)', path: 'D:\\Shares\\財務' });
    const bad = await request(app).post('/api/nas/create-share').set('Authorization', admin).send({ deviceId: 'd1', name: 'x$(calc)', path: '/p' }).expect(400);
    assert.match(bad.body.error, /Share name/);
    await request(app).post('/api/nas/delete-share').set('Authorization', admin).send({ deviceId: 'd1', name: 'Fin;ance' }).expect(400);
    assert.equal(created.length, 1, 'refused requests never reach the driver');
});
