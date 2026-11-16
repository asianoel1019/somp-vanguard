#!/usr/bin/env node
/**
 * Report (and optionally remove) ORPHAN rack documents in document_store.
 *
 * Racks of a data center live in data_center/server_rack_<dcId>.json (data_center/server_rack.json for the default
 * one). Deleting a data center removes its rack document now; older versions left it behind. An orphan is a rack
 * document whose data center is no longer in data_center/datacenters.json. The app never reads it (data center ids
 * are not reused), so removing it changes nothing on screen.
 *
 * Usage:
 *   scripts\Cleanup_Orphan_Racks.bat [dataDir]            report only (databases opened read-only)
 *   scripts\Cleanup_Orphan_Racks.bat <dataDir> --apply    export every orphan rack document, then delete them
 *
 * The report shows counts only (racks, devices, size), never names or addresses.
 * Never touched: the default data center's document (server_rack.json), any document of a data center that exists,
 * and every database without a readable data_center/datacenters.json (nothing can be called an orphan there).
 *
 * --apply first writes each orphan row (raw stored value) to
 *   <dataDir>\orphan_rack_backup\<YYYYMMDD-HHmmss>\<safe key>.json   (+ manifest.json)
 * then deletes them per database in ONE transaction (a row that changed since the export, or whose data center
 * re-appeared, is skipped). Works on database.sqlite and scout.sqlite in <dataDir> (SQLite only).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const posArg = args.find(a => !a.startsWith('--'));
const DB_FILES = ['database.sqlite', 'scout.sqlite'];
const DCS_KEY = 'data_center/datacenters.json';

function resolveDataDir() {
    if (posArg) return posArg;
    if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
    return fs.existsSync('D:\\somp-vanguard\\scout.sqlite') ? 'D:\\somp-vanguard' : 'C:\\ProgramData\\somp-vanguard';
}

/** Data center id of a rack document key (same rule as backend/lib/rackStore.js), null for other keys. */
function dcIdFromKey(key) {
    if (key === 'data_center/server_rack.json') return 'default';
    const m = /^data_center\/server_rack_(.+)\.json$/.exec(String(key || ''));
    return m ? m[1] : null;
}

function parse(text) {
    try { return JSON.parse(text); } catch (_) { return undefined; }
}

/** Ids of the data centers in datacenters.json, or null when it is missing or unreadable (then nothing is an orphan). */
function dcIdsOf(rows) {
    const row = rows.find(r => r.key === DCS_KEY);
    if (!row) return null;
    const list = parse(row.value);
    if (!Array.isArray(list)) return null;
    return new Set(list.filter(d => d && typeof d === 'object' && d.id != null).map(d => String(d.id)));
}

/** Counts of a rack document value: front racks, back faces, devices. */
function rackCounts(value) {
    const racks = parse(value);
    if (!Array.isArray(racks)) return { readable: false, racks: 0, backs: 0, devices: 0 };
    const list = racks.filter(r => r && typeof r === 'object');
    return {
        readable: true,
        racks: list.filter(r => !r.isBack).length,
        backs: list.filter(r => r.isBack).length,
        devices: list.reduce((n, r) => n + (Array.isArray(r.devices) ? r.devices.length : 0), 0),
    };
}

/**
 * Orphan rack rows of one database: [{ row, dcId, counts }]. Returns null when the database has no readable
 * datacenters.json (cannot decide).
 */
function findOrphans(rows) {
    const ids = dcIdsOf(rows);
    if (!ids) return null;
    const out = [];
    for (const row of rows) {
        const dcId = dcIdFromKey(row.key);
        if (!dcId || dcId === 'default' || ids.has(dcId)) continue;
        out.push({ row, dcId, counts: rackCounts(row.value) });
    }
    return out.sort((a, b) => a.row.key.localeCompare(b.row.key));
}

function loadRows(db) {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_store'").get();
    if (!has) return [];
    return db.prepare("SELECT key, value FROM document_store WHERE key = ? OR key LIKE 'data_center/server_rack%'")
        .all(DCS_KEY).map(r => ({ key: String(r.key), value: r.value }));
}

const sizeOf = (v) => (v == null ? 0 : Buffer.byteLength(String(v), 'utf8'));
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeKeyName(key) {
    const s = String(key).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\.json$/i, '');
    return `${s || '_'}.json`;
}

function openDb(file, readOnly) {
    const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
    if (!readOnly) { try { db.exec('PRAGMA busy_timeout = 10000;'); } catch (_) {} }
    return db;
}

