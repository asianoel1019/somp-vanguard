// Issuing: checks, sign + verify (the product's own rules), write the .lic, record the license and its events, then
// regenerate the registry copy — all under the registry lock ("<registry>.lock", shared with the CLI) and one database
// transaction. A .lic written by this call is removed again when the database write fails, so a refusal writes nothing.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'scripts', 'licenseIssuerCore'));
const { KEYS } = require(path.join(__dirname, '..', '..', '..', 'backend', 'lib', 'licenseKeys'));
const R = require('./rules');

const { StoreError, invalid } = R;
const DATE_CHECKS = {
    'id-format': ['licenseId', 'License ID must look like L-YYYY-NNNN.'],
    'issued-date': ['issuedAt', 'Issued must be a real date (YYYY-MM-DD).'],
    'expires-date': ['expiresAt', 'Expires must be a real date (YYYY-MM-DD).'],
    'expires-past': ['expiresAt', 'Expires is in the past.'],
    'expires-before-issued': ['expiresAt', 'Expires is before Issued.'],
};
const LABELS = { licenseId: 'License ID', issuedAt: 'Issued', expiresAt: 'Expires', renewalOf: 'Renewal of', replaces: 'Replaces' };

/** StoreError with extra properties for the result (next, reason, usedBy, file, error). */
function fail(code, message, { field = null, status, ...extra } = {}) {
    return Object.assign(new StoreError(code, message, { field, status }), { extra });
}

function result(e) {
    if (e instanceof StoreError) return { ok: false, code: e.code, status: e.status, field: e.field, message: e.message, ...(e.extra || {}) };
    return { ok: false, code: 'failed', status: 500, field: null, message: `Not written: ${e && e.message ? e.message : String(e)}`, error: e };
}

const given = (v) => v !== undefined && v !== null && v !== '';

function resolveCustomer(store, o, old) {
    if (old) return store.getCustomer(old.customerId);
    if (given(o.customerId)) {
        const c = store.getCustomer(o.customerId);
        if (!c) throw new StoreError('not-found', 'Customer not found.', { field: 'customerId' });
        return c;
    }
    if (o.newCustomer !== undefined && o.newCustomer !== null) {
        if (typeof o.newCustomer !== 'object' || Array.isArray(o.newCustomer)) throw invalid('newCustomer', 'New customer must be an object.');
        const fields = store.checkCustomer(o.newCustomer);
        if (fields.defaultSalesId) store.activeSales({ salesId: fields.defaultSalesId });
        return store.getCustomer(store.insertCustomer(fields));
    }
    if (o.customerName !== undefined) {
        const name = R.text(o.customerName, { field: 'customer', label: 'Customer', max: R.LIMITS.customerName, required: true });
        const c = store.findCustomerByName(name);
        if (c) return c;
        if (!o.createCustomer) throw new StoreError('not-found', `No customer named "${name}".`, { field: 'customer' });
        return store.getCustomer(store.insertCustomer({ name }));
    }
    throw invalid('customer', 'Customer is required.');
}

function resolvePlan(store, o, old) {
    if (!given(o.planId)) return old && old.planId ? store.getPlan(old.planId) : null;
    const p = store.getPlan(o.planId);
    if (!p) throw new StoreError('not-found', 'Plan not found.', { field: 'planId' });
    if (!p.active && !(old && old.planId === p.id)) throw fail('plan-inactive', `Plan "${p.name}" is deactivated.`, { field: 'planId', status: 400 });
    return p;
}

function resolveSales(store, o, old) {
    if (given(o.salesId)) {
        const id = R.id(o.salesId, { field: 'salesId', label: 'Sales' });
        if (old && id === old.salesId) return store.getSales(id); // a replacement may keep a sales person deactivated since
        return store.activeSales({ salesId: id });
    }
    if (typeof o.salesName === 'string' && o.salesName.trim()) return store.activeSales({ salesName: o.salesName });
    if (o.salesId === undefined && old && old.salesId) return store.getSales(old.salesId);
    return null;
}

