// Strict validation helpers for Server Inventory (subnet entries, IPv4 guard, HTML escaping).
// Pure functions only: no I/O, safe to reuse from routes, the worker and tests.

const MAX_SUBNET_ENTRIES = 500;
const SUBNET_ENTRY_RE = /^\d{1,3}(\.\d{1,3}){2}(:\d{1,3}~\d{1,3})?$/;
// Legacy range syntaxes still found in stored configs: 10.0.0.1-100, 10.0.0:1~100, 10.0.0|1~100 ...
const LEGACY_RANGE_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3})[.:|](\d{1,3})[~-](\d{1,3})$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv4(ip) {
    return typeof ip === 'string' && IPV4_RE.test(ip);
}

// Every IP handed to PowerShell / SSH / a shell must pass through here first.
function assertIpv4(ip) {
    if (!isIpv4(ip)) {
        throw new Error(`Invalid IPv4 address: ${String(ip).slice(0, 64).replace(/[^\x20-\x7e]/g, '?')}`);
    }
    return ip;
}

/**
 * Parse one subnet entry ("10.1.2" or "10.1.2:10~50").
 * Returns { prefix, start, end } or { error } with a readable message.
 */
function parseSubnetEntry(entry, defaultRange = [1, 254]) {
    if (typeof entry !== 'string') return { error: 'must be a string' };
    const raw = entry.trim();
    let base, range;
    const legacy = LEGACY_RANGE_RE.exec(raw);
    if (SUBNET_ENTRY_RE.test(raw)) {
        [base, range] = raw.split(':');
        if (range) range = range.split('~');
    } else if (legacy) {
        base = legacy[1];
        range = [legacy[2], legacy[3]];
    } else {
        return { error: 'must look like 10.1.2 or 10.1.2:10~50' };
    }
    const octets = base.split('.').map(Number);
    if (octets.some(o => o > 255)) return { error: 'octets must be between 0 and 255' };
    let start = defaultRange[0];
    let end = defaultRange[1];
    if (range) {
        [start, end] = range.map(Number);
        if (start < 1 || end > 254) return { error: 'range must be within 1 to 254' };
        if (start > end) return { error: 'range start must not exceed range end' };
    }
    return { prefix: base, start, end, normalized: range ? `${base}:${start}~${end}` : base };
}

/**
 * Validate the editable parts of the inventory config.
 * Returns { valid, errors: string[] }. The whole save must be rejected if invalid.
 */
