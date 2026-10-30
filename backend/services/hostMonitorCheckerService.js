const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { readDataSync, writeDataSync, db, getDataDir } = require('../lib/db');
const { queryCmdbServers, readDeletedMeta } = require('./cmdbModel');
const envRegistry = require('../lib/environmentRegistry');

// Environments ignored when the setting was never saved (DEV / SIT used to be hidden by a hard-coded filter)
const DEFAULT_IGNORED_ENVS = ['DEV', 'SIT'];

/** Name used when nothing better is known: the isDefault environment (never a hard-coded 'TRUST'). */
function fallbackEnvName() {
    const def = envRegistry.getDefaultEnv();
    return def ? def.name : envRegistry.UNASSIGNED;
}

/** Default ignoredEnvs: the ids of global environments named DEV / SIT (names kept when not in the list). */
function defaultIgnoredEnvs() {
    const envs = envRegistry.getEnvironments();
    return DEFAULT_IGNORED_ENVS.map(n => { const e = envRegistry.resolveEnv(n, envs); return e ? e.id : n; });
}

const CONFIG_KEY = 'server_operation/hm_checker_config.json';
const CACHE_KEY = 'server_operation/hm_checker_today_cache.json';

const DEFAULT_FILE_PATTERN = 'hostmonitor-item-backup-*.txt';
const DEFAULT_SCAN_TIMEOUT_SEC = 20;
const MIN_SCAN_TIMEOUT_SEC = 5;
const MAX_SCAN_TIMEOUT_SEC = 120;
const MAX_SCAN_DEPTH = 4;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_NAME_LENGTH = 128;
const UPLOAD_DIR_NAME = 'hm_checker_uploads';
const PARSE_CACHE_MAX = 3;
const MAX_PATTERN_STARS = 8;
const SCAN_CACHE_MS = 10000;

// Test seams (never set in production): inject a fake fs.promises, a short scan timeout, a scan-cache TTL
const _testHooks = { fsp: null, timeoutMs: null, scanCacheMs: null };

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/**
 * Get OS local date string (YYYY-MM-DD) to prevent timezone drift
 */
