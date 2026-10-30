/**
 * SQLite Driver Implementation (better-sqlite3 / node:sqlite)
 * Provides local embedded database support with WAL & memory optimizations.
 */
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
        console.warn('[SQLite Driver] Neither better-sqlite3 nor node:sqlite available.');
    }
}

class SqliteDriver {
    constructor(config = {}) {
        this.dataDir = config.dataDir || process.env.DB_DATA_DIR || 'D:\\somp-vanguard';
        this.dbFile = config.dbFile || path.join(this.dataDir, 'scout.sqlite');
        this.db = null;
        this.dbType = 'sqlite';
    }

    ensureDb() {
        if (!this.db) {
            this.initSync();
        }
    }

    initSync() {
        if (this.db) return;
        if (!sqlite) {
            throw new Error('[SQLite Driver] No SQLite engine found in Node.js environment.');
        }

        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }
        } catch (e) {
            this.dataDir = 'C:\\ProgramData\\somp-vanguard';
            this.dbFile = path.join(this.dataDir, 'scout.sqlite');
            try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (err) {}
        }

        // Fallback check: if D:\somp-vanguard\scout.sqlite doesn't exist, check C:\ProgramData
        const fallbackPath = 'C:\\ProgramData\\somp-vanguard\\scout.sqlite';
        if (!process.env.SOMP_DISABLE_LEGACY_PATHS && !fs.existsSync(this.dbFile) && fs.existsSync(fallbackPath)) {
            try {
                console.log(`[SQLite Driver] Copying legacy scout.sqlite from ${fallbackPath} to ${this.dbFile}`);
                fs.copyFileSync(fallbackPath, this.dbFile);
            } catch (e) {}
        }

        this.db = isNodeSqlite 
            ? new sqlite(this.dbFile) 
            : new sqlite(this.dbFile, { timeout: 10000 });

        // Optimize SQLite PRAGMAs
        try {
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.db.exec('PRAGMA synchronous = NORMAL;');
            this.db.exec('PRAGMA busy_timeout = 10000;');
            this.db.exec('PRAGMA mmap_size = 268435456;'); // 256MB memory-mapped I/O
            this.db.exec('PRAGMA cache_size = -64000;');    // 64MB page cache
            this.db.exec('PRAGMA temp_store = MEMORY;');
        } catch (e) {}

        console.log(`[SQLite Driver] Database initialized at: ${this.dbFile} (WAL mode)`);
    }

    async init() {
        this.initSync();
    }

    prepare(sql) {
        this.ensureDb();
        return this.db.prepare(sql);
    }

    get(sql, params = []) {
        this.ensureDb();
        try {
            const stmt = this.db.prepare(sql);
            return stmt.get(...params) || null;
        } catch (err) {
            console.error(`[SQLite Error] get() failed: "${sql}":`, err.message);
            return null;
        }
    }

    all(sql, params = []) {
        this.ensureDb();
        try {
            const stmt = this.db.prepare(sql);
            return stmt.all(...params) || [];
        } catch (err) {
            console.error(`[SQLite Error] all() failed: "${sql}":`, err.message);
            return [];
        }
    }

    /**
     * Synchronous delay helper with sleep to yield to OS or concurrent processes
     */
    _syncDelay(ms) {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        } catch (e) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
        }
    }

    run(sql, params = []) {
        this.ensureDb();
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const stmt = this.db.prepare(sql);
                const result = stmt.run(...params);
                return {
                    changes: result?.changes || 0,
                    lastInsertRowid: result?.lastInsertRowid
                };
            } catch (err) {
                const isLocked = err.code === 'SQLITE_BUSY' || err.message?.includes('locked') || err.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 30 * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
                    this._syncDelay(delay);
                    continue;
                }
                console.error(`[SQLite Error] run() failed (attempt ${attempt + 1}/${maxAttempts}): "${sql}":`, err.message);
                throw err;
            }
        }
    }

    exec(sql) {
        this.ensureDb();
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return this.db.exec(sql);
            } catch (err) {
                const isLocked = err.code === 'SQLITE_BUSY' || err.message?.includes('locked') || err.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 30 * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
                    this._syncDelay(delay);
                    continue;
                }
                if (!err.message?.includes('duplicate column name')) {
                    console.error(`[SQLite Error] exec() failed (attempt ${attempt + 1}/${maxAttempts}):`, err.message);
                }
                throw err;
            }
        }
    }

    transaction(callback) {
        this.ensureDb();
        const self = this;
        const txWrapper = function (...args) {
            self.ensureDb();
            self.db.exec('BEGIN TRANSACTION;');
            try {
                const res = callback(self, ...args);
                self.db.exec('COMMIT;');
                return res;
            } catch (err) {
                try { self.db.exec('ROLLBACK;'); } catch (e) {}
                throw err;
            }
        };

        // Make it a Thenable so `await driver.transaction(...)` automatically executes
        txWrapper.then = function (resolve, reject) {
            try {
                const res = txWrapper();
                if (res && typeof res.then === 'function') {
                    return res.then(resolve, reject);
                }
                resolve(res);
            } catch (e) {
                reject(e);
            }
        };

        return txWrapper;
    }

    async close() {
        if (this.db) {
            try {
                this.db.close();
                console.log('[SQLite Driver] Database connection closed.');
            } catch (e) {}
            this.db = null;
        }
    }
}

module.exports = SqliteDriver;
