// Batched log rotation on a real (temporary) SQLite database: old rows are archived before they are deleted,
// maxRecords keeps the newest inserts, metrics retention deletes in batches, archives read newest first.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dbManager = require('../../services/db');
const db = require('../../services/scoutDb');
const rotation = require('../../services/logRotation');

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const daysAgo = (d, extraMs = 0) => new Date(NOW - d * 86400000 + extraMs).toISOString();
const archiveDir = () => path.join(process.env.DB_DATA_DIR, 'archives');
const archived = (table) => (fs.existsSync(archiveDir()) ? fs.readdirSync(archiveDir()) : [])
    .filter(f => f.startsWith(`archive_${table}_`))
    .flatMap(f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(archiveDir(), f))).toString('utf8')));

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => {
    for (const t of ['windows_events', 'linux_logs', 'metrics', 'log_rotation_settings']) db.run(`DELETE FROM ${t}`);
    fs.rmSync(archiveDir(), { recursive: true, force: true });
});

function addEvents(n, ageDays, prefix) {
    for (let i = 0; i < n; i++) {
        db.run('INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [`${prefix}${i}`, 'host01', 'Error', 4625, 'p', `message ${prefix}${i}`, '{}', daysAgo(ageDays, i * 1000)]);
    }
}
const ids = (table) => db.all(`SELECT id FROM ${table} ORDER BY rowid`).map(r => r.id);

test('hot tier: rows older than hotDays are archived (several files) and deleted; newer rows stay', async () => {
    addEvents(12, 20, 'old');
    addEvents(5, 1, 'new');
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('windows_events', 30, 0, 1)"); // hot 14 days
    const r = await rotation.runLogRotation({ now: NOW, batch: 3, archiveRows: 5, pauseMs: 0 });
    assert.equal(r.windows_events, 12);
    assert.deepEqual(ids('windows_events'), ['new0', 'new1', 'new2', 'new3', 'new4']);
    const arch = archived('windows_events');
    assert.equal(arch.length, 12);
    assert.deepEqual(new Set(arch.map(a => a.id)), new Set(Array.from({ length: 12 }, (_, i) => `old${i}`)));
    assert.equal(arch[0].__rid, undefined, 'no helper columns in the archive');
    assert.equal(fs.readdirSync(archiveDir()).length, 3, '5 + 5 + 2 rows per file');
});

test('maxRecords keeps the newest inserts', async () => {
    addEvents(10, 1, 'e');
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('windows_events', 30, 4, 1)");
    const r = await rotation.runLogRotation({ now: NOW, batch: 2, archiveRows: 3, pauseMs: 0 });
    assert.equal(r.windows_events, 6);
    assert.deepEqual(ids('windows_events'), ['e6', 'e7', 'e8', 'e9']);
    assert.equal(archived('windows_events').length, 6);
});

test('metrics retention deletes old rows in batches; disabled settings are skipped', async () => {
    for (let i = 0; i < 7; i++) db.run('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?, ?, ?)', ['m1', daysAgo(i < 5 ? 10 : 1), '{}']);
    addEvents(3, 40, 'kept');
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('agent_metrics', 7, 0, 1)");
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('windows_events', 30, 0, 0)");
    const r = await rotation.runLogRotation({ now: NOW, batch: 2, pauseMs: 0 });
    assert.equal(r.metrics, 5);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM metrics').n, 2);
    assert.equal(ids('windows_events').length, 3, 'disabled table untouched');
});

test('one run at a time; cold archives come back newest first, filtered, from at most maxFiles files', async () => {
    addEvents(4, 20, 'a');
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('windows_events', 30, 0, 1)");
    const p1 = rotation.runLogRotation({ now: NOW, batch: 2, archiveRows: 2, pauseMs: 0 });
    const p2 = rotation.runLogRotation({ now: NOW });
    assert.equal(p1, p2, 'a second call joins the running one');
    await p1;
    const all = await rotation.readColdArchives('windows_events', null, 10);
    assert.equal(all.length, 4);
    const some = await rotation.readColdArchives('windows_events', (it) => it.id === 'a1', 10);
    assert.deepEqual(some.map(x => x.id), ['a1']);
    const oneFile = await rotation.readColdArchives('windows_events', null, 10, 1);
    assert.equal(oneFile.length, 2);
});

test('the worker checkpoints the WAL itself after deleting', async (t) => {
    addEvents(6, 20, 'old');
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('windows_events', 30, 0, 1)");
    for (let i = 0; i < 5; i++) db.run('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?, ?, ?)', ['m', daysAgo(40), '{}']);
    db.run("INSERT INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) VALUES ('agent_metrics', 7, 0, 1)");
    const pragmas = [];
    const realGet = db.get;
    t.mock.method(db, 'get', (sql, params) => { if (/wal_checkpoint/.test(sql)) pragmas.push(sql); return realGet(sql, params); });
    await rotation.runLogRotation({ now: NOW, batch: 2, archiveRows: 3, pauseMs: 0 });
    assert.ok(pragmas.length >= 3, `checkpoints: ${pragmas.length}`); // two archive files of windows_events, then metrics
    assert.ok(pragmas.every(p => p === 'PRAGMA wal_checkpoint(PASSIVE)'));
});

test('tiers: hot 14 days from 28 days of retention, half below', () => {
    assert.deepEqual(rotation.calculateDynamicTiers(30), { totalDays: 30, hotDays: 14, coldDays: 16 });
    assert.deepEqual(rotation.calculateDynamicTiers(10), { totalDays: 10, hotDays: 5, coldDays: 5 });
});
