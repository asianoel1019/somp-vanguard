const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const tls = require('tls');
const { safeSlice } = require('./textUtil');

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const LOG_DIR = path.join(BASE_DATA_DIR, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (e) {
        console.error(`Failed to create logs dir at ${LOG_DIR}:`, e);
    }
}
console.log(`[Logger] Initialized with directory: ${LOG_DIR}`);

function getTodayStr() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function getLocaleTimestamp() {
    const now = new Date();
    const tz = process.env.SYSTEM_TIMEZONE || 'Asia/Taipei';
    try {
        return now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
    } catch (e) {
        return now.toISOString(); // Fallback
    }
}

function getTodayLogFile() {
    const todayStr = getTodayStr();
    return path.join(LOG_DIR, `auth_${todayStr}.log`);
}

function appendLog(msg) {
    const todayStr = getTodayStr();
    const logFile = path.join(LOG_DIR, `auth_${todayStr}.log`);
    const line = `[${getLocaleTimestamp()}] ${msg}`;
    
    try {
        fs.appendFileSync(logFile, line + '\n');
    } catch (e) {
        // Fallback if file write fails
    }
    console.log(line);
}

// Categories that are only pushed (Telegram / webhooks) when explicitly selected,
// even when no category list has been configured ("unset = all" does not apply).
const OPT_IN_CATEGORIES = new Set(['AIAgent']);

function isOptInCategory(category) {
    return OPT_IN_CATEGORIES.has(category);
}

function resolveLogCategory(moduleName, message = '') {
    const mod = (moduleName || '').toLowerCase();
    const msg = (message || '').toLowerCase();

    // Checked first: agent questions are free text and may contain words like "login" or "[audit]"
    if (mod === 'ai agent') {
        return 'AIAgent';
    }

    if (mod === 'auth' || msg.includes('login') || msg.includes('locked')) {
        return 'AuthSecurity';
    }
    if (mod === 'scoutmonitor' || mod === 'scout') {
        return 'ScoutMonitor';
    }
    if (mod === 'ssl monitor' || mod === 'ssl') {
        return 'SSLMonitor';
    }
    if (mod === 'inventory') {
        return 'Inventory';
    }
    if (mod === 'prometheus') {
        return 'Prometheus';
    }
    if (mod === 'workflow') {
        return 'Workflow';
    }
    if (msg.includes('[sys audit]') || msg.includes('[sys batch audit]') || msg.includes('[audit]')) {
        return 'AuditLogs';
    }

    const auditModules = ['elk manager', 'kubernetes', 'nutanix', 'mail relay', 'fortiproxy', 'squid', 'server list', 'settings', 'rbac', 'dns hub', 'ad user control', 'server check', 'remote command', 'remote install', 'provision', 'redis control', 'ipam', 'task scheduler', 'data centers'];
    if (auditModules.some(m => mod.includes(m))) {
        return 'AuditLogs';
    }

    return 'GeneralLogs';
}

function isTelegramCategoryEnabled(category) {
    const rawSetting = process.env.TELEGRAM_ENABLED_LOGS !== undefined
        ? process.env.TELEGRAM_ENABLED_LOGS
        : process.env.INTEGRATION_ENABLED_LOGS;
    if (rawSetting === undefined || rawSetting === null) {
        // If unset, default to all enabled for backward compatibility (opt-in categories excluded)
        return !isOptInCategory(category);
    }
    const enabledList = rawSetting.split(',').map(s => s.trim()).filter(Boolean);
    return enabledList.includes(category);
}

function isNotificationCategoryEnabled(category) {
    return isTelegramCategoryEnabled(category);
}

const TELEGRAM_MAX_CHARS = 3000;

