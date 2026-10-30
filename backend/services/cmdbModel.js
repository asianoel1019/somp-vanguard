const { db, readDataSync } = require('../lib/db');
const { replaceDocument } = require('../lib/docStore');
const envRegistry = require('../lib/environmentRegistry');

const CMDB_AUTHORITY_KEY = 'server_operation/cmdb_field_authority.json';
const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';
const PROMETHEUS_KEY = 'prometheus_targets.json';
const ENV_KEY = 'system/environments.json';
const DC_KEY = 'data_center/datacenters.json';

const DEFAULT_FIELD_AUTHORITY = {
    applicationName: { 
        policy: 'manual_first', 
        name: '應用程式 (Application)', 
        desc: '用戶填寫優先；空白時自動由 IPAM 或 Prometheus 填補' 
    },
    businessUnit: { 
        policy: 'manual_first', 
        name: '業務單位 (Business Unit / Owner)', 
        desc: '用戶填寫優先；空白時自動由 IPAM 填補' 
    },
    hostname: { 
        policy: 'manual_first', 
        name: '主機名稱 (Hostname)', 
        desc: '用戶填寫優先；空白時自動由 Discovery / 掃描填補' 
    },
    fqdn: { 
        policy: 'manual_first', 
        name: '網域名稱 (FQDN)', 
        desc: '用戶填寫優先；空白時自動由 IPAM 填補' 
    },
    os: { 
        policy: 'agent_first', 
        name: '作業系統 (OS & Version)', 
        desc: 'Scout Agent 優先；無 Agent 時採掃描探測值' 
    },
    cpuCores: { 
        policy: 'agent_first', 
        name: 'CPU 核心數 (CPU Cores)', 
        desc: 'Scout Agent 優先；無 Agent 時採掃描探測值' 
    },
    memoryGB: { 
        policy: 'agent_first', 
        name: '記憶體容量 (RAM GB)', 
        desc: 'Scout Agent 優先；無 Agent 時採掃描探測值' 
    },
    diskGB: { 
        policy: 'agent_first', 
        name: '磁碟容量 (Disk Total & Partitions)', 
        desc: 'Scout Agent 優先 (依實體/邏輯掛載分割區總量)' 
    },
    subnet: { 
        policy: 'ipam_only', 
        name: '網段與閘道 (Subnet & Gateway)', 
        desc: 'IPAM 專屬權威；僅接受 IPAM 模組指派' 
    },
    vlan: { 
        policy: 'ipam_only', 
        name: 'VLAN ID', 
        desc: 'IPAM 專屬權威；僅接受 IPAM 模組指派' 
    },
    rackLocation: { 
        policy: 'rack_only', 
        name: '實體機櫃位置 (Rack & U-Position)', 
        desc: '機房機櫃專屬權威；僅接受機櫃拓撲指派' 
    },
    notes: { 
        policy: 'manual_only', 
        name: '備註與標籤 (Notes & Tags)', 
        desc: '嚴格手動鎖定；完全不接受任何自動覆蓋' 
    }
};

/**
 * Initialize SQLite table for CMDB servers
 */
function initCmdbTable() {
    if (!db) return;
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS cmdb_servers (
                ip TEXT PRIMARY KEY,
                hostname TEXT,
                os TEXT,
                osVersion TEXT,
                arch TEXT,
                status TEXT DEFAULT 'unknown',
                powerState TEXT,
                vmName TEXT,
                cluster TEXT,
                hypervisorHost TEXT,
                cpuCores INTEGER DEFAULT 0,
                memoryGB INTEGER DEFAULT 0,
                diskGB INTEGER DEFAULT 0,
                diskDetails TEXT,
                diskDisplay TEXT,
                mac TEXT,
                vendor TEXT,
                sn TEXT,
                iloIp TEXT,
                cvmIp TEXT,
                fqdn TEXT,
                applicationName TEXT,
                businessUnit TEXT,
                envId TEXT,
                envName TEXT,
                zone TEXT,
                platform TEXT,
                datacenterId TEXT,
                datacenterName TEXT,
                rackId TEXT,
                unitPosition TEXT,
                subnetName TEXT,
                subnetCidr TEXT,
                vlanId TEXT,
                gateway TEXT,
                ipamStatus TEXT,
                criticality TEXT,
                maintenanceWindow TEXT,
                purpose TEXT,
                deviceType TEXT DEFAULT 'Virtual Machine',
                source TEXT,
                notes TEXT,
                tags TEXT,
                isVip INTEGER DEFAULT 0,
                isSecondary INTEGER DEFAULT 0,
                linkedToIp TEXT,
                secondaryIps TEXT,
                lifecycleStatus TEXT DEFAULT 'active',
                agentInstalled INTEGER DEFAULT 0,
                agentVersion TEXT,
                agentStatus TEXT,
                lastSeen TEXT,
                manualOverrides TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                lastDiscoveredAt DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Safe auto-migration for existing SQLite database tables
        const extraColumns = [
            { name: 'zone', type: 'TEXT' },
            { name: 'platform', type: 'TEXT' },
            { name: 'criticality', type: 'TEXT' },
            { name: 'maintenanceWindow', type: 'TEXT' },
            { name: 'purpose', type: 'TEXT' },
            { name: 'deviceType', type: "TEXT DEFAULT 'Virtual Machine'" },
            { name: 'diskDisplay', type: 'TEXT' },
            { name: 'source', type: 'TEXT' },
            // Global Environments: original stored text when it was resolved by code / id-like value (rollback, audit)
            { name: 'envRaw', type: 'TEXT' }
        ];
        extraColumns.forEach(col => {
            try {
                db.exec(`ALTER TABLE cmdb_servers ADD COLUMN ${col.name} ${col.type};`);
            } catch (e) {
                // Column already exists, ignore safely
            }
        });

        const indexes = [
            `CREATE INDEX IF NOT EXISTS idx_cmdb_hostname ON cmdb_servers(hostname);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_env ON cmdb_servers(envName, envId);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_envid ON cmdb_servers(envId);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_app ON cmdb_servers(applicationName);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_bu ON cmdb_servers(businessUnit);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_zone ON cmdb_servers(zone);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_status ON cmdb_servers(status);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_lifecycle ON cmdb_servers(lifecycleStatus);`,
            `CREATE INDEX IF NOT EXISTS idx_cmdb_is_sec ON cmdb_servers(isSecondary, isVip);`
        ];
        indexes.forEach(idxSql => {
            try {
                db.exec(idxSql);
            } catch (e) {}
        });
    } catch (e) {
        console.error('[CMDB] Error initializing cmdb_servers table:', e);
    }
}

