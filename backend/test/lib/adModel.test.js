const test = require('node:test');
const assert = require('node:assert/strict');
const { rdnValue, groupNames, isBrowsableDn, fileTimeToIso, newestLogon, shapeOuTree, dnParts } = require('../../lib/adModel');

test('group names: escaped commas, plus signs and hex escapes stay inside the name', () => {
    assert.equal(rdnValue('CN=Sales\\, East,OU=Groups,DC=example,DC=test'), 'Sales, East');
    assert.equal(rdnValue('CN=R\\+D,DC=example,DC=test'), 'R+D');
    assert.equal(rdnValue('CN=\\23Ops,DC=example,DC=test'), '#Ops');
    assert.equal(rdnValue('CN=\\E5\\8F\\B0\\E5\\8C\\97,DC=example,DC=test'), '台北');
    assert.equal(rdnValue('CN=Back\\\\slash,DC=x'), 'Back\\slash');
    assert.deepEqual(groupNames(['CN=b,DC=x', 'CN=Sales\\, East,DC=x', 'CN=a,DC=x']), ['a', 'b', 'Sales, East']);
    assert.deepEqual(groupNames('CN=Only,DC=x'), ['Only']);
    assert.deepEqual(groupNames(null), []);
    assert.deepEqual(dnParts('CN=Doe\\, John,OU=A,DC=x'), ['CN=Doe\\, John', 'OU=A', 'DC=x']);
});

test('browsable DNs: OU / CN parts over DC parts only', () => {
    assert.ok(isBrowsableDn('DC=example,DC=test'));
    assert.ok(isBrowsableDn('CN=Users,DC=example,DC=test'));
    assert.ok(isBrowsableDn('OU=Kiosk,OU=Workstations,DC=example,DC=test'));
    assert.ok(!isBrowsableDn('OU=A'));
    assert.ok(!isBrowsableDn('L=Taipei,DC=example,DC=test'));
    assert.ok(!isBrowsableDn('DC=x,OU=A,DC=y'));
    assert.ok(!isBrowsableDn("OU=x'\n,DC=y"));
});

test('file times: 0 and never are empty; a real one converts to UTC', () => {
    assert.equal(fileTimeToIso('0'), '');
    assert.equal(fileTimeToIso('9223372036854775807'), '');
    assert.equal(fileTimeToIso(''), '');
    assert.equal(fileTimeToIso('133801632000000000'), '2025-01-01T00:00:00.000Z');
});

test('newest logon over the DCs; unreachable DCs are listed', () => {
    const r = newestLogon([
        { dc: 'dc01.example.test', lastLogon: '133801632000000000' },
        { dc: 'dc02.example.test', lastLogon: '133801668000000000' },
        { dc: 'dc03.example.test', lastLogon: '0' },
        { dc: 'dc04.example.test', lastLogon: '', error: 'unreachable' },
    ]);
    assert.deepEqual(r, { lastLogon: '2025-01-01T01:00:00.000Z', dc: 'dc02.example.test', checked: 3, failed: ['dc04.example.test'] });
    assert.deepEqual(newestLogon([]), { lastLogon: '', dc: '', checked: 0, failed: [] });
});

test('OU tree: containers and OUs with their parents; OUs bounded', () => {
    const t = shapeOuTree({
        dn: 'DC=example,DC=test', name: 'example.test',
        containers: { dn: 'CN=Users,DC=example,DC=test', name: 'Users' },
        ous: [
            { dn: 'OU=A,DC=example,DC=test', name: 'A' },
            { dn: 'OU=B\\, b,OU=A,DC=example,DC=test', name: 'B, b' },
            { dn: 'OU=C,DC=example,DC=test', name: 'C' },
        ],
    }, 2);
    assert.equal(t.domain.name, 'example.test');
    assert.deepEqual(t.nodes.map(n => [n.kind, n.name, n.parentDn]), [
        ['container', 'Users', 'DC=example,DC=test'],
        ['ou', 'A', 'DC=example,DC=test'],
        ['ou', 'B, b', 'OU=A,DC=example,DC=test'],
    ]);
    assert.equal(t.truncated, true);
});
