/**
 * Server Provision pre-check: read-only probes per target host (known target, reachable, auth, disk, installed, NAS, already running).
 * Nothing is installed or changed and nothing is stored. Never uses the install runners.
 */
const prov = require('../lib/provisioning');
const runners = require('../lib/provisionRunners');
const powershell = require('../lib/powershell');
const ssh = require('../lib/ssh');
const netProbe = require('../lib/netProbe');
const jobs = require('./provisionJobs');

const PRECHECK_CONCURRENCY = 8;
const TCP_TIMEOUT_MS = 1500;
const AUTH_TIMEOUT_MS = 20000; // Linux SSH auth (R5)
const PS_PROBE_TIMEOUT_MS = 30000;
const PRECHECK_DEADLINE_MS = 120000;

// Global cap: all concurrent pre-check requests together run at most PRECHECK_CONCURRENCY probes
let precheckActive = 0;
const precheckWaiters = [];
async function withPrecheckSlot(fn) {
    if (precheckActive >= PRECHECK_CONCURRENCY) await new Promise(resolve => precheckWaiters.push(resolve));
    else precheckActive++;
    try { return await fn(); } finally {
        const next = precheckWaiters.shift();
        if (next) next(); // the slot is handed over
        else precheckActive--;
    }
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
    return out;
}

async function checkNas(ctx) {
    try {
        const script = prov.buildNasCheckScript({ nasPath: ctx.nasPath, credentialHeader: powershell.ENV_CREDENTIAL_HEADER });
        const r = prov.parseNasOutput(await powershell.runPowerShell(script, PS_PROBE_TIMEOUT_MS, { env: ctx.credEnv }));
        if (!r) return { id: 'nas', ok: false, message: 'NAS check returned no result' };
        return { id: 'nas', ok: r.ok === true, message: r.ok === true ? `NAS path reachable (${ctx.nasPath})` : prov.scrubSecrets(`NAS path not reachable: ${prov.oneLine(r.error, 160)}`, ctx.secrets) };
    } catch (e) {
        return { id: 'nas', ok: false, message: prov.scrubSecrets(`NAS check failed: ${runners.errText(e)}`, ctx.secrets) };
    }
}

async function probeWindows(ip, ctx, detects) {
    try {
        const script = prov.buildWindowsPrecheckScript({ ip, credentialHeader: powershell.ENV_CREDENTIAL_HEADER, detects });
        const r = prov.parsePrecheckOutput(await powershell.runPowerShell(script, PS_PROBE_TIMEOUT_MS, { env: ctx.credEnv }));
        if (!r) return { ok: false, error: 'No result returned by the probe' };
        return r;
    } catch (e) {
        return { ok: false, error: runners.errText(e) };
    }
}

async function probeLinux(ip, ctx, rules) {
    try {
        const c = ctx.linuxCreds;
        const sshOpts = { timeout: AUTH_TIMEOUT_MS, pinHostKey: true, execTimeoutMs: AUTH_TIMEOUT_MS };
        const r = await ssh.executeSSH(ip, c.user, c.password, 'echo ok', sshOpts);
        const ok = r.success === true && r.code === 0 && /ok/.test(String(r.stdout || ''));
        if (!ok) return { ok: false, error: `SSH command failed${r.stderr ? `: ${prov.oneLine(r.stderr, 120)}` : ''}` };
        // Read-only detect queries (rpm -q / dpkg-query / the configured command), one SSH exec each
        const installed = [];
        let detectError = '';
        for (const d of rules) {
            try {
                let cmd = prov.buildLinuxDetectCommand(d.detect);
                const res = prov.parseLinuxDetect(d.detect, await ssh.executeSSH(ip, c.user, c.password, cmd, sshOpts));
                installed.push({ idx: d.idx, found: res.found, version: res.version });
            } catch (e) { detectError = runners.errText(e); break; }
        }
        return { ok: true, installed, detectError };
    } catch (e) {
        return { ok: false, error: runners.errText(e) };
    }
}

/** The "installed" row (informational, never fails the host): which packages with a detect rule are already present. */
function installedCheck(software, input, probe) {
    const withRule = software.map((sw, idx) => ({ sw, idx })).filter(x => x.sw.detect);
    if (withRule.length === 0) return { id: 'installed', ok: true, message: 'No detect rules configured: every package will be installed' };
    if (input.forceReinstall) return { id: 'installed', ok: true, message: 'Force reinstall is on: detection is ignored and every package will be installed' };
    if (!probe) return { id: 'installed', ok: true, message: 'Not checked' };
    if (probe.detectError) return { id: 'installed', ok: true, message: prov.oneLine(`Could not check installed software: ${probe.detectError}`, 200) };
    const cmdOnly = withRule.filter(x => x.sw.detect.type === 'cmd').map(x => x.sw.name);
    const cmdNote = cmdOnly.length ? ` (cmd rule not evaluated in pre-check: ${cmdOnly.join(', ')})` : '';
    if (cmdOnly.length === withRule.length) return { id: 'installed', ok: true, message: `cmd rule not evaluated in pre-check: ${cmdOnly.join(', ')}` };
    const found = new Map((probe.installed || []).filter(i => i && i.found).map(i => [i.idx, i.version]));
    const names = withRule.filter(x => found.has(x.idx)).map(x => (found.get(x.idx) ? `${x.sw.name} (${prov.oneLine(found.get(x.idx), 40)})` : x.sw.name));
    return names.length
        ? { id: 'installed', ok: true, message: `Already installed, will be skipped: ${names.join(', ')}${cmdNote}` }
        : { id: 'installed', ok: true, message: `None of the ${withRule.length - cmdOnly.length} package(s) with a detect rule is installed yet${cmdNote}` };
}

