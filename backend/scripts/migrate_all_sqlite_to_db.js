/**
 * SOMP Vanguard - Full Dual-SQLite to Enterprise Database Migration Tool
 * Location: backend/scripts/migrate_all_sqlite_to_db.js
 * 
 * Usage:
 *   node scripts/migrate_all_sqlite_to_db.js [--sqlite-dir="D:\somp-vanguard"] [--days=7]
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

// Parse CLI arguments
const args = process.argv.slice(2).reduce((acc, cur) => {
    const [k, v] = cur.replace(/^--/, '').split('=');
    acc[k] = v || true;
    return acc;
}, {});

if (args.help || args.h) {
    console.log(`
SOMP Vanguard Full Database Migration Tool
==========================================
Usage:
  node scripts/migrate_all_sqlite_to_db.js [options]

Options:
  --sqlite-dir=<path>   Directory containing database.sqlite and scout.sqlite
                        (Default: D:\\somp-vanguard or process.env.DB_DATA_DIR)
  --days=<number>       Number of days of telemetry logs to migrate (Default: 7)
                        Core configurations and CMDB are always 100% migrated.
  --help, -h            Show this help screen
    `);
    process.exit(0);
}

let SQLITE_DIR = args['sqlite-dir'] || process.env.DB_DATA_DIR || 'D:\\somp-vanguard';
if (!fs.existsSync(SQLITE_DIR) && fs.existsSync('C:\\ProgramData\\somp-vanguard')) {
    SQLITE_DIR = 'C:\\ProgramData\\somp-vanguard';
}

const DAYS_TO_KEEP = parseInt(args.days || '7', 10);
const DB_DOC_FILE = path.join(SQLITE_DIR, 'database.sqlite');
const DB_SCOUT_FILE = path.join(SQLITE_DIR, 'scout.sqlite');
const { TELEMETRY_TABLES, MIGRATE_SKIP_TABLES, planTables, listSchemaObjects } = require('./lib/sqliteCopy');

let DatabaseSync;
try {
    DatabaseSync = require('better-sqlite3');
} catch (e) {
    try {
        const nodeSqlite = require('node:sqlite');
        DatabaseSync = nodeSqlite.DatabaseSync;
    } catch (err) {
        console.error('[Migration Error] No SQLite driver found (neither better-sqlite3 nor node:sqlite).');
        process.exit(1);
    }
}

async function runMigration() {
    console.log('='.repeat(70));
    console.log('       SOMP Vanguard - Full Dual-Database Migration Tool         ');
    console.log('='.repeat(70));
    console.log(`[Source Dir]     ${SQLITE_DIR}`);
    console.log(`[Document DB]    ${DB_DOC_FILE}`);
    console.log(`[Scout DB]       ${DB_SCOUT_FILE}`);
    console.log(`[Target Engine]  ${(process.env.DB_TYPE || 'sqlite').toUpperCase()} (${process.env.DB_HOST || 'local'}:${process.env.DB_PORT || 'file'})`);
    console.log(`[Target DB Name] ${process.env.DB_NAME || 'scout.sqlite'}`);
    console.log(`[Log Retention]  Migrate recent ${DAYS_TO_KEEP} days of metrics/logs`);
    console.log('='.repeat(70) + '\n');

    if (!fs.existsSync(DB_DOC_FILE) && !fs.existsSync(DB_SCOUT_FILE)) {
        console.error(`[Fatal Error] Neither database.sqlite nor scout.sqlite found in: ${SQLITE_DIR}`);
        process.exit(1);
    }

    const dbManager = require('../services/db');
    await dbManager.initDB();

    const summaryReport = {
        documents: 0,
        coreTables: {},
        telemetry: {}
    };

    // --------------------------------------------------------------------------
    // 步驟 1: 遷移 database.sqlite (document_store CMDB/設定)
    // --------------------------------------------------------------------------
    if (fs.existsSync(DB_DOC_FILE)) {
        console.log('[1/3] Migrating document_store (CMDB & System Settings) from database.sqlite...');
        let docDb;
        try {
            docDb = new DatabaseSync(DB_DOC_FILE, { readonly: true, readOnly: true });
            const checkTbl = docDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_store'").get();
            if (checkTbl) {
                const rows = docDb.prepare('SELECT key, value, updated_at FROM document_store').all();
                console.log(`  - Found ${rows.length} configuration/CMDB documents.`);
                for (const r of rows) {
                    await dbManager.upsert({
                        table: 'document_store',
                        conflictKeys: ['key'],
                        data: {
                            key: r.key,
                            value: r.value,
                            updatedAt: r.updated_at || new Date().toISOString()
                        }
                    });
                }
                summaryReport.documents = rows.length;
                console.log(`  -> Successfully migrated ${rows.length} documents. [OK]`);
            } else {
                console.log('  -> No document_store table found in database.sqlite. [SKIPPED]');
            }
        } catch (e) {
            console.error('  -> Error migrating document_store:', e.message);
        } finally {
            if (docDb) try { docDb.close(); } catch (e) {}
        }
    } else {
        console.log('[1/3] database.sqlite not found. Skipping DocumentStore migration.');
    }

    // --------------------------------------------------------------------------
    // 步驟 2: 遷移 scout.sqlite 核心設定表 (100% 完整無損遷移)
    // --------------------------------------------------------------------------
    if (fs.existsSync(DB_SCOUT_FILE)) {
        console.log('\n[2/3] Migrating core management & configuration tables from scout.sqlite...');
        let scoutDb;
        try {
            scoutDb = new DatabaseSync(DB_SCOUT_FILE, { readonly: true, readOnly: true });
            // Table list from the SOURCE schema (sqlite_master): every table except the telemetry tables (streamed in
            // step 3) and document_store (migrated from database.sqlite in step 1). New tables are never silently dropped.
            const plan = planTables(scoutDb, { partial: TELEMETRY_TABLES, skip: MIGRATE_SKIP_TABLES });
            summaryReport.skippedTables = plan.skipped;
            summaryReport.failedTables = [];
            const created = [];

            for (const { name: tbl, sql } of plan.full) {
                try {
                    // Tables the target schema (initDB) does not know yet: best-effort create from the SQLite DDL
                    if (sql) { try { await dbManager.exec(sql); } catch (e) { /* already exists or dialect differs */ } }
                    created.push(tbl);

                    const rows = scoutDb.prepare(`SELECT * FROM "${tbl}"`).all();
                    for (const r of rows) {
                        const keys = Object.keys(r);
                        const placeholders = keys.map(() => '?').join(',');
                        await dbManager.run(
                            `INSERT INTO ${tbl} (${keys.join(',')}) VALUES (${placeholders})`,
                            Object.values(r)
                        );
                    }
                    summaryReport.coreTables[tbl] = rows.length;
                    console.log(`  - Table ${tbl.padEnd(24)}: ${rows.length.toLocaleString()} rows migrated. [OK]`);
                } catch (tblErr) {
                    summaryReport.failedTables.push(tbl);
                    console.warn(`  - Table ${tbl.padEnd(24)}: Warning: ${tblErr.message}`);
                }
            }
            // Indexes of the copied tables (best effort: SQLite DDL may not fit every target dialect; initDB creates the core ones)
            for (const o of listSchemaObjects(scoutDb, created).filter(x => x.type === 'index')) {
                try { await dbManager.exec(o.sql); } catch (e) { /* exists or unsupported in target dialect */ }
            }
            console.log(`  -> ${plan.full.length - summaryReport.failedTables.length} table(s) copied, ${plan.partial.length} telemetry table(s) streamed in step 3, skipped: ${plan.skipped.join(', ') || '-'}${summaryReport.failedTables.length ? `, FAILED: ${summaryReport.failedTables.join(', ')}` : ''}`);

            // --------------------------------------------------------------------------
            // 步驟 3: 串流分批遷移時序日誌 (Metrics / Windows Events / Linux Logs)
            // --------------------------------------------------------------------------
            console.log(`\n[3/3] Streaming telemetry logs (last ${DAYS_TO_KEEP} days)...`);
            const cutoffTime = new Date(Date.now() - DAYS_TO_KEEP * 24 * 60 * 60 * 1000).toISOString();
            const telemetryTables = TELEMETRY_TABLES.map(t => ({ name: t.name, ts: t.tsCol }));

            for (const t of telemetryTables) {
                try {
                    const checkTbl = scoutDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t.name);
                    if (!checkTbl) continue;

                    const countRow = scoutDb.prepare(`SELECT COUNT(*) as c FROM ${t.name} WHERE ${t.ts} >= ?`).get(cutoffTime);
                    const totalRows = countRow ? countRow.c : 0;
                    console.log(`  - Processing ${t.name}: ${totalRows.toLocaleString()} rows to transfer...`);

                    const BATCH_SIZE = 5000;
                    let offset = 0;
                    while (offset < totalRows) {
                        const batch = scoutDb.prepare(`SELECT * FROM ${t.name} WHERE ${t.ts} >= ? ORDER BY id ASC LIMIT ? OFFSET ?`).all(cutoffTime, BATCH_SIZE, offset);
                        if (!batch || batch.length === 0) break;

                        await dbManager.bulkInsert(t.name, batch);
                        offset += batch.length;
                        process.stdout.write(`    Progress: ${offset.toLocaleString()} / ${totalRows.toLocaleString()} rows (${Math.round(offset / totalRows * 100)}%)...\r`);
                    }
                    summaryReport.telemetry[t.name] = offset;
                    console.log(`\n  -> Table ${t.name} stream migration completed! [OK]`);
                } catch (err) {
                    console.warn(`  -> Table ${t.name} error: ${err.message}`);
                }
            }

        } catch (e) {
            console.error('  -> Error during scout.sqlite migration:', e.message);
        } finally {
            if (scoutDb) try { scoutDb.close(); } catch (e) {}
        }
    } else {
        console.log('[2/3] scout.sqlite not found. Skipping Scout migration.');
    }

    console.log('\n' + '='.repeat(70));
    console.log('🎉 Migration Completed Successfully!');
    console.log('='.repeat(70));
    console.log(`- DocumentStore (CMDB/Settings) : ${summaryReport.documents} records`);
    console.log('- Core Management Tables       :');
    for (const [k, v] of Object.entries(summaryReport.coreTables)) {
        console.log(`    * ${k.padEnd(24)}: ${v.toLocaleString()} rows`);
    }
    if (summaryReport.skippedTables) console.log(`- Skipped tables               : ${summaryReport.skippedTables.join(', ') || '-'}`);
    if (summaryReport.failedTables && summaryReport.failedTables.length) console.log(`- FAILED tables                : ${summaryReport.failedTables.join(', ')}`);
    console.log('- Telemetry Logs Transferred    :');
    for (const [k, v] of Object.entries(summaryReport.telemetry)) {
        console.log(`    * ${k.padEnd(24)}: ${v.toLocaleString()} rows`);
    }
    console.log('='.repeat(70));
    console.log('Next Steps:');
    console.log('  1. Verify data via backend startup (npm start / Start-Service somp-vanguard).');
    console.log('  2. Rename old sqlite files to .bak (e.g. scout.sqlite.bak) after validation.');
    console.log('='.repeat(70) + '\n');

    await dbManager.closeDB();
    process.exit(0);
}

if (require.main === module) {
    runMigration().catch(err => {
        console.error('Fatal Migration Error:', err);
        process.exit(1);
    });
}
