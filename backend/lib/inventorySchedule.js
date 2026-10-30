/**
 * Schedule maths for the Server Inventory scan (pure functions, local time of the process, DST safe).
 *
 * A schedule is { enabled, frequency: 'daily' | 'weekly' | 'cron', time: 'HH:MM', weekday: 0-6 (0 = Sunday), cron: '5 field expression' }.
 * Every frequency is translated to one cron-like spec so there is a single engine for next/previous occurrences.
 * Occurrences are built from local calendar fields (new Date(y, m, d, h, mi)), never by adding 24 h, so a day with
 * 23 or 25 hours still fires exactly once per matching day (a time that does not exist on a spring-forward day fires
 * at the shifted time; a time that happens twice on a fall-back day fires on its first occurrence).
 */

const MAX_CRON_LENGTH = 100;
const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_LOOKAHEAD_DAYS = 366 * 8; // covers Feb 29 expressions

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseValue(token, names) {
    const t = String(token).toLowerCase();
    if (names && Object.prototype.hasOwnProperty.call(names, t)) return names[t];
    if (!/^\d{1,2}$/.test(t)) return NaN;
    return parseInt(t, 10);
}

/** Parses one cron field into a sorted array of integers, or throws Error with a readable message. */
function parseField(text, min, max, label, names) {
    const values = new Set();
    for (const part of String(text).split(',')) {
        if (part === '') throw new Error(`${label}: empty list item`);
        const [rangePart, stepPart, extra] = part.split('/');
        if (extra !== undefined) throw new Error(`${label}: invalid step in "${part}"`);
        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d{1,3}$/.test(stepPart) || parseInt(stepPart, 10) < 1) throw new Error(`${label}: invalid step in "${part}"`);
            step = parseInt(stepPart, 10);
        }
        let lo; let hi;
        if (rangePart === '*') {
            lo = min; hi = max;
        } else if (rangePart.includes('-')) {
            const [a, b, more] = rangePart.split('-');
            if (more !== undefined) throw new Error(`${label}: invalid range "${rangePart}"`);
            lo = parseValue(a, names); hi = parseValue(b, names);
        } else {
            lo = parseValue(rangePart, names);
            hi = stepPart !== undefined ? max : lo;
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`${label}: invalid value "${rangePart}"`);
        const top = label === 'day of week' ? 7 : max;
        if (lo < min || hi > top || lo > hi) throw new Error(`${label}: "${rangePart}" is out of range (${min}-${top})`);
        for (let v = lo; v <= hi; v += step) values.add(label === 'day of week' && v === 7 ? 0 : v);
    }
    return [...values].sort((a, b) => a - b);
}

/** Parses a standard 5-field cron expression (minute hour day-of-month month day-of-week). */
function parseCron(expression) {
    if (typeof expression !== 'string') throw new Error('cron expression must be a string');
    const text = expression.trim();
    if (!text) throw new Error('cron expression is empty');
    if (text.length > MAX_CRON_LENGTH) throw new Error('cron expression is too long');
    const fields = text.split(/\s+/);
    if (fields.length !== 5) throw new Error('cron expression must have 5 fields (minute hour day-of-month month day-of-week)');
    const spec = {
        minutes: parseField(fields[0], 0, 59, 'minute'),
        hours: parseField(fields[1], 0, 23, 'hour'),
        days: parseField(fields[2], 1, 31, 'day of month'),
        months: parseField(fields[3], 1, 12, 'month', MONTH_NAMES),
        weekdays: parseField(fields[4], 0, 6, 'day of week', DAY_NAMES),
        // Vixie cron: a day field that starts with '*' is unrestricted (AND); both restricted -> OR
        domRestricted: !fields[2].startsWith('*'),
        dowRestricted: !fields[4].startsWith('*')
    };
    return spec;
}

function hasWeekday(schedule) {
    return schedule.weekday !== undefined && schedule.weekday !== null && schedule.weekday !== '';
}

function parseTime(time) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
    if (!m) throw new Error('time must be HH:MM (24 hour)');
    return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

/** Returns { spec } for an enabled schedule, or { error } when it cannot run. */
function buildSpec(schedule) {
    if (!schedule || typeof schedule !== 'object') return { error: 'no schedule' };
    const frequency = schedule.frequency || 'daily';
    try {
        if (frequency === 'cron') {
            return { spec: parseCron(schedule.cron) };
        }
        const { hour, minute } = parseTime(schedule.time);
        const base = { minutes: [minute], hours: [hour], days: [], months: [], weekdays: [], domRestricted: false, dowRestricted: false };
        for (let d = 1; d <= 31; d++) base.days.push(d);
        for (let m = 1; m <= 12; m++) base.months.push(m);
        if (frequency === 'daily') {
            base.weekdays = [0, 1, 2, 3, 4, 5, 6];
            return { spec: base };
        }
        if (frequency === 'weekly') {
            // Legacy configs had frequency "weekly" but no weekday picker and ran DAILY: keep running daily
            if (!hasWeekday(schedule)) {
                base.weekdays = [0, 1, 2, 3, 4, 5, 6];
                return { spec: base };
            }
            const wd = Number(schedule.weekday);
            if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { error: 'weekday must be 0 (Sunday) to 6 (Saturday)' };
            base.weekdays = [wd];
            base.dowRestricted = true;
            return { spec: base };
        }
        return { error: `unknown frequency "${frequency}"` };
    } catch (e) {
        return { error: e.message };
    }
}

