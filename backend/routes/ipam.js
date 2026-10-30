const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const core = require('../lib/ipamCore');
const ipamStore = require('../lib/ipamStore');
const ipamSync = require('../lib/ipamSync');

const router = express.Router();
router.use(requireAuth);
router.use(checkFeature('ipam'));

// Every write goes through ipamStore.mutateSubnets (atomic read-modify-write shared with the worker);
// reads use ipamStore.readSubnets (RAM cache).

// --- Global Environments: subnets and IPs store envId (authoritative) + environment (name copy) ---
const envRegistry = require('../lib/environmentRegistry');

function decorateSubnet(s, envs) {
    const out = envRegistry.decorateRecord(s, envs);
    if (out && Array.isArray(out.ips)) out.ips = out.ips.map(ip => envRegistry.decorateRecord(ip, envs));
    return out;
}

// Statuses used in the codebase (frontend STATUS_COLORS, inventory scan, VIP linkage, inventory delete)
const IP_STATUSES = ['free', 'used', 'vip', 'reserved', 'static', 'conflict'];
const RESERVATION_MS = 10 * 60 * 1000;
const WRITE_ROLES = ['SuperAdmin', 'Operator'];
const READ_ROLES = ['SuperAdmin', 'Operator', 'Viewer'];

/** System source that manages an IP (assignedTo written by a sync), or null for a manually managed IP. */
function managedBy(entry) {
    const a = entry && typeof entry.assignedTo === 'string' ? entry.assignedTo : '';
    if (ipamSync.SYSTEM_SOURCES.includes(a)) return a;
    if (a.startsWith('VIP of ')) return 'VIP Linkage';
    return null;
}

/** Usage counts + truncation / gateway info of a subnet (no ips). */
function statsOf(s) {
    const ips = Array.isArray(s.ips) ? s.ips : [];
    const counts = { total: ips.length };
    for (const st of IP_STATUSES) counts[st] = 0;
    let reservations = 0;
    const now = Date.now();
    for (const e of ips) {
        const st = (e && e.status) || 'free';
        counts[st] = (counts[st] || 0) + 1;
        if (core.reservationActive(e, now)) reservations++;
    }
    const t = core.truncationOf(s);
    counts.reservations = reservations;
    counts.truncated = t.truncated;
    counts.hostCount = t.hostCount;
    return {
        counts,
        truncated: t.truncated,
        hostCount: t.hostCount,
        // field absent (legacy subnet) = the first usable host; '' = no gateway
        gateway: core.effectiveGateway(s),
        gatewayDefault: s.gateway === undefined || s.gateway === null,
        reserved: Array.isArray(s.reserved) ? s.reserved : []
    };
}

function summaryOf(s, envs) {
    const { ips, ...rest } = s;
    return { ...envRegistry.decorateRecord(rest, envs), ...statsOf(s) };
}

function fullOf(s, envs) {
    return { ...decorateSubnet(s, envs), ...statsOf(s) };
}

/**
 * Explicit subnet environment change ({ environment } / { envId }): stores id + canonical name.
 * The client sends back what it received, so "Unassigned" (with envUnmapped) means "unchanged".
 * Returns an error message for an unknown value.
 */
function applySubnetEnv(subnet, { environment, envId }, envs) {
    if (environment === undefined && envId === undefined) return null;
    const valid = envRegistry.findById(envId, envs);
    if (!valid && (environment === envRegistry.UNASSIGNED || environment === null || environment === '') && !envId) return null;
    const ref = envRegistry.envWriteFields(valid ? valid.id : (envId || environment), envs);
    if (ref.error) return ref.error;
    subnet.envId = ref.env.id;
    subnet.environment = ref.env.name;
    return null;
}

/**
 * Validates the editable gateway / reserved fields against a cidr. Returns { error } or { fields } (only the
 * given ones; reserved normalised).
 */
function gatewayReservedFields({ gateway, reserved }, cidr) {
    const fields = {};
    if (gateway !== undefined && gateway !== null) {
        const g = typeof gateway === 'string' ? gateway.trim() : gateway;
        const err = core.validateGateway(g, cidr);
        if (err) return { error: err };
        fields.gateway = g === '' ? '' : core.intToIp(core.ipToInt(g));
    }
    if (reserved !== undefined && reserved !== null) {
        const r = core.parseReserved(reserved, cidr);
        if (r.error) return { error: r.error };
        fields.reserved = r.values;
    }
    return { fields };
}