/**
 * Get Field Authority configuration with fallback to defaults
 */
function getFieldAuthorityRules() {
    const saved = readDataSync(CMDB_AUTHORITY_KEY, null);
    if (!saved || typeof saved !== 'object') {
        return DEFAULT_FIELD_AUTHORITY;
    }
    const merged = { ...DEFAULT_FIELD_AUTHORITY };
    for (const [k, v] of Object.entries(saved)) {
        if (merged[k]) {
            merged[k] = { ...merged[k], ...v };
        } else {
            merged[k] = v;
        }
    }
    return merged;
}

/**
 * Save customized Field Authority rules
 */
function saveFieldAuthorityRules(rules) {
    // whole-document replacement (the validated rules object) under the shared document lock
    replaceDocument(CMDB_AUTHORITY_KEY, rules, { defaultValue: {}, fnName: 'cmdbModel.saveFieldAuthorityRules' });
    return getFieldAuthorityRules();
}

/**
 * Reset Field Authority rules to system defaults
 */
function resetFieldAuthorityRules() {
    replaceDocument(CMDB_AUTHORITY_KEY, JSON.parse(JSON.stringify(DEFAULT_FIELD_AUTHORITY)), { defaultValue: {}, fnName: 'cmdbModel.resetFieldAuthorityRules' });
    return DEFAULT_FIELD_AUTHORITY;
}

/**
 * Helper: Parse JSON string with safe fallback
 */
function safeJson(str, def = null) {
    if (!str) return def;
    if (typeof str === 'object') return str;
    try { return JSON.parse(str); } catch { return def; }
}

/**
 * Helper: Stringify object for SQLite text column
 */
function jsonString(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'string') return val;
    try { return JSON.stringify(val); } catch { return null; }
}

/**
 * Helper: Apply Field Authority rules when merging incoming server data into existing server row
 */
