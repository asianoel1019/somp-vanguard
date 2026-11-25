// Data layer: schema and seed, sales / customers / plans / settings, the computed status, and the issuing rules
// (plans, renewals, trials, edit, revoke, replace, events, refusals that write nothing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verifyLicense } = require('../../backend/lib/licenseFormat');
const { KEYS } = require('../../backend/lib/licenseKeys');
const S = require('../src/store');
const { currentVersion } = require('../src/store/schema');
const { tempStore } = require('./helpers');

const payloadOf = (file, onDate = '2026-11-25') => verifyLicense(fs.readFileSync(file, 'utf8'), KEYS, onDate).payload;
const planNamed = (store, name) => store.listPlans().find((p) => p.name === name);

test('a new database gets the schema, the seeded plans and default settings; reopening does not migrate again', (t) => {
    const { k, store } = tempStore(t);
    assert.equal(currentVersion(store.db), S.SCHEMA_VERSION);
    assert.deepEqual(store.listPlans().map((p) => [p.name, p.type, p.termValue, p.termUnit, p.price, p.currency, p.active]), [
        ['Trial 30 days', 'trial', 30, 'days', 0, 'TWD', true],
        ['1 year', 'paid', 12, 'months', null, 'TWD', true],
        ['2 years', 'paid', 24, 'months', null, 'TWD', true],
        ['3 years', 'paid', 36, 'months', null, 'TWD', true],
    ]);
    assert.deepEqual(store.getSettings(), S.rules.DEFAULT_SETTINGS);
    assert.equal(store.getSettings().digestWeekday, 1);
    assert.equal(store.getSettings().digestTime, '09:00');
    store.close();
    const again = S.openStore(store.file);
    k.closers.push(() => again.close());
    assert.equal(again.listPlans().length, 4);
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, 1);
    // a database from a newer program is refused, unchanged
    again.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (99, 'x')").run();
    again.close();
    assert.throws(() => S.openStore(store.file), { code: 'SCHEMA_TOO_NEW' });
});

