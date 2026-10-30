const fs = require('fs');
const path = require('path');

let sqlite;
let isNodeSqlite = false;
try {
    sqlite = require('better-sqlite3');
} catch (e) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        sqlite = DatabaseSync;
        isNodeSqlite = true;
    } catch (e2) {
        console.warn('[DB] Neither better-sqlite3 nor node:sqlite available. VFS JSON mode active.');
    }
}

let TARGET_DB_DIR = process.env.DB_DATA_DIR || 'D:\\somp-vanguard';
try {
    if (!fs.existsSync(TARGET_DB_DIR)) {
        fs.mkdirSync(TARGET_DB_DIR, { recursive: true });
    }
} catch (e) {
    // If D: does not exist or lacks permission (e.g. dev machine), fallback to C:\ProgramData
    TARGET_DB_DIR = 'C:\\ProgramData\\somp-vanguard';
    try { fs.mkdirSync(TARGET_DB_DIR, { recursive: true }); } catch (err) {}
}
const DB_FILE = path.join(TARGET_DB_DIR, 'database.sqlite');

// Fallback: check C:\ProgramData\somp-vanguard\database.sqlite if D:\ does not exist
const OLD_DB_FILE = 'C:\\ProgramData\\somp-vanguard\\database.sqlite';
if (!process.env.SOMP_DISABLE_LEGACY_PATHS && !fs.existsSync(DB_FILE) && fs.existsSync(OLD_DB_FILE)) {
    try {
        console.log(`[Migration] Copying legacy DB from ${OLD_DB_FILE} to ${DB_FILE}`);
        fs.copyFileSync(OLD_DB_FILE, DB_FILE);
    } catch (e) {}
}