function mergeServerWithAuthority(existing, incoming, source, rules, envs) {
    const manualOverrides = safeJson(existing.manualOverrides, {}) || {};
    const result = { ...existing };
    const now = new Date().toISOString();

    function shouldUpdate(fieldKey, ruleKey, incomingVal) {
        if (incomingVal === undefined || incomingVal === null || incomingVal === '') return false;
        if (source === 'MANUAL' || source === 'EXCEL_SYNC') return true;

        const currentVal = existing[fieldKey];
        const rule = rules[ruleKey]?.policy || 'manual_first';
        const isManuallyOverridden = !!manualOverrides[fieldKey];

        if (rule === 'manual_only') return false;
        if (rule === 'manual_first') {
            if (isManuallyOverridden) return false;
            if (currentVal && String(currentVal).trim() !== '') return false;
            return true;
        }
        if (rule === 'agent_first') {
            if (source === 'SCOUT_AGENT') return true;
            if (!existing.agentInstalled && (source === 'SCANNER' || source === 'INVENTORY_SCAN')) {
                return !isManuallyOverridden;
            }
            return false;
        }
        if (rule === 'discovery_first') {
            if (isManuallyOverridden) return false;
            return true;
        }
        if (rule === 'ipam_only') return source === 'IPAM_SYNC';
        if (rule === 'rack_only') return source === 'RACK_SYNC';

        return !isManuallyOverridden;
    }

    if (source === 'MANUAL' || source === 'EXCEL_SYNC') {
        const editableFields = [
            'applicationName', 'businessUnit', 'hostname', 'vmName', 'fqdn', 'notes', 'tags',
            'envId', 'envName', 'datacenterId', 'datacenterName', 'isVip', 'linkedToIp',
            'os', 'osVersion', 'arch', 'cpuCores', 'memoryGB', 'diskGB', 'diskDisplay',
            'zone', 'platform', 'deviceType', 'status', 'criticality', 'maintenanceWindow', 'purpose', 'source'
        ];
        editableFields.forEach(f => {
            if (incoming[f] !== undefined && incoming[f] !== null && incoming[f] !== '') {
                if (f === 'cpuCores' || f === 'memoryGB' || f === 'diskGB') {
                    result[f] = parseInt(incoming[f], 10) || 0;
                } else {
                    result[f] = incoming[f];
                }
                manualOverrides[f] = true;
            }
        });
        if (incoming.diskDetails) {
            result.diskDetails = jsonString(incoming.diskDetails);
        }
    } else {
        if (shouldUpdate('applicationName', 'applicationName', incoming.applicationName)) result.applicationName = incoming.applicationName;
        if (shouldUpdate('businessUnit', 'businessUnit', incoming.businessUnit)) result.businessUnit = incoming.businessUnit;
        if (shouldUpdate('hostname', 'hostname', incoming.hostname)) result.hostname = incoming.hostname;
        if (shouldUpdate('fqdn', 'fqdn', incoming.fqdn)) result.fqdn = incoming.fqdn;
        if (shouldUpdate('os', 'os', incoming.os)) result.os = incoming.os;
        if (shouldUpdate('cpuCores', 'cpuCores', incoming.cpuCores)) result.cpuCores = parseInt(incoming.cpuCores, 10) || 0;
        if (shouldUpdate('memoryGB', 'memoryGB', incoming.memoryGB)) result.memoryGB = parseInt(incoming.memoryGB, 10) || 0;
        if (shouldUpdate('diskGB', 'diskGB', incoming.diskGB)) {
            result.diskGB = parseInt(incoming.diskGB, 10) || 0;
            if (incoming.diskDetails) result.diskDetails = jsonString(incoming.diskDetails);
            if (incoming.diskDisplay) result.diskDisplay = incoming.diskDisplay;
        }
        if (shouldUpdate('subnetName', 'subnet', incoming.subnetName)) result.subnetName = incoming.subnetName;
        if (shouldUpdate('subnetCidr', 'subnet', incoming.subnetCidr)) result.subnetCidr = incoming.subnetCidr;
        if (shouldUpdate('vlanId', 'vlan', incoming.vlanId)) result.vlanId = incoming.vlanId;
        if (shouldUpdate('gateway', 'subnet', incoming.gateway)) result.gateway = incoming.gateway;
        if (shouldUpdate('rackId', 'rackLocation', incoming.rackId)) result.rackId = incoming.rackId;
        if (shouldUpdate('unitPosition', 'rackLocation', incoming.unitPosition)) result.unitPosition = incoming.unitPosition;
        if (shouldUpdate('notes', 'notes', incoming.notes)) result.notes = incoming.notes;
        if (shouldUpdate('tags', 'notes', incoming.tags)) result.tags = incoming.tags;
    }

    if (source === 'SCOUT_AGENT') {
        result.agentInstalled = 1;
        if (incoming.agentVersion) result.agentVersion = incoming.agentVersion;
        if (incoming.agentStatus) result.agentStatus = incoming.agentStatus;
        if (incoming.lastSeen) result.lastSeen = incoming.lastSeen;
        if (incoming.status) result.status = incoming.status;
        if (incoming.diskDetails) result.diskDetails = jsonString(incoming.diskDetails);
        if (incoming.diskGB !== undefined && incoming.diskGB !== null && incoming.diskGB !== '') {
            result.diskGB = parseInt(incoming.diskGB, 10) || 0;
        }
        if (incoming.diskDisplay) result.diskDisplay = incoming.diskDisplay;
        if (incoming.cpuCores !== undefined && incoming.cpuCores !== null && incoming.cpuCores !== '') {
            result.cpuCores = parseInt(incoming.cpuCores, 10) || 0;
        }
        if (incoming.memoryGB !== undefined && incoming.memoryGB !== null && incoming.memoryGB !== '') {
            result.memoryGB = parseInt(incoming.memoryGB, 10) || 0;
        }
        if (incoming.os) result.os = incoming.os;
    }

    if (source === 'INVENTORY_SCAN' || source === 'SCANNER') {
        if (incoming.powerState) result.powerState = incoming.powerState;
        if (incoming.vmName) result.vmName = incoming.vmName;
        if (incoming.cluster) result.cluster = incoming.cluster;
        if (incoming.hypervisorHost) result.hypervisorHost = incoming.hypervisorHost;
        if (incoming.mac) result.mac = incoming.mac;
        if (incoming.vendor) result.vendor = incoming.vendor;
        if (incoming.sn) result.sn = incoming.sn;
        if (incoming.iloIp) result.iloIp = incoming.iloIp;
        if (incoming.cvmIp) result.cvmIp = incoming.cvmIp;
        if (incoming.status && !result.agentInstalled) result.status = incoming.status;
        result.lastDiscoveredAt = now;
        result.lifecycleStatus = 'active';
    }

    const resolvedLink = incoming.linkedToIp || incoming.linkedTo || incoming.vipOf;
    if (resolvedLink) {
        result.linkedToIp = String(resolvedLink).trim();
        result.isSecondary = 1;
        result.isVip = 1;
    } else {
        if (incoming.isVip !== undefined) result.isVip = incoming.isVip ? 1 : 0;
        if (incoming.isSecondary !== undefined) result.isSecondary = incoming.isSecondary ? 1 : 0;
        if (incoming.linkedToIp !== undefined) result.linkedToIp = incoming.linkedToIp || null;
    }
    if (incoming.secondaryIps !== undefined) result.secondaryIps = jsonString(incoming.secondaryIps);
    if (incoming.ipamStatus !== undefined) result.ipamStatus = incoming.ipamStatus;
    if (incoming.envId !== undefined && !isManuallyOverridden(manualOverrides, 'envId')) result.envId = incoming.envId;
    if (incoming.envName !== undefined && !isManuallyOverridden(manualOverrides, 'envName')) result.envName = incoming.envName;
    if (incoming.zone !== undefined && !isManuallyOverridden(manualOverrides, 'zone')) result.zone = incoming.zone;
    if (incoming.platform !== undefined && !isManuallyOverridden(manualOverrides, 'platform')) result.platform = incoming.platform;
    if (incoming.datacenterId !== undefined && !isManuallyOverridden(manualOverrides, 'datacenterId')) result.datacenterId = incoming.datacenterId;
    if (incoming.datacenterName !== undefined && !isManuallyOverridden(manualOverrides, 'datacenterName')) result.datacenterName = incoming.datacenterName;
    if (incoming.criticality !== undefined && !isManuallyOverridden(manualOverrides, 'criticality')) result.criticality = incoming.criticality;
    if (incoming.maintenanceWindow !== undefined && !isManuallyOverridden(manualOverrides, 'maintenanceWindow')) result.maintenanceWindow = incoming.maintenanceWindow;
    if (incoming.purpose !== undefined && !isManuallyOverridden(manualOverrides, 'purpose')) result.purpose = incoming.purpose;
    if (incoming.deviceType !== undefined && !isManuallyOverridden(manualOverrides, 'deviceType')) result.deviceType = incoming.deviceType;
    if (incoming.source !== undefined) result.source = incoming.source;

    applyEnvResolution(result, incoming, envs, existing, source);
    result.manualOverrides = jsonString(manualOverrides);
    result.updatedAt = now;
    return result;
}

const givenEnv = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * Global Environments: the stored envId is authoritative, envName is the display / rollback copy.
 * A value supplied by this write (id, name or code) wins; otherwise the row's own reference is re-resolved.
 * Unresolvable values are left untouched (they show as Unassigned and are listed as unmapped).
 */
function applyEnvResolution(result, incoming, envs, existing = null, source = '') {
    const list = Array.isArray(envs) ? envs : envRegistry.getEnvironments();
    const inId = givenEnv(incoming.envId) && result.envId === incoming.envId;
    const inName = givenEnv(incoming.envName) && result.envName === incoming.envName;
    let env = null;
    if (inId || inName) env = envRegistry.resolveRecordEnv(inId ? incoming.envId : null, inName ? incoming.envName : null, list);
    // An automatic source (scan, sync-all, ...) carrying an empty or unknown value never replaces a valid stored
    // envId (e.g. a value mapped in Settings -> Environments); only an explicit manual edit / Excel value may.
    const explicit = source === 'MANUAL' || source === 'EXCEL_SYNC';
    const stored = existing ? envRegistry.findById(existing.envId, list) : null;
    if (!env && stored && !explicit) env = stored;
    if (!env) env = envRegistry.resolveRecordEnv(result.envId, result.envName, list);
    if (env) {
        result.envId = env.id;
        result.envName = env.name;
    }
    return result;
}

