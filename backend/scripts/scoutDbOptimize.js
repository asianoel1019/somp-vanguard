#!/usr/bin/env node
// scout.sqlite maintenance for a maintenance window (run with the SOMP Vanguard service STOPPED):
//
//   scoutDbOptimize.bat                    report only (nothing changes): size, free space, indexes, duplicates
//   scoutDbOptimize.bat --drop-duplicates  drop the duplicate indexes listed in the report
//   scoutDbOptimize.bat --vacuum           rewrite the file to return free pages to the disk (long; needs free space)
//   add --yes to skip the confirmation, --db <path> for another file
//
// Changes are refused while the service is running or another process holds the database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { findDuplicateIndexes, vacuumSpaceNeeded, vacuumSpaceCheck } = require('./lib/indexAnalysis');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

function defaultDbFile() {
    try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true }); } catch { /* no dotenv: defaults */ }
    return path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'scout.sqlite');
}

const GB = 1024 ** 3;
const size = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

function serviceRunning() {
    try {
        return /STATE\s*:\s*\d+\s+RUNNING/i.test(execFileSync('sc', ['query', 'somp-vanguard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        return false; // no such service on this machine
    }
}

// The question stands on its own lines so it is not lost among other output (it used to sit unanswered for hours).
function ask(question) {
    if (has('--yes')) return Promise.resolve(true);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n${'='.repeat(78)}\n${question.trim()}\nWAITING FOR YOUR ANSWER: type y and press Enter to continue, anything else skips.\n${'='.repeat(78)}`);
    return new Promise(r => rl.question('Continue? [y/N] ', a => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
}

function diskInfo(dir) {
    let free = null;
    let dev = null;
    try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { /* unknown */ }
    try { dev = fs.statSync(dir).dev; } catch { /* unknown */ }
    return { dir, free, dev };
}

function spaceCheck(dbFile, need) {
    return vacuumSpaceCheck({ need, db: diskInfo(path.dirname(dbFile)), temp: diskInfo(os.tmpdir()) });
}

const freeText = (b) => (b === null || b === undefined ? 'unknown' : size(b));

function readSchema(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const rowidAlias = {};
    const indexes = [];
    for (const t of tables) {
        const q = `"${t.replace(/"/g, '""')}"`;
        const pk = db.prepare(`PRAGMA table_info(${q})`).all().filter(c => c.pk > 0);
        if (pk.length === 1 && /^integer$/i.test(pk[0].type)) rowidAlias[t] = pk[0].name;
        for (const ix of db.prepare(`PRAGMA index_list(${q})`).all()) {
            const cols = db.prepare(`PRAGMA index_xinfo("${ix.name.replace(/"/g, '""')}")`).all().filter(c => c.key).sort((a, b) => a.seqno - b.seqno);
            indexes.push({ name: ix.name, table: t, unique: !!ix.unique, origin: ix.origin, columns: cols.map(c => ({ name: c.cid === -2 ? null : c.cid === -1 ? 'rowid' : c.name, desc: !!c.desc })) });
        }
    }
    return { tables, indexes, rowidAlias };
}

