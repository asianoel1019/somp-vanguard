// Daily configuration backup of managed network devices (worker). NETDEVICE_BACKUP_SCHEDULE=HH:MM turns it on; the
// run of the day is recorded in the backup index before it starts, so a restart never runs it twice, and a worker that
// starts more than an hour after the set time skips that day.
const backups = require('../lib/netDevices/backups');
require('../lib/netDevices'); // registers the drivers with the backup module

const TICK_MS = 60 * 1000;
let timer = null;
let busy = false;

async function tick(now = new Date()) {
    if (busy) return { skipped: 'running' };
    busy = true;
    try {
        const r = await backups.scheduledRun(now);
        if (r.results) {
            const failed = r.results.filter(x => !x.ok);
            console.log(`[NetDevice Backup] Scheduled run: ${r.results.length} device(s), ${failed.length} failed`);
            for (const f of failed) console.warn(`[NetDevice Backup] ${f.id}: ${f.error}`);
        }
        return r;
    } finally {
        busy = false;
    }
}

function initNetDeviceBackupScheduler() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick().catch(err => console.error('[NetDevice Backup] Scheduler error:', err.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
}

module.exports = { initNetDeviceBackupScheduler, tick };
