// Mail: SMTP settings (disabled with a reason), status, test mail, delivery preview / send with the .lic attachment
// (hash checked), delivered / delivery_failed events, and the SMTP password never leaving the transport. Fake transport only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { readMailConfig } = require('../src/config');
const { renderTemplate, unknownVariables, createMailer } = require('../src/mail');
const { startApp, fakeTransport, MAIL_ENV } = require('./helpers');

async function mailApp(t, { mailEnv = MAIL_ENV, customerEmail = 'it@example.test' } = {}) {
    const transport = fakeTransport();
    const app = await startApp(t, { mailEnv, transport });
    const c = await app.login();
    const s = (await c.call('POST', '/api/sales', { body: { name: 'Alice Example', email: 'alice@example.test' } })).json.sales;
    const r = await c.call('POST', '/api/licenses', {
        body: { newCustomer: { name: 'Example Corp.', ...(customerEmail ? { email: customerEmail } : {}) }, salesId: s.id, planId: 2, contactVendor: 'Example Vendor', contactEmail: 'support@example.test' },
    });
    assert.equal(r.status, 201, r.text);
    return { app, c, transport, file: r.json.file };
}

test('readMailConfig: disabled with a reason when incomplete or invalid; the password is not enumerable', () => {
    assert.deepEqual([readMailConfig({}).enabled, readMailConfig({}).reason], [false, 'SMTP_HOST is not set; MAIL_FROM is not set']);
    assert.equal(readMailConfig({ SMTP_HOST: 'smtp.example.test' }).reason, 'MAIL_FROM is not set');
    const ok = readMailConfig(MAIL_ENV);
    assert.equal(ok.enabled, true);
    assert.equal(ok.port, 587);
    assert.equal(ok.secure, false);
    assert.deepEqual(ok.from, { name: 'SOMP License Issuer', address: 'issuer@example.test' });
    assert.equal(ok.pass, MAIL_ENV.SMTP_PASS);
    assert.ok(!JSON.stringify(ok).includes(MAIL_ENV.SMTP_PASS));
    assert.ok(!Object.keys(ok).includes('pass'));
    assert.equal(readMailConfig({ ...MAIL_ENV, SMTP_SECURE: 'TRUE', SMTP_PORT: '465' }).secure, true);
    for (const [k, v, re] of [['SMTP_PORT', '70000', /SMTP_PORT/], ['SMTP_SECURE', 'maybe', /SMTP_SECURE/], ['MAIL_FROM', 'a@b.test, evil@example.test', /MAIL_FROM/],
        ['MAIL_FROM', 'Name <x@y.test>\r\nBcc: z@example.test', /MAIL_FROM/], ['MAIL_ADMIN', 'admin@example.test;x@example.test', /MAIL_ADMIN/],
        ['SMTP_USER', '', /SMTP_PASS is set/], ['SMTP_HOST', 'smtp example', /SMTP_HOST/]]) {
        const m = readMailConfig({ ...MAIL_ENV, [k]: v });
        assert.equal(m.enabled, false, `${k}=${v}`);
        assert.match(m.reason, re);
    }
});

test('templates: one pass, unknown placeholders kept and reported', () => {
    assert.equal(renderTemplate('{customer} {licenseId} {nope}', { customer: '{licenseId}', licenseId: 'L-1' }), '{licenseId} L-1 {nope}');
    assert.deepEqual(unknownVariables('{customer} {customr} {customr}'), ['{customr}']);
});

