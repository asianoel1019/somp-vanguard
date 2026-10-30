const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const backupDir = path.join(dataDir, 'test_backups');
process.env.DB_BACKUP_PATH = backupDir;
process.env.DB_BACKUP_RETENTION_DAYS = '30';


const dbManager = require('../../services/db');
const { db: docDb } = require('../../lib/db');
const { encryptText } = require('../../lib/crypto');
const { runBackup, cleanOldBackups, isBackupDue, localDateStr } = require('../../services/backupService');

const readBack = (file, sql, params = []) => {
    const copy = new DatabaseSync(file, { readOnly: true });
    try { return copy.prepare(sql).get(...params); } finally { copy.close(); }
};

test.before(async () => {
    await dbManager.initDB();
    encryptText('make sure .system_key exists');
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=enc:abc\n');
});

test.after(async () => { await dbManager.closeDB(); });

test('runBackup is a no-op unless enabled (or forced)', async () => {
    delete process.env.DB_BACKUP_ENABLED;
    assert.equal(await runBackup(), null);
    assert.equal(fs.existsSync(backupDir), false);
});

test('backs up database.sqlite, scout.sqlite, .system_key and .env with local-date names', async () => {
    // Written just before the backup: still in the -wal file, which a raw file copy can miss
    await dbManager.upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: 'backup-probe', value: '"fresh"', updatedAt: new Date().toISOString() } });
    docDb.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run('legacy-probe', '"fresh-legacy"');

    const now = new Date();
    const result = await runBackup({ force: true, now });
    const date = localDateStr(now);
    assert.deepEqual(result.items.filter(i => !i.ok), [], 'no item failed');
    assert.deepEqual(result.items.map(i => i.name), ['database.sqlite', 'scout.sqlite', '.system_key', '.env']);

    const scoutFile = path.join(backupDir, `scout_backup_${date}.sqlite`);
    const dbFile = path.join(backupDir, `database_backup_${date}.sqlite`);
    assert.equal(readBack(scoutFile, 'SELECT value FROM document_store WHERE key = ?', ['backup-probe']).value, '"fresh"');
    assert.equal(readBack(dbFile, 'SELECT value FROM document_store WHERE key = ?', ['legacy-probe']).value, '"fresh-legacy"');
    assert.equal(readBack(path.join(backupDir, 'scout_backup_latest.sqlite'), 'SELECT value FROM document_store WHERE key = ?', ['backup-probe']).value, '"fresh"');

    const key = fs.readFileSync(path.join(dataDir, '.system_key'), 'utf8');
    assert.equal(fs.readFileSync(path.join(backupDir, 'system_key_backup.key'), 'utf8'), key);
    assert.equal(fs.readFileSync(path.join(backupDir, `env_backup_${date}.env`), 'utf8'), 'FOO=enc:abc\n');
    assert.equal(fs.readdirSync(backupDir).some(f => f.endsWith('.tmp')), false, 'temp files are renamed away');
});

test('a large file is backed up while ANOTHER connection keeps writing (the web process does this)', async () => {
    const { backupSqlite } = require('../../services/backupService');
    const file = path.join(dataDir, 'busy.sqlite');
    const src = new DatabaseSync(file);
    const other = new DatabaseSync(file);
    src.exec('PRAGMA journal_mode=WAL; CREATE TABLE m(id INTEGER PRIMARY KEY, v TEXT)');
    const ins = src.prepare('INSERT INTO m(v) VALUES (?)');
    src.exec('BEGIN');
    for (let i = 0; i < 6000; i++) ins.run('x'.repeat(1000)); // ~6 MB, well over 100 pages
    src.exec('COMMIT');
    const write = other.prepare('INSERT INTO m(v) VALUES (?)');
    const writer = setInterval(() => write.run('w'), 1);
    try {
        const started = Date.now();
        const bytes = await Promise.race([
            backupSqlite(src, path.join(dataDir, 'busy_backup.sqlite')),
            new Promise((_, reject) => setTimeout(() => reject(new Error('backup did not finish within 15s (restart loop)')), 15000)),
        ]);
        assert.ok(bytes > 5_000_000);
        assert.ok(Date.now() - started < 15000);
        assert.ok(readBack(path.join(dataDir, 'busy_backup.sqlite'), 'SELECT count(*) c FROM m').c >= 6000);
    } finally {
        clearInterval(writer);
        src.close();
        other.close();
    }
});

