/**
 * "Service started" notification (Telegram category AuditLogs via the [SYS Audit] marker).
 * A restart storm (crash loop, repeated deploys) is collapsed: starts within 5 minutes of the last notification
 * are only counted, and the count is appended to the next message that is actually sent.
 */
const os = require('os');
const logger = require('./logger');
const { readDataSync, writeDataSync } = require('./db');

const STATE_KEY = 'system/startup_notice.json';
const SUPPRESS_WINDOW_MS = 5 * 60 * 1000;

function defaultVersion() {
    return require('./version').getVersion();
}

/** Local time as YYYY-MM-DD HH:mm:ss */
function formatLocal(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** @returns {Promise<{ sent: boolean, restarts: number }>} never throws */
async function notifyStartup({ version = defaultVersion(), host = os.hostname(), port, now = new Date() } = {}) {
    let suppressed = 0;
    try {
        const state = readDataSync(STATE_KEY, {}) || {};
        const lastSentAt = state.lastSentAt ? new Date(state.lastSentAt) : null;
        suppressed = Number(state.suppressed) || 0;

        if (lastSentAt && !Number.isNaN(lastSentAt.getTime()) && now.getTime() - lastSentAt.getTime() < SUPPRESS_WINDOW_MS) {
            suppressed += 1;
            writeDataSync(STATE_KEY, { lastSentAt: state.lastSentAt, suppressed });
            return { sent: false, restarts: suppressed };
        }

        let message = `✅ [SYS Audit] SOMP Vanguard ${version} 已啟動\nHost: ${host}  Port: ${port}\nTime: ${formatLocal(now)}`;
        if (suppressed > 0 && lastSentAt && !Number.isNaN(lastSentAt.getTime())) {
            const minutes = Math.ceil((now.getTime() - lastSentAt.getTime()) / 60000);
            message += `\n⚠️ 過去 ${minutes} 分鐘內另有 ${suppressed} 次重啟`;
        }

        logger.appendLog(`[Startup] SOMP Vanguard ${version} started (host ${host}, port ${port})`);
        await logger.sendTelegramAlert(message, 'System');
        writeDataSync(STATE_KEY, { lastSentAt: now.toISOString(), suppressed: 0 });
        return { sent: true, restarts: 0 };
    } catch (err) {
        console.error('[Startup Notice] Failed:', err && err.message ? err.message : err);
        return { sent: false, restarts: suppressed };
    }
}

module.exports = { notifyStartup, STATE_KEY, SUPPRESS_WINDOW_MS };
