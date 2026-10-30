/**
 * SOMP Vanguard - Unified Multi-Database Manager
 * Supports SQLite (Embedded Default), PostgreSQL, MariaDB/MySQL, and Microsoft SQL Server.
 */
const SqliteDriver = require('./drivers/sqliteDriver');
const PgDriver = require('./drivers/pgDriver');
const MysqlDriver = require('./drivers/mysqlDriver');
const MssqlDriver = require('./drivers/mssqlDriver');
const { buildUpsertSql, translateSql } = require('./translator');

let activeDriver = null;
let writeQueue = [];
let flushIntervalTimer = null;
let isInitialized = false;

function resolveDriverType() {
    const rawType = (process.env.DB_TYPE || '').toLowerCase().trim();
    if (!rawType || rawType === 'sqlite' || !process.env.DB_HOST) {
        return 'sqlite';
    }
    if (rawType === 'postgres' || rawType === 'pg' || rawType === 'postgresql') return 'postgres';
    if (rawType === 'mariadb' || rawType === 'mysql') return 'mariadb';
    if (rawType === 'mssql' || rawType === 'sqlserver') return 'mssql';
    return 'sqlite';
}

function createDriver(type) {
    switch (type) {
        case 'postgres':
            return new PgDriver();
        case 'mariadb':
            return new MysqlDriver();
        case 'mssql':
            return new MssqlDriver();
        case 'sqlite':
        default:
            return new SqliteDriver();
    }
}

async function initDB() {
    if (isInitialized && activeDriver) return activeDriver;

    const dbType = resolveDriverType();
    console.log(`[DB Manager] Resolving database engine: ${dbType.toUpperCase()}`);

    activeDriver = createDriver(dbType);
    await activeDriver.init();

    // Ensure database schemas exist
    await ensureSchemas(activeDriver);

    // Start background batch flush queue
    if (!flushIntervalTimer) {
        flushIntervalTimer = setInterval(flushWriteBuffer, 1000);
    }

    isInitialized = true;
    return activeDriver;
}

/**
 * Ensures all core system tables and indexes exist on the target database.
 */
