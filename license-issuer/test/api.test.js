// Business API: sign-in / Origin / CSRF on every new endpoint, input checks (400 and nothing written), sales people,
// plans, customers, settings, issuing with sales, replace / edit / revoke / reissue, license list and detail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp } = require('./helpers');

const ROUTES = [
    ['GET', '/api/meta'], ['GET', '/api/settings'], ['PATCH', '/api/settings'],
    ['GET', '/api/sales'], ['POST', '/api/sales'], ['PATCH', '/api/sales/1'],
    ['GET', '/api/plans'], ['POST', '/api/plans'], ['PATCH', '/api/plans/1'],
    ['GET', '/api/customers'], ['GET', '/api/customers/1'], ['POST', '/api/customers'], ['PATCH', '/api/customers/1'], ['DELETE', '/api/customers/1'],
    ['GET', '/api/licenses'], ['POST', '/api/licenses'], ['GET', '/api/licenses/L-2026-0001'], ['PATCH', '/api/licenses/L-2026-0001'],
    ['POST', '/api/licenses/L-2026-0001/replace'], ['POST', '/api/licenses/L-2026-0001/revoke'], ['POST', '/api/licenses/L-2026-0001/reissue'],
    ['GET', '/api/licenses/L-2026-0001/events'], ['GET', '/api/licenses/L-2026-0001/delivery'], ['POST', '/api/licenses/L-2026-0001/send'],
    ['GET', '/api/mail/status'], ['POST', '/api/mail/test'], ['GET', '/api/mail/digest'],
    ['GET', '/api/dashboard'], ['GET', '/api/renewals'], ['GET', '/api/reports'], ['GET', '/api/reports/summary.csv'], ['GET', '/api/reports/detail.csv'],
    ['GET', '/api/backups'], ['POST', '/api/backups'], ['GET', '/api/backups/license-issuer-backup-20261125-100000.db'],
];

/** App with one sales person, one customer and one issued paid license L-2026-0001. */
async function withLicense(t, opts) {
    const app = await startApp(t, opts);
    const c = await app.login();
    const s = await c.call('POST', '/api/sales', { body: { name: 'Alice Example', email: 'alice@example.test' } });
    assert.equal(s.status, 201, s.text);
    const r = await c.call('POST', '/api/licenses', {
        body: { newCustomer: { name: 'Example Corp.', email: 'it@example.test' }, salesId: s.json.sales.id, planId: 2, amount: 1200, orderNo: 'PO-1' },
    });
    assert.equal(r.status, 201, r.text);
    return { app, c, sales: s.json.sales, issued: r.json };
}

test('every new endpoint answers 401 without a session; state-changing ones 403 without Origin or CSRF token', async (t) => {
    const app = await startApp(t);
    for (const [method, p] of ROUTES) {
        const r = await app.request(method, p, { body: method === 'GET' ? undefined : {} });
        assert.equal(r.status, 401, `${method} ${p}`);
    }
    const c = await app.login();
    for (const [method, p] of ROUTES.filter(([m]) => m !== 'GET')) {
        assert.equal((await c.call(method, p, { body: {}, headers: { 'X-CSRF-Token': undefined } })).status, 403, `${method} ${p} without CSRF`);
        assert.equal((await c.call(method, p, { body: {}, headers: { Origin: 'http://evil.example.test' } })).status, 403, `${method} ${p} foreign Origin`);
    }
    assert.equal(app.store.listSales().length, 0);
    assert.equal(app.store.listCustomers().length, 0);
    assert.equal(app.store.listBackups().length, 0);
});

test('sales people: create, list, edit, deactivate; bad input is 400 and writes nothing', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const a = await c.call('POST', '/api/sales', { body: { name: 'Alice Example', email: 'alice@example.test' } });
    assert.equal(a.status, 201);
    assert.equal(a.json.sales.active, true);
    for (const [body, field] of [[{ name: '' }, 'name'], [{ name: 'x'.repeat(101) }, 'name'], [{ name: 'Bob', email: 'not an email' }, 'email'],
        [{ name: 'Bob', role: 'admin' }, 'role'], [{ name: 'alice EXAMPLE' }, 'name'], [{ name: 42 }, 'name']]) {
        const r = await c.call('POST', '/api/sales', { body });
        assert.ok([400, 409].includes(r.status), JSON.stringify(body));
        assert.equal(r.json.field, field, JSON.stringify(body));
    }
    assert.equal((await c.call('POST', '/api/sales', { body: [1] })).status, 400);
    assert.equal(app.store.listSales().length, 1);
    const id = a.json.sales.id;
    assert.equal((await c.call('PATCH', `/api/sales/${id}`, { body: { active: 'no' } })).status, 400);
    assert.equal((await c.call('PATCH', '/api/sales/abc', { body: { active: false } })).status, 400);
    assert.equal((await c.call('PATCH', '/api/sales/999', { body: { active: false } })).status, 404);
    const off = await c.call('PATCH', `/api/sales/${id}`, { body: { active: false, email: '' } });
    assert.equal(off.status, 200);
    assert.deepEqual([off.json.sales.active, off.json.sales.email], [false, null]);
    assert.equal((await c.call('GET', '/api/sales?active=1')).json.sales.length, 0);
    assert.equal((await c.call('GET', '/api/sales')).json.sales.length, 1);
    assert.equal((await c.call('GET', '/api/sales?active=maybe')).status, 400);
    assert.match(app.auditText(), /"event":"sales-create"/);
    assert.match(app.auditText(), /"event":"sales-update"/);
});

