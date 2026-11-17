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
    if (license.edition === 'paid') return license.customer ? `Licensed to ${license.customer}` : 'Licensed';
    return license.edition === 'free' ? 'Free' : '';
}

export const isLicenseError = (err) => !!(err && err.response && err.response.data && err.response.data.code === 'LICENSE_REQUIRED');
