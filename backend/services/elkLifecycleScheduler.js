const axios = require('axios');
const { readDataSync, writeDataSync } = require('../lib/db');
const { auditLog } = require('../lib/logger');
const { getEnvMap, getEsBaseUrl, getHttpConfig } = require('../lib/elkHelper');

const STORE_KEY = 'service_platform_elk_violations.json';

const DEFAULT_CONFIG = {
    schedule: '1 day', // '1 day', '7 day', '30 day', 'disabled'
    targetEnv: '',
    indexPattern: '',
    lastScanTime: null,
    lastScanStatus: 'Idle',
    violations: [],
    totalChecked: 0,
    lastError: null
};

function getViolationsData() {
    return readDataSync(STORE_KEY, DEFAULT_CONFIG);
}

function saveViolationsData(data) {
    writeDataSync(STORE_KEY, data);
}

/**
 * Executes an on-demand or scheduled scan for lifecycle violations across target pattern(s).
 */
async function scanLifecycleViolations(env, indexPattern) {
    const envMap = getEnvMap();
    const targetCluster = (env || '').toUpperCase();
    const envData = envMap[targetCluster] || Object.values(envMap)[0];

    if (!envData || !envData.master) {
        throw new Error(`ELK environment "${env || 'DEFAULT'}" is not configured or missing master endpoint`);
    }

    const pattern = (indexPattern || '').trim() || '*';
    const baseUrl = getEsBaseUrl(envData.master, envData.proto);
    const httpCfg = getHttpConfig(envData);

    const patterns = pattern.split(',').map(p => p.trim()).filter(Boolean);
    const checkedIndexMap = new Map();
    const allViolations = [];

    for (const pat of (patterns.length > 0 ? patterns : ['*'])) {
        try {
            // 1. Fetch indices matching the pattern with sizes and doc counts
            const catUrl = `${baseUrl}/_cat/indices/${encodeURIComponent(pat)}?format=json&h=index,docs.count,store.size,status,health,creation.date.string`;
            const catRes = await axios.get(catUrl, httpCfg);
            const indicesList = Array.isArray(catRes.data) ? catRes.data : [];

            // 2. Fetch ILM explain for indices matching the pattern
            let ilmIndices = {};
            try {
                const ilmUrl = `${baseUrl}/${encodeURIComponent(pat)}/_ilm/explain`;
                const ilmRes = await axios.get(ilmUrl, httpCfg);
                ilmIndices = ilmRes.data?.indices || {};
            } catch (ilmErr) {
                // If ILM is not enabled on cluster or 404, all indices might be unmanaged
                console.warn(`[ELK Lifecycle] ILM explain query returned warning:`, ilmErr.response?.data || ilmErr.message);
            }

            for (const item of indicesList) {
                const idxName = item.index;
                if (!idxName || checkedIndexMap.has(idxName)) continue;
                checkedIndexMap.set(idxName, true);

                // Exclude system internal dot-indices unless pattern explicitly requested dot-indices
                if (idxName.startsWith('.') && !pat.startsWith('.')) {
                    continue;
                }

                const ilmInfo = ilmIndices[idxName];
                const isManaged = Boolean(ilmInfo && ilmInfo.managed === true && ilmInfo.policy);

                if (!isManaged) {
                    allViolations.push({
                        index: idxName,
                        health: item.health || 'unknown',
                        status: item.status || 'open',
                        docsCount: item['docs.count'] || '0',
                        storeSize: item['store.size'] || '0b',
                        creationDate: item['creation.date.string'] || new Date().toISOString(),
                        policy: ilmInfo?.policy || 'None',
                        managed: false,
                        detectedAt: new Date().toISOString()
                    });
                }
            }
        } catch (catErr) {
            console.error(`[ELK Lifecycle] Failed scanning pattern "${pat}":`, catErr.response?.data || catErr.message);
            throw new Error(`Elasticsearch query failed for pattern "${pat}": ${catErr.response?.data?.error?.reason || catErr.message}`);
        }
    }

    // Persist latest findings
    const current = getViolationsData();
    const updated = {
        ...current,
        targetEnv: targetCluster || current.targetEnv || Object.keys(envMap)[0] || '',
        indexPattern: pattern,
        lastScanTime: new Date().toISOString(),
        lastScanStatus: 'Success',
        violations: allViolations,
        totalChecked: checkedIndexMap.size,
        lastError: null
    };

    saveViolationsData(updated);
    return updated;
}

/**
 * Deletes an index or list of indices from Elasticsearch cluster.
 */
