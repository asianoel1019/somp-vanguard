// Daily password expiry notifications (worker): at PWD_NOTIFY_TIME, mail every enabled user whose password expires in
// one of PWD_NOTIFY_DAYS days, then mail a summary to the administrator. Settings: lib/pwdNotifyModel.readConfig.
// - Today's run is recorded before it starts, so a restart never mails twice; a worker that starts more than an hour
//   after the set time skips that day.
// - Test mode sends the user notices to the summary recipient instead of the users.
// - A manual run that mails users (test mode off) counts as today's run; one is refused when today's already ran.
const { runAsService, psLit, adErrorMessage } = require('../lib/adService');
const { readDataSync } = require('../lib/db');
const { mutateDocument } = require('../lib/docStore');
const mailer = require('../lib/mailer');
const { auditLog } = require('../lib/logger');
const model = require('../lib/pwdNotifyModel');

const KEY = 'pwd_notify_runs.json';
const MAX_MAILS = 500;
const KEEP_RUNS = 30;
const TICK_MS = 60 * 1000;
const MODULE = 'AD Password Notify';

class NotifyError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; this.userSafe = true; }
}

let busy = false;
let timer = null;

function readDoc() {
    const doc = readDataSync(KEY, {});
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}
const mutate = (fn, fnName) => mutateDocument(KEY, fn, { defaultValue: {}, fnName, label: 'Password expiry notifications' });

/** Today's run, claimed once: false when it was already claimed. */
function claimToday(now) {
    let claimed = false;
    mutate((d) => {
        const today = model.localDate(now);
        if (d.schedule && d.schedule.lastRunDate === today) return false;
        d.schedule = { lastRunDate: today, startedAt: now.toISOString() };
        claimed = true;
        return true;
    }, 'pwdNotify.claimToday');
    return claimed;
}

function recordRun(entry) {
    mutate((d) => {
        d.runs = [entry, ...(Array.isArray(d.runs) ? d.runs : [])].slice(0, KEEP_RUNS);
        return true;
    }, 'pwdNotify.recordRun');
}

/**
 * Enabled accounts with an expiring password in the configured OUs (or the domain), expiring from today up to
 * the largest configured day count. -> { scanned, accounts: [{ sam, name, mail, expires }] }
 */
async function queryAccounts(cfg) {
    const maxDays = Math.max(...cfg.days);
    const output = await runAsService(`
$bases = @(${cfg.ous.map(psLit).join(', ')})
$filter = "Enabled -eq 'True' -and PasswordNeverExpires -eq 'False'"
$props = @('mail', 'DisplayName', 'msDS-UserPasswordExpiryTimeComputed')
if ($bases.Count -gt 0) {
    $users = foreach ($b in $bases) { Get-ADUser -Filter $filter -SearchBase $b -Properties $props -Credential $global:AD_CRED @dcArgs }
} else {
    $users = Get-ADUser -Filter $filter -Properties $props -Credential $global:AD_CRED @dcArgs
}
$today = (Get-Date).Date
$limit = $today.AddDays(${maxDays + 1})
$seen = @{}
$out = @(foreach ($u in @($users)) {
    if ($null -eq $u -or $seen.ContainsKey($u.SamAccountName)) { continue }
    $seen[$u.SamAccountName] = $true
    $ft = [int64]$u.'msDS-UserPasswordExpiryTimeComputed'
    if ($ft -le 0 -or $ft -ge [int64]::MaxValue) { continue }
    $exp = [DateTime]::FromFileTime($ft)
    if ($exp -lt $today -or $exp -ge $limit) { continue }
    [PSCustomObject]@{
        sam = [string]$u.SamAccountName
        name = [string]$(if ($u.DisplayName) { $u.DisplayName } else { $u.Name })
        mail = [string]$u.mail
        expires = $exp.ToUniversalTime().ToString('o')
    }
})
[PSCustomObject]@{ scanned = $seen.Count; accounts = $out } | ConvertTo-Json -Depth 4 -Compress
`, 300000);
    const raw = String(output || '').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : parsed.accounts ? [parsed.accounts] : [];
    return { scanned: Number(parsed.scanned) || 0, accounts };
}

const brief = (e) => ({ sam: e.sam, name: e.name, mail: e.mail, daysLeft: e.daysLeft, expires: e.expires, ...(e.error ? { error: e.error } : {}) });

/**
 * One run. dryRun: who would be mailed today, nothing sent or recorded.
 * @returns {Promise<{ at, trigger, by, testMode, dryRun, scanned, sent, failed, noEmail, overLimit, due?, summary, error }>}
 */