/** Read-side display: name derived from the global list by envId; unknown -> Unassigned (+ envUnmapped raw value). */
function decorateEnv(server, envs) {
    if (!server) return server;
    const list = Array.isArray(envs) ? envs : envRegistry.getEnvironments();
    const d = envRegistry.displayForRecord(server.envId, server.envName, list);
    const out = { ...server, envId: d.envId, envName: d.envName, envIsProduction: d.isProduction };
    if (!d.assigned) out.envUnmapped = d.unmapped;
    return out;
}

function isManuallyOverridden(overrides, key) {
    return !!(overrides && overrides[key]);
}

/**
 * Fetch a single server by primary IP
 */
function getCmdbServerByIp(ip) {
    if (!db || !ip) return null;
    const cleanIp = String(ip).trim();
    try {
        const stmt = db.prepare('SELECT * FROM cmdb_servers WHERE ip = ?');
        const row = stmt.get(cleanIp);
        if (!row) return null;
        return formatServerRow(row);
    } catch (e) {
        console.error('[CMDB] getCmdbServerByIp error:', e);
        return null;
    }
}

/**
 * Format raw SQLite row into frontend-compatible object
 */
function formatServerRow(row) {
    if (!row) return null;
    return {
        ...row,
        zone: row.zone || row.platform || row.datacenterName || '',
        platform: row.platform || row.zone || '',
        datacenterName: row.datacenterName || row.zone || row.platform || '',
        criticality: row.criticality || '',
        maintenanceWindow: row.maintenanceWindow || '',
        purpose: row.purpose || '',
        deviceType: row.deviceType || 'Virtual Machine',
        diskDisplay: row.diskDisplay || '',
        source: row.source || '',
        diskDetails: safeJson(row.diskDetails, []),
        secondaryIps: safeJson(row.secondaryIps, []),
        manualOverrides: safeJson(row.manualOverrides, {}),
        isVip: !!row.isVip,
        isSecondary: !!row.isSecondary,
        agentInstalled: !!row.agentInstalled
    };
}

/**
 * Deleted-server guard. Server List delete only flags cmdbMeta[ip].deleted = true, so every
 * automatic writer (inventory scan, scout disk sync, global auto-sync, legacy migration) must skip
 * those IPs. Pass { allowDeleted: true } for an explicit user restore / re-create.
 */
function readDeletedMeta() {
    try {
        const meta = readDataSync(CMDB_META_KEY, {}) || {};
        return meta && typeof meta === 'object' ? meta : {};
    } catch (e) {
        return {};
    }
}

function isDeletedEntry(meta, ip) {
    return !!(meta && meta[ip] && meta[ip].deleted === true);
}

/** True when the IP is flagged deleted in the CMDB meta (Server List delete). */
function isServerDeleted(ip) {
    if (!ip) return false;
    return isDeletedEntry(readDeletedMeta(), String(ip).trim());
}

/** Short host name (before the first dot, lower case); '' for empty / "unknown". */
function shortHostname(h) {
    const n = String(h == null ? '' : h).trim().toLowerCase().split('.')[0];
    return n === 'unknown' ? '' : n;
}

function isLinkedVipEntry(m) {
    return !!(m && (m.linkedTo || m.vipOf || m.isVip));
}

/**
 * The IP of a deleted server is now announced by a host whose name matches NONE of the names the deleted
 * server was known by (meta[ip].deletedNames, recorded at delete time): it was reassigned to a new server.
 * Legacy deleted entries without deletedNames never auto-revive by hostname (restore them manually).
 */
function isIpReused(meta, ip, incomingHostname) {
    const incoming = shortHostname(incomingHostname);
    const names = meta[ip] && meta[ip].deletedNames;
    if (!incoming || !Array.isArray(names) || names.length === 0) return false;
    return !names.map(shortHostname).includes(incoming);
}

function appendHistory(ip, action, username, oldData, newData) {
    try {
        // atomic append through the CMDB store (web and worker both write the history)
        require('../lib/cmdbMetaStore').appendHistory({
            id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 4),
            ip, username, action, timestamp: new Date().toISOString(), oldData: oldData || {}, newData: newData || {}
        }, 500);
    } catch (e) { /* history is best effort */ }
}

/**
 * Clears the deleted flag because the IP was reused by a different host (history RESTORE_IP_REUSE).
 * `meta` is the caller's snapshot (kept consistent for its later decisions); the stored document is changed through
 * an atomic read-modify-write of the CURRENT meta, only when the entry is still flagged deleted there.
 */
function reviveForIpReuse(meta, ip, newHostname) {
    const nowIso = new Date().toISOString();
    const host = String(newHostname).trim();
    const revive = (m) => {
        m.deleted = false;
        m.restoredAt = nowIso;
        m.restoredBy = 'SYSTEM';
        m.hostname = host;
        delete m.deletedNames;
        delete m.deletedAt;
        delete m.deletedBy;
    };
    const old = { ...meta[ip] };
    revive(meta[ip]);
    const stored = require('../lib/cmdbMetaStore').mutateMeta((cur) => {
        if (!cur[ip] || cur[ip].deleted !== true) return null; // revived / changed meanwhile by another writer
        const before = { ...cur[ip] };
        revive(cur[ip]);
        return { old: before, entry: { ...cur[ip] } };
    }, { reason: 'IP reuse revive' });
    if (!stored) return;
    appendHistory(ip, 'RESTORE_IP_REUSE', 'SYSTEM', stored.old, stored.entry);
    console.log(`[CMDB] ${ip} is now used by ${newHostname} (was ${old.hostname}); treating as a new server`);
}

/** For callers that only know ip + hostname (agent registration). True when the flag was cleared. */
function reviveIfIpReused(ip, hostname) {
    const cleanIp = String(ip || '').trim();
    const meta = readDeletedMeta();
    if (!isDeletedEntry(meta, cleanIp) || isLinkedVipEntry(meta[cleanIp]) || !isIpReused(meta, cleanIp, hostname)) return false;
    reviveForIpReuse(meta, cleanIp, hostname);
    return true;
}

