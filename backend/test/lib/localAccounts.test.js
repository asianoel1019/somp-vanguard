require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDataSync } = require('../../lib/db');
const la = require('../../lib/localAccounts');
const { setPaid, setFree } = require('../helpers/license');

const PW = 'Correct-horse-42';
test.beforeEach(() => { setPaid(); la._resetForTest(); });
test.after(() => { setPaid(); for (const k of ['LOCAL_OPERATOR_USER', 'LOCAL_OPERATOR_PWD', 'LOCAL_VIEWER_USER', 'LOCAL_VIEWER_PWD']) delete process.env[k]; });

const errOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('hash and verify', () => {
    const h = la.hashPassword(PW);
    assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.notEqual(la.hashPassword(PW), h); // random salt
    assert.equal(la.verifyPassword(PW, h), true);
    assert.equal(la.verifyPassword('wrong-password-1', h), false);
    assert.equal(la.verifyPassword(PW, 'garbage'), false);
    assert.equal(la.verifyPassword(PW, ''), false);
});

test('username and password rules', () => {
    assert.equal(la.validateUsername('ops.team_1-a'), '');
    assert.notEqual(la.validateUsername(''), '');
    assert.notEqual(la.validateUsername('has space'), '');
    assert.notEqual(la.validateUsername('x'.repeat(65)), '');
    assert.notEqual(la.validateUsername('ADMIN'), ''); // break-glass name (setupEnv: LOCAL_ADMIN_USER=admin)
    assert.equal(la.validatePassword(PW), '');
    assert.notEqual(la.validatePassword('short1A'), '');
    assert.notEqual(la.validatePassword('onlyletterslong'), '');
    assert.notEqual(la.validatePassword('123456789012'), '');
});

test('create stores a hash, never the password, encrypted at rest', () => {
    const a = la.createAccount({ username: 'Ops1', role: 'Operator', password: PW }, 'admin');
    assert.equal(a.username, 'Ops1');
    assert.equal(a.createdEdition, 'paid');
    assert.equal(a.active, true);
    assert.equal('passwordHash' in a, false);
    const raw = readDataSync(la.KEY, null);
    assert.equal(typeof raw, 'string');
    assert.equal(raw.includes('Ops1'), false); // encrypted
    assert.equal(raw.includes(PW), false);
    assert.equal(la.findAccount('ops1').role, 'Operator');
});

test('create rejects duplicates, bad roles, bad input', () => {
    la.createAccount({ username: 'dup', role: 'Viewer', password: PW }, 'admin');
    assert.equal(errOf(() => la.createAccount({ username: 'DUP', role: 'Viewer', password: PW }, 'admin')).status, 409);
    assert.equal(errOf(() => la.createAccount({ username: 'r1', role: 'None', password: PW }, 'admin')).status, 400);
    assert.equal(errOf(() => la.createAccount({ username: 'r2', role: 'Viewer', password: 'weak' }, 'admin')).status, 400);
    assert.equal(errOf(() => la.createAccount({ username: 'admin', role: 'Viewer', password: PW }, 'admin')).status, 400);
});

test('free edition: one per role, paid-created accounts inactive and outside the quota', () => {
    la.createAccount({ username: 'paidop', role: 'Operator', password: PW }, 'admin');
    setFree();
    assert.deepEqual(la.accountStatus(la.findAccount('paidop')), { active: false, inactiveReason: 'free edition' });
    const freeOp = la.createAccount({ username: 'freeop', role: 'Operator', password: PW }, 'admin');
    assert.equal(freeOp.createdEdition, 'free');
    const e = errOf(() => la.createAccount({ username: 'freeop2', role: 'Operator', password: PW }, 'admin'));
    assert.equal(e.status, 403);
    assert.equal(e.code, 'LICENSE_REQUIRED');
    assert.equal(e.message, la.QUOTA_MESSAGE);
    const l = la.listAccounts();
    assert.deepEqual(l.quota.Operator, { used: 1, limit: 1 });
    assert.deepEqual(l.quota.Viewer, { used: 0, limit: 1 });
    assert.equal(l.edition, 'free');
    assert.equal(l.breakGlass.username, 'admin');
    setPaid();
    assert.equal(la.accountStatus(la.findAccount('paidop')).active, true);
    assert.equal(la.listAccounts().quota.Operator.limit, null);
});

test('free edition: re-enable and role change respect the quota; paid-created accounts cannot be revived', () => {
    la.createAccount({ username: 'paidv', role: 'Viewer', password: PW }, 'admin');
    setFree();
    la.createAccount({ username: 'fv1', role: 'Viewer', password: PW }, 'admin');
    la.createAccount({ username: 'fo1', role: 'Operator', password: PW }, 'admin');
    assert.equal(errOf(() => la.updateAccount('fo1', { role: 'Viewer' }, 'admin')).code, 'LICENSE_REQUIRED');
    la.updateAccount('fv1', { disabled: true }, 'admin');
    la.updateAccount('fo1', { role: 'Viewer' }, 'admin'); // Viewer slot is free now
    assert.equal(errOf(() => la.updateAccount('fv1', { disabled: false }, 'admin')).code, 'LICENSE_REQUIRED');
    assert.equal(errOf(() => la.updateAccount('paidv', { role: 'Operator' }, 'admin')).code, 'LICENSE_REQUIRED');
    la.updateAccount('paidv', { password: 'Another-pass-99' }, 'admin'); // reset password is allowed
    la.deleteAccount('paidv', 'admin'); // delete is allowed
    assert.equal(la.findAccount('paidv'), null);
});

