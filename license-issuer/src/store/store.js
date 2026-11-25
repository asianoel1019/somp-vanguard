// The license issuer's database (SQLite, node:sqlite): sales people, customers, plans, licenses, their events and the
// settings. The Markdown registry next to it is a generated read-only copy (registry.js), rewritten after every change
// to the data it shows. All methods are synchronous. Refusals throw StoreError (code, message, field, status).
const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'scripts', 'licenseIssuerCore'));
const R = require('./rules');
const { openDatabase } = require('./sqlite');
const { migrate, SCHEMA_VERSION } = require('./schema');
const registry = require('./registry');
const reports = require('./reports');
const backup = require('./backup');

const { StoreError, invalid } = R;
const SETTING_KEYS = {
    mailSubject: 'mail_subject', mailBody: 'mail_body', digestWeekday: 'digest_weekday', digestTime: 'digest_time',
    defaultCurrency: 'default_currency', lastDigestWeek: 'last_digest_week',
};
const IMPORT_KEY = 'registry_import';

const LICENSE_SELECT = `
SELECT l.*, c.name AS customer_name, s.name AS sales_name, s.email AS sales_email, p.name AS plan_name,
    r.license_id AS replaces_text,
    (SELECT n.license_id FROM licenses n WHERE n.replaces_license_id = l.id ORDER BY n.id DESC LIMIT 1) AS replaced_by_text
FROM licenses l
JOIN customers c ON c.id = l.customer_id
LEFT JOIN sales s ON s.id = l.sales_id
LEFT JOIN plans p ON p.id = l.plan_id
LEFT JOIN licenses r ON r.id = l.replaces_license_id`;

const bool = (v) => v === 1 || v === true;

function salesFromRow(r) {
    return r ? { id: r.id, name: r.name, email: r.email, active: bool(r.active), createdAt: r.created_at,
        licenseCount: r.license_count === undefined ? undefined : r.license_count } : null;
}
function planFromRow(r) {
    return r ? { id: r.id, name: r.name, type: r.type, termValue: r.term_value, termUnit: r.term_unit, price: r.price,
        currency: r.currency, active: bool(r.active), createdAt: r.created_at } : null;
}
function customerFromRow(r) {
    if (!r) return null;
    const c = {
        id: r.id, name: r.name, taxId: r.tax_id, address: r.address, contactPerson: r.contact_person, phone: r.phone, email: r.email,
        defaultSalesId: r.default_sales_id, defaultSalesName: r.default_sales_name || null, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.license_count !== undefined) { c.licenseCount = r.license_count; c.nextExpiry = r.next_expiry || null; }
    return c;
}
function licenseFromRow(r, today) {
    if (!r) return null;
    const l = {
        id: r.id, licenseId: r.license_id, customerId: r.customer_id, customerName: r.customer_name, licensedTo: r.licensed_to,
        planId: r.plan_id, planName: r.plan_name || null, type: r.type, format: r.format, issuedAt: r.issued_at, expiresAt: r.expires_at,
        salesId: r.sales_id, salesName: r.sales_name || null, salesEmail: r.sales_email || null, amount: r.amount, currency: r.currency,
        orderNo: r.order_no, isRenewal: bool(r.is_renewal), replacesLicenseId: r.replaces_text || null, replacedByLicenseId: r.replaced_by_text || null,
        revokedAt: r.revoked_at, revokeReason: r.revoke_reason, revokeNote: r.revoke_note, filePath: r.file_path,
        fileName: r.file_path ? path.win32.basename(r.file_path) : null, sha12: r.sha12, signedAt: r.signed_at, keyId: r.key_id,
        contactVendor: r.contact_vendor, contactEmail: r.contact_email, createdAt: r.created_at,
    };
    return Object.assign(l, R.computeStatus(l, today));
}
function eventFromRow(r) {
    let detail = {};
    try { detail = r.detail ? JSON.parse(r.detail) : {}; } catch { detail = { text: r.detail }; }
    return { id: r.id, licenseId: r.license_text, type: r.type, at: r.at, detail };
}

class Store {
    /**
     * Use openStore(). file: the database; registryFile: the generated Markdown copy (optional);
     * now(): Date (clock, for tests); lock: lockRegistry options ({ timeoutMs, staleMs }).
     */
    constructor(db, { file, registryFile = null, now = () => new Date(), lock = {} }) {
        this.db = db;
        this.file = file;
        this.registryFile = registryFile;
        this.now = now;
        this.lockOptions = lock;
        this.depth = 0;
        this.registryError = null;
        this.registryAt = null;
    }

