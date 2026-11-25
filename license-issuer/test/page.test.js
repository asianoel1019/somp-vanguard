// The page (public/): pure helpers of format.js, and static checks of index.html + the tab scripts (no inline code or
// styles for the CSP, no external resources, no innerHTML, every element id the scripts look up exists).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../public/format');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

test('format: numbers, money, amounts per currency, percent, sizes, days', () => {
    assert.equal(F.number(12000), '12,000');
    assert.equal(F.number(1234567.5), '1,234,567.50');
    assert.equal(F.number(0.1 + 0.2), '0.30');
    assert.equal(F.number(0), '0');
    assert.equal(F.number(NaN), '');
    assert.equal(F.money(12000, 'TWD'), 'TWD 12,000');
    assert.equal(F.money(99.5, 'USD'), 'USD 99.50');
    assert.equal(F.money(0, 'TWD'), 'TWD 0');
    assert.equal(F.money(null, 'TWD'), '');
    assert.equal(F.money(undefined), '');
    const order = ['TWD', 'USD', 'EUR'];
    assert.equal(F.amountsText({ USD: 50, TWD: 1000 }, order), 'TWD 1,000 · USD 50');
    assert.equal(F.amountsText({ XYZ: 1, EUR: 2 }, order), 'EUR 2 · XYZ 1');
    assert.equal(F.amountsText({}, order), '—');
    assert.equal(F.amountsText(null), '—');
    assert.deepEqual(F.currenciesOf([{ amounts: { USD: 1 } }, { amounts: { TWD: 2, USD: 3 } }, {}], order), ['TWD', 'USD']);
    assert.equal(F.percent(0.5), '50%');
    assert.equal(F.percent(1 / 3), '33.3%');
    assert.equal(F.percent(0), '0%');
    assert.equal(F.percent(null), '—');
    assert.equal(F.sizeText(512), '512 B');
    assert.equal(F.sizeText(1536), '1.5 KB');
    assert.equal(F.sizeText(5 * 1024 * 1024), '5 MB');
    assert.equal(F.daysText(0), 'today');
    assert.equal(F.daysText(1), '1 day left');
    assert.equal(F.daysText(-3), '3 days ago');
    assert.equal(F.daysText(null), '—');
    assert.equal(F.stampText('2026-11-25T10:05:09+08:00'), '2026-11-25 10:05');
    assert.equal(F.plural(1, 'license'), '1 license');
    assert.equal(F.plural(2, 'license'), '2 licenses');
});

test('format: labels, badges and the query string', () => {
    assert.equal(F.badgeClass('Active'), 'ok');
    assert.equal(F.badgeClass('Expires soon'), 'warn');
    assert.equal(F.badgeClass('Expired'), 'bad');
    assert.equal(F.badgeClass('Format 1 (invalid)'), 'bad');
    assert.equal(F.badgeClass('Revoked'), 'muted');
    assert.equal(F.badgeClass('???'), '');
    assert.equal(F.typeLabel('trial'), 'Trial');
    assert.equal(F.typeLabel('paid'), 'Paid');
    assert.equal(F.kindLabel({ type: 'trial', isRenewal: false }), 'Trial');
    assert.equal(F.kindLabel({ type: 'paid', isRenewal: true }), 'Renewal');
    assert.equal(F.kindLabel({ type: 'paid', isRenewal: false }), 'New');
    assert.equal(F.reasonText('issued_in_error'), 'Issued in error');
    assert.equal(F.query({ a: 1, b: '', c: null, d: undefined, e: false, f: true, q: 'x y&z' }), 'a=1&f=1&q=x%20y%26z');
    assert.equal(F.query({}), '');
    assert.equal(F.dispositionName('attachment; filename="L-2026-0001-example.lic"', 'x'), 'L-2026-0001-example.lic');
    assert.equal(F.dispositionName("attachment; filename=\"a.csv\"; filename*=UTF-8''r%C3%A9port.csv", 'x'), 'réport.csv');
    assert.equal(F.dispositionName('', 'fallback.lic'), 'fallback.lic');
});

test('format: amounts typed in the forms', () => {
    assert.deepEqual(F.parseAmount(''), { value: null, error: '' });
    assert.deepEqual(F.parseAmount('  '), { value: null, error: '' });
    assert.deepEqual(F.parseAmount('12000'), { value: 12000, error: '' });
    assert.deepEqual(F.parseAmount(' 99.5 '), { value: 99.5, error: '' });
    assert.deepEqual(F.parseAmount('0'), { value: 0, error: '' });
    assert.deepEqual(F.parseAmount(0), { value: 0, error: '' });
    for (const bad of ['-1', '1.234', '1,000', '1e3', 'abc', '12 000', '.5', '+5', '1.']) {
        assert.ok(F.parseAmount(bad).error, bad);
        assert.equal(F.parseAmount(bad).value, null, bad);
    }
});

