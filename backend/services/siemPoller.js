const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { sendMail } = require('../lib/mailer');

function getHitsValue(res) {
    if (!res || !res.data || !res.data.hits || !res.data.hits.total) return 0;
    const total = res.data.hits.total;
    if (typeof total === 'object') {
        return total.value || 0;
    }
    if (typeof total === 'number') {
        return total;
    }
    return 0;
}

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const CONFIG_FILE = path.join(BASE_DATA_DIR, 'service_platform', 'siem_config.json');

const { readDataSync } = require('../lib/db');

function getSiemConfig() {
    try {
        const data = readDataSync('elk_siem_config', { enabled: false, tasks: [] });
        // ensure default interval for legacy tasks
        if (data.tasks) {
            data.tasks.forEach(t => { if (!t.interval) t.interval = 10; });
        }
        return data;
    } catch {
        return { enabled: false, tasks: [] };
    }
}

const http = require('http');
const https = require('https');
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true
});

function getEsBaseUrl(master, proto) {
    if (!master) return '';
    let target = master.trim();

    if (/^https?:\/\//i.test(target)) {
        try {
            const parsed = new URL(target);
            const protocol = parsed.protocol;
            const host = parsed.hostname;
            const port = parsed.port || '9200';
            return `${protocol}//${host}:${port}`;
        } catch {
            return target.replace(/\/+$/, '');
        }
    }

    const defaultProto = (proto && proto.toLowerCase() === 'https') ? 'https://' : 'http://';
    if (target.includes(':')) {
        const [host, port] = target.split(':');
        return `${defaultProto}${host}:${port || 9200}`;
    }
    return `${defaultProto}${target}:9200`;
}

function getEnvMap() {
    const envMap = {};
    Object.keys(process.env).forEach(key => {
        const match = key.match(/^ELK_([A-Z0-9_]+)_MASTER$/);
        if (match) {
            const cluster = match[1];
            const rawMaster = process.env[`ELK_${cluster}_MASTER`] || '';
            const explicitProto = process.env[`ELK_${cluster}_PROTO`] || (rawMaster.startsWith('https://') ? 'https' : 'http');
            envMap[cluster] = {
                master: rawMaster,
                proto: explicitProto,
                account: process.env[`ELK_${cluster}_ACCOUNT`],
                pwd: process.env[`ELK_${cluster}_PWD`]
            };
        }
    });
    return envMap;
}

function formatSample(h) {
    const src = h._source || {};
    const time = src['@timestamp'] || '-';
    
    // ECS or fallback to winlogbeat native fields
    const user = src.user?.name || src.winlog?.event_data?.TargetUserName || src.winlog?.event_data?.SubjectUserName || '-';
    const ip = src.source?.ip || src.winlog?.event_data?.IpAddress || '-';
    const host = src.agent?.hostname || src.host?.name || src.winlog?.computer_name || '-';
    const code = src.event?.code || src.winlog?.event_id || '-';
    
    return `Time: ${time} | User: ${user} | SrcIP: ${ip} | Host: ${host} | EventCode: ${code}`;
}

async function sendTelegram(message) {
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
    const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return;

    const { getAxiosProxyConfig } = require('../lib/proxyHelper');
    const proxyConfig = getAxiosProxyConfig('Telegram');

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        }, {
            timeout: 8000,
            proxy: proxyConfig
        });
    } catch (e) {
        console.error('[SIEM] Telegram fail:', e.message);
    }
}

// Local sendMail removed, using shared lib/mailer

