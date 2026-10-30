const express = require('express');
const router = express.Router();
const { requireAuth, checkRole } = require('../middleware/auth');
const { readEnv, writeEnv } = require('../lib/envEditor');
const { auditLog } = require('../lib/logger');
const { validateProvisionSettings } = require('../lib/provisioning');
const { validateMasterListText, decodeMasterList } = require('../lib/provisioningConfig');

// Settings the Telegram listener captures when it starts: TELEGRAM_* (token, chat id, enable flag, poll interval),
// PROXY_* (PROXY_ENABLED_MODULES) and the proxy URL itself
const LISTENER_ENV_KEY = /^(TELEGRAM_|PROXY_|SYSTEM_PROXY$|HTTPS?_PROXY$)/i;

// Secure: Only SuperAdmins can view/edit system .env variables
router.use(requireAuth);
router.use(checkRole(['SuperAdmin']));

// GET /api/settings - Read current .env configuration variables
router.get('/', (req, res) => {
    try {
        const config = readEnv();
        // Software master lists are stored with a two-backslash separator: hand the textarea one entry per line.
        // Only these two keys change; the save route encodes real newlines exactly as before.
        if (config.REMOTE_INSTALL_SOFTWARE_MASTER) config.REMOTE_INSTALL_SOFTWARE_MASTER = decodeMasterList(config.REMOTE_INSTALL_SOFTWARE_MASTER, 'windows');
        if (config.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER) config.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER = decodeMasterList(config.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER, 'linux');
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings/save - Save updated configuration settings
router.post('/save', (req, res) => {
    try {
        const rawConfig = req.body || {};
        const prunedConfig = {};

        // Server Provision: range-check the PROVISION_* numbers and the detect rules of the master lists before anything is written.
        // Only fields this request actually changes are validated, so an old out-of-range stored value never blocks saving other settings.
        const stored = readEnv();
        const changedValue = (key) => {
            if (rawConfig[key] === undefined || rawConfig[key] === null) return false;
            const v = Array.isArray(rawConfig[key]) ? rawConfig[key].join(',') : rawConfig[key];
            const asStored = typeof v === 'string' ? v.replace(/\r?\n/g, '\\\\n') : v;
            return String(asStored) !== String(stored[key] === undefined ? '' : stored[key]);
        };
        const provisionKeys = ['PROVISION_HOST_CONCURRENCY', 'PROVISION_HISTORY_RETENTION_DAYS', 'PROVISION_MIN_FREE_GB'];
        const provisionErrors = [
            ...validateProvisionSettings(Object.fromEntries(provisionKeys.filter(changedValue).map(k => [k, rawConfig[k]]))),
            ...(changedValue('REMOTE_INSTALL_SOFTWARE_MASTER') ? validateMasterListText(rawConfig.REMOTE_INSTALL_SOFTWARE_MASTER, 'windows').map(e => `REMOTE_INSTALL_SOFTWARE_MASTER ${e}`) : []),
            ...(changedValue('REMOTE_INSTALL_LINUX_SOFTWARE_MASTER') ? validateMasterListText(rawConfig.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER, 'linux').map(e => `REMOTE_INSTALL_LINUX_SOFTWARE_MASTER ${e}`) : [])
        ];
        if (provisionErrors.length) return res.status(400).json({ error: provisionErrors.join('; ') });

        Object.keys(rawConfig).forEach(key => {
            let value = rawConfig[key];

            // Join arrays (e.g. from multi-select options)
            if (Array.isArray(value)) value = value.join(',');

            // Escape newlines for env file compatibility
            if (typeof value === 'string') {
                value = value.replace(/\r?\n/g, '\\\\n');
            }

            // Skip specific empty ELK LS fields
            if ((key.startsWith('LS_') && key.endsWith('_NODES')) ||
                (key.startsWith('SYSNAS_LS_') && key.endsWith('_PATH'))) {
                if (!value || value.trim() === '') return;
            }

            // Exclude username/password form noise
            if (key === 'username' || key === 'password') return;

            prunedConfig[key] = value;
        });

        // PC/PE Exclusivity clearing
        if (prunedConfig.NUTANIX_MODE === 'PC') {
            prunedConfig.NUTANIX_PE_IP = '';
            prunedConfig.NUTANIX_PE_ACCOUNT = '';
            prunedConfig.NUTANIX_PE_PWD = '';
        } else if (prunedConfig.NUTANIX_MODE === 'PE') {
            prunedConfig.NUTANIX_PC_IP = '';
            prunedConfig.NUTANIX_PC_ACCOUNT = '';
            prunedConfig.NUTANIX_PC_PWD = '';
        }

        const dynamicPrefixes = [
            'FORTI_HOST_', 'FORTI_TOKEN_', 'FORTI_SSH_',
            'SQUID_SERVERS_', 'SQUID_',
            'MAIL_SERVERS_', 'MAIL_',
            'ELK_', 'LS_', 'SYSNAS_LS_',
            'AD_BUS_', 'AD_OU_',
            'REMOTE_INSTALL_',
            'AD_ADMIN_', 'LINUX_ADMIN_',
            'NETSEARCH_', 'SFTP_'
        ];

        // Also dynamically support ${env}_LIFECYCLE_ for any configured ELK environment
        Object.keys(prunedConfig).forEach(k => {
            if (k.includes('_LIFECYCLE_SHORT') || k.includes('_LIFECYCLE_MEDIUM') || k.includes('_LIFECYCLE_LONG')) {
                const prefix = k.replace(/LIFECYCLE_(SHORT|MEDIUM|LONG)$/, '');
                if (prefix && !dynamicPrefixes.includes(prefix)) {
                    dynamicPrefixes.push(prefix);
                }
            }
        });

        writeEnv(prunedConfig, dynamicPrefixes);

        if (typeof global.reloadEnv === 'function') {
            global.reloadEnv();
        }
        // The background worker has its own process.env: have it re-read .env (backup settings, schedulers, ...)
        if (typeof global.sendWorkerMessage === 'function') {
            try { global.sendWorkerMessage({ type: 'RELOAD_ENV' }); } catch (e) {}
        }

        // The Telegram long-poll listener lives in the worker only (two pollers on one bot token = 409 Conflict).
        // Sent after RELOAD_ENV (IPC keeps order) so the worker restarts it with the new token.
        // Only when a setting the listener captures at start changed (token / chat / enable flag / poll interval / proxy);
        // everything else it reads per message from process.env, which RELOAD_ENV already refreshed.
        const touchesListener = Object.keys(rawConfig || {}).some(k => LISTENER_ENV_KEY.test(k));
        let telegramReload = false;
        if (touchesListener && typeof global.sendWorkerMessage === 'function') {
            try { telegramReload = global.sendWorkerMessage({ type: 'RELOAD_TELEGRAM_LISTENER' }); } catch (e) {}
        }
        if (touchesListener && !telegramReload) {
            console.log('[Settings] No embedded worker reachable: the Telegram listener is owned by the worker process and is not restarted from here.');
        }

        auditLog(req.user.username, 'Settings Manager', 'System configurations updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const WORKER_UNAVAILABLE = 'Background worker unavailable, please retry in a few seconds.';

// POST /api/settings/backup-now - Full manual backup (ignores DB_BACKUP_ENABLED); progress is reported via /backup-status
router.post('/backup-now', async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const current = await backupService.readLastResult();
        if (backupService.isStatusRunning(current)) {
            return res.status(409).json({ error: 'A backup is already running.' });
        }

        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = new Date().toISOString();
        const requestedBy = req.user.username;
        await backupService.writeLastResult({ requestId, requestedBy, startedAt, finishedAt: null, items: [], dir: null });

        if (process.env.ENABLE_EMBEDDED_WORKER === 'false') {
            // No embedded worker by configuration: run in this process, not awaited
            backupService.runManualBackup(requestedBy, requestId)
                .catch(err => console.error('[Settings] Manual backup failed:', err.message));
        } else {
            const handedToWorker = typeof global.sendWorkerMessage === 'function'
                && global.sendWorkerMessage({ type: 'RUN_BACKUP_NOW', requestId, requestedBy });
            if (!handedToWorker) {
                // Worker is restarting or down: do not run in the web process (it would race the worker's scheduler)
                const finishedAt = new Date().toISOString();
                await backupService.writeLastResult({ requestId, requestedBy, startedAt, finishedAt, items: [], dir: null, error: WORKER_UNAVAILABLE });
                return res.status(503).json({ error: WORKER_UNAVAILABLE });
            }
        }

        auditLog(requestedBy, 'Database Backup', 'Manual backup requested');
        res.status(202).json({ requestId, startedAt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/settings/backup-status - Last (or running) backup result
router.get('/backup-status', async (req, res) => {
    try {
        res.json(await require('../services/backupService').readLastResult());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
