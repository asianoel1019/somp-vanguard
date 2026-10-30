const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { appendLog, auditLog } = require('../lib/logger');
const { requireAuth, checkFeature, checkAnyFeature, checkRole } = require('../middleware/auth');

// Tasks run PowerShell / SSH / remote commands (local_ps runs on this server): changing or running them is
// Operator+, deleting is SuperAdmin. Viewers keep read access (tasks, logs, stats).
const canWrite = checkRole(['SuperAdmin', 'Operator']);
const canDelete = checkRole(['SuperAdmin']);

router.use(requireAuth);
// Task Scheduler screen (and the Home dashboard failed-task banner) -> 'scheduler'.
// POST /run-now/:module is also used by System Settings ("Run Scan Now") -> checked on the route itself.
const schedulerGate = checkFeature('scheduler');
const isRunNow = (req) => req.method === 'POST' && /^\/run-now\/[^/]+\/?$/i.test(req.path);
router.use((req, res, next) => (isRunNow(req) ? next() : schedulerGate(req, res, next)));


// Helper to split targets by Comma, Semicolon, or Newline safely and strip \r
function parseTargets(targets) {
    if (Array.isArray(targets)) return targets;
    if (!targets) return [];
    return targets.split(/[,\n;]/).map(t => t.trim().replace(/\r/g, '')).filter(t => t);
}

const { readDataSync, writeDataSync } = require('../lib/db');

// Helper to read tasks
function getTasks() {
    return readDataSync('server_operation/scheduler_tasks.json', []);
}

// Helper to save tasks
function saveTasks(data) {
    writeDataSync('server_operation/scheduler_tasks.json', data);
}

// Helper to read logs
function getLogs() {
    const logs = readDataSync('server_operation/scheduler_logs.json', []);
    // Return last 200 logs to prevent rendering massive tables
    return logs.reverse().slice(0, 200);
}

