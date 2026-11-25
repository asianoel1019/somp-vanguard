// Loads the built-in node:sqlite (Node.js 22.13 or later) without its one-time "SQLite is an experimental feature"
// warning, and opens a database file with the settings every connection uses.
let sqlite = null;

const MIN_NODE = '22.13';

function loadSqlite() {
    if (sqlite) return sqlite;
    const original = process.emitWarning;
    process.emitWarning = function quiet(warning, ...rest) {
        const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
        const text = warning instanceof Error ? warning.message : String(warning);
        if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return undefined;
        return original.call(process, warning, ...rest);
    };
    try {
        sqlite = require('node:sqlite');
    } catch (e) {
        const err = new Error(`license-issuer needs Node.js ${MIN_NODE} or later: node:sqlite is not available in ${process.version}`);
        err.code = 'NO_SQLITE';
        err.cause = e;
        throw err;
    } finally {
        process.emitWarning = original;
    }
    return sqlite;
}

/** A DatabaseSync for `file` (created when missing) with foreign keys on and a 5 s busy timeout. */
function openDatabase(file) {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    } catch (e) {
        db.close();
        throw e;
    }
    return db;
}

module.exports = { MIN_NODE, loadSqlite, openDatabase };
