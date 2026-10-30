process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

// Suppress Node.js experimental feature warnings (e.g., node:sqlite ExperimentalWarning)
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) return;
    if (args[0] === 'ExperimentalWarning' || (typeof warning === 'object' && warning?.name === 'ExperimentalWarning')) {
        if (String(warning?.message || warning).includes('SQLite')) return;
    }
    return originalEmitWarning.call(process, warning, ...args);
};

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

const getFormattedTime = () => {
    const now = new Date();
    const tz = process.env.SYSTEM_TIMEZONE || 'Asia/Taipei';
    try {
        return now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
    } catch (e) {
        return now.toISOString();
    }
};

const hasTimestamp = (arg) => {
    if (typeof arg !== 'string') return false;
    return /^\[\d{4}-\d{2}-\d{2}/.test(arg);
};

console.log = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalLog(...args);
    } else {
        originalLog(`[${getFormattedTime()}]`, ...args);
    }
};
console.error = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalError(...args);
    } else {
        originalError(`[${getFormattedTime()}]`, ...args);
    }
};
console.warn = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalWarn(...args);
    } else {
        originalWarn(`[${getFormattedTime()}]`, ...args);
    }
};
console.info = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalInfo(...args);
    } else {
        originalInfo(`[${getFormattedTime()}]`, ...args);
    }
};

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Initialize dotenv BEFORE loading any internal modules that depend on env vars
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const { initWebSocketServer } = require('./lib/websocket');
const { initGuacamoleProxy } = require('./services/guacamoleProxy');
const fs = require('fs');
const dbModule = require('./lib/db');
const docRegistry = require('./lib/docRegistry');

// --- SQLite Virtual File System (VFS) Intercept ---
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalExistsSync = fs.existsSync;
const originalReadFile = fs.promises.readFile;
const originalWriteFile = fs.promises.writeFile;

const SAVE_DATA_DIR = path.resolve(process.env.DB_DATA_DIR || 'C:\\\\ProgramData\\\\somp-vanguard').toLowerCase();

function isSaveDataJson(filepath) {
    if (typeof filepath !== 'string') return false;
    const absPath = path.resolve(filepath).toLowerCase();
    if (!(absPath.startsWith(SAVE_DATA_DIR) && absPath.endsWith('.json'))) return false;
    // A flat file whose name is a '/' <-> '_' variant of a registered document key (e.g. the fallback copy
    // network_service_ipam_subnets.json that lib/db.js reads / writes) is a plain file: mapping it to a document key
    // would read a stale alias row or create one (see lib/docRegistry.js isAliasKey, scripts/cleanup_doc_aliases.js).
    return !docRegistry.isAliasKey(getDbKey(filepath));
}

function syncFsDelay(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }
}

function getDbKey(filepath) {
    const absPath = path.resolve(filepath);
    const relPath = path.relative(path.resolve(process.env.DB_DATA_DIR || 'C:\\\\ProgramData\\\\somp-vanguard'), absPath);
    return relPath.replace(/\\/g, '/');
}

fs.readFileSync = function(pathArg, options) {
    if (isSaveDataJson(pathArg)) {
        if (!dbModule.db) return originalReadFileSync.apply(this, arguments);
        const key = getDbKey(pathArg);
        const maxAttempts = 5;
        let foundInDb = false;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const raw = dbModule.db.prepare('SELECT value FROM document_store WHERE key = ?').get(key);
                if (raw && raw.value) {
                    foundInDb = true;
                    return raw.value;
                }
                break; // Not found in SQLite, break to fallback check
            } catch (e) {
                const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 25 * Math.pow(2, attempt) + Math.floor(Math.random() * 20);
                    syncFsDelay(delay);
                    continue;
                }
                break;
            }
        }

        // Fallback: If not in SQLite (e.g. manually copied or restored file), read from physical disk
        if (!foundInDb && originalExistsSync(pathArg)) {
            try {
                const diskContent = originalReadFileSync.apply(this, arguments);
                // Auto-sync into SQLite document_store for future requests
                try {
                    dbModule.db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run(key, diskContent);
                } catch (syncErr) {}
                return diskContent;
            } catch (diskErr) {
                throw diskErr;
            }
        }

        const err = new Error(`ENOENT: no such file or directory, open '${pathArg}'`);
        err.code = 'ENOENT';
        throw err;
    }
    return originalReadFileSync.apply(this, arguments);
};

