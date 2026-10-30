const { readDataSync } = require('../../db');
const { queryCmdbServers } = require('../../../services/cmdbModel');
const { findMonitors, splitIps, truncateText } = require('./common');

const HISTORY_KEY = 'server_operation/server_cmdb_history.json';
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function show(v) {
    return truncateText(typeof v === 'string' ? v : JSON.stringify(v), 100);
}

function diffFields(oldData = {}, newData = {}) {
    const keys = [...new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})])];
    return keys
        .filter(k => JSON.stringify(oldData?.[k]) !== JSON.stringify(newData?.[k]))
        .slice(0, 20)
        .map(k => ({ field: k, from: show(oldData?.[k] ?? null), to: show(newData?.[k] ?? null) }));
}

module.exports = {
    name: 'get_host_change_history',
    feature: 'serverList',
    description: 'Recent CMDB change records of a host (who changed what and when), newest first. Useful to answer "what changed recently?". Automatic global sync entries are skipped.',
    parameters: {
        type: 'object',
        properties: {
            host: { type: 'string', maxLength: 100, description: 'Hostname or IP' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10' },
        },
        required: ['host'],
    },
    async run({ host, limit = 10 }) {
        const ips = new Set();
        if (IP_RE.test(host)) ips.add(host);
        const { rows } = await findMonitors(host, 10);
        rows.forEach(r => splitIps(r.ip).forEach(ip => ips.add(ip)));
        if (!ips.size) {
            const { servers } = queryCmdbServers({ keyword: host, limit: 5, page: 1 });
            servers.forEach(s => ips.add(s.ip));
        }
        if (!ips.size) return { count: 0, changes: [], note: `No host matches "${host}"` };

        const history = readDataSync(HISTORY_KEY, []);
        const changes = (Array.isArray(history) ? history : [])
            .filter(h => ips.has(h.ip) && h.action !== 'Global Auto-Sync')
            .slice(0, limit)
            .map(h => ({ timestamp: h.timestamp, ip: h.ip, user: h.username, action: h.action, changedFields: diffFields(h.oldData, h.newData) }));
        return { count: changes.length, ips: [...ips], changes };
    },
};