async function sendTelegramAlert(message, moduleName = 'System', options = {}) {
    const category = resolveLogCategory(moduleName, message);

    // 1. Dispatch to Webhooks independently based on each webhook's own filter
    if (!options.skipWebhooks) {
        try {
            const webhookService = require('../services/webhookService');
            webhookService.triggerWebhooks(message, moduleName, category);
        } catch (err) {
            console.error('[Logger] Failed to dispatch webhook alert:', err.message);
        }
    }

    if (options.skipTelegram) return;

    // 2. Dispatch to Telegram if category is enabled for Telegram
    if (!options.skipCategoryCheck && !isTelegramCategoryEnabled(category)) {
        appendLog(`[${moduleName}] Telegram alert skipped: category '${category}' disabled in TELEGRAM_ENABLED_LOGS`);
        return;
    }

    let token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (token.startsWith('enc:')) {
        try {
            const { decryptText } = require('./crypto');
            token = decryptText(token.substring(4));
        } catch (e) {}
    }
    if (token.toLowerCase().startsWith('bot')) {
        token = token.substring(3).trim();
    }
    const chatId = String(options.chatId || process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) {
        appendLog(`[${moduleName}] Telegram alert skipped: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID`);
        return;
    }

    try {
        // The text travels in a GET query string; cap it so CJK URL-encoding (~9x) stays within URL length limits
        const tgText = String(message);
        const tgMessage = tgText.length > TELEGRAM_MAX_CHARS ? safeSlice(tgText, TELEGRAM_MAX_CHARS) + '…（訊息過長已截斷）' : tgText;
        const urlStr = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(tgMessage)}`;
        const enabledModules = (process.env.PROXY_ENABLED_MODULES || '').split(',').map(s => s.trim());
        const proxyUrl = enabledModules.includes('Telegram') ? (global.SYSTEM_PROXY || '').trim() : '';

        if (proxyUrl) {
            const urlObj = new URL(urlStr);
            const pObj = new URL(proxyUrl);
            const req = http.request({
                host: pObj.hostname,
                port: pObj.port || 80,
                method: 'CONNECT',
                path: `${urlObj.hostname}:443`
            });
            req.on('connect', (proxyRes, socket) => {
                if (proxyRes.statusCode !== 200) {
                    return appendLog(`[${moduleName}] Telegram proxy failed: HTTP ${proxyRes.statusCode}`);
                }
                const tlsSocket = tls.connect({ socket, servername: urlObj.hostname }, () => {
                    tlsSocket.write(`GET ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nConnection: close\r\n\r\n`);
                });
                let data = '';
                tlsSocket.on('data', chunk => data += chunk.toString());
                tlsSocket.on('end', () => {
                    const statusLine = data.split('\r\n')[0] || '';
                    const is200 = statusLine.includes(' 200 ');
                    const bodyIndex = data.indexOf('\r\n\r\n');
                    const bodyStr = bodyIndex !== -1 ? data.slice(bodyIndex + 4) : data;
                    let parsedOk = false;
                    try {
                        const json = JSON.parse(bodyStr);
                        if (json && json.ok === true) parsedOk = true;
                    } catch(e) {}

                    if (is200 && parsedOk) {
                        appendLog(`[${moduleName}] Telegram alert sent (via Proxy)`);
                    } else {
                        appendLog(`[${moduleName}] Telegram alert failed (via Proxy): ${statusLine} - ${bodyStr.trim()}`);
                    }
                });
                tlsSocket.on('error', e => appendLog(`[${moduleName}] Telegram TLS error: ${e.message}`));
            }).on('error', e => appendLog(`[${moduleName}] Telegram proxy network error: ${e.message}`));
            req.end();
        } else {
            https.get(urlStr, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        appendLog(`[${moduleName}] Telegram alert sent`);
                    } else {
                        appendLog(`[${moduleName}] Telegram alert failed: HTTP ${res.statusCode} - ${data}`);
                    }
                });
            }).on('error', (e) => {
                appendLog(`[${moduleName}] Telegram alert network error: ${e.message}`);
            });
        }
    } catch (e) {
        appendLog(`[${moduleName}] Telegram alert exception: ${e.message}`);
    }
}

const MODULE_TO_FLAG = {
    'DNS Hub': 'APP_LOG_ENABLE_DNS_HUB',
    'AD User Control': 'APP_LOG_ENABLE_AD_CONTROL',
    'Server Check': 'APP_LOG_ENABLE_SERVER_CHECK',
    'Remote Command': 'APP_LOG_ENABLE_REMOTE_CMD',
    'FortiProxy Manager': 'APP_LOG_ENABLE_FORTIPROXY',
    'Squid Proxy': 'APP_LOG_ENABLE_SQUID',
    'Mail Relay': 'APP_LOG_ENABLE_MAIL',
    'ELK Manager': 'APP_LOG_ENABLE_ELK',
    'Remote Install': 'APP_LOG_ENABLE_INSTALL',
    'Prometheus Target': 'APP_LOG_ENABLE_PROMETHEUS',
    'Nutanix Manager': 'APP_LOG_ENABLE_NUTANIX',
    'Data Centers': 'APP_LOG_ENABLE_DATA_CENTER',
    'Redis Control': 'APP_LOG_ENABLE_REDIS',
    'Inventory': 'APP_LOG_ENABLE_SERVER_INVENTORY',
    'IPAM': 'APP_LOG_ENABLE_IPAM',
    'SSL Monitor': 'APP_LOG_ENABLE_SSL_MONITOR',
    'Task Scheduler': 'APP_LOG_ENABLE_SCHEDULER'
};

const MODULE_TO_FEATURE_KEY = {
    'DNS Hub': 'dnsHub',
    'AD User Control': 'adControl',
    'Server Check': 'serverCheck',
    'Remote Command': 'remoteCmd',
    'FortiProxy Manager': 'fortiProxy',
    'Squid Proxy': 'squid',
    'Mail Relay': 'mail',
    'ELK Manager': 'elk',
    'Remote Install': 'install',
    'Prometheus Target': 'prometheus',
    'Nutanix Manager': 'nutanix',
    'Data Centers': 'dataCenter',
    'Redis Control': 'redisControl',
    'Inventory': 'inventory',
    'IPAM': 'ipam',
    'SSL Monitor': 'sslMonitor',
    'Task Scheduler': 'scheduler'
};

function isLoggingEnabledForModule(moduleName, username) {
    if (!username) return true;
    if (username.toUpperCase() === 'SYSTEM' || username.startsWith('OpenAPI')) return true;
    try {
        const { getUserRole, readRbacConfig } = require('./rbac');
        const role = getUserRole(username, (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim());
        if (role === 'SuperAdmin') {
            return true;
        }

        const featureKey = MODULE_TO_FEATURE_KEY[moduleName];
        if (!featureKey) return true;

        const userGroups = (global.userGroupsCache && global.userGroupsCache[username.toLowerCase()]) || [];
        if (userGroups.length === 0) {
            return false;
        }

        const rbac = readRbacConfig();
        let enabled = false;
        userGroups.forEach(gName => {
            const gData = rbac.groups?.[gName];
            if (gData && gData.enabled !== false && gData.auditLogs && gData.auditLogs[featureKey] === true) {
                enabled = true;
            }
        });
        return enabled;
    } catch (e) {
        console.error('[Logger] Error resolving logging state:', e);
        return true;
    }
}

function auditLog(user, moduleName, actionDescription) {
    if (!isLoggingEnabledForModule(moduleName, user)) return;
    const rawMessage = `[Audit] User: ${user} | Module: ${moduleName} | Action: ${actionDescription.replace(/\n/g, ' ')}`;
    appendLog(rawMessage);
    sendTelegramAlert(formatAuditMessage(user, moduleName, actionDescription), moduleName);
}

/** Audit line to the log file and webhooks but NOT Telegram: for events that already send their own summary notification. */
function auditLogFileOnly(user, moduleName, actionDescription) {
    if (!isLoggingEnabledForModule(moduleName, user)) return;
    appendLog(`[Audit] User: ${user} | Module: ${moduleName} | Action: ${String(actionDescription).replace(/\n/g, ' ')}`);
    // webhooks still get it (like every other audit line); only the Telegram push is skipped
    sendTelegramAlert(formatAuditMessage(user, moduleName, actionDescription), moduleName, { skipTelegram: true });
}

function formatAuditMessage(user, moduleName, actionDescription) {
    const isResolvedOrAck = actionDescription.toLowerCase().includes('acknowledged') || actionDescription.toLowerCase().includes('resolved');
    const icon = isResolvedOrAck ? '🟢' : '🚨';
    return `${icon} [SYS Audit]\nUser: ${user}\nModule: ${moduleName}\nAction: ${actionDescription}`;
}

function formatBatchAuditMessage(user, moduleName, actions) {
    const tgActionText = actions.join('\n');
    const truncatedActions = tgActionText.length > 3500 ? tgActionText.substring(0, 3500) + '... (truncated)' : tgActionText;
    return `🚨 [SYS Batch Audit]\nUser: ${user}\nModule: ${moduleName}\nActions (${actions.length}):\n${truncatedActions}`;
}

// ─── Batched notifications ──────────────────────────
// Bursts of events (e.g. a bulk CMDB edit touching many Prometheus targets) are pushed to Telegram/Webhooks
// as ONE message: items queued under the same key are sent after quietMs without new items, or at most
// maxWaitMs after the first item. render(items) builds the message; a batch of one should keep the
// original single-event wording.
const notifyBatchTiming = { quietMs: 10000, maxWaitMs: 60000 };
const pendingNotifyBatches = new Map();

function flushNotifyBatch(key) {
    const batch = pendingNotifyBatches.get(key);
    if (!batch) return;
    pendingNotifyBatches.delete(key);
    clearTimeout(batch.timer);
    let message;
    try {
        message = batch.render(batch.items);
    } catch (e) {
        console.error(`[Logger] Failed to render batched notification '${key}':`, e.message);
        return;
    }
    Promise.resolve(sendTelegramAlert(message, batch.moduleName))
        .catch(err => console.error(`[Logger] Batched notification '${key}' failed:`, err.message));
}

function flushAllNotifyBatches() {
    for (const key of [...pendingNotifyBatches.keys()]) flushNotifyBatch(key);
}

/** Queues an item for a batched notification (see above). */
function queueNotification(key, moduleName, item, render) {
    let batch = pendingNotifyBatches.get(key);
    if (!batch) {
        batch = { moduleName, render, items: [], firstAt: Date.now(), timer: null };
        pendingNotifyBatches.set(key, batch);
    }
    batch.items.push(item);
    clearTimeout(batch.timer);
    const wait = Math.max(0, Math.min(notifyBatchTiming.quietMs, batch.firstAt + notifyBatchTiming.maxWaitMs - Date.now()));
    batch.timer = setTimeout(() => flushNotifyBatch(key), wait);
    if (batch.timer.unref) batch.timer.unref();
}

/** "• a\n• b ... 及其他 N 筆" — keeps long batches readable. */
function summarizeLines(lines, max = 20) {
    const shown = lines.slice(0, max).map(l => `• ${l}`).join('\n');
    return lines.length > max ? `${shown}\n... 及其他 ${lines.length - max} 筆` : shown;
}

/** Like auditLog, but the notification is merged with other actions of the same user+module in a short window. */
function auditLogBatched(user, moduleName, actionDescription) {
    if (!isLoggingEnabledForModule(moduleName, user)) return;
    appendLog(`[Audit] User: ${user} | Module: ${moduleName} | Action: ${actionDescription.replace(/\n/g, ' ')}`);
    queueNotification(`audit\u0000${user}\u0000${moduleName}`, moduleName, actionDescription, (actions) => actions.length === 1
        ? formatAuditMessage(user, moduleName, actions[0])
        : formatBatchAuditMessage(user, moduleName, actions));
}

function batchAuditLog(user, moduleName, actions) {
    if (!actions || actions.length === 0) return;
    if (!isLoggingEnabledForModule(moduleName, user)) return;
    
    const count = actions.length;
    const actionText = actions.join(' | ');
    appendLog(`[Audit-Batch] User: ${user} | Module: ${moduleName} | Actions (${count}): ${actionText}`);

    sendTelegramAlert(formatBatchAuditMessage(user, moduleName, actions), moduleName);
}

function compressLogFile(filePath) {
    return new Promise((resolve, reject) => {
        const gzip = zlib.createGzip();
        const readStream = fs.createReadStream(filePath);
        const writeStream = fs.createWriteStream(`${filePath}.gz`);
        
        readStream.pipe(gzip).pipe(writeStream)
            .on('finish', () => {
                // Delete original log file after successful compression
                fs.unlink(filePath, (err) => {
                    if (err) console.error(`Failed to delete ${filePath}:`, err);
                    resolve();
                });
            })
            .on('error', (err) => {
                console.error(`Compression error for ${filePath}:`, err);
                reject(err);
            });
    });
}

function performLogRotationAndCleanup() {
    appendLog('Starting daily log rotation and cleanup task...');
    
    const todayStr = getTodayStr();
    const archiveDir = path.join(LOG_DIR, 'archive');
    
    if (!fs.existsSync(archiveDir)) {
        try { fs.mkdirSync(archiveDir, { recursive: true }); } catch(e) {}
    }
    
    fs.readdir(LOG_DIR, (err, files) => {
        if (err) {
            return console.error('Failed to read log directory:', err);
        }
        
        files.forEach(file => {
            if (file === 'archive') return;
            
            const filePath = path.join(LOG_DIR, file);
            
            // 1. Compress .log files that are older than 7 days
            if (file.endsWith('.log')) {
                const match = file.match(/^auth_(\d{4}-\d{2}-\d{2})\.log$/);
                if (match) {
                    const fileDateStr = match[1];
                    const fileDate = new Date(fileDateStr);
                    const today = new Date(getTodayStr());
                    const diffTime = today.getTime() - fileDate.getTime();
                    const diffDays = diffTime / (1000 * 60 * 60 * 24);
                    if (diffDays >= 7) {
                        compressLogFile(filePath).then(() => {
                            const gzPath = `${filePath}.gz`;
                            const archivePath = path.join(archiveDir, `${file}.gz`);
                            fs.rename(gzPath, archivePath, e => {
                                if (e) console.error(`Failed to move ${file}.gz to archive:`, e);
                            });
                        }).catch(e => console.error(e));
                    }
                }
            }
            
            // 2. Move existing .gz files to archive
            if (file.endsWith('.gz')) {
                const archivePath = path.join(archiveDir, file);
                fs.rename(filePath, archivePath, e => {
                    if (e) console.error(`Failed to move ${file} to archive:`, e);
                });
            }
        });
    });

    // 3. Clean up old archives (>30 days)
    fs.readdir(archiveDir, (err, archiveFiles) => {
        if (err) return;
        const nowMs = Date.now();
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        archiveFiles.forEach(file => {
            const filePath = path.join(archiveDir, file);
            if (file.endsWith('.gz')) {
                fs.stat(filePath, (err, stats) => {
                    if (!err && stats) {
                        if (nowMs - stats.mtimeMs > thirtyDaysMs) {
                            fs.unlink(filePath, e => {
                                if (!e) appendLog(`Deleted old log archive: ${file}`);
                            });
                        }
                    }
                });
            }
        });
    });
}

function scheduleNextRotation() {
    const now = new Date();
    // Since process.env.TZ is set to Asia/Taipei in index.js, 
    // these methods now return local time values correctly.
    let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
    
    if (now.getTime() >= target.getTime()) {
        target.setDate(target.getDate() + 1);
    }
    
    const msToWait = target.getTime() - now.getTime();
    
    // Safety check to prevent infinite immediate loops
    const safeWait = msToWait > 0 ? msToWait : 1000;
    
    console.log(`[Logger] Next rotation in ${Math.round(safeWait / 1000 / 60)} minutes (Target: 06:00 AM)`);
    
    setTimeout(() => {
        performLogRotationAndCleanup();
        scheduleNextRotation();
    }, safeWait);
}

function startLogRotation() {
    scheduleNextRotation();
}

/** Sends to an explicitly configured chat (e.g. escalation group); bypasses category filters and webhooks. */
function sendTelegramToChat(chatId, message) {
    return sendTelegramAlert(message, 'ScoutMonitor', { chatId, skipWebhooks: true, skipCategoryCheck: true });
}

module.exports = {
    appendLog,
    auditLogFileOnly,
    isLoggingEnabledForModule,
    sendTelegramAlert,
    sendTelegramToChat,
    auditLog,
    batchAuditLog,
    auditLogBatched,
    queueNotification,
    summarizeLines,
    flushAllNotifyBatches,
    notifyBatchTiming,
    startLogRotation,
    getTodayLogFile,
    resolveLogCategory,
    isNotificationCategoryEnabled,
    isOptInCategory
};
