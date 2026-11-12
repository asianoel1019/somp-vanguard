// Finding what makes the backend slow:
// - slow database calls: any SQLite call taking DB_SLOW_QUERY_MS (default 500) or longer is logged as
//   "[DB Slow] <ms> <kind>: <SQL>" (the statement text only, never the parameters);
// - a blocked event loop: when the process could not run a timer for EVENT_LOOP_BLOCK_MS (default 1000) or longer,
//   "[Event Loop] <process> blocked ~<ms>; DB: <n> call(s), <ms> in total" is logged, with the slowest database call
//   seen during that time (a block with little database time is CPU work: JSON, compression, ...).
const { performance } = require('perf_hooks');

const threshold = () => Number(process.env.DB_SLOW_QUERY_MS) || 500;
let slowest = null; // { kind, sql, ms, at } since the last event-loop check
let dbCalls = 0; // database calls and their total time since the last event-loop check
let dbMs = 0;

const shortSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Runs fn (synchronous) and logs it when it was slow. */
function timed(kind, sql, fn) {
    const start = performance.now();
    try {
        return fn();
    } finally {
        const ms = performance.now() - start;
        dbCalls++;
        dbMs += ms;
        if (ms >= threshold()) {
            const entry = { kind, sql: shortSql(sql), ms: Math.round(ms), at: Date.now() };
            if (!slowest || entry.ms > slowest.ms) slowest = entry;
            console.warn(`[DB Slow] ${entry.ms}ms ${kind}: ${entry.sql}`);
        }
    }
}

/** Same for an async function. */
async function timedAsync(kind, label, fn) {
    const start = performance.now();
    try {
        return await fn();
    } finally {
        const ms = performance.now() - start;
        if (ms >= threshold()) console.warn(`[DB Slow] ${Math.round(ms)}ms ${kind}: ${shortSql(label)}`);
    }
}

let monitorTimer = null;
/** Logs every time the event loop of this process was blocked for blockMs or more. */
function startEventLoopMonitor(processLabel, { intervalMs = 500, blockMs = Number(process.env.EVENT_LOOP_BLOCK_MS) || 1000 } = {}) {
    if (monitorTimer) return;
    let expected = Date.now() + intervalMs;
    monitorTimer = setInterval(() => {
        const now = Date.now();
        const lag = now - expected;
        if (lag >= blockMs) {
            const total = `; DB: ${dbCalls} call(s), ${Math.round(dbMs)}ms in total`;
            const db = slowest ? `; slowest DB call: ${slowest.ms}ms ${slowest.kind}: ${slowest.sql}` : '';
            console.warn(`[Event Loop] ${processLabel} blocked ~${lag}ms${total}${db}`);
        }
        slowest = null;
        dbCalls = 0;
        dbMs = 0;
        expected = now + intervalMs;
    }, intervalMs);
    if (monitorTimer.unref) monitorTimer.unref();
}

module.exports = { timed, timedAsync, startEventLoopMonitor, shortSql };