function validateInventoryConfig(config) {
    const errors = [];
    const warnings = [];
    const out = {};
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { valid: false, errors: ['Configuration must be an object'] };
    }

    if (config.subnets !== undefined) {
        if (!Array.isArray(config.subnets)) {
            errors.push('subnets must be an array');
        } else {
            if (config.subnets.length > MAX_SUBNET_ENTRIES) {
                errors.push(`subnets may contain at most ${MAX_SUBNET_ENTRIES} entries (got ${config.subnets.length})`);
            }
            config.subnets.slice(0, MAX_SUBNET_ENTRIES).forEach((entry, i) => {
                const parsed = parseSubnetEntry(entry);
                if (!parsed.error) {
                    out.subnets = out.subnets || [];
                    out.subnets.push(parsed.normalized);
                } else {
                    const shown = typeof entry === 'string' ? entry.slice(0, 40).replace(/[^\x20-\x7e]/g, '?') : typeof entry;
                    errors.push(`subnets[${i}] "${shown}": ${parsed.error}`);
                }
            });
        }
    }

    if (config.defaultScanRange !== undefined) {
        const r = config.defaultScanRange;
        const ok = Array.isArray(r) && r.length === 2 && r.every(n => Number.isInteger(n) && n >= 1 && n <= 254) && r[0] <= r[1];
        if (!ok) errors.push('defaultScanRange must be [start, end] within 1 to 254');
    }

    if (config.monitoredIps !== undefined) {
        if (!Array.isArray(config.monitoredIps)) {
            errors.push('monitoredIps must be an array');
        } else {
            // Invalid entries are dropped with a warning instead of failing the whole save
            out.monitoredIps = [];
            config.monitoredIps.forEach((ip, i) => {
                const t = typeof ip === 'string' ? ip.trim() : ip;
                if (isIpv4(t)) out.monitoredIps.push(t);
                else warnings.push(`monitoredIps[${i}] is not a valid IPv4 address and was dropped`);
            });
        }
    }

    if (config.schedule !== undefined && config.schedule !== null) {
        // Per-field checks only: the full check (completeness, cron reachability) runs on the schedule merged with the stored one
        errors.push(...require('./inventorySchedule').validateSchedule(config.schedule, { partial: true }));
    }

    if (config.probe !== undefined && config.probe !== null) errors.push(...validateProbeSettings(config.probe));

    if (config.subnetSettings !== undefined && config.subnetSettings !== null) {
        const res = validateSubnetSettings(config.subnetSettings);
        errors.push(...res.errors);
        if (!res.errors.length) out.subnetSettings = res.settings;
    }

    if (config.newHostAlerts !== undefined && typeof config.newHostAlerts !== 'boolean') errors.push('newHostAlerts must be true or false');

    if (config.historyRetentionDays !== undefined
        && !(Number.isInteger(config.historyRetentionDays) && config.historyRetentionDays >= MIN_RETENTION_DAYS && config.historyRetentionDays <= MAX_RETENTION_DAYS)) {
        errors.push(`historyRetentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`);
    }

    if (config.offlineDeleteDays !== undefined && coerceOfflineDeleteDays(config.offlineDeleteDays) !== Number(config.offlineDeleteDays)) {
        // Legacy stored values (null, 0, out of range) must never block a save / Start Scan: reset to the default
        warnings.push(`offlineDeleteDays was invalid and has been reset to ${DEFAULT_OFFLINE_DELETE_DAYS}`);
    }

    if (config.subnets !== undefined && Array.isArray(config.subnets) && errors.length === 0) out.subnets = out.subnets || [];
    return { valid: errors.length === 0, errors, warnings, subnets: out.subnets, monitoredIps: out.monitoredIps, subnetSettings: out.subnetSettings };
}

// ---------------------------------------------------------------------------------------------
// Per-subnet settings: config.subnetSettings { "<subnet entry>": { concurrency, tcpPorts, autoSyncPrometheus, credentialProfile, timezoneOffset } }
// ---------------------------------------------------------------------------------------------
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 730;
const PROFILE_NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
const SUBNET_SETTING_KEYS = ['concurrency', 'tcpPorts', 'autoSyncPrometheus', 'credentialProfile', 'timezoneOffset'];

/** Returns { settings (clean, keys normalised), errors }. null / '' values mean "no override" and are dropped. */
function validateSubnetSettings(input) {
    const errors = [];
    const settings = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { settings, errors: ['subnetSettings must be an object'] };
    const keys = Object.keys(input);
    if (keys.length > MAX_SUBNET_ENTRIES) errors.push(`subnetSettings may contain at most ${MAX_SUBNET_ENTRIES} entries`);
    for (const key of keys.slice(0, MAX_SUBNET_ENTRIES)) {
        const shown = String(key).slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
        const parsed = parseSubnetEntry(key);
        if (parsed.error) { errors.push(`subnetSettings "${shown}": ${parsed.error}`); continue; }
        const v = input[key];
        if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`subnetSettings "${shown}" must be an object`); continue; }
        const clean = {};
        const isEmpty = (x) => x === undefined || x === null || x === '';
        if (!isEmpty(v.concurrency)) {
            if (!Number.isInteger(v.concurrency) || v.concurrency < 1 || v.concurrency > 64) errors.push(`subnetSettings "${shown}".concurrency must be an integer between 1 and 64`);
            else clean.concurrency = v.concurrency;
        }
        if (!isEmpty(v.tcpPorts)) {
            const p = v.tcpPorts;
            if (!Array.isArray(p) || p.length < 1 || p.length > MAX_PROBE_PORTS || !p.every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) {
                errors.push(`subnetSettings "${shown}".tcpPorts must list 1 to ${MAX_PROBE_PORTS} ports between 1 and 65535`);
            } else clean.tcpPorts = [...new Set(p)];
        }
        if (!isEmpty(v.autoSyncPrometheus)) {
            if (typeof v.autoSyncPrometheus !== 'boolean') errors.push(`subnetSettings "${shown}".autoSyncPrometheus must be true or false`);
            else clean.autoSyncPrometheus = v.autoSyncPrometheus;
        }
        if (!isEmpty(v.credentialProfile)) {
            if (typeof v.credentialProfile !== 'string' || !PROFILE_NAME_RE.test(v.credentialProfile)) errors.push(`subnetSettings "${shown}".credentialProfile must match ${PROFILE_NAME_RE}`);
            else clean.credentialProfile = v.credentialProfile;
        }
        if (!isEmpty(v.timezoneOffset)) {
            const raw = v.timezoneOffset;
            const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN);
            if (!Number.isFinite(n) || n < -12 || n > 14) errors.push(`subnetSettings "${shown}".timezoneOffset must be a UTC offset between -12 and 14`);
            else clean.timezoneOffset = n;
        }
        if (Object.keys(clean).length) settings[parsed.normalized] = { ...(settings[parsed.normalized] || {}), ...clean };
    }
    return { settings, errors };
}

