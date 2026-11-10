const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGpLink, blocksInheritance, parentDn, isContainerDn, parseWmiQueries, shapeTree } = require('../../lib/gpoModel');

const G1 = '31B2F340-016D-11D2-945F-00C04FB984F9';
const G2 = '6AC1786C-016F-11D2-945F-00C04FB984F9';
const link = (g, opt) => `[LDAP://cn={${g}},cn=policies,cn=system,DC=example,DC=test;${opt}]`;

test('gPLink: the last entry is link order 1; option bits give disabled and enforced', () => {
    assert.deepEqual(parseGpLink(link(G1, 0) + link(G2, 3)), [
        { guid: G2.toLowerCase(), enabled: false, enforced: true, order: 1 },
        { guid: G1.toLowerCase(), enabled: true, enforced: false, order: 2 },
    ]);
    assert.deepEqual(parseGpLink(link(G1, 2)), [{ guid: G1.toLowerCase(), enabled: true, enforced: true, order: 1 }]);
    assert.deepEqual(parseGpLink(''), []);
    assert.deepEqual(parseGpLink(' '), []);
    assert.deepEqual(parseGpLink('[LDAP://cn=bogus;0]'), []);
});

test('gPOptions 1 blocks inheritance', () => {
    assert.equal(blocksInheritance('1'), true);
    assert.equal(blocksInheritance('0'), false);
    assert.equal(blocksInheritance(''), false);
});

test('parentDn keeps escaped commas inside a part', () => {
    assert.equal(parentDn('OU=Kiosk,OU=Workstations,DC=example,DC=test'), 'OU=Workstations,DC=example,DC=test');
    assert.equal(parentDn('OU=Sales\\, East,DC=example,DC=test'), 'DC=example,DC=test');
    assert.equal(parentDn('DC=test'), '');
});

test('WMI queries are read by length, so a ";" inside a query stays in it', () => {
    const q1 = "SELECT * FROM Win32_OperatingSystem WHERE Caption LIKE '%;%'";
    const q2 = 'SELECT * FROM Win32_ComputerSystem';
    const ns = 'root\\CIMv2';
    const parm2 = `2;3;${ns.length};${q1.length};WQL;${ns};${q1};3;${ns.length};${q2.length};WQL;${ns};${q2};`;
    assert.deepEqual(parseWmiQueries(parm2), [
        { language: 'WQL', namespace: ns, query: q1 },
        { language: 'WQL', namespace: ns, query: q2 },
    ]);
    assert.deepEqual(parseWmiQueries('garbage'), [{ language: '', namespace: '', query: 'garbage' }]);
    assert.deepEqual(parseWmiQueries(''), []);
});

test('shapeTree: links parsed, parents found, GPO ids normalised, OUs bounded', () => {
    const t = shapeTree({
        domain: { dn: 'DC=example,DC=test', dns: 'example.test', gPLink: link(G1, 0), gPOptions: '' },
        ous: [
            { dn: 'OU=A,DC=example,DC=test', name: 'A', gPLink: '', gPOptions: '1' },
            { dn: 'OU=B,OU=A,DC=example,DC=test', name: 'B', gPLink: link(G2, 2), gPOptions: '0' },
            { dn: 'OU=C,DC=example,DC=test', name: 'C' },
        ],
        gpos: { id: `{${G1}}`, name: 'Default Domain Policy', status: 'AllSettingsEnabled', wmi: '', created: 'x', modified: 'y' },
    }, 2);
    assert.equal(t.domain.name, 'example.test');
    assert.equal(t.domain.links[0].guid, G1.toLowerCase());
    assert.equal(t.ous.length, 2);
    assert.equal(t.truncated, true);
    assert.equal(t.ous[0].blockInheritance, true);
    assert.equal(t.ous[1].parentDn, 'OU=A,DC=example,DC=test');
    assert.equal(t.ous[1].links[0].enforced, true);
    assert.equal(t.gpos[0].id, G1.toLowerCase());
});

test('isContainerDn: only the domain root or an OU', () => {
    assert.equal(isContainerDn('DC=example,DC=test'), true);
    assert.equal(isContainerDn('OU=Kiosk,OU=Workstations,DC=example,DC=test'), true);
    assert.equal(isContainerDn('OU=Sales\\, East,DC=example,DC=test'), true);
    assert.equal(isContainerDn('CN=Users,DC=example,DC=test'), false, 'containers cannot take links');
    assert.equal(isContainerDn('OU=A'), false, 'needs the domain part');
    assert.equal(isContainerDn('DC=example,OU=A,DC=test'), false, 'OU after DC');
    assert.equal(isContainerDn('OU=,DC=example,DC=test'), false);
    assert.equal(isContainerDn('OU=A\nB,DC=example,DC=test'), false);
    assert.equal(isContainerDn(''), false);
    assert.equal(isContainerDn(`OU=${'a'.repeat(2050)},DC=test`), false);
});
