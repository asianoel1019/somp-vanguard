const express = require('express');
const router = express.Router();
const net = require('net');
const { auditLog, auditLogBatched } = require('../lib/logger');
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');


const {
    getTargetsSafely,
    saveTargetsSafely,
    updateTargetsSafely,
    getBackupsList,
    restoreBackup,
    compareIPs
} = require('../lib/prometheusTargetHelper');

const {
    getHealthCheckConfig,
    updateHealthCheckConfig,
    runPrometheusHealthScan
} = require('../services/prometheusScheduler');

const envRegistry = require('../lib/environmentRegistry');
const { unknownPromValues } = require('../services/environmentMigration');

const ENV_LABELS = ['zone', 'env', 'environment'];
const isUnset = (v) => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '-';

/**
 * Validates the environment labels of one target against the global Environments list (Prometheus keeps
 * NAMES, labels must stay strings): zone (required when requireZone) and env / environment when set are
 * resolved case-insensitively (name, id or code) and replaced by the canonical name.
 * Returns { labels } (normalised copy) or { error }.
 */
function normalizeEnvLabels(labels, envs, { requireZone = true } = {}) {
    const out = { ...labels };
    const allowed = envRegistry.allowedNames(envs).join(', ');
    for (const k of ENV_LABELS) {
        if (isUnset(out[k])) {
            if (k === 'zone' && requireZone) return { error: `Environment (zone) is required. Allowed: ${allowed}` };
            continue;
        }
        const env = envRegistry.resolveEnv(out[k], envs);
        if (!env) return { error: `Unknown environment "${String(out[k]).trim()}" in label ${k}. Allowed: ${allowed}` };
        out[k] = env.name;
    }
    return { labels: out };
}

// Helper to read targets safely with circuit breaker
function getTargets() {
    return getTargetsSafely();
}

// Helper to write targets safely with mutex, atomic replacement, and rolling backup
async function saveTargets(data, source = 'prometheus_ui') {
    return await saveTargetsSafely(data, source);
}

// Simple fast TCP port probe for OS Detection
// Assumes 1000ms is enough on an intranet.
function checkPort(host, port, timeout = 1000) {
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

// 1. Endpoint for Prometheus Server (The actual Service Discovery)
router.get('/targets', (req, res) => {
    const authHeader = req.headers['authorization'];
    const expectedToken = process.env.PROMETHEUS_SD_TOKEN;

    if (!expectedToken) {
        // If token is not set in backend, fail safe to deny access
        return res.status(401).send('PROMETHEUS_SD_TOKEN is not configured on server.');
    }

    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
        return res.status(401).send('Unauthorized or invalid token.');
    }

    const targets = getTargets();
    // Filter out paused targets and strip custom fields so Prometheus doesn't crash on unknown fields
    const activeTargets = targets
        .filter(t => !t.isPaused)
        .map(t => ({ targets: t.targets, labels: t.labels }));
    res.json(activeTargets);
});

// Every endpoint below is used only by the Prometheus Target screen (PrometheusSD.jsx).
// /targets above stays token-based for the Prometheus server (no user session, no RBAC).
router.use(requireAuth, checkFeature('prometheus'));
// Writes (targets, backups restore, health-check config / run) are Operator+; reads stay open to Viewers.
const promWriter = checkRole(['SuperAdmin', 'Operator']);

// 2. Endpoint for Frontend UI List
router.get('/list', requireAuth, (req, res) => {
    const envs = envRegistry.getEnvironments();
    // envWarning (display only, never stored): label values that are not a name in Settings -> Environments
    const targets = getTargets().map(t => {
        const unknown = unknownPromValues(t, envs);
        return unknown.length > 0 ? { ...t, envWarning: unknown } : t;
    });
    res.json({
        targets,
        environments: envs.map(e => ({ id: e.id, name: e.name, isProduction: !!e.isProduction, isDefault: !!e.isDefault })),
        token: process.env.PROMETHEUS_SD_TOKEN || '',
        healthCheckConfig: getHealthCheckConfig()
    });
});