/** Stored per-subnet settings map (as saved; the legacy timezoneCheck.subnetOffsets rows are NOT merged in). */
function getSubnetSettings(config) {
    const out = {};
    const stored = config && config.subnetSettings && typeof config.subnetSettings === 'object' && !Array.isArray(config.subnetSettings) ? config.subnetSettings : {};
    for (const [k, v] of Object.entries(stored)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...v };
    }
    return out;
}

/**
 * Legacy timezoneCheck.subnetOffsets: target offset of the most specific row matching `ip`
 * (a row listing the exact IP beats a "10.1.2.*" / "10.1.2.0/24" row), or null.
 */
function legacyOffsetFor(config, ip) {
    const rows = config && config.timezoneCheck && Array.isArray(config.timezoneCheck.subnetOffsets) ? config.timezoneCheck.subnetOffsets : [];
    if (typeof ip !== 'string' || !ip) return null;
    let best = null; let bestRank = 0;
    for (const row of rows) {
        if (!row || typeof row.subnet !== 'string') continue;
        const offset = parseFloat(row.targetOffset);
        if (!Number.isFinite(offset)) continue;
        for (const token of row.subnet.split(',')) {
            const t = token.trim();
            if (!t) continue;
            let rank = 0;
            if (t === ip) rank = 2;
            else if (t.endsWith('.*') && ip.startsWith(t.slice(0, -1))) rank = 1;
            else if (t.endsWith('.0/24') && ip.startsWith(t.slice(0, -4))) rank = 1;
            if (rank > bestRank) { bestRank = rank; best = offset; }
        }
    }
    return best;
}

/**
 * The settings entry that applies to `target` (a subnet entry such as "10.1.2:5~9" / "10.1.2", or a single IPv4).
 * The target is treated as a range [start, end] (an IP is a range of one). An exact key wins; otherwise the NARROWEST
 * key of the same /24 whose range contains the whole target (a whole-/24 key counts as 1~254).
 */
function findSubnetSettings(config, target) {
    const all = getSubnetSettings(config);
    const keys = Object.keys(all);
    if (!keys.length || typeof target !== 'string') return null;
    let prefix; let start; let end; let normalized = null;
    if (isIpv4(target)) {
        const parts = target.split('.');
        prefix = parts.slice(0, 3).join('.');
        start = end = Number(parts[3]);
    } else {
        const p = parseSubnetEntry(target);
        if (p.error) return null;
        prefix = p.prefix; start = p.start; end = p.end; normalized = p.normalized;
    }
    if (normalized && all[normalized]) return all[normalized];
    let best = null; let bestWidth = Infinity;
    for (const k of keys) {
        const p = parseSubnetEntry(k);
        if (p.error || p.prefix !== prefix || start < p.start || end > p.end) continue;
        const width = p.end - p.start;
        if (width < bestWidth) { bestWidth = width; best = all[k]; }
    }
    return best;
}

