// Reports over the API (numbers per sales person / currency, filters, revoked only on request), CSV export (BOM, quoting,
// formula-injection prefix) and backups (create, list, download; only backup files of the database folder).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cell, toCsv, summaryCsv } = require('../src/csv');
const { startApp } = require('./helpers');

const FORMULA = '=HYPERLINK("http://example.test","x")';

async function reportApp(t) {
    const app = await startApp(t);
    const c = await app.login();
    const A = (await c.call('POST', '/api/sales', { body: { name: 'Alice Example' } })).json.sales;
    const B = (await c.call('POST', '/api/sales', { body: { name: 'Bob Example' } })).json.sales;
    const issue = async (body) => {
        const r = await c.call('POST', '/api/licenses', { body });
        assert.equal(r.status, 201, r.text);
        return r.json.license;
    };
    const x1 = await issue({ newCustomer: { name: 'X Corp' }, salesId: A.id, issuedAt: '2026-11-03', expiresAt: '2027-11-02', amount: 1000 });
    await issue({ newCustomer: { name: 'Y Ltd' }, salesId: A.id, issuedAt: '2026-10-20', expiresAt: '2027-10-19', amount: 300, currency: 'USD' });
    await issue({ customerId: x1.customerId, salesId: A.id, issuedAt: '2026-11-10', expiresAt: '2028-11-02', amount: 500 });
    await issue({ newCustomer: { name: 'Z Co' }, salesId: B.id, type: 'trial', issuedAt: '2026-11-10', expiresAt: '2026-12-09' });
    await issue({ newCustomer: { name: FORMULA }, salesId: B.id, issuedAt: '2026-11-12', expiresAt: '2027-11-11', amount: 10, orderNo: '+cmd|calc' });
    const v = await issue({ newCustomer: { name: 'V Co' }, salesId: A.id, issuedAt: '2026-11-05', expiresAt: '2027-11-04', amount: 999 });
    await c.call('POST', `/api/licenses/${v.licenseId}/revoke`, { body: { reason: 'terminated' } });
    return { app, c, A, B };
}

const line = (r) => [r.salesName, r.count, r.new, r.renewal, r.trial, r.amounts];

test('csv cells: quoting, doubled quotes, formula prefix, numbers kept, BOM and CRLF', () => {
    assert.equal(cell('plain'), 'plain');
    assert.equal(cell('a,b'), '"a,b"');
    assert.equal(cell('say "hi"'), '"say ""hi"""');
    assert.equal(cell('two\nlines'), '"two\nlines"');
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', ' =x']) assert.equal(cell(s)[0] === '"' ? cell(s)[1] : cell(s)[0], "'", s);
    assert.equal(cell('=A1,B1'), `"'=A1,B1"`);
    assert.equal(cell(-5), '-5');
    assert.equal(cell(null), '');
    assert.equal(cell(0), '0');
    assert.equal(toCsv([['a', 'b'], [1, 2]]), '﻿a,b\r\n1,2\r\n');
    assert.equal(summaryCsv({ rows: [], totals: { count: 0, new: 0, renewal: 0, trial: 0, amounts: {} } }), '﻿Sales,Licenses,New,Renewal,Trial\r\nTotal,0,0,0,0\r\n');
});

test('reports: month / quarter / custom numbers per sales person, filters, revoked only in detail on request', async (t) => {
    const { c, A, B } = await reportApp(t);
    const m = await c.call('GET', '/api/reports?period=month&date=2026-11-25');
    assert.equal(m.status, 200, m.text);
    assert.deepEqual([m.json.from, m.json.to], ['2026-11-01', '2026-11-30']);
    assert.deepEqual(m.json.summary.rows.map(line), [['Alice Example', 2, 1, 1, 0, { TWD: 1500 }], ['Bob Example', 2, 1, 0, 1, { TWD: 10 }]]);
    assert.deepEqual(m.json.summary.totals, { count: 4, new: 2, renewal: 1, trial: 1, amounts: { TWD: 1510 } });
    assert.equal(m.json.detail.rows.length, 4);
    const withRevoked = await c.call('GET', '/api/reports?period=month&date=2026-11-25&includeRevoked=1');
    assert.equal(withRevoked.json.detail.rows.length, 5);
    assert.deepEqual(withRevoked.json.summary.totals.count, 4); // never counted
    const qt = await c.call('GET', '/api/reports?period=quarter&date=2026-11-25');
    assert.deepEqual(line(qt.json.summary.rows[0]), ['Alice Example', 3, 2, 1, 0, { TWD: 1500, USD: 300 }]);
    const custom = await c.call('GET', '/api/reports?period=custom&from=2026-10-01&to=2026-10-31');
    assert.deepEqual(custom.json.summary.rows.map(line), [['Alice Example', 1, 1, 0, 0, { USD: 300 }]]);
    assert.equal((await c.call(`GET`, `/api/reports?period=year&date=2026-01-01&salesId=${B.id}`)).json.summary.totals.count, 2);
    assert.equal((await c.call('GET', '/api/reports?period=year&date=2026-01-01&kind=renewal')).json.summary.totals.count, 1);
    assert.equal((await c.call('GET', `/api/reports?period=year&date=2026-01-01&type=trial&salesId=${A.id}`)).json.summary.totals.count, 0);
    for (const qs of ['period=decade', 'period=month&date=2026-13-01', 'period=custom&from=2026-12-01&to=2026-11-01', 'type=gift', 'kind=old', 'salesId=x', 'includeRevoked=maybe']) {
        assert.equal((await c.call('GET', `/api/reports?${qs}`)).status, 400, qs);
    }
});