test('plans and settings: create / edit / deactivate; templates and digest time are checked', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    assert.deepEqual((await c.call('GET', '/api/plans')).json.plans.map((p) => p.name).sort(), ['1 year', '2 years', '3 years', 'Trial 30 days']);
    const p = await c.call('POST', '/api/plans', { body: { name: '6 months', type: 'paid', termValue: 6, termUnit: 'months', price: 600, currency: 'usd' } });
    assert.equal(p.status, 201, p.text);
    assert.equal(p.json.plan.currency, 'USD');
    assert.equal((await c.call('POST', '/api/plans', { body: { name: 'Long trial', type: 'trial', termValue: 90, termUnit: 'days' } })).json.field, 'termValue');
    assert.equal((await c.call('POST', '/api/plans', { body: { name: 'X', type: 'gift', termValue: 1, termUnit: 'days' } })).status, 400);
    const off = await c.call('PATCH', `/api/plans/${p.json.plan.id}`, { body: { active: false } });
    assert.equal(off.json.plan.active, false);
    assert.equal((await c.call('GET', '/api/plans?active=true')).json.plans.length, 4);

    const s = await c.call('GET', '/api/settings');
    assert.equal(s.json.settings.digestWeekday, 1);
    assert.ok(s.json.templateVariables.customer);
    const up = await c.call('PATCH', '/api/settings', { body: { mailSubject: 'License {licenseId} for {customr}', digestWeekday: 5, digestTime: '08:30', defaultCurrency: 'usd' } });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual([up.json.settings.digestWeekday, up.json.settings.digestTime, up.json.settings.defaultCurrency], [5, '08:30', 'USD']);
    assert.match(up.json.warnings[0], /\{customr\}/);
    for (const body of [{ digestTime: '25:00' }, { digestWeekday: 8 }, { mailBody: '' }, { lastDigestWeek: '2026-W01' }, { defaultCurrency: 'XXX' }, {},
        { mailBody: 'x'.repeat(10001) }]) {
        assert.equal((await c.call('PATCH', '/api/settings', { body })).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(app.store.getSettings().digestTime, '08:30');
    assert.equal(app.store.getSettings().lastDigestWeek, '');
});

test('customers: create, search, detail with licenses, edit; delete only without licenses', async (t) => {
    const { app, c } = await withLicense(t);
    const n = await c.call('POST', '/api/customers', { body: { name: 'Second Example Ltd.', taxId: '12345678', phone: '+886-2-0000-0000' } });
    assert.equal(n.status, 201, n.text);
    assert.equal((await c.call('POST', '/api/customers', { body: { name: 'second example ltd.' } })).status, 409);
    assert.equal((await c.call('POST', '/api/customers', { body: { name: 'Third', email: 'bad' } })).json.field, 'email');
    assert.equal((await c.call('POST', '/api/customers', { body: { name: 'Third', password: 'x' } })).json.field, 'password');
    const list = await c.call('GET', '/api/customers?q=second');
    assert.deepEqual(list.json.customers.map((x) => x.name), ['Second Example Ltd.']);
    const ex = app.store.findCustomerByName('Example Corp.');
    const d = await c.call('GET', `/api/customers/${ex.id}`);
    assert.equal(d.json.customer.licenses[0].licenseId, 'L-2026-0001');
    assert.equal(d.json.customer.nextExpiry, '2027-11-24');
    assert.equal((await c.call('GET', '/api/customers/999')).status, 404);
    assert.equal((await c.call('GET', '/api/customers/x')).status, 400);
    const e = await c.call('PATCH', `/api/customers/${n.json.customer.id}`, { body: { notes: 'Line 1\nLine 2' } });
    assert.equal(e.json.customer.notes, 'Line 1\nLine 2');
    assert.equal((await c.call('DELETE', `/api/customers/${ex.id}`)).status, 409);
    assert.equal((await c.call('DELETE', `/api/customers/${n.json.customer.id}`)).status, 200);
    assert.equal(app.store.listCustomers().length, 1);
    assert.match(app.auditText(), /"event":"customer-delete"/);
});

test('issue: sales is required; trial rules; renewal; refusals write nothing', async (t) => {
    const { app, c, sales, issued } = await withLicense(t);
    assert.equal(issued.licenseId, 'L-2026-0001');
    assert.equal(issued.license.salesName, 'Alice Example');
    assert.equal(issued.license.expiresAt, '2027-11-24'); // plan "1 year"
    assert.equal(issued.license.amount, 1200);
    assert.equal(issued.license.currency, 'TWD');
    assert.equal(issued.fileName, 'L-2026-0001-example-corp.lic');
    assert.ok(fs.existsSync(issued.file));
    const cust = issued.license.customerId;
    const files = () => fs.readdirSync(app.config.issuedDir).length;
    const before = files();
    const bad = [
        [{ customerId: cust }, 400, 'sales-required'],
        [{ customerId: cust, salesId: 999 }, 404, 'not-found'],
        [{ salesId: sales.id }, 400, 'invalid'],
        [{ customerId: cust, newCustomer: { name: 'X' }, salesId: sales.id }, 400, 'invalid'],
        [{ newCustomer: { name: 'X', secret: 1 }, salesId: sales.id }, 400, 'invalid'],
        [{ customerId: cust, salesId: sales.id, amount: -1, expiresAt: '2027-12-31' }, 400, 'invalid'],
        [{ customerId: cust, salesId: sales.id, currency: 'BTC', expiresAt: '2027-12-31' }, 400, 'invalid'],
        [{ customerId: cust, salesId: sales.id, expiresAt: '2026-02-30' }, 400, 'invalid'],
        [{ customerId: cust, salesId: sales.id, licenseId: 'L-2026-0001', expiresAt: '2027-12-31' }, 409, 'duplicate-id'],
        [{ customerId: cust, salesId: sales.id, planId: 1, amount: 5 }, 400, 'trial-amount'],
        [{ customerId: cust, salesId: sales.id, type: 'trial', expiresAt: '2027-01-30' }, 400, 'trial-term'],
        [{ customerId: cust, salesId: sales.id, contactEmail: 'nope', expiresAt: '2027-12-31' }, 400, 'contact-invalid'],
        [{ customerId: cust, salesId: sales.id, expiresAt: '2027-12-31', extra: true }, 400, 'invalid'],
    ];
    for (const [body, status, code] of bad) {
        const r = await c.call('POST', '/api/licenses', { body });
        assert.equal(r.status, status, `${JSON.stringify(body)} ${r.text}`);
        assert.equal(r.json.code, code, JSON.stringify(body));
    }
    assert.equal(files(), before);
    assert.equal(app.store.licenseCount(), 1);
    assert.equal(app.store.listCustomers().length, 1);
    const dup = await c.call('POST', '/api/licenses', { body: { customerId: cust, salesId: sales.id, licenseId: 'L-2026-0001', expiresAt: '2027-12-31' } });
    assert.equal(dup.json.nextId, 'L-2026-0002');

    const trial = await c.call('POST', '/api/licenses', { body: { newCustomer: { name: 'Trial Co' }, salesId: sales.id, planId: 1 } });
    assert.equal(trial.status, 201, trial.text);
    assert.equal(trial.json.license.type, 'trial');
    assert.equal(trial.json.license.amount, 0);
    const again = await c.call('POST', '/api/licenses', { body: { customerId: trial.json.license.customerId, salesId: sales.id, planId: 1 } });
    assert.equal(again.status, 409);
    assert.equal(again.json.usedBy, trial.json.licenseId);
    const renew = await c.call('POST', '/api/licenses', { body: { customerId: cust, salesId: sales.id, planId: 2, renewalOf: 'L-2026-0001', issuedAt: '2026-11-25', expiresAt: '2028-11-24' } });
    assert.equal(renew.status, 201, renew.text);
    assert.equal(renew.json.license.isRenewal, true);
    assert.match(app.auditText(), /"event":"issue","licenseId":"L-2026-0001"/);
    assert.match(app.auditText(), /"event":"issue-refused"/);
});

test('license list, detail with timeline and file check; edit, reissue, revoke, replace', async (t) => {
    const { app, c, sales } = await withLicense(t);
    const bob = (await c.call('POST', '/api/sales', { body: { name: 'Bob Example' } })).json.sales;
    const list = await c.call('GET', '/api/licenses?q=example&type=paid&includeRevoked=0&sort=expiry');
    assert.deepEqual(list.json.licenses.map((l) => l.licenseId), ['L-2026-0001']);
    assert.equal((await c.call('GET', '/api/licenses?status=Nope')).status, 400);
    assert.equal((await c.call('GET', '/api/licenses?type=paid&type=trial')).status, 400);
    assert.equal((await c.call('GET', `/api/licenses?salesId=${sales.id}&period=month&date=2026-11-01`)).json.licenses.length, 1);
    assert.equal((await c.call('GET', '/api/licenses?period=week')).status, 400);

    const d = await c.call('GET', '/api/licenses/l-2026-0001');
    assert.equal(d.status, 200);
    assert.equal(d.json.license.licenseId, 'L-2026-0001');
    assert.deepEqual(d.json.events.map((e) => e.type), ['issued']);
    assert.equal(d.json.file.ok, true);
    assert.equal(d.json.customer.name, 'Example Corp.');
    assert.equal((await c.call('GET', '/api/licenses/L-2026-0099')).status, 404);
    assert.equal((await c.call('GET', '/api/licenses/..%2F..%2Fx')).status, 404);

    const e = await c.call('PATCH', '/api/licenses/L-2026-0001', { body: { salesId: bob.id, amount: '1500.50', orderNo: 'PO-2' } });
    assert.equal(e.status, 200, e.text);
    assert.equal(e.json.changed, true);
    assert.equal(e.json.license.amount, 1500.5);
    assert.equal((await c.call('PATCH', '/api/licenses/L-2026-0001', { body: { expiresAt: '2030-01-01' } })).status, 400);
    assert.equal((await c.call('PATCH', '/api/licenses/L-2026-0001', { body: { amount: '1.234' } })).status, 400);

    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/reissue', { body: {} })).status, 400);
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/reissue', { body: { reason: 'Lost', via: 'fax' } })).status, 400);
    const ri = await c.call('POST', '/api/licenses/L-2026-0001/reissue', { body: { reason: 'Customer lost the file' } });
    assert.equal(ri.status, 201);
    assert.deepEqual(ri.json.event.detail, { reason: 'Customer lost the file', via: 'download' });

    const rep = await c.call('POST', '/api/licenses/L-2026-0001/replace', { body: { expiresAt: '2027-12-31', note: 'Typo in name', amount: 1500.5 } });
    assert.equal(rep.status, 201, rep.text);
    assert.equal(rep.json.licenseId, 'L-2026-0002');
    assert.equal(rep.json.license.replacesLicenseId, 'L-2026-0001');
    assert.equal(rep.json.replaced.revokeReason, 'replaced');
    assert.equal(rep.json.license.salesName, 'Bob Example');
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0001/replace', { body: {} })).status, 409);

    assert.equal((await c.call('POST', '/api/licenses/L-2026-0002/revoke', { body: { reason: 'replaced' } })).status, 400);
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0002/revoke', { body: { reason: 'oops' } })).status, 400);
    const rv = await c.call('POST', '/api/licenses/L-2026-0002/revoke', { body: { reason: 'terminated', note: 'Contract ended' } });
    assert.equal(rv.status, 200);
    assert.equal(rv.json.license.status, 'Revoked');
    assert.equal((await c.call('POST', '/api/licenses/L-2026-0002/revoke', { body: { reason: 'other' } })).status, 409);
    const ev = await c.call('GET', '/api/licenses/L-2026-0001/events');
    assert.deepEqual(ev.json.events.map((x) => x.type), ['issued', 'edited', 'reissued', 'replaced']);
    for (const name of ['license-edit', 'reissue', 'replace', 'revoke']) assert.match(app.auditText(), new RegExp(`"event":"${name}"`));
});

test('meta, session additions, dashboard and renewal board', async (t) => {
    const { c } = await withLicense(t);
    const m = await c.call('GET', '/api/meta');
    assert.deepEqual(m.json.revokeReasons, ['terminated', 'issued_in_error', 'other']);
    assert.ok(m.json.currencies.includes('TWD'));
    const s = await c.call('GET', '/api/session');
    assert.deepEqual(s.json.mail, { enabled: false, reason: 'SMTP_HOST is not set; MAIL_FROM is not set' });
    assert.equal(s.json.defaultCurrency, 'TWD');
    assert.equal(s.json.registry.ok, true);
    const d = await c.call('GET', '/api/dashboard?days=60');
    assert.equal(d.json.month.issued, 1);
    assert.deepEqual(d.json.month.amounts, { TWD: 1200 });
    assert.equal(d.json.renewals.days, 60);
    assert.equal(d.json.renewals.rows.length, 0);
    const b = await c.call('GET', '/api/renewals?days=366');
    assert.deepEqual(b.json.rows.map((l) => l.licenseId), ['L-2026-0001']);
    assert.equal((await c.call('GET', '/api/renewals?days=0')).status, 400);
});
