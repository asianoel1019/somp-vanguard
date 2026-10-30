#!/usr/bin/env node
/**
 * Report (and optionally remove) duplicate ALIAS rows in document_store.
 *
 * Databases imported from the old flat-file layout hold some documents twice: the canonical key the app reads
 * (e.g. network_service/ipam/subnets.json) and a stale alias that differs only in '/' vs '_'
 * (network/service/ipam/subnets.json, or the flat file name network_service_ipam_subnets.json).
 * Canonical keys = backend/lib/docRegistry.js (every key the backend writes or still reads, exact or pattern).
 *
 * Usage:
 *   scripts\Cleanup_Doc_Aliases.bat [dataDir]            report only (databases opened read-only)
 *   scripts\Cleanup_Doc_Aliases.bat <dataDir> --apply    export every ALIAS row, then delete them
 *
 * Classes:
 *   ALIAS      alias of exactly one canonical row that exists in the same database -> removed by --apply
 *   ORPHAN     looks like an alias, but its canonical row does not exist            -> never touched ("orphan, kept")
 *   AMBIGUOUS  several canonical rows share its flattened name                      -> never touched
 * Canonical rows and unrelated keys are never touched.
 *
 * --apply first writes each ALIAS row (raw stored value) to
 *   <dataDir>\legacy_alias_backup\<YYYYMMDD-HHmmss>\<safe key>.json   (+ manifest.json: database, key, file)
 * then deletes the ALIAS rows of each database in ONE transaction (a row that changed since the export, or whose
 * canonical row vanished, is skipped). Works on database.sqlite and scout.sqlite in <dataDir> (SQLite only).
 * Safe while the service runs: the app never reads alias keys.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { flattenKey, isCanonicalKey, isAliasKey } = require(path.join(__dirname, '..', 'backend', 'lib', 'docRegistry'));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const posArg = args.find(a => !a.startsWith('--'));
const DB_FILES = ['database.sqlite', 'scout.sqlite'];

function resolveDataDir() {
    if (posArg) return posArg;
    if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
    return fs.existsSync('D:\\somp-vanguard\\scout.sqlite') ? 'D:\\somp-vanguard' : 'C:\\ProgramData\\somp-vanguard';
}

// docStore's VFS revision counters are canonical at any depth (the registry pattern only covers root keys)
const isCanonical = (key) => isCanonicalKey(key) || /\.revision\.json$/i.test(key);

function tsColumn(db) {
    const cols = db.prepare('PRAGMA table_info(document_store)').all().map(c => c.name);
    return cols.includes('updated_at') ? 'updated_at' : (cols.includes('updatedAt') ? 'updatedAt' : null);
}

function loadRows(db) {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_store'").get();
    if (!has) return [];
    const ts = tsColumn(db);
    const sql = ts ? `SELECT key, value, ${ts} AS ts FROM document_store` : 'SELECT key, value FROM document_store';
    return db.prepare(sql).all().map(r => ({ key: String(r.key), value: r.value, ts: r.ts == null ? '' : String(r.ts) }));
}

/** 'YYYY-MM-DD HH:MM:SS' (SQLite CURRENT_TIMESTAMP, UTC) or ISO -> ms, NaN when unknown. */
function tsMs(v) {
    if (!v) return NaN;
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)) return Date.parse(v.replace(' ', 'T') + 'Z');
    return Date.parse(v);
}

function normalize(text) {
    try { return JSON.stringify(JSON.parse(text)); } catch (_) { return null; }
}

function sameContent(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return a === b;
    const x = normalize(a);
    const y = normalize(b);
    if (x !== null && y !== null) return x === y;
    return a === b;
}

const sizeOf = (v) => (v == null ? 0 : Buffer.byteLength(String(v), 'utf8'));

