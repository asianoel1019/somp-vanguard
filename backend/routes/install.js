const express = require('express');
const router = express.Router();
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');
// Module objects (not destructured) so tests can inject loggers
const logger = require('../lib/logger');
const { readEnv } = require('../lib/envEditor');
const prov = require('../lib/provisioning');
const runners = require('../lib/provisionRunners');
const jobs = require('../services/provisionJobs');
const precheck = require('../services/provisionPrecheck');

router.use(requireAuth);
router.use(checkFeature('install'));

const WRITER_ROLES = ['SuperAdmin', 'Operator'];
const SECRET_MASK = '••••';
const MODULE = 'Remote Install';
const writers = checkRole(WRITER_ROLES);

router.get('/config', (req, res) => {
    const cfg = prov.loadInstallConfig(readEnv());
    const canSeeArgs = WRITER_ROLES.includes(req.user && req.user.role);
    // Installer arguments / Linux commands may carry license keys or passwords: only writers get them
    const masterList = cfg.masterList.map(sw => (canSeeArgs
        ? { ...sw, hasArgs: !!sw.args, hasDetect: !!sw.detect }
        : { name: sw.name, path: sw.path, args: sw.args ? SECRET_MASK : '', argsMasked: !!sw.args, hasArgs: !!sw.args, hasDetect: !!sw.detect }));
    const linuxMasterList = cfg.linuxMasterList.map(sw => (canSeeArgs
        ? { ...sw, hasDetect: !!sw.detect }
        : { name: sw.name, command: sw.command ? SECRET_MASK : '', argsMasked: !!sw.command, hasDetect: !!sw.detect }));
    res.json({ masterList, linuxMasterList, bus: cfg.bus, mapping: cfg.mapping, linuxMapping: cfg.linuxMapping, provision: prov.loadProvisionSettings(readEnv()) });
});

/** Parses an install-shaped body (execute / precheck): { error } or { value }. Unknown-target override is SuperAdmin only. */
function parseBody(req, installCfg) {
    const v = prov.validateExecuteBody(req.body, installCfg);
    if (v.error) return { status: 400, body: { error: v.error } };
    if (v.value.allowUnknownTargets && req.user.role !== 'SuperAdmin') {
        return { status: 403, body: { error: 'Only SuperAdmin may provision unknown targets' } };
    }
    return { value: v.value };
}

// Creates a job and returns at once; progress is polled through GET /jobs/:id
router.post('/execute', writers, (req, res) => {
    try {
        const config = readEnv();
        const installCfg = prov.loadInstallConfig(config);
        const p = parseBody(req, installCfg);
        if (p.error || p.status) return res.status(p.status).json(p.body);
        const r = jobs.submit({ user: req.user, input: p.value, installCfg, config });
        res.status(r.status).json(r.body);
    } catch (e) {
        console.error('Remote Install execute error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to create the install job' });
    }
});

