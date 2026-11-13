// Pure helpers of the Hardware Issues page.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Timeline time: ISO (current server) shown in local time; older free-form text as it was saved. */
export function formatNoteTime(ts) {
    if (!ts) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return String(ts);
}

/** A CSV cell: quoted, and text Excel would run as a formula (= + - @, tab, CR) prefixed with ' so it stays text. */
export function csvCell(val) {
    let v = String(val === undefined || val === null ? '' : val);
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return `"${v.replace(/"/g, '""')}"`;
}

/** First letter of a name for the avatar; '?' when there is none. */
export function initialOf(name) {
    return (String(name || '?').trim().charAt(0) || '?').toUpperCase();
}

// ---- Service levels -----------------------------------------------------------------------------------------------

/** Days to resolve an issue by urgency, unless it has its own due date. */
export const SLA_DAYS = { H: 2, M: 7, L: 14 };
export const URGENCY_LABELS = { H: 'High', M: 'Medium', L: 'Low' };
export const RESOLUTIONS = ['Part replaced', 'Vendor repair / RMA', 'Firmware / configuration', 'No fault found', 'Device retired', 'Other'];

/** Local midnight of a YYYY-MM-DD date (NaN when missing). */
const dayStart = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).getTime() : NaN);

/** When the issue started: created time, else its reported date. */
export function issueStartMs(issue) {
    const created = Date.parse(issue && issue.createdAt);
    return Number.isFinite(created) ? created : dayStart(issue && issue.date);
}