// ---------------------------------------------------------------------------------------------
// Probe settings (liveness detection, concurrency, outage protection)
// ---------------------------------------------------------------------------------------------
const PROBE_DEFAULTS = Object.freeze({
    concurrencyPerSubnet: 16,
    subnetConcurrency: 4,
    missesBeforeOffline: 2,
    outageThresholdPct: 50,
    tcpPorts: Object.freeze([22, 3389, 5985, 5986])
});
const PROBE_LIMITS = {
    concurrencyPerSubnet: [1, 64],
    subnetConcurrency: [1, 16],
    missesBeforeOffline: [1, 10],
    outageThresholdPct: [10, 100]
};
const MAX_PROBE_PORTS = 10;

function validateProbeSettings(probe) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return ['probe must be an object'];
    const errors = [];
    for (const [key, [lo, hi]] of Object.entries(PROBE_LIMITS)) {
        if (probe[key] === undefined) continue;
        if (!Number.isInteger(probe[key]) || probe[key] < lo || probe[key] > hi) errors.push(`probe.${key} must be an integer between ${lo} and ${hi}`);
    }
    if (probe.tcpPorts !== undefined) {
        const p = probe.tcpPorts;
        if (!Array.isArray(p) || p.length < 1 || p.length > MAX_PROBE_PORTS) errors.push(`probe.tcpPorts must list 1 to ${MAX_PROBE_PORTS} ports`);
        else if (!p.every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) errors.push('probe.tcpPorts entries must be integers between 1 and 65535');
    }
    return errors;
}

/**
 * Effective probe settings for a scan of `subnet` (a /24 prefix or a subnet entry). Missing or invalid stored values
 * fall back to the defaults, so a damaged config never blocks a scan. Per-subnet overrides plug in here.
 */
function resolveProbeSettings(config, subnet) {
    const stored = config && config.probe && typeof config.probe === 'object' && !Array.isArray(config.probe) ? config.probe : {};
    const out = { ...PROBE_DEFAULTS, tcpPorts: [...PROBE_DEFAULTS.tcpPorts] };
    for (const [key, [lo, hi]] of Object.entries(PROBE_LIMITS)) {
        if (Number.isInteger(stored[key]) && stored[key] >= lo && stored[key] <= hi) out[key] = stored[key];
    }
    if (Array.isArray(stored.tcpPorts) && stored.tcpPorts.length >= 1 && stored.tcpPorts.length <= MAX_PROBE_PORTS
        && stored.tcpPorts.every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) {
        out.tcpPorts = [...new Set(stored.tcpPorts)];
    }
    // Per-subnet overrides (invalid stored values are ignored, never fatal)
    const own = subnet ? findSubnetSettings(config, String(subnet)) : null;
    if (own) {
        if (Number.isInteger(own.concurrency) && own.concurrency >= 1 && own.concurrency <= 64) out.concurrencyPerSubnet = own.concurrency;
        if (Array.isArray(own.tcpPorts) && own.tcpPorts.length >= 1 && own.tcpPorts.length <= MAX_PROBE_PORTS
            && own.tcpPorts.every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) out.tcpPorts = [...new Set(own.tcpPorts)];
        if (typeof own.autoSyncPrometheus === 'boolean') out.autoSyncPrometheus = own.autoSyncPrometheus;
        if (typeof own.credentialProfile === 'string' && PROFILE_NAME_RE.test(own.credentialProfile)) out.credentialProfile = own.credentialProfile;
        if (own.timezoneOffset !== undefined && Number.isFinite(Number(own.timezoneOffset))) out.timezoneOffset = Number(own.timezoneOffset);
    }
    return out;
}

// Fields a config save may change. Everything else (lastScan, lastDiscovered, ...) is owned by the server.
const DEFAULT_OFFLINE_DELETE_DAYS = 7;
function coerceOfflineDeleteDays(value) {
    const n = Number(value);
    return value !== null && value !== '' && Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_OFFLINE_DELETE_DAYS;
}
const SCHEDULE_FIELDS = ['enabled', 'frequency', 'time', 'weekday', 'cron'];
const EDITABLE_CONFIG_FIELDS = ['subnets', 'monitoredIps', 'defaultScanRange', 'schedule', 'timezoneCheck', 'offlineDeleteDays', 'autoSyncPrometheus', 'probe', 'subnetSettings', 'newHostAlerts', 'historyRetentionDays'];

/**
 * PATCH semantics: only editable fields present in `body` replace the stored ones; server-owned and unknown
 * stored fields are kept, unknown body fields are dropped. `check` is the validateInventoryConfig result.
 */