test('a failing item is reported without stopping the others', async () => {
    const keyFile = path.join(dataDir, '.system_key');
    const saved = fs.readFileSync(keyFile);
    fs.rmSync(keyFile);
    try {
        const result = await runBackup({ force: true });
        const byName = Object.fromEntries(result.items.map(i => [i.name, i]));
        assert.equal(byName['.system_key'].ok, false);
        assert.match(byName['.system_key'].error, /not found/);
        assert.equal(byName['scout.sqlite'].ok, true);
        assert.equal(byName['.env'].ok, true);
    } finally {
        fs.writeFileSync(keyFile, saved);
    }
});

test('retention purges old dated backups of every kind but keeps latest files and the key', () => {
    const dir = path.join(dataDir, 'retention');
    fs.mkdirSync(dir, { recursive: true });
    const old = ['database_backup_2020-01-01.sqlite', 'scout_backup_2020-01-01.sqlite', 'config_backup_2020-01-01.json', 'env_backup_2020-01-01.env'];
    const keep = ['database_backup_latest.sqlite', 'scout_backup_latest.sqlite', 'env_backup_latest.env', 'system_key_backup.key', 'unrelated.txt', 'scout_backup_2099-01-01.sqlite'];
    const past = new Date(Date.now() - 40 * 86400000);
    for (const f of [...old, ...keep]) {
        fs.writeFileSync(path.join(dir, f), 'x');
        if (f !== 'scout_backup_2099-01-01.sqlite') fs.utimesSync(path.join(dir, f), past, past);
    }
    cleanOldBackups(dir, 30);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [...keep].sort());
});

test('scheduling uses the local date: runs once per day after the scan time', () => {
    const at = (h, m) => { const d = new Date(2026, 9, 14, h, m); return d; };
    assert.equal(isBackupDue(at(2, 59), '03:00', '2026-10-13', false), false, 'before scan time');
    assert.equal(isBackupDue(at(3, 0), '03:00', '2026-10-13', false), true, 'at scan time');
    assert.equal(isBackupDue(at(8, 30), '03:00', '2026-10-14', false), false, 'already ran today (no second run at UTC midnight)');
    assert.equal(isBackupDue(at(10, 0), '03:00', null, true), false, 'restart after today\'s backup exists');
    assert.equal(localDateStr(at(0, 30)), '2026-10-14');
});

test('concurrent runs: the second returns { skipped: "running" } and the guard resets afterwards', async () => {
    const first = runBackup({ force: true });
    const second = await runBackup({ force: true });
    assert.deepEqual(second, { skipped: 'running' });
    const result = await first;
    assert.equal(result.items.length, 4);
    const third = await runBackup({ force: true });
    assert.ok(Array.isArray(third.items), 'a new run is accepted once the previous one finished');
});

test('runManualBackup records started and finished results in system/last_backup_result.json', async () => {
    const { runManualBackup, readLastResult } = require('../../services/backupService');
    let release;
    const gate = new Promise(r => { release = r; });
    let signalStarted;
    const startedWritten = new Promise(r => { signalStarted = r; });
    const p = runManualBackup('alice', 'req-1', { beforeRun: () => { signalStarted(); return gate; } });
    await startedWritten; // the started doc is written before beforeRun is awaited
    const started = await readLastResult();
    assert.equal(started.requestId, 'req-1');
    assert.equal(started.requestedBy, 'alice');
    assert.ok(started.startedAt);
    assert.equal(started.finishedAt, null);
    release();
    const result = await p;
    const done = await readLastResult();
    assert.equal(done.requestId, 'req-1');
    assert.ok(done.finishedAt);
    assert.equal(done.dir, backupDir);
    assert.deepEqual(done.items.map(i => i.name), ['database.sqlite', 'scout.sqlite', '.system_key', '.env']);
    assert.equal(done.items.length, result.items.length);
});

