// License state on the client (free / paid edition). The server enforces everything; this only decides what the UI
// shows as locked. Source of truth: `license` in the login / /auth/config responses (backend lib/license.js).

export const LICENSE_EVENT = 'somp:license';

export const PAID_FEATURE_INFO = {
    aiAgent: { name: 'AI Ops Agent', desc: 'Investigate alerts in plain language: it looks up hosts, metrics, logs and recent changes and sums up likely causes and next steps.' },
    workflow: { name: 'Workflow Editor', desc: 'Design operations workflows by drag and drop (SSH, PowerShell, HTTP, approval steps), run them in one click and keep every run on record.' },
    scheduler: { name: 'Task Scheduler', desc: 'Run commands and scripts on this server or remote hosts on a cron schedule, with every result recorded and failures flagged.' },
    remoteCmd: { name: 'Remote Command', desc: 'Run a command on many Windows / Linux hosts at once, with a command library for the ones you use often.' },
    install: { name: 'Server Provision', desc: 'Deploy software to many servers: pre-checks, parallel installs, live progress and a full deployment history.' },
    manage_self_healing: { name: 'Self-Healing', desc: 'When an alert fires, the Scout agent runs a repair script on the host and reports the result.' },
    networkDevice: { name: 'Network Device', desc: 'Firewall, switch and load balancer integration: interfaces, policies, VLANs, MAC tables and daily configuration backups.' },
    ipam: { name: 'IPAM', desc: 'IP address and subnet management, subnet scans and DNS sync, with IPs in use elsewhere registered automatically.' },
    netSearch: { name: 'NetSearch', desc: 'Search the configuration backups of every network device to find where an IP, VLAN or ACL appears.' },
    dataCenter: { name: 'Data Center', desc: 'Data centers and rack layouts, topology map, hardware issues, spare parts stock, and contract and warranty expiry reminders.' },
    adControl: { name: 'AD Control', desc: 'Active Directory users, groups and OUs, reports and bulk actions, password expiry notices, and Group Policy management (links, inheritance, security filtering, backups).' },
    monitorScout: { name: 'Scout Monitor', desc: 'Live CPU, memory, disk and service status of every host running the Scout agent, with history charts and tags, and the Scout Open API for other systems.' },
    monitorAlerts: { name: 'Alerts & Rules', desc: 'Alert rules, bindings and exclusions per host or tag, alert history, alert quality and bulk resolve.' },
    monitorWinEvent: { name: 'Live Event Viewer', desc: 'Windows event and Linux log streams from the Scout agents, SIEM analytics and forensics.' },
    monitorLinuxLog: { name: 'Log Settings', desc: 'Which Windows event logs and Linux log files each Scout agent collects, and log retention.' },
    monitorAgents: { name: 'Agents', desc: 'Scout agent API keys, agent install tokens, versions and connection status.' },
    nutanixClone: { name: 'Nutanix Clone VM', desc: 'Clone VMs from templates in bulk, with IP / switch and template / BU mappings and live clone progress. The VM list and power actions stay available on the free edition.' },
};

export function readStoredLicense(storage = globalThis.localStorage) {
    try {
        const user = JSON.parse(storage.getItem('user') || 'null');
        return user && user.license && typeof user.license === 'object' ? user.license : null;
    } catch {
        return null;
    }
}

export function storeLicense(license, storage = globalThis.localStorage) {
    try {
        const user = JSON.parse(storage.getItem('user') || 'null');
        if (!user || typeof user !== 'object') return;
        storage.setItem('user', JSON.stringify({ ...user, license }));
    } catch { /* storage unavailable */ }
}

export const isLockedFlag = (flag, license) => !!(license && Array.isArray(license.locked) && license.locked.includes(flag));
export const isFree = (license) => !!(license && license.edition === 'free');

export function licenseLabel(license) {
    if (!license) return '';
    if (license.edition === 'paid') {
        const base = license.customer ? `Licensed to ${license.customer}` : 'Licensed';
        return license.trial === true ? (license.customer ? `Trial \u2014 ${base}` : 'Trial') : base;
    }
    return license.edition === 'free' ? 'Free' : '';
}

