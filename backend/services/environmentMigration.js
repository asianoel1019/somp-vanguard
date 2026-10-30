/**
 * Global Environments phase 2: consumers store the environment ID (authoritative) next to the old name field.
 *
 * Per consumer (same machine keys as services/environmentUsage.js):
 *   - migrate():   one-time, idempotent; resolves stored names / name-like ids / codes (case-insensitive) to envId.
 *                  Unresolved values are left unchanged and recorded in the marker document.
 *   - unmapped():  distinct unresolved values with counts (live).
 *   - apply():     assigns an environment to every record carrying one unresolved value.
 * Prometheus keeps storing names (labels must stay strings): it is listed read-only (no apply, no rewrite).
 */
const { db: libDb, readDataSync, writeDataSync } = require('../lib/db');
const reg = require('../lib/environmentRegistry');
const { getTargetsSafely } = require('../lib/prometheusTargetHelper');

const MARKER_KEY = 'system/environment_id_migration.json';
const DOCS = {
    meta: 'server_operation/server_cmdb_meta.json',
    ipam: 'network_service/ipam/subnets.json',
    ssl: 'network_service/ssl_certificates.json',
    dbInventory: 'service_platform/database_clusters.json',
    dbRequests: 'service_platform/database_requests.json',
    k8s: 'service_platform/k8s_clusters.json'
};
const PROM_LABELS = ['zone', 'env', 'environment'];
const APPLY_BATCH = 500; // rows per UPDATE ... IN (...) and per event-loop yield while scanning

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const sameValue = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();

/**
 * Classifies one stored reference. Returns
 *   { state: 'ok', env }           envId is a known id
 *   { state: 'resolvable', env }   no valid envId, but the name / name-like envId resolves
 *   { state: 'unresolved', value } the raw text (name preferred, '' when nothing is stored)
 */
function classify(envId, name, envs) {
    const byId = reg.findById(envId, envs);
    if (byId) return { state: 'ok', env: byId };
    const env = reg.resolveEnv(envId, envs) || reg.resolveEnv(name, envs);
    if (env) return { state: 'resolvable', env };
    const value = given(name) ? String(name).trim() : (given(envId) ? String(envId).trim() : '');
    return { state: 'unresolved', value };
}

function tally(map, value) {
    const k = value;
    map.set(k, (map.get(k) || 0) + 1);
}