/** True when the item must not be written: its IP, or the primary it is linked to, is flagged deleted. */
function shouldSkipDeleted(meta, item) {
    const ip = String(item.ip).trim();
    if (isDeletedEntry(meta, ip)) {
        if (!isLinkedVipEntry(meta[ip]) && isIpReused(meta, ip, item.hostname)) {
            reviveForIpReuse(meta, ip, item.hostname);
            return false;
        }
        return true;
    }
    const link = item.linkedToIp || item.linkedTo || item.vipOf;
    if (link && isDeletedEntry(meta, String(link).trim())) return true;
    return false;
}

/**
 * Upsert a single server record
 */
function upsertCmdbServer(serverObj, source = 'MANUAL', options = {}) {
    if (!db || !serverObj || !serverObj.ip) return false;
    const cleanIp = String(serverObj.ip).trim();
    if (!options.allowDeleted && shouldSkipDeleted(readDeletedMeta(), serverObj)) {
        console.log(`[CMDB] upsertCmdbServer skipped deleted server ${cleanIp} (source ${source})`);
        return false;
    }
    const rules = getFieldAuthorityRules();
    const existing = getCmdbServerByIp(cleanIp) || { ip: cleanIp, createdAt: new Date().toISOString() };
    const merged = mergeServerWithAuthority(existing, serverObj, source, rules, envRegistry.getEnvironments());

    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO cmdb_servers (
                ip, hostname, os, osVersion, arch, status, powerState, vmName, cluster, hypervisorHost,
                cpuCores, memoryGB, diskGB, diskDetails, diskDisplay, mac, vendor, sn, iloIp, cvmIp, fqdn,
                applicationName, businessUnit, envId, envName, zone, platform, datacenterId, datacenterName,
                rackId, unitPosition, subnetName, subnetCidr, vlanId, gateway, ipamStatus,
                criticality, maintenanceWindow, purpose, deviceType, source,
                notes, tags, isVip, isSecondary, linkedToIp, secondaryIps, lifecycleStatus,
                agentInstalled, agentVersion, agentStatus, lastSeen, manualOverrides,
                createdAt, updatedAt, lastDiscoveredAt, envRaw
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
        `);

        stmt.run(
            merged.ip,
            merged.hostname ? String(merged.hostname) : null,
            merged.os ? String(merged.os) : null,
            merged.osVersion ? String(merged.osVersion) : null,
            merged.arch ? String(merged.arch) : null,
            merged.status ? String(merged.status) : 'unknown',
            merged.powerState ? String(merged.powerState) : null,
            merged.vmName ? String(merged.vmName) : null,
            merged.cluster ? String(merged.cluster) : null,
            merged.hypervisorHost ? String(merged.hypervisorHost) : null,
            Number(merged.cpuCores) || 0,
            Number(merged.memoryGB) || 0,
            Number(merged.diskGB) || 0,
            jsonString(merged.diskDetails),
            merged.diskDisplay ? String(merged.diskDisplay) : null,
            merged.mac ? String(merged.mac) : null,
            merged.vendor ? String(merged.vendor) : null,
            merged.sn ? String(merged.sn) : null,
            merged.iloIp ? String(merged.iloIp) : null,
            merged.cvmIp ? String(merged.cvmIp) : null,
            merged.fqdn ? String(merged.fqdn) : null,
            merged.applicationName ? String(merged.applicationName) : null,
            merged.businessUnit ? String(merged.businessUnit) : null,
            merged.envId ? String(merged.envId) : null,
            merged.envName ? String(merged.envName) : null,
            merged.zone ? String(merged.zone) : null,
            merged.platform ? String(merged.platform) : null,
            merged.datacenterId ? String(merged.datacenterId) : null,
            merged.datacenterName ? String(merged.datacenterName) : null,
            merged.rackId ? String(merged.rackId) : null,
            merged.unitPosition ? String(merged.unitPosition) : null,
            merged.subnetName ? String(merged.subnetName) : null,
            merged.subnetCidr ? String(merged.subnetCidr) : null,
            merged.vlanId ? String(merged.vlanId) : null,
            merged.gateway ? String(merged.gateway) : null,
            merged.ipamStatus ? String(merged.ipamStatus) : null,
            merged.criticality ? String(merged.criticality) : null,
            merged.maintenanceWindow ? String(merged.maintenanceWindow) : null,
            merged.purpose ? String(merged.purpose) : null,
            merged.deviceType ? String(merged.deviceType) : 'Virtual Machine',
            merged.source ? String(merged.source) : null,
            merged.notes ? String(merged.notes) : null,
            merged.tags ? String(merged.tags) : null,
            merged.isVip ? 1 : 0,
            merged.isSecondary ? 1 : 0,
            merged.linkedToIp ? String(merged.linkedToIp) : null,
            jsonString(merged.secondaryIps),
            merged.lifecycleStatus ? String(merged.lifecycleStatus) : 'active',
            merged.agentInstalled ? 1 : 0,
            merged.agentVersion ? String(merged.agentVersion) : null,
            merged.agentStatus ? String(merged.agentStatus) : null,
            merged.lastSeen ? String(merged.lastSeen) : null,
            jsonString(merged.manualOverrides),
            merged.createdAt ? String(merged.createdAt) : new Date().toISOString(),
            merged.updatedAt ? String(merged.updatedAt) : new Date().toISOString(),
            merged.lastDiscoveredAt ? String(merged.lastDiscoveredAt) : new Date().toISOString(),
            merged.envRaw ? String(merged.envRaw) : null
        );
        return true;
    } catch (e) {
        console.error(`[CMDB] upsertCmdbServer error for ${cleanIp}:`, e);
        return false;
    }
}

/**
 * Batch upsert multiple servers within a single SQLite transaction
 */
function bulkUpsertCmdbServers(serverList, source = 'SCANNER', options = {}) {
    if (!db || !Array.isArray(serverList) || serverList.length === 0) return 0;
    const rules = getFieldAuthorityRules();
    const envs = envRegistry.getEnvironments();
    const deletedMeta = options.allowDeleted ? null : readDeletedMeta();
    let updatedCount = 0;
    let skippedDeleted = 0;

    const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO cmdb_servers (
            ip, hostname, os, osVersion, arch, status, powerState, vmName, cluster, hypervisorHost,
            cpuCores, memoryGB, diskGB, diskDetails, diskDisplay, mac, vendor, sn, iloIp, cvmIp, fqdn,
            applicationName, businessUnit, envId, envName, zone, platform, datacenterId, datacenterName,
            rackId, unitPosition, subnetName, subnetCidr, vlanId, gateway, ipamStatus,
            criticality, maintenanceWindow, purpose, deviceType, source,
            notes, tags, isVip, isSecondary, linkedToIp, secondaryIps, lifecycleStatus,
            agentInstalled, agentVersion, agentStatus, lastSeen, manualOverrides,
            createdAt, updatedAt, lastDiscoveredAt, envRaw
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?
        )
    `);

    const selectStmt = db.prepare('SELECT * FROM cmdb_servers WHERE ip = ?');

    const executeBatch = () => {
        serverList.forEach(item => {
            if (!item || !item.ip) return;
            const cleanIp = String(item.ip).trim();
            if (deletedMeta && shouldSkipDeleted(deletedMeta, item)) {
                skippedDeleted++;
                return;
            }
            const rawRow = selectStmt.get(cleanIp);
            const existing = formatServerRow(rawRow) || { ip: cleanIp, createdAt: new Date().toISOString() };
            const merged = mergeServerWithAuthority(existing, item, source, rules, envs);

            upsertStmt.run(
                merged.ip,
                merged.hostname ? String(merged.hostname) : null,
                merged.os ? String(merged.os) : null,
                merged.osVersion ? String(merged.osVersion) : null,
                merged.arch ? String(merged.arch) : null,
                merged.status ? String(merged.status) : 'unknown',
                merged.powerState ? String(merged.powerState) : null,
                merged.vmName ? String(merged.vmName) : null,
                merged.cluster ? String(merged.cluster) : null,
                merged.hypervisorHost ? String(merged.hypervisorHost) : null,
                Number(merged.cpuCores) || 0,
                Number(merged.memoryGB) || 0,
                Number(merged.diskGB) || 0,
                jsonString(merged.diskDetails),
                merged.diskDisplay ? String(merged.diskDisplay) : null,
                merged.mac ? String(merged.mac) : null,
                merged.vendor ? String(merged.vendor) : null,
                merged.sn ? String(merged.sn) : null,
                merged.iloIp ? String(merged.iloIp) : null,
                merged.cvmIp ? String(merged.cvmIp) : null,
                merged.fqdn ? String(merged.fqdn) : null,
                merged.applicationName ? String(merged.applicationName) : null,
                merged.businessUnit ? String(merged.businessUnit) : null,
                merged.envId ? String(merged.envId) : null,
                merged.envName ? String(merged.envName) : null,
                merged.zone ? String(merged.zone) : null,
                merged.platform ? String(merged.platform) : null,
                merged.datacenterId ? String(merged.datacenterId) : null,
                merged.datacenterName ? String(merged.datacenterName) : null,
                merged.rackId ? String(merged.rackId) : null,
                merged.unitPosition ? String(merged.unitPosition) : null,
                merged.subnetName ? String(merged.subnetName) : null,
                merged.subnetCidr ? String(merged.subnetCidr) : null,
                merged.vlanId ? String(merged.vlanId) : null,
                merged.gateway ? String(merged.gateway) : null,
                merged.ipamStatus ? String(merged.ipamStatus) : null,
                merged.criticality ? String(merged.criticality) : null,
                merged.maintenanceWindow ? String(merged.maintenanceWindow) : null,
                merged.purpose ? String(merged.purpose) : null,
                merged.deviceType ? String(merged.deviceType) : 'Virtual Machine',
                merged.source ? String(merged.source) : null,
                merged.notes ? String(merged.notes) : null,
                merged.tags ? String(merged.tags) : null,
                merged.isVip ? 1 : 0,
                merged.isSecondary ? 1 : 0,
                merged.linkedToIp ? String(merged.linkedToIp) : null,
                jsonString(merged.secondaryIps),
                merged.lifecycleStatus ? String(merged.lifecycleStatus) : 'active',
                merged.agentInstalled ? 1 : 0,
                merged.agentVersion ? String(merged.agentVersion) : null,
                merged.agentStatus ? String(merged.agentStatus) : null,
                merged.lastSeen ? String(merged.lastSeen) : null,
                jsonString(merged.manualOverrides),
                merged.createdAt ? String(merged.createdAt) : new Date().toISOString(),
                merged.updatedAt ? String(merged.updatedAt) : new Date().toISOString(),
                merged.lastDiscoveredAt ? String(merged.lastDiscoveredAt) : new Date().toISOString(),
                merged.envRaw ? String(merged.envRaw) : null
            );
            updatedCount++;
        });
    };

    try {
        if (db.transaction) {
            db.transaction(executeBatch)();
        } else {
            db.exec('BEGIN TRANSACTION;');
            executeBatch();
            db.exec('COMMIT;');
        }
        if (skippedDeleted > 0) {
            console.log(`[CMDB] bulkUpsertCmdbServers skipped ${skippedDeleted} deleted server(s) (source ${source})`);
        }
        return updatedCount;
    } catch (e) {
        console.error('[CMDB] bulkUpsertCmdbServers transaction error:', e);
        try { db.exec('ROLLBACK;'); } catch {}
        return 0;
    }
}