test('nobody disables, deletes or demotes their own account', () => {
    la.createAccount({ username: 'boss', role: 'SuperAdmin', password: PW }, 'admin');
    assert.equal(errOf(() => la.updateAccount('boss', { disabled: true }, 'BOSS')).status, 400);
    assert.equal(errOf(() => la.updateAccount('boss', { role: 'Viewer' }, 'boss')).status, 400);
    assert.equal(errOf(() => la.deleteAccount('boss', 'boss')).status, 400);
    assert.equal(errOf(() => la.deleteAccount('ghost', 'boss')).status, 404);
});

test('authenticate and sessionCheck', () => {
    la.createAccount({ username: 'v1', role: 'Viewer', password: PW }, 'admin');
    assert.equal(la.authenticate('V1', PW).ok, true);
    assert.deepEqual(la.authenticate('v1', 'Wrong-pass-123'), { ok: false, found: true });
    assert.deepEqual(la.authenticate('nobody', PW), { ok: false, found: false });
    const u = { username: 'v1', domain: 'local', role: 'SuperAdmin' };
    assert.deepEqual(la.sessionCheck(u), { ok: true, role: 'Viewer' }); // the stored role wins over the token
    assert.equal(la.localAccountRole(u), 'Viewer');
    la.updateAccount('v1', { disabled: true }, 'admin');
    assert.deepEqual(la.authenticate('v1', PW), { ok: false, found: true, code: 'ACCOUNT_INACTIVE', error: 'Account disabled.' });
    assert.deepEqual(la.sessionCheck(u), { ok: false, code: 'ACCOUNT_INACTIVE', error: 'Account disabled.' });
    assert.equal(la.localAccountRole(u), null);
    la.deleteAccount('v1', 'admin');
    assert.deepEqual(la.sessionCheck(u), { ok: false, code: 'ACCOUNT_INACTIVE', error: 'Your account no longer exists.' });
    // break-glass and AD users pass through untouched
    assert.deepEqual(la.sessionCheck({ username: 'admin', domain: 'local', role: 'SuperAdmin' }), { ok: true, role: 'SuperAdmin' });
    assert.deepEqual(la.sessionCheck({ username: 'alice', domain: 'example.test', role: 'Operator' }), { ok: true, role: 'Operator' });
    assert.equal(la.localAccountRole({ username: 'admin', domain: 'local' }), null);
});

test('paid-created account on the free edition', () => {
    la.createAccount({ username: 'p1', role: 'Operator', password: PW }, 'admin');
    setFree();
    assert.deepEqual(la.authenticate('p1', PW), { ok: false, found: true, code: 'LICENSE_REQUIRED', error: 'This account is inactive on the free edition.' });
    assert.equal(la.sessionCheck({ username: 'p1', domain: 'local' }).code, 'LICENSE_REQUIRED');
});

test('changeOwnPassword needs the current password', () => {
    la.createAccount({ username: 'me', role: 'Viewer', password: PW }, 'admin');
    assert.equal(errOf(() => la.changeOwnPassword('me', 'Wrong-pass-123', 'Brand-new-pass-1')).status, 400);
    assert.equal(errOf(() => la.changeOwnPassword('me', PW, 'weak')).status, 400);
    la.changeOwnPassword('me', PW, 'Brand-new-pass-1');
    assert.equal(la.authenticate('me', 'Brand-new-pass-1').ok, true);
});

test('migrateEnvAccounts runs once, as free-edition accounts', () => {
    process.env.LOCAL_OPERATOR_USER = 'envops'; process.env.LOCAL_OPERATOR_PWD = 'old-env-pass';
    process.env.LOCAL_VIEWER_USER = 'admin'; process.env.LOCAL_VIEWER_PWD = 'x'; // clashes with break-glass: skipped
    assert.deepEqual(la.migrateEnvAccounts().migrated, ['envops']);
    const a = la.findAccount('envops');
    assert.equal(a.createdEdition, 'free');
    assert.equal(a.createdBy, '.env');
    assert.equal(la.authenticate('envops', 'old-env-pass').ok, true);
    process.env.LOCAL_VIEWER_USER = 'envview'; process.env.LOCAL_VIEWER_PWD = 'other-pass';
    assert.deepEqual(la.migrateEnvAccounts().migrated, []); // only once
    assert.equal(la.findAccount('envview'), null);
});

