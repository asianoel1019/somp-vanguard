const path = require('path');
const { defaultEnvFields, getEnvironments, getDefaultEnv, resolveRecordEnv } = require('../lib/environmentRegistry');
const { auditLog, sendTelegramAlert, queueNotification, summarizeLines } = require('../lib/logger');
const { checkTcpPort, probeTcpPorts, icmpCheckMany, runPool } = require('../lib/netProbe');
const { runPowerShell, ENV_CREDENTIAL_HEADER, buildCredentialEnv } = require('../lib/powershell');
const { assertIpv4, parseSubnetEntry, validateInventoryConfig, resolveProbeSettings, findSubnetSettings, legacyOffsetFor, escapeHtml } = require('../lib/inventoryValidation');
const { executeSSH } = require('../lib/ssh');
const { sendMail } = require('../lib/mailer');
const inventoryHistory = require('./inventoryHistory');
const { resolveCredentials } = require('../lib/inventoryCredentials');
const { mapInventoryHostToCmdb } = require('./inventoryCmdbMap');

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const SAVE_DIR = path.join(BASE_DATA_DIR, 'server_operation', 'oscheck');
const CONFIG_FILE = path.join(SAVE_DIR, 'config.json');



const scanStatus = {
    running: false,
    currentIp: '',
    activeSubnets: [],
    processedIps: 0,
    totalSubnets: 0,
    totalIps: 0,
    discovered: 0,
    startTime: null,
    logs: [],
    abortRequested: false,
    runId: null,
    trigger: null,
    requestedBy: null,
    scope: null,
    subnetProgress: {},
    degradedSubnets: []
};

const { createStatusWriter, readStatus: readSharedStatus, isStatusRunning, HEARTBEAT_MS } = require('./inventoryStatus');
const statusWriter = createStatusWriter();
let lastProgressWrite = 0;
const PROGRESS_WRITE_INTERVAL_MS = 2000;

function snapshotProgress() {
    return {
        currentIp: scanStatus.currentIp,
        activeSubnets: [...scanStatus.activeSubnets],
        processedIps: scanStatus.processedIps,
        totalIps: scanStatus.totalIps,
        totalSubnets: scanStatus.totalSubnets,
        discovered: scanStatus.discovered,
        abortRequested: scanStatus.abortRequested,
        degraded: scanStatus.degradedSubnets.length > 0,
        degradedSubnets: scanStatus.degradedSubnets.map(d => ({ ...d })),
        subnets: Object.entries(scanStatus.subnetProgress).map(([subnet, p]) => ({ subnet, ...p })),
        logs: scanStatus.logs.slice(-30)
    };
}

/** Publishes progress to the shared status document (throttled; never throws, never blocks the scan). */
function persistProgress(force = false) {
    if (!scanStatus.running) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return;
    lastProgressWrite = nowMs;
    statusWriter.update(snapshotProgress());
}

function scanLog(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    scanStatus.logs.push(entry);
    if (scanStatus.logs.length > 100) scanStatus.logs = scanStatus.logs.slice(-80);
    console.log(`[Inventory] ${msg}`);
}

const { readDataSync, writeDataSync } = require('../lib/db');
const scoutDb = require('./scoutDb');
const { updateTargetsSafely } = require('../lib/prometheusTargetHelper');
const { isIpVip, buildVipSet, reconcileAllLinkedVips, removeIpFromPrometheusTargets } = require('../lib/vipLinkageHelper');
const { readDeletedMeta, shouldSkipDeleted, getCmdbServerByIp } = require('./cmdbModel');

// Prometheus Alert Aggregator for Server Inventory
let pendingPrometheusAlerts = {
    adds: [],
    deletes: []
};
let promAlertTimer = null;

function queuePrometheusAlert(type, item) {
    if (type === 'add') {
        pendingPrometheusAlerts.adds.push(item);
    } else if (type === 'delete') {
        pendingPrometheusAlerts.deletes.push(item);
    }

    if (!promAlertTimer) {
        promAlertTimer = setTimeout(() => {
            promAlertTimer = null;
            flushPrometheusAlerts().catch(err => {
                console.error('[Inventory] Error flushing Prometheus Telegram alerts:', err.message);
            });
        }, 3000);
    }
}

async function flushPrometheusAlerts() {
    if (promAlertTimer) {
        clearTimeout(promAlertTimer);
        promAlertTimer = null;
    }

    const adds = [...pendingPrometheusAlerts.adds];
    const deletes = [...pendingPrometheusAlerts.deletes];
    pendingPrometheusAlerts.adds = [];
    pendingPrometheusAlerts.deletes = [];

    // Process Adds
    if (adds.length > 0) {
        try {
            if (adds.length >= 10) {
                // Compressed message format for >= 10 changes
                const linuxCount = adds.filter(a => a.targetOs === 'linux').length;
                const winCount = adds.filter(a => a.targetOs === 'win').length;
                const sampleLines = adds.slice(0, 5).map(a => `• ${a.ip} (${a.hostname || a.ip}) [${a.targetOs.toUpperCase()}:${a.port}]`).join('\n');
                const remaining = adds.length - 5;

                const msg = [
                    `🎯 [Prometheus Target Linkage - 批量新增 (壓縮訊息)]`,
                    `Server Inventory 批量註冊了 ${adds.length} 筆 Target 至 Prometheus：\n`,
                    `📊 統計摘要：`,
                    `• 總變更筆數：${adds.length} 筆 (達到 10 筆以上，啟用壓縮顯示)`,
                    `• 系統分佈：Linux ${linuxCount} 台 (:9100) / Windows ${winCount} 台 (:9182)\n`,
                    `📋 抽樣清單 (前 5 筆)：`,
                    sampleLines,
                    `... 及其他 ${remaining} 台主機 (完整清單請查閱審計日誌與 Prometheus)`,
                    `\n• 觸發來源：Subnet Auto-Discovery`
                ].join('\n');

                await sendTelegramAlert(msg, 'Prometheus');
            } else if (adds.length === 1) {
                const a = adds[0];
                const msg = `🎯 [Prometheus Target Linkage]\nServer Inventory has registered a new target to Prometheus:\n• Host: ${a.hostname || a.ip}\n• IP: ${a.ip}\n• Exporter: ${a.targetOs.toUpperCase()} (Port ${a.port})\n• Source: Subnet Auto-Discovery`;
                await sendTelegramAlert(msg, 'Prometheus');
            } else {
                // 2 to 9 items: grouped list
                const list = adds.map(a => `• ${a.ip} (${a.hostname || a.ip}) [${a.targetOs.toUpperCase()}:${a.port}]`).join('\n');
                const msg = `🎯 [Prometheus Target Linkage - 批量新增 (${adds.length} 筆)]\nServer Inventory 已自動註冊 ${adds.length} 筆 Target 至 Prometheus：\n${list}\n\n• 觸發來源：Subnet Auto-Discovery`;
                await sendTelegramAlert(msg, 'Prometheus');
            }
        } catch (err) {
            console.error('[Inventory] Failed to send Prometheus add alert:', err.message);
        }
    }

    // Process Deletes
    if (deletes.length > 0) {
        try {
            if (deletes.length >= 10) {
                // Compressed message format for >= 10 deletes
                const sampleLines = deletes.slice(0, 5).map(d => `• ${d.ip} (操作人: ${d.operator || 'System'})`).join('\n');
                const remaining = deletes.length - 5;
                const msg = [
                    `🗑️ [Prometheus Target Linkage - 批量移除 (壓縮訊息)]`,
                    `Server Inventory 批量自 Prometheus 移除 ${deletes.length} 筆 Target：\n`,
                    `📊 統計摘要：`,
                    `• 總移除筆數：${deletes.length} 筆 (達到 10 筆以上，啟用壓縮顯示)`,
                    `• 操作人員：${deletes[0]?.operator || 'System'}\n`,
                    `📋 抽樣清單 (前 5 筆)：`,
                    sampleLines,
                    `... 及其他 ${remaining} 筆 Target (完整清單請查閱審計日誌)`
                ].join('\n');

                await sendTelegramAlert(msg, 'Prometheus');
            } else if (deletes.length === 1) {
                const d = deletes[0];
                const msg = `🗑️ [Prometheus Target Linkage]\nServer Inventory permanently deleted target from Prometheus:\n• IP: ${d.ip}\n• Operator: ${d.operator || 'System'}`;
                await sendTelegramAlert(msg, 'Prometheus');
            } else {
                const list = deletes.map(d => `• ${d.ip}`).join('\n');
                const msg = `🗑️ [Prometheus Target Linkage - 批量移除 (${deletes.length} 筆)]\nServer Inventory 已自 Prometheus 移除 ${deletes.length} 筆 Target：\n${list}\n\n• 操作人員：${deletes[0]?.operator || 'System'}`;
                await sendTelegramAlert(msg, 'Prometheus');
            }
        } catch (err) {
            console.error('[Inventory] Failed to send Prometheus delete alert:', err.message);
        }
    }
}

