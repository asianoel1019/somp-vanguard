const test = require('node:test');
const assert = require('node:assert/strict');
const { timed, shortSql, startEventLoopMonitor } = require('../../lib/perfWatch');

test('slow calls are logged with the statement only; fast ones are not; results and errors pass through', (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (m) => warnings.push(m));
    process.env.DB_SLOW_QUERY_MS = '20';
    try {
        assert.equal(timed('all', 'SELECT 1', () => 'fast'), 'fast');
        const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
        assert.equal(timed('all', 'SELECT *\n   FROM windows_events  WHERE message LIKE ?', () => { busy(30); return 'slow'; }), 'slow');
        assert.throws(() => timed('run', 'DELETE x', () => { busy(30); throw new Error('boom'); }), /boom/);
    } finally {
        delete process.env.DB_SLOW_QUERY_MS;
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /^\[DB Slow\] \d+ms all: SELECT \* FROM windows_events WHERE message LIKE \?$/);
    assert.match(warnings[1], /run: DELETE x/);
    assert.equal(shortSql('x'.repeat(300)).length, 200);
});

test('a blocked event loop is logged with the number and total time of the database calls made meanwhile', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (m) => warnings.push(m));
    startEventLoopMonitor('test', { intervalMs: 20, blockMs: 100 });
    await new Promise(r => setTimeout(r, 50));
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
    for (let i = 0; i < 4; i++) timed('run', 'INSERT x', () => busy(40));
    await new Promise(r => setTimeout(r, 60));
    const line = warnings.find(w => w.startsWith('[Event Loop] test blocked'));
    assert.ok(line, warnings.join(' | '));
    const m = line.match(/; DB: (\d+) call\(s\), (\d+)ms in total$/);
    assert.ok(m, line);
    assert.equal(Number(m[1]), 4);
    assert.ok(Number(m[2]) >= 155, line);
});