// 2.5. Endpoint for Pausing/Resuming a single target
router.put('/pause', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot modify target state.' });
        }
        const { ip, isPaused } = req.body;
        const user = req.user ? req.user.username : 'Unknown';
        if (!ip) return res.status(400).json({ error: 'IP is required' });

        const { result: found } = await updateTargetsSafely((targets) => {
            const targetIdx = targets.findIndex(t => t.labels && t.labels.addr === ip);
            if (targetIdx === -1) return { result: false };
            targets[targetIdx].isPaused = !!isPaused;
            return { targets, result: true };
        }, isPaused ? 'pause_target' : 'resume_target');
        if (!found) {
            return res.status(404).json({ error: 'Target IP not found' });
        }
        auditLogBatched(user, 'Prometheus Target', `${isPaused ? 'Paused' : 'Resumed'} target IP: ${ip}`);
        res.json({ success: true, message: `Target ${ip} is now ${isPaused ? 'paused' : 'active'}` });
    } catch (e) {
        console.error('[Prometheus pause error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 2.6 Endpoint for Bulk Pausing/Resuming targets
router.post('/bulk-pause', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot modify target states.' });
        }
        const { ips, isPaused } = req.body;
        if (!ips || !Array.isArray(ips) || ips.length === 0) {
            return res.status(400).json({ error: 'Invalid or empty ips array' });
        }
        const user = req.user ? req.user.username : 'Unknown';
        const ipSet = new Set(ips);
        const { result: modifiedCount } = await updateTargetsSafely((targets) => {
            let n = 0;
            targets.forEach(t => {
                if (t.labels && ipSet.has(t.labels.addr)) {
                    t.isPaused = !!isPaused;
                    n++;
                }
            });
            return n > 0 ? { targets, result: n } : { result: 0 };
        }, isPaused ? 'bulk_pause' : 'bulk_resume');

        if (modifiedCount > 0) {
            auditLogBatched(user, 'Prometheus Target', `${isPaused ? 'Bulk paused' : 'Bulk enabled'} ${modifiedCount} targets`);
        }
        res.json({ success: true, count: modifiedCount, isPaused: !!isPaused });
    } catch (e) {
        console.error('[Prometheus bulk-pause error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 3. Endpoint for parsing pasted TSV
router.post('/parse', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot add or update targets.' });
        }
        const { pastedText } = req.body;
        if (!pastedText) return res.status(400).json({ error: 'No data provided' });

        const envs = envRegistry.getEnvironments();
        const allowed = envRegistry.allowedNames(envs);
        const lines = String(pastedText).split('\n');
        const rows = [];         // validated rows, applied under the lock
        const lineErrors = [];   // { line, ip, error }: reject the import
        const skippedLines = []; // { line, text, reason }: reported, not imported (not an IP, duplicate)
        const seenAt = new Map();

        lines.forEach((line, i) => {
            const trimmed = line.trim();
            if (!trimmed || /^["']?ip["']?\b/i.test(trimmed)) return; // Skip blank lines and the CSV/TSV header

            let parts = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(',');
            parts = parts.map(p => p.replace(/^["']|["']$/g, '').trim());

            const ip = parts[0];
            if (!ip || !net.isIP(ip)) { skippedLines.push({ line: i + 1, text: trimmed.slice(0, 80), reason: 'first column is not an IP address' }); return; }
            if (seenAt.has(ip)) { skippedLines.push({ line: i + 1, text: ip, reason: `duplicate of line ${seenAt.get(ip)}` }); return; }
            seenAt.set(ip, i + 1);

            // Environment (zone) column: must be in Settings -> Environments (canonical name stored).
            // Empty keeps the current zone of an existing target (checked under the lock); a new target needs one.
            const zoneRaw = isUnset(parts[2]) ? '' : parts[2];
            let zone = '';
            if (zoneRaw) {
                const env = envRegistry.resolveEnv(zoneRaw, envs);
                if (!env) { lineErrors.push({ line: i + 1, ip, error: `Unknown environment "${zoneRaw}"` }); return; }
                zone = env.name;
            }
            rows.push({ line: i + 1, ip, hostname: parts[1] || '', zone, application: parts[3] || '', bu: parts[4] || '' });
        });

        // Early report (snapshot) of new targets without a zone; re-checked under the lock below
        const snapshotIps = new Set(getTargets().map(t => t.labels && t.labels.addr));
        for (const r of rows) {
            if (!r.zone && !snapshotIps.has(r.ip)) lineErrors.push({ line: r.line, ip: r.ip, error: 'Environment (zone) is required for a new target' });
        }
        lineErrors.sort((a, b) => a.line - b.line);

        const reject = (errs) => res.status(400).json({
            error: `Import rejected: ${errs.length} line(s) with an invalid environment (${errs.slice(0, 10).map(e => `line ${e.line}: ${e.error}`).join('; ')}). Allowed: ${allowed.join(', ')}`,
            lineErrors: errs,
            skippedLines,
            allowed
        });
        if (lineErrors.length > 0) return reject(lineErrors);

        // Port probing (network) happens before the lock; the snapshot is only a hint for which rows may be new
        const newValidLines = rows.filter(r => r.zone && !snapshotIps.has(r.ip));
        const parsedTargets = await Promise.all(newValidLines.map(async (v) => {
            let finalPort = 9100;
            let isWindows = await checkPort(v.ip, 9182);
            if (isWindows) {
                finalPort = 9182;
            } else {
                let isLinux = await checkPort(v.ip, 9100);
                if (isLinux) finalPort = 9100;
            }
            return {
                targets: [`${v.ip}:${finalPort}`],
                labels: {
                    zone: v.zone || '-',
                    host: v.hostname || '-',
                    application: v.application || '-',
                    addr: v.ip,
                    group: v.bu || '-'
                }
            };
        }));

        // Atomic read-modify-write: re-read the targets under the shared lock (no lost concurrent edits)
        const probed = new Map(parsedTargets.map(p => [p.labels.addr, p]));
        const { result } = await updateTargetsSafely((targets) => {
            // which IPs exist is decided HERE, on the targets read under the lock
            const idxByIp = new Map(targets.map((t, idx) => [t.labels && t.labels.addr, idx]));
            const lockErrors = rows
                .filter(r => !r.zone && !idxByIp.has(r.ip))
                .map(r => ({ line: r.line, ip: r.ip, error: 'Environment (zone) is required for a new target' }));
            if (lockErrors.length > 0) return { result: { lockErrors } }; // nothing written
            let updatedCount = 0;
            let addedCount = 0;
            for (const r of rows) {
                if (idxByIp.has(r.ip)) {
                    const t = targets[idxByIp.get(r.ip)];
                    t.labels = t.labels || {};
                    if (r.hostname) t.labels.host = r.hostname;
                    if (r.zone) t.labels.zone = r.zone;
                    if (r.application) t.labels.application = r.application;
                    if (r.bu) t.labels.group = r.bu;
                    // existing env / environment labels are canonicalised like /update (unknown ones kept)
                    for (const k of ['env', 'environment']) {
                        if (isUnset(t.labels[k])) continue;
                        const env = envRegistry.resolveEnv(t.labels[k], envs);
                        if (env) t.labels[k] = env.name;
                    }
                    updatedCount++;
                } else {
                    const p = probed.get(r.ip) || {
                        targets: [`${r.ip}:9100`],
                        labels: { zone: r.zone, host: r.hostname || '-', application: r.application || '-', addr: r.ip, group: r.bu || '-' }
                    };
                    targets.push(p);
                    idxByIp.set(r.ip, targets.length - 1);
                    addedCount++;
                }
            }
            const out = { addedCount, updatedCount };
            return (addedCount + updatedCount) > 0 ? { targets, result: out } : { result: out };
        }, 'excel_tsv_parse');
        if (result && result.lockErrors) return reject(result.lockErrors);
        const { addedCount, updatedCount } = result || { addedCount: 0, updatedCount: 0 };

        if (updatedCount > 0 || addedCount > 0) {
            const user = req.user ? req.user.username : 'System';
            auditLogBatched(user, 'Prometheus Target', `Added ${addedCount} and updated ${updatedCount} targets via TSV/Excel parse`);
        }

        res.json({
            addedCount,
            updatedCount,
            totalProcessed: addedCount + updatedCount,
            skippedLines
        });
    } catch (e) {
        console.error('[Prometheus parse error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 4. Delete single target
router.delete('/target/:ip', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot delete targets.' });
        }
        const ip = req.params.ip;
        const { result: removed } = await updateTargetsSafely((targets) => {
            const filtered = targets.filter(t => !(t.labels && t.labels.addr === ip));
            return filtered.length !== targets.length ? { targets: filtered, result: targets.length - filtered.length } : { result: 0 };
        }, 'delete_target');

        if (removed > 0) {
            const user = req.user ? req.user.username : 'System';
            auditLogBatched(user, 'Prometheus Target', `Deleted target IP: ${ip}`);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'IP not found' });
        }
    } catch (e) {
        console.error('[Prometheus delete error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Bulk Delete targets
router.post('/bulk-delete', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot delete targets.' });
        }
        const { ips } = req.body;
        if (!ips || !Array.isArray(ips)) return res.status(400).json({ error: 'Invalid payload' });

        const { result: deletedCount } = await updateTargetsSafely((targets) => {
            const filtered = targets.filter(t => !(t.labels && ips.includes(t.labels.addr)));
            return filtered.length !== targets.length ? { targets: filtered, result: targets.length - filtered.length } : { result: 0 };
        }, 'bulk_delete');

        if (deletedCount > 0) {
            const user = req.user ? req.user.username : 'System';
            auditLogBatched(user, 'Prometheus Target', `Bulk deleted ${deletedCount} targets`);
            res.json({ success: true, deletedCount });
        } else {
            res.status(404).json({ error: 'No IPs found to delete' });
        }
    } catch (e) {
        console.error('[Prometheus bulk-delete error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 6. Update single target
router.put('/update', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot update targets.' });
        }
        const { originalIp, newIp, hostname, zone, application, bu, port } = req.body;
        if (!originalIp || !newIp || !port) return res.status(400).json({ error: 'Missing required fields' });

        // zone must be an environment of the global list (canonical name stored)
        const envs = envRegistry.getEnvironments();
        const checked = normalizeEnvLabels({ zone }, envs, { requireZone: true });
        if (checked.error) return res.status(400).json({ error: checked.error, allowed: envRegistry.allowedNames(envs) });

        const { result } = await updateTargetsSafely((targets) => {
            const targetIndex = targets.findIndex(t => t.labels && t.labels.addr === originalIp);
            if (targetIndex === -1) return { result: { status: 404, error: 'Original target not found' } };
            // Check conflict if IP was changed
            if (originalIp !== newIp && targets.some(t => t.labels && t.labels.addr === newIp)) {
                return { result: { status: 409, error: 'New IP already exists in another target' } };
            }
            const prev = targets[targetIndex];
            // env / environment labels (if the target has them) are validated too; unknown ones are left as they are
            const extra = {};
            for (const k of ['env', 'environment']) {
                if (prev.labels && !isUnset(prev.labels[k])) {
                    const env = envRegistry.resolveEnv(prev.labels[k], envs);
                    extra[k] = env ? env.name : prev.labels[k];
                }
            }
            // Update target inline preserving isPaused if present
            targets[targetIndex] = {
                targets: [`${newIp}:${port}`],
                labels: {
                    zone: checked.labels.zone,
                    host: hostname || '-',
                    application: application || '-',
                    addr: newIp,
                    group: bu || '-',
                    ...extra
                },
                ...(prev.isPaused !== undefined ? { isPaused: prev.isPaused } : {})
            };
            return { targets, result: { status: 200 } };
        }, 'update_target');
        if (result && result.status !== 200) return res.status(result.status).json({ error: result.error });
        const user = req.user ? req.user.username : 'System';
        auditLogBatched(user, 'Prometheus Target', `Updated target IP: ${newIp}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Prometheus update error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 7. Get List of Historical Backups
router.get('/backups', requireAuth, (req, res) => {
    try {
        const backups = getBackupsList();
        res.json(backups);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. Restore from Specific Backup
router.post('/restore', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot restore backups.' });
        }
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'Filename is required' });
        const user = req.user ? req.user.username : 'System';
        const result = await restoreBackup(filename, user);
        auditLogBatched(user, 'Prometheus Target', `Restored ${result.restoredCount} targets from backup: ${filename}`);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. Get Health Check Configuration
router.get('/health-check-config', requireAuth, (req, res) => {
    try {
        res.json(getHealthCheckConfig());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10. Update Health Check Configuration
router.post('/health-check-config', requireAuth, promWriter, (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot modify configuration.' });
        }
        const user = req.user ? req.user.username : 'System';
        const updated = updateHealthCheckConfig(req.body);
        auditLog(user, 'Prometheus Config', `Updated health check config: enabled=${updated.enabled}, interval=${updated.intervalMinutes}m`);
        res.json({ success: true, config: updated });
    } catch (e) {
        console.error('[Prometheus health-check-config error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 11. Run Health Check On-Demand
router.post('/health-check-run', requireAuth, promWriter, async (req, res) => {
    try {
        if (req.user && req.user.role === 'Viewer') {
            return res.status(403).json({ error: 'Permission denied: Viewers cannot run health checks.' });
        }
        const user = req.user ? req.user.username : 'System';
        auditLog(user, 'Prometheus Config', 'Triggered manual on-demand health scan');
        const result = await runPrometheusHealthScan();
        res.json({ success: true, result });
    } catch (e) {
        console.error('[Prometheus health-check-run error]', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
