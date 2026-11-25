// JSON API of the business features (mounted under /api by src/app.js): settings, sales people, plans, customers,
// licenses (issue / replace / edit / revoke / reissue), delivery mails, mail status + test mail, weekly digest preview,
// dashboard, reports + CSV, backups. Every route needs a session; state-changing ones also the CSRF token (requireSession)
// and our Origin (app-wide middleware). Input is checked here and in the store: a refusal answers 400/404/409 with
// { error, code, field } and writes nothing. State changes go to the audit log (never secrets).
// The endpoint list with request / response shapes is in the Task C report ("API for Task D").
const fs = require('fs');
const path = require('path');
const express = require('express');
const core = require(path.join(__dirname, '..', '..', 'scripts', 'licenseIssuerCore'));
const R = require('./store/rules');
const { issueLicense, replaceLicense } = require('./store');
const { downloadTarget } = require('./registry');
const { isMailAddress } = require('./config');
const { TEMPLATE_VARIABLES, unknownVariables, buildDelivery, buildTestMail } = require('./mail');
const { summaryCsv, detailCsv } = require('./csv');

const { StoreError, invalid } = R;
const CUSTOMER_FIELDS = ['name', 'taxId', 'address', 'contactPerson', 'phone', 'email', 'defaultSalesId', 'notes'];
const SALES_FIELDS = ['name', 'email', 'active'];
const PLAN_FIELDS = ['name', 'type', 'termValue', 'termUnit', 'price', 'currency', 'active'];
const SETTINGS_FIELDS = ['mailSubject', 'mailBody', 'digestWeekday', 'digestTime', 'defaultCurrency'];
const ISSUE_FIELDS = ['customerId', 'newCustomer', 'planId', 'type', 'salesId', 'amount', 'currency', 'orderNo', 'licenseId', 'issuedAt', 'expiresAt',
    'renewalOf', 'contactVendor', 'contactEmail'];
const REPLACE_FIELDS = ['licenseId', 'issuedAt', 'expiresAt', 'planId', 'salesId', 'amount', 'currency', 'orderNo', 'contactVendor', 'contactEmail', 'note'];
const REISSUE_VIA = ['download', 'mail', 'other'];

/** The JSON body as an object with only the allowed keys (400 otherwise). */
function bodyOf(req, allowed) {
    const b = req.body === undefined ? {} : req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'The request body must be a JSON object.');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw invalid(k, `Unknown field ${k}.`);
    return b;
}

/** A query parameter as a trimmed string ('' when missing); repeated or nested parameters are refused. */
function q(req, name) {
    const v = req.query[name];
    if (v === undefined) return '';
    if (typeof v !== 'string') throw invalid(name, `${name} must be given once.`);
    return v.trim();
}

/** A yes/no query parameter: 1/true/yes or 0/false/no; `fallback` when missing. */
function qBool(req, name, fallback) {
    const v = q(req, name).toLowerCase();
    if (!v) return fallback;
    if (['1', 'true', 'yes'].includes(v)) return true;
    if (['0', 'false', 'no'].includes(v)) return false;
    throw invalid(name, `${name} must be true or false.`);
}

/** Filter of the license list and the reports from the query string. */
function licenseFilter(req) {
    const f = {};
    const period = q(req, 'period');
    if (period && period !== 'custom' && period !== 'all') {
        f.period = period;
        if (q(req, 'date')) f.date = q(req, 'date');
    } else {
        f.from = q(req, 'from') || null;
        f.to = q(req, 'to') || null;
    }
    for (const k of ['customerId', 'salesId', 'type', 'kind', 'q']) if (q(req, k)) f[k] = q(req, k);
    return f;
}

const fileName = (s) => String(s || 'all').replace(/[^0-9A-Za-z_-]/g, '');

