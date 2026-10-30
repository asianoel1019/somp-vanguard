export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const STATUS_META = {
    active: { label: '🟢 Active', color: '#10b981' },
    scheduled: { label: '🕒 Scheduled', color: '#3b82f6' },
    ended: { label: '⚪ Ended', color: 'var(--text-muted)' },
    disabled: { label: '⏸ Disabled', color: 'var(--text-muted)' },
};

const SUPPRESSION = {
    maintenance: { icon: '🔕', label: 'Maintenance', title: 'Within a maintenance window; no notification was sent' },
    flapping: { icon: '〰️', label: 'Flapping', title: 'State keeps changing; notifications paused' },
    cooldown: { icon: '⏱', label: 'Cooldown', title: 'Same alert within its cooldown period; not re-sent' },
    digest: { icon: '📦', label: 'Digested', title: 'Notification rate limit exceeded; merged into a digest' },
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function suppressionBadge(alert) {
    if (!alert || !hasOwn(SUPPRESSION, alert.suppressedReason)) return null;
    return { ...SUPPRESSION[alert.suppressedReason] };
}

export function badgesFor(alert) {
    const out = [];
    const s = suppressionBadge(alert);
    if (s) out.push(s);
    if (alert && alert.escalatedAt) {
        const at = new Date(alert.escalatedAt);
        const title = Number.isNaN(at.getTime()) ? 'Escalation notice sent' : `Escalation notice sent at ${at.toLocaleString()}`;
        out.push({ icon: '⏫', label: 'Escalated', title });
    }
    if (alert && Number(alert.occurrences) > 1) out.push({ icon: '', label: `×${alert.occurrences}`, title: `Occurred ${alert.occurrences} times in total` });
    if (alert && alert.resolvedReason === 'excluded') out.push({ icon: '🚫', label: 'Excluded', title: 'Resolved because the host was excluded from this rule (no recovery notification)' });
    return out;
}

const pad = (n) => String(n).padStart(2, '0');
export function toLocalInput(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(min) {
    if (min % 60 === 0) return `${min / 60} h`;
    return min > 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export function describeWindow(win) {
    if (win.kind === 'weekly') {
        const days = (win.weekdays || [])
            .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
            .map(d => WEEKDAY_LABELS[d])
            .join(', ');
        return `Every ${days} from ${win.startTime} for ${formatDuration(Number(win.durationMin))}`;
    }
    return `${new Date(win.startAt).toLocaleString()} ~ ${new Date(win.endAt).toLocaleString()}`;
}

export function describeScope(win, monitorsById = {}) {
    const vals = win.scopeValues || [];
    const base = {
        all: 'All hosts',
        monitors: `Hosts: ${vals.map(v => (monitorsById[v] && monitorsById[v].name) || v).join(', ')}`,
        tags: `Tags: ${vals.join(', ')}`,
        envs: `Environments: ${vals.join(', ')}`,
    }[win.scopeType] || win.scopeType;
    return win.ruleIds && win.ruleIds.length ? `${base} (limited to ${win.ruleIds.length} rules)` : base;
}

export function isHostInActiveWindow(windows, monitor) {
    const tags = Array.isArray(monitor.tags) ? monitor.tags : (() => { try { return JSON.parse(monitor.tags || '[]'); } catch { return []; } })();
    return (windows || []).some(w => w.status === 'active' && !(w.ruleIds && w.ruleIds.length) && (
        w.scopeType === 'all' ||
        (w.scopeType === 'monitors' && (w.scopeValues || []).includes(monitor.id)) ||
        (w.scopeType === 'tags' && tags.some(t => (w.scopeValues || []).includes(t))) ||
        (w.scopeType === 'envs' && (w.scopeValues || []).includes(monitor.envId))
    ));
}

const SCOPE_TYPES =['all', 'monitors', 'tags', 'envs'];
const MAX_ONCE_MS = 31 * 86400000;

// Mirrors backend/services/maintenanceWindows.js validateWindowInput.
export function buildWindowPayload(form) {
    const errors = [];
    const name = String(form.name || '').trim();
    if (!name || name.length > 100) errors.push('Name is required (max 100 characters)');
    const reason = String(form.reason || '').trim().slice(0, 500);
    const payload = { name, reason, kind: form.kind, scopeType: form.scopeType };

    if (form.kind === 'once') {
        const hasStart = typeof form.startLocal === 'string' && form.startLocal !== '';
        const hasEnd = typeof form.endLocal === 'string' && form.endLocal !== '';
        const s = hasStart ? new Date(form.startLocal) : null;
        const e = hasEnd ? new Date(form.endLocal) : null;
        if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) errors.push('Start and end time are required');
        else if (e <= s) errors.push('End time must be after start time');
        else if (e - s > MAX_ONCE_MS) errors.push('A one-time window can last at most 31 days');
        else { payload.startAt = s.toISOString(); payload.endAt = e.toISOString(); }
    } else if (form.kind === 'weekly') {
        const raw = Array.isArray(form.weekdays) ? form.weekdays.map(Number) : [];
        if (raw.length === 0 || raw.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Weekdays must be 0–6 (0=Sunday)');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.startTime || '')) errors.push('Start time must be in HH:MM format');
        const dur = Number(form.durationMin);
        if (!Number.isInteger(dur) || dur < 1 || dur > 10080) errors.push('Duration must be 1–10080 minutes');
        Object.assign(payload, {
            weekdays: [...new Set(raw)].sort((a, b) => a - b),
            startTime: form.startTime,
            durationMin: dur,
        });
    } else {
        errors.push('Kind must be once or weekly');
    }

    if (!SCOPE_TYPES.includes(form.scopeType)) errors.push('Scope must be all / monitors / tags / envs');
    if (form.scopeType === 'all') {
        payload.scopeValues = [];
    } else {
        const vals = Array.isArray(form.scopeValues) ? form.scopeValues : [];
        if (vals.length === 0) errors.push('Select at least one scope item');
        if (vals.length > 500) errors.push('At most 500 scope items');
        if (vals.some(v => typeof v !== 'string' || !v || v.length > 200)) errors.push('Invalid scope item format');
        payload.scopeValues = vals;
    }

    const ruleIds = Array.isArray(form.ruleIds) ? form.ruleIds : [];
    if (ruleIds.length > 500 || ruleIds.some(v => typeof v !== 'string' || !v)) errors.push('Invalid rule list format');
    payload.ruleIds = ruleIds;

    return { ok: errors.length === 0, errors, payload };
}
