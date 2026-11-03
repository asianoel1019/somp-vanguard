// Which database targets the Database pages may reach: connection field formats, SQLite file locations,
// and an optional allowlist of hosts (DB_TARGET_ALLOWLIST).
const fs = require('fs');
const net = require('net');
const path = require('path');
const dns = require('dns').promises;

const ENGINES = ['MySQL', 'PostgreSQL', 'SQLServer', 'SQLite'];
// host may carry a SQL Server named instance (host\INSTANCE); every value must start with a letter, digit or '_'
// so it can never be read as a command-line option
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._:-]*(\\[A-Za-z0-9_$-]+)?$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@$\\-]*$/;
const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.$-]*$/;

/** @returns {string|null} error message for a non-SQLite connection definition */
function validateConnectionFields({ engine, host, port, database, username } = {}) {
    if (!ENGINES.includes(engine)) return `不支援的資料庫引擎: ${engine}`;
    if (engine === 'SQLite') return null;
    if (!host || String(host).length > 253 || !HOST_RE.test(String(host))) return '主機格式不正確（只允許英數字、. _ - : 與 SQL Server 執行個體名稱）';
    if (port !== undefined && port !== null && port !== '') {
        const n = Number(port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Port 必須是 1 到 65535 的整數';
    }
    if (!username || String(username).length > 128 || !USER_RE.test(String(username))) return '使用者名稱格式不正確';
    if (database !== undefined && database !== null && database !== '' && (String(database).length > 128 || !DB_NAME_RE.test(String(database)))) {
        return '資料庫名稱格式不正確（只允許英數字與 _ . $ -）';
    }
    return null;
}

const splitList = (value) => String(value || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);

// Resolve links (and Windows 8.3 short names) through the deepest existing ancestor, so a path that does not exist yet
// compares the same way as one that does
function realPath(p) {
    let existing = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) return path.resolve(p);
        rest.unshift(path.basename(existing));
        existing = parent;
    }
    try { return path.join(fs.realpathSync.native(existing), ...rest); } catch (e) { return path.resolve(p); }
}

/** Directories SQLite connections may point into. Relative paths resolve against the first one. */
function sqliteRoots() {
    const configured = splitList(process.env.DB_SQLITE_ROOTS).map(realPath);
    return configured.length ? configured : [realPath(path.join(process.env.DB_DATA_DIR || process.cwd(), 'data'))];
}

// Vanguard's own data directories: only their data\ subfolder may hold user SQLite files
function appDataDirs() {
    const dirs = [process.env.DB_DATA_DIR, 'D:\\somp-vanguard', 'C:\\ProgramData\\somp-vanguard'].filter(Boolean).map(realPath);
    return [...new Set(dirs)];
}

function isInside(dir, file) {
    const rel = path.relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @returns {{ path: string } | { error: string }} */
function resolveSqlitePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return { error: 'SQLite 必須提供資料庫檔案路徑' };
    const roots = sqliteRoots();
    const abs = realPath(path.isAbsolute(filePath) ? filePath : path.resolve(roots[0], filePath));
    if (!roots.some(r => isInside(r, abs))) {
        return { error: `SQLite 檔案必須位於允許的目錄內（${roots.join('; ')}），可用 DB_SQLITE_ROOTS 調整` };
    }
    if (appDataDirs().some(d => isInside(d, abs) && !isInside(path.join(d, 'data'), abs))) {
        return { error: 'SQLite 檔案不可指向 Vanguard 自身的資料檔' };
    }
    return { path: abs };
}

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function inCidr(ip, cidr) {
    const [base, bitsText] = cidr.split('/');
    const bits = Number(bitsText);
    if (!net.isIPv4(ip) || !net.isIPv4(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

/**
 * With DB_TARGET_ALLOWLIST set (comma separated: exact host, *.suffix, or IPv4 CIDR), only matching hosts are reachable.
 * A CIDR entry matches when every address the name resolves to is inside it.
 * @returns {Promise<string|null>} error message
 */
async function checkHostAllowed(host) {
    const entries = splitList(process.env.DB_TARGET_ALLOWLIST).map(e => e.toLowerCase());
    if (entries.length === 0) return null;
    const h = String(host || '').toLowerCase().replace(/\\.*$/, '').replace(/^\[|\]$/g, '');
    if (!h) return '缺少連線主機';
    for (const e of entries) {
        if (e === h) return null;
        if (e.startsWith('*.') && h.endsWith(e.slice(1))) return null;
    }
    const cidrs = entries.filter(e => e.includes('/'));
    if (cidrs.length) {
        let ips = [];
        if (net.isIP(h)) ips = [h];
        else {
            try { ips = (await dns.lookup(h, { all: true })).map(a => a.address); } catch (e) { ips = []; }
        }
        if (ips.length && ips.every(ip => cidrs.some(c => inCidr(ip, c)))) return null;
    }
    return `連線目標 ${host} 不在 DB_TARGET_ALLOWLIST 允許範圍內`;
}

/**
 * Everything a stored or ad-hoc connection must satisfy before Vanguard connects to it.
 * @returns {Promise<{ error: string } | { sqlitePath?: string }>}
 */
async function checkTarget(db) {
    if (!db) return { error: 'Database not found' };
    if (db.engine === 'SQLite') {
        const r = resolveSqlitePath(db.database || db.filePath || db.host);
        return r.error ? { error: r.error } : { sqlitePath: r.path };
    }
    const fieldError = validateConnectionFields(db);
    if (fieldError) return { error: fieldError };
    const hostError = await checkHostAllowed(db.host);
    return hostError ? { error: hostError } : {};
}

module.exports = { ENGINES, validateConnectionFields, sqliteRoots, resolveSqlitePath, checkHostAllowed, checkTarget, inCidr };
