// Reports over one data set (today 2026-11-25): the sales summary per sales person per currency for a month / quarter /
// year / custom range, filters, detail rows (revoked only on request), dashboard numbers, trial conversion, the renewal
// board and the weekly-digest data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempStore } = require('./helpers');

function dataset(t) {
    const ctx = tempStore(t);
    const { store, issue } = ctx;
    const A = store.createSales({ name: 'Alice Example', email: 'alice@example.test' });
    const B = store.createSales({ name: 'Bob Example' });
    const C = store.createSales({ name: 'Carol Example', email: 'carol@example.test' });
    const go = (o) => {
        const r = issue({ createCustomer: true, ...o });
        assert.equal(r.ok, true, r.message);
        return r.license;
    };
    const L = {};
    L.Q1 = go({ customerName: 'Q Corp', salesId: A.id, issuedAt: '2025-12-01', expiresAt: '2027-03-01', amount: 700, currency: 'EUR' });
    L.R1 = go({ customerName: 'R Co', salesId: C.id, issuedAt: '2025-06-01', expiresAt: '2027-01-10', amount: 50, currency: 'USD' });
    L.X1 = go({ customerName: 'X Corp', salesId: A.id, issuedAt: '2026-01-15', expiresAt: '2027-01-14', amount: 500, currency: 'USD' });
    L.X2 = go({ customerName: 'X Corp', salesId: A.id, issuedAt: '2026-11-03', expiresAt: '2027-11-02', amount: 1000 });
    L.Y1 = go({ customerName: 'Y Ltd', salesId: A.id, issuedAt: '2026-10-20', expiresAt: '2026-12-10', amount: 300, currency: 'USD' });
    L.Z1 = go({ customerName: 'Z Co', salesId: B.id, type: 'trial', issuedAt: '2026-11-10', expiresAt: '2026-12-09' });
    L.W1 = go({ customerName: 'W Inc', issuedAt: '2026-11-20', expiresAt: '2027-02-15', amount: 200 });
    L.V1 = go({ customerName: 'V Co', salesId: A.id, issuedAt: '2026-11-05', expiresAt: '2026-12-20', amount: 999 });
    store.revokeLicense(L.V1.licenseId, { reason: 'terminated' });
    L.U1 = go({ customerName: 'U Co', salesId: C.id, type: 'trial', issuedAt: '2026-11-01', expiresAt: '2026-11-30' });
    L.U2 = go({ customerName: 'U Co', salesId: C.id, issuedAt: '2026-11-24', expiresAt: '2027-11-23', amount: 2000 });
    store.updateSales(C.id, { active: false });
    const name = Object.fromEntries(Object.entries(L).map(([k, l]) => [l.licenseId, k]));
    return { ...ctx, A, B, C, L, ids: (rows) => rows.map((l) => name[l.licenseId]) };
}

const line = (r) => [r.salesName, r.count, r.new, r.renewal, r.trial, r.amounts];