    close() { if (this.db && this.db.isOpen !== false) { try { this.db.close(); } catch { /* closed */ } } }

    /** Local date YYYY-MM-DD of the store clock. */
    today() { return R.localDate(this.now()); }
    /** Local date-time with offset of the store clock (all *_at columns). */
    stamp() { return R.localIso(this.now()); }

    /** Runs fn() in a transaction (BEGIN IMMEDIATE; a savepoint when nested); rolls back when it throws. */
    tx(fn) {
        const nested = this.depth > 0;
        const sp = `sp${this.depth}`;
        this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
        this.depth += 1;
        try {
            const out = fn();
            this.depth -= 1;
            this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
            return out;
        } catch (e) {
            this.depth -= 1;
            try {
                if (nested) this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
                else this.db.exec('ROLLBACK');
            } catch { /* the transaction is gone already */ }
            throw e;
        }
    }

    /**
     * Runs fn() holding "<registry>.lock" (shared with the CLI and other writers) when a registry is configured;
     * throws StoreError('locked') when another writer keeps it past the timeout.
     */
    withRegistryLock(fn) {
        if (!this.registryFile) return fn();
        const lock = core.lockRegistry(this.registryFile, this.lockOptions);
        if (lock.error) throw new StoreError('locked', 'The registry is in use by another writer. Try again in a moment.', { status: 503 });
        try { return fn(); } finally { lock.release(); }
    }

    /** A change to licenses, customers or sales people: lock, transaction, then the registry is regenerated (failures are recorded). */
    changeShown(fn) {
        return this.withRegistryLock(() => {
            const out = this.tx(fn);
            this.regenerateRegistry();
            return out;
        });
    }

    // ---------------------------------------------------------------- settings

    /** { mailSubject, mailBody, digestWeekday (1-7), digestTime (HH:mm), defaultCurrency, lastDigestWeek } */
    getSettings() {
        const rows = this.db.prepare('SELECT key, value FROM settings').all();
        const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        const out = { ...R.DEFAULT_SETTINGS };
        for (const [k, col] of Object.entries(SETTING_KEYS)) if (raw[col] !== undefined) out[k] = raw[col];
        out.digestWeekday = Number(out.digestWeekday);
        return out;
    }

