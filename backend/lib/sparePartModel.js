// Spare parts: item fields, stock movements (with reasons and optional serial numbers), stock counts and the
// restock rule. Pure functions over the item objects stored in data_center/spare_parts.json.
// `quantity` is the one stock field (legacy `qty` / `stock` are folded into it on read); it only changes through a
// movement or a count, each recorded in `history` with who, when, why and the stock before / after.

const DEFAULT_CATEGORIES = [
    'Memory', 'SSD', 'NVMe', 'HDD', 'Boot / Flash', 'RAID / HBA', 'Network Card', 'FC HBA', 'Transceiver', 'Cable',
    'Power Supply', 'Fan', 'Server Parts', 'UPS / Power',
];
const CONDITIONS = ['New', 'Refurbished', 'Used'];
const CURRENCIES = ['TWD', 'USD', 'EUR', 'JPY', 'CNY'];
const IN_REASONS = ['Purchase', 'RMA replacement', 'Returned unused', 'Transfer in', 'Initial stock', 'Other'];
const OUT_REASONS = ['Repair', 'Sent for RMA', 'Transfer out', 'Scrapped', 'Other'];
const TEXT_FIELDS = {
    name: 200, category: 100, model: 200, spec: 1000, location: 200, vendor: 100, partNumber: 100,
    compatibleWith: 1000, supplier: 200, notes: 2000,
};
const MAX_SERIALS = 500;
const SERIAL_MAX = 100;
const NOTE_MAX = 500;

function finiteNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

/** Stored shape of an item: a finite whole quantity, history and serial lists. */
function normalizeSpareItem(item) {
    const { qty, stock, ...rest } = item || {};
    const q = finiteNumber(rest.quantity) ?? finiteNumber(qty) ?? finiteNumber(stock) ?? 0;
    return {
        ...rest,
        quantity: Math.max(0, Math.floor(q)),
        history: Array.isArray(rest.history) ? rest.history : [],
        serials: Array.isArray(rest.serials) ? rest.serials.filter(s => typeof s === 'string' && s) : [],
    };
}

/**
 * Validates the editable fields. partial (PATCH): only the keys present. Unknown and server-owned keys (id,
 * quantity, history, serials, stamps) are dropped. -> { error } or { fields }
 */
function cleanSpareFields(body, { partial = false } = {}) {
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const fields = {};
    for (const [k, max] of Object.entries(TEXT_FIELDS)) {
        if (!has(k)) continue;
        const v = src[k];
        if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') return { error: `${k} must be text` };
        const s = v === null || v === undefined ? '' : String(v).trim();
        if (s.length > max) return { error: `${k} is limited to ${max} characters` };
        fields[k] = s;
    }
    if ((!partial || has('name')) && !fields.name) return { error: 'name is required' };
    if ((!partial || has('category')) && !fields.category) return { error: 'category is required' };
    for (const k of ['minStock', 'reorderQty']) {
        if (!has(k)) continue;
        const n = src[k] === '' || src[k] === null ? 0 : finiteNumber(src[k]);
        if (n === null || !Number.isInteger(n) || n < 0 || n > 1e6) return { error: `${k} must be a whole number from 0 to 1000000` };
        fields[k] = n;
    }
    if (has('unitPrice')) {
        const n = src.unitPrice === '' || src.unitPrice === null ? 0 : finiteNumber(src.unitPrice);
        if (n === null || n < 0 || n > 1e10) return { error: 'unitPrice must be a number >= 0' };
        fields.unitPrice = n;
    }
    if (has('condition')) {
        const v = src.condition === null || src.condition === undefined || src.condition === '' ? 'New' : src.condition;
        if (!CONDITIONS.includes(v)) return { error: `condition must be one of ${CONDITIONS.join(', ')}` };
        fields.condition = v;
    }
    if (has('currency')) {
        const v = src.currency === null || src.currency === undefined || src.currency === '' ? 'TWD' : src.currency;
        if (!CURRENCIES.includes(v)) return { error: `currency must be one of ${CURRENCIES.join(', ')}` };
        fields.currency = v;
    }
    return { fields };
}

/** Serial numbers from a list or text (comma / newline separated): trimmed, unique. -> { error } or { serials } */
function cleanSerials(input) {
    if (input === undefined || input === null || input === '') return { serials: [] };
    const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\n,;]+/) : null;
    if (!raw || raw.some(s => typeof s !== 'string')) return { error: 'serials must be a list of serial numbers' };
    const out = [];
    for (const s of raw) {
        const v = s.trim();
        if (!v) continue;
        if (v.length > SERIAL_MAX) return { error: `A serial number is limited to ${SERIAL_MAX} characters` };
        if (!out.includes(v)) out.push(v);
    }
    if (out.length > MAX_SERIALS) return { error: `At most ${MAX_SERIALS} serial numbers at a time` };
    return { serials: out };
}

