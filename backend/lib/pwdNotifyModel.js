// Password expiry notifications: settings, who is due today, and the mails (Traditional Chinese + English).
// Pure functions, no PowerShell or SMTP.

const DEFAULT_TIME = '09:00';
const DEFAULT_DAYS = [14, 7, 3, 2, 1];
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());

/** "14, 7,3" -> [14, 7, 3] (unique, 1-90, largest first); null when any entry is not such a number. */
function parseDays(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) return [...DEFAULT_DAYS];
    const parts = text.split(/[,\s]+/).filter(Boolean);
    if (!parts.every(p => /^\d{1,2}$/.test(p) && Number(p) >= 1 && Number(p) <= MAX_DAYS)) return null;
    return [...new Set(parts.map(Number))].sort((a, b) => b - a);
}

/** "HH:MM" -> { h, m, text }; null when invalid. Empty -> 09:00. */
function parseTime(value) {
    const v = String(value === undefined || value === null ? '' : value).trim() || DEFAULT_TIME;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
    return m ? { h: Number(m[1]), m: Number(m[2]), text: `${m[1].padStart(2, '0')}:${m[2]}` } : null;
}

/** Split at ';' not escaped as "\;" */
function splitDns(value) {
    const out = [];
    let cur = '';
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
        if (s[i] === ';') { out.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
}

const DN_PART_RE = /^(OU|CN|DC)=.+$/i;
function isScopeDn(dn) {
    if (!dn || dn.length > 2048 || /[\x00-\x1f]/.test(dn)) return false;
    const parts = dn.split(/(?<!\\),/);
    return parts.every(p => DN_PART_RE.test(p.trim())) && /^DC=/i.test(parts[parts.length - 1].trim());
}

/**
 * The notification settings from the environment (Settings > System Settings > AD Hierarchy & SearchBase).
 * @returns {{ enabled, testMode, time, days, ous, ousSource, adminTo, adminToSource, changeUrl, mailReady, errors: string[] }}
 */
function readConfig(env = process.env) {
    const errors = [];
    const enabled = String(env.PWD_NOTIFY_ENABLED || '').toLowerCase() === 'true';
    const testMode = String(env.PWD_NOTIFY_TEST_MODE === undefined || env.PWD_NOTIFY_TEST_MODE === '' ? 'true' : env.PWD_NOTIFY_TEST_MODE).toLowerCase() !== 'false';
    const time = parseTime(env.PWD_NOTIFY_TIME);
    if (!time) errors.push('PWD_NOTIFY_TIME must be HH:MM (00:00 to 23:59)');
    const days = parseDays(env.PWD_NOTIFY_DAYS);
    if (!days) errors.push(`PWD_NOTIFY_DAYS must be whole numbers from 1 to ${MAX_DAYS}, separated by commas`);

    let ous = splitDns(env.PWD_NOTIFY_OUS);
    let ousSource = 'PWD_NOTIFY_OUS';
    if (!ous.length) {
        ous = splitDns(env.AD_OU_SEARCH);
        ousSource = ous.length ? 'AD_OU_SEARCH' : 'domain';
    }
    const badOu = ous.find(d => !isScopeDn(d));
    if (badOu) errors.push(`${ousSource} has an entry that is not an OU distinguished name: ${badOu.slice(0, 120)}`);

    let adminTo = String(env.PWD_NOTIFY_ADMIN_TO || '').trim();
    let adminToSource = 'PWD_NOTIFY_ADMIN_TO';
    if (!adminTo) { adminTo = String(env.MAIL_RELAY_RECIPIENT || '').trim(); adminToSource = 'MAIL_RELAY_RECIPIENT'; }
    const adminList = adminTo.split(/[;,]/).map(x => x.trim()).filter(Boolean);
    if (adminList.some(a => !isEmail(a))) errors.push(`${adminToSource} has an address that is not an email address`);
    if (testMode && !adminList.length) errors.push('Test mode needs a summary recipient (PWD_NOTIFY_ADMIN_TO or MAIL_RELAY_RECIPIENT)');

    const changeUrl = String(env.PWD_NOTIFY_CHANGE_URL || '').trim();
    if (changeUrl && !/^https?:\/\/[^\s"<>]+$/i.test(changeUrl)) errors.push('PWD_NOTIFY_CHANGE_URL must be an http(s) address');

    const mailReady = !!(String(env.MAIL_RELAY_SERVER || '').trim() && String(env.MAIL_RELAY_SENDER || '').trim());
    if (enabled && !mailReady) errors.push('Mail Relay is not configured (MAIL_RELAY_SERVER and MAIL_RELAY_SENDER)');

    return { enabled, testMode, time, days, ous, ousSource, adminTo: adminList, adminToSource, changeUrl, mailReady, errors };
}

const startOfLocalDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Calendar days from today to the expiry day (server local time): today -> 0, tomorrow -> 1. */
function daysLeft(expiresIso, now = new Date()) {
    const exp = new Date(expiresIso);
    if (Number.isNaN(exp.getTime())) return null;
    return Math.round((startOfLocalDay(exp) - startOfLocalDay(now)) / DAY_MS);
}

/**
 * Accounts to notify today: daysLeft is one of the configured days.
 * accounts: [{ sam, name, mail, expires }] -> { due: [{ ..., daysLeft }], noEmail: [...] } sorted by days left, then account.
 */
function selectDue(accounts, days, now = new Date()) {
    const due = [];
    const noEmail = [];
    for (const a of accounts || []) {
        const left = daysLeft(a.expires, now);
        if (left === null || !days.includes(left)) continue;
        const entry = { sam: String(a.sam || ''), name: String(a.name || a.sam || ''), mail: String(a.mail || '').trim(), expires: a.expires, daysLeft: left };
        (isEmail(entry.mail) ? due : noEmail).push(entry);
    }
    const order = (x, y) => x.daysLeft - y.daysLeft || x.sam.localeCompare(y.sam);
    return { due: due.sort(order), noEmail: noEmail.sort(order) };
}

const escapeHtml = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const two = (n) => String(n).padStart(2, '0');
const formatLocal = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const daysZh = (n) => (n <= 0 ? '今天' : `${n} 天後`);
const daysEn = (n) => (n <= 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`);

/** The mail to one user. { subject, text, html } */
function buildUserMail(entry, cfg) {
    const when = formatLocal(entry.expires);
    const subject = `密碼將於${daysZh(entry.daysLeft)}到期 / Your password expires ${daysEn(entry.daysLeft)}`;
    const howZh = cfg.changeUrl
        ? `請在到期前變更密碼：在公司電腦按 Ctrl+Alt+Del 選「變更密碼」，或前往 ${cfg.changeUrl}`
        : '請在到期前變更密碼：在公司電腦按 Ctrl+Alt+Del，選「變更密碼」。';
    const howEn = cfg.changeUrl
        ? `Change it before then: press Ctrl+Alt+Del on your work computer and choose "Change a password", or go to ${cfg.changeUrl}`
        : 'Change it before then: press Ctrl+Alt+Del on your work computer and choose "Change a password".';
    const warnZh = 'IT 不會用 email 向你索取密碼，請勿回覆密碼或點選來源不明的連結。';
    const warnEn = 'IT never asks for your password by email. Do not reply with your password or follow links you do not trust.';
    const text = [
        `${entry.name} 您好，`, '',
        `您的帳號 ${entry.sam} 的密碼將於${daysZh(entry.daysLeft)}（${when}）到期。`, howZh, warnZh, '',
        '----', '',
        `Hello ${entry.name},`, '',
        `The password of your account ${entry.sam} expires ${daysEn(entry.daysLeft)} (${when}).`, howEn, warnEn, '',
        '此信由系統自動寄出 / This message was sent automatically.',
    ].join('\n');
    const link = cfg.changeUrl ? `<a href="${escapeHtml(cfg.changeUrl)}">${escapeHtml(cfg.changeUrl)}</a>` : '';
    const p = (s) => `<p style="margin:0 0 10px">${s}</p>`;
    const html = `<div style="font-family:Segoe UI,Microsoft JhengHei,Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
${p(`${escapeHtml(entry.name)} 您好，`)}
${p(`您的帳號 <b>${escapeHtml(entry.sam)}</b> 的密碼將於<b>${escapeHtml(daysZh(entry.daysLeft))}</b>（${escapeHtml(when)}）到期。`)}
${p(cfg.changeUrl ? `請在到期前變更密碼：在公司電腦按 Ctrl+Alt+Del 選「變更密碼」，或前往 ${link}` : escapeHtml(howZh))}
${p(`<span style="color:#b45309">${escapeHtml(warnZh)}</span>`)}
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
${p(`Hello ${escapeHtml(entry.name)},`)}
${p(`The password of your account <b>${escapeHtml(entry.sam)}</b> expires <b>${escapeHtml(daysEn(entry.daysLeft))}</b> (${escapeHtml(when)}).`)}
${p(cfg.changeUrl ? `Change it before then: press Ctrl+Alt+Del on your work computer and choose "Change a password", or go to ${link}` : escapeHtml(howEn))}
${p(`<span style="color:#b45309">${escapeHtml(warnEn)}</span>`)}
<p style="margin:16px 0 0;color:#888;font-size:12px">此信由系統自動寄出 / This message was sent automatically.</p>
</div>`;
    return { subject, text, html };
}

/** The daily summary to the administrator. result: { at, testMode, scanned, sent, failed, noEmail, overLimit, error } */
function buildSummaryMail(result) {
    const date = result.at ? formatLocal(result.at).slice(0, 10) : '';
    const counts = `sent ${result.sent.length}, failed ${result.failed.length}, no email ${result.noEmail.length}${result.overLimit.length ? `, over the limit ${result.overLimit.length}` : ''}`;
    const subject = `${result.testMode ? '[TEST] ' : ''}密碼到期通知彙整 / Password expiry notices ${date}: ${counts}`;
    const rows = (list, extra) => list.map(e => `<tr><td>${escapeHtml(e.sam)}</td><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.mail || '')}</td><td>${escapeHtml(e.daysLeft)}</td><td>${escapeHtml(formatLocal(e.expires))}</td>${extra ? `<td>${escapeHtml(extra(e))}</td>` : ''}</tr>`).join('');
    const table = (title, list, extraHead, extra) => (list.length ? `<h3 style="font-size:14px;margin:16px 0 6px">${escapeHtml(title)} (${list.length})</h3>
<table cellpadding="4" style="border-collapse:collapse;font-size:13px" border="1"><tr><th>Account</th><th>Name</th><th>Email</th><th>Days left</th><th>Expires</th>${extraHead ? `<th>${escapeHtml(extraHead)}</th>` : ''}</tr>${rows(list, extra)}</table>` : '');
    const textList = (title, list, extra) => (list.length ? [`${title} (${list.length}):`, ...list.map(e => `  ${e.sam}\t${e.name}\t${e.mail || '-'}\t${e.daysLeft}d\t${formatLocal(e.expires)}${extra ? `\t${extra(e)}` : ''}`), ''] : []);
    const intro = result.testMode
        ? '測試模式：給使用者的信都改寄到本信箱，使用者沒有收到。 / Test mode: the user notices were sent to this mailbox instead of the users.'
        : '';
    const text = [
        `Password expiry notices ${date}`, intro, `Accounts checked: ${result.scanned}. ${counts}.`, result.error ? `Error: ${result.error}` : '', '',
        ...textList('Sent', result.sent), ...textList('Failed', result.failed, e => e.error || ''),
        ...textList('No email address (not notified)', result.noEmail), ...textList('Over the limit (not notified today)', result.overLimit),
    ].filter(l => l !== null).join('\n');
    const html = `<div style="font-family:Segoe UI,Microsoft JhengHei,Arial,sans-serif;font-size:14px;color:#222">
<p><b>Password expiry notices ${escapeHtml(date)}</b></p>
${intro ? `<p style="color:#b45309">${escapeHtml(intro)}</p>` : ''}
<p>Accounts checked: ${escapeHtml(result.scanned)}. ${escapeHtml(counts)}.</p>
${result.error ? `<p style="color:#b91c1c">Error: ${escapeHtml(result.error)}</p>` : ''}
${table('Sent', result.sent)}${table('Failed', result.failed, 'Error', e => e.error || '')}
${table('No email address (not notified)', result.noEmail)}${table('Over the limit (not notified today)', result.overLimit)}
</div>`;
    return { subject, text, html };
}

/** Due when the time has come today, within one hour after it, and today's run is not recorded yet. */
function isDue(now, time, lastRunDate) {
    if (!time) return false;
    const at = new Date(now);
    at.setHours(time.h, time.m, 0, 0);
    const diff = now.getTime() - at.getTime();
    return diff >= 0 && diff < 60 * 60 * 1000 && lastRunDate !== localDate(now);
}

module.exports = {
    DEFAULT_DAYS, MAX_DAYS, parseDays, parseTime, splitDns, isScopeDn, isEmail, readConfig, daysLeft, selectDue,
    escapeHtml, buildUserMail, buildSummaryMail, isDue, localDate, formatLocal,
};
