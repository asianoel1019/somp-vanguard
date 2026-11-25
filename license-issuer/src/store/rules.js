// Business rules of the license issuer without the database: fixed lists, limits, input checks, the computed license
// status, periods, ISO weeks and the weekly-digest schedule. Shared by the store, the issuing core, the CLI and the web app.
const path = require('path');
const { daysBetween, isRealDate } = require(path.join(__dirname, '..', '..', '..', 'backend', 'lib', 'licenseFormat'));
const D = require(path.join(__dirname, '..', '..', 'public', 'dates'));

const CURRENCIES = ['TWD', 'USD', 'EUR', 'JPY', 'CNY', 'HKD', 'SGD'];
const LICENSE_TYPES = ['paid', 'trial'];
const TERM_UNITS = ['months', 'days'];
const REVOKE_REASONS = ['replaced', 'terminated', 'issued_in_error', 'other'];
/** Reasons a person may pick when revoking; 'replaced' is set only by a replacement. */
const MANUAL_REVOKE_REASONS = ['terminated', 'issued_in_error', 'other'];
const EVENT_TYPES = ['issued', 'delivered', 'delivery_failed', 'downloaded', 'reissued', 'revoked', 'replaced', 'edited', 'imported'];
/** Event types callers record themselves (store.addEvent); the others are written by the store. */
const RECORD_EVENT_TYPES = ['delivered', 'delivery_failed', 'downloaded', 'reissued'];
/** The only license fields that can change after issuing (anything else: replace the license). */
const EDITABLE_FIELDS = ['salesId', 'amount', 'currency', 'orderNo'];

const STATUS = { REVOKED: 'Revoked', FORMAT1: 'Format 1 (invalid)', EXPIRED: 'Expired', SOON: 'Expires soon', ACTIVE: 'Active' };
const STATUSES = [STATUS.REVOKED, STATUS.FORMAT1, STATUS.EXPIRED, STATUS.SOON, STATUS.ACTIVE];
/** "Expires soon" when at most this many days are left. */
const SOON_DAYS = { paid: 30, trial: 7 };
/** A trial license is valid for at most this many days (issued and expiry day included). */
const TRIAL_MAX_DAYS = 60;
const DIGEST_DAYS = 90;
const AMOUNT_MAX = 1e12;
const LIMITS = {
    customerName: 200, salesName: 100, planName: 100, email: 200, taxId: 50, address: 300, contactPerson: 100, phone: 50,
    notes: 2000, orderNo: 100, note: 500, termDays: 3650, termMonths: 120, template: 10000, subject: 300,
};
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ID_PATTERN = /^L-\d{4}-\d{4}$/;
const DEFAULT_CURRENCY = 'TWD';
const DEFAULT_SETTINGS = {
    mailSubject: 'SOMP Vanguard {type} license {licenseId} for {customer}',
    mailBody: [
        'Dear {customer},',
        '',
        'Attached is your SOMP Vanguard {type} license {licenseId}.',
        'Issued: {issuedAt}',
        'Expires: {expiresAt}',
        '',
        'To install it, sign in to SOMP Vanguard as an administrator, open Settings > License and upload the attached .lic file.',
        '',
        'Best regards,',
        '{vendor}',
        '{vendorEmail}',
    ].join('\n'),
    digestWeekday: 1, // ISO weekday: 1 = Monday ... 7 = Sunday
    digestTime: '09:00',
    defaultCurrency: DEFAULT_CURRENCY,
    lastDigestWeek: '',
};

/** A refused store operation. status: the HTTP status a web route should answer with. */
class StoreError extends Error {
    constructor(code, message, { field = null, status } = {}) {
        super(message);
        this.name = 'StoreError';
        this.code = code; // invalid | not-found | conflict | locked | failed
        this.field = field;
        this.status = status || { invalid: 400, 'not-found': 404, conflict: 409, locked: 503 }[code] || 500;
    }
}
const invalid = (field, message) => new StoreError('invalid', message, { field });

/**
 * Trimmed text of an optional or required field; throws StoreError('invalid') for a non-string, a value that is too long or
 * control characters (newlines allowed only when multiline). Returns null for an empty optional value.
 */
function text(value, { field, label, max, required = false, multiline = false }) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') throw invalid(field, `${label} must be text.`);
    const v = multiline ? value.replace(/\r\n/g, '\n').trim() : value.trim();
    if (!v) {
        if (required) throw invalid(field, `${label} is required.`);
        return null;
    }
    if (v.length > max) throw invalid(field, `${label} must be at most ${max} characters.`);
    if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(v)) throw invalid(field, `${label} must not contain control characters.`);
    return v;
}

/** An optional email address (name@domain, no spaces, at most 200 characters); null when empty. */
function email(value, { field, label }) {
    const v = text(value, { field, label, max: LIMITS.email });
    if (v !== null && !EMAIL_PATTERN.test(v)) throw invalid(field, `${label} must look like name@domain (no spaces).`);
    return v;
}

/** Amount: null when empty; else a number >= 0 with at most 2 decimals (number or numeric text). */
function amount(value, { field = 'amount', label = 'Amount' } = {}) {
    if (value === undefined || value === null || value === '') return null;
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
    else throw invalid(field, `${label} must be a number of 0 or more.`);
    if (!Number.isFinite(n) || n < 0) throw invalid(field, `${label} must be a number of 0 or more.`);
    if (n > AMOUNT_MAX) throw invalid(field, `${label} is too large.`);
    const cents = Math.round(n * 100);
    if (Math.abs(cents - n * 100) > 1e-6) throw invalid(field, `${label} can have at most 2 decimals.`);
    return cents / 100;
}

