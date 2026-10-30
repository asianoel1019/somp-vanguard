// Per-host Windows / Linux install runners (moved out of routes/install.js so the job service reuses them).
// External effects go through module objects (powershell / ssh) so tests can inject fakes.
const powershell = require('./powershell');
const ssh = require('./ssh');
const prov = require('./provisioning');

// Own budget for one detect rule (both OS)
const DETECT_TIMEOUT_MS = 30000;

function setting(config, key, fallback = '') {
    return (config && config[key]) || process.env[key] || fallback;
}

function errText(e) {
    if (!e) return 'Unknown error';
    return prov.oneLine((e.error && e.error.message) || e.message || e.stderr || String(e), 300);
}

function scrubResult(r, secrets) {
    if (!secrets.length) return r;
    const s = (t) => prov.scrubSecrets(t, secrets);
    return {
        ...r,
        error: r.error ? s(r.error) : r.error,
        log: s(r.log),
        packages: r.packages.map(p => ({ ...p, message: s(p.message) }))
    };
}

const SERVICE_ACCOUNT_MISSING = 'Server Provision requires the service account in Settings (AD_ADMIN_USER / AD_ADMIN_PWD)';

/**
 * Credentials / paths needed to run a job, resolved in THE PROCESS THAT RUNS IT from the Settings default credentials
 * (inventoryCredentials.readDefaultCredentials: the one helper the Inventory scanner and deploy-agent use; values that
 * cannot be decrypted come back empty). Windows always runs as the service account AD_ADMIN_*, never as the signed-in
 * user and never with an empty credential env; Linux as LINUX_ADMIN_*. Lives in memory only (never persisted / IPC'd).
 * Returns { error } (readable) when something required is missing. A `user` argument is ignored.
 * ctx.runAs is the account user name (no secret) for the job view.
 */
function buildContext({ osType, config, deps } = {}) {
    const creds = require('./inventoryCredentials').readDefaultCredentials(deps || {});
    if (osType === 'linux') {
        const linuxCreds = { user: creds.linuxUser || 'root', password: creds.linuxPassword };
        if (!linuxCreds.password) return { error: 'LINUX_ADMIN_PWD is not configured' };
        return { ctx: { linuxCreds, secrets: [linuxCreds.password], runAs: linuxCreds.user } };
    }
    if (!creds.winUser || !creds.winPassword) return { error: SERVICE_ACCOUNT_MISSING };
    // same qualification as the Inventory scanner: a bare name gets ALLOWED_AD_DOMAIN
    let credUser = creds.winUser;
    if (creds.allowedAdDomain && !credUser.includes('\\') && !credUser.includes('@')) credUser = `${creds.allowedAdDomain}\\${credUser}`;
    return {
        ctx: {
            credEnv: powershell.buildCredentialEnv(credUser, creds.winPassword),
            secrets: [creds.winPassword],
            // no built-in default: the share is site specific (Settings / .env SYSNAS_SOFTWARE_PATH)
            nasPath: setting(config, 'SYSNAS_SOFTWARE_PATH', ''),
            runAs: credUser
        }
    };
}

/** Runs the detect rule of one Linux package: { found, version }. A non-zero exit simply means "not installed". */
async function detectLinux(ip, detect, creds, sshOpts) {
    let cmd = prov.buildLinuxDetectCommand(detect);
    let stdin;
    // rpm / dpkg queries need no root; a user-defined command runs like an installer command
    if (detect.type === 'cmd') ({ cmd, stdin } = prov.linuxSudoWrap(cmd, creds.user, creds.password));
    const o = sshOpts({ stdin });
    o.execTimeoutMs = Math.min(DETECT_TIMEOUT_MS, o.execTimeoutMs);
    const r = await ssh.executeSSH(ip, creds.user, creds.password, cmd, o);
    return prov.parseLinuxDetect(detect, r);
}

