/**
 * Server Provision jobs (scout.sqlite, same handle as inventory_hosts, shared by the web and the worker process):
 *  - provision_jobs: one row per install job (request JSON never carries secrets) + ownership columns
 *  - provision_job_hosts: one row per target host (status, per-package results, truncated log)
 *
 * Where a job runs (Phase 4):
 *  - The web creates the rows (runner NULL) and offers the job to the Background Worker over IPC (RUN_PROVISION_JOB
 *    { jobId }). The worker resolves credentials / software itself, claims the row atomically
 *    (UPDATE ... WHERE runner IS NULL) and acknowledges. No ack within ackTimeoutMs, no worker, a failed send or a
 *    rejection -> the web claims the row with the same statement and runs the job itself. Exactly one claim can win.
 *  - Credentials are the Settings service account (AD_ADMIN_* / LINUX_ADMIN_*, runners.buildContext), resolved by the
 *    process that runs the job; secrets never travel over IPC and are never stored. createdBy keeps the triggering user.
 *  - The owner (ownerId = "<role>:<pid>:<random>") writes heartbeatAt every heartbeatMs. Starting a host, every
 *    queued-host write and the terminal write are fenced on ownerId, so a process that lost the job can never start
 *    a host or close the job. Cancel = cancelRequested flag (+ CANCEL_PROVISION_JOB); the runner reads the flag before
 *    every host and package and on every heartbeat.
 *  - A job whose owner is gone (pid dead / heartbeat stale / pre-upgrade row) is adopted with a compare-and-swap on
 *    ownerId: running hosts -> interrupted, queued hosts -> resumed once (resumeCount) or interrupted / cancelled.
 * Credentials live in an in-memory map for the lifetime of the job and are never written to the database, logs or audit.
 * The full state machine is documented in docs (chapter 2.8) and in recoverAdopted / ownerGone below.
 */
const crypto = require('crypto');
// Module objects so tests can inject loggers / runners
const logger = require('../lib/logger');
const prov = require('../lib/provisioning');
const runners = require('../lib/provisionRunners');

const MODULE = 'Remote Install';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 5000;
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'partial', 'failed', 'cancelled', 'interrupted'];
const MAX_RESUMES = 1;
const HALF_DONE = 'Interrupted: the runner stopped (service restart) while this host was being provisioned; it may be half-installed and is never re-run automatically (use Retry failed)';
// Timing (tests shorten ackTimeoutMs)
const config = { ackTimeoutMs: 5000, heartbeatMs: 15000, staleMs: 60000, webStaleWorkerMs: 120000, sweepMs: 30000 };

const readyHandles = new WeakSet();
// jobId -> { ctx, software, request, actor, settings, cancelled, lost, resumed }  (credentials: memory only); runs HERE
const live = new Map();
// web only: jobId -> same state while the job is being offered to the worker (created here, not claimed yet)
const pending = new Map();
// web only: jobId -> { resolve, timer } waiting for PROVISION_JOB_ACCEPTED / _REJECTED
const ackWaiters = new Map();
// jobId -> promise that settles when the job runner finished (tests and shutdown await it)
const runnerPromises = new Map();

