/**
 * Generic cross-process document store: atomic read-modify-write of ONE document key.
 *
 * The web process and the forked worker both write documents. A plain readDataSync -> modify -> writeDataSync
 * works on the RAM-cached copy of one process and silently overwrites a change the other process made in between.
 * mutateDocument(key, fn) instead:
 *   - local SQLite present (normal case, lib/db.js `db`, node:sqlite / better-sqlite3): BEGIN IMMEDIATE on the shared
 *     database.sqlite (cross-process write lock), reads the CURRENT row from document_store (bypassing the RAM
 *     cache), runs fn(doc) synchronously, writes through writeDataSync (RAM cache, peer-process invalidation,
 *     write-through to the active DB; its local SQLite write joins this transaction) and COMMITs.
 *   - no local SQLite (VFS JSON mode): optimistic revision check on opts.fallbackRevisionKey, the document is
 *     re-read from the shared fallback file (cache dropped), fn re-runs when another process bumped the revision
 *     meanwhile (best effort: the check and the write are not one atomic step across processes).
 *
 * fn(doc) mutates the document IN PLACE (use splice to remove array items) and must be synchronous; its return
 * value is returned by mutateDocument. Keep fn's outputs in that return value (do not accumulate into outer
 * variables): in fallback mode fn can run more than once. Nothing is written when the document is unchanged.
 *
 * lib/ipamStore.js (mutateSubnets) is a thin wrapper around this module.
 */
const dbMod = require('./db');

const MAX_ATTEMPTS = 5;

const arr = (v) => (Array.isArray(v) ? v : []);