async function pollTask(task, envName, envData, intervalMins) {
    if (!envData.master || !envData.account || !envData.pwd) return;

    // Query construction
    let mustQuery = [
        {
            range: {
                "@timestamp": {
                    "gte": `now-${intervalMins + 3}m`,
                    "lte": "now-3m"
                }
            }
        }
    ];

    if (task.type === 'rdp_login') {
        mustQuery.push({ match: { "winlog.event_id": "4624" } });
        mustQuery.push({ match: { "winlog.event_data.LogonType": "10" } });
    } else {
        const eventIds = task.eventIds.split(',').map(id => id.trim()).filter(id => id);
        if (eventIds.length) {
            mustQuery.push({ terms: { "winlog.event_id": eventIds } });
        } else {
            return; // No IDs to monitor
        }
    }

    const payload = {
        query: {
            bool: {
                must: mustQuery
            }
        },
        size: 5,
        sort: [{ "@timestamp": { "order": "desc" } }]
    };

    const credentials = Buffer.from(`${envData.account}:${envData.pwd}`).toString('base64');
    const headers = {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
    };

    const { getAxiosProxyConfig } = require('../lib/proxyHelper');
    const proxyConfig = getAxiosProxyConfig('SIEM');

    try {
        // Suppress timeout/errors by using strict timeout
        const url = `http://${envData.master}:9200/winlogbeat-*/_search?allow_no_indices=true&ignore_unavailable=true`;
        const res = await axios.post(url, payload, { headers, timeout: 15000, proxy: proxyConfig });
        
        const hitsCount = getHitsValue(res);
        const threshold = parseInt(task.threshold, 10) || 1;

        if (hitsCount >= threshold) {
            const samples = (res.data.hits?.hits || []).map(formatSample).join('\n');
            const displayIds = task.type === 'rdp_login' ? '4624 (RDP Type 10)' : task.eventIds;

            if (task.enableTelegram) {
                const text = `🚨 <b>SIEM Alert</b> [${envName}]\nTask: <i>${task.name}</i>\nTarget: ${displayIds}\nTotal Hits (${intervalMins}m): <b>${hitsCount}</b> (Threshold: ${threshold})\n\n<u>Latest samples:</u>\n${samples}`;
                await sendTelegram(text);
            }

            if (task.enableMail) {
                const subject = `[SIEM Alert] ${task.name} - Hits: ${hitsCount} in ${envName}`;
                const body = `<h3>SIEM Alert Triggered</h3>
                <b>Environment:</b> ${envName}<br>
                <b>Task:</b> ${task.name}<br>
                <b>Target:</b> ${displayIds}<br>
                <b>Total Hits (last ${intervalMins}m):</b> ${hitsCount} (Threshold: ${threshold})<br><br>
                <h4>Latest samples:</h4><pre>${samples}</pre>`;
                await sendMail({
                    subject: subject,
                    html: body
                });
            }
        }
    } catch (e) {
        let msg = e.message;
        if (e.response?.data?.error?.type === 'index_not_found_exception') {
            msg = 'No winlogbeat index exist';
        }
        console.error(`[SIEM] Query failed for Env: ${envName}, Task: ${task.name} ->`, msg);
    }
}

async function testRunTask(task) {
    const envMap = getEnvMap();
    const targets = task.env === 'ALL' ? Object.keys(envMap) : [task.env];
    const results = [];

    for (const envName of targets) {
        const envData = envMap[envName];
        if (!envData || !envData.master || !envData.account || !envData.pwd) {
            results.push({ env: envName, status: 'Error: Missing ELK configuration for this environment.' });
            continue;
        }

        const intervalMins = parseInt(task.interval, 10) || 10;

        let mustQuery = [
            { range: { "@timestamp": { "gte": `now-${intervalMins}m`, "lte": "now" } } }
        ];

        if (task.type === 'rdp_login') {
            mustQuery.push({ match: { "winlog.event_id": "4624" } });
            mustQuery.push({ match: { "winlog.event_data.LogonType": "10" } });
        } else {
            const eventIds = task.eventIds.split(',').map(id => id.trim()).filter(Boolean);
            if (eventIds.length) {
                mustQuery.push({ terms: { "winlog.event_id": eventIds } });
            } else {
                results.push({ env: envName, status: 'Error: No Event IDs specified.' });
                continue;
            }
        }

        const payload = {
            query: {
                bool: {
                    must: mustQuery
                }
            },
            size: 5,
            sort: [{ "@timestamp": { "order": "desc" } }]
        };

        try {
            const credentials = Buffer.from(`${envData.account}:${envData.pwd}`).toString('base64');
            const headers = {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/json'
            };
            const { getAxiosProxyConfig } = require('../lib/proxyHelper');
            const proxyConfig = getAxiosProxyConfig('SIEM');
            const baseUrl = getEsBaseUrl(envData.master, envData.proto);
            const url = `${baseUrl}/winlogbeat-*/_search?allow_no_indices=true&ignore_unavailable=true`;
            const res = await axios.post(url, payload, { 
                headers, 
                timeout: 15000, 
                proxy: proxyConfig,
                httpAgent,
                httpsAgent
            });
            const hitsCount = getHitsValue(res);
            
            const samples = (res.data.hits?.hits || []).map(formatSample);

            results.push({
                env: envName,
                status: 'Success',
                hits: hitsCount,
                samples: samples
            });
        } catch (e) {
            let statusMsg = `Error querying ES: ${e.message}`;
            if (e.response?.data?.error?.type === 'index_not_found_exception') {
                statusMsg = 'No winlogbeat index exist';
            }
            results.push({ env: envName, status: statusMsg });
        }
    }
    return results;
}

