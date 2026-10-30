const fs = require('fs');
const path = require('path');
const net = require('net');
const { auditLog, sendTelegramAlert, summarizeLines } = require('../lib/logger');
const { getTargetsSafely, saveTargetsSafely } = require('../lib/prometheusTargetHelper');
const { readDataSync, writeDataSync } = require('../lib/db');

const HEALTH_CHECK_CONFIG_KEY = 'prometheus_health_check.json';

function getHealthCheckConfig() {
    const defaultConfig = {
        enabled: false,
        intervalMinutes: 15,
        lastRun: null
    };
    try {
        const cfg = readDataSync(HEALTH_CHECK_CONFIG_KEY, defaultConfig);
        return { ...defaultConfig, ...(cfg || {}) };
    } catch (e) {
        return defaultConfig;
    }
}

function updateHealthCheckConfig(newConfig) {
    const current = getHealthCheckConfig();
    const updated = {
        ...current,
        enabled: !!newConfig.enabled,
        intervalMinutes: Math.max(1, parseInt(newConfig.intervalMinutes, 10) || 15)
    };
    if (newConfig.lastRun !== undefined) {
        updated.lastRun = newConfig.lastRun;
    }
    writeDataSync(HEALTH_CHECK_CONFIG_KEY, updated);
    initPrometheusScheduler();
    return updated;
}

function getTargets() {
    return getTargetsSafely();
}

async function saveTargets(data) {
    return await saveTargetsSafely(data, 'health_scan');
}

function checkPort(host, port, timeout = 2000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            resolve(false);
        });
        socket.connect(port, host);
    });
}

let isScanning = false;

async function runPrometheusHealthScan() {
    if (isScanning) {
        console.log('[Prometheus] Health scan already in progress, skipping...');
        return;
    }
    isScanning = true;
    try {
        console.log('[Prometheus] Starting background target health scan...');
        const targets = getTargets();
        if (targets.length === 0) return { total: 0, offline: 0 };

        let offlineCount = 0;
        const previousStatuses = {};
        const newlyOffline = [];
        
        // Scan all targets concurrently
        await Promise.all(targets.map(async (t) => {
            const [ip, portStr] = t.targets[0].split(':');
            const port = parseInt(portStr, 10);
            const isOnline = await checkPort(ip, port);
            
            // Save previous status
            previousStatuses[ip] = t._status || 'unknown';
            
            t._status = isOnline ? 'online' : 'offline';
            t._lastChecked = new Date().toISOString();
            
            if (!isOnline) {
                offlineCount++;
                // If it just went offline
                if (previousStatuses[ip] === 'online') {
                    const host = t.labels.host !== '-' ? t.labels.host : ip;
                    newlyOffline.push(`${host} (${ip}:${port})`);
                }
            }
        }));

        // One notification per scan, however many exporters went offline at once
        if (newlyOffline.length === 1) {
            sendTelegramAlert(`🚨 [Prometheus Target Alert]\nExporter Offline: ${newlyOffline[0]}`, 'Prometheus');
        } else if (newlyOffline.length > 1) {
            sendTelegramAlert(`🚨 [Prometheus Target Alert]\n${newlyOffline.length} 個 Exporter 轉為離線：\n${summarizeLines(newlyOffline.sort())}`, 'Prometheus');
        }

        // Re-read latest targets to avoid overwriting user edits during the scan
        const latestTargets = getTargets();
        let updatedTargetsCount = 0;

        latestTargets.forEach(lt => {
            const scanned = targets.find(t => t.labels.addr === lt.labels.addr);
            if (scanned) {
                lt._status = scanned._status;
                lt._lastChecked = scanned._lastChecked;
                updatedTargetsCount++;
            }
        });

        await saveTargets(latestTargets);
        
        const nowIso = new Date().toISOString();
        const currentCfg = getHealthCheckConfig();
        currentCfg.lastRun = nowIso;
        writeDataSync(HEALTH_CHECK_CONFIG_KEY, currentCfg);

        const summary = `Health scan complete. Targets: ${latestTargets.length}, Offline: ${offlineCount}`;
        console.log(`[Prometheus] ${summary}`);
        auditLog('System', 'Prometheus', summary);
        return { total: latestTargets.length, offline: offlineCount, lastRun: nowIso };
    } finally {
        isScanning = false;
    }
}

let scanTask = null;
let lastScanTimestamp = 0;
let lastTickDailyMinute = -1;

function initPrometheusScheduler() {
    if (scanTask) {
        clearInterval(scanTask);
        scanTask = null;
    }

    const config = getHealthCheckConfig();
    const scanTime = process.env.PROMETHEUS_SCAN_TIME || '';

    if (!config.enabled && (!scanTime || !scanTime.includes(':'))) {
        console.log('[Prometheus] Health check scheduler is currently inactive (disabled in config & no PROMETHEUS_SCAN_TIME).');
        return;
    }

    if (config.enabled) {
        console.log(`[Prometheus] Health check native polling engine active: interval = ${config.intervalMinutes} min(s)`);
        if (config.lastRun) {
            const parsed = new Date(config.lastRun).getTime();
            if (!isNaN(parsed)) lastScanTimestamp = parsed;
        }
    }

    if (scanTime && scanTime.includes(':')) {
        console.log(`[Prometheus] Daily health scan also scheduled at ${scanTime}`);
    }

    // Native Local Time Polling Engine (OS Date + setInterval to prevent timezone bugs on Windows Server)
    scanTask = setInterval(() => {
        const now = new Date();
        const nowMs = now.getTime();

        // 1. Interval-based polling if enabled
        if (config.enabled && config.intervalMinutes > 0) {
            const intervalMs = config.intervalMinutes * 60 * 1000;
            if (!lastScanTimestamp || (nowMs - lastScanTimestamp) >= intervalMs) {
                lastScanTimestamp = nowMs;
                runPrometheusHealthScan().catch(err => console.error('[Prometheus] Poller error:', err));
            }
        }

        // 2. Optional fixed daily scan time if configured in env
        if (scanTime && scanTime.includes(':')) {
            const [targetH, targetM] = scanTime.split(':').map(Number);
            const currentH = now.getHours();
            const currentM = now.getMinutes();

            if (currentH === targetH && currentM === targetM && lastTickDailyMinute !== currentM) {
                lastTickDailyMinute = currentM;
                runPrometheusHealthScan().catch(err => console.error('[Prometheus] Daily scan error:', err));
            } else if (currentM !== targetM) {
                lastTickDailyMinute = -1;
            }
        }
    }, 10000);
}

module.exports = {
    runPrometheusHealthScan,
    initPrometheusScheduler,
    getHealthCheckConfig,
    updateHealthCheckConfig
};
