import React, { useState, useEffect } from 'react';
import { FaLinux, FaWindows } from 'react-icons/fa';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import api from '../../api';
import WebRemoteModal from './WebRemoteModal';
import { shouldFallbackToConfig } from './webRemoteUtils';
import { excludedRulesForMonitor, isExcludedFor } from '../MonitorGroup/ruleExclusionUtils';

// Simplified styles
const S = {
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-primary)', borderRadius: 16, width: '90%', maxWidth: 1000, height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' },
    modalHead: { padding: '24px 32px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
    modalTitle: { fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 12 },
    modalBody: { padding: 32, flex: 1, overflowY: 'auto' },
    modalFoot: { padding: '16px 32px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' },
    btnP: { background: 'var(--accent-primary)', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s' },
    btnRemote: { background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', color: '#fff', border: '1px solid #3b82f6', padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)', transition: 'all 0.2s' },
    btnRemoteSsh: { background: 'linear-gradient(135deg, #059669 0%, #047857 100%)', color: '#fff', border: '1px solid #10b981', padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)', transition: 'all 0.2s' },
    btnRemoteDisabled: { background: 'rgba(51, 65, 85, 0.4)', color: '#94a3b8', border: '1px solid rgba(148, 163, 184, 0.2)', padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'not-allowed', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: 0.42, filter: 'grayscale(100%)' },
    badge: { padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' },
    th: { textAlign: 'left', padding: '12px 20px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' },
    td: { padding: '16px 20px', fontSize: 14, borderBottom: '1px solid var(--border-color)' }
};

const formatUptime = (seconds) => {
    if (!seconds) return '-';
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor((seconds % (3600*24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

export default function HostDetailModal({ isOpen, onClose, initialHost }) {
    const [host, setHost] = useState(initialHost);
    const [activeTab, setActiveTab] = useState('overview');
    const [metrics, setMetrics] = useState([]);
    const [rawHistory, setRawHistory] = useState([]);
    const [selectedChartTarget, setSelectedChartTarget] = useState('host');
    const [expandedProcesses, setExpandedProcesses] = useState({});
    const [rules, setRules] = useState([]);
    const [bindings, setBindings] = useState([]);
    const [exclusions, setExclusions] = useState([]);
    const [alerts, setAlerts] = useState([]);
    const [integrationData, setIntegrationData] = useState({ inventory: null, ipam: null, loading: false });
    const [tagInput, setTagInput] = useState('');
    const [historyRange, setHistoryRange] = useState(1); // Default to 1 hour
    const [hasGuacamole, setHasGuacamole] = useState(false);
    const [isRemoteOpen, setIsRemoteOpen] = useState(false);

    useEffect(() => {
        if (!isOpen || !initialHost) return;
        setHost(initialHost);
        setActiveTab(initialHost.id ? 'overview' : 'integration');
        setHistoryRange(1);
        fetchModalData(initialHost, 1);

        // Check Guacamole gateway endpoint status
        api.get('/remote/status')
            .then(r => setHasGuacamole(!!r.data?.configured))
            .catch((err) => {
                // 403 = Web Remote not allowed for this user: hide the button instead of falling back
                if (!shouldFallbackToConfig(err)) { setHasGuacamole(false); return; }
                api.get('/auth/config')
                    .then(r => setHasGuacamole(!!r.data?.hasGuacamole))
                    .catch(() => setHasGuacamole(false));
            });
    }, [isOpen, initialHost]);

    const fetchMetricsHistory = async (hostId, hours) => {
        try {
            const mRes = await api.get(`/monitor/${hostId}/metrics?hours=${hours}`);
            setRawHistory(mRes.data || []);
            const formatted = (mRes.data || []).map(d => ({
                time: new Date(d.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}),
                cpu: d.metrics.cpu?.used ? Number(d.metrics.cpu.used.toFixed(2)) : 0,
                memory: d.metrics.memory?.used ? Number(d.metrics.memory.used.toFixed(2)) : 0,
            }));
            setMetrics(formatted);
        } catch (err) {
            console.error('Error fetching metrics history:', err);
        }
    };

    const fetchModalData = async (targetHost, rangeVal = 1) => {
        try {
            // Fetch rules, bindings, alerts
            const [rRes, bRes, aRes, xRes] = await Promise.all([
                api.get('/monitor/rules'),
                api.get('/monitor/rules/bindings'),
                api.get('/monitor/data/alerts'),
                api.get('/monitor/rules/exclusions').catch(() => ({ data: [] }))
            ]);
            setRules(rRes.data || []);
            setBindings(bRes.data || []);
            setExclusions(Array.isArray(xRes.data) ? xRes.data : []);
            setAlerts(Array.isArray(aRes.data) ? aRes.data : (aRes.data?.data || []));

            // Fetch integration
            setIntegrationData(prev => ({ ...prev, loading: true }));
            const intRes = await api.get(`/integration/check?ip=${targetHost.ip}`);
            setIntegrationData({ inventory: intRes.data.inventory, ipam: intRes.data.ipam, loading: false });

            // If we found monitor data in integration check that has more updated info (like id, tags, lastMetric etc.)
            // update our local host state so the UI displays all Monitor details correctly.
            if (intRes.data.monitor) {
                // Ensure tags are parsed properly
                let mHost = intRes.data.monitor;
                if (typeof mHost.tags === 'string') {
                    try { mHost.tags = JSON.parse(mHost.tags); } catch(e) { mHost.tags = []; }
                }
                setHost(mHost);
                setActiveTab('overview');
                
                // Fetch metrics with range
                await fetchMetricsHistory(mHost.id, rangeVal);
            } else {
                // If there's no monitor record, change the active tab to integration (Asset)
                setActiveTab('integration');
                setMetrics([]);
                setRawHistory([]);
            }
        } catch (err) {
            console.error('Error fetching modal data:', err);
            setIntegrationData(prev => ({ ...prev, loading: false }));
        }
    };

    const handleRangeChange = (val) => {
        setHistoryRange(val);
        if (host && host.id) {
            fetchMetricsHistory(host.id, val);
        }
    };

    const handleAddTagToHost = async (e) => {
        if (e.key === 'Enter' && tagInput.trim()) {
            const newTag = tagInput.trim();
            if (!host.id) return;
            const currentTags = Array.isArray(host.tags) ? host.tags : [];
            if (currentTags.includes(newTag)) {
                setTagInput('');
                return;
            }
            try {
                const updatedTags = [...currentTags, newTag];
                await api.put(`/monitor/${host.id}`, { tags: updatedTags });
                setTagInput('');
                setHost(prev => ({ ...prev, tags: updatedTags }));
            } catch (err) {}
        }
    };

    const handleRemoveTagFromHost = async (tag) => {
        if (!host.id) return;
        try {
            const currentTags = Array.isArray(host.tags) ? host.tags : [];
            const updatedTags = currentTags.filter(t => t !== tag);
            await api.put(`/monitor/${host.id}`, { tags: updatedTags });
            setHost(prev => ({ ...prev, tags: updatedTags }));
        } catch (err) {}
    };

    // Detect Operating System for remote protocol
    const detectedOsStr = ((host?.os || initialHost?.os || integrationData?.inventory?.os || '') + ' ' + (integrationData?.inventory?.osname || '')).toLowerCase();
    const isWindows = detectedOsStr.includes('win') || host?.os === 'windows';
    const isLinux = detectedOsStr.includes('linux') || detectedOsStr.includes('ubuntu') || detectedOsStr.includes('centos') || detectedOsStr.includes('redhat') || host?.os === 'linux';

    return (
        <React.Fragment>
            {/* Host Detail Modal */}
      {isOpen && host && (
        <div style={S.modalOverlay} onClick={() => onClose()}>
          <div style={{...S.modalContent, maxWidth: 1000, height: '85vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden'}} onClick={e => e.stopPropagation()}>
            
            {/* Modal Header */}
            <div style={{...S.modalHead, background: 'var(--bg-secondary)', borderBottom: 'none', padding: '24px 32px'}}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                    <div>
                        <h2 style={{...S.modalTitle, display: 'flex', alignItems: 'center', gap: 12, fontSize: 24}}>
                            {isLinux ? <FaLinux style={{color: '#facc15', fontSize: 28}} /> : <FaWindows style={{color: '#3b82f6', fontSize: 28}} />} {host.name}
                            <span style={{...S.badge, background: host.status === 'offline' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)', color: host.status === 'offline' ? '#ef4444' : '#10b981', fontSize: 12}}>
                                {host.status === 'offline' ? 'OFFLINE' : 'ONLINE'}
                            </span>
                        </h2>
                        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span><strong>IP:</strong> {host.ip}</span>
                            <span><strong>Group:</strong> {host.group}</span>
                            <span><strong>Last Seen:</strong> {new Date(host.lastSeen).toLocaleString()}</span>
                            <span><strong>Interval:</strong> {host.reportInterval}s</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 8 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tags:</span>
                                {(Array.isArray(host.tags) ? host.tags : []).map(tag => (
                                    <div key={tag} style={{...S.badge, background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', fontSize: 11}}>
                                        <span>{tag}</span>
                                        {host.id && (
                                            <button 
                                                style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 2px', fontSize: 12, fontWeight: 'bold' }}
                                                onClick={() => handleRemoveTagFromHost(tag)}
                                                title="Remove tag"
                                            >×</button>
                                        )}
                                    </div>
                                ))}
                                {host.id ? (
                                    <input 
                                        type="text"
                                        style={{ padding: '2px 8px', fontSize: 11, width: 100, background: 'transparent', border: '1px dashed var(--border-color)', borderRadius: 12, color: 'var(--text-primary)' }}
                                        placeholder="+ Add Tag"
                                        value={tagInput}
                                        onChange={(e) => setTagInput(e.target.value)}
                                        onKeyDown={handleAddTagToHost}
                                    />
                                ) : (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>(Not registered in Scout Monitor)</span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Remote Access Action Buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 16 }}>
                        {isWindows && (
                            <button
                                disabled={!hasGuacamole}
                                style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemote}
                                onClick={() => hasGuacamole && setIsRemoteOpen('rdp')}
                                title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點，請由超級管理員至後台設定填寫 GUACD_HOST / GUACD_PORT 啟用連線" : `開啟 ${host.name} 之 Web RDP 遠端桌面`}
                            >
                                🖥️ Web RDP
                            </button>
                        )}
                        {isLinux && (
                            <button
                                disabled={!hasGuacamole}
                                style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemoteSsh}
                                onClick={() => hasGuacamole && setIsRemoteOpen('ssh')}
                                title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點，請由超級管理員至後台設定填寫 GUACD_HOST / GUACD_PORT 啟用連線" : `開啟 ${host.name} 之 Web SSH 終端機`}
                            >
                                ⚡ Web SSH
                            </button>
                        )}
                        {!isWindows && !isLinux && (
                            <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                    disabled={!hasGuacamole}
                                    style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemote}
                                    onClick={() => hasGuacamole && setIsRemoteOpen('rdp')}
                                    title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點" : "開啟 Web RDP"}
                                >
                                    🖥️ Web RDP
                                </button>
                                <button
                                    disabled={!hasGuacamole}
                                    style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemoteSsh}
                                    onClick={() => hasGuacamole && setIsRemoteOpen('ssh')}
                                    title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點" : "開啟 Web SSH"}
                                >
                                    ⚡ Web SSH
                                </button>
                            </div>
                        )}
                        <button
                            onClick={() => onClose()}
                            style={{ background: 'transparent', border: 'none', fontSize: 20, color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 8px', borderRadius: 6, lineHeight: 1 }}
                            title="Close Modal"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            </div>
            
            {/* Modal Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '0 24px', background: 'var(--bg-secondary)' }}>
                {[
                    ...(host.id ? [
                        { id: 'overview', label: '📈 Latest Metrics' },
                        { id: 'history', label: '📊 Performance History' },
                        { id: 'rules', label: '🛡️ Assigned Rules' },
                        { id: 'alerts', label: '⚠️ Alert History' }
                    ] : []),
                    ...(integrationData.inventory || integrationData.ipam ? [{ id: 'integration', label: '🖥️ Asset' }] : [])
                ].map(t => (
                    <button key={t.id} 
                        style={{ background: 'transparent', border: 'none', padding: '16px 20px', color: activeTab === t.id ? 'var(--accent-primary)' : 'var(--text-muted)', fontWeight: activeTab === t.id ? 800 : 500, borderBottom: activeTab === t.id ? '3px solid var(--accent-primary)' : '3px solid transparent', cursor: 'pointer', transition: 'all 0.2s', fontSize: 14 }}
                        onClick={() => setActiveTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* Modal Body */}
            <div style={{...S.modalBody, padding: 32, flex: 1, overflowY: 'auto', background: 'var(--bg-primary)'}}>
                {/* Tab: Overview */}
                {activeTab === 'overview' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        {!host.lastMetric ? (
                            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)' }}>No metrics data reported yet</div>
                        ) : (
                            <>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
                                    {host.lastMetric.cpu && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(59, 130, 246, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>CPU Usage</div>
                                            <div style={{ fontSize: 36, fontWeight: 900, color: host.lastMetric.cpu.used > 80 ? '#ef4444' : 'var(--text-primary)' }}>{host.lastMetric.cpu.used?.toFixed(1)}%</div>
                                        </div>
                                    )}
                                    {host.lastMetric.memory && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(139, 92, 246, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>Memory Usage</div>
                                            <div style={{ fontSize: 36, fontWeight: 900, color: host.lastMetric.memory.used > 80 ? '#ef4444' : 'var(--text-primary)' }}>{host.lastMetric.memory.used?.toFixed(1)}%</div>
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                                                {host.lastMetric.memory.totalMB ? `Total: ${(host.lastMetric.memory.totalMB / 1024).toFixed(1)} GB` : ''}
                                                {host.lastMetric.memory.total ? `Total: ${(host.lastMetric.memory.total / 1024 / 1024 / 1024).toFixed(1)} GB` : ''}
                                            </div>
                                        </div>
                                    )}
                                    {host.lastMetric.connections && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(20, 184, 166, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(20, 184, 166, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>TCP Connections</div>
                                            <div style={{ fontSize: 36, fontWeight: 900, color: 'var(--text-primary)' }}>{host.lastMetric.connections.established}</div>
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                                                Total: {host.lastMetric.connections.total} (Listen: {host.lastMetric.connections.listen})
                                            </div>
                                        </div>
                                    )}
                                    {host.lastMetric.network && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(99, 102, 241, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>Network Speed</div>
                                            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)' }}>
                                                Rx: {host.lastMetric.network.rxSpeedKbps >= 1024 ? `${(host.lastMetric.network.rxSpeedKbps / 1024).toFixed(1)} MB/s` : `${host.lastMetric.network.rxSpeedKbps?.toFixed(1)} KB/s`}
                                            </div>
                                            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>
                                                Tx: {host.lastMetric.network.txSpeedKbps >= 1024 ? `${(host.lastMetric.network.txSpeedKbps / 1024).toFixed(1)} MB/s` : `${host.lastMetric.network.txSpeedKbps?.toFixed(1)} KB/s`}
                                            </div>
                                        </div>
                                    )}
                                    {host.lastMetric.system && host.lastMetric.system.load && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>System Load</div>
                                            <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)' }}>
                                                {host.lastMetric.system.load.load1?.toFixed(2)}
                                            </div>
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                                                5m: {host.lastMetric.system.load.load5?.toFixed(2)} | 15m: {host.lastMetric.system.load.load15?.toFixed(2)}
                                            </div>
                                        </div>
                                    )}
                                    {host.lastMetric.system && host.lastMetric.system.uptime && (
                                        <div style={{ background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, var(--bg-glass) 100%)', border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: 12, padding: 20 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>System Uptime</div>
                                            <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)' }}>
                                                {formatUptime(host.lastMetric.system.uptime)}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {host.lastMetric.disk && host.lastMetric.disk.length > 0 && (
                                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                                        <div style={{ padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase' }}>Disk Volumes</div>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Mount Point</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Used (%)</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Free Space</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Total Capacity</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {host.lastMetric.disk.map((d, i) => {
                                                    const totalGB = d.totalGB != null ? d.totalGB : (d.total ? d.total / (1024 * 1024 * 1024) : 0);
                                                    const freeGB = d.freeGB != null ? d.freeGB : (d.free ? d.free / (1024 * 1024 * 1024) : (totalGB > 0 && d.used != null ? totalGB * (1 - d.used / 100) : null));
                                                    const formattedFree = freeGB != null && !isNaN(freeGB) ? (freeGB < 1 ? `${(freeGB * 1024).toFixed(0)} MB` : `${freeGB.toFixed(1)} GB`) : '-';

                                                    return (
                                                        <tr key={i}>
                                                            <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', fontWeight: 700 }}>{d.mount || d.mountPoint || d.fs || '-'}</td>
                                                            <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', fontWeight: 800, color: d.used > 85 ? '#ef4444' : 'inherit' }}>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                                    <span style={{ width: 45 }}>{d.used?.toFixed(1)}%</span>
                                                                    <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                                                                        <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, d.used))}%`, background: d.used > 85 ? '#ef4444' : '#3b82f6', borderRadius: 3 }}></div>
                                                                    </div>
                                                                </div>
                                                            </td>
                                                            <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', fontWeight: 700, color: '#10b981' }}>
                                                                {formattedFree}
                                                            </td>
                                                            <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>
                                                                {totalGB > 0 ? `${totalGB.toFixed(1)} GB` : '-'}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {host.lastMetric.ping && host.lastMetric.ping.length > 0 && (
                                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                                        <div style={{ padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase' }}>Ping Targets</div>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Target Address</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Latency (ms)</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Packet Loss (%)</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {host.lastMetric.ping.map((p, i) => (
                                                    <tr key={i}>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>{p.target || p.host}</td>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', fontWeight: 700 }}>{p.rttMs === -1 || p.time === 'unknown' ? '-' : p.rttMs?.toFixed(1) || p.time?.toFixed(1) || p.avg?.toFixed(1)}</td>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>{p.lost != null ? p.lost.toFixed(1) : p.packetLoss != null ? p.packetLoss.toFixed(1) : '-'}</td>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>
                                                            {p.rttMs === -1 || p.lost === 100 || p.alive === false ? <span style={{...S.badge, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444'}}>DOWN</span> : <span style={{...S.badge, background: 'rgba(16, 185, 129, 0.1)', color: '#10b981'}}>UP</span>}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {host.lastMetric.tcp && host.lastMetric.tcp.length > 0 && (
                                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                                        <div style={{ padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase' }}>TCP Endpoint Checks</div>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Endpoint</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Latency (ms)</th>
                                                    <th style={{ textAlign: 'left', padding: '12px 20px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {host.lastMetric.tcp.map((t, i) => (
                                                    <tr key={i}>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>{t.host}:{t.port}</td>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', fontWeight: 700 }}>{t.ok ? t.latencyMs?.toFixed(1) : '-'}</td>
                                                        <td style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)' }}>
                                                            {t.ok ? <span style={{...S.badge, background: 'rgba(16, 185, 129, 0.1)', color: '#10b981'}}>UP</span> : <span style={{...S.badge, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444'}}>DOWN</span>}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {(host.lastMetric.services || host.lastMetric.processes) && (
                                     <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                         {host.lastMetric.services && host.lastMetric.services.length > 0 && (
                                             <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20 }}>
                                                 <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', marginBottom: 16 }}>Monitored Services</div>
                                                 <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                     {host.lastMetric.services.map(s => (
                                                         <span key={s.name} style={{...S.badge, background: s.status?.toLowerCase() === 'running' || s.status === true ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: s.status?.toLowerCase() === 'running' || s.status === true ? '#10b981' : '#ef4444', border: `1px solid ${s.status?.toLowerCase() === 'running' || s.status === true ? '#10b981' : '#ef4444'}`}}>
                                                             {s.name}: {(s.status === true ? 'RUNNING' : s.status === false ? 'STOPPED' : s.status?.toUpperCase() || 'UNKNOWN')}
                                                         </span>
                                                     ))}
                                                 </div>
                                             </div>
                                         )}
                                         {host.lastMetric.processes && host.lastMetric.processes.length > 0 && (() => {
                                             const processGroups = {};
                                             host.lastMetric.processes.forEach(p => {
                                                 const name = p.name;
                                                 if (!processGroups[name]) {
                                                     processGroups[name] = {
                                                         name,
                                                         status: 'stopped',
                                                         cpuUsageSum: 0,
                                                         memoryMBSum: 0,
                                                         instances: []
                                                     };
                                                 }
                                                 const isRunning = p.status?.toLowerCase() === 'running' || p.status === true;
                                                 if (isRunning) {
                                                     processGroups[name].status = 'running';
                                                     processGroups[name].cpuUsageSum += p.cpuUsage || 0;
                                                     processGroups[name].memoryMBSum += p.memoryMB || 0;
                                                     processGroups[name].instances.push(p);
                                                 }
                                             });

                                             return (
                                                 <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                                                     <div style={{ padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase' }}>Monitored Processes (CPU & Memory)</div>
                                                     <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                                                         <thead>
                                                             <tr>
                                                                 <th style={{ ...S.th, width: '40%' }}>Process Name</th>
                                                                 <th style={S.th}>Status</th>
                                                                 <th style={S.th}>CPU Usage</th>
                                                                 <th style={S.th}>Memory (RSS)</th>
                                                             </tr>
                                                         </thead>
                                                         <tbody>
                                                             {Object.values(processGroups).map(g => {
                                                                 const isRunning = g.status === 'running';
                                                                 const isExpanded = !!expandedProcesses[g.name];
                                                                 const hasMultiple = g.instances.length > 1;

                                                                 return (
                                                                     <React.Fragment key={g.name}>
                                                                         <tr 
                                                                             style={{ cursor: hasMultiple ? 'pointer' : 'default', background: isExpanded ? 'rgba(255,255,255,0.02)' : 'transparent', borderBottom: '1px solid var(--border-color)' }}
                                                                             onClick={() => hasMultiple && setExpandedProcesses(prev => ({ ...prev, [g.name]: !prev[g.name] }))}
                                                                         >
                                                                             <td style={{ ...S.td, fontWeight: 700 }}>
                                                                                 {hasMultiple ? (isExpanded ? '▼ ' : '▶ ') : ''}
                                                                                 {g.name} 
                                                                                 {hasMultiple && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginLeft: 8 }}>({g.instances.length} instances)</span>}
                                                                             </td>
                                                                             <td style={S.td}>
                                                                                 <span style={{ ...S.badge, background: isRunning ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isRunning ? '#10b981' : '#ef4444', border: `1px solid ${isRunning ? '#10b98144' : '#ef444444'}` }}>
                                                                                     {isRunning ? 'RUNNING' : 'STOPPED'}
                                                                                 </span>
                                                                             </td>
                                                                             <td style={S.td}>
                                                                                 {isRunning ? (
                                                                                     <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                                                         <span style={{ width: 45, fontWeight: 700 }}>{g.cpuUsageSum.toFixed(1)}%</span>
                                                                                         <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden', maxWidth: 100 }}>
                                                                                             <div style={{ height: '100%', width: `${Math.min(100, g.cpuUsageSum)}%`, background: g.cpuUsageSum > 80 ? '#ef4444' : '#3b82f6', borderRadius: 3 }}></div>
                                                                                         </div>
                                                                                     </div>
                                                                                 ) : '-'}
                                                                             </td>
                                                                             <td style={{ ...S.td, fontWeight: 600 }}>
                                                                                 {isRunning ? `${g.memoryMBSum.toFixed(1)} MB` : '-'}
                                                                             </td>
                                                                         </tr>
                                                                         {isExpanded && g.instances.map((ins, idx) => (
                                                                             <tr key={`${g.name}-pid-${ins.pid}-${idx}`} style={{ background: 'rgba(0,0,0,0.15)', borderBottom: '1px solid var(--border-color)' }}>
                                                                                 <td style={{ ...S.td, paddingLeft: 40, color: 'var(--text-muted)', fontSize: 13 }}>
                                                                                     ↳ PID: {ins.pid}
                                                                                 </td>
                                                                                 <td style={S.td}>
                                                                                     <span style={{ ...S.badge, background: 'rgba(16, 185, 129, 0.05)', color: 'var(--text-muted)', border: '1px solid rgba(16,185,129,0.15)', fontSize: 11 }}>
                                                                                         RUNNING
                                                                                     </span>
                                                                                 </td>
                                                                                 <td style={{ ...S.td, fontSize: 13 }}>
                                                                                     {ins.cpuUsage?.toFixed(1)}%
                                                                                 </td>
                                                                                 <td style={{ ...S.td, fontSize: 13 }}>
                                                                                     {ins.memoryMB?.toFixed(1)} MB
                                                                                 </td>
                                                                             </tr>
                                                                         ))}
                                                                     </React.Fragment>
                                                                 );
                                                             })}
                                                         </tbody>
                                                     </table>
                                                 </div>
                                             );
                                         })()}
                                     </div>
                                )}
                            </>
                        )}
                    </div>
                )}
                
                {/* Tab: History */}
                {activeTab === 'history' && (() => {
                    const currentWatch = Array.isArray(host.watchProcesses) 
                        ? host.watchProcesses.map(n => n.toLowerCase()) 
                        : (host.watchProcesses || '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);

                    const uniqueProcessNames = [];
                    const everRunning = new Set();
                    rawHistory.forEach(h => {
                        if (h.metrics && Array.isArray(h.metrics.processes)) {
                            h.metrics.processes.forEach(p => {
                                if (p.name) {
                                    const isRunning = p.status?.toLowerCase() === 'running' || p.status === true;
                                    if (isRunning) {
                                        everRunning.add(p.name.toLowerCase());
                                    }
                                    if (!uniqueProcessNames.some(existing => existing.toLowerCase() === p.name.toLowerCase())) {
                                        uniqueProcessNames.push(p.name);
                                    }
                                }
                            });
                        }
                    });

                    const filteredProcessNames = uniqueProcessNames.filter(pName => {
                        const lower = pName.toLowerCase();
                        return currentWatch.includes(lower) || everRunning.has(lower);
                    });

                    const isProcessTarget = selectedChartTarget.startsWith('process:');
                    const targetProcessName = isProcessTarget ? selectedChartTarget.substring(8) : '';

                    const chartData = rawHistory.map(d => {
                        const timeStr = new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        if (selectedChartTarget === 'host') {
                            return {
                                time: timeStr,
                                cpu: d.metrics.cpu?.used ? Number(d.metrics.cpu.used.toFixed(2)) : 0,
                                memory: d.metrics.memory?.used ? Number(d.metrics.memory.used.toFixed(2)) : 0,
                            };
                        } else if (selectedChartTarget === 'connections') {
                            return {
                                time: timeStr,
                                cpu: d.metrics.connections?.established ? Number(d.metrics.connections.established) : 0,
                                memory: d.metrics.connections?.total ? Number(d.metrics.connections.total) : 0,
                            };
                        } else if (selectedChartTarget === 'network') {
                            return {
                                time: timeStr,
                                cpu: d.metrics.network?.rxSpeedKbps ? Number(d.metrics.network.rxSpeedKbps.toFixed(2)) : 0,
                                memory: d.metrics.network?.txSpeedKbps ? Number(d.metrics.network.txSpeedKbps.toFixed(2)) : 0,
                            };
                        } else {
                            let cpuSum = 0;
                            let memSum = 0;
                            if (d.metrics && Array.isArray(d.metrics.processes)) {
                                d.metrics.processes.forEach(p => {
                                    if (p.name === targetProcessName && (p.status?.toLowerCase() === 'running' || p.status === true)) {
                                        cpuSum += p.cpuUsage || 0;
                                        memSum += p.memoryMB || 0;
                                    }
                                });
                            }
                            return {
                                time: timeStr,
                                cpu: Number(cpuSum.toFixed(2)),
                                memory: Number(memSum.toFixed(2))
                            };
                        }
                    });

                    return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 400, width: '100%' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Select Metric View:</span>
                                    <select 
                                        value={selectedChartTarget} 
                                        onChange={(e) => setSelectedChartTarget(e.target.value)}
                                        style={{ padding: '8px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', outline: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                                    >
                                        <option value="host">🖥️ Host System Resources (CPU % / RAM %)</option>
                                        <option value="connections">🔌 Network Connections (Established / Total)</option>
                                        <option value="network">📈 Network Speed (Rx / Tx KB/s)</option>
                                        {filteredProcessNames.map(pName => (
                                            <option key={pName} value={`process:${pName}`}>⚙️ Process: {pName} (CPU % / RSS MB)</option>
                                        ))}
                                    </select>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Time Range:</span>
                                    <select 
                                        value={historyRange} 
                                        onChange={(e) => handleRangeChange(e.target.value)}
                                        style={{ padding: '8px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', outline: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                                    >
                                        <option value="1">1 Hour</option>
                                        <option value="3">3 Hours</option>
                                        <option value="6">6 Hours</option>
                                        <option value="12">12 Hours</option>
                                        <option value="24">1 Day</option>
                                        <option value="48">2 Days</option>
                                        <option value="168">7 Days</option>
                                        <option value="all">All</option>
                                    </select>
                                </div>
                            </div>
                            {rawHistory.length === 0 ? (
                                <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)' }}>No historical data available</div>
                            ) : (
                                <div style={{ flex: 1, width: '100%', minHeight: 320 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                                            <defs>
                                                <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                                </linearGradient>
                                                <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8}/>
                                                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                                                </linearGradient>
                                            </defs>
                                            <XAxis dataKey="time" stroke="var(--border-color)" tick={{fill: 'var(--text-muted)', fontSize: 12}} minTickGap={30} />
                                            <YAxis stroke="var(--border-color)" tick={{fill: 'var(--text-muted)', fontSize: 12}} domain={['host'].includes(selectedChartTarget) ? [0, 100] : ['auto', 'auto']} />
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                            {selectedChartTarget === 'host' && (
                                                <>
                                                    <ReferenceLine y={80} stroke="#f59e0b" strokeDasharray="3 3" />
                                                    <ReferenceLine y={95} stroke="#ef4444" strokeDasharray="3 3" />
                                                </>
                                            )}
                                            <RechartsTooltip contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} itemStyle={{ fontWeight: 800 }} />
                                            <Area type="monotone" dataKey="cpu" name={
                                                selectedChartTarget === 'host' ? "CPU (%)" :
                                                selectedChartTarget === 'connections' ? "Established Connections" :
                                                selectedChartTarget === 'network' ? "Receive Speed (KB/s)" :
                                                "Process CPU (Sum %)"
                                            } stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorCpu)" />
                                            <Area type="monotone" dataKey="memory" name={
                                                selectedChartTarget === 'host' ? "Memory (%)" :
                                                selectedChartTarget === 'connections' ? "Total Connections" :
                                                selectedChartTarget === 'network' ? "Transmit Speed (KB/s)" :
                                                "Process Memory (Sum MB)"
                                            } stroke="#8b5cf6" strokeWidth={3} fillOpacity={1} fill="url(#colorMem)" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            )}
                        </div>
                    );
                })()}
                
                {/* Tab: Rules */}
                {activeTab === 'rules' && (
                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                        {(() => {
                            const excludedFrom = excludedRulesForMonitor(host, exclusions, rules);
                            if (excludedFrom.length === 0) return null;
                            return (
                                <div style={{ padding: '12px 24px', fontSize: 13, borderBottom: '1px solid var(--border-color)', background: 'rgba(239, 68, 68, 0.06)' }}>
                                    <strong style={{ color: '#ef4444' }}>🚫 Excluded from:</strong> {excludedFrom.map(r => r.name).join(', ')}
                                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> (these rules never alert on this host)</span>
                                </div>
                            );
                        })()}
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Rule Template</th>
                                    <th style={S.th}>Type</th>
                                    <th style={S.th}>Condition</th>
                                    <th style={S.th}>Assigned Via</th>
                                </tr>
                            </thead>
                            <tbody>
                                {bindings.filter(b => 
                                    (b.scopeType === 'monitor' && b.scopeValue === host.id) ||
                                    (b.scopeType === 'apikey' && b.scopeValue === host.apiKey) ||
                                    (b.scopeType === 'tag' && (Array.isArray(host.tags) ? host.tags : (host.tags || '').split(',').map(x => x.trim())).includes(b.scopeValue)) ||
                                    (b.scopeType === 'env' && b.scopeValue === host.envId)
                                ).map(b => {
                                    const r = rules.find(x => x.id === b.ruleId);
                                    if (!r) return null;
                                    const excluded = isExcludedFor(r.id, host, exclusions);
                                    return (
                                        <tr key={b.id} style={excluded ? { opacity: 0.55 } : undefined}>
                                            <td style={{...S.td, fontWeight: 700}}>
                                                {excluded ? <s>{r.name}</s> : r.name}
                                                {excluded && <span style={{...S.badge, marginLeft: 8, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontSize: 10}}>EXCLUDED</span>}
                                            </td>
                                            <td style={{...S.td, textTransform: 'uppercase'}}>{r.type}</td>
                                            <td style={S.td}>
                                                {r.type === 'process' ? (
                                                    <span>
                                                        {r.target} (Offline
                                                        {r.cpuThreshold ? `, CPU > ${r.cpuThreshold}%` : ''}
                                                        {r.memThreshold ? `, Mem > ${r.memThreshold}MB` : ''})
                                                    </span>
                                                ) : (
                                                    <span>{r.target} {r.target ? '>' : ''} {r.threshold}</span>
                                                )}
                                                {` (Hits: ${r.alertHits})`}
                                            </td>
                                            <td style={S.td}>
                                                <span style={{...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-muted)'}}>
                                                    {b.scopeType === 'monitor' ? 'Direct' : b.scopeType === 'apikey' ? `API Key` : b.scopeType === 'env' ? `Environment` : `Tag: ${b.scopeValue}`}
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {bindings.filter(b => 
                                    (b.scopeType === 'monitor' && b.scopeValue === host.id) ||
                                    (b.scopeType === 'apikey' && b.scopeValue === host.apiKey) ||
                                    (b.scopeType === 'tag' && (Array.isArray(host.tags) ? host.tags : (host.tags || '').split(',').map(x => x.trim())).includes(b.scopeValue)) ||
                                    (b.scopeType === 'env' && b.scopeValue === host.envId)
                                ).length === 0 && <tr><td colSpan="4" style={{...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)'}}>No alert rules are currently assigned to this host.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                )}

                {activeTab === 'alerts' && (
                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Status</th>
                                    <th style={S.th}>Triggered At</th>
                                    <th style={S.th}>Type</th>
                                    <th style={S.th}>Details</th>
                                </tr>
                            </thead>
                            <tbody>
                                {alerts.filter(a => a.monitorId === host.id).map((a, i, arr) => (
                                    <tr key={a.id} style={{ borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                                        <td style={S.td}>
                                            <span style={{...S.badge, background: a.resolved ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: a.resolved ? '#10b981' : '#ef4444'}}>
                                                {a.resolved ? 'Resolved' : 'Active'}
                                            </span>
                                        </td>
                                        <td style={{...S.td, color: 'var(--text-muted)'}}>{new Date(a.triggeredAt).toLocaleString()}</td>
                                        <td style={{...S.td, textTransform: 'uppercase', fontWeight: 700}}>{a.type}</td>
                                        <td style={S.td}>{a.target} {a.value} &gt; {a.threshold}</td>
                                    </tr>
                                ))}
                                {alerts.filter(a => a.monitorId === host.id).length === 0 && <tr><td colSpan="4" style={{...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)'}}>No alerts have been recorded for this host.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Tab: Integration (Asset) */}
                {activeTab === 'integration' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        {integrationData.loading ? (
                            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)' }}>Loading asset data...</div>
                        ) : (
                            <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', maxWidth: 600 }}>
                                <div style={{ padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 16 }}></span> Asset Details
                                </div>
                                <div style={{ padding: 20 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>OS Edition</span>
                                            <span style={{ fontWeight: 700 }}>{integrationData.inventory?.osname || integrationData.inventory?.os || '-'}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Domain</span>
                                            <span style={{ fontWeight: 700 }}>{integrationData.inventory?.domain || 'Workgroup'}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Owner (BU)</span>
                                            <span style={{ fontWeight: 700 }}>{integrationData.cmdbMeta?.businessUnit || integrationData.ipam?.owner || integrationData.ipam?.assignedTo || '-'}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Service / Application</span>
                                            <span style={{ fontWeight: 700 }}>{integrationData.cmdbMeta?.applicationName || integrationData.ipam?.service || '-'}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Storage Disk (GB)</span>
                                            <span style={{ fontWeight: 700 }}>{host.diskGB ? `${host.diskGB} GB` : (integrationData.cmdbMeta?.diskGB ? `${integrationData.cmdbMeta.diskGB} GB` : '-')}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Mac Address</span>
                                            <span style={{ fontWeight: 700 }}>{integrationData.inventory?.mac || '-'}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
            
            {/* Modal Footer */}
            <div style={{...S.modalFoot, background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)', padding: '16px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
              <div>
                {isWindows && (
                    <button
                        disabled={!hasGuacamole}
                        style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemote}
                        onClick={() => hasGuacamole && setIsRemoteOpen('rdp')}
                        title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點" : `開啟 ${host.name} Web RDP`}
                    >
                        🖥️ Web RDP (Port 3389)
                    </button>
                )}
                {isLinux && (
                    <button
                        disabled={!hasGuacamole}
                        style={!hasGuacamole ? S.btnRemoteDisabled : S.btnRemoteSsh}
                        onClick={() => hasGuacamole && setIsRemoteOpen('ssh')}
                        title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點" : `開啟 ${host.name} Web SSH`}
                    >
                        ⚡ Web SSH (Port 22)
                    </button>
                )}
              </div>
              <button style={{...S.btnP, padding: '10px 24px'}} onClick={() => onClose()}>Close Detail View</button>
            </div>
          </div>
        </div>
      )}

      {/* Guacamole Web Remote Modal */}
      <WebRemoteModal
        isOpen={!!isRemoteOpen}
        onClose={() => setIsRemoteOpen(false)}
        target={host ? {
          ip: host.ip,
          name: host.name,
          os: isRemoteOpen === 'rdp' ? 'windows' : (isRemoteOpen === 'ssh' ? 'linux' : (isWindows ? 'windows' : 'linux')),
          protocol: isRemoteOpen === 'rdp' ? 'rdp' : (isRemoteOpen === 'ssh' ? 'ssh' : (isWindows ? 'rdp' : 'ssh'))
        } : null}
      />

        </React.Fragment>
    );
}