async function ensureSchemas(driver) {
    const type = driver.dbType;
    console.log(`[DB Manager] Verifying schema integrity for ${type.toUpperCase()}...`);

    const textType = (type === 'mariadb') ? 'LONGTEXT' : (type === 'mssql' ? 'NVARCHAR(MAX)' : 'TEXT');
    const idType = (type === 'mariadb' || type === 'postgres') ? 'VARCHAR(64)' : (type === 'mssql' ? 'NVARCHAR(64)' : 'TEXT');
    const keyType = (type === 'mariadb' || type === 'postgres') ? 'VARCHAR(255)' : (type === 'mssql' ? 'NVARCHAR(255)' : 'TEXT');
    const autoInt = (type === 'mariadb') ? 'BIGINT AUTO_INCREMENT PRIMARY KEY' 
                  : (type === 'postgres') ? 'BIGSERIAL PRIMARY KEY'
                  : (type === 'mssql') ? 'BIGINT IDENTITY(1,1) PRIMARY KEY'
                  : 'INTEGER PRIMARY KEY AUTOINCREMENT';

    // 1. document_store (Unified VFS Document Storage)
    try {
        await driver.exec(`
            CREATE TABLE IF NOT EXISTS document_store (
                ${(type === 'mssql') ? '[key]' : (type === 'mariadb' ? '`key`' : '"key"')} ${keyType} PRIMARY KEY,
                value ${textType},
                updatedAt ${idType}
            );
        `);
    } catch (e) {}

    // 2. monitors
    try {
        await driver.exec(`
            CREATE TABLE IF NOT EXISTS monitors (
                id ${idType} PRIMARY KEY,
                name ${idType},
                ip ${idType},
                os ${idType},
                group_name ${idType},
                tags ${textType},
                apiKey ${idType},
                enabled INTEGER,
                reportInterval INTEGER,
                status ${idType},
                lastSeen ${idType},
                createdAt ${idType},
                envId ${idType},
                pingTargets ${textType},
                tcpTargets ${textType},
                watchServices ${textType},
                watchProcesses ${textType},
                version ${idType},
                disableReportLog INTEGER DEFAULT 1,
                logPath ${idType} DEFAULT '/var/log/scout-agent.log'
            );
        `);
    } catch (e) {}

    // 3. metrics
    try {
        await driver.exec(`
            CREATE TABLE IF NOT EXISTS metrics (
                id ${autoInt},
                monitorId ${idType},
                timestamp ${idType},
                metrics ${textType}
            );
        `);
    } catch (e) {}

    // 4. windows_events
    try {
        await driver.exec(`
            CREATE TABLE IF NOT EXISTS windows_events (
                id ${idType} PRIMARY KEY,
                host ${idType},
                level ${idType},
                eventID INTEGER,
                provider ${idType},
                message ${textType},
                raw ${textType},
                timestamp ${idType}
            );
        `);
    } catch (e) {}

    // 5. linux_logs
    try {
        await driver.exec(`
            CREATE TABLE IF NOT EXISTS linux_logs (
                id ${idType} PRIMARY KEY,
                host ${idType},
                filePath ${textType},
                format ${idType},
                message ${textType},
                tags ${textType},
                raw ${textType},
                timestamp ${idType}
            );
        `);
    } catch (e) {}

    // 6. Management Tables
    const managementTables = [
        `CREATE TABLE IF NOT EXISTS winevent_policy (id ${idType} PRIMARY KEY, rules ${textType});`,
        `CREATE TABLE IF NOT EXISTS linux_log_policy (id ${idType} PRIMARY KEY, rules ${textType});`,
        `CREATE TABLE IF NOT EXISTS api_keys (id ${idType} PRIMARY KEY, name ${idType}, "desc" ${textType}, key ${idType}, createdAt ${idType}, envId ${idType}, maxAgents INTEGER, isOpenApi INTEGER DEFAULT 0);`,
        `CREATE TABLE IF NOT EXISTS log_rotation_settings (id ${idType} PRIMARY KEY, maxRetentionDays INTEGER, maxRecords INTEGER, enabled INTEGER);`,
        `CREATE TABLE IF NOT EXISTS rules (id ${idType} PRIMARY KEY, name ${idType}, type ${idType}, target ${idType}, threshold REAL, cpuThreshold REAL, memThreshold REAL, alertHits INTEGER, actions ${textType}, recoveryNotify INTEGER, remediationScript ${textType}, remediationCooldown INTEGER, remediationMaxRetries INTEGER, category ${idType} DEFAULT 'metric', logConfig ${textType});`,
        `CREATE TABLE IF NOT EXISTS rule_bindings (id ${idType} PRIMARY KEY, ruleId ${idType}, scopeType ${idType}, scopeValue ${idType});`,
        `CREATE TABLE IF NOT EXISTS alerts (id ${idType} PRIMARY KEY, monitorId ${idType}, checkId ${idType}, ruleName ${idType}, type ${idType}, target ${idType}, value ${textType}, threshold REAL, triggeredAt ${idType}, resolved INTEGER, resolvedAt ${idType});`,
        `CREATE TABLE IF NOT EXISTS alert_state (stateKey ${idType} PRIMARY KEY, hitCount INTEGER, status ${idType});`,
        `CREATE TABLE IF NOT EXISTS remediation_logs (id ${idType} PRIMARY KEY, monitorId ${idType}, hostname ${idType}, ip ${idType}, ruleId ${idType}, ruleName ${idType}, type ${idType}, target ${idType}, script ${textType}, output ${textType}, success INTEGER, timestamp ${idType});`,
        `CREATE TABLE IF NOT EXISTS siem_reports (id ${idType} PRIMARY KEY, reportType ${idType}, startTime ${idType}, endTime ${idType}, content ${textType}, timestamp ${idType});`,
        `CREATE TABLE IF NOT EXISTS forensic_tasks (id ${idType} PRIMARY KEY, monitorId ${idType}, scanType ${idType}, status ${idType}, params ${textType}, createdAt ${idType}, completedAt ${idType});`,
        `CREATE TABLE IF NOT EXISTS forensic_reports (id ${idType} PRIMARY KEY, taskId ${idType}, monitorId ${idType}, scanType ${idType}, content ${textType}, timestamp ${idType});`,
        // Alert quality (2026-10-14). Alert engine supports SQLite only (synchronous db usage);
        // other engines get these tables too but the engine does not write to them yet.
        `CREATE TABLE IF NOT EXISTS maintenance_windows (id ${idType} PRIMARY KEY, name ${idType}, reason ${textType}, kind ${idType}, startAt ${idType}, endAt ${idType}, weekdays ${idType}, startTime ${idType}, durationMin INTEGER, scopeType ${idType}, scopeValues ${textType}, ruleIds ${textType}, enabled INTEGER, source ${idType}, createdBy ${idType}, createdAt ${idType}, updatedAt ${idType});`,
        `CREATE TABLE IF NOT EXISTS notify_state (stateKey ${idType} PRIMARY KEY, lastTriggerNotifiedAt ${idType}, lastRecoveryNotifiedAt ${idType}, transitions ${textType}, flappingSince ${idType});`,
        `CREATE TABLE IF NOT EXISTS notify_rate (bucket ${idType} PRIMARY KEY, count INTEGER);`,
        `CREATE TABLE IF NOT EXISTS notify_digest (id ${autoInt}, createdAt ${idType}, line ${textType});`,
        // Alert rule exclusions ("Excluded hosts"): scopeType 'monitor' | 'tag'; never mixed into rule_bindings
        `CREATE TABLE IF NOT EXISTS rule_exclusions (id ${idType} PRIMARY KEY, ruleId ${idType}, scopeType ${idType}, scopeValue ${idType}, reason ${textType}, createdBy ${idType}, createdAt ${idType});`
    ];

    for (const sql of managementTables) {
        try {
            await driver.exec((type === 'mariadb') ? sql.replace(/"desc"/g, '`desc`') : sql);
        } catch (e) {}
    }

    // Auto-migrate new columns for rules table
    try {
        await driver.exec(`ALTER TABLE rules ADD COLUMN category ${idType} DEFAULT 'metric';`);
    } catch (e) {}
    try {
        await driver.exec(`ALTER TABLE rules ADD COLUMN logConfig ${textType};`);
    } catch (e) {}

    // Alert quality (2026-10-14): additive, NULL = previous behaviour
    for (const sql of [
        `ALTER TABLE alerts ADD COLUMN suppressedReason ${idType};`,
        `ALTER TABLE alerts ADD COLUMN escalatedAt ${idType};`,
        `ALTER TABLE alerts ADD COLUMN occurrences INTEGER;`,
        `ALTER TABLE rules ADD COLUMN escalateAfterMin INTEGER;`,
        // Rule exclusions: 'excluded' when an open alert was closed because its host was excluded from the rule
        `ALTER TABLE alerts ADD COLUMN resolvedReason ${idType};`,
    ]) {
        try { await driver.exec(sql); } catch (e) {}
    }

    // Server Inventory per-row storage (SQLite only: the inventory store uses synchronous statements)
    if (type === 'sqlite' && driver.db) {
        try { require('../inventoryStore').ensureTable(driver.db); } catch (e) {}
    }

    // Rule exclusions: one row per (ruleId, scopeType, scopeValue). Rows duplicated by a race before the unique index
    // existed are removed first (keep the oldest row); the table is tiny, so this is cheap on every start.
    try {
        await driver.exec(`DELETE FROM rule_exclusions WHERE id IN (SELECT e.id FROM rule_exclusions e
            WHERE EXISTS (SELECT 1 FROM rule_exclusions o WHERE o.ruleId = e.ruleId AND o.scopeType = e.scopeType AND o.scopeValue = e.scopeValue
                AND (COALESCE(o.createdAt, '') < COALESCE(e.createdAt, '') OR (COALESCE(o.createdAt, '') = COALESCE(e.createdAt, '') AND o.id < e.id))));`);
    } catch (e) {}
    try {
        await driver.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_exclusions_unique ON rule_exclusions(ruleId, scopeType, scopeValue);`);
    } catch (e) {}

    // 7. Performance Indexes
    const indexList = [
        `CREATE INDEX IF NOT EXISTS idx_metrics_monId ON metrics(monitorId);`,
        `CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(timestamp);`,
        `CREATE INDEX IF NOT EXISTS idx_win_events_ts ON windows_events(timestamp);`,
        `CREATE INDEX IF NOT EXISTS idx_lin_logs_ts ON linux_logs(timestamp);`,
        `CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(resolved, monitorId, checkId);`,
        // Global Environments usage / delete guard (lookup by environment id)
        `CREATE INDEX IF NOT EXISTS idx_monitors_envid ON monitors(envId);`,
        `CREATE INDEX IF NOT EXISTS idx_rule_bindings_scope ON rule_bindings(scopeType, scopeValue);`,
        `CREATE INDEX IF NOT EXISTS idx_rule_exclusions_rule ON rule_exclusions(ruleId);`,
        `CREATE INDEX IF NOT EXISTS idx_rule_exclusions_scope ON rule_exclusions(scopeType, scopeValue);`
    ];

    for (const idx of indexList) {
        try {
            await driver.exec(idx);
        } catch (e) {}
    }

    console.log(`[DB Manager] All database schemas and indexes ready.`);
}

function getDriver() {
    if (!activeDriver) {
        // Safe lazy fallback
        activeDriver = createDriver(resolveDriverType());
    }
    return activeDriver;
}

// --------------------------------------------------------------------------
// Core CRUD Interfaces
// --------------------------------------------------------------------------

function get(sqlStr, params = []) {
    const driver = getDriver();
    return driver.get(sqlStr, params);
}

function all(sqlStr, params = []) {
    const driver = getDriver();
    return driver.all(sqlStr, params);
}

function run(sqlStr, params = []) {
    const driver = getDriver();
    return driver.run(sqlStr, params);
}

function exec(sqlStr) {
    const driver = getDriver();
    return driver.exec(sqlStr);
}

/**
 * Upsert abstraction
 */
async function upsert({ table, data, conflictKeys = ['id'] }) {
    const driver = getDriver();
    const { sql, values } = buildUpsertSql(table, data, conflictKeys, driver.dbType);
    return driver.run(sql, values);
}

/**
 * High-performance write buffer queue (flush every second or 500 items)
 */
function queueRun(sqlStr, params = []) {
    writeQueue.push({ sqlStr, params });
    if (writeQueue.length >= 500) {
        flushWriteBuffer();
    }
}

async function flushWriteBuffer() {
    if (writeQueue.length === 0) return;
    const items = writeQueue;
    writeQueue = [];

    const driver = getDriver();
    try {
        await driver.transaction(async (trx) => {
            for (const item of items) {
                await trx.run(item.sqlStr, item.params);
            }
        });
    } catch (err) {
        console.error('[DB Manager Batch Error] Failed to flush write queue:', err.message);
    }
}

/**
 * Bulk insert helper for migration or streaming
 */
async function bulkInsert(table, rows = []) {
    if (!rows || rows.length === 0) return;
    const driver = getDriver();
    const keys = Object.keys(rows[0]);

    if (driver.dbType === 'mariadb' || driver.dbType === 'mysql') {
        const placeholders = `(${keys.map(() => '?').join(',')})`;
        const sql = `INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES ${rows.map(() => placeholders).join(',')}`;
        const flatValues = rows.flatMap(r => Object.values(r));
        return driver.run(sql, flatValues);
    }

    if (driver.dbType === 'postgres') {
        let pIdx = 1;
        const rowPlaceholders = rows.map(() => `(${keys.map(() => `$${pIdx++}`).join(',')})`);
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES ${rowPlaceholders.join(',')}`;
        const flatValues = rows.flatMap(r => Object.values(r));
        return driver.run(sql, flatValues);
    }

    // Default row by row transaction for SQLite & MSSQL
    return driver.transaction(async (trx) => {
        const placeholders = keys.map(() => '?').join(',');
        const sql = `INSERT INTO "${table}" (${keys.join(',')}) VALUES (${placeholders})`;
        for (const row of rows) {
            await trx.run(sql, Object.values(row));
        }
    });
}

async function closeDB() {
    if (flushIntervalTimer) {
        clearInterval(flushIntervalTimer);
        flushIntervalTimer = null;
    }
    await flushWriteBuffer();
    if (activeDriver) {
        await activeDriver.close();
        activeDriver = null;
    }
    isInitialized = false;
}

module.exports = {
    initDB,
    closeDB,
    getDriver,
    resolveDriverType,
    get,
    all,
    run,
    queueRun,
    flushWriteBuffer,
    exec,
    upsert,
    bulkInsert
};