/** Whole days open (until it was closed, for closed issues); null when unknown. */
export function ageDays(issue, now = Date.now()) {
    const start = issueStartMs(issue);
    if (!Number.isFinite(start)) return null;
    const closed = issue.status === 'Closed' ? Date.parse(issue.closedAt) : NaN;
    const end = Number.isFinite(closed) ? closed : now;
    return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Deadline: end of the due date, else start + the urgency's days; NaN when unknown. */
export function dueMs(issue) {
    const due = dayStart(issue && issue.dueDate);
    if (Number.isFinite(due)) return due + DAY_MS - 1;
    const start = issueStartMs(issue);
    return Number.isFinite(start) ? start + (SLA_DAYS[issue.urgency] || SLA_DAYS.M) * DAY_MS : NaN;
}

export function isOverdue(issue, now = Date.now()) {
    if (!issue || issue.status === 'Closed') return false;
    const due = dueMs(issue);
    return Number.isFinite(due) && now > due;
}

/** Closed issues shown on the board by default: closed within `days` (by closedAt, else the reported date). */
export function closedRecently(issue, now = Date.now(), days = 30) {
    const at = Date.parse(issue && issue.closedAt);
    const t = Number.isFinite(at) ? at : dayStart(issue && issue.date);
    return !Number.isFinite(t) || now - t <= days * DAY_MS;
}

// ---- Filters, sorting, figures ------------------------------------------------------------------------------------

const SEARCH_FIELDS = ['deviceName', 'sn', 'failedParts', 'reporter', 'assignee', 'rmaNumber', 'rackLoc', 'id'];

/** filters: { q, dc, urgency, status, from, to (YYYY-MM-DD, on the reported date), overdueOnly } ('' / 'ALL' = any). */
export function filterIssues(issues, filters = {}, now = Date.now()) {
    const q = String(filters.q || '').trim().toLowerCase();
    const any = (v) => !v || v === 'ALL';
    return (issues || []).filter(i => {
        if (!any(filters.status) && i.status !== filters.status) return false;
        if (!any(filters.dc) && i.datacenter !== filters.dc) return false;
        if (!any(filters.urgency) && i.urgency !== filters.urgency) return false;
        if (filters.from && !(i.date && i.date >= filters.from)) return false;
        if (filters.to && !(i.date && i.date <= filters.to)) return false;
        if (filters.overdueOnly && !isOverdue(i, now)) return false;
        if (q && !SEARCH_FIELDS.some(k => String(i[k] || '').toLowerCase().includes(q))) return false;
        return true;
    });
}

const URGENCY_RANK = { H: 0, M: 1, L: 2 };
const STATUS_RANK = { Open: 0, Processing: 1, Closed: 2 };

/** key: date | datacenter | deviceName | urgency | status | age | assignee; dir: 'asc' | 'desc'. Ties: newest first. */
export function sortIssues(issues, key = 'date', dir = 'desc', now = Date.now()) {
    const val = (i) => {
        switch (key) {
            case 'urgency': return URGENCY_RANK[i.urgency] ?? 3;
            case 'status': return STATUS_RANK[i.status] ?? 3;
            case 'age': return ageDays(i, now) ?? -1;
            case 'date': return issueStartMs(i) || 0;
            default: return String(i[key] || '').toLowerCase();
        }
    };
    const sign = dir === 'asc' ? 1 : -1;
    return [...(issues || [])].sort((a, b) => {
        const x = val(a); const y = val(b);
        if (x < y) return -sign;
        if (x > y) return sign;
        return (issueStartMs(b) || 0) - (issueStartMs(a) || 0);
    });
}

/** Figure cards: open (by urgency), processing, overdue, closed in 30 days, average days to close (90 days). */
export function issueKpis(issues, now = Date.now()) {
    const list = issues || [];
    const open = list.filter(i => i.status === 'Open');
    const active = list.filter(i => i.status !== 'Closed');
    const closed30 = list.filter(i => i.status === 'Closed' && Number.isFinite(Date.parse(i.closedAt)) && now - Date.parse(i.closedAt) <= 30 * DAY_MS);
    const closed90 = list.filter(i => i.status === 'Closed' && Number.isFinite(Date.parse(i.closedAt)) && now - Date.parse(i.closedAt) <= 90 * DAY_MS
        && Number.isFinite(issueStartMs(i)));
    const avg = closed90.length
        ? closed90.reduce((s, i) => s + (Date.parse(i.closedAt) - issueStartMs(i)) / DAY_MS, 0) / closed90.length
        : null;
    const byUrgency = (u) => open.filter(i => i.urgency === u).length;
    const perDc = {};
    active.forEach(i => { const k = i.datacenter || '(none)'; perDc[k] = (perDc[k] || 0) + 1; });
    return {
        open: open.length,
        openByUrgency: { H: byUrgency('H'), M: byUrgency('M'), L: byUrgency('L') },
        processing: list.filter(i => i.status === 'Processing').length,
        overdue: active.filter(i => isOverdue(i, now)).length,
        closed30: closed30.length,
        avgDaysToClose: avg === null ? null : Math.round(avg * 10) / 10,
        closedCounted: closed90.length,
        activeByDc: Object.entries(perDc).sort((a, b) => b[1] - a[1]),
    };
}

// ---- Linked data --------------------------------------------------------------------------------------------------

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Hardware warranty of the issue's device: a "Hardware Warranties" contract linked to its device id or with its
 * serial number. The longest-running one wins. -> { contract, daysLeft, active } or null.
 */
export function warrantyFor(issue, contracts, now = Date.now()) {
    if (!issue) return null;
    const sn = norm(issue.sn);
    const matches = (contracts || []).filter(c => c && c.type === 'Hardware Warranties'
        && ((issue.deviceId && Array.isArray(c.linkedDevices) && c.linkedDevices.includes(issue.deviceId)) || (sn && norm(c.serialNumber) === sn)));
    if (!matches.length) return null;
    const endOf = (c) => { const t = dayStart(c.endDate); return Number.isFinite(t) ? t + DAY_MS - 1 : -Infinity; };
    const best = matches.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
    const end = endOf(best);
    const daysLeft = Number.isFinite(end) ? Math.floor((end - now) / DAY_MS) : null;
    return { contract: best, daysLeft, active: daysLeft !== null && end >= now };
}

/** Spare parts used on the issue with their names: [{ name, category, qty, at, user }]. */
export function sparePartsUsed(issue, items) {
    const byId = new Map((items || []).map(i => [i.id, i]));
    return (Array.isArray(issue && issue.sparePartUsages) ? issue.sparePartUsages : []).map(u => {
        const it = byId.get(u.partId);
        return { name: it ? it.name : `(removed part ${u.partId})`, category: it ? it.category : '', qty: u.qty, at: u.at, user: u.user };
    });
}