/** Exporter (OS family + port) for a host OS string, or null when the OS is not win/linux. */
function resolveExporter(os) {
    const osLower = String(os || '').toLowerCase();
    if (osLower.includes('win')) return { targetOs: 'win', port: 9182 };
    if (['linux', 'ubuntu', 'centos', 'debian', 'redhat', 'rocky', 'alma', 'fedora'].some(k => osLower.includes(k))) {
        return { targetOs: 'linux', port: 9100 };
    }
    return null;
}

function targetMentionsIp(t, ip) {
    if (!t) return false;
    const labelAddr = t.labels?.addr;
    if (labelAddr && String(labelAddr).trim() === ip) return true;
    if (Array.isArray(t.targets)) return t.targets.some(tgt => String(tgt).split(':')[0].trim() === ip);
    return false;
}

/**
 * Registers discovered hosts in Prometheus with ONE atomic read-modify-write (one backup, one save), no matter how
 * many hosts: a concurrent writer (UI, VIP link, delete) can never lose or be overwritten by these additions.
 * Hosts that are already present, or whose server was deleted in Server List (unless the IP was reused by a
 * different host name), are skipped at apply time. Returns the items that were really added.
 */
async function applyPrometheusAdditions(items, { source = 'inventory_auto_sync' } = {}) {
    const wanted = Array.isArray(items) ? items.filter(i => i && i.ip) : [];
    if (wanted.length === 0) return [];
    const added = [];
    try {
        // Deleted / IP-reuse decisions are made HERE with a fresh read at decision time (a revive writes the whole meta
        // document, so it must never be handed a stale copy) and outside the Prometheus mutator, which only edits targets.
        const meta0 = readDeletedMeta();
        const allowed = wanted.filter(item => {
            const flagged = meta0[item.ip] && meta0[item.ip].deleted === true;
            if (!flagged) return true;
            // raw probed hostname only: unknown ('') is never an IP reuse, the server stays deleted
            return !shouldSkipDeleted(readDeletedMeta(), { ip: item.ip, hostname: item.probedHostname || '' });
        });
        if (allowed.length === 0) return [];
        // zone label = the server's CMDB environment (canonical NAME), else the isDefault environment; never '-'
        const envList = getEnvironments();
        const fallbackZone = (getDefaultEnv(envList) || {}).name || '-';
        const zoneOf = (ip) => {
            let row = null;
            try { row = getCmdbServerByIp(ip); } catch (_) { row = null; }
            const env = row ? resolveRecordEnv(row.envId, row.envName, envList) : null;
            return env ? env.name : fallbackZone;
        };
        const zones = new Map(allowed.map(item => [item.ip, zoneOf(item.ip)]));
        await updateTargetsSafely((targets) => {
            const next = [...targets];
            for (const item of allowed) {
                if (next.some(t => targetMentionsIp(t, item.ip))) continue;
                next.push({
                    targets: [`${item.ip}:${item.port}`],
                    labels: {
                        zone: zones.get(item.ip),
                        host: item.hostname || item.ip,
                        application: 'Auto-Discovered',
                        addr: item.ip,
                        group: 'Inventory'
                    }
                });
                added.push(item);
            }
            return added.length ? { targets: next, result: added.length } : { result: 0 };
        }, source);
    } catch (err) {
        added.length = 0;
        scanLog(`[Linkage] Circuit breaker protected Prometheus Targets from sync error (${wanted.length} host(s)): ${err.message}`);
        return added;
    }
    for (const item of added) {
        const targetDesc = `${item.ip} (${item.hostname || item.ip}) [${item.targetOs.toUpperCase()} :${item.port}]`;
        const logMsg = `[Linkage] Auto-synced ${targetDesc} to Prometheus Targets`;
        scanLog(logMsg);
        auditLog('System', 'Prometheus', logMsg);
        queuePrometheusAlert('add', { ip: item.ip, hostname: item.hostname || item.ip, targetOs: item.targetOs, port: item.port });
    }
    return added;
}

/**
 * Auto-syncs a discovered host or Scout Agent host to Prometheus Targets (scan and telemetry callers).
 * Skips: auto-sync disabled in the inventory config, VIPs (and purges them), and servers deleted in Server List
 * (same isServerDeleted / IP-reuse rule as every other automatic writer).
 * options.collector (array): scans pass one; the host is queued there and written once at the end of the scan
 * through applyPrometheusAdditions. options.vipSet / deletedMeta / autoSyncEnabled are per-scan caches.
 * Returns true when the host was added (or queued), false otherwise.
 */
async function autoSyncPrometheusTarget(ip, hostname = '', os = '', options = {}) {
    if (!ip) return false;
    const cleanIp = String(ip).trim();

    let enabled = options.autoSyncEnabled;
    if (enabled === undefined) {
        try { enabled = readJson(CONFIG_FILE, {}).autoSyncPrometheus !== false; } catch (_) { enabled = true; }
    }
    if (!enabled) return false;

    // A server deleted in Server List must never be re-added (an IP reused by another host name is a new server)
    // The per-scan snapshot is only a pre-filter ("flagged at scan start?"); the decision itself (which may revive on IP
    // reuse and write the meta) always uses a fresh read. Not flagged in the snapshot: apply time re-checks.
    try {
        const snap = options.deletedMeta;
        const maybeFlagged = !snap || (snap[cleanIp] && snap[cleanIp].deleted === true);
        if (maybeFlagged && shouldSkipDeleted(readDeletedMeta(), { ip: cleanIp, hostname: hostname || '' })) {
            scanLog(`[Linkage] Skipping auto-sync to Prometheus Targets - ${cleanIp} was deleted from Server List`);
            return false;
        }
    } catch (_) {}

    // Check if IP is a VIP - Never auto-sync VIPs to Prometheus Targets
    if (isIpVip(cleanIp, [], options.vipSet ? { vipSet: options.vipSet } : {})) {
        scanLog(`[Linkage] Skipping auto-sync to Prometheus Targets - ${cleanIp} is identified as VIP`);
        if (!options.collector) {
            try {
                const { result: removed } = await updateTargetsSafely((targets) => {
                    const { targets: filtered, removedCount } = removeIpFromPrometheusTargets(targets, cleanIp);
                    return removedCount > 0 ? { targets: filtered, result: removedCount } : { result: 0 };
                }, 'vip_auto_cleanup');
                if (removed > 0) scanLog(`[Linkage] Defensively removed VIP ${cleanIp} from Prometheus Targets`);
            } catch (_) {}
        }
        return false;
    }

    const exporter = resolveExporter(os);
    if (!exporter) return false;
    const item = { ip: cleanIp, hostname: hostname || cleanIp, probedHostname: hostname || '', targetOs: exporter.targetOs, port: exporter.port };

    if (Array.isArray(options.collector)) {
        if (!options.collector.some(x => x.ip === cleanIp)) options.collector.push(item);
        return true;
    }
    const added = await applyPrometheusAdditions([item]);
    return added.length > 0;
}

function getKey(file) {
    return `server_operation/oscheck/${path.basename(file)}`;
}

function readJson(file, defaultData = []) {
    return readDataSync(getKey(file), defaultData);
}

function writeJson(file, data) {
    writeDataSync(getKey(file), data);
}

const inventoryStore = require('./inventoryStore');

/** Compatibility: legacy array-of-hosts shape, now served from the inventory_hosts table. */
function getAllSubnetData() {
    return inventoryStore.getAllSubnetData();
}

// IPAM: shared CIDR helpers + the atomic store (the web process writes the same document)
const ipamCore = require('../lib/ipamCore');
const ipamStore = require('../lib/ipamStore');

/**
 * Per-scan shared state: the VIP set and deleted-server meta are computed once for the whole scan, Prometheus
 * additions are collected and written once at the end, and the ranges that were really checked (and the IPs that
 * answered) feed the CMDB reconcile so it never touches addresses outside this scan.
 */
