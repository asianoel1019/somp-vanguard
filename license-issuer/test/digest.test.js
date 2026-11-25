// Weekly digest: once per ISO week after the configured weekday / time, catch-up after a late start, grouping by sales
// person (sales without licenses or without an email get nothing; the admin gets everything or "nothing expiring"),
// failures retried at most once per interval without resending what went out, disabled mail, and the timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDigest, INTERVAL_MS } = require('../src/digest');
const { startApp, fakeTransport, MAIL_ENV } = require('./helpers');

const WED = new Date(2026, 10, 25, 10, 0, 0); // Wednesday of 2026-W48

async function digestApp(t, { data = true, mailEnv = MAIL_ENV } = {}) {
    const transport = fakeTransport();
    const app = await startApp(t, { mailEnv, transport, start: WED });
    const c = await app.login();
    if (data) {
        const sales = {};
        for (const [name, email] of [['Alice Example', 'alice@example.test'], ['Bob Example', ''], ['Carol Example', 'carol@example.test']]) {
            sales[name] = (await c.call('POST', '/api/sales', { body: { name, ...(email ? { email } : {}) } })).json.sales;
        }
        const issue = async (customer, salesId, expiresAt) => {
            const r = await c.call('POST', '/api/licenses', { body: { newCustomer: { name: customer }, salesId, expiresAt } });
            assert.equal(r.status, 201, r.text);
        };
        await issue('Alpha Co', sales['Alice Example'].id, '2026-12-20');
        await issue('Beta Co', sales['Alice Example'].id, '2027-01-31');
        await issue('Gamma Co', sales['Alice Example'].id, '2027-11-24'); // not within 90 days
        await issue('Delta Co', sales['Bob Example'].id, '2027-02-01');
        await issue('Omega Co', sales['Carol Example'].id, '2028-01-01'); // Carol: nothing expiring
        // issued with a sales person, then unassigned (e.g. an imported license has none)
        const later = await c.issue({ customer: 'Unassigned Co', licenseId: 'L-2026-0006', issuedAt: '2026-11-25', expiresAt: '2026-12-31' });
        assert.equal(later.status, 201, later.text);
        const unassigned = await c.call('PATCH', '/api/licenses/L-2026-0006', { body: { salesId: null } });
        assert.equal(unassigned.status, 200, unassigned.text);
        assert.equal(unassigned.json.license.salesId, null);
    }
    return { app, c, transport };
}

