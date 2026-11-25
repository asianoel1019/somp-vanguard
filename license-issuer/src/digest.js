// Weekly digest: when this week's configured weekday / time (Settings; default Monday 09:00) has passed and the digest of
// this ISO week was not sent yet, each active sales person with an email gets their non-revoked licenses expiring within
// 90 days, and MAIL_ADMIN gets all of them grouped by sales person ("nothing expiring" when there are none). Sales people
// with nothing get no mail. Then last_digest_week is set. A failed mail is logged and retried on a later check (at most
// once per interval); mails that went out this week are not sent twice by this process. A mail the server refuses for
// good (5xx to the address, mail.js `permanent`) is logged and audited once and not retried: it does not hold up the week.
// The timer is started by src/server.js only (start()); tests call check() with their own clock and transport.
const { isMailAddress } = require('./config');
const R = require('./store/rules');

const INTERVAL_MS = 10 * 60 * 1000;
const START_DELAY_MS = 5000;

const typeText = (l) => (l.type === 'trial' ? 'Trial' : 'Paid');
const line = (l) => `- ${l.expiresAt} (${l.daysLeft === 0 ? 'today' : `${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} left`})  ${l.licenseId}  ${l.customerName}  [${typeText(l)}]`;
const FOOTER = ['', 'This message was sent automatically by the SOMP License Issuer (weekly digest).'];

/**
 * The mails of a digest: [{ key, kind: 'sales'|'admin', to, salesId, subject, text }], plus skipped:
 * [{ salesId, salesName, email, reason }] for sales people whose stored address cannot be used.
 */
function buildDigestMails(data, { admin = '', week }) {
    const mails = [];
    const skipped = [];
    for (const g of data.recipients) {
        if (!isMailAddress(g.email)) { skipped.push({ salesId: g.salesId, salesName: g.salesName, email: g.email, reason: 'not a valid address' }); continue; }
        mails.push({
            key: `sales:${g.salesId}:${g.email.toLowerCase()}`, kind: 'sales', to: g.email, salesId: g.salesId,
            subject: `Licenses expiring within ${data.days} days: ${g.licenses.length} (${week})`,
            text: [
                `Hello ${g.salesName},`, '',
                `${g.licenses.length} license(s) of your customers expire within the next ${data.days} days (until ${data.until}):`, '',
                ...g.licenses.map(line), '',
                'Renew them in the license issuer (Dashboard > Renewal board).', ...FOOTER,
            ].join('\n'),
        });
    }
    if (admin) {
        const text = data.total === 0
            ? [`No license expires within the next ${data.days} days (until ${data.until}).`, ...FOOTER]
            : [
                `${data.total} license(s) expire within the next ${data.days} days (${data.today} .. ${data.until}), by sales person:`,
                ...data.groups.flatMap((g) => {
                    const who = g.salesId === null ? 'Unassigned'
                        : `${g.salesName}${g.email ? ` <${g.email}>` : ' (no email)'}${g.active ? '' : ' (deactivated)'}`;
                    return ['', `${who}: ${g.licenses.length}`, ...g.licenses.map(line)];
                }),
                ...(skipped.length ? ['', `Not sent (stored address unusable): ${skipped.map((s) => s.salesName).join(', ')}`] : []),
                ...FOOTER,
            ];
        mails.push({
            key: 'admin', kind: 'admin', to: admin, salesId: null,
            subject: data.total === 0 ? `License digest ${week}: nothing expiring within ${data.days} days`
                : `License digest ${week}: ${data.total} license(s) expiring within ${data.days} days`,
            text: text.join('\n'),
        });
    }
    return { mails, skipped };
}

/**
 * The digest runner. o: store, mailer (src/mail createMailer), audit(event, details), now() -> Date,
 * intervalMs (default 10 min), timers { setInterval, clearInterval, setTimeout, clearTimeout } (tests), log (console-like).
 * check() -> Promise<{ status: 'disabled'|'not-due'|'running'|'throttled'|'sent'|'failed', week, sent, failed, skipped }>.
 */
