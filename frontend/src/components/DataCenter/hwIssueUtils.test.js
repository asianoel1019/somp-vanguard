import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNoteTime, csvCell, initialOf, ageDays, isOverdue, closedRecently, filterIssues, sortIssues, issueKpis, warrantyFor, sparePartsUsed } from './hwIssueUtils.js';

test('csvCell quotes, doubles quotes, and keeps formula-like text as text', () => {
    assert.equal(csvCell('PSU "A"'), '"PSU ""A"""');
    assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${lead}cmd`).startsWith(`"'${lead}`), JSON.stringify(lead));
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(0), '"0"');
});

test('formatNoteTime shows server ISO times in local time and older text unchanged', () => {
    const iso = '2026-11-13T01:02:03.000Z';
    assert.equal(formatNoteTime(iso), new Date(iso).toLocaleString());
    assert.equal(formatNoteTime('2024/1/2 上午10:00:00'), '2024/1/2 上午10:00:00');
    assert.equal(formatNoteTime(''), '');
    assert.equal(formatNoteTime(undefined), '');
});

test('initialOf never fails on a missing reporter', () => {
    assert.equal(initialOf('alice'), 'A');
    assert.equal(initialOf(''), '?');
    assert.equal(initialOf(undefined), '?');
    assert.equal(initialOf('  bob'), 'B');
});

const NOW = new Date('2026-11-13T12:00:00').getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('age, deadline and overdue: urgency days or the due date; closed issues are never overdue', () => {
    const high = { urgency: 'H', status: 'Open', createdAt: daysAgo(3) };
    assert.equal(ageDays(high, NOW), 3);
    assert.equal(isOverdue(high, NOW), true, 'High: 2 days');
    assert.equal(isOverdue({ ...high, urgency: 'M' }, NOW), false, 'Medium: 7 days');
    assert.equal(isOverdue({ ...high, dueDate: '2026-11-13' }, NOW), false, 'own due date: until the end of that day');
    assert.equal(isOverdue({ ...high, dueDate: '2026-11-12' }, NOW), true);
    assert.equal(isOverdue({ ...high, status: 'Closed' }, NOW), false);
    assert.equal(ageDays({ status: 'Closed', createdAt: daysAgo(10), closedAt: daysAgo(4) }, NOW), 6, 'closed: until it was closed');
    assert.equal(ageDays({ status: 'Open', date: '2026-11-10' }, NOW), 3, 'old issues: from the reported date');
    assert.equal(ageDays({ status: 'Open' }, NOW), null);
    assert.equal(isOverdue({ status: 'Open', urgency: 'H' }, NOW), false, 'unknown start: not overdue');
    assert.equal(closedRecently({ closedAt: daysAgo(29) }, NOW), true);
    assert.equal(closedRecently({ closedAt: daysAgo(31) }, NOW), false);
});

test('filters and sorting', () => {
    const issues = [
        { id: 'a', deviceName: 'SRV01', sn: 'SNA', datacenter: 'DC1', urgency: 'H', status: 'Open', date: '2026-11-01', createdAt: daysAgo(12), failedParts: 'PSU', reporter: 'alice' },
        { id: 'b', deviceName: 'SRV02', sn: 'SNB', datacenter: 'DC2', urgency: 'L', status: 'Closed', date: '2026-11-05', createdAt: daysAgo(8), closedAt: daysAgo(1), failedParts: 'Fan', assignee: 'bob', rmaNumber: 'RMA-9' },
        { id: 'c', deviceName: 'db-03', sn: 'SNC', datacenter: 'DC1', urgency: 'M', status: 'Processing', date: '2026-11-12', createdAt: daysAgo(1), failedParts: 'Disk' },
    ];
    const ids = (l) => l.map(i => i.id);
    assert.deepEqual(ids(filterIssues(issues, { dc: 'DC1' }, NOW)), ['a', 'c']);
    assert.deepEqual(ids(filterIssues(issues, { q: 'rma-9' }, NOW)), ['b'], 'RMA number');
    assert.deepEqual(ids(filterIssues(issues, { q: 'BOB' }, NOW)), ['b'], 'assignee, any case');
    assert.deepEqual(ids(filterIssues(issues, { q: 'disk', status: 'ALL', urgency: 'ALL' }, NOW)), ['c']);
    assert.deepEqual(ids(filterIssues(issues, { from: '2026-11-02', to: '2026-11-12' }, NOW)), ['b', 'c']);
    assert.deepEqual(ids(filterIssues(issues, { overdueOnly: true }, NOW)), ['a']);
    assert.deepEqual(ids(sortIssues(issues, 'urgency', 'asc', NOW)), ['a', 'c', 'b']);
    assert.deepEqual(ids(sortIssues(issues, 'age', 'desc', NOW)), ['a', 'b', 'c']);
    assert.deepEqual(ids(sortIssues(issues, 'date', 'desc', NOW)), ['c', 'b', 'a']);
    assert.deepEqual(ids(sortIssues(issues, 'deviceName', 'asc', NOW)), ['c', 'a', 'b']);
});

