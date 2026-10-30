/**
 * Inventory scan status shared between the worker (the only writer) and the web process (reader).
 * Lives in document_store `server_operation/inventory_scan_status.json`; the web process reads it straight from the
 * shared database (like backupService.readLastResult) because its RAM document cache may not see worker writes.
 */
const STATUS_KEY = 'server_operation/inventory_scan_status.json';
/** A "running" status older than this is treated as dead (worker crashed mid-scan). */
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
/** The worker refreshes updatedAt at least every HEARTBEAT_MS while scanning; no refresh for HEARTBEAT_TIMEOUT_MS means the worker is gone. */
const HEARTBEAT_MS = 30 * 1000;
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

async function readStatus() {
    try {
        const row = await require('./scoutDb').get('SELECT value FROM document_store WHERE "key" = ?', [STATUS_KEY]);
        if (!row || !row.value) return {};
        try { return JSON.parse(row.value) || {}; } catch (e) { return {}; }
    } catch (e) {
        const { readDataSync } = require('../lib/db');
        const v = readDataSync(STATUS_KEY, null);
        return v && typeof v === 'object' ? v : {};
    }
}

/** Persists the status doc; resolves once it is in the shared document_store. */
async function writeStatus(doc) {
    const value = JSON.stringify(doc);
    require('../lib/db').writeDataSync(STATUS_KEY, value);
    await require('./db').upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: STATUS_KEY, value, updatedAt: new Date().toISOString() } });
}

/**
 * True when the doc describes a scan that has not finished, started less than STALE_RUNNING_MS ago (hard cap)
 * and was refreshed (updatedAt, falling back to startedAt for old docs) within HEARTBEAT_TIMEOUT_MS.
 */
function isStatusRunning(doc, nowMs = Date.now()) {
    if (!doc || !doc.running || !doc.startedAt || doc.finishedAt) return false;
    const started = new Date(doc.startedAt).getTime();
    if (!Number.isFinite(started) || nowMs - started >= STALE_RUNNING_MS) return false;
    const updated = doc.updatedAt ? new Date(doc.updatedAt).getTime() : started;
    return Number.isFinite(updated) && nowMs - updated < HEARTBEAT_TIMEOUT_MS;
}

function isStatusStale(doc, nowMs = Date.now()) {
    return !!(doc && doc.running && doc.startedAt && !doc.finishedAt && !isStatusRunning(doc, nowMs));
}

/** Shape returned by GET /scan-status (legacy field names kept for the UI, plus the new shared-status fields). */
function toApiStatus(doc, nowMs = Date.now()) {
    const d = doc || {};
    const running = isStatusRunning(d, nowMs);
    const totalIps = Number(d.totalIps) || 0;
    const processedIps = Number(d.processedIps) || 0;
    const startedMs = d.startedAt ? new Date(d.startedAt).getTime() : NaN;
    const endMs = running || !d.finishedAt ? nowMs : new Date(d.finishedAt).getTime();
    const elapsed = Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - startedMs) / 1000)) : 0;
    const logs = Array.isArray(d.logs) ? d.logs.slice(-30) : [];
    const progress = totalIps > 0 ? Math.min(100, Math.round((processedIps / totalIps) * 100)) : 0;
    return {
        running,
        stale: isStatusStale(d, nowMs),
        runId: d.runId || null,
        trigger: d.trigger || null,
        requestedBy: d.requestedBy || null,
        scope: d.scope || null,
        startedAt: d.startedAt || null,
        finishedAt: d.finishedAt || null,
        aborted: !!d.aborted,
        abortRequested: running && !!d.abortRequested,
        degraded: !!d.degraded,
        interrupted: !!d.interrupted,
        error: d.error || null,
        lastSkipped: d.lastSkipped || null,
        updatedAt: d.updatedAt || null,
        currentIp: running ? (d.currentIp || '') : '',
        currentSubnet: running && Array.isArray(d.activeSubnets) ? d.activeSubnets.join(', ') : '',
        subnets: Array.isArray(d.subnets) ? d.subnets : [],
        subnetProgress: `${Number(d.totalSubnets) || (Array.isArray(d.subnets) ? d.subnets.length : 0)} Subnets Total`,
        ipProgress: `${processedIps} / ${totalIps} IPs`,
        processedIps,
        totalIps,
        overallProgress: running ? progress : (d.finishedAt ? 100 : 0),
        discovered: Number(d.discovered) || 0,
        elapsed,
        logs,
        schedule: d.schedule || null,
        nextRunAt: (d.schedule && d.schedule.nextRunAt) || null
    };
}

/**
 * Worker-side owner of the status document: keeps the doc in memory (single writer), merges patches and
 * persists them in order. Persist failures are logged, never thrown.
 */
function createStatusWriter({ read = readStatus, write = writeStatus, now = () => new Date(), delay = (ms) => new Promise(r => setTimeout(r, ms)), attempts = 3 } = {}) {
    let doc = null;
    let chain = Promise.resolve();
    async function load() {
        if (!doc) doc = await read();
        return doc;
    }
    return {
        async get() { return { ...(await load()) }; },
        /** touch=false keeps the stored updatedAt (info-only writes must not revive the liveness of a dead run). */
        update(patch, { touch = true } = {}) {
            chain = chain.then(async () => {
                await load();
                doc = { ...doc, ...patch, ...(touch || !doc.updatedAt ? { updatedAt: now().toISOString() } : {}) };
                let lastErr = null;
                for (let i = 1; i <= attempts; i++) {
                    try { await write(doc); lastErr = null; break; } catch (e) {
                        lastErr = e;
                        if (i < attempts) await delay(200 * i);
                    }
                }
                if (lastErr) throw lastErr;
            }).catch(e => { console.error('[Inventory] Cannot persist scan status:', e.message); });
            return chain;
        },
        flush() { return chain; }
    };
}

module.exports = { createStatusWriter, STATUS_KEY, STALE_RUNNING_MS, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, readStatus, writeStatus, isStatusRunning, isStatusStale, toApiStatus };
