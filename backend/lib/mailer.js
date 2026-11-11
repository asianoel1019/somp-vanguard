const nodemailer = require('nodemailer');

class MailError extends Error {
    constructor(message) { super(message); this.userSafe = true; }
}

/** SMTP transport and sender from the Mail Relay settings; null when MAIL_RELAY_SERVER or MAIL_RELAY_SENDER is missing. */
function relay() {
    const server = process.env.MAIL_RELAY_SERVER;
    const sender = process.env.MAIL_RELAY_SENDER;
    if (!server || !sender) return null;
    const account = process.env.MAIL_RELAY_ACCOUNT;
    const pass = process.env.MAIL_RELAY_PWD;
    const transportOpts = {
        host: server,
        port: parseInt(process.env.MAIL_RELAY_PORT) || 25,
        secure: process.env.MAIL_RELAY_SECURE === 'true',
        tls: {
            rejectUnauthorized: false
        }
    };
    if (account && pass) {
        transportOpts.auth = { user: account, pass: pass };
    }
    return { transporter: module.exports._createTransport(transportOpts), sender };
}

/** Alerts and reports: best effort, failures are only logged. */
async function sendMail({ subject, html, text, to }) {
    const r = relay();
    const recipient = to || process.env.MAIL_RELAY_RECIPIENT;
    if (!r || !recipient) {
        console.warn('[Mailer] Missing configuration or recipient, email skipped.');
        return;
    }

    try {
        await r.transporter.sendMail({
            from: r.sender,
            to: recipient,
            subject: subject,
            html: html,
            text: text
        });
        console.log(`[Mailer] Email sent: ${subject}`);
    } catch (e) {
        console.error('[Mailer] Send failed:', e.message);
    }
}

/**
 * One mail whose outcome matters (e.g. a notice to a user): throws MailError when Mail Relay is not configured, there
 * is no recipient or the SMTP server refuses it. Resolves to the server's message id.
 */
async function deliverMail({ subject, html, text, to }) {
    const r = relay();
    if (!r) throw new MailError('Mail Relay is not configured (MAIL_RELAY_SERVER and MAIL_RELAY_SENDER)');
    if (!to) throw new MailError('No recipient');
    try {
        const info = await r.transporter.sendMail({ from: r.sender, to, subject, html, text });
        return info && info.messageId;
    } catch (e) {
        throw new MailError(String(e && e.message || e).replace(/[\x00-\x1f]+/g, ' ').slice(0, 300));
    }
}

module.exports = { sendMail, deliverMail, MailError, _createTransport: (opts) => nodemailer.createTransport(opts) };