function dayMatches(spec, date) {
    if (!spec.months.includes(date.getMonth() + 1)) return false;
    const domOk = spec.days.includes(date.getDate());
    const dowOk = spec.weekdays.includes(date.getDay());
    if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk; // classic cron semantics
    return domOk && dowOk;
}

/** First occurrence strictly after `after` (Date) or null when none within ~8 years. */
function nextOccurrence(spec, after) {
    const afterMs = after.getTime();
    const y = after.getFullYear(); const mo = after.getMonth(); const d = after.getDate();
    for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
        const day = new Date(y, mo, d + i);
        if (!dayMatches(spec, day)) continue;
        for (const h of spec.hours) {
            for (const mi of spec.minutes) {
                const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0);
                if (cand.getTime() > afterMs) return cand;
            }
        }
    }
    return null;
}

/** Next run of a schedule object after `now` as a Date, or null if disabled / invalid / never. */
function computeNextRun(schedule, now = new Date()) {
    if (!schedule || !schedule.enabled) return null;
    const built = buildSpec(schedule);
    if (!built.spec) return null;
    return nextOccurrence(built.spec, now);
}

/** Latest scheduled slot in (now - windowMs, now], or null. */
function latestSlotWithin(schedule, now, windowMs = CATCH_UP_WINDOW_MS) {
    if (!schedule || !schedule.enabled) return null;
    const built = buildSpec(schedule);
    if (!built.spec) return null;
    let cursor = new Date(now.getTime() - windowMs);
    let latest = null;
    for (let guard = 0; guard < 2000; guard++) {
        const next = nextOccurrence(built.spec, cursor);
        if (!next || next.getTime() > now.getTime()) break;
        latest = next;
        cursor = next;
    }
    return latest;
}

/**
 * Catch-up decision at worker start: returns the missed slot (Date) when a scheduled run fell within the last 6 h
 * and has not been executed yet, otherwise null. A missing lastScheduledRunAt never triggers a catch-up.
 */
function decideCatchUp({ schedule, lastScheduledRunAt, now = new Date(), windowMs = CATCH_UP_WINDOW_MS }) {
    if (!lastScheduledRunAt) return null;
    const last = new Date(lastScheduledRunAt).getTime();
    if (!Number.isFinite(last)) return null;
    const slot = latestSlotWithin(schedule, now, windowMs);
    if (!slot) return null;
    return slot.getTime() > last ? slot : null;
}

/**
 * Validation used by the config save: returns an array of error strings.
 * partial=true validates only the fields present (a PATCH body); the full check runs on the merged schedule.
 * A disabled schedule is never rejected for an empty or half-typed cron expression.
 */
function validateSchedule(schedule, { partial = false } = {}) {
    const errors = [];
    if (schedule === undefined || schedule === null) return errors;
    if (typeof schedule !== 'object' || Array.isArray(schedule)) return ['schedule must be an object'];
    const frequency = schedule.frequency === undefined || schedule.frequency === '' ? 'daily' : schedule.frequency;
    if (!['daily', 'weekly', 'cron'].includes(frequency)) {
        errors.push('schedule.frequency must be daily, weekly or cron');
        return errors;
    }
    if (frequency === 'cron') {
        if (!partial && schedule.enabled) {
            try {
                const spec = parseCron(schedule.cron);
                if (!nextOccurrence(spec, new Date())) errors.push('schedule.cron never matches a real date (for example 31 February)');
            } catch (e) { errors.push(`schedule.cron: ${e.message}`); }
        }
    } else {
        // a disabled schedule (possibly a legacy one with time '') never blocks a save
        if (schedule.enabled && schedule.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time))) {
            errors.push('schedule.time must be HH:MM (24 hour)');
        }
        if (frequency === 'weekly' && hasWeekday(schedule)) {
            const wd = Number(schedule.weekday);
            if (!Number.isInteger(wd) || wd < 0 || wd > 6) errors.push('schedule.weekday must be 0 (Sunday) to 6 (Saturday)');
        }
    }
    if (!partial && schedule.enabled && errors.length === 0) {
        if (!buildSpec({ ...schedule, frequency }).spec) errors.push('schedule is incomplete (time is required)');
    }
    return errors;
}

module.exports = {
    CATCH_UP_WINDOW_MS,
    parseCron,
    buildSpec,
    nextOccurrence,
    computeNextRun,
    latestSlotWithin,
    decideCatchUp,
    validateSchedule
};
