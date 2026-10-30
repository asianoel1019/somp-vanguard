const express = require('express');
const router = express.Router();
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');
const { detectOs } = require('../lib/osDetect');
const { auditLog } = require('../lib/logger');
const { performServerCheck } = require('../services/serverCheckService');
const remoteCommand = require('../services/remoteCommandService');


router.use(requireAuth);

// POST /api/ops/check
// Feature: Server Check screen (ServerCheck.jsx) is the only caller
router.post('/check', checkFeature('serverCheck'), async (req, res) => {
    const { ips, linuxPassword } = req.body;
    const ipList = ips.filter(ip => ip.trim() !== '');
    
    // Set headers for streaming NDJSON
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const CONCURRENCY_LIMIT = 10;
    const queue = [...ipList];
    
    const runWorker = async () => {
        while (queue.length > 0) {
            const ip = queue.shift();
            if (!ip) continue;
            const result = await performServerCheck(ip, linuxPassword, {
                username: req.user.username,
                domain: req.user.domain,
                password: req.user.password
            });
            
            res.write(JSON.stringify(result) + '\n');
        }
    };
    
    // Launch parallel workers
    const workers = [];
    const actualLimit = Math.min(CONCURRENCY_LIMIT, ipList.length);
    for (let i = 0; i < actualLimit; i++) {
        workers.push(runWorker());
    }
    
    await Promise.all(workers);
    
    if (ipList.length > 0) {
        auditLog(req.user.username, 'Server Check', `Checked ${ipList.length} IPs: ${ipList.join(', ')}`);
    }

    res.end();
});

// POST /api/ops/command
// Feature: Remote Command screen (RemoteCommand.jsx) is the only caller
// Executes commands on remote hosts: Operator / SuperAdmin only (the UI already hides it from Viewers).
// /check above is read-only and stays open to Viewers.
// Windows: the signed-in AD user's credential when a Windows password is typed, falling back to the Settings service
// account (AD_ADMIN_*) only when that session cannot be opened. Linux: LINUX_ADMIN_USER with the typed password.
router.post('/command', checkFeature('remoteCmd'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const parsed = remoteCommand.validateCommandRequest(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { targets, winCommand, nixCommand, linuxPassword, winPassword } = parsed;
    const username = req.user.username;

    if (remoteCommand.isCommandDangerous(winCommand) || remoteCommand.isCommandDangerous(nixCommand)) {
        auditLog(username, 'Security', `Blocked dangerous command attempt on ${targets.length} target(s): ${targets.join(', ')}. Win: [${winCommand}], Nix: [${nixCommand}]`);
        return res.status(400).json({ error: 'Command blocked by security policy (dangerous pattern detected).' });
    }

    const winCreds = remoteCommand.resolveWindowsCredentials(req.user, winPassword);
    auditLog(username, 'Remote Command', `Started on ${targets.length} target(s): ${targets.join(', ')} | Win: [${winCommand || 'N/A'}] | Lin: [${nixCommand || 'N/A'}] | Windows credential: ${winCreds.userCred ? `${winCreds.userCred.name} (service account fallback)` : 'service account'}`);

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // The browser closed the stream (Stop button / page left): hand out no further targets
    let cancelled = false;
    res.on('close', () => { if (!res.writableEnded) cancelled = true; });

    const counts = { ok: 0, failed: 0, skipped: 0, offline: 0, notRun: 0 };
    const runOne = async (ip) => {
        const detection = await detectOs(ip);
        if (detection.status === 'offline') return { ip, status: 'Offline', os: 'N/A', output: 'Ping failed' };
        if (detection.os === 'Linux') {
            if (!nixCommand.trim()) return { ip, status: 'Skipped', os: 'Linux', output: 'Linux command input was empty. Skipping.' };
            return remoteCommand.runLinuxCommand(ip, nixCommand, linuxPassword);
        }
        // Windows or Unknown
        if (!winCommand.trim()) return { ip, status: 'Skipped', os: 'Windows', output: 'Windows command input was empty. Skipping.' };
        return remoteCommand.runWindowsCommand(ip, winCommand, winCreds);
    };

    const queue = [...targets];
    const runWorker = async () => {
        while (queue.length > 0 && !cancelled) {
            const ip = queue.shift();
            let result;
            try {
                result = await runOne(ip);
            } catch (err) {
                result = { ip, status: 'Failed', os: 'Error', output: 'Critical failure: ' + err.message };
            }
            if (result.status === 'Online') counts.ok++;
            else if (result.status === 'Skipped') counts.skipped++;
            else if (result.status === 'Offline') counts.offline++;
            else counts.failed++;
            if (!cancelled) res.write(JSON.stringify(result) + '\n');
        }
    };

    const CONCURRENCY_LIMIT = 10;
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, targets.length); i++) workers.push(runWorker());
    await Promise.all(workers);
    counts.notRun = queue.length;

    auditLog(username, 'Remote Command', `${cancelled ? 'Cancelled' : 'Finished'} on ${targets.length} target(s): ok ${counts.ok}, failed ${counts.failed}, offline ${counts.offline}, skipped ${counts.skipped}${counts.notRun ? `, not run ${counts.notRun}` : ''}`);
    if (!res.writableEnded) res.end();
});

module.exports = router;
