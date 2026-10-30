/**
 * SSL Monitor service: certificate store helpers, the scan engine and the daily scheduler (started in worker.js).
 *
 * Scan (scheduler, POST /api/ssl/check-all, scheduler "run now" — one code path, any process):
 *   0. a cross-process lease (network_service/ssl_scan_lock.json { owner, until }) taken through
 *      docStore.mutateDocument: a second scan is refused while one runs (stale lease > 15 min is taken over);
 *   a. snapshot of the targets: { id, host, port } of every probed record (file-only records are never probed,
 *      only file-only records wiped by the old bug are re-parsed from their stored certificate);
 *   b. probes with bounded concurrency (5), per-probe timeout 8 s and an overall deadline (10 min): targets not
 *      reached before the deadline are "not checked this run" (left untouched);
 *   c. ONE mutateDocument merging results by id into the CURRENT document: only probe-owned fields are written,
 *      records deleted meanwhile stay deleted, records added meanwhile / user edits are untouched, a record whose
 *      host / port changed meanwhile ignores the stale result. daysRemaining / status are recomputed for every
 *      record and the alert state machine (sslCore.decideAlerts) runs inside the same transaction, so concurrent
 *      or repeated scans never send the same alert twice. Alerts are sent after the commit.
 */
const { appendLog } = require('../lib/logger');
const { readDataSync } = require('../lib/db');
const { mutateDocument } = require('../lib/docStore');
const { decryptText } = require('../lib/crypto');
const core = require('../lib/sslCore');
const crypto = require('crypto');

const SSL_KEY = 'network_service/ssl_certificates.json';
const SSL_REVISION_KEY = 'network_service/ssl_certificates.revision.json';
const LOCK_KEY = 'network_service/ssl_scan_lock.json';
const LOCK_REVISION_KEY = 'network_service/ssl_scan_lock.revision.json';
const LEASE_MS = 15 * 60 * 1000;
const SCAN_DEADLINE_MS = 10 * 60 * 1000;
const SCAN_CONCURRENCY = 5;

// ---------------------------------------------------------------- store
/** Records for READ-ONLY use (RAM cache allowed). */
function readRecords() {
    const v = readDataSync(SSL_KEY, []);
    return Array.isArray(v) ? v : [];
}

/** Atomic read-modify-write of the certificate list (fn synchronous, mutates in place). */
function mutateRecords(fn, reason) {
    return mutateDocument(SSL_KEY, fn, { fallbackRevisionKey: SSL_REVISION_KEY, defaultValue: [], fnName: 'sslMonitor.mutateRecords', label: 'SSL', reason });
}

const mutateLock = (fn) => mutateDocument(LOCK_KEY, fn, { fallbackRevisionKey: LOCK_REVISION_KEY, defaultValue: {}, fnName: 'sslMonitor.lease', label: 'SSL lease' });
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- record field writers
/** Writes the certificate fields of a parse / probe result (never touches name, env, secrets, ...). */
function applyCertInfo(record, info) {
    for (const f of ['subject', 'issuer', 'validFrom', 'validTo', 'notBefore', 'notAfter', 'fingerprint256']) {
        if (info[f] !== undefined) record[f] = info[f];
    }
    if (info.subjectDN !== undefined) record.subjectDN = info.subjectDN;
    if (info.issuerDN !== undefined) record.issuerDN = info.issuerDN;
    if (Array.isArray(info.san)) record.san = info.san;
}

/** Probe-owned fields of one probe result. */
function applyProbeResult(record, result, now = new Date()) {
    record.lastCheck = now.toISOString();
    if (result && result.success) {
        applyCertInfo(record, result);
        record.trusted = !!result.trusted;
        record.trustError = result.trustError || '';
        record.hostnameChecked = !!result.hostnameChecked;
        record.error = '';
        record.lastSuccessAt = now.toISOString();
    } else {
        record.error = (result && result.error) || 'Probe failed';
    }
    delete record.notCheckedAt;
}

/** Recomputes the stored daysRemaining / status (kept for old readers; reads recompute anyway). */
function refreshStatus(record, now, threshold) {
    const s = core.computeStatus(record, now, threshold);
    record.daysRemaining = s.daysRemaining;
    record.status = s.status;
    if (s.status === 'error' && !record.error) record.error = core.isFileOnly(record) ? 'No certificate data: the stored certificate could not be read' : 'No certificate data';
    return s;
}

