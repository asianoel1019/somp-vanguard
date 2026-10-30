require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { notifyStartup } = require('../../lib/startupNotice');

const KEY = 'system/startup_notice.json';
const realSend = logger.sendTelegramAlert;
let sent;

test.before(async () => { await dbManager.initDB(); });
test.beforeEach(() => {
    sent = [];
    writeDataSync(KEY, {});
    logger.sendTelegramAlert = async (message, moduleName) => { sent.push({ message, moduleName }); };
});
test.after(async () => { logger.sendTelegramAlert = realSend; await dbManager.closeDB(); });

const t0 = new Date('2026-10-19T08:00:00Z');
const at = (minutes) => new Date(t0.getTime() + minutes * 60000);

test('first start sends a message with version, host and port that categorises as AuditLogs', async () => {
    const r = await notifyStartup({ version: 'v9.9.9', host: 'srv01', port: 5000, now: t0 });
    assert.deepEqual(r, { sent: true, restarts: 0 });
    assert.equal(sent.length, 1);
    const { message } = sent[0];
    assert.match(message, /^✅ \[SYS Audit\] SOMP Vanguard v9\.9\.9 已啟動\nHost: srv01 {2}Port: 5000\nTime: /);
    const p = (n) => String(n).padStart(2, '0');
    assert.ok(message.includes(`Time: ${t0.getFullYear()}-${p(t0.getMonth() + 1)}-${p(t0.getDate())} ${p(t0.getHours())}:${p(t0.getMinutes())}:${p(t0.getSeconds())}`));
    assert.equal(logger.resolveLogCategory(sent[0].moduleName, message), 'AuditLogs');
    assert.equal(readDataSync(KEY).lastSentAt, t0.toISOString());
});

test('a second start within 5 minutes is suppressed and counted; a later start reports the restarts', async () => {
    await notifyStartup({ version: 'v1', host: 'h', port: 1, now: t0 });
    const second = await notifyStartup({ version: 'v1', host: 'h', port: 1, now: at(1) });
    assert.deepEqual(second, { sent: false, restarts: 1 });
    assert.equal(sent.length, 1);
    const third = await notifyStartup({ version: 'v1', host: 'h', port: 1, now: at(6) });
    assert.equal(third.sent, true);
    assert.equal(sent.length, 2);
    assert.ok(sent[1].message.includes('⚠️ 過去 6 分鐘內另有 1 次重啟'), sent[1].message);
    assert.equal(sent[1].message.split('\n').filter(l => l.includes('另有')).length, 1);
    assert.deepEqual(readDataSync(KEY), { lastSentAt: at(6).toISOString(), suppressed: 0 });
});

test('defaults: version comes from package.json and host from os.hostname', async () => {
    const saved = process.env.VERSION;
    delete process.env.VERSION;
    await notifyStartup({ port: 5000, now: t0 });
    assert.match(sent[0].message, new RegExp(`SOMP Vanguard v${require('../../package.json').version.replace(/\./g, '\\.')} `));
    assert.ok(sent[0].message.includes(`Host: ${require('os').hostname()}`));
    if (saved !== undefined) process.env.VERSION = saved;
});

test('a throwing sender never rejects', async () => {
    logger.sendTelegramAlert = async () => { throw new Error('telegram down'); };
    const origErr = console.error;
    console.error = () => {};
    try {
        const r = await notifyStartup({ version: 'v1', host: 'h', port: 1, now: t0 });
        assert.equal(r.sent, false);
    } finally { console.error = origErr; }
});

test('startup message uses the package.json version (not a stale .env VERSION) and a readable local time', async (t) => {
    const logger = require('../../lib/logger');
    const { writeDataSync } = require('../../lib/db');
    writeDataSync('system/startup_notice.json', {});
    const sent = [];
    t.mock.method(logger, 'sendTelegramAlert', async (m) => { sent.push(m); });
    const saved = process.env.VERSION;
    process.env.VERSION = 'v1.6.12(Build 2026.08.26)';
    try {
        await require('../../lib/startupNotice').notifyStartup({ host: 'H', port: 8080, now: new Date(2031, 0, 2, 3, 4, 5) });
    } finally {
        if (saved === undefined) delete process.env.VERSION; else process.env.VERSION = saved;
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp('SOMP Vanguard v' + require('../../package.json').version.replace(/./g, '\.') + ' 已啟動'));
    assert.match(sent[0], /Time: 2031-01-02 03:04:05/);
});