// Read-only probes; never installs anything and stores nothing
router.post('/precheck', writers, async (req, res) => {
    try {
        const config = readEnv();
        const installCfg = prov.loadInstallConfig(config);
        const p = parseBody(req, installCfg);
        if (p.status) return res.status(p.status).json(p.body);
        const input = p.value;
        const requested = req.body && req.body.software;
        if (requested !== undefined && requested !== null && (!Array.isArray(requested) || requested.some(n => typeof n !== 'string'))) {
            return res.status(400).json({ error: 'software must be an array of package names' });
        }
        let software = prov.resolveSoftware(installCfg, input.buType, input.osType);
        if (Array.isArray(requested)) {
            const unknownNames = requested.filter(n => !software.some(s => s.name === n));
            if (unknownNames.length) return res.status(400).json({ error: `Unknown software for template "${input.buType}": ${unknownNames.slice(0, 5).map(n => n.slice(0, 40)).join(', ')}` });
            software = software.filter(s => requested.includes(s.name));
        }
        if (software.length === 0) return res.status(400).json({ error: `No software configured for template "${input.buType}" (${input.osType})` });
        const badRule = software.find(sw => sw.detectError);
        if (badRule) return res.status(400).json({ error: `Invalid detect rule for "${badRule.name}": ${badRule.detectError}` });
        // Settings service account, never the signed-in user's password (same as the job runner)
        const built = runners.buildContext({ osType: input.osType, config });
        if (built.error) return res.status(400).json({ error: built.error });
        const info = jobs.lookupTargets(input.ips);
        const result = await precheck.runPrecheck({
            input, info, ctx: built.ctx, software, settings: prov.loadProvisionSettings(config),
            allowUnknown: input.allowUnknownTargets && req.user.role === 'SuperAdmin'
        });
        const unknownIps = input.ips.filter(ip => !info.get(ip).known);
        const override = input.allowUnknownTargets && unknownIps.length ? `; unknown-target override used for ${unknownIps.join(', ')}` : '';
        logger.auditLog(req.user.username, MODULE, `Pre-check (${input.osType}, template ${input.buType}) of ${input.ips.length} host(s): ${result.hosts.filter(h => h.ok).length} ok${override}`);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('Remote Install precheck error:', runners.errText(e));
        res.status(500).json({ error: 'Pre-check failed' });
    }
});

router.get('/targets', writers, (req, res) => {
    try {
        res.json({ targets: jobs.listTargets({ q: req.query.q, limit: req.query.limit }) });
    } catch (e) {
        console.error('Remote Install targets error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to list targets' });
    }
});

router.get('/jobs', (req, res) => {
    try {
        res.json(jobs.listJobs({ limit: req.query.limit, before: req.query.before }));
    } catch (e) {
        console.error('Remote Install jobs error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to list jobs' });
    }
});

router.get('/jobs/:id', (req, res) => {
    try {
        const j = jobs.getJob(req.params.id, { logs: req.query.log !== '0' });
        if (!j) return res.status(404).json({ error: 'Job not found' });
        if (!WRITER_ROLES.includes(req.user && req.user.role)) {
            // Logs and long installer messages can echo installer output / properties: operators only
            j.hosts = j.hosts.map(h => {
                const { log, ...rest } = h;
                return {
                    ...rest, logHidden: true,
                    packages: (h.packages || []).map(p => (p && typeof p.message === 'string' && p.message.length > 200 ? { ...p, message: `${p.message.slice(0, 200)}...` } : p))
                };
            });
        }
        res.json(j);
    } catch (e) {
        console.error('Remote Install job error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to read the job' });
    }
});

router.post('/jobs/:id/cancel', writers, (req, res) => {
    try {
        const r = jobs.cancelJob(req.params.id, req.user.username);
        res.status(r.status).json(r.body);
    } catch (e) {
        console.error('Remote Install cancel error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to cancel the job' });
    }
});

router.post('/jobs/:id/retry-failed', writers, (req, res) => {
    try {
        const config = readEnv();
        const installCfg = prov.loadInstallConfig(config);
        const base = jobs.retryInput(req.params.id);
        if (base.status) return res.status(base.status).json(base.body);
        // The unknown-target override is never inherited: a SuperAdmin must pass it again explicitly
        const flag = req.body && req.body.allowUnknownTargets;
        if (flag !== undefined && flag !== null && typeof flag !== 'boolean') return res.status(400).json({ error: 'allowUnknownTargets must be a boolean' });
        if (flag === true && req.user.role !== 'SuperAdmin') return res.status(403).json({ error: 'Only SuperAdmin may provision unknown targets' });
        const input = { ...base.input, allowUnknownTargets: flag === true };
        const r = jobs.submit({ user: req.user, input, installCfg, config, retryOf: base.original.id });
        if (r.status === 202) logger.auditLog(req.user.username, MODULE, `Retried failed hosts of install job ${base.original.id} as job ${r.body.jobId} (${input.ips.length} host(s))`);
        res.status(r.status).json(r.body);
    } catch (e) {
        console.error('Remote Install retry error:', runners.errText(e));
        res.status(500).json({ error: 'Failed to retry the job' });
    }
});

module.exports = router;