function makeScanContext(config = {}) {
    let vipSet = null;
    try { vipSet = buildVipSet(); } catch (e) { scanLog(`WARN: VIP set unavailable: ${e.message}`); }
    let deletedMeta = {};
    try { deletedMeta = readDeletedMeta(); } catch (_) {}
    const ranges = []; // { prefix, lo, hi } actually processed
    // IPAM addresses that were already in use before this scan (the scan itself writes IPAM afterwards)
    const ipamKnown = new Set();
    try {
        for (const s of readDataSync('network_service/ipam/subnets.json', []) || []) {
            for (const e of (s && s.ips) || []) { if (e && e.address && e.status && e.status !== 'free') ipamKnown.add(e.address); }
        }
    } catch (e) { scanLog(`WARN: IPAM snapshot unavailable: ${e.message}`); }
    return {
        vipSet,
        deletedMeta,
        config,
        autoSyncEnabled: config.autoSyncPrometheus !== false,
        scanId: null,      // inventory_scans row of this run (history)
        ipamKnown,
        firstSeenCount: 0,
        newHosts: [],      // first seen in this scan and alertable (not deleted / VIP)
        unknownHosts: [],  // online, not first seen, but neither in CMDB nor in IPAM
        missedCount: 0,
        promAdds: [],
        degraded: [],      // subnets whose misses were not applied (outage breaker)
        wentOffline: [],   // hosts that crossed missesBeforeOffline in this scan
        heldIps: new Set(),// previously-online hosts that missed but kept their status
        onlineIps: new Set(),
        ranges,
        markScanned(prefix, lo, hi) { if (hi >= lo) ranges.push({ prefix, lo, hi }); },
        inScope(ip) {
            const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
            if (!m) return false;
            const last = Number(m[2]);
            return ranges.some(r => r.prefix === m[1] && last >= r.lo && last <= r.hi);
        }
    };
}

async function syncInventoryToIPAM(subnetPrefix, results, vipSet = null) {
    const online = (results || []).filter(r => r && r.status === 'online' && r.ip);
    // VIP detection reads other documents: computed before the IPAM write lock is taken
    const vipFlag = new Map(online.map(r => [r.ip, !!r.isVip || !!r.linkedTo || !!r.vipOf || isIpVip(r.ip, results, vipSet ? { vipSet } : {})]));
    const envFields = defaultEnvFields(); // one read of the environment list

    // atomic read-modify-write (the web process writes the same document)
    const out = ipamStore.mutateSubnets((subnets) => {
        const r = { created: null, modified: false };
        // no subnet covers the scanned /24: auto-create it (private ranges only)
        if (!ipamCore.findSubnetForIp(subnets, `${subnetPrefix}.1`)) {
            const created = ipamCore.autoCreateSubnetFor(`${subnetPrefix}.1`, envFields, { name: `Auto-Discovered (${subnetPrefix})` });
            if (created) {
                subnets.push(created);
                r.created = created.cidr;
                r.modified = true;
            }
        }
        for (const res of online) {
            // most specific subnet; an address past the materialised IPs of a large subnet is created
            const subnet = ipamCore.findSubnetForIp(subnets, res.ip);
            const ipEntry = subnet ? ipamCore.ensureIpEntry(subnet, res.ip) : null;
            if (!ipEntry) continue;
            let changed = false;
            const isVip = ipEntry.status === 'vip' || vipFlag.get(res.ip);
            if (isVip) {
                if (ipEntry.status !== 'vip') {
                    ipEntry.status = 'vip';
                    changed = true;
                }
            } else if (ipEntry.status !== 'used') {
                ipEntry.status = 'used';
                changed = true;
            }
            if (res.hostname && ipEntry.hostname !== res.hostname) {
                ipEntry.hostname = res.hostname;
                changed = true;
            }
            if (changed) {
                ipEntry.updatedAt = new Date().toISOString();
                r.modified = true;
            }
        }
        return r;
    }, { username: 'SYSTEM', reason: `inventory sync ${subnetPrefix}` });

    if (out.created) scanLog(`Auto-created missing IPAM subnet: ${out.created}`);
    if (out.modified) {
        scanLog(`Synced Inventory results for ${subnetPrefix} to IPAM`);
    }
}

const SPECS_ERROR_MAX = 500;
const SSH_EXEC_TIMEOUT_MS = 30000;
const WINRM_TIMEOUT_MS = 60000;
const DEGRADED_MIN_HOSTS = 4; // fewer previously-online misses than this can never trip the breaker (tiny subnets)

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function specsErrorText(value) {
    const text = String(value === undefined || value === null ? '' : value).trim() || 'Unknown error';
    return text.length > SPECS_ERROR_MAX ? text.slice(0, SPECS_ERROR_MAX) : text;
}

/**
 * Scout Agent host for an IP: exact match on the ip column, or an exact element of a comma-separated list.
 * Parameterised, no LIKE (a LIKE '%1.2.3.4%' also matches 11.2.3.45).
 */
function findScoutMonitor(ip, db = scoutDb) {
    const clean = assertIpv4(ip);
    return db.get(
        "SELECT name, os FROM monitors WHERE ip = ? OR instr(',' || REPLACE(ip, ' ', '') || ',', ?) > 0 LIMIT 1",
        [clean, `,${clean},`]
    );
}

/** True when the previously-online misses of one subnet look like a network outage instead of dead hosts. */
function isOutage(missedPrevOnline, prevOnline, thresholdPct) {
    if (missedPrevOnline < DEGRADED_MIN_HOSTS || prevOnline <= 0) return false;
    const pct = (missedPrevOnline / prevOnline) * 100;
    return pct > thresholdPct || (thresholdPct >= 100 && pct >= 100);
}

/** Normalises what an ICMP dep returns: Set / array of replies, or { alive, checked } for partially checked chunks. */
function normaliseIcmp(res, chunkIps) {
    if (res && !Array.isArray(res) && !(res instanceof Set) && res.alive) {
        return { alive: new Set(res.alive), checked: new Set(res.checked || chunkIps) };
    }
    return { alive: new Set(res || []), checked: new Set(chunkIps) };
}

