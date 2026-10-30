const scoutDb = require('../../../services/scoutDb');
const { parseRange, resolveSingleMonitor, hostSummary } = require('./common');

const MAX_TREND_POINTS = 48;
const round1 = (x) => Math.round(x * 10) / 10;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN));

function stats(values) {
    const v = values.filter(Number.isFinite);
    if (!v.length) return null;
    const sorted = [...v].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))];
    return {
        min: round1(sorted[0]),
        max: round1(sorted[sorted.length - 1]),
        avg: round1(v.reduce((s, x) => s + x, 0) / v.length),
        p95: round1(p95),
        latest: round1(v[v.length - 1]),
    };
}

function average(values) {
    const v = values.filter(Number.isFinite);
    return v.length ? round1(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

function buildTrend(samples, cpu, mem) {
    const size = Math.max(1, Math.ceil(samples.length / MAX_TREND_POINTS));
    const trend = [];
    for (let i = 0; i < samples.length; i += size) {
        trend.push({ t: samples[i].t, cpu: average(cpu.slice(i, i + size)), mem: average(mem.slice(i, i + size)) });
    }
    return trend;
}

function topProcesses(list) {
    return (Array.isArray(list) ? list : [])
        .filter(p => p && p.name)
        .sort((a, b) => (num(b.cpuUsage) || 0) - (num(a.cpuUsage) || 0))
        .slice(0, 5)
        .map(p => ({ name: p.name, pid: p.pid, cpuPercent: round1(num(p.cpuUsage) || 0), memoryMB: round1(num(p.memoryMB) || 0) }));
}

module.exports = {
    maxRows: 5000,
    name: 'get_host_metrics',
    feature: 'monitorScout',
    description: 'Summarize CPU, memory, disk and network usage of one host over a time range (default last 6 hours, max 7 days): min/max/avg/p95/latest, a downsampled trend (≤48 points) and the top 5 processes at the CPU peak.',
    parameters: {
        type: 'object',
        properties: {
            host: { type: 'string', maxLength: 100, description: 'Exact hostname or IP (use find_host first if unsure)' },
            from: { type: 'string', maxLength: 40, description: 'ISO 8601 start time, e.g. 2026-10-08T00:00:00+08:00' },
            to: { type: 'string', maxLength: 40, description: 'ISO 8601 end time (default now)' },
        },
        required: ['host'],
    },
    async run({ host, from, to }, { now }) {
        const monitor = await resolveSingleMonitor(host);
        const range = parseRange({ from, to }, now, { defaultHours: 6, maxDays: 7 });
        const cap = module.exports.maxRows;
        const rows = (await scoutDb.all(
            'SELECT timestamp, metrics FROM metrics WHERE monitorId = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?',
            [monitor.id, range.from, range.to, cap],
        )) || [];
        rows.reverse();
        const limited = rows.length === cap;
        const samples = rows.map(r => {
            try { return { t: r.timestamp, m: JSON.parse(r.metrics) || {} }; } catch (e) { return null; }
        }).filter(Boolean);

        const base = { host: hostSummary(monitor), range, samples: samples.length };
        if (!samples.length) return { ...base, note: 'No metrics reported in this time range.' };

        const cpu = samples.map(s => num(s.m.cpu?.used));
        const mem = samples.map(s => num(s.m.memory?.used));
        const diskSeries = {};
        for (const s of samples) {
            for (const d of Array.isArray(s.m.disk) ? s.m.disk : []) {
                if (!d || !d.mount) continue;
                (diskSeries[d.mount] = diskSeries[d.mount] || []).push(num(d.used));
            }
        }
        const rx = samples.map(s => num(s.m.network?.rxSpeedKbps));
        const tx = samples.map(s => num(s.m.network?.txSpeedKbps));

        let peakIdx = -1;
        cpu.forEach((v, i) => { if (Number.isFinite(v) && (peakIdx < 0 || v > cpu[peakIdx])) peakIdx = i; });

        return {
            ...base,
            ...(limited ? { limited: true, note: `Only the most recent ${cap} samples in this range were analysed; use a shorter range for full coverage.` } : {}),
            cpuPercent: stats(cpu),
            memoryPercent: stats(mem),
            diskPercent: Object.fromEntries(Object.entries(diskSeries).map(([mount, values]) => [mount, stats(values)])),
            networkKbps: { rx: stats(rx), tx: stats(tx) },
            trend: buildTrend(samples, cpu, mem),
            peak: peakIdx < 0 ? null : {
                timestamp: samples[peakIdx].t,
                cpuPercent: round1(cpu[peakIdx]),
                topProcesses: topProcesses(samples[peakIdx].m.processes),
            },
        };
    },
};
