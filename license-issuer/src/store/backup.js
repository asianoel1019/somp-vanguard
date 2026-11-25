// Database backups: a consistent copy (VACUUM INTO) next to the database, named <db name>-backup-YYYYMMDD-HHmmss.db.
const fs = require('fs');
const path = require('path');
const R = require('./rules');

const baseName = (store) => path.basename(store.file).replace(/\.[^.]*$/, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = (store) => new RegExp(`^${escapeRe(baseName(store))}-backup-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})(?:-(\\d+))?\\.db$`);
/** Sort key: the time stamp, then the -2, -3 ... suffix of backups made in the same second. */
const order = (store, name) => {
    const m = pattern(store).exec(name);
    return `${m.slice(1, 7).join('')}-${String(m[7] || 1).padStart(4, '0')}`;
};

function info(store, name) {
    const file = path.join(path.dirname(store.file), name);
    const st = fs.statSync(file);
    const m = pattern(store).exec(name);
    return { name, file, size: st.size, createdAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` };
}

/** Writes a backup of the whole database next to it; { name, file, size, createdAt (local, no offset) }. */
function create(store) {
    const dir = path.dirname(store.file);
    const stem = `${baseName(store)}-backup-${R.stamp(store.now())}`;
    for (let i = 1; i <= 100; i++) {
        const name = i === 1 ? `${stem}.db` : `${stem}-${i}.db`;
        if (fs.existsSync(path.join(dir, name))) continue;
        store.db.prepare('VACUUM INTO ?').run(path.join(dir, name));
        return info(store, name);
    }
    throw new R.StoreError('conflict', 'Too many backups in the same second; try again.');
}

/** Backups next to the database, newest first: [{ name, file, size, createdAt }]. */
function list(store) {
    let names = [];
    try { names = fs.readdirSync(path.dirname(store.file)); } catch { return []; }
    const re = pattern(store);
    return names.filter((n) => re.test(n)).sort((a, b) => (order(store, a) < order(store, b) ? 1 : -1)).flatMap((n) => {
        try { return [info(store, n)]; } catch { return []; }
    });
}

/** The full path of a backup by its name (only names list() could return, of existing files), else null. */
function resolve(store, name) {
    if (typeof name !== 'string' || !pattern(store).test(name)) return null;
    const file = path.join(path.dirname(store.file), name);
    try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

module.exports = { create, list, resolve, pattern };
