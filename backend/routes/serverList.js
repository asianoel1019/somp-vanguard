const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog, sendTelegramAlert, queueNotification, summarizeLines } = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');
const { getAllSubnetData } = require('../services/inventoryStore');
const {
    getFieldAuthorityRules,
    saveFieldAuthorityRules,
    resetFieldAuthorityRules,
    queryCmdbServers,
    getCmdbServerByIp,
    upsertCmdbServer,
    bulkUpsertCmdbServers,
    deleteCmdbServer,
    shortHostname
} = require('../services/cmdbModel');
const serverDeletion = require('../services/serverDeletion');
const envRegistry = require('../lib/environmentRegistry');

router.use(requireAuth);
router.use(checkFeature('serverList'));
router.use(checkRole(['Viewer', 'Operator', 'SuperAdmin']));

// --- CMDB Field Authority Endpoints ---
router.get('/field-authority', (req, res) => {
    try {
        const rules = getFieldAuthorityRules();
        res.json({ success: true, rules });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/field-authority', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { rules } = req.body;
        if (!rules || typeof rules !== 'object') {
            return res.status(400).json({ error: 'Invalid rules object' });
        }
        const saved = saveFieldAuthorityRules(rules);
        auditLog(req.user?.username || 'SYSTEM', 'CMDB Field Authority', 'Updated CMDB Field Authority & Sync Rules');
        res.json({ success: true, rules: saved });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/field-authority/reset', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const rules = resetFieldAuthorityRules();
        auditLog(req.user?.username || 'SYSTEM', 'CMDB Field Authority', 'Reset CMDB Field Authority & Sync Rules to defaults');
        res.json({ success: true, rules });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
const CMDB_HISTORY_KEY = 'server_operation/server_cmdb_history.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';
const ipamStore = require('../lib/ipamStore'); // every IPAM write goes through its atomic read-modify-write
const PROMETHEUS_KEY = 'prometheus_targets.json';
const { getTargetsSafely, updateTargetsSafely } = require('../lib/prometheusTargetHelper');
const REDIS_KEY = 'service_platform/redis_connections.json';
const ENV_KEY = 'system/environments.json';
const DC_KEY = 'data_center/datacenters.json';

function parseJSON(val, def) {
    if (!val) return def;
    try { return JSON.parse(val); } catch(e) { return def; }
}

const STANDARD_RAM_SIZES = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

function normalizeRamGB(val) {
    const num = Number(val);
    if (!num || isNaN(num)) return 0;
    
    for (const std of STANDARD_RAM_SIZES) {
        if (num >= std * 0.94 && num <= std * 1.05) {
            return std;
        }
    }
    return Math.round(num);
}

// Compare IP addresses numerically (e.g. 203.0.113.2 < 203.0.113.10)
function compareIPs(ipA, ipB) {
    const partsA = (ipA || '').split('.').map(n => parseInt(n, 10) || 0);
    const partsB = (ipB || '').split('.').map(n => parseInt(n, 10) || 0);
    
    for (let i = 0; i < 4; i++) {
        if (partsA[i] !== partsB[i]) {
            return partsA[i] - partsB[i];
        }
    }
    return 0;
}

// Helper to record CMDB Audit History
function recordCmdbHistory(ip, username, action, oldData, newData) {
    try {
        let history = readDataSync(CMDB_HISTORY_KEY, []);
        const entry = {
            id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 4),
            ip: String(ip).trim(),
            username: username || 'SYSTEM',
            action: action || 'UPDATE',
            timestamp: new Date().toISOString(),
            oldData: oldData || {},
            newData: newData || {}
        };
        history.unshift(entry);
        if (history.length > 500) history = history.slice(0, 500);
        writeDataSync(CMDB_HISTORY_KEY, history);
    } catch (e) {
        console.error('[ServerList CMDB History] Error:', e.message);
    }
}

// Clears the Server List "deleted" flag on a meta entry (explicit user intent to re-create / restore).
// Linked VIPs keep their flag (linkVip marks them deleted on purpose). Returns true when the flag was cleared.
function clearDeletedFlag(entry, username) {
    if (!entry || entry.deleted !== true || serverDeletion.isLinkedVipMeta(entry)) return false;
    entry.deleted = false;
    entry.restoredAt = new Date().toISOString();
    entry.restoredBy = username || 'SYSTEM';
    delete entry.deletedAt;
    delete entry.deletedBy;
    delete entry.deletedNames;
    return true;
}

/**
 * Explicit environment of a Server List write (envId and/or envName: id, name or code, case-insensitive).
 * Returns {} when none was given, { env } when it resolves, { error } for an unknown value (never a silent default).
 */
function resolveEnvInput(envId, envName, envs) {
    const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    if (!given(envId) && !given(envName)) return {};
    // "Unassigned" is the display of an unknown / missing reference sent back unchanged: leave the stored value
    if (!given(envId) && String(envName).trim() === envRegistry.UNASSIGNED) return { unchanged: true };
    const list = envs || envRegistry.getEnvironments();
    const env = envRegistry.resolveRecordEnv(given(envId) ? envId : null, given(envName) ? envName : null, list);
    if (!env) {
        return { error: `Unknown environment "${String(given(envName) ? envName : envId).trim()}". Allowed: ${envRegistry.allowedNames(list).join(', ')}` };
    }
    return { env };
}

// Cross-module sync helper for IPAM & Prometheus when CMDB metadata updates.
// envRef: environment id, name or code; Prometheus always receives the canonical NAME (labels are strings),
// an unknown value leaves the zone label untouched.
async function syncCrossModules(ip, applicationName, businessUnit, fqdn, envRef) {
    if (!ip) return;
    const cleanIp = String(ip).trim();
    const envName = envRef !== undefined && envRef !== null && envRef !== '' ? envRegistry.canonicalName(envRef) : null;

    // 1. Sync to IPAM subnets.json (service & owner & fqdn)
    try {
        // atomic read-modify-write through the IPAM store (written only when something changed)
        ipamStore.mutateSubnets((subnets) => {
            subnets.forEach(sub => {
                if (Array.isArray(sub.ips)) {
                    sub.ips.forEach(rec => {
                        if (String(rec.address).trim() === cleanIp) {
                            if (applicationName !== undefined && applicationName !== '') rec.service = applicationName;
                            if (businessUnit !== undefined && businessUnit !== '') {
                                rec.owner = businessUnit;
                                rec.assignedTo = businessUnit;
                            }
                            if (fqdn !== undefined && fqdn !== '') rec.fqdn = fqdn;
                        }
                    });
                }
            });
        }, { reason: 'server list sync' });
    } catch (e) {
        console.error(`[ServerList Sync] IPAM sync error for ${cleanIp}:`, e.message);
    }

    // 2. Sync to Prometheus targets.json (applications & bu)
    try {
        // Atomic read-modify-write under the shared Prometheus lock (no lost concurrent additions)
        const { saved: promChanged } = await updateTargetsSafely((targets) => {
            let changed = false;
            targets.forEach(t => {
                let targetIp = t.ip || t.labels?.addr;
                if (!targetIp && t.targets && t.targets[0]) targetIp = t.targets[0].split(':')[0];
                if (String(targetIp).trim() === cleanIp) {
                    if (applicationName !== undefined && applicationName !== '') {
                        t.applications = applicationName;
                        if (t.labels) t.labels.application = applicationName;
                    }
                    if (businessUnit !== undefined && businessUnit !== '') {
                        t.bu = businessUnit;
                        if (t.labels) t.labels.group = businessUnit;
                    }
                    if (envName) {
                        t.zone = envName;
                        if (t.labels) t.labels.zone = envName;
                    }
                    changed = true;
                }
            });
            return changed ? { targets } : null;
        }, 'cmdb_single_sync');

        if (promChanged) {
            // Bulk CMDB edits call this once per IP: merge them into one notification
            queueNotification('prometheus-linkage-cmdb', 'Prometheus', cleanIp, (ips) => ips.length === 1
                ? `🎯 [Prometheus Target Linkage - CMDB 單筆更新]\nCMDB 已同步更新 Prometheus Target：\n• IP: ${ips[0]}\n• 觸發來源：Server List Single Edit`
                : `🎯 [Prometheus Target Linkage - CMDB 批量更新 (${ips.length} 筆)]\nCMDB 已同步更新 ${ips.length} 筆 Prometheus Target：\n${summarizeLines(ips)}\n\n• 觸發來源：Server List Edit`);
        }
    } catch (e) {
        console.error(`[ServerList Sync] Prometheus sync error for ${cleanIp}:`, e.message);
    }
}

// Helper to extract all Compute devices and nodes from all Data Centers' Server Racks
function getAllRackComputeDevices() {
    try {
        const dataCenters = readDataSync(DC_KEY, []);
        const dcMap = {};
        dataCenters.forEach(dc => { if (dc && dc.id) dcMap[dc.id] = dc; });

        const computeTypes = new Set(['Server', 'Nutanix', 'BladeChassis']);
        const rackDevices = [];

        // Collect all rack file keys: default and per-DC
        const rackFileKeys = new Set(['data_center/server_rack.json']);
        dataCenters.forEach(dc => {
            if (dc && dc.id) {
                rackFileKeys.add(dc.id === 'default' ? 'data_center/server_rack.json' : `data_center/server_rack_${dc.id}.json`);
            }
        });

        rackFileKeys.forEach(fileKey => {
            let dcId = 'default';
            const m = fileKey.match(/server_rack_(.+)\.json$/);
            if (m) dcId = m[1];
            const dc = dcMap[dcId] || { name: dcId === 'default' ? 'Default DC' : dcId };

            const racks = readDataSync(fileKey, []);
            if (Array.isArray(racks)) {
                racks.forEach(rack => {
                    if (rack && Array.isArray(rack.devices)) {
                        rack.devices.forEach(dev => {
                            if (dev && computeTypes.has(dev.type)) {
                                const unitPos = dev.uPosition || dev.u_location || (dev.startU ? `U${dev.startU}` : (dev.uStart ? `U${dev.uStart}` : ''));
                                
                                // If multi-node chassis (Nutanix / BladeChassis)
                                if (dev.isChassis && Array.isArray(dev.nodes) && dev.nodes.length > 0) {
                                    dev.nodes.forEach((node, nodeIdx) => {
                                        if (node && (node.ip || node.hostname || node.sn)) {
                                            rackDevices.push({
                                                ip: node.ip ? String(node.ip).trim() : '',
                                                hostname: node.hostname || `${dev.hostname || dev.type}-Node${nodeIdx + 1}`,
                                                model: node.model || dev.model || '',
                                                sn: node.sn || dev.sn || '',
                                                iloIp: node.iloIp || dev.iloIp || '',
                                                cvmIp: node.cvmIp || dev.cvmIp || '',
                                                type: dev.type,
                                                datacenterName: dc.name || 'Default DC',
                                                datacenterId: dc.id || dcId,
                                                rackId: rack.name || rack.id,
                                                unitPosition: unitPos,
                                                isNode: true,
                                                nodeIndex: nodeIdx + 1,
                                                parentHostname: dev.hostname || ''
                                            });
                                        }
                                    });
                                    // If chassis container has its own management IP
                                    if (dev.ip && !dev.nodes.some(n => n.ip === dev.ip)) {
                                        rackDevices.push({
                                            ip: String(dev.ip).trim(),
                                            hostname: dev.hostname || dev.type,
                                            model: dev.model || '',
                                            sn: dev.sn || '',
                                            iloIp: dev.iloIp || '',
                                            cvmIp: dev.cvmIp || '',
                                            type: dev.type,
                                            datacenterName: dc.name || 'Default DC',
                                            datacenterId: dc.id || dcId,
                                            rackId: rack.name || rack.id,
                                            unitPosition: unitPos,
                                            isNode: false
                                        });
                                    }
                                } else if (dev.ip || dev.hostname || dev.sn) {
                                    // Standalone Compute device
                                    rackDevices.push({
                                        ip: dev.ip ? String(dev.ip).trim() : '',
                                        hostname: dev.hostname || dev.type,
                                        model: dev.model || '',
                                        sn: dev.sn || '',
                                        iloIp: dev.iloIp || '',
                                        cvmIp: dev.cvmIp || '',
                                        type: dev.type,
                                        datacenterName: dc.name || 'Default DC',
                                        datacenterId: dc.id || dcId,
                                        rackId: rack.name || rack.id,
                                        unitPosition: unitPos,
                                        isNode: false
                                    });
                                }
                            }
                        });
                    }
                });
            }
        });

        return rackDevices;
    } catch (e) {
        console.error('[ServerList] Failed to read Rack Compute devices:', e);
        return [];
    }
}

// Function to sync disk metrics from Scout telemetry into CMDB Meta (daily or on-demand)
function syncScoutDisksToCmdb() {
    try {
        const scoutDb = require('../services/scoutDb');
        const monitors = scoutDb.all("SELECT id, ip, name, os, lastSeen FROM monitors WHERE ip IS NOT NULL AND ip != '' AND ip != '0.0.0.0'");
        if (!monitors || monitors.length === 0) return { updated: 0 };

        let cmdbMeta = readDataSync(CMDB_META_KEY, {});
        let updatedCount = 0;
        const scoutServersToUpsert = [];

        monitors.forEach(m => {
            const ip = String(m.ip).trim();
            if (!ip) return;
            if (cmdbMeta[ip] && cmdbMeta[ip].deleted === true) return; // deleted in Server List: never resurrect

            const row = scoutDb.get("SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            if (!row || !row.metrics) return;

            let metrics = null;
            try { metrics = JSON.parse(row.metrics); } catch(e) {}
            if (!metrics) return;

            // Extract disk array from metrics
            const diskList = Array.isArray(metrics.disk) ? metrics.disk : (Array.isArray(metrics.disks) ? metrics.disks : []);
            if (diskList.length === 0) return;

            // Calculate total usable storage across mounted disks
            const isWindows = String(m.os || '').toLowerCase().includes('win');
            let totalGB = 0;
            const validDisks = [];

            diskList.forEach(d => {
                const mount = String(d.mount || '').trim();
                const rawSize = Number(d.totalGB) || (d.total ? Number(d.total) / (1024 * 1024 * 1024) : 0);
                if (rawSize <= 0) return;
                let cleanSize = Math.round(rawSize);
                if (cleanSize <= 0 && rawSize > 0) cleanSize = 1; // Small partitions like /boot (0.99GB) rounded to 1GB

                if (isWindows) {
                    if (/^[A-Za-z]:/.test(mount)) {
                        totalGB += cleanSize;
                        validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                    }
                } else {
                    if (!mount.startsWith('/dev') && !mount.startsWith('/proc') && !mount.startsWith('/sys') && !mount.startsWith('/run') && !mount.startsWith('/boot/efi')) {
                        totalGB += cleanSize;
                        validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                    }
                }
            });

            if (totalGB > 0) {
                if (!cmdbMeta[ip]) cmdbMeta[ip] = {};
                cmdbMeta[ip].diskGB = totalGB;
                cmdbMeta[ip].diskDetails = validDisks;
                cmdbMeta[ip].diskUpdatedAt = new Date().toISOString();
                cmdbMeta[ip].updatedAt = new Date().toISOString();

                scoutServersToUpsert.push({
                    ip: ip,
                    diskGB: totalGB,
                    diskDetails: validDisks,
                    diskDisplay: `${totalGB}GB (${validDisks.map(d => `${d.mount}:${d.totalGB}GB`).join(' / ')})`,
                    agentInstalled: 1,
                    agentStatus: m.status || 'online',
                    lastSeen: m.lastSeen || new Date().toISOString()
                });
                updatedCount++;
            }
        });

        if (scoutServersToUpsert.length > 0) {
            bulkUpsertCmdbServers(scoutServersToUpsert, 'SCOUT_AGENT');
            writeDataSync(CMDB_META_KEY, cmdbMeta);
            console.log(`[Scout CMDB Disk Sync] Successfully updated disk specs for ${updatedCount} servers.`);
        }
        return { updated: updatedCount };
    } catch (e) {
        console.error('[Scout CMDB Disk Sync Error]', e);
        return { updated: 0, error: e.message };
    }
}

// Native Local Time Polling Engine for Daily Scout Disk -> CMDB Sync (Rule 6: native setInterval + Date)
let lastDiskSyncDate = '';

function startDailyScoutDiskPoller() {
    const initialTimer = setTimeout(() => {
        try {
            syncScoutDisksToCmdb();
        } catch (e) {
            console.error('[Scout Disk Poller Initial Error]', e);
        }
    }, 10000);
    initialTimer.unref();

    const dailyTimer = setInterval(() => {
        const now = new Date();
        const currentDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const currentHour = now.getHours();

        // Check once daily at or after 02:00 AM local time
        if (currentHour >= 2 && lastDiskSyncDate !== currentDateStr) {
            lastDiskSyncDate = currentDateStr;
            console.log(`[Scout Disk Poller] Running daily scheduled CMDB disk sync for ${currentDateStr} (Local Time: ${now.toLocaleTimeString()})...`);
            syncScoutDisksToCmdb();
        }
    }, 15 * 60 * 1000);
    dailyTimer.unref();
}

startDailyScoutDiskPoller();

// POST /api/server-list/sync-all (Global Auto-Sync)
router.post('/sync-all', requireAuth, async (req, res) => {
    try {
        syncScoutDisksToCmdb();
        const inventory = getAllSubnetData() || [];
        const promTargets = getTargetsSafely();
        const ipamSubnets = readDataSync(IPAM_KEY, []);
        let cmdbMeta = readDataSync(CMDB_META_KEY, {});
        const environments = envRegistry.getEnvironments();

        // Read Scout Agent Monitors
        const scoutDb = require('../services/scoutDb');
        let scoutMonitors = [];
        try {
            scoutMonitors = scoutDb.all("SELECT id, ip, name, os, lastSeen FROM monitors WHERE ip IS NOT NULL AND ip != '' AND ip != '0.0.0.0'") || [];
        } catch (e) {
            console.error('[ServerList Sync-All] Scout DB read error:', e.message);
        }
        const scoutMap = {};
        scoutMonitors.forEach(m => { scoutMap[String(m.ip).trim()] = m; });

        let updateCount = 0;
        const invMap = {};
        const linkedToMap = {};
        inventory.forEach(i => {
            if (i.ip) {
                if (i.linkedTo) {
                    linkedToMap[String(i.ip).trim()] = String(i.linkedTo).trim();
                } else {
                    invMap[String(i.ip).trim()] = i;
                }
            }
        });

        Object.entries(cmdbMeta).forEach(([ipStr, meta]) => {
            if (meta && (meta.linkedTo || meta.vipOf || meta.isVip)) {
                linkedToMap[String(ipStr).trim()] = meta.linkedTo || meta.vipOf || true;
            }
        });

        const promMap = {};
        promTargets.forEach(t => {
            let ip = t.ip || t.labels?.addr;
            if (!ip && t.targets && t.targets[0]) ip = t.targets[0].split(':')[0];
            if (ip) promMap[String(ip).trim()] = t;
        });

        // Collect IPs from IPAM as well
        const ipamIps = [];
        ipamSubnets.forEach(sub => {
            if (Array.isArray(sub.ips)) {
                sub.ips.forEach(rec => { if (rec.address && rec.status !== 'free') ipamIps.push(String(rec.address).trim()); });
            }
        });

        // Collect Compute devices & nodes from Server Rack
        const rackComputeDevices = getAllRackComputeDevices();
        const rackMap = {};
        rackComputeDevices.forEach(rd => {
            if (rd.ip) rackMap[rd.ip] = rd;
        });

        const allIps = new Set([
            ...Object.keys(invMap),
            ...Object.keys(promMap),
            ...Object.keys(cmdbMeta),
            ...Object.keys(rackMap),
            ...Object.keys(scoutMap),
            ...ipamIps
        ]);

        let promUpdated = false;
        const promModifiedList = [];
        const promEdits = new Map(); // ip -> values re-applied to a fresh read of the targets at save time
        const ipamEdits = new Map(); // ip -> CMDB values re-applied to a fresh read of IPAM at save time
        const user = req.user ? req.user.username : 'System (Global Sync)';
        const history = readDataSync(CMDB_HISTORY_KEY, []);

        for (const ip of allIps) {
            if (linkedToMap[ip]) continue; // Skip sync for linked VIPs/secondary IPs
            if (cmdbMeta[ip] && cmdbMeta[ip].deleted === true) continue; // Deleted in Server List: never resurrect

            let meta = cmdbMeta[ip] || {};
            let metaChanged = false;
            const inv = invMap[ip];
            const prom = promMap[ip];
            const rackDev = rackMap[ip];

            // 1. Sync from Server Rack Compute devices (SN, Model, Hostname, Location, iLO, CVM)
            if (rackDev) {
                if (!meta.hostname && rackDev.hostname) {
                    meta.hostname = rackDev.hostname;
                    metaChanged = true;
                }
                if (!meta.vendor && rackDev.model) {
                    meta.vendor = rackDev.model;
                    metaChanged = true;
                }
                if (!meta.sn && rackDev.sn) {
                    meta.sn = rackDev.sn;
                    metaChanged = true;
                }
                if (!meta.iloIp && rackDev.iloIp) {
                    meta.iloIp = rackDev.iloIp;
                    metaChanged = true;
                }
                if (!meta.cvmIp && rackDev.cvmIp) {
                    meta.cvmIp = rackDev.cvmIp;
                    metaChanged = true;
                }
                if (!meta.datacenterName && rackDev.datacenterName) {
                    meta.datacenterName = rackDev.datacenterName;
                    metaChanged = true;
                }
                if (!meta.rackId && rackDev.rackId) {
                    meta.rackId = rackDev.rackId;
                    metaChanged = true;
                }
                if (!meta.unitPosition && rackDev.unitPosition) {
                    meta.unitPosition = rackDev.unitPosition;
                    metaChanged = true;
                }
                if (!meta.deviceType && rackDev.type) {
                    meta.deviceType = rackDev.type;
                    metaChanged = true;
                }
            }

            // 1. Sync from Inventory to CMDB
            // Also overwrite if previous buggy sync just wrote 'win' or 'linux' or 'unknown'
            if (inv && (!meta.os || meta.os === 'win' || meta.os === 'linux' || String(meta.os).toLowerCase().includes('unknown'))) {
                const bestOs = inv.osname ? inv.osname : (inv.os || '');
                if (bestOs && meta.os !== bestOs) {
                    meta.os = bestOs;
                    metaChanged = true;
                }
            }

            // 2. Sync from Prometheus to CMDB
            if (prom) {
                const pApp = prom.applications || prom.labels?.application || '';
                const pBu = prom.bu || prom.labels?.group || '';
                const pZone = prom.zone || prom.labels?.zone || '';

                if (!meta.applicationName && pApp && pApp !== 'Auto-Discovered') {
                    meta.applicationName = pApp;
                    metaChanged = true;
                }
                if (!meta.businessUnit && pBu && pBu !== 'Inventory') {
                    meta.businessUnit = pBu;
                    metaChanged = true;
                }
                if (!meta.envId && !meta.envName && pZone && pZone !== '-') {
                    // Only a zone that is a known environment is adopted (stored as id + canonical name)
                    const zoneEnv = envRegistry.resolveEnv(pZone, environments);
                    if (zoneEnv) {
                        meta.envId = zoneEnv.id;
                        meta.envName = zoneEnv.name;
                        metaChanged = true;
                    }
                }
            }

            // 3. Sync from CMDB to Prometheus
            if (prom) {
                let thisPromChanged = false;
                if (meta.applicationName && (prom.applications !== meta.applicationName || prom.labels?.application !== meta.applicationName)) {
                    prom.applications = meta.applicationName;
                    if (prom.labels) prom.labels.application = meta.applicationName;
                    thisPromChanged = true;
                }
                if (meta.businessUnit && (prom.bu !== meta.businessUnit || prom.labels?.group !== meta.businessUnit)) {
                    prom.bu = meta.businessUnit;
                    if (prom.labels) prom.labels.group = meta.businessUnit;
                    thisPromChanged = true;
                }
                // Prometheus labels carry the canonical environment NAME, never an id; unknown -> label untouched
                const metaEnv = envRegistry.resolveRecordEnv(meta.envId, meta.envName, environments);
                const envStr = metaEnv ? metaEnv.name : '';

                if (envStr && (prom.zone !== envStr || prom.labels?.zone !== envStr)) {
                    prom.zone = envStr;
                    if (prom.labels) prom.labels.zone = envStr;
                    thisPromChanged = true;
                }
                if (thisPromChanged) {
                    promUpdated = true;
                    promEdits.set(String(ip).trim(), { applicationName: meta.applicationName, businessUnit: meta.businessUnit, envStr });
                    promModifiedList.push({ ip, host: prom.labels?.host || ip });
                }
            }

            // 4. Sync from CMDB to IPAM
            // collected here, applied to a fresh read of the IPAM document at save time (no stale overwrite)
            if (meta.applicationName || meta.businessUnit || meta.fqdn) {
                ipamEdits.set(ip, { applicationName: meta.applicationName, businessUnit: meta.businessUnit, fqdn: meta.fqdn });
            }

            // 5. Sync Disk & Hardware from Scout Agent Telemetry
            const scoutMon = scoutMap[ip];
            if (scoutMon) {
                try {
                    const row = scoutDb.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [scoutMon.id]);
                    if (row && row.metrics) {
                        const met = typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics;
                        const diskList = Array.isArray(met.disk) ? met.disk : (Array.isArray(met.disks) ? met.disks : []);
                        if (diskList.length > 0) {
                            const isWin = String(scoutMon.os || '').toLowerCase().includes('win');
                            let scoutTotal = 0;
                            const validDisks = [];
                            diskList.forEach(d => {
                                const mount = String(d.mount || '').trim();
                                const rawSize = Number(d.totalGB) || (d.total ? Number(d.total) / (1024 * 1024 * 1024) : 0);
                                if (rawSize <= 0) return;
                                let cleanSize = Math.round(rawSize);
                                if (cleanSize <= 0 && rawSize > 0) cleanSize = 1;

                                if (isWin) {
                                    if (/^[A-Za-z]:/.test(mount)) {
                                        scoutTotal += cleanSize;
                                        validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                                    }
                                } else {
                                    if (!mount.startsWith('/dev') && !mount.startsWith('/proc') && !mount.startsWith('/sys') && !mount.startsWith('/run') && !mount.startsWith('/boot/efi')) {
                                        scoutTotal += cleanSize;
                                        validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                                    }
                                }
                            });
                            if (scoutTotal > 0 && Number(meta.diskGB) !== scoutTotal) {
                                meta.diskGB = scoutTotal;
                                meta.diskDetails = validDisks;
                                meta.diskUpdatedAt = new Date().toISOString();
                                metaChanged = true;
                            }
                        }
                    }
                } catch (e) {
                    console.error('[ServerList Sync-All] Scout Metric error for IP:', ip, e.message);
                }
            }

            if (metaChanged) {
                cmdbMeta[ip] = meta;
                updateCount++;
                
                // Add audit history for bulk update
                history.unshift({
                    id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
                    ip,
                    username: user,
                    action: 'Global Auto-Sync',
                    timestamp: new Date().toISOString()
                });
            }
        }

        if (updateCount > 0) {
            writeDataSync(CMDB_META_KEY, cmdbMeta);
            if (history.length > 2000) history.splice(2000);
            writeDataSync(CMDB_HISTORY_KEY, history);
            bulkUpsertCmdbServers(Object.entries(cmdbMeta).map(([ip, meta]) => ({ ip, ...meta })), 'SCANNER');
        }
        
        if (promUpdated) {
            await updateTargetsSafely((current) => {
                let changed = false;
                for (const t of current) {
                    let tip = t.ip || t.labels?.addr;
                    if (!tip && t.targets && t.targets[0]) tip = t.targets[0].split(':')[0];
                    const e = promEdits.get(String(tip).trim());
                    if (!e) continue;
                    if (e.applicationName) { t.applications = e.applicationName; if (t.labels) t.labels.application = e.applicationName; }
                    if (e.businessUnit) { t.bu = e.businessUnit; if (t.labels) t.labels.group = e.businessUnit; }
                    if (e.envStr) { t.zone = e.envStr; if (t.labels) t.labels.zone = e.envStr; }
                    changed = true;
                }
                return changed ? { targets: current } : null;
            }, 'cmdb_global_sync');
            const pCount = promModifiedList.length;
            if (pCount >= 10) {
                const samples = promModifiedList.slice(0, 5).map(p => `• ${p.ip} (${p.host})`).join('\n');
                sendTelegramAlert(
                    `🎯 [Prometheus Target Linkage - CMDB 全局同步 (壓縮訊息)]\nCMDB 全局同步已批量更新 ${pCount} 筆 Prometheus Target：\n\n📊 統計摘要：\n• 更新總數：${pCount} 筆 (達到 10 筆以上，啟用壓縮顯示)\n• 操作人員：${user}\n\n📋 抽樣清單 (前 5 筆)：\n${samples}\n... 及其他 ${pCount - 5} 筆 Target (完整紀錄請查閱審計日誌)\n\n• 觸發來源：CMDB Global Auto-Sync`,
                    'Prometheus'
                ).catch(err => console.error('[ServerList] Telegram alert error:', err.message));
            } else if (pCount === 1) {
                sendTelegramAlert(
                    `🎯 [Prometheus Target Linkage - CMDB 同步]\nCMDB 同步已更新 Prometheus Target：\n• IP: ${promModifiedList[0].ip} (${promModifiedList[0].host})\n• 操作人員：${user}\n• 觸發來源：CMDB Auto-Sync`,
                    'Prometheus'
                ).catch(err => console.error('[ServerList] Telegram alert error:', err.message));
            } else if (pCount > 1) {
                const list = promModifiedList.map(p => `• ${p.ip} (${p.host})`).join('\n');
                sendTelegramAlert(
                    `🎯 [Prometheus Target Linkage - CMDB 同步 (${pCount} 筆)]\nCMDB 同步已更新 ${pCount} 筆 Prometheus Target：\n${list}\n\n• 操作人員：${user}\n• 觸發來源：CMDB Auto-Sync`,
                    'Prometheus'
                ).catch(err => console.error('[ServerList] Telegram alert error:', err.message));
            }
        }
        if (ipamEdits.size > 0) {
            ipamStore.mutateSubnets((subnets) => {
                subnets.forEach(sub => {
                    if (!Array.isArray(sub.ips)) return;
                    sub.ips.forEach(rec => {
                        const e = ipamEdits.get(String(rec.address).trim());
                        if (!e) return;
                        if (e.applicationName && rec.service !== e.applicationName) rec.service = e.applicationName;
                        if (e.businessUnit && rec.owner !== e.businessUnit) { rec.owner = e.businessUnit; rec.assignedTo = e.businessUnit; }
                        if (e.fqdn && rec.fqdn !== e.fqdn) rec.fqdn = e.fqdn;
                    });
                });
            }, { username: user, reason: 'server list global sync' });
        }

        if (updateCount > 0) {
            auditLog(user, 'Server List', `Global Auto-Sync triggered. Updated ${updateCount} servers.`);
        }

        res.json({ success: true, count: updateCount });
    } catch (e) {
        console.error('[ServerList] Global Sync Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/server-list/cmdb-history/:ip
router.get('/cmdb-history/:ip', async (req, res) => {
    try {
        const ip = String(req.params.ip).trim();
        const history = readDataSync(CMDB_HISTORY_KEY, []);
        const serverHistory = history.filter(h => h.ip === ip);
        res.json({ history: serverHistory });
    } catch (e) {
        console.error('[ServerList] Fetch CMDB history error:', e);
        res.status(500).json({ error: 'Failed to fetch CMDB history' });
    }
});

/**
 * Environment fields of a Server List row. queryCmdbServers already derived envName from envId
 * (Unassigned + envUnmapped when unknown); colour: the entry's own colour, else red for production.
 * Never falls back to a hard-coded 'Production' / 'prod'.
 */
function envView(srv, environments) {
    const env = srv.envId ? environments.find(e => e.id === srv.envId) : null;
    if (!env) {
        return { envId: null, envName: envRegistry.UNASSIGNED, envColor: '#94a3b8', envIsProduction: false, envUnmapped: srv.envUnmapped || null };
    }
    return { envId: env.id, envName: env.name, envColor: env.color || (env.isProduction ? '#ef4444' : '#64748b'), envIsProduction: !!env.isProduction };
}

// Core helper: Fetch Full Enriched CMDB Dataset (50+ fields, Prometheus, Redis, Scout Telemetry)
function getEnrichedCmdbServersData(query = {}) {
    const { servers } = queryCmdbServers(query);

    const environments = envRegistry.getEnvironments();

    let scoutMetricsMap = {};
    let scoutAlertsMap = {};
    let scoutMonitorsMap = {};
    try {
        const scoutDb = require('../services/scoutDb');
        const monitors = scoutDb.all("SELECT id, name, ip, status, lastSeen, version FROM monitors") || [];
        monitors.forEach(m => {
            if (m.ip) scoutMonitorsMap[String(m.ip).trim()] = m;
        });
        const activeAlerts = scoutDb.all("SELECT monitorId, COUNT(*) as cnt FROM alerts WHERE resolved = 0 GROUP BY monitorId") || [];
        activeAlerts.forEach(a => { scoutAlertsMap[a.monitorId] = a.cnt; });

        const NOW = Date.now();
        monitors.forEach(m => {
            const row = scoutDb.get("SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            if (row && row.metrics) {
                const metricTime = row.timestamp ? new Date(row.timestamp).getTime() : 0;
                if (NOW - metricTime <= 5 * 60 * 1000) {
                    scoutMetricsMap[m.id] = parseJSON(row.metrics, null);
                }
            }
        });
    } catch (e) {
        console.error('[ServerList] Scout live metric read error:', e.message);
    }

    const promTargets = getTargetsSafely();
    const promMap = {};
    promTargets.forEach(pt => {
        let ip = pt.ip || pt.labels?.addr;
        let port = pt.port || 9100;
        if (!ip && Array.isArray(pt.targets) && pt.targets[0]) {
            const parts = pt.targets[0].split(':');
            ip = parts[0];
            if (parts[1]) port = parseInt(parts[1], 10);
        }
        if (ip) {
            const cleanIp = String(ip).trim();
            promMap[cleanIp] = {
                ...pt,
                ip: cleanIp,
                port,
                applications: pt.applications || pt.labels?.application || '',
                bu: pt.bu || pt.labels?.group || '',
                zone: pt.zone || pt.labels?.zone || ''
            };
        }
    });

    const redisConns = readDataSync(REDIS_KEY, []);
    const redisMap = {};
    redisConns.forEach(rc => {
        if (rc.host) {
            const ipKey = String(rc.host).trim();
            if (!redisMap[ipKey]) redisMap[ipKey] = [];
            redisMap[ipKey].push(rc);
        }
    });

    const NOW = Date.now();
    const inventory = getAllSubnetData() || [];
    const invMap = {};
    inventory.forEach(i => {
        if (i.ip) invMap[String(i.ip).trim()] = i;
    });

    const enriched = servers.map(srv => {
        const ipStr = srv.ip;
        const prom = promMap[ipStr];
        const prometheusStatus = prom ? 'scraped' : 'none';
        const isPrometheusScraped = !!prom;
        const exporterPort = prom ? (prom.port || 9100) : 9100;
        const metricsPath = prom ? (prom.metrics_path || '/metrics') : '/metrics';
        const prometheusJob = prom ? (prom.job || 'node_exporter') : 'node_exporter';

        const redisList = redisMap[ipStr] || [];
        const hasRedis = redisList.length > 0;

        let resolvedDisk = Number(srv.diskGB) || 0;
        let resolvedDiskDetails = Array.isArray(srv.diskDetails) ? srv.diskDetails : [];

        const scoutMon = scoutMonitorsMap[ipStr];
        let scoutStatus = 'not_installed';
        let scoutAlertsCount = 0;
        let realtimeCpu = 0;
        let realtimeMem = 0;
        let realtimeDisk = 0;
        let monitoredProcesses = [];

        if (scoutMon) {
            const lastSeenTime = scoutMon.lastSeen ? new Date(scoutMon.lastSeen).getTime() : 0;
            const isStale = (NOW - lastSeenTime) > 5 * 60 * 1000;
            scoutStatus = isStale ? 'offline' : (scoutMon.status || 'not_installed');
            scoutAlertsCount = scoutAlertsMap[scoutMon.id] || 0;

            const met = isStale ? null : scoutMetricsMap[scoutMon.id];
            if (met) {
                realtimeCpu = met.cpuUsage || met.cpu?.used || 0;
                realtimeMem = met.memUsage || met.memory?.used || 0;
                realtimeDisk = met.diskUsage || 0;
                if (Array.isArray(met.processes)) {
                    monitoredProcesses = met.processes.map(p => ({
                        name: p.name,
                        status: p.status,
                        cpu: p.cpuUsage,
                        memory: p.memoryMB
                    }));
                }

                const diskList = Array.isArray(met.disk) ? met.disk : (Array.isArray(met.disks) ? met.disks : []);
                if (diskList.length > 0) {
                    let scoutTotalDisk = 0;
                    const isWindows = String(srv.os || scoutMon.os || '').toLowerCase().includes('win');
                    const validDisks = [];
                    diskList.forEach(d => {
                        const mount = String(d.mount || '').trim();
                        const rawSize = Number(d.totalGB) || (d.total ? Number(d.total) / (1024 * 1024 * 1024) : 0);
                        if (rawSize <= 0) return;
                        let cleanSize = Math.round(rawSize);
                        if (cleanSize <= 0 && rawSize > 0) cleanSize = 1;
                        if (isWindows) {
                            if (/^[A-Za-z]:/.test(mount)) {
                                scoutTotalDisk += cleanSize;
                                validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                            }
                        } else {
                            if (!mount.startsWith('/dev') && !mount.startsWith('/proc') && !mount.startsWith('/sys') && !mount.startsWith('/run') && !mount.startsWith('/boot/efi')) {
                                scoutTotalDisk += cleanSize;
                                validDisks.push({ mount, totalGB: cleanSize, used: Math.round(Number(d.used) || 0) });
                            }
                        }
                    });
                    if (scoutTotalDisk > 0) {
                        resolvedDisk = scoutTotalDisk;
                        resolvedDiskDetails = validDisks;
                    }
                }
            }
        }

        const inv = invMap[ipStr];
        const resolvedCpu = srv.cpuCores > 0 ? srv.cpuCores : Number(inv?.cpu || inv?.cpuCores || 0);
        const resolvedRam = srv.memoryGB > 0 ? srv.memoryGB : Number(inv?.mem || inv?.memoryGB || 0);
        const resolvedOs = (srv.os && srv.os !== 'unknown') ? srv.os : (inv?.osname || inv?.os || scoutMon?.os || '');

        const ev = envView(srv, environments);

        return {
            ...srv,
            cpuCores: resolvedCpu,
            memoryGB: resolvedRam,
            diskGB: resolvedDisk,
            diskDetails: resolvedDiskDetails,
            os: resolvedOs,
            scoutStatus,
            scoutAlertsCount,
            realtimeCpu,
            realtimeMem,
            realtimeDisk,
            monitoredProcesses,
            prometheusStatus,
            isPrometheusScraped,
            exporterPort,
            metricsPath,
            prometheusJob,
            hasRedis,
            redisInstances: redisList.map(r => ({ name: r.name, port: r.port, mode: r.mode || 'standalone' })),
            ...ev,
            secondaryIps: Array.isArray(srv.secondaryIps) ? srv.secondaryIps : []
        };
    });

    enriched.sort((a, b) => compareIPs(a.ip, b.ip));
    return { servers: enriched, total: enriched.length, environments };
}

// Core helper: Fetch Slim Diff Comparison Dataset (+ VIP, iLO, CVM preserved)
function getDiffSlimServersData(query = {}) {
    const { servers } = queryCmdbServers(query);

    const environments = envRegistry.getEnvironments();

    const inventory = getAllSubnetData() || [];
    const invMap = {};
    inventory.forEach(i => {
        if (i.ip) invMap[String(i.ip).trim()] = i;
    });

    const slimServers = servers.map(srv => {
        const ipStr = srv.ip;
        const inv = invMap[ipStr];
        const resolvedCpu = srv.cpuCores > 0 ? srv.cpuCores : Number(inv?.cpu || inv?.cpuCores || 0);
        const resolvedRam = srv.memoryGB > 0 ? srv.memoryGB : Number(inv?.mem || inv?.memoryGB || 0);
        const resolvedOs = (srv.os && srv.os !== 'unknown') ? srv.os : (inv?.osname || inv?.os || '');

        const ev = envView(srv, environments);

        return {
            // 1. Diff Comparison core fields
            ip: srv.ip,
            hostname: srv.hostname,
            cpuCores: resolvedCpu,
            memoryGB: resolvedRam,
            diskGB: Number(srv.diskGB) || 0,
            diskDisplay: srv.diskDisplay || (srv.diskGB ? `${srv.diskGB}GB` : ''),
            diskDetails: Array.isArray(srv.diskDetails) ? srv.diskDetails : [],
            os: resolvedOs,
            ...ev,
            applicationName: srv.applicationName || '',
            businessUnit: srv.businessUnit || '',
            zone: srv.zone || srv.platform || 'Intranet',
            platform: srv.platform || srv.zone || 'Intranet',
            datacenterName: srv.datacenterName || '',
            rackId: srv.rackId || '',
            unitPosition: srv.unitPosition || '',

            // 2. Preserved VIP, iLO, CVM
            isVip: !!srv.isVip,
            linkedToIp: srv.linkedToIp || null,
            secondaryIps: Array.isArray(srv.secondaryIps) ? srv.secondaryIps : [],
            iloIp: srv.iloIp || null,
            cvmIp: srv.cvmIp || null,

            // 3. Metadata & Attributes
            status: srv.status || 'unknown',
            deviceType: srv.deviceType || 'Virtual Machine',
            source: srv.source || null,
            notes: srv.notes || '',
            tags: Array.isArray(srv.tags) ? srv.tags : (srv.tags ? [srv.tags] : []),
            createdAt: srv.createdAt,
            updatedAt: srv.updatedAt
        };
    });

    slimServers.sort((a, b) => compareIPs(a.ip, b.ip));
    return { servers: slimServers, total: slimServers.length, environments };
}

// GET /api/server-list (Slimmed down to Diff Comparison fields + VIP, iLO, CVM; supports ?mode=full for enriched telemetry)
router.get('/', async (req, res) => {
    try {
        if (req.query.mode === 'full' || req.query.full === 'true' || req.query.cmdb === 'true') {
            const data = getEnrichedCmdbServersData(req.query);
            return res.json(data);
        }
        const data = getDiffSlimServersData(req.query);
        res.json(data);
    } catch (e) {
        console.error('[ServerList] Slim query error:', e);
        res.status(500).json({ error: 'Failed to fetch Server List diff data' });
    }
});

// GET /api/server-list/cmdb-full & GET /api/server-list/cmdb-server-list (Comprehensive CMDB + Telemetry)
router.get(['/cmdb-full', '/cmdb-server-list', '/full'], async (req, res) => {
    try {
        const data = getEnrichedCmdbServersData(req.query);
        res.json(data);
    } catch (e) {
        console.error('[ServerList] Full CMDB query error:', e);
        res.status(500).json({ error: 'Failed to fetch Full CMDB Server List data' });
    }
});

// PUT /api/server-list/cmdb-meta/:ip (Single Update)
router.put('/cmdb-meta/:ip', async (req, res) => {
    try {
        const ip = String(req.params.ip).trim();
        const { applicationName, businessUnit, zone, fqdn, criticality, maintenanceWindow, envId, envName, purpose, os, cpuCores, memoryGB, arch, mac, vendor, sn, iloIp, cvmIp, datacenterName, rackId, unitPosition, deviceType } = req.body;

        if (!ip) {
            return res.status(400).json({ error: 'Invalid IP address' });
        }
        const envIn = resolveEnvInput(envId, envName);
        if (envIn.error) return res.status(400).json({ error: envIn.error });

        let cmdbMeta = readDataSync(CMDB_META_KEY, {});
        const oldData = cmdbMeta[ip] ? { ...cmdbMeta[ip] } : {};
        if (!cmdbMeta[ip]) cmdbMeta[ip] = {};
        // Manual add/edit is explicit intent to (re)create this server: clear the deleted flag
        const restored = clearDeletedFlag(cmdbMeta[ip], req.user?.username);

        if (applicationName !== undefined) cmdbMeta[ip].applicationName = applicationName;
        if (businessUnit !== undefined) cmdbMeta[ip].businessUnit = businessUnit;
        if (zone !== undefined) cmdbMeta[ip].zone = zone;
        if (fqdn !== undefined) cmdbMeta[ip].fqdn = fqdn;
        if (criticality !== undefined) cmdbMeta[ip].criticality = criticality;
        if (maintenanceWindow !== undefined) cmdbMeta[ip].maintenanceWindow = maintenanceWindow;
        // Stored as id (authoritative) + canonical name; an explicit empty value clears the assignment
        if (envIn.env) {
            cmdbMeta[ip].envId = envIn.env.id;
            cmdbMeta[ip].envName = envIn.env.name;
        } else if (!envIn.unchanged) {
            if (envId !== undefined) cmdbMeta[ip].envId = envId;
            if (envName !== undefined) cmdbMeta[ip].envName = envName;
        }
        if (purpose !== undefined) cmdbMeta[ip].purpose = purpose;
        if (os !== undefined) cmdbMeta[ip].os = os;
        if (cpuCores !== undefined) cmdbMeta[ip].cpuCores = cpuCores;
        if (memoryGB !== undefined) cmdbMeta[ip].memoryGB = memoryGB;
        if (arch !== undefined) cmdbMeta[ip].arch = arch;
        if (mac !== undefined) cmdbMeta[ip].mac = mac;
        if (vendor !== undefined) cmdbMeta[ip].vendor = vendor;
        if (sn !== undefined) cmdbMeta[ip].sn = sn;
        if (iloIp !== undefined) cmdbMeta[ip].iloIp = iloIp;
        if (cvmIp !== undefined) cmdbMeta[ip].cvmIp = cvmIp;
        if (datacenterName !== undefined) cmdbMeta[ip].datacenterName = datacenterName;
        if (rackId !== undefined) cmdbMeta[ip].rackId = rackId;
        if (unitPosition !== undefined) cmdbMeta[ip].unitPosition = unitPosition;
        if (deviceType !== undefined) cmdbMeta[ip].deviceType = deviceType;

        cmdbMeta[ip].updatedAt = new Date().toISOString();

        writeDataSync(CMDB_META_KEY, cmdbMeta);

        // Update materialized cmdb_servers table
        upsertCmdbServer({ ip, ...cmdbMeta[ip] }, 'MANUAL', { allowDeleted: restored });

        // Cross-module sync to IPAM & Prometheus
        syncCrossModules(ip, applicationName, businessUnit, fqdn, envIn.env ? envIn.env.id : undefined);

        // Record Audit History
        recordCmdbHistory(ip, req.user?.username || 'SYSTEM', restored ? 'RESTORE' : 'MANUAL_UPDATE', oldData, cmdbMeta[ip]);
        if (restored) auditLog(req.user?.username || 'SYSTEM', 'Server List CMDB', `Restored previously deleted server IP ${ip} (manual add/edit)`);

        // Audit Log if user manually updated hardware specs (CPU or RAM)
        if (cpuCores !== undefined || memoryGB !== undefined) {
            auditLog(
                req.user?.username || 'SYSTEM',
                'HARDWARE_SPECS_MANUAL_CHANGE',
                'ServerList',
                `User ${req.user?.username || 'SYSTEM'} manually updated hardware specs for IP ${ip}: CPU=${cpuCores || 'unchanged'}, RAM=${memoryGB || 'unchanged'}GB`
            );
        } else {
            auditLog(req.user?.username || 'SYSTEM', 'Server List CMDB', `Updated CMDB Metadata for IP: ${ip}`);
        }

        res.json({ success: true, ip, data: cmdbMeta[ip] });
    } catch (e) {
        console.error('[ServerList] Update CMDB meta error:', e);
        res.status(500).json({ error: 'Failed to update CMDB metadata' });
    }
});

// POST /api/server-list/bulk-cmdb-meta (Batch Update Multiple Selected Servers)
router.post('/bulk-cmdb-meta', async (req, res) => {
    try {
        const { ips, data } = req.body;

        if (!Array.isArray(ips) || ips.length === 0 || !data) {
            return res.status(400).json({ error: 'Missing ips array or update data' });
        }
        const envIn = resolveEnvInput(data.envId, data.envName);
        if (envIn.error) return res.status(400).json({ error: envIn.error });

        let cmdbMeta = readDataSync(CMDB_META_KEY, {});
        let updatedCount = 0;
        let skippedDeleted = 0;
        const bulkUpdateList = [];

        ips.forEach(rawIp => {
            const ip = String(rawIp).trim();
            if (!ip) return;
            // Bulk edit must never resurrect a deleted server
            if (cmdbMeta[ip] && cmdbMeta[ip].deleted === true) { skippedDeleted++; return; }

            const oldData = cmdbMeta[ip] ? { ...cmdbMeta[ip] } : {};
            if (!cmdbMeta[ip]) cmdbMeta[ip] = {};

            if (data.applicationName !== undefined && data.applicationName !== '') cmdbMeta[ip].applicationName = data.applicationName;
            if (data.businessUnit !== undefined && data.businessUnit !== '') cmdbMeta[ip].businessUnit = data.businessUnit;
            if (data.zone !== undefined && data.zone !== '') cmdbMeta[ip].zone = data.zone;
            if (envIn.env) {
                cmdbMeta[ip].envId = envIn.env.id;
                cmdbMeta[ip].envName = envIn.env.name;
            }
            if (data.criticality !== undefined && data.criticality !== '') cmdbMeta[ip].criticality = data.criticality;
            if (data.maintenanceWindow !== undefined && data.maintenanceWindow !== '') cmdbMeta[ip].maintenanceWindow = data.maintenanceWindow;
            if (data.purpose !== undefined && data.purpose !== '') cmdbMeta[ip].purpose = data.purpose;
            if (data.os !== undefined && data.os !== '') cmdbMeta[ip].os = data.os;
            if (data.cpuCores !== undefined && data.cpuCores !== '') cmdbMeta[ip].cpuCores = data.cpuCores;
            if (data.memoryGB !== undefined && data.memoryGB !== '') cmdbMeta[ip].memoryGB = data.memoryGB;
            if (data.arch !== undefined && data.arch !== '') cmdbMeta[ip].arch = data.arch;
            if (data.mac !== undefined && data.mac !== '') cmdbMeta[ip].mac = data.mac;
            if (data.vendor !== undefined && data.vendor !== '') cmdbMeta[ip].vendor = data.vendor;

            cmdbMeta[ip].updatedAt = new Date().toISOString();
            updatedCount++;
            bulkUpdateList.push({ ip, ...cmdbMeta[ip] });

            // Perform cross-module sync for each IP in bulk
            syncCrossModules(ip, data.applicationName, data.businessUnit, undefined, envIn.env ? envIn.env.id : undefined);

            // Record Audit History
            recordCmdbHistory(ip, req.user?.username || 'SYSTEM', 'BULK_UPDATE', oldData, cmdbMeta[ip]);

            // Audit Log if user manually updated hardware specs
            if (data.cpuCores !== undefined && data.cpuCores !== '' || data.memoryGB !== undefined && data.memoryGB !== '') {
                auditLog(
                    req.user?.username || 'SYSTEM',
                    'HARDWARE_SPECS_MANUAL_CHANGE',
                    'ServerList',
                    `User ${req.user?.username || 'SYSTEM'} bulk manually updated hardware specs for IP ${ip}: CPU=${data.cpuCores || 'unchanged'}, RAM=${data.memoryGB || 'unchanged'}GB`
                );
            }
        });

        writeDataSync(CMDB_META_KEY, cmdbMeta);
        if (bulkUpdateList.length > 0) {
            bulkUpsertCmdbServers(bulkUpdateList, 'MANUAL');
        }

        auditLog(req.user?.username || 'SYSTEM', 'Server List CMDB', `Bulk updated CMDB Metadata for ${updatedCount} servers`);

        res.json({ success: true, count: updatedCount, skipped: skippedDeleted });
    } catch (e) {
        console.error('[ServerList] Bulk CMDB meta error:', e);
        res.status(500).json({ error: 'Failed to bulk update CMDB metadata' });
    }
});

// --- Delete / restore -------------------------------------------------------

function parseCleanup(body) {
    const c = (body && typeof body.cleanup === 'object' && body.cleanup) || {};
    return { prometheus: c.prometheus === true, scoutHistory: c.scoutHistory === true, ruleBindings: c.ruleBindings === true };
}

function describeCleanup(c) {
    const on = [];
    if (c.prometheus) on.push('Prometheus targets');
    if (c.scoutHistory) on.push('Scout history');
    if (c.ruleBindings) on.push('rule bindings & maintenance windows');
    return on.length ? on.join(', ') : 'none';
}

/**
 * Always: flag deleted in CMDB meta, remove cmdb_servers row (+ linked VIPs), history entry, remove Scout monitor.
 * Optional (cleanup.*, default off): Prometheus targets, Scout history (background), rule bindings & windows.
 */
async function performServerDelete(ips, cleanup, username, historyAction) {
    const requested = serverDeletion.normalizeIps(ips);
    const cmdbMeta = readDataSync(CMDB_META_KEY, {});
    const nowIso = new Date().toISOString();
    // An IP that is not in Server List (or already deleted) gets no deleted meta entry and no side effects
    const list = requested.filter(ip => serverDeletion.serverExists(ip, cmdbMeta));
    const skipped = requested.filter(ip => !list.includes(ip));
    if (list.length === 0) return { count: 0, skipped, cleaned: {}, historyJob: null };

    // Resolve everything that depends on rows we are about to delete BEFORE deleting them
    const monitors = serverDeletion.getMonitorsByIps(list);
    const monitorIds = monitors.map(m => m.id);
    const allIps = new Set(list);

    list.forEach(ip => {
        const getLinkedVips = (i) => serverDeletion.getLinkedVips(i, cmdbMeta);
        getLinkedVips(ip).forEach(v => allIps.add(v.ip));
        const oldData = cmdbMeta[ip] ? { ...cmdbMeta[ip] } : {};
        if (!cmdbMeta[ip]) cmdbMeta[ip] = {};
        const row = getCmdbServerByIp(ip);
        if (!cmdbMeta[ip].hostname && row && row.hostname) cmdbMeta[ip].hostname = row.hostname;
        // Every name this server was known by (VM name, OS hostname, FQDN, Scout monitor name): an agent or scan
        // reporting any of them is the same server; only a name matching none of them means the IP was reused.
        const deletedNames = [...new Set([
            cmdbMeta[ip].hostname, row && row.hostname, row && row.vmName, row && row.fqdn, cmdbMeta[ip].vmName, cmdbMeta[ip].fqdn,
            ...monitors.filter(m => String(m.ip).trim() === ip).map(m => m.name)
        ].map(shortHostname).filter(Boolean))];
        cmdbMeta[ip].deletedNames = deletedNames;
        getLinkedVips(ip).forEach(v => {
            if (cmdbMeta[v.ip] && cmdbMeta[v.ip].deleted === true) { cmdbMeta[v.ip].deletedNames = deletedNames; cmdbMeta[v.ip].deletedReason = 'manual'; }
        });
        cmdbMeta[ip].deleted = true;
        cmdbMeta[ip].deletedAt = nowIso;
        cmdbMeta[ip].deletedBy = username;
        cmdbMeta[ip].deletedReason = 'manual';
        delete cmdbMeta[ip].restoredAt;
        delete cmdbMeta[ip].restoredBy;
        deleteCmdbServer(ip);
        recordCmdbHistory(ip, username, historyAction, oldData, { deleted: true, cleanup });
    });
    writeDataSync(CMDB_META_KEY, cmdbMeta);

    try {
        const scoutDb = require('../services/scoutDb');
        list.forEach(ip => scoutDb.run("DELETE FROM monitors WHERE ip = ?", [ip]));
    } catch (err) {
        console.error('[ServerList Delete] Scout monitor delete error:', err.message);
    }
    // Stop the ingestion fast-path from serving the removed monitors out of its cache
    try {
        const ingestion = require('../services/telemetryIngestionService');
        monitorIds.forEach(id => ingestion.invalidateCache(id));
    } catch (err) { /* ingestion not loaded */ }

    const cleaned = {};
    // Monitor-scoped rule exclusions are meaningless without their host: always removed (tag exclusions are kept)
    try {
        const n = require('../services/ruleExclusions').removeForMonitors(monitorIds);
        if (n > 0) cleaned.ruleExclusions = n;
    } catch (err) {
        console.error('[ServerList Delete] Rule exclusion cleanup error:', err.message);
    }
    if (cleanup.prometheus) {
        try {
            cleaned.prometheusTargets = await serverDeletion.removeFromPrometheus([...allIps]);
        } catch (err) {
            cleaned.prometheusError = err.message;
            console.error('[ServerList Delete] Prometheus cleanup error:', err.message);
        }
    }
    if (cleanup.ruleBindings) {
        try {
            const r = serverDeletion.removeRuleScoped(monitorIds);
            cleaned.ruleBindings = r.bindings;
            cleaned.maintenanceWindows = r.windows;
        } catch (err) {
            cleaned.ruleBindingsError = err.message;
            console.error('[ServerList Delete] Rule binding cleanup error:', err.message);
        }
    }

    const summary = list.length === 1 ? `Deleted server IP: ${list[0]}` : `Bulk deleted ${list.length} servers from Server List`;
    const parts = [`cleanup: ${describeCleanup(cleanup)}`];
    if (cleanup.prometheus) parts.push(cleaned.prometheusError ? `Prometheus FAILED (${cleaned.prometheusError})` : `${cleaned.prometheusTargets || 0} Prometheus target(s) removed`);
    if (cleanup.ruleBindings) parts.push(cleaned.ruleBindingsError ? `rule bindings FAILED (${cleaned.ruleBindingsError})` : `${cleaned.ruleBindings || 0} binding(s) and ${cleaned.maintenanceWindows || 0} maintenance window(s) removed`);
    if (cleaned.ruleExclusions) parts.push(`${cleaned.ruleExclusions} rule exclusion(s) of the deleted host(s) removed`);
    if (cleanup.scoutHistory) parts.push(`Scout history cleanup started for ${monitors.length} monitor(s)`);
    if (allIps.size > list.length) parts.push(`linked VIPs removed: ${[...allIps].filter(i => !list.includes(i)).join(', ')}`);
    auditLog(username, 'Server List CMDB', `${summary} (${parts.join('; ')})`);

    let historyJob = null;
    if (cleanup.scoutHistory) {
        historyJob = serverDeletion.startScoutHistoryCleanup(monitors, username);
    }
    return { count: list.length, skipped, cleaned, historyJob };
}

// POST /api/server-list/delete-preview { ips: [...] } - what a delete would touch (read-only)
router.post('/delete-preview', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { ips } = req.body || {};
        if (!Array.isArray(ips) || ips.length === 0) {
            return res.status(400).json({ error: 'Missing ips array' });
        }
        res.json({ success: true, previews: await serverDeletion.previewDelete(ips) });
    } catch (e) {
        console.error('[ServerList] Delete preview error:', e);
        res.status(500).json({ error: 'Failed to build delete preview' });
    }
});

// GET /api/server-list/deleted - servers flagged deleted (linked VIPs are not listed: they come back with their primary)
router.get('/deleted', (req, res) => {
    try {
        const meta = readDataSync(CMDB_META_KEY, {});
        const deleted = Object.entries(meta)
            .filter(([, m]) => m && m.deleted === true && !serverDeletion.isLinkedVipMeta(m))
            .map(([ip, m]) => ({ ip, hostname: m.hostname || '', deletedAt: m.deletedAt || null, deletedBy: m.deletedBy || '' }))
            .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
        res.json({ success: true, servers: deleted });
    } catch (e) {
        console.error('[ServerList] List deleted error:', e);
        res.status(500).json({ error: 'Failed to list deleted servers' });
    }
});

// POST /api/server-list/:ip/restore
router.post('/:ip/restore', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const ip = String(req.params.ip).trim();
        const username = req.user?.username || 'SYSTEM';
        const cmdbMeta = readDataSync(CMDB_META_KEY, {});
        if (!cmdbMeta[ip] || cmdbMeta[ip].deleted !== true || serverDeletion.isLinkedVipMeta(cmdbMeta[ip])) {
            return res.status(404).json({ error: 'No deleted server found for this IP' });
        }
        const oldData = { ...cmdbMeta[ip] };
        clearDeletedFlag(cmdbMeta[ip], username);
        cmdbMeta[ip].updatedAt = new Date().toISOString();
        writeDataSync(CMDB_META_KEY, cmdbMeta);
        upsertCmdbServer({ ip, ...cmdbMeta[ip] }, 'MANUAL', { allowDeleted: true });
        recordCmdbHistory(ip, username, 'RESTORE', oldData, cmdbMeta[ip]);
        auditLog(username, 'Server List CMDB', `Restored deleted server IP: ${ip}`);
        res.json({ success: true, ip });
    } catch (e) {
        console.error('[ServerList] Restore server error:', e);
        res.status(500).json({ error: 'Failed to restore server' });
    }
});

// DELETE /api/server-list/:ip (Delete single server from Server List)
router.delete('/:ip', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const ip = String(req.params.ip).trim();
        if (!ip) {
            return res.status(400).json({ error: 'Invalid IP address' });
        }
        const cleanup = parseCleanup(req.body);
        const result = await performServerDelete([ip], cleanup, req.user?.username || 'SYSTEM', 'DELETE');
        const body = { success: true, ip, deleted: result.count, cleaned: result.cleaned };
        if (result.historyJob) body.cleanup = 'started';
        res.json(body);
    } catch (e) {
        console.error('[ServerList] Delete server error:', e);
        res.status(500).json({ error: 'Failed to delete server' });
    }
});

