/**
 * Worker-side inventory schedule runner. Instead of polling "is it HH:MM right now" it keeps a computed nextRunAt,
 * checks it every 30 s (so a run is never missed by a tick that landed in another minute), records
 * lastScheduledRunAt, and on worker start catches up one run missed within the last 6 hours.
 * Everything with side effects is injected so the logic is testable with a fake clock.
 */
const { computeNextRun, decideCatchUp, validateSchedule, CATCH_UP_WINDOW_MS } = require('../lib/inventorySchedule');

const TICK_MS = 30 * 1000;

function createInventoryScheduler(deps) {
    const now = deps.now || (() => new Date());
    const setIntervalFn = deps.setInterval || setInterval;
    const clearIntervalFn = deps.clearInterval || clearInterval;
    const log = deps.log || (() => {});
    const tickMs = deps.tickMs || TICK_MS;

    let timer = null;
    let schedule = null;
    let nextRunAt = null;
    let lastScheduledRunAt = null;
    let lastSkipped = null;
    let generation = 0;

    function publish() {
        return deps.patchStatus({
            schedule: {
                enabled: !!(schedule && schedule.enabled && nextRunAt),
                frequency: schedule ? (schedule.frequency || 'daily') : null,
                nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
                lastScheduledRunAt: lastScheduledRunAt || null,
                lastSkippedReason: lastSkipped ? lastSkipped.reason : null,
                lastSkippedAt: lastSkipped ? lastSkipped.at : null
            }
        });
    }

    function stop() {
        if (timer) { clearIntervalFn(timer); timer = null; }
    }

    // The scan itself runs for minutes: start it without waiting so worker start-up and the tick never block on it
    function fire(trigger, slot) {
        lastScheduledRunAt = slot.toISOString();
        const skipped = (reason) => {
            lastSkipped = { reason, at: now().toISOString() };
            log(`Scheduled scan for ${slot.toISOString()} was skipped: ${reason}`);
            return publish();
        };
        try {
            Promise.resolve(deps.runScan({ trigger, requestedBy: 'SYSTEM', scheduledFor: lastScheduledRunAt }))
                .then(res => (res && res.skipped ? skipped(res.skipped) : null))
                .catch(e => log(`Scheduled scan failed: ${e.message}`));
        } catch (e) {
            log(`Scheduled scan failed to start: ${e.message}`);
        }
    }

    async function tick() {
        if (!schedule || !nextRunAt) return;
        const t = now();
        if (t.getTime() < nextRunAt.getTime()) return;
        const slot = nextRunAt;
        nextRunAt = computeNextRun(schedule, t);
        const late = t.getTime() - slot.getTime();
        if (late > CATCH_UP_WINDOW_MS) {
            lastSkipped = { reason: `${Math.round(late / 60000)} min late`, at: t.toISOString() };
            log(`Scheduled run for ${slot.toISOString()} skipped (${Math.round(late / 60000)} min late)`);
            lastScheduledRunAt = slot.toISOString();
        } else {
            fire('schedule', slot);
        }
        await publish();
    }

    /**
     * (Re)load the schedule from the config. startup=true (worker start) also performs the catch-up decision.
     * Safe against concurrent calls: only the newest call installs a timer. Returns { nextRunAt, catchUp }.
     */
    async function start({ startup = false } = {}) {
        const gen = ++generation;
        const previous = { schedule: schedule && JSON.stringify(schedule), nextRunAt };
        stop();
        const config = (await deps.readConfig()) || {};
        const status = (await deps.readStatus()) || {};
        if (gen !== generation) return { nextRunAt: null, catchUp: null, superseded: true };
        lastScheduledRunAt = (status.schedule && status.schedule.lastScheduledRunAt) || null;
        schedule = config.schedule || null;

        const errors = validateSchedule(schedule);
        if (!schedule || !schedule.enabled || errors.length) {
            if (errors.length) log(`Inventory schedule ignored: ${errors[0]}`);
            nextRunAt = null;
            await publish();
            return { nextRunAt: null, catchUp: null };
        }

        const t = now();
        // A schedule that has never run is seeded with "now": enabling it must not trigger a catch-up
        if (!lastScheduledRunAt) lastScheduledRunAt = t.toISOString();

        let catchUp = null;
        if (startup) {
            catchUp = decideCatchUp({ schedule, lastScheduledRunAt, now: t });
        } else if (previous.nextRunAt && previous.schedule === JSON.stringify(schedule)
            && previous.nextRunAt.getTime() <= t.getTime() && t.getTime() - previous.nextRunAt.getTime() <= CATCH_UP_WINDOW_MS
            && previous.nextRunAt.toISOString() > lastScheduledRunAt) {
            // Reloaded with an unchanged schedule right as a run came due: do not lose it by recomputing
            catchUp = previous.nextRunAt;
        }
        nextRunAt = computeNextRun(schedule, t);
        stop(); // never leave a second interval behind
        timer = setIntervalFn(() => { tick().catch(e => log(`Scheduler tick error: ${e.message}`)); }, tickMs);
        if (timer && typeof timer.unref === 'function') timer.unref();

        if (catchUp) {
            log(`Running the scheduled scan that came due at ${catchUp.toISOString()}`);
            fire(startup ? 'catchup' : 'schedule', catchUp);
        }
        await publish();
        return { nextRunAt, catchUp };
    }

    return { start, stop, tick, getState: () => ({ nextRunAt, lastScheduledRunAt, schedule, lastSkipped }) };
}

module.exports = { createInventoryScheduler, TICK_MS };
