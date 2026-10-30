const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { db: libDb, writeDataSync } = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const svc = require('../../services/hostMonitorCheckerService');
const { skipPaths } = require('../../lib/skipPaths');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
const DOCS = path.resolve(__dirname, '../../../docs');
let app;
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-route-')); dirs.push(d); return d; };

const sample = (...ips) => ['DefaultFolder = Root\\TRUST\\PING\\', ...ips.map((ip, i) =>
    `; ------- Test #${i + 1} -------\nMethod = Ping\nTitle = Ping: ${ip} (H${i})\nHost = ${ip}\n`)].join('\n');
function put(dir, name, content, mtime) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    if (mtime) fs.utimesSync(full, new Date(mtime), new Date(mtime));
    return full;
}

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { g: { enabled: true, features: { hmChecker: true } } } });
    app = express();
    // same helper index.js uses for the global parser
    app.use(skipPaths(express.json({ limit: '10mb' }), ['/api/hm-checker/upload-backup']));
    app.use('/api/hm-checker', require('../../routes/hmChecker'));
    libDb.prepare('DELETE FROM cmdb_servers').run();
    cmdb.upsertCmdbServer({ ip: '10.9.0.1', hostname: 'KEEP', envName: 'TRUST' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.9.0.2', hostname: 'GONE', envName: 'TRUST' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.9.0.3', hostname: 'DECOM', envName: 'TRUST' }, 'MANUAL');
    libDb.prepare("UPDATE cmdb_servers SET lifecycleStatus = 'decommissioned' WHERE ip = '10.9.0.3'").run();
    writeDataSync(META_KEY, { '10.9.0.2': { deleted: true } });
});
test.after(async () => {
    svc.saveConfig({ uncPath: '', ignoredEnvs: [] });
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    await dbManager.closeDB();
});
test.beforeEach(() => {
    svc.saveConfig({ uncPath: '', ignoredEnvs: [], scanTimeoutSec: 20, filePattern: 'hostmonitor-item-backup-*.txt' });
    svc.clearTodayCache();
    svc.clearParseCache();
    svc._testHooks.timeoutMs = null;
    svc._testHooks.fsp = null;
    svc._testHooks.scanCacheMs = 0;
    svc.clearScanCache();
});

const post = (url, token, body) => request(app).post(`/api/hm-checker${url}`).set('Authorization', token).send(body);
const get = (url, token) => request(app).get(`/api/hm-checker${url}`).set('Authorization', token);

test('compare picks the latest pattern-matching file automatically and reports its details', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'));
    put(d, 'hostmonitor-item-backup-2026-10-06.txt', sample('10.9.0.1', '10.9.0.9'));
    put(d, 'notes.txt', 'not a backup', '2031-01-01T00:00:00Z');
    svc.saveConfig({ uncPath: d });
    const r = await post('/compare', viewer, { source: 'cmdb', backupFilename: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.backupFile, 'hostmonitor-item-backup-2026-10-06.txt');
    assert.equal(r.body.file.filename, 'hostmonitor-item-backup-2026-10-06.txt');
    assert.equal(r.body.file.directory, d);
    assert.equal(r.body.file.source, 'unc');
    assert.ok(r.body.file.modifiedAt && r.body.file.size > 0);
    assert.equal(r.body.pinned, false);
    // Deleted + decommissioned CMDB servers are excluded
    assert.deepEqual(r.body.results.map(x => x.ip), ['10.9.0.1']);
    const st = await get('/status', viewer);
    assert.equal(st.body.activeFile.filename, 'hostmonitor-item-backup-2026-10-06.txt');
    assert.equal(st.body.activeFile.source, 'unc');
    assert.ok(st.body.availableFiles.every(f => f.filename !== 'notes.txt'));
});

