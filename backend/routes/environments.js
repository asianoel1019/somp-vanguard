const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { requireAuth, checkRole } = require('../middleware/auth');
const logger = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');
const { getUsage, cascadeRename } = require('../services/environmentUsage');
const { normalizeEnvList } = require('../lib/environmentRegistry');
const envMigration = require('../services/environmentMigration');

const router = express.Router();

const ENVIRONMENTS_FILE = 'system/environments.json';
const DEFAULT_ENVS = () => [{ id: '1', name: 'Others', purpose: 'Unclassified items', isProduction: false, isDefault: true }];
const NAME_MAX = 64;
const PURPOSE_MAX = 256;
const superAdmin = checkRole(['SuperAdmin']);
const RESERVED_NAMES = ['unassigned', '(empty)'];

const isOthers = (e) => String(e.name || '').trim().toLowerCase() === 'others';

// Always returns the normalised list: isProduction boolean, exactly one isDefault
function readEnvs() {
    const data = readDataSync(ENVIRONMENTS_FILE, null);
    if (!Array.isArray(data)) {
        const def = DEFAULT_ENVS();
        writeDataSync(ENVIRONMENTS_FILE, def);
        return def;
    }
    return normalizeEnvList(data);
}

const writeEnvs = (envs) => writeDataSync(ENVIRONMENTS_FILE, normalizeEnvList(envs));

function cleanFlag(v, field) {
    if (v === undefined) return {};
    if (typeof v !== 'boolean') return { error: `${field} must be a boolean` };
    return { value: v };
}

// currentName: an existing (legacy) entry may keep its own name even if it is now reserved
function cleanName(v, currentName) {
    if (typeof v !== 'string') return { error: 'Name must be a string' };
    const name = v.trim();
    if (!name) return { error: 'Name required' };
    if (name.length > NAME_MAX) return { error: `Name must be at most ${NAME_MAX} characters` };
    // display sentinels: "Unassigned" = unknown reference, "(empty)" = no value (Unmapped values list)
    if (RESERVED_NAMES.includes(name.toLowerCase()) && name !== String(currentName || '').trim()) return { error: `"${name}" is reserved and cannot be used as an environment name` };
    return { value: name };
}

function cleanPurpose(v) {
    if (v === null) return { value: '' };
    if (typeof v !== 'string') return { error: 'Purpose must be a string' };
    const purpose = v.trim();
    if (purpose.length > PURPOSE_MAX) return { error: `Purpose must be at most ${PURPOSE_MAX} characters` };
    return { value: purpose };
}

// Only this web process writes the environment list; serialise read-modify-write cycles (incl. awaits)
let writeChain = Promise.resolve();
function withEnvLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
}

const nameTaken = (envs, name, exceptId) =>
    envs.some(e => e.id !== exceptId && String(e.name).trim().toLowerCase() === name.toLowerCase());

// GET all environments (any logged-in user: every screen needs the dropdown)
router.get('/', requireAuth, (req, res) => {
    res.json(readEnvs());
});