async function main() {
    const dbFile = valueOf('--db') || defaultDbFile();
    if (!fs.existsSync(dbFile)) { console.error(`Database not found: ${dbFile}`); process.exit(1); }
    const { DatabaseSync } = require('node:sqlite');
    await new Promise(r => setImmediate(r)); // let Node's "SQLite is experimental" warning print now, not over a question
    const wantDrop = has('--drop-duplicates');
    const wantVacuum = has('--vacuum');
    const changing = wantDrop || wantVacuum;

    console.log(`Database: ${dbFile}`);
    const db = new DatabaseSync(dbFile, { readOnly: !changing });
    const one = (sql) => db.prepare(sql).get();
    const pageSize = one('PRAGMA page_size').page_size;
    const pageCount = one('PRAGMA page_count').page_count;
    const freePages = one('PRAGMA freelist_count').freelist_count;
    const walFile = `${dbFile}-wal`;
    const walBytes = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
    console.log(`File ${size(fs.statSync(dbFile).size)}, WAL ${size(walBytes)}, free pages ${size(freePages * pageSize)} (${((freePages / Math.max(1, pageCount)) * 100).toFixed(0)}% of the file)`);

    for (const t of ['metrics', 'windows_events', 'linux_logs']) {
        try {
            const r = one(`SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${t}`);
            console.log(`  ${t.padEnd(15)} rowid ${r.lo ?? '-'} .. ${r.hi ?? '-'}${r.hi ? ` (at most ${(r.hi - r.lo + 1).toLocaleString()} rows)` : ''}`);
        } catch { /* table missing */ }
    }

    const schema = readSchema(db);
    console.log('\nIndexes of the large tables:');
    for (const ix of schema.indexes.filter(i => ['metrics', 'windows_events', 'linux_logs'].includes(i.table))) {
        console.log(`  ${ix.table.padEnd(15)} ${ix.name.padEnd(36)} (${ix.columns.map(c => `${c.name ?? '<expr>'}${c.desc ? ' DESC' : ''}`).join(', ')})${ix.unique ? ' UNIQUE' : ''}`);
    }
    const dups = findDuplicateIndexes(schema.indexes, schema.rowidAlias);
    console.log(dups.length ? '\nDuplicate indexes (same key; keep the first, drop the rest):' : '\nNo duplicate indexes.');
    for (const d of dups) console.log(`  ${d.table}: (${d.columns}) keep ${d.keep}, drop ${d.drop.join(', ')}`);

    const need = vacuumSpaceNeeded({ pageSize, pageCount, freePages });
    const space = spaceCheck(dbFile, need);
    console.log(`\nVACUUM would shrink the file by about ${size(freePages * pageSize)}. Free space it needs while it runs:`);
    for (const c of space.checks) console.log(`  ${c.label.padEnd(38)} ${c.dir}: needs about ${size(c.need)}, free ${freeText(c.free)}${c.ok ? '' : '  <- NOT ENOUGH'}`);

    if (!changing) {
        console.log('\nReport only: nothing was changed. Use --drop-duplicates and / or --vacuum with the service stopped.');
        return;
    }

    if (serviceRunning()) { console.error('\nThe somp-vanguard service is running: stop it first (nothing was changed).'); process.exit(2); }
    db.exec('PRAGMA busy_timeout = 2000');
    try {
        db.exec('BEGIN IMMEDIATE'); // fails when another process still holds the database
        db.exec('ROLLBACK');
    } catch (err) {
        console.error(`\nAnother process is using the database (${err.message}): stop it first (nothing was changed).`);
        process.exit(2);
    }

    if (wantDrop) {
        const names = dups.flatMap(d => d.drop);
        if (!names.length) console.log('\nNo duplicate index to drop.');
        else if (await ask(`Drop ${names.length} duplicate index(es): ${names.join(', ')}?`)) {
            for (const n of names) {
                const t0 = Date.now();
                db.exec(`DROP INDEX IF EXISTS "${n.replace(/"/g, '""')}"`);
                console.log(`  dropped ${n} (${Date.now() - t0} ms)`);
            }
            db.exec('PRAGMA optimize');
            console.log('Done. Their pages are now free pages; --vacuum returns them to the disk.');
        } else console.log('Skipped.');
    }

    if (wantVacuum) {
        const nowFree = db.prepare('PRAGMA freelist_count').get().freelist_count;
        const needNow = vacuumSpaceNeeded({ pageSize, pageCount: db.prepare('PRAGMA page_count').get().page_count, freePages: nowFree });
        const spaceNow = spaceCheck(dbFile, needNow);
        if (!spaceNow.ok) {
            console.error('\nNot enough free disk space for VACUUM (nothing more was changed):');
            for (const c of spaceNow.checks.filter(x => !x.ok)) console.error(`  ${c.label} ${c.dir}: needs about ${size(c.need)}, ${freeText(c.free)} free`);
            console.error('Free some space, or run it from an account whose TEMP folder is on a disk with enough room.');
            process.exit(3);
        }
        if (await ask(`VACUUM now? It rewrites the whole database (about ${size((db.prepare('PRAGMA page_count').get().page_count - nowFree) * pageSize)}) and can take a long time; do not interrupt it.\nIt uses about that much space in the temp folder ${os.tmpdir()} until it ends.`)) {
            const t0 = Date.now();
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            db.exec('VACUUM');
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            console.log(`VACUUM finished in ${Math.round((Date.now() - t0) / 1000)} s. File is now ${size(fs.statSync(dbFile).size)}.`);
        } else console.log('Skipped.');
    }
    db.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });
