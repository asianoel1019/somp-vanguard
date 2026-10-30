const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbManager = require('../../services/db');
const svc = require('../../services/hostMonitorCheckerService');

test.before(async () => { await dbManager.initDB(); svc._testHooks.scanCacheMs = 0; });
test.after(async () => { await dbManager.closeDB(); });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hm-svc-'));
function put(dir, rel, content = 'x', mtime = null) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mtime) fs.utimesSync(full, new Date(mtime), new Date(mtime));
    return full;
}

test('poller removed: no export, no timers in the module', () => {
    assert.equal(svc.startDailyHostMonitorPoller, undefined);
    const src = fs.readFileSync(path.join(__dirname, '../../services/hostMonitorCheckerService.js'), 'utf8');
    assert.ok(!/setInterval|startDailyHostMonitorPoller|setTimeout\(startDaily/.test(src));
    const worker = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    assert.ok(!/hostMonitorChecker/i.test(worker));
});

test('patternToMatcher: case-insensitive, only * is a wildcard, linear time on hostile patterns', () => {
    const m = svc.patternToMatcher('hostmonitor-item-backup-*.txt');
    assert.ok(m('HostMonitor-Item-Backup-2026-10-06.TXT'));
    assert.ok(!m('other.txt'));
    assert.ok(!m('hostmonitor-item-backup-1.txt.bak'));
    assert.ok(!svc.patternToMatcher('a.b*')('axb1'));
    assert.ok(svc.patternToMatcher('a.b*')('a.b1'));
    assert.ok(!svc.patternToMatcher('a(b)*')('ab1'));
    assert.ok(svc.patternToMatcher('*')('anything'));
    assert.ok(svc.patternToMatcher('a***b')('aXXb'));
    const hostile = svc.patternToMatcher('*a*a*a*a*a*a*a*a*b');
    const t0 = process.hrtime.bigint();
    assert.equal(hostile('a'.repeat(200)), false);
    assert.equal(svc.patternToMatcher('*a'.repeat(40) + 'b')('a'.repeat(200)), false);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50);
});

test('date detection: adjacent _ / - are fine, the file date beats a dated parent folder', async () => {
    assert.equal(svc.extractDateInfo('hostmonitor-item-backup_20261020.txt'), '2026-10-20');
    assert.equal(svc.extractDateInfo('x-2026-10-20_0300.txt'), '2026-10-20');
    assert.equal(svc.extractDateInfo('x120261020.txt'), null);
    const d = tmp();
    put(d, 'old-2025-12-31/hostmonitor-item-backup-a.txt', 'a', '2026-01-01T00:00:00Z');
    put(d, 'hostmonitor-item-backup-b.txt', 'b', '2026-06-01T00:00:00Z');
    const files = await svc.scanBackupFiles(d, { timeoutMs: 5000 });
    assert.equal(files[0].filename, 'hostmonitor-item-backup-b.txt');
    assert.equal(files.find(f => f.filename.endsWith('a.txt')).hasExplicitDate, false);
    const e = tmp();
    put(e, 'hostmonitor-item-backup-_20261019.txt', 'a', '2027-01-01T00:00:00Z');
    put(e, 'hostmonitor-item-backup-_20261020_0300.txt', 'b', '2026-01-01T00:00:00Z');
    assert.equal((await svc.scanBackupFiles(e, { timeoutMs: 5000 }))[0].filename, 'hostmonitor-item-backup-_20261020_0300.txt');
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(e, { recursive: true, force: true });
});

test('scan: filters by pattern, ignores other .txt, newest by date then mtime, depth <= 4, skips hidden/system dirs', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-2026-10-05.txt', 'a');
    put(d, 'sub/hostmonitor-item-backup-2026-10-07.txt', 'bb');
    put(d, 'notes.txt', 'n', '2030-01-01T00:00:00Z');
    put(d, '.hidden/hostmonitor-item-backup-2099-01-01.txt');
    put(d, '$RECYCLE.BIN/hostmonitor-item-backup-2099-01-02.txt');
    put(d, 'a/b/c/d/hostmonitor-item-backup-2026-01-01.txt'); // depth 4 dir -> allowed
    put(d, 'a/b/c/d/e/hostmonitor-item-backup-2099-01-03.txt'); // depth 5 -> not scanned
    const files = await svc.scanBackupFiles(d, { timeoutMs: 5000, source: 'unc' });
    const names = files.map(f => f.filename);
    assert.equal(names[0], 'hostmonitor-item-backup-2026-10-07.txt');
    assert.ok(names.includes('hostmonitor-item-backup-2026-01-01.txt'));
    assert.ok(!names.includes('notes.txt'));
    assert.ok(!names.some(n => n.includes('2099')));
    assert.equal(files[0].source, 'unc');
    assert.equal(files[0].size, 2);
    assert.equal(files[0].directory, path.join(d, 'sub'));
    fs.rmSync(d, { recursive: true, force: true });
});

