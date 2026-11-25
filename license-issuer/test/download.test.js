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
    assert.equal(r.status, 200, r.text);
    return { app, c, file: r.json.file };
}

/** Appends a hand-made registry row (sha computed from `shaOf` when given). */
function addRow(app, id, file, shaOf) {
    const sha256 = shaOf ? core.sha12(fs.readFileSync(shaOf)) : '000000000000';
    fs.appendFileSync(app.config.registryFile, core.registryRow({ licenseId: id, customer: 'Trick', issuedAt: '2026-11-25',
        expiresAt: '2027-11-24', keyId: 'k1', file, sha256, signedAt: '2026-11-25T10:00:00+08:00' }) + '\n');
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
