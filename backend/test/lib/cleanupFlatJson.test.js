require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'cleanup_flat_json.js');

function seed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-cleanup-'));
    const db = new DatabaseSync(path.join(dir, 'scout.sqlite'));
    db.exec('CREATE TABLE document_store (key TEXT PRIMARY KEY, value TEXT)');
    const ins = db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)');
    ins.run('same.json', JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    ins.run('sub/diff.json', JSON.stringify({ v: 'db' }));
    db.close();
    fs.writeFileSync(path.join(dir, 'same.json'), JSON.stringify({ a: 1, b: [1, 2] }));
    fs.writeFileSync(path.join(dir, 'sub_diff.json'), JSON.stringify({ v: 'file' }));
    fs.writeFileSync(path.join(dir, 'only.json'), '{"x":1}');
    fs.writeFileSync(path.join(dir, 'database_backup_1.sqlite'), 'x');
    return dir;
}
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });

test('report mode classifies and moves nothing', () => {
    const dir = seed();
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /IN_DB_SAME\s+same\.json/);
    assert.match(r.stdout, /IN_DB_DIFFERENT\s+sub_diff\.json/);
    assert.match(r.stdout, /FILE_ONLY\s+only\.json/);
    assert.match(r.stdout, /database_backup_1\.sqlite/);
    for (const f of ['same.json', 'sub_diff.json', 'only.json']) assert.ok(fs.existsSync(path.join(dir, f)));
    assert.equal(fs.existsSync(path.join(dir, 'legacy_flat_files')), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('--apply moves only IN_DB_SAME by default', () => {
    const dir = seed();
    const r = run(dir, '--apply');
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'same.json')), false);
    assert.ok(fs.existsSync(path.join(dir, 'sub_diff.json')));
    assert.ok(fs.existsSync(path.join(dir, 'only.json')));
    assert.ok(fs.existsSync(path.join(dir, 'database_backup_1.sqlite')));
    const [stampDir] = fs.readdirSync(path.join(dir, 'legacy_flat_files'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'legacy_flat_files', stampDir)), ['same.json']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('--apply --include-different also moves IN_DB_DIFFERENT, never FILE_ONLY', () => {
    const dir = seed();
    const r = run(dir, '--apply', '--include-different');
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'same.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sub_diff.json')), false);
    assert.ok(fs.existsSync(path.join(dir, 'only.json')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a flattened alias key (written by the old fs intercept) is not a collision: compared with the real key', () => {
    const dir = seed();
    const db = new DatabaseSync(path.join(dir, 'scout.sqlite'));
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('a/b.json', '{"k":1}');
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('a_b.json', '{"k":"stale alias"}');
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('c/d.json', '{"k":2}');
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('c_d.json', '{"k":2}');
    db.close();
    fs.writeFileSync(path.join(dir, 'a_b.json'), '{"k":1}');          // equals the REAL key a/b.json
    fs.writeFileSync(path.join(dir, 'c_d.json'), '{"k":"old"}');      // differs from the real key c/d.json
    const r = run(dir);
    assert.match(r.stdout, /IN_DB_SAME +a_b[.]json/);
    assert.match(r.stdout, /IN_DB_DIFFERENT +c_d[.]json/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('two different real keys mapping to one filename are AMBIGUOUS and never moved', () => {
    const dir = seed();
    const db = new DatabaseSync(path.join(dir, 'scout.sqlite'));
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('x/y_z.json', '{"k":1}');
    db.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run('x_y/z.json', '{"k":1}');
    db.close();
    fs.writeFileSync(path.join(dir, 'x_y_z.json'), '{"k":1}');
    const r = run(dir, '--apply', '--include-different');
    assert.match(r.stdout, /AMBIGUOUS +x_y_z[.]json/);
    assert.ok(fs.existsSync(path.join(dir, 'x_y_z.json')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('--apply requires an explicit data dir argument', () => {
    const dir = seed();
    const r = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8', env: { ...process.env, DB_DATA_DIR: dir } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /explicit data directory/);
    assert.ok(fs.existsSync(path.join(dir, 'same.json')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('--apply refuses without scout.sqlite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-cleanup-'));
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    const r = run(dir, '--apply');
    assert.notEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'a.json')));
    fs.rmSync(dir, { recursive: true, force: true });
});