test('scan: latest by mtime when names carry no date', async () => {
    const d = tmp();
    put(d, 'hostmonitor-item-backup-old.txt', 'a', '2026-01-01T00:00:00Z');
    put(d, 'hostmonitor-item-backup-new.txt', 'a', '2026-06-01T00:00:00Z');
    const files = await svc.scanBackupFiles(d, { timeoutMs: 5000 });
    assert.equal(files[0].filename, 'hostmonitor-item-backup-new.txt');
    fs.rmSync(d, { recursive: true, force: true });
});

test('scan: custom pattern; missing dir rejects; hanging fs times out', async () => {
    const d = tmp();
    put(d, 'hm-1.txt');
    put(d, 'hostmonitor-item-backup-1.txt');
    const files = await svc.scanBackupFiles(d, { pattern: 'hm-*.txt', timeoutMs: 5000 });
    assert.deepEqual(files.map(f => f.filename), ['hm-1.txt']);
    await assert.rejects(svc.scanBackupFiles(path.join(d, 'nope'), { timeoutMs: 5000 }));
    const hanging = { readdir: () => new Promise(() => {}), stat: () => new Promise(() => {}) };
    const t0 = Date.now();
    await assert.rejects(svc.scanBackupFiles(d, { timeoutMs: 60, fsp: hanging }), /逾時/);
    assert.ok(Date.now() - t0 < 2000);
    fs.rmSync(d, { recursive: true, force: true });
});

test('validateConfigInput', () => {
    const ok = svc.validateConfigInput({ uncPath: '  \\\\h\\s  ', ignoredEnvs: ['A', 'B'], scanTimeoutSec: 30, filePattern: 'x-*.txt' });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.uncPath, '\\\\h\\s');
    assert.equal(ok.value.scanTimeoutSec, 30);
    assert.equal(svc.validateConfigInput({}).ok, true);
    for (const bad of [
        { uncPath: 5 }, { uncPath: 'x'.repeat(1025) },
        { ignoredEnvs: 'A' }, { ignoredEnvs: [1] }, { ignoredEnvs: Array(101).fill('a') },
        { scanTimeoutSec: 4 }, { scanTimeoutSec: 121 }, { scanTimeoutSec: 'abc' },
        { filePattern: 'x'.repeat(129) }, { filePattern: 'a?b*.txt' }, { filePattern: '..\\x*' }, { filePattern: 5 }, { filePattern: '*a*a*a*a*a*a*a*a*a*b' }, { filePattern: 'a{1,2}*' }, { filePattern: 'a|b*' }
    ]) {
        assert.equal(svc.validateConfigInput(bad).ok, false, JSON.stringify(bad));
    }
});

test('getConfig defaults and saveConfig ignores undefined fields', () => {
    svc.saveConfig({ uncPath: '', ignoredEnvs: [] });
    const c = svc.getConfig();
    assert.equal(c.scanTimeoutSec, 20);
    assert.equal(c.filePattern, 'hostmonitor-item-backup-*.txt');
    svc.saveConfig({ ignoredEnvs: ['Z'] });
    svc.saveConfig({ uncPath: undefined, ignoredEnvs: undefined });
    assert.deepEqual(svc.getConfig().ignoredEnvs, ['Z']);
    svc.saveConfig({ ignoredEnvs: [] });
});

