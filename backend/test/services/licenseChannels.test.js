require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const mailer = require('../../lib/mailer');
const webhookService = require('../../services/webhookService');
const listener = require('../../services/telegramListener');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

test.before(async () => {
    await dbManager.initDB();
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    process.env.TELEGRAM_CHAT_ID = '42';
    process.env.MAIL_RELAY_SERVER = 'smtp.example.test';
    process.env.MAIL_RELAY_SENDER = 'somp@example.test';
    process.env.MAIL_RELAY_RECIPIENT = 'ops@example.test';
});
test.after(async () => {
    setPaid();
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'MAIL_RELAY_SERVER', 'MAIL_RELAY_SENDER', 'MAIL_RELAY_RECIPIENT']) delete process.env[k];
    await dbManager.closeDB();
});

test('free: Telegram, email and webhooks send nothing; paid: they send', async (t) => {
    const tg = [];
    t.mock.method(https, 'get', (url, cb) => { tg.push(url); const res = new EventEmitter(); res.statusCode = 200; setImmediate(() => { cb(res); res.emit('end'); }); return new EventEmitter(); });
    const hooks = [];
    t.mock.method(webhookService, 'loadWebhooks', () => [{ id: 'w1', name: 'hook', url: 'http://192.0.2.10/hook', enabled: true, method: 'POST' }]);
    t.mock.method(http, 'request', () => { hooks.push(1); const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.setTimeout = () => {}; req.destroy = () => {}; return req; });
    const mails = [];
    t.mock.method(mailer, '_createTransport', () => ({ sendMail: async (m) => { mails.push(m); return { messageId: 'm1' }; } }));
    t.mock.method(console, 'log', () => {});

    setFree();
    await logger.sendTelegramAlert('hello', 'System', { skipCategoryCheck: true });
    await mailer.sendMail({ subject: 's', text: 't' });
    await assert.rejects(mailer.deliverMail({ subject: 's', text: 't', to: 'a@example.test' }), /paid license/);
    const r = await webhookService.executeWebhook({ id: 'w1', name: 'hook', url: 'http://192.0.2.10/hook' }, { message: 'm' });
    assert.deepEqual({ success: r.success, skipped: r.skipped }, { success: false, skipped: 'license' });
    await webhookService.triggerWebhooks('m', 'System', 'Alert');
    assert.deepEqual([tg.length, mails.length, hooks.length], [0, 0, 0]);

    setPaid();
    await logger.sendTelegramAlert('hello', 'System', { skipCategoryCheck: true, skipWebhooks: true });
    await mailer.sendMail({ subject: 's', text: 't' });
    assert.equal(tg.length, 1);
    assert.equal(mails.length, 1);
});

test('free: the webhook test endpoint answers LICENSE_REQUIRED', async (t) => {
    t.mock.method(webhookService, 'loadWebhooks', () => [{ id: 'w1', name: 'hook', url: 'http://192.0.2.10/hook' }]);
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', require('../../routes/webhooks'));
    setFree();
    const r = await request(app).post('/api/webhooks/test/w1').set('Authorization', `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    setPaid();
});

test('free: the Telegram bot does not poll Telegram', async (t) => {
    const urls = [];
    listener.__test.setFetch(async (url) => { urls.push(url); return { ok: true, result: [] }; });
    t.mock.method(console, 'log', () => {});
    setFree();
    await listener.initTelegramListener();
    await new Promise(r => setTimeout(r, 50));
    listener.stopTelegramListener();
    assert.equal(urls.length, 0);
    listener.__test.setFetch(null);
    setPaid();
});
