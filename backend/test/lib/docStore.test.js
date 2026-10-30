// Generic docStore.mutateDocument (extracted from ipamStore; ipamStore.test.js proves the IPAM wrapper is unchanged).
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbMod = require('../../lib/db');
const { mutateDocument } = require('../../lib/docStore');
const dbManager = require('../../services/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

const rowOf = (key) => {
    const row = dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
};
const externalWrite = (key, value) => dbMod.db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run(key, JSON.stringify(value, null, 2));

test('array document: reads the current row behind a stale cache, writes only when changed', () => {
    const KEY = 'test/doc_array.json';
    dbMod.writeDataSync(KEY, [1]);
    externalWrite(KEY, [1, 2]);
    assert.equal(mutateDocument(KEY, (d) => d.length), 2);
    mutateDocument(KEY, (d) => { d.push(3); });
    assert.deepEqual(rowOf(KEY), [1, 2, 3]);
    assert.deepEqual(dbMod.readDataSync(KEY), [1, 2, 3]);
});

test('object document (defaultValue {}): created on first write, non-object values normalised', () => {
    const KEY = 'test/doc_object.json';
    const r = mutateDocument(KEY, (d) => { d.owner = 'a'; return Object.keys(d); }, { defaultValue: {} });
    assert.deepEqual(r, ['owner']);
    assert.deepEqual(rowOf(KEY), { owner: 'a' });
    externalWrite(KEY, [1, 2]);
    mutateDocument(KEY, (d) => { assert.equal(Array.isArray(d), false); d.x = 1; }, { defaultValue: {} });
    assert.deepEqual(rowOf(KEY), { x: 1 });
});

test('throwing / async fn rolls back with the configured name in the message', () => {
    const KEY = 'test/doc_rollback.json';
    dbMod.writeDataSync(KEY, { v: 1 });
    assert.throws(() => mutateDocument(KEY, (d) => { d.v = 2; throw new Error('boom'); }, { defaultValue: {}, label: 'T', reason: 'unit' }), /boom \(T unit\)/);
    assert.throws(() => mutateDocument(KEY, async (d) => { d.v = 3; }, { defaultValue: {}, fnName: 'x.y' }), /x\.y: fn must be synchronous/);
    assert.deepEqual(dbMod.readDataSync(KEY), { v: 1 });
    assert.equal(dbMod.db.isTransaction, false);
    assert.throws(() => mutateDocument('', () => {}), /key/);
});

test('fallback without a local SQLite handle uses the given revision key (default <key>.revision.json)', () => {
    const KEY = 'test/doc_fallback.json';
    dbMod.writeDataSync(KEY, []);
    const handle = dbMod.db;
    dbMod.db = null;
    try {
        mutateDocument(KEY, (d) => { d.push('a'); }, { fallbackRevisionKey: 'test/custom_rev.json' });
        assert.equal(dbMod.readDataSync('test/custom_rev.json').rev, 1);
        mutateDocument(KEY, (d) => { d.push('b'); });
        assert.equal(dbMod.readDataSync('test/doc_fallback.revision.json').rev, 1);
        assert.deepEqual(dbMod.readDataSync(KEY), ['a', 'b']);
    } finally {
        dbMod.db = handle;
    }
});