function printReport(name, orphans) {
    if (orphans === null) {
        console.log(`\n== ${name}: no readable ${DCS_KEY}, skipped (cannot tell which rack documents are orphans)`);
        return;
    }
    console.log(`\n== ${name}: ${orphans.length} orphan rack document(s)`);
    orphans.forEach((o, i) => {
        const c = o.counts;
        const what = c.readable ? `${c.racks} rack(s), ${c.backs} back face(s), ${c.devices} device(s)` : 'unreadable JSON';
        console.log(`  #${i + 1}  ${what}, ${fmtSize(sizeOf(o.row.value))}`);
    });
}

function main() {
    if (apply && !posArg) {
        console.error('Refusing --apply without an explicit data directory.');
        console.error('Usage: Cleanup_Orphan_Racks.bat <dataDir> --apply');
        return 1;
    }
    const dataDir = resolveDataDir();
    console.log(`Data dir: ${dataDir}`);
    console.log(`Mode: ${apply ? 'APPLY (export, then delete orphan rack documents)' : 'REPORT ONLY'}`);

    const dbs = [];
    for (const name of DB_FILES) {
        const file = path.join(dataDir, name);
        if (!fs.existsSync(file)) { console.log(`(${name} not found, skipped)`); continue; }
        let db;
        try {
            db = openDb(file, true);
            const orphans = findOrphans(loadRows(db));
            dbs.push({ name, file, orphans: orphans || [] });
            printReport(name, orphans);
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

    const removable = dbs.flatMap(d => d.orphans.map(o => ({ ...o, db: d })));
    if (!apply) {
        console.log(`\n${removable.length} orphan rack document(s). Re-run with <dataDir> --apply to export them to orphan_rack_backup\\<timestamp>\\ and delete them.`);
        return 0;
    }
    if (!removable.length) {
        console.log('\nNothing to remove.');
        return 0;
    }

    // 1. export every orphan row (raw stored value) and verify the file
    const destDir = path.join(dataDir, 'orphan_rack_backup', stamp());
    fs.mkdirSync(destDir, { recursive: true });
    const manifest = [];
    for (const r of removable) {
        const raw = r.row.value == null ? '' : String(r.row.value);
        const dest = path.join(destDir, `${r.db.name.replace(/\.sqlite$/, '')}__${safeKeyName(r.row.key)}`);
        fs.writeFileSync(dest, raw, 'utf8');
        if (fs.readFileSync(dest, 'utf8') !== raw) {
            console.error(`Export verification failed (${dest}); nothing was deleted.`);
            return 1;
        }
        manifest.push({ database: r.db.name, key: r.row.key, file: path.basename(dest), bytes: sizeOf(raw), ...r.counts });
    }
    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\nExported ${manifest.length} orphan rack document(s) to ${destDir}`);

    // 2. delete per database in one transaction; re-check each row (and the data center list) inside it
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
            const dcsRow = get.get(DCS_KEY);
            const ids = dcIdsOf(dcsRow ? [{ key: DCS_KEY, value: dcsRow.value }] : []);
            let n = 0;
            for (const r of mine) {
                if (!ids || ids.has(r.dcId)) { console.log(`  skipped #${mine.indexOf(r) + 1} (${d.name}): its data center exists now`); continue; }
                const cur = get.get(r.row.key);
                if (!cur) { console.log(`  skipped #${mine.indexOf(r) + 1} (${d.name}): already gone`); continue; }
                if (String(cur.value == null ? '' : cur.value) !== String(r.row.value == null ? '' : r.row.value)) {
                    console.log(`  skipped #${mine.indexOf(r) + 1} (${d.name}): changed since the export`);
                    continue;
                }
                n += Number(del.run(r.row.key).changes) || 0;
            }
            db.exec('COMMIT');
            deleted += n;
            console.log(`  ${d.name}: deleted ${n} orphan rack document(s)`);
        } catch (e) {
            try { if (db) db.exec('ROLLBACK'); } catch (_) {}
            console.error(`  ${d.name}: FAILED, nothing deleted in this database: ${e.message}`);
            failed = true;
        } finally {
            try { if (db) db.close(); } catch (_) {}
        }
    }
    console.log(`\nDeleted ${deleted} orphan rack document(s). Backup: ${destDir}`);
    return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { findOrphans, dcIdFromKey, rackCounts };