function getTodayLocalDateStr() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function cleanPath(p) {
    return String(p || '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Get persistent HM_checker configuration (always fully populated with defaults)
 */
function getConfig() {
    const stored = readDataSync(CONFIG_KEY, null);
    const raw = stored && typeof stored === 'object' ? stored : {};
    const timeout = Number(raw.scanTimeoutSec);
    return {
        uncPath: typeof raw.uncPath === 'string' ? raw.uncPath : '',
        // entries are environment ids (or names / codes, matched case-insensitively); never saved -> DEV / SIT
        ignoredEnvs: Array.isArray(raw.ignoredEnvs) ? raw.ignoredEnvs : defaultIgnoredEnvs(),
        scanTimeoutSec: Number.isInteger(timeout) && timeout >= MIN_SCAN_TIMEOUT_SEC && timeout <= MAX_SCAN_TIMEOUT_SEC
            ? timeout : DEFAULT_SCAN_TIMEOUT_SEC,
        filePattern: typeof raw.filePattern === 'string' && raw.filePattern.trim() ? raw.filePattern.trim() : DEFAULT_FILE_PATTERN
    };
}

/**
 * Save persistent HM_checker configuration (undefined fields are ignored)
 */
function saveConfig(updates = {}) {
    const merged = getConfig();
    for (const [k, v] of Object.entries(updates || {})) {
        if (v !== undefined) merged[k] = v;
    }
    writeDataSync(CONFIG_KEY, merged);
    return merged;
}

/**
 * Validate the body of POST /config. Returns { ok, value } (only the supplied fields) or { ok:false, error }.
 */
function validateConfigInput(body) {
    const b = body && typeof body === 'object' ? body : {};
    const value = {};

    if (b.uncPath !== undefined) {
        if (typeof b.uncPath !== 'string') return { ok: false, error: 'uncPath 必須為字串' };
        const p = b.uncPath.trim();
        if (p.length > 1024) return { ok: false, error: 'uncPath 長度不得超過 1024 字元' };
        value.uncPath = p;
    }
    if (b.ignoredEnvs !== undefined) {
        if (!Array.isArray(b.ignoredEnvs)) return { ok: false, error: 'ignoredEnvs 必須為陣列' };
        if (b.ignoredEnvs.length > 100) return { ok: false, error: 'ignoredEnvs 最多 100 筆' };
        const out = [];
        for (const e of b.ignoredEnvs) {
            if (typeof e !== 'string') return { ok: false, error: 'ignoredEnvs 內容必須為字串' };
            const t = e.trim();
            if (t.length > 100) return { ok: false, error: 'ignoredEnvs 單筆長度不得超過 100 字元' };
            if (t && !out.includes(t)) out.push(t);
        }
        value.ignoredEnvs = out;
    }
    if (b.scanTimeoutSec !== undefined) {
        const n = typeof b.scanTimeoutSec === 'string' && b.scanTimeoutSec.trim() !== '' ? Number(b.scanTimeoutSec) : b.scanTimeoutSec;
        if (!Number.isInteger(n) || n < MIN_SCAN_TIMEOUT_SEC || n > MAX_SCAN_TIMEOUT_SEC) {
            return { ok: false, error: `scanTimeoutSec 必須為 ${MIN_SCAN_TIMEOUT_SEC} 到 ${MAX_SCAN_TIMEOUT_SEC} 之間的整數` };
        }
        value.scanTimeoutSec = n;
    }
    if (b.filePattern !== undefined) {
        if (typeof b.filePattern !== 'string') return { ok: false, error: 'filePattern 必須為字串' };
        const p = b.filePattern.trim();
        if (p.length > 128) return { ok: false, error: 'filePattern 長度不得超過 128 字元' };
        if (!/^[A-Za-z0-9._ \-*()\[\]#@+&,=~%]*$/.test(p)) return { ok: false, error: 'filePattern 只允許英數字、空白、. _ - ( ) [ ] # @ + & , = ~ % 與 * 萬用字元' };
        if ((p.match(/\*/g) || []).length > MAX_PATTERN_STARS) return { ok: false, error: `filePattern 最多只能包含 ${MAX_PATTERN_STARS} 個 *` };
        value.filePattern = p || DEFAULT_FILE_PATTERN;
    }
    return { ok: true, value };
}

/**
 * Compile a file name glob (only * is a wildcard) to a case-insensitive matcher function.
 * Linear-time two-pointer matching (no regex, so no catastrophic backtracking); repeated * are collapsed.
 */
function patternToMatcher(pattern) {
    const p = String(pattern || DEFAULT_FILE_PATTERN).toLowerCase().replace(/\*+/g, '*');
    return (name) => {
        const s = String(name).toLowerCase();
        let pi = 0, si = 0, star = -1, mark = 0;
        while (si < s.length) {
            if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; }
            else if (pi < p.length && p[pi] === s[si]) { pi++; si++; }
            else if (star !== -1) { pi = star + 1; si = ++mark; }
            else return false;
        }
        while (pi < p.length && p[pi] === '*') pi++;
        return pi === p.length;
    };
}

/**
 * Extract date info from a file name if formatted like YYYY-MM-DD, YYYYMMDD, YYYY_MM_DD, etc.
 * Digits must not be adjacent (so "_" and "-" next to the date are fine).
 */
function extractDateInfo(name) {
    if (!name || typeof name !== 'string') return null;
    // 1. Matches YYYY-MM-DD or YYYY_MM_DD or YYYY.MM.DD
    const m1 = name.match(/(?<!\d)(20\d{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?!\d)/);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

    // 2. Matches YYYYMMDD (e.g. 20261006)
    const m2 = name.match(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

    return null;
}

function describeFsError(e, dir) {
    const code = e && e.code;
    if (code === 'ENOENT') return `路徑不存在或無法存取: ${dir}`;
    if (code === 'EACCES' || code === 'EPERM') return `沒有權限存取路徑: ${dir}`;
    if (code === 'ENOTDIR') return `指定路徑不是目錄: ${dir}`;
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') return `網路無法連線: ${dir}`;
    return `${e && e.message ? e.message : e} (${dir})`;
}

function isSkippedDirName(name) {
    const lower = name.toLowerCase();
    return name.startsWith('.') || lower === '$recycle.bin' || lower === 'system volume information';
}

/**
 * Breadth-first, non-blocking scan for backup files (fs.promises only) with a hard timeout.
 * Rejects when the root cannot be read or the timeout elapses (never resolves with partial results).
 * Options: pattern, timeoutMs, maxDepth (default 4), source ('unc'|'upload'), fsp (injected fs.promises)
 */
async function scanBackupFiles(dirPath, opts = {}) {
    const root = cleanPath(dirPath);
    if (!root) throw new Error('路徑不得為空');
    const pattern = opts.pattern || DEFAULT_FILE_PATTERN;
    const timeoutMs = opts.timeoutMs || DEFAULT_SCAN_TIMEOUT_SEC * 1000;
    const maxDepth = opts.maxDepth === undefined ? MAX_SCAN_DEPTH : opts.maxDepth;
    const source = opts.source || 'unc';
    const fsp = opts.fsp || _testHooks.fsp || fs.promises;
    const matches = patternToMatcher(pattern);
    const state = { cancelled: false };

    const work = (async () => {
        const files = [];
        let level = [root];
        for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
            const next = [];
            for (const dir of level) {
                if (state.cancelled) return files;
                let entries;
                try {
                    entries = await fsp.readdir(dir, { withFileTypes: true });
                } catch (e) {
                    if (dir === root) throw new Error(describeFsError(e, root));
                    continue; // unreadable sub folder: skip it
                }
                for (const entry of entries) {
                    if (state.cancelled) return files;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (depth < maxDepth && !isSkippedDirName(entry.name)) next.push(full);
                    } else if (entry.isFile() && matches(entry.name)) {
                        try {
                            const stats = await fsp.stat(full);
                            // The date comes from the file name only (a dated parent folder must not outrank newer files)
                            const dateFromName = extractDateInfo(entry.name);
                            files.push({
                                filename: entry.name,
                                fullPath: full,
                                directory: dir,
                                size: stats.size,
                                modifiedAt: stats.mtime.toISOString(),
                                mtimeMs: stats.mtimeMs,
                                dateStr: dateFromName || stats.mtime.toISOString().split('T')[0],
                                hasExplicitDate: !!dateFromName,
                                source
                            });
                        } catch (statErr) { /* vanished between readdir and stat */ }
                    }
                }
            }
            level = next;
        }
        return files;
    })();
    work.catch(() => {});

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            state.cancelled = true;
            reject(new Error(`UNC 共享存取逾時 (${Math.round(timeoutMs / 1000)} 秒)，網路共享未回應或延遲過高: ${root}`));
        }, timeoutMs);
    });
    try {
        const files = await Promise.race([work, timeout]);
        return sortBackupFiles(files);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sort backup files so index 0 is always the latest file:
 * 1. If date in filename/path, newest date first
 * 2. If one has date and other doesn't, file with date first
 * 3. Most recently modified file (mtimeMs) descending
 * 4. Natural filename descending (numeric aware)
 */
function sortBackupFiles(files) {
    return files.sort((a, b) => {
        const dateA = a.dateStr;
        const dateB = b.dateStr;

        if (a.hasExplicitDate && b.hasExplicitDate && dateA !== dateB) {
            return dateB.localeCompare(dateA);
        }
        if (a.hasExplicitDate && !b.hasExplicitDate) return -1;
        if (!a.hasExplicitDate && b.hasExplicitDate) return 1;

        if (b.mtimeMs !== a.mtimeMs) {
            return b.mtimeMs - a.mtimeMs;
        }

        return b.filename.localeCompare(a.filename, undefined, { numeric: true, sensitivity: 'base' });
    });
}

// ---------------------------------------------------------------------------
// Uploads (private directory under the app data dir, never under docs/)
// ---------------------------------------------------------------------------

function getUploadDir() {
    return path.resolve(getDataDir(), UPLOAD_DIR_NAME);
}

// Create the upload directory once per process (memoised per path; a failure is retried next time)
const uploadDirReady = new Map();
function ensureUploadDir() {
    const dir = getUploadDir();
    if (!uploadDirReady.has(dir)) {
        const p = fs.promises.mkdir(dir, { recursive: true }).then(() => dir);
        uploadDirReady.set(dir, p);
        p.catch(() => uploadDirReady.delete(dir));
    }
    return uploadDirReady.get(dir);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Client path is ignored: only the basename is kept; [A-Za-z0-9._-], must end with .txt, max 128 chars.
 */
function sanitizeUploadFilename(name) {
    if (name === undefined || name === null || (typeof name === 'string' && name.trim() === '')) {
        return { ok: true, filename: `hostmonitor-item-backup-${getTodayLocalDateStr()}.txt` };
    }
    if (typeof name !== 'string') return { ok: false, error: '檔名格式不正確' };
    const parts = name.trim().split(/[\\/]/);
    const base = parts[parts.length - 1];
    if (!base || base.length > MAX_UPLOAD_NAME_LENGTH) return { ok: false, error: `檔名不得為空且不得超過 ${MAX_UPLOAD_NAME_LENGTH} 字元` };
    if (!/^[A-Za-z0-9._-]+\.txt$/i.test(base) || WINDOWS_RESERVED.test(base)) {
        return { ok: false, error: '檔名只允許英數字、點、底線與連字號，且副檔名必須為 .txt' };
    }
    return { ok: true, filename: base };
}

/**
 * Store an uploaded backup in the private upload dir. An existing file is never overwritten (409) unless
 * `overwrite` is true; links are never followed (exclusive create, or temp file + rename after an lstat check).
 * The name must match the configured filePattern, otherwise the file would never be picked up.
 */
async function saveUploadedBackup({ filename, content, overwrite = false } = {}) {
    const s = sanitizeUploadFilename(filename);
    if (!s.ok) throw httpError(400, s.error);
    if (typeof content !== 'string' || content.length === 0) throw httpError(400, '備份檔內容不得為空');
    if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) {
        throw httpError(413, `備份檔大小超過上限 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    const pattern = getConfig().filePattern;
    if (!patternToMatcher(pattern)(s.filename)) {
        throw httpError(400, `檔名不符合備份檔名規則 (${pattern})，請修改檔名，否則上傳後不會被使用`);
    }
    const dir = await ensureUploadDir();
    const dest = path.resolve(dir, s.filename);
    if (path.dirname(dest) !== dir) throw httpError(400, '檔案路徑不合法');
    const size = Buffer.byteLength(content, 'utf8');

    try {
        await fs.promises.writeFile(dest, content, { encoding: 'utf8', flag: 'wx' });
        return { filename: s.filename, size, directory: dir, overwritten: false };
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }
    if (!overwrite) {
        throw httpError(409, `已存在同名備份檔 ${s.filename}，請更換檔名，或明確選擇覆蓋 (overwrite)`);
    }
    const st = await fs.promises.lstat(dest);
    if (!st.isFile()) throw httpError(400, '目標不是一般檔案，拒絕覆蓋');
    const tmp = path.join(dir, `.${s.filename}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.promises.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(tmp, dest);
    } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw e;
    }
    return { filename: s.filename, size, directory: dir, overwritten: true };
}

// ---------------------------------------------------------------------------
// Backup file discovery
// ---------------------------------------------------------------------------

function effectiveTimeoutMs(config) {
    return _testHooks.timeoutMs || config.scanTimeoutSec * 1000;
}

/**
 * Find the available backup files for this request (async, one scan).
 * - UNC path configured (and the user did not pick uploads): scan it; on failure return `uncError` and NO files
 *   (never silently fall back to uploads).
 * - Otherwise: the private upload directory.
 * Returns { source, uncPath, files, uncError?, uploadError?, config }
 */
// Single-flight + short result cache per (source, path, pattern): concurrent requests (and the status + compare
// calls of one page load) share one scan, so a hung share cannot pile up abandoned fs operations.
const scanInflight = new Map();
const scanLast = new Map();

function clearScanCache() {
    scanLast.clear();
}

function scanShared(dir, opts) {
    const key = `${opts.source}|${cleanPath(dir)}|${opts.pattern}`;
    const ttl = _testHooks.scanCacheMs === null ? SCAN_CACHE_MS : _testHooks.scanCacheMs;
    const last = scanLast.get(key);
    if (ttl > 0 && last) {
        const age = Date.now() - last.at;
        if (last.error ? age < Math.max(ttl, opts.timeoutMs || 0) : age < ttl) {
            return last.error ? Promise.reject(new Error(last.error)) : Promise.resolve(last.files);
        }
    }
    if (scanInflight.has(key)) return scanInflight.get(key);
    const p = scanBackupFiles(dir, opts).then(
        (files) => { scanLast.set(key, { at: Date.now(), files }); return files; },
        (e) => { scanLast.set(key, { at: Date.now(), error: e.message }); throw e; }
    ).finally(() => { scanInflight.delete(key); });
    scanInflight.set(key, p);
    return p;
}

async function resolveBackupFiles({ backupSource } = {}) {
    const config = getConfig();
    const uncPath = cleanPath(config.uncPath);
    if (uncPath && backupSource !== 'upload') {
        try {
            const files = await scanShared(uncPath, {
                pattern: config.filePattern, timeoutMs: effectiveTimeoutMs(config), source: 'unc'
            });
            return { source: 'unc', uncPath, files, config };
        } catch (e) {
            console.warn(`[HM_checker] UNC scan failed (${uncPath}):`, e.message);
            return { source: 'unc', uncPath, files: [], uncError: e.message, config };
        }
    }
    try {
        const dir = await ensureUploadDir();
        const files = await scanBackupFiles(dir, {
            pattern: config.filePattern, timeoutMs: 10000, maxDepth: 0, source: 'upload'
        });
        return { source: 'upload', uncPath, files, config };
    } catch (e) {
        return { source: 'upload', uncPath, files: [], uploadError: e.message, config };
    }
}

/**
 * '' / 'latest' / undefined -> newest file; otherwise the file with exactly that name (and, when given, that
 * directory), or null when it is gone.
 */
function pickBackupFile(files, backupFilename, backupDirectory) {
    if (!files || files.length === 0) return null;
    if (!backupFilename || backupFilename === 'latest') return files[0];
    return files.find(f => f.filename === backupFilename && (!backupDirectory || f.directory === backupDirectory)) || null;
}

function toFileInfo(f) {
    if (!f) return null;
    return {
        filename: f.filename,
        directory: f.directory,
        modifiedAt: f.modifiedAt,
        mtimeMs: f.mtimeMs,
        size: f.size,
        source: f.source
    };
}

/**
 * Test accessibility of a UNC or local path and report the matching backup files (non-blocking, with timeout)
 */
async function testDirectoryAccessAsync(dirPath, { timeoutMs = null, pattern = null } = {}) {
    if (!dirPath || typeof dirPath !== 'string' || !cleanPath(dirPath)) {
        return { success: false, error: '路徑不得為空' };
    }
    const clean = cleanPath(dirPath);
    const config = getConfig();
    if (pattern) config.filePattern = pattern;
    const fsp = _testHooks.fsp || fs.promises;
    try {
        let stat;
        const ms = timeoutMs || effectiveTimeoutMs(config);
        let timer;
        try {
            stat = await Promise.race([
                fsp.stat(clean),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`UNC 共享存取逾時 (${Math.round(ms / 1000)} 秒)，網路共享未回應或延遲過高: ${clean}`)), ms); })
            ]);
        } catch (err) {
            return { success: false, error: /逾時/.test(err.message) ? err.message : describeFsError(err, clean) };
        } finally {
            clearTimeout(timer);
        }
        if (!stat.isDirectory()) {
            return { success: false, error: `指定路徑不是目錄: ${clean}` };
        }
        const files = await scanBackupFiles(clean, { pattern: config.filePattern, timeoutMs: ms, source: 'unc' });
        return {
            success: true,
            totalFiles: files.length,
            backupFilesFound: files.length,
            filePattern: config.filePattern,
            latestBackupFile: files[0]?.filename || null,
            latestBackupFullPath: files[0]?.fullPath || null,
            latestBackupModifiedAt: files[0]?.modifiedAt || null
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ---------------------------------------------------------------------------
// Today cache (an optimisation only: valid for the exact same latest file + same ignoredEnvs)
// ---------------------------------------------------------------------------

function normalizeEnvs(list) {
    return Array.from(new Set((Array.isArray(list) ? list : []).map(e => String(e).trim().toUpperCase()).filter(Boolean))).sort();
}

/**
 * Today's cached CMDB comparison, or null when it was not computed from `latestFile` (same name, directory, mtime,
 * size and source) with the same ignored environments. `latestFile` must come from the SAME request's async scan.
 */
function getTodayCache(latestFile, ignoredEnvs = []) {
    if (!latestFile) return null;
    const cache = readDataSync(CACHE_KEY, null);
    if (!cache || typeof cache !== 'object') return null;
    if (cache.dateStr !== getTodayLocalDateStr()) return null;
    if (cache.source !== 'cmdb') return null;
    const cf = cache.file;
    if (!cf) return null;
    if (cf.filename !== latestFile.filename || cf.directory !== latestFile.directory ||
        cf.mtimeMs !== latestFile.mtimeMs || cf.size !== latestFile.size || cf.source !== latestFile.source) {
        return null;
    }
    if (JSON.stringify(normalizeEnvs(cache.ignoredEnvs)) !== JSON.stringify(normalizeEnvs(ignoredEnvs))) return null;
    // Caches written before results carried the OS family are recomputed
    if (!Array.isArray(cache.results) || cache.results.some(r => !r || !('osFamily' in r))) return null;
    return cache;
}

function saveTodayCache(comparisonResult) {
    const cachePayload = {
        dateStr: getTodayLocalDateStr(),
        cachedAt: new Date().toISOString(),
        summary: comparisonResult.summary,
        results: comparisonResult.results,
        backupFile: comparisonResult.backupFile,
        backupMeta: comparisonResult.backupMeta,
        source: comparisonResult.source,
        file: toFileInfo(comparisonResult.file),
        ignoredEnvs: normalizeEnvs(comparisonResult.ignoredEnvs)
    };
    writeDataSync(CACHE_KEY, cachePayload);
    return cachePayload;
}

function clearTodayCache() {
    writeDataSync(CACHE_KEY, null);
}

/**
 * Get all actual environments defined in the system and CMDB
 */
function getActualEnvironments() {
    // The global Environments list is the only source (DEV / SIT are no longer filtered here:
    // they are excluded from the comparison through the ignoredEnvs default instead)
    return envRegistry.getEnvironments().map(e => e.name).sort((a, b) => a.localeCompare(b));
}

/** Global entries for the UI: [{ id, name, isProduction, isDefault }] */
function getEnvironmentOptions() {
    return envRegistry.getEnvironments().map(e => ({ id: e.id, name: e.name, isProduction: !!e.isProduction, isDefault: !!e.isDefault }));
}

/** Splits ignoredEnvs entries into resolved ids and upper-cased raw names (case-insensitive matching). */
function ignoredEnvMatcher(ignoredEnvs) {
    const envs = envRegistry.getEnvironments();
    const ids = new Set();
    const names = new Set();
    for (const raw of (ignoredEnvs || [])) {
        const t = String(raw).trim();
        if (!t) continue;
        const env = envRegistry.resolveEnv(t, envs);
        if (env) { ids.add(env.id); names.add(env.name.toUpperCase()); }
        else names.add(t.toUpperCase());
    }
    return (server) => {
        if (server.envId && ids.has(String(server.envId))) return true;
        const env = String(server.envName || server.env || server.envId || 'UNKNOWN').trim().toUpperCase();
        return names.has(env);
    };
}


// ---------------------------------------------------------------------------
// Parsed file cache: at most PARSE_CACHE_MAX parsed files (LRU), keyed by path + mtime + size
// ---------------------------------------------------------------------------
const parseCache = new Map();

function clearParseCache() {
    parseCache.clear();
}

function _parseCacheKeys() {
    return Array.from(parseCache.keys());
}

async function getOrParseFile(file, { parse = parseHostMonitorFile, timeoutMs } = {}) {
    const key = `${file.fullPath}|${file.mtimeMs}|${file.size}`;
    if (parseCache.has(key)) {
        const hit = parseCache.get(key);
        parseCache.delete(key);
        parseCache.set(key, hit); // refresh recency
        return hit;
    }
    // The parse shares the scan timeout; a timed-out or failed parse is evicted, never cached
    const ms = timeoutMs || effectiveTimeoutMs(getConfig());
    const ac = new AbortController();
    let timer;
    const parsing = Promise.resolve().then(() => parse(file.fullPath, { signal: ac.signal }));
    parsing.catch(() => {});
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            ac.abort();
            reject(httpError(504, `讀取備份檔逾時 (${Math.round(ms / 1000)} 秒)，網路共享未回應或延遲過高: ${file.fullPath}`));
        }, ms);
    });
    const pending = Promise.race([parsing, timeout]).finally(() => clearTimeout(timer));
    parseCache.set(key, pending);
    pending.catch(() => { if (parseCache.get(key) === pending) parseCache.delete(key); });
    while (parseCache.size > PARSE_CACHE_MAX) {
        parseCache.delete(parseCache.keys().next().value);
    }
    return pending;
}

