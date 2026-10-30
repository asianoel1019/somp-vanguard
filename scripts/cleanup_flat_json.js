#!/usr/bin/env node
/**
 * Report (and optionally move away) legacy flat JSON files that now live in the database.
 *
 * Usage:
 *   scripts\Cleanup_Flat_Json.bat [dataDir]                              report only
 *   scripts\Cleanup_Flat_Json.bat <dataDir> --apply                      move IN_DB_SAME files
 *   scripts\Cleanup_Flat_Json.bat <dataDir> --apply --include-different  also move IN_DB_DIFFERENT files
 *
 * Moves go to <dataDir>\legacy_flat_files\<YYYYMMDD-HHmmss>\ (never deletes).
 * scout.sqlite / database.sqlite are opened READ-ONLY.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeDifferent = args.includes('--include-different');
const posArg = args.find(a => !a.startsWith('--'));

function resolveDataDir() {
    if (posArg) return posArg;
    if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
    return fs.existsSync('D:\\somp-vanguard\\scout.sqlite') ? 'D:\\somp-vanguard' : 'C:\\ProgramData\\somp-vanguard';
}

function loadDocs(file) {
    const map = new Map(); // key -> { value, updatedAt }
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true });
    } catch (e) {
        return { error: e, map };
    }
    try {
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_store'").get();
        if (has) {
            const cols = db.prepare('PRAGMA table_info(document_store)').all().map(c => c.name);
            const tsCol = cols.includes('updated_at') ? 'updated_at' : (cols.includes('updatedAt') ? 'updatedAt' : null);
            const sql = tsCol ? `SELECT key, value, ${tsCol} AS ts FROM document_store` : 'SELECT key, value FROM document_store';
            for (const r of db.prepare(sql).all()) map.set(r.key, { value: r.value, updatedAt: r.ts || '' });
        }
    } catch (e) {
        return { error: e, map };
    } finally {
        try { db.close(); } catch (_) {}
    }
    return { map };
}

function normalize(text) {
    try { return JSON.stringify(JSON.parse(text)); } catch (_) { return null; }
}

function sameContent(fileText, dbText) {
    if (typeof fileText !== 'string' || typeof dbText !== 'string') return false;
    const a = normalize(fileText);
    const b = normalize(dbText);
    if (a !== null && b !== null) return a === b;
    return fileText === dbText;
}

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

function main() {
    if (apply && !posArg) {
        console.error('Refusing --apply without an explicit data directory.');
        console.error('Usage: Cleanup_Flat_Json.bat <dataDir> --apply [--include-different]');
        return 1;
    }
    const dataDir = resolveDataDir();
    const scoutFile = path.join(dataDir, 'scout.sqlite');
    const legacyFile = path.join(dataDir, 'database.sqlite');
    console.log(`Data dir: ${dataDir}`);
    console.log(`Mode: ${apply ? `APPLY (move IN_DB_SAME${includeDifferent ? ' + IN_DB_DIFFERENT' : ''})` : 'REPORT ONLY'}`);

    if (!fs.existsSync(scoutFile)) {
        console.error(`scout.sqlite not found: ${scoutFile}`);
        return apply ? 1 : 0;
    }
    const scout = loadDocs(scoutFile);
    if (scout.error) {
        console.error(`Cannot open scout.sqlite read-only: ${scout.error.message}`);
        return 1;
    }
    let legacy = { map: new Map() };
    if (fs.existsSync(legacyFile)) {
        legacy = loadDocs(legacyFile);
        if (legacy.error) {
            console.warn(`Warning: cannot read database.sqlite (ignored): ${legacy.error.message}`);
            legacy = { map: new Map() };
        }
    }

    // legacy filename -> { recs: Map<key, { scout, legacy }> }
    const byFile = new Map();
    const add = (map, field) => {
        for (const [key, rec] of map) {
            const fname = key.replace(/[\/\\]/g, '_');
            if (!byFile.has(fname)) byFile.set(fname, { recs: new Map() });
            const recs = byFile.get(fname).recs;
            if (!recs.has(key)) recs.set(key, {});
            recs.get(key)[field] = rec;
        }
    };
    add(scout.map, 'scout');
    add(legacy.map, 'legacy');

    const classify = (full, doc) => {
        let content = null;
        try { content = fs.readFileSync(full, 'utf8'); } catch (_) {}
        if (content === null) return { cls: 'UNREADABLE' };
        if (!doc) return { cls: 'FILE_ONLY' };
        // The old fs.writeFileSync intercept in index.js also stored each file under its flattened name
        // (e.g. "a_b.json" next to the real key "a/b.json"). Such an alias is not a collision: compare the
        // file with the real key the app reads. Two different real keys for one filename stay AMBIGUOUS.
        const keys = [...doc.recs.keys()];
        const realKeys = keys.filter(k => /[\/\\]/.test(k));
        let key;
        if (keys.length === 1) key = keys[0];
        else if (realKeys.length === 1) key = realKeys[0];
        else return { cls: 'AMBIGUOUS' };
        const rec = doc.recs.get(key);
        const primary = rec.scout || rec.legacy;
        const cls = sameContent(content, primary.value) ? 'IN_DB_SAME' : 'IN_DB_DIFFERENT';
        const eqLegacy = rec.legacy ? sameContent(content, rec.legacy.value) : null;
        return { cls, eqLegacy, key, rec };
    };

    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    const rows = [];
    for (const ent of entries) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.json')) continue;
        const full = path.join(dataDir, ent.name);
        const st = fs.statSync(full);
        const doc = byFile.get(ent.name);
        const c = classify(full, doc);
        rows.push({
            name: ent.name, size: st.size, full, doc,
            mtime: st.mtime.toISOString().slice(0, 19).replace('T', ' '),
            ...c,
            dbTime: c.rec && c.rec.scout ? String(c.rec.scout.updatedAt || '') : ''
        });
    }
    rows.sort((x, y) => x.cls.localeCompare(y.cls) || x.name.localeCompare(y.name));

    const w = Math.max(10, ...rows.map(r => r.name.length));
    console.log(`\n${'CLASS'.padEnd(16)}${'FILE'.padEnd(w + 2)}${'SIZE'.padEnd(10)}${'FILE MTIME (UTC)'.padEnd(22)}${'SCOUT UPDATED (UTC)'.padEnd(27)}EQ database.sqlite`);
    for (const r of rows) {
        const eq = r.eqLegacy === null || r.eqLegacy === undefined ? '-' : (r.eqLegacy ? 'yes' : 'no');
        console.log(`${r.cls.padEnd(16)}${r.name.padEnd(w + 2)}${fmtSize(r.size).padEnd(10)}${r.mtime.padEnd(22)}${(r.dbTime || '-').padEnd(27)}${eq}`);
    }
    console.log('\nTotals:');
    for (const cls of ['IN_DB_SAME', 'IN_DB_DIFFERENT', 'AMBIGUOUS', 'FILE_ONLY', 'UNREADABLE']) {
        const list = rows.filter(r => r.cls === cls);
        console.log(`  ${cls.padEnd(16)} ${String(list.length).padStart(4)} files  ${fmtSize(list.reduce((s, r) => s + r.size, 0))}`);
    }
    console.log('  FILE_ONLY / AMBIGUOUS / UNREADABLE files are never moved.');
    console.log('  IN_DB_DIFFERENT files are only moved with --apply --include-different (the app reads the database, not the file).');

    const others = entries
        .filter(e => e.isFile() && /^database_backup.*\.sqlite/i.test(e.name))
        .map(e => ({ name: e.name, size: fs.statSync(path.join(dataDir, e.name)).size }));
    if (others.length) {
        console.log('\nOld backup copies (not touched; verify they are not your current DB_BACKUP_PATH before deleting):');
        for (const o of others) console.log(`  ${o.name}  ${fmtSize(o.size)}`);
    }

    const movable = rows.filter(r => r.cls === 'IN_DB_SAME' || (includeDifferent && r.cls === 'IN_DB_DIFFERENT'));
    if (!apply) {
        console.log(`\n${movable.length} file(s) are movable by default (IN_DB_SAME: ${rows.filter(r => r.cls === 'IN_DB_SAME').length}). Re-run with <dataDir> --apply to move them to legacy_flat_files\\<timestamp>\\ (nothing is deleted).`);
        return 0;
    }
    console.log('\nNote: moving is safe while the service runs, because the app reads the database first.');
    if (!movable.length) {
        console.log('Nothing to move.');
        return 0;
    }
    const destDir = path.join(dataDir, 'legacy_flat_files', stamp());
    fs.mkdirSync(destDir, { recursive: true });
    let moved = 0;
    for (const r of movable) {
        try {
            // Re-read and re-compare right before the rename
            const again = classify(r.full, r.doc);
            if (again.cls !== r.cls) {
                console.log(`  skipped ${r.name} (changed since the scan: now ${again.cls})`);
                continue;
            }
            fs.renameSync(r.full, uniqueDest(destDir, r.name));
            console.log(`  moved ${r.name}`);
            moved++;
        } catch (e) {
            console.warn(`  FAILED ${r.name}: ${e.message}`);
        }
    }
    console.log(`\nMoved ${moved} file(s) to ${destDir}`);
    return 0;
}

process.exit(main());
