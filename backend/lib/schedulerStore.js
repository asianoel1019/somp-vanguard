/**
 * Task Scheduler documents: the ONLY way to write
 *   server_operation/scheduler_tasks.json  [ task, ... ]       (routes/scheduler.js edits; run metadata after each run)
 * and of the execution log (table scheduler_logs, one row per run, oldest = lowest id; services/logTables.js).
 *
 * Tasks run in the worker (cron) AND in the web process (manual "Run now" executes in the web), and both record
 * lastRunTime / lastRunStatus and append a log entry. Task list writes are atomic read-modify-writes through
 * lib/docStore.js mutateDocument (fn synchronous, mutates in place, returns the result; see docStore); a log entry is
 * a single INSERT.
 */
const dbMod = require('./db');
const { mutateDocument } = require('./docStore');

const TASKS_KEY = 'server_operation/scheduler_tasks.json';
// execution logs: table scheduler_logs (services/logTables.js); the former log document is legacy (migration only)

const arr = (v) => (Array.isArray(v) ? v : []);

/** Current tasks for READ-ONLY use (RAM cache allowed). */
function readTasks() {
    return dbMod.readDataSync(TASKS_KEY, []);
}

/** Atomic read-modify-write of the task list. Returns fn's result. */
function mutateTasks(fn, opts = {}) {
    return mutateDocument(TASKS_KEY, fn, {
        defaultValue: [], normalize: arr, fnName: 'schedulerStore.mutateTasks', label: 'scheduler tasks', reason: opts.reason,
    });
}

/** Appends one execution log entry as ONE row of table scheduler_logs (services/logTables.js). Returns 1. */
function appendLog(entry) {
    return require('../services/logTables').append('scheduler_logs', entry);
}

/** The newest `limit` log entries, newest first (the former logs.reverse().slice(0, limit)). */
function listRecentLogs(limit = 200) {
    return require('../services/logTables').listSchedulerLogs(limit);
}

/** Every log entry oldest first, without stdout / stderr (statistics). */
function listLogsForStats() {
    return require('../services/logTables').listSchedulerLogsLite();
}

module.exports = { TASKS_KEY, readTasks, mutateTasks, appendLog, listRecentLogs, listLogsForStats };