/**
 * Reconcile discovered servers after a scan: active servers that were NOT seen online are marked "missing".
 * options.inScope(ip) restricts the check to addresses the scan actually covered (partial scans, aborted scans,
 * servers of other sources in other networks are never touched). Without inScope every active server is checked.
 * Returns the number of rows marked missing.
 */
function reconcileDiscoveredServers(discoveredIpsSet, options = {}) {
    if (!db || !(discoveredIpsSet instanceof Set)) return 0;
    const inScope = typeof options.inScope === 'function' ? options.inScope : null;
    let marked = 0;
    try {
        const stmt = db.prepare("SELECT ip, lifecycleStatus FROM cmdb_servers WHERE lifecycleStatus = 'active' AND isSecondary = 0");
        const rows = stmt.all();
        const updateStmt = db.prepare("UPDATE cmdb_servers SET lifecycleStatus = 'missing', updatedAt = CURRENT_TIMESTAMP WHERE ip = ?");

        rows.forEach(r => {
            if (inScope && !inScope(r.ip)) return;
            if (!discoveredIpsSet.has(r.ip)) {
                updateStmt.run(r.ip);
                marked++;
            }
        });
    } catch (e) {
        console.error('[CMDB] reconcileDiscoveredServers error:', e);
    }
    return marked;
}

