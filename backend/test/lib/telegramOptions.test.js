require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const logger = require('../../lib/logger');
const webhookService = require('../../services/webhookService');

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ENABLED_LOGS', 'PROXY_ENABLED_MODULES'];
let saved, urls, hookCalls;

test.beforeEach((t) => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.TELEGRAM_BOT_TOKEN = 'testtoken';
    process.env.TELEGRAM_CHAT_ID = '-100111';
    delete process.env.PROXY_ENABLED_MODULES;
    urls = []; hookCalls = [];
    t.mock.method(https, 'get', (url, cb) => {
        urls.push(url);
        const res = new EventEmitter(); res.statusCode = 200;
        setImmediate(() => { cb(res); res.emit('end'); });
        return new EventEmitter();
    });
    t.mock.method(webhookService, 'triggerWebhooks', (...a) => { hookCalls.push(a); });
});
test.afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('default sendTelegramAlert triggers webhooks and respects TELEGRAM_ENABLED_LOGS', async () => {
    process.env.TELEGRAM_ENABLED_LOGS = 'ScoutMonitor';
    await logger.sendTelegramAlert('hello', 'ScoutMonitor');
    assert.equal(hookCalls.length, 1);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /chat_id=-100111&/);

    process.env.TELEGRAM_ENABLED_LOGS = 'SomethingElse';
    await logger.sendTelegramAlert('hello', 'ScoutMonitor');
    assert.equal(hookCalls.length, 2, 'webhooks still dispatched independently');
    assert.equal(urls.length, 1, 'telegram skipped when category disabled');
});

test('F9: an over-long message is truncated for Telegram only (webhooks get the full text)', async () => {
    process.env.TELEGRAM_ENABLED_LOGS = 'ScoutMonitor';
    const long = '告'.repeat(5000);
    await logger.sendTelegramAlert(long, 'ScoutMonitor');
    assert.equal(urls.length, 1);
    const text = new URL(urls[0]).searchParams.get('text');
    assert.ok(text.length <= 3020, `decoded length ${text.length}`);
    assert.match(text, /訊息過長已截斷/);
    assert.equal(hookCalls[0][0].length, 5000);
    await logger.sendTelegramAlert('short', 'ScoutMonitor');
    assert.equal(new URL(urls[1]).searchParams.get('text'), 'short');
});

test('sendTelegramToChat uses the given chat, skips webhooks and ignores category filter', async () => {
    process.env.TELEGRAM_ENABLED_LOGS = 'SomethingElse';
    await logger.sendTelegramToChat('-100999', 'escalation');
    assert.equal(hookCalls.length, 0);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /chat_id=-100999&/);
});

test('truncation does not split an emoji at the cut (message is still sent)', async () => {
    const msg = 'a'.repeat(2999) + '\u{1F600}' + 'b'.repeat(100);   // emoji straddles the 3000-char cut
    await logger.sendTelegramAlert(msg, 'System');
    assert.equal(urls.length, 1, 'Telegram request was made (encodeURIComponent did not throw)');
    const text = new URL(urls[0]).searchParams.get('text');
    assert.ok(text.startsWith('a'.repeat(2999)));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate');
});
