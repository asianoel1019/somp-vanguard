import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGpmcTree, canonicalPath, linkedGpos, inheritance, gpoLocations, securityFiltering, delegationRows } from './gpmcModel.js';

const DOM = 'DC=example,DC=test';
const link = (guid, order, extra = {}) => ({ guid, order, enabled: true, enforced: false, ...extra });
const data = {
    domain: { dn: DOM, name: 'example.test', links: [link('ddp', 1), link('dom-enf', 2, { enforced: true })], blockInheritance: false },
    ous: [
        { dn: `OU=Workstations,${DOM}`, name: 'Workstations', parentDn: DOM, links: [link('ws-base', 1, { enforced: true }), link('ws-off', 2, { enabled: false })], blockInheritance: false },
        { dn: `OU=Kiosk,OU=Workstations,${DOM}`, name: 'Kiosk', parentDn: `OU=Workstations,${DOM}`, links: [link('kiosk', 1), link('kiosk-2', 2)], blockInheritance: true },
        { dn: `OU=Orphan,OU=Gone,${DOM}`, name: 'Orphan', parentDn: `OU=Gone,${DOM}`, links: [], blockInheritance: false },
        { dn: `OU=Apps,${DOM}`, name: 'Apps', parentDn: DOM, links: [link('kiosk', 1)], blockInheritance: false },
    ],
    gpos: ['ddp', 'dom-enf', 'ws-base', 'ws-off', 'kiosk', 'kiosk-2'].map(id => ({ id, name: `GPO ${id}`, status: 'AllSettingsEnabled', wmiFilter: '' })),
};

test('tree: OUs under their parents, sorted; an OU without a read parent hangs off the domain', () => {
    const t = buildGpmcTree(data);
    assert.deepEqual(t.root.children.map(c => c.name), ['Apps', 'Orphan', 'Workstations']);
    const kiosk = t.byDn.get(`ou=kiosk,ou=workstations,${DOM}`.toLowerCase());
    assert.equal(canonicalPath(kiosk), 'example.test/Workstations/Kiosk');
});

test('linked GPOs come in link order and name a missing GPO', () => {
    const t = buildGpmcTree({ ...data, gpos: [] });
    assert.deepEqual(linkedGpos(t.root, t.gpoById).map(l => [l.order, l.name]), [[1, '(GPO not found)'], [2, '(GPO not found)']]);
});

test('inheritance: block stops parents, enforced passes through and the highest container wins', () => {
    const t = buildGpmcTree(data);
    const kiosk = t.byDn.get(`ou=kiosk,ou=workstations,${DOM}`.toLowerCase());
    assert.deepEqual(inheritance(kiosk, t.gpoById).map(e => [e.precedence, e.guid, e.location]), [
        [1, 'dom-enf', 'example.test'],
        [2, 'ws-base', 'Workstations'],
        [3, 'kiosk', 'Kiosk'],
        [4, 'kiosk-2', 'Kiosk'],
    ]);
    const ws = t.byDn.get(`ou=workstations,${DOM}`.toLowerCase());
    // the disabled link never applies; the domain's normal link follows the OU's own
    assert.deepEqual(inheritance(ws, t.gpoById).map(e => e.guid), ['dom-enf', 'ws-base', 'ddp']);
});

test('a GPO lists every place it is linked', () => {
    const t = buildGpmcTree(data);
    assert.deepEqual(gpoLocations('kiosk', t).map(l => l.path), ['example.test/Apps', 'example.test/Workstations/Kiosk']);
});

test('security filtering keeps allowed Apply entries; delegation labels permissions', () => {
    const perms = [
        { trustee: 'Authenticated Users', domain: 'NT AUTHORITY', permission: 'GpoApply', inherited: false, denied: false },
        { trustee: 'Kiosk Admins', domain: 'EXAMPLE', permission: 'GpoEdit', inherited: false, denied: false },
        { trustee: 'Guests', domain: 'EXAMPLE', permission: 'GpoApply', inherited: false, denied: true },
    ];
    assert.deepEqual(securityFiltering(perms).map(p => p.name), ['NT AUTHORITY\\Authenticated Users']);
    assert.deepEqual(delegationRows(perms).map(r => r.allowed), ['Deny: Read (from Security Filtering)', 'Edit settings', 'Read (from Security Filtering)']);
});