/** Editable subnet fields (name, vlan, environment, gateway, reserved) - ips / cidr are ignored. */
function applySubnetEdit(subnet, update, envs) {
    if (update.name !== undefined && (typeof update.name !== 'string' || !update.name.trim())) return 'Name must be a non-empty string';
    const gr = gatewayReservedFields(update, subnet.cidr);
    if (gr.error) return gr.error;
    const probe = { ...subnet };
    const envErr = applySubnetEnv(probe, { environment: update.environment, envId: update.envId }, envs);
    if (envErr) return envErr;
    if (update.name !== undefined) subnet.name = update.name;
    if (update.vlan !== undefined) subnet.vlan = update.vlan;
    applySubnetEnv(subnet, { environment: update.environment, envId: update.envId }, envs);
    Object.assign(subnet, gr.fields);
    return null;
}

/**
 * A new subnet from a create request, validated against `existing` (duplicate / overlap).
 * Returns { error } or { subnet, normalizedFrom }.
 */
function buildNewSubnet(input, existing, envs) {
    const { name, cidr, vlan, environment, envId } = input || {};
    if (!name || !cidr) return { error: 'Name and CIDR required' };
    const v = core.validateNewCidr(String(cidr));
    if (!v.ok) return { error: v.error };
    const conflict = core.findConflict(existing, v.cidr);
    if (conflict.duplicate) return { error: `Subnet ${v.cidr} already exists (${conflict.duplicate.name})` };
    if (conflict.overlap) return { error: `Subnet ${v.cidr} overlaps existing subnet ${conflict.overlap.name} (${conflict.overlap.cidr})` };
    const envRef = envRegistry.envWriteFields(envId || environment, envs, { useDefault: true });
    if (envRef.error) return { error: envRef.error };
    const gr = gatewayReservedFields({
        gateway: input.gateway === undefined || input.gateway === null ? core.firstUsableHost(v.cidr) : input.gateway,
        reserved: input.reserved === undefined || input.reserved === null ? [] : input.reserved
    }, v.cidr);
    if (gr.error) return { error: gr.error };
    return {
        normalizedFrom: v.normalized ? String(cidr).trim() : null,
        subnet: {
            id: uuidv4(),
            name,
            cidr: v.cidr,
            vlan: vlan || '',
            ...envRef.fields,
            ...gr.fields,
            ips: core.generateIPs(v.cidr, envRegistry.defaultEnvFields(envs)),
            createdAt: new Date().toISOString()
        }
    };
}

const failure = (status, body) => ({ fail: { status, body } });
const sendFail = (res, r) => res.status(r.fail.status).json(r.fail.body);

// --- SUB-ROUTES: Subnets ---
// GET /subnets -> summaries without ips; ?include=ips -> the full subnets (ips included)
router.get('/subnets', checkRole(READ_ROLES), async (req, res) => {
    const data = ipamStore.readSubnets();
    const envs = envRegistry.getEnvironments();
    const withIps = String(req.query.include || '').split(',').map(x => x.trim()).includes('ips');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(data.map(s => (withIps ? fullOf(s, envs) : summaryOf(s, envs))));
});

router.post('/subnets', checkRole(WRITE_ROLES), async (req, res) => {
    const envs = envRegistry.getEnvironments();
    const r = ipamStore.mutateSubnets((subnets) => {
        const built = buildNewSubnet(req.body, subnets, envs);
        if (built.error) return failure(400, { error: built.error });
        subnets.push(built.subnet);
        return built;
    }, { username: req.user.username, reason: 'create subnet' });
    if (r.fail) return sendFail(res, r);
    const s = r.subnet;
    auditLog(req.user.username, 'IPAM', `Created Subnet: ${s.name} (${s.cidr})${r.normalizedFrom ? ` (normalised from ${r.normalizedFrom})` : ''}`);
    res.status(201).json({ ...s, ...(r.normalizedFrom ? { cidrNormalizedFrom: r.normalizedFrom } : {}) });
});

