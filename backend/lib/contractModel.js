// Contracts & Warranties: field validation, day counting and the expiry notice selection (pure functions).
// Dates are calendar days (YYYY-MM-DD). A contract ending today has 0 days left and is still active.
const CONTRACT_TYPES = ['Hardware Warranties', 'Software Licenses'];
const CURRENCIES = ['TWD', 'USD', 'EUR', 'JPY', 'CNY'];
const TEXT_FIELDS = { name: 200, vendor: 200, serialNumber: 200, licenseKey: 4000, contact: 200, notes: 2000 };
const MAX_LINKED_DEVICES = 1000;
const DEFAULT_NOTIFY_DAYS = [60, 30, 7];
const EXPIRED_NOTICE_DAYS = 7; // an expiry older than this is never announced (first run after a long pause)
const DAY_MS = 86400000;

function ymdIndex(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return t / DAY_MS;
}

const todayIndex = (now = new Date()) => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;

/** Calendar days from today to endDate (negative once expired); null without a valid date. */
function daysLeft(endDate, now = new Date()) {
    const end = ymdIndex(endDate);
    return end === null ? null : end - todayIndex(now);
}

/** A contract that still counts: not in the trash and not replaced by a renewal. */
const isCurrent = (c) => !!c && !c.deletedAt && !c.renewedTo;

function optionalNumber(body, key, { integer = false, max = 1e12 } = {}) {
    const v = body[key];
    if (v === undefined || v === null || v === '') return { value: '' };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
        return { error: `${key} must be ${integer ? 'a whole number' : 'a number'} from 0 to ${max}` };
    }
    return { value: n };
}

/**
 * Validates the editable fields of a contract (the whole form is sent on create and update).
 * Unknown and server-owned keys (id, file, times, trash, renewal links) are dropped. -> { error } or { fields }
 */
function cleanContractFields(body) {
    const src = body && typeof body === 'object' ? body : {};
    const fields = {};
    if (!CONTRACT_TYPES.includes(src.type)) return { error: `type must be one of ${CONTRACT_TYPES.join(', ')}` };
    fields.type = src.type;
    for (const [key, max] of Object.entries(TEXT_FIELDS)) {
        const v = src[key];
        if (v === undefined || v === null) { fields[key] = ''; continue; }
        if (typeof v !== 'string' && typeof v !== 'number') return { error: `${key} must be text` };
        const s = String(v).trim();
        if (s.length > max) return { error: `${key} is limited to ${max} characters` };
        fields[key] = s;
    }
    if (!fields.name) return { error: 'name is required' };
    if (!fields.vendor) return { error: 'vendor is required' };
    for (const key of ['startDate', 'endDate']) {
        if (ymdIndex(src[key]) === null) return { error: `${key} must be a valid date (YYYY-MM-DD)` };
        fields[key] = src[key];
    }
    if (ymdIndex(fields.endDate) < ymdIndex(fields.startDate)) return { error: 'endDate must not be before startDate' };
    const currency = src.currency === undefined || src.currency === null || src.currency === '' ? 'TWD' : src.currency;
    if (!CURRENCIES.includes(currency)) return { error: `currency must be one of ${CURRENCIES.join(', ')}` };
    fields.currency = currency;
    for (const [key, opts] of [['cost', {}], ['seats', { integer: true, max: 1e7 }], ['seatsUsed', { integer: true, max: 1e7 }]]) {
        const r = optionalNumber(src, key, opts);
        if (r.error) return { error: r.error };
        fields[key] = r.value;
    }
    const links = src.linkedDevices === undefined || src.linkedDevices === null ? [] : src.linkedDevices;
    if (!Array.isArray(links) || links.some(d => typeof d !== 'string' || !d.trim() || d.length > 100)) {
        return { error: 'linkedDevices must be a list of device ids' };
    }
    fields.linkedDevices = [...new Set(links.map(d => d.trim()))];
    if (fields.linkedDevices.length > MAX_LINKED_DEVICES) return { error: `at most ${MAX_LINKED_DEVICES} linked devices` };
    if (fields.type !== 'Software Licenses') { fields.licenseKey = ''; fields.seats = ''; fields.seatsUsed = ''; }
    return { fields };
}