/**
 * Fast query servers from cmdb_servers table
 */
function queryCmdbServers(filter = {}) {
    if (!db) return { total: 0, servers: [] };
    try {
        let sql = "SELECT * FROM cmdb_servers WHERE isSecondary = 0";
        const params = [];

        if (filter.ip) {
            sql += " AND (ip = ? OR ip LIKE ?)";
            params.push(filter.ip, `%${filter.ip}%`);
        }
        if (filter.keyword) {
            const kw = `%${filter.keyword}%`;
            sql += " AND (ip LIKE ? OR hostname LIKE ? OR vmName LIKE ? OR applicationName LIKE ? OR businessUnit LIKE ? OR notes LIKE ? OR tags LIKE ?)";
            params.push(kw, kw, kw, kw, kw, kw, kw);
        }
        const envs = envRegistry.getEnvironments();
        if (filter.env || filter.envId || filter.envName) {
            // Accept an id, name or code (case-insensitive) and filter by the resolved id; rows not yet
            // migrated (no valid envId) still match by name. An unknown value matches the raw stored text.
            const targetEnv = String(filter.env || filter.envId || filter.envName).trim();
            const env = envRegistry.resolveEnv(targetEnv, envs);
            if (env) {
                const ids = envs.map(e => e.id);
                // legacy rows match the name or the code (case-insensitive), the same rule as the display
                const terms = [...new Set([env.name, env.code].filter(Boolean).map(t => String(t).trim().toLowerCase()))];
                const inList = terms.map(() => '?').join(',');
                sql += ` AND (envId = ? OR ((envId IS NULL OR envId = '' OR envId NOT IN (${ids.map(() => '?').join(',')})) AND (LOWER(TRIM(envName)) IN (${inList}) OR LOWER(TRIM(envId)) IN (${inList}))))`;
                params.push(env.id, ...ids, ...terms, ...terms);
            } else {
                sql += " AND (LOWER(envName) = LOWER(?) OR envId = ?)";
                params.push(targetEnv, targetEnv);
            }
        }
        if (filter.datacenter) {
            sql += " AND (LOWER(datacenterName) = LOWER(?) OR datacenterId = ?)";
            params.push(filter.datacenter, filter.datacenter);
        }
        if (filter.bu) {
            sql += " AND LOWER(businessUnit) LIKE LOWER(?)";
            params.push(`%${filter.bu}%`);
        }
        if (filter.application) {
            sql += " AND LOWER(applicationName) LIKE LOWER(?)";
            params.push(`%${filter.application}%`);
        }
        if (filter.os) {
            sql += " AND LOWER(os) LIKE LOWER(?)";
            params.push(`%${filter.os}%`);
        }
        if (filter.status) {
            sql += " AND status = ?";
            params.push(filter.status);
        }
        if (filter.lifecycle) {
            sql += " AND lifecycleStatus = ?";
            params.push(filter.lifecycle);
        }
        if (filter.isVip !== undefined && filter.isVip !== null && filter.isVip !== '') {
            sql += " AND isVip = ?";
            params.push(filter.isVip === 'true' || filter.isVip === true || filter.isVip === 1 ? 1 : 0);
        }

        const countSql = sql.replace("SELECT *", "SELECT COUNT(*) as total");
        const total = db.prepare(countSql).get(...params)?.total || 0;

        const sortBy = filter.sortBy || 'ip';
        const sortOrder = (filter.sortOrder || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        sql += ` ORDER BY ${sortBy} ${sortOrder}`;

        if (filter.limit) {
            const limit = Math.min(Math.max(parseInt(filter.limit, 10) || 50, 1), 1000);
            const page = Math.max(parseInt(filter.page, 10) || 1, 1);
            const offset = (page - 1) * limit;
            sql += ` LIMIT ${limit} OFFSET ${offset}`;
        }

        const rows = db.prepare(sql).all(...params);
        return {
            total,
            servers: rows.map(r => decorateEnv(formatServerRow(r), envs))
        };
    } catch (e) {
        console.error('[CMDB] queryCmdbServers error:', e);
        return { total: 0, servers: [] };
    }
}

/**
 * Delete a server from CMDB
 */
function deleteCmdbServer(ip) {
    if (!db || !ip) return false;
    try {
        db.prepare('DELETE FROM cmdb_servers WHERE ip = ? OR linkedToIp = ?').run(ip, ip);
        return true;
    } catch (e) {
        console.error(`[CMDB] deleteCmdbServer error for ${ip}:`, e);
        return false;
    }
}

/**
 * Automated Migration: Ingest legacy JSON data into cmdb_servers if table is empty
 */
function autoMigrateLegacyCmdb() {
    if (!db) return;
    try {
        const count = db.prepare('SELECT COUNT(*) as count FROM cmdb_servers').get()?.count || 0;
        if (count > 0) {
            console.log(`[CMDB Migration] cmdb_servers table already contains ${count} records. Skipping initial migration.`);
            return;
        }

        console.log('[CMDB Migration] Starting zero-touch legacy data migration into cmdb_servers...');

        const cmdbMeta = readDataSync(CMDB_META_KEY, {});

        let inventory = [];
        try { inventory = require('./inventoryStore').getAllSubnetData() || []; } catch {}

        let scoutMonitors = [];
        let scoutMetricsMap = {};
        try {
            const scoutDb = require('./scoutDb');
            scoutMonitors = scoutDb.all("SELECT * FROM monitors WHERE ip IS NOT NULL AND ip != ''") || [];
            scoutMonitors.forEach(m => {
                const row = scoutDb.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
                if (row && row.metrics) {
                    try { scoutMetricsMap[m.id] = JSON.parse(row.metrics); } catch {}
                }
            });
        } catch {}

        const ipamSubnets = readDataSync(IPAM_KEY, []);
        const ipamMap = {};
        ipamSubnets.forEach(sub => {
            if (Array.isArray(sub.ips)) {
                sub.ips.forEach(rec => {
                    if (rec.address && rec.status !== 'free') {
                        ipamMap[String(rec.address).trim()] = {
                            subnetName: sub.name,
                            subnetCidr: sub.cidr,
                            vlanId: sub.vlanId || sub.vlan || '',
                            gateway: sub.gateway || '',
                            ipamStatus: rec.status,
                            service: rec.service || '',
                            owner: rec.owner || rec.assignedTo || '',
                            fqdn: rec.fqdn || '',
                            description: rec.description || ''
                        };
                    }
                });
            }
        });

        const environments = readDataSync(ENV_KEY, []);
        const envMap = {};
        environments.forEach(e => {
            if (e.id) envMap[e.id] = e.name;
            if (e.name) envMap[e.name.toLowerCase()] = e.name;
        });

        const serverMap = new Map();

        inventory.forEach(inv => {
            if (!inv || !inv.ip) return;
            const ip = String(inv.ip).trim();
            serverMap.set(ip, {
                ip,
                hostname: inv.hostname || '',
                os: inv.os || '',
                osVersion: inv.osVersion || '',
                arch: inv.arch || '',
                status: inv.status || 'running',
                cpuCores: parseInt(inv.cpuCores, 10) || 0,
                memoryGB: parseInt(inv.memoryGB, 10) || 0,
                diskGB: parseInt(inv.diskGB, 10) || 0,
                mac: inv.mac || '',
                vendor: inv.vendor || '',
                sn: inv.sn || '',
                powerState: inv.powerState || 'ON',
                vmName: inv.vmName || '',
                cluster: inv.cluster || '',
                hypervisorHost: inv.hypervisorHost || '',
                isSecondary: inv.linkedTo ? 1 : 0,
                linkedToIp: inv.linkedTo || null
            });
        });

        scoutMonitors.forEach(m => {
            const ip = String(m.ip).trim();
            if (!ip) return;
            const met = scoutMetricsMap[m.id];
            const existing = serverMap.get(ip) || { ip, status: m.status };
            existing.hostname = existing.hostname || m.name;
            existing.os = m.os || existing.os;
            existing.agentInstalled = 1;
            existing.agentVersion = m.version || '';
            existing.agentStatus = m.status || '';
            existing.lastSeen = m.lastSeen || '';
            if (met) {
                if (met.cpu && met.cpu.cores) existing.cpuCores = met.cpu.cores;
                if (met.memory && met.memory.totalGB) existing.memoryGB = Math.round(met.memory.totalGB);
                if (met.disk) {
                    existing.diskDetails = met.disk;
                    const total = met.disk.reduce((acc, d) => acc + (Number(d.totalGB) || 0), 0);
                    if (total > 0) existing.diskGB = Math.round(total);
                }
            }
            serverMap.set(ip, existing);
        });

        Object.entries(cmdbMeta).forEach(([ip, meta]) => {
            if (!ip || !meta) return;
            const cleanIp = String(ip).trim();
            const existing = serverMap.get(cleanIp) || { ip: cleanIp };

            if (meta.hostname) existing.hostname = meta.hostname;
            if (meta.os) existing.os = meta.os;
            if (meta.applicationName) existing.applicationName = meta.applicationName;
            if (meta.businessUnit) existing.businessUnit = meta.businessUnit;
            if (meta.fqdn) existing.fqdn = meta.fqdn;
            if (meta.envId) {
                existing.envId = meta.envId;
                existing.envName = envMap[meta.envId] || meta.envName || '';
            }
            if (meta.datacenterId) existing.datacenterId = meta.datacenterId;
            if (meta.datacenterName) existing.datacenterName = meta.datacenterName;
            if (meta.notes) existing.notes = meta.notes;
            if (meta.tags) existing.tags = Array.isArray(meta.tags) ? meta.tags.join(',') : meta.tags;
            if (meta.diskGB) existing.diskGB = parseInt(meta.diskGB, 10);
            if (meta.diskDetails) existing.diskDetails = meta.diskDetails;
            if (meta.isVip) existing.isVip = 1;
            if (meta.linkedTo || meta.vipOf) {
                existing.isSecondary = 1;
                existing.linkedToIp = meta.linkedTo || meta.vipOf;
            }

            existing.manualOverrides = {
                applicationName: !!meta.applicationName,
                businessUnit: !!meta.businessUnit,
                hostname: !!meta.hostname,
                fqdn: !!meta.fqdn,
                notes: !!meta.notes
            };

            serverMap.set(cleanIp, existing);
        });

        Object.entries(ipamMap).forEach(([ip, ipam]) => {
            const existing = serverMap.get(ip) || { ip };
            existing.subnetName = ipam.subnetName;
            existing.subnetCidr = ipam.subnetCidr;
            existing.vlanId = ipam.vlanId;
            existing.gateway = ipam.gateway;
            existing.ipamStatus = ipam.ipamStatus;
            if (!existing.applicationName && ipam.service) existing.applicationName = ipam.service;
            if (!existing.businessUnit && ipam.owner) existing.businessUnit = ipam.owner;
            if (!existing.fqdn && ipam.fqdn) existing.fqdn = ipam.fqdn;
            serverMap.set(ip, existing);
        });

        const allServers = Array.from(serverMap.values());
        const inserted = bulkUpsertCmdbServers(allServers, 'MANUAL');
        console.log(`[CMDB Migration] Successfully migrated ${inserted} servers into cmdb_servers SQLite table!`);
    } catch (e) {
        console.error('[CMDB Migration] Fatal error during legacy migration:', e);
    }
}

initCmdbTable();

module.exports = {
    initCmdbTable,
    autoMigrateLegacyCmdb,
    getFieldAuthorityRules,
    saveFieldAuthorityRules,
    resetFieldAuthorityRules,
    getCmdbServerByIp,
    upsertCmdbServer,
    bulkUpsertCmdbServers,
    reconcileDiscoveredServers,
    queryCmdbServers,
    deleteCmdbServer,
    isServerDeleted,
    readDeletedMeta,
    shouldSkipDeleted,
    isIpReused,
    shortHostname,
    reviveIfIpReused,
    applyEnvResolution,
    decorateEnv
};
