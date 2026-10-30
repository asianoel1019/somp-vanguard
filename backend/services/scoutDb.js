/**
 * SOMP Vanguard - ScoutDB Service Facade
 * Delegates to Unified Multi-Database Manager (backend/services/db).
 * Maintains 100% backward compatibility with all legacy calls.
 */
const dbManager = require('./db');
const { warmupDocCache } = require('../lib/db');

async function initDB() {
    // 1. Initialize multi-database driver and ensure schemas
    await dbManager.initDB();

    // 2. Preload document_store RAM cache for microsecond reads
    await warmupDocCache();

    console.log('[ScoutDB] Service initialized and ready.');
    return dbManager.getDriver();
}

function getDB() {
    const driver = dbManager.getDriver();
    if (driver && typeof driver.ensureDb === 'function') {
        driver.ensureDb();
    }
    if (driver && driver.db) return driver.db; // Return native SQLite instance if available
    return driver;
}

function transaction(callback) {
    const driver = dbManager.getDriver();
    return driver.transaction(callback);
}

// Proxy CRUD calls to Unified DB Manager
function run(sqlStr, params = []) {
    return dbManager.run(sqlStr, params);
}

function queueRun(sqlStr, params = []) {
    dbManager.queueRun(sqlStr, params);
}

function flushWriteBuffer() {
    return dbManager.flushWriteBuffer();
}

function exec(sqlStr) {
    return dbManager.exec(sqlStr);
}

function all(sqlStr, params = []) {
    return dbManager.all(sqlStr, params);
}

function get(sqlStr, params = []) {
    return dbManager.get(sqlStr, params);
}

async function upsert(options) {
    return dbManager.upsert(options);
}

async function bulkInsert(table, rows) {
    return dbManager.bulkInsert(table, rows);
}

async function closeDB() {
    return dbManager.closeDB();
}

function backupDB() {
    const driver = dbManager.getDriver();
    if (driver.dbType === 'sqlite' && driver.db) {
        // SQLite native vacuum backup
        try {
            const fs = require('fs');
            const path = require('path');
            const backupDir = path.join(driver.dataDir, 'backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            const dateStr = new Date().toISOString().slice(0, 10);
            const backupPath = path.join(backupDir, `scout_backup_${dateStr}_${Date.now()}.sqlite`);
            driver.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
            console.log(`[ScoutDB Backup] Created local SQLite backup at ${backupPath}`);
            return backupPath;
        } catch (e) {
            console.error('[ScoutDB Backup Error]:', e.message);
            return null;
        }
    }
    console.log(`[ScoutDB Backup] Target database is ${driver.dbType.toUpperCase()}. Native daily backup managed via server maintenance.`);
    return null;
}

module.exports = {
    initDB,
    getDB,
    run,
    queueRun,
    flushWriteBuffer,
    exec,
    all,
    get,
    upsert,
    bulkInsert,
    transaction,
    closeDB,
    close: closeDB,
    getEngine: () => {
        const driver = dbManager.getDriver();
        return driver ? driver.dbType : 'sqlite';
    },
    backupDB
};
