import test from 'node:test';
import assert from 'node:assert/strict';
import { SPARE_CATALOG, DEFAULT_CATEGORIES, searchCatalog, catalogCounts } from './sparePartCatalog.js';
import {
    stockStatus, needsRestock, suggestedOrder, lowStockItems, usedWithin, spareKpis, filterSpares, sortSpares, valuesOf,
    categoryCounts, parseSerials, spareFromCatalog, spareEditDraft, spareBody, spareFormProblem, issuesUsing, monthlyUsage,
    sparesCsv, reorderCsv, moneyText,
} from './sparePartUtils.js';

const NOW = new Date(2026, 10, 13, 12, 0).getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('catalog: every entry in a default category, with a spec and a minimum; unique names per category', () => {
    assert.ok(SPARE_CATALOG.length >= 140, `${SPARE_CATALOG.length} entries`);
    const seen = new Set();
    for (const e of SPARE_CATALOG) {
        assert.ok(DEFAULT_CATEGORIES.includes(e.category), e.category);
        assert.ok(e.name && e.spec && e.minStock >= 1, e.name);
        const key = `${e.category}|${e.name}`;
        assert.ok(!seen.has(key), `duplicate ${key}`);
        seen.add(key);
    }
    const counts = catalogCounts();
    for (const c of DEFAULT_CATEGORIES) assert.ok(counts[c] >= 5, `${c} has ${counts[c]}`);
    assert.ok(searchCatalog('Transceiver', 'sfp28 sr').some(e => e.name === 'SFP28 25G SR'));
    assert.ok(searchCatalog('ALL', 'ddr5 64gb').every(e => e.category === 'Memory'));
    assert.ok(searchCatalog('Cable', 'cat6 50cm').length >= 1);
});

test('stock status and restock: at or below the minimum is low; none left is out', () => {
    assert.equal(stockStatus({ quantity: 0, minStock: 0 }), 'Out');
    assert.equal(stockStatus({ quantity: 2, minStock: 2 }), 'Low');
    assert.equal(stockStatus({ quantity: 3, minStock: 2 }), 'OK');
    assert.equal(needsRestock({ quantity: 0, minStock: 0 }), false);
    assert.equal(suggestedOrder({ quantity: 1, minStock: 3 }), 5);
    assert.equal(suggestedOrder({ quantity: 1, minStock: 3, reorderQty: 10 }), 10);
    assert.equal(suggestedOrder({ quantity: 9, minStock: 3 }), 0);
    assert.deepEqual(lowStockItems([{ name: 'b', quantity: 2, minStock: 2 }, { name: 'a', quantity: 0, minStock: 1 }, { name: 'c', quantity: 5, minStock: 1 }]).map(i => i.name), ['a', 'b']);
});

test('figures: units, alerts, value per currency, use in the last 30 days', () => {
    const items = [
        { quantity: 2, minStock: 2, unitPrice: 100, currency: 'USD', history: [{ type: 'OUT', qty: 3, date: daysAgo(5) }, { type: 'OUT', qty: 9, date: daysAgo(40) }, { type: 'IN', qty: 1, date: daysAgo(1) }] },
        { quantity: 0, minStock: 1, unitPrice: 50 },
        { quantity: 10, minStock: 0, unitPrice: '30', currency: 'TWD' },
    ];
    const k = spareKpis(items, NOW);
    assert.deepEqual([k.parts, k.units, k.low, k.out, k.restock, k.used30], [3, 12, 1, 1, 2, 3]);
    assert.equal(moneyText(k.value), 'TWD 300 · USD 200');
    assert.equal(usedWithin(items[0], 60, NOW), 12);
});

