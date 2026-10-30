// Pure helpers for scan history, host changes, new-host badge, subnet settings forms and CSV export (no React, no network).

const DAY_MS = 86400000;

/** "1h 2m 3s" / "45s" / "<1s" / "-" for a duration in ms. */
export function formatDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '-';
    const total = Math.round(Number(ms) / 1000);
    if (total < 1) return '<1s';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h) return `${h}h ${m}m ${sec}s`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
}

/** True when the host was first seen within `days` days (default 7). */
export function isNewHost(host, nowMs = Date.now(), days = 7) {
    const t = host && host.firstSeen ? new Date(host.firstSeen).getTime() : NaN;
    if (!Number.isFinite(t)) return false;
    const age = nowMs - t;
    return age >= -DAY_MS && age <= days * DAY_MS;
}

/** Short text for the scope of a scan: "Whole inventory", "Subnet 10.1.2", "Host 10.1.2.3". */
export function describeScope(scan) {
    const scope = scan && scan.scope;
    if (scope && scope.ip) return `Host ${scope.ip}`;
    if (scope && scope.subnet) return `Subnet ${scope.subnet}`;
    return 'All subnets';
}

const TRIGGERS = { manual: 'Manual', schedule: 'Scheduled', catchup: 'Scheduled (catch-up)' };

export function scanTriggerText(scan) {
    if (!scan || !scan.trigger) return '-';
    const base = TRIGGERS[scan.trigger] || scan.trigger;
    return scan.requestedBy && scan.requestedBy !== 'SYSTEM' ? `${base} by ${scan.requestedBy}` : base;
}

/** Badge list for a scan row: running / aborted / partial / degraded. */
export function scanFlags(scan) {
    const out = [];
    if (!scan) return out;
    if (scan.running) out.push({ label: 'RUNNING', tone: 'warning' });
    if (scan.aborted) out.push({ label: 'ABORTED', tone: 'danger' });
    if (scan.partial) out.push({ label: 'PARTIAL', tone: 'info' });
    const degraded = Array.isArray(scan.degradedSubnets) ? scan.degradedSubnets.length : 0;
    if (degraded) out.push({ label: `DEGRADED x${degraded}`, tone: 'warning' });
    return out;
}

export function describeDegraded(scan) {
    const list = scan && Array.isArray(scan.degradedSubnets) ? scan.degradedSubnets : [];
    return list.map(d => `${d.subnet}: ${d.missed}/${d.previouslyOnline} hosts did not answer`).join('; ');
}

const FIELD_LABELS = { hostname: 'Hostname', os: 'OS', osVersion: 'OS version', cpu: 'CPU', memoryGB: 'Memory (GB)', timezone: 'Timezone', status: 'Status' };

export function fieldLabel(field) { return FIELD_LABELS[field] || field || '-'; }

/** Value text of a change cell: null/'' show as an em dash. */
export function changeValue(v) {
    return v === null || v === undefined || v === '' ? '—' : String(v);
}

/** "old -> new" text of a change row. */
export function changeText(change) {
    return `${changeValue(change && change.oldValue)} → ${changeValue(change && change.newValue)}`;
}

/** Query string for the CSV export from the screen's current filters (server filters: status, subnet, q, os). */
export function buildExportQuery({ statusFilter, selectedSubnet, filter } = {}) {
    const p = new URLSearchParams();
    p.set('format', 'csv');
    // Same meaning as the table filters: win / linux / unknown = that OS category of hosts that are not offline
    if (statusFilter === 'offline') p.set('status', 'offline');
    else if (statusFilter === 'win' || statusFilter === 'linux' || statusFilter === 'unknown') p.set('os', statusFilter);
    if (selectedSubnet) p.set('subnet', selectedSubnet);
    const q = typeof filter === 'string' ? filter.trim() : '';
    if (q) p.set('q', q);
    return p.toString();
}

/** File name from a Content-Disposition header, else a dated fallback. */
export function exportFileName(disposition, now = new Date()) {
    const m = typeof disposition === 'string' && disposition.match(/filename="?([^";]+)"?/i);
    if (m) return m[1];
    const d = now.toISOString().slice(0, 10).replace(/-/g, '');
    return `server-inventory-${d}.csv`;
}

/** "22, 3389" -> [22, 3389]; returns { ports, error }. Empty text = no ports. */
export function parsePorts(text) {
    const parts = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
    const ports = [];
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return { ports: [], error: `"${p}" is not a port number` };
        const n = Number(p);
        if (n < 1 || n > 65535) return { ports: [], error: `Port ${p} must be between 1 and 65535` };
        if (!ports.includes(n)) ports.push(n);
    }
    if (ports.length > 10) return { ports: [], error: 'At most 10 ports' };
    return { ports, error: null };
}

/** Editable row for a subnet entry (all inputs as strings so empty = no override). */
export function subnetSettingsToForm(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    return {
        concurrency: e.concurrency === undefined || e.concurrency === null ? '' : String(e.concurrency),
        tcpPorts: Array.isArray(e.tcpPorts) ? e.tcpPorts.join(', ') : '',
        autoSyncPrometheus: e.autoSyncPrometheus === true ? 'on' : e.autoSyncPrometheus === false ? 'off' : '',
        credentialProfile: e.credentialProfile || '',
        timezoneOffset: e.timezoneOffset === undefined || e.timezoneOffset === null ? '' : String(e.timezoneOffset)
    };
}

