import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useSync } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';

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
    loginBox: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 32, maxWidth: 400, margin: '10% auto', textAlign: 'center' }
};

const FileTypes = ['access', 'smarttable', 'mailertable'];

// --- Dashboard Subcomponent ---
const DashboardTab = ({ env, linuxPassword, onNavigateToTrace, onOpenAiAdvisor }) => {
    const { lastEvent } = useSync();
    const { showToast } = useToast();
    const [stats, setStats] = useState([]);
    const [loading, setLoading] = useState(false);

    // Drilldown modal state
    const [detailModal, setDetailModal] = useState({
        open: false,
        type: 'deferred', // 'deferred' | 'bounced'
        results: [],
        loading: false,
        filterText: '',
        hostFilter: 'ALL',
        viewMode: 'table' // 'table' | 'raw'
    });

    const fetchStats = async () => {
        if(!env) return;
        setLoading(true);
        try {
            const res = await api.post('/mail/dashboard', { env, linuxPassword });
            setStats(res.data.results || []);
        } catch(e) { console.error(e); }
        setLoading(false);
    };

    const fetchDetails = async (type) => {
        if (!env) return;
        setDetailModal(prev => ({ ...prev, open: true, type, loading: true, results: [], filterText: '', hostFilter: 'ALL' }));
        try {
            const res = await api.post('/mail/dashboard/details', { env, linuxPassword, type });
            setDetailModal(prev => ({ ...prev, results: res.data.results || [], loading: false }));
        } catch (e) {
            showToast(e.message || 'Failed to fetch details', 'error');
            setDetailModal(prev => ({ ...prev, loading: false }));
        }
    };

    useEffect(() => {
        if (!lastEvent) return;
        switch(lastEvent.type) {
            case 'MAIL_RELAY_UPDATED':
                if (typeof fetchStats !== "undefined") fetchStats();
                break;
        }
    }, [lastEvent]);

    useEffect(() => {
        fetchStats();
        const interval = setInterval(fetchStats, 60000); // 1 minute refresh
        return () => clearInterval(interval);
    }, [env]);

    // Aggregate stats from all hosts
    const totalSent = stats.reduce((acc, curr) => acc + (curr.sent || 0), 0);
    const totalDeferred = stats.reduce((acc, curr) => acc + (curr.deferred || 0), 0);
    const totalBounced = stats.reduce((acc, curr) => acc + (curr.bounced || 0), 0);

    const total = totalSent + totalDeferred + totalBounced || 1;
    const sentPct = Math.round((totalSent / total) * 100);
    const bouncedPct = Math.round((totalBounced / total) * 100);

    // Filtered items in detail modal
    const allDetailItems = detailModal.results
        .filter(r => detailModal.hostFilter === 'ALL' || r.host === detailModal.hostFilter)
        .flatMap(r => (r.items || []).map(item => ({ ...item, host: r.host })));

    const filteredItems = allDetailItems.filter(item => {
        if (!detailModal.filterText) return true;
        const q = detailModal.filterText.toLowerCase();
        return (
            (item.from && item.from.toLowerCase().includes(q)) ||
            (item.sourceRelay && item.sourceRelay.toLowerCase().includes(q)) ||
            (item.to && item.to.toLowerCase().includes(q)) ||
            (item.stat && item.stat.toLowerCase().includes(q)) ||
            (item.qid && item.qid.toLowerCase().includes(q)) ||
            (item.relay && item.relay.toLowerCase().includes(q)) ||
            (item.host && item.host.toLowerCase().includes(q)) ||
            (item.raw && item.raw.toLowerCase().includes(q))
        );
    });

    const allRawLogs = detailModal.results
        .filter(r => detailModal.hostFilter === 'ALL' || r.host === detailModal.hostFilter)
        .map(r => `=== Node: ${r.host} (${r.items?.length || 0} events) ===\n${r.rawLogs || 'No entries.'}`)
        .join('\n\n');

    return (
        <div className="animate-fade-in">
            <div style={{ display: 'flex', gap: 20, marginBottom: 28 }}>
                {/* SVG circular gauge */}
                <div style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 24, padding: '24px 32px' }}>
                    <div style={{ position: 'relative', width: 110, height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="110" height="110" viewBox="0 0 110 110">
                            <circle cx="55" cy="55" r="45" fill="transparent" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
                            <circle cx="55" cy="55" r="45" fill="transparent" stroke="var(--success)" strokeWidth="10" 
                                    strokeDasharray={2 * Math.PI * 45} 
                                    strokeDashoffset={2 * Math.PI * 45 * (1 - (totalSent / total))} 
                                    strokeLinecap="round"
                                    transform="rotate(-90 55 55)" />
                            <circle cx="55" cy="55" r="45" fill="transparent" stroke="var(--danger)" strokeWidth="10" 
                                    strokeDasharray={2 * Math.PI * 45} 
                                    strokeDashoffset={2 * Math.PI * 45 * (1 - (totalBounced / total))} 
                                    strokeLinecap="round"
                                    transform={`rotate(${360 * (totalSent / total) - 90} 55 55)`} />
                        </svg>
                        <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <span style={{ fontSize: 18, fontWeight: 900 }}>{loading && stats.length === 0 ? '--' : `${sentPct}%`}</span>
                            <span style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.05em' }}>SUCCESS</span>
                        </div>
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>MAIL RELAY DISTRIBUTION</div>
                            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>Real-time relay output on {env}</p>
                        </div>
                        {totalBounced / total > 0.05 && (
                            <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, fontSize: 11, color: 'var(--danger)', fontWeight: 700 }}>
                                🚨 Warning: Bounce Rate is high (&gt;5%). Inspect bounce logs for potential issues.
                            </div>
                        )}
                    </div>
                </div>

                {/* Summary Metrics Card with Clickable Drilldown Rows */}
                <div style={{ ...S.card, flex: 0.7, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '18px 24px', gap: 8 }}>
                    {/* Sent Row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 8 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} /> Sent (成功寄送)
                        </span>
                        <strong style={{ fontSize: 16, color: 'var(--success)', fontWeight: 800 }}>{totalSent}</strong>
                    </div>

                    {/* Deferred Interactive Row */}
                    <div 
                        onClick={() => fetchDetails('deferred')}
                        title="點擊查看延遲寄送信件明細 (Click to inspect deferred mails)"
                        style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between', 
                            alignItems: 'center', 
                            padding: '8px 12px', 
                            borderRadius: 10,
                            background: 'rgba(245, 158, 11, 0.08)',
                            border: '1px solid rgba(245, 158, 11, 0.25)',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.18)'; e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.5)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'; e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.25)'; }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warning)' }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: '#fde68a' }}>Deferred (延遲重試)</span>
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(245, 158, 11, 0.25)', color: '#fbbf24', fontWeight: 800 }}>🔍 查看詳情</span>
                        </div>
                        <strong style={{ fontSize: 16, color: 'var(--warning)', fontWeight: 800 }}>{totalDeferred}</strong>
                    </div>

                    {/* Bounced Interactive Row */}
                    <div 
                        onClick={() => fetchDetails('bounced')}
                        title="點擊查看退信與失敗明細 (Click to inspect bounced mails)"
                        style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between', 
                            alignItems: 'center', 
                            padding: '8px 12px', 
                            borderRadius: 10,
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.18)'; e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.25)'; }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)' }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: '#fca5a5' }}>Bounced (退信失敗)</span>
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.25)', color: '#f87171', fontWeight: 800 }}>🔍 查看詳情</span>
                        </div>
                        <strong style={{ fontSize: 16, color: 'var(--danger)', fontWeight: 800 }}>{totalBounced}</strong>
                    </div>
                </div>
            </div>

            {/* Node Cards */}
            <div style={S.gridRow}>
                {stats.map((hostStat, i) => (
                    <div key={i} style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                            <h4 style={S.tblTitle}>Node: <span style={{ color: 'var(--accent-primary)' }}>{hostStat.host}</span></h4>
                            <span style={hostStat.status === 'Success' ? { color: 'var(--success)', fontWeight: 800, fontSize: 12 } : { color: 'var(--danger)', fontWeight: 800, fontSize: 12 }}>{hostStat.status}</span>
                        </div>
                        <p style={S.metLabel}>TOP RELAYERS (IPS/DOMAINS)</p>
                        <pre style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8, minHeight: 120 }}>
                            {hostStat.topRelayers || 'No traffic recorded today.'}
                        </pre>
                    </div>
                ))}
            </div>

            {/* --- Drilldown Modal --- */}
            {detailModal.open && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    backgroundColor: 'rgba(0, 0, 0, 0.75)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 1000,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20
                }}>
                    <div style={{
                        background: 'var(--bg-primary, #0f172a)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '95%',
                        maxWidth: 1100,
                        maxHeight: '88vh',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
                    }}>
                        {/* Modal Header */}
                        <div style={{
                            padding: '18px 24px',
                            borderBottom: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'rgba(0,0,0,0.3)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 24 }}>{detailModal.type === 'deferred' ? '🕒' : '🚨'}</span>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 900, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        {detailModal.type === 'deferred' ? 'Deferred Mail Inspection (延遲重試信件清單)' : 'Bounced Mail Inspection (退信與發送失敗信件)'}
                                        <span style={{
                                            fontSize: 11,
                                            padding: '2px 8px',
                                            borderRadius: 12,
                                            background: detailModal.type === 'deferred' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                                            color: detailModal.type === 'deferred' ? '#fbbf24' : '#f87171',
                                            fontWeight: 800
                                        }}>
                                            {env} • 共 {filteredItems.length} 筆
                                        </span>
                                    </h3>
                                    <p style={{ margin: '2px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                                        即時自 {env} 叢集各節點 /var/log/maillog 擷取今日發生的 {detailModal.type === 'deferred' ? 'Deferred' : 'Bounced / Rejected'} 紀錄
                                    </p>
                                </div>
                            </div>
                            <button 
                                onClick={() => setDetailModal(prev => ({ ...prev, open: false }))}
                                style={{
                                    background: 'rgba(255,255,255,0.08)',
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    borderRadius: 10,
                                    width: 34,
                                    height: 34,
                                    color: '#fff',
                                    fontSize: 14,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        {/* Toolbar */}
                        <div style={{
                            padding: '14px 24px',
                            borderBottom: '1px solid var(--border-color)',
                            display: 'flex',
                            gap: 12,
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            background: 'rgba(0,0,0,0.15)'
                        }}>
                            {/* Search Filter Input */}
                            <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
                                <input 
                                    style={{ ...S.input, margin: 0, paddingLeft: 34, fontSize: 12 }} 
                                    placeholder="🔍 快速搜尋收件人、原因、Queue ID、Relay IP..."
                                    value={detailModal.filterText}
                                    onChange={e => setDetailModal(prev => ({ ...prev, filterText: e.target.value }))}
                                />
                                <span style={{ position: 'absolute', left: 12, top: 10, color: 'var(--text-muted)', fontSize: 13 }}>🔍</span>
                            </div>

                            {/* Node Filter */}
                            <select 
                                style={{ ...S.select, padding: '8px 12px', fontSize: 12 }}
                                value={detailModal.hostFilter}
                                onChange={e => setDetailModal(prev => ({ ...prev, hostFilter: e.target.value }))}
                            >
                                <option value="ALL">全部節點 (All Nodes)</option>
                                {detailModal.results.map(r => (
                                    <option key={r.host} value={r.host}>{r.host} ({r.items?.length || 0})</option>
                                ))}
                            </select>

                            {/* View Switch */}
                            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 2 }}>
                                <button
                                    onClick={() => setDetailModal(prev => ({ ...prev, viewMode: 'table' }))}
                                    style={{
                                        padding: '6px 12px',
                                        fontSize: 11,
                                        fontWeight: 800,
                                        border: 'none',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                        background: detailModal.viewMode === 'table' ? 'var(--accent-primary)' : 'transparent',
                                        color: detailModal.viewMode === 'table' ? '#fff' : 'var(--text-muted)'
                                    }}
                                >
                                    📊 表格 (Table)
                                </button>
                                <button
                                    onClick={() => setDetailModal(prev => ({ ...prev, viewMode: 'raw' }))}
                                    style={{
                                        padding: '6px 12px',
                                        fontSize: 11,
                                        fontWeight: 800,
                                        border: 'none',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                        background: detailModal.viewMode === 'raw' ? 'var(--accent-primary)' : 'transparent',
                                        color: detailModal.viewMode === 'raw' ? '#fff' : 'var(--text-muted)'
                                    }}
                                >
                                    📜 原始日誌 (Raw)
                                </button>
                            </div>

                            {/* Refresh */}
                            <button 
                                onClick={() => fetchDetails(detailModal.type)}
                                disabled={detailModal.loading}
                                style={{ ...S.btnO, padding: '7px 14px', fontSize: 12 }}
                            >
                                {detailModal.loading ? '讀取中...' : '🔄 重新整理'}
                            </button>

                            {/* Batch AI Advisor */}
                            {filteredItems.length > 0 && onOpenAiAdvisor && (
                                <button
                                    onClick={() => onOpenAiAdvisor({
                                        mode: 'batch_bounce',
                                        env,
                                        type: detailModal.type,
                                        items: filteredItems.slice(0, 30)
                                    })}
                                    style={{
                                        ...S.btnP,
                                        padding: '7px 16px',
                                        fontSize: 12,
                                        background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                                        boxShadow: '0 4px 14px rgba(99, 102, 241, 0.4)',
                                        marginLeft: 'auto'
                                    }}
                                    title="彙整當前篩選之所有退信紀錄，由 AI 進行分類並給出全域處置策略"
                                >
                                    🤖 AI 分析全量退信原因 ({Math.min(filteredItems.length, 30)} 筆)
                                </button>
                            )}
                        </div>

                        {/* Modal Body */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 24, minHeight: 320 }}>
                            {detailModal.loading ? (
                                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
                                    <div style={{ fontSize: 32, marginBottom: 12 }} className="animate-spin">⏳</div>
                                    <p style={{ fontSize: 13, fontWeight: 700 }}>正在從 {env} 各節點分析 maillog 中...</p>
                                </div>
                            ) : detailModal.viewMode === 'raw' ? (
                                <div style={{ position: 'relative' }}>
                                    <button 
                                        onClick={() => {
                                            navigator.clipboard.writeText(allRawLogs);
                                            showToast('已複製所有日誌文字至剪貼簿！', 'success');
                                        }}
                                        style={{
                                            position: 'absolute',
                                            top: 12,
                                            right: 12,
                                            padding: '6px 12px',
                                            fontSize: 11,
                                            fontWeight: 800,
                                            background: 'rgba(255,255,255,0.1)',
                                            border: '1px solid rgba(255,255,255,0.2)',
                                            color: '#fff',
                                            borderRadius: 8,
                                            cursor: 'pointer'
                                        }}
                                    >
                                        📋 複製全部日誌
                                    </button>
                                    <pre style={{
                                        margin: 0,
                                        padding: 16,
                                        background: 'rgba(0,0,0,0.5)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 12,
                                        fontSize: 11,
                                        fontFamily: 'monospace',
                                        color: '#38bdf8',
                                        maxHeight: 480,
                                        overflow: 'auto',
                                        whiteSpace: 'pre-wrap',
                                        lineHeight: 1.6
                                    }}>
                                        {allRawLogs || '無紀錄'}
                                    </pre>
                                </div>
                            ) : filteredItems.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
                                    <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
                                    <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 15 }}>查無任何 {detailModal.type === 'deferred' ? 'Deferred' : 'Bounced'} 紀錄</h4>
                                    <p style={{ fontSize: 12, marginTop: 4 }}>今日該環境目前運作正常，或搜尋條件未匹配到信件。</p>
                                </div>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                        <thead>
                                            <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>時間 (TIME)</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>節點 (NODE)</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>QUEUE ID</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>寄件來源 (SENDER / FROM)</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>收件人 (RECIPIENT / TO)</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800 }}>RELAY 目標</th>
                                                <th style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 800, minWidth: 320 }}>狀態原因與操作 (REASON & ACTION)</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredItems.map((item, idx) => (
                                                <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.2s' }}>
                                                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                                                        {item.time || '-'}
                                                    </td>
                                                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                                        {item.host}
                                                    </td>
                                                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontFamily: 'monospace', color: '#a7f3d0' }}>
                                                        {item.qid || '-'}
                                                    </td>
                                                    {/* Sender / From Column */}
                                                    <td style={{ padding: '10px 12px' }}>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                <span style={{ fontWeight: 800, color: item.from && item.from !== 'Unknown (未查得來源)' ? '#38bdf8' : 'var(--text-muted)' }}>
                                                                    {item.from || '-'}
                                                                </span>
                                                                {item.from && item.from !== 'Unknown (未查得來源)' && (
                                                                    <button 
                                                                        title="複製寄件人"
                                                                        onClick={() => {
                                                                            navigator.clipboard.writeText(item.from);
                                                                            showToast(`已複製寄件人: ${item.from}`, 'success');
                                                                        }}
                                                                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                                                                    >
                                                                        📋
                                                                    </button>
                                                                )}
                                                            </div>
                                                            {item.sourceRelay && (
                                                                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                                                                    via {item.sourceRelay}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    {/* Recipient / To Column */}
                                                    <td style={{ padding: '10px 12px', fontWeight: 800, color: '#fff' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            <span>{item.to || '-'}</span>
                                                            {item.to && (
                                                                <button 
                                                                    title="複製收件人"
                                                                    onClick={() => {
                                                                        navigator.clipboard.writeText(item.to);
                                                                        showToast(`已複製收件人: ${item.to}`, 'success');
                                                                    }}
                                                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                                                                >
                                                                    📋
                                                                </button>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                                                        {item.relay || '-'}
                                                    </td>
                                                    {/* Combined Reason on Top, Action on Bottom */}
                                                    <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                                                            {/* Top: Reason */}
                                                            <div style={{
                                                                width: '100%',
                                                                padding: '6px 10px',
                                                                borderRadius: 6,
                                                                background: detailModal.type === 'deferred' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                                                                border: detailModal.type === 'deferred' ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
                                                                color: detailModal.type === 'deferred' ? '#fde68a' : '#fca5a5',
                                                                fontFamily: 'monospace',
                                                                fontSize: 11,
                                                                wordBreak: 'break-word',
                                                                lineHeight: 1.4,
                                                                boxSizing: 'border-box'
                                                            }}>
                                                                {(item.stat || item.raw).replace(/^stat=/, '')}
                                                            </div>
                                                            {/* Bottom: Action Buttons (Trace + AI Diagnose) */}
                                                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                                <button 
                                                                    onClick={() => {
                                                                        const queryTarget = item.qid || item.from || item.to;
                                                                        setDetailModal(prev => ({ ...prev, open: false }));
                                                                        if (onNavigateToTrace && queryTarget) {
                                                                            onNavigateToTrace(queryTarget);
                                                                        }
                                                                    }}
                                                                    title="以 Queue ID 或信箱前往 Message Trace 追蹤完整生命週期"
                                                                    style={{
                                                                        padding: '5px 12px',
                                                                        fontSize: 11,
                                                                        fontWeight: 800,
                                                                        background: 'rgba(255,255,255,0.08)',
                                                                        border: '1px solid rgba(255,255,255,0.2)',
                                                                        color: '#fff',
                                                                        borderRadius: 6,
                                                                        cursor: 'pointer',
                                                                        display: 'inline-flex',
                                                                        alignItems: 'center',
                                                                        gap: 6
                                                                    }}
                                                                >
                                                                    🔍 追蹤日誌 (Trace)
                                                                </button>
                                                                {onOpenAiAdvisor && (
                                                                    <button
                                                                        onClick={() => onOpenAiAdvisor({
                                                                            mode: 'bounce',
                                                                            env,
                                                                            from: item.from,
                                                                            to: item.to,
                                                                            relay: item.relay,
                                                                            stat: (item.stat || item.raw).replace(/^stat=/, ''),
                                                                            item
                                                                        })}
                                                                        title="呼叫 AI 專家深度解讀此筆退信代碼、責任歸屬與處置方針"
                                                                        style={{
                                                                            padding: '5px 12px',
                                                                            fontSize: 11,
                                                                            fontWeight: 800,
                                                                            background: 'rgba(99, 102, 241, 0.18)',
                                                                            border: '1px solid rgba(99, 102, 241, 0.4)',
                                                                            color: '#a5b4fc',
                                                                            borderRadius: 6,
                                                                            cursor: 'pointer',
                                                                            display: 'inline-flex',
                                                                            alignItems: 'center',
                                                                            gap: 6
                                                                        }}
                                                                    >
                                                                        🤖 AI 診斷
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {/* Modal Footer */}
                        <div style={{
                            padding: '14px 24px',
                            borderTop: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'rgba(0,0,0,0.3)'
                        }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                💡 提示：點擊「🔍 追蹤 Trace」可自動切換至 Message Trace 查詢該信件於所有節點的日誌流。
                            </span>
                            <button 
                                onClick={() => setDetailModal(prev => ({ ...prev, open: false }))}
                                style={{ ...S.btnP, padding: '7px 20px', fontSize: 12 }}
                            >
                                關閉 (Close)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// --- Message Trace Subcomponent ---
const MessageTraceTab = ({ env, linuxPassword, initialQuery = '', onOpenAiAdvisor }) => {
    const [query, setQuery] = useState(initialQuery);
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);

    const { showToast } = useToast();

    useEffect(() => {
        if (initialQuery) {
            setQuery(initialQuery);
            handleSearchWithTarget(initialQuery);
        }
    }, [initialQuery]);

    const handleSearchWithTarget = async (searchTarget) => {
        if (!searchTarget) return;
        setLoading(true);
        try {
            const res = await api.post('/mail/trace', { env, linuxPassword, query: searchTarget });
            setResults(res.data.results || []);
        } catch(e) { showToast(e.message, 'error'); }
        setLoading(false);
    };

    const handleSearch = async (e) => {
        if (e) e.preventDefault();
        if (!query) return;
        handleSearchWithTarget(query);
    };

    const aggregatedLogs = results.map(r => `=== Node: ${r.host} (${r.status}) ===\n${r.logs || r.error || 'No logs'}`).join('\n\n');

    return (
        <div className="animate-fade-in">
            <div style={{ ...S.card, marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div>
                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🔍 Message Trace</h3>
                        <p style={{ ...S.subtitle, marginTop: 4, marginBottom: 0 }}>Search /var/log/maillog across all cluster nodes.</p>
                    </div>
                    {results.length > 0 && onOpenAiAdvisor && (
                        <button
                            type="button"
                            onClick={() => onOpenAiAdvisor({
                                mode: 'trace',
                                env,
                                rawText: `Target Query: ${query}\n\n${aggregatedLogs}`
                            })}
                            style={{
                                ...S.btnP,
                                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                                boxShadow: '0 4px 14px rgba(99, 102, 241, 0.4)',
                                fontSize: 12,
                                padding: '8px 16px'
                            }}
                            title="由 AI 專家深度解讀搜尋到的跨節點軌跡日誌，梳理寄件始末與失敗環節"
                        >
                            🤖 AI 軌跡深度解讀
                        </button>
                    )}
                </div>
                <form onSubmit={handleSearch} style={{ display: 'flex', gap: 12 }}>
                    <input 
                        style={{ ...S.input, margin: 0, flex: 1 }} 
                        placeholder="Enter Email Address, IP, or Message-ID (e.g., admin@example.com)" 
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <button type="submit" style={S.btnP} disabled={loading || !query}>
                        {loading ? 'Searching...' : 'Search Logs'}
                    </button>
                </form>
            </div>

            <div style={S.gridRow}>
                {results.map((r, i) => (
                    <div key={i} style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                            <h4 style={S.tblTitle}>Node: <span style={{ color: 'var(--accent-primary)' }}>{r.host}</span></h4>
                            <span style={r.status === 'Success' ? { color: 'var(--success)', fontWeight: 800, fontSize: 12 } : { color: 'var(--danger)', fontWeight: 800, fontSize: 12 }}>{r.status}</span>
                        </div>
                        <pre style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8, maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {r.logs || 'No results found.'}
                            {r.error && <span style={{ color: 'var(--danger)' }}>{r.error}</span>}
                        </pre>
                    </div>
                ))}
            </div>
        </div>
    );
};

// --- Queue Manager Subcomponent ---
const QueueManagerTab = ({ env, linuxPassword, role, setIsProcessing, onOpenAiAdvisor }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const [queueResults, setQueueResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [queueIdInput, setQueueIdInput] = useState('');

    const checkQueue = async () => {
        setLoading(true); setIsProcessing(true);
        try {
            const res = await api.post('/mail/queue', { env, linuxPassword });
            setQueueResults(res.data.results || []);
        } catch(e) { showToast(e.message, 'error'); }
        setLoading(false); setIsProcessing(false);
    };

    const performAction = async (action, queueId = null) => {
        if(role !== 'SuperAdmin') return showToast('SuperAdmin Only', 'error');
        const actionName = action === 'flush' ? 'Flush Queue' : action === 'clear' ? 'Clear Entire Queue' : 'Delete Specific Queue Item';
        const confirmed = await showConfirm(`Are you sure you want to perform ${actionName} on ${env}?`);
        if(!confirmed) return;

        setLoading(true); setIsProcessing(true);
        try {
            await api.post('/mail/queue/action', { env, linuxPassword, action, queueId });
            showToast(`Action ${actionName} executed successfully`, 'success');
            checkQueue();
            if (action === 'delete') setQueueIdInput('');
        } catch(e) { showToast(e.response?.data?.error || e.message, 'error'); }
        setLoading(false); setIsProcessing(false);
    };

    const aggregatedQueueOutput = queueResults.map(r => `Node: ${r.host}\n${r.queue || r.error || 'Empty'}`).join('\n\n');

    return (
        <div className="animate-fade-in">
            <div style={{ ...S.card, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <h3 style={S.tblTitle}>📊 Queue Manager</h3>
                    <p style={{ ...S.subtitle, marginTop: 4 }}>View and manage stuck emails in the Sendmail Queue.</p>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button style={S.btnO} onClick={checkQueue} disabled={loading}>🔄 Refresh Queue</button>
                    {queueResults.length > 0 && onOpenAiAdvisor && (
                        <button
                            onClick={() => onOpenAiAdvisor({
                                mode: 'queue',
                                env,
                                queueOutput: aggregatedQueueOutput
                            })}
                            style={{
                                ...S.btnP,
                                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                                boxShadow: '0 4px 14px rgba(99, 102, 241, 0.4)',
                                fontSize: 12,
                                padding: '8px 16px'
                            }}
                            title="由 AI 專家診斷目前卡滯在 Sendmail 佇列中的郵件，分析主要壅塞瓶頸與清理建議"
                        >
                            🤖 AI 佇列壅塞分析
                        </button>
                    )}
                    {role === 'SuperAdmin' && (
                        <>
                            <button style={{ ...S.btnSuccess, background: 'var(--accent-primary)' }} onClick={() => performAction('flush')} disabled={loading}>🚀 Flush Queue</button>
                            <button style={S.btnDanger} onClick={() => performAction('clear')} disabled={loading}>🗑️ Clear Entire Queue</button>
                        </>
                    )}
                </div>
            </div>

            {role === 'SuperAdmin' && (
                <div style={{ ...S.card, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <label style={{ ...S.metLabel, margin: 0, width: 200 }}>DELETE BY QUEUE ID:</label>
                    <input 
                        style={{ ...S.input, margin: 0, flex: 1 }} 
                        placeholder="e.g. 35I6Kx7v012345" 
                        value={queueIdInput}
                        onChange={(e) => setQueueIdInput(e.target.value)}
                    />
                    <button style={S.btnDanger} onClick={() => performAction('delete', queueIdInput)} disabled={loading || !queueIdInput}>
                        Delete Queue ID
                    </button>
                </div>
            )}

            <div style={S.gridRow}>
                {queueResults.map((r, i) => (
                    <div key={i} style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                            <h4 style={S.tblTitle}>Node: <span style={{ color: 'var(--accent-primary)' }}>{r.host}</span></h4>
                            <span style={r.status === 'Success' ? { color: 'var(--success)', fontWeight: 800, fontSize: 12 } : { color: 'var(--danger)', fontWeight: 800, fontSize: 12 }}>{r.status}</span>
                        </div>
                        <pre style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8, maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {r.error && <span style={{ color: 'var(--danger)' }}>{r.error}\n</span>}
                            {r.queue || 'Mail queue is empty.'}
                        </pre>
                    </div>
                ))}
            </div>
            {queueResults.length === 0 && !loading && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
                    Click "Refresh Queue" to retrieve the current queue status.
                </div>
            )}
        </div>
    );
};

const MailRelay = ({ linuxPassword, setLinuxPassword, linuxAdminUser, setIsProcessing }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [tab, setTab] = useState('DASHBOARD'); // DASHBOARD, TRACE, QUEUE, CONFIG, BACKUP, EXTERNAL
    const [loading, setLoading] = useState(false);
    const [envs, setEnvs] = useState([]);
    
    // Unified Environment State
    const [currentEnv, setCurrentEnv] = useState('');
    const [traceInitialQuery, setTraceInitialQuery] = useState('');

    // AI Mail Advisor State
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState('');
    const [aiResult, setAiResult] = useState(null);
    const [aiCopied, setAiCopied] = useState(false);
    const [aiContext, setAiContext] = useState({
        mode: 'raw', // 'bounce' | 'batch_bounce' | 'queue' | 'trace' | 'raw'
        env: '',
        from: '',
        to: '',
        relay: '',
        stat: '',
        queueOutput: '',
        rawText: '',
        items: []
    });
    const [aiCustomInput, setAiCustomInput] = useState('');

    const handleOpenAiAdvisor = (params = {}) => {
        const mode = params.mode || 'raw';
        const ctx = {
            mode,
            env: params.env || currentEnv,
            from: params.from || '',
            to: params.to || '',
            relay: params.relay || '',
            stat: params.stat || '',
            queueOutput: params.queueOutput || '',
            rawText: params.rawText || '',
            items: params.items || []
        };
        setAiContext(ctx);
        setAiCustomInput(params.rawText || params.stat || '');
        setAiResult(null);
        setAiError('');
        setShowAiModal(true);

        // Auto trigger diagnosis if non-raw or provided with content
        if (mode !== 'raw' || params.rawText) {
            triggerAiDiagnose(ctx, params.rawText);
        }
    };

    const triggerAiDiagnose = async (ctx, customInput = null) => {
        setAiLoading(true);
        setAiError('');
        try {
            const payload = {
                env: ctx.env || currentEnv,
                linuxPassword,
                mode: ctx.mode,
                from: ctx.from,
                to: ctx.to,
                relay: ctx.relay,
                stat: ctx.stat,
                queueOutput: ctx.queueOutput,
                rawText: customInput !== null ? customInput : (aiCustomInput || ctx.rawText),
                items: ctx.items
            };
            const res = await api.post('/mail/ai-diagnose', payload);
            setAiResult(res.data);
        } catch (e) {
            setAiError(e.response?.data?.error || e.message || 'AI 診斷請求失敗');
        } finally {
            setAiLoading(false);
        }
    };

    // Auth Input logic
    const [tempPassword, setTempPassword] = useState('');

    // Config Builder State
    const [configFile, setConfigFile] = useState('access');
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
        // Load available mail environments
        api.get('/mail/envs')
            .then(r => {
                const list = r.data.envs || [];
                setEnvs(list);
                setEnvDetails(r.data.envDetails || []);
                if (list.length > 0) {
                    setCurrentEnv(list[0]);
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
                        <h1 style={S.title}>📧 Mail Relay</h1>
                        <p style={S.subtitle}>Mail Relay Cluster Management</p>
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
                        <h1 style={S.title}>📧 Mail Relay</h1>
                        <p style={S.subtitle}>Mail Relay Cluster Management</p>
                    </div>
                </div>
                <div style={{ ...S.card, textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>No Mail Environments Configured</div>
                    <p style={{ fontSize: 13 }}>Please configure MAIL_ENVS and MAIL_SERVERS in Settings first.</p>
                </div>
            </div>
        );
    }

    const currentEnvDetail = envDetails.find(d => d.name === currentEnv) || envDetails[0];
    const hasAuth = !!linuxPassword || !!currentEnvDetail?.hasPresetAuth;

    if (!hasAuth) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>📧 Mail Relay</h1>
                        <p style={S.subtitle}>Mail Relay Cluster Management</p>
                    </div>
                </div>
                <div style={S.loginBox}>
                    <h3 style={{ marginBottom: 16, fontSize: 18, fontWeight: 900 }}>🔒 sudo Authentication</h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
                        Mail Relay configuration requires <strong>{currentEnvDetail?.user || linuxAdminUser}</strong> privileges to interact with remote nodes.
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

    // Handlers
    const loadConfig = async () => {
        setLoading(true); setIsProcessing(true); setDeployResults(null); setConfigContent(''); setShowEditor(false);
        try {
            const res = await api.post('/mail/config/read', { env: currentEnv, fileType: configFile, linuxPassword });
            setConfigContent(res.data.content);
            setShowEditor(true);
        } catch(e) { showToast(e.response?.data?.error || e.message, 'error'); }
        setLoading(false); setIsProcessing(false);
    };

    const deployConfig = async () => {
        const confirmed = await showConfirm(`Are you sure you want to deploy to all ${currentEnv} servers and restart Sendmail?`);
        if(!confirmed) return;
        setLoading(true); setIsProcessing(true);
        try {
            const res = await api.post('/mail/config/deploy', { env: currentEnv, fileType: configFile, content: configContent, linuxPassword });
            setDeployResults(res.data);
            setShowEditor(false);
            showToast('Deployed successfully', 'success');
        } catch(e) { showToast(e.response?.data?.error || e.message, 'error'); }
        setLoading(false); setIsProcessing(false);
    };

    const loadBackups = async () => {
        try {
            const res = await api.get('/mail/backups');
            setBackups(res.data.files);
        } catch(e) { console.error(e); }
    };

    const viewBackupContent = async (filename) => {
        if(!filename) return;
        setSelectedBackup(filename);
        try {
            const res = await api.post('/mail/backups/read', { filename });
            setBackupContent(res.data.content);
        } catch(e) { showToast("Failed to read backup", 'error'); }
    };

    if (envs.length === 0) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>📧 Mail Relay</h1>
                        <p style={S.subtitle}>Mail Relay Cluster Management</p>
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
                        尚未設定 Mail Relay 伺服器 (No Mail Relay Servers Configured)
                    </h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 24px 0' }}>
                        目前系統尚未配置任何 Mail Relay 伺服器節點。請先前往 <strong>Settings (系統設定)</strong> 進行伺服器設定。
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
                    <h1 style={S.title}>📧 Mail Relay</h1>
                    <p style={S.subtitle}>Mail Relay Cluster Management</p>
                </div>
                {/* Environment selector & AI Advisor button pulled to top right */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                        onClick={() => handleOpenAiAdvisor({ mode: 'raw', env: currentEnv })}
                        style={{
                            ...S.btnP,
                            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                            boxShadow: '0 4px 14px rgba(99, 102, 241, 0.4)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 18px',
                            fontSize: 13,
                            fontWeight: 800
                        }}
                        title="開啟 AI 郵件顧問，可自由貼上退信 NDR、錯誤日誌或 SMTP 狀態碼即時診斷"
                    >
                        <span>🤖</span> AI 郵件診斷助理
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', padding: '8px 16px', borderRadius: 10 }}>
                        <label style={{ ...S.metLabel, margin: 0, color: 'var(--text-primary)', fontSize: 13 }}>ENVIRONMENT:</label>
                        <select 
                            style={S.select} 
                            value={currentEnv} 
                            onChange={e => setCurrentEnv(e.target.value)}
                        >
                            {envs.map(env => <option key={env} value={env}>{env} Servers</option>)}
                        </select>
                    </div>
                </div>
            </div>

            {/* Browser-like tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 16, overflowX: 'auto' }}>
                <button style={tab === 'DASHBOARD' ? S.btnP : S.btnO} onClick={() => setTab('DASHBOARD')}>📊 Dashboard</button>
                <button style={tab === 'TRACE' ? S.btnP : S.btnO} onClick={() => setTab('TRACE')}>🔍 Message Trace</button>
                <button style={tab === 'QUEUE' ? S.btnP : S.btnO} onClick={() => setTab('QUEUE')}>📨 Queue Manager</button>
                <button style={tab === 'CONFIG' ? S.btnP : S.btnO} onClick={() => setTab('CONFIG')}>⚙️ Config Editor</button>
                <button style={tab === 'BACKUP' ? S.btnP : S.btnO} onClick={() => setTab('BACKUP')}>📦 Backup Vault</button>
            </div>

            <main className="animate-fade-in">
                {tab === 'DASHBOARD' && (
                    <DashboardTab 
                        env={currentEnv} 
                        linuxPassword={linuxPassword} 
                        onNavigateToTrace={(query) => {
                            setTraceInitialQuery(query);
                            setTab('TRACE');
                        }}
                        onOpenAiAdvisor={handleOpenAiAdvisor}
                    />
                )}
                {tab === 'TRACE' && (
                    <MessageTraceTab 
                        env={currentEnv} 
                        linuxPassword={linuxPassword} 
                        initialQuery={traceInitialQuery}
                        onOpenAiAdvisor={handleOpenAiAdvisor}
                    />
                )}
                {tab === 'QUEUE' && (
                    <QueueManagerTab 
                        env={currentEnv} 
                        linuxPassword={linuxPassword} 
                        role={role} 
                        setIsProcessing={setIsProcessing}
                        onOpenAiAdvisor={handleOpenAiAdvisor}
                    />
                )}
                
                {tab === 'CONFIG' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        <div style={S.card}>
                            <div style={{ marginBottom: 16 }}>
                                <label style={S.metLabel}>TARGET CONFIGURATION FILE</label>
                                <select style={S.input} value={configFile} onChange={e => { setConfigFile(e.target.value); setShowEditor(false); }}>
                                    {FileTypes.map(f => <option key={f} value={f}>/etc/mail/{f}</option>)}
                                </select>
                            </div>
                            <button style={{ ...S.btnP, width: '100%', justifyContent: 'center' }} onClick={loadConfig} disabled={loading}>
                                {loading ? 'Fetching...' : 'Fetch Live Configuration (Host 1)'}
                            </button>
                        </div>

                        {showEditor && (
                            <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>EDITOR: /etc/mail/{configFile}</h4>
                                    {role !== 'Viewer' ? (
                                        <button style={S.btnDanger} onClick={deployConfig} disabled={loading || !configContent}>
                                            {loading ? 'Deploying...' : `Deploy to ${currentEnv} Mail Server & Restart Sendmail`}
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
                                        setLoading(true);
                                        setIsProcessing(true);
                                        setTab('CONFIG');
                                        setConfigContent(backupContent);
                                        setShowEditor(true);
                                        setDeployResults(null);
                                        if(selectedBackup.includes('access')) setConfigFile('access');
                                        if(selectedBackup.includes('smarttable')) setConfigFile('smarttable');
                                        if(selectedBackup.includes('mailertable')) setConfigFile('mailertable');
                                        
                                        if(selectedBackup.toUpperCase().includes('UAT')) setCurrentEnv('UAT');
                                        else if(selectedBackup.toUpperCase().includes('BU')) setCurrentEnv('BU');
                                        else if (envs.length > 0) {
                                            const found = envs.find(e => selectedBackup.toUpperCase().includes(e.toUpperCase()));
                                            if (found) setCurrentEnv(found);
                                        }
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

            {/* AI Mail Advisor Modal */}
            {showAiModal && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.7)',
                    backdropFilter: 'blur(8px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1100,
                    padding: 20
                }} onClick={() => setShowAiModal(false)}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '100%',
                        maxWidth: 880,
                        maxHeight: '90vh',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        boxShadow: '0 30px 60px rgba(0,0,0,0.5)',
                        backdropFilter: 'blur(16px)'
                    }} onClick={e => e.stopPropagation()}>
                        {/* Modal Header */}
                        <div style={{
                            padding: '18px 24px',
                            borderBottom: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'linear-gradient(90deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.05) 100%)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 26 }}>🤖</span>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 900, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        AI NDR 退信與佇列塞車分析師
                                        <span style={{
                                            fontSize: 10,
                                            padding: '2px 8px',
                                            borderRadius: 12,
                                            background: 'rgba(99, 102, 241, 0.25)',
                                            color: '#a5b4fc',
                                            fontWeight: 800,
                                            letterSpacing: '0.04em'
                                        }}>
                                            {aiContext.mode === 'bounce' ? '單筆退信診斷' :
                                             aiContext.mode === 'batch_bounce' ? `批次退信分析 (${aiContext.items?.length || 0} 筆)` :
                                             aiContext.mode === 'queue' ? '佇列壅塞診斷' :
                                             aiContext.mode === 'trace' ? '日誌軌跡解讀' : '自由貼上診斷'}
                                        </span>
                                        {aiResult?.engine && (
                                            <span style={{
                                                fontSize: 10,
                                                padding: '2px 8px',
                                                borderRadius: 12,
                                                background: aiResult.engine.includes('Offline') ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                                                color: aiResult.engine.includes('Offline') ? '#fbbf24' : '#34d399',
                                                fontWeight: 800
                                            }}>
                                                {aiResult.engine}
                                            </span>
                                        )}
                                    </h3>
                                    <p style={{ margin: '2px 0 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>
                                        深入解析 SMTP 狀態代碼、歸屬責任方（我方設定/對端政策/帳號異常）並提供修復指南
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowAiModal(false)}
                                style={{
                                    background: 'rgba(255,255,255,0.08)',
                                    border: '1px solid rgba(255,255,255,0.15)',
                                    borderRadius: 10,
                                    width: 32,
                                    height: 32,
                                    color: '#fff',
                                    fontSize: 14,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        {/* Modal Body */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                            {/* Input / Context Box */}
                            <div style={{
                                background: 'rgba(0,0,0,0.25)',
                                border: '1px solid var(--border-color)',
                                borderRadius: 12,
                                padding: 14,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 10
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                                        DIAGNOSTIC TARGET & METADATA
                                    </span>
                                    {aiContext.env && (
                                        <span style={{ fontSize: 11, color: '#38bdf8', fontFamily: 'monospace' }}>
                                            Cluster: {aiContext.env}
                                        </span>
                                    )}
                                </div>

                                {aiContext.mode === 'bounce' && (
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, fontSize: 12 }}>
                                        <div><strong>Sender:</strong> <span style={{ color: '#38bdf8' }}>{aiContext.from || 'Unknown'}</span></div>
                                        <div><strong>Recipient:</strong> <span style={{ color: '#fff' }}>{aiContext.to || 'Unknown'}</span></div>
                                        <div><strong>Relay:</strong> <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{aiContext.relay || 'Direct'}</span></div>
                                    </div>
                                )}

                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                                        {aiContext.mode === 'raw' ? '貼上退信 NDR 本文、郵件標頭或 maillog 片段：' : '錯誤字串 / 關鍵日誌資訊：'}
                                    </label>
                                    <textarea
                                        style={{
                                            ...S.textarea,
                                            height: aiContext.mode === 'raw' ? 120 : 70,
                                            margin: 0,
                                            fontSize: 12,
                                            background: 'rgba(0,0,0,0.4)',
                                            color: '#e2e8f0'
                                        }}
                                        value={aiCustomInput}
                                        onChange={e => setAiCustomInput(e.target.value)}
                                        placeholder="例如：stat=Deferred: 451 4.4.1 Connection refused by mx.example.com 或 550 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using Spamhaus..."
                                    />
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                                    <button
                                        onClick={() => triggerAiDiagnose(aiContext, aiCustomInput)}
                                        disabled={aiLoading || !aiCustomInput.trim()}
                                        style={{
                                            ...S.btnP,
                                            padding: '6px 18px',
                                            fontSize: 12,
                                            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'
                                        }}
                                    >
                                        {aiLoading ? '分析中...' : '🚀 開始 AI 深度診斷'}
                                    </button>
                                </div>
                            </div>

                            {/* Error Alert */}
                            {aiError && (
                                <div style={{
                                    padding: '12px 16px',
                                    borderRadius: 10,
                                    background: 'rgba(239, 68, 68, 0.15)',
                                    border: '1px solid rgba(239, 68, 68, 0.35)',
                                    color: '#fca5a5',
                                    fontSize: 12.5,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8
                                }}>
                                    <span>⚠️</span>
                                    <span>{aiError}</span>
                                </div>
                            )}

                            {/* Loading State */}
                            {aiLoading && (
                                <div style={{
                                    padding: '40px 20px',
                                    textAlign: 'center',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: 12,
                                    color: 'var(--text-muted)'
                                }}>
                                    <div style={{ fontSize: 32 }} className="animate-spin">🧠</div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                                        AI 顧問正在研判郵件日誌與 SMTP 狀態碼...
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        分析退信根因 • 責任歸屬鑑定 • 產生最佳化處理建議
                                    </div>
                                </div>
                            )}

                            {/* Result Display */}
                            {aiResult && !aiLoading && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '8px 14px',
                                        background: 'rgba(99, 102, 241, 0.08)',
                                        border: '1px solid rgba(99, 102, 241, 0.2)',
                                        borderRadius: 8,
                                        fontSize: 11
                                    }}>
                                        <span style={{ color: '#a5b4fc', fontWeight: 700 }}>
                                            🎯 診斷情境: {aiResult.mode}
                                        </span>
                                        <span style={{ color: 'var(--text-muted)' }}>
                                            引擎: <strong>{aiResult.engine}</strong>
                                        </span>
                                    </div>

                                    <div style={{
                                        padding: 20,
                                        background: 'rgba(0,0,0,0.35)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 12,
                                        fontSize: 13,
                                        lineHeight: 1.7,
                                        color: '#e2e8f0',
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word'
                                    }}>
                                        {aiResult.analysis}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Modal Footer */}
                        <div style={{
                            padding: '12px 24px',
                            borderTop: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'var(--bg-secondary)'
                        }}>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                💡 可於「System Settings &gt; AI Service」設定專屬大模型與 API 金鑰
                            </span>
                            <div style={{ display: 'flex', gap: 10 }}>
                                {aiResult && (
                                    <button
                                        onClick={() => {
                                            navigator.clipboard.writeText(aiResult.analysis);
                                            setAiCopied(true);
                                            setTimeout(() => setAiCopied(false), 2000);
                                        }}
                                        style={{ ...S.btnO, padding: '7px 16px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        {aiCopied ? '✅ 已複製報告' : '📋 複製報告'}
                                    </button>
                                )}
                                <button
                                    onClick={() => setShowAiModal(false)}
                                    style={{ ...S.btnP, padding: '7px 20px', fontSize: 12 }}
                                >
                                    關閉
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MailRelay;
