const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { encryptText, decryptText } = require('../lib/crypto');
const { auditLog, appendLog } = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');
const sqliteHelper = require('../lib/sqliteHelper');
const aiRouter = require('./ai');
const envRegistry = require('../lib/environmentRegistry');
const sqlGuard = require('../lib/sqlGuard');
const dbTargetPolicy = require('../lib/dbTargetPolicy');
const dbBackupCommand = require('../lib/dbBackupCommand');
const dbClient = require('../lib/dbClient');

/**
 * Get DB clusters list securely
 */
function getDatabases() {
    return readDataSync('service_platform/database_clusters.json', []);
}

/**
 * Save DB clusters securely
 */
function saveDatabases(databases) {
    writeDataSync('service_platform/database_clusters.json', databases);
}

router.use(requireAuth);

function handleRouteError(res, e, action = 'Database operation') {
    console.error(e);
    appendLog(`[Database] Exception during ${action}: ${e.stack || e.message}`);
    res.status(500).json({ success: false, error: 'Internal server error occurred.' });
}

/**
 * A stored DB record that passed the target policy (field formats, SQLite location, host allowlist).
 * @returns {Promise<{ db: object, sqlitePath?: string } | { status: number, error: string }>}
 */
async function loadTarget(id) {
    const db = getDatabases().find(d => d.id === id);
    if (!db) return { status: 404, error: 'Database not found' };
    const check = await dbTargetPolicy.checkTarget(db);
    if (check.error) return { status: 400, error: check.error };
    return { db, sqlitePath: check.sqlitePath };
}

const withConnection = dbClient.withConnection;

// --------------------------------------------------------------------------
// GET /api/database/inventory
// Returns list of DBs (without passwords)
// --------------------------------------------------------------------------
router.get('/inventory', checkFeature('dbInventory'), (req, res) => {
    try {
        const dbs = getDatabases();
        const envs = envRegistry.getEnvironments();
        const safeList = dbs.map(db => {
            const env = envRegistry.displayForRecord(db.envId, db.environment, envs);
            return {
            id: db.id,
            name: db.name,
            environment: env.envName,
            envId: env.envId,
            envIsProduction: env.isProduction,
            ...(env.assigned ? {} : { envUnmapped: env.unmapped }),
            engine: db.engine,
            host: db.host,
            port: db.port,
            database: db.database,
            username: db.username,
            trustServerCertificate: db.trustServerCertificate === true
            };
        });
        res.json({ success: true, databases: safeList });
    } catch (e) {
        handleRouteError(res, e, 'get inventory');
    }
});

// --------------------------------------------------------------------------
// POST /api/database/inventory
// Add or Edit a DB connection
// --------------------------------------------------------------------------
router.post('/inventory', checkFeature('dbInventory'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { id, name, environment, envId, engine, host, port, database, username, password, filePath } = req.body;
        // SQL Server only: accept a self-signed server certificate (TLS stays on)
        const trustServerCertificate = engine === 'SQLServer' && req.body.trustServerCertificate === true;

        // Editing a record whose environment is Unassigned keeps it as is unless the user picks one
        const keepEnv = !!id && envRegistry.isUnchangedEnvInput(envId, environment);
        if (!name || (!keepEnv && !(environment || envId)) || !engine) {
            return res.status(400).json({ success: false, error: '缺少必填欄位 (名稱/環境/資料庫引擎)' });
        }
        const envRef = keepEnv ? { keep: true } : envRegistry.envWriteFields(envId || environment);
        if (envRef.error) return res.status(400).json({ success: false, error: envRef.error });

        const isSqlite = engine === 'SQLite';
        let finalDatabase = isSqlite ? (filePath || database || host) : database;
        const finalHost = isSqlite ? 'localhost' : host;
        const finalUsername = isSqlite ? (username || 'sqlite') : username;

        if (isSqlite && !finalDatabase) {
            return res.status(400).json({ success: false, error: 'SQLite 必須提供資料庫檔案路徑' });
        } else if (!isSqlite && (!host || !username)) {
            return res.status(400).json({ success: false, error: '缺少連線主機或使用者名稱' });
        }
        if (isSqlite) {
            const resolved = dbTargetPolicy.resolveSqlitePath(finalDatabase);
            if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
            finalDatabase = resolved.path;
        } else {
            const fieldError = dbTargetPolicy.validateConnectionFields({ engine, host, port, database, username })
                || await dbTargetPolicy.checkHostAllowed(host);
            if (fieldError) return res.status(400).json({ success: false, error: fieldError });
        }

        let dbs = getDatabases();
        let targetId = id;
        
        if (targetId) {
            const idx = dbs.findIndex(db => db.id === targetId);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Database not found' });
            
            // Update
            const existing = dbs[idx];
            existing.name = name;
            if (!envRef.keep) {
                existing.environment = envRef.env.name;
                existing.envId = envRef.env.id;
            }
            existing.engine = engine;
            existing.host = finalHost;
            existing.port = isSqlite ? null : port;
            existing.database = finalDatabase;
            existing.username = finalUsername;
            existing.trustServerCertificate = trustServerCertificate;
            if (password && !isSqlite) {
                existing.password_enc = encryptText(password);
            }
        } else {
            // Create
            targetId = 'db-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            const newDb = {
                id: targetId,
                name,
                environment: envRef.env.name,
                envId: envRef.env.id,
                engine,
                host: finalHost,
                port: isSqlite ? null : port,
                database: finalDatabase,
                username: finalUsername,
                trustServerCertificate,
                password_enc: (password && !isSqlite) ? encryptText(password) : null
            };
            dbs.push(newDb);
        }

        saveDatabases(dbs);
        auditLog(req.user.username, 'Database', `Saved database definition: ${name} (${engine})`);
        res.json({ success: true, id: targetId });
    } catch (e) {
        handleRouteError(res, e, 'save inventory');
    }
});

