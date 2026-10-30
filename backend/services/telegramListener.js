const https = require('https');
const http = require('http');
const tls = require('tls');
const { performServerCheck } = require('./serverCheckService');
const { appendLog, sendTelegramAlert } = require('../lib/logger');

let lastUpdateId = 0;
let lastToken = null; // token the stored offset belongs to
let isPolling = false;
let pollTimeoutObj = null;
let generation = 0; // bumped on every init/stop: a poll loop from an older generation stops itself
let fetchImpl = (url, timeoutMs) => fetchTelegramWithProxy(url, timeoutMs);

/** Long-poll seconds Telegram holds getUpdates open (TELEGRAM_POLL_INTERVAL, default 30). */
function longPollSeconds() {
    return parseInt(process.env.TELEGRAM_POLL_INTERVAL, 10) || 30;
}

/** HTTP timeout: the long poll itself plus 10 s of slack (a fixed 15 s aborted every poll with a longer interval). */
function requestTimeoutMs(pollSeconds = longPollSeconds()) {
    return (pollSeconds + 10) * 1000;
}

function resolveToken() {
    let token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (token.startsWith('enc:')) {
        try {
            const { decryptText } = require('../lib/crypto');
            token = decryptText(token.substring(4));
        } catch (e) {}
    }
    if (token.toLowerCase().startsWith('bot')) {
        token = token.substring(3).trim();
    }
    return token;
}

async function fetchTelegramWithProxy(urlStr, timeoutMs = requestTimeoutMs()) {
    return new Promise((resolve, reject) => {
        const enabledModules = (process.env.PROXY_ENABLED_MODULES || '').split(',').map(s => s.trim());
        const proxyUrl = enabledModules.includes('Telegram') ? (global.SYSTEM_PROXY || '').trim() : '';

        if (proxyUrl) {
            const urlObj = new URL(urlStr);
            const pObj = new URL(proxyUrl);
            const req = http.request({
                host: pObj.hostname,
                port: pObj.port || 80,
                method: 'CONNECT',
                path: `${urlObj.hostname}:443`,
                timeout: timeoutMs
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Proxy connection timeout (${timeoutMs / 1000}s)`));
            });

            req.on('connect', (proxyRes, socket) => {
                if (proxyRes.statusCode !== 200) {
                    return reject(new Error(`Proxy failed: HTTP ${proxyRes.statusCode}`));
                }
                const tlsSocket = tls.connect({ socket, servername: urlObj.hostname }, () => {
                    tlsSocket.write(`GET ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nConnection: close\r\n\r\n`);
                });
                let data = '';
                tlsSocket.on('data', chunk => data += chunk.toString());
                tlsSocket.on('end', () => {
                    try {
                        const body = data.substring(data.indexOf('\r\n\r\n') + 4);
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('Invalid JSON response: ' + data.substring(0, 200)));
                    }
                });
                tlsSocket.on('error', e => reject(e));
            }).on('error', e => reject(e));
            req.end();
        } else {
            const req = https.get(urlStr, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });
            req.on('error', e => reject(e));
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error(`Direct connection timeout (${timeoutMs / 1000}s)`));
            });
        }
    });
}

const { performProcessCheck } = require('./processCheckService');

async function processMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();
    const configuredChatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

    // Security Check: Only allow commands from configured Chat ID
    if (configuredChatId && String(msg.chat.id) !== configuredChatId) {
        appendLog(`[TelegramBot] Ignoring message from unauthorized chat ID: ${msg.chat.id} (Configured: ${configuredChatId})`);
        return;
    }

    const isCheck = text.toLowerCase().startsWith('/check ');
    const isProcess = text.toLowerCase().startsWith('/process ');

    if (isCheck || isProcess) {
        const ipString = text.substring(text.indexOf(' ') + 1);
        const ips = ipString.split(',').map(ip => ip.trim()).filter(ip => ip);

        if (ips.length === 0) {
            await sendTelegramAlert('⚠️ Please provide at least one IP address. Example: `/check 198.51.100.240, 198.51.100.241`', 'TelegramBot');
            return;
        }

        const actionName = isCheck ? 'Server Check' : 'Process Check';
        await sendTelegramAlert(`⏳ Executing ${actionName} for ${ips.length} host(s)...`, 'TelegramBot');

        for (const ip of ips) {
            try {
                const linuxPassword = process.env.LINUX_ADMIN_PWD || '';
                const adCredentials = {}; // Let performServerCheck automatically use AD_ADMIN_USER and AD_ADMIN_PWD

                if (isCheck) {
                    const result = await performServerCheck(ip, linuxPassword, adCredentials);

                    let msgOut = `📊 **Server Check Result: ${ip}**\n`;
                    msgOut += `Status: ${result.status === 'Online' ? '🟢 Online' : '🔴 ' + result.status}\n`;
                    msgOut += `OS: ${result.os}\n`;
                    
                    if (result.status === 'Online') {
                        msgOut += `CPU: ${result.cpu}\n`;
                        msgOut += `Mem: ${result.memory}\n`;
                        msgOut += `Disk: ${result.disk}\n`;
                    }

                    if (result.error) {
                        msgOut += `\n⚠️ Error: ${result.error}\n`;
                    }

                    await sendTelegramAlert(msgOut, 'TelegramBot');
                } else if (isProcess) {
                    const result = await performProcessCheck(ip, linuxPassword, adCredentials);

                    let msgOut = `⚙️ **Top Processes: ${ip}**\n`;
                    msgOut += `Status: ${result.status === 'Online' ? '🟢 Online' : '🔴 ' + result.status}\n`;
                    msgOut += `OS: ${result.os}\n\n`;

                    if (result.status === 'Online' && result.processes && result.processes.length > 0) {
                        msgOut += `\`\`\`\n`;
                        // Format table
                        const pidPad = 8;
                        const cpuPad = 8;
                        const memPad = 8;
                        msgOut += 'PID'.padEnd(pidPad) + 'CPU'.padEnd(cpuPad) + 'MEM'.padEnd(memPad) + 'NAME\n';
                        msgOut += '-'.repeat(40) + '\n';
                        for (const p of result.processes) {
                            msgOut += String(p.pid).padEnd(pidPad) + String(p.cpu).padEnd(cpuPad) + String(p.mem).padEnd(memPad) + p.name + '\n';
                        }
                        msgOut += `\`\`\`\n`;
                    } else if (result.status === 'Online') {
                        msgOut += `No process data available.\n`;
                    }

                    if (result.error) {
                        msgOut += `\n⚠️ Error: ${result.error}\n`;
                    }

                    await sendTelegramAlert(msgOut, 'TelegramBot');
                }
            } catch (e) {
                await sendTelegramAlert(`❌ Check failed for ${ip}: ${e.message}`, 'TelegramBot');
            }
        }
    }
}