fs.writeFileSync = function(pathArg, data, options) {
    if (isSaveDataJson(pathArg)) {
        const key = getDbKey(pathArg);
        const strData = typeof data === 'string' ? data : data.toString();
        
        // 1. Write to SQLite with exponential backoff if DB available
        if (dbModule.db) {
            const maxAttempts = 5;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    dbModule.db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run(key, strData);
                    break;
                } catch (e) {
                    const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
                    if (isLocked && attempt < maxAttempts - 1) {
                        const delay = 30 * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
                        syncFsDelay(delay);
                        continue;
                    }
                    console.warn(`[index.js writeFileSync] SQLite write failed for key ${key}:`, e.message);
                    break;
                }
            }
        }

        // 2. Dual-Write: Also persist to physical file on disk for redundancy & manual backup compatibility
        try {
            const dir = path.dirname(path.resolve(pathArg));
            if (!originalExistsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            originalWriteFileSync.apply(this, arguments);
        } catch (diskWriteErr) {
            // Non-critical if SQLite succeeded
        }

        // 3. Keep in-memory cache updated
        try {
            dbModule.invalidateCache(key, strData);
        } catch (e) {}

        return;
    }
    return originalWriteFileSync.apply(this, arguments);
};

fs.existsSync = function(pathArg) {
    if (isSaveDataJson(pathArg)) {
        if (!dbModule.db) return originalExistsSync.apply(this, arguments);
        const key = getDbKey(pathArg);
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const raw = dbModule.db.prepare('SELECT 1 FROM document_store WHERE key = ?').get(key);
                if (raw) return true;
                break; // Not in SQLite, break to check physical disk
            } catch (e) {
                const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
                if (isLocked && attempt < maxAttempts - 1) {
                    const delay = 25 * Math.pow(2, attempt) + Math.floor(Math.random() * 20);
                    syncFsDelay(delay);
                    continue;
                }
                break;
            }
        }
        // Fallback: If not in SQLite, check physical disk directly
        return originalExistsSync.apply(this, arguments);
    }
    return originalExistsSync.apply(this, arguments);
};

fs.promises.readFile = async function(pathArg, options) {
    if (isSaveDataJson(pathArg)) {
        return fs.readFileSync(pathArg, options);
    }
    return originalReadFile.apply(this, arguments);
};

fs.promises.writeFile = async function(pathArg, data, options) {
    if (isSaveDataJson(pathArg)) {
        fs.writeFileSync(pathArg, data, options);
        return;
    }
    return originalWriteFile.apply(this, arguments);
};
// --- End SQLite VFS Intercept ---
// 1. Define global reload config helper
global.reloadEnv = function() {
    require('./lib/loadEnv').loadEnv({ rewrite: true, logger: console });
};

// 2. Load variables FIRST on startup
global.reloadEnv();

// 3. Assert JWT_SECRET exists
if (!process.env.JWT_SECRET) {
    console.error('CRITICAL ERROR: JWT_SECRET environment variable is missing. Aborting startup.');
    process.exit(1);
}

const { startLogRotation, auditLog } = require('./lib/logger');

// --- Global Process Crash Handlers (prevents silent crashes) ---
process.on('uncaughtException', (err) => {
    const rawMsg = err?.message || String(err);
    const msg = rawMsg.toLowerCase();
    const code = err?.code;

    // Network disconnect, socket reset, websocket teardown, or guacd/proxy errors should NEVER crash the production backend!
    if (
        code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ||
        msg.includes('econnreset') || msg.includes('epipe') || msg.includes('websocket') ||
        msg.includes('guacd') || msg.includes('guacamole') || msg.includes('socket') || msg.includes('closed') || msg.includes('token') ||
        msg.includes('handshake') || msg.includes('abort') || msg.includes('unhandled \'error\'') ||
        msg.includes('connection') || msg.includes('decrypt')
    ) {
        console.warn('[Process] Non-fatal network/proxy error caught and contained:', rawMsg);
        return;
    }
    console.error('[CRITICAL] Uncaught Exception:', err);
    try { auditLog('SYSTEM', 'Process', `Uncaught Exception: ${rawMsg}`); } catch (e) {}
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const rawMsg = reason?.message || String(reason);
    const msg = rawMsg.toLowerCase();
    const code = reason?.code;

    if (
        code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ||
        msg.includes('econnreset') || msg.includes('epipe') || msg.includes('websocket') ||
        msg.includes('guacd') || msg.includes('guacamole') || msg.includes('socket') || msg.includes('closed') || msg.includes('token') ||
        msg.includes('handshake') || msg.includes('abort') || msg.includes('unhandled \'error\'') ||
        msg.includes('connection') || msg.includes('decrypt')
    ) {
        console.warn('[Process] Non-fatal network/proxy rejection caught and contained:', rawMsg);
        return;
    }
    console.error('[CRITICAL] Unhandled Rejection:', reason);
    try { auditLog('SYSTEM', 'Process', `Unhandled Rejection: ${rawMsg}`); } catch (e) {}
    process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 5000;

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
const globalJsonParser = express.json({ limit: '10mb' });
// HM_checker backup upload accepts up to 50 MB: its own (larger) parser runs inside the router after auth/RBAC checks
app.use(require('./lib/skipPaths').skipPaths(globalJsonParser, ['/api/hm-checker/upload-backup']));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Global Security Hardening Headers (CSP, Clickjacking, MIME-Sniffing) ---
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self' http: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none';");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
});