// --------------------------------------------------------------------------
// DELETE /api/database/inventory/:id
// Remove a DB
// --------------------------------------------------------------------------
router.delete('/inventory/:id', checkFeature('dbInventory'), checkRole(['SuperAdmin']), (req, res) => {
    try {
        const dbs = getDatabases();
        const filtered = dbs.filter(db => db.id !== req.params.id);
        if (filtered.length === dbs.length) {
            return res.status(404).json({ success: false, error: 'Database not found' });
        }
        saveDatabases(filtered);
        auditLog(req.user.username, 'Database', `Deleted database ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (e) {
        handleRouteError(res, e, 'delete inventory');
    }
});

// --------------------------------------------------------------------------
// POST /api/database/test-connection
// Test connection to a DB (either stored db by ID or ad-hoc from form data)
// --------------------------------------------------------------------------
router.post('/test-connection', checkFeature('dbInventory'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { id, engine, host, port, database, username, password, filePath, trustServerCertificate } = req.body;

        let connInfo = {};
        let sqlitePath;
        if (id) {
            const target = await loadTarget(id);
            if (target.error) return res.status(target.status).json({ success: false, error: target.error });
            const targetDb = target.db;
            sqlitePath = target.sqlitePath;
            connInfo = {
                engine: targetDb.engine,
                host: targetDb.host,
                port: targetDb.port,
                database: targetDb.database,
                username: targetDb.username,
                password: targetDb.password_enc ? decryptText(targetDb.password_enc) : '',
                trustServerCertificate: targetDb.trustServerCertificate === true
            };
        } else {
            if (engine === 'SQLite') {
                const finalPath = filePath || database || host;
                if (!finalPath) {
                    return res.status(400).json({ success: false, error: 'SQLite 必須提供檔案路徑' });
                }
                connInfo = { engine: 'SQLite', database: finalPath };
            } else {
                if (!engine || !host || !username) {
                    return res.status(400).json({ success: false, error: 'Missing required connection fields' });
                }
                connInfo = { engine, host, port, database, username, password, trustServerCertificate: trustServerCertificate === true };
            }
            const check = await dbTargetPolicy.checkTarget(connInfo);
            if (check.error) return res.status(400).json({ success: false, error: check.error });
            sqlitePath = check.sqlitePath;
            // Ad-hoc targets are not in the inventory yet, so the audit log is the only record of what was probed
            auditLog(req.user.username, 'Database', connInfo.engine === 'SQLite'
                ? `Tested ad-hoc SQLite connection: ${sqlitePath}`
                : `Tested ad-hoc ${connInfo.engine} connection: ${connInfo.host}:${connInfo.port || 'default'}`);
        }

        // Special handling for SQLite
        if (connInfo.engine === 'SQLite') {
            const testRes = await sqliteHelper.testConnection(sqlitePath);
            return res.json({ success: true, message: testRes.message, details: testRes });
        }

        await dbClient.testConnection(connInfo, 3000);
        res.json({ success: true, message: 'Connection test succeeded' });

    } catch (e) {
        console.error(e);
        appendLog(`[Database] Exception during test-connection: ${e.stack || e.message}`);
        res.json({ success: false, error: e.message || 'Database connection test failed.' });
    }
});

// --------------------------------------------------------------------------
// POST /api/database/query
// Execute a SQL Query (Restricted)
// --------------------------------------------------------------------------
router.post('/query', checkFeature('dbSqlTerminal'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { id, query } = req.body;
        if (!id || !query || typeof query !== 'string') return res.status(400).json({ success: false, error: 'Missing id or query' });

        const target = await loadTarget(id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const targetDb = target.db;

        // One read-only statement only, checked with the target engine's own quoting and comment rules
        const guard = sqlGuard.validateReadOnlyQuery(query, targetDb.engine);
        if (!guard.ok) {
            auditLog(req.user.username, 'Database', `Attempted blocked query on DB ${id}: ${guard.word || 'invalid'}`);
            return res.status(403).json({ success: false, error: guard.error });
        }
        // The statement runs unchanged; each engine caps the rows on the server side (see dbClient.runReadOnly)
        let rows = [];
        let truncated = false;
        const startTime = process.hrtime();
        try {
            if (targetDb.engine === 'SQLite') {
                rows = await sqliteHelper.executeQuery(target.sqlitePath, query, { maxRows: dbClient.MAX_ROWS + 1 });
                truncated = rows.length > dbClient.MAX_ROWS;
                rows = rows.slice(0, dbClient.MAX_ROWS);
            } else {
                ({ rows, truncated } = await dbClient.runReadOnly(targetDb, query, guard.leading));
            }
        } catch (dbErr) {
            // Errors from the database itself (syntax, permission, timeout) go back to the user as-is
            appendLog(`[Database] Query failed on ${targetDb.name}: ${dbErr.message}`);
            return res.status(400).json({ success: false, error: dbErr.message || 'Query failed' });
        }

        const diff = process.hrtime(startTime);
        const executionMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);

        // Sensitive data masking: only SuperAdmin may ask for raw values (showRaw=true); everyone else gets masked data
        const role = req.user?.role || 'Viewer';
        const canUnmask = role === 'SuperAdmin';
        const showRaw = req.body.showRaw === true && canUnmask;
        let maskedRows = rows;
        let maskedColumns = [];
        if (!showRaw) {
            ({ rows: maskedRows, maskedColumns } = sqlGuard.maskSensitiveRows(rows, query, targetDb.engine));
        }

        // Enhancement 5: Audit Log detailed SQL statement executed (redacting string literals)
        let loggedSql = query.replace(/'[^']*'/g, "'***'").replace(/"[^"]*"/g, '"***"');
        loggedSql = loggedSql.replace(/\s+/g, ' ').substring(0, 150);
        auditLog(req.user.username, 'Database', `Executed SELECT query on ${targetDb.name}. Masked: ${!showRaw}. SQL: "${loggedSql}${query.length > 150 ? '...' : ''}"`);
        
        res.json({ 
            success: true, 
            rows: maskedRows, 
            rowCount: rows.length,
            truncated,
            maxRows: dbClient.MAX_ROWS,
            executionMs,
            isMasked: !showRaw && maskedColumns.length > 0,
            maskedColumns,
            canUnmask
        });

    } catch (e) {
        handleRouteError(res, e, 'execute query');
    }
});

// --------------------------------------------------------------------------
// PROVISIONING API
// --------------------------------------------------------------------------
// Also used as the SQLite file name on approval, so no path characters
const PROVISION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

// Reasons saved before v1.7.9 were HTML-escaped on save
const decodeLegacyReason = (r) => (r.rejectReason && /&(lt|gt);/.test(r.rejectReason)
    ? { ...r, rejectReason: r.rejectReason.replace(/&lt;/g, '<').replace(/&gt;/g, '>') }
    : r);

function getProvisionRequests() {
    return readDataSync('service_platform/database_requests.json', []);
}

function saveProvisionRequests(requests) {
    writeDataSync('service_platform/database_requests.json', requests);
}

router.get('/provision', checkFeature('dbProvision'), (req, res) => {
    try {
        const envs = envRegistry.getEnvironments();
        res.json({ success: true, requests: getProvisionRequests().map(r => envRegistry.decorateRecord(decodeLegacyReason(r), envs)) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/provision', checkFeature('dbProvision'), checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { name, engine, environment, envId, size, reason } = req.body;
        if (!name || !engine || !(environment || envId) || !size) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        if (!PROVISION_NAME_RE.test(String(name))) {
            return res.status(400).json({ success: false, error: '資料庫名稱只能用英文字母開頭，並只包含英數字與底線（最多 63 字）' });
        }
        if (!dbTargetPolicy.ENGINES.includes(engine)) {
            return res.status(400).json({ success: false, error: `不支援的資料庫引擎: ${engine}` });
        }
        const envRef = envRegistry.envWriteFields(envId || environment);
        if (envRef.error) return res.status(400).json({ success: false, error: envRef.error });
        const requests = getProvisionRequests();
        const newReq = {
            id: 'req-' + Date.now(),
            name,
            engine,
            environment: envRef.env.name,
            envId: envRef.env.id,
            size,
            reason,
            status: 'pending',
            requester: req.user.username,
            requestDate: new Date().toISOString()
        };
        requests.push(newReq);
        saveProvisionRequests(requests);
        auditLog(req.user.username, 'Database', `Submitted DB provision request: ${name}`);
        res.json({ success: true, request: newReq });
    } catch (e) {
        handleRouteError(res, e, 'create provision request');
    }
});

router.put('/provision/:id/status', checkFeature('dbProvision'), checkRole(['SuperAdmin']), (req, res) => {
    try {
        const { status, rejectReason } = req.body;
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status value' });
        }

        const requests = getProvisionRequests();
        const target = requests.find(r => r.id === req.params.id);
        if (!target) return res.status(404).json({ success: false, error: 'Request not found' });

        if (target.requester === req.user.username) {
            return res.status(403).json({ success: false, error: 'Security policy: Self-approval is forbidden.' });
        }
        if (target.status !== 'pending') {
            return res.status(409).json({ success: false, error: `此申請已處理過（${target.status}）` });
        }

        // SQLite is the only engine Vanguard can create itself: an empty database file in the SQLite root,
        // registered in the Connection Hub. Server engines are created by a DBA and registered by hand afterwards.
        let newDb = null;
        if (status === 'approved' && target.engine === 'SQLite') {
            if (!PROVISION_NAME_RE.test(String(target.name))) {
                return res.status(400).json({ success: false, error: '申請的資料庫名稱格式不正確，無法建立 SQLite 檔案' });
            }
            const resolved = dbTargetPolicy.resolveSqlitePath(`${target.name}.db`);
            if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
            fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
            try {
                fs.writeFileSync(resolved.path, '', { flag: 'wx' }); // a zero-byte file is a valid empty SQLite database
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
            }
            const dbs = getDatabases();
            newDb = dbs.find(d => d.engine === 'SQLite' && d.database === resolved.path) || null;
            if (!newDb) {
                newDb = {
                    id: 'db-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                    name: target.name,
                    environment: target.environment,
                    ...(target.envId ? { envId: target.envId } : {}),
                    engine: 'SQLite',
                    host: 'localhost',
                    port: null,
                    database: resolved.path,
                    username: 'sqlite',
                    password_enc: null
                };
                dbs.push(newDb);
                saveDatabases(dbs);
            }
            auditLog(req.user.username, 'Database', `Created SQLite database for approved request ${target.name}: ${resolved.path}`);
        }

        target.status = status;
        target.processedBy = req.user.username;
        target.processedDate = new Date().toISOString();
        if (status === 'rejected') {
            // Stored as typed: the page renders it as text, so escaping here only showed up as &lt; on screen
            target.rejectReason = String(rejectReason || '').trim().substring(0, 500);
        } else if (newDb) {
            target.connectionId = newDb.id;
            target.provisionNote = `已建立 SQLite 資料庫並登錄到 DB Connection Hub：${newDb.database}`;
        } else {
            target.provisionNote = '已核准。請 DBA 建立資料庫與帳號後，到 DB Connection Hub 登錄連線。';
        }

        saveProvisionRequests(requests);
        auditLog(req.user.username, 'Database', `${status.toUpperCase()} DB provision request: ${target.name}`);
        res.json({ success: true, request: target });
    } catch (e) {
        handleRouteError(res, e, 'update provision status');
    }
});

// --------------------------------------------------------------------------
// BACKUP API
// --------------------------------------------------------------------------
function getBackups() {
    return readDataSync('service_platform/database_backups.json', []);
}

function saveBackups(backups) {
    writeDataSync('service_platform/database_backups.json', backups);
}

const BACKUP_SCHEDULE_KEY = 'service_platform/database_backup_schedule.json';
const BACKUP_FILE_EXT = { MySQL: '.sql', PostgreSQL: '.dump', SQLServer: '.bak', SQLite: '.db' };
// A record still 'running' this long after it started belongs to a run that died with the process
const STALE_BACKUP_MS = dbBackupCommand.BACKUP_TIMEOUT_MS + 10 * 60 * 1000;

function backupDir() {
    return path.join(process.env.DB_DATA_DIR || process.cwd(), 'backups');
}

// SQL Server writes the .bak on its own host, so that path comes from DB_SQLSERVER_BACKUP_DIR (a directory on the SQL Server host)
function backupFileFor(db, backupId) {
    const name = `${backupId}${BACKUP_FILE_EXT[db.engine] || '.bak'}`;
    if (db.engine === 'SQLServer' && process.env.DB_SQLSERVER_BACKUP_DIR) return path.win32.join(process.env.DB_SQLSERVER_BACKUP_DIR, name);
    return path.join(backupDir(), name);
}

const isRemoteBackup = (b) => b.engine === 'SQLServer';
const isInsideBackupDir = (file) => {
    const rel = path.relative(backupDir(), path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function withStaleState(b) {
    let out = b;
    if (b.status === 'running' && Date.now() - new Date(b.timestamp).getTime() > STALE_BACKUP_MS) {
        out = { ...out, status: 'failed', error: b.error || '備份程序中斷（服務可能曾重啟）' };
    }
    if (b.restore && b.restore.status === 'running' && Date.now() - new Date(b.restore.startedAt).getTime() > STALE_BACKUP_MS) {
        out = { ...out, restore: { ...b.restore, status: 'failed', error: '還原程序中斷（服務可能曾重啟）' } };
    }
    return out;
}

// Records written before real backups existed (the old 02:00 job) carry no file and a "(Simulated)" size
const isSimulatedBackup = (b) => !b.file || /Simulated/.test(String(b.size || ''));

function isRestorable(b) {
    if (b.status !== 'completed' || isSimulatedBackup(b)) return false;
    return isRemoteBackup(b) || fs.existsSync(b.file);
}

function updateBackup(id, patch) {
    const all = getBackups();
    const b = all.find(x => x.id === id);
    if (b) {
        Object.assign(b, patch);
        saveBackups(all);
    }
    return b;
}

const formatSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const formatDuration = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * Record a running backup and start it. done resolves once the record says completed or failed (it never rejects).
 * @returns {{ record: object, done: Promise<object> }}
 */
function startBackup(db, sqlitePath, createdBy) {
    const backupId = 'snap-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    const file = backupFileFor(db, backupId);
    if (db.engine !== 'SQLServer' || !process.env.DB_SQLSERVER_BACKUP_DIR) fs.mkdirSync(backupDir(), { recursive: true });
    const record = {
        id: backupId,
        dbId: db.id,
        engine: db.engine,
        type: 'full',
        status: 'running',
        createdBy,
        timestamp: new Date().toISOString(),
        file
    };
    const all = getBackups();
    all.push(record);
    saveBackups(all);

    const startedAt = Date.now();
    const done = (async () => {
        try {
            if (db.engine === 'SQLite') {
                // VACUUM INTO also captures what is still in the -wal file, which a plain file copy would miss
                await sqliteHelper.backupTo(sqlitePath, file);
            } else {
                await dbBackupCommand.run('backup', db, file, db.password_enc ? decryptText(db.password_enc) : '');
            }
            let size = null;
            if (db.engine !== 'SQLServer') {
                const stats = fs.existsSync(file) ? fs.statSync(file) : null;
                if (!stats || stats.size === 0) throw new Error('備份指令已結束，但沒有產生備份檔');
                size = formatSize(stats.size);
            }
            const finished = updateBackup(backupId, {
                status: 'completed',
                size,
                duration: formatDuration(Date.now() - startedAt),
                completedAt: new Date().toISOString()
            });
            auditLog(createdBy, 'Database', `Created full backup for DB: ${db.name} (${db.engine})`);
            return finished;
        } catch (err) {
            const message = String(err.message || err).slice(0, 500);
            appendLog(`[Database] Backup failed for ${db.name}: ${message}`);
            auditLog(createdBy, 'Database', `Backup FAILED for DB: ${db.name}`);
            return updateBackup(backupId, { status: 'failed', error: message, duration: formatDuration(Date.now() - startedAt) });
        }
    })();
    return { record, done };
}

const hasRunningBackup = (dbId) => getBackups().some(b => b.dbId === dbId && withStaleState(b).status === 'running');

const retentionDays = () => {
    const n = Number(process.env.DB_BACKUP_RETENTION_DAYS);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Drop finished backups older than DB_BACKUP_RETENTION_DAYS together with their local files (unset = keep everything).
 * The newest completed backup of every database is always kept, however old.
 */
function pruneBackups(now = Date.now()) {
    const days = retentionDays();
    if (!days) return { removed: 0 };
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const all = getBackups();
    const newest = new Map();
    for (const b of all) {
        if (b.status !== 'completed' || isSimulatedBackup(b)) continue;
        const cur = newest.get(b.dbId);
        if (!cur || new Date(b.timestamp) > new Date(cur.timestamp)) newest.set(b.dbId, b);
    }
    const keep = [];
    const drop = [];
    for (const b of all) {
        const view = withStaleState(b);
        const busy = view.status === 'running' || (view.restore && view.restore.status === 'running');
        if (new Date(b.timestamp).getTime() < cutoff && !busy && newest.get(b.dbId) !== b) drop.push(b);
        else keep.push(b);
    }
    if (drop.length === 0) return { removed: 0 };
    saveBackups(keep);
    for (const b of drop) {
        if (b.file && !isRemoteBackup(b) && isInsideBackupDir(b.file)) {
            try { fs.unlinkSync(b.file); } catch (e) { if (e.code !== 'ENOENT') appendLog(`[Database] Could not delete backup file ${b.file}: ${e.message}`); }
        }
    }
    appendLog(`[Database] Backup retention (${days} days) removed ${drop.length} record(s)`);
    return { removed: drop.length };
}

router.get('/backup-settings', checkFeature('dbBackup'), (req, res) => {
    try {
        res.json({
            success: true,
            schedule: String(process.env.DB_BACKUP_SCHEDULE || '').trim() || null,
            retentionDays: retentionDays(),
            lastRunDay: readDataSync(BACKUP_SCHEDULE_KEY, {}).lastRunDay || null,
            sqlServerBackupDirSet: !!process.env.DB_SQLSERVER_BACKUP_DIR
        });
    } catch (e) {
        handleRouteError(res, e, 'get backup settings');
    }
});

// A backup holds the whole database, so downloading it is SuperAdmin only and audited
router.get('/backups/:id/download', checkFeature('dbBackup'), checkRole(['SuperAdmin']), (req, res) => {
    try {
        const backup = getBackups().find(b => b.id === req.params.id);
        if (!backup) return res.status(404).json({ success: false, error: 'Backup not found' });
        if (isRemoteBackup(backup)) {
            return res.status(400).json({ success: false, error: 'SQL Server 的備份檔在 SQL Server 主機上，無法從這裡下載' });
        }
        if (withStaleState(backup).status !== 'completed' || isSimulatedBackup(backup)) {
            return res.status(400).json({ success: false, error: '此紀錄沒有可下載的備份檔' });
        }
        if (!isInsideBackupDir(backup.file) || !fs.existsSync(backup.file)) {
            return res.status(404).json({ success: false, error: '備份檔不存在' });
        }
        auditLog(req.user.username, 'Database', `Downloaded backup file: ${backup.id}`);
        res.download(path.resolve(backup.file), path.basename(backup.file));
    } catch (e) {
        handleRouteError(res, e, 'download backup');
    }
});

router.get('/backups/:dbId', checkFeature('dbBackup'), (req, res) => {
    try {
        const dbBackups = getBackups()
            .filter(b => b.dbId === req.params.dbId)
            .map(b => {
                const view = withStaleState(b);
                return { ...view, simulated: isSimulatedBackup(view), restorable: isRestorable(view) };
            });
        res.json({ success: true, backups: dbBackups });
    } catch (e) {
        handleRouteError(res, e, 'get backups');
    }
});

router.post('/backups/create', checkFeature('dbBackup'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { dbId, type = 'full' } = req.body;
        if (!dbId) return res.status(400).json({ success: false, error: 'Missing dbId' });
        if (type !== 'full') return res.status(400).json({ success: false, error: '目前只支援完整備份 (full)' });

        const target = await loadTarget(dbId);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const db = target.db;
        if (db.engine === 'SQLite' && !fs.existsSync(target.sqlitePath)) {
            return res.status(404).json({ success: false, error: `SQLite 檔案未找到: ${target.sqlitePath}` });
        }
        if (hasRunningBackup(dbId)) {
            return res.status(409).json({ success: false, error: '此資料庫已有備份正在進行' });
        }

        const { record } = startBackup(db, target.sqlitePath, req.user.username);
        res.json({ success: true, message: 'Backup started in background', backup: record });
    } catch (e) {
        handleRouteError(res, e, 'create backup');
    }
});

router.post('/backups/restore/:id', checkFeature('dbBackup'), checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const backup = getBackups().find(b => b.id === req.params.id);
        if (!backup) return res.status(404).json({ success: false, error: 'Backup not found' });
        const view = withStaleState(backup);
        if (!isRestorable(view)) {
            return res.status(400).json({ success: false, error: '此紀錄沒有可還原的備份檔（舊版的模擬紀錄、失敗或未完成的備份，或檔案已不存在）' });
        }
        if (view.restore && view.restore.status === 'running') {
            return res.status(409).json({ success: false, error: '此備份正在還原中' });
        }
        if (!isRemoteBackup(backup) && !isInsideBackupDir(backup.file)) {
            return res.status(400).json({ success: false, error: '備份檔不在備份目錄內，拒絕還原' });
        }

        const target = await loadTarget(backup.dbId);
        if (target.error) return res.status(target.status).json({ success: false, error: target.status === 404 ? 'Associated DB not found' : target.error });
        const db = target.db;

        const restoreStartedAt = new Date().toISOString();
        updateBackup(backup.id, { restore: { status: 'running', by: req.user.username, startedAt: restoreStartedAt } });

        // Run restore in background; the backup record carries the outcome
        (async () => {
            try {
                if (db.engine === 'SQLite') {
                    fs.mkdirSync(path.dirname(target.sqlitePath), { recursive: true });
                    await fs.promises.copyFile(backup.file, target.sqlitePath);
                } else {
                    await dbBackupCommand.run('restore', db, backup.file, db.password_enc ? decryptText(db.password_enc) : '');
                }
                updateBackup(backup.id, { restore: { status: 'completed', by: req.user.username, startedAt: restoreStartedAt, completedAt: new Date().toISOString() } });
                auditLog(req.user.username, 'Database', `Completed restore from snapshot: ${req.params.id}`);
            } catch (err) {
                const message = String(err.message || err).slice(0, 500);
                updateBackup(backup.id, { restore: { status: 'failed', by: req.user.username, startedAt: restoreStartedAt, error: message, completedAt: new Date().toISOString() } });
                appendLog(`[Database] Restore failed for snapshot ${req.params.id}: ${message}`);
                auditLog(req.user.username, 'Database', `Restore FAILED for snapshot: ${req.params.id}`);
            }
        })();

        auditLog(req.user.username, 'Database', `Initiated restore from snapshot: ${req.params.id}`);
        res.json({ success: true, message: 'Restore initiated successfully in background' });
    } catch (e) {
        handleRouteError(res, e, 'restore backup');
    }
});

router.delete('/backups/:id', checkFeature('dbBackup'), checkRole(['SuperAdmin']), (req, res) => {
    try {
        const allBackups = getBackups();
        const backup = allBackups.find(b => b.id === req.params.id);
        if (!backup) {
            return res.status(404).json({ success: false, error: 'Backup not found' });
        }
        const view = withStaleState(backup);
        if (view.status === 'running' || (view.restore && view.restore.status === 'running')) {
            return res.status(409).json({ success: false, error: '備份或還原進行中，不能刪除' });
        }
        saveBackups(allBackups.filter(b => b.id !== req.params.id));
        // The .bak of a SQL Server backup lives on the SQL Server host and is left to its own retention
        if (backup.file && !isRemoteBackup(backup) && isInsideBackupDir(backup.file)) {
            try { fs.unlinkSync(backup.file); } catch (e) { if (e.code !== 'ENOENT') appendLog(`[Database] Could not delete backup file ${backup.file}: ${e.message}`); }
        }
        auditLog(req.user.username, 'Database', `Deleted backup ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (e) {
        handleRouteError(res, e, 'delete backup');
    }
});

// --------------------------------------------------------------------------
// SCHEDULED BACKUP (optional)
// DB_BACKUP_SCHEDULE=HH:MM runs a real full backup of every DB once a day; unset means no scheduled backups.
// The last run day is persisted and a run only starts within an hour of the scheduled time, so a restart later in
// the day never triggers it.
// --------------------------------------------------------------------------
const SCHEDULE_WINDOW_MS = 60 * 60 * 1000;

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function runScheduledBackups(now = new Date()) {
    const m = String(process.env.DB_BACKUP_SCHEDULE || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) return { ran: false };
    const at = new Date(now);
    at.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (now < at || now - at > SCHEDULE_WINDOW_MS) return { ran: false };
    const day = localDay(now);
    if (readDataSync(BACKUP_SCHEDULE_KEY, {}).lastRunDay === day) return { ran: false };
    writeDataSync(BACKUP_SCHEDULE_KEY, { lastRunDay: day, startedAt: now.toISOString() });

    const results = { ran: true, completed: 0, failed: 0, skipped: [] };
    for (const db of getDatabases()) {
        const check = await dbTargetPolicy.checkTarget(db);
        const reason = check.error
            || (hasRunningBackup(db.id) && '已有備份進行中')
            || (db.engine === 'SQLite' && !fs.existsSync(check.sqlitePath) && 'SQLite 檔案不存在');
        if (reason) {
            results.skipped.push(db.name);
            appendLog(`[Database] Scheduled backup skipped ${db.name}: ${reason}`);
            continue;
        }
        const finished = await startBackup(db, check.sqlitePath, 'system_scheduler').done;
        if (finished && finished.status === 'completed') results.completed++;
        else results.failed++;
    }
    appendLog(`[Database] Scheduled backup finished: ${results.completed} completed, ${results.failed} failed, ${results.skipped.length} skipped`);
    return results;
}

let scheduledRunActive = false;
let lastPruneAt = 0;
setInterval(() => {
    if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
        lastPruneAt = Date.now();
        try { pruneBackups(); } catch (err) { appendLog(`[Database] Backup retention error: ${err.message}`); }
    }
    if (scheduledRunActive) return;
    scheduledRunActive = true;
    runScheduledBackups()
        .catch(err => appendLog(`[Database] Scheduled backup error: ${err.stack || err.message}`))
        .finally(() => { scheduledRunActive = false; });
}, 60000).unref(); // unref: the HTTP server keeps the process alive

// --------------------------------------------------------------------------
// METRICS API
// What SQL can report on every engine: reachability, round-trip latency of SELECT 1, connections, and a request rate
// from the server's cumulative counter (MySQL Questions = QPS, PostgreSQL commits+rollbacks = TPS,
// SQL Server Batch Requests = batches/s). The rate needs two samples, so the first poll has none.
// --------------------------------------------------------------------------
const METRICS_CACHE_MS = 4000;
const metricsCache = new Map(); // dbId -> { at, metrics, counter: { value, at } }

const METRICS_QUERIES = {
    MySQL: {
        rateKind: 'QPS',
        sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Questions')",
        read: (rows) => {
            const v = Object.fromEntries(rows.map(r => [r.Variable_name, Number(r.Value)]));
            return { connections: v.Threads_connected, counter: v.Questions };
        }
    },
    PostgreSQL: {
        rateKind: 'TPS',
        sql: `SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
                     (SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database())::bigint AS counter`,
        read: (rows) => ({ connections: Number(rows[0].connections), counter: Number(rows[0].counter) })
    },
    SQLServer: {
        rateKind: 'Batch/s',
        sql: `SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS connections,
                     (SELECT TOP 1 cntr_value FROM sys.dm_os_performance_counters WHERE RTRIM(counter_name) = 'Batch Requests/sec') AS counter`,
        read: (rows) => ({ connections: Number(rows[0].connections), counter: rows[0].counter === null ? null : Number(rows[0].counter) })
    }
};

const toNumberOrNull = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

router.get('/metrics/:id', checkFeature('dbPerformance'), async (req, res) => {
    try {
        const id = req.params.id;
        if (!getDatabases().some(d => d.id === id)) return res.status(404).json({ success: false, error: 'DB not found' });
        const cached = metricsCache.get(id);
        const now = Date.now();
        if (cached && now - cached.at < METRICS_CACHE_MS) return res.json({ success: true, metrics: cached.metrics });

        let metrics;
        let counter = null;
        const target = await loadTarget(id);
        try {
            if (target.error) throw new Error(target.error);
            const db = target.db;
            if (db.engine === 'SQLite') {
                const stats = sqliteHelper.getStorageStats(target.sqlitePath);
                if (!stats.exists) throw new Error(`SQLite 檔案不存在: ${target.sqlitePath}`);
                const t0 = Date.now();
                await sqliteHelper.executeQuery(target.sqlitePath, 'SELECT 1;');
                metrics = { reachable: true, latencyMs: Date.now() - t0, activeConnections: null, rate: null, rateKind: null, storageBytes: stats.totalBytes };
            } else {
                const spec = METRICS_QUERIES[db.engine];
                metrics = await withConnection(db, 3000, async (query) => {
                    const t0 = Date.now();
                    await query('SELECT 1');
                    const latencyMs = Date.now() - t0;
                    let read = { connections: null, counter: null };
                    try {
                        read = spec.read(await query(spec.sql));
                    } catch (e) {
                        // Usually missing VIEW SERVER STATE / pg_monitor style permissions; latency is still real
                    }
                    counter = toNumberOrNull(read.counter);
                    return { reachable: true, latencyMs, activeConnections: toNumberOrNull(read.connections), rate: null, rateKind: spec.rateKind };
                });
            }
        } catch (e) {
            metrics = { reachable: false, error: e.message || 'Connection failed', latencyMs: null, activeConnections: null, rate: null, rateKind: null };
        }

        const prev = cached && cached.counter;
        if (counter !== null && prev && counter >= prev.value && now > prev.at) {
            metrics.rate = Math.round(((counter - prev.value) / ((now - prev.at) / 1000)) * 10) / 10;
        }
        metricsCache.set(id, { at: now, metrics, counter: counter !== null ? { value: counter, at: now } : null });
        res.json({ success: true, metrics });
    } catch (e) {
        handleRouteError(res, e, 'get metrics');
    }
});

// --------------------------------------------------------------------------
// 1. POST /api/database/ai-explain
// AI SQL Advisor: Analyze query for performance, indexing, and optimization
// --------------------------------------------------------------------------
router.post('/ai-explain', checkFeature('dbSqlTerminal'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { id, query } = req.body;
        if (!query || !query.trim()) {
            return res.status(400).json({ success: false, error: 'SQL query cannot be empty' });
        }

        const dbs = getDatabases();
        const targetDb = dbs.find(d => d.id === id);
        const engine = targetDb ? targetDb.engine : 'SQL';
        const dbName = targetDb ? targetDb.name : 'Unknown';

        const aiConfig = aiRouter.getAiConfig ? aiRouter.getAiConfig() : { enabled: false };
        if (!aiConfig.enabled) {
            return res.json({
                success: true,
                warning: '系統 AI 引擎目前未啟用（可在 System Settings > AI Service 開啟）。以下為靜態規則檢測。',
                analysis: `### 🔍 靜態 SQL 分析建議（${engine}）\n` +
                          `1. **語法檢查**：請確保包含必要的 \`WHERE\` 篩選條件以避免全表掃描 (Full Table Scan)。\n` +
                          `2. **索引建議**：若有 \`WHERE\` 或 \`ORDER BY\` 條件，請在對應欄位建立複合索引 (B-Tree)。\n` +
                          `3. **分頁保護**：建議搭配 \`LIMIT / OFFSET\` 控制單次傳輸筆數，降低網路與記憶體消耗。\n` +
                          `*（提示：至後台啟用 AI 服務即可享受 LLM 深度上下文重寫建議）*`,
                isAiGenerated: false
            });
        }

        const messages = [
            {
                role: 'system',
                content: `You are an elite Database Administrator and Performance Tuning Expert for SOMP Vanguard.
Analyze the user's SQL query for target database engine "${engine}".
Provide a concise, highly structured Markdown report in Traditional Chinese (繁體中文):
1. **執行計畫與盲點評估** (Performance & Execution Bottlenecks, e.g. Full Table Scan, Temp Tables, Cartesian Product)
2. **建議建立之索引** (Recommended Indexes DDL with brief reasoning)
3. **最佳化改寫範本** (Optimized SQL Rewrite in code block)
4. **維運安全提醒** (Operational & Safety Warning)`
            },
            {
                role: 'user',
                content: `Target Database: ${dbName} (${engine})\nSQL Query:\n\`\`\`sql\n${query}\n\`\`\``
            }
        ];

        const aiResponse = await aiRouter.callAiEngine(aiConfig, messages);
        auditLog(req.user.username, 'Database', `Requested AI SQL Advisor on ${dbName}`);
        res.json({
            success: true,
            analysis: aiResponse.content,
            model: aiResponse.model,
            provider: aiResponse.provider,
            isAiGenerated: true
        });
    } catch (e) {
        handleRouteError(res, e, 'AI Explain');
    }
});

