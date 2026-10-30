// Pure helpers for the Server Inventory scan scheduler and live status (no React, no network).

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_SCHEDULE = Object.freeze({ enabled: false, frequency: 'daily', time: '08:00', weekday: 1, cron: '' });

/** Fills the schedule defaults the editor needs without losing what the server sent. */
export function normalizeSchedule(schedule) {
    const s = schedule && typeof schedule === 'object' ? schedule : {};
    const hasWeekday = s.weekday !== '' && s.weekday !== null && s.weekday !== undefined && Number.isInteger(Number(s.weekday));
    let frequency = ['daily', 'weekly', 'cron'].includes(s.frequency) ? s.frequency : 'daily';
    // Legacy configs say "weekly" without a weekday and always ran daily: show (and save) them as daily
    if (frequency === 'weekly' && !hasWeekday) frequency = 'daily';
    return {
        enabled: !!s.enabled,
        frequency,
        time: s.time || DEFAULT_SCHEDULE.time,
        weekday: hasWeekday ? Number(s.weekday) : DEFAULT_SCHEDULE.weekday,
        cron: typeof s.cron === 'string' ? s.cron : ''
    };
}

/** Human readable one-liner, e.g. "Every Monday at 02:30". */
export function describeSchedule(schedule) {
    const s = normalizeSchedule(schedule);
    if (!s.enabled) return 'Automatic scan is off';
    if (s.frequency === 'cron') return s.cron.trim() ? `Cron: ${s.cron.trim()}` : 'Cron expression missing';
    if (s.frequency === 'weekly') return `Every ${WEEKDAYS[s.weekday] || 'week'} at ${s.time}`;
    return `Every day at ${s.time}`;
}

/** Client-side hint only; the server validates the cron expression authoritatively. */
export function cronLooksValid(expr) {
    return typeof expr === 'string'
        && expr.trim().split(/\s+/).filter(Boolean).length === 5
        && /^[0-9*/,A-Za-z\s-]+$/.test(expr);
}

/** Body sent on save: only editable fields (lastScan / lastDiscovered are owned by the server). */
export function buildConfigPayload(config) {
    const editable = { ...(config || {}) };
    delete editable.lastScan;
    delete editable.lastDiscovered;
    return { ...editable, schedule: normalizeSchedule(editable.schedule) };
}

/** Probe / specs error of a host (stored by the scan, max 500 chars), or '' when the last probe succeeded. */
export function specsErrorText(host) {
    const e = host && (host.error || host.specsError);
    return typeof e === 'string' ? e.trim().slice(0, 500) : '';
}

/** Label + tone for the scan monitor badge. */
export function scanBadge(status) {
    if (!status) return null;
    if (status.running) return { label: status.abortRequested ? 'ABORTING' : 'LIVE', tone: 'warning' };
    if (status.stale) return { label: 'STALE', tone: 'danger' };
    if (status.aborted) return { label: status.interrupted ? 'INTERRUPTED' : 'ABORTED', tone: 'danger' };
    if (status.finishedAt) return { label: status.degraded ? 'COMPLETED (DEGRADED)' : 'COMPLETED', tone: status.degraded ? 'warning' : 'success' };
    return null;
}

const TRIGGER_LABELS = { manual: 'Manual', schedule: 'Scheduled', catchup: 'Scheduled (catch-up)' };

export function triggerLabel(status) {
    if (!status || !status.trigger) return '';
    const base = TRIGGER_LABELS[status.trigger] || status.trigger;
    return status.requestedBy && status.requestedBy !== 'SYSTEM' ? `${base} by ${status.requestedBy}` : base;
}

/** "in 2h 5m" / "in 3 days" style label for the next scheduled run. */
export function formatNextRun(iso, nowMs = Date.now()) {
    if (!iso) return 'Not scheduled';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 'Not scheduled';
    const abs = new Date(t).toLocaleString();
    const diff = t - nowMs;
    if (diff <= 0) return `${abs} (due)`;
    const mins = Math.round(diff / 60000);
    let rel;
    if (mins < 1) rel = 'in under a minute';
    else if (mins < 60) rel = `in ${mins}m`;
    else if (mins < 48 * 60) rel = `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    else rel = `in ${Math.round(mins / 1440)} days`;
    return `${abs} (${rel})`;
}