    /** Changes the given settings (others stay); validates everything first. Returns getSettings(). */
    updateSettings(changes) {
        if (!changes || typeof changes !== 'object') throw invalid(null, 'Settings must be an object.');
        const set = {};
        for (const [k, v] of Object.entries(changes)) {
            if (!SETTING_KEYS[k]) throw invalid(k, `Unknown setting ${k}.`);
            if (k === 'mailSubject') set[k] = R.text(v, { field: k, label: 'Mail subject', max: R.LIMITS.subject, required: true });
            else if (k === 'mailBody') set[k] = R.text(v, { field: k, label: 'Mail body', max: R.LIMITS.template, required: true, multiline: true });
            else if (k === 'digestWeekday') {
                const n = Number(v);
                if (!Number.isInteger(n) || n < 1 || n > 7) throw invalid(k, 'Digest weekday must be 1 (Monday) to 7 (Sunday).');
                set[k] = String(n);
            } else if (k === 'digestTime') {
                if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) throw invalid(k, 'Digest time must be HH:mm (00:00-23:59).');
                set[k] = v.trim();
            } else if (k === 'defaultCurrency') set[k] = R.currency(v, null, { field: k });
            else if (k === 'lastDigestWeek') {
                if (typeof v !== 'string' || !(v === '' || /^\d{4}-W\d{2}$/.test(v))) throw invalid(k, 'Last digest week must look like 2026-W48.');
                set[k] = v;
            }
            if (set[k] === null) throw invalid(k, `${k} is required.`);
        }
        this.tx(() => {
            const up = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            for (const [k, v] of Object.entries(set)) up.run(SETTING_KEYS[k], String(v));
        });
        return this.getSettings();
    }

    // ---------------------------------------------------------------- sales

    listSales({ activeOnly = false } = {}) {
        const rows = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM licenses l WHERE l.sales_id = s.id) AS license_count
            FROM sales s ${activeOnly ? 'WHERE s.active = 1' : ''} ORDER BY s.active DESC, s.name COLLATE NOCASE`).all();
        return rows.map(salesFromRow);
    }

    getSales(id) { return salesFromRow(this.db.prepare('SELECT * FROM sales WHERE id = ?').get(R.id(id, { field: 'salesId', label: 'Sales' }))); }

    findSalesByName(name) {
        if (typeof name !== 'string' || !name.trim()) return null;
        return salesFromRow(this.db.prepare('SELECT * FROM sales WHERE name = ?').get(name.trim()));
    }

    /** { name (1-100, unique ignoring case), email? } -> sales */
    createSales(fields = {}) {
        const name = R.text(fields.name, { field: 'name', label: 'Name', max: R.LIMITS.salesName, required: true });
        const email = R.email(fields.email, { field: 'email', label: 'Email' });
        const r = this.tx(() => { // the name check runs inside the write transaction (another writer may add the same name)
            if (this.findSalesByName(name)) throw new StoreError('conflict', `A sales person named "${name}" already exists.`, { field: 'name' });
            return this.db.prepare('INSERT INTO sales (name, email, active, created_at) VALUES (?, ?, 1, ?)').run(name, email, this.stamp());
        });
        return this.getSales(Number(r.lastInsertRowid));
    }

    /** Changes name / email / active (false = deactivated: kept on old licenses, not selectable for new ones). */
    updateSales(id, fields = {}) {
        const cur = this.getSales(id);
        if (!cur) throw new StoreError('not-found', 'Sales person not found.', { field: 'salesId' });
        const next = { ...cur };
        if (fields.name !== undefined) next.name = R.text(fields.name, { field: 'name', label: 'Name', max: R.LIMITS.salesName, required: true });
        if (fields.email !== undefined) next.email = R.email(fields.email, { field: 'email', label: 'Email' });
        if (fields.active !== undefined) {
            if (typeof fields.active !== 'boolean') throw invalid('active', 'Active must be true or false.');
            next.active = fields.active;
        }
        const write = () => {
            const other = this.findSalesByName(next.name);
            if (other && other.id !== cur.id) throw new StoreError('conflict', `A sales person named "${next.name}" already exists.`, { field: 'name' });
            this.db.prepare('UPDATE sales SET name = ?, email = ?, active = ? WHERE id = ?').run(next.name, next.email, next.active ? 1 : 0, cur.id);
        };
        this.changeShown(write);
        return this.getSales(cur.id);
    }

    /** An active sales person by id or name, for a new license; throws not-found / sales-inactive. */
    activeSales({ salesId, salesName }) {
        let s = null;
        if (salesId !== undefined && salesId !== null && salesId !== '') {
            s = this.getSales(salesId);
            if (!s) throw new StoreError('not-found', 'Sales person not found.', { field: 'salesId' });
        } else if (typeof salesName === 'string' && salesName.trim()) {
            s = this.findSalesByName(salesName);
            if (!s) throw new StoreError('not-found', `No sales person named "${salesName.trim()}".`, { field: 'salesId' });
        } else return null;
        if (!s.active) throw new StoreError('sales-inactive', `Sales person "${s.name}" is deactivated.`, { field: 'salesId', status: 400 });
        return s;
    }

    // ---------------------------------------------------------------- plans

    listPlans({ activeOnly = false } = {}) {
        return this.db.prepare(`SELECT * FROM plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, type DESC, term_unit, term_value, name`)
            .all().map(planFromRow);
    }

    getPlan(id) { return planFromRow(this.db.prepare('SELECT * FROM plans WHERE id = ?').get(R.id(id, { field: 'planId', label: 'Plan' }))); }

    checkPlan(p) {
        const name = R.text(p.name, { field: 'name', label: 'Name', max: R.LIMITS.planName, required: true });
        if (!R.LICENSE_TYPES.includes(p.type)) throw invalid('type', 'Type must be paid or trial.');
        if (!R.TERM_UNITS.includes(p.termUnit)) throw invalid('termUnit', 'Term unit must be months or days.');
        const tv = Number(p.termValue);
        const max = p.termUnit === 'days' ? R.LIMITS.termDays : R.LIMITS.termMonths;
        if (!Number.isInteger(tv) || tv < 1 || tv > max) throw invalid('termValue', `Term must be a whole number from 1 to ${max}.`);
        if (p.type === 'trial' && (p.termUnit === 'days' ? tv : tv * 31) > R.TRIAL_MAX_DAYS) {
            throw invalid('termValue', `A trial plan can last at most ${R.TRIAL_MAX_DAYS} days.`);
        }
        let price = R.amount(p.price, { field: 'price', label: 'Price' });
        if (p.type === 'trial') {
            if (price) throw invalid('price', 'A trial plan is free: its price must be 0.');
            price = 0;
        }
        const cur = R.currency(p.currency, this.getSettings().defaultCurrency);
        if (typeof p.active !== 'boolean') throw invalid('active', 'Active must be true or false.');
        return { name, type: p.type, termValue: tv, termUnit: p.termUnit, price, currency: cur, active: p.active };
    }

    /** { name, type paid|trial, termValue, termUnit months|days, price (null for paid allowed; trial 0), currency?, active? } */
    createPlan(fields = {}) {
        const p = this.checkPlan({ active: true, ...fields });
        const r = this.tx(() => {
            if (this.db.prepare('SELECT 1 FROM plans WHERE name = ?').get(p.name)) throw new StoreError('conflict', `A plan named "${p.name}" already exists.`, { field: 'name' });
            return this.db.prepare('INSERT INTO plans (name, type, term_value, term_unit, price, currency, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(p.name, p.type, p.termValue, p.termUnit, p.price, p.currency, p.active ? 1 : 0, this.stamp());
        });
        return this.getPlan(Number(r.lastInsertRowid));
    }

    /** Changes any plan field; the type of a plan used by licenses cannot change. */
    updatePlan(id, fields = {}) {
        const cur = this.getPlan(id);
        if (!cur) throw new StoreError('not-found', 'Plan not found.', { field: 'planId' });
        if (fields.type !== undefined && fields.type !== cur.type && this.db.prepare('SELECT 1 FROM licenses WHERE plan_id = ?').get(cur.id)) {
            throw new StoreError('conflict', 'The type of a plan that licenses use cannot change: add a new plan instead.', { field: 'type' });
        }
        const merged = { ...cur };
        for (const k of ['name', 'type', 'termValue', 'termUnit', 'price', 'currency', 'active']) if (fields[k] !== undefined) merged[k] = fields[k];
        const p = this.checkPlan(merged);
        this.tx(() => {
            const other = this.db.prepare('SELECT id FROM plans WHERE name = ?').get(p.name);
            if (other && other.id !== cur.id) throw new StoreError('conflict', `A plan named "${p.name}" already exists.`, { field: 'name' });
            this.db.prepare('UPDATE plans SET name = ?, type = ?, term_value = ?, term_unit = ?, price = ?, currency = ?, active = ? WHERE id = ?')
                .run(p.name, p.type, p.termValue, p.termUnit, p.price, p.currency, p.active ? 1 : 0, cur.id);
        });
        return this.getPlan(cur.id);
    }

    // ---------------------------------------------------------------- customers

    checkCustomer(f, { partial = false } = {}) {
        const out = {};
        const has = (k) => !partial || f[k] !== undefined;
        if (has('name')) out.name = R.text(f.name, { field: 'name', label: 'Customer name', max: R.LIMITS.customerName, required: true });
        if (has('taxId')) out.taxId = R.text(f.taxId, { field: 'taxId', label: 'Tax ID', max: R.LIMITS.taxId });
        if (has('address')) out.address = R.text(f.address, { field: 'address', label: 'Address', max: R.LIMITS.address, multiline: true });
        if (has('contactPerson')) out.contactPerson = R.text(f.contactPerson, { field: 'contactPerson', label: 'Contact person', max: R.LIMITS.contactPerson });
        if (has('phone')) out.phone = R.text(f.phone, { field: 'phone', label: 'Phone', max: R.LIMITS.phone });
        if (has('email')) out.email = R.email(f.email, { field: 'email', label: 'Email' });
        if (has('notes')) out.notes = R.text(f.notes, { field: 'notes', label: 'Notes', max: R.LIMITS.notes, multiline: true });
        if (has('defaultSalesId')) {
            out.defaultSalesId = R.id(f.defaultSalesId, { field: 'defaultSalesId', label: 'Default sales' });
            if (out.defaultSalesId !== null && !this.getSales(out.defaultSalesId)) throw new StoreError('not-found', 'Default sales person not found.', { field: 'defaultSalesId' });
        }
        return out;
    }

    /**
     * Customers with licenseCount and nextExpiry (earliest expiry from today among non-revoked licenses).
     * q: part of the name, tax ID, contact person or email (ignoring case).
     */
    listCustomers({ q = '' } = {}) {
        const where = [];
        const args = [this.today()];
        const term = typeof q === 'string' ? q.trim() : '';
        if (term) {
            where.push("(c.name LIKE ? ESCAPE '\\' OR c.tax_id LIKE ? ESCAPE '\\' OR c.contact_person LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')");
            const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            args.push(like, like, like, like);
        }
        return this.db.prepare(`SELECT c.*, s.name AS default_sales_name,
                (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count,
                (SELECT MIN(l.expires_at) FROM licenses l WHERE l.customer_id = c.id AND l.revoked_at IS NULL AND l.expires_at >= ?) AS next_expiry
            FROM customers c LEFT JOIN sales s ON s.id = c.default_sales_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name COLLATE NOCASE`).all(...args).map(customerFromRow);
    }

    /** A customer (with licenseCount / nextExpiry), or null. withLicenses: adds `licenses` (newest first). */
    getCustomer(id, { withLicenses = false } = {}) {
        const cid = R.id(id, { field: 'customerId', label: 'Customer' });
        const row = this.db.prepare(`SELECT c.*, s.name AS default_sales_name,
                (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count,
                (SELECT MIN(l.expires_at) FROM licenses l WHERE l.customer_id = c.id AND l.revoked_at IS NULL AND l.expires_at >= ?) AS next_expiry
            FROM customers c LEFT JOIN sales s ON s.id = c.default_sales_id WHERE c.id = ?`).get(this.today(), cid);
        const c = customerFromRow(row);
        if (c && withLicenses) c.licenses = this.listLicenses({ customerId: c.id, sort: 'newest' });
        return c;
    }

    findCustomerByName(name) {
        if (typeof name !== 'string' || !name.trim()) return null;
        const row = this.db.prepare('SELECT id FROM customers WHERE name = ?').get(name.trim());
        return row ? this.getCustomer(row.id) : null;
    }

    /** Inserts a checked customer inside the caller's transaction; returns its id. */
    insertCustomer(c) {
        if (this.db.prepare('SELECT 1 FROM customers WHERE name = ?').get(c.name)) {
            throw new StoreError('conflict', `A customer named "${c.name}" already exists.`, { field: 'name' });
        }
        const at = this.stamp();
        const r = this.db.prepare(`INSERT INTO customers (name, tax_id, address, contact_person, phone, email, default_sales_id, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.taxId ?? null, c.address ?? null, c.contactPerson ?? null, c.phone ?? null,
            c.email ?? null, c.defaultSalesId ?? null, c.notes ?? null, at, at);
        return Number(r.lastInsertRowid);
    }

    /** { name (1-200, unique ignoring case), taxId, address, contactPerson, phone, email, defaultSalesId, notes } */
    createCustomer(fields = {}) {
        const c = this.checkCustomer(fields);
        if (c.defaultSalesId) this.activeSales({ salesId: c.defaultSalesId });
        const cid = this.tx(() => this.insertCustomer(c));
        return this.getCustomer(cid);
    }

    /** Changes the given fields. A new name shows in the registry; licenses keep the name they were signed with. */
    updateCustomer(id, fields = {}) {
        const cur = this.getCustomer(id);
        if (!cur) throw new StoreError('not-found', 'Customer not found.', { field: 'customerId' });
        const c = this.checkCustomer(fields, { partial: true });
        if (c.defaultSalesId && c.defaultSalesId !== cur.defaultSalesId) this.activeSales({ salesId: c.defaultSalesId });
        const next = { ...cur, ...c };
        const write = () => {
            if (c.name !== undefined) {
                const other = this.db.prepare('SELECT id FROM customers WHERE name = ?').get(c.name);
                if (other && other.id !== cur.id) throw new StoreError('conflict', `A customer named "${c.name}" already exists.`, { field: 'name' });
            }
            this.db.prepare(`UPDATE customers SET name = ?, tax_id = ?, address = ?, contact_person = ?, phone = ?, email = ?,
                default_sales_id = ?, notes = ?, updated_at = ? WHERE id = ?`).run(next.name, next.taxId, next.address, next.contactPerson, next.phone,
                next.email, next.defaultSalesId, next.notes, this.stamp(), cur.id);
        };
        this.changeShown(write);
        return this.getCustomer(cur.id);
    }

    /** Deletes a customer that has no licenses (else conflict). */
    deleteCustomer(id) {
        const cur = this.getCustomer(id);
        if (!cur) throw new StoreError('not-found', 'Customer not found.', { field: 'customerId' });
        if (cur.licenseCount > 0) throw new StoreError('conflict', `${cur.name} has ${cur.licenseCount} license(s) and cannot be deleted.`, { field: 'customerId' });
        this.tx(() => this.db.prepare('DELETE FROM customers WHERE id = ?').run(cur.id));
        return { deleted: true, id: cur.id };
    }

    // ---------------------------------------------------------------- licenses

    /** One license by its ID (L-YYYY-NNNN, any case), or null. */
    getLicense(licenseId) {
        if (typeof licenseId !== 'string' || !/^L-\d{4}-\d{4}$/i.test(licenseId.trim())) return null;
        return licenseFromRow(this.db.prepare(`${LICENSE_SELECT} WHERE l.license_id = ?`).get(licenseId.trim()), this.today());
    }

    getLicenseByRowId(rowId) { return licenseFromRow(this.db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).get(rowId), this.today()); }

    /**
     * Licenses matching every given filter:
     *   customerId, salesId (number, or 'none' = no sales), type (paid|trial), status (one of STATUSES, on today),
     *   from / to (issued_at, YYYY-MM-DD, both included), q (part of the ID, customer, licensed-to name, order no. or sales),
     *   kind (new|renewal), period + date (instead of from / to), includeRevoked (default true),
     *   sort: 'newest' (latest issued first, default) | 'issued' (oldest first) | 'expiry' | 'id' (insertion order).
     */
    listLicenses(filter = {}) {
        const { sql, args } = reports.licenseWhere({ today: this.today(), ...filter });
        const order = {
            newest: 'l.issued_at DESC, l.id DESC', issued: 'l.issued_at ASC, l.license_id', expiry: "COALESCE(l.expires_at, '9999') ASC, l.license_id", id: 'l.id',
        }[filter.sort || 'newest'];
        if (!order) throw invalid('sort', 'Sort must be newest, issued, expiry or id.');
        let rows = this.db.prepare(`${LICENSE_SELECT} ${sql} ORDER BY ${order}`).all(...args).map((r) => licenseFromRow(r, this.today()));
        if (filter.status !== undefined && filter.status !== '' && filter.status !== null) {
            if (!R.STATUSES.includes(filter.status)) throw invalid('status', `Status must be one of ${R.STATUSES.join(', ')}.`);
            rows = rows.filter((l) => l.status === filter.status);
        }
        return rows;
    }

    /** Events of a license, oldest first: [{ id, licenseId, type, at, detail }]. */
    licenseEvents(licenseId) {
        const l = this.getLicense(licenseId);
        if (!l) throw new StoreError('not-found', 'License not found.', { field: 'licenseId' });
        return this.db.prepare('SELECT e.*, l.license_id AS license_text FROM events e JOIN licenses l ON l.id = e.license_id WHERE e.license_id = ? ORDER BY e.id')
            .all(l.id).map(eventFromRow);
    }

    insertEvent(rowId, type, detail = {}) {
        this.db.prepare('INSERT INTO events (license_id, type, at, detail) VALUES (?, ?, ?, ?)').run(rowId, type, this.stamp(), JSON.stringify(detail || {}));
    }

    /**
     * Records delivered / delivery_failed / downloaded / reissued for a license. detail: a plain object (JSON at most
     * 4000 characters); 'reissued' needs detail.reason (why the same file is sent or downloaded again).
     */
    addEvent(licenseId, type, detail = {}) {
        if (!R.RECORD_EVENT_TYPES.includes(type)) throw invalid('type', `Event type must be one of ${R.RECORD_EVENT_TYPES.join(', ')}.`);
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw invalid('detail', 'Event detail must be an object.');
        const d = { ...detail };
        if (type === 'reissued') d.reason = R.text(d.reason, { field: 'reason', label: 'Reason', max: R.LIMITS.note, required: true });
        if (JSON.stringify(d).length > 4000) throw invalid('detail', 'Event detail is too long.');
        const l = this.getLicense(licenseId);
        if (!l) throw new StoreError('not-found', 'License not found.', { field: 'licenseId' });
        this.tx(() => this.insertEvent(l.id, type, d));
        return this.licenseEvents(l.licenseId).pop();
    }

    /** Next free ID for a year: L-<year>-<highest number in the database + 1>. */
    nextLicenseId(year = this.today().slice(0, 4)) {
        const y = String(year);
        let max = 0;
        for (const r of this.db.prepare('SELECT license_id FROM licenses WHERE license_id LIKE ?').all(`L-${y}-%`)) {
            const m = /^L-\d{4}-(\d{4})$/i.exec(r.license_id);
            if (m) max = Math.max(max, Number(m[1]));
        }
        return `L-${y}-${String(max + 1).padStart(4, '0')}`;
    }

    /**
     * The trial that used up the customer's allowance (one per customer; revoked trials count, except one revoked as
     * 'replaced': its replacement carries the allowance), or null. exceptRowId: a license being replaced.
     */
    usedTrial(customerId, { exceptRowId = null } = {}) {
        const row = this.db.prepare(`SELECT license_id FROM licenses WHERE customer_id = ? AND type = 'trial'
            AND (revoke_reason IS NULL OR revoke_reason <> 'replaced') AND id <> ? ORDER BY id LIMIT 1`).get(customerId, exceptRowId || 0);
        return row ? row.license_id : null;
    }

    /** Whether the customer already has a paid license that is not revoked (a new paid license is then a renewal). */
    hasPaidLicense(customerId) {
        return !!this.db.prepare("SELECT 1 FROM licenses WHERE customer_id = ? AND type = 'paid' AND revoked_at IS NULL").get(customerId);
    }

    /**
     * Changes sales / amount / currency / order number of an issued license (nothing else can change: replace it).
     * Records an 'edited' event with before / after of the changed fields. Returns { license, changed }.
     */
    editLicense(licenseId, changes = {}) {
        const l = this.getLicense(licenseId);
        if (!l) throw new StoreError('not-found', 'License not found.', { field: 'licenseId' });
        if (!changes || typeof changes !== 'object') throw invalid(null, 'Changes must be an object.');
        const bad = Object.keys(changes).filter((k) => !R.EDITABLE_FIELDS.includes(k));
        if (bad.length) {
            throw invalid(bad[0], 'Only sales, amount, currency and order number can change after issuing. To change anything else, replace the license.');
        }
        const next = { salesId: l.salesId, amount: l.amount, currency: l.currency, orderNo: l.orderNo };
        if (changes.salesId !== undefined) {
            next.salesId = R.id(changes.salesId, { field: 'salesId', label: 'Sales' });
            if (next.salesId !== null && next.salesId !== l.salesId) this.activeSales({ salesId: next.salesId });
        }
        if (changes.amount !== undefined) {
            next.amount = R.amount(changes.amount);
            if (l.type === 'trial' && next.amount) throw new StoreError('trial-amount', 'A trial license is free: its amount must be 0.', { field: 'amount', status: 400 });
            if (l.type === 'trial') next.amount = 0;
        }
        if (changes.currency !== undefined) next.currency = R.currency(changes.currency, this.getSettings().defaultCurrency);
        if (changes.orderNo !== undefined) next.orderNo = R.text(changes.orderNo, { field: 'orderNo', label: 'Order no.', max: R.LIMITS.orderNo });
        // an amount without a currency (e.g. on an imported license) would be left out of the report totals
        if (next.amount !== null && next.amount !== undefined && !next.currency) next.currency = this.getSettings().defaultCurrency;
        const before = {};
        const after = {};
        for (const k of R.EDITABLE_FIELDS) {
            if (next[k] !== l[k]) { before[k] = l[k]; after[k] = next[k]; }
        }
        if (before.salesId !== undefined) {
            before.sales = l.salesName;
            after.sales = next.salesId ? this.getSales(next.salesId).name : null;
        }
        if (!Object.keys(after).length) return { license: l, changed: false };
        const write = () => {
            this.db.prepare('UPDATE licenses SET sales_id = ?, amount = ?, currency = ?, order_no = ? WHERE id = ?')
                .run(next.salesId, next.amount, next.currency, next.orderNo, l.id);
            this.insertEvent(l.id, 'edited', { before, after });
        };
        this.changeShown(write);
        return { license: this.getLicense(l.licenseId), changed: true };
    }

    /**
     * Records that a license is revoked (the customer's offline file stays valid until it expires: nothing is recalled).
     * reason: terminated | issued_in_error | other ('replaced' only through a replacement); note optional (<= 500).
     */
    revokeLicense(licenseId, { reason, note } = {}) {
        const l = this.getLicense(licenseId);
        if (!l) throw new StoreError('not-found', 'License not found.', { field: 'licenseId' });
        if (!R.MANUAL_REVOKE_REASONS.includes(reason)) {
            throw invalid('reason', reason === 'replaced' ? 'Use Replace to replace a license.' : `Reason must be one of ${R.MANUAL_REVOKE_REASONS.join(', ')}.`);
        }
        const n = R.text(note, { field: 'note', label: 'Note', max: R.LIMITS.note, multiline: true });
        if (l.revokedAt) throw new StoreError('conflict', `${l.licenseId} was already revoked on ${l.revokedAt.slice(0, 10)}.`, { field: 'licenseId' });
        this.changeShown(() => {
            this.db.prepare('UPDATE licenses SET revoked_at = ?, revoke_reason = ?, revoke_note = ? WHERE id = ? AND revoked_at IS NULL')
                .run(this.stamp(), reason, n, l.id);
            this.insertEvent(l.id, 'revoked', { reason, note: n });
        });
        return this.getLicense(l.licenseId);
    }

    // ---------------------------------------------------------------- reports (reports.js)

    reportSummary(filter) { return reports.summary(this, filter); }
    reportDetail(filter) { return reports.detail(this, filter); }
    dashboard(o) { return reports.dashboard(this, o); }
    renewalBoard(o) { return reports.renewalBoard(this, o); }
    trialConversion(o) { return reports.trialConversion(this, o); }
    digestData(o) { return reports.digestData(this, o); }

    // ---------------------------------------------------------------- registry (registry.js)

    /** Rewrites the Markdown copy from the database. { ok, error (Error|null) }; also kept for registryStatus(). */
    regenerateRegistry() {
        if (!this.registryFile) return { ok: true, error: null };
        const r = registry.writeRegistry(this);
        this.registryError = r.error;
        this.registryAt = this.stamp();
        return r;
    }

    /** { file, ok, error (message|null), at (last attempt) } of the generated registry copy. */
    registryStatus() {
        return { file: this.registryFile, ok: !this.registryError, error: this.registryError ? this.registryError.message : null, at: this.registryAt };
    }

    /** The record of the one-time import of the Markdown registry ({ at, file, backup, imported, ... }), or null. */
    importRecord() {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(IMPORT_KEY);
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
    }

    setImportRecord(rec) {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(IMPORT_KEY, JSON.stringify(rec));
    }

    licenseCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n; }

    /** Random ID of this database (kept in backups), written into the generated registry. */
    dbId() {
        const row = this.db.prepare("SELECT value FROM settings WHERE key = 'db_id'").get();
        return row ? row.value : '';
    }

    /** First use: imports the existing Markdown registry into an empty database (see registry.importIfNeeded). */
    importRegistryIfNeeded() { return registry.importIfNeeded(this); }

    // ---------------------------------------------------------------- backups (backup.js)

    createBackup() { return backup.create(this); }
    listBackups() { return backup.list(this); }
    backupPath(name) { return backup.resolve(this, name); }
}

/**
 * Opens (creating when missing) the database file and brings its schema up to date.
 * options: registryFile (generated Markdown copy, also the lock shared with the CLI), now () => Date, lock options.
 */
function openStore(file, options = {}) {
    if (!file || typeof file !== 'string') throw new Error('openStore needs the database file path');
    const abs = path.resolve(file);
    const db = openDatabase(abs);
    const store = new Store(db, { ...options, file: abs, registryFile: options.registryFile ? path.resolve(options.registryFile) : null });
    try {
        migrate(db, store.stamp());
    } catch (e) {
        store.close();
        throw e;
    }
    return store;
}

module.exports = { Store, openStore, SCHEMA_VERSION, licenseFromRow };