const toList = (map) => [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

// ----------------------------------------------------------------------------- document consumers
/**
 * A document consumer: records(data) yields the records, idField / nameField name the stored fields.
 * ipam has two keys over one document (subnets and IP addresses).
 */
/** Text a record carried before it was linked: the name, else the (name-like) envId; '' when nothing. */
const rawOf = (envId, name) => (given(name) ? String(name).trim() : (given(envId) ? String(envId).trim() : ''));

/**
 * Keeps the pre-link text in `<nameField>Raw` (rollback / audit) when it differs from the canonical name,
 * e.g. a code ("PRD"), a name stored in envId, or a different spelling. Never overwrites an existing raw value.
 */
function keepRaw(rec, nameField, raw, env) {
    const field = `${nameField}Raw`;
    if (raw && raw !== env.name && !given(rec[field])) rec[field] = raw;
}

/**
 * Read-modify-write of a document: fn(data) -> { result, changed }. The IPAM document goes through its atomic
 * store (the worker writes it too, a stale copy would lose its changes); other documents read -> write.
 * Returns `empty` when the document does not exist.
 */
function updateDoc(docKey, fn, empty) {
    if (docKey === DOCS.ipam) {
        return require('../lib/ipamStore').mutateSubnets((subnets) => fn(subnets).result, { reason: 'environment migration' });
    }
    // SSL certificates: the scan merges probe results through the same locked store
    if (docKey === DOCS.ssl) {
        if (readDataSync(docKey, null) == null) return empty;
        return require('./sslMonitorService').mutateRecords((records) => fn(records).result, 'environment migration');
    }
    const data = readDataSync(docKey, null);
    if (data === null || data === undefined) return empty;
    const out = fn(data);
    if (out.changed) writeDataSync(docKey, data);
    return out.result;
}

function docConsumer(key, label, docKey, records, nameField = 'environment', idField = 'envId', opts = {}) {
    const load = () => readDataSync(docKey, null);
    return {
        key, label, readOnly: false,
        migrate(envs) {
            return updateDoc(docKey, (data) => {
            let resolved = 0;
            const un = new Map();
            for (const rec of records(data)) {
                if (!rec || typeof rec !== 'object') continue;
                const c = classify(rec[idField], rec[nameField], envs);
                if (c.state === 'resolvable') {
                    keepRaw(rec, nameField, rawOf(rec[idField], rec[nameField]), c.env);
                    rec[idField] = c.env.id;
                    rec[nameField] = c.env.name;
                    resolved++;
                }
                else if (c.state === 'unresolved') tally(un, c.value);
            }
            return { result: { resolved, unresolved: toList(un) }, changed: resolved > 0 };
            }, { resolved: 0, unresolved: [] });
        },
        unmapped(envs) {
            const data = load();
            const un = new Map();
            if (data !== null && data !== undefined) {
                for (const rec of records(data)) {
                    if (!rec || typeof rec !== 'object') continue;
                    const c = classify(rec[idField], rec[nameField], envs);
                    if (c.state !== 'ok') tally(un, c.state === 'resolvable' ? (given(rec[nameField]) ? String(rec[nameField]).trim() : String(rec[idField]).trim()) : c.value);
                }
            }
            return toList(un);
        },
        // Assigns env to the unmapped records carrying `value`, or (onlyKeys) to the unmapped records with those keys
        // (IPs of the meta document). Returns { count, keys } (keys of the changed records, when the consumer has keys).
        apply(value, env, envs, onlyKeys = null) {
            return updateDoc(docKey, (data) => {
            let n = 0;
            const keys = [];
            const entries = opts.entries ? opts.entries(data) : records(data).map(rec => [null, rec]);
            for (const [k, rec] of entries) {
                if (!rec || typeof rec !== 'object') continue;
                if (onlyKeys && !onlyKeys.has(k)) continue;
                const c = classify(rec[idField], rec[nameField], envs);
                if (c.state === 'ok') continue;
                const raw = rawOf(rec[idField], rec[nameField]);
                if (!onlyKeys && !sameValue(raw, value)) continue;
                keepRaw(rec, nameField, raw, env);
                rec[idField] = env.id;
                rec[nameField] = env.name;
                n++;
                if (k !== null) keys.push(k);
            }
            return { result: { count: n, keys }, changed: n > 0 };
            }, { count: 0, keys: [] });
        }
    };
}

const flat = (data) => arr(data);
const subnetsOf = (data) => arr(data);
const ipsOf = (data) => arr(data).flatMap(s => arr(s && s.ips));
const metaOf = (data) => Object.values(obj(data));

// ----------------------------------------------------------------------------- CMDB table
const cmdbConsumer = {
    key: 'cmdb', label: 'CMDB servers', readOnly: false,
    rows() {
        if (!libDb) return [];
        return libDb.prepare('SELECT ip, envId, envName FROM cmdb_servers').all();
    },
    migrate(envs) {
        if (!libDb) return { resolved: 0, unresolved: [] };
        // envRaw keeps the pre-link text when it differs from the canonical name (code, name in envId, spelling)
        const upd = libDb.prepare("UPDATE cmdb_servers SET envId = ?, envName = ?, envRaw = COALESCE(NULLIF(envRaw, ''), ?) WHERE ip = ?");
        let resolved = 0;
        const un = new Map();
        const rows = this.rows();
        const run = () => {
            for (const r of rows) {
                const c = classify(r.envId, r.envName, envs);
                if (c.state === 'resolvable') {
                    const raw = rawOf(r.envId, r.envName);
                    upd.run(c.env.id, c.env.name, raw && raw !== c.env.name ? raw : null, r.ip);
                    resolved++;
                }
                else if (c.state === 'unresolved') tally(un, c.value);
            }
        };
        libDb.exec('BEGIN');
        try { run(); libDb.exec('COMMIT'); } catch (e) { try { libDb.exec('ROLLBACK'); } catch (_) {} throw e; }
        return { resolved, unresolved: toList(un) };
    },
    /**
     * Sets env on the given IPs in ONE transaction, in batches of APPLY_BATCH (UPDATE ... WHERE ip IN (...)).
     * Only rows that are still unmapped are touched; envRaw keeps their previous text.
     */
    updateIps(ips, env, envs) {
        if (!libDb || ips.length === 0) return 0;
        const validIds = envs.map(e => e.id);
        const notValid = `(envId IS NULL OR envId NOT IN (${validIds.map(() => '?').join(',')}))`;
        let n = 0;
        libDb.exec('BEGIN');
        try {
            for (let i = 0; i < ips.length; i += APPLY_BATCH) {
                const batch = ips.slice(i, i + APPLY_BATCH);
                n += libDb.prepare(
                    `UPDATE cmdb_servers SET envId = ?, envName = ?,
                        envRaw = CASE WHEN COALESCE(envRaw, '') <> '' THEN envRaw
                                      ELSE NULLIF(COALESCE(NULLIF(TRIM(envName), ''), TRIM(envId)), '') END
                     WHERE ip IN (${batch.map(() => '?').join(',')}) AND ${notValid}`
                ).run(env.id, env.name, ...batch, ...validIds).changes;
            }
            libDb.exec('COMMIT');
        } catch (e) { try { libDb.exec('ROLLBACK'); } catch (_) {} throw e; }
        return n;
    },
    unmapped(envs) {
        const un = new Map();
        for (const r of this.rows()) {
            const c = classify(r.envId, r.envName, envs);
            if (c.state !== 'ok') tally(un, c.state === 'unresolved' ? c.value : (given(r.envName) ? String(r.envName).trim() : String(r.envId).trim()));
        }
        return toList(un);
    },
    /**
     * Finds the unmapped rows carrying `value` (yielding to the event loop every APPLY_BATCH rows), then updates
     * them in one transaction. The Server List metadata entries of the same IPs are mapped too, so a later
     * sync-all / scan that pushes the metadata into the table cannot bring the old value back (I1).
     */
    async apply(value, env, envs) {
        if (!libDb) return { count: 0, keys: [] };
        const rows = this.rows();
        const ips = [];
        for (let i = 0; i < rows.length; i++) {
            if (i > 0 && i % APPLY_BATCH === 0) await new Promise(r => setImmediate(r));
            const r = rows[i];
            const c = classify(r.envId, r.envName, envs);
            if (c.state === 'ok') continue;
            if (!sameValue(rawOf(r.envId, r.envName), value)) continue;
            ips.push(r.ip);
        }
        const count = this.updateIps(ips, env, envs);
        const meta = metaConsumer.apply(value, env, envs, new Set(ips));
        return { count, keys: ips, related: { cmdb_meta: meta.count } };
    }
};

// ----------------------------------------------------------------------------- Prometheus (read-only)
/** Label values of a target that are not a canonical environment NAME (case-insensitive). '-' / empty = not set. */
function unknownPromValues(target, envs) {
    const l = obj(target && target.labels);
    const out = [];
    for (const k of PROM_LABELS) {
        const v = l[k];
        if (!given(v) || String(v).trim() === '-') continue;
        if (!envs.some(e => sameValue(e.name, v))) out.push({ label: k, value: String(v).trim() });
    }
    return out;
}

const prometheusConsumer = {
    key: 'prometheus_name', label: 'Prometheus targets (labels zone/env/environment)', readOnly: true,
    migrate() { return { resolved: 0, unresolved: [] }; },
    unmapped(envs) {
        const un = new Map();
        for (const t of arr(getTargetsSafely())) {
            const seen = new Set();
            for (const u of unknownPromValues(t, envs)) {
                if (seen.has(u.value.toLowerCase())) continue;
                seen.add(u.value.toLowerCase());
                tally(un, u.value);
            }
        }
        return toList(un);
    },
    apply() { throw Object.assign(new Error('Prometheus labels are not rewritten automatically; edit the targets in Prometheus SD'), { status: 400 }); }
};

// Server List metadata (keyed by IP). Applying a value here maps the CMDB rows of the same IPs as well (I1).
const metaDocConsumer = docConsumer('cmdb_meta', 'Server list metadata', DOCS.meta, metaOf, 'envName', 'envId', { entries: (data) => Object.entries(obj(data)) });
const metaConsumer = {
    ...metaDocConsumer,
    apply(value, env, envs, onlyKeys = null) {
        const r = metaDocConsumer.apply(value, env, envs, onlyKeys);
        if (!onlyKeys) r.related = { cmdb: cmdbConsumer.updateIps(r.keys, env, envs) };
        return r;
    }
};

const CONSUMERS = [
    cmdbConsumer,
    metaConsumer,
    docConsumer('ipam_subnets', 'IPAM subnets', DOCS.ipam, subnetsOf),
    docConsumer('ipam_ips', 'IPAM IP addresses', DOCS.ipam, ipsOf),
    docConsumer('ssl', 'SSL certificates', DOCS.ssl, flat),
    docConsumer('db_clusters', 'Database inventory', DOCS.dbInventory, flat),
    docConsumer('db_requests', 'Database requests', DOCS.dbRequests, flat),
    docConsumer('k8s', 'Kubernetes clusters', DOCS.k8s, flat),
    prometheusConsumer
];

const getConsumer = (key) => CONSUMERS.find(c => c.key === key) || null;

/**
 * Runs every consumer migration that has no marker yet. Each consumer is independent (try/catch):
 * a failure is logged, leaves its marker unset and is retried at the next start. Never throws.
 */
function runEnvironmentIdMigration(options = {}) {
    const log = options.log || ((m) => console.log(m));
    const marker = obj(readDataSync(MARKER_KEY, {}));
    const envs = reg.getEnvironments();
    const results = {};
    if (envs.length === 0) return { skipped: true, results };
    let changed = false;
    for (const c of CONSUMERS) {
        if (c.readOnly) continue;
        if (marker[c.key] && marker[c.key].migratedAt && !options.force) { results[c.key] = { skipped: true }; continue; }
        try {
            const r = c.migrate(envs);
            marker[c.key] = { migratedAt: new Date().toISOString(), resolved: r.resolved, unresolved: r.unresolved.slice(0, 200) };
            results[c.key] = r;
            changed = true;
            const unCount = r.unresolved.reduce((s, u) => s + u.count, 0);
            if (r.resolved > 0 || unCount > 0) {
                log(`[Env Migration] ${c.label}: ${r.resolved} record(s) linked to an environment id, ${unCount} unresolved (${r.unresolved.slice(0, 10).map(u => `${u.value || '(empty)'}: ${u.count}`).join(', ')})`);
            }
        } catch (e) {
            results[c.key] = { error: e.message || String(e) };
            console.error(`[Env Migration] ${c.label} failed (will retry at next start):`, e.message);
        }
    }
    if (changed) writeDataSync(MARKER_KEY, marker);
    return { results };
}

/** Distinct unresolved values per consumer: [{ key, consumer, readOnly, values: [{ value, count }], total }] */
function getUnmapped() {
    const envs = reg.getEnvironments();
    return CONSUMERS.map(c => {
        try {
            const values = c.unmapped(envs);
            return { key: c.key, consumer: c.label, readOnly: c.readOnly, values, total: values.reduce((s, v) => s + v.count, 0) };
        } catch (e) {
            return { key: c.key, consumer: c.label, readOnly: c.readOnly, values: [], total: 0, error: e.message || String(e) };
        }
    });
}

/** Assigns env to every record of one consumer carrying `value` (case-insensitive). Returns the record count. */
/**
 * Assigns env to every record of one consumer carrying `value` (case-insensitive).
 * Returns { count, related? } (related: records of a linked consumer updated too, e.g. cmdb <-> cmdb_meta).
 */
async function applyUnmapped(key, value, envId) {
    const c = getConsumer(key);
    if (!c) throw Object.assign(new Error(`Unknown consumer "${key}"`), { status: 400 });
    if (c.readOnly) return c.apply();
    const envs = reg.getEnvironments();
    const env = reg.findById(envId, envs);
    if (!env) throw Object.assign(new Error('Target environment not found'), { status: 400 });
    const r = await c.apply(String(value == null ? '' : value), env, envs);
    return { count: r.count, ...(r.related ? { related: r.related } : {}) };
}

module.exports = {
    MARKER_KEY,
    CONSUMERS,
    classify,
    unknownPromValues,
    runEnvironmentIdMigration,
    getUnmapped,
    applyUnmapped
};