test('sales: names unique ignoring case, optional valid email, deactivated people cannot be chosen', (t) => {
    const { store, issue } = tempStore(t);
    const a = store.createSales({ name: '  Alice Example ', email: 'alice@example.test' });
    assert.deepEqual([a.name, a.email, a.active], ['Alice Example', 'alice@example.test', true]);
    assert.throws(() => store.createSales({ name: 'ALICE EXAMPLE' }), { code: 'conflict', field: 'name', status: 409 });
    assert.throws(() => store.createSales({ name: '  ' }), { code: 'invalid', field: 'name', status: 400 });
    assert.throws(() => store.createSales({ name: 'x'.repeat(101) }), { code: 'invalid', field: 'name' });
    assert.throws(() => store.createSales({ name: 'Bob', email: 'not-an-email' }), { code: 'invalid', field: 'email' });
    const b = store.createSales({ name: 'Bob Example' });
    assert.throws(() => store.updateSales(b.id, { name: 'alice example' }), { code: 'conflict' });
    assert.throws(() => store.updateSales(b.id, { active: 'no' }), { code: 'invalid', field: 'active' });
    assert.throws(() => store.updateSales(999, { name: 'X' }), { code: 'not-found' });
    assert.equal(store.updateSales(b.id, { active: false }).active, false);
    assert.deepEqual(store.listSales({ activeOnly: true }).map((s) => s.name), ['Alice Example']);
    assert.deepEqual(store.listSales().map((s) => [s.name, s.active, s.licenseCount]), [['Alice Example', true, 0], ['Bob Example', false, 0]]);
    assert.equal(store.findSalesByName('BOB example').id, b.id);

    const base = { customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24' };
    const off = issue({ ...base, salesId: b.id });
    assert.deepEqual([off.ok, off.code, off.field, off.status], [false, 'sales-inactive', 'salesId', 400]);
    assert.equal(issue({ ...base, salesName: 'Nobody' }).code, 'not-found');
    assert.equal(issue({ ...base, salesId: 'abc' }).code, 'invalid');
    assert.equal(store.licenseCount(), 0);
    assert.equal(store.findCustomerByName('Example Corp.'), null); // rolled back with the refused issue
    const ok = issue({ ...base, salesName: 'alice example' });
    assert.equal(ok.ok, true, ok.message);
    assert.equal(ok.license.salesName, 'Alice Example');
    assert.deepEqual(ok.warnings, []);
});

test('customers: name 1-200 unique ignoring case, checked fields, delete only without licenses', (t) => {
    const { store, issue } = tempStore(t);
    const sales = store.createSales({ name: 'Alice Example' });
    const c = store.createCustomer({ name: ' Example Corp. ', taxId: '12345678', address: 'Line 1\r\nLine 2', contactPerson: 'Pat Example',
        phone: '+886 2 0000 0000', email: 'it@example.test', notes: 'First\nSecond', defaultSalesId: sales.id });
    assert.deepEqual([c.name, c.taxId, c.address, c.contactPerson, c.phone, c.email, c.notes, c.defaultSalesId, c.defaultSalesName, c.licenseCount, c.nextExpiry],
        ['Example Corp.', '12345678', 'Line 1\nLine 2', 'Pat Example', '+886 2 0000 0000', 'it@example.test', 'First\nSecond', sales.id, 'Alice Example', 0, null]);
    const bad = [
        [{ name: 'EXAMPLE CORP.' }, 'conflict', 'name'],
        [{ name: '' }, 'invalid', 'name'],
        [{ name: 'x'.repeat(201) }, 'invalid', 'name'],
        [{ name: 'Line\nbreak' }, 'invalid', 'name'],
        [{ name: 42 }, 'invalid', 'name'],
        [{ name: 'B', email: 'b@' }, 'invalid', 'email'],
        [{ name: 'B', phone: 'p'.repeat(51) }, 'invalid', 'phone'],
        [{ name: 'B', defaultSalesId: 999 }, 'not-found', 'defaultSalesId'],
    ];
    for (const [fields, code, field] of bad) assert.throws(() => store.createCustomer(fields), { code, field }, JSON.stringify(fields));
    assert.ok(store.createCustomer({ name: 'y'.repeat(200) }));
    store.updateSales(sales.id, { active: false });
    assert.throws(() => store.createCustomer({ name: 'C', defaultSalesId: sales.id }), { code: 'sales-inactive' });

    const u = store.updateCustomer(c.id, { phone: '', email: 'billing@example.test' });
    assert.deepEqual([u.phone, u.email, u.name, u.taxId], [null, 'billing@example.test', 'Example Corp.', '12345678']);
    assert.throws(() => store.updateCustomer(c.id, { name: 'y'.repeat(200).toUpperCase() }), { code: 'conflict' });
    assert.equal(store.updateCustomer(c.id, { name: 'example corp.' }).name, 'example corp.'); // its own name in another case

    assert.equal(issue({ customerId: c.id, expiresAt: '2027-01-31' }).ok, true);
    assert.equal(issue({ customerId: c.id, expiresAt: '2026-12-31' }).ok, true);
    const listed = store.listCustomers({ q: 'EXAMPLE' });
    assert.deepEqual(listed.map((x) => [x.name, x.licenseCount, x.nextExpiry]), [['example corp.', 2, '2026-12-31']]);
    assert.deepEqual(store.listCustomers({ q: '1234' }).map((x) => x.name), ['example corp.']);
    assert.deepEqual(store.listCustomers({ q: '%' }), []);
    assert.equal(store.getCustomer(c.id, { withLicenses: true }).licenses.length, 2);
    assert.throws(() => store.deleteCustomer(c.id), { code: 'conflict', status: 409 });
    const lonely = store.createCustomer({ name: 'No Licenses Ltd.' });
    assert.deepEqual(store.deleteCustomer(lonely.id), { deleted: true, id: lonely.id });
    assert.equal(store.getCustomer(lonely.id), null);
    assert.throws(() => store.deleteCustomer(lonely.id), { code: 'not-found' });
});

test('plans: trial plans at most 60 days and free; a used plan keeps its type; deactivated plans cannot be chosen', (t) => {
    const { store, issue } = tempStore(t);
    const t60 = store.createPlan({ name: 'Trial 60 days', type: 'trial', termValue: 60, termUnit: 'days' });
    assert.deepEqual([t60.price, t60.currency, t60.active], [0, 'TWD', true]);
    assert.equal(store.createPlan({ name: 'Trial 1 month', type: 'trial', termValue: 1, termUnit: 'months' }).termUnit, 'months');
    const bad = [
        [{ name: 'T61', type: 'trial', termValue: 61, termUnit: 'days' }, 'termValue'],
        [{ name: 'T2m', type: 'trial', termValue: 2, termUnit: 'months' }, 'termValue'],
        [{ name: 'Tp', type: 'trial', termValue: 30, termUnit: 'days', price: 10 }, 'price'],
        [{ name: 'P0', type: 'paid', termValue: 0, termUnit: 'months' }, 'termValue'],
        [{ name: 'P1.5', type: 'paid', termValue: 1.5, termUnit: 'months' }, 'termValue'],
        [{ name: 'Pw', type: 'paid', termValue: 1, termUnit: 'weeks' }, 'termUnit'],
        [{ name: 'Px', type: 'gift', termValue: 1, termUnit: 'months' }, 'type'],
        [{ name: 'Pc', type: 'paid', termValue: 1, termUnit: 'months', currency: 'XYZ' }, 'currency'],
        [{ name: 'Pp', type: 'paid', termValue: 1, termUnit: 'months', price: -1 }, 'price'],
        [{ name: 'Pp', type: 'paid', termValue: 1, termUnit: 'months', price: 1.005 }, 'price'],
    ];
    for (const [fields, field] of bad) assert.throws(() => store.createPlan(fields), { code: 'invalid', field }, JSON.stringify(fields));
    assert.throws(() => store.createPlan({ name: '1 YEAR', type: 'paid', termValue: 12, termUnit: 'months' }), { code: 'conflict' });
    const p = store.createPlan({ name: '6 months', type: 'paid', termValue: 6, termUnit: 'months', price: '45000.5', currency: 'usd' });
    assert.deepEqual([p.price, p.currency], [45000.5, 'USD']);

    const year = planNamed(store, '1 year');
    assert.equal(issue({ customerName: 'Example Corp.', createCustomer: true, planId: year.id }).ok, true);
    assert.throws(() => store.updatePlan(year.id, { type: 'trial' }), { code: 'conflict', field: 'type' });
    assert.equal(store.updatePlan(year.id, { price: 30000, name: '1 year (standard)' }).price, 30000);
    store.updatePlan(p.id, { active: false });
    assert.deepEqual(store.listPlans({ activeOnly: true }).map((x) => x.name).includes('6 months'), false);
    const r = issue({ customerName: 'Example Corp.', planId: p.id });
    assert.deepEqual([r.ok, r.code, r.field], [false, 'plan-inactive', 'planId']);
    assert.equal(issue({ customerName: 'Example Corp.', planId: 999 }).code, 'not-found');
});

test('settings: defaults and checked updates; the default currency applies to new licenses', (t) => {
    const { store, issue } = tempStore(t);
    const s = store.updateSettings({ digestWeekday: '5', digestTime: '17:30', defaultCurrency: 'usd', mailSubject: ' License {licenseId} ', lastDigestWeek: '2026-W48' });
    assert.deepEqual([s.digestWeekday, s.digestTime, s.defaultCurrency, s.mailSubject, s.lastDigestWeek], [5, '17:30', 'USD', 'License {licenseId}', '2026-W48']);
    assert.equal(s.mailBody, S.rules.DEFAULT_SETTINGS.mailBody);
    const bad = [
        [{ digestWeekday: 0 }, 'digestWeekday'], [{ digestWeekday: 8 }, 'digestWeekday'], [{ digestWeekday: 1.5 }, 'digestWeekday'],
        [{ digestTime: '9:00' }, 'digestTime'], [{ digestTime: '24:00' }, 'digestTime'], [{ defaultCurrency: 'XYZ' }, 'defaultCurrency'],
        [{ mailSubject: '' }, 'mailSubject'], [{ mailBody: '   ' }, 'mailBody'], [{ lastDigestWeek: '2026-48' }, 'lastDigestWeek'],
        [{ smtpPass: 'x' }, 'smtpPass'],
    ];
    for (const [change, field] of bad) assert.throws(() => store.updateSettings(change), { code: 'invalid', field }, JSON.stringify(change));
    assert.equal(store.getSettings().digestWeekday, 5); // nothing changed by the refusals
    assert.equal(store.updateSettings({ mailBody: 'Line 1\r\nLine 2' }).mailBody, 'Line 1\nLine 2');
    const r = issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24', amount: 10 });
    assert.equal(r.license.currency, 'USD');
});

test('status: Revoked > Format 1 > Expired > Expires soon (paid 30 / trial 7 days) > Active', () => {
    const st = (o) => S.computeStatus({ revokedAt: null, format: 2, type: 'paid', ...o }, '2026-11-25');
    assert.deepEqual(st({ expiresAt: '2026-12-26' }), { status: 'Active', daysLeft: 31 });
    assert.deepEqual(st({ expiresAt: '2026-12-25' }), { status: 'Expires soon', daysLeft: 30 });
    assert.deepEqual(st({ expiresAt: '2026-11-25' }), { status: 'Expires soon', daysLeft: 0 });
    assert.deepEqual(st({ expiresAt: '2026-11-24' }), { status: 'Expired', daysLeft: -1 });
    assert.deepEqual(st({ type: 'trial', expiresAt: '2026-12-03' }), { status: 'Active', daysLeft: 8 });
    assert.deepEqual(st({ type: 'trial', expiresAt: '2026-12-02' }), { status: 'Expires soon', daysLeft: 7 });
    assert.deepEqual(st({ format: 1, expiresAt: null }), { status: 'Format 1 (invalid)', daysLeft: null });
    assert.deepEqual(st({ format: 1, expiresAt: null, revokedAt: '2026-11-01T10:00:00+08:00' }), { status: 'Revoked', daysLeft: null });
    assert.deepEqual(st({ expiresAt: '2026-11-01', revokedAt: '2026-10-01T10:00:00+08:00' }), { status: 'Revoked', daysLeft: -24 });
});

test('issue: plan defaults (expiry, amount, currency), the next ID, customers found or created, sales when required', (t) => {
    const { store, issue, issuedDir } = tempStore(t);
    const year = store.updatePlan(planNamed(store, '1 year').id, { price: 30000 });
    const r = issue({ customerName: 'Example Corp.', createCustomer: true, planId: year.id, source: 'web' });
    assert.equal(r.ok, true, r.message);
    const l = r.license;
    assert.deepEqual([l.licenseId, l.issuedAt, l.expiresAt, l.amount, l.currency, l.type, l.format, l.isRenewal, l.planName, l.status, l.salesId],
        ['L-2026-0001', '2026-11-25', '2027-11-24', 30000, 'TWD', 'paid', 2, false, '1 year', 'Active', null]);
    assert.equal(r.outAbs, path.join(issuedDir, 'L-2026-0001-example-corp.lic'));
    assert.equal(l.filePath, r.outAbs);
    assert.deepEqual(r.warnings, ['no-sales']);
    assert.equal(r.nextId, 'L-2026-0002');
    assert.equal(r.registryError, null);
    assert.equal('trial' in payloadOf(r.outAbs), false);
    assert.deepEqual(store.licenseEvents('L-2026-0001').map((e) => [e.type, e.detail]),
        [['issued', { source: 'web', plan: '1 year', renewalOf: null, replaces: null }]]);
    // a two-year plan, an amount that overrides the price, a customer found ignoring case (the stored name is signed)
    const two = issue({ customerName: 'EXAMPLE CORP.', planId: planNamed(store, '2 years').id, amount: '', orderNo: ' PO-1 ' });
    assert.deepEqual([two.license.expiresAt, two.license.amount, two.license.orderNo, two.license.customerName, two.license.licensedTo],
        ['2028-11-24', null, 'PO-1', 'Example Corp.', 'Example Corp.']);
    assert.equal(payloadOf(two.outAbs).customer, 'Example Corp.');
    // refusals
    const c = store.findCustomerByName('Example Corp.');
    assert.deepEqual(issue({ customerId: c.id, planId: year.id, requireSales: true }).code, 'sales-required');
    assert.equal(issue({ customerName: 'Unknown Ltd.', planId: year.id }).code, 'not-found');
    assert.equal(issue({ customerId: 999, planId: year.id }).code, 'not-found');
    assert.equal(issue({ customerId: c.id }).field, 'expiresAt'); // no plan, no expiry
    assert.equal(issue({}).field, 'customer');
    assert.equal(issue({ customerId: c.id, planId: year.id, type: 'trial' }).field, 'type');
    assert.equal(issue({ customerId: c.id, planId: year.id, amount: -5 }).field, 'amount');
    assert.equal(issue({ customerId: c.id, planId: year.id, currency: 'ABC' }).field, 'currency');
    assert.equal(issue({ customerId: c.id, planId: year.id, licenseId: 'L-26-1' }).field, 'licenseId');
    const past = issue({ customerId: c.id, expiresAt: '2026-11-24' });
    assert.deepEqual([past.code, past.field, past.check], ['invalid', 'expiresAt', 'expires-past']);
    const newBad = issue({ newCustomer: { name: 'New Co.', email: 'nope' }, planId: year.id });
    assert.deepEqual([newBad.code, newBad.field], ['invalid', 'email']);
    assert.equal(issue({ newCustomer: { name: 'example corp.' }, planId: year.id }).code, 'conflict');
    const made = issue({ newCustomer: { name: 'New Co.', email: 'it@example.test' }, planId: year.id });
    assert.equal(made.ok, true, made.message);
    assert.equal(store.getCustomer(made.license.customerId).email, 'it@example.test');
    assert.equal(store.licenseCount(), 3);
});

test('renewal: via Renew of a paid license, or an earlier non-revoked paid license of the customer; trials never', (t) => {
    const { store, issue } = tempStore(t);
    const ex = (name) => ({ customerName: name, createCustomer: true, expiresAt: '2027-11-24' });
    const first = issue(ex('Example Corp.'));
    assert.equal(first.license.isRenewal, false);
    assert.equal(issue(ex('Example Corp.')).license.isRenewal, true);
    // a revoked paid license does not make the next one a renewal
    const other = issue(ex('Other Ltd.'));
    store.revokeLicense(other.licenseId, { reason: 'issued_in_error' });
    assert.equal(issue(ex('Other Ltd.')).license.isRenewal, false);
    // a trial is never a renewal; buying after a trial (even through Renew on the trial) is new business
    const trial = issue({ ...ex('Trial Co.'), type: 'trial', expiresAt: '2026-12-24' });
    assert.equal(trial.license.isRenewal, false);
    const bought = issue({ ...ex('Trial Co.'), renewalOf: trial.licenseId });
    assert.equal(bought.license.isRenewal, false);
    assert.deepEqual(store.licenseEvents(bought.licenseId)[0].detail.renewalOf, trial.licenseId);
    // Renew of a paid license counts as a renewal
    const fresh = issue(ex('Fresh Ltd.'));
    store.revokeLicense(fresh.licenseId, { reason: 'terminated' });
    assert.equal(issue({ ...ex('Fresh Ltd.'), renewalOf: fresh.licenseId }).license.isRenewal, true);
    // Renew must name a license of the same customer
    const wrong = issue({ ...ex('Example Corp.'), renewalOf: other.licenseId });
    assert.deepEqual([wrong.code, wrong.field], ['invalid', 'renewalOf']);
    assert.equal(issue({ ...ex('Example Corp.'), renewalOf: 'L-2026-0999' }).code, 'not-found');
});

test('trial rules: free, at most 60 days, one per customer (revoked ones count; a replaced one hands its allowance on); trial: true', (t) => {
    const { store, issue, replace } = tempStore(t);
    const plan = planNamed(store, 'Trial 30 days');
    const r = issue({ customerName: 'Trial Co.', createCustomer: true, planId: plan.id });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.license.type, r.license.expiresAt, r.license.amount, r.license.status, r.license.daysLeft], ['trial', '2026-12-24', 0, 'Active', 29]);
    assert.equal(payloadOf(r.outAbs).trial, true);

    const base = { customerName: 'Second Co.', createCustomer: true, type: 'trial' };
    const amount = issue({ ...base, expiresAt: '2026-12-24', amount: 100 });
    assert.deepEqual([amount.code, amount.field, amount.status], ['trial-amount', 'amount', 400]);
    const long = issue({ ...base, expiresAt: '2027-01-24' }); // 61 days
    assert.deepEqual([long.code, long.field], ['trial-term', 'expiresAt']);
    assert.match(long.message, /at most 60 days \(this one: 61\)/);
    const sixty = issue({ ...base, expiresAt: '2027-01-23', amount: '0' });
    assert.equal(sixty.ok, true, sixty.message);
    const again = issue({ ...base, expiresAt: '2026-12-01' });
    assert.deepEqual([again.code, again.status, again.usedBy, again.field], ['trial-used', 409, sixty.licenseId, 'customer']);
    // a revoked trial still used the allowance
    store.revokeLicense(sixty.licenseId, { reason: 'terminated' });
    assert.equal(issue({ ...base, expiresAt: '2026-12-01' }).code, 'trial-used');
    // replacing a trial keeps the allowance with the replacement (still at most 60 days)
    assert.equal(replace({ replaces: r.licenseId, expiresAt: '2027-01-24' }).code, 'trial-term');
    const rep = replace({ replaces: r.licenseId, expiresAt: '2027-01-20', note: 'Longer evaluation' });
    assert.equal(rep.ok, true, rep.message);
    assert.equal(rep.license.type, 'trial');
    assert.equal(payloadOf(rep.outAbs).trial, true);
    const third = issue({ customerName: 'Trial Co.', type: 'trial', expiresAt: '2026-12-01' });
    assert.deepEqual([third.code, third.usedBy], ['trial-used', rep.licenseId]);
    // a paid license for a trial customer is fine
    assert.equal(issue({ customerName: 'Trial Co.', expiresAt: '2027-11-24' }).ok, true);
});