/** WinRM / SSH specs of one alive host. Returns the scan-owned fields to store (error text goes to `error`). */
async function collectHostSpecs(ip, os, deps, ctx, creds = null) {
    // Credentials: the subnet's profile, else the default AD_ADMIN_* / LINUX_ADMIN_* (one shared source with deploy-agent)
    creds = creds || resolveCredentials((ctx && ctx.config) || {}, ip, { readEnv: deps.readEnv });
    const _ps = deps.runPowerShell || runPowerShell;
    const _ssh = deps.executeSSH || executeSSH;
    const winMs = deps.winrmTimeoutMs || WINRM_TIMEOUT_MS;
    const sshMs = deps.sshTimeoutMs || SSH_EXEC_TIMEOUT_MS;
    const specs = { ip, os, lastSeen: new Date().toISOString(), status: 'online' };

    // Linkage: when the open ports did not identify the OS, a Scout Agent installed on the host can
    if (os === 'unknown') {
        try {
            const mon = findScoutMonitor(ip, deps.scoutDb || scoutDb);
            if (mon && mon.os) {
                const monOs = String(mon.os).toLowerCase();
                if (monOs.includes('win')) os = 'win';
                else if (['linux', 'ubuntu', 'centos', 'debian', 'redhat', 'rocky', 'alma', 'fedora'].some(k => monOs.includes(k))) os = 'linux';
                specs.os = os;
                specs.hostname = specs.hostname || mon.name;
                specs.osname = mon.os;
                specs.error = null;
                scanLog(`[Linkage] Resolved ${ip} OS from Scout Agent: ${os.toUpperCase()} (${mon.name || 'N/A'})`);
            }
        } catch (dbErr) {
            console.warn('[InventoryScheduler] ScoutDB lookup failed:', dbErr.message);
        }
    }

    if (os === 'win' && creds.winError) {
        specs.error = creds.winError;
    } else if (os === 'linux' && creds.linuxError) {
        specs.error = creds.linuxError;
    } else if (os === 'win') {
        try {
            const scanUser = creds.winUser || '';
            const scanPwd = creds.winPassword || '';
            let formattedUser = scanUser;
            if (creds.allowedAdDomain && !formattedUser.includes('\\') && !formattedUser.includes('@')) {
                formattedUser = `${creds.allowedAdDomain}\\${formattedUser}`;
            }
            // Credentials travel via environment variables, never inside the script text
            const credEnv = (scanUser && scanPwd) ? buildCredentialEnv(formattedUser, scanPwd) : {};
            const hasCred = !!credEnv.SOMP_CRED_USER;
            const psCmd = `
                        $ErrorActionPreference = "Stop";
                        ${hasCred ? ENV_CREDENTIAL_HEADER : ''}
                        try {
                            $res = Invoke-Command -ComputerName "${ip}" ${hasCred ? '-Credential $global:AD_CRED' : ''} -ScriptBlock {
                                $o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_ComputerSystem; $t=Get-CimInstance Win32_TimeZone;
                                @{hostname=$o.CSName; domain=$c.Domain; osname=$o.Caption; mem=[math]::Round($c.TotalPhysicalMemory/1GB); cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum; timezone=$t.Caption}
                            }
                            $res | ConvertTo-Json
                        } catch {
                            @{ error = $_.Exception.Message } | ConvertTo-Json
                        }
                    `;
            const psOut = await withTimeout(_ps(psCmd, winMs + 5000, { env: credEnv }), winMs, `WinRM timed out after ${Math.round(winMs / 1000)} s`);
            if (psOut.trim()) {
                const p = JSON.parse(psOut.trim());
                if (p.error) {
                    scanLog(`WARN: ${ip} win probe failed: ${specsErrorText(p.error)}`);
                    specs.error = specsErrorText(p.error);
                } else {
                    Object.entries(p).forEach(([k, v]) => { if (v) specs[k] = v; });
                    specs.error = null; // Clear past errors on success
                }
            } else {
                scanLog(`WARN: ${ip} win probe failed (Empty response)`);
                specs.error = 'Empty response from WinRM';
            }
        } catch (e) {
            const errMsg = specsErrorText(e && (e.stderr || e.message || (e.error && e.error.message)));
            scanLog(`WARN: ${ip} win probe failed: ${errMsg}`);
            specs.error = errMsg;
        }
    } else if (os === 'linux') {
        try {
            const su = creds.linuxUser || '', sp = creds.linuxPassword || '';
            if (su && sp) {
                const cmd = `h=$(hostname); o=$(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2); m=$(free -m | awk 'NR==2{print int(($2*1.025+512)/1024)}'); c=$(nproc); t=$(timedatectl show --property=Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null); echo "$h|$o|$m|$c|$t"`;
                const { stdout } = await withTimeout(_ssh(ip, su, sp, cmd, { timeout: 5000, execTimeoutMs: sshMs, pinHostKey: true }), sshMs + 2000, `SSH timed out after ${Math.round(sshMs / 1000)} s`);
                const pts = String(stdout || '').trim().split('|');
                if (pts.length >= 5) {
                    specs.hostname = pts[0]; specs.osname = pts[1]; specs.mem = parseInt(pts[2]); specs.cpu = parseInt(pts[3]); specs.timezone = pts[4];
                    specs.error = null; // Clear past errors on success
                } else {
                    scanLog(`WARN: ${ip} linux probe failed (Invalid response)`);
                    specs.error = 'Invalid SSH response format';
                }
            } else {
                scanLog(`WARN: ${ip} linux probe skipped (No credentials configured)`);
                specs.error = 'Missing Linux credentials';
            }
        } catch (e) {
            scanLog(`WARN: ${ip} linux probe failed: ${e.message}`);
            specs.error = specsErrorText(e.message);
        }
    } else {
        specs.error = 'Unknown OS: no SSH/RDP/WinRM port answered';
    }
    return specs;
}