test('figures: open by urgency, overdue, closed in 30 days, average days to close, active per data center', () => {
    const issues = [
        { status: 'Open', urgency: 'H', createdAt: daysAgo(5), datacenter: 'DC1' },
        { status: 'Open', urgency: 'L', createdAt: daysAgo(1), datacenter: 'DC1' },
        { status: 'Processing', urgency: 'M', createdAt: daysAgo(9), datacenter: 'DC2' },
        { status: 'Closed', urgency: 'M', createdAt: daysAgo(10), closedAt: daysAgo(6), datacenter: 'DC2' },
        { status: 'Closed', urgency: 'H', createdAt: daysAgo(70), closedAt: daysAgo(60), datacenter: 'DC1' },
        { status: 'Closed', urgency: 'H', date: '2025-01-01' },
    ];
    const k = issueKpis(issues, NOW);
    assert.equal(k.open, 2);
    assert.deepEqual(k.openByUrgency, { H: 1, M: 0, L: 1 });
    assert.equal(k.processing, 1);
    assert.equal(k.overdue, 2, 'the High one (5 > 2 days) and the Medium one (9 > 7)');
    assert.equal(k.closed30, 1);
    assert.equal(k.avgDaysToClose, 7, '(4 + 10) / 2');
    assert.equal(k.closedCounted, 2);
    assert.deepEqual(k.activeByDc, [['DC1', 2], ['DC2', 1]]);
    assert.equal(issueKpis([], NOW).avgDaysToClose, null);
});

test('warranty by linked device or serial number; spare parts used with their names', () => {
    const contracts = [
        { id: 'w1', type: 'Hardware Warranties', serialNumber: ' sna ', endDate: '2026-12-31' },
        { id: 'w2', type: 'Hardware Warranties', linkedDevices: ['dev-1'], endDate: '2027-06-30' },
        { id: 'w3', type: 'Hardware Warranties', serialNumber: 'SNX', endDate: '2026-01-01' },
        { id: 's1', type: 'Software Licenses', serialNumber: 'SNA', endDate: '2030-01-01' },
    ];
    const w = warrantyFor({ sn: 'SNA', deviceId: 'dev-1' }, contracts, NOW);
    assert.equal(w.contract.id, 'w2', 'the longest-running match');
    assert.equal(w.active, true);
    assert.equal(warrantyFor({ sn: 'SNA' }, contracts, NOW).contract.id, 'w1');
    const expired = warrantyFor({ sn: 'snx' }, contracts, NOW);
    assert.equal(expired.active, false);
    assert.ok(expired.daysLeft < 0);
    assert.equal(warrantyFor({ sn: 'NONE' }, contracts, NOW), null);
    assert.equal(warrantyFor({ sn: 'SNA' }, [{ ...contracts[0], deletedAt: '2026-01-01T00:00:00Z' }], NOW), null, 'a trashed contract is not a warranty');
    assert.equal(warrantyFor({ sn: '' }, [{ type: 'Hardware Warranties', serialNumber: '' }], NOW), null, 'empty serials never match');

    const used = sparePartsUsed({ sparePartUsages: [{ partId: 'p1', qty: 2, at: 't', user: 'bob' }, { partId: 'gone', qty: 1 }, { partId: 'gone2', partName: 'PSU 800W', qty: 1 }] }, [{ id: 'p1', name: 'Fan X', category: 'Fan' }]);
    assert.deepEqual(used.map(u => [u.name, u.qty]), [['Fan X', 2], ['(removed part gone)', 1], ['PSU 800W (deleted)', 1]]);
    assert.deepEqual(sparePartsUsed({}, []), []);
});