test('summary per sales person per currency: month / quarter / year / custom range, revoked excluded, new / renewal / trial', (t) => {
    const { store, A } = dataset(t);
    const month = store.reportSummary({ period: 'month', date: '2026-11-25' });
    assert.deepEqual([month.from, month.to], ['2026-11-01', '2026-11-30']);
    assert.deepEqual(month.rows.map(line), [
        ['Alice Example', 1, 0, 1, 0, { TWD: 1000 }],
        ['Bob Example', 1, 0, 0, 1, { TWD: 0 }],
        ['Carol Example', 2, 1, 0, 1, { TWD: 2000 }],
        [null, 1, 1, 0, 0, { TWD: 200 }], // unassigned last
    ]);
    assert.equal(month.rows[3].salesId, null);
    assert.deepEqual(month.totals, { count: 5, new: 2, renewal: 1, trial: 2, amounts: { TWD: 3200 } });

    const quarter = store.reportSummary({ period: 'quarter', date: '2026-11-25' });
    assert.deepEqual(line(quarter.rows[0]), ['Alice Example', 2, 1, 1, 0, { TWD: 1000, USD: 300 }]);
    assert.deepEqual(quarter.totals, { count: 6, new: 3, renewal: 1, trial: 2, amounts: { TWD: 3200, USD: 300 } });

    const year = store.reportSummary({ period: 'year', date: '2026-11-25' });
    assert.deepEqual(line(year.rows[0]), ['Alice Example', 3, 2, 1, 0, { USD: 800, TWD: 1000 }]);
    assert.deepEqual(year.totals, { count: 7, new: 4, renewal: 1, trial: 2, amounts: { TWD: 3200, USD: 800 } });

    const custom = store.reportSummary({ from: '2025-12-01', to: '2026-01-31' });
    assert.deepEqual(custom.rows.map(line), [['Alice Example', 2, 2, 0, 0, { EUR: 700, USD: 500 }]]);
    assert.deepEqual(store.reportSummary({}).totals.count, 9); // all time
    // filters
    const y = { period: 'year', date: '2026-11-25' };
    assert.equal(store.reportSummary({ ...y, salesId: A.id, kind: 'renewal' }).totals.count, 1);
    assert.equal(store.reportSummary({ ...y, salesId: String(A.id) }).totals.count, 3);
    assert.deepEqual(store.reportSummary({ ...y, salesId: 'none' }).rows.map(line), [[null, 1, 1, 0, 0, { TWD: 200 }]]);
    assert.equal(store.reportSummary({ ...y, type: 'trial' }).totals.trial, 2);
    assert.equal(store.reportSummary({ ...y, kind: 'new' }).totals.count, 4);
    assert.equal(store.reportSummary({ ...y, q: 'x corp' }).totals.count, 2);
    assert.equal(store.reportSummary({ ...y, includeRevoked: true }).totals.count, 7); // never in totals
    for (const [f, field] of [[{ from: '2026-12-01', to: '2026-11-01' }, 'to'], [{ from: '2026-02-30' }, 'from'], [{ type: 'free' }, 'type'],
        [{ kind: 'old' }, 'kind'], [{ salesId: 'x' }, 'salesId'], [{ period: 'week', date: '2026-11-25' }, 'period']]) {
        assert.throws(() => store.reportSummary(f), { code: 'invalid', field }, JSON.stringify(f));
    }
});

test('detail rows: oldest issue first; revoked licenses only on request', (t) => {
    const { store, ids } = dataset(t);
    const m = { period: 'month', date: '2026-11-25' };
    assert.deepEqual(ids(store.reportDetail(m).rows), ['U1', 'X2', 'Z1', 'W1', 'U2']);
    const all = store.reportDetail({ ...m, includeRevoked: true });
    assert.deepEqual(ids(all.rows), ['U1', 'X2', 'V1', 'Z1', 'W1', 'U2']);
    assert.deepEqual([all.from, all.to], ['2026-11-01', '2026-11-30']);
    const v1 = all.rows[2];
    assert.deepEqual([v1.status, v1.revokeReason, v1.customerName, v1.salesName, v1.amount, v1.currency], ['Revoked', 'terminated', 'V Co', 'Alice Example', 999, 'TWD']);
    const x2 = all.rows[1];
    assert.deepEqual([x2.isRenewal, x2.type, x2.salesEmail], [true, 'paid', 'alice@example.test']);
    assert.deepEqual(ids(store.reportDetail({ ...m, kind: 'new' }).rows), ['W1', 'U2']);
});

