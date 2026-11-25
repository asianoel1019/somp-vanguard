require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { readDataSync, writeDataSync } = require('../../lib/db');
const lic = require('../../lib/license');
const logger = require('../../lib/logger');
const mailer = require('../../lib/mailer');
const svc = require('../../services/licenseReminder');
const { signLicense, setPaid } = require('../helpers/license');

const ENV = ['MAIL_RELAY_RECIPIENT', 'MAIL_RELAY_SERVER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const saved = {};
let mails, tgs, audits, mailOk, tgOk;
const DOC = 'system/license_reminders.json';

const install = (overrides) => writeDataSync(lic.LICENSE_KEY, { text: signLicense(overrides), uploadedAt: '2026-11-01T00:00:00.000Z', uploadedBy: 'test' });
const setNow = (y, m, d) => lic._setClockForTest(() => new Date(y, m - 1, d, 10, 0, 0));
const configure = () => {
    process.env.MAIL_RELAY_RECIPIENT = 'ops@example.test'; process.env.MAIL_RELAY_SERVER = '192.0.2.10';
    process.env.TELEGRAM_BOT_TOKEN = '123:TEST'; process.env.TELEGRAM_CHAT_ID = '-100';
};
const desc = (a) => a.slice().sort((x, y) => y - x);

test.before(async () => { await dbManager.initDB(); for (const k of ENV) saved[k] = process.env[k]; });
test.after(async () => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    lic._setClockForTest(null); setPaid(); svc._resetForTest(); await dbManager.closeDB();
});
test.beforeEach((t) => {
    svc._resetForTest();
    writeDataSync(DOC, {});
    mails = []; tgs = []; audits = []; mailOk = true; tgOk = true;
    configure();
    t.mock.method(mailer, 'deliverMail', async (o) => { mails.push(o); if (!mailOk) throw new Error('smtp down'); return 'id'; });
    t.mock.method(logger, 'sendTelegramChecked', async (text, o) => { tgs.push({ text, ...o }); return tgOk; });
    t.mock.method(logger, 'auditLog', (...a) => { audits.push(a); });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    setNow(2026, 11, 17);
});

test('texts match the templates, with and without a vendor contact', () => {
    const st = { licenseId: 'L-1', customer: 'Example Test Co.', expiresAt: '2026-12-17', expiredAt: '2026-12-17' };
    const both = { vendor: 'Example Vendor', email: 'support@example.test' };
    assert.equal(svc.reminderText(st, 30, both), 'SOMP Vanguard license L-1 for Example Test Co. expires on 2026-12-17 (30 days left). After that date the system switches to the free edition. Contact Example Vendor (support@example.test) to renew.');
    assert.equal(svc.expiredText(st, both), 'SOMP Vanguard license L-1 for Example Test Co. expired on 2026-12-17. The system now runs as the free edition. Contact Example Vendor (support@example.test) to renew.');
    assert.equal(svc.reminderText(st, 30, null), 'SOMP Vanguard license L-1 for Example Test Co. expires on 2026-12-17 (30 days left). After that date the system switches to the free edition. Contact your software vendor to renew.');
    assert.equal(svc.expiredText(st, null), 'SOMP Vanguard license L-1 for Example Test Co. expired on 2026-12-17. The system now runs as the free edition. Contact your software vendor to renew.');
    assert.ok(svc.reminderText(st, 30, { vendor: 'Example Vendor', email: '' }).endsWith(' free edition. Contact Example Vendor to renew.'));
    assert.ok(svc.expiredText(st, { email: 'support@example.test' }).endsWith(' free edition. Contact support@example.test to renew.'));
});

test('trial texts say "trial license" right after SOMP Vanguard', () => {
    const st = { licenseId: 'L-1', customer: 'Example Test Co.', expiresAt: '2026-12-17', expiredAt: '2026-12-17', trial: true };
    assert.equal(svc.reminderText(st, 7, null), 'SOMP Vanguard trial license L-1 for Example Test Co. expires on 2026-12-17 (7 days left). After that date the system switches to the free edition. Contact your software vendor to renew.');
    assert.equal(svc.expiredText(st, null), 'SOMP Vanguard trial license L-1 for Example Test Co. expired on 2026-12-17. The system now runs as the free edition. Contact your software vendor to renew.');
});