// --------------------------------------------------------------------------
// 2. GET /api/database/processes/:id
// Capture Active Sessions & Running Queries
// --------------------------------------------------------------------------
// What "kill" does per engine: MySQL and PostgreSQL cancel the running statement and keep the session;
// SQL Server has no cancel for another session, so KILL ends the whole session and rolls back its transaction
const KILL_MODE = { MySQL: 'cancel-query', PostgreSQL: 'cancel-query', SQLServer: 'kill-session' };

const PROCESS_QUERIES = {
    MySQL: {
        sql: 'SHOW FULL PROCESSLIST',
        map: (r, db) => ({ id: r.Id, user: r.User, host: r.Host, db: r.db || db.database, command: r.Command, time: r.Time, state: r.State || 'executing', info: r.Info || '' })
    },
    PostgreSQL: {
        sql: `SELECT pid, usename, client_addr, state,
                     COALESCE(ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))::int, 0) AS duration_sec,
                     query
              FROM pg_stat_activity
              WHERE pid <> pg_backend_pid() AND datname = current_database()
              ORDER BY duration_sec DESC LIMIT 50`,
        map: (r, db) => ({ id: r.pid, user: r.usename, host: r.client_addr || 'local', db: db.database, command: r.state || 'active', time: r.duration_sec, state: r.state, info: r.query || '' })
    },
    SQLServer: {
        sql: `SELECT r.session_id, s.login_name, s.host_name, r.status, r.command,
                     (r.total_elapsed_time / 1000) AS time_sec, t.text AS query_text
              FROM sys.dm_exec_requests r
              CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
              JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
              WHERE r.session_id <> @@SPID AND s.is_user_process = 1`,
        map: (r, db) => ({ id: r.session_id, user: r.login_name, host: r.host_name, db: db.database, command: r.command, time: r.time_sec, state: r.status, info: r.query_text })
    }
};

