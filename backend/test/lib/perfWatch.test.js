const test = require('node:test');
const assert = require('node:assert/strict');
const { timed, shortSql } = require('../../lib/perfWatch');

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
