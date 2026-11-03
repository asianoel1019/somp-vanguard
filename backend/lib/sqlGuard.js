// Read-only guard and result masking for the SQL Terminal.
// The scan follows each engine's own quoting and comment rules, so text the check skips is text the server also treats as
// a literal or a comment. The guard is defense in depth: the real boundary is a read-only account on the database side.

// Quoted identifiers come out of the scan as Q_<name> so keyword checks skip them while column lookups still see them
const IDENT_PREFIX = 'Q_';
const identToken = (content) => ` ${IDENT_PREFIX}${String(content).replace(/\W/g, '_')} `;

/**
 * Strip comments and string literals from a query, following the engine's lexical rules.
 * @returns {{ code: string, versionedComment: boolean }} code keeps every executable character (literals become spaces)
 */
function scanSql(query, engine) {
    const isMySql = engine === 'MySQL';
    const nestedComments = engine === 'PostgreSQL' || engine === 'SQLServer';
    const bracketIdents = engine === 'SQLServer' || engine === 'SQLite';
    const backtickIdents = engine === 'MySQL' || engine === 'SQLite';
    const s = String(query);
    let code = '';
    let versionedComment = false;
    let i = 0;

    const readQuoted = (quote, backslashEscapes) => {
        let j = i + 1;
        let content = '';
        while (j < s.length) {
            const ch = s[j];
            if (backslashEscapes && ch === '\\') { content += s.slice(j, j + 2); j += 2; continue; }
            if (ch === quote) {
                if (s[j + 1] === quote) { content += quote; j += 2; continue; }
                return { end: j + 1, content };
            }
            content += ch;
            j++;
        }
        return { end: s.length, content };
    };

    while (i < s.length) {
        const ch = s[i];
        const next = s[i + 1];

        if (ch === '-' && next === '-' && (!isMySql || i + 2 >= s.length || /[\s\x00-\x1f]/.test(s[i + 2]))) {
            const nl = s.indexOf('\n', i);
            i = nl === -1 ? s.length : nl;
            code += ' ';
            continue;
        }
        if (ch === '#' && isMySql) {
            const nl = s.indexOf('\n', i);
            i = nl === -1 ? s.length : nl;
            code += ' ';
            continue;
        }
        if (ch === '/' && next === '*') {
            if (isMySql && (s[i + 2] === '!' || (s[i + 2] === 'M' && s[i + 3] === '!'))) versionedComment = true;
            let depth = 1;
            let j = i + 2;
            while (j < s.length && depth > 0) {
                if (nestedComments && s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; continue; }
                if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; continue; }
                j++;
            }
            i = depth > 0 ? s.length : j;
            code += ' ';
            continue;
        }
        if (ch === "'") {
            const prev = s[i - 1];
            const escapeString = engine === 'PostgreSQL' && (prev === 'E' || prev === 'e') && !/\w/.test(s[i - 2] || '');
            i = readQuoted("'", isMySql || escapeString).end;
            code += ' ';
            continue;
        }
        if (ch === '"') {
            const r = readQuoted('"', isMySql);
            i = r.end;
            code += isMySql ? ' ' : identToken(r.content);
            continue;
        }
        if (ch === '`' && backtickIdents) {
            const r = readQuoted('`', false);
            i = r.end;
            code += identToken(r.content);
            continue;
        }
        if (ch === '[' && bracketIdents) {
            const r = readQuoted(']', false);
            i = r.end;
            code += identToken(r.content);
            continue;
        }
        if (ch === '$' && engine === 'PostgreSQL' && !/[\w$]/.test(s[i - 1] || '')) {
            const tag = s.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
            if (tag) {
                const close = s.indexOf(tag[0], i + tag[0].length);
                i = close === -1 ? s.length : close + tag[0].length;
                code += ' ';
                continue;
            }
        }
        code += ch;
        i++;
    }
    return { code, versionedComment };
}

const LEADING_KEYWORDS = {
    MySQL: ['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC'],
    PostgreSQL: ['SELECT', 'WITH', 'SHOW', 'EXPLAIN'],
    SQLServer: ['SELECT', 'WITH'],
    SQLite: ['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA'],
};

