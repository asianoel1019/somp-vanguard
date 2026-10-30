require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { mountFrontend } = require('../../lib/frontendStatic');

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-dist-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script src="/assets/index-AbC123.js"></script>');
fs.writeFileSync(path.join(dist, 'assets', 'index-AbC123.js'), 'console.log(1)');
fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
test.after(() => fs.rmSync(dist, { recursive: true, force: true }));

const app = express();
app.get('/api/ping', (req, res) => res.json({ ok: true }));
mountFrontend(app, dist);

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

test('index.html is always revalidated (root and direct path)', async () => {
    for (const url of ['/', '/index.html']) {
        const res = await request(app).get(url).expect(200);
        assert.equal(res.headers['cache-control'], NO_CACHE, url);
        assert.match(res.text, /index-AbC123\.js/);
    }
});

test('SPA routes fall back to index.html with no-cache', async () => {
    const res = await request(app).get('/some/client/route').expect(200);
    assert.equal(res.headers['cache-control'], NO_CACHE);
    assert.match(res.text, /<!doctype html>/);
});

test('hashed build assets are cached long-term as immutable', async () => {
    const res = await request(app).get('/assets/index-AbC123.js').expect(200);
    assert.equal(res.headers['cache-control'], IMMUTABLE);
});

test('non-hashed static files are revalidated', async () => {
    const res = await request(app).get('/favicon.svg').expect(200);
    assert.equal(res.headers['cache-control'], NO_CACHE);
});

test('revalidation returns 304 when index.html is unchanged', async () => {
    const first = await request(app).get('/').expect(200);
    await request(app).get('/').set('If-None-Match', first.headers.etag).expect(304);
});

test('unknown /api/ paths still return JSON 404, existing API routes still work', async () => {
    const res = await request(app).get('/api/does-not-exist').expect(404);
    assert.deepEqual(res.body, { error: 'Not Found' });
    await request(app).get('/api/ping').expect(200);
});

test('a relative dist path works the same as an absolute one', async () => {
    const relApp = express();
    mountFrontend(relApp, path.relative(process.cwd(), dist));
    assert.equal((await request(relApp).get('/assets/index-AbC123.js').expect(200)).headers['cache-control'], IMMUTABLE);
    assert.equal((await request(relApp).get('/client/route').expect(200)).headers['cache-control'], NO_CACHE);
});

test('SPA fallback works when the install path contains a dot-directory (e.g. a .claude folder)', async () => {
    const dotted = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'somp-dot-')), '.claude', 'dist');
    fs.mkdirSync(dotted, { recursive: true });
    fs.writeFileSync(path.join(dotted, 'index.html'), '<!doctype html>dotted');
    const dotApp = express();
    mountFrontend(dotApp, dotted);
    const res = await request(dotApp).get('/client/route').expect(200);
    assert.match(res.text, /dotted/);
});