function fmtSize(n) {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function uniqueDest(dir, name) {
    let dest = path.join(dir, name);
    let n = 1;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    while (fs.existsSync(dest)) dest = path.join(dir, `${base}.${n++}${ext}`);
    return dest;
}

/** File name for an exported key: path separators / reserved characters -> '_', always ending in .json. */
function safeKeyName(key) {
    const s = String(key).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\.json$/i, '');
    return `${s || '_'}.json`;
}

/** Classifies the rows of one database. Returns the alias-like rows only. */
function classify(rows) {
    const groups = new Map(); // flattened key -> rows
    for (const r of rows) {
        const f = flattenKey(r.key);
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(r);
    }
    const out = [];
    for (const list of groups.values()) {
        const aliases = list.filter(r => !isCanonical(r.key) && isAliasKey(r.key));
        if (!aliases.length) continue;
        const canon = list.filter(r => isCanonical(r.key));
        for (const a of aliases) {
            if (canon.length !== 1) {
                out.push({ cls: canon.length ? 'AMBIGUOUS' : 'ORPHAN', row: a, canonical: canon.map(c => c.key).join(' | ') || null });
                continue;
            }
            const c = canon[0];
            const ta = tsMs(a.ts);
            const tc = tsMs(c.ts);
            const newer = Number.isNaN(ta) || Number.isNaN(tc) ? '-' : (ta > tc ? 'alias' : (tc > ta ? 'canonical' : 'same time'));
            out.push({ cls: 'ALIAS', row: a, canonical: c.key, canonicalRow: c, identical: sameContent(a.value, c.value), newer });
        }
    }
    const order = { ALIAS: 0, ORPHAN: 1, AMBIGUOUS: 2 };
    return out.sort((x, y) => order[x.cls] - order[y.cls] || x.row.key.localeCompare(y.row.key));
}

function printReport(dbName, items) {
    console.log(`\n== ${dbName}: ${items.length} alias-like row(s)`);
    if (!items.length) return;
    const w = Math.max(10, ...items.map(i => i.row.key.length));
    console.log(`${'CLASS'.padEnd(11)}${'KEY'.padEnd(w + 2)}${'SIZE'.padEnd(10)}${'SAME'.padEnd(6)}${'NEWER'.padEnd(11)}CANONICAL`);
    for (const i of items) {
        const same = i.cls === 'ALIAS' ? (i.identical ? 'yes' : 'no') : '-';
        const newer = i.cls === 'ALIAS' ? i.newer : '-';
        const canon = i.cls === 'ORPHAN' ? '(missing: orphan, kept)' : (i.cls === 'AMBIGUOUS' ? `${i.canonical} (ambiguous, kept)` : i.canonical);
        console.log(`${i.cls.padEnd(11)}${i.row.key.padEnd(w + 2)}${fmtSize(sizeOf(i.row.value)).padEnd(10)}${same.padEnd(6)}${newer.padEnd(11)}${canon}`);
    }
    const n = (c) => items.filter(i => i.cls === c).length;
    console.log(`  ALIAS ${n('ALIAS')} (removable, ${fmtSize(items.filter(i => i.cls === 'ALIAS').reduce((s, i) => s + sizeOf(i.row.value), 0))}), ORPHAN ${n('ORPHAN')} (kept), AMBIGUOUS ${n('AMBIGUOUS')} (kept)`);
    const risky = items.filter(i => i.cls === 'ALIAS' && !i.identical && i.newer === 'alias');
    if (risky.length) console.log(`  Note: ${risky.length} ALIAS row(s) differ from AND are newer than their canonical row (the app never read them; they are exported before removal).`);
}

function openDb(file, readOnly) {
    const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
    if (!readOnly) { try { db.exec('PRAGMA busy_timeout = 10000;'); } catch (_) {} }
    return db;
}