test('trial license: no reminder at 30 days, first at 7 days, then 3 and 1; texts say trial license', async () => {
    install({ trial: true, expiresAt: '2026-12-17' }); // 30 days left
    assert.equal((await svc.checkNow()).sent, null);
    assert.equal(mails.length, 0);
    setNow(2026, 12, 9); // 8 days left
    assert.equal((await svc.checkNow()).sent, null);
    setNow(2026, 12, 10); // 7 days left
    assert.equal((await svc.checkNow()).sent, 7);
    assert.match(mails[0].text, /^SOMP Vanguard trial license L-TEST-0001 for Example Test Co\. expires on 2026-12-17 \(7 days left\)\./);
    assert.deepEqual(readDataSync(DOC).sent, [7]);
    assert.equal((await svc.checkNow()).sent, null);
    setNow(2026, 12, 13); // 4 days left: still covered by 7
    assert.equal((await svc.checkNow()).sent, null);
    setNow(2026, 12, 14); // 3 days left
    assert.equal((await svc.checkNow()).sent, 3);
    setNow(2026, 12, 15); // 2 days left: no 2-day threshold for trials
    assert.equal((await svc.checkNow()).sent, null);
    setNow(2026, 12, 16); // 1 day left
    assert.equal((await svc.checkNow()).sent, 1);
    assert.equal(mails.length, 3);
    assert.deepEqual(desc(readDataSync(DOC).sent), [7, 3, 1]);
});

test('expired trial license: one notice that says trial license', async () => {
    install({ trial: true, expiresAt: '2026-12-17' });
    setNow(2026, 12, 18);
    const r = await svc.checkNow();
    assert.equal(r.expired, true);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /^SOMP Vanguard trial license L-TEST-0001 for Example Test Co\. expired on 2026-12-17\. /);
    assert.equal(mails[0].ignoreLicense, true);
    await svc.checkNow();
    assert.equal(mails.length, 1);
});

test('sent texts use the contact signed into the license, else the generic sentence', async () => {
    install({ expiresAt: '2026-12-17', contact: { vendor: 'Example Vendor', email: 'support@example.test' } });
    await svc.checkNow();
    assert.ok(mails[0].text.endsWith(' free edition. Contact Example Vendor (support@example.test) to renew.'), mails[0].text);
    assert.equal(tgs[0].text, mails[0].text);
    svc._resetForTest(); writeDataSync(DOC, {});
    install({ licenseId: 'L-TEST-0002', expiresAt: '2026-12-17' });
    await svc.checkNow();
    assert.ok(mails[1].text.endsWith(' free edition. Contact your software vendor to renew.'), mails[1].text);
    setNow(2026, 12, 18);
    await svc.checkNow();
    assert.ok(mails[2].text.endsWith('expired on 2026-12-17. The system now runs as the free edition. Contact your software vendor to renew.'), mails[2].text);
});

test('the 30-day reminder is sent once on both channels', async () => {
    install({ expiresAt: '2026-12-17' });
    const r = await svc.checkNow();
    assert.equal(r.sent, 30);
    assert.deepEqual(r.channels, ['email', 'telegram']);
    assert.equal(mails.length, 1); assert.equal(tgs.length, 1);
    assert.equal(mails[0].subject, 'SOMP Vanguard license expiry');
    assert.equal(mails[0].to, 'ops@example.test');
    assert.equal(mails[0].ignoreLicense, false);
    assert.match(mails[0].text, /\(30 days left\)/);
    assert.deepEqual(readDataSync(DOC).sent, [30]);
    const again = await svc.checkNow();
    assert.equal(again.sent, null);
    assert.equal(mails.length, 1); assert.equal(tgs.length, 1);
});

test('nothing is sent while more than 30 days are left', async () => {
    install({ expiresAt: '2026-12-18' });
    assert.equal((await svc.checkNow()).sent, null);
    assert.equal(mails.length, 0);
});

test('starting at 5 days left sends once and records 30, 14, 7; 3 days later sends again', async () => {
    install({ expiresAt: '2026-11-22' });
    assert.equal((await svc.checkNow()).sent, 5);
    assert.equal(mails.length, 1);
    assert.deepEqual(desc(readDataSync(DOC).sent), [30, 14, 7]);
    setNow(2026, 11, 19);
    assert.equal((await svc.checkNow()).sent, 3);
    assert.equal(mails.length, 2);
    assert.match(mails[1].text, /\(3 days left\)/);
    assert.deepEqual(desc(readDataSync(DOC).sent), [30, 14, 7, 3]);
});

test('a new license id resets the record', async () => {
    install({ expiresAt: '2026-12-17', licenseId: 'L-A' });
    await svc.checkNow();
    assert.equal(readDataSync(DOC).licenseId, 'L-A');
    install({ expiresAt: '2026-12-17', licenseId: 'L-B' });
    const r = await svc.checkNow();
    assert.equal(r.sent, 30);
    assert.equal(mails.length, 2);
    assert.equal(readDataSync(DOC).licenseId, 'L-B');
    assert.deepEqual(readDataSync(DOC).sent, [30]);
});

test('when every configured channel fails nothing is recorded and the next check retries', async () => {
    install({ expiresAt: '2026-12-17' });
    mailOk = false; tgOk = false;
    const r = await svc.checkNow();
    assert.equal(r.sent, null);
    assert.deepEqual(readDataSync(DOC).sent, []);
    mailOk = true;
    const r2 = await svc.checkNow();
    assert.equal(r2.sent, 30);
    assert.deepEqual(r2.channels, ['email']);
    assert.deepEqual(readDataSync(DOC).sent, [30]);
});

