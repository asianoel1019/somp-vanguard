import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect } from 'react';
import { useSync } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';
import api from '../../api';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 8 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2, fontWeight: 600 },
    headerBtns: { display: 'flex', gap: 10, alignItems: 'center' },
    btnP: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s' },
    btnDanger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 20px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    btnSuccess: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 20px', background: 'var(--success)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden', marginBottom: 28 },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    textarea: { width: '100%', borderRadius: 12, padding: 16, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'monospace', marginTop: 6, boxSizing: 'border-box' },
    select: { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 8, padding: '8px 16px', fontSize: 14, outline: 'none', fontFamily: 'inherit', fontWeight: 800 },
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 12 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    loginBox: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 32, maxWidth: 400, margin: '10% auto', textAlign: 'center' },
    overlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        padding: 20
    },
    modal: {
        background: 'var(--bg-secondary, #1a1d24)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.12))',
        borderRadius: 20,
        padding: '28px 32px',
        width: '100%',
        maxWidth: 800,
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 60px rgba(0, 0, 0, 0.65)',
        color: 'var(--text-primary)',
        position: 'relative',
        boxSizing: 'border-box'
    }
};

// --- Enhanced Dashboard Subcomponent ---
const DashboardTab = ({ env, linuxPassword }) => {
    const { lastEvent } = useSync();
    const { showToast } = useToast();
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(false);
    const [filterCategory, setFilterCategory] = useState('ALL'); // ALL, DENIED, HITS, ERRORS, CONNECTS
    const [searchTerm, setSearchTerm] = useState('');
    const [autoRefresh, setAutoRefresh] = useState(true);

    // AI Threat Diagnosis Modal State
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiReport, setAiReport] = useState(null);

    useEffect(() => {
        if (!lastEvent) return;
        switch(lastEvent.type) {
            case 'PROXY_RULES_UPDATED':
                if (typeof fetchConfig !== "undefined") fetchConfig();
                break;
        }
    }, [lastEvent]);

    const fetchStats = async () => {
        if(!env) return;
        setLoading(true);
        try {
            const res = await api.post('/squid/dashboard', { env, linuxPassword });
            setStats(res.data);
        } catch(e) { 
            console.error('Squid Dashboard Fetch Error:', e); 
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStats();
        if (!autoRefresh) return;
        const interval = setInterval(fetchStats, 10000);
        return () => clearInterval(interval);
    }, [env, autoRefresh]);

    const runAiDiagnosis = async () => {
        setShowAiModal(true);
        setAiLoading(true);
        setAiReport(null);

        try {
            let currentStats = stats;
            if (!currentStats) {
                const resStats = await api.post('/squid/dashboard', { env, linuxPassword });
                currentStats = resStats.data;
                setStats(currentStats);
            }

            const res = await api.post('/squid/ai-diagnose', { env, stats: currentStats });
            if (res.data.success) {
                setAiReport(res.data);
            } else if (res.data.notConfigured) {
                setAiReport({ error: res.data.message || 'AI Engine is not configured. Please enable it in Settings > AI Service.' });
            } else {
                setAiReport({ error: res.data.error || 'Failed to generate AI diagnosis.' });
            }
        } catch (err) {
            setAiReport({ error: err.response?.data?.error || err.message });
        } finally {
            setAiLoading(false);
        }
    };

    // Filtered logs calculation
    const filteredLogs = (stats?.recentLogs || []).filter(log => {
        // Category filter
        if (filterCategory === 'DENIED' && !log.isDenied) return false;
        if (filterCategory === 'HITS' && !log.isHit) return false;
        if (filterCategory === 'ERRORS' && (log.statusCode < 400 || log.statusCode === 403)) return false;
        if (filterCategory === 'CONNECTS' && log.method !== 'CONNECT') return false;

        // Search text
        if (!searchTerm.trim()) return true;
        const term = searchTerm.toLowerCase();
        return (
            log.ip.toLowerCase().includes(term) ||
            log.url.toLowerCase().includes(term) ||
            log.domain.toLowerCase().includes(term) ||
            log.result.toLowerCase().includes(term) ||
            log.method.toLowerCase().includes(term)
        );
    });

    const maxClientBandwidth = Math.max(...(stats?.topClients || []).map(c => parseFloat(c.bandwidthMB) || 0), 1);
    const maxDomainRequests = Math.max(...(stats?.topDomains || []).map(d => d.requests || 0), 1);

    return (
        <div className="animate-fade-in">
            {/* Top Toolbar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h3 style={{ ...S.tblTitle, fontSize: 18, margin: 0 }}>📊 Live Proxy Analytics & Traffic Insights</h3>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', padding: '3px 8px', borderRadius: 6 }}>
                        Environment: <b>{env}</b>
                    </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button 
                        style={{ ...S.btnP, background: 'linear-gradient(135deg, #8b5cf6, #ec4899)', border: 'none', padding: '8px 16px', fontSize: 12 }} 
                        onClick={runAiDiagnosis}
                    >
                        🤖 AI Threat & Anomaly Diagnosis
                    </button>
                    <button 
                        style={{ ...S.btnO, padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }} 
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        title="Toggle Auto Refresh every 10s"
                    >
                        <span style={{ color: autoRefresh ? 'var(--success)' : 'var(--text-muted)' }}>●</span>
                        {autoRefresh ? 'Auto 10s' : 'Paused'}
                    </button>
                    <button 
                        style={{ ...S.btnO, padding: '8px 14px', fontSize: 12 }} 
                        onClick={fetchStats} 
                        disabled={loading}
                    >
                        {loading ? 'Refreshing...' : '🔄 Refresh'}
                    </button>
                </div>
            </div>

            {/* Top Executive Metrics (5 Cards Grid) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
                <div style={{ ...S.card, padding: '20px 24px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                    <span style={S.metLabel}>💾 CACHE HIT RATIO</span>
                    <div style={{ ...S.metVal, color: 'var(--success)', fontSize: 32 }}>
                        {stats ? stats.hitRatio : '--'}%
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        From last {stats ? stats.totalRequests : '--'} requests
                    </div>
                </div>

                <div style={{ ...S.card, padding: '20px 24px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                    <span style={S.metLabel}>📈 TRANSFERRED BANDWIDTH</span>
                    <div style={{ ...S.metVal, color: 'var(--accent-primary)', fontSize: 32 }}>
                        {stats ? stats.bandwidthMB : '--'} <span style={{ fontSize: 14, fontWeight: 700 }}>MB</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Scanned log window
                    </div>
                </div>

                <div style={{ ...S.card, padding: '20px 24px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                    <span style={S.metLabel}>🔌 ACTIVE CONNECTIONS</span>
                    <div style={{ ...S.metVal, color: 'var(--warning)', fontSize: 32 }}>
                        {stats ? stats.activeConnections : '--'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Port 3128 Established
                    </div>
                </div>

                <div style={{ ...S.card, padding: '20px 24px', background: 'var(--bg-glass)', border: stats?.deniedCount > 0 ? '1px solid rgba(239,68,68,0.4)' : '1px solid var(--border-color)', borderRadius: 16 }}>
                    <span style={S.metLabel}>🛡️ SECURITY DENIALS (403)</span>
                    <div style={{ ...S.metVal, color: stats?.deniedCount > 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: 32 }}>
                        {stats ? stats.deniedCount : '--'}
                    </div>
                    <div style={{ fontSize: 11, color: stats?.deniedCount > 0 ? 'var(--danger)' : 'var(--text-muted)', marginTop: 4, fontWeight: 600 }}>
                        {stats?.deniedCount > 0 ? '⚠️ Blocked ACL events' : 'Zero blocked events'}
                    </div>
                </div>

                <div style={{ ...S.card, padding: '20px 24px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                    <span style={S.metLabel}>⏱️ AVG RESPONSE TIME</span>
                    <div style={{ ...S.metVal, color: '#38bdf8', fontSize: 32 }}>
                        {stats ? stats.avgLatencyMs : '--'} <span style={{ fontSize: 14, fontWeight: 700 }}>ms</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Proxy transit latency
                    </div>
                </div>
            </div>

            {/* Two-Column Analytics Grid: Top Clients & Top Domains */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                {/* Left Card: Top 10 Clients */}
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                        <div>
                            <h4 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>🔥 Top 10 Internal Clients</h4>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ranked by bandwidth consumption</span>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)' }}>{(stats?.topClients || []).length} Active</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {(stats?.topClients || []).map((c, idx) => {
                            const ratio = Math.min(100, Math.round(((parseFloat(c.bandwidthMB) || 0) / maxClientBandwidth) * 100));
                            return (
                                <div 
                                    key={c.ip} 
                                    style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
                                    onClick={() => setSearchTerm(c.ip)}
                                    title="Click to filter logs by this IP"
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ fontSize: 12, fontWeight: 900, color: idx < 3 ? 'var(--warning)' : 'var(--text-muted)', width: 18 }}>#{idx + 1}</span>
                                            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent-primary)', fontFamily: 'monospace' }}>{c.ip}</span>
                                            {c.denied > 0 && (
                                                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', fontWeight: 800 }}>
                                                    {c.denied} denied
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>{c.bandwidthMB} MB</span>
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>({c.requests} reqs)</span>
                                        </div>
                                    </div>
                                    <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                                        <div style={{ width: `${ratio}%`, height: '100%', background: idx === 0 ? 'var(--accent-primary)' : '#6366f1', borderRadius: 2, transition: 'width 0.4s ease' }} />
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                                        <span>Top target: <code style={{ color: 'var(--text-secondary)' }}>{c.topDomain}</code></span>
                                        <span>Click to filter</span>
                                    </div>
                                </div>
                            );
                        })}
                        {(!stats || !stats.topClients || stats.topClients.length === 0) && (
                            <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 12 }}>No client traffic captured</div>
                        )}
                    </div>
                </div>

                {/* Right Card: Top 10 Destination Domains */}
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                        <div>
                            <h4 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>🌐 Top 10 Visited Domains</h4>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ranked by request frequency</span>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#38bdf8' }}>{(stats?.topDomains || []).length} Domains</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {(stats?.topDomains || []).map((d, idx) => {
                            const ratio = Math.min(100, Math.round((d.requests / maxDomainRequests) * 100));
                            return (
                                <div 
                                    key={d.domain} 
                                    style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
                                    onClick={() => setSearchTerm(d.domain)}
                                    title="Click to filter logs by this domain"
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                                            <span style={{ fontSize: 12, fontWeight: 900, color: idx < 3 ? '#38bdf8' : 'var(--text-muted)', width: 18 }}>#{idx + 1}</span>
                                            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{d.domain}</span>
                                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: d.isConnect ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.15)', color: d.isConnect ? '#60a5fa' : '#34d399', fontWeight: 700 }}>
                                                {d.isConnect ? 'HTTPS' : 'HTTP'}
                                            </span>
                                            {d.denied > 0 && (
                                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', fontWeight: 800 }}>
                                                    {d.denied} blocked
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>{d.requests} reqs</span>
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>({d.bandwidthMB} MB)</span>
                                        </div>
                                    </div>
                                    <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                                        <div style={{ width: `${ratio}%`, height: '100%', background: '#38bdf8', borderRadius: 2, transition: 'width 0.4s ease' }} />
                                    </div>
                                </div>
                            );
                        })}
                        {(!stats || !stats.topDomains || stats.topDomains.length === 0) && (
                            <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 12 }}>No external domain traffic captured</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Denied / Blocked Events Watchlist (Only shows if there are denied events) */}
            {stats && stats.deniedEvents && stats.deniedEvents.length > 0 && (
                <div style={{ ...S.tblWrap, border: '1px solid rgba(239,68,68,0.3)', marginBottom: 24 }}>
                    <div style={{ ...S.tblHead, background: 'rgba(239,68,68,0.05)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 18 }}>🚨</span>
                            <div>
                                <h3 style={{ ...S.tblTitle, color: 'var(--danger)' }}>Security & Denied Events Watchlist</h3>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Requests blocked by Squid ACL or blacklist rules ({stats.deniedEvents.length} events)</span>
                            </div>
                        </div>
                        <button 
                            style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '4px 12px', fontSize: 11 }}
                            onClick={() => setFilterCategory('DENIED')}
                        >
                            View All Denied in Log Table
                        </button>
                    </div>
                    <div style={{ overflowX: 'auto', maxHeight: '250px' }} className="custom-scrollbar">
                        <table style={S.tbl}>
                            <thead>
                                <tr>
                                    <th style={S.th}>TIME</th>
                                    <th style={S.th}>CLIENT IP</th>
                                    <th style={S.th}>METHOD</th>
                                    <th style={S.th}>TARGET URL / DOMAIN</th>
                                    <th style={S.th}>RESULT</th>
                                    <th style={S.th}>ACTION</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.deniedEvents.slice(0, 10).map((d, i) => (
                                    <tr key={i} style={{ ...S.tr, background: 'rgba(239,68,68,0.02)' }}>
                                        <td style={{ ...S.td, color: 'var(--text-muted)', fontSize: 12 }}>{d.timestamp}</td>
                                        <td style={{ ...S.td, color: 'var(--danger)', fontWeight: 800, fontFamily: 'monospace' }}>{d.ip}</td>
                                        <td style={{ ...S.td, fontWeight: 700 }}>{d.method}</td>
                                        <td style={{ ...S.td, maxWidth: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace' }} title={d.url}>
                                            {d.url}
                                        </td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, background: 'rgba(239,68,68,0.2)', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                                                {d.result}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <button 
                                                style={{ ...S.btnO, padding: '3px 8px', fontSize: 10 }}
                                                onClick={() => {
                                                    navigator.clipboard.writeText(d.domain || d.url);
                                                    showToast(`Copied ${d.domain || d.url} to clipboard`, 'success');
                                                }}
                                            >
                                                📋 Copy Domain
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Live Access Log Analyzer Table with Search & Filter Pills */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <h3 style={S.tblTitle}>🔍 Interactive Access Log Explorer</h3>
                        
                        {/* Filter Tabs */}
                        <div style={{ display: 'flex', gap: 6, background: 'var(--bg-secondary)', padding: 3, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                            {[
                                { id: 'ALL', label: `All Logs (${stats?.recentLogs?.length || 0})` },
                                { id: 'DENIED', label: `🚨 Denied (${stats?.deniedCount || 0})` },
                                { id: 'HITS', label: `💾 Hits (${stats ? Math.round((stats.totalRequests * parseFloat(stats.hitRatio || 0)) / 100) : 0})` },
                                { id: 'ERRORS', label: `⚠️ Errors (${stats?.errorCount || 0})` },
                                { id: 'CONNECTS', label: `🔒 HTTPS Connects` }
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    style={{
                                        padding: '4px 10px',
                                        fontSize: 11,
                                        fontWeight: 800,
                                        border: 'none',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                        background: filterCategory === tab.id ? 'var(--accent-primary)' : 'transparent',
                                        color: filterCategory === tab.id ? '#fff' : 'var(--text-muted)',
                                        transition: 'all 0.2s'
                                    }}
                                    onClick={() => setFilterCategory(tab.id)}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Search Filter Input */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            type="text"
                            style={{ ...S.input, width: 220, padding: '6px 12px', fontSize: 12, marginTop: 0 }}
                            placeholder="Filter IP, domain, result..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button 
                                style={{ ...S.btnO, padding: '4px 8px', fontSize: 11 }}
                                onClick={() => setSearchTerm('')}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                </div>

                <div style={{ overflowX: 'auto', maxHeight: '500px' }} className="custom-scrollbar">
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>TIME</th>
                                <th style={S.th}>CLIENT IP</th>
                                <th style={S.th}>METHOD</th>
                                <th style={S.th}>RESULT</th>
                                <th style={S.th}>BYTES</th>
                                <th style={S.th}>LATENCY</th>
                                <th style={S.th}>TARGET URL / DOMAIN</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredLogs.map((log, i) => {
                                const isGreen = log.isHit || log.result?.includes('TCP_TUNNEL/200');
                                const isRed = log.isDenied;
                                const bgColor = isGreen ? 'rgba(16,185,129,0.1)' : isRed ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)';
                                const color = isGreen ? 'var(--success)' : isRed ? 'var(--danger)' : 'var(--warning)';

                                return (
                                    <tr key={i} style={S.tr}>
                                        <td style={{ ...S.td, color: 'var(--text-muted)', fontSize: 12 }}>{log.timestamp}</td>
                                        <td style={{ ...S.td, color: 'var(--accent-primary)', fontWeight: 800, fontFamily: 'monospace' }}>
                                            <span 
                                                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                                                onClick={() => setSearchTerm(log.ip)}
                                                title="Filter by this IP"
                                            >
                                                {log.ip}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, fontWeight: 700, fontSize: 11 }}>
                                            <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: log.method === 'CONNECT' ? '#60a5fa' : 'var(--text-secondary)' }}>
                                                {log.method}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <span style={{ 
                                                ...S.badge, 
                                                background: bgColor,
                                                color: color,
                                                border: `1px solid ${color}`
                                            }}>
                                                {log.result}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, fontWeight: 600, fontSize: 12 }}>{log.bytes.toLocaleString()} B</td>
                                        <td style={{ ...S.td, color: 'var(--text-muted)', fontSize: 12 }}>{log.elapsed} ms</td>
                                        <td style={{ ...S.td, maxWidth: '350px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace', fontSize: 12 }} title={log.url}>
                                            <span 
                                                style={{ cursor: 'pointer' }} 
                                                onClick={() => setSearchTerm(log.domain)}
                                                title="Filter by domain"
                                            >
                                                {log.url}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                            {filteredLogs.length === 0 && (
                                <tr>
                                    <td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
                                        No access log entries matching current filter
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 🤖 AI Threat & Anomaly Diagnosis Modal */}
            {showAiModal && (
                <div style={S.overlay} onClick={() => !aiLoading && setShowAiModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 780, textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 14 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 26 }}>🤖</span>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 }}>
                                        Squid Proxy AI Security & Threat Diagnosis
                                        {aiLoading && (
                                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(139,92,246,0.2)', color: '#c084fc', border: '1px solid #c084fc', fontWeight: 800 }}>
                                                Thinking & Analyzing...
                                            </span>
                                        )}
                                    </h3>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        Powered by Vanguard Centralized AI Engine {aiReport?.model ? `(${aiReport.model})` : ''} • Env: <b>{env}</b>
                                    </span>
                                </div>
                            </div>
                            <button 
                                style={{ ...S.btnO, padding: '4px 10px', fontSize: 12 }} 
                                onClick={() => setShowAiModal(false)}
                                disabled={aiLoading}
                            >
                                ✕ Close
                            </button>
                        </div>

                        {aiLoading ? (
                            <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                                {/* Animated AI Orb / Glowing Banner */}
                                <div style={{ 
                                    maxWidth: 580, 
                                    margin: '0 auto 24px auto', 
                                    background: 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(236,72,153,0.15))', 
                                    border: '1px solid rgba(139,92,246,0.3)', 
                                    borderRadius: 16, 
                                    padding: '24px 20px',
                                    boxShadow: '0 8px 24px rgba(139,92,246,0.1)'
                                }}>
                                    <div style={{ fontSize: 32, marginBottom: 12 }} className="animate-bounce">🧠</div>
                                    <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 6 }}>
                                        📡 正在聯繫 Vanguard AI 引擎，等待回覆中...
                                    </div>
                                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
                                        系統已將 <b>{stats?.totalRequests || 0}</b> 筆即時連線特徵、Top 客戶端流量、外部目標域名與 <b>{stats?.deniedCount || 0}</b> 筆遭阻擋事件封裝傳送。<br />
                                        AI 正在全面推理與分析安全威脅，一般約需 <b>3 ~ 15 秒</b>，請稍候。
                                    </p>
                                </div>

                                {/* Step Progress Checklist */}
                                <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {[
                                        { icon: '🔍', label: '分析內部主機頻寬異常與突發外連模式 (Data Exfiltration)' },
                                        { icon: '🛡️', label: '外部訪問域名與 C2 惡意連線情報特徵比對 (C2 Beaconing)' },
                                        { icon: '🚨', label: '審查遭 ACL 攔截的 TCP_DENIED (403) 事件安全性評估' },
                                        { icon: '⚡', label: '生成快取命中率優化指引與 Squid ACL 阻擋配置建議' }
                                    ].map((step, idx) => (
                                        <div key={idx} style={{ 
                                            display: 'flex', 
                                            alignItems: 'center', 
                                            gap: 12, 
                                            padding: '10px 14px', 
                                            borderRadius: 10, 
                                            background: 'rgba(255,255,255,0.03)', 
                                            border: '1px solid var(--border-color)',
                                            fontSize: 12,
                                            fontWeight: 600,
                                            color: 'var(--text-primary)'
                                        }}>
                                            <span style={{ fontSize: 16 }}>{step.icon}</span>
                                            <span style={{ flex: 1 }}>{step.label}</span>
                                            <span className="animate-pulse" style={{ fontSize: 11, color: 'var(--accent-primary)', fontWeight: 800 }}>進行中...</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : aiReport?.error ? (
                            <div style={{ padding: 24, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 14, color: 'var(--danger)', fontSize: 13, lineHeight: 1.6 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 15, fontWeight: 900 }}>
                                    <span>⚠️</span> AI 診斷執行失敗
                                </div>
                                <div style={{ color: 'var(--text-primary)' }}>{aiReport.error}</div>
                                <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>
                                    💡 請至 <b>System Settings &gt; AI Service</b> 確認 AI 引擎（Ollama / OpenAI / Gemini）已啟動且連線正常。
                                </div>
                            </div>
                        ) : (
                            <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 8 }} className="custom-scrollbar">
                                <div style={{ 
                                    fontSize: 13, 
                                    lineHeight: 1.75, 
                                    color: 'var(--text-primary)', 
                                    whiteSpace: 'pre-wrap', 
                                    fontFamily: "'Inter', sans-serif",
                                    background: 'rgba(255,255,255,0.02)',
                                    padding: '16px 20px',
                                    borderRadius: 12,
                                    border: '1px solid var(--border-color)'
                                }}>
                                    {aiReport?.diagnosis}
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 10 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {aiReport?.provider ? `Provider: ${aiReport.provider} | Model: ${aiReport.model}` : ''}
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button 
                                    style={S.btnO} 
                                    onClick={() => {
                                        if (aiReport?.diagnosis) {
                                            navigator.clipboard.writeText(aiReport.diagnosis);
                                            showToast('Copied diagnosis report to clipboard', 'success');
                                        }
                                    }}
                                    disabled={aiLoading || !aiReport?.diagnosis}
                                >
                                    📋 Copy Report
                                </button>
                                <button 
                                    style={S.btnP} 
                                    onClick={() => setShowAiModal(false)}
                                    disabled={aiLoading}
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// --- Block Manager Subcomponent ---
const BlockManagerTab = ({ env, linuxPassword, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const [enabled, setEnabled] = useState(false);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(false);

    const loadConfig = async () => {
        setLoading(true);
        try {
            const confRes = await api.post('/squid/config/read', { env, linuxPassword, fileType: 'squid.conf' });
            setEnabled(confRes.data.content.includes('acl block_url dstdomain "/etc/squid/blacklist.txt"'));

            const res = await api.post('/squid/config/read', { env, linuxPassword, fileType: 'blacklist' });
            setContent(res.data.content);
        } catch(e) { }
        setLoading(false);
    };

    useEffect(() => { loadConfig(); }, [env]);

    const handleToggle = async () => {
        if(role !== 'SuperAdmin') return showToast('SuperAdmin Only');
        
        const confirmed = window.sysConfirm 
            ? await new Promise(resolve => window.sysConfirm(`Are you sure you want to ${enabled ? 'DISABLE' : 'ENABLE'} URL Blocking on ${env}?`, resolve))
            : await showConfirm(`Are you sure you want to ${enabled ? 'DISABLE' : 'ENABLE'} URL Blocking on ${env}?`);
            
        if(!confirmed) return;
        
        setIsProcessing(true);
        try {
            await api.post('/squid/config/toggle-block', { env, linuxPassword, enable: !enabled });
            setEnabled(!enabled);
            showToast('Success');
        } catch(e) { 
            showToast('Error: ' + e.message); 
        }
        setIsProcessing(false);
    };

    const handleSaveList = async () => {
        if(role !== 'SuperAdmin') return showToast('SuperAdmin Only');
        
        const confirmed = window.sysConfirm 
            ? await new Promise(resolve => window.sysConfirm(`Deploy changes to all ${env} servers?`, resolve))
            : await showConfirm(`Deploy changes to all ${env} servers?`);
            
        if(!confirmed) return;

        setIsProcessing(true);
        try {
            await api.post('/squid/config/deploy', { env, linuxPassword, fileType: 'blacklist', content });
            showToast('Blacklist updated and Squid reloaded.');
        } catch(e) { 
            showToast('Error: ' + e.message); 
        }
        setIsProcessing(false);
    };

    return (
        <div style={S.card} className="animate-fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
                <div>
                    <h3 style={S.tblTitle}>URL Block / Allow Manager</h3>
                    <p style={{ ...S.subtitle, marginTop: 4 }}>Manage blocked domains globally.</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)' }}>STATUS:</span>
                        <span style={{ fontWeight: 900, color: enabled ? 'var(--success)' : 'var(--danger)' }}>{enabled ? '✅ Enabled' : '❌ Disabled'}</span>
                    </div>
                    {role === 'SuperAdmin' && (
                        <button style={enabled ? S.btnDanger : S.btnSuccess} onClick={handleToggle}>
                            {enabled ? 'Disable Blocking' : 'Enable Blocking'}
                        </button>
                    )}
                </div>
            </div>
            
            <label style={S.metLabel}>🚫 BLACKLISTED DOMAINS (One per line)</label>
            <p style={{ ...S.subtitle, marginBottom: 8 }}>Example: <code>.facebook.com</code> to block facebook.com and all subdomains.</p>
            <textarea
                style={{ ...S.textarea, height: 250, marginBottom: 16 }}
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder=".facebook.com&#10;.youtube.com"
                disabled={loading}
            />
            {role === 'SuperAdmin' ? (
                <button style={S.btnP} onClick={handleSaveList} disabled={loading}>
                    Save & Deploy Blacklist
                </button>
            ) : (
                <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--danger)' }}>Read Only (SuperAdmin Required)</p>
            )}
        </div>
    );
};


// --- Main Component ---
const SquidProxy = ({ linuxPassword, setLinuxPassword, linuxAdminUser, setIsProcessing }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [tab, setTab] = useState('DASHBOARD'); // DASHBOARD, CONFIG, BLOCK, BACKUP
    const [loading, setLoading] = useState(false);
    const [envs, setEnvs] = useState([]);
    
    // Auth Input logic
    const [tempPassword, setTempPassword] = useState('');

    // Config Builder State
    const [configEnv, setConfigEnv] = useState('');
    const [fileType, setFileType] = useState('access');
    const [configContent, setConfigContent] = useState('');
    const [deployResults, setDeployResults] = useState(null);
    const [showEditor, setShowEditor] = useState(false);

    // Backup State
    const [backups, setBackups] = useState([]);
    const [selectedBackup, setSelectedBackup] = useState('');
    const [backupContent, setBackupContent] = useState('');
    const [envDetails, setEnvDetails] = useState([]);
    const [loadingEnvs, setLoadingEnvs] = useState(true);

    useEffect(() => {
        api.get('/squid/envs')
            .then(r => {
                const list = r.data.envs || [];
                setEnvs(list);
                setEnvDetails(r.data.envDetails || []);
                if (list.length > 0) {
                    setConfigEnv(list[0]);
                }
            })
            .catch(() => {})
            .finally(() => {
                setLoadingEnvs(false);
            });
    }, []);

    useEffect(() => {
        if (tab === 'BACKUP') loadBackups();
    }, [tab]);

    const handlePasswordSubmit = (e) => {
        e.preventDefault();
        setLinuxPassword(tempPassword);
    };

    if (loadingEnvs) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>🦑 Squid Proxy</h1>
                        <p style={S.subtitle}>Squid Proxy Management</p>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--text-muted)' }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                        <div>Loading environments...</div>
                    </div>
                </div>
            </div>
        );
    }

    if (envs.length === 0) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>🦑 Squid Proxy</h1>
                        <p style={S.subtitle}>Squid Proxy Management</p>
                    </div>
                </div>
                <div style={{ ...S.card, textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>No Squid Environments Configured</div>
                    <p style={{ fontSize: 13 }}>Please configure SQUID_ENVS and SQUID_SERVERS in Settings first.</p>
                </div>
            </div>
        );
    }

    const currentEnvDetail = envDetails.find(d => d.name === configEnv) || envDetails[0];
    const hasAuth = !!linuxPassword || !!currentEnvDetail?.hasPresetAuth;

    if (!hasAuth) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>🦑 Squid Proxy</h1>
                        <p style={S.subtitle}>Squid Proxy Management</p>
                    </div>
                </div>
                <div style={S.loginBox}>
                    <h3 style={{ marginBottom: 16, fontSize: 18, fontWeight: 900 }}>🔒 sudo Authentication</h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
                        Squid Proxy configuration requires <strong>{currentEnvDetail?.user || linuxAdminUser}</strong> privileges to interact with remote nodes.
                    </p>
                    <form onSubmit={handlePasswordSubmit}>
                        <input
                            type="password"
                            style={{ ...S.input, marginBottom: 16, textAlign: 'center' }}
                            placeholder={`Enter password for ${currentEnvDetail?.user || linuxAdminUser}...`}
                            value={tempPassword}
                            onChange={(e) => setTempPassword(e.target.value)}
                            autoFocus
                        />
                        <button type="submit" style={{ ...S.btnP, width: '100%', justifyContent: 'center' }} disabled={!tempPassword}>
                            Authenticate Cluster Execution
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    const loadConfig = async () => {
        setLoading(true); setIsProcessing(true); setDeployResults(null); setConfigContent(''); setShowEditor(false);
        try {
            const res = await api.post('/squid/config/read', { env: configEnv, linuxPassword, fileType });
            setConfigContent(res.data.content);
            setShowEditor(true);
        } catch(e) { showToast(e.response?.data?.error || e.message); }
        setLoading(false); setIsProcessing(false);
    };

    const deployConfig = async () => {
        const confirmed = window.sysConfirm 
            ? await new Promise(resolve => window.sysConfirm(`Are you sure you want to deploy to all ${configEnv} servers and RELOAD Squid?`, resolve))
            : await showConfirm(`Are you sure you want to deploy to all ${configEnv} servers and RELOAD Squid?`);
        if(!confirmed) return;

        setLoading(true); setIsProcessing(true);
        try {
            const res = await api.post('/squid/config/deploy', { env: configEnv, content: configContent, linuxPassword, fileType });
            setDeployResults(res.data);
            setShowEditor(false);
        } catch(e) { showToast(e.response?.data?.error || e.message); }
        setLoading(false); setIsProcessing(false);
    };

    const loadBackups = async () => {
        try {
            const res = await api.get('/squid/backups');
            setBackups(res.data.files);
        } catch(e) { console.error(e); }
    };

    const viewBackupContent = async (filename) => {
        if(!filename) return;
        setSelectedBackup(filename);
        try {
            const res = await api.post('/squid/backups/read', { filename });
            setBackupContent(res.data.content);
        } catch(e) { showToast("Failed to read backup"); }
    };

    if (envs.length === 0) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>🦑 Squid Proxy</h1>
                        <p style={S.subtitle}>Squid Proxy Management & Monitoring</p>
                    </div>
                </div>
                <div style={{
                    background: 'var(--bg-glass)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 24,
                    padding: '60px 24px',
                    textAlign: 'center',
                    maxWidth: 520,
                    margin: '40px auto',
                    boxShadow: '0 20px 40px rgba(0,0,0,0.2)'
                }}>
                    <div style={{ fontSize: 56, marginBottom: 16 }}>⚙️</div>
                    <h3 style={{ fontSize: 20, fontWeight: 900, margin: '0 0 12px 0', color: 'var(--text-primary)' }}>
                        尚未設定 Squid Proxy 伺服器 (No Squid Proxy Servers Configured)
                    </h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 24px 0' }}>
                        目前系統尚未配置任何 Squid Proxy 伺服器節點。請先前往 <strong>Settings (系統設定)</strong> 進行伺服器設定。
                    </p>
                    <button 
                        onClick={() => { if (window.navigateToSettings) window.navigateToSettings(); else window.location.hash = '#settings'; }}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '12px 24px',
                            background: 'var(--accent-primary)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 24,
                            fontWeight: 800,
                            fontSize: 14,
                            boxShadow: '0 4px 14px var(--accent-glow)',
                            cursor: 'pointer'
                        }}
                    >
                        ⚙️ 前往 Settings 設定伺服器
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div style={S.page} className="animate-fade-in">
            {/* Header */}
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>🦑 Squid Proxy</h1>
                    <p style={S.subtitle}>Squid Proxy Management & Monitoring</p>
                </div>
                {/* 1. Environment selector pulled to top right */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', padding: '8px 16px', borderRadius: 10 }}>
                    <label style={{ ...S.metLabel, margin: 0, color: 'var(--text-primary)', fontSize: 13 }}>ENVIRONMENT:</label>
                    <select 
                        style={S.select} 
                        value={configEnv} 
                        onChange={e => setConfigEnv(e.target.value)}
                    >
                        {envs.map(env => <option key={env} value={env}>{env} Servers</option>)}
                    </select>
                </div>
            </div>

            {/* 2. Browser-like tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
                <button style={tab === 'DASHBOARD' ? S.btnP : S.btnO} onClick={() => setTab('DASHBOARD')}>📊 Dashboard</button>
                <button style={tab === 'CONFIG' ? S.btnP : S.btnO} onClick={() => setTab('CONFIG')}>⚙️ Config Editor</button>
                <button style={tab === 'BLOCK' ? S.btnP : S.btnO} onClick={() => setTab('BLOCK')}>🚫 URL Block/Allow</button>
                <button style={tab === 'BACKUP' ? S.btnP : S.btnO} onClick={() => setTab('BACKUP')}>📦 Backup Vault</button>
            </div>

            <main className="animate-fade-in">
                {tab === 'DASHBOARD' && <DashboardTab env={configEnv} linuxPassword={linuxPassword} />}

                {tab === 'BLOCK' && <BlockManagerTab env={configEnv} linuxPassword={linuxPassword} role={role} setIsProcessing={setIsProcessing} />}

                {tab === 'CONFIG' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        <div style={S.card}>
                            <div style={{ marginBottom: 16 }}>
                                <label style={S.metLabel}>TARGET CONFIGURATION FILE</label>
                                <select style={S.input} value={fileType} onChange={e => { setFileType(e.target.value); setShowEditor(false); }}>
                                    <option value="access">Access List (/etc/squid/allowip.txt)</option>
                                    <option value="squid.conf">Main Config (/etc/squid/squid.conf)</option>
                                </select>
                            </div>
                            <button style={{ ...S.btnP, width: '100%', justifyContent: 'center' }} onClick={loadConfig} disabled={loading}>
                                {loading ? 'Fetching...' : 'Fetch Live Configuration (Host 1)'}
                            </button>
                        </div>

                        {showEditor && (
                            <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>EDITOR: {fileType === 'access' ? '/etc/squid/allowip.txt' : '/etc/squid/squid.conf'}</h4>
                                    {role !== 'Viewer' ? (
                                        <button style={S.btnDanger} onClick={deployConfig} disabled={loading || !configContent}>
                                            {loading ? 'Deploying...' : `Deploy to ${configEnv} Servers & Reload`}
                                        </button>
                                    ) : (
                                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--danger)' }}>Read Only</span>
                                    )}
                                </div>
                                <textarea
                                    style={{ ...S.textarea, height: 400, border: 'none', borderRadius: 0, margin: 0 }}
                                    value={configContent}
                                    onChange={(e) => setConfigContent(e.target.value)}
                                    placeholder="Fetch a configuration to edit..."
                                />
                            </div>
                        )}

                        {deployResults && (
                            <div style={S.card}>
                                <h4 style={{ ...S.tblTitle, color: 'var(--warning)', marginBottom: 12 }}>Deployment Status</h4>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, fontWeight: 600 }}>Saved Backup: {deployResults.backupFile}</div>
                                <div style={S.gridRow}>
                                    {deployResults.results.map((r, i) => (
                                        <div key={i} style={{ padding: 16, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                            <div style={{ fontWeight: 800, color: r.status==='Success' ? 'var(--success)' : 'var(--danger)' }}>
                                                {r.host} - {r.status}
                                            </div>
                                            {r.error && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{r.error}</div>}
                                            {r.logs && <pre style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, maxHeight: 120, overflow: 'auto', background: 'rgba(0,0,0,0.3)', padding: 8, borderRadius: 6, fontFamily: 'monospace' }}>{r.logs}</pre>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'BACKUP' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 24 }}>
                        <div style={{ ...S.card, height: 500, overflowY: 'auto' }} className="custom-scrollbar">
                            <h4 style={{ ...S.tblTitle, color: 'var(--accent-primary)', marginBottom: 16 }}>Local Backups ({backups.length})</h4>
                            {backups.map(bk => (
                                <div 
                                    key={bk} 
                                    onClick={() => viewBackupContent(bk)}
                                    style={{
                                        padding: '10px 14px', marginBottom: 8, cursor: 'pointer', borderRadius: 8, fontSize: 12, fontWeight: 600,
                                        border: `1px solid ${selectedBackup === bk ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                        background: selectedBackup === bk ? 'rgba(59,130,246,0.1)' : 'transparent',
                                        color: selectedBackup === bk ? 'var(--accent-primary)' : 'var(--text-primary)',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    {bk}
                                </div>
                            ))}
                        </div>
                        <div style={{ ...S.card, padding: 0, display: 'flex', flexDirection: 'column', height: 500 }}>
                            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--warning)' }}>VIEWER: {selectedBackup || 'Select a file'}</h4>
                                <button 
                                    style={{ ...S.btnP, padding: '6px 14px', fontSize: 12 }} 
                                    onClick={async () => {
                                        setTab('CONFIG');
                                        setConfigContent(backupContent);
                                        setShowEditor(true);
                                        setDeployResults(null);
                                    }} 
                                    disabled={!backupContent}
                                >
                                    Send to Config Editor
                                </button>
                            </div>
                            <textarea
                                readOnly
                                style={{ ...S.textarea, flex: 1, border: 'none', borderRadius: 0, margin: 0, resize: 'none' }}
                                value={backupContent}
                                placeholder="File contents will appear here..."
                            />
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

export default SquidProxy;