// Identity of this process as a job owner. The worker calls initWorker() (role 'worker'); everything else is 'web'.
const makeInstance = (role) => `${role}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
const identity = { role: 'web', instance: makeInstance('web') };
let workerReady = false;
function setRole(role) {
    if (identity.role === role) return;
    identity.role = role;
    identity.instance = makeInstance(role);
}

function getHandle() {
    const handle = require('./inventoryStore').getHandle();
    if (!readyHandles.has(handle)) {
        ensureTables(handle);
        readyHandles.add(handle);
    }
    return handle;
}

/** Idempotent: CREATE TABLE IF NOT EXISTS + indexes. */
function ensureTables(handle) {
    handle.exec(`CREATE TABLE IF NOT EXISTS provision_jobs (
        id TEXT PRIMARY KEY,
        createdBy TEXT,
        createdAt TEXT,
        startedAt TEXT,
        finishedAt TEXT,
        status TEXT,
        buType TEXT,
        request TEXT,
        hostCount INTEGER DEFAULT 0,
        okCount INTEGER DEFAULT 0,
        failCount INTEGER DEFAULT 0,
        rebootCount INTEGER DEFAULT 0,
        note TEXT
    )`);
    handle.exec(`CREATE TABLE IF NOT EXISTS provision_job_hosts (
        jobId TEXT,
        ip TEXT,
        hostname TEXT,
        os TEXT,
        status TEXT,
        startedAt TEXT,
        finishedAt TEXT,
        packages TEXT,
        rebootRequired INTEGER DEFAULT 0,
        log TEXT,
        error TEXT
    )`);
    addMissingColumns(handle);
    for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_provision_jobs_createdAt ON provision_jobs(createdAt)',
        'CREATE INDEX IF NOT EXISTS idx_provision_jobs_status ON provision_jobs(status)',
        'CREATE INDEX IF NOT EXISTS idx_provision_job_hosts_jobId ON provision_job_hosts(jobId)',
        'CREATE INDEX IF NOT EXISTS idx_provision_job_hosts_ip ON provision_job_hosts(ip)'
    ]) {
        try { handle.exec(sql); } catch (e) { /* index is an optimisation only */ }
    }
}

// Phase 4 ownership columns; old rows get NULL runner (treated as orphans of the web) and 0 flags
const JOB_COLUMNS = [['runAs', 'TEXT'], ['runner', 'TEXT'], ['ownerId', 'TEXT'], ['claimedAt', 'TEXT'], ['heartbeatAt', 'TEXT'], ['cancelRequested', 'INTEGER DEFAULT 0'], ['resumeCount', 'INTEGER DEFAULT 0']];
/** ALTER TABLE ... ADD COLUMN guarded by PRAGMA table_info; the other process may add the same column concurrently. */
function addMissingColumns(handle) {
    const have = new Set(handle.prepare('PRAGMA table_info(provision_jobs)').all().map(c => c.name));
    for (const [name, type] of JOB_COLUMNS) {
        if (have.has(name)) continue;
        try { handle.exec(`ALTER TABLE provision_jobs ADD COLUMN ${name} ${type}`); }
        catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
}

const nowIso = () => new Date().toISOString();
const parseJson = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };

// ---------------------------------------------------------------------------------------------
// Known targets (CMDB, not deleted, or inventory)
// ---------------------------------------------------------------------------------------------
function lookupTargets(ips) {
    const cmdbModel = require('./cmdbModel');
    const inventoryStore = require('./inventoryStore');
    let deletedMeta = {};
    try { deletedMeta = cmdbModel.readDeletedMeta() || {}; } catch (e) { deletedMeta = {}; }
    const out = new Map();
    for (const ip of ips) {
        let cmdb = null;
        let inv = null;
        try { cmdb = cmdbModel.getCmdbServerByIp(ip); } catch (e) { cmdb = null; }
        if (cmdb && deletedMeta[ip] && deletedMeta[ip].deleted === true) cmdb = null;
        try { inv = inventoryStore.getHost(ip); } catch (e) { inv = null; }
        const source = cmdb && inv ? 'both' : cmdb ? 'cmdb' : inv ? 'inventory' : null;
        out.set(ip, {
            ip, known: !!source, source,
            hostname: (cmdb && cmdb.hostname) || (inv && inv.hostname) || '',
            os: (cmdb && cmdb.os) || (inv && (inv.os || inv.osname)) || ''
        });
    }
    return out;
}

/** The queued / running host row (and so the job) that currently owns an IP, or null. */
function activeJobForIp(ip, excludeJobId = null) {
    const row = getHandle().prepare(`SELECT jobId FROM provision_job_hosts WHERE ip = ? AND status IN ('queued', 'running') AND (? IS NULL OR jobId != ?) LIMIT 1`)
        .get(ip, excludeJobId, excludeJobId);
    return row ? row.jobId : null;
}

const ipSortKey = (ip) => String(ip).split('.').map(n => String(parseInt(n, 10) || 0).padStart(3, '0')).join('.');

/** CMDB (not deleted) + inventory hosts for the target picker. Parameterised LIKE on ip / hostname, max 200. */
function listTargets({ q, limit } = {}) {
    const lim = prov.clampInt(limit, 50, 1, 200);
    const term = String(q === undefined || q === null ? '' : q).trim().slice(0, 100);
    const like = `%${term.replace(/[!%_]/g, m => `!${m}`)}%`;
    const merged = new Map();
    const cmdbModel = require('./cmdbModel');
    let deletedMeta = {};
    try { deletedMeta = cmdbModel.readDeletedMeta() || {}; } catch (e) { deletedMeta = {}; }
    try {
        const db = require('../lib/db').db;
        const rows = db.prepare(`SELECT ip, hostname, os, businessUnit FROM cmdb_servers WHERE (? = '' OR ip LIKE ? ESCAPE '!' OR hostname LIKE ? ESCAPE '!') ORDER BY ip LIMIT 2000`).all(term, like, like);
        for (const r of rows) {
            if (!prov.isIpv4(r.ip) || (deletedMeta[r.ip] && deletedMeta[r.ip].deleted === true)) continue;
            merged.set(r.ip, { ip: r.ip, hostname: r.hostname || '', os: r.os || '', source: 'cmdb', bu: r.businessUnit || '' });
        }
    } catch (e) { /* CMDB table unavailable: inventory only */ }
    try {
        const { hosts } = require('./inventoryStore').listHosts({ search: term || undefined, limit: 2000 });
        for (const x of hosts) {
            if (!prov.isIpv4(x.ip)) continue;
            const cur = merged.get(x.ip);
            if (cur) { cur.source = 'both'; cur.hostname = cur.hostname || x.hostname || ''; cur.os = cur.os || x.os || x.osname || ''; }
            else merged.set(x.ip, { ip: x.ip, hostname: x.hostname || '', os: x.os || x.osname || '', source: 'inventory' });
        }
    } catch (e) { /* inventory unavailable: CMDB only */ }
    return [...merged.values()].sort((a, b) => ipSortKey(a.ip).localeCompare(ipSortKey(b.ip))).slice(0, lim);
}

// ---------------------------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------------------------
function jobRowToApi(r) {
    const request = parseJson(r.request, {});
    // audit-log groups of the actor are stored for the worker only; not part of the API shape
    delete request.actorGroups;
    return {
        id: r.id,
        seq: Number(r.seq) || undefined,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        startedAt: r.startedAt || null,
        finishedAt: r.finishedAt || null,
        status: r.status,
        buType: r.buType,
        osType: request.osType || 'windows',
        request,
        unknownTargets: Array.isArray(request.unknownIps) ? request.unknownIps : [],
        hostCount: Number(r.hostCount) || 0,
        okCount: Number(r.okCount) || 0,
        failCount: Number(r.failCount) || 0,
        rebootCount: Number(r.rebootCount) || 0,
        note: r.note || null,
        running: ACTIVE_JOB.includes(r.status),
        runner: r.runner || null,
        runAs: r.runAs || null,
        claimedAt: r.claimedAt || null,
        heartbeatAt: r.heartbeatAt || null,
        cancelRequested: Number(r.cancelRequested) === 1,
        resumeCount: Number(r.resumeCount) || 0,
        resumed: Number(r.resumeCount) > 0
    };
}

function hostRowToApi(r, withLog) {
    const out = {
        ip: r.ip, hostname: r.hostname || '', os: r.os || '', status: r.status,
        startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
        packages: parseJson(r.packages, []), rebootRequired: !!r.rebootRequired, error: r.error || null
    };
    if (withLog) out.log = r.log || '';
    return out;
}

function listJobs({ limit, before } = {}) {
    const lim = prov.clampInt(limit, 25, 1, 200);
    const h = getHandle();
    const beforeSeq = parseInt(before, 10);
    const rows = Number.isFinite(beforeSeq)
        ? h.prepare('SELECT rowid AS seq, * FROM provision_jobs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?').all(beforeSeq, lim + 1)
        : h.prepare('SELECT rowid AS seq, * FROM provision_jobs ORDER BY rowid DESC LIMIT ?').all(lim + 1);
    const jobs = rows.slice(0, lim).map(jobRowToApi);
    return { jobs, nextBefore: rows.length > lim && jobs.length ? jobs[jobs.length - 1].seq : null };
}

function getJob(id, { logs = true } = {}) {
    const h = getHandle();
    const row = h.prepare('SELECT rowid AS seq, * FROM provision_jobs WHERE id = ?').get(String(id));
    if (!row) return null;
    const hosts = h.prepare('SELECT rowid AS seq, * FROM provision_job_hosts WHERE jobId = ? ORDER BY rowid').all(row.id).map(r => hostRowToApi(r, logs));
    return { job: jobRowToApi(row), hosts };
}

// ---------------------------------------------------------------------------------------------
// Creating and running jobs
// ---------------------------------------------------------------------------------------------
function createJob({ actor, request, software, ctx, hostInfo, settings, workerEligible = false }) {
    const h = getHandle();
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const ips = request.ips;
    const hostRows = ips.map(ip => {
        const info = (hostInfo && hostInfo.get(ip)) || {};
        const owner = activeJobForIp(ip);
        return { ip, hostname: info.hostname || '', os: info.os || '', skipped: owner ? `Skipped: already being provisioned by job ${owner}` : null };
    });
    h.exec('BEGIN');
    try {
        h.prepare('INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount, okCount, failCount, rebootCount) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)')
            .run(id, actor, createdAt, 'queued', request.buType, JSON.stringify(request), ips.length);
        const ins = h.prepare('INSERT INTO provision_job_hosts (jobId, ip, hostname, os, status, startedAt, finishedAt, packages, rebootRequired, log, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
        for (const r of hostRows) {
            if (r.skipped) ins.run(id, r.ip, r.hostname, r.os, 'skipped', createdAt, createdAt, '[]', r.skipped, r.skipped);
            else ins.run(id, r.ip, r.hostname, r.os, 'queued', null, null, '[]', '', null);
        }
        if (ctx && ctx.runAs) h.prepare('UPDATE provision_jobs SET runAs = ? WHERE id = ?').run(String(ctx.runAs).slice(0, 200), id);
        h.exec('COMMIT');
    } catch (e) {
        try { h.exec('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
        throw e;
    }
    // set in the same synchronous turn as the INSERT: a sweep can never see this unclaimed row as an orphan
    pending.set(id, { ctx, software, request, actor, settings, cancelled: false, workerEligible: workerEligible === true });
    setSlotLimit(settings && settings.hostConcurrency);
    track(id, new Promise((resolve) => {
        setImmediate(() => { startJob(id).catch(e => console.error('[Provision] job runner failed:', e && e.message)).then(resolve); });
    }));
    return id;
}

function track(id, p) {
    runnerPromises.set(id, p);
    p.then(() => { if (runnerPromises.get(id) === p) runnerPromises.delete(id); });
}

/** Atomic claim of a never-claimed job (web fallback and worker accept use the same statement): true when this process won. */
function claimJob(h, id) {
    const at = nowIso();
    return Number(h.prepare("UPDATE provision_jobs SET runner = ?, ownerId = ?, claimedAt = ?, heartbeatAt = ? WHERE id = ? AND runner IS NULL AND status IN ('queued', 'running')")
        .run(identity.role, identity.instance, at, at, id).changes) === 1;
}

/** Starts the runner of a job this process owns (state already holds credentials / software). */
function launch(id, st) {
    live.set(id, st);
    // account the hosts are actually provisioned with in this process (user name only, no secret)
    try { if (st.ctx && st.ctx.runAs) getHandle().prepare('UPDATE provision_jobs SET runAs = ? WHERE id = ? AND ownerId = ?').run(String(st.ctx.runAs).slice(0, 200), id, identity.instance); } catch (e) { /* display only */ }
    setSlotLimit(st.settings && st.settings.hostConcurrency);
    startHeartbeat();
    return runJob(id);
}

/** Web: offer the job to the worker; run it here when the worker does not take it. */
async function startJob(id) {
    const st = pending.get(id);
    if (!st) return;
    let handedOver = false;
    try {
        if (st.workerEligible && !st.cancelled) handedOver = await offerToWorker(id);
    } finally {
        pending.delete(id);
    }
    // the worker owns it now: drop the credentials of this process
    if (handedOver) return;
    const h = getHandle();
    if (!claimJob(h, id)) {
        const row = h.prepare('SELECT * FROM provision_jobs WHERE id = ?').get(id);
        console.log(`[Provision] Job ${id} is run by the ${(row && row.runner) || 'other'} process.`);
        // The worker claimed it but its ack never came because it died (exit handler ended the wait): the exit
        // handler skipped this job while it was still pending here, so adopt it now instead of waiting for the respawn.
        if (row && row.runner === 'worker' && ACTIVE_JOB.includes(row.status) && pidOf(row.ownerId) && !hooks.isPidAlive(pidOf(row.ownerId))) {
            try { recoverOrphans({ pid: pidOf(row.ownerId) }); } catch (e) { console.error('[Provision] recovery after a lost ack failed:', prov.oneLine(e && e.message, 200)); }
        }
        return;
    }
    await launch(id, st);
}

// ---------------------------------------------------------------------------------------------
// IPC (web <-> worker). Only { type, jobId } travels; each process resolves credentials itself.
// ---------------------------------------------------------------------------------------------
const WORKER_UNAVAILABLE = 'unavailable';
function sendToWorker(msg) {
    if (process.env.ENABLE_EMBEDDED_WORKER === 'false') return false;
    try { return typeof global.sendWorkerMessage === 'function' && global.sendWorkerMessage(msg) === true; } catch (e) { return false; }
}

function settleAck(id, result) {
    const w = ackWaiters.get(id);
    if (!w) return;
    ackWaiters.delete(id);
    clearTimeout(w.timer);
    w.resolve(result);
}

/** Resolves true only when the worker acknowledged (it claimed the row before acknowledging). */
async function offerToWorker(id) {
    if (identity.role !== 'web') return false;
    const ack = new Promise((resolve) => {
        const timer = setTimeout(() => settleAck(id, 'timeout'), config.ackTimeoutMs);
        ackWaiters.set(id, { resolve, timer });
    });
    if (!sendToWorker({ type: 'RUN_PROVISION_JOB', jobId: id })) settleAck(id, WORKER_UNAVAILABLE);
    const result = await ack;
    if (result !== 'accepted') console.log(`[Provision] Job ${id} runs in the web process (worker: ${result}).`);
    return result === 'accepted';
}

/** Web: messages from the worker (index.js supervisor). Late acks are ignored: the claim in the DB decides. */
function onWorkerMessage(msg) {
    if (!msg || typeof msg.jobId !== 'string') return false;
    if (msg.type === 'PROVISION_JOB_ACCEPTED') { settleAck(msg.jobId, 'accepted'); return true; }
    if (msg.type === 'PROVISION_JOB_REJECTED') { settleAck(msg.jobId, `rejected (${prov.oneLine(msg.reason || '', 120)})`); return true; }
    return false;
}

/** Web: the worker exited; every pending offer falls back to the web at once. */
function onWorkerGone() {
    for (const id of [...ackWaiters.keys()]) settleAck(id, 'worker exited');
}

/** Worker: RUN_PROVISION_JOB / CANCEL_PROVISION_JOB from the web. reply(msg) sends to the web. Never throws. */
function handleWorkerMessage(msg, reply) {
    if (!msg || typeof msg !== 'object') return false;
    const send = (m) => { try { if (typeof reply === 'function') reply(m); } catch (e) { /* the web falls back on its own */ } };
    const id = String(msg.jobId || '');
    if (msg.type === 'RUN_PROVISION_JOB') {
        try { acceptJob(id, send); } catch (e) {
            console.error('[Provision] RUN_PROVISION_JOB failed:', prov.oneLine(e && e.message, 200));
            send({ type: 'PROVISION_JOB_REJECTED', jobId: id, reason: 'worker error' });
        }
        return true;
    }
    if (msg.type === 'CANCEL_PROVISION_JOB') {
        const st = live.get(id);
        if (st) { st.cancelled = true; cancelWaiters(st); }
        return true;
    }
    return false;
}

function acceptJob(id, send) {
    const reject = (reason) => send({ type: 'PROVISION_JOB_REJECTED', jobId: id, reason });
    if (identity.role !== 'worker' || !workerReady) return reject('worker not ready');
    const h = getHandle();
    const row = h.prepare('SELECT * FROM provision_jobs WHERE id = ?').get(id);
    if (!row) return reject('not found');
    if (row.runner) return reject('already claimed');
    if (!ACTIVE_JOB.includes(row.status)) return reject('not active');
    const plan = buildRunPlan(row);
    if (plan.error) return reject(plan.error);
    if (!claimJob(h, id)) return reject('already claimed');
    send({ type: 'PROVISION_JOB_ACCEPTED', jobId: id });
    track(id, launch(id, plan.st).catch(e => console.error('[Provision] job runner failed:', e && e.message)));
}

const readConfig = () => { try { return require('../lib/envEditor').readEnv() || {}; } catch (e) { return {}; } };

/** The worker never saw the actor's login: seed the audit-log groups stored with the job (group names only). */
function seedActorGroups(actor, groups) {
    if (!actor || !Array.isArray(groups) || !groups.length) return;
    global.userGroupsCache = global.userGroupsCache || {};
    const key = String(actor).toLowerCase();
    if (!Array.isArray(global.userGroupsCache[key]) || !global.userGroupsCache[key].length) global.userGroupsCache[key] = groups.map(String);
}

/**
 * Rebuilds the run state of a job from its row in THIS process: credentials from the settings store / env, software
 * from the current configuration (same names as at submit; a removed package or invalid rule refuses the run).
 * Returns { st } or { error } (readable, no secrets).
 */
function buildRunPlan(row, cfg = readConfig()) {
    const request = parseJson(row.request, null);
    if (!request || !Array.isArray(request.ips) || !request.osType || !request.buType || !Array.isArray(request.softwareNames) || !request.softwareNames.length) {
        return { error: 'the job request is incomplete (created by an older version)' };
    }
    // Every job runs as the Settings service account (any credentialSource, also jobs created before the switch):
    // resolved here, fresh, in the process that runs the job
    const built = runners.buildContext({ osType: request.osType === 'linux' ? 'linux' : 'windows', config: cfg });
    if (built.error) return { error: built.error };
    built.ctx.secrets = (built.ctx.secrets || []).filter(Boolean);
    const all = prov.resolveSoftware(prov.loadInstallConfig(cfg), request.buType, request.osType);
    const software = [];
    for (const name of request.softwareNames) {
        const sw = all.find(s => s.name === name);
        if (!sw) return { error: `package "${prov.oneLine(name, 60)}" is no longer configured for template "${prov.oneLine(request.buType, 60)}"` };
        if (sw.detectError) return { error: `invalid detect rule for "${prov.oneLine(name, 60)}"` };
        software.push(sw);
    }
    seedActorGroups(row.createdBy, request.actorGroups);
    return { st: { ctx: built.ctx, software, request, actor: row.createdBy, settings: prov.loadProvisionSettings(cfg), cancelled: false } };
}

function recomputeCounts(h, id) {
    const rows = h.prepare('SELECT status, rebootRequired FROM provision_job_hosts WHERE jobId = ?').all(id);
    const okCount = rows.filter(r => r.status === 'ok').length;
    const failCount = rows.filter(r => ['failed', 'skipped', 'interrupted'].includes(r.status)).length;
    const rebootCount = rows.filter(r => r.status === 'ok' && r.rebootRequired).length;
    h.prepare('UPDATE provision_jobs SET okCount = ?, failCount = ?, rebootCount = ? WHERE id = ?').run(okCount, failCount, rebootCount, id);
    return { okCount, failCount, rebootCount };
}

// Host slots: PROVISION_HOST_CONCURRENCY applies across ALL jobs running in THIS process (one PowerShell / ssh child
// per slot). A job only runs in its owner process; with the worker as the normal owner the limit is effectively
// global. Web-fallback jobs (worker unavailable / not answering) have their own pool of the same size.
// One global limit (the latest value read from the settings at job creation). Slots are handed to waiters directly
// by releaseSlot / pumpSlots, so a wakeup can never be lost and the limit can never be overshot.
let activeHosts = 0;
let slotLimit = prov.DEFAULT_HOST_CONCURRENCY;
const slotWaiters = []; // { st, resolve }

function pumpSlots() {
    while (slotWaiters.length && activeHosts < slotLimit) {
        const w = slotWaiters.shift();
        activeHosts++;
        w.resolve(true);
    }
}
/** Resolves true when a slot was granted, false when the job was cancelled while waiting. */
function acquireSlot(st) {
    if (st.cancelled || st.lost) return Promise.resolve(false);
    return new Promise((resolve) => {
        slotWaiters.push({ st, resolve });
        pumpSlots();
    });
}
function releaseSlot() {
    activeHosts = Math.max(0, activeHosts - 1);
    pumpSlots();
}
/** A cancelled job's waiting hosts leave the slot queue at once. */
function cancelWaiters(st) {
    for (let i = slotWaiters.length - 1; i >= 0; i--) {
        if (slotWaiters[i].st === st) { const [w] = slotWaiters.splice(i, 1); w.resolve(false); }
    }
}
function setSlotLimit(n) {
    slotLimit = Math.max(1, Math.min(prov.MAX_HOST_CONCURRENCY, Number(n) || prov.DEFAULT_HOST_CONCURRENCY));
    pumpSlots();
}

// Test hook: called at the start of every terminal write attempt
const hooks = { beforeTerminalWrite: null };
const RETRY_DELAY_MS = 200;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Host-row writes of the runner are fenced on job ownership: a process that lost the job changes nothing any more
const OWNED = 'jobId IN (SELECT id FROM provision_jobs WHERE id = ? AND ownerId = ?)';
const markHostCancelled = (h, id, ip) => h.prepare(`UPDATE provision_job_hosts SET status = 'cancelled', finishedAt = ? WHERE jobId = ? AND ip = ? AND status = 'queued' AND ${OWNED}`).run(nowIso(), id, ip, id, identity.instance);

/**
 * Reads the cancel flag and the ownership of the job (indexed primary-key read). Sets st.cancelled / st.lost and
 * releases waiting hosts. Returns true when the runner must not start anything new.
 */
function refreshFlags(h, id, st) {
    try {
        const row = h.prepare('SELECT ownerId, cancelRequested FROM provision_jobs WHERE id = ?').get(id);
        if (!row || row.ownerId !== identity.instance) st.lost = true;
        else if (Number(row.cancelRequested) === 1) st.cancelled = true;
    } catch (e) { /* keep the current state; the next check or heartbeat retries */ }
    if (st.cancelled || st.lost) cancelWaiters(st);
    return !!(st.cancelled || st.lost);
}

/** One host: never throws. Any unexpected error fails only that host and the job goes on. */
async function runOneHost(h, id, st, ip) {
    const { ctx, software, request, actor } = st;
    try {
        if (refreshFlags(h, id, st)) { if (!st.lost) markHostCancelled(h, id, ip); return; }
        const granted = await acquireSlot(st);
        if (!granted) { if (!st.lost) markHostCancelled(h, id, ip); return; }
        try {
            if (refreshFlags(h, id, st)) { if (!st.lost) markHostCancelled(h, id, ip); return; }
            // atomic start: only the current owner of a job that is not being cancelled can start a queued host
            const claimed = h.prepare("UPDATE provision_job_hosts SET status = 'running', startedAt = ? WHERE jobId = ? AND ip = ? AND status = 'queued' AND jobId IN (SELECT id FROM provision_jobs WHERE id = ? AND ownerId = ? AND COALESCE(cancelRequested, 0) = 0)")
                .run(nowIso(), id, ip, id, identity.instance);
            if (Number(claimed.changes) === 0) {
                if (refreshFlags(h, id, st) && !st.lost) markHostCancelled(h, id, ip);
                return;
            }
            const r = await runners.runHost({
                ip, osType: request.osType, software, ctx,
                opts: { reboot: request.reboot, forceReinstall: request.forceReinstall === true, keepInstallers: request.keepInstallers === true, jobId: id },
                // checked before every package (Linux): local flag, then the DB flag (cancel works even if IPC is lost)
                shouldStop: () => st.cancelled || st.lost || refreshFlags(h, id, st)
            });
            const w = h.prepare("UPDATE provision_job_hosts SET status = ?, finishedAt = ?, packages = ?, rebootRequired = ?, log = ?, error = ? WHERE jobId = ? AND ip = ? AND status = 'running'")
                .run(r.ok ? 'ok' : 'failed', nowIso(), JSON.stringify(r.packages), r.rebootRequired ? 1 : 0, prov.truncateLog(r.log), r.error || null, id, ip);
            if (Number(w.changes) === 0) {
                console.error('[Provision] result of', ip, 'could not be recorded (row no longer running)');
                return;
            }
            recomputeCounts(h, id);
            // Per-host lines are batched (one notification instead of one per host)
            const okPkgs = r.packages.filter(p => p.ok).length;
            logger.auditLogBatched(actor, MODULE, `${r.ok ? 'SUCCESS' : 'FAILED'} ${ip}: ${okPkgs}/${r.packages.length} package(s) ok${r.error ? `, error: ${r.error}` : ''}`);
        } finally {
            releaseSlot();
        }
    } catch (e) {
        console.error('[Provision] host failed unexpectedly:', ip, prov.scrubSecrets(prov.oneLine(e && e.message, 200), st.ctx.secrets || []));
        try {
            h.prepare(`UPDATE provision_job_hosts SET status = 'failed', finishedAt = ?, error = COALESCE(error, 'Job runner error') WHERE jobId = ? AND ip = ? AND status IN ('queued', 'running') AND ${OWNED}`).run(nowIso(), id, ip, id, identity.instance);
            recomputeCounts(h, id);
        } catch (e2) { /* the final reconciliation in runJob handles it */ }
    }
}

async function runJob(id) {
    const st = live.get(id);
    if (!st) return;
    let h = null;
    try {
        h = getHandle();
        h.prepare("UPDATE provision_jobs SET status = 'running', startedAt = ? WHERE id = ? AND status = 'queued'").run(nowIso(), id);
        refreshFlags(h, id, st);
        const queued = h.prepare("SELECT ip FROM provision_job_hosts WHERE jobId = ? AND status = 'queued' ORDER BY rowid").all(id).map(r => r.ip);
        let next = 0;
        const worker = async () => {
            while (!st.cancelled && !st.lost && next < queued.length) await runOneHost(h, id, st, queued[next++]);
        };
        const n = Math.max(1, Math.min(queued.length || 1, prov.MAX_HOST_CONCURRENCY));
        // allSettled: finalize only after every worker has stopped
        await Promise.allSettled(Array.from({ length: n }, worker));
        if (st.lost) {
            // another process adopted the job (this one was considered gone): it owns the rows and the terminal state
            console.warn(`[Provision] Job ${id} was taken over by another process; this runner stopped without closing it.`);
            return;
        }
        reconcileLeftovers(h, id);
        await finalizeJob(id, st);
    } catch (e) {
        console.error('[Provision] job failed unexpectedly:', prov.scrubSecrets(prov.oneLine(e && e.message, 200), st.ctx.secrets || []));
        st.cancelled = true;
        cancelWaiters(st);
        try {
            h = h || getHandle();
            h.prepare(`UPDATE provision_job_hosts SET status = 'failed', finishedAt = ?, error = 'Job runner error' WHERE jobId = ? AND status IN ('queued', 'running') AND ${OWNED}`).run(nowIso(), id, id, identity.instance);
        } catch (e2) { /* nothing more to do */ }
        st.runnerError = true;
        await finalizeJob(id, st, `Job runner error: ${prov.scrubSecrets(prov.oneLine(e && e.message, 200), st.ctx.secrets || [])}`);
    } finally {
        live.delete(id);
        // never leave credentials or waiters behind
        cancelWaiters(st);
    }
}

/** Once every worker has stopped no row can legitimately be queued / running any more. */
function reconcileLeftovers(h, id) {
    const at = nowIso();
    h.prepare(`UPDATE provision_job_hosts SET status = 'cancelled', finishedAt = ? WHERE jobId = ? AND status = 'queued' AND ${OWNED}`).run(at, id, id, identity.instance);
    h.prepare(`UPDATE provision_job_hosts SET status = 'failed', finishedAt = ?, error = COALESCE(error, 'Result could not be recorded') WHERE jobId = ? AND status = 'running' AND ${OWNED}`).run(at, id, id, identity.instance);
}

/** Runs at most once per job: terminal write first (own try, retried after a pause, last resort), then audit and notification separately. */
async function finalizeJob(id, st, note) {
    if (st.finalized) return;
    st.finalized = true;
    let h = null;
    let counts = { okCount: 0, failCount: 0, rebootCount: 0 };
    let status = 'failed';
    let changed = 0;
    const writeTerminal = () => {
        if (hooks.beforeTerminalWrite) hooks.beforeTerminalWrite();
        h = h || getHandle();
        reconcileLeftovers(h, id);
        counts = recomputeCounts(h, id);
        // a cancel requested through the DB only (IPC lost) still ends as cancelled
        const flags = h.prepare('SELECT cancelRequested FROM provision_jobs WHERE id = ?').get(id);
        if (flags && Number(flags.cancelRequested) === 1) st.cancelled = true;
        status = st.runnerError ? 'failed' : st.cancelled ? 'cancelled' : counts.failCount === 0 ? 'done' : counts.okCount === 0 ? 'failed' : 'partial';
        changed = Number(h.prepare("UPDATE provision_jobs SET status = ?, finishedAt = ?, note = COALESCE(?, note) WHERE id = ? AND status IN ('queued', 'running') AND ownerId = ?").run(status, nowIso(), note || null, id, identity.instance).changes);
    };
    let written = false;
    for (let attempt = 0; attempt < 2 && !written; attempt++) {
        if (attempt > 0) await delay(RETRY_DELAY_MS);
        try { writeTerminal(); written = true; } catch (e) { console.error('[Provision] terminal write failed:', prov.oneLine(e && e.message, 200)); }
    }
    if (!written) {
        status = 'failed';
        try {
            h = h || getHandle();
            changed = Number(h.prepare("UPDATE provision_jobs SET status = 'failed', finishedAt = ?, note = COALESCE(note, 'Job runner error') WHERE id = ? AND status IN ('queued', 'running') AND ownerId = ?").run(nowIso(), id, identity.instance).changes);
        } catch (e) { console.error('[Provision] last-resort status write failed:', prov.oneLine(e && e.message, 200)); }
    }
    if (!changed) {
        // nothing closed: the job was adopted by another process meanwhile (it reports the job) or the DB is unreachable
        try {
            const row = (h || getHandle()).prepare('SELECT ownerId FROM provision_jobs WHERE id = ?').get(id);
            if (row && row.ownerId !== identity.instance) { st.lost = true; return; }
        } catch (e) { /* report below anyway */ }
    }
    let job = null;
    try { job = getJob(id, { logs: false }); } catch (e) { job = null; }
    const hostCount = job ? job.job.hostCount : st.request.ips.length;
    try {
        // no Telegram for this line: the 'Provision' summary below is the job's finish message (Started and per-host audit lines are separate Telegram messages)
        logger.auditLogFileOnly(st.actor, MODULE, `Finished ${st.request.osType} install job ${id}: ${status}, ${counts.okCount}/${hostCount} host(s) succeeded, ${counts.failCount} failed, ${counts.rebootCount} need a reboot`);
    } catch (e) { console.error('[Provision] finish audit failed:', prov.oneLine(e && e.message, 200)); }
    try {
        // same install-logging toggle as the other audit lines of this module
        if (typeof logger.isLoggingEnabledForModule === 'function' && !logger.isLoggingEnabledForModule(MODULE, st.actor)) return;
        const failedHosts = (job ? job.hosts : []).filter(x => x.status === 'failed' || x.status === 'skipped').map(x => `${x.ip}${x.error ? ` (${prov.oneLine(x.error, 80)})` : ''}`);
        logger.queueNotification(`provision-job\u0000${id}`, 'Provision', { id, status, user: st.actor, bu: st.request.buType, okCount: counts.okCount, failCount: counts.failCount, rebootCount: counts.rebootCount, failedHosts, resumed: st.resumed || 0 }, (items) => {
            const it = items[0];
            return `📦 [Server Provision] Job ${it.id} ${it.status}\n• User: ${it.user}\n• BU / template: ${it.bu}\n• OK: ${it.okCount}, Failed: ${it.failCount}, Reboot required: ${it.rebootCount}`
                + (it.resumed ? `\n• Resumed after restart (${it.resumed} host(s))` : '')
                + (it.failedHosts.length ? `\nFailed hosts:\n${logger.summarizeLines(it.failedHosts, 10)}` : '');
        });
    } catch (e) { console.error('[Provision] notification failed:', prov.oneLine(e && e.message, 200)); }
}

/** Resolves when the job runner of that job (or every runner) has finished. */
async function whenIdle(id) {
    if (id) { await runnerPromises.get(id); return; }
    while (runnerPromises.size) await Promise.all([...runnerPromises.values()]);
}

// ---------------------------------------------------------------------------------------------
// Submit (shared by POST /execute and POST /jobs/:id/retry-failed)
// ---------------------------------------------------------------------------------------------
/**
 * input = validated body ({ ips, osType, buType, reboot, forceReinstall, keepInstallers, allowUnknownTargets }); user = req.user.
 * Returns { status, body }: 202 { jobId } or an error status with { error, ... }.
 */
function submit({ user, input, installCfg, config, retryOf = null }) {
    const software = prov.resolveSoftware(installCfg, input.buType, input.osType);
    if (software.length === 0) return { status: 400, body: { error: `No software configured for template "${input.buType}" (${input.osType})` } };

    const badRule = software.find(sw => sw.detectError);
    if (badRule) return { status: 400, body: { error: `Invalid detect rule for "${badRule.name}": ${badRule.detectError}` } };

    const info = lookupTargets(input.ips);
    const unknown = input.ips.filter(ip => !info.get(ip).known);
    if (unknown.length && !input.allowUnknownTargets) {
        return { status: 400, body: { error: `Unknown target(s) (not in CMDB or inventory): ${unknown.join(', ')}`, unknownTargets: unknown } };
    }
    if (unknown.length && user.role !== 'SuperAdmin') {
        return { status: 403, body: { error: 'Only SuperAdmin may provision unknown targets', unknownTargets: unknown } };
    }

    // Settings service account (AD_ADMIN_* / LINUX_ADMIN_*), never the signed-in user's password: fail fast when missing
    const built = runners.buildContext({ osType: input.osType, config });
    if (built.error) return { status: 400, body: { error: built.error } };

    const settings = prov.loadProvisionSettings(config);
    // Every process resolves the same Settings credentials itself, so any job can run in the worker and be resumed
    const credentialSource = 'settings';
    const request = {
        ips: input.ips, osType: input.osType, buType: input.buType, reboot: input.reboot, forceReinstall: input.forceReinstall === true, keepInstallers: input.keepInstallers === true,
        softwareNames: software.map(s => s.name),
        allowUnknownTargets: unknown.length > 0, unknownIps: unknown,
        credentialSource,
        // group names only (audit-log toggle in the worker, which never sees the login)
        actorGroups: Array.isArray(user.groups) ? user.groups.slice(0, 50).map(g => String(g).slice(0, 100)) : [],
        ...(retryOf ? { retryOf } : {})
    };
    const jobId = createJob({ actor: user.username, request, software, ctx: built.ctx, hostInfo: info, settings, workerEligible: true });
    logger.auditLog(user.username, MODULE, `Started ${input.osType} install job ${jobId} (template ${input.buType}, ${software.length} package(s), ${input.ips.length} host(s), reboot: ${input.reboot}, forceReinstall: ${input.forceReinstall === true}, keepInstallers: ${input.keepInstallers === true}, run as: ${built.ctx.runAs})${retryOf ? ` retrying failed hosts of job ${retryOf}` : ''}: ${input.ips.join(', ')}`);
    if (unknown.length) logger.auditLog(user.username, MODULE, `Unknown-target override used for job ${jobId}: ${unknown.join(', ')}`);
    return { status: 202, body: { jobId } };
}

/** Cancel: no new host / package starts; a PowerShell host script already running finishes (it cannot be interrupted safely). */
function cancelJob(id, actor) {
    const h = getHandle();
    const row = h.prepare('SELECT * FROM provision_jobs WHERE id = ?').get(String(id));
    if (!row) return { status: 404, body: { error: 'Job not found' } };
    const st = live.get(row.id) || pending.get(row.id);
    if (!ACTIVE_JOB.includes(row.status)) return { status: 409, body: { error: `Job is not running (status: ${row.status})` } };
    if (!st && ownerGone(row) && tryAdopt(row)) {
        // Active in the database but its owner process is gone: take it over and release its IP locks now
        interruptJob(h, row.id, nowIso());
        logger.auditLog(actor, MODULE, `Cancelled install job ${row.id} (no live runner: marked interrupted)`);
        return { status: 200, body: { success: true, jobId: row.id, interrupted: true } };
    }
    // The flag reaches the owner even when IPC is lost: it is read before every host / package and on every heartbeat.
    // Queued hosts are closed here for any owner: starting a host requires status 'queued' and no flag (atomic).
    h.prepare('UPDATE provision_jobs SET cancelRequested = 1 WHERE id = ?').run(row.id);
    h.prepare("UPDATE provision_job_hosts SET status = 'cancelled', finishedAt = ? WHERE jobId = ? AND status = 'queued'").run(nowIso(), row.id);
    if (st) { st.cancelled = true; cancelWaiters(st); }
    else if (row.runner === 'worker') sendToWorker({ type: 'CANCEL_PROVISION_JOB', jobId: row.id });
    logger.auditLog(actor, MODULE, `Cancelled install job ${row.id}`);
    return { status: 200, body: { success: true, jobId: row.id, runner: row.runner || identity.role } };
}

/** Request of a finished job reduced to its failed / interrupted / skipped hosts. */
function retryInput(id) {
    const j = getJob(id, { logs: false });
    if (!j) return { status: 404, body: { error: 'Job not found' } };
    if (j.job.running) return { status: 409, body: { error: 'Job is still running' } };
    const ips = j.hosts.filter(x => ['failed', 'interrupted', 'skipped'].includes(x.status)).map(x => x.ip);
    if (!ips.length) return { status: 400, body: { error: 'No failed, interrupted or skipped hosts to retry' } };
    const r = j.job.request;
    return { input: { ips, osType: r.osType || 'windows', buType: r.buType || j.job.buType, reboot: r.reboot === true, forceReinstall: r.forceReinstall === true, keepInstallers: r.keepInstallers === true, allowUnknownTargets: false }, original: j.job };
}

// ---------------------------------------------------------------------------------------------
// Startup / retention
// ---------------------------------------------------------------------------------------------
/** One job (and its non-terminal hosts) -> interrupted. Returns the number of host rows changed. */
function interruptJob(h, id, at) {
    const n = Number(h.prepare("UPDATE provision_job_hosts SET status = 'interrupted', finishedAt = ?, error = COALESCE(error, 'Interrupted by a service restart') WHERE jobId = ? AND status IN ('queued', 'running')").run(at, id).changes);
    recomputeCounts(h, id);
    h.prepare("UPDATE provision_jobs SET status = 'interrupted', finishedAt = ?, note = 'Service restarted while the job was running' WHERE id = ? AND status IN ('queued', 'running')").run(at, id);
    return n;
}

// ---------------------------------------------------------------------------------------------
// Ownership: heartbeat, orphan detection, adoption, resume
// ---------------------------------------------------------------------------------------------
// Signal 0 only tests existence (Windows and POSIX); tests replace it
hooks.isPidAlive = (pid) => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};
const pidOf = (ownerId) => { const m = /^(?:web|worker):(\d+):/.exec(String(ownerId || '')); return m ? Number(m[1]) : null; };

/**
 * True when the owner of an active job row can no longer be running it, seen from THIS process:
 *  - the job is live or being dispatched here -> never gone;
 *  - never claimed (runner NULL): only the web creates jobs and every job it is dispatching is in `pending`, so an
 *    unclaimed row the web does not know is left over from a previous web process (or from before the upgrade);
 *    the worker never treats an unclaimed row as gone;
 *  - claimed by this very instance but not live here -> its runner ended without closing it;
 *  - claimed by another instance -> its pid is dead, or its heartbeat is older than staleMs.
 * heartbeatOnly ignores the pid test (web sweep of worker jobs: the worker / exit handler handle dead pids first).
 */
function ownerGone(row, { staleMs = config.staleMs, heartbeatOnly = false } = {}) {
    if (live.has(row.id) || pending.has(row.id)) return false;
    if (!row.ownerId) return identity.role === 'web';
    if (row.ownerId === identity.instance) return true;
    const pid = pidOf(row.ownerId);
    if (!heartbeatOnly && pid && !hooks.isPidAlive(pid)) return true;
    const beat = Date.parse(row.heartbeatAt || row.claimedAt || '');
    return !Number.isFinite(beat) || Date.now() - beat > staleMs;
}

/**
 * Compare-and-swap on ownerId AND the observed heartbeat: exactly one process can adopt a given owner state, and an
 * owner that heartbeats between the read and the adoption (it was only slow) keeps its job.
 */
function tryAdopt(row) {
    const at = nowIso();
    return Number(getHandle().prepare("UPDATE provision_jobs SET runner = ?, ownerId = ?, claimedAt = ?, heartbeatAt = ? WHERE id = ? AND status IN ('queued', 'running') AND COALESCE(ownerId, '') = ? AND COALESCE(heartbeatAt, '') = ?")
        .run(identity.role, identity.instance, at, at, row.id, row.ownerId || '', row.heartbeatAt || '').changes) === 1;
}

/**
 * Active jobs whose owner is gone and that THIS process may adopt:
 *  - pid given (supervisor exit handler, web): the worker jobs of that exited worker process;
 *  - worker: worker-owned jobs (startup and sweep);
 *  - web: unclaimed / web-owned jobs; worker-owned ones only in the periodic sweep and only with a heartbeat older
 *    than webStaleWorkerMs (normally the worker itself, or the exit handler, recovers them first).
 */
function orphanCandidates(h, { startup = false, pid = null } = {}) {
    const rows = h.prepare("SELECT * FROM provision_jobs WHERE status IN ('queued', 'running') ORDER BY rowid").all();
    return rows.filter((row) => {
        if (live.has(row.id) || pending.has(row.id)) return false;
        if (pid !== null && pid !== undefined) return identity.role === 'web' && row.runner === 'worker' && pidOf(row.ownerId) === pid;
        if (identity.role === 'worker') return row.runner === 'worker' && ownerGone(row);
        if (row.runner === 'worker') return !startup && ownerGone(row, { staleMs: config.webStaleWorkerMs, heartbeatOnly: true });
        return ownerGone(row);
    });
}

/** Legacy helper: every orphan in this process's scope -> interrupted (no resume). Live / dispatched jobs are left alone. */
function markInterrupted() {
    const h = getHandle();
    const at = nowIso();
    let jobs = 0;
    let hosts = 0;
    for (const row of orphanCandidates(h, { startup: true })) {
        if (!tryAdopt(row)) continue;
        jobs++;
        hosts += interruptJob(h, row.id, at);
    }
    return { jobs, hosts };
}

/**
 * Adopts every orphan in scope and recovers it (see recoverAdopted). Synchronous up to the start of resumed runners.
 * Returns { jobs, resumed, closed }.
 */
function recoverOrphans(opts = {}) {
    const h = getHandle();
    const out = { jobs: 0, resumed: 0, closed: 0 };
    for (const row of orphanCandidates(h, opts)) {
        if (!tryAdopt(row)) continue; // another process adopted it first
        out.jobs++;
        try {
            if (recoverAdopted(h, row) === 'resumed') out.resumed++; else out.closed++;
        } catch (e) {
            console.error('[Provision] recovery of job', row.id, 'failed:', prov.oneLine(e && e.message, 200));
            try { interruptJob(h, row.id, nowIso()); } catch (e2) { /* the next sweep adopts it again (we own it, not live) */ }
        }
    }
    return out;
}

/**
 * Called by the adopter only. Rules:
 *  1. running hosts -> interrupted (half-done: never re-run automatically);
 *  2. cancelRequested -> queued hosts cancelled, job cancelled;
 *  3. already resumed MAX_RESUMES time(s) -> queued hosts interrupted (no restart loops);
 *  4. credentials / software cannot be resolved here -> queued hosts interrupted with the reason;
 *  5. otherwise known-target and per-IP lock re-check (failures -> skipped with the reason), resumeCount + 1,
 *     note + audit, and the remaining queued hosts run again in this process with the same request / options.
 */
function recoverAdopted(h, row) {
    const id = row.id;
    const at = nowIso();
    const interrupted = Number(h.prepare("UPDATE provision_job_hosts SET status = 'interrupted', finishedAt = ?, error = COALESCE(error, ?) WHERE jobId = ? AND status = 'running'").run(at, HALF_DONE, id).changes);
    const flags = h.prepare('SELECT cancelRequested, resumeCount FROM provision_jobs WHERE id = ?').get(id) || {};
    const queuedIps = () => h.prepare("SELECT ip FROM provision_job_hosts WHERE jobId = ? AND status = 'queued' ORDER BY rowid").all(id).map(r => r.ip);
    const closeQueued = (status, reason) => h.prepare("UPDATE provision_job_hosts SET status = ?, finishedAt = ?, error = COALESCE(error, ?) WHERE jobId = ? AND status = 'queued'").run(status, at, reason, id);

    if (Number(flags.cancelRequested) === 1) {
        closeQueued('cancelled', null);
        return closeRecovered(h, row, { cancelled: true, interrupted });
    }
    let reason = null;
    let plan = null;
    if (queuedIps().length) {
        if ((Number(flags.resumeCount) || 0) >= MAX_RESUMES) reason = 'Not resumed after a restart: the job was already resumed once';
        else {
            plan = buildRunPlan(row);
            if (plan.error) { reason = `Not resumed after a restart: ${plan.error}`; plan = null; }
        }
    }
    if (!plan) {
        if (reason) closeQueued('interrupted', reason);
        return closeRecovered(h, row, { interrupted });
    }
    // the target list is re-checked live: deleted / unknown hosts (unless overridden at submit) and hosts another job holds are skipped
    const req = plan.st.request;
    const ips = queuedIps();
    const info = lookupTargets(ips);
    for (const ip of ips) {
        const t = info.get(ip);
        const overridden = req.allowUnknownTargets === true && Array.isArray(req.unknownIps) && req.unknownIps.includes(ip);
        let skip = null;
        if (!(t && t.known) && !overridden) skip = 'Skipped on resume: no longer a known target (not in CMDB or Server Inventory)';
        else {
            const owner = activeJobForIp(ip, id);
            if (owner) skip = `Skipped on resume: already being provisioned by job ${owner}`;
        }
        if (skip) h.prepare("UPDATE provision_job_hosts SET status = 'skipped', startedAt = COALESCE(startedAt, ?), finishedAt = ?, error = ?, log = ? WHERE jobId = ? AND ip = ? AND status = 'queued'").run(at, at, skip, skip, id, ip);
    }
    const remaining = queuedIps().length;
    if (!remaining) return closeRecovered(h, row, { interrupted });
    const note = `Resumed after restart (${remaining} host(s)${interrupted ? `, ${interrupted} interrupted` : ''})`;
    h.prepare('UPDATE provision_jobs SET resumeCount = COALESCE(resumeCount, 0) + 1, note = ? WHERE id = ? AND ownerId = ?').run(note, id, identity.instance);
    recomputeCounts(h, id);
    try {
        logger.auditLog('SYSTEM', MODULE, `Resumed install job ${id} after a restart in the ${identity.role} process: ${remaining} queued host(s) run again${interrupted ? `, ${interrupted} half-done host(s) marked interrupted` : ''}`);
    } catch (e) { console.error('[Provision] resume audit failed:', prov.oneLine(e && e.message, 200)); }
    plan.st.resumed = remaining;
    track(id, launch(id, plan.st).catch(e => console.error('[Provision] job runner failed:', e && e.message)));
    return 'resumed';
}

/** Terminal state of an adopted job that is not resumed. */
function closeRecovered(h, row, { cancelled = false, interrupted = 0 } = {}) {
    const id = row.id;
    const counts = recomputeCounts(h, id);
    const anyInterrupted = Number(h.prepare("SELECT COUNT(*) AS c FROM provision_job_hosts WHERE jobId = ? AND status = 'interrupted'").get(id).c) > 0;
    const status = cancelled ? 'cancelled' : anyInterrupted ? 'interrupted' : counts.failCount === 0 ? 'done' : counts.okCount === 0 ? 'failed' : 'partial';
    const note = cancelled ? 'Cancelled while the runner was stopped (service restart)' : 'Service restarted while the job was running';
    h.prepare("UPDATE provision_jobs SET status = ?, finishedAt = ?, note = COALESCE(note, ?) WHERE id = ? AND status IN ('queued', 'running') AND ownerId = ?").run(status, nowIso(), note, id, identity.instance);
    try {
        logger.auditLog('SYSTEM', MODULE, `Install job ${id} closed after a restart: ${status} (${counts.okCount} ok, ${counts.failCount} failed / skipped / interrupted${interrupted ? `, ${interrupted} half-done host(s) interrupted` : ''})`);
    } catch (e) { console.error('[Provision] recovery audit failed:', prov.oneLine(e && e.message, 200)); }
    return status;
}

/** Owner heartbeat (every heartbeatMs while this process runs jobs); also picks up DB-only cancels and lost ownership. */
let heartbeatTimer = null;
function startHeartbeat() {
    if (heartbeatTimer || !config.heartbeatMs) return;
    heartbeatTimer = setInterval(beat, config.heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
}
function beat() {
    if (!live.size) {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        return;
    }
    let h;
    try { h = getHandle(); } catch (e) { return; }
    const at = nowIso();
    for (const [id, st] of live) {
        try {
            h.prepare("UPDATE provision_jobs SET heartbeatAt = ? WHERE id = ? AND ownerId = ? AND status IN ('queued', 'running')").run(at, id, identity.instance);
            refreshFlags(h, id, st);
        } catch (e) { console.error('[Provision] heartbeat failed:', prov.oneLine(e && e.message, 200)); }
    }
}

let sweepTimer = null;
function startSweep(ms) {
    if (sweepTimer || !ms) return;
    sweepTimer = setInterval(() => {
        try {
            const r = recoverOrphans({});
            if (r.jobs) console.log(`[Provision] Took over ${r.jobs} orphaned job(s) (${r.resumed} resumed).`);
        } catch (e) { console.error('[Provision] orphan sweep failed:', prov.oneLine(e && e.message, 200)); }
    }, ms);
    if (sweepTimer.unref) sweepTimer.unref();
}

const yieldTurn = () => new Promise(r => setImmediate(r));

/** Deletes finished jobs (and their hosts) older than the retention window in LIMIT-bounded batches. */
async function cleanup({ retentionDays = prov.DEFAULT_RETENTION_DAYS, batchSize = CLEANUP_BATCH, now = Date.now() } = {}) {
    const h = getHandle();
    const cutoff = new Date(now - prov.clampInt(retentionDays, prov.DEFAULT_RETENTION_DAYS, 1, 36500) * DAY_MS).toISOString();
    const out = { jobs: 0, hosts: 0 };
    for (;;) {
        const ids = h.prepare(`SELECT id FROM provision_jobs WHERE createdAt < ? AND status NOT IN ('queued', 'running') ORDER BY createdAt LIMIT ?`).all(cutoff, batchSize).map(r => r.id);
        if (!ids.length) break;
        const marks = ids.map(() => '?').join(',');
        out.hosts += Number(h.prepare(`DELETE FROM provision_job_hosts WHERE jobId IN (${marks})`).run(...ids).changes);
        out.jobs += Number(h.prepare(`DELETE FROM provision_jobs WHERE id IN (${marks})`).run(...ids).changes);
        if (ids.length < batchSize) break;
        await yieldTurn();
    }
    // hosts whose job row is already gone (e.g. an earlier crash between the two deletes)
    for (;;) {
        const n = Number(h.prepare('DELETE FROM provision_job_hosts WHERE rowid IN (SELECT hh.rowid FROM provision_job_hosts hh LEFT JOIN provision_jobs j ON j.id = hh.jobId WHERE j.id IS NULL LIMIT ?)').run(batchSize).changes);
        out.hosts += n;
        if (n < batchSize) break;
        await yieldTurn();
    }
    return out;
}

/** Startup recovery of this process's orphans; a failure would leave stale per-IP locks: retried up to 3 times. */
function recoverAtStartup(retryDelayMs, attempt = 1) {
    try {
        const r = recoverOrphans({ startup: true });
        if (r.jobs) console.log(`[Provision] ${identity.role}: recovered ${r.jobs} job(s) left over from the previous run (${r.resumed} resumed, ${r.closed} closed).`);
    } catch (e) {
        console.error(`[Provision] startup recovery failed (attempt ${attempt}/3):`, e.message);
        if (attempt < 3) { const t = setTimeout(() => recoverAtStartup(retryDelayMs, attempt + 1), retryDelayMs); if (t.unref) t.unref(); }
    }
}

let workerInitDone = false;
/** Worker process: role, ready for RUN_PROVISION_JOB, recovery of worker-owned orphans, periodic sweep. Never throws. */
function initWorker({ sweepMs = config.sweepMs, retryDelayMs = 5000 } = {}) {
    if (workerInitDone) return true;
    setRole('worker');
    try { getHandle(); } catch (e) {
        console.error('[Provision] tables unavailable in the worker:', e.message);
        const t = setTimeout(() => { initWorker({ sweepMs, retryDelayMs }); }, retryDelayMs);
        if (t.unref) t.unref();
        return false;
    }
    workerInitDone = true;
    workerReady = true;
    recoverAtStartup(retryDelayMs);
    startSweep(sweepMs);
    return true;
}

let cleanupTimer = null;
/** Web process: recovers its orphans now (resume / interrupt), orphan sweep, one cleanup shortly after start, then once per day. Never throws. */
let initDone = false;
function init({ readConfig, firstDelayMs = 30 * 1000, retryDelayMs = 5000, sweepMs = config.sweepMs } = {}) {
    // run-once: a second call must never touch live jobs
    if (initDone) return true;
    try { getHandle(); } catch (e) {
        console.error('[Provision] tables unavailable:', e.message);
        const t = setTimeout(() => { init({ readConfig, firstDelayMs, retryDelayMs, sweepMs }); }, retryDelayMs);
        if (t.unref) t.unref();
        return false;
    }
    initDone = true;
    recoverAtStartup(retryDelayMs);
    startSweep(sweepMs);
    if (cleanupTimer) return true;
    const tick = async () => {
        try {
            const settings = prov.loadProvisionSettings(readConfig ? (await readConfig()) : {});
            const res = await cleanup({ retentionDays: settings.historyRetentionDays });
            if (res.jobs || res.hosts) console.log(`[Provision] History cleanup removed ${res.jobs} job(s) and ${res.hosts} host row(s).`);
        } catch (e) { console.error('[Provision] History cleanup failed:', e.message); }
    };
    const first = setTimeout(() => { tick(); }, firstDelayMs);
    if (first.unref) first.unref();
    cleanupTimer = setInterval(tick, DAY_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();
    return true;
}

module.exports = {
    ensureTables, getHandle, lookupTargets, listTargets, activeJobForIp, listJobs, getJob, createJob, submit, cancelJob, retryInput,
    markInterrupted, recoverOrphans, cleanup, init, initWorker, whenIdle, ACTIVE_JOB, FINISHED_JOB,
    setRole, onWorkerMessage, onWorkerGone, handleWorkerMessage,
    _live: live, _hooks: hooks, _config: config, _beat: beat, _tryAdopt: tryAdopt, _identity: identity
};
