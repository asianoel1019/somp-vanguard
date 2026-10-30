/**
 * Server Inventory storage: one SQL row per host in table `inventory_hosts` (scout.sqlite).
 *
 * Why a table instead of one JSON document per /24:
 *  - scans, tag edits and VIP links touch single rows, so concurrent writers (worker scan vs web edits)
 *    never overwrite each other and two ranges of one /24 cannot clobber one another;
 *  - both processes read the same table directly (no RAM document cache to keep coherent, no big IPC payloads).
 *
 * Ownership of columns:
 *  - scan-owned: os, hostname, domain, osname, osVersion, cpu, memoryGB, timezone, status, lastSeenAt,
 *    lastCheckedAt, offlineSince, consecutiveMisses, specsError, source (+ unknown keys in `extra`)
 *  - user-owned: tags, linkedTo, isVip, vipOf  (never touched by upsertScanResult)
 *
 * getAllSubnetData() keeps the legacy "array of host objects" shape for existing callers.
 */
const fs = require('fs');
const path = require('path');

const DOC_PREFIX = 'server_operation/oscheck/data_';
const MARKER_KEY = 'server_operation/inventory_hosts_migrated.json'; // informational copy; the authoritative marker lives in inventory_meta
const META_MARKER = 'hosts_migrated';
const FLAT_PREFIX = 'server_operation_oscheck_data_';

const COLUMNS = [
    ['ip', 'TEXT PRIMARY KEY'],
    ['subnet', 'TEXT'],
    ['hostname', 'TEXT'],
    ['os', 'TEXT'],
    ['osname', 'TEXT'],
    ['osVersion', 'TEXT'],
    ['domain', 'TEXT'],
    ['cpu', 'BLOB'], // no affinity: values are stored exactly as the legacy documents carried them
    ['memoryGB', 'BLOB'],
    ['timezone', 'TEXT'],
    ['status', 'TEXT'],
    ['firstSeenAt', 'TEXT'],
    ['lastSeenAt', 'TEXT'],
    ['lastCheckedAt', 'TEXT'],
    ['offlineSince', 'TEXT'],
    ['consecutiveMisses', 'INTEGER'],
    ['tags', 'TEXT'],
    ['linkedTo', 'TEXT'],
    ['isVip', 'INTEGER'],
    ['vipOf', 'TEXT'],
    ['specsError', 'TEXT'],
    ['source', 'TEXT'],
    ['updatedAt', 'TEXT'],
    ['extra', 'TEXT']
];

// legacy document key -> column
const DOC_TO_COL = {
    hostname: 'hostname', os: 'os', osname: 'osname', osVersion: 'osVersion', domain: 'domain',
    cpu: 'cpu', mem: 'memoryGB', timezone: 'timezone', status: 'status',
    lastSeen: 'lastSeenAt', lastChecked: 'lastCheckedAt', firstSeen: 'firstSeenAt',
    offlineSince: 'offlineSince', consecutiveMisses: 'consecutiveMisses',
    error: 'specsError', source: 'source'
};
// accepted aliases when called with column names
const COL_ALIASES = { memoryGB: 'memoryGB', lastSeenAt: 'lastSeenAt', lastCheckedAt: 'lastCheckedAt', firstSeenAt: 'firstSeenAt', specsError: 'specsError' };
const COL_TO_DOC = {};
Object.entries(DOC_TO_COL).forEach(([d, c]) => { COL_TO_DOC[c] = d; });

const SCAN_COLS = new Set(Object.values(DOC_TO_COL));
SCAN_COLS.delete('firstSeenAt'); // set once on insert (a scan may pass it explicitly for migrations)
const USER_KEYS = new Set(['tags', 'linkedTo', 'isVip', 'vipOf', 'ip']);

const migratedHandles = new WeakSet();
const testHooks = { beforeCommit: null, dataDir: null };
const LEGACY_TTL_MS = 30000;
let legacyCache = null; // { at, hosts } while unmigrated
const readyHandles = new WeakSet();

