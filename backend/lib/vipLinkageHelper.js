const { readDataSync, db } = require('./db');
const cmdbMetaStore = require('./cmdbMetaStore');
const { auditLog, queueNotification, summarizeLines } = require('./logger');
const { updateTargetsSafely } = require('./prometheusTargetHelper');
const { getCmdbServerByIp, upsertCmdbServer, deleteCmdbServer } = require('../services/cmdbModel');

const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';

// Helper to record CMDB Audit History
function recordCmdbHistoryEntry(ip, username, action, oldData, newData) {
    try {
        // atomic append (the worker writes the same history)
        cmdbMetaStore.appendHistory(cmdbMetaStore.makeHistoryEntry(ip, username, action, oldData, newData), 500);
    } catch (e) {
        console.error('[vipLinkageHelper] CMDB History error:', e.message);
    }
}

/**
 * Filter and remove any Prometheus target matching a given IP across all supported target formats
 */
function removeIpFromPrometheusTargets(targets, targetIp) {
    if (!Array.isArray(targets) || !targetIp) return { targets: targets || [], removedCount: 0 };
    const cleanIp = String(targetIp).trim();
    let removedCount = 0;

    const filtered = [];
    for (const t of targets) {
        let isMatch = false;

        // 1. Check labels.addr
        if (t.labels?.addr) {
            const addrClean = String(t.labels.addr).trim().split(':')[0];
            if (addrClean === cleanIp) isMatch = true;
        }

        // 2. Check labels.ip
        if (!isMatch && t.labels?.ip) {
            const ipClean = String(t.labels.ip).trim().split(':')[0];
            if (ipClean === cleanIp) isMatch = true;
        }

        // 3. Check labels.instance
        if (!isMatch && t.labels?.instance) {
            const instClean = String(t.labels.instance).replace(/^https?:\/\//, '').trim().split(':')[0];
            if (instClean === cleanIp) isMatch = true;
        }

        // 4. Check root ip
        if (!isMatch && t.ip) {
            const ipClean = String(t.ip).trim().split(':')[0];
            if (ipClean === cleanIp) isMatch = true;
        }

        // 5. Check targets array (multi-port or multi-host)
        if (Array.isArray(t.targets)) {
            const matchedInTargets = t.targets.some(tgt => {
                const hostOrIp = String(tgt).replace(/^https?:\/\//, '').trim().split(':')[0];
                return hostOrIp === cleanIp;
            });
            if (matchedInTargets) {
                const remainingEndpoints = t.targets.filter(tgt => {
                    const hostOrIp = String(tgt).replace(/^https?:\/\//, '').trim().split(':')[0];
                    return hostOrIp !== cleanIp;
                });
                if (remainingEndpoints.length === 0) {
                    isMatch = true;
                } else {
                    t.targets = remainingEndpoints;
                    removedCount++;
                    filtered.push(t);
                    continue;
                }
            }
        }

        if (isMatch) {
            removedCount++;
        } else {
            filtered.push(t);
        }
    }

    return { targets: filtered, removedCount };
}

/**
 * Link a VIP / Secondary IP to a Primary Server
 * Cascades across:
 * 1. Server Inventory (marks linkedTo, isVip, vipOf)
 * 2. IPAM (marks status=vip, assignedTo)
 * 3. CMDB (deletes standalone VIP from Server List cmdb_servers & server_cmdb_meta; updates primary host secondaryIps & vips)
 * 4. Prometheus Targets (removes VIP target completely)
 * 5. Scout Agent Monitors (deletes standalone monitor for VIP)
 */
async function linkVip(primaryIp, secondaryIp, username = 'SYSTEM') {
    if (!primaryIp || !secondaryIp) {
        throw new Error('Missing primaryIp or secondaryIp');
    }

    const pri = String(primaryIp).trim();
    const sec = String(secondaryIp).trim();
    if (pri === sec) {
        throw new Error('Primary IP and Secondary VIP cannot be the same');
    }

    // 1. Update in Server Inventory (per-row store)
    let primaryHostname = '';
    try {
        const inventoryStore = require('../services/inventoryStore');
        const priItem = inventoryStore.getHost(pri);
        if (priItem && priItem.hostname) primaryHostname = priItem.hostname;
        inventoryStore.setVipLink(sec, pri);
    } catch (e) {
        if (e && e.code === 'INVENTORY_MIGRATION_PENDING') throw e;
        console.error('[vipLinkageHelper] Inventory sync error:', e.message);
    }

    // 2. Update in IPAM (mark status as VIP)
    try {
        // atomic read-modify-write through the IPAM store (written only when something changed)
        require('./ipamStore').mutateSubnets((subnets) => {
            subnets.forEach(sub => {
                if (Array.isArray(sub.ips)) {
                    sub.ips.forEach(rec => {
                        if (String(rec.address).trim() === sec) {
                            rec.status = 'vip';
                            rec.assignedTo = `VIP of ${pri}`;
                            if (!rec.service) rec.service = 'VIP';
                            else if (!rec.service.includes('VIP')) rec.service = `${rec.service} (VIP)`;
                            rec.updatedAt = new Date().toISOString();
                        }
                    });
                }
            });
        }, { reason: 'VIP link' });
    } catch (e) {
        console.error('[vipLinkageHelper] IPAM sync error:', e.message);
    }

    // 3. Update in Server List CMDB Meta & cmdb_servers table
    try {
        // atomic read-modify-write of the CMDB meta (the worker writes it too); side effects run afterwards
        const { oldSecData, oldPriData, priMeta } = cmdbMetaStore.mutateMeta((cmdbMeta) => {
        const oldSecData = cmdbMeta[sec] ? { ...cmdbMeta[sec] } : {};
        const oldPriData = cmdbMeta[pri] ? { ...cmdbMeta[pri] } : {};

        // VIP / Secondary metadata
        if (!cmdbMeta[sec]) cmdbMeta[sec] = {};
        // Only claim ownership of the delete when it was not already deleted by someone else
        if (!cmdbMeta[sec].deleted) cmdbMeta[sec].deletedReason = 'vip_link';
        else if (!cmdbMeta[sec].deletedReason) cmdbMeta[sec].deletedReason = 'manual';
        const alreadyDeleted = cmdbMeta[sec].deleted === true;
        cmdbMeta[sec].deleted = true;
        if (!alreadyDeleted || !cmdbMeta[sec].deletedAt) cmdbMeta[sec].deletedAt = new Date().toISOString();
        if (!alreadyDeleted || !cmdbMeta[sec].deletedBy) cmdbMeta[sec].deletedBy = username;
        cmdbMeta[sec].isVip = true;
        cmdbMeta[sec].isSecondary = true;
        cmdbMeta[sec].linkedTo = pri;
        cmdbMeta[sec].vipOf = pri;
        cmdbMeta[sec].updatedAt = new Date().toISOString();

        // Primary metadata
        if (!cmdbMeta[pri]) cmdbMeta[pri] = {};
        if (!Array.isArray(cmdbMeta[pri].secondaryIps)) cmdbMeta[pri].secondaryIps = [];
        if (!cmdbMeta[pri].secondaryIps.includes(sec)) cmdbMeta[pri].secondaryIps.push(sec);

        if (!Array.isArray(cmdbMeta[pri].vips)) cmdbMeta[pri].vips = [];
        if (!cmdbMeta[pri].vips.includes(sec)) cmdbMeta[pri].vips.push(sec);
        cmdbMeta[pri].updatedAt = new Date().toISOString();
        return { oldSecData, oldPriData, priMeta: { ...cmdbMeta[pri] } };
        }, { reason: 'VIP link' });

        // Update materialized SQLite table: cmdb_servers
        if (db) {
            // A. Update primary host to register secondary VIP
            const priRow = getCmdbServerByIp(pri);
            if (priRow) {
                let secIps = Array.isArray(priRow.secondaryIps) ? [...priRow.secondaryIps] : [];
                if (!secIps.includes(sec)) secIps.push(sec);
                db.prepare('UPDATE cmdb_servers SET secondaryIps = ?, updatedAt = CURRENT_TIMESTAMP WHERE ip = ?')
                  .run(JSON.stringify(secIps), pri);
            } else {
                // If primary not yet in table, upsert with VIP linkage
                upsertCmdbServer({
                    ip: pri,
                    hostname: primaryHostname || priMeta.hostname || pri,
                    secondaryIps: [sec],
                    ...priMeta
                }, 'MANUAL');
            }

            // B. Delete VIP record from standalone server list (cmdb_servers)
            deleteCmdbServer(sec);
        }

        // Record CMDB History
        recordCmdbHistoryEntry(sec, username, 'LINK_VIP_DELETE', oldSecData, { deleted: true, isVip: true, linkedTo: pri });
        recordCmdbHistoryEntry(pri, username, 'LINK_VIP_PRIMARY', oldPriData, { secondaryIps: priMeta.secondaryIps });

        // Remove VIP monitor from scoutDb if exists
        try {
            const scoutDb = require('../services/scoutDb');
            if (scoutDb && typeof scoutDb.run === 'function') {
                scoutDb.run("DELETE FROM monitors WHERE ip = ?", [sec]);
            }
        } catch (err) {}
    } catch (e) {
        console.error('[vipLinkageHelper] CMDB sync error:', e.message);
    }

    // 4. Update in Prometheus Targets (remove VIP target)
    let removedFromPrometheus = false;
    try {
        const { result: removed } = await updateTargetsSafely((targets) => {
            const { targets: filteredTargets, removedCount } = removeIpFromPrometheusTargets(targets, sec);
            return (removedCount > 0 || filteredTargets.length < targets.length)
                ? { targets: filteredTargets, result: removedCount }
                : { result: 0 };
        }, 'inventory_link_vip');
        if (removed > 0) {
            removedFromPrometheus = true;
            queueNotification(`prometheus-linkage-vip\u0000${username}`, 'Prometheus', { vip: sec, primary: pri }, (items) => items.length === 1
                ? `🔗 [Prometheus Target Linkage]\nVIP IP removed from Prometheus Targets:\n• VIP: ${items[0].vip}\n• Primary Host: ${items[0].primary}\n• Operator: ${username}`
                : `🔗 [Prometheus Target Linkage - VIP 批量移除 (${items.length} 筆)]\nVIP IP removed from Prometheus Targets:\n${summarizeLines(items.map(i => `VIP ${i.vip} → Primary ${i.primary}`))}\n\n• Operator: ${username}`);
        }
    } catch (e) {
        console.error('[vipLinkageHelper] Prometheus sync error:', e.message);
    }

    // 5. Audit Log
    auditLog(username, 'Inventory', `Linked VIP ${sec} to Primary IP ${pri} (Marked VIP in IPAM, Deleted from Server List & Prometheus Targets)`);

    return {
        success: true,
        primaryIp: pri,
        secondaryIp: sec,
        removedFromPrometheus,
        message: `Successfully linked ${sec} as VIP to primary host ${pri} across Server Inventory, IPAM, Server List (CMDB), and Prometheus Targets.`
    };
}

/**
 * Unlink a previously linked VIP / Secondary IP
 */
async function unlinkVip(targetIp, username = 'SYSTEM') {
    if (!targetIp) throw new Error('Missing IP address to unlink');
    const cleanIp = String(targetIp).trim();
    let primaryIp = null;

    // 1. Remove linkedTo in Server Inventory
    try {
        const prev = require('../services/inventoryStore').setVipLink(cleanIp, null);
        if (prev) primaryIp = prev;
    } catch (e) {
        if (e && e.code === 'INVENTORY_MIGRATION_PENDING') throw e;
        console.error('[vipLinkageHelper] Inventory unlink error:', e.message);
    }

    // 2. Revert in IPAM
    try {
        require('./ipamStore').mutateSubnets((subnets) => {
            subnets.forEach(sub => {
                if (Array.isArray(sub.ips)) {
                    sub.ips.forEach(rec => {
                        if (String(rec.address).trim() === cleanIp) {
                            if (rec.status === 'vip') rec.status = 'used';
                            if (rec.assignedTo && rec.assignedTo.startsWith('VIP of')) rec.assignedTo = '';
                            rec.updatedAt = new Date().toISOString();
                        }
                    });
                }
            });
        }, { reason: 'VIP unlink' });
    } catch (e) {}

    // 3. Revert in CMDB Meta & cmdb_servers
    try {
        // atomic read-modify-write of the CMDB meta (the worker writes it too); side effects run afterwards
        const inventoryPrimary = primaryIp;
        const unlinked = cmdbMetaStore.mutateMeta((cmdbMeta) => {
        let primaryIp = inventoryPrimary;
        const oldData = cmdbMeta[cleanIp] ? { ...cmdbMeta[cleanIp] } : {};

        if (!primaryIp && cmdbMeta[cleanIp]) {
            primaryIp = cmdbMeta[cleanIp].linkedTo || cmdbMeta[cleanIp].vipOf;
        }

        // Entries linked before deletedReason existed carry no reason but always have the link markers
        const m0 = cmdbMeta[cleanIp];
        const deletedByLink = !!(m0 && m0.deleted && (m0.deletedReason === 'vip_link' || (!m0.deletedReason && m0.isSecondary && (m0.linkedTo || m0.vipOf))));
        if (cmdbMeta[cleanIp]) {
            delete cmdbMeta[cleanIp].isVip;
            delete cmdbMeta[cleanIp].linkedTo;
            delete cmdbMeta[cleanIp].vipOf;
            delete cmdbMeta[cleanIp].isSecondary;
            // Restore only when this link itself set the delete; an unrelated delete stays
            if (deletedByLink) {
                cmdbMeta[cleanIp].deleted = false;
                delete cmdbMeta[cleanIp].deletedAt;
                delete cmdbMeta[cleanIp].deletedBy;
                delete cmdbMeta[cleanIp].deletedReason;
            }
            cmdbMeta[cleanIp].updatedAt = new Date().toISOString();
        }

        // Clean primary host's secondaryIps & vips list
        if (primaryIp && cmdbMeta[primaryIp]) {
            if (Array.isArray(cmdbMeta[primaryIp].secondaryIps)) {
                cmdbMeta[primaryIp].secondaryIps = cmdbMeta[primaryIp].secondaryIps.filter(ip => ip !== cleanIp);
            }
            if (Array.isArray(cmdbMeta[primaryIp].vips)) {
                cmdbMeta[primaryIp].vips = cmdbMeta[primaryIp].vips.filter(ip => ip !== cleanIp);
            }
            cmdbMeta[primaryIp].updatedAt = new Date().toISOString();
        }
        return { primaryIp, oldData, entry: cmdbMeta[cleanIp] ? { ...cmdbMeta[cleanIp] } : null };
        }, { reason: 'VIP unlink' });
        primaryIp = unlinked.primaryIp;
        const oldData = unlinked.oldData;
        const cmdbMeta = unlinked.entry ? { [cleanIp]: unlinked.entry } : {};

        // Update cmdb_servers table
        if (db) {
            // Update primary
            if (primaryIp) {
                const priRow = getCmdbServerByIp(primaryIp);
                if (priRow && Array.isArray(priRow.secondaryIps)) {
                    const filteredSec = priRow.secondaryIps.filter(ip => ip !== cleanIp);
                    db.prepare('UPDATE cmdb_servers SET secondaryIps = ?, updatedAt = CURRENT_TIMESTAMP WHERE ip = ?')
                      .run(JSON.stringify(filteredSec), primaryIp);
                }
            }

            // Restore unlinked server back into cmdb_servers table (never resurrect an unrelated delete)
            if (!(cmdbMeta[cleanIp] && cmdbMeta[cleanIp].deleted)) upsertCmdbServer({
                ip: cleanIp,
                isSecondary: 0,
                isVip: 0,
                linkedToIp: null,
                ...(cmdbMeta[cleanIp] || {})
            }, 'MANUAL');
        }

        recordCmdbHistoryEntry(cleanIp, username, 'UNLINK_VIP', oldData, { linkedTo: null, isVip: false });
    } catch (e) {
        console.error('[vipLinkageHelper] CMDB unlink error:', e.message);
    }

    auditLog(username, 'Inventory', `Unlinked VIP ${cleanIp}`);
    return {
        success: true,
        ip: cleanIp,
        message: `Unlinked ${cleanIp} successfully across Server Inventory, IPAM, and Server List (CMDB).`
    };
}

/**
 * Startup / Periodic Reconciler:
 * Scans all inventory records, IPAM, and server_cmdb_meta to ensure that any linked VIPs
 * are properly synchronized across CMDB (cmdb_servers + meta) and Prometheus Targets.
 */
async function reconcileAllLinkedVips() {
    try {
        if (!db) return;
        const linkedMap = {}; // secIp -> priIp

        // 1. Collect from Server Inventory
        try {
            require('../services/inventoryStore').listLinkedHosts().forEach(item => {
                const link = item.linkedTo || item.vipOf;
                if (link && item.ip) linkedMap[String(item.ip).trim()] = String(link).trim();
            });
        } catch (_) {}

        // 2. Collect from CMDB Meta
        const meta = readDataSync(CMDB_META_KEY, {});
        Object.entries(meta).forEach(([ip, m]) => {
            const link = m?.linkedTo || m?.vipOf;
            if (link && ip) {
                linkedMap[String(ip).trim()] = String(link).trim();
            }
        });

        const pairs = Object.entries(linkedMap);
        if (pairs.length === 0) return;

        console.log(`[vipLinkageHelper] Reconciling ${pairs.length} VIP linkages...`);
        // A + B: one atomic read-modify-write of the CMDB meta (the web writes it too)
        cmdbMetaStore.mutateMeta((cmdbMeta) => {
        for (const [sec, pri] of pairs) {
            // A. Ensure CMDB Meta primary has secondaryIps
            if (!cmdbMeta[pri]) cmdbMeta[pri] = {};
            if (!Array.isArray(cmdbMeta[pri].secondaryIps)) cmdbMeta[pri].secondaryIps = [];
            if (!cmdbMeta[pri].secondaryIps.includes(sec)) cmdbMeta[pri].secondaryIps.push(sec);

            if (!Array.isArray(cmdbMeta[pri].vips)) cmdbMeta[pri].vips = [];
            if (!cmdbMeta[pri].vips.includes(sec)) cmdbMeta[pri].vips.push(sec);

            // B. Ensure CMDB Meta secondary is marked deleted/VIP
            if (!cmdbMeta[sec]) cmdbMeta[sec] = {};
            if (!cmdbMeta[sec].deleted) cmdbMeta[sec].deletedReason = 'vip_link';
            else if (!cmdbMeta[sec].deletedReason && !cmdbMeta[sec].isSecondary) cmdbMeta[sec].deletedReason = 'manual';
            cmdbMeta[sec].deleted = true;
            cmdbMeta[sec].isVip = true;
            cmdbMeta[sec].isSecondary = true;
            cmdbMeta[sec].linkedTo = pri;
        }
        }, { reason: 'VIP reconcile' });

        for (const [sec, pri] of pairs) {
            // C. Ensure cmdb_servers table reflects primary & secondary
            const priRow = getCmdbServerByIp(pri);
            if (priRow) {
                let secIps = Array.isArray(priRow.secondaryIps) ? [...priRow.secondaryIps] : [];
                if (!secIps.includes(sec)) {
                    secIps.push(sec);
                    db.prepare('UPDATE cmdb_servers SET secondaryIps = ?, updatedAt = CURRENT_TIMESTAMP WHERE ip = ?')
                      .run(JSON.stringify(secIps), pri);
                }
            }
            deleteCmdbServer(sec);
        }

        // D + E. Remove linked VIPs and any other VIP target from Prometheus in ONE atomic read-modify-write.
        // The VIP set is computed once (after the meta above is saved), not per target.
        const vipSet = buildVipSet();
        const { result: removedTotal } = await updateTargetsSafely((current) => {
            let targets = current;
            let removed = 0;
            for (const [sec] of pairs) {
                const res = removeIpFromPrometheusTargets(targets, sec);
                if (res.removedCount > 0) { targets = res.targets; removed += res.removedCount; }
            }
            for (const t of [...targets]) {
                let targetIp = t.ip || t.labels?.addr || t.labels?.ip;
                if (!targetIp && Array.isArray(t.targets) && t.targets[0]) {
                    targetIp = String(t.targets[0]).replace(/^https?:\/\//, '').split(':')[0].trim();
                }
                if (targetIp && isIpVip(targetIp, [], { vipSet })) {
                    const res = removeIpFromPrometheusTargets(targets, targetIp);
                    if (res.removedCount > 0) {
                        targets = res.targets;
                        removed += res.removedCount;
                        console.log(`[vipLinkageHelper] Purged VIP target ${targetIp} from Prometheus during reconciliation.`);
                    }
                }
            }
            return removed > 0 ? { targets, result: removed } : { result: 0 };
        }, 'vip_reconciliation');
        if (removedTotal > 0) {
            console.log('[vipLinkageHelper] Removed stale VIP targets from Prometheus during reconciliation.');
        }
    } catch (e) {
        console.error('[vipLinkageHelper] Reconcile error:', e.message);
    }
}

/**
 * Every IP known as a VIP / secondary address, computed with ONE pass over CMDB meta, cmdb_servers, IPAM and the
 * inventory store (the same four sources isIpVip consults). Scans build it once and pass it down instead of
 * letting isIpVip re-parse the same documents for every host.
 */
function buildVipSet() {
    const set = new Set();
    const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s) set.add(s); };
    try {
        const cmdbMeta = readDataSync(CMDB_META_KEY, {}) || {};
        for (const [ip, m] of Object.entries(cmdbMeta)) {
            if (m && (m.isVip || m.isSecondary || m.linkedTo || m.vipOf)) add(ip);
            for (const list of [m && m.secondaryIps, m && m.vips]) {
                if (Array.isArray(list)) list.forEach(add);
            }
        }
    } catch (_) {}
    try {
        if (db) {
            for (const row of db.prepare('SELECT ip, isVip, isSecondary, linkedToIp, secondaryIps FROM cmdb_servers WHERE isVip = 1 OR isSecondary = 1 OR linkedToIp IS NOT NULL OR (secondaryIps IS NOT NULL AND secondaryIps != \'\' AND secondaryIps != \'[]\')').all()) {
                if (row.isVip === 1 || row.isSecondary === 1 || row.linkedToIp) add(row.ip);
                if (row.secondaryIps) {
                    try { const l = JSON.parse(row.secondaryIps); if (Array.isArray(l)) l.forEach(add); } catch (_) {}
                }
            }
        }
    } catch (_) {}
    try {
        const subnets = readDataSync(IPAM_KEY, []);
        for (const sub of subnets) {
            if (!Array.isArray(sub.ips)) continue;
            for (const rec of sub.ips) {
                if (rec.status === 'vip'
                    || (typeof rec.service === 'string' && rec.service.toLowerCase().includes('vip'))
                    || (typeof rec.assignedTo === 'string' && rec.assignedTo.toLowerCase().includes('vip'))) add(rec.address);
            }
        }
    } catch (_) {}
    try {
        require('../services/inventoryStore').listLinkedHosts().forEach(h => add(h.ip));
    } catch (_) {}
    return set;
}

/**
 * Checks whether a given IP is designated or known as a VIP / Secondary IP
 * across CMDB Meta, CMDB Servers Table, IPAM, Inventory records, or a candidate list.
 * options.vipSet (from buildVipSet) answers from memory instead of re-reading every source.
 */
function isIpVip(ip, candidateList = [], options = {}) {
    if (!ip) return false;
    const cleanIp = String(ip).trim();
    if (!cleanIp) return false;

    // 0. Check optional candidate / in-memory list
    if (Array.isArray(candidateList) && candidateList.length > 0) {
        const item = candidateList.find(it => it && String(it.ip).trim() === cleanIp);
        if (item && (item.isVip || item.linkedTo || item.vipOf)) {
            return true;
        }
    }
    if (options && options.vipSet instanceof Set) return options.vipSet.has(cleanIp);

    try {
        // 1. Check CMDB Meta
        const cmdbMeta = readDataSync(CMDB_META_KEY, {});
        const meta = cmdbMeta[cleanIp];
        if (meta && (meta.isVip || meta.isSecondary || meta.linkedTo || meta.vipOf)) {
            return true;
        }
        // Check if cleanIp is in any host's secondaryIps or vips
        for (const [priIp, priMeta] of Object.entries(cmdbMeta)) {
            if (priIp === cleanIp) continue;
            if (Array.isArray(priMeta?.secondaryIps) && priMeta.secondaryIps.map(s => String(s).trim()).includes(cleanIp)) {
                return true;
            }
            if (Array.isArray(priMeta?.vips) && priMeta.vips.map(s => String(s).trim()).includes(cleanIp)) {
                return true;
            }
        }
    } catch (_) {}

    try {
        // 2. Check cmdb_servers table if SQLite db is available
        if (db) {
            const row = db.prepare('SELECT ip, isVip, isSecondary, linkedToIp FROM cmdb_servers WHERE ip = ?').get(cleanIp);
            if (row && (row.isVip === 1 || row.isSecondary === 1 || row.linkedToIp)) {
                return true;
            }
            const secRows = db.prepare('SELECT ip, secondaryIps FROM cmdb_servers WHERE secondaryIps LIKE ?').all(`%"${cleanIp}"%`);
            if (secRows && secRows.length > 0) {
                return true;
            }
        }
    } catch (_) {}

    try {
        // 3. Check IPAM
        const subnets = readDataSync(IPAM_KEY, []);
        for (const sub of subnets) {
            if (Array.isArray(sub.ips)) {
                const rec = sub.ips.find(r => String(r.address).trim() === cleanIp);
                if (rec) {
                    if (rec.status === 'vip') return true;
                    if (rec.service && typeof rec.service === 'string' && rec.service.toLowerCase().includes('vip')) return true;
                    if (rec.assignedTo && typeof rec.assignedTo === 'string' && rec.assignedTo.toLowerCase().includes('vip')) return true;
                }
            }
        }
    } catch (_) {}

    try {
        // 4. Check the inventory store
        const item = require('../services/inventoryStore').getHost(cleanIp);
        if (item && (item.isVip || item.linkedTo || item.vipOf)) {
            return true;
        }
    } catch (_) {}

    return false;
}

module.exports = {
    isIpVip,
    buildVipSet,
    linkVip,
    unlinkVip,
    reconcileAllLinkedVips,
    removeIpFromPrometheusTargets
};