test('with no channel configured the threshold is recorded, so the skipped lines are not repeated every hour', async () => {
    install({ expiresAt: '2026-12-17' });
    for (const k of ENV) delete process.env[k];
    const skipped = () => console.log.mock.calls.map(c => c.arguments[0]).filter(m => /skipped/.test(m));
    const r = await svc.checkNow();
    assert.equal(r.sent, null);
    assert.equal(mails.length + tgs.length, 0);
    assert.deepEqual(readDataSync(DOC).sent, [30]);
    assert.equal(skipped().length, 2);
    await svc.checkNow();
    assert.equal(skipped().length, 2, 'no new skipped lines on the next check');
});

test('a re-signed copy of the same id with a later expiry date starts clean', async () => {
    install({ expiresAt: '2026-11-16' }); // expired copy
    await svc.checkNow();
    assert.equal(readDataSync(DOC).expiredNotified, true);
    assert.equal(readDataSync(DOC).expiresAt, '2026-11-16');
    install({ expiresAt: '2026-12-17' }); // same id L-TEST-0001, renewed
    const r = await svc.checkNow();
    assert.equal(r.sent, 30);
    assert.deepEqual(readDataSync(DOC), { licenseId: 'L-TEST-0001', expiresAt: '2026-12-17', sent: [30], expiredNotified: false });
});

test('a check whose channel never answers is given up, and the next check still runs', async () => {
    install({ expiresAt: '2026-12-17' });
    delete process.env.MAIL_RELAY_RECIPIENT;
    let hang = true;
    logger.sendTelegramChecked.mock.mockImplementation(async (text, o) => {
        tgs.push({ text, ...o });
        return hang ? new Promise(() => {}) : true;
    });
    const saved = svc.reminderTiming.checkTimeoutMs;
    svc.reminderTiming.checkTimeoutMs = 50;
    try {
        await svc.guardedCheck();
        assert.equal(tgs.length, 1);
        assert.ok(console.error.mock.calls.some(c => /Reminder check timed out/.test(c.arguments[0])));
        hang = false;
        await svc.guardedCheck();
        assert.equal(tgs.length, 2, 'the second check ran');
        assert.deepEqual(readDataSync(DOC).sent, [30]);
    } finally {
        svc.reminderTiming.checkTimeoutMs = saved;
    }
});

test('an expired license sends one notice with ignoreLicense and one audit entry', async () => {
    install({ expiresAt: '2026-11-16' });
    assert.equal(lic.isPaid(), false);
    const r = await svc.checkNow();
    assert.equal(r.expired, true);
    assert.equal(mails.length, 1); assert.equal(tgs.length, 1);
    assert.equal(mails[0].ignoreLicense, true); assert.equal(tgs[0].ignoreLicense, true);
    assert.equal(mails[0].text, svc.expiredText(lic.getLicense()));
    assert.deepEqual(audits, [['SYSTEM', 'License', 'License L-TEST-0001 expired on 2026-11-16: switched to the free edition']]);
    assert.equal(readDataSync(DOC).expiredNotified, true);
    await svc.checkNow();
    assert.equal(mails.length, 1); assert.equal(tgs.length, 1); assert.equal(audits.length, 1);
});

test('an expiry notice whose channels fail is retried without a second audit entry', async () => {
    install({ expiresAt: '2026-11-16' });
    mailOk = false; tgOk = false;
    await svc.checkNow();
    assert.equal(readDataSync(DOC).expiredNotified, false);
    tgOk = true;
    await svc.checkNow();
    assert.equal(readDataSync(DOC).expiredNotified, true);
    assert.equal(audits.length, 1);
});

test('an expiry with no channel configured is marked notified after the audit entry', async () => {
    install({ expiresAt: '2026-11-16' });
    for (const k of ENV) delete process.env[k];
    await svc.checkNow();
    assert.equal(audits.length, 1);
    assert.equal(readDataSync(DOC).expiredNotified, true);
});

test('the daily log line is written once per day, and again on the first check after a restart', async () => {
    install({ expiresAt: '2026-12-17' });
    const lines = () => console.log.mock.calls.map(c => c.arguments[0]).filter(m => /^\[License\] Expires in/.test(m));
    await svc.checkNow(); await svc.checkNow();
    assert.deepEqual(lines(), ['[License] Expires in 30 days (2026-12-17)']);
    assert.equal(readDataSync(DOC).lastLogDay, undefined, 'not persisted');
    svc._resetForTest(); // same as a process restart: in-memory state is gone, the reminders doc stays
    await svc.checkNow();
    assert.equal(lines().length, 2);
    setNow(2026, 11, 18);
    await svc.checkNow(); await svc.checkNow();
    assert.deepEqual(lines().slice(2), ['[License] Expires in 29 days (2026-12-17)']);
});

test('start runs a check immediately and stop clears the timer', async () => {
    install({ expiresAt: '2026-12-17' });
    svc.start({ intervalMs: 3600000 });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(mails.length, 1);
    svc.stop();
});