const namesIn = (dir) => fs.readdirSync(dir).filter(f => !f.endsWith('.tmp')).sort();
const withBackupDir = (name) => {
    const dir = path.join(dataDir, name);
    process.env.DB_BACKUP_PATH = dir;
    return dir;
};
const ALL = ['database.sqlite', 'scout.sqlite', '.system_key', '.env'];

test('targets: system writes only database_backup + key + env', async () => {
    const dir = withBackupDir('t_system');
    const r = await runBackup({ force: true, targets: 'system' });
    assert.deepEqual(r.items.map(i => i.name), ['database.sqlite', '.system_key', '.env']);
    assert.ok(namesIn(dir).some(f => f.startsWith('database_backup_')));
    assert.equal(namesIn(dir).some(f => f.startsWith('scout_backup_')), false);
    assert.ok(namesIn(dir).includes('system_key_backup.key'));
});

test('targets: scout writes only scout_backup + key + env', async () => {
    const dir = withBackupDir('t_scout');
    const r = await runBackup({ force: true, targets: 'scout' });
    assert.deepEqual(r.items.map(i => i.name), ['scout.sqlite', '.system_key', '.env']);
    assert.ok(namesIn(dir).some(f => f.startsWith('scout_backup_')));
    assert.equal(namesIn(dir).some(f => f.startsWith('database_backup_')), false);
});

test('targets: invalid or missing value means both; the env value is used when no param is given; manual is always both', async () => {
    const { normalizeTargets, runManualBackup } = require('../../services/backupService');
    assert.equal(normalizeTargets('bogus'), 'both');
    assert.equal(normalizeTargets(undefined), 'both');
    assert.equal(normalizeTargets(' System '), 'system');
    withBackupDir('t_invalid');
    try {
        process.env.DB_BACKUP_TARGETS = 'nonsense';
        assert.deepEqual((await runBackup({ force: true })).items.map(i => i.name), ALL);
        process.env.DB_BACKUP_TARGETS = 'system';
        assert.deepEqual((await runBackup({ force: true })).items.map(i => i.name), ['database.sqlite', '.system_key', '.env']);
        const manual = await runManualBackup('u', 'rid-both');
        assert.deepEqual(manual.items.map(i => i.name), ALL);
    } finally {
        delete process.env.DB_BACKUP_TARGETS;
    }
});

test('hasBackupFor only considers the selected targets', () => {
    const { hasBackupFor } = require('../../services/backupService');
    const dir = withBackupDir('t_has');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'database_backup_2030-01-01.sqlite'), 'x');
    assert.equal(hasBackupFor('2030-01-01', 'system'), true);
    assert.equal(hasBackupFor('2030-01-01', 'scout'), false);
    assert.equal(hasBackupFor('2030-01-01', 'both'), true);
    fs.writeFileSync(path.join(dir, 'config_backup_2030-01-02.json'), 'x');
    assert.equal(hasBackupFor('2030-01-02', 'scout'), true);
    assert.equal(hasBackupFor('2030-01-02', 'system'), false);
});

