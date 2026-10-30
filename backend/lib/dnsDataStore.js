/**
 * DNS Hub documents: the ONLY way to write
 *   dns_data.json     { servers: [...], exportSchedule: {...}, ... }  (routes/servers.js, routes/records.js)
 *   the DNS change log: table dns_changes (services/logTables.js), one row per change (routes/records.js)
 *
 * The DNS server routes used to read the whole document, await a PowerShell call (zone cache update: seconds), then
 * write the whole stale copy back, dropping any change made meanwhile. Writes are now atomic read-modify-writes
 * through lib/docStore.js mutateDocument (fn synchronous, mutates in place, returns the result).
 * lib/db.js readDB / writeDB stay for reading (dnsScheduler) and legacy callers; new writers use this module.
 */
const { mutateDocument } = require('./docStore');

const DNS_DATA_KEY = 'dns_data.json';
const DNS_CHANGES_MAX = 5000; // entries listed by GET /api/records/logs

/** Atomic read-modify-write of dns_data.json; doc.servers is always an array inside fn. Returns fn's result. */
function mutateDnsDb(fn, opts = {}) {
    return mutateDocument(DNS_DATA_KEY, (doc) => {
        if (!Array.isArray(doc.servers)) doc.servers = [];
        return fn(doc);
    }, { defaultValue: { servers: [] }, fnName: 'dnsDataStore.mutateDnsDb', label: 'DNS data', reason: opts.reason });
}

/**
 * Adds the entries to the change log (table dns_changes), one row each in one transaction. The given order is the
 * listing order (entries[0] is listed first, exactly like the former logs.unshift(...entries)), so they are inserted
 * last-to-first. Returns the number added.
 */
function appendDnsChanges(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return 0;
    return require('../services/logTables').append('dns_changes', list.slice().reverse());
}

/** The change log, newest first, at most DNS_CHANGES_MAX entries (what the former capped document held). */
function listDnsChanges(limit = DNS_CHANGES_MAX) {
    return require('../services/logTables').listDnsChanges(limit);
}

module.exports = { DNS_DATA_KEY, DNS_CHANGES_MAX, mutateDnsDb, appendDnsChanges, listDnsChanges };
