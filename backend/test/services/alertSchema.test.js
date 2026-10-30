require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

const columns = (table) => dbManager.all(`PRAGMA table_info(${table})`).map(c => c.name);

test('new alert-quality tables exist', () => {
    for (const t of ['maintenance_windows', 'notify_state', 'notify_rate', 'notify_digest']) {
        assert.ok(dbManager.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]), t);
    }
});

test('new columns are added to alerts and rules, and are NULL for existing rows', () => {
    for (const c of ['suppressedReason', 'escalatedAt', 'occurrences']) assert.ok(columns('alerts').includes(c), c);
    assert.ok(columns('rules').includes('escalateAfterMin'));
    dbManager.run("INSERT INTO rules (id, name, type) VALUES ('r-old', 'old', 'cpu')");
    assert.equal(dbManager.get("SELECT escalateAfterMin FROM rules WHERE id='r-old'").escalateAfterMin, null);
});

test('initDB is idempotent (migrations re-run safely)', async () => {
    await dbManager.initDB();
    assert.ok(columns('alerts').includes('occurrences'));
});