function mergeConfigPatch(existing, body, check) {
    const out = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}) };
    for (const field of EDITABLE_CONFIG_FIELDS) {
        if (body[field] === undefined) continue;
        out[field] = body[field];
    }
    if (check && check.subnets !== undefined) out.subnets = check.subnets;
    if (check && check.monitoredIps !== undefined) out.monitoredIps = check.monitoredIps;
    // subnetSettings: the validated, normalised map replaces the stored one (null clears it)
    if (body.subnetSettings === null) out.subnetSettings = {};
    else if (check && check.subnetSettings !== undefined) out.subnetSettings = check.subnetSettings;
    // Schedule PATCH merges per sub-field so a body carrying only { enabled } keeps the stored time / weekday / cron
    if (body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)) {
        const prev = existing && existing.schedule && typeof existing.schedule === 'object' ? existing.schedule : {};
        const merged = { ...prev };
        for (const f of SCHEDULE_FIELDS) if (body.schedule[f] !== undefined) merged[f] = body.schedule[f];
        out.schedule = merged;
    }
    // Probe PATCH merges per setting (a body with only { missesBeforeOffline } keeps the stored ports / concurrency)
    if (body.probe && typeof body.probe === 'object' && !Array.isArray(body.probe)) {
        const prev = existing && existing.probe && typeof existing.probe === 'object' && !Array.isArray(existing.probe) ? existing.probe : {};
        const merged = { ...prev };
        for (const f of [...Object.keys(PROBE_LIMITS), 'tcpPorts']) if (body.probe[f] !== undefined) merged[f] = body.probe[f];
        out.probe = merged;
    }
    if (out.schedule && typeof out.schedule === 'object') {
        const s = out.schedule;
        const clean = { enabled: !!s.enabled, frequency: s.frequency || 'daily' };
        if (s.time !== undefined) clean.time = String(s.time);
        if (clean.frequency === 'weekly') {
            // Legacy "weekly" without a weekday ran daily: keep it daily instead of inventing a weekday
            if (s.weekday === undefined || s.weekday === null || s.weekday === '') clean.frequency = 'daily';
            else clean.weekday = Number(s.weekday);
        }
        if (s.frequency === 'cron' || s.cron !== undefined) clean.cron = String(s.cron || '').trim();
        if (clean.frequency !== 'weekly' && s.weekday !== undefined && s.weekday !== null && s.weekday !== '') clean.weekday = Number(s.weekday);
        out.schedule = clean;
    }
    if (out.offlineDeleteDays !== undefined && body.offlineDeleteDays !== undefined) out.offlineDeleteDays = coerceOfflineDeleteDays(body.offlineDeleteDays);
    return out;
}

// Scout API keys embedded into generated install scripts must stay inside this charset
const API_KEY_RE = /^[A-Za-z0-9._-]{8,256}$/;
const API_KEY_ERROR = 'This API key contains unsupported characters; regenerate it in Agents';
function isValidApiKey(key) {
    return typeof key === 'string' && API_KEY_RE.test(key);
}
// POSIX single-quote quoting: each quote is closed, escaped and reopened (backslash-quote)
function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}
// PowerShell single-quoted literal: ' becomes ''. PowerShell also treats the typographic quotes U+2018..U+201B as
// single quotes, so those are doubled as well (a pasted "Bob's Tool" must not end the literal).
function psQuote(value) {
    return `'${String(value).replace(/['‘’‚‛]/g, m => m + m)}'`;
}

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    MAX_SUBNET_ENTRIES,
    isIpv4,
    assertIpv4,
    parseSubnetEntry,
    validateInventoryConfig,
    mergeConfigPatch,
    PROBE_DEFAULTS,
    validateProbeSettings,
    resolveProbeSettings,
    validateSubnetSettings,
    getSubnetSettings,
    legacyOffsetFor,
    findSubnetSettings,
    PROFILE_NAME_RE,
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
    DEFAULT_OFFLINE_DELETE_DAYS,
    EDITABLE_CONFIG_FIELDS,
    escapeHtml,
    API_KEY_RE,
    API_KEY_ERROR,
    isValidApiKey,
    shellQuote,
    psQuote
};