/**
 * Parse a HostMonitor export/backup file (.txt)
 */
async function parseHostMonitorFile(filePath, { signal } = {}) {
    try {
        await fs.promises.stat(filePath);
    } catch (e) {
        throw new Error(`HostMonitor backup file not found: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath);
    if (signal) {
        if (signal.aborted) fileStream.destroy();
        else signal.addEventListener('abort', () => fileStream.destroy(), { once: true });
    }
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const tests = [];
    const folders = new Set();
    let currentFolder = '';
    let currentTest = null;
    let headerMeta = { generatedAt: '', version: '', sourceFile: '' };

    try {
        for await (const line of rl) {
            const trimmed = line.trim();

            // Header comments parsing
            if (line.includes('Generated by HostMonitor')) {
                const m = line.match(/HostMonitor\s+([0-9.]+)\s+at\s+([^-\r\n]+)/i);
                if (m) {
                    headerMeta.version = m[1].trim();
                    headerMeta.generatedAt = m[2].trim();
                }
            }
            if (line.includes('Source file:')) {
                const m = line.match(/Source file:\s*([^-\r\n]+)/i);
                if (m) headerMeta.sourceFile = m[1].trim();
            }

            // Folder directive
            const folderMatch = line.match(/^DefaultFolder\s*=\s*(.*)/i);
            if (folderMatch) {
                currentFolder = folderMatch[1].trim();
                folders.add(currentFolder);
                continue;
            }

            // Test boundary
            if (line.match(/^;\s*-------\s*Test\s*#/i)) {
                if (currentTest && currentTest.Method) {
                    tests.push(currentTest);
                }
                currentTest = { folder: currentFolder };
                continue;
            }

            // Key = Value
            if (currentTest && !trimmed.startsWith(';')) {
                const m = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.*)/);
                if (m) {
                    const key = m[1].trim();
                    const val = m[2].trim();
                    currentTest[key] = val;
                }
            }
        }
    } finally {
        fileStream.destroy();
    }

    if (currentTest && currentTest.Method) {
        tests.push(currentTest);
    }

    return {
        headerMeta,
        totalTests: tests.length,
        totalFolders: folders.size,
        tests
    };
}

/**
 * CMDB servers to compare: not decommissioned and not flagged deleted in the CMDB meta (fresh read per call).
 * No query limit is passed (queryCmdbServers caps any limit at 1000 rows).
 */
/**
 * OS family from the CMDB os text: 'windows' | 'linux' | 'unknown'. Windows and Linux hosts are monitored with
 * different HostMonitor methods, so anything not clearly one of them stays 'unknown' (no CPU/MEM/Disk generated).
 */
const LINUX_OS_PATTERN = /linux|centos|rhel|red\s*hat|ubuntu|debian|suse|sles|rocky|alma|fedora|oracle\s*(linux|el)|amzn|amazon/i;
function resolveOsFamily(os) {
    const text = String(os || '').trim();
    if (!text) return 'unknown';
    if (/win/i.test(text)) return 'windows';
    if (LINUX_OS_PATTERN.test(text)) return 'linux';
    return 'unknown';
}

/**
 * Fill os / osFamily from the CMDB (matched by IP). The CMDB value wins over anything supplied by the client;
 * servers not in the CMDB keep their own os text (if any).
 */
function attachCmdbOs(servers, deps = {}) {
    const queryCmdb = deps.queryCmdb || queryCmdbServers;
    const byIp = new Map();
    for (const s of ((queryCmdb({}) || {}).servers || [])) {
        const ip = String(s.ip || '').trim();
        if (ip && s.os && !byIp.has(ip)) byIp.set(ip, String(s.os));
    }
    return (Array.isArray(servers) ? servers : []).map(s => {
        const os = byIp.get(String(s.ip || '').trim()) || (typeof s.os === 'string' ? s.os : '');
        return { ...s, os, osFamily: resolveOsFamily(os) };
    });
}

function loadCmdbServers(envFilter, deps = {}) {
    const queryCmdb = deps.queryCmdb || queryCmdbServers;
    const readMeta = deps.readDeletedMeta || readDeletedMeta;
    const filter = {};
    if (envFilter && envFilter !== 'ALL') filter.env = envFilter;
    const all = (queryCmdb(filter) || {}).servers || [];
    const meta = readMeta() || {};
    const isDeleted = (ip) => !!ip && !!meta[String(ip).trim()] && meta[String(ip).trim()].deleted === true;
    const fallback = fallbackEnvName();
    // queryCmdbServers derives envName from envId; an unmapped row keeps its raw text (HostMonitor folder name)
    const envOf = (s) => (s.envId ? s.envName : (s.envUnmapped || fallback));

    return all
        .filter(s => s.lifecycleStatus !== 'decommissioned')
        .filter(s => !isDeleted(s.ip) && !isDeleted(s.linkedToIp || s.linkedTo || s.vipOf))
        .map(s => ({
            ip: s.ip,
            hostname: s.hostname || s.vmName || s.fqdn?.split('.')[0] || '',
            envId: s.envId || null,
            env: envOf(s),
            envName: envOf(s),
            zone: s.zone || s.businessUnit || 'SYS',
            applicationName: s.applicationName || s.purpose || '',
            os: s.os || '',
            osFamily: resolveOsFamily(s.os)
        }));
}

/**
 * Build fast lookup indexes from parsed tests
 */
function buildTestIndexes(tests) {
    const testsByIp = new Map();
    const testsByHostname = new Map();

    function addIndex(map, key, test) {
        if (!key) return;
        const k = key.trim().toLowerCase();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(test);
    }

    for (const t of tests) {
        // Direct target field
        const target = t.Host || t.Agent || t.Server || t.Computer || '';
        if (target) {
            // Is it an IPv4 address?
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) {
                addIndex(testsByIp, target, t);
            } else {
                addIndex(testsByHostname, target, t);
            }
        }

        // Extract IP from Title (e.g. "Ping: 10.88.18.108 (JH-SBK-APP108)")
        if (t.Title) {
            const ipMatches = t.Title.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
            if (ipMatches) {
                for (const ip of ipMatches) {
                    addIndex(testsByIp, ip, t);
                }
            }

            // Extract Hostname inside parentheses, e.g. (JH-SBK-APP108)
            const hostMatches = t.Title.match(/\(([^)]+)\)/g);
            if (hostMatches) {
                for (const h of hostMatches) {
                    const cleanH = h.replace(/[()]/g, '').trim();
                    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanH)) {
                        addIndex(testsByHostname, cleanH, t);
                    }
                }
            }
        }

        // Extract from PerfCounter path (e.g. "\\10.88.105.74\Processor(_Total)\...")
        if (t.PerfCounter) {
            const pcMatch = t.PerfCounter.match(/^\\\\([^\\/]+)\\/);
            if (pcMatch) {
                const targetHost = pcMatch[1].trim();
                if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(targetHost)) {
                    addIndex(testsByIp, targetHost, t);
                } else {
                    addIndex(testsByHostname, targetHost, t);
                }
            }
        }

        // Extract from Comment
        if (t.Comment) {
            const ipMatches = t.Comment.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
            if (ipMatches) {
                for (const ip of ipMatches) {
                    addIndex(testsByIp, ip, t);
                }
            }
        }
    }

    return { testsByIp, testsByHostname };
}

/**
 * Compare server list with HostMonitor test items (with Ignored Environments support)
 */
function compareServersWithHostMonitor(servers, parsedData, ignoredEnvs = []) {
    const { testsByIp, testsByHostname } = buildTestIndexes(parsedData.tests);

    const isIgnored = ignoredEnvMatcher(ignoredEnvs);

    let countAllMonitored = 0;
    let countMissingPing = 0;
    let countMissingCpu = 0;
    let countMissingMem = 0;
    let countMissingDisk = 0;
    let countUnmonitored = 0;
    let countIgnored = 0;

    const results = [];

    for (const server of servers) {
        // Check if this environment is set to be ignored (by id, or by name case-insensitively)
        if (isIgnored(server)) {
            countIgnored++;
            continue; // Skip comparing this server
        }
        const env = String(server.envName || server.env || server.envId || 'UNKNOWN').trim().toUpperCase();

        const ip = (server.ip || '').trim();
        const hostname = (server.hostname || '').trim();
        const zone = (server.zone || server.businessUnit || '').trim();
        const appName = (server.applicationName || server.purpose || '').trim();

        const matchedTestsSet = new Set();

        if (ip) {
            const byIp = testsByIp.get(ip.toLowerCase()) || [];
            byIp.forEach(t => matchedTestsSet.add(t));
        }
        if (hostname) {
            const byHost = testsByHostname.get(hostname.toLowerCase()) || [];
            byHost.forEach(t => matchedTestsSet.add(t));
        }

        const matched = Array.from(matchedTestsSet);

        // Identify test presence
        let hasPing = false;
        let hasCpu = false;
        let hasMem = false;
        let hasDisk = false;

        const pingTests = [];
        const cpuTests = [];
        const memTests = [];
        const diskTests = [];

        for (const t of matched) {
            const m = (t.Method || '').toLowerCase();
            const f = (t.folder || '').toLowerCase();
            const title = (t.Title || '').toLowerCase();

            // Ping
            if (m === 'ping' || f.includes('\\ping\\') || title.startsWith('ping:')) {
                hasPing = true;
                pingTests.push(t);
                continue;
            }

            // CPU
            if (
                f.includes('\\cpu\\') ||
                m === 'cpu' ||
                title.includes('cpu ') ||
                title.startsWith('cpu:') ||
                title.includes('% processor time') ||
                (t.OID && t.OID.startsWith('1.3.6.1.4.1.2021.11.'))
            ) {
                hasCpu = true;
                cpuTests.push(t);
                continue;
            }

            // Memory
            if (
                f.includes('\\mem\\') ||
                m === 'memory' ||
                title.includes('physical memory') ||
                title.includes('freemem') ||
                (t.MemoryType && t.MemoryType.toLowerCase().includes('physical'))
            ) {
                hasMem = true;
                memTests.push(t);
                continue;
            }

            // Disk Space
            if (
                f.includes('\\disk space\\') ||
                f.includes('\\disk\\') ||
                m === 'drivespace' ||
                title.includes('free space:') ||
                title.includes('disk space') ||
                (t.OID && t.OID.startsWith('1.3.6.1.4.1.2021.9.'))
            ) {
                hasDisk = true;
                diskTests.push(t);
                continue;
            }
        }

        const isAllMonitored = hasPing && hasCpu && hasMem && hasDisk;
        const isUnmonitored = !hasPing && !hasCpu && !hasMem && !hasDisk;

        if (isAllMonitored) countAllMonitored++;
        if (isUnmonitored) countUnmonitored++;
        if (!hasPing) countMissingPing++;
        if (!hasCpu) countMissingCpu++;
        if (!hasMem) countMissingMem++;
        if (!hasDisk) countMissingDisk++;

        results.push({
            env,
            envId: server.envId || null,
            hostname: hostname || '-',
            ip: ip || '-',
            zone: zone || '-',
            applicationName: appName || '-',
            os: server.os || '',
            osFamily: server.osFamily || resolveOsFamily(server.os),
            hasPing,
            hasCpu,
            hasMem,
            hasDisk,
            pingCell: hasPing ? '' : 'X',
            cpuCell: hasCpu ? '' : 'X',
            memCell: hasMem ? '' : 'X',
            diskCell: hasDisk ? '' : 'X',
            isAllMonitored,
            isUnmonitored,
            matchedCount: matched.length,
            details: {
                pingTests: pingTests.map(t => ({ title: t.Title, folder: t.folder, method: t.Method })),
                cpuTests: cpuTests.map(t => ({ title: t.Title, folder: t.folder, method: t.Method })),
                memTests: memTests.map(t => ({ title: t.Title, folder: t.folder, method: t.Method })),
                diskTests: diskTests.map(t => ({ title: t.Title, folder: t.folder, method: t.Method }))
            }
        });
    }

    return {
        summary: {
            totalServers: results.length,
            totalRawServers: servers.length,
            ignoredServers: countIgnored,
            allMonitored: countAllMonitored,
            missingPing: countMissingPing,
            missingCpu: countMissingCpu,
            missingMem: countMissingMem,
            missingDisk: countMissingDisk,
            unmonitored: countUnmonitored
        },
        results
    };
}

const KNOWN_ALERT_BUS = ['BI', 'SBKTW', 'SBKPH', 'TA', 'TRS'];
const DEFAULT_SYS_ALERT = '[SYS] Monitor Email, SYS Skype, SYS Teams';

/**
 * Resolve Business Unit (BU) tag for a server based on zone, BU, group, and hostname:
 * Known alert profile BUs: BI, SBKTW, SBKPH, TA, TRS
 */
function resolveServerBu(server) {
    const rawZone = String(server.zone || server.businessUnit || server.group || '').trim().toUpperCase();
    const hostname = String(server.hostname || '').toUpperCase();

    // 1. SBK-PH / SBKPH
    if (rawZone === 'SBK-PH' || rawZone === 'SBKPH' || hostname.includes('SBKPH') || hostname.includes('SBK-PH')) {
        return 'SBKPH';
    }
    // 2. SBKTW / SBK-TW / SBK
    if (rawZone === 'SBKTW' || rawZone === 'SBK-TW') {
        return 'SBKTW';
    }
    if (rawZone === 'SBK' || hostname.includes('-SBK-') || hostname.includes('.SBK.')) {
        return 'SBKTW';
    }
    // 3. BI
    if (rawZone === 'BI' || hostname.includes('-BI-') || hostname.includes('.BI.')) {
        return 'BI';
    }
    // 4. TA
    if (rawZone === 'TA' || hostname.includes('-TA-') || hostname.includes('.TA.')) {
        return 'TA';
    }
    // 5. TRS
    if (rawZone === 'TRS' || hostname.includes('-TRS-') || hostname.includes('.TRS.')) {
        return 'TRS';
    }

    if (KNOWN_ALERT_BUS.includes(rawZone)) {
        return rawZone;
    }

    return null;
}

/**
 * Resolve Action Profile (Alerts) string according to HostMonitor 2026-10-06 export rules:
 * - If BU is known (BI, SBKTW, SBKPH, TA, TRS):
 *     Ping: [BU] Ping Email, SYS Teams, SBK Teams
 *     Disk: [BU] Disk Mail, SYS Teams, SBK Teams
 *     CPU:  [BU] CPU SYS Teams, SBK Teams
 *     MEM:  [BU] MEM SYS Teams, SBK Teams
 * - All other BUs / default:
 *     [SYS] Monitor Email, SYS Skype, SYS Teams
 */
function resolveActionProfile(server, metricType, customOverride = null) {
    if (customOverride) return customOverride;

    const bu = resolveServerBu(server);
    if (!bu) {
        return DEFAULT_SYS_ALERT;
    }

    switch (metricType.toLowerCase()) {
        case 'ping':
            return `[${bu}] Ping Email, SYS Teams, SBK Teams`;
        case 'disk':
            return `[${bu}] Disk Mail, SYS Teams, SBK Teams`;
        case 'cpu':
            return `[${bu}] CPU SYS Teams, SBK Teams`;
        case 'mem':
        case 'memory':
            return `[${bu}] MEM SYS Teams, SBK Teams`;
        default:
            return DEFAULT_SYS_ALERT;
    }
}

/**
 * Per-OS test bodies, copied from the tests already in production HostMonitor (backup 2026-10-27):
 * Linux = net-snmp UCD OIDs / Memory over SNMP; Windows = PerfCounter CPU, Memory over WMI, DriveSpace (all local drives).
 */
const OS_TEST_TEMPLATES = {
    disk: {
        linux: ({ s, group, appTag }) => ({
            method: 'SNMP',
            title: `Free space: ${s.ip} (${s.hostname})${appTag} [${group}]`,
            comment: `SNMP Get 1.3.6.1.4.1.2021.9.1.9.1 from ${s.ip}`,
            cmntPattern: 'SNMP Get %mibnameshort% from %host%',
            interval: 300,
            props: [
                `Agent       = ${s.ip}`,
                'Profile     = public',
                'Timeout     = 2000',
                'Retries     = 1',
                'OID         = 1.3.6.1.4.1.2021.9.1.9.1',
                'Condition   = MoreThan',
                'Value       = 85'
            ]
        }),
        windows: ({ s, group, appTag }) => ({
            method: 'DriveSpace',
            title: `Free space: local on ${s.ip} (${s.hostname})${appTag} [${group}]`,
            comment: 'local',
            namePattern: `Free space: %path% on %host% (${s.hostname})${appTag} [${group}]`,
            cmntPattern: '%path%',
            interval: 300,
            props: [
                'SnmpMode    = 0',
                `Server      = ${s.ip}`,
                'DriveList   = C:',
                'CheckByList = No',
                'CheckLocals = Yes',
                'CheckRemovable= No',
                'MinFreeSpace= 15%'
            ]
        })
    },
    cpu: {
        linux: ({ s, env, group, appTag }) => ({
            method: 'SNMP',
            title: `CPU ${s.ip} (${s.hostname})${appTag} [${group}]`,
            comment: `CPU ${group} ${env} ${s.applicationName || ''} ${s.ip} ${s.hostname}`,
            namePattern: `CPU %host% (${s.hostname})${appTag} [${group}]`,
            interval: 180,
            props: [
                `Agent       = ${s.ip}`,
                'Profile     = public',
                'Timeout     = 2000',
                'Retries     = 1',
                'OID         = 1.3.6.1.4.1.2021.11.9.0',
                'Condition   = MoreThan',
                'Value       = 85'
            ]
        }),
        windows: ({ s, env, group, appTag }) => ({
            method: 'PerfCounter',
            title: `PerfCounter: % Processor Time ${s.ip} (${s.hostname})${appTag} [${group}]`,
            comment: `CPU ${group} ${env} ${s.applicationName || ''} ${s.ip} ${s.hostname}`,
            namePattern: `PerfCounter: %object% ${s.ip} (${s.hostname})${appTag} [${group}]`,
            interval: 180,
            props: [
                `PerfCounter = \\\\${s.ip}\\Processor(_Total)\\% Processor Time`,
                'Condition   = MoreThan',
                'Value       = 85.00',
                'DisplayMode = AsIs'
            ]
        })
    },
    mem: {
        linux: ({ s, env, group, appTag }) => ({
            method: 'Memory',
            title: `Free Physical memory (${s.ip}) (${s.hostname})${appTag} [${group}]`,
            comment: `MEM ${group} ${env} ${s.applicationName || ''} ${s.ip} ${s.hostname}`,
            namePattern: `Free %object% (%host%) (${s.hostname})${appTag} [${group}]`,
            interval: 180,
            props: [
                `Host        = ${s.ip}`,
                'Protocol    = SNMP',
                'Timeout     = 2000',
                'Retries     = 1',
                'Profile     = public',
                'MemoryType  = Physical memory',
                'Limit       = 15 %'
            ]
        }),
        windows: ({ s, env, group, appTag }) => ({
            method: 'Memory',
            title: `Free Physical memory (${s.ip}) (${s.hostname})${appTag} [${group}]`,
            comment: `MEM ${group} ${env} ${s.applicationName || ''} ${s.ip} ${s.hostname}`,
            namePattern: `Free %object% (%host%) (${s.hostname})${appTag} [${group}]`,
            interval: 180,
            props: [
                `Host        = ${s.ip}`,
                'Protocol    = WMI',
                'MemoryType  = Physical memory',
                'Limit       = 15 %'
            ]
        })
    }
};

/**
 * Generate HostMonitor import file content (.txt)
 */
function generateHostMonitorImportText(targetServers, metricsToGenerate = ['ping'], options = {}) {
    return buildHostMonitorImport(targetServers, metricsToGenerate, options).content;
}

/**
 * Same as generateHostMonitorImportText, plus `skipped`: the CPU/MEM/Disk tests left out because the OS is unknown.
 */
function buildHostMonitorImport(targetServers, metricsToGenerate = ['ping'], options = {}) {
    const rmAgent = options.rmAgent || '10.88.105.97';
    const lines = [];
    const skipped = [];

    lines.push(';-----------------------------------------------------------------------------');
    lines.push(';- HostMonitor Import File                                                   -');
    lines.push(`;- Generated by sys-op-manager HM_checker at ${new Date().toISOString()}      -`);
    lines.push(';- Target: Add Missing Monitor Tests into HostMonitor                        -');
    lines.push(';-----------------------------------------------------------------------------');
    lines.push('');
    lines.push('ImportMode = Add');
    lines.push('');

    // Group servers by (ENV, GROUP)
    const grouped = {};
    const fallback = fallbackEnvName();
    for (const server of targetServers) {
        const env = String(server.env || fallback).toUpperCase();
        const group = (server.zone && server.zone !== '-' ? server.zone : (server.group || 'SYS')).toUpperCase();
        const key = `${env}|${group}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push({ ...server, env, group });
    }

    const wantPing = metricsToGenerate.includes('ping');
    const wantCpu = metricsToGenerate.includes('cpu');
    const wantMem = metricsToGenerate.includes('mem');
    const wantDisk = metricsToGenerate.includes('disk');

    for (const [key, items] of Object.entries(grouped)) {
        const [env, group] = key.split('|');

        // 1. PING Section
        if (wantPing) {
            const pings = items.filter(s => !s.hasPing || s.forceGenerate);
            if (pings.length > 0) {
                const folder = `Root\\${env}\\${group}\\PING\\`;
                lines.push(';-----------------------------------------------------------------------------');
                lines.push(`; Folder: ${folder}`);
                lines.push(';-----------------------------------------------------------------------------');
                lines.push(`DefaultFolder  = ${folder}`);
                lines.push('');

                for (let i = 0; i < pings.length; i++) {
                    const s = pings[i];
                    const appTag = s.applicationName && s.applicationName !== '-' ? ` [${s.applicationName}]` : '';
                    const title = `Ping: ${s.ip} (${s.hostname})${appTag} [${group}]`;
                    const alerts = resolveActionProfile(s, 'ping', options.pingAlerts);

                    lines.push(`; ------- Test Ping #${i + 1} (${s.hostname}) -------`);
                    lines.push('Method      = Ping');
                    lines.push(`;DestFolder = ${folder}`);
                    lines.push(`RMAgent     = ${rmAgent}`);
                    lines.push(`Title       = ${title}`);
                    lines.push(`Comment     = Ping ${s.ip}`);
                    lines.push('RelatedURL  = ');
                    lines.push(`NamePattern = %methodname%: %host% (${s.hostname})${appTag} [${group}]`);
                    lines.push('CmntPattern = Ping %host%');
                    lines.push('ScheduleMode= Regular');
                    lines.push('Schedule    = ');
                    lines.push('Interval    = 60');
                    lines.push(`Alerts      = ${alerts}`);
                    lines.push('Alerts2     = Do nothing');
                    lines.push('ReverseAlert= No');
                    lines.push('UnknownIsBad= No');
                    lines.push('WarningIsBad= No');
                    lines.push('UseCommonLog= No');
                    lines.push('PrivLogMode = Default');
                    lines.push('CommLogMode = Default');
                    lines.push('MasterAFresh= No');
                    lines.push(';--- Test specific properties ---');
                    lines.push(`Host        = ${s.ip}`);
                    lines.push('Timeout     = 2000');
                    lines.push('Retries     = 4');
                    lines.push('MaxLostRatio= 100');
                    lines.push('DefJitter   = 100');
                    lines.push('DisplayMode = time');
                    lines.push('DontFragment= No');
                    lines.push('');
                }
            }
        }

        // 2-4. DISK / CPU / MEM: the HostMonitor method depends on the OS (taken from the CMDB); unknown OS is skipped
        const sections = [
            { metric: 'disk', want: wantDisk, has: 'hasDisk', folder: 'Disk Space', label: 'Disk' },
            { metric: 'cpu', want: wantCpu, has: 'hasCpu', folder: 'CPU', label: 'CPU' },
            { metric: 'mem', want: wantMem, has: 'hasMem', folder: 'MEM', label: 'Memory' }
        ];
        for (const sec of sections) {
            if (!sec.want) continue;
            const targets = items.filter(s => !s[sec.has] || s.forceGenerate);
            const known = [];
            for (const s of targets) {
                const family = s.osFamily || resolveOsFamily(s.os);
                if (family === 'unknown') skipped.push({ metric: sec.metric, env, group, ip: s.ip, hostname: s.hostname, os: s.os || '' });
                else known.push({ ...s, osFamily: family });
            }
            if (known.length === 0) continue;

            const folder = `Root\\${env}\\${group}\\${sec.folder}\\`;
            lines.push(';-----------------------------------------------------------------------------');
            lines.push(`; Folder: ${folder}`);
            lines.push(';-----------------------------------------------------------------------------');
            lines.push(`DefaultFolder  = ${folder}`);
            lines.push('');

            known.forEach((s, i) => {
                const appTag = s.applicationName && s.applicationName !== '-' ? ` [${s.applicationName}]` : '';
                const alerts = resolveActionProfile(s, sec.metric, options[`${sec.metric}Alerts`]);
                const isWin = s.osFamily === 'windows';
                const t = OS_TEST_TEMPLATES[sec.metric][isWin ? 'windows' : 'linux']({ s, env, group, appTag });

                lines.push(`; ------- Test ${sec.label} #${i + 1} (${s.hostname}) [${isWin ? 'Windows' : 'Linux'}] -------`);
                lines.push(`Method      = ${t.method}`);
                lines.push(`;DestFolder = ${folder}`);
                lines.push(`RMAgent     = ${rmAgent}`);
                lines.push(`Title       = ${t.title}`);
                lines.push(`Comment     = ${t.comment}`);
                lines.push('RelatedURL  = ');
                if (t.namePattern) lines.push(`NamePattern = ${t.namePattern}`);
                if (t.cmntPattern) lines.push(`CmntPattern = ${t.cmntPattern}`);
                lines.push('ScheduleMode= Regular');
                lines.push('Schedule    = ');
                lines.push(`Interval    = ${t.interval}`);
                lines.push(`Alerts      = ${alerts}`);
                lines.push('Alerts2     = Do nothing');
                lines.push('ReverseAlert= No');
                lines.push('UnknownIsBad= No');
                lines.push('WarningIsBad= No');
                lines.push('UseCommonLog= No');
                lines.push('PrivLogMode = Default');
                lines.push('CommLogMode = Default');
                lines.push('MasterAFresh= No');
                lines.push(';--- Test specific properties ---');
                for (const p of t.props) lines.push(p);
                lines.push('');
            });
        }
    }

    if (skipped.length > 0) {
        lines.push(';-----------------------------------------------------------------------------');
        lines.push(`; Skipped ${skipped.length} CPU/MEM/Disk test(s): OS is not recorded in the CMDB (or not Windows/Linux).`);
        lines.push('; Fill in the OS in the CMDB, then generate again.');
        lines.push(';-----------------------------------------------------------------------------');
        for (const k of skipped) {
            lines.push(`; ${k.metric.toUpperCase().padEnd(4)} ${k.env}\\${k.group}  ${k.ip} (${k.hostname})${k.os ? `  OS=${k.os}` : ''}`);
        }
        lines.push('');
    }

    return { content: lines.join('\r\n'), skipped };
}

/**
 * Parse Excel pasted text (Tab-separated or comma-separated)
 */
function parseExcelPastedText(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const envList = envRegistry.getEnvironments();
    const fallback = fallbackEnvName();

    const parsed = [];
    let headerZoneIdx = -1;
    let headerHostIdx = -1;
    let headerIpIdx = -1;

    // Check if first row is header
    const firstRowTokens = lines[0].split(/\t|,/).map(t => t.trim().toLowerCase());
    const hasHeader = firstRowTokens.some(t => 
        t.includes('zone') || t.includes('env') || t.includes('hostname') || t.includes('ip') || t.includes('servicelan')
    );

    let startRow = 0;
    if (hasHeader) {
        startRow = 1;
        firstRowTokens.forEach((t, idx) => {
            if (t.includes('zone') || t.includes('env')) headerZoneIdx = idx;
            if (t.includes('host') || t.includes('server')) headerHostIdx = idx;
            if (t.includes('ip') || t.includes('lan')) headerIpIdx = idx;
        });
    }

    // Default indices if not mapped
    if (headerZoneIdx === -1) headerZoneIdx = 0;
    if (headerHostIdx === -1) headerHostIdx = 1;
    if (headerIpIdx === -1) headerIpIdx = 2;

    for (let i = startRow; i < lines.length; i++) {
        const cols = lines[i].split(/\t|,/).map(c => c.trim());
        if (cols.length === 0) continue;

        let zone = cols[headerZoneIdx] || '';
        let hostname = cols[headerHostIdx] || '';
        let ip = cols[headerIpIdx] || '';

        // Auto detect if column positions are swapped
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
            const foundIpIdx = cols.findIndex(c => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(c));
            if (foundIpIdx !== -1) {
                ip = cols[foundIpIdx];
                if (headerHostIdx === foundIpIdx) {
                    hostname = cols.find((c, idx) => idx !== foundIpIdx && idx !== headerZoneIdx) || '';
                }
            }
        }

        if (ip || hostname) {
            // Comparison input only: a known environment is canonicalised (and gets its id), other text is kept
            // as typed (it is the HostMonitor folder); empty -> the default environment
            const env = zone ? envRegistry.resolveEnv(zone, envList) : null;
            const envName = env ? env.name : (zone || fallback);
            parsed.push({
                envId: env ? env.id : (zone ? null : (envRegistry.getDefaultEnv(envList) || {}).id || null),
                env: envName,
                envName,
                zone: zone || fallback,
                hostname: hostname || '-',
                ip: ip || '-',
                applicationName: ''
            });
        }
    }

    return parsed;
}


module.exports = {
    DEFAULT_FILE_PATTERN,
    DEFAULT_SCAN_TIMEOUT_SEC,
    MAX_UPLOAD_BYTES,
    getTodayLocalDateStr,
    getConfig,
    saveConfig,
    validateConfigInput,
    patternToMatcher,
    extractDateInfo,
    clearScanCache,
    ensureUploadDir,
    getTodayCache,
    saveTodayCache,
    clearTodayCache,
    getActualEnvironments,
    getEnvironmentOptions,
    DEFAULT_IGNORED_ENVS,
    scanBackupFiles,
    sortBackupFiles,
    resolveBackupFiles,
    pickBackupFile,
    toFileInfo,
    testDirectoryAccessAsync,
    getUploadDir,
    sanitizeUploadFilename,
    saveUploadedBackup,
    getOrParseFile,
    clearParseCache,
    _parseCacheKeys,
    parseHostMonitorFile,
    loadCmdbServers,
    buildTestIndexes,
    compareServersWithHostMonitor,
    generateHostMonitorImportText,
    buildHostMonitorImport,
    resolveOsFamily,
    attachCmdbOs,
    parseExcelPastedText,
    _testHooks
};