const BLOCKED_KEYWORDS = [
    'DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE',
    'CREATE', 'RENAME', 'MERGE', 'CALL', 'INTO', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'LOCK', 'UNLOCK', 'COPY',
];
// T-SQL runs a whole batch and needs no ';' between statements, so statement keywords are blocked anywhere
const BLOCKED_KEYWORDS_SQLSERVER = [
    'SHUTDOWN', 'KILL', 'BACKUP', 'RESTORE', 'DBCC', 'USE', 'WAITFOR', 'DECLARE', 'SET', 'IF', 'WHILE', 'GOTO',
    'PRINT', 'RAISERROR', 'THROW', 'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY', 'OPENXML', 'BULK', 'DENY',
    'RECONFIGURE', 'CHECKPOINT', 'BEGIN', 'SAVE', 'SETUSER', 'REVERT', 'WRITETEXT', 'UPDATETEXT', 'READTEXT',
];
// Functions with side effects (or that run a query passed as a string) that a read-only transaction does not stop
const BLOCKED_FUNCTIONS = /\b(SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|PG_SLEEP\w*|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_PROMOTE|PG_READ_\w+|PG_LS_\w+|PG_STAT_RESET\w*|PG_SWITCH_\w+|PG_CREATE_\w+|PG_DROP_\w+|PG_FILE_\w+|PG_LOGICAL_\w+|PG_NOTIFY|PG_ADVISORY\w*|PG_TRY_ADVISORY\w*|PG_REPLICATION_\w+|LO_\w+|DBLINK\w*|SET_CONFIG|QUERY_TO_XML\w*|CURSOR_TO_XML\w*|LOAD_EXTENSION|READFILE|WRITEFILE|EDIT|FTS3_TOKENIZER)\s*\(/;

/**
 * Decide whether a query may run in the SQL Terminal.
 * @returns {{ ok: true, code: string, leading: string } | { ok: false, error: string, word?: string }}
 */
function validateReadOnlyQuery(query, engine) {
    if (typeof query !== 'string' || !query.trim()) return { ok: false, error: 'Query is empty.' };
    if (engine === 'MySQL' && /\/\*M?!/.test(query)) {
        return { ok: false, word: '/*!', error: 'SECURITY POLICY: MySQL executable comments (/*! ... */) are not allowed.' };
    }
    if (engine === 'MySQL' && /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(query)) {
        return { ok: false, word: 'INTO OUTFILE', error: 'SECURITY POLICY: Writing query results to files is not allowed.' };
    }
    const { code, versionedComment } = scanSql(query, engine);
    if (versionedComment) {
        return { ok: false, word: '/*!', error: 'SECURITY POLICY: MySQL executable comments (/*! ... */) are not allowed.' };
    }
    const body = code.replace(/[\s;]+$/, '').trim();
    if (!body) return { ok: false, error: 'Query is empty.' };
    if (body.includes(';')) {
        return { ok: false, word: ';', error: 'SECURITY POLICY: Only one statement per execution is allowed.' };
    }
    const upper = body.toUpperCase();
    const leading = (upper.match(/^[\s(]*([A-Z]+)/) || [])[1] || '';
    const allowed = LEADING_KEYWORDS[engine] || ['SELECT', 'WITH'];
    if (!allowed.includes(leading)) {
        return { ok: false, word: leading || body.slice(0, 20), error: `SECURITY POLICY: Only read-only queries (${allowed.join(', ')}) are permitted in the Web Terminal.` };
    }
    const keywords = engine === 'SQLServer' ? BLOCKED_KEYWORDS.concat(BLOCKED_KEYWORDS_SQLSERVER) : BLOCKED_KEYWORDS;
    for (const word of keywords) {
        if (new RegExp(`\\b${word}\\b`).test(upper)) {
            return { ok: false, word, error: `SECURITY POLICY: The '${word}' command is blocked in the Web Terminal for safety reasons. Only SELECT queries are permitted.` };
        }
    }
    const fn = upper.match(BLOCKED_FUNCTIONS);
    if (fn) {
        return { ok: false, word: fn[1], error: `SECURITY POLICY: The function '${fn[1]}' is blocked in the Web Terminal.` };
    }
    return { ok: true, code: body, leading };
}

const SENSITIVE_PATTERN = /(email|mail|phone|mobile|tel|id_card|ssn|identity|pwd|password|token|secret|credential|salary|card_no|credit)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TW_ID_VALUE = /^[A-Z][12]\d{8}$/i;
const MOBILE_VALUE = /^09\d{8}$/;
const LIST_END = new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'INTO', 'WINDOW', 'OFFSET', 'FETCH']);