test('edit: only sales, amount, currency and order no. change; an edited event with before / after', (t) => {
    const { store, issue, reg } = tempStore(t);
    const a = store.createSales({ name: 'Alice Example' });
    const b = store.createSales({ name: 'Bob Example' });
    const r = issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24', salesId: a.id, amount: 100 });
    for (const k of ['expiresAt', 'issuedAt', 'customerId', 'type', 'licenseId']) {
        assert.throws(() => store.editLicense(r.licenseId, { [k]: 'x' }), { code: 'invalid', field: k, message: /Only sales, amount, currency and order number/ });
    }
    const e = store.editLicense(r.licenseId, { salesId: b.id, amount: '250.75', currency: 'eur', orderNo: ' PO-9 ' });
    assert.equal(e.changed, true);
    assert.deepEqual([e.license.salesName, e.license.amount, e.license.currency, e.license.orderNo], ['Bob Example', 250.75, 'EUR', 'PO-9']);
    const ev = store.licenseEvents(r.licenseId).at(-1);
    assert.equal(ev.type, 'edited');
    assert.deepEqual(ev.detail, {
        before: { salesId: a.id, amount: 100, currency: 'TWD', orderNo: null, sales: 'Alice Example' },
        after: { salesId: b.id, amount: 250.75, currency: 'EUR', orderNo: 'PO-9', sales: 'Bob Example' },
    });
    assert.match(fs.readFileSync(reg, 'utf8'), /\| L-2026-0001 \| Example Corp\. \| Paid \| 2026-11-25 \| 2027-11-24 \| Bob Example \| Active \|/);
    // nothing changed: no event
    const n = store.licenseEvents(r.licenseId).length;
    assert.equal(store.editLicense(r.licenseId, { amount: 250.75, currency: 'EUR' }).changed, false);
    assert.equal(store.licenseEvents(r.licenseId).length, n);
    // only the changed fields are listed; sales can be removed
    assert.deepEqual(store.editLicense(r.licenseId, { salesId: null }).license.salesId, null);
    assert.deepEqual(store.licenseEvents(r.licenseId).at(-1).detail, { before: { salesId: b.id, sales: 'Bob Example' }, after: { salesId: null, sales: null } });
    store.updateSales(a.id, { active: false });
    assert.throws(() => store.editLicense(r.licenseId, { salesId: a.id }), { code: 'sales-inactive' });
    assert.throws(() => store.editLicense(r.licenseId, { amount: 'abc' }), { code: 'invalid', field: 'amount' });
    assert.throws(() => store.editLicense('L-2026-0999', { amount: 1 }), { code: 'not-found' });
    // a trial stays free
    const tr = issue({ customerName: 'Trial Co.', createCustomer: true, type: 'trial', expiresAt: '2026-12-24' });
    assert.throws(() => store.editLicense(tr.licenseId, { amount: 5 }), { code: 'trial-amount' });
    assert.equal(store.editLicense(tr.licenseId, { amount: 0, orderNo: 'T-1' }).license.amount, 0);
});