async function run({ now = new Date(), dryRun = false, trigger = 'manual', by = 'system', cfg = model.readConfig() } = {}) {
    if (cfg.errors.length) throw new NotifyError(cfg.errors.join('; '));
    const result = { at: now.toISOString(), trigger, by, testMode: cfg.testMode, dryRun, scanned: 0, sent: [], failed: [], noEmail: [], overLimit: [], summary: null, error: '' };
    try {
        const { scanned, accounts } = await queryAccounts(cfg);
        const { due, noEmail } = model.selectDue(accounts, cfg.days, now);
        result.scanned = scanned;
        result.noEmail = noEmail.map(brief);
        result.overLimit = due.slice(MAX_MAILS).map(brief);
        const toSend = due.slice(0, MAX_MAILS);
        if (dryRun) return { ...result, due: toSend.map(brief) };

        const adminTo = cfg.adminTo.join(', ');
        for (const e of toSend) {
            const mail = model.buildUserMail(e, cfg);
            try {
                await mailer.deliverMail(cfg.testMode
                    ? { ...mail, to: adminTo, subject: `[TEST -> ${e.mail}] ${mail.subject}` }
                    : { ...mail, to: e.mail });
                result.sent.push(brief(e));
            } catch (err) {
                result.failed.push(brief({ ...e, error: err.message }));
            }
        }
    } catch (err) {
        if (dryRun) throw new NotifyError(`Could not read the accounts: ${adErrorMessage(err)}`, 502);
        result.error = `Could not read the accounts: ${adErrorMessage(err)}`;
    }

    if (cfg.adminTo.length) {
        try {
            await mailer.deliverMail({ ...model.buildSummaryMail(result), to: cfg.adminTo.join(', ') });
            result.summary = 'sent';
        } catch (err) {
            result.summary = `failed: ${err.message}`;
        }
    } else {
        result.summary = 'no recipient';
    }

    recordRun(result);
    auditLog(by, MODULE, `${trigger === 'schedule' ? 'Scheduled' : 'Manual'} run${cfg.testMode ? ' (test mode)' : ''}: checked ${result.scanned}, sent ${result.sent.length}, failed ${result.failed.length}, no email ${result.noEmail.length}${result.overLimit.length ? `, over the limit ${result.overLimit.length}` : ''}${result.error ? `; ${result.error}` : ''}`);
    return result;
}

/** A run started from the page by a SuperAdmin. */
async function runNow(by, now = new Date()) {
    if (busy) throw new NotifyError('A run is already in progress', 409);
    const cfg = model.readConfig();
    if (cfg.errors.length) throw new NotifyError(cfg.errors.join('; '));
    if (!cfg.testMode && !claimToday(now)) {
        throw new NotifyError('Today\'s notices were already sent; users are not mailed twice in one day', 409);
    }
    busy = true;
    try {
        return await run({ now, trigger: 'manual', by, cfg });
    } finally {
        busy = false;
    }
}

/** Who would be mailed today (nothing sent). */
async function preview(now = new Date()) {
    return run({ now, dryRun: true, trigger: 'preview', cfg: model.readConfig() });
}

/** Settings as they apply now, today's state and the recent runs. */
function status() {
    const cfg = model.readConfig();
    const doc = readDoc();
    return {
        config: { ...cfg, time: cfg.time ? cfg.time.text : null },
        lastRunDate: (doc.schedule && doc.schedule.lastRunDate) || null,
        runs: Array.isArray(doc.runs) ? doc.runs : [],
        busy,
        maxMails: MAX_MAILS,
    };
}

/** One scheduler tick. */
async function tick(now = new Date()) {
    if (busy) return { skipped: 'running' };
    const cfg = model.readConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const doc = readDoc();
    if (!model.isDue(now, cfg.time, doc.schedule && doc.schedule.lastRunDate)) return { skipped: 'not-due' };
    if (!claimToday(now)) return { skipped: 'already-ran' };
    busy = true;
    try {
        if (cfg.errors.length) {
            const result = { at: now.toISOString(), trigger: 'schedule', by: 'system', testMode: cfg.testMode, dryRun: false, scanned: 0, sent: [], failed: [], noEmail: [], overLimit: [], summary: null, error: `Settings: ${cfg.errors.join('; ')}` };
            recordRun(result);
            auditLog('system', MODULE, `Scheduled run skipped: ${result.error}`);
            return result;
        }
        return await run({ now, trigger: 'schedule', by: 'system', cfg });
    } finally {
        busy = false;
    }
}

function initPwdExpiryNotifier() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick().catch(err => console.error('[Password Notify] Scheduler error:', err.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
}

module.exports = { initPwdExpiryNotifier, tick, run, runNow, preview, status, queryAccounts, NotifyError, MAX_MAILS, KEY };