// GET unmapped values: stored environment references that do not resolve to an entry (per consumer)
router.get('/unmapped', requireAuth, superAdmin, (req, res) => {
    try {
        res.json({ consumers: envMigration.getUnmapped() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST apply: assign an environment to every record of one consumer that carries an unmapped value
router.post('/unmapped/apply', requireAuth, superAdmin, (req, res) => withEnvLock(async () => {
    const { consumer, value, envId } = req.body || {};
    if (typeof consumer !== 'string' || !consumer) return res.status(400).json({ error: 'consumer required' });
    if (value !== undefined && value !== null && typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
    if (typeof envId !== 'string' || !envId) return res.status(400).json({ error: 'envId required' });
    try {
        const { count, related } = await envMigration.applyUnmapped(consumer, value || '', envId);
        const env = readEnvs().find(e => e.id === envId);
        const rel = related ? Object.entries(related).map(([k, n]) => `${k}: ${n}`).join(', ') : '';
        logger.auditLog(req.user.username, 'System', `Mapped environment value "${clip(value || '(empty)')}" of ${consumer} to ${env ? env.name : envId} (${count} record(s)${rel ? `; linked ${rel}` : ''})`);
        res.json({ success: true, consumer, value: value || '', envId, count, ...(related ? { related } : {}) });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
}));

// GET usage (where is this environment referenced)
router.get('/:id/usage', requireAuth, superAdmin, async (req, res) => {
    const env = readEnvs().find(e => e.id === req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    res.json(await getUsage(env));
});

// POST create
router.post('/', requireAuth, superAdmin, (req, res) => withEnvLock(async () => {
    const body = req.body || {};
    const n = cleanName(body.name);
    if (n.error) return res.status(400).json({ error: n.error });
    let purpose = '';
    if (body.purpose !== undefined) {
        const p = cleanPurpose(body.purpose);
        if (p.error) return res.status(400).json({ error: p.error });
        purpose = p.value;
    }
    const prod = cleanFlag(body.isProduction, 'isProduction');
    if (prod.error) return res.status(400).json({ error: prod.error });
    const def = cleanFlag(body.isDefault, 'isDefault');
    if (def.error) return res.status(400).json({ error: def.error });
    const envs = readEnvs();
    if (nameTaken(envs, n.value)) return res.status(400).json({ error: 'Environment name already exists' });

    const newEnv = { id: uuidv4(), name: n.value, purpose, isProduction: prod.value === true, isDefault: def.value === true };
    if (newEnv.isDefault) envs.forEach(e => { e.isDefault = false; });
    envs.push(newEnv);
    writeEnvs(envs);
    logger.auditLog(req.user.username, 'System', `Created Global Environment: ${newEnv.name}`);
    res.status(201).json(newEnv);
}));

const clip = (v) => { const t = String(v || ''); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };

// PUT update (id immutable). Rename with cascade: references are updated FIRST; the list is renamed only when
// every consumer succeeded, so a failed run changes nothing in the list and can simply be retried.
router.put('/:id', requireAuth, superAdmin, (req, res) => withEnvLock(async () => {
    const body = req.body || {};
    const envs = readEnvs();
    const idx = envs.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Environment not found' });
    const env = envs[idx];
    const curName = String(env.name).trim();

    if (body.id !== undefined && body.id !== env.id) return res.status(400).json({ error: 'Environment id cannot be changed' });

    let newName = curName;
    if (body.name !== undefined) {
        const n = cleanName(body.name, curName);
        if (n.error) return res.status(400).json({ error: n.error });
        newName = n.value;
    }
    let newPurpose = env.purpose;
    if (body.purpose !== undefined) {
        const p = cleanPurpose(body.purpose);
        if (p.error) return res.status(400).json({ error: p.error });
        newPurpose = p.value;
    }

    const prod = cleanFlag(body.isProduction, 'isProduction');
    if (prod.error) return res.status(400).json({ error: prod.error });
    const def = cleanFlag(body.isDefault, 'isDefault');
    if (def.error) return res.status(400).json({ error: def.error });
    if (def.value === false && env.isDefault) {
        return res.status(400).json({ error: 'Exactly one environment must be the default: mark another environment as default instead' });
    }

    const renamed = newName !== curName;
    if (renamed) {
        if (isOthers(env)) return res.status(403).json({ error: 'Cannot rename the default Others environment' });
        if (nameTaken(envs, newName, env.id)) return res.status(400).json({ error: 'Environment name already exists' });
    }

    const oldName = env.name;
    let cascade;
    if (renamed && body.cascade === true) {
        try {
            cascade = await cascadeRename(env, oldName, newName);
        } catch (e) {
            cascade = [{ key: 'cascade', consumer: 'Reference update', count: 0, error: e.message }];
        }
        const failed = cascade.filter(c => c.error);
        if (failed.length > 0) {
            logger.auditLog(req.user.username, 'System', `Rename of Global Environment ${oldName} -> ${newName} not applied: reference update failed for ${failed.map(f => f.consumer).join(', ')}; updated so far: ${cascade.filter(c => !c.error).map(c => `${c.consumer}: ${c.count}`).join(', ')}`);
            return res.status(500).json({
                error: `References could not be fully updated (${failed.map(f => f.consumer).join(', ')}). The environment was not renamed; retry is safe.`,
                renamed: false,
                cascade
            });
        }
    }

    const newProd = prod.value !== undefined ? prod.value : env.isProduction;
    const makeDefault = def.value === true && !env.isDefault;
    if (makeDefault) envs.forEach(e => { e.isDefault = false; });
    envs[idx] = { ...env, name: newName, purpose: newPurpose, isProduction: newProd, isDefault: makeDefault ? true : env.isDefault };
    writeEnvs(envs);

    const result = { ...envs[idx] };
    let desc;
    if (renamed) {
        desc = `Renamed Global Environment: ${oldName} -> ${newName}`;
        if (cascade) {
            result.cascade = cascade;
            desc += ` (updated references: ${cascade.map(c => `${c.consumer}: ${c.count}`).join(', ')})`;
        }
    } else {
        desc = `Updated Global Environment: ${newName}`;
    }
    if (newPurpose !== env.purpose) desc += ` [purpose: "${clip(env.purpose)}" -> "${clip(newPurpose)}"]`;
    if (newProd !== env.isProduction) desc += ` [production: ${env.isProduction} -> ${newProd}]`;
    if (makeDefault) desc += ' [now the default environment]';
    logger.auditLog(req.user.username, 'System', desc);
    res.json(result);
}));

// DELETE (never while referenced, and never when usage could not be fully verified)
router.delete('/:id', requireAuth, superAdmin, (req, res) => withEnvLock(async () => {
    const envs = readEnvs();
    const target = envs.find(e => e.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Environment not found' });
    if (isOthers(target)) return res.status(403).json({ error: 'Cannot delete the default Others environment' });
    if (envs.length <= 1) return res.status(400).json({ error: 'Cannot delete the last remaining environment' });
    if (target.isDefault) return res.status(403).json({ error: 'Cannot delete the default environment: mark another environment as default first' });

    const usage = await getUsage(target);
    if (!usage.complete) {
        return res.status(409).json({ error: 'Environment usage could not be verified, so it cannot be deleted. Try again later.', usage });
    }
    if (usage.total > 0) {
        return res.status(409).json({ error: 'Environment is still referenced and cannot be deleted', usage });
    }

    writeEnvs(readEnvs().filter(e => e.id !== target.id));
    logger.auditLog(req.user.username, 'System', `Deleted Global Environment: ${target.name}`);
    res.json({ success: true });
}));

module.exports = router;