test('edit: an amount set without a currency on a license that has none (imported) gets the default currency and counts in reports', (t) => {
    const { store, issue } = tempStore(t);
    const r = issue({ customerName: 'Imported Co.', createCustomer: true, expiresAt: '2027-11-24' });
    store.db.prepare('UPDATE licenses SET amount = NULL, currency = NULL WHERE license_id = ?').run(r.licenseId); // as imported
    store.updateSettings({ defaultCurrency: 'USD' });
    const e = store.editLicense(r.licenseId, { amount: 120 });
    assert.deepEqual([e.license.amount, e.license.currency], [120, 'USD']);
    assert.deepEqual(store.licenseEvents(r.licenseId).at(-1).detail, { before: { amount: null, currency: null }, after: { amount: 120, currency: 'USD' } });
    assert.deepEqual(store.reportSummary({}).totals.amounts, { USD: 120 });
    // only the order no.: the amount stays empty and no currency is added
    const r2 = issue({ customerName: 'Imported Co.', expiresAt: '2028-11-24' });
    store.db.prepare('UPDATE licenses SET amount = NULL, currency = NULL WHERE license_id = ?').run(r2.licenseId);
    assert.deepEqual([store.editLicense(r2.licenseId, { orderNo: 'PO-1' }).license.currency], [null]);
});

