// Read-only queries over the licenses: filters, the sales report (summary per sales person per currency, detail rows),
// dashboard numbers, the renewal board, trial conversion and the weekly-digest data. Revoked licenses never count in
// totals or on the renewal board; amounts are summed per currency (no exchange rates).
const R = require('./rules');

const { invalid } = R;
const KINDS = ['new', 'renewal'];
const likeArg = (q) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * from / to of a filter: explicit { from, to } (YYYY-MM-DD, both optional) or { period: month|quarter|year, date }
 * (date defaults to filter.today, which the store fills in with its today). Throws invalid for bad dates or from > to.
 */
function range(filter = {}) {
    let { from = null, to = null } = filter;
    if (filter.period) ({ from, to } = R.periodRange(filter.period, filter.date || filter.today));
    if (from === '') from = null;
    if (to === '') to = null;
    if (from !== null && !R.isRealDate(from)) throw invalid('from', 'From must be a real date (YYYY-MM-DD).');
    if (to !== null && !R.isRealDate(to)) throw invalid('to', 'To must be a real date (YYYY-MM-DD).');
    if (from && to && from > to) throw invalid('to', 'To is before From.');
    return { from, to };
}

/**
 * WHERE clause over `licenses l JOIN customers c LEFT JOIN sales s`: customerId, salesId (id or 'none'), type, kind
 * (new = paid and not a renewal, renewal = paid renewal), from / to / period (issued_at), q, includeRevoked (default true).
 */
function licenseWhere(filter = {}) {
    const where = [];
    const args = [];
    if (filter.customerId !== undefined && filter.customerId !== null && filter.customerId !== '') {
        where.push('l.customer_id = ?');
        args.push(R.id(filter.customerId, { field: 'customerId', label: 'Customer' }));
    }
    if (filter.salesId === 'none') where.push('l.sales_id IS NULL');
    else if (filter.salesId !== undefined && filter.salesId !== null && filter.salesId !== '') {
        where.push('l.sales_id = ?');
        args.push(R.id(filter.salesId, { field: 'salesId', label: 'Sales' }));
    }
    if (filter.type !== undefined && filter.type !== null && filter.type !== '') {
        if (!R.LICENSE_TYPES.includes(filter.type)) throw invalid('type', 'Type must be paid or trial.');
        where.push('l.type = ?');
        args.push(filter.type);
    }
    if (filter.kind !== undefined && filter.kind !== null && filter.kind !== '') {
        if (!KINDS.includes(filter.kind)) throw invalid('kind', 'Kind must be new or renewal.');
        where.push(`l.type = 'paid' AND l.is_renewal = ${filter.kind === 'renewal' ? 1 : 0}`);
    }
    const { from, to } = range(filter);
    if (from) { where.push('l.issued_at >= ?'); args.push(from); }
    if (to) { where.push('l.issued_at <= ?'); args.push(to); }
    const q = typeof filter.q === 'string' ? filter.q.trim() : '';
    if (q) {
        where.push("(l.license_id LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR l.licensed_to LIKE ? ESCAPE '\\' OR l.order_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
        const like = likeArg(q);
        args.push(like, like, like, like, like);
    }
    if (filter.includeRevoked === false) where.push('l.revoked_at IS NULL');
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args, from, to };
}

const emptyLine = () => ({ count: 0, new: 0, renewal: 0, trial: 0, amounts: {} });
function addLine(line, row) {
    line.count += 1;
    if (row.type === 'trial') line.trial += 1;
    else if (row.is_renewal) line.renewal += 1;
    else line.new += 1;
    R.addAmount(line.amounts, row.currency, row.amount);
}

/**
 * Sales report summary (revoked licenses never count). filter: as licenseWhere (from / to / period, salesId, type, kind, q).
 * { from, to, rows: [{ salesId (null = unassigned), salesName, count, new, renewal, trial, amounts: { TWD: n, ... } }],
 *   totals: { count, new, renewal, trial, amounts } } — rows by sales name, unassigned last.
 */
