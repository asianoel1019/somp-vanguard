// Mail of the license issuer (nodemailer, SMTP settings from .env): the test mail, delivery mails to customers (template +
// the .lic attachment) and the weekly digest (src/digest.js). Plain text only. The SMTP password stays inside the
// transport: it is never returned, logged or written into an event, and it is scrubbed from error texts.
const os = require('os');
const nodemailer = require('nodemailer');
const { isMailAddress, readMailConfig } = require('./config');
const R = require('./store/rules');

/** Template variables of the delivery mail (Settings > Email), with what they become. */
const TEMPLATE_VARIABLES = {
    customer: 'Customer name signed into the license',
    licenseId: 'License ID (L-YYYY-NNNN)',
    issuedAt: 'Issued date (YYYY-MM-DD)',
    expiresAt: 'Expiry date (YYYY-MM-DD)',
    type: 'paid or trial',
    vendor: 'Vendor signed into the license (else CONTACT_VENDOR)',
    vendorEmail: 'Contact email signed into the license (else CONTACT_EMAIL)',
    sales: 'Sales person of the license (empty when none)',
};

/** Replaces {name} placeholders in one pass (values are never expanded again); unknown ones stay as typed. */
function renderTemplate(template, vars) {
    return String(template || '').replace(/\{([A-Za-z]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLES, k) ? String(vars[k] ?? '') : m));
}

/** Placeholders in a template that are not template variables (typos), e.g. ['{customr}']. */
function unknownVariables(template) {
    const out = new Set();
    for (const m of String(template || '').matchAll(/\{([A-Za-z]+)\}/g)) if (!Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLES, m[1])) out.add(m[0]);
    return [...out];
}

/** Template values of a license; vendor / email fall back to the .env defaults when the license has none signed in. */
function templateVars(license, contactDefaults = {}) {
    return {
        customer: license.licensedTo || license.customerName || '',
        licenseId: license.licenseId,
        issuedAt: license.issuedAt || '',
        expiresAt: license.expiresAt || '',
        type: license.type,
        vendor: license.contactVendor || contactDefaults.vendor || '',
        vendorEmail: license.contactEmail || contactDefaults.email || '',
        sales: license.salesName || '',
    };
}

const oneLine = (s, max) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

/** { subject, text } of the delivery mail for a license, from the settings templates. */
function buildDelivery(settings, license, contactDefaults) {
    const vars = templateVars(license, contactDefaults);
    return {
        subject: oneLine(renderTemplate(settings.mailSubject, vars), 998),
        text: renderTemplate(settings.mailBody, vars).replace(/\r\n/g, '\n'),
    };
}

/** { subject, text } of the test mail. */
function buildTestMail(now = new Date()) {
    return {
        subject: 'SOMP License Issuer test mail',
        text: [
            'This is a test mail from the SOMP License Issuer.',
            '',
            `Sent at ${R.localIso(now)} from ${os.hostname()}.`,
            'If you can read it, delivery mails and the weekly digest can be sent with these settings.',
            '',
            'This message was sent automatically.',
        ].join('\n'),
    };
}

/**
 * The mailer: status() (never the password) and send({ to, subject, text, attachments? }) -> Promise<{ ok, messageId } |
 * { ok: false, error }> (never rejects). mail: readMailConfig(...) result. createTransport: nodemailer's (tests: a fake).
 */
function createMailer(mail = readMailConfig({}), { createTransport = nodemailer.createTransport } = {}) {
    let transport = null;
    const scrub = (text) => {
        let s = oneLine(text, 500);
        if (mail.pass) s = s.split(mail.pass).join('***');
        return s;
    };
    function status() {
        return {
            enabled: !!mail.enabled, reason: mail.enabled ? '' : mail.reason || 'Mail is not configured',
            host: mail.host || '', port: mail.port || null, secure: !!mail.secure, auth: !!mail.user,
            from: mail.from ? (mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address) : '',
            admin: mail.admin || '',
        };
    }
    async function send({ to, subject, text, attachments = [] }) {
        if (!mail.enabled) return { ok: false, error: `Mail is not configured: ${status().reason}` };
        if (!isMailAddress(to)) return { ok: false, error: 'The recipient is not a valid address.' };
        try {
            if (!transport) {
                transport = createTransport({
                    host: mail.host, port: mail.port, secure: mail.secure,
                    ...(mail.user ? { auth: { user: mail.user, pass: mail.pass } } : {}),
                    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
                    disableFileAccess: true, disableUrlAccess: true,
                });
            }
            const info = await transport.sendMail({
                from: { name: mail.from.name, address: mail.from.address }, to: { name: '', address: to },
                subject: oneLine(subject, 998), text: String(text), attachments, disableFileAccess: true, disableUrlAccess: true,
            });
            return { ok: true, messageId: info && info.messageId ? oneLine(info.messageId, 200) : '' };
        } catch (err) {
            transport = null; // a fresh connection next time
            // permanent: the server refused the address for good (5xx to RCPT / MAIL FROM); retrying will not help
            const permanent = !!err && err.code === 'EENVELOPE' && Number(err.responseCode) >= 500 && Number(err.responseCode) < 600;
            return { ok: false, permanent, error: scrub((err && (err.message || err.code)) || String(err)) || 'Unknown mail error' };
        }
    }
    return { status, send, scrub };
}

module.exports = { TEMPLATE_VARIABLES, renderTemplate, unknownVariables, templateVars, buildDelivery, buildTestMail, createMailer };