// ---------------------------------------------------------------- file-only repair
/** File-only record whose data were wiped by the old bug (no usable expiry) but whose certificate is stored. */
function needsRepair(record) {
    if (!core.isFileOnly(record)) return false;
    if (core.daysUntil(core.expiryOf(record), new Date()) !== null) return false;
    if (record.repairAttemptedAt) return false; // re-parsed once already
    return !!(record.encryptedFile || (record.certText && String(record.certText).trim()));
}

/** Re-parses the stored certificate (PEM/DER in Node, PFX through the safe PowerShell path). */
async function reparseStored(snap) {
    if (snap.encryptedFile) {
        const b64 = decryptText(snap.encryptedFile);
        if (!b64) return { success: false, error: 'Stored certificate file could not be decrypted' };
        const decoded = core.decodeUpload(b64, snap.uploadedFileType || 'PEM');
        if (decoded.error) return { success: false, error: decoded.error };
        const pass = snap.encryptedPass ? decryptText(snap.encryptedPass) : '';
        return core.parseUpload(decoded, pass);
    }
    return core.parseX509(snap.certText);
}

// ---------------------------------------------------------------- lease
function newOwner() {
    return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Takes the scan lease; returns false when another live scan holds it. */
function acquireLease(owner, nowMs = Date.now()) {
    return mutateLock((doc) => {
        if (doc.owner && Number(doc.until) > nowMs && doc.owner !== owner) return false;
        if (doc.owner && doc.owner !== owner) doc.takenOverFrom = doc.owner; // stale lease
        else delete doc.takenOverFrom;
        doc.owner = owner;
        doc.until = nowMs + LEASE_MS;
        doc.startedAt = new Date(nowMs).toISOString();
        return true;
    });
}

function releaseLease(owner, lastResult) {
    return mutateLock((doc) => {
        if (doc.owner !== owner) return false;
        doc.owner = '';
        doc.until = 0;
        doc.finishedAt = new Date().toISOString();
        if (lastResult !== undefined) doc.lastResult = lastResult;
        return true;
    });
}

/** { running, startedAt, finishedAt, lastResult } — read inside the lock (fresh across processes). */
function getScanStatus(nowMs = Date.now()) {
    const doc = mutateLock((d) => clone(d));
    const running = !!doc.owner && Number(doc.until) > nowMs;
    return { running, startedAt: doc.startedAt || null, finishedAt: doc.finishedAt || null, lastResult: doc.lastResult || null };
}

// ---------------------------------------------------------------- alerts
function alertMessage(record, ev) {
    const where = core.isFileOnly(record) ? `File: ${record.uploadedFileName || record.name || record.id}` : `Domain: ${record.host}:${record.port}`;
    const days = record.daysRemaining;
    if (ev.type === 'expiry') {
        const tag = days <= 7 ? '🚨 [CRITICAL]' : '⚠️ [WARNING]';
        return `${tag} SSL Certificate Expiration Notice\n\n` +
            `Name: ${record.name}\n${where}\nSubject: ${record.subject}\nIssuer: ${record.issuer}\n` +
            `Expiration Date: ${record.validTo}\nDays Remaining: ${days} Days!\n\n` +
            'Please renew or update the certificate immediately in the Operations System portal.';
    }
    if (ev.type === 'expired') {
        return '🚨 [EXPIRED] SSL Certificate Expired\n\n' +
            `Name: ${record.name}\n${where}\nSubject: ${record.subject}\nIssuer: ${record.issuer}\n` +
            `Expired On: ${record.validTo}\n\nThe certificate is no longer valid. Replace it immediately.`;
    }
    if (ev.type === 'error') {
        return '❌ [SSL Monitor Probe Error]\n\n' +
            `Name: ${record.name}\n${where}\nError: ${record.error}\nFailed scans in a row: ${record.failCount}\n` +
            'Please verify if the target host is reachable or DNS resolution is working.';
    }
    return '✅ [SSL Monitor Recovered]\n\n' +
        `Name: ${record.name}\n${where}\nThe certificate endpoint answers again (expires ${record.validTo}, ${days} days remaining).`;
}

// ---------------------------------------------------------------- scan engine
/** Runs fn over items with at most `limit` in flight; items not started before `deadline` get { notChecked }. */
async function runPool(items, limit, deadline, fn) {
    const results = new Map();
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const item = items[next++];
            if (Date.now() >= deadline) { results.set(item.id, { notChecked: true }); continue; }
            let timer;
            const remaining = Math.max(0, deadline - Date.now());
            const overall = new Promise((resolve) => { timer = setTimeout(() => resolve({ notChecked: true }), remaining); });
            try {
                results.set(item.id, await Promise.race([Promise.resolve().then(() => fn(item)).catch((e) => ({ success: false, error: e.message })), overall]));
            } finally {
                clearTimeout(timer);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * One scan (the caller holds the lease). opts: { trigger, user, concurrency, deadlineMs }.
 * Returns the summary stored as lastResult.
 */
async function runScan(opts = {}) {
    const startedAt = new Date();
    const deadline = Date.now() + (opts.deadlineMs || SCAN_DEADLINE_MS);
    const threshold = core.thresholdDays();

    // (a) snapshot of the targets, from the current document
    const snapshot = mutateRecords((records) => clone(records));
    const targets = [];
    for (const r of snapshot) {
        if (!r || !r.id) continue;
        if (!core.isFileOnly(r)) targets.push({ id: r.id, kind: 'probe', host: r.host, port: r.port || core.DEFAULT_PORT });
        else if (needsRepair(r)) {
            targets.push({ id: r.id, kind: 'repair', encryptedFile: r.encryptedFile || '', encryptedPass: r.encryptedPass || '', certText: r.certText || '', uploadedFileType: r.uploadedFileType || '' });
        }
    }

    // (b) probes / re-parses
    const results = await runPool(targets, opts.concurrency || SCAN_CONCURRENCY, deadline, (t) => (
        t.kind === 'probe' ? core.hooks.probe(t.host, t.port) : reparseStored(t)
    ));
    const byId = new Map(targets.map(t => [t.id, t]));
    const inSnapshot = new Set(snapshot.filter(r => r && r.id).map(r => r.id));

    // (c) merge into the CURRENT document + alert state (one transaction)
    const now = new Date();
    const merged = mutateRecords((records) => {
        const out = { checked: 0, failed: 0, notChecked: 0, repaired: 0, repairFailed: 0, warning: 0, expired: 0, error: 0, events: [] };
        for (const record of records) {
            if (!record || !record.id) continue;
            if (!inSnapshot.has(record.id)) continue; // added during the scan: left untouched (next scan)
            const t = byId.get(record.id);
            const res = t ? results.get(record.id) : undefined;
            if (res && res.notChecked) {
                out.notChecked++;
                record.notCheckedAt = now.toISOString(); // marker only: status / alert state unchanged
                continue;
            }
            let probed = false;
            let probeFailed = false;
            if (t && t.kind === 'probe' && res) {
                // a host / port edited during the scan: the result belongs to the old endpoint
                if (!core.isFileOnly(record) && record.host === t.host && Number(record.port || core.DEFAULT_PORT) === Number(t.port)) {
                    applyProbeResult(record, res, now);
                    probed = true;
                    probeFailed = !res.success;
                    out.checked++;
                    if (probeFailed) out.failed++;
                }
            } else if (t && t.kind === 'repair' && res) {
                const sameMaterial = (record.encryptedFile || '') === t.encryptedFile && (record.certText || '') === t.certText;
                if (sameMaterial && core.isFileOnly(record)) {
                    record.repairAttemptedAt = now.toISOString();
                    if (res.success) {
                        applyCertInfo(record, res);
                        record.error = '';
                        out.repaired++;
                    } else {
                        record.error = `Stored certificate could not be parsed: ${res.error}`;
                        out.repairFailed++;
                    }
                }
            }
            const s = refreshStatus(record, now, threshold);
            if (s.status === 'warning') out.warning++;
            else if (s.status === 'expired') out.expired++;
            else if (s.status === 'error') out.error++;

            const decision = core.decideAlerts(record.alertState, record.failCount, {
                days: s.status === 'error' ? null : s.daysRemaining,
                expiry: core.expiryOf(record),
                threshold, probed, probeFailed, now,
            });
            record.alertState = decision.alertState;
            if (probed) record.failCount = decision.failCount;
            for (const ev of decision.events) out.events.push({ ev, record: clone(record) });
        }
        return out;
    }, 'scan merge');

    // alerts AFTER the commit (state already recorded: at most once)
    let alertsSent = 0;
    for (const { ev, record } of merged.events) {
        try { await core.hooks.sendAlert(alertMessage(record, ev), 'SSL Monitor'); alertsSent++; }
        catch (e) { appendLog(`[SSL Service] Alert for ${record.name} could not be sent: ${e.message}`); }
    }
    const summary = {
        trigger: opts.trigger || 'scheduled',
        user: opts.user || 'System',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        targets: targets.length,
        checked: merged.checked,
        failed: merged.failed,
        notChecked: merged.notChecked,
        repaired: merged.repaired,
        repairFailed: merged.repairFailed,
        warning: merged.warning,
        expired: merged.expired,
        error: merged.error,
        alerts: alertsSent,
    };
    appendLog(`[SSL Service] Scan finished (${summary.trigger}): ${summary.checked} checked, ${summary.failed} failed, ${summary.notChecked} not checked, ${summary.alerts} alert(s).`);
    if (merged.warning + merged.expired > 0) {
        try { require('../lib/websocket').broadcastEvent('SSL_EXPIRING_WARNING', { warningsCount: merged.warning + merged.expired }); } catch (e) { /* no websocket in this process */ }
    }
    return summary;
}

/** Runs a scan under an already-acquired lease and always releases it. */
async function runScanWithLease(owner, opts = {}) {
    let result;
    try {
        result = await runScan(opts);
        return result;
    } catch (e) {
        result = { trigger: opts.trigger || 'scheduled', error: e.message, finishedAt: new Date().toISOString() };
        throw e;
    } finally {
        try { releaseLease(owner, result); } catch (e) { appendLog(`[SSL Service] Scan lease could not be released: ${e.message}`); }
    }
}

/**
 * Starts a scan in the background (POST /check-all). Returns { started: true, startedAt } or { running: true }
 * when another scan (any process) holds the lease. opts.onDone(promise) is for tests.
 */
function startBackgroundScan(opts = {}) {
    const owner = newOwner();
    if (!acquireLease(owner)) return { running: true };
    const p = runScanWithLease(owner, { ...opts, trigger: opts.trigger || 'manual' })
        .catch((err) => { console.error('[SSL Service Error]', err); });
    if (typeof opts.onDone === 'function') opts.onDone(p);
    return { started: true, startedAt: new Date().toISOString() };
}

/** Scheduler / startup / scheduler "run now": skips when disabled or when a scan is already running. */
async function runSSLCheck(opts = {}) {
    const isEnabled = process.env.APP_ENABLE_SSL_MONITOR !== 'false';
    if (!isEnabled) {
        appendLog('[SSL Service] Background SSL Monitor is disabled.');
        return { skipped: 'disabled' };
    }
    const owner = newOwner();
    if (!acquireLease(owner)) {
        appendLog('[SSL Service] Scan already in progress. Skipping overlapping run.');
        return { skipped: 'running' };
    }
    appendLog('[SSL Service] Starting background SSL/TLS certificate scan...');
    return runScanWithLease(owner, { trigger: opts.trigger || 'scheduled', user: opts.user });
}

let sslSchedulerTask = null;
let lastSslTickMinute = -1;

// Initialize Scheduler
function initSSLMonitorScheduler() {
    // Run once at startup after a short delay (10 seconds); state-based alert dedupe means it only alerts on real changes
    setTimeout(() => {
        runSSLCheck({ trigger: 'startup' }).catch(err => console.error('[SSL Service Error]', err));
    }, 10000);

    if (sslSchedulerTask) {
        clearInterval(sslSchedulerTask);
    }

    // native OS time polling engine running check every 10 seconds
    sslSchedulerTask = setInterval(() => {
        const scanTime = process.env.SSL_MONITOR_SCAN_TIME || '04:00';
        const [hh, mm] = scanTime.split(':');
        const targetH = parseInt(hh, 10);
        const targetM = parseInt(mm, 10);

        const now = new Date();
        const currentH = now.getHours();
        const currentM = now.getMinutes();

        if (currentH === targetH && currentM === targetM && lastSslTickMinute !== currentM) {
            lastSslTickMinute = currentM;
            runSSLCheck({ trigger: 'scheduled' }).catch(err => console.error('[SSL Service Error]', err));
        } else if (currentM !== targetM) {
            lastSslTickMinute = -1;
        }
    }, 10000);
}

module.exports = {
    SSL_KEY, LOCK_KEY, LEASE_MS, SCAN_DEADLINE_MS, SCAN_CONCURRENCY,
    initSSLMonitorScheduler,
    runSSLCheck,
    startBackgroundScan,
    getScanStatus,
    acquireLease,
    releaseLease,
    runScan,
    readRecords,
    mutateRecords,
    applyCertInfo,
    applyProbeResult,
    refreshStatus,
    needsRepair,
    reparseStored,
    newOwner,
};
