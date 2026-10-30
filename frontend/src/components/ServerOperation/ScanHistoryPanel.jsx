import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FiX } from 'react-icons/fi';
import api from '../../api';
import { formatDuration, describeScope, scanTriggerText, scanFlags, describeDegraded, fieldLabel, changeText, apiErrorText } from './inventoryHistoryUtils';

const TONES = {
    warning: ['rgba(245,158,11,0.12)', 'var(--warning)'],
    danger: ['rgba(239,68,68,0.12)', 'var(--danger)'],
    info: ['rgba(59,130,246,0.12)', 'var(--accent-primary)'],
    success: ['rgba(16,185,129,0.12)', 'var(--success)']
};

export const Badge = ({ label, tone = 'info', title }) => (
    <span title={title} style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 800, marginRight: 4, background: TONES[tone][0], color: TONES[tone][1], border: `1px solid ${TONES[tone][1]}` }}>{label}</span>
);

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const PAGE = 25;

/** Change list of one scan (click on a scan row). */
const ScanChangesModal = ({ s, scan, onClose }) => {
    const [state, setState] = useState({ loading: true, error: '', changes: [], total: 0 });
    const [offset, setOffset] = useState(0);
    const LIMIT = 100;
    useEffect(() => {
        let cancelled = false;
        setState(p => ({ ...p, loading: true, error: '' }));
        api.get(`/inventory/history/${scan.id}/changes`, { params: { limit: LIMIT, offset } })
            .then(r => { if (!cancelled) setState({ loading: false, error: '', changes: r.data.changes || [], total: r.data.total || 0 }); })
            .catch(e => { if (!cancelled) setState({ loading: false, error: apiErrorText(e, 'Failed to load changes'), changes: [], total: 0 }); });
        return () => { cancelled = true; };
    }, [scan.id, offset]);
    return (
        <div style={s.modalOverlay} onClick={onClose}>
            <div style={{ ...s.modal, maxWidth: 820 }} onClick={e => e.stopPropagation()}>
                <div style={s.modalHeader}>
                    <div>
                        <h3 style={{ ...s.overviewTitle, fontSize: 18 }}>Scan #{scan.id} changes</h3>
                        <span style={s.subnetMeta}>{fmtTime(scan.startedAt)} · {scanTriggerText(scan)} · {describeScope(scan)}</span>
                    </div>
                    <button onClick={onClose} style={s.closeBtn} aria-label="Close"><FiX size={20} /></button>
                </div>
                <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                    {state.error && <div style={{ padding: 16, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{state.error}</div>}
                    <table style={s.table}>
                        <thead><tr><th style={s.th}>IP</th><th style={s.th}>FIELD</th><th style={s.th}>CHANGE</th><th style={s.th}>TIME</th></tr></thead>
                        <tbody>
                            {state.loading ? (
                                <tr><td colSpan="4" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>
                            ) : state.changes.length === 0 ? (
                                <tr><td colSpan="4" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>No changes were recorded in this scan.</td></tr>
                            ) : state.changes.map(c => (
                                <tr key={c.id} style={s.tr}>
                                    <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 700 }}>{c.ip}</td>
                                    <td style={s.td}>{fieldLabel(c.field)}</td>
                                    <td style={s.td}>{changeText(c)}</td>
                                    <td style={{ ...s.td, fontSize: 12, color: 'var(--text-muted)' }}>{fmtTime(c.at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {state.total > LIMIT && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 24px', borderTop: '1px solid var(--border-color)' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{offset + 1}–{Math.min(offset + LIMIT, state.total)} of {state.total}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button style={s.filterBtn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>&lt;</button>
                            <button style={s.filterBtn} disabled={offset + LIMIT >= state.total} onClick={() => setOffset(offset + LIMIT)}>&gt;</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/** Scan history tab: paged scan list (cursor "before"), click a row for its changes. */
const ScanHistoryPanel = ({ s, refreshKey }) => {
    const [pages, setPages] = useState([]); // [{ before, scans, nextBefore }]
    const [index, setIndex] = useState(0);
    const [legacy, setLegacy] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState(null);

    const reqRef = useRef(0);
    useEffect(() => () => { reqRef.current = -1; }, []);
    const load = useCallback(async (before, idx, reset) => {
        const reqId = ++reqRef.current; // a newer request (or unmount) makes this response stale
        setLoading(true);
        setError('');
        try {
            const r = await api.get('/inventory/history', { params: { limit: PAGE, ...(before ? { before } : {}) } });
            if (reqRef.current !== reqId) return;
            const page = { before: before || null, scans: r.data.scans || [], nextBefore: r.data.nextBefore ?? null };
            setPages(prev => { const base = reset ? [] : prev.slice(0, idx); return [...base, page]; });
            setIndex(idx);
            if (!before) setLegacy(r.data.legacyStatusChanges || []);
        } catch (e) { if (reqRef.current !== reqId) return; setError(apiErrorText(e, 'Failed to load scan history')); }
        if (reqRef.current === reqId) setLoading(false);
    }, []);

    useEffect(() => { load(null, 0, true); }, [load, refreshKey]);

    const page = pages[index];
    const scans = page ? page.scans : [];
    return (
        <div>
            {error && <div style={{ padding: 16, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{error}</div>}
            <table style={s.table}>
                <thead>
                    <tr>
                        <th style={s.th}>STARTED</th>
                        <th style={s.th}>TRIGGER / SCOPE</th>
                        <th style={s.th}>DURATION</th>
                        <th style={s.th}>RESULT</th>
                        <th style={s.th}>FLAGS</th>
                    </tr>
                </thead>
                <tbody>
                    {loading && scans.length === 0 ? (
                        <tr><td colSpan="5" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>
                    ) : scans.length === 0 ? (
                        <tr><td colSpan="5" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>No scans recorded yet.</td></tr>
                    ) : scans.map(sc => (
                        <tr key={sc.id} style={{ ...s.tr, cursor: 'pointer' }} onClick={() => setSelected(sc)} title="Show the changes of this scan">
                            <td style={{ ...s.td, fontSize: 12 }}>{fmtTime(sc.startedAt)}</td>
                            <td style={s.td}>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>{scanTriggerText(sc)}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{describeScope(sc)}{sc.ipsChecked ? ` · ${sc.ipsChecked} IPs` : ''}</div>
                            </td>
                            <td style={{ ...s.td, fontSize: 12 }}>{sc.running ? 'running' : formatDuration(sc.durationMs)}</td>
                            <td style={{ ...s.td, fontSize: 12, whiteSpace: 'nowrap' }}>
                                <span style={{ color: 'var(--success)', fontWeight: 800 }}>{sc.online ?? 0} online</span>
                                {' / '}<span style={{ color: 'var(--danger)', fontWeight: 800 }}>{sc.offline ?? 0} offline</span>
                                {' / '}<span style={{ color: 'var(--accent-primary)', fontWeight: 800 }}>{sc.newHosts ?? 0} new</span>
                                {' / '}<span style={{ fontWeight: 800 }}>{sc.disappeared ?? 0} disappeared</span>
                            </td>
                            <td style={s.td}>
                                {scanFlags(sc).map(f => <Badge key={f.label} label={f.label} tone={f.tone} title={f.label.startsWith('DEGRADED') ? describeDegraded(sc) : undefined} />)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {(index > 0 || (page && page.nextBefore !== null)) && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, padding: '12px 24px', borderTop: '1px solid var(--border-color)' }}>
                    <button style={{ ...s.filterBtn, opacity: index === 0 ? 0.4 : 1 }} disabled={index === 0 || loading} onClick={() => setIndex(index - 1)}>&lt; Newer</button>
                    <span style={{ fontSize: 12, fontWeight: 800 }}>Page {index + 1}</span>
                    <button
                        style={{ ...s.filterBtn, opacity: page && page.nextBefore !== null ? 1 : 0.4 }}
                        disabled={loading || !page || page.nextBefore === null}
                        onClick={() => (pages[index + 1] ? setIndex(index + 1) : load(page.nextBefore, index + 1, false))}
                    >Older &gt;</button>
                </div>
            )}
            {index === 0 && legacy.length > 0 && (
                <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ ...s.metricLabel }}>EARLIER STATUS CHANGES (BEFORE SCAN HISTORY, READ-ONLY)</div>
                    <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12 }}>
                        {legacy.map((c, i) => (
                            <div key={i} style={{ padding: '3px 0', color: 'var(--text-secondary)' }}>
                                {fmtTime(c.timestamp)} · <b style={{ fontFamily: 'monospace' }}>{c.ip}</b> {c.hostname || ''} · {c.from} → {c.to}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {selected && <ScanChangesModal s={s} scan={selected} onClose={() => setSelected(null)} />}
        </div>
    );
};

export default ScanHistoryPanel;
