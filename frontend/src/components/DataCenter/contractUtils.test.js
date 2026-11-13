import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ymdIndex, contractDaysLeft, contractStatus, termProgress, daysLeftText, expiringSoon, contractKpis, moneyText, seatUsage,
    relatedIssues, filterContracts, sortContracts, vendorsOf, renewalDraft, editDraft, formProblem, contractsCsv, groupDevices,
} from './contractUtils.js';

const NOW = new Date(2026, 10, 13, 15, 30).getTime();
const ymd = (offset) => { const d = new Date(2026, 10, 13 + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const C = (id, endOffset, extra = {}) => ({ id, name: id, vendor: 'V', type: 'Hardware Warranties', startDate: ymd(-300), endDate: ymd(endOffset), ...extra });

test('days left and status: calendar days, last day still active, renewed and undated', () => {
    assert.equal(ymdIndex('2026-02-30'), null);
    assert.equal(contractDaysLeft(C('a', 0), NOW), 0);
    assert.equal(contractStatus(C('a', 0), NOW), 'Expiring');
    assert.equal(contractStatus(C('a', 61), NOW), 'Active');
    assert.equal(contractStatus(C('a', 60), NOW), 'Expiring');
    assert.equal(contractStatus(C('a', -1), NOW), 'Expired');
    assert.equal(contractStatus(C('a', -1, { renewedTo: 'b' }), NOW), 'Renewed');
    assert.equal(contractStatus({ endDate: '' }, NOW), 'Unknown');
    assert.equal(daysLeftText(1), '1 day left');
    assert.equal(daysLeftText(-3), 'Expired 3 days ago');
    assert.equal(daysLeftText(0), 'Ends today');
    assert.equal(termProgress({ startDate: ymd(0), endDate: ymd(9) }, NOW), 0);
    assert.equal(termProgress({ startDate: ymd(-5), endDate: ymd(4) }, NOW), 50);
    assert.equal(termProgress({ startDate: ymd(-5), endDate: ymd(-1) }, NOW), 100);
});

test('Home banner list: trashed and renewed contracts left out, soonest first', () => {
    const list = [C('a', 20), C('b', 3), C('c', 40), C('d', 5, { deletedAt: 'x' }), C('e', 5, { renewedTo: 'f' }), C('g', -1)];
    assert.deepEqual(expiringSoon(list, NOW, 30).map(c => [c.id, c.daysLeft]), [['b', 3], ['a', 20]]);
});

test('figures: counts by status; spend and renewals per currency, never added across currencies', () => {
    const list = [
        C('a', 100, { cost: 1000, currency: 'USD' }), C('b', 30, { cost: '500', currency: 'USD' }), C('c', 10, { cost: 30000, currency: 'TWD' }),
        C('d', -5, { cost: 9 }), C('e', 200, { renewedTo: 'x', cost: 7 }), C('f', 20, { deletedAt: 'x', cost: 99 }),
        C('g', 50, { type: 'Software Licenses', cost: 1 }),
    ];
    const k = contractKpis(list, 'Hardware Warranties', NOW);
    assert.equal(k.total, 5);
    assert.deepEqual([k.Active, k.Expiring, k.Expired, k.Renewed], [1, 2, 1, 1]);
    assert.equal(k.renewalCount, 2);
    assert.equal(moneyText(k.renewalDue), 'TWD 30,000 · USD 500');
    // running terms: a, b (USD) and c, e (TWD; the renewed term still runs until its end); d expired
    assert.deepEqual(k.spend.map(s => [s.currency, s.total]), [['TWD', 30007], ['USD', 1500]]);
    assert.equal(moneyText([]), '-');
});

test('seats: entered count first, else linked devices; over-use flagged', () => {
    assert.equal(seatUsage({ type: 'Hardware Warranties', seats: 5 }), null);
    assert.equal(seatUsage({ type: 'Software Licenses', seats: '' }), null);
    assert.deepEqual(seatUsage({ type: 'Software Licenses', seats: '10', seatsUsed: 4, linkedDevices: ['a'] }), { used: 4, total: 10, source: 'manual', over: false, pct: 40 });
    assert.deepEqual(seatUsage({ type: 'Software Licenses', seats: 1, seatsUsed: '', linkedDevices: ['a', 'b'] }), { used: 2, total: 1, source: 'devices', over: true, pct: 100 });
});

test('related issues by device or warranty serial; open first', () => {
    const issues = [
        { id: 1, deviceId: 'd1', status: 'Closed', date: '2026-01-01' },
        { id: 2, sn: ' sn9 ', status: 'Open', date: '2026-02-01' },
        { id: 3, deviceId: 'zz', status: 'Open' },
    ];
    assert.deepEqual(relatedIssues({ type: 'Hardware Warranties', serialNumber: 'SN9', linkedDevices: ['d1'] }, issues).map(i => i.id), [2, 1]);
    assert.deepEqual(relatedIssues({ type: 'Software Licenses', serialNumber: 'SN9', linkedDevices: [] }, issues), []);
});

test('filter, sort, vendors: tab and trash, status, vendor, search through device names', () => {
    const devices = new Map([['d1', { hostname: 'DB-SERVER-01' }]]);
    const list = [
        C('alpha', 100, { vendor: 'Dell', linkedDevices: ['d1'], cost: 5, updatedAt: '2026-11-01' }),
        C('beta', 10, { vendor: 'HPE', cost: 50, updatedAt: '2026-11-10' }),
        C('gamma', 5, { vendor: 'Dell', deletedAt: '2026-11-12' }),
        C('lic', 5, { type: 'Software Licenses', vendor: 'Microsoft' }),
        C('old', 300, { vendor: 'Dell', renewedTo: 'alpha' }),
    ];
    const tab = 'Hardware Warranties';
    assert.deepEqual(filterContracts(list, { tab }, NOW).map(c => c.id), ['alpha', 'beta', 'old']);
    assert.deepEqual(filterContracts(list, { tab: 'Trash' }, NOW).map(c => c.id), ['gamma']);
    assert.deepEqual(filterContracts(list, { tab, status: 'Expiring' }, NOW).map(c => c.id), ['beta']);
    assert.deepEqual(filterContracts(list, { tab, vendor: 'Dell' }, NOW).map(c => c.id), ['alpha', 'old']);
    assert.deepEqual(filterContracts(list, { tab, q: 'db-server' }, NOW, devices).map(c => c.id), ['alpha']);
    assert.deepEqual(sortContracts(filterContracts(list, { tab }, NOW), 'end', NOW).map(c => c.id), ['beta', 'alpha', 'old']);
    assert.deepEqual(sortContracts(list, 'cost', NOW).map(c => c.id).slice(0, 2), ['beta', 'alpha']);
    assert.deepEqual(sortContracts(list, 'updated', NOW).map(c => c.id).slice(0, 2), ['gamma', 'beta']);
    assert.deepEqual(vendorsOf(list), ['Dell', 'HPE', 'Microsoft']);
});

test('renewal and edit drafts; form checks', () => {
    const c = { id: 'c1', type: 'Software Licenses', name: 'Office', vendor: 'MS', startDate: '2026-01-01', endDate: '2026-12-31', seats: 10, cost: 100, currency: 'USD', linkedDevices: ['d1'], savedFileName: 'x.pdf', updatedAt: 'T1' };
    const r = renewalDraft(c);
    assert.equal(r.startDate, '2027-01-01');
    assert.equal(r.endDate, '2027-12-31');
    assert.equal(r.renewedFrom, 'c1');
    assert.equal(r.id, '');
    assert.ok(!('savedFileName' in r));
    r.linkedDevices.push('d2');
    assert.deepEqual(c.linkedDevices, ['d1'], 'the draft has its own list');
    const e = editDraft(c);
    assert.equal(e.id, 'c1');
    assert.equal(e.expectedUpdatedAt, 'T1');
    assert.ok(!('savedFileName' in e));

    assert.equal(formProblem({ ...e }), '');
    assert.match(formProblem({ ...e, endDate: '2025-01-01' }), /before the start/);
    assert.match(formProblem({ ...e, vendor: ' ' }), /vendor/);
    assert.match(formProblem({ ...e, type: 'Hardware Warranties', serialNumber: '', linkedDevices: [] }), /serial number or link a device/);
});

test('CSV: one row per contract, Excel-safe cells, device names', () => {
    const csv = contractsCsv([C('a', 10, { name: '=cmd', linkedDevices: ['d1', 'gone'], cost: 5, currency: 'USD' })], NOW, new Map([['d1', { hostname: 'SRV01' }]]));
    const [head, row] = csv.split('\r\n');
    assert.match(head, /^"Type","Name","Vendor","Status"/);
    assert.match(row, /"'=cmd"/);
    assert.match(row, /"Expiring"/);
    assert.match(row, /"SRV01; gone"/);
});

test('device picker groups by data center and rack, top unit first, with search and selected-only', () => {
    const devices = [
        { id: 'a', hostname: 'SRV01', dcId: 'default', dcName: 'Main', rackId: 'r1', rackName: 'A01', u: 10 },
        { id: 'b', hostname: 'SRV02', dcId: 'default', dcName: 'Main', rackId: 'r1', rackName: 'A01', u: 20 },
        { id: 'c', hostname: 'SW01', dcId: 'dc2', dcName: 'Backup', rackId: 'r9', rackName: 'B01', u: 40 },
    ];
    const g = groupDevices(devices);
    assert.deepEqual(g.map(x => [x.label, x.devices.map(d => d.id)]), [['Backup · B01', ['c']], ['Main · A01', ['b', 'a']]]);
    assert.deepEqual(groupDevices(devices, 'srv02').flatMap(x => x.devices.map(d => d.id)), ['b']);
    assert.deepEqual(groupDevices(devices, '', new Set(['a', 'c'])).flatMap(x => x.devices.map(d => d.id)), ['c', 'a']);
});
