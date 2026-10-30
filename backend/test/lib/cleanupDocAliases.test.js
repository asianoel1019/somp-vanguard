require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { isAliasKey, isCanonicalKey, flattenKey } = require('../../lib/docRegistry');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'cleanup_doc_aliases.js');
const SUBNETS = 'network_service/ipam/subnets.json';

function makeDb(file, tsCol) {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE document_store (key TEXT PRIMARY KEY, value TEXT, ${tsCol} TEXT)`);
    return db;
}

function seed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-alias-'));
    const local = makeDb(path.join(dir, 'database.sqlite'), 'updated_at');
    const ins = local.prepare('INSERT INTO document_store (key, value, updated_at) VALUES (?, ?, ?)');
    ins.run(SUBNETS, JSON.stringify([{ id: 1 }], null, 2), '2026-10-01 10:00:00');
    ins.run('network/service/ipam/subnets.json', JSON.stringify([{ id: 1 }]), '2026-01-01 10:00:00');       // identical, older
    ins.run('network_service_ipam_subnets.json', JSON.stringify([{ id: 'stale' }]), '2026-10-02 10:00:00'); // different, newer
    ins.run('data/center/datacenters.json', '[{"dc":"orphan"}]', '2026-01-01 10:00:00');                    // canonical missing
    ins.run('foo/bar.json', '{"unrelated":true}', '2026-01-01 10:00:00');                                    // not registered at all
    ins.run('network_service/ipam/subnets.revision.json', '{"rev":3}', '2026-01-01 10:00:00');               // docStore revision key
    ins.run('system/rbac.json', 'enc:abc', '2026-01-01 10:00:00');
    ins.run('system_rbac.json', 'enc:old', '2026-01-01 10:00:00');                                           // non-JSON alias
    local.close();
    const scout = makeDb(path.join(dir, 'scout.sqlite'), 'updatedAt');
    const ins2 = scout.prepare('INSERT INTO document_store (key, value, updatedAt) VALUES (?, ?, ?)');
    ins2.run('dns_data.json', '{"servers":[]}', '2026-10-01T10:00:00.000Z');
    ins2.run('dns/data.json', '{"servers":[1]}', '2026-01-01T10:00:00.000Z');
    scout.close();
    return dir;
}

const keysOf = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT key FROM document_store ORDER BY key').all().map(r => r.key); } finally { db.close(); }
};
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('registry alias helpers: canonical keys, "_" -> "/" aliases and flat file names', () => {
    assert.equal(flattenKey('a/b\\c.json'), 'a_b_c.json');
    assert.equal(isCanonicalKey(SUBNETS), true);
    assert.equal(isAliasKey(SUBNETS), false);
    assert.equal(isAliasKey('network/service/ipam/subnets.json'), true);
    assert.equal(isAliasKey('network_service_ipam_subnets.json'), true);
    assert.equal(isAliasKey('data/center/server/rack/dc1.json'), true, 'variant of a pattern-registered key');
    assert.equal(isAliasKey('data_center/server_rack_dc1.json'), false, 'the pattern-registered key itself');
    assert.equal(isAliasKey('dns_data.json'), false, 'a root canonical key is its own flat name');
    assert.equal(isAliasKey('foo/bar.json'), false, 'unregistered and no registered counterpart');
    assert.equal(isAliasKey('network_service/ipam/subnets.revision.json'), false);
});

test('report mode lists ALIAS / ORPHAN rows with size, equality and age, and changes nothing', () => {
    const dir = seed();
    const before = keysOf(path.join(dir, 'database.sqlite'));
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ALIAS +network\/service\/ipam\/subnets\.json +\S+ B +yes +canonical +network_service\/ipam\/subnets\.json/);
    assert.match(r.stdout, /ALIAS +network_service_ipam_subnets\.json +\S+ B +no +alias +network_service\/ipam\/subnets\.json/);
    assert.match(r.stdout, /ALIAS +system_rbac\.json .* no /);
    assert.match(r.stdout, /ORPHAN +data\/center\/datacenters\.json .*orphan, kept/);
    assert.match(r.stdout, /== scout\.sqlite: 1 alias-like row/);
    assert.match(r.stdout, /ALIAS +dns\/data\.json/);
    assert.doesNotMatch(r.stdout, /foo\/bar\.json/);
    assert.doesNotMatch(r.stdout, /subnets\.revision\.json/);
    assert.deepEqual(keysOf(path.join(dir, 'database.sqlite')), before);
    assert.equal(fs.existsSync(path.join(dir, 'legacy_alias_backup')), false);
    cleanup(dir);
});

test('--apply exports every alias row first, then deletes only those (canonical / orphan / unrelated rows kept)', () => {
    const dir = seed();
    const r = run(dir, '--apply');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(keysOf(path.join(dir, 'database.sqlite')), [
        'data/center/datacenters.json', 'foo/bar.json', SUBNETS, 'network_service/ipam/subnets.revision.json', 'system/rbac.json',
    ]);
    assert.deepEqual(keysOf(path.join(dir, 'scout.sqlite')), ['dns_data.json']);

    const [stampDir] = fs.readdirSync(path.join(dir, 'legacy_alias_backup'));
    const out = path.join(dir, 'legacy_alias_backup', stampDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.map(m => `${m.database}|${m.key}`).sort(), [
        'database.sqlite|network/service/ipam/subnets.json', 'database.sqlite|network_service_ipam_subnets.json',
        'database.sqlite|system_rbac.json', 'scout.sqlite|dns/data.json',
    ]);
    // raw values exported byte for byte (also the non-JSON one); colliding safe names get a suffix
    const byKey = Object.fromEntries(manifest.map(m => [m.key, fs.readFileSync(path.join(out, m.file), 'utf8')]));
    assert.equal(byKey['network_service_ipam_subnets.json'], JSON.stringify([{ id: 'stale' }]));
    assert.equal(byKey['network/service/ipam/subnets.json'], JSON.stringify([{ id: 1 }]));
    assert.equal(byKey['system_rbac.json'], 'enc:old');
    assert.equal(byKey['dns/data.json'], '{"servers":[1]}');
    assert.equal(new Set(manifest.map(m => m.file)).size, manifest.length);

    // second run: nothing left to remove, the orphan is still kept
    const again = run(dir, '--apply');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Nothing to remove/);
    assert.ok(keysOf(path.join(dir, 'database.sqlite')).includes('data/center/datacenters.json'));
    cleanup(dir);
});

test('--apply requires an explicit data dir argument', () => {
    const dir = seed();
    const r = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8', env: { ...process.env, DB_DATA_DIR: dir } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /explicit data directory/);
    assert.ok(keysOf(path.join(dir, 'database.sqlite')).includes('network_service_ipam_subnets.json'));
    cleanup(dir);
});

test('classify: revision keys are never aliases; aliases of pattern-registered keys are found', () => {
    const { classify } = require(SCRIPT);
    const rows = [
        { key: 'network_service/ipam/subnets.json', value: '[]', ts: '' },
        { key: 'network_service/ipam/subnets.revision.json', value: '{}', ts: '' },
        { key: 'network_service_ipam/subnets.revision.json', value: '{}', ts: '' },
    ];
    // revision keys are canonical at any depth; neither is an alias
    assert.deepEqual(classify(rows), []);
    const amb = classify([
        { key: 'workflows.json', value: '[]', ts: '' },
        { key: 'agent/conversations/a_b.json', value: '[]', ts: '' },
        { key: 'agent/conversations/a/b.json', value: '[1]', ts: '' },
        { key: 'agent_conversations/a_b.json', value: '[2]', ts: '' },
    ]);
    assert.deepEqual(amb.map(i => `${i.cls} ${i.row.key} -> ${i.canonical}`).sort(), [
        'ALIAS agent/conversations/a/b.json -> agent/conversations/a_b.json',
        'ALIAS agent_conversations/a_b.json -> agent/conversations/a_b.json',
    ]);
});

test('no database files: report exits 0, --apply exits non-zero', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-alias-'));
    assert.equal(run(dir).status, 0);
    assert.notEqual(run(dir, '--apply').status, 0);
    cleanup(dir);
});