test('sanitizeUploadFilename', () => {
    assert.match(svc.sanitizeUploadFilename('').filename, /^hostmonitor-item-backup-\d{4}-\d{2}-\d{2}\.txt$/);
    assert.match(svc.sanitizeUploadFilename(undefined).filename, /^hostmonitor-item-backup-/);
    assert.equal(svc.sanitizeUploadFilename('good_1-2.TXT').filename, 'good_1-2.TXT');
    assert.equal(svc.sanitizeUploadFilename('../../evil.txt').filename, 'evil.txt');
    assert.equal(svc.sanitizeUploadFilename('C:\\x\\y\\evil.txt').filename, 'evil.txt');
    for (const bad of ['..', '../', 'a.exe', 'a b.txt', 'a.txt.exe', '.txt', 'é.txt', 'a'.repeat(125) + '.txt', 'a:b.txt', 'con\u0000.txt', 123]) {
        assert.equal(svc.sanitizeUploadFilename(bad).ok, false, String(bad));
    }
    assert.equal(svc.sanitizeUploadFilename('a'.repeat(124) + '.txt').ok, true);
});

test('saveUploadedBackup stores inside the private upload dir only, rejects bad input, enforces 50 MB', async () => {
    const dir = svc.getUploadDir();
    assert.ok(dir.startsWith(dataDir));
    assert.ok(!dir.includes(`${path.sep}docs${path.sep}`));
    const r = await svc.saveUploadedBackup({ filename: '../../hostmonitor-item-backup-escape.txt', content: 'hello' });
    assert.equal(r.filename, 'hostmonitor-item-backup-escape.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'hostmonitor-item-backup-escape.txt'), 'utf8'), 'hello');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'hostmonitor-item-backup-escape.txt')));
    // no silent overwrite; explicit overwrite replaces, leaves no temp file
    await assert.rejects(svc.saveUploadedBackup({ filename: 'hostmonitor-item-backup-escape.txt', content: 'second' }), (e) => e.status === 409);
    assert.equal(fs.readFileSync(path.join(dir, 'hostmonitor-item-backup-escape.txt'), 'utf8'), 'hello');
    const o = await svc.saveUploadedBackup({ filename: 'hostmonitor-item-backup-escape.txt', content: 'second', overwrite: true });
    assert.equal(o.overwritten, true);
    assert.equal(fs.readFileSync(path.join(dir, 'hostmonitor-item-backup-escape.txt'), 'utf8'), 'second');
    assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')));
    // name must match the configured pattern, otherwise it would never be used
    await assert.rejects(svc.saveUploadedBackup({ filename: 'random.txt', content: 'x' }), (e) => e.status === 400 && /規則/.test(e.message));
    await assert.rejects(svc.saveUploadedBackup({ filename: 'x.exe', content: 'a' }), (e) => e.status === 400);
    await assert.rejects(svc.saveUploadedBackup({ filename: 'x.txt', content: '' }), (e) => e.status === 400);
    await assert.rejects(svc.saveUploadedBackup({ filename: 'x.txt', content: 5 }), (e) => e.status === 400);
    await assert.rejects(svc.saveUploadedBackup({ filename: 'hostmonitor-item-backup-big.txt', content: 'a'.repeat(50 * 1024 * 1024 + 1) }), (e) => e.status === 413);
    assert.ok(!fs.existsSync(path.join(dir, 'hostmonitor-item-backup-big.txt')));
    fs.rmSync(path.join(dir, 'hostmonitor-item-backup-escape.txt'), { force: true });
});

test('resolveBackupFiles: UNC configured and failing -> uncError, never falls back to uploads; explicit upload source works', async () => {
    const up = svc.getUploadDir();
    put(up, 'hostmonitor-item-backup-2026-01-01.txt', 'u');
    svc._testHooks.timeoutMs = 50;
    try {
        svc.saveConfig({ uncPath: path.join(tmp(), 'missing') });
        const bad = await svc.resolveBackupFiles({});
        assert.equal(bad.files.length, 0);
        assert.ok(bad.uncError);
        assert.equal(bad.source, 'unc');
        const forced = await svc.resolveBackupFiles({ backupSource: 'upload' });
        assert.equal(forced.source, 'upload');
        assert.equal(forced.uncError, undefined);
        assert.equal(forced.files[0].filename, 'hostmonitor-item-backup-2026-01-01.txt');
        svc.saveConfig({ uncPath: '' });
        const none = await svc.resolveBackupFiles({});
        assert.equal(none.source, 'upload');
        assert.equal(none.files.length, 1);
    } finally {
        svc._testHooks.timeoutMs = null;
        svc.saveConfig({ uncPath: '' });
        fs.rmSync(path.join(up, 'hostmonitor-item-backup-2026-01-01.txt'), { force: true });
    }
});

test('pickBackupFile: empty/latest -> newest; pinned honoured; unknown -> null', () => {
    const files = [{ filename: 'b.txt' }, { filename: 'a.txt' }];
    assert.equal(svc.pickBackupFile(files, '').filename, 'b.txt');
    assert.equal(svc.pickBackupFile(files, 'latest').filename, 'b.txt');
    assert.equal(svc.pickBackupFile(files, undefined).filename, 'b.txt');
    assert.equal(svc.pickBackupFile(files, 'a.txt').filename, 'a.txt');
    assert.equal(svc.pickBackupFile(files, 'zzz.txt'), null);
    const dup = [{ filename: 'a.txt', directory: 'X' }, { filename: 'a.txt', directory: 'Y' }];
    assert.equal(svc.pickBackupFile(dup, 'a.txt', 'Y').directory, 'Y');
    assert.equal(svc.pickBackupFile(dup, 'a.txt', 'Z'), null);
});

test('today cache: valid only for the same latest file (name+mtime+size+source) and same ignoredEnvs', () => {
    const latest = { filename: 'hostmonitor-item-backup-2026-10-06.txt', directory: 'D', size: 100, mtimeMs: 1000, modifiedAt: 'x', source: 'unc' };
    svc.clearTodayCache();
    assert.equal(svc.getTodayCache(latest, []), null);
    svc.saveTodayCache({ source: 'cmdb', file: latest, ignoredEnvs: ['B', 'a'], backupFile: latest.filename, backupMeta: {}, summary: { totalServers: 1 }, results: [] });
    assert.ok(svc.getTodayCache(latest, ['A', 'b']));
    assert.equal(svc.getTodayCache(null, []), null);
    assert.equal(svc.getTodayCache({ ...latest, filename: 'hostmonitor-item-backup-2026-10-07.txt' }, ['a', 'b']), null);
    assert.equal(svc.getTodayCache({ ...latest, mtimeMs: 2000 }, ['a', 'b']), null);
    assert.equal(svc.getTodayCache({ ...latest, size: 101 }, ['a', 'b']), null);
    assert.equal(svc.getTodayCache({ ...latest, source: 'upload' }, ['a', 'b']), null);
    assert.equal(svc.getTodayCache(latest, []), null);
    assert.equal(svc.getTodayCache(latest, ['a']), null);
    svc.clearTodayCache();
});

test('parse cache keeps at most 3 entries (LRU) keyed by path+mtime+size', async () => {
    svc.clearParseCache();
    let parses = 0;
    const parse = async (p) => { parses++; return { p }; };
    const f = (n, m = 1, s = 1) => ({ fullPath: `/f${n}`, mtimeMs: m, size: s });
    for (const n of [1, 2, 3]) await svc.getOrParseFile(f(n), { parse });
    assert.equal(parses, 3);
    await svc.getOrParseFile(f(1), { parse }); // hit, refreshes 1
    assert.equal(parses, 3);
    await svc.getOrParseFile(f(4), { parse }); // evicts 2 (least recently used)
    assert.equal(svc._parseCacheKeys().length, 3);
    await svc.getOrParseFile(f(1), { parse });
    assert.equal(parses, 4);
    await svc.getOrParseFile(f(2), { parse }); // was evicted
    assert.equal(parses, 5);
    await svc.getOrParseFile(f(1, 2), { parse }); // mtime changed -> miss
    assert.equal(parses, 6);
    await svc.getOrParseFile(f(1, 2, 9), { parse }); // size changed -> miss
    assert.equal(parses, 7);
    assert.ok(svc._parseCacheKeys().length <= 3);
    svc.clearParseCache();
});

test('loadCmdbServers excludes decommissioned and deleted servers and does not cap the query', () => {
    let seenFilter;
    const servers = [
        { ip: '10.0.0.1', hostname: 'A', lifecycleStatus: 'active' },
        { ip: '10.0.0.2', hostname: 'B', lifecycleStatus: 'decommissioned' },
        { ip: '10.0.0.3', hostname: 'C' },
        { ip: '10.0.0.4', hostname: 'D', linkedToIp: '10.0.0.3' }
    ];
    const out = svc.loadCmdbServers('TRUST', {
        queryCmdb: (f) => { seenFilter = f; return { servers }; },
        readDeletedMeta: () => ({ '10.0.0.3': { deleted: true } })
    });
    assert.deepEqual(out.map(s => s.ip), ['10.0.0.1']);
    assert.equal(seenFilter.env, 'TRUST');
    assert.equal(seenFilter.limit, undefined);
    const all = svc.loadCmdbServers('ALL', { queryCmdb: (f) => { seenFilter = f; return { servers: [] }; }, readDeletedMeta: () => ({}) });
    assert.equal(seenFilter.env, undefined);
    assert.deepEqual(all, []);
});

test('parse is bounded by the timeout and a hung/failed parse is never cached', async () => {
    svc.clearParseCache();
    let aborted = false;
    const hung = (p, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
    const t0 = Date.now();
    await assert.rejects(svc.getOrParseFile({ fullPath: '/h', mtimeMs: 1, size: 1 }, { parse: hung, timeoutMs: 50 }), (e) => e.status === 504 && /逾時/.test(e.message));
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(aborted, true);
    assert.equal(svc._parseCacheKeys().length, 0);
    await assert.rejects(svc.getOrParseFile({ fullPath: '/f', mtimeMs: 1, size: 1 }, { parse: async () => { throw new Error('boom'); }, timeoutMs: 50 }), /boom/);
    assert.equal(svc._parseCacheKeys().length, 0);
    const ok = await svc.getOrParseFile({ fullPath: '/h', mtimeMs: 1, size: 1 }, { parse: async () => ({ fine: true }), timeoutMs: 50 });
    assert.deepEqual(ok, { fine: true });
    svc.clearParseCache();
});

test('scan is single-flight and its result/uncError is cached (never-resolving fs is hit once)', async () => {
    const d = tmp();
    let calls = 0;
    svc._testHooks.fsp = { readdir: () => { calls++; return new Promise(() => {}); }, stat: () => new Promise(() => {}) };
    svc._testHooks.timeoutMs = 80;
    svc._testHooks.scanCacheMs = 10000;
    svc.clearScanCache();
    svc.saveConfig({ uncPath: d });
    try {
        const [a, b, c] = await Promise.all([svc.resolveBackupFiles({}), svc.resolveBackupFiles({}), svc.resolveBackupFiles({})]);
        assert.ok(a.uncError && b.uncError && c.uncError);
        assert.equal(calls, 1);
        const again = await svc.resolveBackupFiles({});
        assert.match(again.uncError, /逾時/);
        assert.equal(calls, 1);
        svc.clearScanCache();
        await svc.resolveBackupFiles({});
        assert.equal(calls, 2);
    } finally {
        svc._testHooks.fsp = null;
        svc._testHooks.timeoutMs = null;
        svc._testHooks.scanCacheMs = 0;
        svc.clearScanCache();
        svc.saveConfig({ uncPath: '' });
        fs.rmSync(d, { recursive: true, force: true });
    }
});

test('today cache written before results carried osFamily is ignored', () => {
    const latest = { filename: 'hostmonitor-item-backup-2026-10-27.txt', directory: 'D', size: 1, mtimeMs: 1, modifiedAt: 'x', source: 'unc' };
    svc.saveTodayCache({ source: 'cmdb', file: latest, ignoredEnvs: [], backupFile: latest.filename, backupMeta: {}, summary: {}, results: [{ ip: '10.0.0.1' }] });
    assert.equal(svc.getTodayCache(latest, []), null);
    svc.saveTodayCache({ source: 'cmdb', file: latest, ignoredEnvs: [], backupFile: latest.filename, backupMeta: {}, summary: {}, results: [{ ip: '10.0.0.1', osFamily: 'linux' }] });
    assert.ok(svc.getTodayCache(latest, []));
    svc.clearTodayCache();
});

test('resolveOsFamily: Windows / Linux by CMDB os text, anything else unknown', () => {
    for (const os of ['Windows Server 2019 Standard', 'Microsoft Windows Server 2022', 'win2016']) assert.equal(svc.resolveOsFamily(os), 'windows', os);
    for (const os of ['Linux', 'CentOS 7.9', 'Red Hat Enterprise Linux 8', 'RHEL 9', 'Ubuntu 22.04', 'Oracle Linux 8', 'Rocky Linux 9', 'SLES 15'])
        assert.equal(svc.resolveOsFamily(os), 'linux', os);
    for (const os of ['', null, undefined, 'VMware ESXi 7', 'AIX 7.2', 'Other']) assert.equal(svc.resolveOsFamily(os), 'unknown', String(os));
});

test('attachCmdbOs: CMDB os (by IP) wins over the client value; unmatched keep their own', () => {
    const out = svc.attachCmdbOs(
        [{ ip: '10.0.0.1', os: 'Linux' }, { ip: ' 10.0.0.2 ' }, { ip: '10.0.0.3', os: 'CentOS 7' }, { ip: '10.0.0.4' }],
        { queryCmdb: () => ({ servers: [{ ip: '10.0.0.1', os: 'Windows Server 2019' }, { ip: '10.0.0.2', os: 'Ubuntu 22.04' }] }) }
    );
    assert.deepEqual(out.map(s => s.osFamily), ['windows', 'linux', 'linux', 'unknown']);
    assert.equal(out[0].os, 'Windows Server 2019');
});

test('import file: Windows uses PerfCounter / Memory WMI / DriveSpace, Linux keeps SNMP, unknown OS is skipped', () => {
    const base = { env: 'MM', zone: 'PFM-SYS', applicationName: 'App', hasPing: false, hasCpu: false, hasMem: false, hasDisk: false };
    const { content, skipped } = svc.buildHostMonitorImport([
        { ...base, ip: '10.0.0.1', hostname: 'WIN01', osFamily: 'windows' },
        { ...base, ip: '10.0.0.2', hostname: 'LNX02', os: 'CentOS 7' },
        { ...base, ip: '10.0.0.3', hostname: 'UNK03', os: '' }
    ], ['ping', 'cpu', 'mem', 'disk'], {});
    const block = (host, label) => {
        const all = content.split(/(?=; ------- Test )/).filter(b => b.startsWith(`; ------- Test ${label} `) && b.includes(`(${host})`));
        assert.equal(all.length, 1, `${label} ${host}`);
        return all[0].split(/(?=;-{10,})/)[0];
    };
    // Windows
    const wCpu = block('WIN01', 'CPU');
    assert.match(wCpu, /Method {6}= PerfCounter/);
    assert.ok(wCpu.includes(String.raw`PerfCounter = \\10.0.0.1\Processor(_Total)\% Processor Time`));
    assert.match(wCpu, /Value {7}= 85\.00/);
    const wMem = block('WIN01', 'Memory');
    assert.match(wMem, /Protocol {4}= WMI/);
    assert.ok(!/Profile/.test(wMem));
    const wDisk = block('WIN01', 'Disk');
    assert.match(wDisk, /Method {6}= DriveSpace/);
    assert.match(wDisk, /Server {6}= 10\.0\.0\.1/);
    assert.match(wDisk, /CheckLocals = Yes/);
    assert.match(wDisk, /MinFreeSpace= 15%/);
    assert.ok(!/2021\./.test(wCpu + wMem + wDisk), 'no net-snmp OIDs for Windows');
    // Linux (unchanged)
    assert.match(block('LNX02', 'CPU'), /OID {9}= 1\.3\.6\.1\.4\.1\.2021\.11\.9\.0/);
    assert.match(block('LNX02', 'Memory'), /Protocol {4}= SNMP/);
    assert.match(block('LNX02', 'Disk'), /OID {9}= 1\.3\.6\.1\.4\.1\.2021\.9\.1\.9\.1/);
    // Unknown: ping only, CPU/MEM/Disk listed as skipped
    assert.ok(/Title {7}= Ping: 10\.0\.0\.3 \(UNK03\)/.test(content));
    assert.ok(!/Test (CPU|Memory|Disk) #\d+ \(UNK03\)/.test(content));
    assert.deepEqual(skipped.map(k => k.metric).sort(), ['cpu', 'disk', 'mem']);
    assert.match(content, /; Skipped 3 CPU\/MEM\/Disk test\(s\)/);
    // generateHostMonitorImportText still returns the text only
    assert.equal(typeof svc.generateHostMonitorImportText([{ ...base, ip: '10.0.0.1', hostname: 'WIN01', osFamily: 'windows' }], ['cpu']), 'string');
});