function createDigest({ store, mailer, audit = () => {}, now = () => new Date(), intervalMs = INTERVAL_MS, timers = {}, log = console } = {}) {
    const T = { setInterval, clearInterval, setTimeout, clearTimeout, ...timers };
    let running = null;
    let done = { week: null, keys: new Set() }; // mails that went out this week (this process)
    let lastFailureMs = null;
    let lastRun = null;
    let handles = null;

    function preview(at = now()) {
        const week = R.isoWeek(at);
        const settings = store.getSettings();
        const data = store.digestData({ today: R.localDate(at) });
        const { mails, skipped } = buildDigestMails(data, { admin: mailer.status().admin, week });
        return {
            week, today: data.today, until: data.until, days: data.days, total: data.total, due: R.digestDue(settings, at),
            lastDigestWeek: settings.lastDigestWeek, mails: mails.map(({ key, ...m }) => ({ ...m, alreadySent: done.week === week && done.keys.has(key) })), skipped,
        };
    }

    async function run() {
        const at = now();
        const week = R.isoWeek(at);
        if (!mailer.status().enabled) return { status: 'disabled', week };
        const settings = store.getSettings();
        if (!R.digestDue(settings, at)) return { status: 'not-due', week };
        // 1 s slack: the interval timer may fire a little early, which must not skip a whole interval
        if (lastFailureMs !== null && at.getTime() - lastFailureMs < intervalMs - 1000) return { status: 'throttled', week };
        if (done.week !== week) done = { week, keys: new Set() };
        const data = store.digestData({ today: R.localDate(at) });
        const { mails, skipped } = buildDigestMails(data, { admin: mailer.status().admin, week });
        const sent = [];
        const failed = [];
        const rejected = [];
        for (const m of mails) {
            if (done.keys.has(m.key)) continue;
            const r = await mailer.send({ to: m.to, subject: m.subject, text: m.text });
            if (r.ok) { done.keys.add(m.key); sent.push({ kind: m.kind, to: m.to }); } else if (r.permanent) {
                done.keys.add(m.key); // final for this week: not retried
                rejected.push({ kind: m.kind, to: m.to, error: r.error });
            } else failed.push({ kind: m.kind, to: m.to, error: r.error });
        }
        for (const s of skipped) log.warn(`[license-issuer] Weekly digest: not sent to ${s.salesName} (${s.reason}).`);
        if (rejected.length) {
            const error = rejected.map((f) => `${f.to}: ${f.error}`).join('; ');
            log.error(`[license-issuer] Weekly digest ${week}: ${rejected.length} mail(s) refused by the mail server, not retried this week: ${error}`);
            audit('digest-failed', { reason: `${week}: ${rejected.length} refused by the mail server (not retried)`, detail: error });
        }
        if (failed.length) {
            lastFailureMs = at.getTime();
            const error = failed.map((f) => `${f.to}: ${f.error}`).join('; ');
            log.error(`[license-issuer] Weekly digest ${week}: ${failed.length} mail(s) failed, retrying on a later check: ${error}`);
            audit('digest-failed', { reason: `${week}: ${sent.length} sent, ${failed.length} failed`, detail: error });
            lastRun = { at: R.localIso(at), week, status: 'failed', sent: sent.length, failed: failed.length, error };
            return { status: 'failed', week, total: data.total, sent, failed, rejected, skipped };
        }
        lastFailureMs = null;
        store.updateSettings({ lastDigestWeek: week });
        audit('digest', { reason: `${week}: ${sent.length} mail(s) sent, ${data.total} license(s) expiring within ${data.days} days` });
        const error = rejected.length ? rejected.map((f) => `${f.to}: ${f.error}`).join('; ') : null;
        lastRun = { at: R.localIso(at), week, status: 'sent', sent: sent.length, failed: 0, rejected: rejected.length, error };
        return { status: 'sent', week, total: data.total, sent, failed, rejected, skipped };
    }

    /** One check (the timer calls it every intervalMs); never rejects, never overlaps. */
    function check() {
        if (running) return Promise.resolve({ status: 'running', week: R.isoWeek(now()) });
        running = run().catch((e) => {
            const error = mailer.scrub ? mailer.scrub(e.message || String(e)) : String(e.message || e);
            log.error(`[license-issuer] Weekly digest check failed: ${error}`);
            lastFailureMs = now().getTime();
            lastRun = { at: R.localIso(now()), week: R.isoWeek(now()), status: 'failed', sent: 0, failed: 0, error };
            return { status: 'failed', error };
        }).finally(() => { running = null; });
        return running;
    }

    function status() {
        const at = now();
        const settings = store.getSettings();
        return {
            enabled: mailer.status().enabled, scheduled: !!handles, weekday: settings.digestWeekday, time: settings.digestTime,
            lastDigestWeek: settings.lastDigestWeek, currentWeek: R.isoWeek(at), due: R.digestDue(settings, at), running: !!running, lastRun,
        };
    }

    /** Starts the checks: one shortly after start (catch-up), then every intervalMs. Timers are unref'd. */
    function start() {
        if (handles) return;
        const first = T.setTimeout(() => { check(); }, START_DELAY_MS);
        const every = T.setInterval(() => { check(); }, intervalMs);
        for (const h of [first, every]) if (h && typeof h.unref === 'function') h.unref();
        handles = { first, every };
    }

    function stop() {
        if (!handles) return;
        T.clearTimeout(handles.first);
        T.clearInterval(handles.every);
        handles = null;
    }

    return { check, preview, status, start, stop };
}

module.exports = { INTERVAL_MS, buildDigestMails, createDigest };
