const { getCmdbServerByIp, queryCmdbServers, decorateEnv } = require('../../../services/cmdbModel');
const { hasFeature } = require('../../permissions');
const { findMonitors, hostSummary, splitIps } = require('./common');

function cmdbInfo(s) {
    if (!s) return null;
    return {
        hostname: s.hostname,
        application: s.applicationName,
        businessUnit: s.businessUnit,
        environment: s.envName,
        environmentId: s.envId || null,
        datacenter: s.datacenterName,
        lifecycle: s.lifecycleStatus,
        criticality: s.criticality,
        osVersion: s.osVersion,
    };
}

module.exports = {
    name: 'find_host',
    feature: 'monitorScout',
    description: 'Find monitored hosts by hostname or IP (partial match allowed). Returns status, OS, last report time and, when permitted, CMDB info (application, business unit, environment). Call this first to identify the exact host.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', maxLength: 100, description: 'Hostname or IP, full or partial, e.g. "web-03" or "10.0.5.13"' },
        },
        required: ['query'],
    },
    async run({ query }, { user }) {
        const { rows } = await findMonitors(query, 10);
        const withCmdb = hasFeature(user, 'serverList');
        const hosts = rows.map(m => {
            const h = hostSummary(m);
            // environment = name derived from the stored envId (Unassigned when unknown)
            if (withCmdb) h.cmdb = cmdbInfo(decorateEnv(getCmdbServerByIp(splitIps(m.ip)[0])));
            return h;
        });
        const result = { matches: hosts.length, hosts };
        if (withCmdb && hosts.length === 0) {
            const { servers } = queryCmdbServers({ keyword: query, limit: 10, page: 1 });
            result.cmdbOnly = servers.map(s => ({ ip: s.ip, status: s.status, os: s.os, ...cmdbInfo(s) }));
            if (result.cmdbOnly.length) result.note = 'Not monitored by Scout; CMDB records only (no metrics, alerts or logs available).';
        }
        return result;
    },
};