function createApi({ config, store: db, audit, privateKey, keys, today, requireSession: auth, mailer, digest, contactDefaults }) {
    const router = express.Router();
    const json = express.json({ limit: '16kb' });
    const jsonLarge = express.json({ limit: '64kb' }); // mail templates

    /** Wraps a handler: StoreError -> its status with { error, code, field }. */
    const h = (fn) => async (req, res, next) => {
        try {
            await fn(req, res);
        } catch (e) {
            if (e instanceof StoreError || (e && e.name === 'StoreError')) {
                return res.status(e.status || 400).json({ error: e.message, code: e.code, ...(e.field ? { field: e.field } : {}) });
            }
            next(e);
        }
    };
    const licenseOr404 = (req) => {
        const l = db.getLicense(String(req.params.licenseId || ''));
        if (!l) throw new StoreError('not-found', 'License not found.', { field: 'licenseId' });
        return l;
    };
    const mailState = () => { const s = mailer.status(); return { enabled: s.enabled, reason: s.reason }; };
    const issueError = (res, r, what, licenseId) => {
        audit(`${what}-refused`, { licenseId, reason: r.message });
        const extra = {};
        if (r.next) extra.nextId = r.next;
        if (r.usedBy) extra.usedBy = r.usedBy;
        if (r.file) extra.file = r.file;
        if (r.check) extra.check = r.check;
        const message = r.code === 'failed' ? 'Not written: the database refused the change.' : r.message;
        if (r.code === 'failed') console.error('[license-issuer] Issue failed:', r.message);
        return res.status(r.status || 500).json({ error: message, code: r.code, ...(r.field ? { field: r.field } : {}), ...extra });
    };
    const issued = (r) => ({
        ok: true, license: r.license, licenseId: r.licenseId, file: r.outAbs, fileName: path.basename(r.outAbs), sha256: r.sha256, nextId: r.nextId,
        warnings: r.warnings || [], replaced: r.replaced || null,
        ...(r.registryError ? { registryError: `The license was issued and saved in the database, but the registry copy was not regenerated (${r.registryError.code || r.registryError.message}). It is regenerated after the next change.` } : {}),
    });
    const contactOf = (b, required) => {
        for (const k of ['contactVendor', 'contactEmail']) {
            if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw invalid(k, `${k === 'contactVendor' ? 'Vendor' : 'Contact email'} must be text.`);
        }
        if (!required && b.contactVendor === undefined && b.contactEmail === undefined) return undefined;
        return { vendor: (b.contactVendor || '').trim(), email: (b.contactEmail || '').trim() };
    };
    const strOrUndef = (b, k) => {
        if (b[k] === undefined || b[k] === null) return undefined;
        if (typeof b[k] !== 'string') throw invalid(k, `${k} must be text.`);
        return b[k];
    };

    // ------------------------------------------------------------------ lists and settings

    router.get('/meta', auth, h((req, res) => {
        res.json({
            currencies: R.CURRENCIES, licenseTypes: R.LICENSE_TYPES, termUnits: R.TERM_UNITS, revokeReasons: R.MANUAL_REVOKE_REASONS,
            statuses: R.STATUSES, kinds: ['new', 'renewal'], soonDays: R.SOON_DAYS, trialMaxDays: R.TRIAL_MAX_DAYS, digestDays: R.DIGEST_DAYS,
            limits: R.LIMITS, editableFields: R.EDITABLE_FIELDS, eventTypes: R.EVENT_TYPES, reissueVia: REISSUE_VIA, templateVariables: TEMPLATE_VARIABLES,
        });
    }));

    router.get('/settings', auth, h((req, res) => {
        const s = db.getSettings();
        res.json({ settings: s, templateVariables: TEMPLATE_VARIABLES, warnings: [...unknownVariables(s.mailSubject), ...unknownVariables(s.mailBody)] });
    }));

    router.patch('/settings', auth, jsonLarge, h((req, res) => {
        const b = bodyOf(req, SETTINGS_FIELDS);
        if (!Object.keys(b).length) throw invalid(null, 'Nothing to change.');
        const s = db.updateSettings(b);
        audit('settings', { detail: `changed: ${Object.keys(b).join(', ')}` });
        res.json({ settings: s, warnings: [...unknownVariables(s.mailSubject), ...unknownVariables(s.mailBody)].map((v) => `Unknown variable ${v}: it is sent as typed.`) });
    }));

    // ------------------------------------------------------------------ sales people

    router.get('/sales', auth, h((req, res) => res.json({ sales: db.listSales({ activeOnly: qBool(req, 'active', false) }) })));

    router.post('/sales', auth, json, h((req, res) => {
        const s = db.createSales(bodyOf(req, ['name', 'email']));
        audit('sales-create', { target: `sales ${s.id}`, detail: `${s.name}${s.email ? ` <${s.email}>` : ''}` });
        res.status(201).json({ sales: s });
    }));

    router.patch('/sales/:id', auth, json, h((req, res) => {
        const b = bodyOf(req, SALES_FIELDS);
        const s = db.updateSales(req.params.id, b);
        audit('sales-update', { target: `sales ${s.id}`, detail: `${s.name}: ${Object.keys(b).map((k) => `${k}=${b[k]}`).join(', ')}` });
        res.json({ sales: s });
    }));

    // ------------------------------------------------------------------ plans

    router.get('/plans', auth, h((req, res) => res.json({ plans: db.listPlans({ activeOnly: qBool(req, 'active', false) }) })));

    router.post('/plans', auth, json, h((req, res) => {
        const p = db.createPlan(bodyOf(req, PLAN_FIELDS));
        audit('plan-create', { target: `plan ${p.id}`, detail: `${p.name} (${p.type}, ${p.termValue} ${p.termUnit}, ${p.price ?? '-'} ${p.currency})` });
        res.status(201).json({ plan: p });
    }));

    router.patch('/plans/:id', auth, json, h((req, res) => {
        const b = bodyOf(req, PLAN_FIELDS);
        const p = db.updatePlan(req.params.id, b);
        audit('plan-update', { target: `plan ${p.id}`, detail: `${p.name}: ${Object.keys(b).join(', ')}` });
        res.json({ plan: p });
    }));

    // ------------------------------------------------------------------ customers

    router.get('/customers', auth, h((req, res) => res.json({ customers: db.listCustomers({ q: q(req, 'q') }) })));

    router.get('/customers/:id', auth, h((req, res) => {
        const c = db.getCustomer(req.params.id, { withLicenses: true });
        if (!c) throw new StoreError('not-found', 'Customer not found.', { field: 'customerId' });
        res.json({ customer: c });
    }));

    router.post('/customers', auth, json, h((req, res) => {
        const c = db.createCustomer(bodyOf(req, CUSTOMER_FIELDS));
        audit('customer-create', { customer: c.name, target: `customer ${c.id}` });
        res.status(201).json({ customer: c });
    }));

    router.patch('/customers/:id', auth, json, h((req, res) => {
        const b = bodyOf(req, CUSTOMER_FIELDS);
        const c = db.updateCustomer(req.params.id, b);
        audit('customer-update', { customer: c.name, target: `customer ${c.id}`, detail: `changed: ${Object.keys(b).join(', ')}` });
        res.json({ customer: c });
    }));

    router.delete('/customers/:id', auth, h((req, res) => {
        const c = db.getCustomer(req.params.id);
        const r = db.deleteCustomer(req.params.id);
        audit('customer-delete', { customer: c && c.name, target: `customer ${r.id}` });
        res.json(r);
    }));

    // ------------------------------------------------------------------ licenses

    router.get('/licenses', auth, h((req, res) => {
        const f = { ...licenseFilter(req), includeRevoked: qBool(req, 'includeRevoked', true) };
        if (q(req, 'status')) f.status = q(req, 'status');
        if (q(req, 'sort')) f.sort = q(req, 'sort');
        res.json({ today: today(), licenses: db.listLicenses(f) });
    }));

    router.get('/licenses/:licenseId', auth, h((req, res) => {
        const l = licenseOr404(req);
        const t = downloadTarget(db, l.licenseId, config.keyFile);
        res.json({
            license: l, events: db.licenseEvents(l.licenseId), customer: db.getCustomer(l.customerId),
            file: t.file ? { ok: true, name: t.name, error: null } : { ok: false, name: l.fileName, error: t.reason },
        });
    }));

    router.post('/licenses', auth, json, h((req, res) => {
        const b = bodyOf(req, ISSUE_FIELDS);
        const hasId = b.customerId !== undefined && b.customerId !== null && b.customerId !== '';
        const hasNew = b.newCustomer !== undefined && b.newCustomer !== null;
        if (hasId === hasNew) throw invalid('customerId', hasId ? 'Give customerId or newCustomer, not both.' : 'Customer is required.');
        if (hasNew) {
            if (typeof b.newCustomer !== 'object' || Array.isArray(b.newCustomer)) throw invalid('newCustomer', 'New customer must be an object.');
            for (const k of Object.keys(b.newCustomer)) if (!CUSTOMER_FIELDS.includes(k)) throw invalid(k, `Unknown customer field ${k}.`);
        }
        const contact = contactOf(b, true);
        const r = issueLicense(db, {
            key: privateKey, keyFile: config.keyFile, keyId: config.keyId, keys, onDate: today(), issuedDir: config.issuedDir, overwrite: false, source: 'web',
            requireSales: true, ...(hasId ? { customerId: b.customerId } : { newCustomer: b.newCustomer }), planId: b.planId, type: b.type, salesId: b.salesId,
            amount: b.amount, currency: b.currency, orderNo: b.orderNo, licenseId: strOrUndef(b, 'licenseId'), issuedAt: strOrUndef(b, 'issuedAt'),
            expiresAt: strOrUndef(b, 'expiresAt'), renewalOf: strOrUndef(b, 'renewalOf'), contact,
        });
        if (!r.ok) return issueError(res, r, 'issue', typeof b.licenseId === 'string' ? b.licenseId : '');
        const l = r.license;
        audit('issue', {
            licenseId: l.licenseId, customer: l.licensedTo, contact: core.contactText({ vendor: contact.vendor, email: contact.email }), issuedAt: l.issuedAt,
            expiresAt: l.expiresAt, file: r.outAbs, reason: r.registryError ? 'registry not updated' : '',
            detail: `${l.type}${l.isRenewal ? ' renewal' : ''}; sales ${l.salesName}; ${l.amount ?? '-'} ${l.currency || ''}${b.renewalOf ? `; renews ${b.renewalOf}` : ''}`,
        });
        res.status(201).json(issued(r));
    }));

    router.post('/licenses/:licenseId/replace', auth, json, h((req, res) => {
        const old = licenseOr404(req);
        const b = bodyOf(req, REPLACE_FIELDS);
        const r = replaceLicense(db, {
            key: privateKey, keyFile: config.keyFile, keyId: config.keyId, keys, onDate: today(), issuedDir: config.issuedDir, overwrite: false, source: 'web',
            requireSales: true, replaces: old.licenseId, licenseId: strOrUndef(b, 'licenseId'), issuedAt: strOrUndef(b, 'issuedAt'),
            expiresAt: strOrUndef(b, 'expiresAt'), planId: b.planId, salesId: b.salesId, amount: b.amount, currency: b.currency, orderNo: b.orderNo,
            contact: contactOf(b, false), note: b.note,
        });
        if (!r.ok) return issueError(res, r, 'replace', old.licenseId);
        const l = r.license;
        audit('replace', { licenseId: l.licenseId, customer: l.licensedTo, issuedAt: l.issuedAt, expiresAt: l.expiresAt, file: r.outAbs, target: `replaces ${old.licenseId}` });
        res.status(201).json(issued(r));
    }));

    router.patch('/licenses/:licenseId', auth, json, h((req, res) => {
        const l = licenseOr404(req);
        const b = bodyOf(req, R.EDITABLE_FIELDS);
        const r = db.editLicense(l.licenseId, b);
        if (r.changed) audit('license-edit', { licenseId: l.licenseId, detail: `changed: ${Object.keys(b).join(', ')}` });
        res.json(r);
    }));

    router.post('/licenses/:licenseId/revoke', auth, json, h((req, res) => {
        const l0 = licenseOr404(req);
        const b = bodyOf(req, ['reason', 'note']);
        const l = db.revokeLicense(l0.licenseId, { reason: b.reason, note: b.note });
        audit('revoke', { licenseId: l.licenseId, customer: l.licensedTo, reason: l.revokeReason });
        res.json({ license: l });
    }));

    router.post('/licenses/:licenseId/reissue', auth, json, h((req, res) => {
        const l = licenseOr404(req);
        const b = bodyOf(req, ['reason', 'via']);
        const via = b.via === undefined || b.via === null || b.via === '' ? 'download' : b.via;
        if (!REISSUE_VIA.includes(via)) throw invalid('via', `Via must be one of ${REISSUE_VIA.join(', ')}.`);
        const e = db.addEvent(l.licenseId, 'reissued', { reason: b.reason, via });
        audit('reissue', { licenseId: l.licenseId, reason: e.detail.reason, detail: `via ${via}` });
        res.status(201).json({ event: e });
    }));

    router.get('/licenses/:licenseId/events', auth, h((req, res) => {
        const l = licenseOr404(req);
        res.json({ events: db.licenseEvents(l.licenseId) });
    }));

    // ------------------------------------------------------------------ delivery mail

    /** Why a license cannot be sent (revoked / format 1 / expired), or null. */
    const blockedReason = (l) => {
        if (l.revokedAt) return `${l.licenseId} is revoked${l.replacedByLicenseId ? `; send its replacement ${l.replacedByLicenseId}` : ''}.`;
        if (l.status === R.STATUS.FORMAT1) return `${l.licenseId} is a format 1 license, which the product no longer accepts.`;
        if (l.status === R.STATUS.EXPIRED) return `${l.licenseId} has expired.`;
        return null;
    };

    router.get('/licenses/:licenseId/delivery', auth, h((req, res) => {
        const l = licenseOr404(req);
        const customer = db.getCustomer(l.customerId);
        const m = buildDelivery(db.getSettings(), l, contactDefaults());
        const t = downloadTarget(db, l.licenseId, config.keyFile);
        const to = (customer && customer.email) || '';
        const mail = mailState();
        const blocked = blockedReason(l);
        res.json({
            licenseId: l.licenseId, to, toValid: isMailAddress(to), subject: m.subject, text: m.text,
            attachment: { name: t.file ? t.name : l.fileName, ok: !!t.file, error: t.file ? null : t.reason },
            mail, blocked, canSend: mail.enabled && !!t.file && !blocked,
        });
    }));

    router.post('/licenses/:licenseId/send', auth, json, h(async (req, res) => {
        const l = licenseOr404(req);
        const b = bodyOf(req, ['to', 'reason']);
        const to = typeof b.to === 'string' ? b.to.trim() : '';
        if (!to) throw invalid('to', 'Recipient is required.');
        if (!isMailAddress(to)) throw invalid('to', 'Recipient must be one address like name@example.test.');
        const reason = b.reason === undefined ? null : R.text(b.reason, { field: 'reason', label: 'Reason', max: R.LIMITS.note });
        const mail = mailState();
        if (!mail.enabled) return res.status(503).json({ error: `Mail is not configured: ${mail.reason}`, code: 'mail-disabled' });
        const blocked = blockedReason(l);
        if (blocked) return res.status(409).json({ error: blocked, code: 'not-sendable', field: 'licenseId' });
        const t = downloadTarget(db, l.licenseId, config.keyFile);
        if (!t.file) {
            audit('deliver-refused', { licenseId: l.licenseId, to, reason: t.reason });
            return res.status(t.status).json({ error: t.reason, code: 'attachment' });
        }
        const m = buildDelivery(db.getSettings(), l, contactDefaults());
        const r = await mailer.send({ to, subject: m.subject, text: m.text, attachments: [{ filename: t.name, content: t.body, contentType: 'application/octet-stream' }] });
        const record = (type, detail) => {
            try { return db.addEvent(l.licenseId, type, detail); } catch (e) { console.error('[license-issuer] Could not record the delivery:', e.message); return null; }
        };
        if (!r.ok) {
            const event = record('delivery_failed', { to, subject: m.subject, error: r.error });
            audit('deliver-failed', { licenseId: l.licenseId, to, reason: r.error });
            return res.status(502).json({ error: `The mail was not sent: ${r.error}`, code: 'mail-failed', event });
        }
        const event = record('delivered', { to, subject: m.subject, attachment: t.name, messageId: r.messageId || null });
        const reissued = reason ? record('reissued', { reason, via: 'mail', to }) : null;
        audit('deliver', { licenseId: l.licenseId, customer: l.licensedTo, to, file: t.file, reason: reason || '' });
        res.json({ ok: true, to, subject: m.subject, attachment: t.name, messageId: r.messageId || null, event, reissued });
    }));

    // ------------------------------------------------------------------ mail status, test mail, digest

    router.get('/mail/status', auth, h((req, res) => res.json({ ...mailer.status(), digest: digest.status() })));

    router.post('/mail/test', auth, json, h(async (req, res) => {
        const b = bodyOf(req, ['to']);
        const s = mailer.status();
        const to = (typeof b.to === 'string' && b.to.trim()) || s.admin;
        if (b.to !== undefined && b.to !== null && typeof b.to !== 'string') throw invalid('to', 'Recipient must be text.');
        if (!to) throw invalid('to', 'Type a recipient (MAIL_ADMIN is not set).');
        if (!isMailAddress(to)) throw invalid('to', 'Recipient must be one address like name@example.test.');
        if (!s.enabled) return res.status(503).json({ error: `Mail is not configured: ${s.reason}`, code: 'mail-disabled' });
        const r = await mailer.send({ to, ...buildTestMail(new Date()) });
        if (!r.ok) {
            audit('mail-test-failed', { to, reason: r.error });
            return res.status(502).json({ error: `The test mail was not sent: ${r.error}`, code: 'mail-failed' });
        }
        audit('mail-test', { to });
        res.json({ ok: true, to, messageId: r.messageId || null });
    }));

    router.get('/mail/digest', auth, h((req, res) => res.json({ ...digest.preview(), mail: mailState(), status: digest.status() })));

    // ------------------------------------------------------------------ dashboard and reports

    router.get('/dashboard', auth, h((req, res) => {
        res.json({ ...db.dashboard(), renewals: db.renewalBoard({ days: q(req, 'days') || 30 }) });
    }));

    router.get('/renewals', auth, h((req, res) => {
        res.json(db.renewalBoard({ days: q(req, 'days') || 30, type: q(req, 'type') || undefined }));
    }));

    const reportFilter = (req) => {
        const f = licenseFilter(req);
        delete f.customerId;
        return f;
    };

    router.get('/reports', auth, h((req, res) => {
        const f = reportFilter(req);
        const s = db.reportSummary(f);
        const d = db.reportDetail({ ...f, includeRevoked: qBool(req, 'includeRevoked', false) });
        res.json({ from: s.from, to: s.to, summary: { rows: s.rows, totals: s.totals }, detail: { rows: d.rows } });
    }));

    const csvSend = (res, name, text) => {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.attachment(name);
        res.send(Buffer.from(text, 'utf8'));
    };

    router.get('/reports/summary.csv', auth, h((req, res) => {
        const s = db.reportSummary(reportFilter(req));
        audit('report-export', { detail: `summary ${s.from || 'start'}..${s.to || 'now'}` });
        csvSend(res, `license-report-summary-${fileName(s.from)}_${fileName(s.to)}.csv`, summaryCsv(s));
    }));

    router.get('/reports/detail.csv', auth, h((req, res) => {
        const d = db.reportDetail({ ...reportFilter(req), includeRevoked: qBool(req, 'includeRevoked', false) });
        audit('report-export', { detail: `detail ${d.from || 'start'}..${d.to || 'now'}` });
        csvSend(res, `license-report-detail-${fileName(d.from)}_${fileName(d.to)}.csv`, detailCsv(d));
    }));

    // ------------------------------------------------------------------ backups

    const backupInfo = ({ name, size, createdAt }) => ({ name, size, createdAt });

    router.get('/backups', auth, h((req, res) => {
        res.json({ dir: path.dirname(db.file), backups: db.listBackups().map(backupInfo) });
    }));

    router.post('/backups', auth, h((req, res) => {
        let b;
        try { b = db.createBackup(); } catch (e) {
            if (e instanceof StoreError) throw e;
            console.error('[license-issuer] Backup failed:', e.message);
            return res.status(500).json({ error: `The backup could not be written (${e.code || e.message}).`, code: 'backup-failed' });
        }
        audit('backup', { file: b.file });
        res.status(201).json({ backup: backupInfo(b) });
    }));

    router.get('/backups/:name', auth, h((req, res) => {
        const name = String(req.params.name || '');
        const file = db.backupPath(name);
        const refuse = (reason) => {
            audit('backup-download-refused', { file: name, reason });
            res.status(404).json({ error: 'No such backup.' });
        };
        if (!file || path.basename(file) !== name) return refuse('not a backup name');
        const dir = path.dirname(db.file);
        try {
            const st = fs.lstatSync(file);
            if (!st.isFile() || st.isSymbolicLink()) return refuse('not a regular file');
            if (!core.samePath(path.dirname(fs.realpathSync(file)), fs.realpathSync(dir))) return refuse('outside the database folder');
        } catch {
            return refuse('missing');
        }
        audit('backup-download', { file });
        res.set('Content-Type', 'application/octet-stream');
        res.attachment(name);
        res.sendFile(name, { root: dir, dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false }, (err) => {
            if (err && !res.headersSent) res.status(404).json({ error: 'No such backup.' });
        });
    }));

    return router;
}

module.exports = { createApi, bodyOf, licenseFilter };
