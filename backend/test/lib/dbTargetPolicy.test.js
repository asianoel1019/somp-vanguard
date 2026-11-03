const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../../lib/dbTargetPolicy');

const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
    try { return await fn(); } finally {
        Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
    }
};

test('connection fields: shell and option-looking values are rejected', () => {
    const base = { engine: 'MySQL', host: 'db01.example.test', port: 3306, database: 'app', username: 'reader' };
    assert.equal(policy.validateConnectionFields(base), null);
    assert.equal(policy.validateConnectionFields({ ...base, engine: 'SQLServer', host: 'sql01\\INST1', username: 'CORP\\svc' }), null);
    for (const bad of [
        { host: 'x & calc' }, { host: 'x"; rm' }, { host: '-oProxyCommand=x' }, { database: 'app; DROP' },
        { database: '--result-file=x' }, { username: 'a b' }, { port: 70000 }, { port: 'abc' }, { engine: 'Oracle' },
    ]) {
        assert.ok(policy.validateConnectionFields({ ...base, ...bad }), JSON.stringify(bad));
    }
});

test('SQLite paths: relative paths land in the root, other places and Vanguard data files are refused', async () => {
    const root = path.join(dataDir, 'data');
    const r = policy.resolveSqlitePath('app.db');
    assert.equal(r.error, undefined);
    assert.equal(path.dirname(r.path).toLowerCase(), fs.realpathSync.native(dataDir).toLowerCase() + path.sep + 'data');
    assert.ok(policy.resolveSqlitePath('../database.sqlite').error, 'escape from root');
    assert.ok(policy.resolveSqlitePath(path.join(dataDir, 'database.sqlite')).error, 'Vanguard own file');
    assert.ok(policy.resolveSqlitePath(path.join(os.tmpdir(), 'elsewhere.db')).error, 'outside root');

    // a configured root may sit outside the data dir, but never opens Vanguard's own files
    await withEnv({ DB_SQLITE_ROOTS: `${os.tmpdir()};${dataDir}` }, () => {
        assert.equal(policy.resolveSqlitePath(path.join(os.tmpdir(), 'elsewhere.db')).error, undefined);
        assert.ok(policy.resolveSqlitePath(path.join(dataDir, 'database.sqlite')).error);
        assert.equal(policy.resolveSqlitePath(path.join(root, 'ok.db')).error, undefined);
    });
});

test('host allowlist: unset allows all; exact, wildcard and CIDR entries', async (t) => {
    // no real DNS in tests: names resolve from this table
    const dnsPromises = require('dns').promises;
    const realLookup = dnsPromises.lookup;
    const table = { 'evil.example.test': ['203.0.113.9'], 'inside.example.test': ['192.0.2.5'], 'split.example.test': ['192.0.2.6', '203.0.113.9'] };
    dnsPromises.lookup = async (name) => {
        if (!table[name]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return table[name].map(address => ({ address, family: 4 }));
    };
    t.after(() => { dnsPromises.lookup = realLookup; });
    await withEnv({ DB_TARGET_ALLOWLIST: undefined }, async () => {
        assert.equal(await policy.checkHostAllowed('anything.example.test'), null);
    });
    await withEnv({ DB_TARGET_ALLOWLIST: 'db01.example.test, *.db.example.test, 192.0.2.0/24' }, async () => {
        assert.equal(await policy.checkHostAllowed('DB01.example.test'), null);
        assert.equal(await policy.checkHostAllowed('a.db.example.test'), null);
        assert.equal(await policy.checkHostAllowed('192.0.2.77'), null);
        assert.equal(await policy.checkHostAllowed('192.0.2.77\\INST'), null);
        assert.ok(await policy.checkHostAllowed('198.51.100.1'));
        assert.ok(await policy.checkHostAllowed('evil.example.test'));
        assert.equal(await policy.checkHostAllowed('inside.example.test'), null, 'name resolving into the CIDR');
        assert.ok(await policy.checkHostAllowed('split.example.test'), 'every resolved address must be inside');
        assert.ok(await policy.checkHostAllowed('unknown.example.test'));
    });
    assert.equal(policy.inCidr('10.1.2.3', '10.0.0.0/8'), true);
    assert.equal(policy.inCidr('11.1.2.3', '10.0.0.0/8'), false);
});