function summary(store, filter = {}) {
    const w = licenseWhere({ today: store.today(), ...filter, includeRevoked: false });
    const rows = store.db.prepare(`SELECT l.sales_id, s.name AS sales_name, l.type, l.is_renewal, l.amount, l.currency
        FROM licenses l JOIN customers c ON c.id = l.customer_id LEFT JOIN sales s ON s.id = l.sales_id ${w.sql}`).all(...w.args);
    const by = new Map();
    const totals = emptyLine();
    for (const r of rows) {
        const k = r.sales_id === null ? 'none' : r.sales_id;
        if (!by.has(k)) by.set(k, { salesId: r.sales_id, salesName: r.sales_name || null, ...emptyLine() });
        addLine(by.get(k), r);
        addLine(totals, r);
    }
    const out = [...by.values()].sort((a, b) => {
        if ((a.salesId === null) !== (b.salesId === null)) return a.salesId === null ? 1 : -1;
        return String(a.salesName).localeCompare(String(b.salesName), 'en', { sensitivity: 'base' });
    });
    return { from: w.from, to: w.to, rows: out, totals };
}

/**
 * Sales report detail rows (licenses, oldest issue first). Revoked licenses only with includeRevoked: true.
 * { from, to, rows: [license] }
 */
function detail(store, filter = {}) {
    const { from, to } = range({ today: store.today(), ...filter });
    const rows = store.listLicenses({ ...filter, period: undefined, from, to, includeRevoked: filter.includeRevoked === true, sort: 'issued' });
    return { from, to, rows };
}

/** Trial conversion: customers with a trial (issued in from..to when given; trials revoked as issued_in_error do not
 *  count) and how many later got a paid license that is not revoked. rate: converted / withTrial (null when none). */
function trialConversion(store, filter = {}) {
    const { from, to } = range({ today: store.today(), ...filter });
    const where = ["t.type = 'trial'", "(t.revoke_reason IS NULL OR t.revoke_reason <> 'issued_in_error')"];
    const args = [];
    if (from) { where.push('t.issued_at >= ?'); args.push(from); }
    if (to) { where.push('t.issued_at <= ?'); args.push(to); }
    const rows = store.db.prepare(`SELECT t.customer_id, c.name AS customer_name, MIN(t.issued_at) AS first_trial,
            (SELECT MIN(p.issued_at) FROM licenses p WHERE p.customer_id = t.customer_id AND p.type = 'paid' AND p.revoked_at IS NULL
                AND p.issued_at >= MIN(t.issued_at)) AS converted_at
        FROM licenses t JOIN customers c ON c.id = t.customer_id WHERE ${where.join(' AND ')}
        GROUP BY t.customer_id ORDER BY first_trial, c.name`).all(...args);
    const customers = rows.map((r) => ({ customerId: r.customer_id, customerName: r.customer_name, firstTrial: r.first_trial, convertedAt: r.converted_at || null }));
    const converted = customers.filter((c) => c.convertedAt).length;
    return { from, to, withTrial: customers.length, converted, rate: customers.length ? converted / customers.length : null, customers };
}

function checkDays(days, max = 366) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > max) throw invalid('days', `Days must be a whole number from 1 to ${max}.`);
    return n;
}

/**
 * Licenses still to follow up: not revoked, format 2, expiring today .. today + days, and not already renewed (no other
 * non-revoked paid license of the customer expires later). Oldest expiry first.
 */