// Stats Endpoint
router.get('/stats', (req, res) => {
    try {
        const logs = readDataSync('server_operation/scheduler_logs.json', []);
        const stats = {};
        
        logs.forEach(log => {
            const taskId = log.taskId || log.taskName; // fallback if ID not available
            if (!taskId) return;
            if (!stats[taskId]) {
                stats[taskId] = { total: 0, success: 0, failed: 0, totalDuration: 0, lastRun: null };
            }
            
            stats[taskId].total += 1;
            if (log.status === 'Success') stats[taskId].success += 1;
            else if (log.status === 'Failed') stats[taskId].failed += 1;
            
            if (log.duration) {
                const parts = log.duration.split(' ');
                let secs = 0;
                parts.forEach(p => {
                    if (p.endsWith('m')) secs += parseInt(p) * 60;
                    if (p.endsWith('s')) secs += parseInt(p);
                });
                stats[taskId].totalDuration += secs;
            }
            
            if (!stats[taskId].lastRun || new Date(log.timestamp) > new Date(stats[taskId].lastRun)) {
                stats[taskId].lastRun = log.timestamp;
            }
        });
        
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to reload cron engine if initialized
function triggerEngineReload() {
    try {
        const service = require('../services/taskSchedulerService');
        if (typeof service.reloadScheduler === 'function') {
            service.reloadScheduler();
        }
    } catch (e) {
        console.warn('[Scheduler Router] Dynamic engine reload skipped: service not fully loaded yet.');
    }
}

// GET /tasks - List all scheduled tasks
router.get('/tasks', (req, res) => {
    res.json(getTasks());
});

// GET /logs - List last 200 execution logs
router.get('/logs', (req, res) => {
    res.json(getLogs());
});

// POST /tasks/add - Create a scheduled task
router.post('/tasks/add', canWrite, (req, res) => {
    const { name, cronExpression, targetType, targets, winCommand, nixCommand, executeAt } = req.body;
    if (!name || !targetType) {
        return res.status(400).json({ error: 'Name and Target Type are required' });
    }
    
    // Validate cron expression format unless it is permanent remote task
    if (targetType !== 'remote_windows_task' && cronExpression && !cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid Cron Expression format.' });
    }

    const tasks = getTasks();
    const newTask = {
        id: Date.now().toString(),
        name,
        cronExpression: cronExpression || '0 0 * * *', // Default midnight daily
        targetType, // 'local_ps', 'remote_linux_ssh', 'remote_windows_cmd', 'remote_windows_task', 'remote_auto_cmd'
        targets: parseTargets(targets),
        winCommand: winCommand || '',
        nixCommand: nixCommand || '',
        executeAt: executeAt || '09:00', // Used for remote windows task scheduler time
        status: 'active', // 'active' or 'inactive'
        lastRunStatus: 'Never',
        lastRunTime: 'N/A'
    };

    tasks.push(newTask);
    saveTasks(tasks);
    triggerEngineReload();
    
    const user = req.user ? req.user.username : 'System';
    auditLog(user, 'Task Scheduler', `Added scheduled task: ${name}`);
    res.json({ success: true, task: newTask });
});

// PUT /tasks/update - Edit an existing task
router.put('/tasks/update', canWrite, (req, res) => {
    const { id, name, cronExpression, targetType, targets, winCommand, nixCommand, executeAt } = req.body;
    if (!id) return res.status(400).json({ error: 'Task ID is required' });

    // Validate cron expression format unless it is permanent remote task
    const resolvedType = targetType || 'local_ps';
    if (resolvedType !== 'remote_windows_task' && cronExpression && !cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid Cron Expression format.' });
    }

    let tasks = getTasks();
    const taskIndex = tasks.findIndex(t => t.id === id);

    if (taskIndex === -1) {
        return res.status(404).json({ error: 'Task not found' });
    }

    tasks[taskIndex] = {
        ...tasks[taskIndex],
        name: name || tasks[taskIndex].name,
        cronExpression: cronExpression || tasks[taskIndex].cronExpression,
        targetType: targetType || tasks[taskIndex].targetType,
        targets: parseTargets(targets),
        winCommand: winCommand !== undefined ? winCommand : tasks[taskIndex].winCommand,
        nixCommand: nixCommand !== undefined ? nixCommand : tasks[taskIndex].nixCommand,
        executeAt: executeAt !== undefined ? executeAt : tasks[taskIndex].executeAt
    };

    saveTasks(tasks);
    triggerEngineReload();

    const user = req.user ? req.user.username : 'System';
    auditLog(user, 'Task Scheduler', `Updated scheduled task: ${tasks[taskIndex].name}`);
    res.json({ success: true, task: tasks[taskIndex] });
});

// POST /tasks/toggle/:id - Toggle task state (active/inactive)
router.post('/tasks/toggle/:id', canWrite, (req, res) => {
    const id = req.params.id;
    let tasks = getTasks();
    const taskIndex = tasks.findIndex(t => t.id === id);

    if (taskIndex === -1) {
        return res.status(404).json({ error: 'Task not found' });
    }

    const nextStatus = tasks[taskIndex].status === 'active' ? 'inactive' : 'active';
    tasks[taskIndex].status = nextStatus;
    
    saveTasks(tasks);
    triggerEngineReload();

    const user = req.user ? req.user.username : 'System';
    auditLog(user, 'Task Scheduler', `Toggled task ${tasks[taskIndex].name} to: ${nextStatus}`);
    res.json({ success: true, task: tasks[taskIndex] });
});

// DELETE /tasks/delete/:id - Remove a task
router.delete('/tasks/delete/:id', canDelete, (req, res) => {
    const id = req.params.id;
    let tasks = getTasks();
    const filtered = tasks.filter(t => t.id !== id);

    if (tasks.length !== filtered.length) {
        saveTasks(filtered);
        triggerEngineReload();
        const user = req.user ? req.user.username : 'System';
        auditLog(user, 'Task Scheduler', `Deleted scheduled task ID: ${id}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Task not found' });
    }
});

// POST /tasks/run/:id - Execute task manually now in background
router.post('/tasks/run/:id', canWrite, (req, res) => {
    const id = req.params.id;
    const service = require('../services/taskSchedulerService');
    
    if (typeof service.triggerTaskExecution === 'function') {
        service.triggerTaskExecution(id).catch(err => {
            console.error('[Scheduler Manual Run Error]', err);
        });
        const user = req.user ? req.user.username : 'System';
        auditLog(user, 'Task Scheduler', `Triggered manual run for task ID: ${id}`);
        res.json({ success: true, message: 'Execution triggered in background.' });
    } else {
        res.status(500).json({ error: 'Scheduler engine is currently unavailable.' });
    }
});

// POST /run-now/:module - Trigger native system services manually
// Callers: System Settings "Run Scan Now" ('settings', SuperAdmin only) and the Task Scheduler ('scheduler');
// the module's own feature is accepted too (same job as that module's own scan, e.g. POST /api/inventory/scan-now).
const RUN_NOW_GATES = {
    ssl: checkAnyFeature('scheduler', 'settings', 'sslMonitor'),
    inventory: checkAnyFeature('scheduler', 'settings', 'inventory'),
    dns: checkAnyFeature('scheduler', 'settings', 'dnsHub'),
    prometheus: checkAnyFeature('scheduler', 'settings', 'prometheus'),
};
const runNowDefaultGate = checkAnyFeature('scheduler', 'settings');
function runNowGate(req, res, next) {
    const m = String(req.params.module || '');
    const gate = Object.prototype.hasOwnProperty.call(RUN_NOW_GATES, m) ? RUN_NOW_GATES[m] : runNowDefaultGate;
    return gate(req, res, next);
}

// Role parity with each module's own run endpoint (e.g. POST /api/ssl/check-all, /api/inventory/scan-now): Operator+.
router.post('/run-now/:module', runNowGate, canWrite, async (req, res) => {
    const moduleName = req.params.module;
    const user = req.user ? req.user.username : 'System';

    try {
        if (moduleName === 'ssl') {
            const { runSSLCheck, getScanStatus } = require('../services/sslMonitorService');
            // same lease-guarded merge path as POST /api/ssl/check-all and the worker's daily scan
            let running = false;
            try { running = getScanStatus().running; } catch (e) { /* status unavailable: runSSLCheck still refuses overlaps */ }
            if (running) return res.json({ success: true, alreadyRunning: true, message: 'An SSL scan is already running.' });
            runSSLCheck({ trigger: 'run-now', user }).catch(err => console.error('[RunNow SSL Error]', err));
            auditLog(user, 'Scheduler', 'Triggered manual SSL Monitor scan');
            return res.json({ success: true, message: 'SSL scan triggered in background.' });
        } else if (moduleName === 'inventory') {
            // Same RBAC as POST /api/inventory/scan-now (a scan sends stored credentials to every answering host)
            const passes = (mw) => { let ok = false; mw(req, res, () => { ok = true; }); return ok; };
            if (!passes(checkFeature('inventory')) || !passes(checkRole(['SuperAdmin', 'Operator']))) return;
            // Scans run only in the background worker: hand the request over via IPC (503 when no worker)
            const result = await require('../services/inventoryControl').requestScan({ body: {}, requestedBy: user });
            if (result.status === 202) {
                auditLog(user, 'Scheduler', 'Triggered manual Inventory scan');
                return res.json({ success: true, message: 'Inventory scan triggered in background.' });
            }
            if (result.status === 409) return res.json({ success: true, alreadyRunning: true, message: result.body.message });
            return res.status(result.status).json({ error: result.body.error || result.body.message });
        } else if (moduleName === 'dns') {
            const { runExportTask } = require('../services/dnsScheduler');
            runExportTask().catch(err => console.error('[RunNow DNS Error]', err));
            auditLog(user, 'Scheduler', 'Triggered manual DNS Export task');
            return res.json({ success: true, message: 'DNS Export triggered in background.' });
        } else if (moduleName === 'prometheus') {
            const { runPrometheusHealthScan } = require('../services/prometheusScheduler');
            runPrometheusHealthScan().catch(err => console.error('[RunNow Prometheus Error]', err));
            auditLog(user, 'Scheduler', 'Triggered manual Prometheus Health scan');
            return res.json({ success: true, message: 'Prometheus Health scan triggered in background.' });
        } else {
            return res.status(400).json({ error: 'Unknown module for manual run' });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