// ---------------------------------------------------------------------------------------------
// handle / schema
// ---------------------------------------------------------------------------------------------
function getHandle() {
    const dbManager = require('./db');
    const driver = dbManager.getDriver();
    let handle = null;
    if (driver && driver.dbType === 'sqlite') {
        if (typeof driver.ensureDb === 'function') driver.ensureDb();
        handle = driver.db;
    }
    // Other engines have no synchronous handle: the local database.sqlite still exists next to them
    if (!handle) handle = require('../lib/db').db;
    if (!handle) throw new Error('inventoryStore: no SQLite handle available');
    if (!readyHandles.has(handle)) {
        ensureTable(handle);
        readyHandles.add(handle);
    }
    return handle;
}

/** Idempotent: CREATE TABLE IF NOT EXISTS + additive ALTERs + indexes. */
function ensureTable(handle) {
    const cols = COLUMNS.map(([n, t]) => `${n} ${t}`).join(', ');
    handle.exec(`CREATE TABLE IF NOT EXISTS inventory_hosts (${cols})`);
    handle.exec('CREATE TABLE IF NOT EXISTS inventory_meta (key TEXT PRIMARY KEY, value TEXT)');
    try {
        const have = new Set(handle.prepare('PRAGMA table_info(inventory_hosts)').all().map(r => r.name));
        for (const [n, t] of COLUMNS) {
            if (have.has(n) || /PRIMARY KEY/.test(t)) continue;
            try { handle.exec(`ALTER TABLE inventory_hosts ADD COLUMN ${n} ${t}`); } catch (e) {}
        }
    } catch (e) {}
    try { handle.exec('CREATE INDEX IF NOT EXISTS idx_inventory_hosts_subnet ON inventory_hosts(subnet)'); } catch (e) {}
    try { handle.exec('CREATE INDEX IF NOT EXISTS idx_inventory_hosts_status ON inventory_hosts(status)'); } catch (e) {}
}

function tx(handle, fn) {
    if (handle.inTransaction || handle.isTransaction) return fn(); // better-sqlite3 / node:sqlite: already inside a transaction
    handle.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        handle.exec('COMMIT');
        return out;
    } catch (e) {
        try { handle.exec('ROLLBACK'); } catch (_) {}
        throw e;
    }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function cleanIp(ip) { return String(ip == null ? '' : ip).trim(); }

function subnetOf(ip) {
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
    return m ? m[1] : '';
}

/** When a host went offline: its last sighting when that is older than now (legacy hosts), else now. */
function offlineSinceFor(lastSeenAt, nowIso) {
    const t = Date.parse(lastSeenAt || '');
    return Number.isFinite(t) && t < Date.parse(nowIso) ? new Date(t).toISOString() : nowIso;
}

function bindable(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
}

