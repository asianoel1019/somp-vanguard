const scoutDb = require('../../../services/scoutDb');
const { readDataSync } = require('../../db');
const { ToolInputError } = require('../errors');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseRange({ from, to } = {}, now, { defaultHours, maxDays }) {
    const toDate = to ? new Date(to) : new Date(now);
    if (Number.isNaN(toDate.getTime())) throw new ToolInputError(`Invalid "to" time: ${to}`);
    let fromDate = from ? new Date(from) : new Date(toDate.getTime() - defaultHours * HOUR_MS);
    if (Number.isNaN(fromDate.getTime())) throw new ToolInputError(`Invalid "from" time: ${from}`);
    if (fromDate > toDate) throw new ToolInputError('"from" must be earlier than "to"');
    let clamped = false;
    if (toDate - fromDate > maxDays * DAY_MS) {
        fromDate = new Date(toDate.getTime() - maxDays * DAY_MS);
        clamped = true;
    }
    return { from: fromDate.toISOString(), to: toDate.toISOString(), clamped };
}

const splitIps = (ip) => String(ip || '').split(',').map(s => s.trim()).filter(Boolean);

function truncateText(s, n) {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n)}…` : str;
}

async function findMonitors(query, limit = 10) {
    const q = String(query || '').trim();
    if (!q) return { rows: [], exact: [] };
    const rows = (await scoutDb.all(
        'SELECT id, name, ip, os, status, lastSeen FROM monitors WHERE id = ? OR LOWER(name) LIKE LOWER(?) OR ip LIKE ? ORDER BY name LIMIT ?',
        [q, `%${q}%`, `%${q}%`, limit],
    )) || [];
    const lower = q.toLowerCase();
    const exact = rows.filter(r => r.id === q || String(r.name || '').toLowerCase() === lower || splitIps(r.ip).includes(q));
    return { rows, exact };
}

async function resolveSingleMonitor(host) {
    const { rows, exact } = await findMonitors(host);
    if (exact.length === 1) return exact[0];
    if (rows.length === 1) return rows[0];
    if (!rows.length) throw new ToolInputError(`No monitored host matches "${host}". Use find_host first.`);
    throw new ToolInputError(`"${host}" matches ${rows.length} hosts: ${rows.map(r => r.name).join(', ')}. Use the exact name or IP.`);
}

function hostSummary(m) {
    return { id: m.id, name: m.name, ip: splitIps(m.ip).join(', '), os: m.os, status: m.status, lastSeen: m.lastSeen };
}

/**
 * Runbooks merged with built-in presets exactly like GET /api/runbook does,
 * but without writing anything back.
 */
function getAllRunbooks() {
    const presets = require('../../../routes/runbook').PRESEEDED_RUNBOOKS || [];
    const stored = readDataSync('runbooks.json', []);
    const map = new Map(presets.map(p => [p.id, p]));
    for (const rb of Array.isArray(stored) ? stored : []) {
        const preset = map.get(rb.id);
        if (preset && (rb.updatedBy === 'SYSTEM' || !rb.updatedBy)) map.set(rb.id, { ...rb, ...preset });
        else map.set(rb.id, rb);
    }
    return [...map.values()];
}

module.exports = { parseRange, splitIps, truncateText, findMonitors, resolveSingleMonitor, hostSummary, getAllRunbooks };
