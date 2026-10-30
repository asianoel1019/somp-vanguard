// IPAM store: atomic read-modify-write that never loses a change written by the other process (worker / web).
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbMod = require('../../lib/db');
const ipamStore = require('../../lib/ipamStore');
const dbManager = require('../../services/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

const KEY = ipamStore.IPAM_KEY;
const sub = (id) => ({ id, name: id, cidr: `10.${id.length}.0.0/30`, ips: [] });

/** What another process does: writes the row of the shared database.sqlite, this process' RAM cache is untouched. */
function externalWrite(value) {
    dbMod.db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(value, null, 2));
}

test('a change written by the other process behind the RAM cache survives the next mutation', () => {
    dbMod.writeDataSync(KEY, [sub('a')]);
    assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['a']); // cached
    externalWrite([sub('a'), sub('worker')]);
    assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['a'], 'cache is stale (no IPC in tests)');

    ipamStore.mutateSubnets((subnets) => { subnets.push(sub('web')); });
    assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['a', 'worker', 'web']);
    const row = dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(KEY);
    assert.deepEqual(JSON.parse(row.value).map(s => s.id), ['a', 'worker', 'web']);
});

test('two mutations based on stale reads do not lose either change', () => {
    dbMod.writeDataSync(KEY, [sub('base')]);
    const staleA = ipamStore.readSubnets();
    const staleB = ipamStore.readSubnets();
    // each "caller" decides from its stale copy, but mutates the current document
    ipamStore.mutateSubnets((subnets) => { if (staleA.length === 1) subnets.push(sub('one')); });
    externalWrite([...JSON.parse(dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(KEY).value), sub('ext')]);
    ipamStore.mutateSubnets((subnets) => { if (staleB.length === 1) subnets.push(sub('two')); });
    assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['base', 'one', 'ext', 'two']);
});

test('returns fn result; no write when unchanged; a throwing fn rolls back', () => {
    dbMod.writeDataSync(KEY, [sub('x')]);
    const orig = dbMod.writeDataSync;
    let writes = 0;
    dbMod.writeDataSync = (...a) => { writes++; return orig(...a); };
    try {
        assert.equal(ipamStore.mutateSubnets((subnets) => subnets.length), 1);
        assert.equal(writes, 0, 'unchanged document is not written');
        assert.throws(() => ipamStore.mutateSubnets((subnets) => { subnets.push(sub('boom')); throw new Error('boom'); }), /boom/);
        assert.equal(writes, 0);
        assert.equal(dbMod.db.isTransaction, false, 'transaction closed');
        assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['x']);
        assert.throws(() => ipamStore.mutateSubnets(async (subnets) => { subnets.push(sub('async')); }), /synchronous/);
        assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['x']);
        assert.equal(dbMod.db.isTransaction, false);
    } finally {
        dbMod.writeDataSync = orig;
    }
});

test('a document only in the RAM cache (active DB, not in the local SQLite) is never wiped by a mutation', () => {
    dbMod.writeDataSync(KEY, [sub('pg')]);
    dbMod.db.prepare('DELETE FROM document_store WHERE key = ?').run(KEY); // as after a warmup from PostgreSQL
    ipamStore.mutateSubnets((subnets) => { subnets.push(sub('new')); });
    const row = dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(KEY);
    assert.deepEqual(JSON.parse(row.value).map(s => s.id), ['pg', 'new'], 'now stored locally, later mutations are locked');
});

test('fallback without a local SQLite handle: revision check re-runs fn on the newer document', () => {
    dbMod.writeDataSync(KEY, [sub('f')]);
    const handle = dbMod.db;
    dbMod.db = null; // ipamStore reads the handle at call time
    try {
        let runs = 0;
        const res = ipamStore.mutateSubnets((subnets) => {
            runs++;
            if (runs === 1) {
                // another process writes the document and bumps the revision while fn runs
                const rev = (dbMod.readDataSync(ipamStore.REVISION_KEY, { rev: 0 }) || {}).rev || 0;
                dbMod.writeDataSync(KEY, [sub('f'), sub('other')]);
                dbMod.writeDataSync(ipamStore.REVISION_KEY, { rev: rev + 1 });
            }
            subnets.push(sub('mine'));
            return runs;
        });
        assert.equal(res, 2);
        assert.deepEqual(ipamStore.readSubnets().map(s => s.id), ['f', 'other', 'mine']);
        assert.ok(dbMod.readDataSync(ipamStore.REVISION_KEY).rev >= 2);
    } finally {
        dbMod.db = handle;
    }
});
