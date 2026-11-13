// Pure helpers of the Spare Parts page (and the Home low-stock banner). Rules match backend/lib/sparePartModel.js.
import { csvCell } from './hwIssueUtils.js';

export const CONDITIONS = ['New', 'Refurbished', 'Used'];
export const CURRENCIES = ['TWD', 'USD', 'EUR', 'JPY', 'CNY'];
export const IN_REASONS = ['Purchase', 'RMA replacement', 'Returned unused', 'Transfer in', 'Other'];
export const OUT_REASONS = ['Repair', 'Sent for RMA', 'Transfer out', 'Scrapped', 'Other'];
const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v) => {
    const n = Number(v);
    return v === '' || v === null || v === undefined || !Number.isFinite(n) ? 0 : n;
};

/** 'Out' (none left), 'Low' (at or below the minimum), 'OK'. */
export function stockStatus(item) {
    const q = num(item && item.quantity);
    const min = num(item && item.minStock);
    if (q <= 0) return 'Out';
    if (min > 0 && q <= min) return 'Low';
    return 'OK';
}

/** A minimum is set and the stock is at or below it. */
export function needsRestock(item) {
    const min = num(item && item.minStock);
    return min > 0 && num(item.quantity) <= min;
}

/** Quantity to order: the set reorder quantity, else back up to twice the minimum. 0 when not needed. */
export function suggestedOrder(item) {
    if (!needsRestock(item)) return 0;
    const set = num(item.reorderQty);
    if (set > 0) return set;
    return Math.max(1, num(item.minStock) * 2 - num(item.quantity));
}

/** Parts for the Home banner: needing restock, out of stock first. */
export function lowStockItems(items) {
    return (Array.isArray(items) ? items : []).filter(i => i && needsRestock(i))
        .sort((a, b) => num(a.quantity) - num(b.quantity) || String(a.name || '').localeCompare(String(b.name || '')));
}

/** Units used (repair, RMA, scrapped, transfer out) within `days`. */
export function usedWithin(item, days, now = Date.now()) {
    const from = now - days * DAY_MS;
    return (item.history || []).reduce((sum, h) => {
        if (h.type !== 'OUT') return sum;
        const t = Date.parse(h.date);
        return Number.isFinite(t) && t >= from ? sum + num(h.qty) : sum;
    }, 0);
}

