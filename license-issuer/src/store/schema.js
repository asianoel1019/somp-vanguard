// Database schema of the license issuer: numbered migrations (applied in order, each in its own transaction, recorded in
// schema_version) and the seed data of the first version.
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

const V1 = `
CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL
);
CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    tax_id TEXT,
    address TEXT,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    default_sales_id INTEGER REFERENCES sales(id),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE plans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('paid', 'trial')),
    term_value INTEGER NOT NULL CHECK (term_value > 0),
    term_unit TEXT NOT NULL CHECK (term_unit IN ('months', 'days')),
    price REAL CHECK (price IS NULL OR price >= 0),
    currency TEXT NOT NULL DEFAULT 'TWD',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL
);
CREATE TABLE licenses (
    id INTEGER PRIMARY KEY,
    license_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    licensed_to TEXT NOT NULL,
    plan_id INTEGER REFERENCES plans(id),
    type TEXT NOT NULL CHECK (type IN ('paid', 'trial')),
    format INTEGER NOT NULL CHECK (format IN (1, 2)),
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    sales_id INTEGER REFERENCES sales(id),
    amount REAL CHECK (amount IS NULL OR amount >= 0),
    currency TEXT,
    order_no TEXT,
    is_renewal INTEGER NOT NULL DEFAULT 0 CHECK (is_renewal IN (0, 1)),
    replaces_license_id INTEGER REFERENCES licenses(id),
    revoked_at TEXT,
    revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('replaced', 'terminated', 'issued_in_error', 'other')),
    revoke_note TEXT,
    file_path TEXT,
    sha12 TEXT,
    signed_at TEXT,
    key_id TEXT,
    contact_vendor TEXT,
    contact_email TEXT,
    created_at TEXT NOT NULL,
    CHECK (format = 1 OR expires_at IS NOT NULL),
    CHECK (type = 'paid' OR amount IS NULL OR amount = 0)
);
CREATE INDEX licenses_customer ON licenses(customer_id);
CREATE INDEX licenses_sales ON licenses(sales_id);
CREATE INDEX licenses_issued ON licenses(issued_at);
CREATE INDEX licenses_expires ON licenses(expires_at);
CREATE INDEX licenses_replaces ON licenses(replaces_license_id);
CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    license_id INTEGER NOT NULL REFERENCES licenses(id),
    type TEXT NOT NULL CHECK (type IN ('issued', 'delivered', 'delivery_failed', 'downloaded', 'reissued', 'revoked', 'replaced', 'edited', 'imported')),
    at TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX events_license ON events(license_id);
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const SEED_PLANS = [
    { name: 'Trial 30 days', type: 'trial', termValue: 30, termUnit: 'days', price: 0 },
    { name: '1 year', type: 'paid', termValue: 12, termUnit: 'months', price: null },
    { name: '2 years', type: 'paid', termValue: 24, termUnit: 'months', price: null },
    { name: '3 years', type: 'paid', termValue: 36, termUnit: 'months', price: null },
];

const MIGRATIONS = [
    {
        version: 1,
        up(db, at) {
            db.exec(V1);
            const ins = db.prepare('INSERT INTO plans (name, type, term_value, term_unit, price, currency, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
            for (const p of SEED_PLANS) ins.run(p.name, p.type, p.termValue, p.termUnit, p.price, 'TWD', at);
            // identifies this database in the generated registry, so another database never rewrites that copy
            db.prepare("INSERT INTO settings (key, value) VALUES ('db_id', ?)").run(crypto.randomBytes(8).toString('hex'));
        },
    },
];

/** Schema version of an open database (0 = empty). */
function currentVersion(db) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    return row && row.v ? row.v : 0;
}

/**
 * Brings the database to SCHEMA_VERSION; returns the versions applied. Throws when the file was made by a newer
 * license-issuer (a schema this code does not know) — nothing is changed then.
 */
function migrate(db, at) {
    const from = currentVersion(db);
    if (from > SCHEMA_VERSION) {
        const err = new Error(`The database has schema version ${from}, newer than this license-issuer understands (${SCHEMA_VERSION}). Update the program.`);
        err.code = 'SCHEMA_TOO_NEW';
        throw err;
    }
    const applied = [];
    for (const m of MIGRATIONS) {
        if (m.version <= from) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            // another process may have applied it while this one waited for the write lock
            if (currentVersion(db) >= m.version) { db.exec('COMMIT'); continue; }
            m.up(db, at);
            db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, at);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        applied.push(m.version);
    }
    return applied;
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, SEED_PLANS, currentVersion, migrate };
