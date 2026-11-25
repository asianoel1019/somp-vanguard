// License expiry reminders: while a paid license has 30 days or less left, one notice per threshold (REMINDER_DAYS)
// goes out by email / Telegram; when it expires, one notice says the system is now the free edition. What was sent is
// kept per license (id + expiry date) in system/license_reminders.json, so a restart does not repeat it and a new or
// re-signed license starts clean.
const { getLicense, REMINDER_DAYS, today } = require('../lib/license');
const { readDataSync, writeDataSync } = require('../lib/db');
const mailer = require('../lib/mailer');
const contact = require('../lib/licenseContact');

const DOC_KEY = 'system/license_reminders.json';
const SUBJECT = 'SOMP Vanguard license expiry';
const WINDOW_DAYS = Math.max(...REMINDER_DAYS);
const logger = require('../lib/logger');

// One check may not take longer than this (a stalled channel must not keep the in-flight flag set forever).
const reminderTiming = { checkTimeoutMs: 60000 };

let timer = null;
let running = false;
let auditedExpiry = new Set();
let lastLogDay = ''; // in memory only: the daily line is also written on the first check after a restart

function reminderText(state, days) {
    return `SOMP Vanguard license ${state.licenseId} for ${state.customer} expires on ${state.expiresAt} (${days} days left). `
        + `After that date the system switches to the free edition. Contact ${contact.vendor} (${contact.email}) to renew.`;
}

function expiredText(state) {
    return `SOMP Vanguard license ${state.licenseId} for ${state.customer} expired on ${state.expiredAt}. `
        + `The system now runs as the free edition. Contact ${contact.vendor} (${contact.email}) to renew.`;
}

function readDoc() {
    const d = readDataSync(DOC_KEY, null);
    if (!d || typeof d !== 'object') return { licenseId: '', expiresAt: '', sent: [], expiredNotified: false };
    return {
        licenseId: typeof d.licenseId === 'string' ? d.licenseId : '',
        expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : '',
        sent: Array.isArray(d.sent) ? d.sent.filter(Number.isFinite) : [],
        expiredNotified: d.expiredNotified === true,
    };
}

/** Sends one text on every configured channel: { configured, ok } (channel names). Never throws. */
async function send(text, ignoreLicense) {
    const configured = [];
    const ok = [];
    if (process.env.MAIL_RELAY_RECIPIENT && process.env.MAIL_RELAY_SERVER) {
        configured.push('email');
        try {
            await mailer.deliverMail({ subject: SUBJECT, text, to: process.env.MAIL_RELAY_RECIPIENT, ignoreLicense });
            ok.push('email');
        } catch (e) {
            console.error('[License] Expiry email failed:', e && e.message);
        }
    } else {
        console.log('[License] Expiry email skipped: Mail Relay recipient is not configured');
    }
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        configured.push('telegram');
        try {
            if (await logger.sendTelegramChecked(text, { ignoreLicense })) ok.push('telegram');
            else console.error('[License] Expiry Telegram message failed');
        } catch (e) {
            console.error('[License] Expiry Telegram message failed:', e && e.message);
        }
    } else {
        console.log('[License] Expiry Telegram skipped: Telegram is not configured');
    }
    return { configured, ok };
}

async function checkNow() {
    const result = { sent: null, expired: false, channels: [] };
    const state = getLicense();
    const id = state.licenseId;
    if (!id) return result;

    // The expiry date is part of the key: a re-signed copy of the same id with another date starts clean.
    const expiresAt = state.expiresAt || state.expiredAt || '';
    let doc = readDoc();
    const before = JSON.stringify(doc);
    if (doc.licenseId !== id || doc.expiresAt !== expiresAt) doc = { licenseId: id, expiresAt, sent: [], expiredNotified: false };

    if (state.edition === 'paid' && state.daysLeft !== null && state.daysLeft <= WINDOW_DAYS) {
        const day = today();
        if (lastLogDay !== day) {
            console.log(`[License] Expires in ${state.daysLeft} days (${state.expiresAt})`);
            lastLogDay = day;
        }
        const candidates = REMINDER_DAYS.filter(d => d >= state.daysLeft && !doc.sent.includes(d));
        if (candidates.length) {
            const target = Math.min(...candidates);
            const r = await send(reminderText(state, state.daysLeft), false);
            // With no channel configured the threshold counts as handled (the in-app reminder still shows), so the
            // "skipped" lines are not repeated every hour.
            if (r.ok.length || !r.configured.length) {
                doc.sent = [...new Set([...doc.sent, ...REMINDER_DAYS.filter(d => d >= target)])].sort((a, b) => b - a);
            }
            if (r.ok.length) {
                result.sent = state.daysLeft;
                result.channels = r.ok;
            }
        }
    } else if (state.edition === 'free' && state.expiredAt) {
        result.expired = true;
        if (!doc.expiredNotified) {
            if (!auditedExpiry.has(id)) {
                console.warn(`[License] License ${id} expired on ${state.expiredAt}: switched to the free edition`);
                logger.auditLog('SYSTEM', 'License', `License ${id} expired on ${state.expiredAt}: switched to the free edition`);
                auditedExpiry.add(id);
            }
            const r = await send(expiredText(state), true);
            if (r.ok.length || !r.configured.length) doc.expiredNotified = true;
            result.channels = r.ok;
        }
    }

    if (JSON.stringify(doc) !== before) writeDataSync(DOC_KEY, doc);
    return result;
}

/** One check at a time; a check that runs longer than reminderTiming.checkTimeoutMs is given up so the next one can run. */
function guardedCheck() {
    if (running) return Promise.resolve();
    running = true;
    let limitTimer = null;
    const limit = new Promise((resolve) => {
        limitTimer = setTimeout(() => {
            console.error(`[License] Reminder check timed out after ${reminderTiming.checkTimeoutMs} ms; the next check will retry`);
            resolve();
        }, reminderTiming.checkTimeoutMs);
        if (limitTimer.unref) limitTimer.unref();
    });
    const check = checkNow().catch(e => console.error('[License] Reminder check failed:', e && e.message));
    return Promise.race([check, limit]).finally(() => { clearTimeout(limitTimer); running = false; });
}

function start({ intervalMs = 3600000 } = {}) {
    stop();
    guardedCheck();
    timer = setInterval(guardedCheck, intervalMs);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

function _resetForTest() {
    stop();
    running = false;
    auditedExpiry = new Set();
    lastLogDay = '';
}

module.exports = { checkNow, guardedCheck, start, stop, reminderText, expiredText, reminderTiming, _resetForTest, DOC_KEY };