test('name checks run inside the write transaction: a name another writer added meanwhile is a conflict (409), not a SQLite error', (t) => {
    const { store, k } = tempStore(t);
    const other = S.openStore(path.join(k.dir, 'license-issuer.db'), { registryFile: null }); // e.g. the CLI
    k.closers.push(() => other.close());
    // the other writer commits just before this store's transaction starts (after the old pre-transaction check)
    const meanwhile = (fn) => {
        const tx = store.tx;
        store.tx = function once(f) { store.tx = tx; fn(); return tx.call(this, f); };
    };
    meanwhile(() => other.createSales({ name: 'Race Sales' }));
    assert.throws(() => store.createSales({ name: 'race sales' }), { code: 'conflict', status: 409, field: 'name' });
    const s = store.createSales({ name: 'Second Sales' });
    meanwhile(() => other.createSales({ name: 'Renamed Sales' }));
    assert.throws(() => store.updateSales(s.id, { name: 'Renamed Sales' }), { code: 'conflict', status: 409, field: 'name' });
    assert.equal(store.getSales(s.id).name, 'Second Sales');

    const plan = { type: 'paid', termValue: 12, termUnit: 'months' };
    meanwhile(() => other.createPlan({ name: 'Race Plan', ...plan }));
    assert.throws(() => store.createPlan({ name: 'Race Plan', ...plan }), { code: 'conflict', status: 409, field: 'name' });
    const p = store.createPlan({ name: 'Second Plan', ...plan });
    meanwhile(() => other.createPlan({ name: 'Renamed Plan', ...plan }));
    assert.throws(() => store.updatePlan(p.id, { name: 'Renamed Plan' }), { code: 'conflict', status: 409, field: 'name' });

    meanwhile(() => other.createCustomer({ name: 'Race Co.' }));
    assert.throws(() => store.createCustomer({ name: 'Race Co.' }), { code: 'conflict', status: 409, field: 'name' });
    const c = store.createCustomer({ name: 'Second Co.' });
    meanwhile(() => other.createCustomer({ name: 'Renamed Co.' }));
    assert.throws(() => store.updateCustomer(c.id, { name: 'Renamed Co.' }), { code: 'conflict', status: 409, field: 'name' });
    assert.equal(store.getCustomer(c.id).name, 'Second Co.');
});

