// Pure helpers for the Server Provision UI (target picker, pre-check, job view, history).

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isValidIpv4(s) {
    return typeof s === 'string' && IPV4_RE.test(s.trim());
}

/** Splits free text (newline / comma / space / semicolon separated) into unique valid and invalid tokens. */
export function parseManualIps(text) {
    const valid = [];
    const invalid = [];
    const seen = new Set();
    String(text || '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean).forEach(t => {
        if (seen.has(t)) return;
        seen.add(t);
        (isValidIpv4(t) ? valid : invalid).push(t);
    });
    return { valid, invalid };
}

/** Unique IP list: picker chips first, then valid manual IPs. */
export function mergeTargets(selected, manualText) {
    const out = [];
    const seen = new Set();
    (selected || []).forEach(t => { if (t && t.ip && !seen.has(t.ip)) { seen.add(t.ip); out.push(t.ip); } });
    parseManualIps(manualText).valid.forEach(ip => { if (!seen.has(ip)) { seen.add(ip); out.push(ip); } });
    return out;
}

/** Manual IPs not known to the lookup cache (a Set of known IPs, including chip selections). */
export function unknownManualIps(manualText, knownSet) {
    return parseManualIps(manualText).valid.filter(ip => !knownSet.has(ip));
}

// forceReinstall: install even when a package's detect rule says it is already present.
// keepInstallers: leave the copied installers on the guest (Windows only; Linux commands copy nothing).
export function buildExecuteBody({ ips, buType, reboot, osType, forceReinstall, keepInstallers, allowUnknownTargets, isSuperAdmin }) {
    const body = { ips, buType, reboot: !!reboot, osType, forceReinstall: !!forceReinstall, keepInstallers: osType === 'windows' ? !!keepInstallers : false };
    if (isSuperAdmin && allowUnknownTargets) body.allowUnknownTargets = true;
    return body;
}

export function buildPrecheckBody({ ips, buType, osType, software, forceReinstall, allowUnknownTargets, isSuperAdmin }) {
    const body = { ips, buType, osType, forceReinstall: !!forceReinstall };
    if (Array.isArray(software) && software.length) body.software = software;
    if (isSuperAdmin && allowUnknownTargets) body.allowUnknownTargets = true;
    return body;
}

const CHECK_LABELS = {
    'known-target': 'Known target',
    reachable: 'Reachable',
    auth: 'Credentials',
    disk: 'Disk (X:)',
    installed: 'Installed',
    nas: 'NAS path',
    alreadyRunning: 'Not busy'
};

export function checkLabel(id) {
    return CHECK_LABELS[id] || String(id);
}

/** Ordered union of check ids across hosts (stable column order). */
export function precheckColumns(hosts) {
    const order = Object.keys(CHECK_LABELS);
    const found = new Set();
    (hosts || []).forEach(h => (h.checks || []).forEach(c => found.add(c.id)));
    const cols = order.filter(id => found.has(id));
    found.forEach(id => { if (!cols.includes(id)) cols.push(id); });
    return cols;
}

export function precheckFailures(precheck) {
    const hosts = (precheck && precheck.hosts) || [];
    return hosts.filter(h => h.ok === false || (h.checks || []).some(c => !c.ok));
}

/**
 * Warning text for the Install confirm dialog, or '' when no warning is needed.
 * precheck = last pre-check response (or null); ips = current target list.
 */
export function installWarning(precheck, ips, precheckIps) {
    if (!precheck) return 'Pre-check has not been run. Hosts may be unreachable or lack access.';
    const checked = new Set(precheckIps || []);
    const unchecked = (ips || []).filter(ip => !checked.has(ip));
    const failed = precheckFailures(precheck);
    const parts = [];
    if (failed.length) parts.push(`Pre-check failed for ${failed.length} host(s): ${failed.map(h => h.ip).join(', ')}.`);
    if (precheck.nas && precheck.nas.ok === false) parts.push(`NAS path check failed: ${precheck.nas.message || 'not reachable'}.`);
    if (!parts.length && precheck.ok === false) parts.push('Pre-check reported problems.');
    if (unchecked.length) parts.push(`${unchecked.length} host(s) were added after the last pre-check.`);
    return parts.join(' ');
}