// batch routes before /subnets/:id (otherwise "batch" is taken for an id)
router.post('/subnets/batch', checkRole(WRITE_ROLES), async (req, res) => {
    const { subnets: list } = req.body || {};
    if (!Array.isArray(list)) return res.status(400).json({ error: 'subnets array required' });
    const envs = envRegistry.getEnvironments();
    const r = ipamStore.mutateSubnets((subnets) => {
        const added = [];
        const rejected = [];
        for (const s of list) {
            // per row: invalid / duplicate / overlapping (also with earlier rows) / unknown environment -> rejected
            const built = buildNewSubnet(s, subnets, envs);
            if (built.error) { rejected.push({ cidr: s && s.cidr, name: s && s.name, error: built.error }); continue; }
            subnets.push(built.subnet);
            added.push(built.subnet);
        }
        return { added, rejected };
    }, { username: req.user.username, reason: 'batch create subnets' });
    auditLog(req.user.username, 'IPAM', `Batch added ${r.added.length} Subnets${r.rejected.length ? ` (${r.rejected.length} rejected)` : ''}`);
    res.status(201).json({ added: r.added.length, rejected: r.rejected });
});

router.put('/subnets/batch', checkRole(WRITE_ROLES), async (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    const envs = envRegistry.getEnvironments();
    const r = ipamStore.mutateSubnets((subnets) => {
        // Validate every update first: one invalid value rejects the whole batch (nothing written)
        const errors = [];
        for (const update of updates) {
            const s = subnets.find(x => x.id === (update && update.id));
            if (!s) continue;
            const err = applySubnetEdit(JSON.parse(JSON.stringify({ ...s, ips: [] })), update, envs);
            if (err) errors.push({ id: update.id, error: err });
        }
        if (errors.length > 0) return failure(400, { error: errors[0].error, errors });
        for (const update of updates) {
            const s = subnets.find(x => x.id === (update && update.id));
            if (s) applySubnetEdit(s, update, envs); // ips are ignored (never replaced)
        }
        return {};
    }, { username: req.user.username, reason: 'batch update subnets' });
    if (r.fail) return sendFail(res, r);
    auditLog(req.user.username, 'IPAM', `Batch updated ${updates.length} Subnets`);
    res.json({ success: true });
});

