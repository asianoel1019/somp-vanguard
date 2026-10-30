import React, { useState, useEffect } from 'react';
import api from '../../api';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    select: { padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-glass)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 24 },
    card: (hasAlert) => ({ background: 'var(--bg-glass)', border: hasAlert ? '1px solid #ef4444' : '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: hasAlert ? '0 0 20px rgba(239, 68, 68, 0.3)' : '0 10px 30px rgba(0,0,0,0.2)', backdropFilter: 'blur(12px)', transition: 'all 0.3s ease-in-out' }),
    cardH: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
    dbName: { fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)' },
    dbEnv: { padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' },
    metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 },
    gaugeContainer: { display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' },
    gaugeCircle: { position: 'relative', width: 60, height: 60, borderRadius: '50%', background: 'var(--bg-primary)', border: '4px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 4px 8px rgba(0,0,0,0.3)' },
    gaugeFill: (pct, color) => ({ position: 'absolute', inset: -4, borderRadius: '50%', background: `conic-gradient(${color} ${pct}%, transparent ${pct}%)`, WebkitMask: 'radial-gradient(transparent 55%, black 56%)', mask: 'radial-gradient(transparent 55%, black 56%)', transition: 'all 0.8s ease-out' }),
    gaugeValue: { fontSize: 13, fontWeight: 800, zIndex: 2 },
    gaugeLabel: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, marginTop: 8, letterSpacing: '0.05em' },
    statsBox: { background: 'rgba(0,0,0,0.2)', borderRadius: 12, padding: 16, display: 'flex', justifyContent: 'space-between', marginBottom: 16 },
    statItem: { display: 'flex', flexDirection: 'column' },
    statValue: { fontSize: 18, fontWeight: 900, color: 'var(--accent-primary)', textShadow: '0 0 10px var(--accent-glow)' },
    statLabel: { fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700, marginTop: 4, letterSpacing: '0.05em' },
    pulsePoint: (isAlert) => ({ width: 8, height: 8, borderRadius: '50%', background: isAlert ? '#ef4444' : '#10b981', boxShadow: isAlert ? '0 0 10px #ef4444' : '0 0 10px #10b981', display: 'inline-block', marginRight: 6 }),
    alertIndicator: { position: 'absolute', top: -4, right: 12, width: 8, height: 8, borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 8px #ef4444' },
    sparklineBox: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, fontSize: 11 },
    sparklineRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
};

const DbPerformance = () => {
    const [databases, setDatabases] = useState([]);
    const [metricsMap, setMetricsMap] = useState({});
    
    // History state: { [dbId]: { cpu: [], memory: [] } }
    const [historyMap, setHistoryMap] = useState({});

    // refresh interval state in seconds: 5, 10, 30, or 0 (paused)
    const [refreshInterval, setRefreshInterval] = useState(5);

    // Active Process & Kill Query state
    const [selectedDbForProcesses, setSelectedDbForProcesses] = useState('');
    const [processes, setProcesses] = useState([]);
    const [loadingProcesses, setLoadingProcesses] = useState(false);
    const [processToKill, setProcessToKill] = useState(null);
    const [killing, setKilling] = useState(false);
    const [killResult, setKillResult] = useState(null);

    // Database Health & Storage state
    const [healthMap, setHealthMap] = useState({});
    const [selectedDbHealth, setSelectedDbHealth] = useState(null);
    const [vacuuming, setVacuuming] = useState(false);
    const [vacuumResult, setVacuumResult] = useState('');

    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isSuperAdmin = user.role === 'SuperAdmin';

    // Fetch DB list once
    useEffect(() => {
        api.get('/database/inventory')
            .then(res => {
                const list = res.data.databases || [];
                setDatabases(list);
                if (list.length > 0) {
                    setSelectedDbForProcesses(list[0].id);
                }
            })
            .catch(e => console.error("Failed to load inventory:", e));
    }, []);

    const fetchProcesses = async (dbId) => {
        if (!dbId) return;
        setLoadingProcesses(true);
        try {
            const res = await api.get(`/database/processes/${dbId}`);
            setProcesses(res.data.processes || []);
        } catch (e) {
            console.error('Failed to load processes:', e);
            setProcesses([]);
        } finally {
            setLoadingProcesses(false);
        }
    };

    const fetchHealth = async (dbId) => {
        if (!dbId) return;
        try {
            const res = await api.get(`/database/health/${dbId}`);
            setSelectedDbHealth({ dbId, ...res.data.health });
        } catch (e) {
            console.error('Failed to load health:', e);
        }
    };

    const handleExecuteVacuum = async (dbId) => {
        setVacuuming(true);
        setVacuumResult('');
        try {
            const res = await api.post('/database/vacuum', { id: dbId });
            setVacuumResult(res.data.message || 'VACUUM 執行成功！');
            fetchHealth(dbId);
        } catch (e) {
            setVacuumResult(`❌ 執行失敗: ${e.response?.data?.error || e.message}`);
        } finally {
            setVacuuming(false);
        }
    };

    const handleConfirmKill = async () => {
        if (!processToKill) return;
        setKilling(true);
        setKillResult(null);
        try {
            const res = await api.post('/database/kill-process', {
                dbId: selectedDbForProcesses,
                processId: processToKill.id
            });
            setKillResult({ success: true, message: res.data.message });
            fetchProcesses(selectedDbForProcesses);
        } catch (e) {
            setKillResult({ success: false, message: e.response?.data?.error || e.message });
        } finally {
            setKilling(false);
            setProcessToKill(null);
        }
    };

    useEffect(() => {
        if (selectedDbForProcesses) {
            fetchProcesses(selectedDbForProcesses);
        }
    }, [selectedDbForProcesses]);

    // Poll metrics based on dynamic interval selection
    useEffect(() => {
        if (databases.length === 0 || refreshInterval === 0) return;

        const fetchMetrics = async () => {
            const results = await Promise.allSettled(
                databases.map(db => api.get(`/database/metrics/${db.id}`))
            );

            setMetricsMap(prev => {
                const updated = { ...prev };
                results.forEach((res, index) => {
                    const db = databases[index];
                    if (res.status === 'fulfilled' && res.value.data.success) {
                        const m = res.value.data.metrics;
                        updated[db.id] = m;

                        // Update trends history (store up to last 10 points)
                        setHistoryMap(prevHistory => {
                            const dbHistory = prevHistory[db.id] || { cpu: [], memory: [] };
                            const cpuHist = [...dbHistory.cpu, m.cpuUsage].slice(-10);
                            const memHist = [...dbHistory.memory, m.memoryUsage].slice(-10);
                            return {
                                ...prevHistory,
                                [db.id]: { cpu: cpuHist, memory: memHist }
                            };
                        });
                    }
                });
                return updated;
            });
        };

        fetchMetrics();
        const interval = setInterval(fetchMetrics, refreshInterval * 1000);
        return () => clearInterval(interval);
    }, [databases, refreshInterval]);

    const getColor = (usage) => {
        if (usage >= 80) return '#ef4444'; // Danger
        if (usage >= 60) return '#f59e0b'; // Warning
        return '#10b981'; // Success
    };

    // Helper to render inline SVG mini sparklines
    const renderSparkline = (dataPoints) => {
        if (!dataPoints || dataPoints.length < 2) return null;
        const width = 120;
        const height = 16;
        const maxVal = 100;
        const points = dataPoints.map((val, index) => {
            const x = (index / (dataPoints.length - 1)) * width;
            const y = height - (val / maxVal) * height;
            return `${x},${y}`;
        }).join(' ');

        return (
            <svg width={width} height={height} style={{ overflow: 'visible' }}>
                <polyline
                    fill="none"
                    stroke="var(--accent-primary)"
                    strokeWidth="1.5"
                    points={points}
                />
                <circle
                    cx={width}
                    cy={height - (dataPoints[dataPoints.length - 1] / maxVal) * height}
                    r="2.5"
                    fill="var(--accent-primary)"
                    className="animate-pulse"
                />
            </svg>
        );
    };

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Performance Dashboard</h1>
                    <p style={S.subtitle}>Real-time telemetry and resource utilization across DB clusters</p>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>REFRESH RATE:</span>
                    <select 
                        style={S.select} 
                        value={refreshInterval} 
                        onChange={e => setRefreshInterval(parseInt(e.target.value, 10))}
                    >
                        <option value="5">5s Refresh</option>
                        <option value="10">10s Refresh</option>
                        <option value="30">30s Refresh</option>
                        <option value="0">⏸ Paused</option>
                    </select>
                </div>
            </div>

            <div style={S.grid}>
                {databases.map(db => {
                    const metrics = metricsMap[db.id] || { cpuUsage: 0, memoryUsage: 0, storageUsage: 0, activeConnections: 0, qps: 0, latencyMs: 0 };
                    const hasAlert = metrics.cpuUsage >= 80 || metrics.memoryUsage >= 80;
                    const dbHistory = historyMap[db.id] || { cpu: [], memory: [] };

                    return (
                        <div key={db.id} style={S.card(hasAlert)}>
                            <div style={S.cardH}>
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center' }}>
                                        <span style={S.pulsePoint(hasAlert)} className="animate-pulse"></span>
                                        <h3 style={S.dbName}>{db.name}</h3>
                                    </div>
                                    <div style={{ marginTop: 6 }}>
                                        <span style={S.dbEnv}>{db.engine}</span>
                                    </div>
                                </div>
                                <span style={S.dbEnv}>{db.environment}</span>
                            </div>

                            <div style={S.metricsGrid}>
                                <div style={S.gaugeContainer}>
                                    {metrics.cpuUsage >= 80 && <span style={S.alertIndicator} className="animate-ping" />}
                                    <div style={S.gaugeCircle}>
                                        <div style={S.gaugeFill(metrics.cpuUsage, getColor(metrics.cpuUsage))}></div>
                                        <span style={S.gaugeValue}>{metrics.cpuUsage}%</span>
                                    </div>
                                    <span style={S.gaugeLabel}>CPU</span>
                                </div>
                                <div style={S.gaugeContainer}>
                                    {metrics.memoryUsage >= 80 && <span style={S.alertIndicator} className="animate-ping" />}
                                    <div style={S.gaugeCircle}>
                                        <div style={S.gaugeFill(metrics.memoryUsage, getColor(metrics.memoryUsage))}></div>
                                        <span style={S.gaugeValue}>{metrics.memoryUsage}%</span>
                                    </div>
                                    <span style={S.gaugeLabel}>MEMORY</span>
                                </div>
                                <div style={S.gaugeContainer}>
                                    <div style={S.gaugeCircle}>
                                        <div style={S.gaugeFill(metrics.storageUsage, getColor(metrics.storageUsage))}></div>
                                        <span style={S.gaugeValue}>{metrics.storageUsage}%</span>
                                    </div>
                                    <span style={S.gaugeLabel}>STORAGE</span>
                                </div>
                            </div>

                            <div style={S.statsBox}>
                                <div style={S.statItem}>
                                    <span style={S.statValue}>{metrics.activeConnections}</span>
                                    <span style={S.statLabel}>CONNECTIONS</span>
                                </div>
                                <div style={S.statItem}>
                                    <span style={S.statValue}>{metrics.qps}</span>
                                    <span style={S.statLabel}>QPS</span>
                                </div>
                                <div style={{ ...S.statItem, alignItems: 'flex-end' }}>
                                    <span style={{ ...S.statValue, color: 'var(--text-primary)', textShadow: 'none' }}>{metrics.latencyMs}ms</span>
                                    <span style={S.statLabel}>LATENCY</span>
                                </div>
                            </div>

                            {/* Sparklines History Drawer */}
                            <div style={S.sparklineBox}>
                                <div style={S.sparklineRow}>
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>CPU Trend</span>
                                    {dbHistory.cpu.length > 1 ? renderSparkline(dbHistory.cpu) : <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Calculating...</span>}
                                </div>
                                <div style={S.sparklineRow}>
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Mem Trend</span>
                                    {dbHistory.memory.length > 1 ? renderSparkline(dbHistory.memory) : <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Calculating...</span>}
                                </div>
                            </div>

                            {/* Card Footer Actions */}
                            <div style={{ display: 'flex', gap: 8, marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10 }}>
                                <button 
                                    style={{ flex: 1, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}
                                    onClick={() => fetchHealth(db.id)}
                                >
                                    🏥 Health & Storage
                                </button>
                                {db.engine === 'SQLite' && isSuperAdmin && (
                                    <button 
                                        style={{ padding: '6px 12px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 6, fontSize: 11, color: '#60a5fa', cursor: 'pointer', fontWeight: 700 }}
                                        onClick={() => handleExecuteVacuum(db.id)}
                                        disabled={vacuuming}
                                    >
                                        {vacuuming ? '⏳' : '🧹 VACUUM'}
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
                {databases.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', padding: 20 }}>No databases configured. Add one in the DB Connection Hub.</div>
                )}
            </div>

            {/* Health & Storage Details Drawer (if selected) */}
            {selectedDbHealth && (
                <div style={{ marginTop: 24, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 20 }}>🏥</span>
                            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>
                                Database Health & Storage Allocation — {databases.find(d => d.id === selectedDbHealth.dbId)?.name}
                            </h3>
                        </div>
                        <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }} onClick={() => setSelectedDbHealth(null)}>✕</button>
                    </div>

                    {vacuumResult && (
                        <div style={{ padding: '10px 14px', background: 'rgba(52,199,89,0.1)', border: '1px solid rgba(52,199,89,0.3)', borderRadius: 8, color: '#34c759', marginBottom: 16, fontSize: 12 }}>
                            {vacuumResult}
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
                        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>TOTAL STORAGE USAGE</div>
                            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--accent-primary)', marginTop: 4 }}>
                                {selectedDbHealth.storage?.totalKb || selectedDbHealth.storage?.totalBytes ? `${selectedDbHealth.storage.totalKb} KB` : 'N/A'}
                            </div>
                        </div>
                        {selectedDbHealth.storage?.walKb && (
                            <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>WAL BUFFER FILE</div>
                                <div style={{ fontSize: 18, fontWeight: 900, color: '#f59e0b', marginTop: 4 }}>
                                    {selectedDbHealth.storage.walKb} KB
                                </div>
                            </div>
                        )}
                        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>ENGINE STATUS</div>
                            <div style={{ fontSize: 18, fontWeight: 900, color: '#10b981', marginTop: 4 }}>
                                {selectedDbHealth.status || 'HEALTHY'}
                            </div>
                        </div>
                    </div>

                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8 }}>
                        📊 TOP 10 LARGEST TABLES BY STORAGE ALLOCATION:
                    </div>
                    <div style={{ overflowX: 'auto', background: 'rgba(0,0,0,0.15)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', textAlign: 'left' }}>
                                    <th style={{ padding: '8px 12px' }}>TABLE NAME</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'right' }}>SIZE (KB)</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'right' }}>ROWS (EST)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(selectedDbHealth.topTables || []).map((t, idx) => (
                                    <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)' }}>📁 {t.tableName}</td>
                                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--accent-primary)', fontWeight: 700 }}>{t.sizeKb}</td>
                                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-secondary)' }}>{t.rowEstimate || '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Active Sessions & Kill Query Section */}
            <div style={{ marginTop: 28, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <h2 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>⚡ Active Processes & Slow Queries</h2>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                            Inspect currently running transactions, locks, and live client threads with emergency termination capability
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <select 
                            style={S.select} 
                            value={selectedDbForProcesses} 
                            onChange={e => setSelectedDbForProcesses(e.target.value)}
                        >
                            {databases.map(db => (
                                <option key={db.id} value={db.id}>[{db.engine}] {db.name}</option>
                            ))}
                        </select>
                        <button 
                            style={{ ...S.select, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}
                            onClick={() => fetchProcesses(selectedDbForProcesses)}
                            disabled={loadingProcesses}
                        >
                            {loadingProcesses ? '⏳' : '🔄 Refresh'}
                        </button>
                    </div>
                </div>

                {killResult && (
                    <div style={{ padding: '10px 14px', background: killResult.success ? 'rgba(52,199,89,0.1)' : 'rgba(239,68,68,0.1)', border: killResult.success ? '1px solid rgba(52,199,89,0.3)' : '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: killResult.success ? '#34c759' : '#ef4444', marginBottom: 16, fontSize: 12 }}>
                        {killResult.message}
                    </div>
                )}

                <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', textAlign: 'left', background: 'rgba(0,0,0,0.2)' }}>
                                <th style={{ padding: '10px 14px' }}>PID / ID</th>
                                <th style={{ padding: '10px 14px' }}>USER</th>
                                <th style={{ padding: '10px 14px' }}>HOST</th>
                                <th style={{ padding: '10px 14px' }}>STATE / CMD</th>
                                <th style={{ padding: '10px 14px' }}>TIME (S)</th>
                                <th style={{ padding: '10px 14px' }}>QUERY / INFO</th>
                                <th style={{ padding: '10px 14px', textAlign: 'right' }}>ACTION</th>
                            </tr>
                        </thead>
                        <tbody>
                            {processes.map((p, idx) => {
                                const isLongRunning = p.time > 10;
                                return (
                                    <tr key={p.id || idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isLongRunning ? 'rgba(239,68,68,0.06)' : 'transparent' }}>
                                        <td style={{ padding: '10px 14px', fontWeight: 800 }}>{p.id}</td>
                                        <td style={{ padding: '10px 14px', color: 'var(--accent-primary)' }}>{p.user}</td>
                                        <td style={{ padding: '10px 14px', color: 'var(--text-secondary)' }}>{p.host}</td>
                                        <td style={{ padding: '10px 14px' }}>
                                            <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', fontSize: 10 }}>{p.state || p.command}</span>
                                        </td>
                                        <td style={{ padding: '10px 14px', color: isLongRunning ? '#ef4444' : 'var(--text-secondary)', fontWeight: isLongRunning ? 800 : 400 }}>
                                            {p.time}s
                                        </td>
                                        <td style={{ padding: '10px 14px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.info}>
                                            {p.info || <span style={{ color: 'var(--text-muted)' }}>-</span>}
                                        </td>
                                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                                            {isSuperAdmin ? (
                                                <button
                                                    style={{ padding: '4px 10px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 6, color: '#ef4444', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}
                                                    onClick={() => setProcessToKill(p)}
                                                >
                                                    🚨 Kill
                                                </button>
                                            ) : (
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Viewer Only</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {processes.length === 0 && !loadingProcesses && (
                                <tr>
                                    <td colSpan="7" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                                        No active queries running on this database.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Custom Confirm Kill Modal (No browser confirm box) */}
            {processToKill && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    <div style={{ background: '#0f172a', border: '1px solid #ef4444', borderRadius: 16, width: '100%', maxWidth: 460, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.6)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                            <span style={{ fontSize: 28 }}>⚠️</span>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: '#ef4444' }}>確認終止資料庫進程 (Kill Query)</h3>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PID: {processToKill.id} | User: {processToKill.user}</span>
                            </div>
                        </div>
                        <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: 20 }}>
                            您即將強制終止此執行緒。若該查詢正在進行大筆交易寫入，可能會觸發 Rollback 操作。此動作將被記入系統 Audit Log。確定要執行嗎？
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                            <button 
                                style={{ ...S.select, background: 'transparent', color: 'var(--text-secondary)' }}
                                onClick={() => setProcessToKill(null)}
                                disabled={killing}
                            >
                                取消
                            </button>
                            <button 
                                style={{ ...S.select, background: '#ef4444', border: 'none', color: '#fff', fontWeight: 800 }}
                                onClick={handleConfirmKill}
                                disabled={killing}
                            >
                                {killing ? '終止中...' : '確定強制擊殺 (Kill)'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DbPerformance;