async function deleteIndices(env, indexNames, username = 'SYSTEM') {
    const envMap = getEnvMap();
    const targetCluster = (env || '').toUpperCase();
    const envData = envMap[targetCluster] || Object.values(envMap)[0];

    if (!envData || !envData.master) {
        throw new Error(`ELK environment "${env}" is not configured or missing master endpoint`);
    }

    const baseUrl = getEsBaseUrl(envData.master, envData.proto);
    const httpCfg = getHttpConfig(envData);
    const targets = Array.isArray(indexNames) ? indexNames : [indexNames];
    const results = [];

    for (const idx of targets) {
        const cleanName = String(idx).trim();
        if (!cleanName) continue;

        try {
            const delRes = await axios.delete(`${baseUrl}/${encodeURIComponent(cleanName)}`, httpCfg);
            auditLog(username, 'ELK Manager', `Deleted lifecycle violation index: [${cleanName}] on Env: ${targetCluster}`);
            results.push({ index: cleanName, success: true, response: delRes.data });
        } catch (delErr) {
            const errMsg = delErr.response?.data?.error?.reason || delErr.response?.data || delErr.message;
            results.push({ index: cleanName, success: false, error: errMsg });
        }
    }

    // Remove successfully deleted indices from stored violation cache
    const current = getViolationsData();
    const successfulDeletes = new Set(results.filter(r => r.success).map(r => r.index));
    if (successfulDeletes.size > 0 && Array.isArray(current.violations)) {
        current.violations = current.violations.filter(v => !successfulDeletes.has(v.index));
        saveViolationsData(current);
    }

    return results;
}

let schedulerTimer = null;
let lastTickMinute = -1;

/**
 * Native Local Time Polling Engine for Lifecycle Violations
 * Adheres strictly to Rule 6:
 * OS local time (Date object) + setInterval polling avoids Windows Server 2016 timezone/daylight shift bugs.
 */
function initElkLifecycleScheduler() {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }

    console.log('[ELK Lifecycle Scheduler] Initializing Native Local Time Polling Engine...');

    schedulerTimer = setInterval(async () => {
        try {
            const config = getViolationsData();
            if (!config || config.schedule === 'disabled' || !config.indexPattern) {
                return;
            }

            const now = new Date();
            const currentMinute = now.getMinutes();

            // Run at the beginning of each minute cycle check
            if (lastTickMinute === currentMinute) return;
            lastTickMinute = currentMinute;

            const schedule = (config.schedule || '1 day').toLowerCase();
            const lastScanMs = config.lastScanTime ? new Date(config.lastScanTime).getTime() : 0;
            const nowMs = now.getTime();
            const diffMs = nowMs - lastScanMs;

            let shouldRun = false;

            if (schedule.includes('1 day')) {
                // 1 day: Once every 24 hours (86,400,000 ms) or if never run
                if (diffMs >= 24 * 60 * 60 * 1000) {
                    shouldRun = true;
                }
            } else if (schedule.includes('7 day')) {
                // 7 days: Once every 7 days (604,800,000 ms)
                if (diffMs >= 7 * 24 * 60 * 60 * 1000) {
                    shouldRun = true;
                }
            } else if (schedule.includes('30 day')) {
                // 30 days: Once every 30 days (2,592,000,000 ms)
                if (diffMs >= 30 * 24 * 60 * 60 * 1000) {
                    shouldRun = true;
                }
            }

            if (shouldRun) {
                console.log(`[ELK Lifecycle Scheduler] Triggering scheduled violation scan for pattern "${config.indexPattern}" on env "${config.targetEnv}"`);
                auditLog('SYSTEM', 'ELK Manager', `Triggered scheduled lifecycle violation scan: ${config.indexPattern}`);
                
                try {
                    await scanLifecycleViolations(config.targetEnv, config.indexPattern);
                    console.log(`[ELK Lifecycle Scheduler] Scheduled scan completed successfully.`);
                } catch (scanErr) {
                    console.error(`[ELK Lifecycle Scheduler] Scheduled scan failed:`, scanErr.message);
                    const cur = getViolationsData();
                    cur.lastScanStatus = 'Failed';
                    cur.lastError = scanErr.message;
                    saveViolationsData(cur);
                }
            }
        } catch (e) {
            console.error('[ELK Lifecycle Scheduler] Unexpected tick error:', e.message);
        }
    }, 60000); // 1 minute local time poll interval
}

module.exports = {
    getViolationsData,
    saveViolationsData,
    scanLifecycleViolations,
    deleteIndices,
    initElkLifecycleScheduler
};
