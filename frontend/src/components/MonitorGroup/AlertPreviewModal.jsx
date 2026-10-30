import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';

const overlay = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const box = { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 860, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' };
const th = { padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', borderBottom: '2px solid var(--border-color)' };
const td = { padding: '10px 14px', fontSize: 13, borderBottom: '1px solid var(--border-color)' };
const btnS = { padding: '9px 20px', background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' };

export default function AlertPreviewModal({ onClose }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setError('');
        try {
            const res = await api.get('/alert-quality/preview');
            setData(res.data);
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    const firing = data?.firing || [];
    const muted = firing.filter(f => f.inMaintenance).length;

    return (
        <div style={overlay} onClick={onClose}>
            <div style={box} onClick={e => e.stopPropagation()}>
                <div style={{ padding: '20px 28px', borderBottom: '1px solid var(--border-color)' }}>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>🔍 Preview Alerts</h3>
                </div>
                <div style={{ padding: '20px 28px', overflowY: 'auto' }}>
                    {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
                    {error && <div style={{ color: '#ef4444' }}>Failed to load: {error}</div>}
                    {data && !loading && (
                        <>
                            <div style={{ fontSize: 13, marginBottom: 14 }}>
                                Checked {data.monitorsChecked} hosts ({data.monitorsWithoutMetrics} without metrics, {data.monitorsStale} with metrics older than 10 min), {data.rulesChecked} rules — {firing.length} alerts would fire ({muted} muted by maintenance).
                            </div>
                            {firing.length === 0 ? (
                                <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)' }}>No rules would fire right now</div>
                            ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr><th style={th}>Host</th><th style={th}>Rule</th><th style={th}>Type</th><th style={th}>Value</th><th style={th}>Threshold</th><th style={th}>In maintenance</th></tr>
                                    </thead>
                                    <tbody>
                                        {firing.map((f, i) => (
                                            <tr key={`${f.monitorId}-${f.ruleId}-${f.target || ''}-${i}`}>
                                                <td style={{ ...td, fontWeight: 700 }}>{f.host}{f.ip ? ` (${f.ip})` : ''}</td>
                                                <td style={td}>{f.ruleName}</td>
                                                <td style={{ ...td, textTransform: 'uppercase' }}>{f.type}{f.target ? ` ${f.target}` : ''}</td>
                                                <td style={td}>{String(f.value)}</td>
                                                <td style={td}>{String(f.threshold)}</td>
                                                <td style={td}>{f.inMaintenance ? '🔧 Yes' : '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            {data.note && <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>{data.note}</div>}
                        </>
                    )}
                </div>
                <div style={{ padding: '16px 28px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' }}>
                    <button style={btnS} onClick={load} disabled={loading}>Refresh</button>
                    <button style={btnS} onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
