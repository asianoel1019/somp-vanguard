const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { writeDataSync } = require('../../lib/db');
const { getTargetsSafely, saveTargetsSafely, TARGETS_FILE, TARGETS_KEY } = require('../../lib/prometheusTargetHelper');

const t = (ip) => ({ targets: [`${ip}:9100`], labels: { addr: ip } });

test('falls back to the legacy file when the database is empty', () => {
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.9')]));
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.9']);
});

test('reads the database first even if a stale file exists', () => {
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.9')]));
    writeDataSync(TARGETS_KEY, [t('10.0.0.2'), t('10.0.0.1')]);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.1', '10.0.0.2']);
});

test('save does not create the flat file and stores in the database', async () => {
    fs.rmSync(TARGETS_FILE, { force: true });
    await saveTargetsSafely([t('10.0.0.5'), t('10.0.0.3')], 'test');
    assert.equal(fs.existsSync(TARGETS_FILE), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'prometheus_targets.json')), false);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.3', '10.0.0.5']);
});

test('throws (circuit breaker) when the database value is not an array', () => {
    writeDataSync(TARGETS_KEY, '"corrupt"');
    assert.throws(() => getTargetsSafely(), /Circuit Breaker/);
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
});

test('importLegacyTargetsFileOnce: differing file updates the DB and is renamed', async () => {
    const { importLegacyTargetsFileOnce } = require('../../lib/prometheusTargetHelper');
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.7'), t('10.0.0.6')]));
    const r = await importLegacyTargetsFileOnce();
    assert.equal(r.status, 'imported');
    assert.equal(fs.existsSync(TARGETS_FILE), false);
    assert.ok(fs.readdirSync(dataDir).some(f => f.startsWith('prometheus_targets.json.imported-')));
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.6', '10.0.0.7']);
});

test('importLegacyTargetsFileOnce: equal file is only renamed', async () => {
    const { importLegacyTargetsFileOnce } = require('../../lib/prometheusTargetHelper');
    const list = [t('10.0.0.8')];
    writeDataSync(TARGETS_KEY, list);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(list));
    const r = await importLegacyTargetsFileOnce();
    assert.equal(r.status, 'skipped');
    assert.equal(fs.existsSync(TARGETS_FILE), false);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.8']);
});

test('importLegacyTargetsFileOnce: corrupt file is left in place without throwing', async () => {
    const { importLegacyTargetsFileOnce } = require('../../lib/prometheusTargetHelper');
    fs.writeFileSync(TARGETS_FILE, '{not json');
    const warn = console.warn;
    console.warn = () => {};
    let r;
    try { r = await importLegacyTargetsFileOnce(); } finally { console.warn = warn; }
    assert.equal(r.status, 'corrupt');
    assert.equal(fs.existsSync(TARGETS_FILE), true);
    fs.rmSync(TARGETS_FILE, { force: true });
});

test('a save in another process is visible here (shared DB, not the RAM cache)', () => {
    const { spawnSync } = require('child_process');
    // warm this process's RAM cache with the old value
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    getTargetsSafely();
    const helper = require.resolve('../../lib/prometheusTargetHelper');
    const code = `require(${JSON.stringify(helper)}).saveTargetsSafely([{targets:['10.9.9.9:9100'],labels:{addr:'10.9.9.9'}}],'child').then(()=>process.exit(0),e=>{console.error(e);process.exit(2)})`;
    const r = spawnSync(process.execPath, ['-e', code], { env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.9.9.9']);
});

const dbModule = require('../../lib/db');
const helper = require('../../lib/prometheusTargetHelper');

function withBrokenDb(fn) {
    const original = dbModule.db.prepare;
    dbModule.db.prepare = () => { throw new Error('disk I/O error'); };
    const err = console.error;
    const warn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try { return fn(); } finally { dbModule.db.prepare = original; console.error = err; console.warn = warn; }
}

test('a database read error throws and never falls back to the legacy file', () => {
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.9')]));
    assert.throws(() => withBrokenDb(() => getTargetsSafely()), /Circuit Breaker/);
    fs.rmSync(TARGETS_FILE, { force: true });
});

test('save aborts and writes nothing when the current targets cannot be read', async () => {
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    const original = dbModule.db.prepare;
    dbModule.db.prepare = () => { throw new Error('disk I/O error'); };
    const err = console.error;
    console.error = () => {};
    try {
        await assert.rejects(saveTargetsSafely([t('10.5.5.5')], 'test'), /Circuit Breaker/);
    } finally { dbModule.db.prepare = original; console.error = err; }
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.1']);
});

function resetImportState() {
    dbModule.db.prepare('DELETE FROM document_store WHERE key = ?').run('system/legacy_targets_import.json');
    dbModule.invalidateCache('system/legacy_targets_import.json');
    for (const f of fs.readdirSync(dataDir)) if (f.startsWith('prometheus_targets.json')) fs.rmSync(path.join(dataDir, f), { force: true });
}

test('import: failed rename does not re-import on the next run', async () => {
    resetImportState();
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.50')]));
    const origRename = fs.renameSync;
    const warn = console.warn;
    console.warn = () => {};
    fs.renameSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
    let r1;
    try { r1 = await helper.importLegacyTargetsFileOnce(); } finally { fs.renameSync = origRename; }
    assert.equal(r1.status, 'imported');
    assert.equal(r1.renamed, false);
    assert.equal(fs.existsSync(TARGETS_FILE), true);
    // operator edits targets in between
    writeDataSync(TARGETS_KEY, [t('10.0.0.77')]);
    const r2 = await helper.importLegacyTargetsFileOnce();
    console.warn = warn;
    assert.equal(r2.status, 'already-imported');
    assert.equal(fs.existsSync(TARGETS_FILE), false);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.77']);
});

test('import: a database read error writes nothing', async () => {
    resetImportState();
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.60')]));
    const r = await withBrokenDb(() => helper.importLegacyTargetsFileOnce());
    assert.equal(r.status, 'read-error');
    assert.equal(fs.existsSync(TARGETS_FILE), true);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.1']);
});

test('import: a database newer than the file is kept, marker written, file renamed', async () => {
    resetImportState();
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.61')]));
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(TARGETS_FILE, old, old);
    const r = await helper.importLegacyTargetsFileOnce();
    assert.equal(r.status, 'skipped');
    assert.equal(fs.existsSync(TARGETS_FILE), false);
    assert.deepEqual(getTargetsSafely().map(x => x.labels.addr), ['10.0.0.1']);
    const m = dbModule.db.prepare('SELECT value FROM document_store WHERE key = ?').get('system/legacy_targets_import.json');
    assert.ok(JSON.parse(m.value).fileSha256);
});

test('import: a rolling backup of the current value is created before overwrite', async () => {
    resetImportState();
    writeDataSync(TARGETS_KEY, [t('10.0.0.1')]);
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([t('10.0.0.62')]));
    const r = await helper.importLegacyTargetsFileOnce();
    assert.equal(r.status, 'imported');
    assert.ok(fs.readdirSync(helper.BACKUP_DIR).some(f => f.includes('pre_legacy_import')));
});
