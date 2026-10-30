require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { db: libDb, readDataSync, writeDataSync } = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const serverDeletion = require('../../services/serverDeletion');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const HISTORY_KEY = 'server_operation/server_cmdb_history.json';
const row = (ip) => libDb.prepare('SELECT ip FROM cmdb_servers WHERE ip = ?').get(ip);

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

test('migration clears stale deleted flags only where the server is still present, once', () => {
    cmdb.upsertCmdbServer({ ip: '10.5.0.1', hostname: 'RESURRECTED' }, 'MANUAL');           // deleted flag + row: resurrected by old code
    cmdb.upsertCmdbServer({ ip: '10.5.0.9', hostname: 'VIPROW', linkedToIp: '10.5.0.3' }, 'SCANNER'); // VIP row
    writeDataSync(META_KEY, {
        '10.5.0.1': { hostname: 'RESURRECTED', deleted: true, deletedAt: 'x', deletedBy: 'bob' },
        '10.5.0.2': { hostname: 'REALLYGONE', deleted: true, deletedAt: 'x', deletedBy: 'bob' },   // no row: stays deleted
        '10.5.0.3': { hostname: 'PRIMARY' },
        '10.5.0.9': { deleted: true, isVip: true, linkedTo: '10.5.0.3' },                          // linked VIP: stays
        '10.5.0.4': { hostname: 'ROWVIP', deleted: true }                                          // meta without VIP marks but row is a VIP
    });
    cmdb.upsertCmdbServer({ ip: '10.5.0.4', hostname: 'ROWVIP', linkedToIp: '10.5.0.3' }, 'SCANNER', { allowDeleted: true });
    writeDataSync(HISTORY_KEY, []);

    const r = serverDeletion.migrateResurrectedDeletedFlags();
    assert.deepEqual(r.ips, ['10.5.0.1']);
    const meta = readDataSync(META_KEY, {});
    assert.equal(meta['10.5.0.1'].deleted, false);
    assert.equal(meta['10.5.0.1'].restoredBy, 'MIGRATION');
    assert.ok(meta['10.5.0.1'].restoredAt);
    assert.equal(meta['10.5.0.1'].deletedBy, undefined);
    assert.equal(meta['10.5.0.2'].deleted, true);
    assert.equal(meta['10.5.0.9'].deleted, true);
    assert.equal(meta['10.5.0.4'].deleted, true);
    const h = readDataSync(HISTORY_KEY, []);
    assert.equal(h.length, 1);
    assert.deepEqual([h[0].ip, h[0].action, h[0].username], ['10.5.0.1', 'RESTORE', 'MIGRATION']);
    assert.ok(row('10.5.0.1'));

    // second run is a no-op even if a new stale flag appeared meanwhile
    meta['10.5.0.1'].deleted = true;
    writeDataSync(META_KEY, meta);
    const again = serverDeletion.migrateResurrectedDeletedFlags();
    assert.equal(again.skipped, true);
    assert.equal(readDataSync(META_KEY, {})['10.5.0.1'].deleted, true);
    assert.ok(readDataSync('system/cmdb_deleted_flag_migration.json', null));
});