test('an undecryptable document disables page accounts and is never overwritten', () => {
    const { writeDataSync } = require('../../lib/db');
    writeDataSync(la.KEY, 'not:encrypted-garbage');
    la._resetCacheForTest();
    assert.equal(la.readState().ok, false);
    assert.deepEqual(la.authenticate('anyone', PW), { ok: false, found: false, unavailable: true });
    // live page sessions get a distinct reason; the break-glass admin is unaffected
    assert.deepEqual(la.sessionCheck({ username: 'v1', domain: 'local', role: 'Viewer' }), { ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: 'Local accounts are unavailable.' });
    assert.equal(la.sessionCheck({ username: 'admin', domain: 'local', role: 'SuperAdmin' }).ok, true);
    assert.equal(errOf(() => la.createAccount({ username: 'n1', role: 'Viewer', password: PW }, 'admin')).status, 503);
    assert.equal(readDataSync(la.KEY, null), 'not:encrypted-garbage');
    assert.equal(la.migrateEnvAccounts().migrated.length, 0);
});

test('mutate refuses when the row it re-reads under the lock is undecodable (RAM copy still fine)', () => {
    const db = require('../../lib/db');
    la.createAccount({ username: 'keep1', role: 'Viewer', password: PW }, 'admin');
    const good = readDataSync(la.KEY, null);
    db.writeDataSync(la.KEY, 'not:encrypted-garbage'); // stored copy
    db.invalidateCache(la.KEY, good);                   // this process still holds the good copy
    la._resetCacheForTest();
    assert.equal(la.readState().ok, true);
    const e = errOf(() => la.createAccount({ username: 'n2', role: 'Operator', password: PW }, 'admin'));
    assert.equal(e && e.status, 503);
    assert.equal(e.code, 'ACCOUNTS_UNAVAILABLE');
    db.invalidateCache(la.KEY);
    assert.equal(readDataSync(la.KEY, null), 'not:encrypted-garbage'); // never overwritten with an empty document
});

test('updateAccountDetailed reports what changed; self password reset refused; self is local-only', () => {
    la.createAccount({ username: 'u1', role: 'Operator', password: PW }, 'admin');
    assert.deepEqual(la.updateAccountDetailed('u1', {}, 'admin').changed, { role: false, disabled: false, password: false });
    assert.deepEqual(la.updateAccountDetailed('u1', { role: 'Operator', disabled: false }, 'admin').changed, { role: false, disabled: false, password: false });
    assert.deepEqual(la.updateAccountDetailed('u1', { role: 'Viewer', disabled: true }, 'admin').changed, { role: true, disabled: true, password: false });
    la.createAccount({ username: 'boss', role: 'SuperAdmin', password: PW }, 'admin');
    const e = errOf(() => la.updateAccount('boss', { password: 'Another-pass-123' }, { username: 'BOSS', domain: 'local' }));
    assert.equal(e.status, 400);
    assert.equal(e.message, 'Use Change password to change your own password.');
    // an AD user "boss" is not the local account "boss"
    assert.equal(la.updateAccount('boss', { role: 'Viewer' }, { username: 'boss', domain: 'example.test' }).role, 'Viewer');
});

test('async hashing interoperates with the sync API; changeOwnPasswordAsync flags a wrong current password', async () => {
    const h = await la.hashPasswordAsync(PW);
    assert.equal(la.verifyPassword(PW, h), true);
    assert.equal(await la.verifyPasswordAsync(PW, la.hashPassword(PW)), true);
    assert.equal(await la.verifyPasswordAsync('wrong-password-1', h), false);
    la.createAccount({ username: 'me2', role: 'Viewer', password: PW }, 'admin');
    await assert.rejects(la.changeOwnPasswordAsync('me2', 'Wrong-pass-123', 'Brand-new-pass-1'), (err) => err.wrongPassword === true && err.status === 400);
    await assert.rejects(la.changeOwnPasswordAsync('me2', PW, 'short'), (err) => !err.wrongPassword && err.status === 400);
    await la.changeOwnPasswordAsync('me2', PW, 'Brand-new-pass-1');
    assert.equal(la.authenticate('me2', 'Brand-new-pass-1').ok, true);
});

test('break-glass name collision: old tokens of the stored account are refused, new break-glass tokens pass', () => {
    la.createAccount({ username: 'ops9', role: 'Viewer', password: PW }, 'admin');
    const prev = process.env.LOCAL_ADMIN_USER;
    process.env.LOCAL_ADMIN_USER = 'ops9';
    try {
        assert.equal(la.breakGlassCollision(), 'ops9');
        const old = la.sessionCheck({ username: 'ops9', domain: 'local', role: 'Viewer', iat: la.PROCESS_START_S - 60 });
        assert.deepEqual(old, { ok: false, code: 'ACCOUNT_INACTIVE', error: 'Your session ended: please sign in again.' });
        const fresh = la.sessionCheck({ username: 'ops9', domain: 'local', role: 'SuperAdmin', iat: Math.floor(Date.now() / 1000) });
        assert.deepEqual(fresh, { ok: true, role: 'SuperAdmin' });
    } finally {
        if (prev === undefined) delete process.env.LOCAL_ADMIN_USER; else process.env.LOCAL_ADMIN_USER = prev;
    }
    assert.equal(la.breakGlassCollision(), '');
});