function syncDelay(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (e) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

const isBusy = (e) => !!e && (e.code === 'SQLITE_BUSY' || /locked|busy/i.test(String(e.message || '')));

/** Normalised options: key-specific defaults, shape normaliser, names used in error messages. */
function resolveOpts(key, opts = {}) {
    const defaultValue = opts.defaultValue !== undefined ? opts.defaultValue : [];
    const isArrayDoc = Array.isArray(defaultValue);
    const normalize = typeof opts.normalize === 'function'
        ? opts.normalize
        : (isArrayDoc
            ? arr
            : (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : JSON.parse(JSON.stringify(defaultValue))));
    return {
        key,
        normalize,
        // optional codec for documents not stored as plain JSON (e.g. an encrypted string): decode(stored) -> value,
        // encode(doc) -> the string to store. Changes are detected on JSON.stringify(doc) (the decoded value).
        decode: typeof opts.decode === 'function' ? opts.decode : null,
        encode: typeof opts.encode === 'function' ? opts.encode : null,
        fallbackRevisionKey: opts.fallbackRevisionKey || `${String(key).replace(/\.json$/i, '')}.revision.json`,
        fnName: opts.fnName || 'docStore.mutateDocument',
        label: opts.label || key,
        reason: opts.reason,
    };
}

function parseDoc(raw, o) {
    if (o.decode) {
        if (raw === null || raw === undefined || raw === '') return o.normalize(o.decode(null));
        try { return o.normalize(o.decode(raw)); } catch (e) { return o.normalize(null); }
    }
    if (raw === null || raw === undefined || raw === '') return o.normalize(null);
    try { return o.normalize(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) { return o.normalize(null); }
}

/** The stored document, bypassing the RAM cache (inside the write lock). */
function loadLocked(handle, o) {
    const row = handle.prepare('SELECT value FROM document_store WHERE key = ?').get(o.key);
    if (row && row.value) return parseDoc(row.value, o);
    // Not in the local SQLite: the copy this process has (RAM cache warmed from the active DB, else the flat-file
    // fallback / seed). The cache is NOT dropped here: when the document only exists in the active DB (e.g. a
    // PostgreSQL deployment whose database.sqlite never had it) dropping it would read the default and wipe the
    // document. The first write stores it in the local SQLite, later mutations are then fully locked.
    const cached = dbMod.readDataSync(o.key, null);
    return o.decode ? parseDoc(cached, o) : o.normalize(cached);
}

/** The value to store: the codec's string, else the pretty JSON already computed for the change check. */
const encodeDoc = (doc, json, o) => (o.encode ? o.encode(doc) : json);

/** Fallback mode: the shared flat-file copy (cache dropped); the cached copy when there is no file. */
function loadFresh(o) {
    const cached = dbMod.readDataSync(o.key, null);
    dbMod.invalidateCache(o.key);
    const fresh = dbMod.readDataSync(o.key, null);
    const norm = (v) => (o.decode ? parseDoc(v, o) : o.normalize(v));
    if (fresh !== null && fresh !== undefined) return norm(fresh);
    if (cached !== null && cached !== undefined) dbMod.invalidateCache(o.key, cached); // keep it for readers
    return norm(cached);
}

function begin(handle) {
    for (let attempt = 0; ; attempt++) {
        try { handle.exec('BEGIN IMMEDIATE'); return; }
        catch (e) {
            if (isBusy(e) && attempt < MAX_ATTEMPTS - 1) { syncDelay(30 * Math.pow(2, attempt) + Math.floor(Math.random() * 25)); continue; }
            throw e;
        }
    }
}

function runFn(fn, doc, o) {
    const result = fn(doc);
    if (result && typeof result.then === 'function') {
        throw new Error(`${o.fnName}: fn must be synchronous (it returned a Promise)`);
    }
    return result;
}

function mutateLocked(handle, fn, o) {
    const own = !(handle.isTransaction || handle.inTransaction);
    if (own) begin(handle);
    let wrote = false;
    try {
        const doc = loadLocked(handle, o);
        const before = JSON.stringify(doc, null, 2);
        const result = runFn(fn, doc, o);
        const after = JSON.stringify(doc, null, 2);
        if (after !== before) {
            dbMod.writeDataSync(o.key, encodeDoc(doc, after, o));
            wrote = true;
        }
        if (own) handle.exec('COMMIT');
        return result;
    } catch (e) {
        if (own) { try { handle.exec('ROLLBACK'); } catch (_) { /* not in a transaction */ } }
        // the RAM cache may hold the rolled-back value: drop it so the next read goes to the database
        if (wrote) dbMod.invalidateCache(o.key);
        if (o.reason) e.message = `${e.message} (${o.label} ${o.reason})`;
        throw e;
    }
}

function readRevision(revisionKey) {
    dbMod.invalidateCache(revisionKey);
    const r = dbMod.readDataSync(revisionKey, { rev: 0 });
    return Number(r && r.rev) || 0;
}

function mutateWithRevision(fn, o) {
    for (let attempt = 0; ; attempt++) {
        const rev = readRevision(o.fallbackRevisionKey);
        const doc = loadFresh(o);
        const before = JSON.stringify(doc, null, 2);
        const result = runFn(fn, doc, o);
        const after = JSON.stringify(doc, null, 2);
        if (after === before) return result;
        if (readRevision(o.fallbackRevisionKey) !== rev && attempt < MAX_ATTEMPTS - 1) continue; // another process wrote meanwhile: redo on its version
        dbMod.writeDataSync(o.key, encodeDoc(doc, after, o));
        dbMod.writeDataSync(o.fallbackRevisionKey, { rev: rev + 1, updatedAt: new Date().toISOString() });
        return result;
    }
}

/**
 * Atomic read-modify-write of the document stored under `key`. Returns fn's return value.
 * opts:
 *   fallbackRevisionKey  revision document used when there is no local SQLite (default `<key>.revision.json`)
 *   defaultValue         value when the document does not exist (default []; an object default makes it an object doc)
 *   normalize(v)         shape normaliser applied to the loaded value (default: array docs -> array, object docs -> object)
 *   decode(raw), encode(doc)  codec for a document that is not stored as JSON (e.g. system/rbac.json, encrypted);
 *                        decode receives the stored value (null when absent), encode returns the string to store
 *   fnName, label, reason  diagnostics only (error messages)
 */
function mutateDocument(key, fn, opts = {}) {
    if (typeof fn !== 'function') throw new TypeError(`${opts.fnName || 'docStore.mutateDocument'}: fn must be a function`);
    if (!key || typeof key !== 'string') throw new TypeError('docStore.mutateDocument: key must be a non-empty string');
    const o = resolveOpts(key, opts);
    const handle = dbMod.db; // read at call time (tests swap it)
    if (handle) return mutateLocked(handle, fn, o);
    return mutateWithRevision(fn, o);
}

/** Replaces the contents of `doc` (array or object, in place) with `value` (same kind). */
function replaceContents(doc, value) {
    if (Array.isArray(doc)) {
        doc.length = 0;
        for (const v of Array.isArray(value) ? value : []) doc.push(v);
        return doc;
    }
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, value && typeof value === 'object' ? value : {});
    return doc;
}

/**
 * Whole-document replacement under the same lock as mutateDocument (for writers whose new value is computed in full,
 * e.g. a validated settings object). Prefer mutateDocument with a delta when the value was derived from an earlier read.
 */
function replaceDocument(key, value, opts = {}) {
    const defaultValue = opts.defaultValue !== undefined ? opts.defaultValue : (Array.isArray(value) ? [] : {});
    return mutateDocument(key, (doc) => { replaceContents(doc, value); }, { ...opts, defaultValue });
}

module.exports = { mutateDocument, replaceDocument, replaceContents };
