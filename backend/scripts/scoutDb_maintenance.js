const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const DB_FILE = path.join(DATA_DIR, 'scout.sqlite');
const NEW_DB_FILE = path.join(DATA_DIR, 'scout_compact_rebuild.sqlite');
const BACKUP_DB_FILE = path.join(DATA_DIR, `scout_backup_${Date.now()}.sqlite`);
const { rebuildInto } = require('./lib/sqliteCopy');

let sqlite;
try {
    sqlite = require('better-sqlite3');
} catch (e) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        sqlite = DatabaseSync;
    } catch (e2) {
        console.error('[Error] SQLite driver not found.');
        process.exit(1);
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function runMaintenance() {
    console.log('='.repeat(65));
    console.log('       SOMP Vanguard - ScoutDB Safe Clean Rebuilder & Shrink');
    console.log('='.repeat(65));

    if (!fs.existsSync(DB_FILE)) {
        console.error(`[Error] Database file not found at: ${DB_FILE}`);
        process.exit(1);
    }

    const initialStats = fs.statSync(DB_FILE);
    console.log(`[Target DB]     ${DB_FILE}`);
    console.log(`[Current Size]   ${formatBytes(initialStats.size)} (${initialStats.size} bytes)\n`);

    // Ensure temporary rebuild file does not exist
    if (fs.existsSync(NEW_DB_FILE)) {
        try { fs.unlinkSync(NEW_DB_FILE); } catch(e) {}
    }

    console.log('[1/4] Opening source and target databases...');
    const srcDb = new sqlite(DB_FILE, { readonly: true, readOnly: true, timeout: 10000 });
    const dstDb = new sqlite(NEW_DB_FILE);
    let summary = null;

    try {
        dstDb.exec('PRAGMA journal_mode = WAL;');
        dstDb.exec('PRAGMA synchronous = NORMAL;');
        dstDb.exec('PRAGMA temp_store = MEMORY;');

        // Table list comes from the SOURCE schema (sqlite_master): every table is copied with all rows, except the
        // large telemetry tables (metrics, windows_events, linux_logs) which keep only the last 3 days (max 50000 rows each).
        // Indexes / triggers / views of the copied tables are recreated from their source DDL.
        console.log('[2/4] Copying all tables (schema from source; telemetry: last 3 days only)...');
        const retentionCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        summary = rebuildInto(srcDb, dstDb, { retentionCutoff, logLimit: 50000, log: (l) => console.log(l) });
        console.log(`\n[3/4] Summary: ${summary.copied.length} table(s) copied in full, ${summary.partial.length} telemetry table(s) trimmed to recent rows (${summary.partial.map(p => p.name).join(', ') || '-'}), ${summary.failed.length} failed; ${summary.schemaObjects.created} index/trigger/view definition(s) recreated${summary.schemaObjects.failed.length ? `, ${summary.schemaObjects.failed.length} failed (${summary.schemaObjects.failed.map(f => f.name).join(', ')})` : ''}.`);

        // Recreate indexes in destination database
        console.log('\n[4/4] Creating optimized indexes...');
        try {
            dstDb.exec(`
                CREATE INDEX IF NOT EXISTS idx_metrics_monitorId ON metrics(monitorId);
                CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
                CREATE INDEX IF NOT EXISTS idx_metrics_monitor_id_desc ON metrics(monitorId, id DESC);
                CREATE INDEX IF NOT EXISTS idx_metrics_monitor_ts ON metrics(monitorId, timestamp DESC);
                CREATE INDEX IF NOT EXISTS idx_windows_events_timestamp ON windows_events(timestamp);
                CREATE INDEX IF NOT EXISTS idx_win_events_ts ON windows_events(timestamp DESC);
                CREATE INDEX IF NOT EXISTS idx_linux_logs_timestamp ON linux_logs(timestamp);
                CREATE INDEX IF NOT EXISTS idx_lin_logs_ts ON linux_logs(timestamp DESC);
                CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(monitorId, resolved, triggeredAt DESC);
            `);
            console.log('   - Indexes created successfully.');
        } catch (idxErr) {
            console.warn('   - Index warning:', idxErr.message);
        }

    } finally {
        try { srcDb.close(); } catch(e) {}
        try { dstDb.close(); } catch(e) {}
    }

    // Never activate a rebuild that lost a table: keep the original database untouched
    if (!summary || summary.failed.length > 0) {
        console.error(`\n[Abort] ${summary ? summary.failed.map(f => `${f.name}: ${f.error}`).join(' | ') : 'rebuild did not complete'}`);
        console.error(`[Abort] Original database left in place; incomplete rebuild kept at ${NEW_DB_FILE} for inspection.`);
        process.exit(1);
    }

    // Step 5: File Swap
    console.log('\n[5/5] Swapping database files...');
    const newStats = fs.statSync(NEW_DB_FILE);

    // Backup original 37GB file by renaming
    try {
        console.log(`   - Renaming ${DB_FILE} -> ${BACKUP_DB_FILE}`);
        fs.renameSync(DB_FILE, BACKUP_DB_FILE);
    } catch (rnErr) {
        console.error(`   - Failed to rename original file: ${rnErr.message}. Trying copy fallback.`);
    }

    // Also remove WAL / SHM files if present
    const walFile = `${DB_FILE}-wal`;
    const shmFile = `${DB_FILE}-shm`;
    if (fs.existsSync(walFile)) { try { fs.unlinkSync(walFile); } catch(e) {} }
    if (fs.existsSync(shmFile)) { try { fs.unlinkSync(shmFile); } catch(e) {} }

    // Place the new compact database
    fs.renameSync(NEW_DB_FILE, DB_FILE);
    console.log(`   - Activated new optimized database at ${DB_FILE} [OK]`);

    // Final Report
    const reclaimedBytes = initialStats.size - newStats.size;
    console.log('\n' + '='.repeat(65));
    console.log('                       REBUILD REPORT');
    console.log('='.repeat(65));
    console.log(`  Initial File Size   : ${formatBytes(initialStats.size)}`);
    console.log(`  Optimized File Size : ${formatBytes(newStats.size)}`);
    console.log(`  Space Saved (Disk)  : ${formatBytes(Math.max(0, reclaimedBytes))} (${((Math.max(0, reclaimedBytes) / (initialStats.size || 1)) * 100).toFixed(1)}%)`);
    console.log(`  Original Backup     : ${BACKUP_DB_FILE}`);
    console.log('='.repeat(65));
    console.log('Optimization completed successfully! You can now start somp-vanguard.\n');
}

if (require.main === module) {
    runMaintenance().catch(err => {
        console.error('[Fatal Error] Maintenance failed:', err);
        process.exit(1);
    });
}