let pollTasks = [];

const { auditLog } = require('../lib/logger');

function reloadPoller() {
    // Clean up existing tasks
    pollTasks.forEach(job => clearInterval(job));
    pollTasks = [];

    const activeConfig = getSiemConfig();
    if (!activeConfig.enabled || !activeConfig.tasks || activeConfig.tasks.length === 0) {
        auditLog('SYSTEM', 'SIEM', 'Engine started but no active tasks found or engine disabled.');
        return;
    }

    const envMap = getEnvMap();
    const activeTasks = activeConfig.tasks.filter(t => t.enabled);
    const msg = `Engine ON - Scheduling ${activeTasks.length} active tasks...`;
    console.log(`[SIEM] ${msg}`);
    auditLog('SYSTEM', 'SIEM', msg);

    for (const task of activeTasks) {
        const intervalMins = parseInt(task.interval, 10) || 10;
        
        console.log(`[SIEM] Registered Task: ${task.name} (Poll every ${intervalMins}m)`);
        
        let lastTickMinute = -1;
        let isPolling = false;
        const job = setInterval(async () => {
            const now = new Date();
            const currentM = now.getMinutes();
            // Using modulo to simulate */interval
            if (currentM % intervalMins === 0 && lastTickMinute !== currentM) {
                if (isPolling) {
                    console.log(`[SIEM] Task ${task.name} is already polling. Skipping overlapping run.`);
                    return;
                }
                lastTickMinute = currentM;
                isPolling = true;
                try {
                    console.log(`[SIEM] Executing Scheduled Task: ${task.name}`);
                    const targets = task.env === 'ALL' ? Object.keys(envMap) : [task.env];
                    for (const envName of targets) {
                        if (!envMap[envName]) continue;
                        await pollTask(task, envName, envMap[envName], intervalMins);
                    }
                } finally {
                    isPolling = false;
                }
            } else if (currentM % intervalMins !== 0) {
                lastTickMinute = -1;
            }
        }, 10000);

        pollTasks.push(job);
    }
}

function startPoller() {
    auditLog('SYSTEM', 'SIEM', 'SIEM Poller service initializing...');
    reloadPoller();
}

async function getTopThreatToday() {
    const config = getSiemConfig();
    if (!config.enabled || !config.tasks) return null;

    const activeTasks = config.tasks.filter(t => t.enabled);
    if (activeTasks.length === 0) return null;

    const envMap = getEnvMap();
    const envNames = Object.keys(envMap);
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const threatScores = [];

    for (const task of activeTasks) {
        let totalHits = 0;
        const targets = task.env === 'ALL' ? envNames : [task.env];

        for (const envName of targets) {
            const envData = envMap[envName];
            if (!envData || !envData.master || !envData.account || !envData.pwd) continue;

            let mustQuery = [
                { range: { "@timestamp": { gte: todayStart.toISOString(), lte: new Date().toISOString() } } }
            ];

            if (task.type === 'rdp_login') {
                mustQuery.push({ match: { "winlog.event_id": "4624" } });
                mustQuery.push({ match: { "winlog.event_data.LogonType": "10" } });
            } else {
                const eventIds = task.eventIds.split(',').map(id => id.trim()).filter(Boolean);
                if (eventIds.length) {
                    mustQuery.push({ terms: { "winlog.event_id": eventIds } });
                } else {
                    continue;
                }
            }

            const payload = {
                query: { bool: { must: mustQuery } },
                size: 0
            };

            try {
                const credentials = Buffer.from(`${envData.account}:${envData.pwd}`).toString('base64');
                const headers = { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' };
                const { getAxiosProxyConfig } = require('../lib/proxyHelper');
                const proxyConfig = getAxiosProxyConfig('SIEM');
                const url = `http://${envData.master}:9200/winlogbeat-*/_search?allow_no_indices=true`;
                const res = await axios.post(url, payload, { headers, timeout: 5000, proxy: proxyConfig });
                totalHits += getHitsValue(res);
            } catch (e) {
                // Ignore query error for single env
            }
        }

        threatScores.push({
            name: task.name,
            hits: totalHits,
            type: task.type,
            eventIds: task.eventIds
        });
    }

    threatScores.sort((a, b) => b.hits - a.hits);

    const top = threatScores[0];
    if (!top || top.hits === 0) {
        return {
            name: 'No active threats detected',
            hits: 0,
            eventIds: '',
            status: 'Stable'
        };
    }

    return top;
}

module.exports = { startPoller, testRunTask, reloadPoller, getTopThreatToday };
