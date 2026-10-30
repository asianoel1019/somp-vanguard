// Unified data access guard: scans the backend source (not tests / node_modules / scripts) for document writes.
//  - writeDataSync( / writeDB( on a key whose lib/docRegistry.js mode is 'mutate' or 'log' fails (outside lib/db.js,
//    lib/docStore.js and the explicit allowlist below): those documents must use docStore.mutateDocument.
//  - a written key that resolves to a literal / file constant but has no registry entry fails: register new documents.
//  - a key that cannot be resolved statically must be listed in DYNAMIC_KEYS with a reason.
//  - a 'legacy' key (e.g. the former log documents, now SQL tables in services/logTables.js) is never written:
//    no writeDataSync / writeDB / mutateDocument / replaceDocument on it anywhere (no allowlist), and its key literal
//    appears only in lib/docRegistry.js and the readers its registry entry names (the one-time migration / imports).
// Every rule is strict: a violation fails the suite (there is no warn-only mode).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getEntry, modeOf, ENTRIES } = require('../../lib/docRegistry');

const ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'scripts', 'data', 'coverage']);
const EXEMPT_FILES = new Set(['lib/db.js', 'lib/docStore.js']);

// One-time migrations etc. that may write a 'mutate' / 'log' key directly. Format: 'file|key' -> reason.
const MUTATE_WRITE_ALLOWLIST = {
    // (none: every mutate / log key is written through docStore)
};

// Writes whose key is computed at runtime. Format: 'file|<first argument text>' -> reason (incl. the keys it can be).
const DYNAMIC_KEYS = {
    'lib/agent/conversationStore.js|storeKey(user)': "per-user 'agent/conversations/<user>.json' (registry pattern, replace, web only)",
    'lib/rackStore.js|rackKey(dcId)': "'data_center/server_rack[_<dc>].json' (registry pattern, replace, own revision scheme, web only)",
    'services/environmentMigration.js|docKey': 'generic helper: the CMDB meta / IPAM / SSL keys are routed to their atomic stores first; only the replace-mode database_clusters / database_requests documents reach writeDataSync',
    'services/environmentUsage.js|key': 'generic helper: the CMDB meta / IPAM / SSL keys are routed to their atomic stores first; only the replace-mode database_clusters / database_requests documents reach writeDataSync',
};

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), out);
        } else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
}

/** const NAME = 'literal' / `literal` and NAME: 'a/b.json' within one file. */
function constantsOf(src) {
    const map = {};
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n$]+)\2/g)) map[m[1]] = m[3];
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"\n]+\.json)\2/g)) if (!map[m[1]]) map[m[1]] = m[3];
    return map;
}

/** Text of the first call argument starting at index i (just after the opening parenthesis). */
function firstArg(src, i) {
    let depth = 0;
    let quote = null;
    let out = '';
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += src[++i]; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
        if (c === ',' && depth === 0) break;
        out += c;
    }
    return out.trim();
}