test('format: customer search matches every word in name, email, tax ID, contact or phone', () => {
    const list = [
        { id: 1, name: 'Example Corp.', email: 'it@example.test', taxId: '12345678' },
        { id: 2, name: '範例科技股份有限公司', contactPerson: 'Amy Lin', phone: '02-1234-5678' },
        { id: 3, name: 'Other Example Ltd.', email: null },
    ];
    const ids = (q) => F.filterCustomers(list, q).map((c) => c.id);
    assert.deepEqual(ids(''), [1, 2, 3]);
    assert.deepEqual(ids('example'), [1, 3]);
    assert.deepEqual(ids('EXAMPLE corp'), [1]);
    assert.deepEqual(ids('1234'), [1, 2]);
    assert.deepEqual(ids('範例'), [2]);
    assert.deepEqual(ids('amy'), [2]);
    assert.deepEqual(ids('nobody'), []);
});

test('format: plan expiry and renewal defaults (Renew on the Dashboard / Licenses tabs)', () => {
    const plans = [
        { id: 1, name: 'Trial 30 days', type: 'trial', termValue: 30, termUnit: 'days', price: 0, currency: 'TWD', active: true },
        { id: 2, name: '1 year', type: 'paid', termValue: 12, termUnit: 'months', price: null, currency: 'TWD', active: true },
        { id: 3, name: '2 years', type: 'paid', termValue: 24, termUnit: 'months', price: 50000, currency: 'USD', active: true },
        { id: 4, name: 'Old', type: 'paid', termValue: 6, termUnit: 'months', price: 1, currency: 'TWD', active: false },
    ];
    assert.equal(F.planExpiry('2026-11-25', plans[1]), '2027-11-24');
    assert.equal(F.planExpiry('2026-11-25', plans[0]), '2026-12-24');
    assert.equal(F.planExpiry('bad', plans[0]), '');
    assert.equal(F.planExpiry('2026-11-25', null), '');

    // still valid: the new term starts the day after the old expiry
    assert.equal(F.renewalStart('2026-12-31', '2026-11-25'), '2027-01-01');
    assert.equal(F.renewalStart('2026-11-25', '2026-11-25'), '2026-11-26');
    // expired or no expiry (format 1): starts today
    assert.equal(F.renewalStart('2026-11-24', '2026-11-25'), '2026-11-25');
    assert.equal(F.renewalStart(null, '2026-11-25'), '2026-11-25');

    const paid = { licenseId: 'L-2026-0001', customerId: 7, planId: 3, salesId: 5, type: 'paid', expiresAt: '2026-12-31', amount: 1000, currency: 'EUR', revokedAt: null };
    assert.deepEqual(F.renewalDefaults(paid, plans, '2026-11-25', 'TWD'), {
        customerId: 7, renewalOf: 'L-2026-0001', planId: 3, salesId: 5, issuedAt: '2026-11-25', expiresAt: '2028-12-31',
        amount: 50000, currency: 'USD', orderNo: '',
    });
    // own plan without a price: the old amount and currency are offered
    const noPrice = { ...paid, planId: 2 };
    const r1 = F.renewalDefaults(noPrice, plans, '2026-11-25', 'TWD');
    assert.deepEqual([r1.planId, r1.expiresAt, r1.amount, r1.currency], [2, '2027-12-31', 1000, 'EUR']);
    // inactive or missing plan: the 12-month paid plan
    const r2 = F.renewalDefaults({ ...paid, planId: 4, expiresAt: '2026-01-01' }, plans, '2026-11-25', 'TWD');
    assert.deepEqual([r2.planId, r2.issuedAt, r2.expiresAt], [2, '2026-11-25', '2027-11-24']);
    // a trial converts to a paid plan; the trial's amount (0) is not carried over
    const trial = { licenseId: 'L-2026-0002', customerId: 8, planId: 1, salesId: null, type: 'trial', expiresAt: '2026-12-10', amount: 0, currency: 'TWD', revokedAt: null };
    const r3 = F.renewalDefaults(trial, plans, '2026-11-25', 'JPY');
    assert.deepEqual([r3.planId, r3.expiresAt, r3.amount, r3.currency, r3.salesId], [2, '2027-12-10', null, 'TWD', null]);
    // revoked: starts today
    assert.equal(F.renewalDefaults({ ...noPrice, revokedAt: '2026-11-01T10:00:00+08:00' }, plans, '2026-11-25', 'TWD').expiresAt, '2027-11-24');
    // no paid plan at all: one year
    const r4 = F.renewalDefaults(paid, [plans[0]], '2026-11-25', 'TWD');
    assert.deepEqual([r4.planId, r4.expiresAt, r4.amount, r4.currency], [null, '2027-12-31', 1000, 'EUR']);
});