test('mail status and test mail: no password anywhere; disabled mail answers 503 with the reason', async (t) => {
    const { app, c, transport } = await mailApp(t);
    const s = await c.call('GET', '/api/mail/status');
    assert.equal(s.status, 200);
    assert.equal(s.json.enabled, true);
    assert.equal(s.json.from, 'SOMP License Issuer <issuer@example.test>');
    assert.equal(s.json.admin, 'admin@example.test');
    assert.equal(s.json.auth, true);
    assert.equal(s.json.digest.weekday, 1);
    const toAdmin = await c.call('POST', '/api/mail/test', { body: {} });
    assert.equal(toAdmin.status, 200, toAdmin.text);
    assert.equal(transport.sent[0].to.address, 'admin@example.test');
    assert.match(transport.sent[0].subject, /test mail/);
    assert.equal(transport.options.auth.pass, MAIL_ENV.SMTP_PASS); // only the transport gets it
    assert.equal((await c.call('POST', '/api/mail/test', { body: { to: 'ops@example.test' } })).json.to, 'ops@example.test');
    for (const to of ['nope', 'a@b.test, c@d.test', 'x@y.test>', '"x"@y.test', 42]) {
        assert.equal((await c.call('POST', '/api/mail/test', { body: { to } })).status, 400, String(to));
    }
    transport.fail = `Invalid login: 535 bad credentials for ${MAIL_ENV.SMTP_PASS}`;
    const failed = await c.call('POST', '/api/mail/test', { body: {} });
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /535/);
    assert.ok(!failed.text.includes(MAIL_ENV.SMTP_PASS));
    assert.equal(transport.sent.length, 2);
    for (const body of app.seen) assert.ok(!body.includes(MAIL_ENV.SMTP_PASS), 'a response contains SMTP_PASS');
    assert.ok(!app.auditText().includes(MAIL_ENV.SMTP_PASS), 'the audit log contains SMTP_PASS');
    assert.match(app.auditText(), /"event":"mail-test","to":"admin@example.test"/);
    assert.match(app.auditText(), /"event":"mail-test-failed"/);
});

test('mail not configured: status says why, sending is 503, preview still works', async (t) => {
    const { c, transport } = await mailApp(t, { mailEnv: { SMTP_HOST: 'smtp.example.test' } });
    const s = await c.call('GET', '/api/mail/status');
    assert.deepEqual([s.json.enabled, s.json.reason], [false, 'MAIL_FROM is not set']);
    const tm = await c.call('POST', '/api/mail/test', { body: { to: 'ops@example.test' } });
    assert.equal(tm.status, 503);
    assert.match(tm.json.error, /MAIL_FROM is not set/);
    const p = await c.call('GET', '/api/licenses/L-2026-0001/delivery');
    assert.equal(p.status, 200);
    assert.equal(p.json.canSend, false);
    assert.equal(p.json.mail.reason, 'MAIL_FROM is not set');
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'it@example.test' } })).status, 503);
    assert.equal(transport.sent.length, 0);
});

test('delivery: preview renders the templates; send attaches the .lic and records delivered (+ reissued with a reason)', async (t) => {
    const { app, c, transport, file } = await mailApp(t);
    await c.call('PATCH', '/api/settings', { body: { mailSubject: '{type} license {licenseId} for {customer}', mailBody: 'Dear {customer},\n{issuedAt}..{expiresAt}\nSales: {sales}\n{vendor} <{vendorEmail}> {unknown}' } });
    const p = await c.call('GET', '/api/licenses/L-2026-0001/delivery');
    assert.equal(p.status, 200, p.text);
    assert.deepEqual([p.json.to, p.json.toValid, p.json.canSend, p.json.blocked], ['it@example.test', true, true, null]);
    assert.equal(p.json.subject, 'paid license L-2026-0001 for Example Corp.');
    assert.equal(p.json.text, 'Dear Example Corp.,\n2026-11-25..2027-11-24\nSales: Alice Example\nExample Vendor <support@example.test> {unknown}');
    assert.deepEqual(p.json.attachment, { name: 'L-2026-0001-example-corp.lic', ok: true, error: null });

    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/send', { body: {} })).status, 400);
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'bad address' } })).json.field, 'to');
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'it@example.test', cc: 'x@example.test' } })).status, 400);
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0099/send', { body: { to: 'it@example.test' } })).status, 404);
    assert.equal(transport.sent.length, 0);

    const r = await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'buyer@example.test' } });
    assert.equal(r.status, 200, r.text);
    const m = transport.sent[0];
    assert.deepEqual(m.to, { name: '', address: 'buyer@example.test' });
    assert.deepEqual(m.from, { name: 'SOMP License Issuer', address: 'issuer@example.test' });
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].filename, 'L-2026-0001-example-corp.lic');
    assert.deepEqual(m.attachments[0].content, fs.readFileSync(file));
    assert.equal(r.json.event.type, 'delivered');
    assert.equal(r.json.event.detail.to, 'buyer@example.test');
    assert.equal(r.json.reissued, null);

    const again = await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'buyer@example.test', reason: 'Mail was lost' } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.reissued.detail, { reason: 'Mail was lost', via: 'mail', to: 'buyer@example.test' });
    assert.deepEqual(app.store.licenseEvents('L-2026-0001').map((e) => e.type), ['issued', 'delivered', 'delivered', 'reissued']);
    assert.match(app.auditText(), /"event":"deliver","licenseId":"L-2026-0001"/);
});