function expiring(store, { today, days, type } = {}) {
    const t = today || store.today();
    const until = R.addDays(t, days);
    const args = [t, until];
    let typeSql = '';
    if (type) {
        if (!R.LICENSE_TYPES.includes(type)) throw invalid('type', 'Type must be paid or trial.');
        typeSql = 'AND l.type = ?';
        args.push(type);
    }
    const sql = `SELECT l.id FROM licenses l WHERE l.revoked_at IS NULL AND l.format = 2 AND l.expires_at >= ? AND l.expires_at <= ? ${typeSql}
        AND NOT EXISTS (SELECT 1 FROM licenses n WHERE n.customer_id = l.customer_id AND n.id <> l.id AND n.revoked_at IS NULL
            AND n.format = 2 AND n.type = 'paid' AND n.expires_at > l.expires_at)
        ORDER BY l.expires_at, l.license_id`;
    const rows = store.db.prepare(sql).all(...args).map((r) => {
        const l = store.getLicenseByRowId(r.id);
        return Object.assign(l, R.computeStatus(l, t));
    });
    return { today: t, until, rows };
}

/** Renewal board: expiring(...) for days (default 30; the page offers 30 / 60 / 90). { today, days, until, rows } */
function renewalBoard(store, { days = 30, type, today } = {}) {
    const d = checkDays(days);
    return { days: d, ...expiring(store, { today, days: d, type }) };
}

/**
 * Dashboard numbers on `today` (default the store's today):
 *   month / quarter: { from, to, issued, new, renewal, trial, amounts } (revoked excluded),
 *   trials: { active (valid now, including expiring soon), expiringSoon (<= 7 days), list (valid trials, soonest first),
 *             conversion (trialConversion over all time) }
 */
function dashboard(store, { today } = {}) {
    const t = today || store.today();
    const period = (kind) => {
        const s = summary(store, { period: kind, date: t });
        return { from: s.from, to: s.to, issued: s.totals.count, new: s.totals.new, renewal: s.totals.renewal, trial: s.totals.trial, amounts: s.totals.amounts };
    };
    const list = store.db.prepare("SELECT id FROM licenses WHERE type = 'trial' AND revoked_at IS NULL AND format = 2 AND expires_at >= ? ORDER BY expires_at, license_id")
        .all(t).map((r) => { const l = store.getLicenseByRowId(r.id); return Object.assign(l, R.computeStatus(l, t)); });
    return {
        today: t,
        month: period('month'),
        quarter: period('quarter'),
        trials: { active: list.length, expiringSoon: list.filter((l) => l.status === R.STATUS.SOON).length, list, conversion: trialConversion(store) },
    };
}

/**
 * Weekly digest data: licenses to follow up within `days` (default 90; see expiring), grouped by sales person.
 *   groups: every sales person with licenses (active or not, with or without email) plus { salesId: null } for unassigned
 *           ones, by name, unassigned last — for the MAIL_ADMIN summary;
 *   recipients: the groups of active sales people with an email — one mail each (none for people without licenses).
 * { today, until, days, total, licenses, groups: [{ salesId, salesName, email, active, licenses }], recipients }
 */
function digestData(store, { today, days = R.DIGEST_DAYS } = {}) {
    const d = checkDays(days);
    const e = expiring(store, { today, days: d });
    const by = new Map();
    for (const l of e.rows) {
        const k = l.salesId === null ? 'none' : l.salesId;
        if (!by.has(k)) {
            const s = l.salesId === null ? null : store.getSales(l.salesId);
            by.set(k, { salesId: l.salesId, salesName: s ? s.name : null, email: s ? s.email : null, active: s ? s.active : false, licenses: [] });
        }
        by.get(k).licenses.push(l);
    }
    const groups = [...by.values()].sort((a, b) => {
        if ((a.salesId === null) !== (b.salesId === null)) return a.salesId === null ? 1 : -1;
        return String(a.salesName).localeCompare(String(b.salesName), 'en', { sensitivity: 'base' });
    });
    return {
        today: e.today, until: e.until, days: d, total: e.rows.length, licenses: e.rows, groups,
        recipients: groups.filter((g) => g.salesId !== null && g.active && g.email),
    };
}

module.exports = { KINDS, range, licenseWhere, summary, detail, trialConversion, renewalBoard, dashboard, digestData, expiring };
