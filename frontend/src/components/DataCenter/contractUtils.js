// Pure helpers of the Contracts & Warranties page (and the Home expiry banner).
// Dates are calendar days (YYYY-MM-DD) in local time: a contract ending today has 0 days left and is still active.
import { csvCell } from './hwIssueUtils.js';

export const CONTRACT_TYPES = ['Hardware Warranties', 'Software Licenses'];
export const CURRENCIES = ['TWD', 'USD', 'EUR', 'JPY', 'CNY'];
export const STATUSES = ['Active', 'Expiring', 'Expired', 'Renewed'];
export const EXPIRING_DAYS = 60;
export const RENEWAL_WINDOW_DAYS = 90;
export const FILE_ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg';
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Day number of a YYYY-MM-DD date; null when it is not a real date. */
export function ymdIndex(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return t / DAY_MS;
}

/** YYYY-MM-DD of a day number. */
export function indexYmd(index) {
    return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function todayIndex(now) {
    const d = new Date(now);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

/** Days from today to the end date (negative once expired); null without a valid end date. */
export function contractDaysLeft(c, now = Date.now()) {
    const end = ymdIndex(c && c.endDate);
    return end === null ? null : end - todayIndex(now);
}

/** Still counts: not in the trash and not replaced by a renewal. */
export const isCurrent = (c) => !!c && !c.deletedAt && !c.renewedTo;

/** 'Renewed' | 'Expired' | 'Expiring' | 'Active' | 'Unknown' */
export function contractStatus(c, now = Date.now()) {
    if (c && c.renewedTo) return 'Renewed';
    const left = contractDaysLeft(c, now);
    if (left === null) return 'Unknown';
    if (left < 0) return 'Expired';
    if (left <= EXPIRING_DAYS) return 'Expiring';
    return 'Active';
}

/** Share of the term already used, 0-100. */
export function termProgress(c, now = Date.now()) {
    const s = ymdIndex(c && c.startDate);
    const e = ymdIndex(c && c.endDate);
    if (s === null || e === null) return 0;
    const t = todayIndex(now);
    if (t <= s) return 0;
    if (t >= e + 1) return 100;
    return Math.floor(((t - s) / (e + 1 - s)) * 100);
}

/** Days left as words: "12 days left", "ends today", "expired 3 days ago". */
export function daysLeftText(left) {
    if (left === null || left === undefined) return 'No end date';
    if (left === 0) return 'Ends today';
    if (left > 0) return `${left} day${left === 1 ? '' : 's'} left`;
    return `Expired ${-left} day${left === -1 ? '' : 's'} ago`;
}

/** Contracts for the Home banner: current ones ending within `days` (today included). */
export function expiringSoon(contracts, now = Date.now(), days = 30) {
    return (Array.isArray(contracts) ? contracts : [])
        .filter(isCurrent)
        .map(c => ({ c, left: contractDaysLeft(c, now) }))
        .filter(x => x.left !== null && x.left >= 0 && x.left <= days)
        .sort((a, b) => a.left - b.left)
        .map(x => ({ ...x.c, daysLeft: x.left }));
}

const num = (v) => {
    const n = Number(v);
    return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : n;
};

/** Sums of cost per currency: [{ currency, total }] largest first. */
function sumByCurrency(list) {
    const map = new Map();
    for (const c of list) {
        const cost = num(c.cost);
        if (cost === null) continue;
        const cur = c.currency || 'TWD';
        map.set(cur, (map.get(cur) || 0) + cost);
    }
    return [...map.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
}

/** "USD 1,200 · TWD 50,000"; '-' for none. Different currencies are never added together. */
export function moneyText(sums) {
    return sums && sums.length ? sums.map(s => formatMoney(s.total, s.currency)).join(' · ') : '-';
}

export function formatMoney(amount, currency) {
    const n = num(amount);
    if (n === null) return '-';
    return `${currency || 'TWD'} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Figures of one type's contracts (trash left out): counts by status, the spend of the running terms and what is
 * due for renewal within RENEWAL_WINDOW_DAYS (per currency).
 */
export function contractKpis(contracts, type, now = Date.now()) {
    const list = (Array.isArray(contracts) ? contracts : []).filter(c => c && !c.deletedAt && (!type || c.type === type));
    const out = { total: list.length, Active: 0, Expiring: 0, Expired: 0, Renewed: 0, Unknown: 0, renewalCount: 0 };
    const running = [];
    const due = [];
    for (const c of list) {
        const status = contractStatus(c, now);
        out[status] += 1;
        const left = contractDaysLeft(c, now);
        if (left !== null && left >= 0 && ymdIndex(c.startDate) !== null && ymdIndex(c.startDate) <= todayIndex(now)) running.push(c);
        if (isCurrent(c) && left !== null && left >= 0 && left <= RENEWAL_WINDOW_DAYS) due.push(c);
    }
    out.renewalCount = due.length;
    out.renewalDue = sumByCurrency(due);
    out.spend = sumByCurrency(running);
    return out;
}

/** Seats of a software license: the used count entered by hand, else the linked devices. null without seats. */
export function seatUsage(c) {
    if (!c || c.type !== 'Software Licenses') return null;
    const total = num(c.seats);
    if (!total) return null;
    const manual = num(c.seatsUsed);
    const used = manual !== null ? manual : (Array.isArray(c.linkedDevices) ? c.linkedDevices.length : 0);
    return { used, total, source: manual !== null ? 'manual' : 'devices', over: used > total, pct: Math.min(100, Math.round((used / total) * 100)) };
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Hardware issues of the contract's devices (linked device or the warranty's serial number), open ones first. */
export function relatedIssues(c, issues) {
    if (!c) return [];
    const ids = new Set(Array.isArray(c.linkedDevices) ? c.linkedDevices : []);
    const sn = c.type === 'Hardware Warranties' ? norm(c.serialNumber) : '';
    const order = { Open: 0, Processing: 1, Closed: 2 };
    return (Array.isArray(issues) ? issues : [])
        .filter(i => i && ((i.deviceId && ids.has(i.deviceId)) || (sn && norm(i.sn) === sn)))
        .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || String(b.date || '').localeCompare(String(a.date || '')));
}

/** Names of the linked devices (the id when the device is gone). */
export function deviceNames(c, devicesById) {
    return (Array.isArray(c && c.linkedDevices) ? c.linkedDevices : []).map(id => {
        const d = devicesById && devicesById.get(id);
        return d ? d.hostname || id : id;
    });
}

/** Contracts of a tab ('Trash' = the deleted ones) matching the search, status and vendor filters. */
export function filterContracts(contracts, { tab, q = '', status = 'ALL', vendor = 'ALL' } = {}, now = Date.now(), devicesById = null) {
    const term = norm(q);
    return (Array.isArray(contracts) ? contracts : []).filter(c => {
        if (!c) return false;
        if (tab === 'Trash' ? !c.deletedAt : (c.deletedAt || (tab && c.type !== tab))) return false;
        if (status !== 'ALL' && tab !== 'Trash' && contractStatus(c, now) !== status) return false;
        if (vendor !== 'ALL' && (c.vendor || '') !== vendor) return false;
        if (!term) return true;
        const hay = [c.name, c.vendor, c.serialNumber, c.licenseKey, c.notes, c.contact, ...deviceNames(c, devicesById)];
        return hay.some(v => norm(v).includes(term));
    });
}

export const SORTS = { end: 'Ending first', name: 'Name', vendor: 'Vendor', cost: 'Cost (high first)', updated: 'Recently changed' };

/** Sorted copy. 'end': the soonest end first (renewed and undated last). */
export function sortContracts(list, key = 'end', now = Date.now()) {
    const arr = [...(list || [])];
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const cmp = {
        end: (a, b) => {
            const rank = (c) => (c.renewedTo ? 1 : 0);
            const la = contractDaysLeft(a, now), lb = contractDaysLeft(b, now);
            return rank(a) - rank(b) || (la === null) - (lb === null) || (la ?? 0) - (lb ?? 0) || byName(a, b);
        },
        name: byName,
        vendor: (a, b) => String(a.vendor || '').localeCompare(String(b.vendor || '')) || byName(a, b),
        cost: (a, b) => (num(b.cost) ?? -1) - (num(a.cost) ?? -1) || byName(a, b),
        updated: (a, b) => String(b.updatedAt || b.deletedAt || '').localeCompare(String(a.updatedAt || a.deletedAt || '')) || byName(a, b),
    }[key] || (() => 0);
    return arr.sort(cmp);
}

/** Vendors in use, sorted. */
export function vendorsOf(contracts) {
    return [...new Set((contracts || []).map(c => c && c.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Form of the next term: same fields, starting the day after the end, as long as the current term. */
export function renewalDraft(c) {
    const s = ymdIndex(c.startDate);
    const e = ymdIndex(c.endDate);
    const start = e !== null ? e + 1 : null;
    const length = s !== null && e !== null ? e - s : 364;
    return {
        ...emptyContract(c.type),
        type: c.type, name: c.name || '', vendor: c.vendor || '', serialNumber: c.serialNumber || '', contact: c.contact || '',
        seats: c.seats ?? '', seatsUsed: c.seatsUsed ?? '', licenseKey: c.licenseKey || '', currency: c.currency || 'TWD', cost: c.cost ?? '',
        linkedDevices: Array.isArray(c.linkedDevices) ? [...c.linkedDevices] : [],
        startDate: start !== null ? indexYmd(start) : '',
        endDate: start !== null ? indexYmd(start + length) : '',
        renewedFrom: c.id,
    };
}

/** A blank form. */
export function emptyContract(type = 'Hardware Warranties') {
    return {
        id: '', type, name: '', vendor: '', startDate: '', endDate: '', linkedDevices: [], licenseKey: '', serialNumber: '',
        seats: '', seatsUsed: '', cost: '', currency: 'TWD', contact: '', notes: '',
    };
}

/** The editable fields of a stored contract, for the edit form. */
export function editDraft(c) {
    const base = emptyContract(c.type);
    const out = { ...base };
    for (const k of Object.keys(base)) if (c[k] !== undefined && c[k] !== null) out[k] = Array.isArray(c[k]) ? [...c[k]] : c[k];
    out.id = c.id;
    out.expectedUpdatedAt = c.updatedAt || '';
    return out;
}

/** Form problems found before saving (the server checks again): '' when fine. */
export function formProblem(f) {
    if (!f.name || !String(f.name).trim()) return 'Enter a name.';
    if (!f.vendor || !String(f.vendor).trim()) return 'Enter the vendor.';
    const s = ymdIndex(f.startDate), e = ymdIndex(f.endDate);
    if (s === null || e === null) return 'Enter the start and end dates.';
    if (e < s) return 'The end date is before the start date.';
    if (f.type === 'Hardware Warranties' && !String(f.serialNumber || '').trim() && !(f.linkedDevices || []).length) {
        return 'Enter the serial number or link a device, so the warranty can be found from hardware issues.';
    }
    return '';
}

/** CSV of the listed contracts (Excel-safe cells, UTF-8 BOM added by the caller). */
export function contractsCsv(list, now = Date.now(), devicesById = null) {
    const head = ['Type', 'Name', 'Vendor', 'Status', 'Start', 'End', 'Days left', 'Cost', 'Currency', 'Serial number', 'Seats', 'Seats used', 'Linked devices', 'Contact', 'Notes', 'File', 'Updated by', 'Updated at'];
    const rows = (list || []).map(c => {
        const seats = seatUsage(c);
        return [
            c.type, c.name, c.vendor, c.deletedAt ? 'In trash' : contractStatus(c, now), c.startDate, c.endDate, contractDaysLeft(c, now) ?? '',
            c.cost ?? '', c.currency || '', c.serialNumber || '', c.seats ?? '', seats ? seats.used : '', deviceNames(c, devicesById).join('; '),
            c.contact || '', c.notes || '', c.originalFileName || '', c.updatedBy || c.createdBy || '', c.updatedAt || c.createdAt || '',
        ];
    });
    return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** Devices grouped for the picker: [{ key, label, devices }] by data center and rack, matching the search. */
export function groupDevices(devices, q = '', selected = null) {
    const term = norm(q);
    const groups = new Map();
    for (const d of devices || []) {
        if (selected && !selected.has(d.id)) continue;
        if (term && ![d.hostname, d.model, d.sn, d.rackName, d.dcName].some(v => norm(v).includes(term))) continue;
        const key = `${d.dcId}\u0000${d.rackId}`;
        if (!groups.has(key)) groups.set(key, { key, label: `${d.dcName || d.dcId} · ${d.rackName || d.rackId}`, devices: [] });
        groups.get(key).devices.push(d);
    }
    const out = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    out.forEach(g => g.devices.sort((a, b) => (Number(b.u) || 0) - (Number(a.u) || 0)));
    return out;
}
