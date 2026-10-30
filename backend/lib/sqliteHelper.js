const fs = require('fs');
const path = require('path');

// Cache SQL.js instance once loaded
let sqlJsInstance = null;

async function getSqlJs() {
    if (!sqlJsInstance) {
        const initSqlJs = require('sql.js');
        sqlJsInstance = await initSqlJs();
    }
    return sqlJsInstance;
}

/**
 * Check if the file is a valid SQLite 3 database by header
 */
function isValidSqliteHeader(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(16);
        fs.readSync(fd, buffer, 0, 16, 0);
        return buffer.toString('utf8', 0, 15) === 'SQLite format 3';
    } catch (e) {
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Test connection to a SQLite database file
 */
async function testConnection(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('SQLite 資料庫檔案路徑未指定');
    }

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`SQLite 檔案不存在: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
        throw new Error(`指定路徑為目錄而非 SQLite 檔案: ${resolvedPath}`);
    }

    if (stat.size > 0 && !isValidSqliteHeader(resolvedPath)) {
        throw new Error(`檔案不是合法的 SQLite 資料庫格式 (缺少 SQLite 檔案標頭)`);
    }

    // Attempt to open and run SELECT 1
    const rows = await executeQuery(resolvedPath, 'SELECT 1 AS connected;');
    const tables = await getTables(resolvedPath);

    return {
        success: true,
        message: `連線成功！檔案大小: ${(stat.size / 1024).toFixed(2)} KB，包含 ${tables.length} 個資料表。`,
        filePath: resolvedPath,
        sizeBytes: stat.size,
        tablesCount: tables.length
    };
}

/**
 * Get list of table names in the SQLite database
 */
async function getTables(filePath) {
    try {
        const rows = await executeQuery(filePath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
        return rows.map(r => r.name);
    } catch (e) {
        return [];
    }
}

/**
 * Execute a query on the SQLite database and return an array of row objects
 */
async function executeQuery(filePath, query) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`SQLite 資料庫檔案未找到: ${resolvedPath}`);
    }

    // Priority 1: Check if node:sqlite is available (Node.js 22.5+)
    let nodeSqliteAvailable = false;
    try {
        const { DatabaseSync } = require('node:sqlite');
        if (typeof DatabaseSync === 'function') {
            nodeSqliteAvailable = true;
            let db = null;
            try {
                db = new DatabaseSync(resolvedPath, { readOnly: true });
                const stmt = db.prepare(query);
                const results = stmt.all();
                return results;
            } finally {
                if (db) {
                    try { db.close(); } catch (_) {}
                }
            }
        }
    } catch (err) {
        // Fallback to sql.js if node:sqlite fails or throws
        nodeSqliteAvailable = false;
    }

    // Priority 2: Pure JS / WebAssembly sql.js (guaranteed cross-platform, e.g. Windows Server 2016)
    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(resolvedPath);
    let db = null;
    try {
        db = new SQL.Database(fileBuffer);
        const execResults = db.exec(query);
        if (!execResults || execResults.length === 0) {
            return [];
        }

        const { columns, values } = execResults[0];
        const rows = values.map(rowVals => {
            const obj = {};
            columns.forEach((col, idx) => {
                obj[col] = rowVals[idx];
            });
            return obj;
        });

        return rows;
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
}

/**
 * Get detailed schema (columns, types, pk, notnull) for tables in SQLite
 */
async function getSchemaDetails(filePath) {
    const tables = await getTables(filePath);
    const schema = {};

    for (const tbl of tables) {
        try {
            const cols = await executeQuery(filePath, `PRAGMA table_info("${tbl.replace(/"/g, '""')}");`);
            schema[tbl] = cols.map(c => ({
                name: c.name,
                type: c.type || 'TEXT',
                notnull: c.notnull === 1,
                pk: c.pk === 1,
                dflt_value: c.dflt_value
            }));
        } catch (e) {
            schema[tbl] = [];
        }
    }
    return schema;
}

/**
 * Execute VACUUM to compress and defragment SQLite database file
 */
async function executeVacuum(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`SQLite 檔案未找到: ${resolvedPath}`);
    }

    const beforeStat = fs.statSync(resolvedPath);

    // Use node:sqlite in readWrite mode or sql.js export
    let vacuumExecuted = false;
    try {
        const { DatabaseSync } = require('node:sqlite');
        if (typeof DatabaseSync === 'function') {
            const db = new DatabaseSync(resolvedPath);
            try {
                db.exec('VACUUM;');
                vacuumExecuted = true;
            } finally {
                db.close();
            }
        }
    } catch (err) {
        vacuumExecuted = false;
    }

    if (!vacuumExecuted) {
        const SQL = await getSqlJs();
        const fileBuffer = fs.readFileSync(resolvedPath);
        const db = new SQL.Database(fileBuffer);
        try {
            db.exec('VACUUM;');
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(resolvedPath, buffer);
        } finally {
            db.close();
        }
    }

    const afterStat = fs.statSync(resolvedPath);
    return {
        success: true,
        beforeBytes: beforeStat.size,
        afterBytes: afterStat.size,
        freedBytes: Math.max(0, beforeStat.size - afterStat.size)
    };
}

/**
 * Get storage stats including WAL/SHM file presence
 */
function getStorageStats(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        return { exists: false };
    }
    const stat = fs.statSync(resolvedPath);
    const walPath = `${resolvedPath}-wal`;
    const shmPath = `${resolvedPath}-shm`;

    let walBytes = 0;
    let shmBytes = 0;
    if (fs.existsSync(walPath)) {
        try { walBytes = fs.statSync(walPath).size; } catch (_) {}
    }
    if (fs.existsSync(shmPath)) {
        try { shmBytes = fs.statSync(shmPath).size; } catch (_) {}
    }

    return {
        exists: true,
        mainBytes: stat.size,
        walBytes,
        shmBytes,
        totalBytes: stat.size + walBytes + shmBytes,
        updatedAt: stat.mtime
    };
}

module.exports = {
    testConnection,
    executeQuery,
    getTables,
    getSchemaDetails,
    executeVacuum,
    getStorageStats,
    isValidSqliteHeader
};