/** File name shown to the user: the base name only, control characters removed, at most 200 characters. */
function displayFileName(name) {
    // eslint-disable-next-line no-control-regex
    const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return base.slice(0, 200) || 'file';
}

/** Notice days from CONTRACT_NOTIFY_DAYS ("60,30,7"; "off" or "0" disables), largest first. */
function parseNotifyDays(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_NOTIFY_DAYS.slice();
    const s = String(raw).trim().toLowerCase();
    if (s === 'off' || s === '0' || s === 'false') return [];
    const days = [...new Set(s.split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0 && n <= 365))];
    return days.length ? days.sort((a, b) => b - a) : DEFAULT_NOTIFY_DAYS.slice();
}

/**
 * Notices due now and the next notice state. state: { [contractId]: { endDate, sent: [days], expired } }.
 * Each contract gets at most one notice per call: the closest notice day it has reached (the larger ones are marked
 * sent with it, so a contract first seen 5 days before its end gets one notice, not three). A changed end date starts
 * over. An expiry is announced once, only within EXPIRED_NOTICE_DAYS of it.
 * -> { notices: [{ contract, daysLeft, kind: 'expiring' | 'expired', threshold }], state, changed }
 */
function dueNotices(contracts, state, now, days) {
    const prev = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    const next = {};
    const notices = [];
    let changed = false;
    for (const c of Array.isArray(contracts) ? contracts : []) {
        if (!isCurrent(c) || !c.id) continue;
        const left = daysLeft(c.endDate, now);
        if (left === null) continue;
        const old = prev[c.id];
        const entry = old && old.endDate === c.endDate
            ? { endDate: c.endDate, sent: Array.isArray(old.sent) ? old.sent.slice() : [], expired: !!old.expired }
            : { endDate: c.endDate, sent: [], expired: false };
        if (!old || old.endDate !== c.endDate) changed = true;
        const reached = days.filter(t => left <= t);
        const fresh = reached.filter(t => !entry.sent.includes(t));
        if (left < 0) {
            if (!entry.expired) {
                if (left >= -EXPIRED_NOTICE_DAYS) notices.push({ contract: c, daysLeft: left, kind: 'expired', threshold: 0 });
                entry.expired = true;
                changed = true;
            }
        } else if (fresh.length) {
            notices.push({ contract: c, daysLeft: left, kind: 'expiring', threshold: Math.min(...fresh) });
        }
        if (fresh.length) { entry.sent = [...new Set([...entry.sent, ...reached])].sort((a, b) => b - a); changed = true; }
        next[c.id] = entry;
    }
    if (Object.keys(prev).some(id => !next[id])) changed = true;
    return { notices, state: next, changed };
}

/** Telegram text of one batch of notices. */
function noticeMessage(notices) {
    const lines = notices
        .slice()
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .map(n => {
            const c = n.contract;
            const what = `${c.name || '(unnamed)'}${c.vendor ? ` (${c.vendor})` : ''}${c.serialNumber ? ` SN ${c.serialNumber}` : ''}`;
            const when = n.kind === 'expired'
                ? `expired ${c.endDate} (${-n.daysLeft} day(s) ago)`
                : n.daysLeft === 0 ? `ends today (${c.endDate})` : `ends ${c.endDate} (${n.daysLeft} day(s) left)`;
            return `${n.kind === 'expired' ? '⛔' : n.daysLeft <= 7 ? '⚠️' : '•'} [${c.type === 'Software Licenses' ? 'License' : 'Warranty'}] ${what}: ${when}`;
        });
    return `📜 Contracts & Warranties: ${notices.length} contract(s) need renewal\n${lines.join('\n')}`;
}

module.exports = {
    CONTRACT_TYPES, CURRENCIES, DEFAULT_NOTIFY_DAYS, EXPIRED_NOTICE_DAYS,
    ymdIndex, daysLeft, isCurrent, cleanContractFields, displayFileName, parseNotifyDays, dueNotices, noticeMessage,
};
