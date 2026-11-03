const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReadOnlyQuery, scanSql, maskSensitiveRows } = require('../../lib/sqlGuard');

const ok = (q, engine) => assert.equal(validateReadOnlyQuery(q, engine).ok, true, `${engine}: ${q}`);
const blocked = (q, engine) => assert.equal(validateReadOnlyQuery(q, engine).ok, false, `${engine}: ${q}`);

test('plain reads pass on every engine', () => {
    for (const engine of ['MySQL', 'PostgreSQL', 'SQLServer', 'SQLite']) {
        ok('SELECT id, name FROM users WHERE note = \'drop it; now\' ORDER BY id;', engine);
        ok('WITH t AS (SELECT 1 AS x) SELECT * FROM t', engine);
        ok('(SELECT 1) UNION (SELECT 2)', engine);
    }
    ok('SHOW TABLES', 'MySQL');
    ok('EXPLAIN SELECT 1', 'PostgreSQL');
    ok('PRAGMA table_info(users)', 'SQLite');
    ok('SELECT -- trailing comment\n 1', 'MySQL');
});

test('MySQL executable comments are rejected (they run although they look like comments)', () => {
    blocked('/*!50000 DROP TABLE t,*/ limitx', 'MySQL');
    blocked('SELECT 1 /*M! , SLEEP(10) */', 'MySQL');
    // the same text on PostgreSQL is an ordinary comment
    ok('SELECT 1 /*! DROP */', 'PostgreSQL');
});

test('more than one statement is rejected, a trailing semicolon is fine', () => {
    blocked('SELECT 1 LIMIT 1; COMMIT; SELECT pg_terminate_backend(1)', 'PostgreSQL');
    blocked('SELECT 1; SELECT 2', 'MySQL');
    ok('SELECT 1;  ;  ', 'PostgreSQL');
});

test('only read-only leading keywords are allowed', () => {
    blocked('DO $$ BEGIN PERFORM 1; END $$', 'PostgreSQL');
    blocked('KILL 12', 'MySQL');
    blocked('SHOW TABLES', 'SQLServer');
    blocked('PRAGMA writable_schema = 1', 'MySQL');
});

test('write keywords and side-effect functions inside a SELECT are rejected', () => {
    blocked('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'PostgreSQL');
    blocked('SELECT * INTO new_table FROM t', 'SQLServer');
    blocked('SELECT * FROM t LIMIT 1 INTO OUTFILE \'/tmp/x\'', 'MySQL');
    blocked('SELECT pg_sleep(100)', 'PostgreSQL');
    blocked('SELECT query_to_xml(\'select pg_terminate_backend(1)\', true, true, \'\')', 'PostgreSQL');
    blocked('SELECT SLEEP (5)', 'MySQL');
    blocked('SELECT * FROM t FOR UPDATE', 'MySQL');
});

test('T-SQL batches need no semicolon, so statement keywords are blocked anywhere', () => {
    blocked('SELECT 1 SHUTDOWN WITH NOWAIT', 'SQLServer');
    blocked('SELECT 1 WAITFOR DELAY \'00:10\'', 'SQLServer');
    blocked('SELECT TOP 1 1 COMMIT', 'SQLServer');
    ok('SELECT IIF(a > 1, 1, 0) FROM t', 'SQLServer');
});

test('quoting rules follow the engine', () => {
    // MySQL backslash escape: the string runs to the last quote, nothing executable hides
    assert.doesNotMatch(scanSql("SELECT 'a\\' DROP'", 'MySQL').code, /DROP/);
    // PostgreSQL standard strings: backslash is literal, DROP is code
    blocked("SELECT 'a\\' DROP '", 'PostgreSQL');
    // MySQL '--' needs a space to be a comment
    blocked('SELECT 1 --1\n; DROP TABLE t', 'MySQL');
    // PostgreSQL nests block comments
    assert.doesNotMatch(scanSql('SELECT /* a /* b */ DROP */ 1', 'PostgreSQL').code, /DROP/);
    assert.match(scanSql('SELECT /* a /* b */ DROP */ 1', 'MySQL').code, /DROP/);
    // dollar quoting hides its body, quoted identifiers stay visible as Q_ names
    assert.doesNotMatch(scanSql('SELECT $x$ DROP $x$', 'PostgreSQL').code, /DROP/);
    assert.match(scanSql('SELECT [delete] FROM t', 'SQLServer').code, /Q_delete/);
    ok('SELECT [delete] FROM t', 'SQLServer');
});

test('masking: sensitive names, aliases of sensitive columns, and sensitive-looking values', () => {
    const rows = [{ id: 1, p: 'hunter2', contact: 'alice@example.com', mobile_no: '0912345678', nid: 'A123456789', note: 'hi' }];
    const { rows: masked, maskedColumns } = maskSensitiveRows(rows, 'SELECT id, password AS p, x AS contact, mobile_no, nid, note FROM u', 'MySQL');
    assert.deepEqual(maskedColumns.sort(), ['contact', 'mobile_no', 'nid', 'p'].sort());
    assert.equal(masked[0].p, '******');
    assert.equal(masked[0].contact, 'a***e@example.com');
    assert.equal(masked[0].mobile_no, '091****78');
    assert.equal(masked[0].nid, 'A12****789');
    assert.equal(masked[0].note, 'hi');
    assert.equal(rows[0].p, 'hunter2', 'input rows untouched');
});

test('masking: aliases in quoted, implicit, T-SQL and subquery forms; WHERE-only use masks nothing', () => {
    const cols = (q, engine, row) => maskSensitiveRows([row], q, engine).maskedColumns;
    assert.deepEqual(cols('SELECT [password] AS [x] FROM u', 'SQLServer', { x: 'a' }), ['x']);
    assert.deepEqual(cols('SELECT x = pwd FROM u', 'SQLServer', { x: 'a' }), ['x']);
    assert.deepEqual(cols('SELECT UPPER(secret) s FROM u', 'PostgreSQL', { s: 'a' }), ['s']);
    assert.deepEqual(cols('SELECT * FROM (SELECT token AS t FROM u) z', 'MySQL', { t: 'a' }), ['t']);
    assert.deepEqual(cols("SELECT id FROM u WHERE email = 'a@b.c'", 'MySQL', { id: 1 }), []);
});
