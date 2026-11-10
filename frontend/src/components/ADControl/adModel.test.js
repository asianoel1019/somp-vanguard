import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, batchPreview, buildOuTree, ouPath, filterRows, formatAdDate } from './adModel.js';

test('CSV: quoting and formula-looking text neutralised', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('-1+2'), "'-1+2");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(false), 'false');
    const csv = toCsv([{ a: 'x', b: 1 }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', value: r => r.b + 1 }]);
    assert.equal(csv, '﻿A,B\r\nx,2\r\n');
});

test('batch preview leaves out accounts already in the target state', () => {
    const users = [
        { SamAccountName: 'a', Enabled: true, LockedOut: true },
        { SamAccountName: 'b', Enabled: false, LockedOut: false },
        { SamAccountName: 'c', Enabled: true, LockedOut: false },
    ];
    const sel = new Set(['a', 'b']);
    assert.deepEqual(batchPreview(users, sel, 'unlock').change.map(u => u.SamAccountName), ['a']);
    assert.deepEqual(batchPreview(users, sel, 'enable').change.map(u => u.SamAccountName), ['b']);
    const dis = batchPreview(users, sel, 'disable');
    assert.deepEqual([dis.change.map(u => u.SamAccountName), dis.unchanged.map(u => u.SamAccountName)], [['a'], ['b']]);
    const withAdmin = batchPreview([...users, { SamAccountName: 'adm', Enabled: true, LockedOut: true, Protected: true }], new Set(['a', 'adm']), 'unlock');
    assert.deepEqual([withAdmin.change.map(u => u.SamAccountName), withAdmin.protected.map(u => u.SamAccountName)], [['a'], ['adm']]);
});

test('OU tree: containers before OUs, orphans under the domain, paths', () => {
    const t = buildOuTree({
        domain: { dn: 'DC=example,DC=test', name: 'example.test' },
        nodes: [
            { dn: 'OU=Zeta,DC=example,DC=test', name: 'Zeta', kind: 'ou', parentDn: 'DC=example,DC=test' },
            { dn: 'CN=Users,DC=example,DC=test', name: 'Users', kind: 'container', parentDn: 'DC=example,DC=test' },
            { dn: 'OU=Alpha,DC=example,DC=test', name: 'Alpha', kind: 'ou', parentDn: 'DC=example,DC=test' },
            { dn: 'OU=Kid,OU=Gone,DC=example,DC=test', name: 'Kid', kind: 'ou', parentDn: 'OU=Gone,DC=example,DC=test' },
            { dn: 'OU=Sub,OU=Alpha,DC=example,DC=test', name: 'Sub', kind: 'ou', parentDn: 'OU=Alpha,DC=example,DC=test' },
        ],
    });
    assert.deepEqual(t.root.children.map(c => c.name), ['Users', 'Alpha', 'Kid', 'Zeta']);
    assert.equal(ouPath(t.byDn.get('ou=sub,ou=alpha,dc=example,dc=test')), 'example.test/Alpha/Sub');
});

test('filter and dates', () => {
    const rows = [{ Name: 'Alice', Description: 'Sales' }, { Name: 'Bob', Description: '' }];
    assert.deepEqual(filterRows(rows, 'sal', ['Name', 'Description']).map(r => r.Name), ['Alice']);
    assert.equal(filterRows(rows, '  ', ['Name']).length, 2);
    assert.equal(formatAdDate(''), '');
    assert.equal(formatAdDate(null), '');
    assert.equal(formatAdDate('/Date(0)/'), new Date(0).toLocaleString());
    assert.equal(formatAdDate('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z').toLocaleString());
});
