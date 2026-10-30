/**
 * Web-process close-out after the Background Worker exited unexpectedly (called from the supervisor 'exit' handler
 * in index.js; never during a shutdown). Every step is independent and nothing ever throws to the supervisor.
 *  - Server Provision: ack waits for that worker end at once (the web runs those jobs itself), and the provision jobs
 *    the exited worker owned are adopted by the web (half-done hosts -> interrupted, queued hosts resumed once).
 *  - Backup: a backup that was running inside the worker will never report back.
 * Dependencies are injectable for tests.
 */
async function handleWorkerExit({ pid, jobs, backupService } = {}) {
    try {
        const j = jobs || require('../services/provisionJobs');
        try { j.onWorkerGone(); } catch (e) { console.error('[Supervisor] Provision ack close-out failed:', e.message); }
        // let the released offers settle first (they leave the pending map; one the dead worker had claimed is then
        // adopted by its own fallback path or by the recovery below; the CAS makes the two exclusive)
        await new Promise((resolve) => setImmediate(resolve));
        if (Number.isInteger(pid) && pid > 0) {
            const r = j.recoverOrphans({ pid });
            if (r && r.jobs) console.log(`[Supervisor] Took over ${r.jobs} provision job(s) of the exited worker (${r.resumed} resumed).`);
        }
    } catch (e) {
        console.error('[Supervisor] Provision job close-out failed:', e.message);
    }
    try {
        const svc = backupService || require('../services/backupService');
        const st = await svc.readLastResult();
        if (st && st.startedAt && !st.finishedAt) {
            await svc.writeLastResult({ ...st, finishedAt: new Date().toISOString(), error: 'Background worker exited during backup' });
        }
    } catch (e) {
        console.error('[Supervisor] Failed to close unfinished backup status:', e.message);
    }
}

module.exports = { handleWorkerExit };