const normName = (name) => String(name).replace(/^Q_/, '').replace(/\W/g, '_').toLowerCase();

/**
 * Output names of select-list items built from a sensitive column, e.g. `password AS p`, `password p`, `p = password`.
 * Every SELECT in the query is inspected, so aliases inside subqueries and CTEs count too.
 */
function sensitiveAliases(code) {
    const aliases = new Set();
    const re = /\bSELECT\b/gi;
    let m;
    while ((m = re.exec(code))) {
        let depth = 0;
        let item = '';
        const items = [];
        let i = m.index + m[0].length;
        for (; i < code.length; i++) {
            const ch = code[i];
            if (ch === '(') depth++;
            if (ch === ')') { if (depth === 0) break; depth--; }
            if (depth === 0 && ch === ',') { items.push(item); item = ''; continue; }
            if (depth === 0 && /\s/.test(ch)) {
                const word = (code.slice(i + 1).match(/^[A-Za-z_]+/) || [''])[0].toUpperCase();
                if (LIST_END.has(word)) break;
            }
            item += ch;
        }
        items.push(item);
        for (const raw of items) {
            if (!SENSITIVE_PATTERN.test(raw)) continue;
            const assign = raw.match(/^\s*([A-Za-z_][\w$]*)\s*=(?!=)/);
            const trailing = raw.match(/([A-Za-z_][\w$]*)\s*$/);
            const name = assign ? assign[1] : trailing && trailing[1];
            if (name) aliases.add(normName(name));
        }
    }
    return aliases;
}

function maskValue(str) {
    if (/@/.test(str)) {
        const at = str.indexOf('@');
        const prefix = str.slice(0, at);
        const maskedPrefix = prefix.length > 2 ? prefix[0] + '***' + prefix[prefix.length - 1] : '***';
        return `${maskedPrefix}@${str.slice(at + 1)}`;
    }
    if (/^\d{7,15}$/.test(str)) return str.slice(0, 3) + '****' + str.slice(-2);
    if (/^[A-Z]\d{9}$/i.test(str)) return str.slice(0, 3) + '****' + str.slice(-3);
    return '******';
}

/**
 * Mask sensitive data in query results: columns named like sensitive data, aliases of sensitive columns,
 * and individual values shaped like an email, a Taiwan ID or a mobile number.
 * @returns {{ rows: object[], maskedColumns: string[] }}
 */
function maskSensitiveRows(rows, query, engine) {
    if (!Array.isArray(rows) || rows.length === 0) return { rows: rows || [], maskedColumns: [] };
    const keys = Object.keys(rows[0]);
    const aliases = sensitiveAliases(scanSql(query, engine).code);
    const byName = new Set(keys.filter(k => SENSITIVE_PATTERN.test(k) || aliases.has(normName(k))));
    const byValue = new Set();
    const masked = rows.map(r => {
        const cloned = { ...r };
        for (const k of keys) {
            const val = cloned[k];
            if (val === null || val === undefined) continue;
            if (byName.has(k)) { cloned[k] = maskValue(String(val)); continue; }
            if (typeof val !== 'string') continue;
            if (EMAIL_VALUE.test(val) || TW_ID_VALUE.test(val) || MOBILE_VALUE.test(val)) {
                cloned[k] = maskValue(val);
                byValue.add(k);
            }
        }
        return cloned;
    });
    const maskedColumns = keys.filter(k => byName.has(k) || byValue.has(k));
    return { rows: maskedColumns.length ? masked : rows, maskedColumns };
}

module.exports = { scanSql, validateReadOnlyQuery, sensitiveAliases, maskSensitiveRows };
