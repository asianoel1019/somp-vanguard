import React, { useState, useEffect, useCallback } from 'react';
import api from '../../../api';
import { dataQuery, formatBytes, formatBps, formatDuration, statusTone, describeError, filterInterfaces } from './mgmtTabs.js';

const TONES = {
    success: { background: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
    danger: { background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' },
    warning: { background: 'rgba(245,158,11,0.1)', color: 'var(--warning)' },
    muted: { background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' },
};
const Badge = ({ value, tone }) => (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...TONES[tone || statusTone(value)] }}>{value === null || value === undefined || value === '' ? '-' : String(value)}</span>
);
const list = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : '-');
const dash = (v) => (v === null || v === undefined || v === '' ? '-' : v);

// Capabilities that need input before the first read (sessions: a filter)
const NEEDS_FILTER = { sessions: true };

// Query parameters of the tabs that send them
const INITIAL_PARAMS = {
    policies: { page: 1, limit: 50, search: '' },
    sessions: { src: '', dst: '', dport: '' },
    mac: { mac: '', port: '', vlan: '' },
};
// A port that learned this many MACs is most likely an uplink / trunk, not a host port
const UPLINK_MACS = 10;

/** One read-only data tab (summary, interfaces, policies, routes, sessions, vpn, ha, vlans, mac) of a managed device. */
export default function CapabilityTab({ device, capability, s }) {
    const [data, setData] = useState(null);
    const [meta, setMeta] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [params, setParams] = useState(INITIAL_PARAMS[capability] || {});
    const [ifFilter, setIfFilter] = useState({ errorsOnly: false, downOnly: false });

    const load = useCallback((refresh = false, p = params) => {
        setLoading(true);
        setError('');
        const q = INITIAL_PARAMS[capability] ? p : {};
        api.get(`/network-device/${device.id}/mgmt/data/${capability}${dataQuery(q, refresh)}`)
            .then(res => { setData(res.data.data); setMeta({ cachedAt: res.data.cachedAt, fromCache: res.data.fromCache }); })
            .catch(err => { setData(null); setError(describeError(err)); })
            .finally(() => setLoading(false));
    }, [device.id, capability]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setData(null);
        setError('');
        setMeta(null);
        if (!NEEDS_FILTER[capability]) load(false);
    }, [device.id, capability]); // eslint-disable-line react-hooks/exhaustive-deps

    const th = s.th;
    const td = { ...s.td, padding: '10px 12px', fontSize: 13 };
    const mono = { ...td, fontFamily: 'monospace' };
    const table = (head, rows) => (
        <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
                <thead><tr>{head.map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{rows.length ? rows : <tr><td colSpan={head.length} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>No data</td></tr>}</tbody>
            </table>
        </div>
    );

    const toolbar = (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {meta ? `資料時間 ${new Date(meta.cachedAt).toLocaleTimeString()}${meta.fromCache ? '（快取）' : ''}` : ''}
            </span>
            {!NEEDS_FILTER[capability] && (
                <button style={{ ...s.btnPrimary, padding: '6px 14px', opacity: loading ? 0.6 : 1 }} disabled={loading} onClick={() => load(true)}>{loading ? 'Loading...' : 'Refresh'}</button>
            )}
        </div>
    );

    const sessionFilter = capability === 'sessions' && (
        <form style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={e => { e.preventDefault(); load(true); }}>
            {[['src', 'Source IP'], ['dst', 'Destination IP'], ['dport', 'Dest Port']].map(([k, l]) => (
                <div key={k} style={{ ...s.inputGroup, marginBottom: 0 }}>
                    <label style={s.label}>{l}</label>
                    <input style={{ ...s.input, width: k === 'dport' ? 110 : 170 }} value={params[k]} onChange={e => setParams(p => ({ ...p, [k]: e.target.value }))} />
                </div>
            ))}
            <button type="submit" style={{ ...s.btnPrimary, padding: '9px 16px', opacity: loading ? 0.6 : 1 }} disabled={loading}>{loading ? 'Searching...' : 'Search'}</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: '100%' }}>至少填一個條件；最多顯示 500 筆。</span>
        </form>
    );

    const macSearch = capability === 'mac' && (
        <form style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={e => { e.preventDefault(); load(false); }}>
            {[['mac', 'MAC（任何格式，可部分）', 200], ['port', 'Port', 140], ['vlan', 'VLAN', 90]].map(([k, l, w]) => (
                <div key={k} style={{ ...s.inputGroup, marginBottom: 0 }}>
                    <label style={s.label}>{l}</label>
                    <input style={{ ...s.input, width: w }} value={params[k]} onChange={e => setParams(p => ({ ...p, [k]: e.target.value }))} />
                </div>
            ))}
            <button type="submit" style={{ ...s.btnPrimary, padding: '9px 16px', opacity: loading ? 0.6 : 1 }} disabled={loading}>{loading ? 'Searching...' : 'Search'}</button>
        </form>
    );

    const policySearch = capability === 'policies' && (
        <form style={{ display: 'flex', gap: 8, marginBottom: 12 }} onSubmit={e => { e.preventDefault(); const p = { ...params, page: 1 }; setParams(p); load(false, p); }}>
            <input style={{ ...s.input, maxWidth: 280 }} placeholder="Search id, name, address, service..." value={params.search} onChange={e => setParams(p => ({ ...p, search: e.target.value }))} />
            <button type="submit" style={{ ...s.btnPrimary, padding: '9px 16px' }}>Search</button>
        </form>
    );

    let body = null;
    if (error) body = <div style={{ padding: 12, borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', fontSize: 13 }}>{error}</div>;
    else if (!data) body = loading ? <p>Loading...</p> : (NEEDS_FILTER[capability] ? null : <p style={{ color: 'var(--text-muted)' }}>No data</p>);
    else if (capability === 'summary') {
        // a vendor leaves out (undefined) what it does not have; null is "could not be read"
        const tiles = [['Model', data.model], ['Hostname', data.hostname], ['Firmware', data.version], ['Serial', data.serial],
            ['VDOM', data.vdom], ['vsys', data.vsys], ['Domain', data.domain], ['Uptime', data.uptime],
            ['Policy', data.policy === undefined ? undefined : `${dash(data.policy)}${data.policyInstalled === false ? '（未安裝）' : ''}`],
            ['Mgmt API', data.managementApi], ['HA Mode', data.haMode],
            ['CPU', data.cpu !== null && data.cpu !== undefined ? `${data.cpu}%` : null], ['Memory', data.memory !== null && data.memory !== undefined ? `${data.memory}%` : null],
            ['Sessions', data.sessions]].filter(([, v]) => v !== undefined);
        body = (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
                {tiles.map(([k, v]) => (
                    <div key={k} style={{ padding: 12, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-primary)' }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 0.5 }}>{k.toUpperCase()}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, wordBreak: 'break-all' }}>{dash(v)}</div>
                    </div>
                ))}
                {Array.isArray(data.members) && data.members.length > 1 && (
                    <div style={{ gridColumn: '1 / -1', fontSize: 13 }}>
                        <b>Stack / 機箱成員</b>
                        {data.members.map(m => (
                            <div key={m.slot} style={{ color: 'var(--text-secondary)' }}>
                                #{m.slot} {dash(m.model)} · {dash(m.serial)} · {m.role === 'active' ? 'active' : 'member'}{m.version ? ` · ${m.version}` : ''}
                            </div>
                        ))}
                    </div>
                )}
                {Array.isArray(data.gateways) && data.gateways.length > 1 && (
                    <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--text-muted)' }}>
                        管理伺服器上的 Gateway：{data.gateways.map(g => `${g.name}${g.ip ? ` (${g.ip})` : ''}`).join('、')}
                    </div>
                )}
            </div>
        );
    } else if (capability === 'interfaces' && Array.isArray(data) && data.some(i => i.mode !== undefined)) {
        // switch / router interfaces: mode, VLAN, error counters, rates
        const shown = filterInterfaces(data, ifFilter);
        const errCell = (i) => {
            const vals = [i.inErrors, i.crcErrors, i.outErrors];
            const bad = vals.some(v => Number(v) > 0);
            return <td style={{ ...td, color: bad ? 'var(--danger)' : undefined, fontWeight: bad ? 700 : undefined }} title="input / CRC / output errors since the counters were last cleared">{vals.map(v => dash(v)).join(' / ')}</td>;
        };
        const interval = (data.find(i => i.rateInterval) || {}).rateInterval;
        const intervalText = interval ? ` · 速率為設備回報的 ${interval >= 60 ? `${interval / 60} 分鐘` : `${interval} 秒`}平均` : '';
        body = (
            <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 13, flexWrap: 'wrap' }}>
                    <label><input type="checkbox" checked={ifFilter.errorsOnly} onChange={e => setIfFilter(x => ({ ...x, errorsOnly: e.target.checked }))} /> 只看有錯誤的 Port</label>
                    <label><input type="checkbox" checked={ifFilter.downOnly} onChange={e => setIfFilter(x => ({ ...x, downOnly: e.target.checked }))} /> 只看非 up 的 Port</label>
                    <span style={{ color: 'var(--text-muted)' }}>{shown.length} / {data.length} 個介面{intervalText}</span>
                </div>
                {table(['PORT', 'STATUS', 'MODE', 'VLAN', 'SPEED', 'ERRORS (IN/CRC/OUT)', 'DISCARDS (IN/OUT)', 'RATE IN / OUT', 'IP'], shown.map(i => (
                    <tr key={i.name} title={i.name}>
                        <td style={{ ...td, fontWeight: 700 }}>{i.shortName || i.name}{i.alias && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{i.alias}</div>}</td>
                        <td style={td}><Badge value={i.status} /></td>
                        <td style={td}>{dash(i.mode)}</td>
                        <td style={td}>{i.mode === 'trunk' ? `native ${dash(i.vlan)}${i.trunkVlans ? ` · ${i.trunkVlans} VLANs` : ''}` : dash(i.vlan)}</td>
                        <td style={td}>{i.speed ? `${i.speed >= 1000 ? `${i.speed / 1000}G` : `${i.speed}M`}${i.duplex && i.duplex !== 'full' ? ` ${i.duplex}` : ''}` : '-'}</td>
                        {errCell(i)}
                        <td style={td}>{dash(i.inDiscards)} / {dash(i.outDiscards)}</td>
                        <td style={td}>{formatBps(i.rxBps)} / {formatBps(i.txBps)}</td>
                        <td style={mono}>{dash(i.ip)}</td>
                    </tr>
                )))}
            </>
        );
    } else if (capability === 'vlans') {
        body = table(['VLAN', 'NAME', 'STATUS', 'ACCESS PORTS', 'TRUNKS'], data.map(v => (
            <tr key={v.id}>
                <td style={{ ...mono, fontWeight: 700 }}>{v.id}</td><td style={td}>{dash(v.name)}</td><td style={td}><Badge value={v.status} /></td>
                <td style={td}>{v.accessPorts && v.accessPorts.length ? v.accessPorts.join(', ') : '-'}</td>
                <td style={td}>{v.trunkPorts && v.trunkPorts.length
                    ? <details><summary style={{ cursor: 'pointer' }}>{v.trunkPorts.length} 個 Trunk</summary>{v.trunkPorts.join(', ')}</details>
                    : '-'}</td>
            </tr>
        )));
    } else if (capability === 'mac') {
        const counts = data.perPortCount || {};
        body = (
            <>
                {table(['MAC', 'HOST (CMDB)', 'VLAN', 'PORT', 'TYPE'], data.items.map((m, i) => (
                    <tr key={`${m.mac}-${m.vlan}-${i}`}>
                        <td style={mono}>{m.mac}</td>
                        <td style={td}>{m.hosts && m.hosts.length
                            ? m.hosts.map(h => <div key={h.ip}>{h.hostname || '-'} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.ip}</span></div>)
                            : '-'}</td>
                        <td style={td}>{m.vlan}</td>
                        <td style={td}>
                            {m.port} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>（{counts[m.port] || 1} 個 MAC{(counts[m.port] || 0) >= UPLINK_MACS ? '，可能是 uplink / trunk' : ''}）</span>
                        </td>
                        <td style={td}>{m.type}</td>
                    </tr>
                )))}
                <p style={{ fontSize: 12, color: data.truncated ? 'var(--warning)' : 'var(--text-muted)' }}>
                    符合 {data.total} 筆{data.truncated ? `，只顯示前 ${data.items.length} 筆，請用 MAC / Port / VLAN 縮小範圍` : ''}。
                </p>
            </>
        );
    } else if (capability === 'interfaces') {
        body = table(['NAME', 'ALIAS', 'IP', 'STATUS', 'SPEED', 'VLAN', 'ZONE', 'RX', 'TX'], data.map(i => (
            <tr key={i.name}>
                <td style={{ ...td, fontWeight: 700 }}>{i.name}</td><td style={td}>{dash(i.alias)}</td><td style={mono}>{dash(i.ip)}</td>
                <td style={td}><Badge value={i.status} /></td><td style={td}>{i.speed ? `${i.speed} Mbps` : '-'}</td><td style={td}>{dash(i.vlan)}</td>
                <td style={td}>{dash(i.zone)}</td><td style={td}>{formatBytes(i.rxBytes)}</td><td style={td}>{formatBytes(i.txBytes)}</td>
            </tr>
        )));
    } else if (capability === 'policies') {
        const pages = Math.max(1, Math.ceil(data.total / data.limit));
        const hasApps = data.items.some(p => Array.isArray(p.application));
        const go = (page) => { const p = { ...params, page }; setParams(p); load(false, p); };
        body = (
            <>
                {table(['ID', 'NAME', 'FROM → TO', 'SOURCE', 'DESTINATION', hasApps ? 'APPLICATION / SERVICE' : 'SERVICE', 'ACTION', 'HITS', 'LAST HIT'], data.items.map(p => (
                    <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }} title={p.comment || ''}>
                        <td style={mono}>{p.id}</td><td style={{ ...td, fontWeight: 700 }}>{dash(p.name)}{!p.enabled && <> <Badge value="disabled" /></>}{p.section && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{p.section}</div>}</td>
                        <td style={td}>{list(p.from)} → {list(p.to)}</td><td style={td}>{list(p.source)}</td><td style={td}>{list(p.destination)}</td>
                        <td style={td}>{hasApps ? `${list(p.application)} / ${list(p.service)}` : list(p.service)}</td><td style={td}><Badge value={p.action} /></td>
                        <td style={td}>{p.hitCount === null ? '-' : p.hitCount.toLocaleString()}</td><td style={td}>{p.lastHit ? new Date(p.lastHit).toLocaleString() : '-'}</td>
                    </tr>
                )))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                    <span>
                        共 {data.total} 條{data.hitCounts ? '' : '（無法讀取命中次數）'}{data.layer ? ` · Layer：${data.layer}` : ''}
                        {data.truncated ? '（規則過多，只讀取前 5000 條）' : ''}
                    </span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button style={{ ...s.btnPrimary, padding: '4px 10px' }} disabled={data.page <= 1 || loading} onClick={() => go(data.page - 1)}>‹</button>
                        {data.page} / {pages}
                        <button style={{ ...s.btnPrimary, padding: '4px 10px' }} disabled={data.page >= pages || loading} onClick={() => go(data.page + 1)}>›</button>
                    </span>
                </div>
            </>
        );
    } else if (capability === 'routes') {
        body = table(['DESTINATION', 'GATEWAY', 'INTERFACE', 'TYPE', 'DISTANCE', 'METRIC'], data.map((r, i) => (
            <tr key={`${r.destination}-${r.gateway}-${i}`}>
                <td style={mono}>{dash(r.destination)}</td><td style={mono}>{dash(r.gateway)}</td><td style={td}>{dash(r.interface)}</td>
                <td style={td}>{dash(r.type)}</td><td style={td}>{dash(r.distance)}</td><td style={td}>{dash(r.metric)}</td>
            </tr>
        )));
    } else if (capability === 'sessions') {
        body = (
            <>
                {data.truncated && <p style={{ fontSize: 12, color: 'var(--warning)' }}>符合條件共 {data.total} 筆，只顯示前 {data.items.length} 筆；請縮小條件。</p>}
                {table(['PROTO', 'SOURCE', 'DESTINATION', 'POLICY', 'STATE', 'DURATION', 'BYTES'], data.items.map((x, i) => (
                    <tr key={i}>
                        <td style={td}>{dash(x.protocol)}</td><td style={mono}>{x.source}:{dash(x.sourcePort)}</td><td style={mono}>{x.destination}:{dash(x.destinationPort)}</td>
                        <td style={td}>{dash(x.policyId)}</td><td style={td}>{dash(x.state)}</td><td style={td}>{formatDuration(x.duration)}</td><td style={td}>{formatBytes(x.bytes)}</td>
                    </tr>
                )))}
            </>
        );
    } else if (capability === 'vpn') {
        body = (
            <>
                <h4 style={{ margin: '0 0 8px' }}>IPsec Tunnels</h4>
                {table(['NAME', 'PEER', 'STATUS', 'PHASE 2', 'IN', 'OUT'], (data.tunnels || []).map(t => (
                    <tr key={t.name}>
                        <td style={{ ...td, fontWeight: 700 }}>{t.name}</td><td style={mono}>{dash(t.peer)}</td><td style={td}><Badge value={t.status} /></td>
                        <td style={td}>{(t.phase2 || []).map(p => <span key={p.name} style={{ marginRight: 6 }}><Badge value={`${p.name}: ${p.status}`} tone={statusTone(p.status)} /></span>)}</td>
                        <td style={td}>{formatBytes(t.bytesIn)}</td><td style={td}>{formatBytes(t.bytesOut)}</td>
                    </tr>
                )))}
                <h4 style={{ margin: '20px 0 8px' }}>SSL VPN Users</h4>
                {table(['USER', 'FROM', 'TUNNEL IP', 'SINCE'], (data.users || []).map((u, i) => (
                    <tr key={`${u.user}-${i}`}>
                        <td style={{ ...td, fontWeight: 700 }}>{dash(u.user)}</td><td style={mono}>{dash(u.peer)}</td><td style={mono}>{dash(u.tunnelIp)}</td>
                        <td style={td}>{u.since ? new Date(u.since).toLocaleString() : '-'}</td>
                    </tr>
                )))}
            </>
        );
    } else if (capability === 'ha') {
        body = (
            <>
                <p style={{ fontSize: 14 }}>Mode：<b>{dash(data.mode)}</b>{data.group ? ` · Group：${data.group}` : ''}{data.priority !== null && data.priority !== undefined ? ` · Priority：${data.priority}` : ''}</p>
                {table(['HOSTNAME', 'SERIAL', 'PRIORITY', 'ROLE'], (data.members || []).map((m, i) => (
                    <tr key={`${m.serial}-${i}`}>
                        <td style={{ ...td, fontWeight: 700 }}>{dash(m.hostname)}</td><td style={mono}>{dash(m.serial)}</td><td style={td}>{dash(m.priority)}</td>
                        <td style={td}>{m.primary === null || m.primary === undefined ? (m.state || '-') : <Badge value={m.primary ? 'primary' : 'secondary'} tone={m.primary ? 'success' : 'muted'} />}</td>
                    </tr>
                )))}
            </>
        );
    }

    return (
        <div>
            {toolbar}
            {policySearch}
            {macSearch}
            {sessionFilter}
            {body}
        </div>
    );
}
