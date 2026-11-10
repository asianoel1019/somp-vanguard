const test = require('node:test');
const assert = require('node:assert/strict');
const { managedOus, splitDns, guardRefusal } = require('../../lib/adGuard');

test('managed OUs: AD_MANAGE_OUS first, else every AD_OU_* value, else the whole domain', () => {
    assert.deepEqual(managedOus({ AD_MANAGE_OUS: ' OU=Staff,DC=example,DC=test ; CN=Users,DC=example,DC=test ', AD_OU_X: 'OU=Other,DC=example,DC=test' }),
        { dns: ['OU=Staff,DC=example,DC=test', 'CN=Users,DC=example,DC=test'], source: 'AD_MANAGE_OUS' });
    assert.deepEqual(managedOus({ AD_OU_Co_A: 'OU=A,DC=example,DC=test', AD_OU_SEARCH: 'OU=Staff,DC=example,DC=test', AD_OU_Co_B: 'OU=A,DC=example,DC=test', AD_OU_BAD: 'nonsense' }),
        { dns: ['OU=A,DC=example,DC=test', 'OU=Staff,DC=example,DC=test'], source: 'AD_OU_*' });
    assert.deepEqual(managedOus({}), { dns: [], source: 'domain' });
    assert.throws(() => managedOus({ AD_MANAGE_OUS: 'OU=Staff,DC=example,DC=test;Staff' }), /not an OU distinguished name/);
});

test('splitDns keeps an escaped ;', () => {
    assert.deepEqual(splitDns('OU=A\\;B,DC=x;OU=C,DC=x;;'), ['OU=A\\;B,DC=x', 'OU=C,DC=x']);
});

test('guard refusals become 403 with the readable sentence only', () => {
    assert.deepEqual(guardRefusal('Get-ManagedUser : OUTSIDE_MANAGED_OUS: eve is outside the OUs AD Control manages\nAt line:1'),
        { status: 403, error: 'eve is outside the OUs AD Control manages' });
    assert.equal(guardRefusal('Cannot find an object with identity'), null);
    assert.equal(guardRefusal(undefined), null);
});