test('revoke: a record only (reason + note), the file stays; "replaced" and a second revoke are refused', (t) => {
    const { store, issue, reg } = tempStore(t);
    const r = issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24' });
    assert.throws(() => store.revokeLicense(r.licenseId, { reason: 'replaced' }), { code: 'invalid', field: 'reason', message: /Use Replace/ });
    assert.throws(() => store.revokeLicense(r.licenseId, { reason: 'bogus' }), { code: 'invalid', field: 'reason' });
    assert.throws(() => store.revokeLicense(r.licenseId, { reason: 'other', note: 'n'.repeat(501) }), { code: 'invalid', field: 'note' });
    const l = store.revokeLicense(r.licenseId, { reason: 'terminated', note: 'Contract ended' });
    assert.deepEqual([l.status, l.revokeReason, l.revokeNote, l.revokedAt], ['Revoked', 'terminated', 'Contract ended', '2026-11-25T10:00:00' + l.revokedAt.slice(19)]);
    assert.throws(() => store.revokeLicense(r.licenseId, { reason: 'other' }), { code: 'conflict', status: 409 });
    assert.deepEqual(store.licenseEvents(r.licenseId).map((e) => [e.type, e.detail]),
        [['issued', { source: null, plan: null, renewalOf: null, replaces: null }], ['revoked', { reason: 'terminated', note: 'Contract ended' }]]);
    assert.equal(fs.existsSync(r.outAbs), true); // an offline license cannot be recalled
    assert.match(fs.readFileSync(reg, 'utf8'), /\| L-2026-0001 \| .*\| Revoked \(terminated\) \|/);
    assert.equal(store.listLicenses({ status: 'Revoked' }).length, 1);
    assert.equal(store.listLicenses({ includeRevoked: false }).length, 0);
});