test('pinned file is honoured; unknown pinned file is a 404 (no silent fallback)', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'));
    put(d, 'hostmonitor-item-backup-2026-10-06.txt', sample());
    svc.saveConfig({ uncPath: d });
    const r = await post('/compare', viewer, { source: 'cmdb', backupFilename: 'hostmonitor-item-backup-2026-10-05.txt' });
    assert.equal(r.status, 200);
    assert.equal(r.body.file.filename, 'hostmonitor-item-backup-2026-10-05.txt');
    assert.equal(r.body.pinned, true);
    const miss = await post('/compare', viewer, { source: 'cmdb', backupFilename: 'nope.txt' });
    assert.equal(miss.status, 404);
});

test('UNC scan timeout -> uncError, uploaded files are NOT used', async () => {
    await svc.ensureUploadDir();
    put(svc.getUploadDir(), 'hostmonitor-item-backup-2026-01-01.txt', sample('10.9.0.1'));
    svc.saveConfig({ uncPath: tmp() });
    svc._testHooks.timeoutMs = 50;
    svc._testHooks.fsp = { readdir: () => new Promise(() => {}), stat: () => new Promise(() => {}) };
    const r = await post('/compare', viewer, { source: 'cmdb', backupFilename: '' });
    assert.equal(r.status, 503);
    assert.ok(r.body.uncError);
    assert.match(r.body.error, /逾時/);
    const st = await get('/status', viewer);
    assert.equal(st.status, 200);
    assert.equal(st.body.hasBackup, false);
    assert.ok(st.body.uncError);
    // explicit upload source works
    svc._testHooks.fsp = null;
    const up = await post('/compare', viewer, { source: 'cmdb', backupSource: 'upload' });
    assert.equal(up.status, 200);
    assert.equal(up.body.file.source, 'upload');
    fs.rmSync(path.join(svc.getUploadDir(), 'hostmonitor-item-backup-2026-01-01.txt'), { force: true });
});

test('no UNC configured -> uploaded files are used', async () => {
    const docsBefore = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).sort() : null;
    const up = await post('/upload-backup', op, { filename: 'hostmonitor-item-backup-2026-02-02.txt', content: sample('10.9.0.1') });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.filename, 'hostmonitor-item-backup-2026-02-02.txt');
    assert.equal(up.body.path, undefined);
    const stored = path.join(svc.getUploadDir(), 'hostmonitor-item-backup-2026-02-02.txt');
    assert.ok(fs.existsSync(stored));
    assert.ok(stored.startsWith(dataDir));
    const r = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(r.status, 200);
    assert.equal(r.body.file.source, 'upload');
    assert.equal(r.body.file.filename, 'hostmonitor-item-backup-2026-02-02.txt');
    // docs/ never written
    const docsAfter = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).sort() : null;
    assert.deepEqual(docsAfter, docsBefore);
    fs.rmSync(stored, { force: true });
});

test('docs/ is never read: only the private upload dir is scanned when no UNC is configured', async () => {
    const seen = [];
    const real = fs.promises;
    svc._testHooks.fsp = {
        readdir: (d, o) => { seen.push(path.resolve(d)); return real.readdir(d, o); },
        stat: (f) => { seen.push(path.resolve(f)); return real.stat(f); }
    };
    const r = await get('/status', viewer);
    assert.equal(r.body.hasBackup, false);
    assert.ok(seen.length > 0);
    assert.ok(seen.every(p => p.startsWith(svc.getUploadDir())), seen.join(','));
    assert.ok(!seen.some(p => p.startsWith(DOCS)));
});