/** Last movement time (ms) or 0. */
export function lastMovedAt(item) {
    const h = (item.history || []).at(-1);
    const t = h ? Date.parse(h.date) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/** "USD 1,200 · TWD 50,000"; '-' for none. */
export function moneyText(sums) {
    return sums && sums.length ? sums.map(s => `${s.currency} ${s.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`).join(' · ') : '-';
}

/** Value of the stock per currency, largest first. */
export function stockValue(items) {
    const map = new Map();
    for (const i of items || []) {
        const v = num(i.quantity) * num(i.unitPrice);
        if (!v) continue;
        const cur = i.currency || 'TWD';
        map.set(cur, (map.get(cur) || 0) + v);
    }
    return [...map.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
}

/** Figures of the page. */
export function spareKpis(items, now = Date.now()) {
    const list = Array.isArray(items) ? items : [];
    return {
        parts: list.length,
        units: list.reduce((s, i) => s + num(i.quantity), 0),
        low: list.filter(i => stockStatus(i) === 'Low').length,
        out: list.filter(i => stockStatus(i) === 'Out').length,
        restock: list.filter(needsRestock).length,
        value: stockValue(list),
        used30: list.reduce((s, i) => s + usedWithin(i, 30, now), 0),
    };
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Items matching the category, search, stock status, vendor and location filters. */
export function filterSpares(items, { category = 'ALL', q = '', status = 'ALL', vendor = 'ALL', location = 'ALL' } = {}) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    return (Array.isArray(items) ? items : []).filter(i => {
        if (!i) return false;
        if (category !== 'ALL' && i.category !== category) return false;
        if (status === 'RESTOCK' ? !needsRestock(i) : status !== 'ALL' && stockStatus(i) !== status) return false;
        if (vendor !== 'ALL' && (i.vendor || '') !== vendor) return false;
        if (location !== 'ALL' && (i.location || '') !== location) return false;
        if (!words.length) return true;
        const hay = [i.name, i.category, i.model, i.partNumber, i.spec, i.location, i.vendor, i.compatibleWith, i.supplier, i.notes, ...(i.serials || [])].map(norm).join(' ');
        return words.every(w => hay.includes(w));
    });
}

export const SORTS = { restock: 'Needs restock first', name: 'Name', quantity: 'Quantity (low first)', value: 'Value (high first)', moved: 'Recently moved' };

/** Sorted copy. */
export function sortSpares(list, key = 'restock') {
    const arr = [...(list || [])];
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const rank = { Out: 0, Low: 1, OK: 2 };
    const cmp = {
        restock: (a, b) => (needsRestock(b) - needsRestock(a)) || rank[stockStatus(a)] - rank[stockStatus(b)] || byName(a, b),
        name: byName,
        quantity: (a, b) => num(a.quantity) - num(b.quantity) || byName(a, b),
        value: (a, b) => num(b.quantity) * num(b.unitPrice) - num(a.quantity) * num(a.unitPrice) || byName(a, b),
        moved: (a, b) => lastMovedAt(b) - lastMovedAt(a) || byName(a, b),
    }[key] || byName;
    return arr.sort(cmp);
}

/** Distinct non-empty values of a field, sorted. */
export function valuesOf(items, key) {
    return [...new Set((items || []).map(i => i && i[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

/** Items per category, with the categories that have none (list order first, then unknown ones). */
export function categoryCounts(categories, items) {
    const counts = new Map((categories || []).map(c => [c, { name: c, parts: 0, alerts: 0 }]));
    for (const i of items || []) {
        const key = i.category || '(none)';
        if (!counts.has(key)) counts.set(key, { name: key, parts: 0, alerts: 0, unlisted: true });
        const c = counts.get(key);
        c.parts += 1;
        if (needsRestock(i)) c.alerts += 1;
    }
    return [...counts.values()];
}

/** Serial numbers from text (comma / semicolon / newline separated), trimmed and unique. */
export function parseSerials(text) {
    const out = [];
    for (const s of String(text || '').split(/[\n,;]+/)) {
        const v = s.trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

/** A blank form. */
export function emptySpare(category = '') {
    return {
        id: '', category, name: '', model: '', partNumber: '', vendor: '', condition: 'New', spec: '', compatibleWith: '',
        location: '', supplier: '', minStock: 1, reorderQty: '', unitPrice: '', currency: 'TWD', notes: '', quantity: 0, serialsText: '',
    };
}

/** The form for a catalog entry. */
export function spareFromCatalog(entry, extra = {}) {
    return { ...emptySpare(entry.category), name: entry.name, spec: entry.spec, minStock: entry.minStock ?? 1, ...extra };
}

/** The editable fields of a stored item, for the edit form. */
export function spareEditDraft(item) {
    const base = emptySpare(item.category);
    const out = { ...base };
    for (const k of Object.keys(base)) if (item[k] !== undefined && item[k] !== null) out[k] = item[k];
    out.id = item.id;
    out.expectedUpdatedAt = item.updatedAt || '';
    out.serialsText = '';
    return out;
}

/** Body of a create / update request from the form. */
export function spareBody(form, { create }) {
    const keys = ['name', 'category', 'model', 'partNumber', 'vendor', 'condition', 'spec', 'compatibleWith', 'location', 'supplier', 'minStock', 'reorderQty', 'unitPrice', 'currency', 'notes'];
    const body = {};
    for (const k of keys) body[k] = typeof form[k] === 'string' ? form[k].trim() : form[k];
    if (create) {
        body.quantity = Number(form.quantity) || 0;
        const serials = parseSerials(form.serialsText);
        if (serials.length) body.serials = serials;
    } else if (form.expectedUpdatedAt) {
        body.expectedUpdatedAt = form.expectedUpdatedAt;
    }
    return body;
}

/** Form problems found before saving (the server checks again): '' when fine. */
export function spareFormProblem(form) {
    if (!String(form.name || '').trim()) return 'Enter a name.';
    if (!String(form.category || '').trim()) return 'Choose a category.';
    for (const k of ['minStock', 'reorderQty', 'quantity']) {
        const v = form[k];
        if (v !== '' && v !== null && v !== undefined && (!Number.isInteger(Number(v)) || Number(v) < 0)) return `${k} must be a whole number of 0 or more.`;
    }
    if (form.unitPrice !== '' && form.unitPrice !== null && form.unitPrice !== undefined && !(Number(form.unitPrice) >= 0)) return 'The unit price must be 0 or more.';
    const serials = parseSerials(form.serialsText);
    if (!form.id && serials.length > (Number(form.quantity) || 0)) return `${serials.length} serial numbers for ${Number(form.quantity) || 0} part(s).`;
    return '';
}

/** Hardware issues that used the part: [{ issue, qty, at, user }] newest first. */
export function issuesUsing(item, issues) {
    const out = [];
    for (const issue of issues || []) {
        for (const u of Array.isArray(issue && issue.sparePartUsages) ? issue.sparePartUsages : []) {
            if (u && u.partId === item.id) out.push({ issue, qty: u.qty, at: u.at, user: u.user });
        }
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/** Units booked out per month over the last `months` months: [{ label: 'YYYY-MM', qty }], oldest first. */
export function monthlyUsage(item, months = 12, now = Date.now()) {
    const d = new Date(now);
    const buckets = [];
    for (let k = months - 1; k >= 0; k--) {
        const m = new Date(d.getFullYear(), d.getMonth() - k, 1);
        buckets.push({ label: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, qty: 0 });
    }
    const index = new Map(buckets.map((b, idx) => [b.label, idx]));
    for (const h of item.history || []) {
        if (h.type !== 'OUT') continue;
        const t = new Date(h.date);
        if (Number.isNaN(t.getTime())) continue;
        const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
        if (index.has(key)) buckets[index.get(key)].qty += num(h.qty);
    }
    return buckets;
}

/** CSV of the listed parts (Excel-safe cells; the caller adds the UTF-8 BOM). */
export function sparesCsv(items, now = Date.now()) {
    const head = ['Category', 'Name', 'Vendor', 'Part number', 'Model', 'Condition', 'Spec', 'Compatible with', 'Location', 'Supplier', 'Quantity', 'Min stock', 'Status', 'Suggested order', 'Unit price', 'Currency', 'Stock value', 'Used (30 days)', 'Serial numbers', 'Notes'];
    const rows = (items || []).map(i => [
        i.category, i.name, i.vendor || '', i.partNumber || '', i.model || '', i.condition || '', i.spec || '', i.compatibleWith || '', i.location || '', i.supplier || '',
        num(i.quantity), num(i.minStock), stockStatus(i), suggestedOrder(i) || '', num(i.unitPrice) || '', i.currency || 'TWD', num(i.quantity) * num(i.unitPrice) || '',
        usedWithin(i, 30, now), (i.serials || []).join('; '), i.notes || '',
    ]);
    return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** CSV of what to order: parts needing restock with the suggested quantity and estimated cost. */
export function reorderCsv(items) {
    const head = ['Category', 'Name', 'Vendor', 'Part number', 'Supplier', 'On hand', 'Min stock', 'Order qty', 'Unit price', 'Currency', 'Estimated cost'];
    const rows = lowStockItems(items).map(i => {
        const q = suggestedOrder(i);
        return [i.category, i.name, i.vendor || '', i.partNumber || '', i.supplier || '', num(i.quantity), num(i.minStock), q, num(i.unitPrice) || '', i.currency || 'TWD', q * num(i.unitPrice) || ''];
    });
    return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