async function scanSubnet(subnetRaw, defaultRange = [1, 254], deps = {}, scanCtx = null) {
    // Defence in depth: the config is validated on save, but never trust stored values
    const parsed = parseSubnetEntry(subnetRaw, defaultRange);
    if (parsed.error) {
        throw new Error(`Invalid subnet entry "${String(subnetRaw).slice(0, 40).replace(/[^ -~]/g, '?')}": ${parsed.error}`);
    }
    const { prefix, start, end } = parsed;
    // Called without a scan context (direct use): own one, and write the collected Prometheus additions at the end
    const ownCtx = !scanCtx;
    const ctx = scanCtx || makeScanContext(readJson(CONFIG_FILE, {}) || {});
    const settings = resolveProbeSettings(ctx.config, parsed.normalized);
    let subnetCreds = null; // resolved lazily: only subnets with a reachable Windows / Linux host need them
    const credsForSubnet = () => (subnetCreds = subnetCreds || resolveCredentials(ctx.config, parsed.normalized, { readEnv: (deps || {}).readEnv }));
    const aborted = () => scanStatus.abortRequested;
    const _tcp = deps.tcpProbe || deps.tcpCheck || checkTcpPort;
    // Legacy injected single-address ping (tests): checked one by one so an abort stops it between addresses
    const _icmp = deps.icmpBatch || (deps.pingCheck
        ? async (chunkIps) => {
            const alive = []; const checked = [];
            for (const ip of chunkIps) {
                if (scanStatus.abortRequested) break;
                if (await deps.pingCheck(ip)) alive.push(ip);
                checked.push(ip);
            }
            return { alive, checked };
        }
        : (silentIps) => icmpCheckMany(silentIps, { concurrency: settings.concurrencyPerSubnet, shouldStop: aborted, execFile: deps.execFile }));
    scanStatus.activeSubnets.push(subnetRaw);
    const subnetTotal = Math.max(0, end - start + 1);
    let subnetDone = 0;
    scanStatus.subnetProgress[subnetRaw] = { total: subnetTotal, processed: 0, state: 'running' };
    persistProgress(true);
    const tick = () => {
        scanStatus.processedIps++;
        subnetDone++;
        scanStatus.subnetProgress[subnetRaw].processed = subnetDone;
        persistProgress();
    };

    // Legacy documents must be in the table before the first row-level write. A failure is not latched:
    // every write below retries it and is rejected (and logged per IP) until the import succeeds.
    try { inventoryStore.ensureMigrated(); } catch (e) { scanLog(`WARN: ${e.message}`); }

    // Hosts that were online before this scan (denominator of the outage breaker)
    const prevOnline = new Set();
    try {
        for (const h of inventoryStore.listHostsBySubnet(prefix)) {
            const last = Number(String(h.ip).split('.')[3]);
            if (h.status === 'online' && last >= start && last <= end) prevOnline.add(h.ip);
        }
    } catch (e) { scanLog(`WARN: previous state of ${prefix}.x unavailable: ${e.message}`); }

    const ips = [];
    for (let i = start; i <= end; i++) ips.push(assertIpv4(`${prefix}.${i}`));
    const alive = new Map();   // ip -> open TCP ports
    const missed = [];         // ips that really did not answer (never an unchecked address)
    const decided = new Set(); // addresses fully handled by this scan (missed, or alive and stored)

    // Phase 1: TCP connect on the configured ports, bounded concurrency
    const noTcp = [];
    await runPool(ips, settings.concurrencyPerSubnet, async (ip) => {
        scanStatus.currentIp = ip;
        const open = await probeTcpPorts(ip, settings.tcpPorts, _tcp);
        if (open.length) { alive.set(ip, open); tick(); } else noTcp.push(ip);
    }, aborted);

    // Phase 2: ICMP (ping, 2 attempts) only for the addresses where no TCP port answered. An address whose ping could
    // not be decided (spawn error / timeout) is neither alive nor a miss: it is held like an unreached one.
    const unknown = [];
    if (noTcp.length && !aborted()) {
        const { alive: replied, checked } = normaliseIcmp(await _icmp(noTcp), noTcp);
        for (const ip of noTcp) {
            if (replied.has(ip)) { alive.set(ip, []); tick(); }
            else if (checked.has(ip)) { missed.push(ip); decided.add(ip); tick(); }
            else if (!aborted()) { unknown.push(ip); tick(); }
        }
        if (unknown.length) scanLog(`WARN: ${subnetRaw}: ping could not be decided for ${unknown.length} address(es); their status was left unchanged`);
    }

    // Phase 3: specs of the alive hosts (WinRM / SSH, with timeouts), bounded concurrency
    await runPool([...alive.keys()], settings.concurrencyPerSubnet, async (ip) => {
        const open = alive.get(ip);
        ctx.onlineIps.add(ip);
        let os = 'unknown';
        if (open.some(p => p === 3389 || p === 5985 || p === 5986)) os = 'win';
        else if (open.includes(22)) os = 'linux';
        const specs = await collectHostSpecs(ip, os, deps, ctx, (os === 'win' || os === 'linux' || os === 'unknown') ? credsForSubnet() : null);
        os = specs.os;

        const prevItem = inventoryStore.getHost(ip) || {};
        const isFirstSeen = !prevItem.ip;
        const isVipHost = !!prevItem.isVip || !!prevItem.linkedTo || !!prevItem.vipOf || isIpVip(ip, prevItem.ip ? [prevItem] : [], ctx.vipSet ? { vipSet: ctx.vipSet } : {});
        // New / unknown host detection must look at CMDB / IPAM BEFORE this scan registers the host there.
        // A server flagged deleted (fresh meta, never the scan-start snapshot) or a VIP never raises the alert.
        let alertable = !isVipHost;
        try { if (alertable) { const m = readDeletedMeta(); alertable = !(m[ip] && m[ip].deleted === true); } } catch (_) { /* detection is best effort */ }
        let unmanaged = false;
        try { if (alertable && !isFirstSeen) unmanaged = !ctx.ipamKnown.has(ip) && !(deps.cmdbLookup || getCmdbServerByIp)(ip); } catch (_) { /* best effort */ }
        // One row write per IP: only scan-owned fields; tags / VIP links edited meanwhile are untouched
        let stored = null;
        try {
            stored = inventoryStore.upsertScanResult(ip, specs);
            if (isVipHost && !prevItem.isVip) inventoryStore.markVip(ip);
        } catch (e) {
            scanLog(`WARN: ${ip} result not stored: ${e.message}`);
        }
        if (stored) {
            if (isFirstSeen) ctx.firstSeenCount++;
            if (isFirstSeen && alertable) ctx.newHosts.push({ ip, hostname: specs.hostname || '', os: specs.os || '' });
            else if (unmanaged) ctx.unknownHosts.push({ ip, hostname: specs.hostname || prevItem.hostname || '', os: specs.os || '' });
            // History: field level changes of this host (old vs new); a history failure never hides the host or the alert
            if (ctx.scanId) {
                try { inventoryHistory.recordChanges(ctx.scanId, inventoryHistory.diffHost(isFirstSeen ? null : prevItem, stored).map(c => ({ ...c, ip }))); }
                catch (e) { scanLog(`WARN: ${ip} scan history not written: ${e.message}`); }
            }
        }
        scanStatus.discovered++;

        // Auto-sync to Prometheus Targets (if OS is win/linux or resolved from Scout Agent, and NOT VIP)
        if ((os === 'win' || os === 'linux') && !isVipHost) {
            // Collected here, written once at the end of the scan
            const syncEnabled = typeof settings.autoSyncPrometheus === 'boolean' ? settings.autoSyncPrometheus : ctx.autoSyncEnabled;
            await autoSyncPrometheusTarget(ip, specs.hostname, os, { collector: ctx.promAdds, vipSet: ctx.vipSet, deletedMeta: ctx.deletedMeta, autoSyncEnabled: syncEnabled });
        }
        decided.add(ip);
    }, aborted);

    // Misses: hosts that were online before are only counted when the subnet is not in an outage
    // Breaker denominator: previously-online hosts whose liveness was really decided in this run (not unreached / unknown)
    const missedPrev = missed.filter(ip => prevOnline.has(ip));
    const decidedPrevCount = [...prevOnline].filter(ip => alive.has(ip) || missed.includes(ip)).length;
    unknown.forEach(ip => ctx.heldIps.add(ip));
    let toRecord = missed;
    if (isOutage(missedPrev.length, decidedPrevCount, settings.outageThresholdPct)) {
        const info = { subnet: subnetRaw, missed: missedPrev.length, previouslyOnline: decidedPrevCount };
        ctx.degraded.push(info);
        scanStatus.degradedSubnets.push(info);
        toRecord = missed.filter(ip => !prevOnline.has(ip));
        scanLog(`DEGRADED: ${subnetRaw} - ${missedPrev.length} of ${decidedPrevCount} previously online hosts did not answer; their status was left unchanged`);
    }
    if (toRecord !== missed) missedPrev.forEach(ip => ctx.heldIps.add(ip));
    for (let i = 0; i < toRecord.length; i += 25) {
        try {
            const res = inventoryStore.recordMissBatch(toRecord.slice(i, i + 25), { missesBeforeOffline: settings.missesBeforeOffline });
            res.wentOffline.forEach(ip => ctx.wentOffline.push(ip));
            ctx.missedCount += res.missed;
            if (ctx.scanId && res.wentOffline.length) {
                try { inventoryHistory.recordChanges(ctx.scanId, res.wentOffline.map(ip => ({ ip, field: 'status', oldValue: 'online', newValue: 'offline' }))); }
                catch (e) { scanLog(`WARN: history of ${res.wentOffline.length} offline host(s) not stored: ${e.message}`); }
            }
            const gone = new Set(res.wentOffline);
            toRecord.slice(i, i + 25).forEach(ip => { if (prevOnline.has(ip) && !gone.has(ip)) ctx.heldIps.add(ip); });
        } catch (e) { scanLog(`WARN: could not store miss state for ${Math.min(25, toRecord.length - i)} hosts: ${e.message}`); }
    }

    const cut = aborted() && (decided.size + unknown.length) < subnetTotal;
    if (!cut) {
        ctx.markScanned(prefix, start, end);
    } else {
        // aborted: only the addresses whose liveness was really decided and finished count as scanned (contiguous runs)
        const last = [...decided].map(ip => Number(ip.split('.')[3])).sort((x, y) => x - y);
        let from = null; let prev = null;
        for (const n of last) {
            if (from === null) { from = n; prev = n; continue; }
            if (n === prev + 1) { prev = n; continue; }
            ctx.markScanned(prefix, from, prev); from = n; prev = n;
        }
        if (from !== null) ctx.markScanned(prefix, from, prev);
    }
    const isDegraded = ctx.degraded.some(d => d.subnet === subnetRaw);
    scanStatus.subnetProgress[subnetRaw].state = cut ? 'aborted' : (isDegraded ? 'degraded' : 'done');
    scanStatus.activeSubnets = scanStatus.activeSubnets.filter(s => s !== subnetRaw);
    persistProgress(true);
    scanLog(`${subnetRaw}: ${alive.size} online, ${missed.length} no answer${isDegraded ? ' (degraded)' : ''}`);
    await syncInventoryToIPAM(prefix, inventoryStore.listHostsBySubnet(prefix), ctx.vipSet);
    if (ownCtx) await applyPrometheusAdditions(ctx.promAdds);
}