function resolveKey(arg, consts) {
    const lit = /^(['"`])([^'"`$]*)\1$/.exec(arg);
    if (lit) return lit[2];
    if (/^[A-Za-z_$][\w$]*$/.test(arg) && consts[arg]) return consts[arg];
    return null;
}

const SOURCES = walk(ROOT).map(abs => ({ file: path.relative(ROOT, abs).replace(/\\/g, '/'), src: fs.readFileSync(abs, 'utf8') }));
const isCommentLine = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };

/** Every call of one of `fnNames`: { file, line, fn, key|null, arg } (EXEMPT_FILES skipped). */
function scanCalls(fnNames) {
    const re = new RegExp(`\\b(${fnNames.join('|')})\\s*\\(`, 'g');
    const calls = [];
    for (const { file, src } of SOURCES) {
        if (EXEMPT_FILES.has(file)) continue;
        const consts = constantsOf(src);
        const lines = src.split(/\r?\n/);
        lines.forEach((l, idx) => {
            if (isCommentLine(l)) return;
            for (const m of l.matchAll(re)) {
                // definitions / destructuring imports are not calls
                if (/function\s+$/.test(l.slice(0, m.index))) continue;
                const offset = lines.slice(0, idx).reduce((n, x) => n + x.length + 1, 0) + m.index + m[0].length;
                const arg = m[1] === 'writeDB' ? "'dns_data.json'" : firstArg(src.replace(/\r\n/g, '\n'), offset);
                calls.push({ file, line: idx + 1, fn: m[1], arg, key: resolveKey(arg, consts) });
            }
        });
    }
    return calls;
}

/** Every document write call: { file, line, key|null, arg } */
function scanWrites() {
    return scanCalls(['writeDataSync', 'writeDB']);
}

const writes = scanWrites();
const lockedWrites = scanCalls(['mutateDocument', 'replaceDocument']);
if (process.env.DOC_GUARD_DEBUG === '1') console.log(writes.map(w => `${w.file}:${w.line} ${w.key || `<${w.arg}>`} ${w.key ? modeOf(w.key) : ''}`).join('\n'));

test('the scan finds the document writes (sanity)', () => {
    assert.ok(writes.length > 20, `only ${writes.length} writes found`);
    assert.ok(writes.some(w => w.key === 'runbooks.json'), 'a known replace-mode write is found');
});

test('no writeDataSync on a mutate / log document outside lib/db.js, lib/docStore.js and the allowlist', () => {
    const bad = writes
        .filter(w => w.key && ['mutate', 'log'].includes(modeOf(w.key)))
        .filter(w => !MUTATE_WRITE_ALLOWLIST[`${w.file}|${w.key}`])
        .map(w => `${w.file}:${w.line} writes '${w.key}' (mode ${modeOf(w.key)}): use docStore.mutateDocument / its store module`);
    assert.deepEqual(bad, []);
});

test('legacy documents are never written (writeDataSync / writeDB / mutateDocument / replaceDocument), no allowlist', () => {
    const bad = writes.concat(lockedWrites)
        .filter(w => w.key && modeOf(w.key) === 'legacy')
        .map(w => `${w.file}:${w.line} ${w.fn}('${w.key}'): legacy document (read only by its migration)`);
    assert.deepEqual(bad, []);
});

test('a legacy key literal appears only in lib/docRegistry.js and the readers its registry entry names', () => {
    const legacy = ENTRIES.filter(e => e.mode === 'legacy' && e.key);
    assert.ok(legacy.length >= 5, 'the former log documents are legacy');
    const bad = [];
    for (const e of legacy) {
        const allowed = new Set(['lib/docRegistry.js', ...(e.readers || [])]);
        const lit = new RegExp(`(['"\`])${e.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
        for (const { file, src } of SOURCES) {
            if (allowed.has(file)) continue;
            src.split(/\r?\n/).forEach((l, idx) => { if (!isCommentLine(l) && lit.test(l)) bad.push(`${file}:${idx + 1} '${e.key}'`); });
        }
    }
    assert.deepEqual(bad, [], 'read the table (services/logTables.js) instead of the legacy document');
    for (const e of legacy) assert.deepEqual(e.writers || [], [], `legacy ${e.key} has no writers`);
});

test('every statically resolvable written key is registered in lib/docRegistry.js', () => {
    const missing = writes.filter(w => w.key && !getEntry(w.key)).map(w => `${w.file}:${w.line} '${w.key}'`);
    assert.deepEqual(missing, [], 'register these documents in lib/docRegistry.js');
});

test('every unresolvable (dynamic) key is allowlisted with a reason, and the allowlist has no stale entries', () => {
    const dynamic = writes.filter(w => !w.key);
    const unlisted = dynamic.filter(w => !DYNAMIC_KEYS[`${w.file}|${w.arg}`]).map(w => `${w.file}:${w.line} writeDataSync(${w.arg}, ...)`);
    assert.deepEqual(unlisted, [], 'add a DYNAMIC_KEYS entry (with the keys it can be) or use a constant key');
    const seen = new Set(dynamic.map(w => `${w.file}|${w.arg}`));
    assert.deepEqual(Object.keys(DYNAMIC_KEYS).filter(k => !seen.has(k)), [], 'stale DYNAMIC_KEYS entries');
    for (const [k, reason] of Object.entries({ ...DYNAMIC_KEYS, ...MUTATE_WRITE_ALLOWLIST })) assert.ok(String(reason).length > 10, `reason for ${k}`);
});

test('registry entries are well formed', () => {
    for (const e of ENTRIES) {
        assert.ok(!!e.key !== !!e.pattern, `exactly one of key / pattern: ${JSON.stringify(e)}`);
        assert.ok(['mutate', 'replace', 'log', 'legacy'].includes(e.mode), `mode of ${e.key || e.pattern}`);
        assert.ok(['web', 'worker', 'both'].includes(e.owner), `owner of ${e.key || e.pattern}`);
        assert.ok(e.description, `description of ${e.key || e.pattern}`);
    }
    assert.equal(modeOf('data_center/server_rack.json'), 'replace');
    assert.equal(modeOf('data_center/server_rack_dc-2.json'), 'replace');
    assert.equal(modeOf('server_operation/server_cmdb_meta.json'), 'mutate');
    assert.equal(modeOf('not/registered.json'), null);
});

test('the guard detects a forbidden write (self-test)', () => {
    const consts = constantsOf("const K = 'server_operation/server_cmdb_meta.json';");
    assert.equal(resolveKey('K', consts), 'server_operation/server_cmdb_meta.json');
    assert.equal(resolveKey("'dns_changes.json'", {}), 'dns_changes.json');
    assert.equal(resolveKey('`x/${a}.json`', {}), null);
    assert.equal(firstArg("CMDB_META_KEY, meta);", 0), 'CMDB_META_KEY');
    assert.equal(firstArg("getKey(file), data);", 0), 'getKey(file)');
    assert.equal(modeOf(resolveKey('K', consts)), 'mutate');
    // a legacy key written through docStore is caught too
    assert.equal(modeOf(resolveKey("'server_operation/scheduler_logs.json'", {})), 'legacy');
    assert.ok(lockedWrites.length > 10, 'mutateDocument / replaceDocument calls are scanned');
});