test('CSV export: summary and detail as attachments with BOM, quoting and formula prefix', async (t) => {
    const { app, c } = await reportApp(t);
    const s = await c.call('GET', '/api/reports/summary.csv?period=quarter&date=2026-11-25');
    assert.equal(s.status, 200);
    assert.equal(s.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(s.headers['content-disposition'], /attachment; filename="?license-report-summary-2026-10-01_2026-12-31\.csv"?$/);
    assert.deepEqual([...s.raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(s.text, '﻿Sales,Licenses,New,Renewal,Trial,Amount TWD,Amount USD\r\nAlice Example,3,2,1,0,1500,300\r\nBob Example,2,1,0,1,10,\r\nTotal,5,3,1,1,1510,300\r\n');
    const d = await c.call('GET', '/api/reports/detail.csv?period=month&date=2026-11-25&includeRevoked=true');
    const lines = d.text.replace(/^﻿/, '').split('\r\n');
    assert.equal(lines[0], 'License ID,Customer,Licensed to,Type,New/Renewal,Issued,Expires,Sales,Amount,Currency,Order no.,Plan,Status,Revoked at,Revoke reason,Replaces,Replaced by');
    assert.equal(lines.length, 7); // header + 5 rows + final empty
    const f = lines.find((l) => l.includes('HYPERLINK'));
    assert.ok(f.includes(`"'=HYPERLINK(""http://example.test"",""x"")","'=HYPERLINK(""http://example.test"",""x"")",Paid,New,2026-11-12,2027-11-11,Bob Example,10,TWD,'+cmd|calc`), f);
    assert.ok(lines.some((l) => /,Revoked,.*,terminated,/.test(l)));
    assert.match(d.headers['content-disposition'], /license-report-detail-2026-11-01_2026-11-30\.csv/);
    const all = await c.call('GET', '/api/reports/summary.csv');
    assert.match(all.headers['content-disposition'], /license-report-summary-all_all\.csv/);
    assert.match(app.auditText(), /"event":"report-export"/);
});

test('backups: create, list, download; only backup files of the database folder', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    assert.deepEqual((await c.call('GET', '/api/backups')).json.backups, []);
    const b = await c.call('POST', '/api/backups');
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.backup.name, 'license-issuer-backup-20261125-100000.db');
    assert.equal(b.json.backup.file, undefined);
    const b2 = await c.call('POST', '/api/backups');
    assert.equal(b2.json.backup.name, 'license-issuer-backup-20261125-100000-2.db');
    const list = await c.call('GET', '/api/backups');
    assert.equal(list.json.dir, app.k.dir);
    assert.deepEqual(list.json.backups.map((x) => x.name), [b2.json.backup.name, b.json.backup.name]);
    const dl = await c.call('GET', `/api/backups/${b.json.backup.name}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'application/octet-stream');
    assert.match(dl.headers['content-disposition'], /attachment; filename="?license-issuer-backup-20261125-100000\.db"?$/);
    assert.equal(dl.headers['cache-control'], 'no-store');
    assert.deepEqual(dl.raw, fs.readFileSync(path.join(app.k.dir, b.json.backup.name)));
    assert.equal(dl.raw.subarray(0, 15).toString(), 'SQLite format 3');

    // names that are not existing backups, path tricks, the database itself, the key
    fs.writeFileSync(path.join(app.k.dir, 'license-issuer-backup-20990101-000000.txt'), 'x');
    for (const p of ['license-issuer.db', path.basename(app.k.keyFile), '..%2Flicense-issuer.db', '..%5C..%5Cx.db', '%2e%2e', 'license-issuer-backup-20990101-000000.db',
        'license-issuer-backup-20990101-000000.txt', `${b.json.backup.name}%00`, `..%2F${path.basename(app.k.dir)}%2F${b.json.backup.name}`, 'LICENSE-ISSUER-BACKUP-20261125-100000.DB']) {
        const r = await c.call('GET', `/api/backups/${p}`);
        assert.equal(r.status, 404, `${p} -> ${r.status}`);
        assert.ok(!r.raw.includes('PRIVATE KEY') && !r.raw.includes('SQLite format'), p);
    }
    // a folder with a backup's name
    fs.mkdirSync(path.join(app.k.dir, 'license-issuer-backup-20261125-110000.db'));
    assert.equal((await c.call('GET', '/api/backups/license-issuer-backup-20261125-110000.db')).status, 404);
    // a link with a backup's name pointing outside (skipped where links cannot be made)
    const outside = path.join(app.k.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.db'), 'SQLite format 3 secret');
    let linked = false;
    try { fs.symlinkSync(path.join(outside, 'secret.db'), path.join(app.k.dir, 'license-issuer-backup-20261125-120000.db')); linked = true; } catch { /* no symlink rights */ }
    if (linked) assert.equal((await c.call('GET', '/api/backups/license-issuer-backup-20261125-120000.db')).status, 404);
    assert.match(app.auditText(), /"event":"backup"/);
    assert.match(app.auditText(), /"event":"backup-download"/);
    assert.match(app.auditText(), /"event":"backup-download-refused"/);
});