async function sendComplianceReport(config = null, deps = {}) {
    if (!config) config = readJson(CONFIG_FILE, {});
    const _sendMail = deps.sendMail || sendMail;
    
    try {
        const targetOffset = parseFloat(config.timezoneCheck?.targetOffset);
        if (isNaN(targetOffset)) return { success: false, message: 'Invalid target offset' };

        const allData = deps.getAllSubnetData ? deps.getAllSubnetData() : getAllSubnetData();
        const exclusions = config.timezoneCheck?.exclusions || [];
        
        const getOffset = (tz) => {
            if (!tz) return null;
            const winMatch = tz.match(/\(UTC([+-]\d{2}):(\d{2})\)/);
            if (winMatch) {
                const h = parseInt(winMatch[1]);
                const m = parseInt(winMatch[2]);
                return h + (m / 60) * (h < 0 ? -1 : 1);
            }
            try {
                const now = new Date();
                const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
                const parts = fmt.formatToParts(now);
                const offsetStr = parts.find(p => p.type === 'timeZoneName').value;
                const offsetMatch = offsetStr.match(/GMT([+-]\d+)(?::(\d+))?/);
                if (offsetMatch) {
                    const h = parseInt(offsetMatch[1]);
                    const m = parseInt(offsetMatch[2] || '0');
                    return h + (m / 60) * (h < 0 ? -1 : 1);
                }
            } catch (e) {
                console.warn(`[Inventory] Could not resolve offset for TZ: ${tz} - ${e.message}`);
            }
            return null; 
        };

        const nonCompliant = allData.filter(srv => {
            let target = targetOffset;
            // Precedence: legacy timezoneCheck.subnetOffsets row (single IP beats /24) > subnetSettings.timezoneOffset > global target
            const legacy = legacyOffsetFor(config, srv.ip);
            if (legacy !== null) {
                target = legacy;
            } else {
                const own = srv.ip ? findSubnetSettings(config, srv.ip) : null;
                if (own && own.timezoneOffset !== undefined && Number.isFinite(Number(own.timezoneOffset))) target = Number(own.timezoneOffset);
            }

            if (srv.status === 'offline' || !srv.timezone || isNaN(target)) return false;
            const isExcluded = exclusions.some(ex => {
                if (!ex.target) return false;
                if (ex.target === srv.ip || ex.target === srv.hostname) return true;
                let prefix = '';
                if (ex.target.endsWith('.*')) prefix = ex.target.slice(0, -1);
                else if (ex.target.endsWith('.0/24')) prefix = ex.target.slice(0, -4) + '.';
                if (prefix && srv.ip && srv.ip.startsWith(prefix)) return true;
                return false;
            });
            if (isExcluded) return false;
            const offset = getOffset(srv.timezone);
            if (offset === null) return false; 
            return Math.abs(offset - target) > 0.01;
        });

        if (nonCompliant.length === 0) {
            return { success: true, message: 'All compliant, no report sent' };
        }

        let tableRows = nonCompliant.map(s => `
            <tr>
                <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.ip)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.hostname || '-')}</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.timezone)}</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.os)}</td>
            </tr>
        `).join('');

        await _sendMail({
            subject: `[Inventory] Timezone Compliance Report - ${nonCompliant.length} Issues Found`,
            html: `
                <h2>Timezone Non-Compliance Alert</h2>
                <p>The inventory scan has identified <b>${nonCompliant.length}</b> devices with timezones that do not match the target offset (UTC ${targetOffset > 0 ? '+' : ''}${escapeHtml(targetOffset)}).</p>
                <table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px">
                    <thead style="background:#f4f4f4">
                        <tr>
                            <th style="padding:8px;text-align:left">IP</th>
                            <th style="padding:8px;text-align:left">Hostname</th>
                            <th style="padding:8px;text-align:left">Current Timezone</th>
                            <th style="padding:8px;text-align:left">OS</th>
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
                <p><small>This is a manual/automated report from SOMP Vanguard.</small></p>
            `
        });
        return { success: true, count: nonCompliant.length };
    } catch (err) {
        console.error('[Inventory] Report failed:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Resolves the subnet list of a scan. Without a scope: every configured subnet. { ip }: just that address.
 * { subnet }: the configured entries of that /24 (or the given range itself when it is not configured).
 */
function resolveScanTargets(config, scope) {
    const defaultRange = config.defaultScanRange || [1, 254];
    const configured = (config.subnets || []).map(entry => {
        const p = parseSubnetEntry(entry, defaultRange);
        if (p.error) { scanLog(`Skipping invalid subnet entry: ${p.error}`); return null; }
        return p;
    }).filter(Boolean);
    if (!scope) return configured.map(p => p.normalized);
    if (scope.ip) {
        const ip = assertIpv4(scope.ip);
        const parts = ip.split('.');
        const last = parseInt(parts[3], 10);
        if (last < 1 || last > 254) throw new Error(`Cannot scan ${ip}: host part must be 1-254`);
        return [`${parts.slice(0, 3).join('.')}:${last}~${last}`];
    }
    if (scope.subnet) {
        const want = parseSubnetEntry(scope.subnet, defaultRange);
        if (want.error) throw new Error(`Invalid scan scope: ${want.error}`);
        const same = configured.filter(p => p.prefix === want.prefix).map(p => p.normalized);
        return same.length ? same : [want.normalized];
    }
    return [];
}

/**
 * Runs one scan in this (worker) process. Only one scan at a time: a worker-local flag plus the shared status
 * document (a "running" status younger than 6 h belonging to another run blocks a second start).
 * Resolves with { skipped } when it did not start.
 * @param {{ trigger?: string, requestedBy?: string, scope?: { subnet?: string, ip?: string } }} [options]
 */
/** Records why a requested scan did not start in the shared status (so the UI can show it). */
async function recordSkip(reason, message, options = {}, whileRunning = false) {
    try {
        const skip = { reason, message, at: new Date().toISOString(), trigger: options.trigger || 'manual', requestedBy: options.requestedBy || null };
        // while a scan runs only the lastSkipped field changes (progress writes keep flowing through the same writer)
        await statusWriter.update({ lastSkipped: skip }, { touch: false });
    } catch (e) { /* the writer never rejects */ }
}

async function runScan(options = {}) {
    if (scanStatus.running) { await recordSkip('running', 'A scan is already running in the worker', options, true); return { skipped: 'running' }; }
    // Reserve the worker-local guard synchronously: no await between the check and this assignment
    scanStatus.running = true;
    let started = false;
    try {
        const shared = await readSharedStatus();
        if (isStatusRunning(shared) && shared.pid !== process.pid) {
            // Another process owns the status document: report, but never write over its progress
            scanLog('Scan not started: another scan is already running');
            return { skipped: 'running' };
        }
        const config = readJson(CONFIG_FILE, { subnets: [] });
        let targets;
        try {
            targets = resolveScanTargets(config, options.scope || null);
        } catch (e) {
            scanLog(`Scan not started: ${e.message}`);
            await recordSkip('invalid_scope', e.message, options);
            return { skipped: 'invalid_scope', error: e.message };
        }
        if (!targets.length) {
            scanLog('No valid subnets configured.');
            await recordSkip('no_subnets', 'No valid subnets configured', options);
            return { skipped: 'no_subnets' };
        }
        started = true;
        await runScanInner(config, targets, options);
        return { ok: true, runId: scanStatus.runId };
    } finally {
        if (!started) scanStatus.running = false;
    }
}

async function runScanInner(config, validSubnets, options) {
    const trigger = options.trigger || 'manual';
    const isPartial = !!options.scope;
    config.subnets = validSubnets;

    // Build previous status map of all existing devices
    const previousStatusMap = {};
    getAllSubnetData().forEach(item => {
        previousStatusMap[item.ip] = {
            status: item.status || 'offline',
            hostname: item.hostname || 'Unknown'
        };
    });
    const monitoredIps = config.monitoredIps || [];
    const startedAtIso = new Date().toISOString();
    const scanCtx = makeScanContext(config);

    let heartbeat = null;
    try {
        scanStatus.running = true;
        scanStatus.discovered = 0;
        scanStatus.processedIps = 0;
        scanStatus.startTime = Date.now();
        scanStatus.totalSubnets = config.subnets.length;
        const defaultRange = config.defaultScanRange || [1, 254];
        scanStatus.totalIps = config.subnets.reduce((acc, subnetRaw) => {
            const p = parseSubnetEntry(subnetRaw, defaultRange);
            return acc + (Math.max(0, p.end - p.start + 1));
        }, 0);
        scanStatus.logs = [];
        scanStatus.abortRequested = false;
        scanStatus.activeSubnets = [];
        scanStatus.runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        scanStatus.trigger = trigger;
        scanStatus.requestedBy = options.requestedBy || null;
        scanStatus.scope = options.scope || null;
        scanStatus.subnetProgress = {};
        scanStatus.degradedSubnets = [];
        config.subnets.forEach(sn => { scanStatus.subnetProgress[sn] = { total: 0, processed: 0, state: 'pending' }; });
        config.subnets.forEach(sn => { const p = parseSubnetEntry(sn, defaultRange); scanStatus.subnetProgress[sn].total = Math.max(0, p.end - p.start + 1); });
        try {
            scanCtx.scanId = inventoryHistory.startScan({ runId: scanStatus.runId, trigger, requestedBy: scanStatus.requestedBy, scope: scanStatus.scope, startedAt: startedAtIso, subnets: config.subnets });
        } catch (e) { scanLog(`WARN: scan history unavailable: ${e.message}`); }
        lastProgressWrite = Date.now();
        await statusWriter.update({
            running: true,
            runId: scanStatus.runId,
            pid: process.pid,
            startedAt: startedAtIso,
            finishedAt: null,
            trigger,
            requestedBy: scanStatus.requestedBy,
            scope: scanStatus.scope,
            aborted: false,
            interrupted: false,
            degraded: false,
            error: null,
            ...snapshotProgress()
        });
        // Liveness: refresh updatedAt while scanning so the web process can tell a live scan from a dead worker
        heartbeat = setInterval(() => { statusWriter.update(snapshotProgress()); }, options.heartbeatMs || HEARTBEAT_MS);
        if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
        const probeSettings = resolveProbeSettings(config);
        scanLog(`Scan started (${trigger}${isPartial ? ', partial' : ''}, ${probeSettings.subnetConcurrency} subnets parallel, ${probeSettings.concurrencyPerSubnet} hosts per subnet)`);

        auditLog(options.requestedBy || 'System', 'Inventory', `Background scan started (${trigger})`);

        // A failing subnet never stops the others
        await runPool(config.subnets, probeSettings.subnetConcurrency, async (s) => {
            try {
                await scanSubnet(s, defaultRange, options.deps || {}, scanCtx);
            } catch (e) {
                scanLog(`ERROR: subnet ${s} failed: ${e.message}`);
                if (scanStatus.subnetProgress[s]) scanStatus.subnetProgress[s].state = 'error';
                scanStatus.activeSubnets = scanStatus.activeSubnets.filter(x => x !== s);
            }
        }, () => scanStatus.abortRequested);
    } catch (e) {
        scanLog(`CRITICAL ERROR: ${e.message}`);
    } finally {
      // Captured before any await: an abort that arrives during post-processing must not turn a finished scan into an aborted one
      const scanAborted = scanStatus.abortRequested;
      let postError = null;
      try {
        // One Prometheus write for every host found by this scan. An aborted scan still registers the hosts it
        // completed (they were really discovered); it simply has fewer of them.
        await applyPrometheusAdditions(scanCtx.promAdds);
        await flushPrometheusAlerts();
        
        // Reconcile and purge any VIP targets from Prometheus Targets after inventory scan completes
        try {
            await reconcileAllLinkedVips();
        } catch (recErr) {
            scanLog(`[VIP Reconcile] Post-scan VIP reconciliation error: ${recErr.message}`);
        }

        const updatedConfig = readJson(CONFIG_FILE, {});
        const prevDiscovered = updatedConfig.lastDiscovered !== undefined ? updatedConfig.lastDiscovered : scanStatus.discovered;
        const delta = scanStatus.discovered - prevDiscovered;
        const deltaStr = delta > 0 ? `+${delta}` : (delta < 0 ? `${delta}` : `0`);

        // lastScan / lastDiscovered are server-owned and describe the last COMPLETE full scan
        if (!isPartial && !scanAborted) {
            updatedConfig.lastScan = new Date().toISOString();
            updatedConfig.lastDiscovered = scanStatus.discovered;
            writeJson(CONFIG_FILE, updatedConfig);
        }
        
        const durationMs = Date.now() - scanStatus.startTime;
        const durationMin = Math.floor(durationMs / 60000);
        const durationSec = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${durationMin}m ${durationSec}s`;

        const outcome = scanAborted ? 'aborted' : 'completed';
        const summary = `Scan ${outcome} — ${scanStatus.discovered} devices discovered (Delta: ${deltaStr}) (Duration: ${durationStr})`;
        scanLog(summary);
        auditLog('System', 'Inventory', summary);
        // Partial or aborted scans do not describe the whole network: no "completed" summary notice
        if (!isPartial && !scanAborted) require('../lib/logger').sendTelegramAlert(`📋 [Inventory Scan]\nStatus: ${outcome === 'aborted' ? 'Aborted' : 'Completed'}${isPartial ? ' (partial)' : ''}\nDiscovered: ${scanStatus.discovered} (Delta: ${deltaStr})\nDuration: ${durationStr}\nProcessed: ${scanStatus.processedIps} IPs`, 'Inventory');
        
        // Check for status changes and log them to status_changes.json
        const currentStatusMap = {};
        getAllSubnetData().forEach(item => {
            currentStatusMap[item.ip] = {
                status: item.status || 'offline',
                hostname: item.hostname || 'Unknown'
            };
        });

        const statusChanges = [];
        const changeTime = new Date().toISOString();
        for (const ip of Object.keys(currentStatusMap)) {
            const prev = previousStatusMap[ip];
            const curr = currentStatusMap[ip];
            
            const prevStatus = prev ? prev.status : 'unknown';
            const currStatus = curr.status;

            if (prevStatus !== currStatus) {
                if (prevStatus === 'unknown' && currStatus !== 'online') {
                    continue; // Do not record unknown -> offline
                }
                statusChanges.push({
                    timestamp: changeTime,
                    ip,
                    hostname: curr.hostname !== 'Unknown' ? curr.hostname : (prev ? prev.hostname : 'Unknown'),
                    from: prevStatus === 'unknown' ? 'none' : prevStatus,
                    to: currStatus
                });
            }
        }

        // History lives in inventory_scans / inventory_host_changes (recorded while the results are stored);
        // the old 1000-entry status_changes.json is no longer written (read-only fallback in the history API).

        // Status changes: ONE batched notice per scan (never one message per host); offline hosts of the monitored
        // list are called out in the same notice
        queueStatusChangeNotice(statusChanges, monitoredIps, scanCtx);
        queueDegradedNotice(scanCtx);
        if (config.newHostAlerts !== false) queueNewHostNotice(scanCtx);

        // Automated Timezone Report Email
        if (!isPartial && !scanAborted && updatedConfig.timezoneCheck?.autoEmail) {
            await module.exports.sendComplianceReport(updatedConfig);
        }

        // Sync discovered inventory to CMDB Master Table (cmdb_servers).
        // Only hosts that answered in THIS scan refresh their CMDB row (lastDiscoveredAt / lifecycle 'active'), and only
        // addresses inside the ranges this scan really covered can be marked "missing" (partial / aborted scans, and
        // servers of other sources outside the scanned networks, are never touched).
        try {
            const { bulkUpsertCmdbServers, reconcileDiscoveredServers } = require('./cmdbModel');
            const onlineNow = [];
            const prefixes = [...new Set(scanCtx.ranges.map(r => r.prefix))];
            for (const prefix of prefixes) {
                for (const host of inventoryStore.listHostsBySubnet(prefix)) {
                    if (host && scanCtx.onlineIps.has(host.ip) && scanCtx.inScope(host.ip)) onlineNow.push(host);
                }
            }
            // Inventory fields -> CMDB columns (cpu, memory, OS, FQDN, tags ...); empty values never blank a CMDB value
            if (onlineNow.length) bulkUpsertCmdbServers(onlineNow.map(mapInventoryHostToCmdb), 'INVENTORY_SCAN');
            // hosts that missed but are still 'online' (below missesBeforeOffline, or held by the outage breaker) are not "missing" yet
            reconcileDiscoveredServers(new Set(scanCtx.onlineIps), { inScope: (ip) => scanCtx.inScope(ip) && !scanCtx.heldIps.has(ip) });
        } catch (e) {
            console.error('[InventoryScheduler] CMDB sync error:', e.message);
        }

      } catch (postErr) {
        postError = postErr;
        scanLog(`Post-scan processing error: ${postErr.message}`);
      } finally {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        // Subnets that never started are 'skipped'; one left running by an error / abort is closed too
        Object.values(scanStatus.subnetProgress).forEach(p => {
            if (p.state === 'pending') p.state = 'skipped';
            else if (p.state === 'running') p.state = scanAborted ? 'aborted' : 'error';
        });
        // History row of this run (also for partial / aborted scans), then retention cleanup in small batches
        if (scanCtx.scanId) {
            try {
                inventoryHistory.finishScan(scanCtx.scanId, {
                    durationMs: Date.now() - scanStatus.startTime,
                    ipsChecked: scanStatus.processedIps,
                    online: scanCtx.onlineIps.size,
                    offline: scanCtx.missedCount,
                    newHosts: scanCtx.firstSeenCount,
                    disappeared: scanCtx.wentOffline.length,
                    degradedSubnets: scanCtx.degraded,
                    aborted: scanAborted
                });
            } catch (e) { console.error('[Inventory] Could not close the scan history row:', e.message); }
            try { await inventoryHistory.cleanup({ retentionDays: inventoryHistory.retentionDays(readJson(CONFIG_FILE, {})) }); }
            catch (e) { console.error('[Inventory] History cleanup failed:', e.message); }
        }
        scanStatus.running = false;
        scanStatus.activeSubnets = [];
        scanStatus.currentIp = '';
        try {
            await statusWriter.update({
                ...snapshotProgress(),
                running: false,
                finishedAt: new Date().toISOString(),
                aborted: scanAborted,
                abortRequested: false,
                error: postError ? postError.message : null
            });
        } catch (e) { /* the writer never rejects */ }
      }
        
        // Broadcast WebSocket Event via IPC to Web process
        // Worker is a forked child process and has no WebSocket server instance.
        // Send IPC message to parent (Web process) which owns the WSS.
        if (typeof process.send === 'function') {
            try {
                process.send({ type: 'BROADCAST_EVENT', event: 'INVENTORY_SCAN_COMPLETE', payload: { timestamp: Date.now() } });
            } catch(e) {}
        }
    }
}

/** One batched notice per scan: hosts that went offline / came back online (and monitored hosts that went offline). */
function queueStatusChangeNotice(statusChanges, monitoredIps, scanCtx) {
    try {
        const monitored = new Set(monitoredIps || []);
        const label = (c) => `${c.ip} (${c.hostname && c.hostname !== 'Unknown' ? c.hostname : '-'})`;
        const down = statusChanges.filter(c => c.from === 'online' && c.to === 'offline');
        const up = statusChanges.filter(c => c.from === 'offline' && c.to === 'online');
        if (!down.length && !up.length) return;
        const item = { down: down.map(c => label(c) + (monitored.has(c.ip) ? ' [monitored]' : '')), up: up.map(label) };
        queueNotification('inventory-status-changes', 'Inventory', item, (items) => {
            const downs = items.flatMap(i => i.down);
            const ups = items.flatMap(i => i.up);
            const parts = [`📡 [Inventory] Status changes: ${downs.length} offline, ${ups.length} back online`];
            if (downs.length) parts.push(`Went OFFLINE (${downs.length}):\n${summarizeLines(downs)}`);
            if (ups.length) parts.push(`Back ONLINE (${ups.length}):\n${summarizeLines(ups)}`);
            return parts.join('\n\n');
        });
    } catch (e) {
        console.error('[Inventory] Could not queue status change notice:', e.message);
    }
}

/**
 * One summary per scan for hosts seen for the first time and for online hosts that are neither in CMDB nor in IPAM
 * (category Inventory; switched off with config.newHostAlerts = false).
 */
function queueNewHostNotice(scanCtx) {
    if (!scanCtx.newHosts.length && !scanCtx.unknownHosts.length) return;
    try {
        const label = (h, why) => `${h.ip} (${h.hostname || '-'})${h.os && h.os !== 'unknown' ? ` [${h.os}]` : ''} - ${why}`;
        const lines = [
            ...scanCtx.newHosts.map(h => label(h, 'first seen')),
            ...scanCtx.unknownHosts.map(h => label(h, 'not in CMDB / IPAM'))
        ];
        queueNotification('inventory-new-hosts', 'Inventory', { lines }, (items) => {
            const all = items.flatMap(i => i.lines);
            return `🆕 [Inventory] ${all.length} new / unknown host(s) found\n${summarizeLines(all)}`;
        });
    } catch (e) {
        console.error('[Inventory] Could not queue new host notice:', e.message);
    }
}

/** One notice per scan listing the subnets whose results were not applied because they looked like an outage. */
function queueDegradedNotice(scanCtx) {
    if (!scanCtx.degraded.length) return;
    try {
        const lines = scanCtx.degraded.map(d => `${d.subnet}: ${d.missed} of ${d.previouslyOnline} previously online hosts did not answer`);
        queueNotification('inventory-degraded', 'Inventory', { lines }, (items) =>
            `⚠️ [Inventory] Scan degraded - possible network outage, host status left unchanged\n${summarizeLines(items.flatMap(i => i.lines))}`);
    } catch (e) {
        console.error('[Inventory] Could not queue degraded notice:', e.message);
    }
}

/** Asks the running scan (if any) to stop at the next IP. Returns true when a scan was running. */
function abortScan() {
    if (!scanStatus.running) return false;
    scanStatus.abortRequested = true;
    scanLog('Abort requested');
    persistProgress(true);
    return true;
}

/**
 * IPC abort: stops the active scan; when the shared status says "running" but this worker has no active scan
 * (final write lost / ghost) the status is closed as aborted instead of silently doing nothing.
 * Returns 'aborting' | 'closed' | 'idle'.
 */
async function abortScanOrCloseGhost() {
    if (abortScan()) return 'aborting';
    try {
        const cur = await readSharedStatus();
        if (cur && cur.running && !cur.finishedAt) {
            await statusWriter.update({ ...cur, running: false, finishedAt: new Date().toISOString(), aborted: true, abortRequested: false, error: 'Aborted: no active scan in the worker' });
            console.log('[Inventory] Closed a ghost "running" status on abort request.');
            return 'closed';
        }
    } catch (e) {
        console.error('[Inventory] Ghost status close failed:', e.message);
    }
    return 'idle';
}

/**
 * Worker start: a status that still says "running" cannot belong to a live scan of this process, so close it
 * (the previous worker died mid-scan) instead of blocking new scans until the 6 h staleness limit.
 */
async function recoverInterruptedStatus() {
    // Scan history rows left open by the dead worker are closed as interrupted (only the worker scans)
    try {
        const n = inventoryHistory.closeInterrupted();
        if (n) console.log(`[Inventory] Closed ${n} interrupted scan history row(s).`);
    } catch (e) {
        console.error('[Inventory] Closing interrupted scan history failed:', e.message);
    }
    try {
        const cur = await readSharedStatus();
        if (cur && cur.running && !cur.finishedAt && cur.pid !== process.pid) {
            await statusWriter.update({ running: false, finishedAt: new Date().toISOString(), interrupted: true, aborted: true, error: 'Worker restarted during the scan' });
            console.log('[Inventory] Closed a scan status left running by a previous worker.');
        }
    } catch (e) {
        console.error('[Inventory] Status recovery failed:', e.message);
    }
}

const { createInventoryScheduler } = require('./inventoryScheduling');
let inventorySchedulerInstance = null;

function getSchedulerInstance() {
    if (!inventorySchedulerInstance) {
        inventorySchedulerInstance = createInventoryScheduler({
            readConfig: async () => readJson(CONFIG_FILE, { schedule: { enabled: false } }),
            readStatus: () => statusWriter.get(),
            patchStatus: (patch) => statusWriter.update(patch),
            runScan: (opts) => runScan(opts),
            log: (m) => console.log(`[Inventory] ${m}`)
        });
    }
    return inventorySchedulerInstance;
}

/**
 * (Re)loads the schedule. Called by the worker at start (startup: true, which also performs the 6 h catch-up)
 * and on RELOAD_INVENTORY_SCHEDULER. Never throws.
 */
async function initInventoryScheduler({ startup = false } = {}) {
    try {
        if (startup) {
            await recoverInterruptedStatus();
            // History retention: one cleanup shortly after the worker starts, then every 24 h (batched deletes)
            inventoryHistory.scheduleDailyCleanup(async () => readJson(CONFIG_FILE, {}));
        }
        const res = await getSchedulerInstance().start({ startup });
        if (res.nextRunAt) {
            console.log(`[Inventory] Next scheduled scan: ${res.nextRunAt.toISOString()}`);
        } else {
            console.log('[Inventory] Scheduled scan is currently disabled.');
        }
        return res;
    } catch (err) {
        console.error(`[Inventory] Scheduler init error: ${err.message}`);
        return null;
    }
}

function updateServerTags(ip, tags) {
    if (!ip) throw new Error('IP address is required');
    if (!Array.isArray(tags)) throw new Error('Tags must be an array');

    const updated = inventoryStore.updateTags(ip, tags);
    
    if (!updated) throw new Error('Server not found in inventory');
    return { success: true, tags };
}

module.exports = { 
    validateInventoryConfig,
    scanSubnet,
    scanStatus, 
    runScan, 
    abortScan,
    abortScanOrCloseGhost,
    initInventoryScheduler, 
    recoverInterruptedStatus,
    readJson, 
    writeJson, 
    getAllSubnetData, 
    sendComplianceReport,
    updateServerTags,
    autoSyncPrometheusTarget,
    applyPrometheusAdditions,
    makeScanContext,
    isOutage,
    findScoutMonitor,
    queuePrometheusAlert,
    flushPrometheusAlerts,
    CONFIG_FILE 
};