router.get('/subnets/:id', checkRole(READ_ROLES), async (req, res) => {
    const subnet = ipamStore.readSubnets().find(s => s.id === req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(fullOf(subnet, envRegistry.getEnvironments()));
});

router.put('/subnets/:id', checkRole(WRITE_ROLES), async (req, res) => {
    const envs = envRegistry.getEnvironments();
    const body = req.body || {};
    const r = ipamStore.mutateSubnets((subnets) => {
        const subnet = subnets.find(s => s.id === req.params.id);
        if (!subnet) return failure(404, { error: 'Subnet not found' });
        // only name / vlan / environment / gateway / reserved: ips (sent back by old clients) and cidr are ignored
        const err = applySubnetEdit(subnet, body, envs);
        if (err) return failure(400, { error: err });
        return { subnet };
    }, { username: req.user.username, reason: 'update subnet' });
    if (r.fail) return sendFail(res, r);
    auditLog(req.user.username, 'IPAM', `Updated Subnet: ${r.subnet.name} (${r.subnet.cidr})`);
    res.json(summaryOf(r.subnet, envs));
});

router.delete('/subnets/:id', checkRole(WRITE_ROLES), async (req, res) => {
    const confirmCidr = (req.body && req.body.confirmCidr) || req.query.confirmCidr;
    const r = ipamStore.mutateSubnets((subnets) => {
        const idx = subnets.findIndex(s => s.id === req.params.id);
        if (idx === -1) return failure(404, { error: 'Subnet not found' });
        const target = subnets[idx];
        const inUse = (target.ips || []).filter(e => e && (((e.status || 'free') !== 'free') || e.hostname || e.assignedTo)).length;
        if (inUse > 0) {
            if (req.user.role !== 'SuperAdmin') {
                return failure(403, { error: `Subnet ${target.cidr} has ${inUse} IP(s) in use: only a SuperAdmin can delete it`, inUse });
            }
            if (String(confirmCidr || '').trim() !== target.cidr) {
                return failure(400, { error: `Subnet ${target.cidr} has ${inUse} IP(s) in use: confirmCidr must equal "${target.cidr}"`, inUse });
            }
        }
        subnets.splice(idx, 1);
        return { target, inUse };
    }, { username: req.user.username, reason: 'delete subnet' });
    if (r.fail) return sendFail(res, r);
    auditLog(req.user.username, 'IPAM', `Deleted Subnet: ${r.target.name} (${r.target.cidr})${r.inUse ? ` with ${r.inUse} IPs in use` : ''}`);
    res.json({ success: true });
});

// Read-only: skips the gateway, reserved entries, status !== 'free' and running reservations
router.get('/subnets/:id/next-available', checkRole(READ_ROLES), async (req, res) => {
    const subnet = ipamStore.readSubnets().find(s => s.id === req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    const nextIp = core.nextAvailable(subnet);
    if (!nextIp) return res.status(404).json({ error: 'No available IPs' });
    res.json(nextIp);
});

// Picks the next available IP and reserves it for 10 minutes (status stays 'free': other readers are unaffected)
router.post('/subnets/:id/reserve-next', checkRole(WRITE_ROLES), async (req, res) => {
    const username = req.user.username;
    const r = ipamStore.mutateSubnets((subnets) => {
        const subnet = subnets.find(s => s.id === req.params.id);
        if (!subnet) return failure(404, { error: 'Subnet not found' });
        const entry = core.nextAvailable(subnet);
        if (!entry) return failure(404, { error: 'No available IPs' });
        entry.reservedBy = username;
        entry.reservedUntil = new Date(Date.now() + RESERVATION_MS).toISOString();
        return { entry: { ...entry }, subnet: { name: subnet.name, cidr: subnet.cidr } };
    }, { username, reason: 'reserve next IP' });
    if (r.fail) return sendFail(res, r);
    auditLog(username, 'IPAM', `Reserved IP ${r.entry.address} in Subnet: ${r.subnet.name} (${r.subnet.cidr}) until ${r.entry.reservedUntil}`);
    res.json(r.entry);
});

const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** Field validation of a single-IP update; returns an error message or null. */
function validateIpUpdate({ address, status, hostname, fqdn, assignedTo, service, tags }) {
    if (!address || !core.isValidIp(String(address))) return 'A valid IPv4 address is required';
    if (status !== undefined && status !== null && status !== '' && !IP_STATUSES.includes(status)) {
        return `Unknown status "${status}". Allowed: ${IP_STATUSES.join(', ')}`;
    }
    if (hostname !== undefined && !isStr(hostname, 253)) return 'hostname must be a string of at most 253 characters';
    if (fqdn !== undefined) {
        if (typeof fqdn !== 'string') return 'fqdn must be a string';
        if (fqdn.split(',').some(f => f.trim().length > 253)) return 'each fqdn must be at most 253 characters';
    }
    if (assignedTo !== undefined && !isStr(assignedTo, 200)) return 'assignedTo must be a string of at most 200 characters';
    if (service !== undefined && !isStr(service, 200)) return 'service must be a string of at most 200 characters';
    if (tags !== undefined && tags !== null) {
        if (!Array.isArray(tags) || tags.length > 50) return 'tags must be an array of at most 50 strings';
        if (tags.some(t => !isStr(t, 64))) return 'each tag must be a string of at most 64 characters';
    }
    return null;
}

router.put('/subnets/:id/ips', checkRole(WRITE_ROLES), async (req, res) => {
    const body = req.body || {};
    const { status, hostname, fqdn, assignedTo, service, environment, envId, tags, force } = body;
    const verr = validateIpUpdate(body);
    if (verr) return res.status(400).json({ error: verr });
    const address = core.intToIp(core.ipToInt(String(body.address)));
    const envs = envRegistry.getEnvironments();
    const isSuperAdmin = req.user.role === 'SuperAdmin';

    const r = ipamStore.mutateSubnets((subnets) => {
        const subnet = subnets.find(s => s.id === req.params.id);
        if (!subnet) return failure(404, { error: 'Subnet not found' });
        if (!core.ipInCidr(address, subnet.cidr)) return failure(400, { error: `IP ${address} is not inside subnet ${subnet.cidr}` });
        const current = (subnet.ips || []).find(e => e && e.address === address);

        // System-managed IPs: status / hostname / owner are owned by the sync source
        const owner = managedBy(current);
        let forced = false;
        if (owner) {
            const changes = [];
            if (status && status !== (current.status || 'free')) changes.push('status');
            if (hostname !== undefined && hostname !== (current.hostname || '')) changes.push('hostname');
            if (assignedTo !== undefined && assignedTo !== (current.assignedTo || '')) changes.push('assignedTo');
            if (changes.length > 0) {
                if (!(force === true && isSuperAdmin)) {
                    return failure(409, {
                        error: `IP ${address} is managed by ${owner}: ${changes.join(', ')} cannot be changed manually${isSuperAdmin ? ' (resend with force: true to override)' : ''}`,
                        managedBy: owner, fields: changes
                    });
                }
                forced = changes;
            }
        }

        // Explicit value -> validated (unknown = 400); none -> inherit the subnet's environment
        let envFields;
        if (envId || (environment && environment !== envRegistry.UNASSIGNED)) {
            const ref = envRegistry.envWriteFields(envId || environment, envs);
            if (ref.error) return failure(400, { error: ref.error });
            envFields = ref.fields;
        } else {
            // "Unassigned" is what the client was shown for an unmapped value: keep the stored one
            const src = environment === envRegistry.UNASSIGNED && current ? current : subnet;
            envFields = src.envId ? { envId: src.envId, environment: src.environment } : { environment: src.environment };
        }

        // inside the CIDR but not materialised (legacy /16 - /19): created in address order
        const entry = current || core.ensureIpEntry(subnet, address);
        if (!entry) return failure(400, { error: `IP ${address} is not a usable host of subnet ${subnet.cidr}` });
        const idx = subnet.ips.indexOf(entry);
        const next = {
            ...entry,
            status: status || entry.status || 'used',
            hostname: hostname !== undefined ? hostname : (entry.hostname || ''),
            fqdn: fqdn !== undefined ? fqdn : (entry.fqdn || ''),
            assignedTo: assignedTo !== undefined ? assignedTo : (entry.assignedTo || ''),
            service: service !== undefined ? service : (entry.service || ''),
            ...envFields,
            tags: tags || entry.tags || [],
            updatedAt: new Date().toISOString()
        };
        if (!envFields.envId) delete next.envId;
        // setting the IP ends a reservation
        delete next.reservedBy;
        delete next.reservedUntil;
        subnet.ips[idx] = next;
        return { entry: next, subnet: { name: subnet.name, cidr: subnet.cidr }, forced, owner };
    }, { username: req.user.username, reason: 'update IP' });
    if (r.fail) return sendFail(res, r);
    auditLog(req.user.username, 'IPAM', `Updated IP: ${address} in Subnet: ${r.subnet.name} (${r.subnet.cidr})`);
    if (r.forced) auditLog(req.user.username, 'IPAM', `FORCED change of system-managed IP ${address} (managed by ${r.owner}): ${r.forced.join(', ')}`);
    res.json(r.entry);
});

// DNS to IPAM Sync. zones (optional): zones whose records are complete in `records`; only FQDNs of those
// zones can be removed / cleared. Without zones nothing is cleared.
router.post('/subnets/dns-sync', checkRole(WRITE_ROLES), async (req, res) => {
    const { records, zones } = req.body || {};
    if (!records || !Array.isArray(records)) {
        return res.status(400).json({ error: 'Invalid payload, expected { records: [...] }' });
    }
    if (zones !== undefined && (!Array.isArray(zones) || zones.some(z => typeof z !== 'string'))) {
        return res.status(400).json({ error: 'zones must be an array of zone names' });
    }
    const result = await ipamSync.syncDnsToIpam(records, req.user.username, zones ? { zones } : {});
    res.json({ success: true, updated: result.updated, cleared: result.cleared, skipped: result.skipped });
});

// Removed environments routes as they are now global
module.exports = router;