test('catch-up after a late start, once per ISO week, next week after weekday + time; grouping per sales person', async (t) => {
    const { app, transport } = await digestApp(t);
    assert.equal(app.digest.status().scheduled, false); // the app never starts the timer itself
    const r = await app.digest.check();
    assert.equal(r.status, 'sent', JSON.stringify(r));
    assert.equal(r.week, '2026-W48');
    assert.deepEqual(transport.sent.map((m) => m.to.address), ['alice@example.test', 'admin@example.test']);
    const alice = transport.sent[0];
    assert.match(alice.subject, /2 \(2026-W48\)/);
    assert.ok(alice.text.indexOf('Alpha Co') < alice.text.indexOf('Beta Co'), 'sorted by expiry');
    assert.ok(!alice.text.includes('Gamma Co') && !alice.text.includes('Delta Co'));
    const admin = transport.sent[1];
    assert.match(admin.subject, /License digest 2026-W48: 4 license\(s\)/);
    assert.match(admin.text, /Alice Example <alice@example\.test>: 2/);
    assert.match(admin.text, /Bob Example \(no email\): 1/);
    assert.match(admin.text, /Unassigned: 1\n- 2026-12-31 \(36 days left\)  L-2026-0006  Unassigned Co/);
    assert.ok(admin.text.indexOf('Unassigned') > admin.text.indexOf('Bob Example'), 'unassigned last');
    assert.ok(!admin.text.includes('Carol'));
    assert.equal(app.store.getSettings().lastDigestWeek, '2026-W48');
    assert.match(app.auditText(), /"event":"digest","reason":"2026-W48: 2 mail\(s\) sent/);

    assert.equal((await app.digest.check()).status, 'not-due');
    app.clock.ms = new Date(2026, 10, 29, 23, 59).getTime(); // Sunday, still W48
    assert.equal((await app.digest.check()).status, 'not-due');
    app.clock.ms = new Date(2026, 10, 30, 8, 59).getTime(); // Monday W49 before 09:00
    assert.equal((await app.digest.check()).status, 'not-due');
    app.clock.ms = new Date(2026, 10, 30, 9, 0).getTime();
    const w49 = await app.digest.check();
    assert.deepEqual([w49.status, w49.week], ['sent', '2026-W49']);
    assert.equal(transport.sent.length, 4);
    assert.equal((await app.digest.check()).status, 'not-due');
    assert.equal(app.store.getSettings().lastDigestWeek, '2026-W49');
});

test('configured weekday / time is respected (Friday 08:30 is not due on Wednesday)', async (t) => {
    const { app, c, transport } = await digestApp(t);
    await c.call('PATCH', '/api/settings', { body: { digestWeekday: 5, digestTime: '08:30' } });
    assert.equal((await app.digest.check()).status, 'not-due');
    app.clock.ms = new Date(2026, 10, 27, 8, 29).getTime();
    assert.equal((await app.digest.check()).status, 'not-due');
    app.clock.ms = new Date(2026, 10, 27, 8, 30).getTime();
    assert.equal((await app.digest.check()).status, 'sent');
    assert.equal(transport.sent.length, 2);
});

test('nothing expiring: only the admin gets a short mail; no MAIL_ADMIN: nothing sent but the week is done', async (t) => {
    const { app, transport } = await digestApp(t, { data: false });
    assert.equal((await app.digest.check()).status, 'sent');
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].to.address, 'admin@example.test');
    assert.match(transport.sent[0].subject, /nothing expiring within 90 days/);
    assert.match(transport.sent[0].text, /No license expires within the next 90 days/);

    const noAdmin = await digestApp(t, { data: false, mailEnv: { ...MAIL_ENV, MAIL_ADMIN: '' } });
    assert.equal((await noAdmin.app.digest.check()).status, 'sent');
    assert.equal(noAdmin.transport.sent.length, 0);
    assert.equal(noAdmin.app.store.getSettings().lastDigestWeek, '2026-W48');
});

test('mail not configured: the digest does nothing', async (t) => {
    const { app } = await digestApp(t, { mailEnv: {} });
    assert.equal((await app.digest.check()).status, 'disabled');
    assert.equal(app.store.getSettings().lastDigestWeek, '');
});

test('failure: logged, retried at most once per 10 minutes, mails that went out are not sent again', async (t) => {
    const { app, transport } = await digestApp(t);
    const send = transport.sendMail;
    let adminDown = true;
    transport.sendMail = async (msg) => {
        if (adminDown && msg.to.address === 'admin@example.test') throw new Error(`421 try later ${MAIL_ENV.SMTP_PASS}`);
        return send(msg);
    };
    const first = await app.digest.check();
    assert.equal(first.status, 'failed');
    assert.deepEqual(first.sent.map((s) => s.to), ['alice@example.test']);
    assert.equal(app.store.getSettings().lastDigestWeek, '');
    assert.match(app.auditText(), /"event":"digest-failed"/);
    assert.ok(!app.auditText().includes(MAIL_ENV.SMTP_PASS));
    assert.equal(app.digest.status().lastRun.status, 'failed');
    assert.ok(!JSON.stringify(app.digest.status()).includes(MAIL_ENV.SMTP_PASS));

    app.clock.ms += 5 * 60 * 1000;
    assert.equal((await app.digest.check()).status, 'throttled');
    app.clock.ms += 5 * 60 * 1000;
    assert.equal((await app.digest.check()).status, 'failed'); // still down: one more try after 10 minutes
    adminDown = false;
    app.clock.ms += INTERVAL_MS;
    const ok = await app.digest.check();
    assert.equal(ok.status, 'sent');
    assert.deepEqual(ok.sent.map((s) => s.to), ['admin@example.test']);
    assert.deepEqual(transport.sent.map((m) => m.to.address), ['alice@example.test', 'admin@example.test']);
    assert.equal(app.store.getSettings().lastDigestWeek, '2026-W48');
});