test('format: timeline texts of every event type', () => {
    const t = (type, detail) => F.eventText({ type, detail });
    assert.equal(t('issued', { source: 'web', plan: '1 year', renewalOf: 'L-2026-0001' }), 'Issued (via web page, plan 1 year, renews L-2026-0001)');
    assert.equal(t('issued', { source: 'cli', replaces: 'L-2026-0003' }), 'Issued (via command line, replaces L-2026-0003)');
    assert.equal(t('issued', {}), 'Issued');
    assert.equal(t('delivered', { to: 'it@example.test', attachment: 'L-1.lic' }), 'Sent to it@example.test with L-1.lic');
    assert.equal(t('delivery_failed', { to: 'it@example.test', error: 'timeout' }), 'Sending to it@example.test failed: timeout');
    assert.equal(t('downloaded', {}), 'Downloaded');
    assert.equal(t('reissued', { reason: 'Lost file', via: 'mail', to: 'it@example.test' }), 'Reissued by email to it@example.test: Lost file');
    assert.equal(t('reissued', { reason: 'Lost file', via: 'download' }), 'Reissued by download: Lost file');
    assert.equal(t('revoked', { reason: 'terminated', note: 'Contract ended' }), 'Revoked: Terminated (Contract ended)');
    assert.equal(t('replaced', { replacedBy: 'L-2026-0009' }), 'Replaced by L-2026-0009');
    assert.equal(t('edited', { before: { amount: null, sales: 'Alice' }, after: { amount: 100, sales: 'Bob' } }), 'Edited: sales Alice → Bob; amount (none) → 100');
    assert.equal(t('imported', { line: 12 }), 'Imported from the old registry (line 12)');
    assert.equal(F.eventText({ type: 'something' }), 'something');
});

test('page: no inline scripts, styles or handlers; no external resources; no innerHTML', () => {
    const html = read('index.html');
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 5);
    for (const [, attrs, body] of scripts) {
        assert.match(attrs, /^ src="[a-z-]+\.js"$/);
        assert.equal(body.trim(), '');
        assert.ok(fs.existsSync(path.join(PUBLIC, attrs.match(/src="([^"]+)"/)[1])), attrs);
    }
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|javascript:/i);
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i);
    const js = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js'));
    for (const f of js) {
        const text = read(f);
        assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
        assert.doesNotMatch(text, /https?:\/\//, f);
        assert.doesNotMatch(text, /\.style\.|setAttribute\('style'/, f);
    }
    // every page script is loaded, helpers first, main last
    const order = scripts.map((s) => s[1].match(/src="([^"]+)"/)[1]);
    assert.deepEqual([...order].sort(), [...js].sort());
    assert.deepEqual(order.slice(0, 4), ['dates.js', 'contact.js', 'format.js', 'ui.js']);
    assert.equal(order[order.length - 1], 'main.js');
});

test('page: six tabs with a panel each; every id the scripts look up exists in index.html', () => {
    const html = read('index.html');
    const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ['dashboard', 'issue', 'licenses', 'customers', 'reports', 'settings']);
    for (const t of tabs) {
        assert.match(html, new RegExp(`<section id="panel-${t}"`));
        assert.match(read(`tab-${t}.js`), new RegExp(`LI\\.register\\('${t}'`));
    }
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(ids.size, [...html.matchAll(/\sid="([^"]+)"/g)].length, 'ids are unique');
    for (const f of fs.readdirSync(PUBLIC).filter((x) => /^(ui|main|tab-[a-z]+)\.js$/.test(x))) {
        const text = read(f);
        const used = [
            ...[...text.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
            ...[...text.matchAll(/LI\.(?:banner|show|fillSelect|clearErrors|clear|fieldError)\('([^']+)'\s*[,)]/g)].map((m) => m[1]),
        ];
        for (const id of used) assert.ok(ids.has(id), `${f}: #${id} is not in index.html`);
        // LI.banner adds the 'banner' class itself: the kind is only err | warn | ok | info
        assert.doesNotMatch(text, /'banner (?:err|warn|ok|info)'\);/, f);
    }
    // labels point at existing inputs
    for (const m of html.matchAll(/<label for="([^"]+)"/g)) assert.ok(ids.has(m[1]), `label for=${m[1]}`);
});

test('page: confirm texts — revoke says the file stays valid, replace and customer delete ask first', () => {
    const lic = read('tab-licenses.js');
    assert.match(lic, /Revoking is a record only\. /);
    assert.match(lic, /stays valid until it expires/);
    assert.match(lic, /title: 'Replace ' \+ l\.licenseId \+ '\?'/);
    assert.match(lic, /okText: 'Send'/); // the delivery mail is previewed in the dialog before sending
    assert.match(read('tab-customers.js'), /LI\.confirm\('Delete ' \+ c\.name \+ '\?'/);
    assert.match(read('tab-issue.js'), /LI\.api\('POST', 'api\/licenses', body\)/);
    assert.doesNotMatch(read('tab-issue.js'), /api\/issue/);
});