router.get('/processes/:id', checkFeature('dbPerformance'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const target = await loadTarget(req.params.id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const targetDb = target.db;

        if (targetDb.engine === 'SQLite') {
            // A SQLite file has no server sessions; show its storage state instead
            const stats = sqliteHelper.getStorageStats(target.sqlitePath);
            return res.json({
                success: true,
                killMode: null,
                processes: [{
                    id: 1, user: 'local_file', host: 'localhost', db: path.basename(target.sqlitePath), command: 'FILE', time: 0,
                    state: stats.walBytes > 0 ? 'WAL Active' : 'Normal',
                    info: stats.exists ? `Storage total: ${(stats.totalBytes / 1024).toFixed(1)} KB` : 'File not found'
                }]
            });
        }

        const spec = PROCESS_QUERIES[targetDb.engine];
        let processes;
        try {
            processes = await withConnection(targetDb, 3000, async (query) => (await query(spec.sql)).map(r => spec.map(r, targetDb)));
        } catch (dbErr) {
            return res.status(502).json({ success: false, error: dbErr.message || 'Failed to read sessions' });
        }
        res.json({ success: true, processes, killMode: KILL_MODE[targetDb.engine] });
    } catch (e) {
        handleRouteError(res, e, 'get processes');
    }
});

// --------------------------------------------------------------------------
// POST /api/database/kill-process
// Terminate an active query/session (Emergency Stop)
// --------------------------------------------------------------------------
router.post('/kill-process', checkFeature('dbPerformance'), checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const { dbId, processId } = req.body;
        if (!dbId || processId === undefined || processId === null || processId === '') {
            return res.status(400).json({ success: false, error: 'dbId and processId are required' });
        }
        const pidNum = Number(processId);
        if (!Number.isInteger(pidNum) || pidNum <= 0) {
            return res.status(400).json({ success: false, error: 'processId must be a positive integer' });
        }

        const target = await loadTarget(dbId);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const targetDb = target.db;
        if (targetDb.engine === 'SQLite') {
            return res.status(400).json({ success: false, error: 'Kill process not applicable to SQLite local files' });
        }

        let message;
        try {
            message = await withConnection(targetDb, 3000, async (query) => {
                if (targetDb.engine === 'MySQL') {
                    await query(`KILL QUERY ${pidNum}`);
                    return `Query of thread ${pidNum} cancelled (the connection stays open).`;
                }
                if (targetDb.engine === 'PostgreSQL') {
                    const [r] = await query('SELECT pg_cancel_backend($1) AS ok', [pidNum]);
                    if (!r || r.ok !== true) throw new Error(`PID ${pidNum} not found or the statement could not be cancelled`);
                    return `Query of PID ${pidNum} cancelled (the session stays open).`;
                }
                // SQL Server: only user sessions may be killed
                const [s] = await query('SELECT is_user_process FROM sys.dm_exec_sessions WHERE session_id = @sid', { sid: pidNum });
                if (!s) throw new Error(`Session ${pidNum} not found`);
                if (!s.is_user_process) throw new Error(`Session ${pidNum} is a system session and cannot be killed`);
                await query(`KILL ${pidNum}`);
                return `Session ${pidNum} killed; its open transaction is rolled back.`;
            });
        } catch (dbErr) {
            return res.status(400).json({ success: false, error: dbErr.message || 'Kill failed' });
        }

        auditLog(req.user.username, 'Database', `EMERGENCY KILL (${KILL_MODE[targetDb.engine]}) executed on ${targetDb.name} for PID ${pidNum}`);
        res.json({ success: true, message, killMode: KILL_MODE[targetDb.engine] });
    } catch (e) {
        handleRouteError(res, e, 'kill process');
    }
});