test('replace: new ID for the same customer, defaults from the old license, the old one revoked as replaced and linked', (t) => {
    const { store, issue, replace, reg } = tempStore(t);
    const a = store.createSales({ name: 'Alice Example' });
    issue({ customerName: 'Example Corp.', createCustomer: true, issuedAt: '2025-11-25', expiresAt: '2026-11-25' });
    const old = issue({ customerName: 'Example Corp.', salesId: a.id, amount: 500, currency: 'USD', orderNo: 'PO-1', planId: planNamed(store, '1 year').id,
        contact: { vendor: 'Example Vendor', email: 'support@example.test' }, issuedAt: '2026-11-20' });
    assert.equal(old.license.isRenewal, true);
    store.updateSales(a.id, { active: false }); // a replacement may keep a sales person deactivated since
    const r = replace({ replaces: old.licenseId, expiresAt: '2028-01-31', note: 'Wrong expiry' });
    assert.equal(r.ok, true, r.message);
    const n = r.license;
    assert.deepEqual([n.licenseId, n.customerId, n.salesId, n.amount, n.currency, n.orderNo, n.planName, n.issuedAt, n.expiresAt, n.isRenewal, n.replacesLicenseId],
        ['L-2026-0003', old.license.customerId, a.id, 500, 'USD', 'PO-1', '1 year', '2026-11-20', '2028-01-31', true, old.licenseId]);
    assert.deepEqual(payloadOf(r.outAbs).contact, { vendor: 'Example Vendor', email: 'support@example.test' });
    const o = store.getLicense(old.licenseId);
    assert.deepEqual([o.status, o.revokeReason, o.revokeNote, o.replacedByLicenseId], ['Revoked', 'replaced', 'Wrong expiry', 'L-2026-0003']);
    assert.deepEqual(r.replaced.replacedByLicenseId, 'L-2026-0003');
    assert.deepEqual(store.licenseEvents(old.licenseId).at(-1), { ...store.licenseEvents(old.licenseId).at(-1), type: 'replaced', detail: { replacedBy: 'L-2026-0003', note: 'Wrong expiry' } });
    assert.equal(store.licenseEvents('L-2026-0003')[0].detail.replaces, old.licenseId);
    assert.match(fs.readFileSync(reg, 'utf8'), new RegExp(`\\| ${old.licenseId} \\| .*\\| Revoked \\(replaced by L-2026-0003\\) \\|`));
    // the old dates are kept when none are given; amount and others can change
    const r2 = replace({ replaces: 'L-2026-0003', amount: 600, salesId: null });
    assert.deepEqual([r2.license.expiresAt, r2.license.amount, r2.license.salesId], ['2028-01-31', 600, null]);
    // refusals
    assert.equal(replace({ replaces: old.licenseId }).code, 'conflict'); // revoked already
    assert.equal(replace({ replaces: 'L-2026-0999' }).code, 'not-found');
    assert.equal(replace({}).code, 'invalid');
    assert.equal(replace({ replaces: r2.licenseId, type: 'trial' }).field, 'type');
    assert.equal(replace({ replaces: r2.licenseId, planId: planNamed(store, 'Trial 30 days').id }).field, 'planId');
    // only the live license counts
    const sum = store.reportSummary({ period: 'year', date: '2026-11-25' });
    assert.deepEqual([sum.totals.count, sum.totals.renewal, sum.totals.amounts], [1, 1, { USD: 600 }]);
});

test('events: delivered / delivery_failed / downloaded / reissued (with a reason) can be recorded; the others cannot', (t) => {
    const { store, issue } = tempStore(t);
    const r = issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24' });
    assert.throws(() => store.addEvent(r.licenseId, 'reissued', {}), { code: 'invalid', field: 'reason' });
    const ev = store.addEvent(r.licenseId, 'reissued', { reason: 'Customer lost the file', via: 'download' });
    assert.deepEqual([ev.type, ev.licenseId, ev.detail], ['reissued', r.licenseId, { reason: 'Customer lost the file', via: 'download' }]);
    store.addEvent(r.licenseId, 'delivered', { to: 'it@example.test' });
    store.addEvent(r.licenseId, 'delivery_failed', { to: 'it@example.test', error: 'connection refused' });
    store.addEvent(r.licenseId, 'downloaded');
    for (const type of ['issued', 'revoked', 'replaced', 'edited', 'imported', 'bogus']) {
        assert.throws(() => store.addEvent(r.licenseId, type, {}), { code: 'invalid', field: 'type' });
    }
    assert.throws(() => store.addEvent(r.licenseId, 'delivered', ['x']), { code: 'invalid', field: 'detail' });
    assert.throws(() => store.addEvent(r.licenseId, 'delivered', { x: 'y'.repeat(5000) }), { code: 'invalid', field: 'detail' });
    assert.throws(() => store.addEvent('L-2026-0999', 'downloaded'), { code: 'not-found' });
    assert.deepEqual(store.licenseEvents(r.licenseId).map((e) => e.type), ['issued', 'reissued', 'delivered', 'delivery_failed', 'downloaded']);
});

