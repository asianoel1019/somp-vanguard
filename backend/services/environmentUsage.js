/**
 * Global Environments: where an environment is referenced (usage) and the optional rename cascade.
 * id-keyed consumers store the environment id and need nothing on rename;
 * name-keyed consumers store the free-text name (matched case-insensitively).
 *
 * Every usage item has a stable machine `key` (consumer labels are for display only).
 * Fail closed: only "no such table" counts as 0; any other read error marks the item
 * { error } and the whole usage { complete: false } so callers must not treat it as "unused".
 */
const dbManager = require('./db');
const { db: libDb, readDataSync, writeDataSync } = require('../lib/db');
const { getTargetsSafely, updateTargetsSafely } = require('../lib/prometheusTargetHelper');
const { getEnvironments } = require('../lib/environmentRegistry');

const KEYS = {
    meta: 'server_operation/server_cmdb_meta.json',
    ipam: 'network_service/ipam/subnets.json',
    ssl: 'network_service/ssl_certificates.json',
    dbInventory: 'service_platform/database_clusters.json',
    dbRequests: 'service_platform/database_requests.json',
    k8s: 'service_platform/k8s_clusters.json'
};
const PROM_LABELS = ['zone', 'env', 'environment'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const same = (a, b) => norm(a) !== '' && norm(a) === norm(b);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const isNoTable = (e) => /no such table|doesn't exist|does not exist|invalid object name/i.test(String(e && e.message));

function parseList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return [];
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

// Runs fn; a missing table is 0, any other failure becomes { error }
async function guarded(fn) {
    try {
        return { count: Number(await fn()) || 0 };
    } catch (e) {
        if (isNoTable(e)) return { count: 0 };
        return { count: 0, error: e && e.message ? e.message : String(e) };
    }
}

const sqlCount = (sql, params) => async () => {
    const row = await dbManager.get(sql, params);
    return row && (row.c ?? row.C);
};

const cmdbCount = (where, params) => () => {
    if (!libDb) return 0;
    return libDb.prepare(`SELECT COUNT(*) AS c FROM cmdb_servers WHERE ${where}`).get(...params).c;
};

// Lower-cased texts that identify an environment in legacy rows: its name and its code (same rule as the display)
const termsOf = (name, code) => [...new Set([norm(name), norm(code)].filter(Boolean))];

// A record without a valid envId that names this environment (name or code, case-insensitive; in its name
// field, or a name stored in envId)
function legacyMatch(rec, nameField, validIds, terms) {
    if (!rec || (rec.envId && validIds.has(String(rec.envId)))) return false;
    const list = Array.isArray(terms) ? terms : termsOf(terms);
    if (norm(rec[nameField]) !== '') return list.includes(norm(rec[nameField]));
    return list.includes(norm(rec.envId));
}

// SQL for the same legacy match on cmdb_servers (envName, or envId when envName is empty)
function legacySql(ids, terms) {
    const inList = terms.map(() => '?').join(',');
    return {
        sql: `(envId IS NULL OR envId NOT IN (${ids.map(() => '?').join(',')})) AND (LOWER(TRIM(COALESCE(envName, ''))) IN (${inList}) OR (COALESCE(TRIM(envName), '') = '' AND LOWER(TRIM(COALESCE(envId, ''))) IN (${inList})))`,
        params: [...ids, ...terms, ...terms]
    };
}

function promLabelHits(t, pred) {
    const l = obj(t && t.labels);
    return PROM_LABELS.some(k => pred(l[k]));
}

async function getUsage(env) {
    const { id, name } = env;
    const items = [];
    const add = async (key, consumer, keyedBy, fn) => {
        const r = await guarded(fn);
        const item = { key, consumer, count: r.count, keyedBy };
        if (r.error) item.error = r.error;
        items.push(item);
    };

    const metaDoc = () => Object.values(obj(readDataSync(KEYS.meta, {})));
    const subnets = () => arr(readDataSync(KEYS.ipam, []));
    let targets = [];
    let targetsError = null;
    try { targets = getTargetsSafely(); } catch (e) { targetsError = e.message || String(e); }
    const promById = (t) => promLabelHits(t, v => v === id);

    // ---- id-keyed
    await add('cmdb', 'CMDB servers', 'id', cmdbCount('envId = ?', [id]));
    await add('cmdb_meta', 'Server list metadata', 'id', () => metaDoc().filter(m => m && m.envId === id).length);
    await add('monitors', 'Scout monitors', 'id', sqlCount('SELECT COUNT(*) AS c FROM monitors WHERE envId = ?', [id]));
    await add('api_keys', 'API keys', 'id', sqlCount('SELECT COUNT(*) AS c FROM api_keys WHERE envId = ?', [id]));
    await add('rule_bindings', 'Alert rule bindings', 'id', sqlCount("SELECT COUNT(*) AS c FROM rule_bindings WHERE scopeType = 'env' AND scopeValue = ?", [id]));
    await add('maintenance', 'Maintenance windows', 'id', async () => {
        const rows = await dbManager.all("SELECT scopeValues FROM maintenance_windows WHERE scopeType = 'envs'");
        return arr(rows).filter(w => parseList(w.scopeValues).map(String).includes(String(id))).length;
    });
    await add('prometheus_id', 'Prometheus targets (zone = id)', 'id', () => {
        if (targetsError) throw new Error(targetsError);
        return targets.filter(promById).length;
    });

    // ---- legacy rows without a valid envId, matched by the stored name (or a name stored in envId)
    const validIds = new Set(getEnvironments().map(e => e.id));
    validIds.add(String(id));
    const ids = [...validIds];
    const terms = termsOf(name, env.code);
    const legacy = legacySql(ids, terms);
    await add('cmdb_name', 'CMDB servers (by name)', 'name', cmdbCount(legacy.sql, legacy.params));
    await add('cmdb_meta_name', 'Server list metadata (by name)', 'name', () => metaDoc().filter(m => m && legacyMatch(m, 'envName', validIds, terms)).length);

    // ---- id-keyed since phase 2 (envId next to the name); legacy rows still count by name until migrated
    const refs = (rec) => rec && (rec.envId === id || legacyMatch(rec, 'environment', validIds, terms));
    await add('ipam_subnets', 'IPAM subnets', 'id', () => subnets().filter(refs).length);
    await add('ipam_ips', 'IPAM IP addresses', 'id', () => subnets().reduce((n, s) => n + arr(s && s.ips).filter(refs).length, 0));
    await add('ssl', 'SSL certificates', 'id', () => arr(readDataSync(KEYS.ssl, [])).filter(refs).length);
    await add('db_clusters', 'Database inventory', 'id', () => arr(readDataSync(KEYS.dbInventory, [])).filter(refs).length);
    await add('db_requests', 'Database requests', 'id', () => arr(readDataSync(KEYS.dbRequests, [])).filter(refs).length);
    await add('k8s', 'Kubernetes clusters', 'id', () => arr(readDataSync(KEYS.k8s, [])).filter(refs).length);
    // a target already counted by id is not counted again by name (no double count in the total)
    await add('prometheus_name', 'Prometheus targets', 'name', () => {
        if (targetsError) throw new Error(targetsError);
        return targets.filter(t => !promById(t) && promLabelHits(t, v => same(v, name))).length;
    });

    return {
        id, name,
        total: items.reduce((s, i) => s + i.count, 0),
        complete: items.every(i => !i.error),
        items
    };
}

/**
 * Rewrites matching records of a document; returns the number of records changed.
 * id-keyed records (envId = id) only get their stored name copy refreshed (display is derived anyway);
 * legacy records without a valid envId that still carry the old name are linked to the id as well.
 */
function rewriteDoc(key, newName, oldTerms, visit, id, validIds) {
    // IPAM: atomic read-modify-write through its store (the worker writes the same document); visit must
    // not accumulate outside state across calls for it (it may be re-run in fallback mode)
    if (key === KEYS.ipam) {
        return require('../lib/ipamStore').mutateSubnets((data) => rewriteVisit(data, newName, oldTerms, visit, id, validIds), { reason: 'environment rename' });
    }
    // SSL certificates: the scan merges probe results through the same locked store
    if (key === KEYS.ssl) {
        if (readDataSync(key, null) == null) return 0;
        return require('./sslMonitorService').mutateRecords((data) => rewriteVisit(data, newName, oldTerms, visit, id, validIds), 'environment rename');
    }
    const data = readDataSync(key, null);
    if (data === null || data === undefined) return 0;
    const count = rewriteVisit(data, newName, oldTerms, visit, id, validIds);
    if (count > 0) writeDataSync(key, data);
    return count;
}

function rewriteVisit(data, newName, oldTerms, visit, id, validIds) {
    return visit(data, (rec, field) => {
        if (!rec) return 0;
        if (rec.envId === id) {
            if (rec[field] !== newName) { rec[field] = newName; return 1; }
            return 0;
        }
        if (legacyMatch(rec, field, validIds, oldTerms)) { rec.envId = id; rec[field] = newName; return 1; }
        return 0;
    });
}

const flatList = (field = 'environment') => (data, fix) => arr(data).reduce((n, r) => n + fix(r, field), 0);

/**
 * Rename follow-up. Since phase 2 every consumer except Prometheus stores the id and derives the display
 * name, so a rename is visible everywhere without this; the cascade only refreshes the stored name copies
 * (rollback / back-compat), links legacy name-only rows, and rewrites the Prometheus labels (names).
 * Each consumer is independent and idempotent, so a failed run can simply be retried.
 * Returns [{ key, consumer, count, error? }]; callers treat any `error` as a failed cascade.
 */
async function cascadeRename(env, oldName, newName) {
    const id = env.id;
    const validIds = new Set(getEnvironments().map(e => e.id));
    validIds.add(String(id));
    const ids = [...validIds];
    const oldTerms = termsOf(oldName, env.code);
    const rewrite = (key, visit) => rewriteDoc(key, newName, oldTerms, visit, id, validIds);
    const out = [];
    const step = async (key, consumer, fn) => {
        try { out.push({ key, consumer, count: Number(await fn()) || 0 }); }
        catch (e) { out.push({ key, consumer, count: 0, error: e && e.message ? e.message : String(e) }); }
    };

    await step('cmdb', 'CMDB servers', () => {
        if (!libDb) return 0;
        const legacy = legacySql(ids, oldTerms);
        return libDb.prepare(
            `UPDATE cmdb_servers SET envName = ?, envId = ?
             WHERE (envId = ? OR (${legacy.sql}))
               AND (COALESCE(envName, '') <> ? OR COALESCE(envId, '') <> ?)`
        ).run(newName, id, id, ...legacy.params, newName, id).changes;
    });

    await step('cmdb_meta', 'Server list metadata', () => rewrite(KEYS.meta, (data, fix) => {
        let n = 0;
        for (const m of Object.values(obj(data))) n += fix(m, 'envName');
        return n;
    }));

    let subnetCount = 0;
    let ipCount = 0;
    let ipamError = null;
    try {
        rewrite(KEYS.ipam, (data, fix) => {
            subnetCount = 0; ipCount = 0; // the IPAM store may re-run this visit
            for (const s of arr(data)) {
                subnetCount += fix(s, 'environment');
                for (const ip of arr(s && s.ips)) ipCount += fix(ip, 'environment');
            }
            return subnetCount + ipCount;
        });
    } catch (e) { ipamError = e && e.message ? e.message : String(e); }
    out.push({ key: 'ipam_subnets', consumer: 'IPAM subnets', count: ipamError ? 0 : subnetCount, ...(ipamError ? { error: ipamError } : {}) });
    out.push({ key: 'ipam_ips', consumer: 'IPAM IP addresses', count: ipamError ? 0 : ipCount, ...(ipamError ? { error: ipamError } : {}) });

    await step('ssl', 'SSL certificates', () => rewrite(KEYS.ssl, flatList()));
    await step('db_clusters', 'Database inventory', () => rewrite(KEYS.dbInventory, flatList()));
    await step('db_requests', 'Database requests', () => rewrite(KEYS.dbRequests, flatList()));
    await step('k8s', 'Kubernetes clusters', () => rewrite(KEYS.k8s, flatList()));

    await step('prometheus_name', 'Prometheus targets', async () => {
        const { result } = await updateTargetsSafely((targets) => {
            let n = 0;
            for (const t of targets) {
                const l = t && t.labels;
                if (!l || typeof l !== 'object') continue;
                let hit = false;
                for (const k of PROM_LABELS) {
                    if (same(l[k], oldName) && l[k] !== newName) { l[k] = newName; hit = true; }
                }
                if (hit) n++;
            }
            return n > 0 ? { targets, result: n } : { result: 0 };
        }, 'environment_rename');
        return result || 0;
    });

    return out;
}

module.exports = { getUsage, cascadeRename };
