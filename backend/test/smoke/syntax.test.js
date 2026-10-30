require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'data']);

function collectJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...collectJsFiles(path.join(dir, entry.name)));
        } else if (entry.name.endsWith('.js')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const files = collectJsFiles(BACKEND_ROOT);

test('backend contains JavaScript files to check', () => {
    assert.ok(files.length > 50, `expected >50 files, found ${files.length}`);
});

for (const file of files) {
    test(`syntax OK: ${path.relative(BACKEND_ROOT, file)}`, () => {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    });
}
