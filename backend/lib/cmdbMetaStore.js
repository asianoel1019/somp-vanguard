/**
 * Server List CMDB data: the ONLY way to write
 *   server_operation/server_cmdb_meta.json     { "<ip>": { ...meta } }
 *   the CMDB change history                    table cmdb_history (services/logTables.js), one row per entry
 *
 * Both processes write them (web: Server List / VIP / restore routes, telemetry revive; worker: DNS export FQDN sync,
 * inventory scan VIP reconcile and deleted-IP revive). A plain readDataSync -> modify -> writeDataSync works on one
 * process' RAM-cached copy and silently drops the other process' change. mutateMeta delegates to
 * lib/docStore.js mutateDocument (BEGIN IMMEDIATE on the shared database.sqlite, current row, fn, write, COMMIT);
 * a history entry is a single INSERT.
 *
 * fn contract (as docStore): synchronous, mutates the document IN PLACE, returns the caller's result; never accumulate
 * into outer variables (fn can run more than once in fallback mode) and never run side effects (other documents,
 * cmdb_servers, audit log, notifications) inside fn - do them with fn's return value afterwards.
 */
const dbMod = require('./db');
const { mutateDocument } = require('./docStore');

const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
const DEFAULT_HISTORY_MAX = 500;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const objOrEmpty = (v) => (isObj(v) ? v : {});

/** Current meta for READ-ONLY use (RAM cache allowed). Never mutate and write this copy back. */
function readMeta() {
    return objOrEmpty(dbMod.readDataSync(CMDB_META_KEY, {}));
}

/** Atomic read-modify-write of the CMDB meta document. opts: { reason } (diagnostics). Returns fn's result. */
function mutateMeta(fn, opts = {}) {
    if (typeof fn !== 'function') throw new TypeError('cmdbMetaStore.mutateMeta: fn must be a function');
    return mutateDocument(CMDB_META_KEY, fn, {
        defaultValue: {},
        normalize: objOrEmpty,
        fnName: 'cmdbMetaStore.mutateMeta',
        label: 'CMDB meta',
        reason: opts && opts.reason,
    });
}

/**
 * History entries, newest first (table cmdb_history, services/logTables.js). opts: ip (only that IP), ips (any of
 * them), excludeAction, limit. Without options: the whole history.
 */
function readHistory(opts = {}) {
    const o = opts || {};
    const ips = o.ips !== undefined ? [...o.ips] : (o.ip !== undefined ? [o.ip] : undefined);
    return require('../services/logTables').listCmdbHistory({ ips, excludeAction: o.excludeAction, limit: o.limit });
}

/**
 * Adds entries in the given order, each one newer than the previous (exactly like the former history.unshift(entry)
 * loop: the last entry of the list is the newest), as ONE INSERT per entry in one transaction. The former per-call cap
 * (`max`, 500 / 2000 entries) is replaced by the table retention (RETENTION_CMDB_HISTORY_DAYS, row cap); the argument is
 * accepted for compatibility and ignored.
 */
function appendHistory(entries, max = DEFAULT_HISTORY_MAX) { // eslint-disable-line no-unused-vars
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (list.length === 0) return 0;
    return require('../services/logTables').append('cmdb_history', list);
}

/** The history entry shape used by every CMDB writer. */
function makeHistoryEntry(ip, username, action, oldData, newData) {
    return {
        id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 4),
        ip: String(ip).trim(),
        username: username || 'SYSTEM',
        action: action || 'UPDATE',
        timestamp: new Date().toISOString(),
        oldData: oldData || {},
        newData: newData || {}
    };
}

module.exports = {
    CMDB_META_KEY, DEFAULT_HISTORY_MAX,
    readMeta, mutateMeta, readHistory, appendHistory, makeHistoryEntry
};
