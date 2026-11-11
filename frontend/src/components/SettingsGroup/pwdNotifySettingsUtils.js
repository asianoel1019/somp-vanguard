// Checks of the password expiry notification settings (the same rules the backend applies in lib/pwdNotifyModel).

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const DN_PART_RE = /^(OU|CN|DC)=.+$/i;

export const PWD_NOTIFY_DEFAULTS = { time: '09:00', days: '14,7,3,2,1' };

/** Split at ';' not escaped as "\;" */
export function splitDns(value) {
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

const isScopeDn = (dn) => {
    const parts = dn.split(/(?<!\\),/);
    return dn.length <= 2048 && parts.every(p => DN_PART_RE.test(p.trim())) && /^DC=/i.test(parts[parts.length - 1].trim());
};

/** true unless the value is 'false' (test mode is on until it is switched off explicitly) */
export const testModeOn = (cfg) => String(cfg.PWD_NOTIFY_TEST_MODE ?? '').toLowerCase() !== 'false';
export const enabledOn = (cfg) => String(cfg.PWD_NOTIFY_ENABLED ?? '').toLowerCase() === 'true';

/** { FIELD: 'what is wrong' } for the PWD_NOTIFY_* settings; empty when they can be saved. */
export function pwdNotifyProblems(cfg) {
    const p = {};
    const time = String(cfg.PWD_NOTIFY_TIME ?? '').trim();
    if (time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) p.PWD_NOTIFY_TIME = 'Use HH:MM, 00:00 to 23:59.';
    const days = String(cfg.PWD_NOTIFY_DAYS ?? '').trim();
    if (days && !days.split(/[,\s]+/).filter(Boolean).every(d => /^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 90)) {
        p.PWD_NOTIFY_DAYS = 'Whole numbers from 1 to 90, separated by commas.';
    }
    const bad = splitDns(cfg.PWD_NOTIFY_OUS).find(d => !isScopeDn(d));
    if (bad) p.PWD_NOTIFY_OUS = `Not an OU distinguished name: ${bad.slice(0, 80)}`;
    const admin = String(cfg.PWD_NOTIFY_ADMIN_TO ?? '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
    if (admin.some(a => !EMAIL_RE.test(a))) p.PWD_NOTIFY_ADMIN_TO = 'Email addresses separated by ; or ,.';
    const url = String(cfg.PWD_NOTIFY_CHANGE_URL ?? '').trim();
    if (url && !/^https?:\/\/[^\s"<>]+$/i.test(url)) p.PWD_NOTIFY_CHANGE_URL = 'An http:// or https:// address.';
    if (testModeOn(cfg) && !admin.length && !String(cfg.MAIL_RELAY_RECIPIENT ?? '').trim()) {
        p.PWD_NOTIFY_ADMIN_TO = 'Test mode needs a recipient: set this or MAIL_RELAY_RECIPIENT.';
    }
    return p;
}

/** "14, 7,3,7" -> "14,7,3" (unique, largest first) for display after editing; unchanged when not valid */
export function normalizeDays(value) {
    const parts = String(value ?? '').split(/[,\s]+/).filter(Boolean);
    if (!parts.length || !parts.every(d => /^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 90)) return value;
    return [...new Set(parts.map(Number))].sort((a, b) => b - a).join(',');
}

/** Off / Test mode / On, and whether Mail Relay is set up */
export function pwdNotifyState(cfg) {
    const mailReady = !!(String(cfg.MAIL_RELAY_SERVER ?? '').trim() && String(cfg.MAIL_RELAY_SENDER ?? '').trim());
    const state = !enabledOn(cfg) ? 'off' : testModeOn(cfg) ? 'test' : 'on';
    return { state, mailReady };
}