// POST /api/server-list/bulk-delete (Bulk Delete multiple servers)
router.post('/bulk-delete', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { ips } = req.body || {};
        if (!Array.isArray(ips) || ips.length === 0) {
            return res.status(400).json({ error: 'Missing ips array' });
        }
        const cleanup = parseCleanup(req.body);
        const result = await performServerDelete(ips, cleanup, req.user?.username || 'SYSTEM', 'BULK_DELETE');
        const body = { success: true, count: result.count, skipped: result.skipped, cleaned: result.cleaned };
        if (result.historyJob) body.cleanup = 'started';
        res.json(body);
    } catch (e) {
        console.error('[ServerList] Bulk delete error:', e);
        res.status(500).json({ error: 'Failed to bulk delete servers' });
    }
});

// POST /api/server-list/link (Link a secondary IP / VIP to a primary host)
router.post('/link', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { primaryIp, secondaryIp } = req.body;
        if (!primaryIp || !secondaryIp) {
            return res.status(400).json({ error: 'Missing primaryIp or secondaryIp' });
        }
        const { linkVip } = require('../lib/vipLinkageHelper');
        const result = await linkVip(primaryIp, secondaryIp, req.user?.username || 'SYSTEM');
        res.json(result);
    } catch (e) {
        console.error('[ServerList Link Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/server-list/unlink (Unlink a previously linked VIP/secondary IP)
router.post('/unlink', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'Missing IP' });
        const { unlinkVip } = require('../lib/vipLinkageHelper');
        const result = await unlinkVip(ip, req.user?.username || 'SYSTEM');
        res.json(result);
    } catch (e) {
        console.error('[ServerList Unlink Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// Upsert / Register Cloned VMs into Server List CMDB
/** Environment cell of an Excel / clone row (Env, envName, environment, envId). */
const vmEnvValue = (vm) => vm.envId || vm.Env || vm.envName || vm.environment || '';

/**
 * Rows whose environment is not in the global list (id, name or code, case-insensitive).
 * Empty is allowed (keeps the server's current environment). Returns [{ index, ip, value, error }].
 */
function findUnknownVmEnvs(vms, envs) {
    const list = envs || envRegistry.getEnvironments();
    const out = [];
    (Array.isArray(vms) ? vms : []).forEach((vm, index) => {
        const value = vm ? String(vmEnvValue(vm)).trim() : '';
        if (!value || envRegistry.resolveEnv(value, list)) return;
        out.push({ index, ip: String((vm && (vm.IP || vm.ip)) || '').trim(), value, error: `Unknown environment "${value}". Allowed: ${envRegistry.allowedNames(list).join(', ')}` });
    });
    return out;
}

function upsertClonedVms(vms, operator = 'SYSTEM') {
    if (!Array.isArray(vms) || vms.length === 0) return { count: 0 };
    const environments = envRegistry.getEnvironments();
    let cmdbMeta = readDataSync(CMDB_META_KEY, {});
    let updatedCount = 0;
    const serverListToUpsert = [];

    vms.forEach(vm => {
        const ip = String(vm.IP || vm.ip || '').trim();
        const hostname = String(vm.Name || vm.VMName || vm.hostname || vm.name || '').trim();
        if (!ip) return;

        const totalDisk = (vm.DiskInfo?.Total !== undefined ? vm.DiskInfo.Total : (Number(vm.DiskInfo?.C || 0) + Number(vm.DiskInfo?.L || 0) + Number(vm.DiskInfo?.X || 0))) || Number(vm.diskGB || 0);
        const diskDisplay = vm.DiskInfo?.Display || vm.diskDisplay || (totalDisk ? `${totalDisk}GB` : '');
        const diskDetails = vm.DiskInfo?.Partitions || vm.DiskInfo?.Disks || vm.diskDetails || [];
        const oldData = cmdbMeta[ip] ? { ...cmdbMeta[ip] } : {};
        const wasDeleted = oldData.deleted === true;

        // Row value (validated by the callers) -> id + canonical name; empty / unknown keeps the current environment
        const rowEnv = envRegistry.resolveEnv(vmEnvValue(vm), environments);
        const envFields = rowEnv
            ? { envId: rowEnv.id, envName: rowEnv.name }
            : { envId: cmdbMeta[ip]?.envId || '', envName: cmdbMeta[ip]?.envName || '' };
        const zoneVal = vm.Zone || vm.zone || vm.Platform || vm.platform || cmdbMeta[ip]?.zone || '';
        const appVal = vm.Application || vm.applicationName || vm.application || cmdbMeta[ip]?.applicationName || '';
        const buVal = vm.BU || vm.businessUnit || vm.bu || cmdbMeta[ip]?.businessUnit || '';
        const osVal = vm.OS || vm.os || cmdbMeta[ip]?.os || '';
        const cpuVal = Number(vm.NumCore || vm.cpuCores || vm.cpu) || cmdbMeta[ip]?.cpuCores || 4;
        const ramVal = Number(vm.MemoryGB || vm.memoryGB || vm.ram || vm.ramGB) || cmdbMeta[ip]?.memoryGB || 8;

        const updatedServer = {
            ...cmdbMeta[ip],
            ip: ip,
            hostname: hostname,
            vmName: hostname,
            os: osVal,
            cpuCores: cpuVal,
            memoryGB: ramVal,
            diskGB: totalDisk || cmdbMeta[ip]?.diskGB || 0,
            diskDisplay: diskDisplay || cmdbMeta[ip]?.diskDisplay || '',
            diskDetails: diskDetails.length > 0 ? diskDetails : (cmdbMeta[ip]?.diskDetails || []),
            businessUnit: buVal,
            applicationName: appVal,
            ...envFields,
            zone: zoneVal,
            platform: zoneVal,
            datacenterName: zoneVal || cmdbMeta[ip]?.datacenterName || '',
            deviceType: 'Virtual Machine',
            status: 'online',
            deleted: wasDeleted && serverDeletion.isLinkedVipMeta(oldData),
            updatedAt: new Date().toISOString(),
            source: 'Excel Batch Sync / Nutanix'
        };
        if (wasDeleted && !updatedServer.deleted) {
            // Excel import is explicit intent to (re)create the server
            updatedServer.restoredAt = new Date().toISOString();
            updatedServer.restoredBy = operator;
            delete updatedServer.deletedAt;
            delete updatedServer.deletedBy;
            delete updatedServer.deletedNames;
        }

        cmdbMeta[ip] = updatedServer;
        // No environment in the row: the CMDB row keeps its own (possibly mapped) environment untouched
        if (rowEnv) {
            serverListToUpsert.push(updatedServer);
        } else {
            const noEnv = { ...updatedServer };
            delete noEnv.envId;
            delete noEnv.envName;
            serverListToUpsert.push(noEnv);
        }

        updatedCount++;
        syncCrossModules(ip, appVal, buVal, hostname, rowEnv ? rowEnv.id : undefined);
        recordCmdbHistory(ip, operator, (wasDeleted && !updatedServer.deleted) ? 'RESTORE' : 'EXCEL_SYNC_UPSERT', oldData, cmdbMeta[ip]);
    });

    writeDataSync(CMDB_META_KEY, cmdbMeta);
    if (serverListToUpsert.length > 0) {
        bulkUpsertCmdbServers(serverListToUpsert, 'EXCEL_SYNC');
    }
    auditLog(operator, 'Server List CMDB', `Auto-registered/updated ${updatedCount} VMs from Excel Batch Sync`);
    return { count: updatedCount };
}

// POST /api/server-list/upsert-vms
router.post('/upsert-vms', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { vms } = req.body;
        if (!Array.isArray(vms)) return res.status(400).json({ error: 'vms array required' });
        // Unknown environments reject their rows (never a silent default); the other rows are imported
        const rejected = findUnknownVmEnvs(vms);
        const bad = new Set(rejected.map(r => r.index));
        const accepted = vms.filter((_, i) => !bad.has(i));
        if (accepted.length === 0 && rejected.length > 0) {
            return res.status(400).json({ error: `All ${rejected.length} row(s) rejected: unknown environment`, rejected });
        }
        const result = upsertClonedVms(accepted, req.user?.username || 'SYSTEM');
        res.json({ success: true, count: result.count, rejected });
    } catch (e) {
        console.error('[ServerList Upsert VMs Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// Dedicated Router for GET /api/cmdb-server-list (Comprehensive Full CMDB & Telemetry)
const cmdbRouter = express.Router();
cmdbRouter.use(requireAuth);
cmdbRouter.use(checkFeature('serverList'));
cmdbRouter.get('/', async (req, res) => {
    try {
        const data = getEnrichedCmdbServersData(req.query);
        res.json(data);
    } catch (e) {
        console.error('[CMDB ServerList Full Query Error]', e);
        res.status(500).json({ error: 'Failed to fetch full CMDB server list' });
    }
});

router.cmdbRouter = cmdbRouter;
router.getEnrichedCmdbServersData = getEnrichedCmdbServersData;
router.getDiffSlimServersData = getDiffSlimServersData;
router.upsertClonedVms = upsertClonedVms;
router.findUnknownVmEnvs = findUnknownVmEnvs;
router.performServerDelete = performServerDelete;

module.exports = router;
