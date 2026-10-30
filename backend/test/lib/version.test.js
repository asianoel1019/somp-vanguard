require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');

test('getVersion comes from package.json even when a stale VERSION is left in .env', () => {
    const saved = process.env.VERSION;
    process.env.VERSION = 'v1.6.12(Build 2026.08.26)';   // production .env is never deployed (SCP excludes it)
    try {
        delete require.cache[require.resolve('../../lib/version')];
        assert.equal(require('../../lib/version').getVersion(), `v${pkg.version}`);
    } finally {
        if (saved === undefined) delete process.env.VERSION; else process.env.VERSION = saved;
    }
});

test('no runtime code reads process.env.VERSION any more (single source of truth)', () => {
    const hits = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', 'test', 'scripts'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('process.env.VERSION')) hits.push(path.relative(path.join(__dirname, '../..'), p));
        }
    };
    walk(path.join(__dirname, '../..'));
    assert.deepEqual(hits, []);
});