/**
 * input = validated body; info = Map from lookupTargets; allowUnknown = SuperAdmin override is active.
 * Returns { osType, buType, ok, minFreeGB, nas, hosts }.
 */
async function runPrecheck({ input, info, ctx, settings, allowUnknown, software = [] }) {
    const isLinux = input.osType === 'linux';
    const port = isLinux ? 22 : 5985;
    const secrets = ctx.secrets || [];
    const deadline = Date.now() + PRECHECK_DEADLINE_MS;
    const rules = software.map((sw, idx) => ({ idx, detect: sw.detect })).filter(x => x.detect);
    const detects = input.forceReinstall ? [] : rules.map(x => ({ idx: x.idx, type: x.detect.type, value: x.detect.value, minVersion: x.detect.minVersion }));
    // cmd rules are user-defined commands: never run during the read-only pre-check (rpm / dpkg queries run without sudo)
    const linuxRules = input.forceReinstall ? [] : rules.filter(x => x.detect.type !== 'cmd');
    // NAS is checked once per request (not per host), concurrently with the host probes
    const nasPromise = isLinux ? Promise.resolve(null) : withPrecheckSlot(() => checkNas(ctx));

    const hostResults = await mapLimit(input.ips, PRECHECK_CONCURRENCY, (ip) => withPrecheckSlot(async () => {
        const t = info.get(ip) || { known: false, hostname: '', os: '' };
        const checks = [];
        if (Date.now() > deadline) {
            const msg = 'Skipped: pre-check time limit reached';
            for (const id of ['reachable', 'auth', ...(isLinux ? [] : ['disk'])]) checks.push({ id, ok: false, message: msg });
            checks.unshift({ id: 'known-target', ok: t.known, message: t.known ? `Known target (${t.source})` : 'Not in CMDB or inventory' });
            checks.push({ id: 'installed', ok: true, message: 'Not checked (time limit reached)' });
            if (!isLinux) checks.push({ id: 'nas', ok: false, message: 'pending' });
            checks.push({ id: 'alreadyRunning', ok: true, message: 'Not checked (time limit reached)' });
            return { ip, known: t.known, hostname: t.hostname || '', os: t.os || '', checks };
        }
        checks.push({ id: 'known-target', ok: t.known, message: t.known ? `Known target (${t.source})` : 'Not in CMDB or inventory' });
        let reachable = false;
        try { reachable = await netProbe.checkTcpPort(ip, port, TCP_TIMEOUT_MS); } catch (e) { reachable = false; }
        checks.push({ id: 'reachable', ok: reachable === true, message: reachable ? `TCP ${port} reachable` : `TCP ${port} not reachable within ${TCP_TIMEOUT_MS / 1000} s` });

        let hostname = t.hostname;
        let probe = null;
        const mayAuth = t.known || allowUnknown;
        if (!mayAuth || !reachable) {
            const why = !mayAuth ? 'Skipped: unknown target (credentials are not used for it)' : 'Skipped: host not reachable';
            checks.push({ id: 'auth', ok: false, message: why });
            if (!isLinux) checks.push({ id: 'disk', ok: false, message: why });
        } else if (isLinux) {
            const r = await probeLinux(ip, ctx, linuxRules);
            if (r.ok) probe = r;
            checks.push({ id: 'auth', ok: r.ok, message: r.ok ? 'SSH login ok' : prov.scrubSecrets(`SSH login failed: ${r.error}`, secrets) });
        } else {
            const r = await probeWindows(ip, ctx, detects);
            if (!r.ok) {
                checks.push({ id: 'auth', ok: false, message: prov.scrubSecrets(`WinRM login failed: ${prov.oneLine(r.error, 160)}`, secrets) });
                checks.push({ id: 'disk', ok: false, message: 'Skipped: no WinRM session' });
            } else {
                if (r.hostname) hostname = hostname || r.hostname;
                checks.push({ id: 'auth', ok: true, message: `WinRM login ok (${r.hostname || 'unknown name'})` });
                probe = r;
                const free = typeof r.freeGB === 'number' ? r.freeGB : null;
                if (!r.hasX) {
                    checks.push({ id: 'disk', ok: false, message: 'Drive X: not found \u2014 prepare the data disk (Nutanix Clone VM does this)' });
                } else if (free !== null && free < settings.minFreeGB) {
                    checks.push({ id: 'disk', ok: false, message: `Drive X: has ${free} GB free, at least ${settings.minFreeGB} GB required` });
                } else {
                    checks.push({ id: 'disk', ok: true, message: `Drive X: ${free === null ? 'free space unknown' : `${free} GB free`}` });
                }
            }
        }
        checks.push(installedCheck(software, input, probe));
        if (!isLinux) checks.push({ id: 'nas', ok: false, message: 'pending' });
        const owner = jobs.activeJobForIp(ip);
        checks.push({ id: 'alreadyRunning', ok: !owner, message: owner ? `Already being provisioned by job ${owner}` : 'No active job for this host' });
        return { ip, known: t.known, hostname: hostname || '', os: t.os || '', checks };
    }));
    const nas = await nasPromise;
    const hosts = hostResults.map(h => {
        const checks = h.checks.map(c => (c.id === 'nas' && nas ? { ...nas } : c));
        return { ip: h.ip, known: h.known, hostname: h.hostname, os: h.os, ok: checks.every(c => c.ok), checks };
    });
    const out = { osType: input.osType, buType: input.buType, minFreeGB: settings.minFreeGB, ok: hosts.every(h => h.ok), nas, hosts };
    if (isLinux) out.note = 'The Linux pre-check pins the SSH host key on first contact (trust on first use); later installs verify it.';
    return out;
}

module.exports = { runPrecheck, mapLimit, PRECHECK_CONCURRENCY };