// Vendor contact for renewals: `contact` ({ vendor, email } or null) in the license state, from the license file, the
// license removed last or the server's .env (backend lib/license.js resolveContact). '' when there is none.
export function contactText(contact) {
    if (!contact || typeof contact !== 'object') return '';
    const vendor = typeof contact.vendor === 'string' ? contact.vendor.trim() : '';
    const email = typeof contact.email === 'string' ? contact.email.trim() : '';
    if (vendor && email) return `${vendor} (${email})`;
    return vendor || email;
}

export const isLicenseError = (err) => !!(err && err.response && err.response.data && err.response.data.code === 'LICENSE_REQUIRED');

// Expiry reminders: the SuperAdmin dialog shows once per license and threshold (days left <= 30 / 14 / 7 / 3 / 2 / 1;
// trial licenses: 7 / 3 / 1, like the server's reminders).
export const REMINDER_DAYS = [30, 14, 7, 3, 2, 1];
export const TRIAL_REMINDER_DAYS = [7, 3, 1];
export const isTrial = (license) => !!(license && license.trial === true);
export const reminderDays = (license) => (isTrial(license) ? TRIAL_REMINDER_DAYS : REMINDER_DAYS);
const isDays = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Colour of the days left, in step with the reminders: 'warning' from the first reminder day (paid 30, trial 7),
 * 'danger' in the last week of a paid license / the last 3 days of a trial.
 */
export function expiryTone(daysLeft, trial = false) {
    if (!isDays(daysLeft)) return 'normal';
    if (daysLeft <= (trial ? 3 : 7)) return 'danger';
    return daysLeft <= (trial ? TRIAL_REMINDER_DAYS : REMINDER_DAYS)[0] ? 'warning' : 'normal';
}

export function expiryText(license) {
    if (!license) return '';
    if (license.edition === 'paid' && license.expiresAt) {
        const n = license.daysLeft;
        const left = !isDays(n) ? '' : n === 0 ? ' (expires today)' : n === 1 ? ' (1 day left)' : ` (${n} days left)`;
        return `Expires ${license.expiresAt}${left}`;
    }
    if (license.edition === 'free' && license.expiredAt) return `Expired on ${license.expiredAt}`;
    return '';
}

// Smallest threshold that is >= daysLeft (null when more than the largest threshold is left or daysLeft is unknown).
// `trial` selects the trial thresholds (7 / 3 / 1).
export function reminderThreshold(daysLeft, trial = false) {
    if (!isDays(daysLeft)) return null;
    const hit = (trial ? TRIAL_REMINDER_DAYS : REMINDER_DAYS).filter(d => d >= daysLeft);
    return hit.length ? Math.min(...hit) : null;
}

export function reminderKey(license) {
    if (!license || license.edition !== 'paid' || !license.licenseId) return '';
    const t = reminderThreshold(license.daysLeft, isTrial(license));
    return t === null ? '' : `somp.licenseReminder:${license.licenseId}:${t}`;
}

// The SuperAdmin dialog is shown once per browser, license and threshold: the key is kept in localStorage.
// `storage` is anything with getItem / setItem (localStorage in the app, a stub in tests); errors count as "not shown".
export function shouldShowReminder(license, storage) {
    const key = reminderKey(license);
    if (!key) return false;
    try { return !storage.getItem(key); } catch { return true; }
}

export function markReminderShown(license, storage) {
    const key = reminderKey(license);
    if (!key) return;
    try { storage.setItem(key, String(Date.now())); } catch { /* storage unavailable */ }
}

// "Go to License page": the Settings screen reads the category from sessionStorage when it mounts, and listens for
// this event when it is already open.
export const SETTINGS_CATEGORY_EVENT = 'somp:settings-category';

export function openLicensePage() {
    try { sessionStorage.setItem('somp.settings.category', 'license'); } catch { /* storage unavailable */ }
    try { window.dispatchEvent(new CustomEvent(SETTINGS_CATEGORY_EVENT, { detail: { category: 'license' } })); } catch { /* no window (tests) */ }
}