export function jobStatusTone(status) {
    switch (status) {
        case 'ok': case 'done': return 'success';
        case 'failed': case 'interrupted': return 'danger';
        case 'partial': case 'cancelled': case 'skipped': return 'warning';
        case 'running': case 'queued': return 'info';
        default: return 'muted';
    }
}

export function toneClass(tone) {
    switch (tone) {
        case 'success': return 'bg-success/20 text-success';
        case 'danger': return 'bg-danger/20 text-danger';
        case 'warning': return 'bg-warning/20 text-warning';
        case 'info': return 'bg-primary/20 text-primary';
        default: return 'bg-white/10 text-secondary';
    }
}

export function isJobRunning(data) {
    return !!(data && data.job && data.job.running);
}

/** Hosts that "Retry failed hosts" would pick (failed / interrupted). */
export function retryableHosts(hosts) {
    return (hosts || []).filter(h => h.status === 'failed' || h.status === 'interrupted' || h.status === 'skipped');
}

export function canRetry(job, hosts) {
    if (!job || job.running) return false;
    return retryableHosts(hosts).length > 0;
}

export function jobProgress(hosts) {
    const list = hosts || [];
    const finished = list.filter(h => !['queued', 'running'].includes(h.status)).length;
    return { finished, total: list.length };
}

export function formatDuration(startedAt, finishedAt, now = Date.now()) {
    if (!startedAt) return '-';
    const s = Math.max(0, Math.round(((finishedAt || now) - startedAt) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

/**
 * Polling state machine. Input: previous consecutive error count and the outcome of the latest poll
 * ({ error: true } or { data }). Returns { action: 'continue' | 'finish' | 'lost', errors }.
 * Transient errors are tolerated (maxErrors consecutive failures -> 'lost').
 */
export function nextPollState(errors, outcome, maxErrors = 5) {
    if (outcome && outcome.error) {
        const n = (errors || 0) + 1;
        return { action: n >= maxErrors ? 'lost' : 'continue', errors: n };
    }
    return { action: isJobRunning(outcome && outcome.data) ? 'continue' : 'finish', errors: 0 };
}

export function packageLine(p) {
    const code = p.exitCode === undefined || p.exitCode === null ? '' : ` (exit ${p.exitCode})`;
    const label = p.skipped ? 'SKIP' : p.ok ? 'OK' : 'FAIL';
    return `${label} - ${p.name}${code}${p.message ? `: ${p.message}` : ''}`;
}

/** Text colour class of a package line: skipped (already installed) is neutral, not a success or a failure. */
export function packageClass(p) {
    if (p && p.skipped) return 'text-secondary';
    return p && p.ok ? 'text-success' : 'text-danger';
}

/** Informational "already installed" note of a pre-check host row ('' when there is none). */
export function installedNote(host) {
    const c = ((host && host.checks) || []).find(x => x.id === 'installed');
    return c && c.message ? c.message : '';
}

const RUNNER_LABELS = { worker: 'Background worker', web: 'Web server (fallback)' };

/** Process that runs (ran) the job; '' for jobs created before the runner was recorded. */
export function runnerLabel(job) {
    return (job && RUNNER_LABELS[job.runner]) || '';
}

/** "Triggered by: <SOMP user> / Run as: <Settings service account user name>" (no secrets; older jobs have no runAs). */
export function jobAccountsLine(job) {
    if (!job) return '';
    const parts = [];
    if (job.createdBy) parts.push(`Triggered by: ${job.createdBy}`);
    if (job.runAs) parts.push(`Run as: ${job.runAs}`);
    return parts.join(' / ');
}

/** Badge text for a job whose queued hosts were run again after a service / worker restart. */
export function resumedBadge(job) {
    return job && (job.resumed === true || Number(job.resumeCount) > 0) ? 'Resumed after restart' : '';
}

export function jobSummaryLine(job) {
    if (!job) return '';
    const parts = [`${job.hostCount || 0} host(s)`, `${job.okCount || 0} ok`, `${job.failCount || 0} failed`];
    if (job.rebootCount) parts.push(`${job.rebootCount} need reboot`);
    return parts.join(', ');
}
