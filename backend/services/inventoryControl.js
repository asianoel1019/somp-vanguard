/**
 * Web-side control of the inventory scanner. The web process never scans or schedules; it only hands requests to the
 * background worker over IPC and reads the worker-written status from the shared database.
 */
const { readStatus, isStatusRunning } = require('./inventoryStatus');
const { parseSubnetEntry, assertIpv4, isIpv4 } = require('../lib/inventoryValidation');

const WORKER_UNAVAILABLE = 'Background worker unavailable, please retry in a few seconds.';
const WORKER_DISABLED = 'The background worker is disabled (ENABLE_EMBEDDED_WORKER=false); inventory scans run only in the worker.';

function sendToWorker(msg) {
    if (process.env.ENABLE_EMBEDDED_WORKER === 'false') return { ok: false, error: WORKER_DISABLED };
    let sent = false;
    try { sent = typeof global.sendWorkerMessage === 'function' && global.sendWorkerMessage(msg) === true; } catch (e) { sent = false; }
    return sent ? { ok: true } : { ok: false, error: WORKER_UNAVAILABLE };
}

/** Normalises the optional { subnet } / { ip } scope of a scan request. Returns { scope } (maybe null) or { error }. */
function normalizeScope(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (b.ip !== undefined && b.ip !== null && b.ip !== '') {
        const ip = typeof b.ip === 'string' ? b.ip.trim() : b.ip;
        if (!isIpv4(ip)) return { error: 'ip must be a valid IPv4 address' };
        const host = parseInt(String(ip).split('.')[3], 10);
        if (host < 1 || host > 254) return { error: 'ip host part must be between 1 and 254' };
        return { scope: { ip: assertIpv4(ip) } };
    }
    if (b.subnet !== undefined && b.subnet !== null && b.subnet !== '') {
        const parsed = parseSubnetEntry(typeof b.subnet === 'string' ? b.subnet.trim() : b.subnet);
        if (parsed.error) return { error: `Invalid subnet: ${parsed.error}` };
        return { scope: { subnet: parsed.normalized } };
    }
    return { scope: null };
}

/** Ask the worker to start a scan. Returns { status, body } for the HTTP layer. */
async function requestScan({ body, requestedBy }) {
    const norm = normalizeScope(body);
    if (norm.error) return { status: 400, body: { error: norm.error } };
    const current = await readStatus();
    if (isStatusRunning(current)) {
        return { status: 409, body: { message: 'Scan already in progress', alreadyRunning: true } };
    }
    const msg = { type: 'RUN_INVENTORY_SCAN', requestedBy: requestedBy || 'unknown' };
    if (norm.scope) msg.scope = norm.scope;
    const sent = sendToWorker(msg);
    if (!sent.ok) return { status: 503, body: { error: sent.error, message: sent.error } };
    return { status: 202, body: { message: 'Scan started in background', scope: norm.scope } };
}

/** Ask the worker to abort the running scan. */
async function requestAbort({ requestedBy }) {
    const current = await readStatus();
    if (!isStatusRunning(current)) return { status: 400, body: { message: 'No scan in progress' } };
    const sent = sendToWorker({ type: 'ABORT_INVENTORY_SCAN', requestedBy: requestedBy || 'unknown' });
    if (!sent.ok) return { status: 503, body: { error: sent.error, message: sent.error } };
    return { status: 200, body: { message: 'Abort request received' } };
}

/** Tell the worker to reload the schedule after a config save. Returns true when delivered. */
function requestSchedulerReload() {
    return sendToWorker({ type: 'RELOAD_INVENTORY_SCHEDULER' }).ok;
}

module.exports = { WORKER_UNAVAILABLE, WORKER_DISABLED, normalizeScope, requestScan, requestAbort, requestSchedulerReload };
