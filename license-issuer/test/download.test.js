// Downloads: only files the registry lists, unchanged since signing; path tricks are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../../scripts/licenseIssuerCore');
const { startApp } = require('./helpers');

const GOOD = { customer: 'Example Corp.', licenseId: 'L-2026-0001', issuedAt: '2026-11-25', expiresAt: '2027-11-24' };

async function issued(t) {
    const app = await startApp(t);
    const c = await app.login();
    const r = await c.issue(GOOD);
    assert.equal(r.status, 201, r.text);
    return { app, c, file: r.json.file };
}

/** Records a hand-made license row in the database (sha computed from `shaOf` when given). */
function addRow(app, id, file, shaOf) {
    const sha256 = shaOf ? core.sha12(fs.readFileSync(shaOf)) : '000000000000';
    const customerId = app.store.listCustomers()[0].id;
    app.store.db.prepare(`INSERT INTO licenses (license_id, customer_id, licensed_to, type, format, issued_at, expires_at, file_path, sha12,
        signed_at, key_id, created_at) VALUES (?, ?, 'Trick', 'paid', 2, '2026-11-25', '2027-11-24', ?, ?, '2026-11-25T10:00:00+08:00', 'k1', '2026-11-25T10:00:00+08:00')`)
        .run(id, customerId, file, sha256);
}

test('a listed file with a matching hash downloads as an attachment', async (t) => {
    const { app, c, file } = await issued(t);
    const r = await c.call('GET', '/api/download/L-2026-0001');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /^attachment; filename="?L-2026-0001-example-corp\.lic"?$/);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.raw, fs.readFileSync(file));
    assert.match(app.auditText(), /"event":"download","licenseId":"L-2026-0001"/);
    assert.deepEqual(app.store.licenseEvents('L-2026-0001').map((e) => e.type), ['issued', 'downloaded']);
});

test('an ID that is not in the registry is 404', async (t) => {
    const { c } = await issued(t);
    const r = await c.call('GET', '/api/download/L-2026-0099');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /not in the registry/);
});

test('a file changed after signing is 409; a missing file is 404', async (t) => {
    const { c, file } = await issued(t);
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, ' ');
    const changed = await c.call('GET', '/api/download/L-2026-0001');
    assert.equal(changed.status, 409);
    assert.match(changed.json.error, /does not match the SHA-256/);
    fs.rmSync(file);
    const missing = await c.call('GET', '/api/download/L-2026-0001');
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /missing/);
    fs.writeFileSync(file, original);
    assert.equal((await c.call('GET', '/api/download/L-2026-0001')).status, 200);
});

test('path tricks: odd IDs, the private key, relative paths and non-.lic files are refused', async (t) => {
    const { app, c } = await issued(t);
    for (const p of ['/api/download/..%2F..%2Fissued-licenses.md', '/api/download/..%5C..%5Cx', '/api/download/L-2026-0001%00',
        '/api/download/L-2026-0001.lic', '/api/download/l-2026-0001', '/api/download/%2e%2e', '/api/download/']) {
        const r = await c.call('GET', p);
        assert.ok(r.status === 404, `${p} -> ${r.status}`);
        assert.ok(!r.raw.includes('PRIVATE KEY'), p);
    }
    // a registry row pointing at the private key, even with a matching hash
    addRow(app, 'L-2026-0050', app.config.keyFile, app.config.keyFile);
    // ...or at another file with a matching hash, or a relative path, or a folder
    const other = path.join(app.k.dir, 'notes.txt');
    fs.writeFileSync(other, 'not a license');
    addRow(app, 'L-2026-0051', other, other);
    addRow(app, 'L-2026-0052', 'issued\\L-2026-0001-example-corp.lic', path.join(app.config.issuedDir, 'L-2026-0001-example-corp.lic'));
    fs.mkdirSync(path.join(app.k.dir, 'dir.lic'));
    addRow(app, 'L-2026-0053', path.join(app.k.dir, 'dir.lic'));
    for (const id of ['L-2026-0050', 'L-2026-0051', 'L-2026-0052', 'L-2026-0053']) {
        const r = await c.call('GET', `/api/download/${id}`);
        assert.equal(r.status, 409, `${id}: ${r.text}`);
        assert.ok(!r.raw.includes('PRIVATE KEY'), id);
    }
    assert.match(app.auditText(), /"event":"download-refused"/);
});