// --------------------------------------------------------------------------
// 3. GET /api/database/insights/:id
// Slow queries (Top 10 by total time) and sessions waiting on locks. Each part needs a source the DBA may not have
// enabled (performance_schema, pg_stat_statements, VIEW SERVER STATE); a missing source becomes a note, not an error.
// --------------------------------------------------------------------------
const INSIGHT_QUERIES = {
    MySQL: {
        slow: {
            sql: `SELECT DIGEST_TEXT AS query_text, COUNT_STAR AS calls,
                         ROUND(SUM_TIMER_WAIT / 1000000000, 1) AS total_ms, ROUND(AVG_TIMER_WAIT / 1000000000, 1) AS avg_ms
                  FROM performance_schema.events_statements_summary_by_digest
                  WHERE SCHEMA_NAME = DATABASE()
                  ORDER BY SUM_TIMER_WAIT DESC LIMIT 10`,
            note: '需要啟用 performance_schema，且帳號可讀取 performance_schema'
        },
        locks: {
            sql: `SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, wait_age_secs
                  FROM sys.innodb_lock_waits ORDER BY wait_age_secs DESC LIMIT 20`,
            map: r => ({ waitingId: r.waiting_pid, waitingQuery: r.waiting_query, blockingId: r.blocking_pid, blockingQuery: r.blocking_query, waitSec: Number(r.wait_age_secs) }),
            note: '需要 MySQL 5.7 以上的 sys schema 與讀取權限'
        }
    },
    PostgreSQL: {
        slow: {
            // mean_exec_time / total_exec_time from PostgreSQL 13; older versions name them mean_time / total_time
            sql: [
                `SELECT query AS query_text, calls, ROUND(total_exec_time::numeric, 1) AS total_ms, ROUND(mean_exec_time::numeric, 1) AS avg_ms
                 FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                 ORDER BY total_exec_time DESC LIMIT 10`,
                `SELECT query AS query_text, calls, ROUND(total_time::numeric, 1) AS total_ms, ROUND(mean_time::numeric, 1) AS avg_ms
                 FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                 ORDER BY total_time DESC LIMIT 10`
            ],
            note: '需要安裝 pg_stat_statements 擴充套件（並列入 shared_preload_libraries）'
        },
        locks: {
            sql: `SELECT pid, pg_blocking_pids(pid) AS blocked_by, query,
                         COALESCE(ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))::int, 0) AS wait_sec
                  FROM pg_stat_activity
                  WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
                  ORDER BY wait_sec DESC LIMIT 20`,
            map: r => ({ waitingId: r.pid, waitingQuery: r.query, blockingId: (r.blocked_by || []).join(', '), blockingQuery: null, waitSec: r.wait_sec }),
            note: '需要可讀取 pg_stat_activity 的權限（pg_monitor）'
        }
    },
    SQLServer: {
        slow: {
            sql: `SELECT TOP 10 SUBSTRING(t.text, 1, 2000) AS query_text, s.execution_count AS calls,
                         s.total_elapsed_time / 1000 AS total_ms, (s.total_elapsed_time / NULLIF(s.execution_count, 0)) / 1000 AS avg_ms
                  FROM sys.dm_exec_query_stats s CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
                  WHERE t.dbid = DB_ID()
                  ORDER BY s.total_elapsed_time DESC`,
            note: '需要 VIEW SERVER STATE 權限'
        },
        locks: {
            sql: `SELECT TOP 20 r.session_id, r.blocking_session_id, r.wait_type, r.wait_time / 1000 AS wait_sec, t.text AS query_text
                  FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
                  WHERE r.blocking_session_id <> 0
                  ORDER BY r.wait_time DESC`,
            map: r => ({ waitingId: r.session_id, waitingQuery: r.query_text, blockingId: r.blocking_session_id, blockingQuery: null, waitSec: r.wait_sec, waitType: r.wait_type }),
            note: '需要 VIEW SERVER STATE 權限'
        }
    }
};

