require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { translateSql, buildUpsertSql } = require('../../services/db/translator');

const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('translateSql keeps ? for sqlite and mysql/mariadb', () => {
    const sql = 'SELECT * FROM t WHERE a = ? AND b = ?';
    assert.equal(translateSql(sql, 'sqlite'), sql);
    assert.equal(translateSql(sql, 'mariadb'), sql);
    assert.equal(translateSql(sql, 'mysql'), sql);
});

test('translateSql numbers placeholders for postgres aliases', () => {
    for (const type of ['postgres', 'pg', 'postgresql', ' PG ']) {
        assert.equal(translateSql('a = ? AND b = ?', type), 'a = $1 AND b = $2');
    }
});

test('translateSql converts ? to @pN for mssql', () => {
    assert.equal(translateSql('a = ? AND b = ?', 'mssql'), 'a = @p1 AND b = @p2');
});

test('translateSql rewrites LIMIT/OFFSET to OFFSET-FETCH for mssql', () => {
    assert.equal(
        translateSql('SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20', 'mssql'),
        'SELECT * FROM t ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY'
    );
    assert.equal(
        translateSql('SELECT * FROM t ORDER BY id LIMIT ? OFFSET ?', 'sqlserver'),
        'SELECT * FROM t ORDER BY id OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY'
    );
    assert.equal(
        translateSql('SELECT * FROM t ORDER BY id LIMIT 5', 'mssql'),
        'SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY'
    );
});

test('translateSql passes through non-string input', () => {
    assert.equal(translateSql(null, 'pg'), null);
    assert.equal(translateSql(undefined, 'pg'), undefined);
});

test('translateSql does not replace ? inside string literals', () => {
    assert.equal(translateSql("SELECT 'why?' WHERE a = ?", 'pg'), "SELECT 'why?' WHERE a = $1");
    assert.equal(translateSql("SELECT 'why?' WHERE a = ?", 'mssql'), "SELECT 'why?' WHERE a = @p1");
});

test('translateSql handles escaped quotes inside literals', () => {
    assert.equal(
        translateSql("UPDATE t SET note = 'it''s ok?' WHERE id = ? AND b = ?", 'pg'),
        "UPDATE t SET note = 'it''s ok?' WHERE id = $1 AND b = $2"
    );
});

test('translateSql does not replace ? inside quoted identifiers or comments', () => {
    assert.equal(translateSql('SELECT "col?" FROM t WHERE a = ?', 'pg'), 'SELECT "col?" FROM t WHERE a = $1');
    assert.equal(translateSql('SELECT [col?] FROM t WHERE a = ?', 'mssql'), 'SELECT [col?] FROM t WHERE a = @p1');
    assert.equal(translateSql('SELECT 1 -- why?\nWHERE a = ?', 'pg'), 'SELECT 1 -- why?\nWHERE a = $1');
    assert.equal(translateSql('SELECT /* a ? b */ 1 WHERE a = ?', 'mssql'), 'SELECT /* a ? b */ 1 WHERE a = @p1');
});

test('translateSql keeps PostgreSQL array subscripts as placeholders', () => {
    assert.equal(translateSql('SELECT arr[?] FROM t WHERE a = ?', 'pg'), 'SELECT arr[$1] FROM t WHERE a = $2');
});

test('translateSql leaves an unterminated literal untouched instead of guessing', () => {
    assert.equal(translateSql("SELECT 'oops ? WHERE a = ?", 'pg'), "SELECT 'oops ? WHERE a = ?");
});

const DATA = { key: 'k1', value: 'v1', updatedAt: '2026-01-01' };

test('buildUpsertSql sqlite uses ON CONFLICT DO UPDATE', () => {
    const { sql, values } = buildUpsertSql('document_store', DATA, ['key'], 'sqlite');
    assert.equal(norm(sql),
        'INSERT INTO "document_store" ("key","value","updatedAt") VALUES (?,?,?) ' +
        'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"');
    assert.deepEqual(values, ['k1', 'v1', '2026-01-01']);
});

test('buildUpsertSql postgres uses $N and EXCLUDED', () => {
    const { sql } = buildUpsertSql('document_store', DATA, ['key'], 'postgres');
    assert.equal(norm(sql),
        'INSERT INTO "document_store" ("key", "value", "updatedAt") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = EXCLUDED."updatedAt"');
});

test('buildUpsertSql mariadb uses ON DUPLICATE KEY UPDATE', () => {
    const { sql } = buildUpsertSql('document_store', DATA, ['key'], 'mariadb');
    assert.equal(norm(sql),
        'INSERT INTO `document_store` (`key`, `value`, `updatedAt`) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = VALUES(`updatedAt`)');
});

test('buildUpsertSql mssql uses MERGE with @pN params', () => {
    const { sql, values } = buildUpsertSql('document_store', DATA, ['key'], 'mssql');
    const s = norm(sql);
    assert.ok(s.startsWith('MERGE INTO [document_store] WITH (HOLDLOCK) AS target'));
    assert.ok(s.includes('USING (VALUES (@p1, @p2, @p3)) AS source ([key], [value], [updatedAt])'));
    assert.ok(s.includes('ON target.[key] = source.[key]'));
    assert.ok(s.includes('UPDATE SET target.[value] = source.[value], target.[updatedAt] = source.[updatedAt]'));
    assert.deepEqual(values, ['k1', 'v1', '2026-01-01']);
});

test('buildUpsertSql with only conflict columns becomes DO NOTHING', () => {
    assert.match(buildUpsertSql('t', { id: 1 }, ['id'], 'sqlite').sql, /DO NOTHING$/);
    assert.match(buildUpsertSql('t', { id: 1 }, ['id'], 'pg').sql, /DO NOTHING$/);
});

test('mariadb/mysql: double-quoted identifiers become backticks, placeholders stay ?', () => {
    for (const type of ['mariadb', 'mysql']) {
        assert.equal(
            translateSql('SELECT "key", value FROM document_store WHERE "key" = ?', type),
            'SELECT `key`, value FROM document_store WHERE `key` = ?'
        );
    }
});

test('mariadb: a double-quoted word inside a single-quoted literal is not converted (including \'\' escapes)', () => {
    assert.equal(
        translateSql(`SELECT "key" FROM t WHERE note = 'say "key"' AND other = 'it''s "x"' AND "id" = ?`, 'mariadb'),
        `SELECT \`key\` FROM t WHERE note = 'say "key"' AND other = 'it''s "x"' AND \`id\` = ?`
    );
});

test('mssql: double-quoted identifiers become [brackets] and ? becomes @pN', () => {
    assert.equal(
        translateSql('SELECT "key", value FROM document_store WHERE "key" = ?', 'mssql'),
        'SELECT [key], value FROM document_store WHERE [key] = @p1'
    );
    assert.equal(translateSql("SELECT 'a \"key\"' WHERE x = ?", 'sqlserver'), "SELECT 'a \"key\"' WHERE x = @p1");
});

test('sqlite and postgres keep double-quoted identifiers', () => {
    const sql = 'SELECT "key", value FROM document_store WHERE "key" = ?';
    assert.equal(translateSql(sql, 'sqlite'), sql);
    assert.equal(translateSql(sql, 'postgres'), 'SELECT "key", value FROM document_store WHERE "key" = $1');
});

test('the mysql driver sends every get/all/run (and transaction) query through translateSql', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../services/db/drivers/mysqlDriver.js'), 'utf8');
    assert.equal((src.match(/translateSql\(sql, 'mariadb'\)/g) || []).length, 6);
});