/** shouldStop(): true when the job was cancelled; no further package is started then. */
async function runLinuxHost(ip, software, opts, creds, shouldStop = () => false) {
    const started = Date.now();
    const packages = [];
    const lines = [`Connecting to ${ip} via SSH...`];
    let hostError;
    let stopped = false;
    const remaining = () => Math.max(1000, prov.LINUX_HOST_TIMEOUT_MS - (Date.now() - started));
    const sshOpts = (extra = {}) => ({ timeout: 10000, pinHostKey: true, execTimeoutMs: remaining(), ...extra });
    try {
        for (const sw of software) {
            if (shouldStop()) {
                stopped = true;
                packages.push({ name: sw.name, exitCode: null, ok: false, rebootRequired: false, message: 'Not executed (job cancelled)' });
                continue;
            }
            lines.push(`=== ${sw.name} ===`);
            let pkg;
            try {
                if (sw.detect && !opts.forceReinstall) {
                    // A detect problem or timeout means "not installed": warn and install; it never fails the host itself
                    let found = { found: false, version: '' };
                    try { found = await detectLinux(ip, sw.detect, creds, sshOpts); } catch (e) {
                        lines.push(`Detect check failed, installing anyway: ${errText(e)}`);
                    }
                    if (found.found) {
                        pkg = prov.skippedPackage(sw.name, found.version);
                        lines.push(`[SKIP] ${pkg.name}: ${pkg.message}`);
                        packages.push(pkg);
                        continue;
                    }
                }
                const { cmd, stdin } = prov.linuxSudoWrap(sw.command, creds.user, creds.password);
                const r = await ssh.executeSSH(ip, creds.user, creds.password, cmd, sshOpts({ stdin }));
                const code = Number.isInteger(r.code) ? r.code : null;
                const ok = r.success === true && code === 0;
                const detail = prov.oneLine(r.stderr || r.stdout, 160);
                pkg = { name: sw.name, exitCode: code, ok, rebootRequired: false, message: ok ? 'Installed (exit code 0)' : `Command exited with code ${code}${detail ? `: ${detail}` : ''}` };
                if (r.stdout) lines.push(`stdout: ${r.stdout.trim()}`);
                if (r.stderr) lines.push(`stderr: ${r.stderr.trim()}`);
            } catch (e) {
                pkg = { name: sw.name, exitCode: null, ok: false, rebootRequired: false, message: errText(e) };
                // A connection / host key failure applies to the whole host
                hostError = pkg.message;
            }
            lines.push(`[${pkg.ok ? 'OK' : 'FAIL'}] ${pkg.name}: ${pkg.message}`);
            packages.push(pkg);
            if (hostError) break;
        }
        const allOk = packages.every(p => p.ok) && !hostError;
        const anyInstalled = packages.some(p => p.ok && !p.skipped);
        if (hostError) {
            for (const sw of software) {
                if (!packages.some(p => p.name === sw.name)) packages.push({ name: sw.name, exitCode: null, ok: false, rebootRequired: false, message: 'Not executed (connection failed)' });
            }
        }
        if (stopped) lines.push('Job cancelled: remaining packages were not started.');
        if (opts.reboot && allOk && !anyInstalled) {
            lines.push('Reboot skipped because nothing was installed.');
        } else if (opts.reboot && allOk) {
            lines.push('Rebooting guest VM...');
            try {
                const { cmd, stdin } = prov.linuxSudoWrap('reboot', creds.user, creds.password);
                await ssh.executeSSH(ip, creds.user, creds.password, cmd, sshOpts({ stdin, execTimeoutMs: 30000 }));
                lines.push('Reboot command sent.');
            } catch (e) {
                lines.push(`Reboot note (connection probably closed): ${errText(e)}`);
            }
        } else if (opts.reboot) {
            lines.push('Reboot skipped because at least one package failed.');
        }
    } catch (e) {
        hostError = errText(e);
    }
    if (hostError) lines.push(`ERROR: ${hostError}`);
    return { ip, ok: !hostError && packages.every(p => p.ok), packages, error: hostError, rebootRequired: false, log: lines.join('\n') };
}

async function runWindowsHost(ip, software, opts, ctx) {
    if (!ctx.nasPath && software.length > 0) {
        return prov.parseHostOutput('', ip, software.map(s => s.name), 'SYSNAS_SOFTWARE_PATH is not configured (Settings > Server Provision)');
    }
    const script = prov.buildWindowsHostScript({
        ip, nasPath: ctx.nasPath, packages: software, reboot: opts.reboot,
        forceReinstall: opts.forceReinstall === true, keepInstallers: opts.keepInstallers === true, jobId: opts.jobId,
        credentialHeader: powershell.ENV_CREDENTIAL_HEADER
    });
    const timeoutMs = prov.computeTimeoutMs(1, software.length);
    const names = software.map(s => s.name);
    const secrets = ctx.secrets || [];
    let r;
    try {
        const output = await powershell.runPowerShell(script, timeoutMs, { env: ctx.credEnv });
        r = prov.parseHostOutput(output, ip, names);
    } catch (e) {
        // Timeouts / non-zero exits reject with an object carrying the partial stdout
        const partial = (e && e.stdout) || '';
        const msg = errText(e);
        r = prov.parseHostOutput(partial, ip, names, msg);
        // stderr is only appended after scrubbing; the credential itself only ever lives in the process env
        if (e && e.stderr && !partial) r.log = `${r.log}\n${prov.oneLine(prov.scrubSecrets(e.stderr, secrets), 500)}`.trim();
    }
    return scrubResult(r, secrets);
}

/** One host, never throws: any exception becomes a failed result. */
async function runHost({ ip, osType, software, opts, ctx, shouldStop }) {
    try {
        return osType === 'linux'
            ? scrubResult(await runLinuxHost(ip, software, opts, ctx.linuxCreds, shouldStop), ctx.secrets || [])
            : await runWindowsHost(ip, software, opts, ctx);
    } catch (e) {
        console.error('Remote Install host error:', ip, prov.scrubSecrets(errText(e), ctx.secrets || []));
        return scrubResult({
            ip, ok: false,
            packages: software.map(s => ({ name: s.name, exitCode: null, ok: false, rebootRequired: false, message: 'Not executed' })),
            error: errText(e), rebootRequired: false, log: `ERROR: ${errText(e)}`
        }, ctx.secrets || []);
    }
}

module.exports = { SERVICE_ACCOUNT_MISSING, setting, errText, scrubResult, buildContext, runLinuxHost, runWindowsHost, runHost };