test('amounts are summed per currency in cents', (t) => {
    const { store, issue } = tempStore(t);
    for (const amount of [0.1, 0.2, '1000000.05']) {
        assert.equal(issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24', amount }).ok, true);
    }
    assert.deepEqual(store.reportSummary({ period: 'year', date: '2026-11-25' }).totals.amounts, { TWD: 1000000.35 });
});

test('dashboard: this month and quarter, active trials, trials expiring soon and the conversion rate', (t) => {
    const { store, ids } = dataset(t);
    const d = store.dashboard();
    assert.equal(d.today, '2026-11-25');
    assert.deepEqual(d.month, { from: '2026-11-01', to: '2026-11-30', issued: 5, new: 2, renewal: 1, trial: 2, amounts: { TWD: 3200 } });
    assert.deepEqual(d.quarter, { from: '2026-10-01', to: '2026-12-31', issued: 6, new: 3, renewal: 1, trial: 2, amounts: { TWD: 3200, USD: 300 } });
    assert.deepEqual([d.trials.active, d.trials.expiringSoon], [2, 1]);
    assert.deepEqual(ids(d.trials.list), ['U1', 'Z1']);
    assert.deepEqual(d.trials.list.map((l) => [l.status, l.daysLeft]), [['Expires soon', 5], ['Active', 14]]);
    const c = d.trials.conversion;
    assert.deepEqual([c.withTrial, c.converted, c.rate], [2, 1, 0.5]);
    assert.deepEqual(c.customers.map((x) => [x.customerName, x.firstTrial, x.convertedAt]), [['U Co', '2026-11-01', '2026-11-24'], ['Z Co', '2026-11-10', null]]);
    assert.deepEqual(store.trialConversion({ from: '2026-11-05', to: '2026-11-30' }).rate, 0);
    assert.equal(store.trialConversion({ from: '2027-01-01' }).rate, null);
    // a trial revoked as issued in error is not a trial customer
    store.revokeLicense(d.trials.list[1].licenseId, { reason: 'issued_in_error' });
    assert.deepEqual([store.trialConversion().withTrial, store.trialConversion().rate], [1, 1]);
    assert.equal(store.dashboard({ today: '2026-12-01' }).trials.active, 0); // U1 expired, Z1 revoked
});

test('renewal board: not revoked, expiring within 30 / 60 / 90 days, not already renewed, soonest first', (t) => {
    const { store, ids, issue, L } = dataset(t);
    assert.deepEqual(ids(store.renewalBoard({ days: 30 }).rows), ['Z1', 'Y1']);
    assert.deepEqual(ids(store.renewalBoard({ days: 60 }).rows), ['Z1', 'Y1', 'R1']);
    const b90 = store.renewalBoard({ days: 90 });
    assert.deepEqual(ids(b90.rows), ['Z1', 'Y1', 'R1', 'W1']);
    assert.deepEqual([b90.today, b90.until, b90.days], ['2026-11-25', '2027-02-23', 90]);
    assert.deepEqual(b90.rows.map((l) => [l.customerName, l.salesName, l.daysLeft, l.status]), [
        ['Z Co', 'Bob Example', 14, 'Active'], ['Y Ltd', 'Alice Example', 15, 'Expires soon'], ['R Co', 'Carol Example', 46, 'Active'], ['W Inc', null, 82, 'Active']]);
    assert.deepEqual(ids(store.renewalBoard({ days: 90, type: 'paid' }).rows), ['Y1', 'R1', 'W1']);
    assert.deepEqual(ids(store.renewalBoard({ days: 120 }).rows), ['Z1', 'Y1', 'R1', 'W1', 'Q1']);
    assert.deepEqual(ids(store.renewalBoard().rows), ['Z1', 'Y1']); // default 30
    for (const days of [0, 367, 'x', 1.5]) assert.throws(() => store.renewalBoard({ days }), { code: 'invalid', field: 'days' });
    // renewing (a later paid license of the customer) takes a license off the board; a later trial does not
    assert.equal(issue({ customerName: 'Y Ltd', expiresAt: '2027-12-09', renewalOf: L.Y1.licenseId }).license.isRenewal, true);
    assert.equal(issue({ customerName: 'R Co', type: 'trial', expiresAt: '2026-12-24' }).ok, true);
    assert.deepEqual(ids(store.renewalBoard({ days: 60 }).rows), ['Z1', 'R1']);
});

test('weekly digest data: licenses expiring within 90 days per sales person; mail only for active people with an email', (t) => {
    const { store, ids, A } = dataset(t);
    const d = store.digestData();
    assert.deepEqual([d.today, d.until, d.days, d.total], ['2026-11-25', '2027-02-23', 90, 4]);
    assert.deepEqual(ids(d.licenses), ['Z1', 'Y1', 'R1', 'W1']);
    assert.deepEqual(d.groups.map((g) => [g.salesName, g.email, g.active, ids(g.licenses)]), [
        ['Alice Example', 'alice@example.test', true, ['Y1']],
        ['Bob Example', null, true, ['Z1']],
        ['Carol Example', 'carol@example.test', false, ['R1']],
        [null, null, false, ['W1']],
    ]);
    assert.deepEqual(d.recipients.map((g) => [g.salesId, g.email]), [[A.id, 'alice@example.test']]);
    assert.deepEqual(ids(store.digestData({ days: 30 }).licenses), ['Z1', 'Y1']);
    const later = store.digestData({ today: '2027-06-01' });
    assert.deepEqual([later.total, later.groups, later.recipients], [0, [], []]); // the admin still gets a "nothing expiring" mail
});