function parseExtra(raw) {
    if (!raw) return {};
    try { const o = JSON.parse(raw); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
}

/** Row -> legacy host object (only non-null fields, so the old document shape is reproduced). */
function rowToHost(row) {
    if (!row) return null;
    const extra = parseExtra(row.extra);
    const nullKeys = Array.isArray(extra._nullKeys) ? extra._nullKeys : [];
    const out = {};
    for (const [k, v] of Object.entries(extra)) { if (k !== '_nullKeys') out[k] = v; }
    out.ip = row.ip;
    for (const [col, docKey] of Object.entries(COL_TO_DOC)) {
        if (row[col] !== null && row[col] !== undefined) out[docKey] = row[col];
    }
    if (row.tags !== null && row.tags !== undefined) {
        try { out.tags = JSON.parse(row.tags); } catch (e) { /* unreadable tags are dropped */ }
    }
    if (row.linkedTo) out.linkedTo = row.linkedTo;
    if (row.vipOf) out.vipOf = row.vipOf;
    if (row.isVip !== null && row.isVip !== undefined) out.isVip = !!row.isVip;
    for (const k of nullKeys) { if (!(k in out)) out[k] = null; }
    return out;
}

/** Legacy host object -> column map (+ extra). */
function hostToCols(host) {
    const cols = {};
    const extra = {};
    const nullKeys = [];
    for (const [k, v] of Object.entries(host)) {
        if (k === 'ip') continue;
        if (USER_KEYS.has(k)) continue;
        const col = DOC_TO_COL[k] || COL_ALIASES[k];
        if (col) {
            if (v === null) nullKeys.push(COL_TO_DOC[col]);
            cols[col] = v;
        } else if (v !== undefined) {
            extra[k] = v;
        }
    }
    return { cols, extra, nullKeys };
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------
function legacyDirs() {
    const dirs = [];
    const add = (d) => {
        if (!d) return;
        const norm = path.resolve(d);
        const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
        if (!dirs.some(x => (process.platform === 'win32' ? x.toLowerCase() : x) === key)) dirs.push(norm);
    };
    try {
        const resolver = testHooks.dataDir || require('../lib/db').getDataDir;
        add(resolver());
    } catch (e) {}
    add(path.join(__dirname, '..', 'data'));
    return dirs;
}

/** Legacy hosts grouped by source: DB documents first, then flat files (read-only, only if present). */
function readLegacySources() {
    const sources = []; // { origin, key, list }
    try {
        const { db } = require('../lib/db');
        if (db) {
            const rows = db.prepare('SELECT key, value FROM document_store WHERE key LIKE ?').all(`${DOC_PREFIX}%`);
            for (const r of rows) {
                try {
                    const list = JSON.parse(r.value);
                    if (Array.isArray(list)) sources.push({ origin: 'db', key: r.key, list });
                } catch (e) {}
            }
        }
    } catch (e) {
        console.warn('[InventoryStore] reading legacy documents failed:', e.message);
    }
    for (const dir of legacyDirs()) {
        try {
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
                if (!f.startsWith(FLAT_PREFIX) || !f.endsWith('.json')) continue;
                try {
                    const list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                    if (Array.isArray(list)) sources.push({ origin: 'flat', key: f, list });
                } catch (e) {}
            }
        } catch (e) {}
    }
    return sources;
}

function recency(item) {
    return String(item.lastChecked || item.updatedAt || item.lastSeen || '');
}

function isEmpty(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }

/** Merges all legacy entries of one IP: newest wins (ties: first source), user-owned fields filled from the others. */
function mergeLegacyEntries(entries) {
    let win = entries[0];
    for (const e of entries.slice(1)) { if (recency(e) > recency(win)) win = e; }
    const ordered = [win, ...entries.filter(e => e !== win)];
    const out = { ...win };
    const tagVals = ordered.map(e => e.tags).filter(v => !isEmpty(v));
    if (tagVals.length && tagVals.every(Array.isArray)) {
        out.tags = [...new Set(tagVals.flat())];
    } else if (tagVals.length) {
        out.tags = tagVals[0];
    }
    for (const k of ['linkedTo', 'vipOf']) {
        const v = ordered.map(e => e[k]).find(x => !isEmpty(x));
        if (v !== undefined) out[k] = v;
    }
    const vip = ordered.map(e => e.isVip).find(x => x !== undefined && x !== null);
    if (vip !== undefined) out.isVip = vip;
    return out;
}

/** Legacy documents + flat files -> flat array of merged host objects (cached up to 30 s while unmigrated). */
function readDocumentHosts(opts = {}) {
    if (!opts.fresh && legacyCache && Date.now() - legacyCache.at < LEGACY_TTL_MS) return legacyCache.hosts;
    const byIp = new Map();
    for (const src of readLegacySources()) {
        for (const item of src.list) {
            const ip = cleanIp(item && item.ip);
            if (!ip) continue;
            if (!byIp.has(ip)) byIp.set(ip, []);
            byIp.get(ip).push(item);
        }
    }
    const hosts = [...byIp.values()].map(mergeLegacyEntries);
    legacyCache = { at: Date.now(), hosts };
    return hosts;
}

function readMeta(handle) {
    try {
        const r = handle.prepare('SELECT value FROM inventory_meta WHERE key = ?').get(META_MARKER);
        if (!r) return null;
        try { return JSON.parse(r.value); } catch (e) { return {}; }
    } catch (e) { return null; }
}

/**
 * Migrated = marker row in inventory_meta (same database as the table) AND not "table empty while legacy hosts
 * exist" (a recreated / restored scout.sqlite re-imports). Cached per handle once true.
 */
function isMigrated() {
    let handle;
    try { handle = getHandle(); } catch (e) { return false; }
    if (migratedHandles.has(handle)) return true;
    const marker = readMeta(handle);
    if (!marker) return false;
    const count = handle.prepare('SELECT COUNT(*) AS c FROM inventory_hosts').get().c;
    // marker.emptied: the operator deleted the last host on purpose; do not resurrect it from the legacy documents
    if (count === 0 && !marker.emptied && readDocumentHosts().length > 0) return false;
    migratedHandles.add(handle);
    return true;
}

/** Compatibility: the old "all hosts of all subnets" array. */
function getAllSubnetData() {
    if (!isMigrated()) return readDocumentHosts();
    const handle = getHandle();
    return handle.prepare('SELECT * FROM inventory_hosts ORDER BY subnet, CAST(substr(ip, length(subnet) + 2) AS INTEGER)').all().map(rowToHost);
}

function getHost(ip) {
    const clean = cleanIp(ip);
    if (!isMigrated()) return readDocumentHosts().find(h => cleanIp(h && h.ip) === clean) || null;
    return rowToHost(getHandle().prepare('SELECT * FROM inventory_hosts WHERE ip = ?').get(clean));
}

function listHostsBySubnet(prefix) {
    if (!isMigrated()) return readDocumentHosts().filter(h => subnetOf(cleanIp(h && h.ip)) === prefix);
    return getHandle().prepare('SELECT * FROM inventory_hosts WHERE subnet = ? ORDER BY CAST(substr(ip, length(subnet) + 2) AS INTEGER)').all(prefix).map(rowToHost);
}

/** Hosts that carry any VIP link (linkedTo / vipOf / isVip). */
function listLinkedHosts() {
    if (!isMigrated()) return readDocumentHosts().filter(h => h && (h.linkedTo || h.vipOf || h.isVip));
    return getHandle().prepare("SELECT * FROM inventory_hosts WHERE linkedTo IS NOT NULL AND linkedTo != '' OR vipOf IS NOT NULL AND vipOf != '' OR isVip = 1").all().map(rowToHost);
}

/**
 * Filtered + paginated listing: { hosts, total }. filters: subnet, status, search (ip/hostname/os substring), limit, offset.
 */
function listHosts(filters = {}) {
    const { subnet, status, search, os } = filters;
    const limit = filters.all ? 0 : Math.min(Math.max(parseInt(filters.limit, 10) || 1000, 1), 10000);
    const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
    if (!isMigrated()) {
        let all = readDocumentHosts();
        if (subnet) all = all.filter(h => subnetOf(cleanIp(h.ip)) === subnet);
        if (status) all = all.filter(h => (h.status || 'offline') === status);
        if (search) {
            const q = String(search).toLowerCase();
            all = all.filter(h => [h.ip, h.hostname, h.osname, h.os].some(v => v && String(v).toLowerCase().includes(q)));
        }
        if (os) {
            const q = String(os).toLowerCase();
            all = all.filter(h => [h.os, h.osname].some(v => v && String(v).toLowerCase().includes(q)));
        }
        const total = all.length;
        return { hosts: limit ? all.slice(offset, offset + limit) : all.slice(offset), total };
    }
    const where = [];
    const params = [];
    if (subnet) { where.push('subnet = ?'); params.push(String(subnet)); }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    if (search) {
        const q = `%${String(search).replace(/[\\%_]/g, m => '\\' + m)}%`;
        where.push("(ip LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\' OR osname LIKE ? ESCAPE '\\' OR os LIKE ? ESCAPE '\\')");
        params.push(q, q, q, q);
    }
    if (os) {
        const q = `%${String(os).replace(/[\\%_]/g, m => '\\' + m)}%`;
        where.push("(os LIKE ? ESCAPE '\\' OR osname LIKE ? ESCAPE '\\')");
        params.push(q, q);
    }
    const w =where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const handle = getHandle();
    const total = handle.prepare(`SELECT COUNT(*) AS c FROM inventory_hosts${w}`).get(...params).c;
    const order = ' ORDER BY subnet, CAST(substr(ip, length(subnet) + 2) AS INTEGER)';
    const page = limit ? ` LIMIT ${limit} OFFSET ${offset}` : (offset ? ` LIMIT -1 OFFSET ${offset}` : '');
    const hosts = handle.prepare(`SELECT * FROM inventory_hosts${w}${order}${page}`).all(...params).map(rowToHost);
    return { hosts, total };
}

// ---------------------------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------------------------

/**
 * Makes sure legacy documents are in the table before a row-level write. Never latches a failure: the next
 * write retries. Throws an error with code INVENTORY_MIGRATION_PENDING when the import cannot complete, so
 * no write ever lands in an unmigrated table.
 */
function ensureMigrated() {
    if (isMigrated()) return true;
    try {
        migrateFromDocuments();
        return true;
    } catch (e) {
        console.error('[InventoryStore] on-demand migration failed:', e.message);
        const err = new Error(`inventory storage migration pending: ${e.message}`);
        err.code = 'INVENTORY_MIGRATION_PENDING';
        throw err;
    }
}

/**
 * Merges ONLY scan-owned fields into the host row (creates it unless opts.createIfMissing === false).
 * fields use either the legacy keys (mem, lastSeen, error) or the column names (memoryGB, lastSeenAt, specsError).
 * tags / linkedTo / isVip / vipOf in `fields` are ignored by design.
 * Returns the resulting legacy host object, or null when nothing was written.
 */
function upsertScanResult(ip, fields = {}, opts = {}) {
    const clean = cleanIp(ip);
    if (!clean) throw new Error('IP address is required');
    ensureMigrated();
    const handle = getHandle();
    const now = new Date().toISOString();
    const { cols, extra, nullKeys } = hostToCols(fields);
    return tx(handle, () => {
        const existing = handle.prepare('SELECT * FROM inventory_hosts WHERE ip = ?').get(clean);
        if (!existing && opts.createIfMissing === false) return null;

        const set = {};
        for (const [c, v] of Object.entries(cols)) {
            if (SCAN_COLS.has(c) || (c === 'firstSeenAt' && !(existing && existing.firstSeenAt))) set[c] = v;
        }
        // lifecycle bookkeeping
        const nextStatus = set.status !== undefined ? set.status : (existing ? existing.status : null);
        if (set.status === 'online') {
            if (set.lastSeenAt === undefined) set.lastSeenAt = now;
            if (set.offlineSince === undefined) set.offlineSince = null;
            if (set.consecutiveMisses === undefined) set.consecutiveMisses = 0;
        } else if (set.status === 'offline' && (!existing || existing.status !== 'offline' || !existing.offlineSince) && set.offlineSince === undefined) {
            set.offlineSince = offlineSinceFor(set.lastSeenAt !== undefined ? set.lastSeenAt : (existing && existing.lastSeenAt), now);
        }
        if (set.lastCheckedAt === undefined) set.lastCheckedAt = now;
        if (!existing && set.firstSeenAt === undefined && nextStatus === 'online') set.firstSeenAt = set.lastSeenAt || now;

        const mergedExtra = existing ? parseExtra(existing.extra) : {};
        const prevNull = new Set(Array.isArray(mergedExtra._nullKeys) ? mergedExtra._nullKeys : []);
        Object.assign(mergedExtra, extra);
        // a column key written with null is remembered so the legacy shape can reproduce `error: null`
        for (const k of nullKeys) prevNull.add(k);
        for (const [c, v] of Object.entries(set)) { if (v !== null && v !== undefined) prevNull.delete(COL_TO_DOC[c]); }
        if (prevNull.size) mergedExtra._nullKeys = [...prevNull]; else delete mergedExtra._nullKeys;
        const extraJson = Object.keys(mergedExtra).length ? JSON.stringify(mergedExtra) : null;

        if (existing) {
            const names = Object.keys(set);
            const assigns = names.map(n => `${n} = ?`).concat(['updatedAt = ?', 'extra = ?']);
            handle.prepare(`UPDATE inventory_hosts SET ${assigns.join(', ')} WHERE ip = ?`)
                .run(...names.map(n => bindable(set[n])), now, extraJson, clean);
        } else {
            const names = ['ip', 'subnet', ...Object.keys(set), 'updatedAt', 'extra'];
            const vals = [clean, subnetOf(clean), ...Object.keys(set).map(n => bindable(set[n])), now, extraJson];
            handle.prepare(`INSERT INTO inventory_hosts (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...vals);
            handle.prepare("UPDATE inventory_meta SET value = json_remove(value, '$.emptied') WHERE key = ? AND value LIKE '%emptied%'").run(META_MARKER);
        }
        return rowToHost(handle.prepare('SELECT * FROM inventory_hosts WHERE ip = ?').get(clean));
    });
}

/**
 * Marks known hosts as offline in ONE transaction (unknown addresses are ignored). Keeps offlineSince of hosts
 * that were already offline. Used by scans to avoid one write lock per unanswered IP.
 */
function markOfflineBatch(ips) {
    const list = (ips || []).map(cleanIp).filter(Boolean);
    if (!list.length) return 0;
    ensureMigrated();
    const handle = getHandle();
    const now = new Date().toISOString();
    const sel = handle.prepare('SELECT status, offlineSince, lastSeenAt FROM inventory_hosts WHERE ip = ?');
    const upd = handle.prepare("UPDATE inventory_hosts SET offlineSince = ?, status = 'offline', lastCheckedAt = ?, updatedAt = ? WHERE ip = ?");
    let n = 0;
    tx(handle, () => {
        for (const ip of list) {
            const row = sel.get(ip);
            if (!row) continue;
            const since = row.status === 'offline' && row.offlineSince ? row.offlineSince : offlineSinceFor(row.lastSeenAt, now);
            n += Number(upd.run(since, now, now, ip).changes);
        }
    });
    return n;
}

/**
 * The host did not answer this scan: consecutiveMisses + 1; the host goes offline once it reaches missesBeforeOffline
 * (offlineSince = its lastSeenAt when older than now). Already-offline hosts stay offline and keep offlineSince
 * (set from lastSeenAt when it was empty). Unknown addresses are ignored. One transaction for the whole list.
 * Returns { missed, wentOffline: ip[] }.
 */
function recordMissBatch(ips, { missesBeforeOffline = 2 } = {}) {
    const list = (ips || []).map(cleanIp).filter(Boolean);
    const result = { missed: 0, wentOffline: [] };
    if (!list.length) return result;
    ensureMigrated();
    const handle = getHandle();
    const now = new Date().toISOString();
    const threshold = Math.max(1, Number(missesBeforeOffline) || 1);
    const sel = handle.prepare('SELECT status, offlineSince, lastSeenAt, consecutiveMisses FROM inventory_hosts WHERE ip = ?');
    const upd = handle.prepare('UPDATE inventory_hosts SET status = ?, offlineSince = ?, consecutiveMisses = ?, lastCheckedAt = ?, updatedAt = ? WHERE ip = ?');
    tx(handle, () => {
        for (const ip of list) {
            const row = sel.get(ip);
            if (!row) continue;
            const misses = (Number(row.consecutiveMisses) || 0) + 1;
            let status = row.status;
            let since = row.offlineSince || null;
            if (row.status === 'offline') {
                if (!since) since = offlineSinceFor(row.lastSeenAt, now);
            } else if (misses >= threshold) {
                status = 'offline';
                since = offlineSinceFor(row.lastSeenAt, now);
                result.wentOffline.push(ip);
            }
            upd.run(status, since, misses, now, now, ip);
            result.missed++;
        }
    });
    return result;
}

/** Sets isVip=1 for a host detected as VIP elsewhere (CMDB / IPAM). Does not touch linkedTo / vipOf. */
function markVip(ip) {
    ensureMigrated();
    return getHandle().prepare('UPDATE inventory_hosts SET isVip = 1 WHERE ip = ? AND (isVip IS NULL OR isVip = 0)').run(cleanIp(ip)).changes > 0;
}

/** Replaces the user tags of a host. Returns false when the host is unknown. */
function updateTags(ip, tags) {
    if (!Array.isArray(tags)) throw new Error('Tags must be an array');
    ensureMigrated();
    const res = getHandle().prepare('UPDATE inventory_hosts SET tags = ?, updatedAt = ? WHERE ip = ?')
        .run(JSON.stringify(tags), new Date().toISOString(), cleanIp(ip));
    return res.changes > 0;
}

/**
 * Link (primaryIp given) or unlink (primaryIp null) a secondary/VIP address.
 * Returns the previous linkedTo (string|null) when the host exists, or undefined when it is unknown.
 */
function setVipLink(ip, primaryIp = null) {
    ensureMigrated();
    const clean = cleanIp(ip);
    const handle = getHandle();
    return tx(handle, () => {
        const row = handle.prepare('SELECT linkedTo FROM inventory_hosts WHERE ip = ?').get(clean);
        if (!row) return undefined;
        const prev = row.linkedTo || null;
        const now = new Date().toISOString();
        if (primaryIp) {
            const pri = cleanIp(primaryIp);
            handle.prepare('UPDATE inventory_hosts SET linkedTo = ?, isVip = 1, vipOf = ?, updatedAt = ? WHERE ip = ?').run(pri, pri, now, clean);
        } else {
            handle.prepare('UPDATE inventory_hosts SET linkedTo = NULL, isVip = NULL, vipOf = NULL, updatedAt = ? WHERE ip = ?').run(now, clean);
        }
        return prev;
    });
}

/** Removes the host row. Returns true when a row was deleted. */
function deleteHost(ip) {
    ensureMigrated();
    const handle = getHandle();
    return tx(handle, () => {
        const deleted = Number(handle.prepare('DELETE FROM inventory_hosts WHERE ip = ?').run(cleanIp(ip)).changes) > 0;
        if (deleted && handle.prepare('SELECT COUNT(*) AS c FROM inventory_hosts').get().c === 0) {
            const marker = readMeta(handle) || {};
            handle.prepare('INSERT OR REPLACE INTO inventory_meta (key, value) VALUES (?, ?)').run(META_MARKER, JSON.stringify({ ...marker, emptied: true }));
        }
        return deleted;
    });
}

// ---------------------------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------------------------

/**
 * Idempotent import of server_operation/oscheck/data_*.json documents (and legacy flat files
 * server_operation_oscheck_data_*.json when present) into inventory_hosts.
 * - sources are only read, never modified (kept for rollback)
 * - duplicate IPs: newest by lastChecked/updatedAt/lastSeen wins, user-owned fields are merged
 * - existing rows are never overwritten; only EMPTY user-owned fields (tags, linkedTo, vipOf, isVip) are filled
 * - the marker (inventory_meta) is written in the same transaction as the rows. Returns { skipped, migrated, total }.
 */
function migrateFromDocuments(options = {}) {
    if (!options.force && isMigrated()) return { skipped: true, migrated: 0, total: 0 };
    const handle = getHandle();
    const hosts = readDocumentHosts({ fresh: true });
    let migrated = 0;
    const now = new Date().toISOString();
    const insert = handle.prepare('INSERT OR IGNORE INTO inventory_hosts (ip, subnet, hostname, os, osname, osVersion, domain, cpu, memoryGB, timezone, status, firstSeenAt, lastSeenAt, lastCheckedAt, offlineSince, consecutiveMisses, tags, linkedTo, isVip, vipOf, specsError, source, updatedAt, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const fill = handle.prepare("UPDATE inventory_hosts SET tags = CASE WHEN tags IS NULL OR tags IN ('[]', 'null') THEN COALESCE(?, tags) ELSE tags END, linkedTo = CASE WHEN linkedTo IS NULL OR linkedTo = '' THEN COALESCE(?, linkedTo) ELSE linkedTo END, vipOf = CASE WHEN vipOf IS NULL OR vipOf = '' THEN COALESCE(?, vipOf) ELSE vipOf END, isVip = COALESCE(isVip, ?) WHERE ip = ?");
    tx(handle, () => {
        for (const item of hosts) {
            const ip = cleanIp(item.ip);
            const { cols, extra, nullKeys } = hostToCols(item);
            if (nullKeys.length) extra._nullKeys = nullKeys;
            const c = (n) => bindable(cols[n]);
            const tags = (item.tags === undefined || item.tags === null) ? null : JSON.stringify(item.tags);
            const linkedTo = item.linkedTo ? String(item.linkedTo) : null;
            const vipOf = item.vipOf ? String(item.vipOf) : null;
            const isVip = (item.isVip === undefined || item.isVip === null) ? null : (item.isVip ? 1 : 0);
            const res = insert.run(
                ip, subnetOf(ip), c('hostname'), c('os'), c('osname'), c('osVersion'), c('domain'), c('cpu'), c('memoryGB'), c('timezone'),
                c('status'), c('firstSeenAt'), c('lastSeenAt'), c('lastCheckedAt'), c('offlineSince'), c('consecutiveMisses'),
                tags, linkedTo, isVip, vipOf, c('specsError'), c('source'), now,
                Object.keys(extra).length ? JSON.stringify(extra) : null
            );
            if (Number(res.changes) > 0) migrated++;
            else fill.run(tags, linkedTo, vipOf, isVip, ip);
        }
        if (typeof testHooks.beforeCommit === 'function') testHooks.beforeCommit();
        handle.prepare('INSERT OR REPLACE INTO inventory_meta (key, value) VALUES (?, ?)')
            .run(META_MARKER, JSON.stringify({ migratedAt: now, hosts: hosts.length, inserted: migrated }));
    });
    migratedHandles.add(handle);
    legacyCache = null;
    try {
        require('../lib/db').writeDataSync(MARKER_KEY, { migratedAt: now, hosts: hosts.length, inserted: migrated });
    } catch (e) {}
    console.log(`[InventoryStore] Migrated ${migrated}/${hosts.length} inventory hosts from legacy documents.`);
    return { skipped: false, migrated, total: hosts.length };
}

/** Test helper: forget the cached "migrated" flag. */
function _resetForTests() {
    try { const h = getHandle(); migratedHandles.delete(h); legacyCache = null; h.exec('DELETE FROM inventory_meta'); } catch (e) {}
}

module.exports = {
    MARKER_KEY,
    ensureTable,
    getHandle,
    isMigrated,
    getHost,
    listHosts,
    listHostsBySubnet,
    listLinkedHosts,
    upsertScanResult,
    markVip,
    updateTags,
    setVipLink,
    deleteHost,
    getAllSubnetData,
    migrateFromDocuments,
    ensureMigrated,
    markOfflineBatch,
    recordMissBatch,
    _testHooks: testHooks,
    _resetForTests
};
