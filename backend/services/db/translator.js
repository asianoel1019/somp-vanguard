/**
 * SQL Dialect Translator
 * Handles placeholder translation (?, $1, @p1) and pagination/upsert syntax differences.
 */

/**
 * Replaces ? placeholders with makePlaceholder(n), skipping ? inside
 * '...' literals ('' escapes), "..." identifiers, -- and /* *\/ comments,
 * and (for MSSQL) [bracket] identifiers.
 */
function replacePlaceholders(sql, makePlaceholder, { brackets = false } = {}) {
    let out = '';
    let idx = 1;
    let i = 0;
    const copyUntil = (end) => { out += sql.slice(i, end); i = end; };

    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === '?') {
            out += makePlaceholder(idx++);
            i++;
        } else if (ch === "'" || ch === '"') {
            // Quoted literal / identifier; a doubled quote is an escaped quote
            let j = i + 1;
            for (;;) {
                const close = sql.indexOf(ch, j);
                if (close === -1) { j = sql.length; break; }
                if (sql[close + 1] === ch) { j = close + 2; continue; }
                j = close + 1;
                break;
            }
            copyUntil(j);
        } else if (brackets && ch === '[') {
            const close = sql.indexOf(']', i + 1);
            copyUntil(close === -1 ? sql.length : close + 1);
        } else if (ch === '-' && next === '-') {
            const eol = sql.indexOf('\n', i + 2);
            copyUntil(eol === -1 ? sql.length : eol);
        } else if (ch === '/' && next === '*') {
            const close = sql.indexOf('*/', i + 2);
            copyUntil(close === -1 ? sql.length : close + 2);
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

/**
 * Converts simple double-quoted identifiers ("name") to open+name+close, leaving '...' literals (with '' escapes),
 * comments and complex "..." identifiers untouched. MariaDB/MySQL (without ANSI_QUOTES) read "key" as a string
 * literal and MSSQL treats key as a reserved word, so shared SQL is written ANSI-style and converted per dialect.
 */
function convertQuotedIdentifiers(sql, open, close) {
    const simple = /^"([A-Za-z_][A-Za-z0-9_]*)"/;
    let out = '';
    let i = 0;
    const copyUntil = (end) => { out += sql.slice(i, end); i = end; };
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === "'") {
            let j = i + 1;
            for (;;) {
                const c = sql.indexOf("'", j);
                if (c === -1) { j = sql.length; break; }
                if (sql[c + 1] === "'") { j = c + 2; continue; }
                j = c + 1;
                break;
            }
            copyUntil(j);
        } else if (ch === '"') {
            const m = simple.exec(sql.slice(i));
            if (m) {
                out += open + m[1] + close;
                i += m[0].length;
            } else {
                let j = i + 1;
                for (;;) {
                    const c = sql.indexOf('"', j);
                    if (c === -1) { j = sql.length; break; }
                    if (sql[c + 1] === '"') { j = c + 2; continue; }
                    j = c + 1;
                    break;
                }
                copyUntil(j);
            }
        } else if (ch === '-' && next === '-') {
            const eol = sql.indexOf('\n', i + 2);
            copyUntil(eol === -1 ? sql.length : eol);
        } else if (ch === '/' && next === '*') {
            const c = sql.indexOf('*/', i + 2);
            copyUntil(c === -1 ? sql.length : c + 2);
        } else if (open === '[' && ch === '[') {
            const c = sql.indexOf(']', i + 1);
            copyUntil(c === -1 ? sql.length : c + 1);
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

function translateSql(sql, dbType = 'sqlite') {
    if (!sql || typeof sql !== 'string') return sql;
    const type = String(dbType).toLowerCase().trim();

    if (type === 'postgres' || type === 'pg' || type === 'postgresql') {
        // Convert ? to $1, $2, $3...
        return replacePlaceholders(sql, (n) => `$${n}`);
    }

    if (type === 'mssql' || type === 'sqlserver') {
        // Convert ? to @p1, @p2, @p3...
        let translated = convertQuotedIdentifiers(replacePlaceholders(sql, (n) => `@p${n}`, { brackets: true }), '[', ']');

        // Translate LIMIT x OFFSET y -> OFFSET y ROWS FETCH NEXT x ROWS ONLY
        // MSSQL requires an ORDER BY clause with OFFSET-FETCH
        const limitOffsetRegex = /LIMIT\s+(\d+|\@p\d+)\s+OFFSET\s+(\d+|\@p\d+)/i;
        const matchLO = translated.match(limitOffsetRegex);
        if (matchLO) {
            const limitVal = matchLO[1];
            const offsetVal = matchLO[2];
            translated = translated.replace(limitOffsetRegex, `OFFSET ${offsetVal} ROWS FETCH NEXT ${limitVal} ROWS ONLY`);
        } else {
            const limitRegex = /LIMIT\s+(\d+|\@p\d+)/i;
            const matchL = translated.match(limitRegex);
            if (matchL) {
                const limitVal = matchL[1];
                translated = translated.replace(limitRegex, `OFFSET 0 ROWS FETCH NEXT ${limitVal} ROWS ONLY`);
            }
        }
        return translated;
    }

    if (type === 'mariadb' || type === 'mysql') {
        // Placeholders stay ?, identifiers become backticks
        return convertQuotedIdentifiers(sql, '`', '`');
    }

    // SQLite: unchanged
    return sql;
}

/**
 * Builds dialect-compatible Upsert SQL statement.
 * @param {string} table Table name
 * @param {Object} data Key-value data object
 * @param {string[]} conflictKeys Primary/Unique conflict keys
 * @param {string} dbType Database type ('sqlite', 'postgres', 'mariadb', 'mssql')
 */
function buildUpsertSql(table, data, conflictKeys = ['id'], dbType = 'sqlite') {
    const type = String(dbType).toLowerCase().trim();
    const columns = Object.keys(data);
    const updateCols = columns.filter(c => !conflictKeys.includes(c));

    if (type === 'postgres' || type === 'pg' || type === 'postgresql') {
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const setClause = updateCols.length > 0 
            ? updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')
            : 'NOTHING';
        
        const conflictClause = updateCols.length > 0
            ? `ON CONFLICT (${conflictKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET ${setClause}`
            : `ON CONFLICT (${conflictKeys.map(k => `"${k}"`).join(', ')}) DO NOTHING`;

        return {
            sql: `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')}) ${conflictClause}`,
            values: Object.values(data)
        };
    }

    if (type === 'mariadb' || type === 'mysql') {
        const placeholders = columns.map(() => '?');
        const setClause = updateCols.length > 0
            ? updateCols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')
            : columns.map(c => `\`${c}\` = \`${c}\``).join(', '); // no-op

        return {
            sql: `INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders.join(', ')}) ON DUPLICATE KEY UPDATE ${setClause}`,
            values: Object.values(data)
        };
    }

    if (type === 'mssql' || type === 'sqlserver') {
        // Use MERGE statement for MSSQL
        let pIdx = 1;
        const valParams = columns.map(() => `@p${pIdx++}`);
        const onConditions = conflictKeys.map(k => `target.[${k}] = source.[${k}]`).join(' AND ');
        const setClause = updateCols.map(c => `target.[${c}] = source.[${c}]`).join(', ');

        const sql = `
            MERGE INTO [${table}] WITH (HOLDLOCK) AS target
            USING (VALUES (${valParams.join(', ')})) AS source (${columns.map(c => `[${c}]`).join(', ')})
            ON ${onConditions}
            WHEN MATCHED THEN
                UPDATE SET ${setClause || 'target.[id] = target.[id]'}
            WHEN NOT MATCHED THEN
                INSERT (${columns.map(c => `[${c}]`).join(', ')}) VALUES (${columns.map(c => `source.[${c}]`).join(', ')});
        `;
        return {
            sql,
            values: Object.values(data)
        };
    }

    // Default SQLite (UPSERT via ON CONFLICT)
    const placeholders = columns.map(() => '?');
    const setClause = updateCols.length > 0
        ? updateCols.map(c => `"${c}" = excluded."${c}"`).join(', ')
        : 'NOTHING';
    
    const conflictClause = updateCols.length > 0
        ? `ON CONFLICT(${conflictKeys.map(k => `"${k}"`).join(',')}) DO UPDATE SET ${setClause}`
        : `ON CONFLICT(${conflictKeys.map(k => `"${k}"`).join(',')}) DO NOTHING`;

    return {
        sql: `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${placeholders.join(',')}) ${conflictClause}`,
        values: Object.values(data)
    };
}

module.exports = {
    translateSql,
    buildUpsertSql
};