test('upload: bad names rejected with 400, traversal contained, size limit, RBAC', async () => {
    for (const filename of ['evil.exe', 'a b.txt', '..', '../', 'x'.repeat(130) + '.txt']) {
        const r = await post('/upload-backup', op, { filename, content: 'hi' });
        assert.equal(r.status, 400, filename);
    }
    const t = await post('/upload-backup', admin, { filename: '..\\..\\..\\hostmonitor-item-backup-trav.txt', content: 'hi' });
    assert.equal(t.status, 200);
    assert.equal(t.body.filename, 'hostmonitor-item-backup-trav.txt');
    assert.ok(fs.existsSync(path.join(svc.getUploadDir(), 'hostmonitor-item-backup-trav.txt')));
    assert.ok(!fs.existsSync(path.join(svc.getUploadDir(), '..', 'hostmonitor-item-backup-trav.txt')));
    assert.ok(!fs.existsSync(path.join(DOCS, 'hostmonitor-item-backup-trav.txt')));
    fs.rmSync(path.join(svc.getUploadDir(), 'hostmonitor-item-backup-trav.txt'), { force: true });
    assert.equal((await post('/upload-backup', op, { filename: 'hostmonitor-item-backup-a.txt', content: '' })).status, 400);
    const big = await post('/upload-backup', op, { filename: 'hostmonitor-item-backup-big.txt', content: 'a'.repeat(50 * 1024 * 1024 + 1) });
    assert.equal(big.status, 413);
    assert.ok(!fs.existsSync(path.join(svc.getUploadDir(), 'hostmonitor-item-backup-big.txt')));
    assert.equal((await post('/upload-backup', viewer, { filename: 'hostmonitor-item-backup-a.txt', content: 'x' })).status, 403);
});

test('config: validation and RBAC', async () => {
    assert.equal((await post('/config', viewer, { uncPath: 'x' })).status, 403);
    assert.equal((await post('/test-unc', viewer, { uncPath: 'x' })).status, 403);
    assert.equal((await post('/generate-import', viewer, { servers: [{ ip: '1.1.1.1' }] })).status, 403);
    assert.equal((await post('/config', op, { scanTimeoutSec: 3 })).status, 400);
    assert.equal((await post('/config', op, { filePattern: 'a?.txt' })).status, 400);
    assert.equal((await post('/config', op, { filePattern: '*a*a*a*a*a*a*a*a*a*b' })).status, 400);
    assert.equal((await post('/config', op, { ignoredEnvs: 'x' })).status, 400);
    const ok = await post('/config', op, { scanTimeoutSec: 45, filePattern: 'hm-*.txt', ignoredEnvs: ['A'] });
    assert.equal(ok.status, 200);
    const cfg = await get('/config', viewer);
    assert.equal(cfg.body.scanTimeoutSec, 45);
    assert.equal(cfg.body.filePattern, 'hm-*.txt');
    assert.deepEqual(cfg.body.ignoredEnvs, ['A']);
});

test('today cache: reused for the same latest file, invalidated by a newer file or changed mtime/size', async () => {
    const d = tmp();
    const f1 = put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'), '2026-10-05T01:00:00Z');
    svc.saveConfig({ uncPath: d });
    const a = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(a.body.fromCache, false);
    const b = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(b.body.fromCache, true);
    assert.equal(b.body.file.filename, 'hostmonitor-item-backup-2026-10-05.txt');
    // force bypasses
    assert.equal((await post('/compare', viewer, { source: 'cmdb', force: true })).body.fromCache, false);
    // mtime changes, same name
    fs.utimesSync(f1, new Date('2026-10-05T05:00:00Z'), new Date('2026-10-05T05:00:00Z'));
    const c = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(c.body.fromCache, false);
    assert.equal((await post('/compare', viewer, { source: 'cmdb' })).body.fromCache, true);
    // size changes, same mtime
    fs.writeFileSync(f1, sample('10.9.0.1', '10.9.0.8'));
    fs.utimesSync(f1, new Date('2026-10-05T05:00:00Z'), new Date('2026-10-05T05:00:00Z'));
    assert.equal((await post('/compare', viewer, { source: 'cmdb' })).body.fromCache, false);
    // newer file arrives
    put(d, 'hostmonitor-item-backup-2026-10-06.txt', sample('10.9.0.1'));
    const e = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(e.body.fromCache, false);
    assert.equal(e.body.file.filename, 'hostmonitor-item-backup-2026-10-06.txt');
    // pinned / env-filtered / custom runs never read nor write the cache
    const pin = await post('/compare', viewer, { source: 'cmdb', backupFilename: 'hostmonitor-item-backup-2026-10-05.txt' });
    assert.equal(pin.body.fromCache, false);
    assert.equal((await post('/compare', viewer, { source: 'cmdb' })).body.fromCache, true);
});

