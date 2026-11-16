require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'cleanup_orphan_racks.js');
const { findOrphans, dcIdFromKey, rackCounts } = require(SCRIPT);

const racksOf = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `r${i}`, devices: [{ id: `d${i}` }] }))
    .concat([{ id: 'b', isBack: true, devices: [] }]));

function seed(dcs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-orphan-'));
    const db = new DatabaseSync(path.join(dir, 'database.sqlite'));
    db.exec('CREATE TABLE document_store (key TEXT PRIMARY KEY, value TEXT)');
    const ins = db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)');
    if (dcs !== undefined) ins.run('data_center/datacenters.json', dcs);
    ins.run('data_center/server_rack.json', racksOf(1));        // default DC: never an orphan
    ins.run('data_center/server_rack_dc-live.json', racksOf(2)); // DC exists
    ins.run('data_center/server_rack_dc-gone.json', racksOf(3)); // orphan
    ins.run('data_center/rack_revisions.json', '{"dc-gone":4}');  // not a rack document
    db.close();
    return dir;
}

const keys = (dir) => {
    const db = new DatabaseSync(path.join(dir, 'database.sqlite'), { readOnly: true });
    const out = db.prepare('SELECT key FROM document_store ORDER BY key').all().map(r => r.key);
    db.close();
    return out;
};

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('dcIdFromKey and rackCounts', () => {
    assert.equal(dcIdFromKey('data_center/server_rack.json'), 'default');
    assert.equal(dcIdFromKey('data_center/server_rack_abc.json'), 'abc');
    assert.equal(dcIdFromKey('data_center/rack_revisions.json'), null);
    assert.deepEqual(rackCounts(racksOf(2)), { readable: true, racks: 2, backs: 1, devices: 2 });
    assert.equal(rackCounts('not json').readable, false);
});

test('findOrphans: only rack documents of data centers that are gone', () => {
    const rows = [
        { key: 'data_center/datacenters.json', value: JSON.stringify([{ id: 'dc-live' }]) },
        { key: 'data_center/server_rack.json', value: '[]' },
        { key: 'data_center/server_rack_dc-live.json', value: '[]' },
        { key: 'data_center/server_rack_dc-gone.json', value: racksOf(1) },
    ];
    const found = findOrphans(rows);
    assert.deepEqual(found.map(o => o.dcId), ['dc-gone']);
    assert.equal(found[0].counts.racks, 1);
});

test('findOrphans: no readable datacenters.json -> cannot decide (null)', () => {
    assert.equal(findOrphans([{ key: 'data_center/server_rack_x.json', value: '[]' }]), null);
    assert.equal(findOrphans([{ key: 'data_center/datacenters.json', value: '{bad' }]), null);
});

test('report mode changes nothing and prints counts only', () => {
    const dir = seed(JSON.stringify([{ id: 'default' }, { id: 'dc-live', name: 'Secret Name' }]));
    const before = keys(dir);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 orphan rack document\(s\)/);
    assert.match(r.stdout, /3 rack\(s\), 1 back face\(s\), 3 device\(s\)/);
    assert.doesNotMatch(r.stdout, /Secret Name|dc-gone/);
    assert.deepEqual(keys(dir), before);
});

test('--apply needs an explicit data directory', () => {
    const r = run('--apply');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing --apply/);
});

test('--apply exports, then deletes only the orphan', () => {
    const dir = seed(JSON.stringify([{ id: 'dc-live' }]));
    const r = run(dir, '--apply');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(keys(dir), [
        'data_center/datacenters.json', 'data_center/rack_revisions.json', 'data_center/server_rack.json',
        'data_center/server_rack_dc-live.json',
    ]);
    const backupRoot = path.join(dir, 'orphan_rack_backup');
    const [stampDir] = fs.readdirSync(backupRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, stampDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].key, 'data_center/server_rack_dc-gone.json');
    assert.equal(fs.readFileSync(path.join(backupRoot, stampDir, manifest[0].file), 'utf8'), racksOf(3));
});

test('--apply without datacenters.json deletes nothing', () => {
    const dir = seed(undefined);
    const before = keys(dir);
    const r = run(dir, '--apply');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skipped/);
    assert.deepEqual(keys(dir), before);
});