function run(store, o, old) {
    const onDate = o.onDate || store.today();
    const warnings = [];
    let created = null; // a .lic this call created: removed again when the database write fails
    try {
        // ---- checks that need no database ----
        for (const k of ['licenseId', 'issuedAt', 'expiresAt', 'renewalOf']) {
            if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') throw invalid(k, `${LABELS[k]} must be text.`);
        }
        if (!o.key && !o.keyFile) throw invalid('key', 'The signing key is missing.');
        if (typeof o.keyId !== 'string' || !o.keyId) throw invalid('keyId', 'The key ID is missing.');
        let contact = null;
        if (o.contact !== undefined || !old) {
            if (o.contact !== undefined && o.contact !== null && (typeof o.contact !== 'object' || Array.isArray(o.contact))) {
                throw invalid('contactVendor', 'Contact must be an object { vendor, email }.');
            }
            const c = core.makeContact(o.contact || {});
            if (c.error) throw fail('contact-invalid', c.error, { field: c.field === 'vendor' ? 'contactVendor' : 'contactEmail', status: 400 });
            contact = c.contact;
        } else if (old.contactVendor || old.contactEmail) {
            contact = core.makeContact({ vendor: old.contactVendor || '', email: old.contactEmail || '' }).contact;
        }
        const type0 = given(o.type) ? o.type : null;
        if (type0 !== null && !R.LICENSE_TYPES.includes(type0)) throw invalid('type', 'Type must be paid or trial.');
        const issuedAt = (o.issuedAt && o.issuedAt.trim()) || (old ? old.issuedAt : onDate);
        let licenseId = (o.licenseId && o.licenseId.trim()) || null;
        if (licenseId !== null && !core.ID_PATTERN.test(licenseId)) throw invalid('licenseId', DATE_CHECKS['id-format'][1]);
        const amountIn = o.amount === undefined ? undefined : R.amount(o.amount);
        const orderNo = o.orderNo === undefined ? (old ? old.orderNo : null) : R.text(o.orderNo, { field: 'orderNo', label: 'Order no.', max: R.LIMITS.orderNo });
        const note = old ? R.text(o.note, { field: 'note', label: 'Note', max: R.LIMITS.note, multiline: true }) : null;

        return store.withRegistryLock(() => {
            const done = store.tx(() => {
                const customer = resolveCustomer(store, o, old);
                const plan = resolvePlan(store, o, old);
                const type = old ? old.type : plan ? plan.type : type0 || 'paid';
                if (type0 && type0 !== type) {
                    throw invalid('type', old ? `A replacement keeps the type of ${old.licenseId} (${old.type}).` : `Type must match the plan (${plan.type}).`);
                }
                if (old && plan && plan.type !== old.type) throw invalid('planId', `Choose a ${old.type} plan, like the one of ${old.licenseId}.`);
                const sales = resolveSales(store, o, old);
                if (!sales) {
                    if (o.requireSales) throw fail('sales-required', 'Sales is required.', { field: 'salesId', status: 400 });
                    warnings.push('no-sales');
                }
                let renewalOf = null;
                if (!old && given(o.renewalOf)) {
                    renewalOf = store.getLicense(o.renewalOf);
                    if (!renewalOf) throw new StoreError('not-found', `License ${o.renewalOf} not found.`, { field: 'renewalOf' });
                    if (renewalOf.customerId !== customer.id) throw invalid('renewalOf', `${renewalOf.licenseId} belongs to another customer (${renewalOf.customerName}).`);
                }

                const planTerm = plan && R.isRealDate(issuedAt) ? R.planEnd(issuedAt, plan.termValue, plan.termUnit) : null;
                let expiresAt = (o.expiresAt && o.expiresAt.trim()) || null;
                if (!expiresAt) expiresAt = old && !given(o.planId) ? old.expiresAt || planTerm : planTerm;
                if (!expiresAt) throw invalid('expiresAt', 'Expires is required (or choose a plan).');
                if (!licenseId) licenseId = store.nextLicenseId(onDate.slice(0, 4));
                const bad = core.validateIssueFields({ licenseId, issuedAt, expiresAt }, onDate);
                if (bad) throw Object.assign(invalid(DATE_CHECKS[bad][0], DATE_CHECKS[bad][1]), { extra: { check: bad } });
                const dup = store.getLicense(licenseId);
                if (dup) {
                    throw fail('duplicate-id', `License ID ${dup.licenseId} is already in the database.`,
                        { field: 'licenseId', status: 409, next: store.nextLicenseId(licenseId.slice(2, 6)) });
                }

                if (type === 'trial') {
                    if (amountIn) throw fail('trial-amount', 'A trial license is free: its amount must be 0.', { field: 'amount', status: 400 });
                    const days = R.termDays(issuedAt, expiresAt);
                    if (days > R.TRIAL_MAX_DAYS) {
                        throw fail('trial-term', `A trial license can be valid for at most ${R.TRIAL_MAX_DAYS} days (this one: ${days}).`, { field: 'expiresAt', status: 400 });
                    }
                    const used = store.usedTrial(customer.id, { exceptRowId: old ? old.id : null });
                    if (used) {
                        throw fail('trial-used', `${customer.name} already had a trial license (${used}). Each customer can have one trial.`,
                            { field: 'customer', status: 409, usedBy: used });
                    }
                }
                const settings = store.getSettings();
                let amount = amountIn !== undefined ? amountIn : old ? old.amount : plan ? plan.price : null;
                if (type === 'trial') amount = 0;
                const currency = o.currency !== undefined ? R.currency(o.currency, settings.defaultCurrency)
                    : old && old.currency ? old.currency : plan ? plan.currency : settings.defaultCurrency;
                const isRenewal = old ? old.isRenewal
                    : type === 'paid' && ((renewalOf !== null && renewalOf.type === 'paid') || store.hasPaidLicense(customer.id));

                const out = o.out ? path.resolve(o.out)
                    : o.issuedDir ? path.join(path.resolve(o.issuedDir), `${licenseId}-${R.slugify(customer.name)}.lic`) : null;
                if (!out) throw invalid('out', 'The output file is missing.');
                if ([o.keyFile, store.registryFile, store.file].filter(Boolean).some((f) => core.samePath(out, f))) {
                    throw fail('out-protected', 'The output file must not be the private key, the registry or the database.', { status: 400 });
                }
                const existed = fs.existsSync(out);
                if (existed && !o.overwrite) throw fail('out-exists', `${out} already exists. Nothing was written.`, { status: 409, file: out });

                let key = o.key;
                if (!key) {
                    try { key = crypto.createPrivateKey(fs.readFileSync(o.keyFile)); } catch (e) {
                        throw fail('key-unreadable', `Cannot read the private key: ${e.message}`, { status: 500, error: e });
                    }
                }
                const text = core.signLicenseText({ key, keyId: o.keyId, licenseId, customer: customer.name, issuedAt, expiresAt, contact, trial: type === 'trial' });
                const check = core.verifyLicense(text, o.keys || KEYS, onDate);
                if (!check.valid) throw fail('rejected', `Not written: the product would reject this license (${check.reason}).`, { status: 500, reason: check.reason });
                try {
                    fs.writeFileSync(out, text, o.overwrite ? undefined : { flag: 'wx' });
                } catch (e) {
                    if (e && e.code === 'EEXIST') throw fail('out-exists', `${out} already exists. Nothing was written.`, { status: 409, file: out });
                    throw fail('write-failed', `Cannot write ${out}: ${e.message}`, { status: 500, error: e });
                }
                if (!existed) created = out;
                const sha = core.sha12(fs.readFileSync(out));

                const at = store.stamp();
                const res = store.db.prepare(`INSERT INTO licenses (license_id, customer_id, licensed_to, plan_id, type, format, issued_at, expires_at,
                        sales_id, amount, currency, order_no, is_renewal, replaces_license_id, file_path, sha12, signed_at, key_id, contact_vendor,
                        contact_email, created_at) VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(licenseId, customer.id, customer.name, plan ? plan.id : null, type, issuedAt, expiresAt, sales ? sales.id : null, amount, currency,
                        orderNo, isRenewal ? 1 : 0, old ? old.id : null, out, sha, at, o.keyId, contact && contact.vendor ? contact.vendor : null,
                        contact && contact.email ? contact.email : null, at);
                store.insertEvent(Number(res.lastInsertRowid), 'issued', {
                    source: o.source || null, plan: plan ? plan.name : null, renewalOf: renewalOf ? renewalOf.licenseId : null, replaces: old ? old.licenseId : null,
                });
                if (old) {
                    const u = store.db.prepare("UPDATE licenses SET revoked_at = ?, revoke_reason = 'replaced', revoke_note = ? WHERE id = ? AND revoked_at IS NULL")
                        .run(at, note, old.id);
                    if (u.changes !== 1) throw new StoreError('conflict', `${old.licenseId} was revoked meanwhile. Nothing was written.`, { field: 'replaces' });
                    store.insertEvent(old.id, 'replaced', { replacedBy: licenseId, note });
                }
                return { licenseId, text, out, sha, contact };
            });
            created = null; // committed: the file belongs to the license now
            const reg = store.regenerateRegistry();
            const license = store.getLicense(done.licenseId);
            return {
                ok: true, license, licenseId: license.licenseId, text: done.text, outAbs: done.out, sha256: done.sha, contact: done.contact,
                registryError: reg.error, warnings, nextId: store.nextLicenseId(license.licenseId.slice(2, 6)),
                replaced: old ? store.getLicense(old.licenseId) : null,
            };
        });
    } catch (e) {
        if (created) { try { fs.unlinkSync(created); } catch { /* already gone */ } }
        return result(e);
    }
}

/**
 * Issues a new license. o:
 *   key (KeyObject) or keyFile; keyId; keys (public keys to verify with, default the built-in ones); onDate (default today)
 *   customer: customerId | newCustomer { name, taxId, ... } (created in the same transaction) | customerName (+ createCustomer: true
 *     creates it when no customer has that name, ignoring case)
 *   licenseId (default the next free ID of this year); issuedAt (default today); expiresAt (default from the plan)
 *   planId (type, expiry, amount and currency defaults come from it); type 'paid' | 'trial' (default paid / the plan's)
 *   salesId | salesName (an active sales person); requireSales (web: true → sales-required without one; CLI: warning 'no-sales')
 *   amount (>= 0, 2 decimals; trial: 0 only), currency (default plan / settings), orderNo
 *   renewalOf (license ID of the same customer: a paid license then counts as a renewal)
 *   contact { vendor, email } (signed in when set); out (file) or issuedDir (→ <dir>/<ID>-<slug>.lic); overwrite; source ('web'|'cli')
 * Result: { ok: true, license, licenseId, text, outAbs, sha256, contact, registryError (Error|null), warnings, nextId, replaced: null }
 *   or { ok: false, code, status, field, message, ...extra } — see the report for the codes.
 */
function issueLicense(store, o = {}) {
    return run(store, o, null);
}

/**
 * Replaces a license: issues a new one for the same customer (type kept; sales, plan, amount, currency, order no., contact
 * and dates default to the old license's, all can be given like for issueLicense) and marks the old one revoked with
 * reason 'replaced' (note: o.note), linked both ways (replaces / replacedBy) with an event on each. The new license keeps
 * the old one's new / renewal classification. o.replaces: the license ID to replace. Result as issueLicense (+ replaced).
 */
function replaceLicense(store, o = {}) {
    if (o.replaces !== undefined && typeof o.replaces !== 'string') return result(invalid('replaces', 'Replaces must be a license ID.'));
    const old = store.getLicense(o.replaces);
    if (!old) return result(o.replaces ? new StoreError('not-found', `License ${o.replaces} not found.`, { field: 'replaces' }) : invalid('replaces', 'Replaces is required.'));
    if (old.revokedAt) return result(new StoreError('conflict', `${old.licenseId} is revoked already; it cannot be replaced.`, { field: 'replaces' }));
    const rest = { ...o };
    for (const k of ['customerId', 'customerName', 'newCustomer', 'createCustomer', 'renewalOf']) delete rest[k];
    return run(store, rest, old);
}

module.exports = { issueLicense, replaceLicense };
