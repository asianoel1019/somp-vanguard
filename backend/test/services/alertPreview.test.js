require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { previewAlerts } = require('../../services/alertPreview');

const T0 = new Date();   // fixtures are relative to now so the script test (which uses the real clock) sees them as fresh
const ago = (min) => new Date(+T0 - min * 60000).toISOString();
test.before(async () => {
    await dbManager.initDB();
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m1','WEB-01','10.0.0.1','[]',1),('m2','WEB-02','10.0.0.2','[]',1),('m3','NEW','10.0.0.3','[]',1),('m4','OFF','10.0.0.4','[]',0),('m5','STALE','10.0.0.5','[]',1),('m6','BADTS','10.0.0.6','[]',1)");
    dbManager.run(`INSERT INTO rules (id, name, type, threshold, alertHits, actions, category) VALUES ('r1','CPU','cpu',90,3,'[]','metric'),('r-log','4625','winevent',1,1,'[]','log')`);
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b1','r1','monitor','m1'),('b2','r1','monitor','m2'),('b3','r-log','monitor','m1'),('b4','r1','monitor','m4'),('b5','r1','monitor','m5'),('b6','r1','monitor','m6')");
    dbManager.run("INSERT INTO metrics (monitorId, timestamp, metrics) VALUES ('m1',?,?),('m1',?,?),('m2',?,?),('m4',?,?),('m5',?,?),('m6',?,?)", [
        ago(5), JSON.stringify({ cpu: { used: 20 } }),
        ago(1), JSON.stringify({ cpu: { used: 97 } }),
        ago(1), JSON.stringify({ cpu: { used: 50 } }),
        ago(1), JSON.stringify({ cpu: { used: 99 } }),
        ago(30), JSON.stringify({ cpu: { used: 99 } }),
        'not-a-date', JSON.stringify({ cpu: { used: 99 } }),
    ]);
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w','x','once',?,?,'monitors','["m1"]','[]',1)`, [new Date(T0 - 60000).toISOString(), new Date(+T0 + 3600000).toISOString()]);
});
test.after(async () => { await dbManager.closeDB(); });

test('uses the latest metrics per enabled monitor and flags maintenance; read-only', () => {
    const before = dbManager.get('SELECT count(*) c FROM alerts').c;
    const p = previewAlerts({ all: dbManager.all, get: dbManager.get }, T0);
    assert.equal(p.monitorsChecked, 5);
    assert.equal(p.monitorsWithoutMetrics, 1);
    assert.equal(p.monitorsStale, 2);   // 30 min old + unparsable timestamp
    assert.deepEqual(p.firing.map(f => [f.host, f.ruleName, f.value, f.inMaintenance]), [['WEB-01', 'CPU', 97, true]]);
    assert.equal(p.firing[0].metricsAt, ago(1));
    assert.match(p.note, /日誌|log/i);
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts').c, before);
});

test('scripts/alert_preview.js prints a report from a read-only DB', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const { dataDir } = require('../helpers/setupEnv');
    const out = execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/alert_preview.js'), dataDir], { encoding: 'utf8' });
    assert.match(out, /預計觸發：1 則/);
    assert.match(out, /1 台無指標資料，2 台指標超過 10 分鐘未更新/);
});

test('scripts/alert_preview.js works when maintenance_windows table is missing', () => {
    const { execFileSync } = require('child_process');
    const fs = require('fs'), os = require('os'), path = require('path');
    const { DatabaseSync } = require('node:sqlite');
    const { dataDir } = require('../helpers/setupEnv');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-prev-'));
    try {
        for (const suffix of ['', '-wal', '-shm']) {
            const src = path.join(dataDir, 'scout.sqlite' + suffix);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'scout.sqlite' + suffix));
        }
        const d = new DatabaseSync(path.join(tmp, 'scout.sqlite'));
        d.exec('DROP TABLE maintenance_windows');
        d.close();
        const out = execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/alert_preview.js'), tmp], { encoding: 'utf8' });
        assert.match(out, /預計觸發：1 則（其中維護中 0 則/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('preview honours rule exclusions (excluded host is not listed as firing)', () => {
    dbManager.run("INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, reason, createdBy, createdAt) VALUES ('px','r1','monitor','m1','','t',?)", [T0.toISOString()]);
    try {
        assert.deepEqual(previewAlerts({ all: dbManager.all, get: dbManager.get }, T0).firing, []);
    } finally {
        dbManager.run("DELETE FROM rule_exclusions WHERE id = 'px'");
    }
});

test('scripts/alert_preview.js works when rule_exclusions table is missing (DB not migrated yet)', () => {
    const { execFileSync } = require('child_process');
    const fs = require('fs'), os = require('os'), path = require('path');
    const { DatabaseSync } = require('node:sqlite');
    const { dataDir } = require('../helpers/setupEnv');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-prev-'));
    try {
        for (const suffix of ['', '-wal', '-shm']) {
            const src = path.join(dataDir, 'scout.sqlite' + suffix);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'scout.sqlite' + suffix));
        }
        const d = new DatabaseSync(path.join(tmp, 'scout.sqlite'));
        d.exec('DROP TABLE rule_exclusions');
        d.close();
        const out = execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/alert_preview.js'), tmp], { encoding: 'utf8' });
        assert.match(out, /預計觸發：1 則/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('alertPreview.js loads without the logger or the db manager (pure modules only)', () => {
    const { execFileSync } = require('child_process');
    const mod = require.resolve('../../services/alertPreview');
    const code = `require(${JSON.stringify(mod)}); process.stdout.write(JSON.stringify(Object.keys(require.cache).map(p => p.split(String.fromCharCode(92)).join('/')).filter(p => p.includes('/lib/logger') || p.includes('/services/db')))); `;
    const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), []);
});