async function firstWorking(query, sqls) {
    let lastErr;
    for (const s of [].concat(sqls)) {
        try { return await query(s); } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

router.get('/insights/:id', checkFeature('dbPerformance'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const target = await loadTarget(req.params.id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const db = target.db;
        if (db.engine === 'SQLite') {
            return res.json({ success: true, slowQueries: [], lockWaits: [], notes: ['SQLite 沒有查詢統計與鎖等待資訊'] });
        }
        const spec = INSIGHT_QUERIES[db.engine];
        const notes = [];
        let slowQueries = [];
        let lockWaits = [];
        try {
            await withConnection(db, 4000, async (query) => {
                try {
                    slowQueries = (await firstWorking(query, spec.slow.sql)).map(r => ({
                        query: r.query_text, calls: Number(r.calls), totalMs: Number(r.total_ms), avgMs: r.avg_ms === null ? null : Number(r.avg_ms)
                    }));
                } catch (e) {
                    notes.push(`慢查詢：${spec.slow.note}（${e.message}）`);
                }
                try {
                    lockWaits = (await query(spec.locks.sql)).map(spec.locks.map);
                } catch (e) {
                    notes.push(`鎖等待：${spec.locks.note}（${e.message}）`);
                }
            });
        } catch (dbErr) {
            return res.status(502).json({ success: false, error: dbErr.message || 'Connection failed' });
        }
        res.json({ success: true, slowQueries, lockWaits, notes });
    } catch (e) {
        handleRouteError(res, e, 'get insights');
    }
});

// --------------------------------------------------------------------------
// 4. GET /api/database/schema/:id
// Schema Explorer: Fetch tables, columns, data types, and constraints
// --------------------------------------------------------------------------
/** @returns {Promise<Object<string, Array<{name, type, notnull, pk, dflt_value?}>>>} table name -> columns */
async function fetchSchema(db, sqlitePath) {
    if (db.engine === 'SQLite') return sqliteHelper.getSchemaDetails(sqlitePath);
    const schema = {};
    const add = (table, col) => { (schema[table] = schema[table] || []).push(col); };
    await withConnection(db, 4000, async (query) => {
        if (db.engine === 'MySQL') {
            const cols = await query(`
                SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ?
                ORDER BY TABLE_NAME, ORDINAL_POSITION;
            `, [db.database]);
            cols.forEach(c => add(c.TABLE_NAME, { name: c.COLUMN_NAME, type: c.DATA_TYPE, notnull: c.IS_NULLABLE === 'NO', pk: c.COLUMN_KEY === 'PRI', dflt_value: c.COLUMN_DEFAULT }));
        } else if (db.engine === 'PostgreSQL') {
            const cols = await query(`
                SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
                       CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END as is_pk
                FROM information_schema.columns c
                LEFT JOIN information_schema.key_column_usage kcu
                       ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name AND c.column_name = kcu.column_name
                LEFT JOIN information_schema.table_constraints tc
                       ON kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name AND kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
                WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
                ORDER BY c.table_schema, c.table_name, c.ordinal_position;
            `);
            // Tables outside the default schema are shown as schema.table
            cols.forEach(c => add(c.table_schema === 'public' ? c.table_name : `${c.table_schema}.${c.table_name}`, { name: c.column_name, type: c.data_type, notnull: c.is_nullable === 'NO', pk: !!c.is_pk }));
        } else if (db.engine === 'SQLServer') {
            const cols = await query(`
                SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
                       CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN (
                    SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
                ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
            `);
            cols.forEach(c => add(c.TABLE_SCHEMA === 'dbo' ? c.TABLE_NAME : `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`, { name: c.COLUMN_NAME, type: c.DATA_TYPE, notnull: c.IS_NULLABLE === 'NO', pk: c.IS_PK === 1 }));
        }
    });
    return schema;
}

router.get('/schema/:id', checkFeature('dbSqlTerminal'), checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    try {
        const target = await loadTarget(req.params.id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const schema = await fetchSchema(target.db, target.sqlitePath);
        res.json({ success: true, schema, tablesCount: Object.keys(schema).length });
    } catch (e) {
        handleRouteError(res, e, 'get schema');
    }
});

// --------------------------------------------------------------------------
// 5. GET /api/database/health/:id
// Health & Storage: total size and the 10 largest tables, read from the engine's own catalog
// --------------------------------------------------------------------------
const kb = (bytes) => (Number(bytes || 0) / 1024).toFixed(2);

async function readHealth(db, sqlitePath) {
    const health = { engine: db.engine, status: 'HEALTHY', storage: {}, topTables: [] };
    if (db.engine === 'SQLite') {
        const stats = sqliteHelper.getStorageStats(sqlitePath);
        if (!stats.exists) throw new Error(`SQLite 檔案不存在: ${sqlitePath}`);
        health.storage = { mainKb: kb(stats.mainBytes), walKb: kb(stats.walBytes), totalKb: kb(stats.totalBytes), lastModified: stats.updatedAt };
        try {
            // dbstat is an optional SQLite module; indexes count toward their table
            const rows = await sqliteHelper.executeQuery(sqlitePath, `
                SELECT m.tbl_name AS tableName, SUM(d.pgsize) AS bytes
                FROM dbstat d JOIN sqlite_master m ON m.name = d.name
                WHERE m.type IN ('table', 'index') AND m.tbl_name NOT LIKE 'sqlite_%'
                GROUP BY m.tbl_name ORDER BY bytes DESC LIMIT 10;`);
            health.topTables = rows.map(r => ({ tableName: r.tableName, sizeKb: kb(r.bytes) }));
        } catch (e) {
            const tables = await sqliteHelper.getTables(sqlitePath);
            health.topTables = tables.slice(0, 10).map(name => ({ tableName: name, sizeKb: null }));
            health.note = '此 SQLite 不支援 dbstat，無法計算各資料表大小';
        }
        return health;
    }
    await withConnection(db, 4000, async (query) => {
        if (db.engine === 'MySQL') {
            const [total] = await query(`
                SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.TABLES WHERE table_schema = ?;
            `, [db.database]);
            const rows = await query(`
                SELECT table_name AS tableName, (data_length + index_length) AS bytes, table_rows AS rowEstimate
                FROM information_schema.TABLES
                WHERE table_schema = ?
                ORDER BY (data_length + index_length) DESC LIMIT 10;
            `, [db.database]);
            health.storage = { totalKb: kb(total.bytes) };
            health.topTables = rows.map(r => ({ tableName: r.tableName, sizeKb: kb(r.bytes), rowEstimate: r.rowEstimate }));
        } else if (db.engine === 'PostgreSQL') {
            const [total] = await query('SELECT pg_database_size(current_database()) AS bytes');
            const rows = await query(`
                SELECT n.nspname AS schema_name, c.relname AS table_name, pg_total_relation_size(c.oid) AS bytes,
                       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
                ORDER BY bytes DESC LIMIT 10
            `);
            health.storage = { totalKb: kb(total.bytes) };
            health.topTables = rows.map(r => ({
                tableName: r.schema_name === 'public' ? r.table_name : `${r.schema_name}.${r.table_name}`,
                sizeKb: kb(r.bytes),
                rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate)
            }));
        } else if (db.engine === 'SQLServer') {
            const [total] = await query(`
                SELECT SUM(CAST(size AS bigint)) * 8192 AS bytes,
                       SUM(CASE WHEN type = 1 THEN CAST(size AS bigint) ELSE 0 END) * 8192 AS log_bytes
                FROM sys.database_files
            `);
            const rows = await query(`
                SELECT TOP 10 s.name AS schema_name, t.name AS table_name,
                       (SELECT SUM(a.total_pages) FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE p.object_id = t.object_id) * 8192 AS bytes,
                       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS row_estimate
                FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
                ORDER BY bytes DESC
            `);
            health.storage = { totalKb: kb(total.bytes), logKb: kb(total.log_bytes) };
            health.topTables = rows.map(r => ({
                tableName: r.schema_name === 'dbo' ? r.table_name : `${r.schema_name}.${r.table_name}`,
                sizeKb: kb(r.bytes),
                rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate)
            }));
        }
    });
    return health;
}

