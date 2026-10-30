/** Pure maintenance-window logic (no DB, no side effects). Weekly windows use server local time. */
const MAX_ONCE_MS = 31 * 24 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCOPES = ['all', 'monitors', 'tags', 'envs'];

function parseList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return [];
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

const isEnabled = (win) => win && win.enabled !== 0 && win.enabled !== false;

function isWindowActive(win, now) {
    if (!isEnabled(win)) return false;
    const t = now.getTime();
    if (win.kind === 'once') {
        const s = Date.parse(win.startAt), e = Date.parse(win.endAt);
        return Number.isFinite(s) && Number.isFinite(e) && t >= s && t < e;
    }
    if (win.kind === 'weekly') {
        const m = TIME_RE.exec(String(win.startTime || ''));
        const dur = Number(win.durationMin) * 60000;
        if (!m || !(dur > 0)) return false;
        const days = parseList(win.weekdays).map(Number);
        const maxBack = Math.ceil(Number(win.durationMin) / 1440) + 1;
        for (let back = 0; back <= maxBack; back++) {
            const start = new Date(now);
            start.setDate(start.getDate() - back);
            start.setHours(Number(m[1]), Number(m[2]), 0, 0);
            if (days.includes(start.getDay()) && t >= start.getTime() && t < start.getTime() + dur) return true;
        }
    }
    return false;
}

function windowCovers(win, monitor, ruleId) {
    const values = parseList(win.scopeValues).map(String);
    const ruleIds = parseList(win.ruleIds).map(String);
    if (ruleIds.length > 0 && !ruleIds.includes(String(ruleId))) return false;
    switch (win.scopeType) {
        case 'all': return true;
        case 'monitors': return values.includes(String(monitor.id));
        case 'tags': {
            const tags = parseList(monitor.tags).map(String);
            return tags.some(tg => values.includes(tg));
        }
        case 'envs': return monitor.envId != null && values.includes(String(monitor.envId));
        default: return false;
    }
}

function findActiveWindow(windows, monitor, ruleId, now) {
    for (const w of windows || []) {
        try { if (isWindowActive(w, now) && windowCovers(w, monitor, ruleId)) return w; } catch (e) {}
    }
    return null;
}

const isInMaintenance = (windows, monitor, ruleId, now) => !!findActiveWindow(windows, monitor, ruleId, now);

function windowStatus(win, now) {
    if (!isEnabled(win)) return 'disabled';
    if (isWindowActive(win, now)) return 'active';
    if (win.kind === 'once') return now.getTime() < Date.parse(win.startAt) ? 'scheduled' : 'ended';
    return 'scheduled';
}

function validateWindowInput(body, now = new Date()) {
    const b = body && typeof body === 'object' ? body : {};
    const errors = [];
    const name = String(b.name || '').trim();
    if (!name || name.length > 100) errors.push('Name is required (max 100 characters)');
    const kind = b.kind;
    const value = {
        name, reason: String(b.reason || '').trim().slice(0, 500), kind,
        startAt: null, endAt: null, weekdays: null, startTime: null, durationMin: null,
        scopeType: b.scopeType, scopeValues: '[]', ruleIds: '[]',
        enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    };
    if (kind === 'once') {
        const s = Date.parse(b.startAt), e = Date.parse(b.endAt);
        if (!Number.isFinite(s) || !Number.isFinite(e)) errors.push('Start and end time are required');
        else if (e <= s) errors.push('End time must be after start time');
        else if (e - s > MAX_ONCE_MS) errors.push('A one-time window can last at most 31 days');
        else { value.startAt = new Date(s).toISOString(); value.endAt = new Date(e).toISOString(); }
    } else if (kind === 'weekly') {
        const days = Array.isArray(b.weekdays) ? b.weekdays.map(Number) : [];
        if (days.length === 0 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Weekdays must be 0–6 (0=Sunday)');
        if (!TIME_RE.test(String(b.startTime || ''))) errors.push('Start time must be in HH:MM format');
        const dur = Number(b.durationMin);
        if (!Number.isInteger(dur) || dur < 1 || dur > 10080) errors.push('Duration must be 1–10080 minutes');
        value.weekdays = JSON.stringify([...new Set(days)].sort());
        value.startTime = String(b.startTime || '');
        value.durationMin = dur;
    } else {
        errors.push('Kind must be once or weekly');
    }
    if (!SCOPES.includes(b.scopeType)) errors.push('Scope must be all / monitors / tags / envs');
    if (b.scopeType && b.scopeType !== 'all') {
        const vals = Array.isArray(b.scopeValues) ? b.scopeValues : [];
        if (vals.length === 0) errors.push('Select at least one scope item');
        if (vals.length > 500) errors.push('At most 500 scope items');
        if (vals.some(v => typeof v !== 'string' || !v || v.length > 200)) errors.push('Invalid scope item format');
        value.scopeValues = JSON.stringify(vals);
    }
    const ruleIds = Array.isArray(b.ruleIds) ? b.ruleIds : [];
    if (ruleIds.length > 500 || ruleIds.some(v => typeof v !== 'string' || !v)) errors.push('Invalid rule list format');
    value.ruleIds = JSON.stringify(ruleIds);
    return { ok: errors.length === 0, errors, value };
}

module.exports = { parseList, isWindowActive, windowCovers, findActiveWindow, isInMaintenance, windowStatus, validateWindowInput };