/** 'Out' (none left), 'Low' (at or below the minimum), 'OK'. */
function stockStatus(item) {
    const q = Number(item && item.quantity) || 0;
    const min = Number(item && item.minStock) || 0;
    if (q <= 0) return 'Out';
    if (min > 0 && q <= min) return 'Low';
    return 'OK';
}

/** Needs ordering: a minimum is set and the stock is at or below it. */
function needsRestock(item) {
    const min = Number(item && item.minStock) || 0;
    return min > 0 && (Number(item.quantity) || 0) <= min;
}

/**
 * Applies a stock movement to `item` in place (no save). Returns an error message or null.
 * IN serials join the on-hand list (one may not already be there); OUT serials must be on hand and leave it.
 * Serials are optional and at most `qty` of them.
 */
function applyStockMovement(item, { type, qty, reason, note, issueId, serials, username }) {
    if (type !== 'IN' && type !== 'OUT') return "type must be 'IN' or 'OUT'";
    if (!isPositiveInt(qty)) return 'qty must be a positive integer';
    const reasons = type === 'IN' ? IN_REASONS : OUT_REASONS;
    const why = reason === undefined || reason === null || reason === '' ? (type === 'IN' ? 'Purchase' : 'Other') : reason;
    if (!reasons.includes(why)) return `reason must be one of ${reasons.join(', ')}`;
    if (type === 'OUT' && qty > item.quantity) {
        return `Insufficient stock for "${item.name}": ${item.quantity} on hand, ${qty} requested`;
    }
    const text = note === undefined || note === null ? '' : String(note).trim();
    if (text.length > NOTE_MAX) return `note is limited to ${NOTE_MAX} characters`;
    const sn = cleanSerials(serials);
    if (sn.error) return sn.error;
    if (sn.serials.length > qty) return `${sn.serials.length} serial numbers given for ${qty} part(s)`;
    const onHand = Array.isArray(item.serials) ? item.serials : [];
    if (type === 'IN') {
        const dup = sn.serials.find(s => onHand.includes(s));
        if (dup) return `Serial number ${dup} is already in stock`;
    } else {
        const missing = sn.serials.find(s => !onHand.includes(s));
        if (missing) return `Serial number ${missing} is not in stock`;
    }
    const before = item.quantity;
    item.quantity = type === 'IN' ? before + qty : before - qty;
    item.serials = type === 'IN' ? [...onHand, ...sn.serials] : onHand.filter(s => !sn.serials.includes(s));
    item.history = [...(item.history || []), {
        date: new Date().toISOString(),
        type,
        qty,
        reason: why,
        note: text,
        user: username,
        before,
        after: item.quantity,
        ...(issueId ? { issueId: String(issueId).slice(0, 100) } : {}),
        ...(sn.serials.length ? { serials: sn.serials } : {}),
    }];
    return null;
}

/**
 * Stock count: sets the counted quantity and records the difference (type COUNT, qty = signed change). serials,
 * when given, replace the on-hand serial list (at most `actual` of them). Returns an error message or null.
 */
function applyStockCount(item, { actual, note, serials, username }) {
    const n = typeof actual === 'string' && actual.trim() !== '' ? Number(actual) : actual;
    if (!Number.isInteger(n) || n < 0 || n > 1e7) return 'actual must be a whole number >= 0';
    const text = note === undefined || note === null ? '' : String(note).trim();
    if (text.length > NOTE_MAX) return `note is limited to ${NOTE_MAX} characters`;
    let list = null;
    if (serials !== undefined && serials !== null) {
        const sn = cleanSerials(serials);
        if (sn.error) return sn.error;
        if (sn.serials.length > n) return `${sn.serials.length} serial numbers given for ${n} part(s)`;
        list = sn.serials;
    }
    const before = item.quantity;
    item.quantity = n;
    if (list) item.serials = list;
    else if (Array.isArray(item.serials) && item.serials.length > n) item.serials = item.serials.slice(0, n);
    item.history = [...(item.history || []), {
        date: new Date().toISOString(), type: 'COUNT', qty: n - before, reason: 'Stock count', note: text, user: username, before, after: n,
    }];
    return null;
}

module.exports = {
    DEFAULT_CATEGORIES, CONDITIONS, CURRENCIES, IN_REASONS, OUT_REASONS,
    finiteNumber, isPositiveInt, normalizeSpareItem, cleanSpareFields, cleanSerials, stockStatus, needsRestock,
    applyStockMovement, applyStockCount,
};