// --- IP Whitelist Middleware ---
app.use((req, res, next) => {
    const isApi = req.path.startsWith('/api/');
    let allowedIpsStr = '';
    let accessType = 'FRONTEND';

    if (isApi) {
        allowedIpsStr = process.env.API_ALLOWED_IPS || '';
        accessType = 'API';
    } else {
        allowedIpsStr = process.env.FRONTEND_ALLOWED_IPS || '';
    }
    
    if (!allowedIpsStr.trim()) return next(); // Allow all if specific list is empty

    const allowedIps = allowedIpsStr.split(',').map(ip => ip.trim());
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const cleanIp = clientIp.startsWith('::ffff:') ? clientIp.substring(7) : clientIp;
    
    // Always allow localhost for safety
    if (cleanIp === '127.0.0.1' || cleanIp === '::1') return next();

    if (allowedIps.includes(cleanIp)) {
        return next();
    }

    // If not allowed, send Access Denied
    console.warn(`[Security] Blocked unauthorized access attempt to ${accessType} from IP: ${cleanIp}`);
    
    if (req.accepts('html') && !isApi) {
        res.status(403).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Access Denied - Security System</title>
                <style>
                    :root { --bg: #0f172a; --text: #f8fafc; --primary: #3b82f6; --error: #ef4444; }
                    body { margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; height: 100vh; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--text); text-align: center; overflow: hidden; }
                    .container { max-width: 500px; padding: 2.5rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 1.5rem; backdrop-filter: blur(10px); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
                    .icon { font-size: 4rem; color: var(--error); margin-bottom: 1.5rem; }
                    h1 { margin: 0 0 1rem; font-size: 2rem; font-weight: 600; color: #fff; }
                    p { color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
                    .info { font-size: 0.875rem; padding: 0.75rem; background: rgba(0,0,0,0.2); border-radius: 0.5rem; color: #64748b; font-family: monospace; border: 1px solid rgba(255,255,255,0.05); }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">🔒</div>
                    <h1>${accessType} Access Denied</h1>
                    <p>Your current IP address is not authorized to access the system. Please contact your system administrator to update the whitelist.</p>
                    <div class="info">Client IP: ${cleanIp}</div>
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(403).json({ error: 'Access Denied', message: `IP address not authorized for ${accessType}` });
    }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/kubernetes', require('./routes/kubernetes'));
app.use('/api/rbac', require('./routes/rbac'));
app.use('/api/settings', require('./routes/apiSettings'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/records', require('./routes/records'));
app.use('/api/ops', require('./routes/ops'));
app.use('/api/fortiproxy', require('./routes/fortiproxy'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/squid', require('./routes/squid'));
app.use('/api/elk', require('./routes/elk'));
app.use('/api/ad', require('./routes/ad'));
app.use('/api/install', require('./routes/install'));
app.use('/api/prometheus', require('./routes/prometheus'));
app.use('/api/siem', require('./routes/siem'));
app.use('/api/monitor-siem', require('./routes/monitorSiem'));
app.use('/api/nutanix', require('./routes/nutanix'));
app.use('/api/rack', require('./routes/rack'));
app.use('/api/redis', require('./routes/redis'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/ipam', require('./routes/ipam'));
app.use('/api/ssl', require('./routes/ssl'));
app.use('/api/scheduler', require('./routes/scheduler'));
app.use('/api/gpo', require('./routes/gpo'));
app.use('/api/netsearch', require('./routes/netsearch'));
app.use('/api/network-device', require('./routes/networkDevice'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/health', require('./routes/health'));
app.use('/api/environments', require('./routes/environments'));
app.use('/api/cmd-library', require('./routes/cmdLibrary'));
app.use('/api/workflow', require('./routes/workflow'));
app.use('/api/runbook', require('./routes/runbook'));
app.use('/api/database', require('./routes/database'));
app.use('/api/monitor/forensics', require('./routes/forensics'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/integration', require('./routes/integration'));
app.use('/api/server-list', require('./routes/serverList'));
app.use('/api/cmdb-server-list', require('./routes/serverList').cmdbRouter);
app.use('/api/hm-checker', require('./routes/hmChecker'));
app.use('/api/nas', require('./routes/nas'));
app.use('/api/v1/open', require('./routes/openScoutApi'));
app.use('/api/open/scout', require('./routes/openScoutApi'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/alert-quality', require('./routes/alertQuality'));
app.use('/api/devtools', require('./routes/devTools'));
app.use('/api/sftp', require('./routes/sftp'));
app.use('/api/remote', require('./routes/remote'));

// --- Frontend Static Files & SPA Support ---
const distPath = path.join(__dirname, '../frontend/dist');
const docsPath = path.join(__dirname, '../docs');
app.use('/docs', express.static(docsPath));
// index.html is never served stale after a deploy; hashed /assets are cached long-term (see lib/frontendStatic.js)
require('./lib/frontendStatic').mountFrontend(app, distPath);

const { fork } = require('child_process');
const { initDB, closeDB } = require('./services/scoutDb');
const { autoMigrateLegacyCmdb } = require('./services/cmdbModel');

let server;
let workerProcess = null;
let isStopping = false;

function startBackgroundWorker() {
    if (process.env.ENABLE_EMBEDDED_WORKER === 'false') {
        console.log('[Supervisor] Embedded Background Worker is disabled by env (ENABLE_EMBEDDED_WORKER=false).');
        return;
    }

    const workerPath = path.join(__dirname, 'worker.js');
    console.log(`[Supervisor] Spawning isolated Background Worker process: ${workerPath}`);
    
    const child = fork(workerPath, [], {
        stdio: 'inherit',
        env: { ...process.env }
    });
    workerProcess = child;

    workerProcess.on('message', (msg) => {
        if (msg && msg.type === 'WORKER_READY') {
            console.log('[Supervisor] Background Worker reported READY.');
        }
        // Server Provision: the worker accepted / rejected a RUN_PROVISION_JOB (the web falls back on reject / timeout)
        if (msg && (msg.type === 'PROVISION_JOB_ACCEPTED' || msg.type === 'PROVISION_JOB_REJECTED')) {
            try {
                require('./services/provisionJobs').onWorkerMessage(msg);
            } catch (e) {}
        }
        // Worker wrote a document: refresh the web RAM cache (never re-broadcast to the worker)
        if (msg && msg.type === 'DOC_CACHE_UPDATED' && msg.key) {
            try {
                require('./lib/db').invalidateCache(msg.key);
            } catch (e) {}
        }
        // Relay WebSocket broadcast events from Worker process (Worker has no WSS)
        if (msg && msg.type === 'BROADCAST_EVENT') {
            try {
                const { broadcastEvent } = require('./lib/websocket');
                broadcastEvent(msg.event, msg.payload || {});
            } catch(e) {}
        }
    });

    workerProcess.on('exit', (code, signal) => {
        if (isStopping) {
            console.log('[Supervisor] Background Worker exited cleanly during shutdown.');
            return;
        }
        console.warn(`[Supervisor] WARNING: Background Worker exited unexpectedly (code: ${code}, signal: ${signal}). Respawning in 5 seconds...`);
        if (workerProcess === child) workerProcess = null;
        // Close-out (never throws): provision jobs of that worker are taken over by the web (resumed once),
        // pending provision acks fall back at once, and a backup that was running in the worker is closed.
        require('./lib/workerExitHandler').handleWorkerExit({ pid: child.pid }).catch(() => {});
        setTimeout(() => {
            if (!isStopping) {
                startBackgroundWorker();
            }
        }, 5000);
    });

    workerProcess.on('error', (err) => {
        console.error('[Supervisor] Background Worker process error:', err);
    });
}

global.sendWorkerMessage = function(msg) {
    if (workerProcess && workerProcess.connected && typeof workerProcess.send === 'function') {
        try {
            workerProcess.send(msg);
            return true;
        } catch (e) {
            console.error('[Supervisor] Failed to send IPC message to Background Worker:', e.message);
        }
    }
    return false;
};

initDB().then(async () => {
    // One-time import of the legacy prometheus_targets.json (original fs: bypasses the VFS intercept)
    try {
        await require('./lib/prometheusTargetHelper').importLegacyTargetsFileOnce({
            fsApi: { readFileSync: originalReadFileSync, existsSync: originalExistsSync }
        });
    } catch (e) {
        console.warn('[Startup] Legacy prometheus targets import skipped:', e.message);
    }

    // Agent reports are ingested here (web process), so the evaluators must be registered here too.
    // The worker registers its own copy and runs the offline poller.
    try {
        require('./services/scoutAlertEngine').registerEvaluator();
    } catch (e) {
        console.error('[Startup] Failed to register alert evaluators:', e.message);
    }

    // One-time copy of the former log documents (scheduler logs, CMDB history, DNS changes, workflow executions /
    // history) into their tables, before the worker is forked. Idempotent and cross-process safe (marker row in the
    // same transaction); every reader / writer also migrates lazily, so a failure here is retried on first use.
    try {
        require('./services/logTables').migrateAll();
    } catch (e) {
        console.error('[Startup] Log table migration skipped:', e.message);
    }

    // Run automated CMDB migration if table is empty
    autoMigrateLegacyCmdb();

    // One-time: clear stale "deleted" flags on servers that the old code re-created (never blocks startup)
    try {
        const r = require('./services/serverDeletion').migrateResurrectedDeletedFlags();
        if (r && r.cleared) console.log(`[Startup] Cleared stale deleted flag on ${r.cleared} server(s)`);
    } catch (e) {
        console.error('[Startup] Deleted-flag migration skipped:', e.message);
    }

    // One-time per consumer (marker system/environment_id_migration.json): link stored environment names to the
    // global environment id. Deferred so it never delays startup; idempotent; unresolved values stay untouched
    // (Settings -> Environments -> Unmapped values).
    setImmediate(() => {
        try {
            require('./services/environmentMigration').runEnvironmentIdMigration();
        } catch (e) {
            console.error('[Startup] Environment id migration skipped:', e.message);
        }
    });

    // Reconcile and synchronize all linked VIPs across CMDB and Prometheus Targets
    try {
        const { reconcileAllLinkedVips } = require('./lib/vipLinkageHelper');
        reconcileAllLinkedVips();
    } catch (e) {
        console.error('[Startup] Failed to reconcile linked VIPs:', e.message);
    }

    server = app.listen(PORT, () => {
        console.log(`[Startup] Web API Server is running on port ${PORT}`);
    
        // Initialize WebSocket Server
        initWebSocketServer(server);

        // Initialize Apache Guacamole Clientless Remote Gateway
        initGuacamoleProxy(server);

        // Start isolated Background Worker process (Process Isolation - Option 1)
        startBackgroundWorker();

        // Server Provision: tables, recovery of web-owned / pre-upgrade jobs left over from a previous run (queued hosts
        // resumed once, half-done hosts interrupted; worker-owned jobs are recovered by the worker), orphan sweep,
        // daily history cleanup (never blocks startup)
        try {
            require('./services/provisionJobs').init({ readConfig: () => require('./lib/envEditor').readEnv() });
        } catch (e) {
            console.error('[Startup] Provision job service skipped:', e.message);
        }

        // Startup warning when ALLOWED_AD_DOMAIN=local (ignored: reserved for the local admin account)
        try { require('./lib/rbac').getAllowedAdDomain(); } catch (e) {}

        // Service-start notification (web process only; restart storms are collapsed inside notifyStartup)
        require('./lib/startupNotice').notifyStartup({ port: PORT }).catch(() => {});
    }); // End of app.listen()
}).catch(err => {
    console.error('[Startup] Failed to initialize Database:', err);
    process.exit(1);
}); // End of initDB().then()

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
    if (isStopping) return;
    isStopping = true;
    console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    
    // 1. Terminate Background Worker if running
    if (workerProcess) {
        console.log('[Shutdown] Notifying Background Worker to shut down...');
        try {
            workerProcess.send({ type: 'SHUTDOWN' });
            setTimeout(() => {
                try { if (workerProcess) workerProcess.kill('SIGTERM'); } catch (e) {}
            }, 3000);
        } catch (e) {
            try { workerProcess.kill('SIGTERM'); } catch (err) {}
        }
    }

    // 2. Force close WebSockets and HTTP Keep-Alives immediately
    const { closeAllConnections } = require('./lib/websocket');
    closeAllConnections();
    
    if (server && server.closeAllConnections) {
        server.closeAllConnections();
    }

    if (server) {
        server.close(() => {
            console.log('[Shutdown] Closed out Web Server remaining connections.');
            try {
                closeDB();
            } catch (err) {
                console.error('[Shutdown] Error closing Scout DB:', err);
            }
            process.exit(0);
        });
    } else {
        process.exit(0);
    }

    // Fallback: forcefully exit if it takes too long (e.g., 10 seconds)
    setTimeout(() => {
        console.error('[Shutdown] Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