router.get('/health/:id', checkFeature('dbPerformance'), checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    try {
        const target = await loadTarget(req.params.id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        let health;
        try {
            health = await readHealth(target.db, target.sqlitePath);
        } catch (dbErr) {
            appendLog(`[Database] Health check failed on ${target.db.name}: ${dbErr.message}`);
            return res.status(502).json({ success: false, error: dbErr.message || 'Health check failed' });
        }
        res.json({ success: true, health });
    } catch (e) {
        handleRouteError(res, e, 'get health');
    }
});

// --------------------------------------------------------------------------
// POST /api/database/vacuum
// SQLite Database Defragmentation & Vacuum Execution
// --------------------------------------------------------------------------
router.post('/vacuum', checkFeature('dbInventory'), checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const { id } = req.body;
        const target = await loadTarget(id);
        if (target.error) return res.status(target.status).json({ success: false, error: target.error });
        const targetDb = target.db;
        if (targetDb.engine !== 'SQLite') {
            return res.status(400).json({ success: false, error: 'VACUUM command is exclusively supported for SQLite files' });
        }

        const result = await sqliteHelper.executeVacuum(target.sqlitePath);
        auditLog(req.user.username, 'Database', `Executed VACUUM on ${targetDb.name}. Freed: ${(result.freedBytes / 1024).toFixed(2)} KB`);
        res.json({
            success: true,
            message: `VACUUM 成功！磁碟釋放: ${(result.freedBytes / 1024).toFixed(2)} KB，當前檔案大小: ${(result.afterBytes / 1024).toFixed(2)} KB`,
            result
        });
    } catch (e) {
        handleRouteError(res, e, 'execute vacuum');
    }
});

