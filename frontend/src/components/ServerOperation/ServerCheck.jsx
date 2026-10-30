import React, { useState, useEffect, useRef } from 'react';
import { useSync } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';
import api from '../../api';
import HostDetailModal from '../Shared/HostDetailModal';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 500, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    textarea: { width: '100%', borderRadius: 12, padding: 16, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'monospace', marginTop: 6, boxSizing: 'border-box' }
};

const ServerCheck = ({ linuxPassword, setLinuxPassword, linuxAdminUser }) => {
    const { lastEvent } = useSync();
    const { showToast } = useToast();
    const offlineQueueRef = useRef([]);
    const offlineTimerRef = useRef(null);

    useEffect(() => {
        if (!lastEvent) return;

        if (lastEvent.type === 'SERVER_OFFLINE_ALERT' || lastEvent.type === 'PROCESS_OFFLINE_ALERT') {
            offlineQueueRef.current.push(lastEvent);

            if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);

            offlineTimerRef.current = setTimeout(() => {
                const queue = offlineQueueRef.current;
                if (queue.length === 0) return;

                const serverOffline = queue.filter(e => e.type === 'SERVER_OFFLINE_ALERT');
                const procOffline = queue.filter(e => e.type === 'PROCESS_OFFLINE_ALERT');

                if (serverOffline.length > 5) {
                    showToast(`Multiple Servers Offline (${serverOffline.length} servers)`, 'error');
                } else {
                    serverOffline.forEach(e => showToast(`Server Offline Alert: ${e.payload?.ip || 'Unknown'}`, 'error'));
                }

                if (procOffline.length > 5) {
                    showToast(`Multiple Processes Offline (${procOffline.length} processes)`, 'error');
                } else {
                    procOffline.forEach(e => showToast(`Process Offline Alert: ${e.payload?.ip || 'Unknown'}`, 'error'));
                }

                performBackgroundCheck();
                offlineQueueRef.current = [];
            }, 500);
        }
    }, [lastEvent]);

    const [activeTab, setActiveTab] = useState('diagnostic'); // 'dashboard' | 'diagnostic'

    // One-off Diagnostic State
    const [diagIps, setDiagIps] = useState('');
    const [diagResults, setDiagResults] = useState([]);
    const [diagLoading, setDiagLoading] = useState(false);
    const [diagErrorMsg, setDiagErrorMsg] = useState(null);

    // Watchlist Dashboard State
    const [watchList, setWatchList] = useState([]);
    const [watchResults, setWatchResults] = useState([]);
    const [refreshRate, setRefreshRate] = useState(0); // seconds
    const [searchTerm, setSearchTerm] = useState('');
    const [showAddModal, setShowAddModal] = useState(false);
    const [addIps, setAddIps] = useState('');

    const pollRef = useRef(null);

    const [monitors, setMonitors] = useState([]);
    const [selectedHostForDetail, setSelectedHostForDetail] = useState(null);
    const [showHostDetailModal, setShowHostDetailModal] = useState(false);
    const [deployingIps, setDeployingIps] = useState({});

    // Load monitors list and watch list from local storage on mount
    useEffect(() => {
        // Fetch active monitors
        api.get('/monitor/data/dashboard')
            .then(res => setMonitors(res.data.monitors || []))
            .catch(err => console.error('Failed to fetch monitors:', err));

        const saved = localStorage.getItem('serverCheckWatchList');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                setWatchList(parsed);
                // Initialize watchResults
                setWatchResults(parsed.map(ip => ({
                    ip, status: 'Waiting...', os: '-', cpu: '-', memory: '-', disk: '-', error: null
                })));
            } catch (e) {
                console.error('Failed to parse watchlist');
            }
        }
    }, []);

    // Save watch list to local storage
    useEffect(() => {
        localStorage.setItem('serverCheckWatchList', JSON.stringify(watchList));
    }, [watchList]);

    // Polling Logic
    useEffect(() => {
        if (pollRef.current) clearInterval(pollRef.current);

        if (activeTab === 'dashboard' && refreshRate > 0 && watchList.length > 0) {
            // Immediate tick if we just turned on auto-refresh
            // But wait, if watchList changes, it will also tick immediately.
            pollRef.current = setInterval(() => {
                performBackgroundCheck(watchList);
            }, refreshRate * 1000);
        }

        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [activeTab, refreshRate, watchList]);

    const performBackgroundCheck = async (currentList = watchList) => {
        if (!currentList || currentList.length === 0) return;

        // Visual feedback that background check is starting
        setWatchResults(prev => prev.map(r =>
            currentList.includes(r.ip) && (r.status === 'Waiting...' || r.status === 'Offline')
                ? { ...r, status: 'Processing', os: 'Checking...' }
                : r
        ));

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/ops/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ ips: currentList, linuxPassword })
            });
            if (!response.ok) return;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let partialBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                partialBuffer += decoder.decode(value, { stream: true });
                const lines = partialBuffer.split('\n');
                partialBuffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const chunk = JSON.parse(line);
                        setWatchResults(prev => {
                            const exists = prev.find(r => r.ip === chunk.ip);
                            if (exists) return prev.map(r => r.ip === chunk.ip ? chunk : r);
                            return [...prev, chunk];
                        });
                    } catch (e) { }
                }
            }
        } catch (err) {
            console.error('Background check failed:', err);
        }
    };

    const handleRunDiagnostic = async () => {
        setDiagErrorMsg(null);
        if (!diagIps.trim()) {
            setDiagErrorMsg('Please enter at least one IP address.');
            return;
        }

        const ipList = diagIps.split('\n').map(ip => ip.trim()).filter(ip => ip);
        setDiagLoading(true);

        setDiagResults(ipList.map(ip => ({
            ip, status: 'Processing', os: 'Checking...', cpu: '-', memory: '-', disk: '-', error: null
        })));

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/ops/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ ips: ipList, linuxPassword })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || 'Network response was not ok');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let partialBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                partialBuffer += decoder.decode(value, { stream: true });
                const lines = partialBuffer.split('\n');
                partialBuffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const chunk = JSON.parse(line);
                        setDiagResults(prev => prev.map(r => r.ip === chunk.ip ? chunk : r));
                    } catch (e) { }
                }
            }
        } catch (err) {
            setDiagErrorMsg('Failed to run diagnostic: ' + err.message);
        } finally {
            setDiagLoading(false);
        }
    };

    const handleAddWatchList = (e) => {
        e.preventDefault();
        const list = addIps.split('\n').map(ip => ip.trim()).filter(ip => ip && !watchList.includes(ip));
        if (list.length > 0) {
            const newList = [...watchList, ...list];
            setWatchList(newList);
            setWatchResults(prev => [...prev, ...list.map(ip => ({
                ip, status: 'Waiting...', os: '-', cpu: '-', memory: '-', disk: '-', error: null
            }))]);

            // Trigger check immediately with the new list
            setTimeout(() => performBackgroundCheck(newList), 100);
        }
        setAddIps('');
        setShowAddModal(false);
    };

    const handleRemoveWatch = (ip) => {
        setWatchList(prev => prev.filter(item => item !== ip));
        setWatchResults(prev => prev.filter(item => item.ip !== ip));
    };

    const handleDeployScout = async (ip, detectedOs) => {
        if (deployingIps[ip]) return;
        setDeployingIps(prev => ({ ...prev, [ip]: true }));
        showToast(`Starting Scout deployment on ${ip}...`, 'info');

        try {
            const osType = detectedOs && (detectedOs.toLowerCase().includes('win') || detectedOs.toLowerCase().includes('windows'))
                ? 'win'
                : 'linux';

            const response = await api.post('/inventory/deploy-agent', {
                ip,
                os: osType,
                hostname: ip,
                password: linuxPassword
            });

            if (response.data && response.data.success) {
                showToast(`Scout Agent deployed successfully on ${ip}!`, 'success');
                const res = await api.get('/monitor/data/dashboard');
                setMonitors(res.data.monitors || []);
            } else {
                showToast(`Deployment failed: ${response.data?.error || 'Unknown error'}`, 'error');
            }
        } catch (err) {
            showToast(err.response?.data?.error || `Failed to deploy to ${ip}`, 'error');
        } finally {
            setDeployingIps(prev => ({ ...prev, [ip]: false }));
        }
    };

    // Helper to parse percentages
    const parsePercent = (val) => {
        if (!val || val === '-' || val === 'Checking...') return 0;
        return parseFloat(val.toString().replace('%', '')) || 0;
    };

    const exportToCSV = (data) => {
        if (data.length === 0) return;
        const headers = ['Target IP', 'Status', 'Detected OS', 'CPU Load', 'Memory Used', 'Disk Used', 'Errors'];
        const rows = data.map(r => [
            r.ip, r.status, r.os, r.cpu, r.memory, r.disk, r.error || ''
        ]);
        const csvContent = "data:text/csv;charset=utf-8,"
            + [
                headers.join(','),
                ...rows.map(row => row.map(val => {
                    const strVal = String(val || '');
                    const cleanVal = /^[=+\-@]/.test(strVal) ? "'" + strVal : strVal;
                    return `"${cleanVal.replace(/"/g, '""')}"`;
                }).join(","))
            ].join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `Server_Check_Report_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const renderProgressBar = (valueStr, type) => {
        if (!valueStr || valueStr === '-' || valueStr === 'Waiting...') return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>-</span>;
        if (valueStr === 'Checking...') return <span style={{ color: 'var(--text-muted)', fontSize: 12, animation: 'pulse 2s infinite' }}>Checking...</span>;

        const value = parsePercent(valueStr);
        let barColor = 'var(--success)';
        let textColor = 'var(--success)';

        if (value > 85) {
            barColor = 'var(--danger)';
            textColor = 'var(--danger)';
        } else if (value > 60) {
            barColor = 'var(--warning)';
            textColor = 'var(--warning)';
        }

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                    <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.05em' }}>{type}</span>
                    <span style={{ color: textColor, fontWeight: 700 }}>{value}%</span>
                </div>
                <div style={{ width: '100%', background: 'rgba(255,255,255,0.1)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: barColor, width: `${Math.min(value, 100)}%`, transition: 'width 0.5s ease' }} />
                </div>
            </div>
        );
    };

    const renderTable = (data, isWatchlist) => {
        const filtered = data.filter(r =>
            r.ip.toLowerCase().includes(searchTerm.toLowerCase()) ||
            r.os.toLowerCase().includes(searchTerm.toLowerCase()) ||
            r.status.toLowerCase().includes(searchTerm.toLowerCase())
        );

        return (
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h3 style={S.tblTitle}>{isWatchlist ? 'Observation List' : 'Diagnostic Results'}</h3>
                        <div style={S.sBox}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>▽</span>
                            <input type="text" placeholder="Search IP or Status..." style={S.sInput} value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                        </div>
                    </div>
                    <button style={S.btnO} onClick={() => exportToCSV(filtered)}>📥 Export CSV</button>
                </div>
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>TARGET IP</th>
                            <th style={S.th}>STATUS</th>
                            <th style={S.th}>DETECTED OS</th>
                            <th style={S.th}>CPU LOAD</th>
                            <th style={S.th}>MEMORY USED</th>
                            <th style={S.th}>DISK USED</th>
                            <th style={S.th}>DIAGNOSTICS ERRORS</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan="8" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                    {isWatchlist ? 'Watchlist is empty or no matches.' : 'No diagnostic results yet.'}
                                </td>
                            </tr>
                        )}
                        {filtered.map((r, idx) => {
                            const isError = r.status === 'Offline' || !!r.error;
                            const isProc = r.status === 'Processing' || r.status === 'Waiting...';
                            const scoutHost = monitors.find(m => m.ip === r.ip);
                            const isDeploying = deployingIps[r.ip];
                            let bg = 'rgba(16,185,129,0.1)'; let col = 'var(--success)';
                            if (isError) { bg = 'rgba(239,68,68,0.1)'; col = 'var(--danger)'; }
                            else if (isProc) { bg = 'var(--bg-secondary)'; col = 'var(--text-muted)'; }

                            return (
                                <tr key={r.ip + idx} style={{ ...S.tr, opacity: isProc ? 0.7 : 1 }}>
                                    <td style={{ ...S.td, fontWeight: 800 }}>{r.ip}</td>
                                    <td style={S.td}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                                            <span style={{ ...S.badge, background: bg, color: col, border: `1px solid ${col}` }}>
                                                {r.status}
                                            </span>
                                            {scoutHost && (
                                                <button
                                                    style={{
                                                        background: 'rgba(16,185,129,0.15)',
                                                        color: '#10b981',
                                                        border: '1px solid rgba(16,185,129,0.3)',
                                                        borderRadius: 4,
                                                        fontSize: 10,
                                                        padding: '2px 6px',
                                                        cursor: 'pointer',
                                                        fontWeight: 700
                                                    }}
                                                    onClick={() => {
                                                        setSelectedHostForDetail(scoutHost);
                                                        setShowHostDetailModal(true);
                                                    }}
                                                >
                                                    ⚡ Scout Active
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                    <td style={{ ...S.td, color: isProc ? 'var(--text-muted)' : 'inherit' }}>{r.os}</td>
                                    <td style={S.td}>{renderProgressBar(r.cpu, 'cpu')}</td>
                                    <td style={S.td}>{renderProgressBar(r.memory, 'ram')}</td>
                                    <td style={S.td}>{renderProgressBar(r.disk, 'disk')}</td>
                                    <td style={{ ...S.td, color: 'var(--danger)', fontSize: 11, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.error || ''}>
                                        {r.error || '-'}
                                    </td>
                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                                            {scoutHost ? (
                                                <button
                                                    style={{ ...S.btnO, padding: '4px 10px', fontSize: 11 }}
                                                    onClick={() => {
                                                        setSelectedHostForDetail(scoutHost);
                                                        setShowHostDetailModal(true);
                                                    }}
                                                >
                                                    📊 Chart
                                                </button>
                                            ) : (
                                                <button
                                                    style={{
                                                        ...S.btnP,
                                                        padding: '4px 10px',
                                                        fontSize: 11,
                                                        background: isDeploying || isProc || r.status === 'Offline' ? 'var(--bg-secondary)' : 'var(--accent-primary)',
                                                        color: isDeploying || isProc || r.status === 'Offline' ? 'var(--text-muted)' : '#fff',
                                                        border: isDeploying || isProc || r.status === 'Offline' ? '1px solid var(--border-color)' : 'none',
                                                        boxShadow: isDeploying || isProc || r.status === 'Offline' ? 'none' : '0 2px 6px var(--accent-glow)',
                                                        cursor: isDeploying || isProc || r.status === 'Offline' ? 'default' : 'pointer'
                                                    }}
                                                    onClick={() => {
                                                        if (!isDeploying && !isProc && r.status !== 'Offline') {
                                                            handleDeployScout(r.ip, r.os);
                                                        }
                                                    }}
                                                    disabled={isDeploying || isProc || r.status === 'Offline'}
                                                >
                                                    {isDeploying ? 'Deploying...' : 'Deploy Scout'}
                                                </button>
                                            )}
                                            {isWatchlist && (
                                                <button
                                                    style={{ background: 'none', border: 'none', color: 'var(--danger)', fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '4px 8px' }}
                                                    onClick={() => handleRemoveWatch(r.ip)}
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        );
    };

    // Dashboard Calculations
    const activeData = activeTab === 'dashboard' ? watchResults : diagResults;
    const totalTargets = activeData.length;
    const onlineCount = activeData.filter(r => r.status === 'Online').length;
    const offlineCount = activeData.filter(r => r.status === 'Offline').length;

    const totalWarnings = activeData.filter(r => r.status === 'Online' && (parsePercent(r.cpu) > 85 || parsePercent(r.memory) > 85 || parsePercent(r.disk) > 85)).length;

    return (
        <div style={S.page}>
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Server Check</h1>
                    <p style={S.subtitle}>New Server Verification with Agentless Diagnostics</p>
                </div>
                <div style={S.headerBtns}>
                    <div style={{ display: 'flex', background: 'var(--bg-glass)', padding: 4, borderRadius: 24, border: '1px solid var(--border-color)' }}>
                        <button
                            onClick={() => setActiveTab('dashboard')}
                            style={{ padding: '6px 16px', border: 'none', borderRadius: 20, fontSize: 12, fontWeight: activeTab === 'dashboard' ? 800 : 600, background: activeTab === 'dashboard' ? 'var(--accent-primary)' : 'transparent', color: activeTab === 'dashboard' ? '#fff' : 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.15s' }}
                        >
                            Observation Dashboard
                        </button>
                        <button
                            onClick={() => setActiveTab('diagnostic')}
                            style={{ padding: '6px 16px', border: 'none', borderRadius: 20, fontSize: 12, fontWeight: activeTab === 'diagnostic' ? 800 : 600, background: activeTab === 'diagnostic' ? 'var(--accent-primary)' : 'transparent', color: activeTab === 'diagnostic' ? '#fff' : 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.15s' }}
                        >
                            Manual Diagnostic
                        </button>
                    </div>
                </div>
            </div>

            {/* Dashboard Specific Top Controls */}
            {activeTab === 'dashboard' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <button style={S.btnP} onClick={() => setShowAddModal(true)}>+ Add to Watchlist</button>
                        <button style={S.btnO} onClick={() => performBackgroundCheck(watchList)}>🔄 Refresh Now</button>
                        {watchList.length > 0 && (
                            <button
                                style={{ ...S.btnO, color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }}
                                onClick={() => { setWatchList([]); setWatchResults([]); }}
                            >
                                🗑️ Clear All
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-glass)', padding: '6px 16px', borderRadius: 24, border: '1px solid var(--border-color)' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>Auto-Refresh:</span>
                        <select
                            value={refreshRate}
                            onChange={(e) => setRefreshRate(Number(e.target.value))}
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', outline: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer', padding: '2px 8px', borderRadius: '4px' }}
                        >
                            <option value={0}>Off</option>
                            <option value={30}>30 Seconds</option>
                            <option value={60}>1 Minute</option>
                            <option value={300}>5 Minutes</option>
                        </select>
                    </div>
                </div>
            )}

            {/* Diagnostic Specific Controls */}
            {activeTab === 'diagnostic' && (
                <div style={{ ...S.card, marginBottom: 24 }}>
                    <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: 16, fontWeight: 900 }}>🔍 Diagnostic Settings</h3>
                    {diagErrorMsg && (
                        <div style={{ padding: 12, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
                            ⚠️ {diagErrorMsg}
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 24 }}>
                        <div style={{ flex: 1 }}>
                            <label style={S.metLabel}>TARGET IPS / HOSTNAMES (ONE PER LINE)</label>
                            <textarea style={S.textarea} rows="4" placeholder="e.g.&#10;192.168.1.100" value={diagIps} onChange={(e) => setDiagIps(e.target.value)} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label style={S.metLabel}>LINUX SSH CREDENTIAL (OPTIONAL)</label>
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, marginTop: 0 }}>If targets contain Linux nodes, supply password for automated <code>{linuxAdminUser}</code> login.</p>
                            <input type="password" style={S.input} placeholder={`Password for '${linuxAdminUser}'`} value={linuxPassword} onChange={(e) => setLinuxPassword(e.target.value)} />
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                                <button style={S.btnP} onClick={handleRunDiagnostic} disabled={diagLoading}>
                                    {diagLoading ? '⚡ Diagnosing...' : '▶ Start Diagnostic'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Metrics Dashboard */}
            {(activeTab === 'dashboard' || activeData.length > 0) && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
                    <div style={{ ...S.card, padding: 16, borderBottom: '4px solid var(--accent-primary)' }}>
                        <span style={{ ...S.metLabel, marginBottom: 4 }}>TOTAL TARGETS</span>
                        <div style={{ ...S.metVal, fontSize: 24 }}>{totalTargets}</div>
                    </div>
                    <div style={{ ...S.card, padding: 16, borderBottom: '4px solid var(--success)' }}>
                        <span style={{ ...S.metLabel, marginBottom: 4 }}>ONLINE SYSTEMS</span>
                        <div style={{ ...S.metVal, fontSize: 24, color: 'var(--success)' }}>{onlineCount}</div>
                    </div>
                    <div style={{ ...S.card, padding: 16, borderBottom: '4px solid var(--danger)' }}>
                        <span style={{ ...S.metLabel, marginBottom: 4 }}>OFFLINE SYSTEMS</span>
                        <div style={{ ...S.metVal, fontSize: 24, color: 'var(--danger)' }}>{offlineCount}</div>
                    </div>
                    <div style={{ ...S.card, padding: 16, borderBottom: '4px solid var(--warning)' }}>
                        <span style={{ ...S.metLabel, marginBottom: 4 }}>RESOURCE ALERTS</span>
                        <div style={{ ...S.metVal, fontSize: 24, color: totalWarnings > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>{totalWarnings}</div>
                    </div>
                </div>
            )}

            {/* Table */}
            {activeTab === 'dashboard' ? renderTable(watchResults, true) : (activeData.length > 0 && renderTable(diagResults, false))}

            {/* Add to Watchlist Modal */}
            {showAddModal && (
                <div style={S.overlay} onClick={() => setShowAddModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>➕ Add Servers to Watchlist</h3>
                            <button style={S.closeBtn} onClick={() => setShowAddModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleAddWatchList} style={{ padding: '20px 28px' }}>
                            <div>
                                <label style={S.metLabel}>IP ADDRESSES (ONE PER LINE)</label>
                                <textarea style={S.textarea} rows="5" placeholder="10.99.1.100&#10;10.99.1.101" value={addIps} onChange={e => setAddIps(e.target.value)} required />
                            </div>
                            <div style={{ marginTop: 16 }}>
                                <label style={S.metLabel}>LINUX SSH CREDENTIAL (OPTIONAL)</label>
                                <input type="password" style={S.input} placeholder={`Password for '${linuxAdminUser}'`} value={linuxPassword} onChange={(e) => setLinuxPassword(e.target.value)} />
                                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Password is stored locally during this session for background polling.</p>
                            </div>
                            <button style={{ ...S.btnP, width: '100%', justifyContent: 'center', marginTop: 20 }} type="submit">
                                Add to Observation List
                            </button>
                        </form>
                    </div>
                </div>
            )}

            <HostDetailModal
                isOpen={showHostDetailModal}
                onClose={() => {
                    setShowHostDetailModal(false);
                    setSelectedHostForDetail(null);
                }}
                initialHost={selectedHostForDetail}
            />
        </div>
    );
};

export default ServerCheck;
