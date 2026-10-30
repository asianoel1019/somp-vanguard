const scoutDb = require('../../../services/scoutDb');
const { parseRange, findMonitors } = require('./common');

module.exports = {
    name: 'list_alerts',
    feature: 'monitorScout',
    description: 'List Scout alerts. status "active" (default) returns current unresolved alerts; "resolved" or "all" return alerts triggered since "since" (default last 24 hours, max 7 days). Optional host filter.',
    parameters: {
        type: 'object',
        properties: {
            host: { type: 'string', maxLength: 100, description: 'Hostname or IP filter (partial allowed)' },
            status: { type: 'string', enum: ['active', 'resolved', 'all'], description: 'Default "active"' },
            since: { type: 'string', maxLength: 40, description: 'ISO 8601 time; ignored for status "active"' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' },
        },
    },
    async run({ host, status = 'active', since, limit = 20 }, { now }) {
        const where = [];
        const params = [];

        const monitors = (await scoutDb.all('SELECT id, name FROM monitors')) || [];
        const nameById = new Map(monitors.map(m => [m.id, m.name]));

        if (host) {
            const { rows, exact } = await findMonitors(host, 20);
            const matched = exact.length ? exact : rows;
            if (!matched.length) return { count: 0, status, alerts: [], note: `No monitored host matches "${host}"` };
            where.push(`monitorId IN (${matched.map(() => '?').join(',')})`);
            params.push(...matched.map(r => r.id));
        }

        let range = null;
        if (status === 'active') {
            where.push('resolved = 0');
        } else {
            if (status === 'resolved') where.push('resolved = 1');
            range = parseRange({ from: since }, now, { defaultHours: 24, maxDays: 7 });
            where.push('triggeredAt >= ?');
            params.push(range.from);
        }

        const sql = `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY triggeredAt DESC LIMIT ?`;
        const rows = (await scoutDb.all(sql, [...params, limit])) || [];
        return {
            count: rows.length,
            status,
            ...(range ? { range } : {}),
            alerts: rows.map(a => ({
                id: a.id,
                host: nameById.get(a.monitorId) || a.monitorId,
                type: a.type,
                ruleName: a.ruleName,
                target: a.target,
                value: a.value,
                threshold: a.threshold,
                triggeredAt: a.triggeredAt,
                resolved: !!a.resolved,
                resolvedAt: a.resolvedAt || null,
            })),
        };
    },
};