test('filter and sort: category, status incl. restock, vendor, location, words across fields and serials', () => {
    const items = [
        { id: 1, name: 'SFP+ 10G SR', category: 'Transceiver', vendor: 'Cisco', location: 'Cage A', quantity: 10, minStock: 4, unitPrice: 1, history: [{ date: daysAgo(9) }] },
        { id: 2, name: '32GB DDR4-3200 RDIMM', category: 'Memory', vendor: 'Dell', location: 'Cage B', quantity: 1, minStock: 2, unitPrice: 100, compatibleWith: 'R650', serials: ['MEM-77'], history: [{ date: daysAgo(1) }] },
        { id: 3, name: 'Server PSU 800W', category: 'Power Supply', vendor: 'Dell', location: 'Cage A', quantity: 0, minStock: 0 },
    ];
    assert.deepEqual(filterSpares(items, { category: 'Memory' }).map(i => i.id), [2]);
    assert.deepEqual(filterSpares(items, { status: 'RESTOCK' }).map(i => i.id), [2]);
    assert.deepEqual(filterSpares(items, { status: 'Out' }).map(i => i.id), [3]);
    assert.deepEqual(filterSpares(items, { vendor: 'Dell', location: 'Cage A' }).map(i => i.id), [3]);
    assert.deepEqual(filterSpares(items, { q: 'r650 ddr4' }).map(i => i.id), [2]);
    assert.deepEqual(filterSpares(items, { q: 'mem-77' }).map(i => i.id), [2]);
    assert.deepEqual(sortSpares(items, 'restock').map(i => i.id), [2, 3, 1]);
    assert.deepEqual(sortSpares(items, 'value').map(i => i.id), [2, 1, 3]);
    assert.deepEqual(sortSpares(items, 'moved').map(i => i.id), [2, 1, 3]);
    assert.deepEqual(valuesOf(items, 'location'), ['Cage A', 'Cage B']);
    assert.deepEqual(categoryCounts(['Memory', 'SSD'], items).map(c => [c.name, c.parts, c.alerts, !!c.unlisted]),
        [['Memory', 1, 1, false], ['SSD', 0, 0, false], ['Transceiver', 1, 0, true], ['Power Supply', 1, 0, true]]);
});

test('forms: from the catalog, edit draft, request body, checks; serial text', () => {
    assert.deepEqual(parseSerials('A1, B2\nA1;;C3 '), ['A1', 'B2', 'C3']);
    const f = spareFromCatalog(SPARE_CATALOG[0], { vendor: 'Dell' });
    assert.equal(f.category, 'Memory');
    assert.equal(f.vendor, 'Dell');
    assert.equal(spareFormProblem({ ...f, quantity: 1, serialsText: 'a,b' }), '2 serial numbers for 1 part(s).');
    assert.equal(spareFormProblem({ ...f, minStock: 1.5 }), 'minStock must be a whole number of 0 or more.');
    assert.equal(spareFormProblem({ ...f, name: ' ' }), 'Enter a name.');
    assert.equal(spareFormProblem({ ...f, quantity: 2, serialsText: 'a,b' }), '');
    const body = spareBody({ ...f, quantity: '2', serialsText: 'a, b', name: ' X ' }, { create: true });
    assert.deepEqual([body.name, body.quantity, body.serials], ['X', 2, ['a', 'b']]);
    const e = spareEditDraft({ id: 'p1', name: 'N', category: 'Fan', quantity: 9, history: [1], updatedAt: 'T', vendor: null });
    assert.deepEqual([e.id, e.expectedUpdatedAt, e.vendor, 'history' in e], ['p1', 'T', '', false]);
    const upd = spareBody(e, { create: false });
    assert.equal(upd.expectedUpdatedAt, 'T');
    assert.ok(!('quantity' in upd));
});

test('usage: issues that used the part and the monthly totals', () => {
    const issues = [
        { id: 'h1', sparePartUsages: [{ partId: 'p1', qty: 1, at: '2026-10-01T00:00:00Z' }, { partId: 'p2', qty: 4 }] },
        { id: 'h2', sparePartUsages: [{ partId: 'p1', qty: 2, at: '2026-11-01T00:00:00Z' }] },
    ];
    assert.deepEqual(issuesUsing({ id: 'p1' }, issues).map(u => [u.issue.id, u.qty]), [['h2', 2], ['h1', 1]]);
    const m = monthlyUsage({ history: [{ type: 'OUT', qty: 2, date: new Date(2026, 10, 2).toISOString() }, { type: 'OUT', qty: 1, date: new Date(2026, 9, 20).toISOString() }, { type: 'IN', qty: 5, date: new Date(2026, 10, 3).toISOString() }] }, 3, NOW);
    assert.deepEqual(m, [{ label: '2026-09', qty: 0 }, { label: '2026-10', qty: 1 }, { label: '2026-11', qty: 2 }]);
});

test('CSV: inventory and the reorder list', () => {
    const items = [{ category: 'Memory', name: '=X', quantity: 1, minStock: 2, unitPrice: 10, currency: 'USD', serials: ['S1', 'S2'] }, { category: 'Fan', name: 'ok', quantity: 9, minStock: 1 }];
    const inv = sparesCsv(items, NOW).split('\r\n');
    assert.equal(inv.length, 3);
    assert.match(inv[1], /"'=X"/);
    assert.match(inv[1], /"Low"/);
    assert.match(inv[1], /"S1; S2"/);
    const re = reorderCsv(items).split('\r\n');
    assert.equal(re.length, 2);
    assert.match(re[1], /"'=X","","","","1","2","3","10","USD","30"/);
});