test('a sales address the server refuses for good (5xx) is logged and audited once, not retried; the week is done', async (t) => {
    const { app, transport } = await digestApp(t);
    const send = transport.sendMail;
    let refusals = 0;
    transport.sendMail = async (msg) => {
        if (msg.to.address === 'alice@example.test') {
            refusals += 1;
            throw Object.assign(new Error('550 5.1.1 <alice@example.test>: Recipient address rejected'), { code: 'EENVELOPE', responseCode: 550 });
        }
        return send(msg);
    };
    const r = await app.digest.check();
    assert.equal(r.status, 'sent');
    assert.deepEqual(r.sent.map((s) => s.to), ['admin@example.test']);
    assert.deepEqual(r.rejected.map((s) => s.to), ['alice@example.test']);
    assert.equal(app.store.getSettings().lastDigestWeek, '2026-W48');
    assert.match(app.auditText(), /"event":"digest-failed".*refused by the mail server \(not retried\)/);
    assert.match(app.digest.status().lastRun.error, /alice@example\.test: 550/);
    app.clock.ms += INTERVAL_MS;
    assert.equal((await app.digest.check()).status, 'not-due');
    assert.equal(refusals, 1);
});

test('after a failure the retry is not skipped when the interval timer fires a little early', async (t) => {
    const { app, transport } = await digestApp(t);
    transport.fail = '421 try later';
    assert.equal((await app.digest.check()).status, 'failed');
    transport.fail = null;
    app.clock.ms += INTERVAL_MS - 500; // timer jitter
    assert.equal((await app.digest.check()).status, 'sent');
});

test('preview endpoint shows the mails without sending; checks never overlap', async (t) => {
    const { app, c, transport } = await digestApp(t);
    const p = await c.call('GET', '/api/mail/digest');
    assert.equal(p.status, 200);
    assert.deepEqual([p.json.week, p.json.due, p.json.total], ['2026-W48', true, 4]);
    assert.deepEqual(p.json.mails.map((m) => [m.kind, m.to]), [['sales', 'alice@example.test'], ['admin', 'admin@example.test']]);
    assert.equal(transport.sent.length, 0);
    const [a, b] = await Promise.all([app.digest.check(), app.digest.check()]);
    assert.deepEqual([a.status, b.status], ['sent', 'running']);
    assert.equal(transport.sent.length, 2);
});

test('start(): a catch-up check soon after start and one every 10 minutes, timers unref\'d; stop() clears them', async () => {
    const calls = [];
    const handle = (kind, ms) => { const h = { kind, ms, unrefed: false, unref() { h.unrefed = true; } }; calls.push(h); return h; };
    const cleared = [];
    let checks = 0;
    const store = { getSettings: () => { checks += 1; return { digestWeekday: 1, digestTime: '09:00', lastDigestWeek: '' }; } };
    const mailer = { status: () => ({ enabled: false }) };
    const d = createDigest({
        store, mailer, now: () => WED,
        timers: { setTimeout: (fn, ms) => { const h = handle('timeout', ms); h.fn = fn; return h; }, setInterval: (fn, ms) => { const h = handle('interval', ms); h.fn = fn; return h; },
            clearTimeout: (h) => cleared.push(h.kind), clearInterval: (h) => cleared.push(h.kind) },
    });
    d.start();
    d.start(); // only once
    assert.deepEqual(calls.map((h) => [h.kind, h.unrefed]), [['timeout', true], ['interval', true]]);
    assert.equal(calls[1].ms, 10 * 60 * 1000);
    assert.equal((await d.check()).status, 'disabled');
    d.stop();
    assert.deepEqual(cleared.sort(), ['interval', 'timeout']);
    assert.equal(checks, 0);
});