test('a refused or failed issue writes nothing: no file, no customer, no license', (t) => {
    const { store, issue, issuedDir, reg } = tempStore(t);
    const first = issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24' });
    const files = () => fs.readdirSync(issuedDir).sort();
    const regBefore = fs.readFileSync(reg, 'utf8');
    const dup = issue({ newCustomer: { name: 'New Co.' }, licenseId: first.licenseId, expiresAt: '2027-11-24' });
    assert.deepEqual([dup.code, dup.status, dup.next, dup.field], ['duplicate-id', 409, 'L-2026-0002', 'licenseId']);
    assert.equal(issue({ newCustomer: { name: 'New Co.' }, licenseId: 'l-2026-0001', expiresAt: '2027-11-24' }).field, 'licenseId'); // upper-case L only
    // the database write fails after the file was written: the file is removed again
    store.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON licenses BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    const failed = issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24' });
    assert.deepEqual([failed.ok, failed.code, failed.status], [false, 'failed', 500]);
    assert.match(failed.message, /simulated failure/);
    store.db.exec('DROP TRIGGER fail_insert');
    // an existing file is never overwritten; the output may not be the database, registry or key
    fs.writeFileSync(path.join(issuedDir, 'L-2026-0002-new-co.lic'), 'keep me');
    assert.equal(issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24' }).code, 'out-exists');
    assert.equal(fs.readFileSync(path.join(issuedDir, 'L-2026-0002-new-co.lic'), 'utf8'), 'keep me');
    fs.rmSync(path.join(issuedDir, 'L-2026-0002-new-co.lic'));
    for (const out of [store.file, reg]) assert.equal(issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24', out }).code, 'out-protected');
    // a key the product does not trust
    const untrusted = issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24', keys: {} });
    assert.deepEqual([untrusted.code, untrusted.reason], ['rejected', `unknown key ${store.getLicense(first.licenseId).keyId}`]);
    // another writer holds the registry lock
    fs.writeFileSync(`${reg}.lock`, 'other');
    store.lockOptions = { timeoutMs: 100 };
    const locked = issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24' });
    assert.deepEqual([locked.code, locked.status], ['locked', 503]);
    fs.rmSync(`${reg}.lock`);
    assert.deepEqual(files(), ['L-2026-0001-example-corp.lic']);
    assert.equal(store.licenseCount(), 1);
    assert.equal(store.findCustomerByName('New Co.'), null);
    assert.equal(fs.readFileSync(reg, 'utf8'), regBefore);
    assert.equal(issue({ newCustomer: { name: 'New Co.' }, expiresAt: '2027-11-24' }).licenseId, 'L-2026-0002');
});

test('dates and weeks: plan terms, periods, ISO weeks and when the weekly digest is due', () => {
    const { rules } = S;
    const D = require('../public/dates');
    assert.equal(rules.planEnd('2026-11-25', 12, 'months'), D.termEnd('2026-11-25', 1));
    assert.equal(rules.planEnd('2026-11-25', 36, 'months'), '2029-11-24');
    assert.equal(rules.planEnd('2028-02-29', 12, 'months'), '2029-02-28');
    // month ends: when the start day does not exist in the target month, the term ends on that month's last day
    assert.equal(rules.planEnd('2026-01-31', 1, 'months'), '2026-02-28');
    assert.equal(rules.planEnd('2028-01-31', 1, 'months'), '2028-02-29');
    assert.equal(rules.planEnd('2026-01-29', 1, 'months'), '2026-02-28');
    assert.equal(rules.planEnd('2026-03-31', 1, 'months'), '2026-04-30');
    assert.equal(rules.planEnd('2026-08-31', 6, 'months'), '2027-02-28');
    assert.equal(rules.planEnd('2026-01-30', 1, 'months'), '2026-02-28');
    assert.equal(rules.planEnd('2026-01-28', 1, 'months'), '2026-02-27');
    assert.equal(rules.planEnd('2026-03-30', 1, 'months'), '2026-04-29');
    assert.equal(rules.planEnd('2026-12-31', 2, 'months'), '2027-02-28');
    // whole years always match the "N years = issued + N years - 1 day" rule
    for (const start of ['2026-11-25', '2028-02-29', '2027-03-01', '2026-01-31', '2026-12-31', '2027-02-28']) {
        for (const y of [1, 2, 3]) assert.equal(rules.planEnd(start, 12 * y, 'months'), D.termEnd(start, y), `${start} + ${y}y`);
    }
    assert.equal(rules.planEnd('2026-11-25', 30, 'days'), '2026-12-24');
    assert.equal(rules.planEnd('2026-11-25', 1, 'days'), '2026-11-25');
    assert.deepEqual(S.periodRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
    assert.deepEqual(S.periodRange('quarter', '2026-11-25'), { from: '2026-10-01', to: '2026-12-31' });
    assert.deepEqual(S.periodRange('quarter', '2026-01-01'), { from: '2026-01-01', to: '2026-03-31' });
    assert.deepEqual(S.periodRange('year', '2026-11-25'), { from: '2026-01-01', to: '2026-12-31' });
    assert.throws(() => S.periodRange('week', '2026-11-25'), { code: 'invalid' });
    assert.equal(S.isoWeek(new Date(2026, 10, 25)), '2026-W48');
    assert.equal(S.isoWeek(new Date(2027, 0, 1)), '2026-W53');
    assert.equal(S.isoWeek(new Date(2027, 0, 4)), '2027-W01');
    const due = (o, d) => S.digestDue({ digestWeekday: 1, digestTime: '09:00', lastDigestWeek: '', ...o }, d);
    assert.equal(due({}, new Date(2026, 10, 23, 8, 59)), false); // Monday before 09:00
    assert.equal(due({}, new Date(2026, 10, 23, 9, 0)), true);
    assert.equal(due({}, new Date(2026, 10, 25, 10, 0)), true); // later in the week, not sent yet
    assert.equal(due({ lastDigestWeek: '2026-W48' }, new Date(2026, 10, 25, 10, 0)), false);
    assert.equal(due({ digestWeekday: 7, digestTime: '23:00' }, new Date(2026, 10, 29, 22, 0)), false); // Sunday
    assert.equal(due({ digestWeekday: 5 }, new Date(2026, 10, 25, 10, 0)), false); // Friday is still to come
});
