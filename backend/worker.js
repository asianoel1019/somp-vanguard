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

const path = require('path');
const dotenv = require('dotenv');

// 1. Timezone and Logging format helper
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
        originalLog(`[Worker ${getFormattedTime()}]`, ...args);
    }
};
console.error = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalError(...args);
    } else {
        originalError(`[Worker ${getFormattedTime()}]`, ...args);
    }
};
console.warn = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalWarn(...args);
    } else {
        originalWarn(`[Worker ${getFormattedTime()}]`, ...args);
    }
};
console.info = (...args) => {
    if (args.length > 0 && hasTimestamp(args[0])) {
        originalInfo(...args);
    } else {
        originalInfo(`[Worker ${getFormattedTime()}]`, ...args);
    }
};

// 2. Load and decrypt environment variables
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

// The worker only READS .env (rewrite: false); only the web process may migrate plain-text secrets.
global.reloadEnv = function() {
    require('./lib/loadEnv').loadEnv({ rewrite: false });
};

global.reloadEnv();

const { startLogRotation, auditLog } = require('./lib/logger');
const { initDB, closeDB } = require('./services/scoutDb');

// --- Global Process Crash Handlers ---
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Background Worker Uncaught Exception:', err);
    try { auditLog('SYSTEM', 'WorkerProcess', `Uncaught Exception: ${err.message}`); } catch (e) {}
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRITICAL] Background Worker Unhandled Rejection:', reason);
    try { auditLog('SYSTEM', 'WorkerProcess', `Unhandled Rejection: ${reason}`); } catch (e) {}
    process.exit(1);
});

console.log('[Worker] Starting SOMP Vanguard Background Worker...');

async function startWorker() {
    try {
        await initDB();
        console.log('[Worker] ScoutDB initialized in Worker process.');

        startLogRotation();
        console.log('[Worker] Log Rotation initialized.');

        // idx_alerts_monId (Server List delete preview) is built in the background, never at web startup
        try { require('./services/serverDeletion').scheduleAlertsMonitorIndex(); } catch (e) { console.warn('[Worker] alerts index scheduling skipped:', e.message); }

        const { startPoller } = require('./services/siemPoller');
        startPoller();
        console.log('[Worker] SIEM Poller initialized.');

        const { initDnsScheduler } = require('./services/dnsScheduler');
        initDnsScheduler();
        console.log('[Worker] DNS Scheduler initialized.');

        // Server Provision: this process may now claim jobs offered by the web; worker-owned jobs left over from a
        // previous worker run are recovered (half-done hosts interrupted, queued hosts resumed once). Never blocks startup.
        try { require('./services/provisionJobs').initWorker(); } catch (e) { console.error('[Worker] Provision job service skipped:', e.message); }

        // Per-row inventory storage: import the legacy oscheck documents once (idempotent, never blocks startup)
        setImmediate(() => {
            try { require('./services/inventoryStore').migrateFromDocuments(); }
            catch (e) { console.error('[Worker] Inventory hosts migration failed:', e.message); }
        });

        // Log tables (scheduler logs, CMDB history, DNS changes, workflow executions / history): retention prune
        // (RETENTION_*_DAYS + row caps) shortly after start, then daily; bounded batches. Never blocks startup.
        try { require('./services/logTables').scheduleDailyPrune(); } catch (e) { console.error('[Worker] Log table retention skipped:', e.message); }

        const { initInventoryScheduler } = require('./services/inventoryScheduler');
        await initInventoryScheduler({ startup: true });
        console.log('[Worker] Inventory Scheduler initialized.');

        const { initSSLMonitorScheduler } = require('./services/sslMonitorService');
        initSSLMonitorScheduler();
        console.log('[Worker] SSL Monitor Scheduler initialized.');

        const { initTaskScheduler } = require('./services/taskSchedulerService');
        initTaskScheduler();
        console.log('[Worker] Task Scheduler Service initialized.');

        const { initNetSearchScheduler } = require('./services/netsearchScheduler');
        initNetSearchScheduler();
        console.log('[Worker] NetSearch Scheduler initialized.');

        const { initPrometheusScheduler } = require('./services/prometheusScheduler');
        initPrometheusScheduler();
        console.log('[Worker] Prometheus Scheduler initialized.');

        const { initTelegramListener } = require('./services/telegramListener');
        initTelegramListener();
        console.log('[Worker] Telegram Listener initialized.');

        const { initBackupScheduler } = require('./services/backupService');
        initBackupScheduler();
        console.log('[Worker] Database Backup Scheduler initialized.');

        const { initScoutAlertEngine } = require('./services/scoutAlertEngine');
        initScoutAlertEngine();
        console.log('[Worker] Scout Alert Engine initialized.');

        alertMaintenanceJob = require('./services/alertMaintenanceJob');
        alertMaintenanceJob.start();
        console.log('[Worker] Alert maintenance job (escalation / digest / maintenance follow-up) initialized.');

        const { initSiemScheduler } = require('./services/siemScheduler');
        initSiemScheduler();
        console.log('[Worker] SIEM Scheduler initialized.');

        const { initElkLifecycleScheduler } = require('./services/elkLifecycleScheduler');
        initElkLifecycleScheduler();
        console.log('[Worker] ELK Lifecycle Scheduler initialized.');

        console.log('[Worker] All background schedulers & pollers successfully initialized.');

        // Notify parent process if spawned as a child
        if (process.send) {
            process.send({ type: 'WORKER_READY' });
        }
    } catch (err) {
        console.error('[Worker] Fatal Error during scheduler initialization:', err);
        process.exit(1);
    }
}