function main() {
    if (apply && !posArg) {
        console.error('Refusing --apply without an explicit data directory.');
        console.error('Usage: Cleanup_Doc_Aliases.bat <dataDir> --apply');
        return 1;
    }
    const dataDir = resolveDataDir();
    console.log(`Data dir: ${dataDir}`);
    console.log(`Mode: ${apply ? 'APPLY (export, then delete ALIAS rows)' : 'REPORT ONLY'}`);

    const dbs = [];
    for (const name of DB_FILES) {
        const file = path.join(dataDir, name);
        if (!fs.existsSync(file)) { console.log(`(${name} not found, skipped)`); continue; }
        let db;
        try {
            db = openDb(file, true);
            const items = classify(loadRows(db));
            dbs.push({ name, file, items });
            printReport(name, items);
        } catch (e) {
            console.error(`Cannot read ${name}: ${e.message}`);
            return 1;
        } finally {
            try { if (db) db.close(); } catch (_) {}
        }
    }
    if (!dbs.length) {
        console.error('No database.sqlite / scout.sqlite in the data directory.');
        return apply ? 1 : 0;
    }
    console.log('\nOnly SQLite files are handled. PostgreSQL / MSSQL / MariaDB document_store tables are not touched.');

    const removable = dbs.flatMap(d => d.items.filter(i => i.cls === 'ALIAS').map(i => ({ ...i, db: d })));
    if (!apply) {
        console.log(`\n${removable.length} ALIAS row(s) are removable. Re-run with <dataDir> --apply to export them to legacy_alias_backup\\<timestamp>\\ and delete them.`);
        return 0;
    }
    if (!removable.length) {
        console.log('\nNothing to remove.');
        return 0;
    }

    // 1. export every alias row (raw stored value) and verify the file
    const destDir = path.join(dataDir, 'legacy_alias_backup', stamp());
    fs.mkdirSync(destDir, { recursive: true });
    const manifest = [];
    for (const r of removable) {
        const raw = r.row.value == null ? '' : String(r.row.value);
        const dest = uniqueDest(destDir, safeKeyName(r.row.key));
        fs.writeFileSync(dest, raw, 'utf8');
        if (fs.readFileSync(dest, 'utf8') !== raw) {
            console.error(`Export verification failed for ${r.row.key} (${dest}); nothing was deleted.`);
            return 1;
        }
        manifest.push({ database: r.db.name, key: r.row.key, file: path.basename(dest), canonical: r.canonical, identical: r.identical, newer: r.newer, updated: r.row.ts || null, bytes: sizeOf(raw) });
    }
    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\nExported ${manifest.length} alias row(s) to ${destDir}`);

    // 2. delete per database in one transaction; re-check each row inside it
    let deleted = 0;
    let failed = false;
    for (const d of dbs) {
        const mine = removable.filter(r => r.db === d);
        if (!mine.length) continue;
        let db;
        try {
            db = openDb(d.file, false);
            db.exec('BEGIN IMMEDIATE');
            const get = db.prepare('SELECT value FROM document_store WHERE key = ?');
            const del = db.prepare('DELETE FROM document_store WHERE key = ?');
            let n = 0;
            for (const r of mine) {
                const cur = get.get(r.row.key);
                if (!cur) { console.log(`  skipped ${r.row.key} (${d.name}): already gone`); continue; }
                if (String(cur.value == null ? '' : cur.value) !== String(r.row.value == null ? '' : r.row.value)) { console.log(`  skipped ${r.row.key} (${d.name}): changed since the export`); continue; }
                if (!get.get(r.canonical)) { console.log(`  skipped ${r.row.key} (${d.name}): canonical row ${r.canonical} vanished`); continue; }
                n += Number(del.run(r.row.key).changes) || 0;
            }
            db.exec('COMMIT');
            deleted += n;
            console.log(`  ${d.name}: deleted ${n} alias row(s)`);
        } catch (e) {
            try { if (db) db.exec('ROLLBACK'); } catch (_) {}
            console.error(`  ${d.name}: FAILED, nothing deleted in this database: ${e.message}`);
            failed = true;
        } finally {
            try { if (db) db.close(); } catch (_) {}
        }
    }
    console.log(`\nDeleted ${deleted} alias row(s). Backup: ${destDir}`);
    return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { classify, safeKeyName, tsMs };