test('today-cache endpoint is async and honest about the file', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'));
    svc.saveConfig({ uncPath: d });
    assert.equal((await get('/today-cache', viewer)).body.hasCache, false);
    await post('/compare', viewer, { source: 'cmdb' });
    const r = await get('/today-cache', viewer);
    assert.equal(r.body.hasCache, true);
    assert.equal(r.body.file.filename, 'hostmonitor-item-backup-2026-10-05.txt');
});

test('test-unc reports pattern matches and honest errors', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample());
    put(d, 'other.txt', 'x');
    const ok = await post('/test-unc', op, { uncPath: d });
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.backupFilesFound, 1);
    assert.equal(ok.body.latestBackupFile, 'hostmonitor-item-backup-2026-10-05.txt');
    // the pattern being edited is used, and validated
    const byBody = await post('/test-unc', op, { uncPath: d, filePattern: 'other*.txt' });
    assert.equal(byBody.body.backupFilesFound, 1);
    assert.equal(byBody.body.latestBackupFile, 'other.txt');
    assert.equal((await post('/test-unc', op, { uncPath: d, filePattern: 'a?b' })).body.success, false);
    const bad = await post('/test-unc', op, { uncPath: path.join(d, 'missing') });
    assert.equal(bad.body.success, false);
    assert.equal((await post('/test-unc', op, { uncPath: 5 })).body.success, false);
});

test('routes contain no synchronous filesystem access to the backup location', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/hmChecker.js'), 'utf8');
    assert.ok(!/existsSync|statSync|readdirSync|findAvailableBackupFiles\(|readFileSync|writeFileSync/.test(src));
    assert.ok(!/\.\.\/\.\.\/docs/.test(src));
});

test('unauthenticated upload is refused before any body parsing', async () => {
    const r = await request(app).post('/api/hm-checker/upload-backup').send({ filename: 'hostmonitor-item-backup-x.txt', content: 'x' });
    assert.equal(r.status, 401);
    const noFeature = await request(app).post('/api/hm-checker/upload-backup').set('Authorization', `Bearer ${signToken({ username: 'n', domain: 'corp', role: 'Operator', groups: ['none'] })}`).send({ filename: 'hostmonitor-item-backup-x.txt', content: 'x' });
    assert.ok([401, 403].includes(noFeature.status));
});

test('upload path variants: exact path allows big bodies, variants stay on the 10 MB global limit', async () => {
    const content = sample('10.9.0.1') + ' '.repeat(11 * 1024 * 1024);
    const name = 'hostmonitor-item-backup-variant.txt';
    const exact = await post('/upload-backup', op, { filename: name, content });
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    fs.rmSync(path.join(svc.getUploadDir(), name), { force: true });
    for (const variant of ['/API/HM-CHECKER/upload-backup', '/api/hm-checker/upload-backup/']) {
        const r = await request(app).post(variant).set('Authorization', op).send({ filename: name, content });
        assert.equal(r.status, 413, variant);
        const small = await request(app).post(variant).set('Authorization', op).send({ filename: name, content: sample('10.9.0.1') });
        assert.equal(small.status, 200, variant);
        fs.rmSync(path.join(svc.getUploadDir(), name), { force: true });
    }
});

test('upload: existing file is not overwritten (409) unless overwrite=true; malformed JSON is a JSON 400', async () => {
    const name = 'hostmonitor-item-backup-dup.txt';
    assert.equal((await post('/upload-backup', op, { filename: name, content: 'one' })).status, 200);
    const dup = await post('/upload-backup', op, { filename: name, content: 'two' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.exists, true);
    assert.equal(fs.readFileSync(path.join(svc.getUploadDir(), name), 'utf8'), 'one');
    const ow = await post('/upload-backup', op, { filename: name, content: 'two', overwrite: true });
    assert.equal(ow.status, 200);
    assert.equal(ow.body.overwritten, true);
    assert.equal(fs.readFileSync(path.join(svc.getUploadDir(), name), 'utf8'), 'two');
    fs.rmSync(path.join(svc.getUploadDir(), name), { force: true });
    const bad = await request(app).post('/api/hm-checker/upload-backup').set('Authorization', op).set('Content-Type', 'application/json').send('{not json');
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);
    const wrongName = await post('/upload-backup', op, { filename: 'random.txt', content: 'x' });
    assert.equal(wrongName.status, 400);
});

test('route level: a changed ignoredEnvs setting invalidates today cache; compare after a hung parse does not stay stuck', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'));
    svc.saveConfig({ uncPath: d });
    assert.equal((await post('/compare', viewer, { source: 'cmdb' })).body.fromCache, false);
    assert.equal((await post('/compare', viewer, { source: 'cmdb' })).body.fromCache, true);
    svc.saveConfig({ ignoredEnvs: ['TRUST'] }); // changed without going through POST /config (which clears the cache)
    const r = await post('/compare', viewer, { source: 'cmdb' });
    assert.equal(r.body.fromCache, false);
    assert.equal(r.body.results.length, 0);
    assert.equal(r.body.summary.ignoredServers, 1);
});

test('pinned file resolves by directory + filename', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'archive'));
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', sample('10.9.0.1'), '2026-10-05T01:00:00Z');
    put(path.join(d, 'archive'), 'hostmonitor-item-backup-2026-10-05.txt', sample(), '2026-10-05T09:00:00Z');
    svc.saveConfig({ uncPath: d });
    const r = await post('/compare', viewer, { source: 'cmdb', backupFilename: 'hostmonitor-item-backup-2026-10-05.txt', backupDirectory: d });
    assert.equal(r.status, 200);
    assert.equal(r.body.file.directory, d);
    const miss = await post('/compare', viewer, { source: 'cmdb', backupFilename: 'hostmonitor-item-backup-2026-10-05.txt', backupDirectory: path.join(d, 'nowhere') });
    assert.equal(miss.status, 404);
    assert.equal(miss.body.pinnedMissing, true);
});

test('generate-import: CPU/MEM/Disk method follows the CMDB OS (client os ignored); unknown OS is skipped', async () => {
    cmdb.upsertCmdbServer({ ip: '10.9.1.1', hostname: 'WINHOST', envName: 'TRUST', os: 'Windows Server 2019' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.9.1.2', hostname: 'LNXHOST', envName: 'TRUST', os: 'CentOS 7' }, 'MANUAL');
    try {
        const servers = [
            { ip: '10.9.1.1', hostname: 'WINHOST', env: 'TRUST', zone: 'SYS', os: 'Linux' },
            { ip: '10.9.1.2', hostname: 'LNXHOST', env: 'TRUST', zone: 'SYS' },
            { ip: '10.9.1.9', hostname: 'NOCMDB', env: 'TRUST', zone: 'SYS' }
        ];
        const r = await post('/generate-import', op, { servers, metrics: ['ping', 'cpu'] });
        assert.equal(r.status, 200);
        assert.ok(r.body.content.includes(String.raw`PerfCounter = \\10.9.1.1\Processor(_Total)\% Processor Time`));
        assert.match(r.body.content, /CPU 10\.9\.1\.2 \(LNXHOST\)/);
        assert.ok(!/Test CPU #\d+ \(NOCMDB\)/.test(r.body.content));
        assert.match(r.body.content, /Ping: 10\.9\.1\.9 \(NOCMDB\)/);
        assert.deepEqual(r.body.skippedUnknownOs.map(k => [k.metric, k.ip]), [['cpu', '10.9.1.9']]);
    } finally {
        libDb.prepare("DELETE FROM cmdb_servers WHERE ip IN ('10.9.1.1', '10.9.1.2')").run();
    }
});