// --------------------------------------------------------------------------
// 6. POST /api/database/schema-diff
// Schema Migration & Diff: Compare schemas between 2 database instances
// --------------------------------------------------------------------------
router.post('/schema-diff', checkFeature('dbInventory'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { sourceId, targetId } = req.body;
        if (!sourceId || !targetId) {
            return res.status(400).json({ success: false, error: 'Both sourceId and targetId are required' });
        }

        const src = await loadTarget(sourceId);
        const tgt = await loadTarget(targetId);
        if (src.status === 404 || tgt.status === 404) {
            return res.status(404).json({ success: false, error: 'Source or Target database not found' });
        }
        if (src.error || tgt.error) return res.status(400).json({ success: false, error: src.error || tgt.error });
        const srcDb = src.db;
        const tgtDb = tgt.db;

        let srcSchema;
        let tgtSchema;
        try {
            srcSchema = await fetchSchema(srcDb, src.sqlitePath);
        } catch (dbErr) {
            return res.status(502).json({ success: false, error: `讀取來源資料庫結構失敗: ${dbErr.message}` });
        }
        try {
            tgtSchema = await fetchSchema(tgtDb, tgt.sqlitePath);
        } catch (dbErr) {
            return res.status(502).json({ success: false, error: `讀取目標資料庫結構失敗: ${dbErr.message}` });
        }

        // An empty side usually means missing permissions, not an empty database: never report that as "identical"
        const warnings = [];
        const srcEmpty = Object.keys(srcSchema).length === 0;
        const tgtEmpty = Object.keys(tgtSchema).length === 0;
        if (srcEmpty) warnings.push('來源資料庫讀不到任何資料表（帳號權限不足或資料庫為空），無法判斷差異。');
        if (tgtEmpty && !srcEmpty) warnings.push('目標資料庫讀不到任何資料表（帳號權限不足或資料庫為空），以下差異可能不準確。');
        if (srcDb.engine !== tgtDb.engine) {
            warnings.push(`來源 (${srcDb.engine}) 與目標 (${tgtDb.engine}) 引擎不同，資料型態名稱不能直接比較，產生的 SQL 僅供參考。`);
        }

        const missingTables = [];
        const missingColumns = [];
        const typeMismatches = [];
        const migrationSql = [];

        // Compare Source vs Target
        Object.keys(srcSchema).forEach(table => {
            if (!tgtSchema[table]) {
                missingTables.push(table);
                const colDefs = srcSchema[table].map(c => `  ${c.name} ${c.type}`).join(',\n');
                migrationSql.push(`-- 補齊缺少之資料表: ${table}\nCREATE TABLE ${table} (\n${colDefs}\n);`);
            } else {
                const tgtCols = tgtSchema[table] || [];
                const tgtColMap = new Map(tgtCols.map(c => [c.name.toLowerCase(), c]));

                srcSchema[table].forEach(srcCol => {
                    const tgtCol = tgtColMap.get(srcCol.name.toLowerCase());
                    if (!tgtCol) {
                        missingColumns.push({ table, column: srcCol.name, type: srcCol.type });
                        migrationSql.push(`ALTER TABLE ${table} ADD COLUMN ${srcCol.name} ${srcCol.type};`);
                    } else if (String(tgtCol.type).toLowerCase() !== String(srcCol.type).toLowerCase()) {
                        typeMismatches.push({
                            table,
                            column: srcCol.name,
                            sourceType: srcCol.type,
                            targetType: tgtCol.type
                        });
                        migrationSql.push(`-- 注意: 型態差異 ${table}.${srcCol.name}: ${tgtCol.type} -> ${srcCol.type}`);
                    }
                });
            }
        });

        auditLog(req.user.username, 'Database', `Computed schema diff between ${srcDb.name} (${srcDb.environment}) and ${tgtDb.name} (${tgtDb.environment})`);

        const noDiffText = srcEmpty
            ? '-- 來源資料庫沒有可比對的資料表，未產生遷移 SQL。'
            : '-- 兩端資料庫結構完全一致，無需遷移變更。';
        res.json({
            success: true,
            sourceName: `${srcDb.name} (${srcDb.environment})`,
            targetName: `${tgtDb.name} (${tgtDb.environment})`,
            diffSummary: {
                missingTablesCount: missingTables.length,
                missingColumnsCount: missingColumns.length,
                typeMismatchesCount: typeMismatches.length
            },
            sourceTablesCount: Object.keys(srcSchema).length,
            targetTablesCount: Object.keys(tgtSchema).length,
            warnings,
            missingTables,
            missingColumns,
            typeMismatches,
            migrationSql: migrationSql.join('\n\n') || noDiffText
        });

    } catch (e) {
        handleRouteError(res, e, 'schema diff');
    }
});

// Test hooks
router._test = { runScheduledBackups, pruneBackups, metricsCache };

module.exports = router;