let db = null;
try {
    if (sqlite) {
        if (isNodeSqlite) {
            db = new sqlite(DB_FILE);
        } else {
            db = new sqlite(DB_FILE, { timeout: 10000 });
        }
        try { 
            db.exec('PRAGMA journal_mode = WAL;');
            db.exec('PRAGMA synchronous = NORMAL;');
            db.exec('PRAGMA busy_timeout = 10000;');
            db.exec('PRAGMA mmap_size = 268435456;');
            db.exec('PRAGMA cache_size = -64000;');
            db.exec('PRAGMA temp_store = MEMORY;');
        } catch (e) {}
        db.exec(`
            CREATE TABLE IF NOT EXISTS document_store (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
} catch (e) {
    console.warn('[DB] Local SQLite database.sqlite not active or skipped:', e.message);
}

// --------------------------------------------------------------------------
// Option A: In-Memory RAM Cache for Universal Database Document Store
// --------------------------------------------------------------------------
const inMemoryDocStore = new Map();
let isCacheWarmedUp = false;

/**
 * Preloads all document_store records from the active DB (PostgreSQL / MariaDB / MSSQL / SQLite)
 * into high-speed memory RAM Map.
 */
async function warmupDocCache() {
    try {
        const dbManager = require('../services/db');
        const rows = await dbManager.all('SELECT "key", value FROM document_store');
        if (rows && rows.length > 0) {
            for (const r of rows) {
                const k = r.key || r.KEY;
                if (k) inMemoryDocStore.set(k, r.value);
            }
            console.log(`[DocumentStore Cache] Preloaded ${rows.length} documents into RAM memory cache.`);
        }
        isCacheWarmedUp = true;
    } catch (e) {
        console.warn('[DocumentStore Cache] Failed to warmup cache from active DB (will use local fallback):', e.message);
    }
}

function syncDelay(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }
}

/**
 * Read data synchronously from Key-Value store.
 * Microsecond-speed RAM cache hit ensures 100% compatibility with synchronous fs.readFileSync.
 */
function readDataSync(key, defaultValue = null) {
    // 1. First priority: Check in-memory RAM cache (Option A)
    if (inMemoryDocStore.has(key)) {
        const val = inMemoryDocStore.get(key);
        try {
            return JSON.parse(val);
        } catch {
            return val;
        }
    }

    // 2. Second priority: Check local SQLite (if in SQLite mode)
    if (db) {
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const stmt = db.prepare('SELECT value FROM document_store WHERE key = ?');
                const row = stmt.get(key);
                if (row && row.value) {
                    inMemoryDocStore.set(key, row.value); // Populate cache
                    try {
                        return JSON.parse(row.value);
                    } catch (e) {
                        return row.value;
                    }
                }
                return defaultValue;
            } catch (e) {
                const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 25 * Math.pow(2, attempt) + Math.floor(Math.random() * 20);
                    syncDelay(delay);
                    continue;
                }
                break;
            }
        }
    }

    // 3. Third priority: Fallback to flat file on disk
    const safeKey = key.replace(/[\/\\]/g, '_');
    const fallbackPath = path.join(TARGET_DB_DIR, safeKey);
    try {
        if (fs.existsSync(fallbackPath)) {
            const raw = fs.readFileSync(fallbackPath, 'utf8');
            inMemoryDocStore.set(key, raw);
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        }

        const seedPath = path.join(__dirname, '..', 'data', safeKey);
        if (fs.existsSync(seedPath)) {
            const raw = fs.readFileSync(seedPath, 'utf8');
            inMemoryDocStore.set(key, raw);
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        }
    } catch (e) {
        console.error(`Error reading fallback flat file for key ${key}:`, e);
    }
    return defaultValue;
}

// --------------------------------------------------------------------------
// Optional write tracing (off by default): DOC_WRITE_TRACE=1 appends one line per document write to
// <data dir>/logs/doc_write_trace.log:  ISO time | pid | web|worker | key | bytes | caller file:line
// The file is rotated at 20 MB (renamed to .1). Tracing never throws and never blocks a write.
// --------------------------------------------------------------------------
const TRACE_MAX_BYTES = 20 * 1024 * 1024;
const TRACE_SKIP_FILES = /[\\/]lib[\\/](db|docStore)\.js$/;

/** 'web' or 'worker', decided the same way writeDataSync picks its IPC direction. */
function processRole() {
    if (typeof global.sendWorkerMessage === 'function') return 'web';
    if (typeof process.send === 'function') return 'worker';
    const main = require.main && require.main.filename ? path.basename(require.main.filename) : '';
    return main === 'worker.js' ? 'worker' : 'web';
}

/** First stack frames outside lib/db.js and lib/docStore.js ("file:line < file:line"). */
function traceCaller() {
    const frames = String(new Error().stack || '').split('\n').slice(1);
    const out = [];
    for (const f of frames) {
        const m = /\(?([A-Za-z]:[\\/][^():]+|\/[^():]+|[^():\s]+\.js):(\d+):\d+\)?\s*$/.exec(f.trim());
        if (!m) continue;
        const file = m[1];
        if (TRACE_SKIP_FILES.test(file) || file.startsWith('node:')) continue;
        const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
        out.push(`${rel.startsWith('..') ? file : rel}:${m[2]}`);
        if (out.length >= 2) break;
    }
    return out.join(' < ') || 'unknown';
}

function traceWrite(key, bytes) {
    try {
        if (process.env.DOC_WRITE_TRACE !== '1') return;
        const dir = path.join(TARGET_DB_DIR, 'logs');
        const file = path.join(dir, 'doc_write_trace.log');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
            if (fs.statSync(file).size >= TRACE_MAX_BYTES) fs.renameSync(file, `${file}.1`);
        } catch (e) { /* no file yet */ }
        fs.appendFileSync(file, `${new Date().toISOString()} | ${process.pid} | ${processRole()} | ${key} | ${bytes} | ${traceCaller()}\n`);
    } catch (e) { /* tracing is best effort */ }
}

/**
 * Write data synchronously to Key-Value store with async DB write-through.
 */
function writeDataSync(key, data) {
    const strData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    traceWrite(key, Buffer.byteLength(strData, 'utf8'));

    // 1. Immediately update RAM cache (synchronous read guaranteed)
    inMemoryDocStore.set(key, strData);

    // Broadcast cache invalidation / sync to background Worker if running in Web process
    if (typeof global.sendWorkerMessage === 'function') {
        try {
            global.sendWorkerMessage({ type: 'INVALIDATE_DOC_CACHE', key, data: strData });
        } catch (e) {}
    }

    // Worker -> Web: a forked child has no sendWorkerMessage, tell the supervisor to refresh its RAM cache
    else if (typeof process.send === 'function' && process.connected !== false) {
        try {
            // key only: the web process drops its cached copy and reloads from the shared database.sqlite
            process.send({ type: 'DOC_CACHE_UPDATED', key });
        } catch (e) {}
    }

    // 2. Write-through to active DB (PostgreSQL / MariaDB / MSSQL / SQLite)
    try {
        const dbManager = require('../services/db');
        dbManager.upsert({
            table: 'document_store',
            conflictKeys: ['key'],
            data: { key, value: strData, updatedAt: new Date().toISOString() }
        }).catch(err => {
            // Non-critical background warning
            // console.warn(`[DocumentStore Async Error] Failed to persist key ${key}:`, err.message);
        });
    } catch (e) {}

    // 3. Also write to local SQLite if running in SQLite mode with exponential backoff
    let localOk = false;
    if (db) {
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const stmt = db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)');
                stmt.run(key, strData);
                localOk = true;
                break;
            } catch (e) {
                const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 30 * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
                    syncDelay(delay);
                    continue;
                }
                console.warn(`[db.js writeDataSync] SQLite write failed after ${attempt + 1} attempts:`, e.message);
                break;
            }
        }
    }

    // 4. Flat file fallback: only when the local SQLite write did not succeed
    //    (no local db / VFS JSON mode, or the write failed). Otherwise the DB is the only copy.
    if (!localOk) {
        const safeKey = key.replace(/[\/\\]/g, '_');
        const fallbackPath = path.join(TARGET_DB_DIR, safeKey);
        try {
            fs.writeFileSync(fallbackPath, strData);
        } catch (e) {}
    }

    return true;
}

/**
 * Remove a document everywhere: RAM cache (this process and the peer process), the active DB,
 * the local SQLite and the flat-file fallback. The next readDataSync(key, def) returns def.
 */
function deleteDataSync(key) {
    inMemoryDocStore.delete(key);

    if (typeof global.sendWorkerMessage === 'function') {
        try {
            // no data -> the worker's invalidateCache drops the key
            global.sendWorkerMessage({ type: 'INVALIDATE_DOC_CACHE', key });
        } catch (e) {}
    } else if (typeof process.send === 'function' && process.connected !== false) {
        try {
            process.send({ type: 'DOC_CACHE_UPDATED', key });
        } catch (e) {}
    }

    try {
        const dbManager = require('../services/db');
        Promise.resolve(dbManager.run('DELETE FROM document_store WHERE "key" = ?', [key])).catch(() => {});
    } catch (e) {}

    if (db) {
        try {
            db.prepare('DELETE FROM document_store WHERE key = ?').run(key);
        } catch (e) {
            console.warn(`[db.js deleteDataSync] SQLite delete failed for ${key}:`, e.message);
        }
    }

    const safeKey = key.replace(/[\/\\]/g, '_');
    const fallbackPath = path.join(TARGET_DB_DIR, safeKey);
    try {
        if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
    } catch (e) {}

    return true;
}

function invalidateCache(key, newValue = null) {
    if (!key) {
        inMemoryDocStore.clear();
    } else if (newValue !== null) {
        inMemoryDocStore.set(key, typeof newValue === 'string' ? newValue : JSON.stringify(newValue, null, 2));
    } else {
        inMemoryDocStore.delete(key);
    }
}

async function readDnsDb(forceFresh = false) {
    if (forceFresh) {
        invalidateCache('dns_data.json');
    }
    return readDataSync('dns_data.json', { servers: [] });
}

async function writeDnsDb(data) {
    writeDataSync('dns_data.json', data);
}

module.exports = {
    readDB: readDnsDb,
    writeDB: writeDnsDb,
    readDataSync,
    writeDataSync,
    deleteDataSync,
    invalidateCache,
    warmupDocCache,
    getDataDir: () => TARGET_DB_DIR,
    db
};