test('delivery: a changed file is not attached; SMTP failure records delivery_failed; revoked / no email are flagged', async (t) => {
    const { app, c, transport, file } = await mailApp(t, { customerEmail: '' });
    const p = await c.call('GET', '/api/licenses/L-2026-0001/delivery');
    assert.deepEqual([p.json.to, p.json.toValid], ['', false]);

    const original = fs.readFileSync(file);
    fs.appendFileSync(file, ' ');
    const changed = await c.call('GET', '/api/licenses/L-2026-0001/delivery');
    assert.equal(changed.json.attachment.ok, false);
    assert.equal(changed.json.canSend, false);
    const refused = await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'it@example.test' } });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /SHA-256/);
    assert.equal(transport.sent.length, 0);
    fs.writeFileSync(file, original);

    transport.fail = `Connection refused (user issuer, pass ${MAIL_ENV.SMTP_PASS})`;
    const failed = await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'it@example.test' } });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.event.type, 'delivery_failed');
    assert.match(failed.json.event.detail.error, /Connection refused/);
    const events = app.store.licenseEvents('L-2026-0001');
    assert.ok(!JSON.stringify(events).includes(MAIL_ENV.SMTP_PASS));
    assert.ok(!failed.text.includes(MAIL_ENV.SMTP_PASS));
    assert.ok(!app.auditText().includes(MAIL_ENV.SMTP_PASS));
    assert.match(app.auditText(), /"event":"deliver-failed"/);

    transport.fail = null;
    await c.call('POST', '/api/licenses/L-2026-0001/revoke', { body: { reason: 'terminated' } });
    const rv = await c.call('GET', '/api/licenses/L-2026-0001/delivery');
    assert.match(rv.json.blocked, /revoked/);
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/send', { body: { to: 'it@example.test' } })).status, 409);
    assert.equal(transport.sent.length, 0);
});

test('createMailer: never rejects; a failed transport is created again next time', async () => {
    const tr = fakeTransport();
    const mailer = createMailer(readMailConfig(MAIL_ENV), { createTransport: tr.createTransport });
    tr.fail = 'boom';
    assert.deepEqual(await mailer.send({ to: 'a@example.test', subject: 's', text: 't' }), { ok: false, permanent: false, error: 'boom' });
    tr.fail = null;
    assert.equal((await mailer.send({ to: 'a@example.test', subject: 's\r\nBcc: x@example.test', text: 't' })).ok, true);
    assert.equal(tr.created, 2);
    assert.equal(tr.sent[0].subject, 's Bcc: x@example.test');
    assert.equal((await mailer.send({ to: 'a@example.test,b@example.test', subject: 's', text: 't' })).ok, false);
    assert.equal((await createMailer(readMailConfig({})).send({ to: 'a@example.test', subject: 's', text: 't' })).ok, false);
});

test('createMailer: only a 5xx refusal of the envelope (the address) is permanent; 4xx, auth and connection errors are retried', async () => {
    const tr = fakeTransport();
    const mailer = createMailer(readMailConfig(MAIL_ENV), { createTransport: tr.createTransport });
    const error = (message, props) => Object.assign(new Error(message), props);
    const send = async (err) => {
        tr.sendMail = async () => { throw err; };
        return mailer.send({ to: 'a@example.test', subject: 's', text: 't' });
    };
    assert.equal((await send(error('550 5.1.1 no such user', { code: 'EENVELOPE', responseCode: 550 }))).permanent, true);
    assert.equal((await send(error('553 mailbox name not allowed', { code: 'EENVELOPE', responseCode: 553 }))).permanent, true);
    assert.equal((await send(error('450 mailbox busy', { code: 'EENVELOPE', responseCode: 450 }))).permanent, false);
    assert.equal((await send(error('535 auth failed', { code: 'EAUTH', responseCode: 535 }))).permanent, false);
    assert.equal((await send(error('connect ECONNREFUSED', { code: 'ESOCKET' }))).permanent, false);
});