/** One form row -> API entry (empty fields are omitted = no override). Returns { entry, error }. */
export function formToSubnetSettings(form) {
    const f = form || {};
    const entry = {};
    const c = String(f.concurrency ?? '').trim();
    if (c !== '') {
        const n = Number(c);
        if (!Number.isInteger(n) || n < 1 || n > 64) return { entry: null, error: 'Concurrency must be a whole number between 1 and 64' };
        entry.concurrency = n;
    }
    if (String(f.tcpPorts ?? '').trim() !== '') {
        const { ports, error } = parsePorts(f.tcpPorts);
        if (error) return { entry: null, error };
        if (ports.length < 1) return { entry: null, error: 'TCP ports must list 1 to 10 ports' };
        entry.tcpPorts = ports;
    }
    if (f.autoSyncPrometheus === 'on') entry.autoSyncPrometheus = true;
    else if (f.autoSyncPrometheus === 'off') entry.autoSyncPrometheus = false;
    if (f.credentialProfile) entry.credentialProfile = f.credentialProfile;
    const tz = String(f.timezoneOffset ?? '').trim();
    if (tz !== '') {
        const n = Number(tz);
        if (!Number.isFinite(n) || n < -12 || n > 14) return { entry: null, error: 'Timezone offset must be a number between -12 and 14' };
        entry.timezoneOffset = n;
    }
    return { entry, error: null };
}

/** Whole subnetSettings map (full map is replaced on save). Rows without overrides are dropped. */
/** Drops settings of subnets that are no longer configured (a key stays while any configured entry has its /24). */
export function keepConfiguredSubnetSettings(settings, subnets) {
    const base = (e) => String(e || '').split(':')[0].trim();
    const prefixes = new Set((subnets || []).map(base));
    const out = {};
    for (const [k, v] of Object.entries(settings || {})) if (prefixes.has(base(k))) out[k] = v;
    return out;
}

export function buildSubnetSettingsPayload(forms) {
    const out = {};
    for (const [key, form] of Object.entries(forms || {})) {
        const { entry, error } = formToSubnetSettings(form);
        if (error) return { settings: null, error: `${key}: ${error}` };
        if (Object.keys(entry).length) out[key] = entry;
    }
    return { settings: out, error: null };
}

const PROBE_FIELDS = [
    ['concurrencyPerSubnet', 1, 64, 16],
    ['subnetConcurrency', 1, 16, 4],
    ['missesBeforeOffline', 1, 10, 2],
    ['outageThresholdPct', 10, 100, 50]
];
export const PROBE_FIELD_META = PROBE_FIELDS.map(([key, min, max, def]) => ({ key, min, max, def }));
export const DEFAULT_PROBE_PORTS = [22, 3389, 5985, 5986];

/** Probe form (strings) from the stored config.probe (defaults shown when unset). */
export function probeToForm(probe) {
    const p = probe && typeof probe === 'object' ? probe : {};
    const form = {};
    for (const { key, def } of PROBE_FIELD_META) form[key] = String(Number.isInteger(p[key]) ? p[key] : def);
    form.tcpPorts = (Array.isArray(p.tcpPorts) && p.tcpPorts.length ? p.tcpPorts : DEFAULT_PROBE_PORTS).join(', ');
    return form;
}

export function formToProbe(form) {
    const out = {};
    for (const { key, min, max } of PROBE_FIELD_META) {
        const n = Number(String(form[key] ?? '').trim());
        if (!Number.isInteger(n) || n < min || n > max) return { probe: null, error: `${key} must be a whole number between ${min} and ${max}` };
        out[key] = n;
    }
    const { ports, error } = parsePorts(form.tcpPorts);
    if (error) return { probe: null, error };
    if (ports.length < 1) return { probe: null, error: 'tcpPorts must list 1 to 10 ports' };
    out.tcpPorts = ports;
    return { probe: out, error: null };
}

/** Body of PUT /credential-profiles/:name: passwords only when typed (blank = keep). */
export function buildProfileBody(form) {
    const body = {};
    if (typeof form.winUser === 'string') body.winUser = form.winUser.trim();
    if (typeof form.linuxUser === 'string') body.linuxUser = form.linuxUser.trim();
    if (form.winPassword) body.winPassword = form.winPassword;
    if (form.linuxPassword) body.linuxPassword = form.linuxPassword;
    if (form.clearWinPassword && !form.winPassword) body.winPassword = '';
    if (form.clearLinuxPassword && !form.linuxPassword) body.linuxPassword = '';
    return body;
}

/** Readable text of an API error (axios or fetch style): lists the validation errors of a 400. */
export function apiErrorText(err, fallback = 'Request failed') {
    const d = err && err.response && err.response.data;
    if (d && Array.isArray(d.errors) && d.errors.length) return d.errors.slice(0, 10).join('\n');
    if (d && typeof d.error === 'string') {
        if (d.code === 'PROFILE_IN_USE' && Array.isArray(d.subnets)) return `${d.error} (${d.subnets.join(', ')})`;
        return d.error;
    }
    return (err && err.message) || fallback;
}