// Graceful Shutdown
let isShuttingDown = false;
let alertMaintenanceJob = null;
function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Worker] Received ${signal}, gracefully shutting down background services...`);

    try {
        const { stopTelegramListener } = require('./services/telegramListener');
        stopTelegramListener();
    } catch (e) {}

    try {
        if (alertMaintenanceJob) alertMaintenanceJob.stop();
    } catch (e) {}

    try {
        closeDB();
    } catch (e) {}

    console.log('[Worker] Background worker shutdown complete.');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// The web died (IPC channel closed): never keep running next to the worker the restarted web forks
require('./lib/workerLifecycle').attachParentDisconnect(process, shutdown);

// Listen for parent process IPC messages
process.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'SHUTDOWN') {
        shutdown('PARENT_IPC_SHUTDOWN');
    } else if (msg.type === 'INVALIDATE_DOC_CACHE') {
        try {
            const { invalidateCache } = require('./lib/db');
            if (typeof invalidateCache === 'function') {
                invalidateCache(msg.key, msg.data);
            }
        } catch (e) {}
    } else if (msg.type === 'RELOAD_DNS_SCHEDULER') {
        console.log('[Worker] Received IPC to reload DNS Scheduler.');
        try {
            const { invalidateCache } = require('./lib/db');
            if (typeof invalidateCache === 'function') {
                invalidateCache('dns_data.json');
            }
            const { initDnsScheduler } = require('./services/dnsScheduler');
            initDnsScheduler(msg.schedule);
        } catch (e) {
            console.error('[Worker] Error reloading DNS Scheduler:', e.message);
        }
    } else if (msg.type === 'RELOAD_INVENTORY_SCHEDULER') {
        console.log('[Worker] Received IPC to reload Inventory Scheduler.');
        try {
            const { invalidateCache } = require('./lib/db');
            if (typeof invalidateCache === 'function') {
                invalidateCache();
            }
            const { initInventoryScheduler } = require('./services/inventoryScheduler');
            initInventoryScheduler();
        } catch (e) {
            console.error('[Worker] Error reloading Inventory Scheduler:', e.message);
        }
    } else if (msg.type === 'RUN_INVENTORY_SCAN') {
        console.log(`[Worker] Received IPC to run an inventory scan (requested by ${msg.requestedBy}).`);
        try {
            const { invalidateCache } = require('./lib/db');
            if (typeof invalidateCache === 'function') invalidateCache('server_operation/oscheck/config.json');
            const { runScan } = require('./services/inventoryScheduler');
            runScan({ trigger: 'manual', requestedBy: msg.requestedBy, scope: msg.scope || null })
                .catch(e => console.error('[Worker] Inventory scan failed:', e.message));
        } catch (e) {
            console.error('[Worker] Error starting inventory scan:', e.message);
        }
    } else if (msg.type === 'ABORT_INVENTORY_SCAN') {
        console.log(`[Worker] Received IPC to abort the inventory scan (requested by ${msg.requestedBy}).`);
        try {
            require('./services/inventoryScheduler').abortScanOrCloseGhost().catch(e => console.error('[Worker] Error aborting inventory scan:', e.message));
        } catch (e) {
            console.error('[Worker] Error aborting inventory scan:', e.message);
        }
    } else if (msg.type === 'RUN_PROVISION_JOB' || msg.type === 'CANCEL_PROVISION_JOB') {
        // Only { type, jobId } arrives; the job service resolves credentials itself and answers PROVISION_JOB_ACCEPTED / _REJECTED
        try {
            require('./services/provisionJobs').handleWorkerMessage(msg, (reply) => {
                try { if (process.send && process.connected !== false) process.send(reply); } catch (e) { /* the web falls back after its ack timeout */ }
            });
        } catch (e) {
            console.error('[Worker] Error handling provision job message:', e.message);
        }
    } else if (msg.type === 'RELOAD_TELEGRAM_LISTENER') {
        try {
            const { stopTelegramListener, initTelegramListener } = require('./services/telegramListener');
            stopTelegramListener();
            Promise.resolve(initTelegramListener())
                .catch(e => console.error('[Worker] Error restarting Telegram Listener:', e.message));
        } catch (e) {
            console.error('[Worker] Error restarting Telegram Listener:', e.message);
        }
    } else if (msg.type === 'RELOAD_ENV') {
        try {
            global.reloadEnv();
            console.log('[Worker] Environment reloaded from .env.');
        } catch (e) {
            console.error('[Worker] Error reloading environment:', e.message);
        }
    } else if (msg.type === 'RUN_BACKUP_NOW') {
        console.log(`[Worker] Received IPC to run a manual backup (requested by ${msg.requestedBy}).`);
        try {
            const { runManualBackup } = require('./services/backupService');
            runManualBackup(msg.requestedBy, msg.requestId)
                .catch(e => console.error('[Worker] Manual backup failed:', e.message));
        } catch (e) {
            console.error('[Worker] Error starting manual backup:', e.message);
        }
    } else if (msg.type === 'RELOAD_TASK_SCHEDULER') {
        console.log('[Worker] Received IPC to reload Task Scheduler.');
        try {
            const { invalidateCache } = require('./lib/db');
            if (typeof invalidateCache === 'function') {
                invalidateCache();
            }
            const { reloadScheduler } = require('./services/taskSchedulerService');
            reloadScheduler();
        } catch (e) {
            console.error('[Worker] Error reloading Task Scheduler:', e.message);
        }
    } else if (msg.type === 'RELOAD_PROMETHEUS_SCHEDULER') {
        console.log('[Worker] Received IPC to reload Prometheus health scheduler.');
        try {
            const { initPrometheusScheduler } = require('./services/prometheusScheduler');
            initPrometheusScheduler();
        } catch (e) {
            console.error('[Worker] Error reloading Prometheus health scheduler:', e.message);
        }
    }
});

startWorker();