test('scheduled run uses DB_BACKUP_TARGETS from the env and records requestedBy SCHEDULE', async () => {
    const { schedulerTick, resetSchedulerState, readLastResult } = require('../../services/backupService');
    const dir = withBackupDir('t_sched');
    resetSchedulerState();
    process.env.DB_BACKUP_ENABLED = 'true';
    process.env.DB_BACKUP_SCAN_TIME = '00:00';
    process.env.DB_BACKUP_TARGETS = 'system';
    try {
        const tick = await schedulerTick(new Date(2030, 0, 5, 12, 0));
        assert.ok(tick.started, JSON.stringify(tick));
        await tick.started;
        assert.deepEqual(namesIn(dir).filter(f => /^(database|scout)_backup_2030.*.sqlite$/.test(f)), ['database_backup_2030-01-05.sqlite']);
        assert.equal((await readLastResult()).requestedBy, 'SCHEDULE');
        assert.deepEqual(await schedulerTick(new Date(2030, 0, 5, 12, 1)), { skipped: 'already-ran' });
    } finally {
        delete process.env.DB_BACKUP_ENABLED; delete process.env.DB_BACKUP_SCAN_TIME; delete process.env.DB_BACKUP_TARGETS;
        resetSchedulerState();
    }
});

test('scheduler skips while the status doc shows a fresh unfinished run, and ignores a stale one', async () => {
    const { schedulerTick, resetSchedulerState, writeLastResult } = require('../../services/backupService');
    withBackupDir('t_sched_busy');
    resetSchedulerState();
    process.env.DB_BACKUP_ENABLED = 'true';
    process.env.DB_BACKUP_SCAN_TIME = '00:00';
    try {
        const now = new Date(2030, 0, 6, 12, 0);
        await writeLastResult({ requestId: 'm', requestedBy: 'alice', startedAt: new Date(now.getTime() - 5 * 60000).toISOString(), finishedAt: null });
        assert.deepEqual(await schedulerTick(now), { skipped: 'running' });
        await writeLastResult({ requestId: 'm', requestedBy: 'alice', startedAt: new Date(now.getTime() - 31 * 60000).toISOString(), finishedAt: null });
        const tick = await schedulerTick(now);
        assert.ok(tick.started);
        await tick.started;
    } finally {
        delete process.env.DB_BACKUP_ENABLED; delete process.env.DB_BACKUP_SCAN_TIME;
        resetSchedulerState();
    }
});

test('a skipped scheduled run leaves the status doc alone; a skipped manual run records finishedAt + error', async () => {
    const { runRecordedBackup, runManualBackup, readLastResult, writeLastResult } = require('../../services/backupService');
    withBackupDir('t_skip');
    const marker = { requestId: 'in-progress', requestedBy: 'alice', startedAt: new Date().toISOString(), finishedAt: null, items: [], dir: null };
    await writeLastResult(marker);
    const direct = runBackup({ force: true }); // takes the running guard synchronously
    try {
        assert.deepEqual(await runRecordedBackup('SCHEDULE'), { skipped: 'running' });
        assert.deepEqual(await readLastResult(), marker);

        assert.deepEqual(await runManualBackup('bob', 'skip-manual'), { skipped: 'running' });
        const st = await readLastResult();
        assert.equal(st.requestId, 'skip-manual');
        assert.ok(st.finishedAt);
        assert.equal(st.error, 'A backup is already running.');
    } finally {
        await direct;
    }
});

test('two concurrent recorded runs: exactly one runs, the loser is skipped and a scheduled loser never touches the status doc', async () => {
    const { runRecordedBackup, runManualBackup, readLastResult } = require('../../services/backupService');
    withBackupDir('t_race');
    process.env.DB_BACKUP_ENABLED = 'true';
    try {
        const [manual, scheduled] = await Promise.all([
            runManualBackup('carol', 'race-1'),
            runRecordedBackup('SCHEDULE'),
        ]);
        assert.ok(Array.isArray(manual.items));
        assert.deepEqual(scheduled, { skipped: 'running' });
        const st = await readLastResult();
        assert.equal(st.requestId, 'race-1');
        assert.equal(st.requestedBy, 'carol');
        assert.equal(st.error, undefined);
        // the guard is released afterwards
        assert.ok(Array.isArray((await runManualBackup('carol', 'race-2')).items));
    } finally {
        delete process.env.DB_BACKUP_ENABLED;
    }
});