async function flushTelegramQueue(token, gen) {
    console.log('[TelegramBot] Flushing old messages...');
    try {
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId}&timeout=0`;
        const response = await fetchImpl(url, requestTimeoutMs(0));
        if (gen !== generation) return;
        if (response.ok && response.result) {
            for (const update of response.result) {
                lastUpdateId = update.update_id + 1;
            }
            if (response.result.length > 0) {
                console.log(`[TelegramBot] Flushed ${response.result.length} old messages.`);
            }
        }
    } catch (e) {
        console.error('[TelegramBot] Failed to flush queue:', e.message);
    }
}

async function pollUpdates(gen, token) {
    // token is the one captured at init: it only changes through a reload (init), never mid-loop
    if (gen !== generation) return;
    if (!token) return;

    // Use configurable polling timeout (long polling), default to 30 seconds
    const pollTimeout = longPollSeconds();

    try {
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId}&timeout=${pollTimeout}`;
        const response = await fetchImpl(url, requestTimeoutMs(pollTimeout));

        if (gen !== generation) return;
        if (response.ok && response.result) {
            for (const update of response.result) {
                if (gen !== generation) return;
                lastUpdateId = update.update_id + 1;
                if (update.message) {
                    await processMessage(update.message);
                }
            }
        } else if (!response.ok) {
            console.error('[TelegramBot] API Error:', JSON.stringify(response));
        }
    } catch (e) {
        console.error('[TelegramBot] Polling error:', e.message);
    }

    // Schedule next poll immediately after the long poll finishes
    if (isPolling && gen === generation) {
        pollTimeoutObj = setTimeout(() => { pollTimeoutObj = null; pollUpdates(gen, token); }, 1000);
    }
}

async function initTelegramListener() {
    // Idempotent: whatever is running is stopped first, so one process never has two poll loops
    if (isPolling) {
        console.log('[TelegramBot] Already running. Restarting listener to reload configuration...');
        stopTelegramListener();
        await new Promise(r => setTimeout(r, 1000));
    }
    const gen = ++generation;
    
    if (process.env.TELEGRAM_LISTENER_ENABLED === 'false') {
        console.log('[TelegramBot] Listener disabled via configuration.');
        return;
    }

    const token = resolveToken();
    if (!token) {
        console.log('[TelegramBot] TELEGRAM_BOT_TOKEN not configured. Listener disabled.');
        return;
    }

    // A different bot has its own update_id sequence: the old offset would skip or confirm its pending updates
    if (lastToken !== null && lastToken !== token) {
        console.log('[TelegramBot] Bot token changed: resetting update offset.');
        lastUpdateId = 0;
    }
    lastToken = token;

    isPolling = true;
    console.log('[TelegramBot] Starting Telegram long polling listener...');
    
    // Flush old accumulated messages before starting the listener loop
    await flushTelegramQueue(token, gen);
    if (gen !== generation) return; // superseded by a newer init/stop while flushing

    pollUpdates(gen, token);
}

function stopTelegramListener() {
    isPolling = false;
    generation++;
    if (pollTimeoutObj) {
        clearTimeout(pollTimeoutObj);
        pollTimeoutObj = null;
    }
    console.log('[TelegramBot] Stopping Telegram listener...');
}

module.exports = {
    initTelegramListener,
    stopTelegramListener,
    // Test hooks (no network): replace the fetcher and inspect loop state
    __test: {
        setFetch(fn) { fetchImpl = fn || ((url, timeoutMs) => fetchTelegramWithProxy(url, timeoutMs)); },
        requestTimeoutMs,
        state: () => ({ isPolling, hasTimer: pollTimeoutObj !== null, lastUpdateId, generation }),
    },
};