/** Currency code from the fixed list (any case); `fallback` when empty. */
function currency(value, fallback = DEFAULT_CURRENCY, { field = 'currency' } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || !CURRENCIES.includes(value.trim().toUpperCase())) {
        throw invalid(field, `Currency must be one of ${CURRENCIES.join(', ')}.`);
    }
    return value.trim().toUpperCase();
}

/** A positive integer row id (number or digits); throws invalid otherwise. null when empty and not required. */
function id(value, { field, label, required = false }) {
    if (value === undefined || value === null || value === '') {
        if (required) throw invalid(field, `${label} is required.`);
        return null;
    }
    const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 1) throw invalid(field, `${label} is not valid.`);
    return n;
}

/** Sums amounts per currency, rounded to cents: { TWD: 1200, USD: 99.5 }. */
function addAmount(totals, cur, value) {
    if (value === null || value === undefined || !cur) return totals;
    totals[cur] = Math.round(((totals[cur] || 0) + value) * 100) / 100;
    return totals;
}

/**
 * Status of a license on `today`: Revoked > Format 1 (invalid) > Expired > Expires soon (paid <= 30 days, trial <= 7) >
 * Active. daysLeft: days until the expiry (negative once expired), null without an expiry date.
 */
function computeStatus({ revokedAt, format, expiresAt, type }, today) {
    const daysLeft = expiresAt && isRealDate(expiresAt) ? daysBetween(today, expiresAt) : null;
    if (revokedAt) return { status: STATUS.REVOKED, daysLeft };
    if (format === 1 || daysLeft === null) return { status: STATUS.FORMAT1, daysLeft: null };
    if (daysLeft < 0) return { status: STATUS.EXPIRED, daysLeft };
    if (daysLeft <= (SOON_DAYS[type] || SOON_DAYS.paid)) return { status: STATUS.SOON, daysLeft };
    return { status: STATUS.ACTIVE, daysLeft };
}

/** Days a license is valid, the issued and expiry days included. */
const termDays = (issuedAt, expiresAt) => daysBetween(issuedAt, expiresAt) + 1;

const pad = (n) => String(n).padStart(2, '0');
/** Local date YYYY-MM-DD of a Date. */
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local date-time with offset, e.g. 2026-11-25T10:00:00+08:00. */
function localIso(d = new Date()) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
/** YYYYMMDD-HHmmss (local) for file names. */
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** { from, to } (YYYY-MM-DD, both included) of the month / quarter / year that contains `date`. */
function periodRange(kind, date) {
    if (!isRealDate(date)) throw invalid('period', 'The period date must be a real date (YYYY-MM-DD).');
    const [y, m] = date.split('-').map(Number);
    const last = (yy, mm) => `${yy}-${pad(mm)}-${pad(new Date(Date.UTC(yy, mm, 0)).getUTCDate())}`;
    if (kind === 'month') return { from: `${y}-${pad(m)}-01`, to: last(y, m) };
    if (kind === 'quarter') {
        const q0 = Math.floor((m - 1) / 3) * 3 + 1;
        return { from: `${y}-${pad(q0)}-01`, to: last(y, q0 + 2) };
    }
    if (kind === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
    throw invalid('period', 'Period must be month, quarter or year.');
}

/** ISO 8601 week of a local Date: "2026-W48". */
function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides the year
    const y = t.getUTCFullYear();
    const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}-W${pad(week)}`;
}

/**
 * Whether the weekly digest is due at `now` (local Date): this week's weekday (1 = Monday ... 7 = Sunday) and time
 * (HH:mm) have passed and it was not sent in this ISO week (lastWeek, e.g. "2026-W48").
 */
function digestDue({ digestWeekday, digestTime, lastDigestWeek }, now) {
    if (lastDigestWeek === isoWeek(now)) return false;
    const weekday = now.getDay() || 7;
    if (weekday !== digestWeekday) return weekday > digestWeekday;
    return `${pad(now.getHours())}:${pad(now.getMinutes())}` >= digestTime;
}

/** File name part from a customer name: lowercase ASCII letters, digits and hyphens, at most 40, else "customer". */
function slugify(customer) {
    const s = String(customer || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return s || 'customer';
}

module.exports = {
    CURRENCIES, LICENSE_TYPES, TERM_UNITS, REVOKE_REASONS, MANUAL_REVOKE_REASONS, EVENT_TYPES, RECORD_EVENT_TYPES, EDITABLE_FIELDS,
    STATUS, STATUSES, SOON_DAYS, TRIAL_MAX_DAYS, DIGEST_DAYS, AMOUNT_MAX, LIMITS, EMAIL_PATTERN, ID_PATTERN, DEFAULT_CURRENCY,
    DEFAULT_SETTINGS, StoreError, invalid, text, email, amount, currency, id, addAmount, computeStatus, termDays, planEnd: D.planEnd,
    addDays: D.addDays, daysBetween, isRealDate, localDate, localIso, stamp, periodRange, isoWeek, digestDue, slugify,
};
