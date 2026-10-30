import React, { useState, useEffect } from 'react';
import api from '../../api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { FaShieldAlt, FaExclamationTriangle, FaSearch, FaDownload, FaSpinner, FaHistory, FaFileCsv, FaFileCode, FaLayerGroup, FaServer, FaCheckCircle, FaTimesCircle, FaChevronRight, FaRobot, FaCopy, FaCheck, FaLightbulb, FaTerminal } from 'react-icons/fa';

const S = {
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 24 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    cardBody: { padding: '20px 24px' },
    grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20, marginBottom: 24 },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 24, marginBottom: 24 },
    th: { padding: '14px 20px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    td: { padding: '14px 20px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' },
    input: { padding: '10px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none' },
    select: { padding: '10px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', cursor: 'pointer' },
    btnP: { padding: '10px 22px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', display: 'inline-flex', alignItems: 'center', gap: 8, transition: 'all 0.2s' },
    btnS: { padding: '10px 20px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, transition: 'all 0.2s' },
    metVal: { fontSize: 30, fontWeight: 900, marginTop: 8 },
    badge: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    reportContainer: { padding: 24, background: 'rgba(0,0,0,0.25)', borderRadius: 16, border: '1px solid var(--border-color)', animation: 'fadeIn 0.3s ease', marginBottom: 28 },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 },
    modal: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 520, boxShadow: '0 24px 60px rgba(0,0,0,0.5)', overflow: 'hidden', padding: 28, textAlign: 'left' }
};

export default function OnDemandForensics() {
    const [mode, setMode] = useState('single'); // 'single' | 'fleet'
    const [monitors, setMonitors] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [selectedEnv, setSelectedEnv] = useState('');
    const [selectedMonitor, setSelectedMonitor] = useState('');
    const [selectedMonitorIds, setSelectedMonitorIds] = useState([]);
    const [scanType, setScanType] = useState('local');
    const [days, setDays] = useState(7);
    const [loading, setLoading] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [taskStatus, setTaskStatus] = useState('');
    const [taskId, setTaskId] = useState(null);
    const [report, setReport] = useState(null);
    const [reportHostName, setReportHostName] = useState('');
    const [pastReports, setPastReports] = useState([]);
    const [agentSearch, setAgentSearch] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [fleetResults, setFleetResults] = useState(null);
    const [timelineSeverityFilter, setTimelineSeverityFilter] = useState('all');

    // AI Remediation States
    const [aiLoading, setAiLoading] = useState(false);
    const [aiAnalysis, setAiAnalysis] = useState(null);
    const [aiNotice, setAiNotice] = useState(null);
    const [aiError, setAiError] = useState(null);
    const [copiedScript, setCopiedScript] = useState(false);

    useEffect(() => {
        fetchMonitors();
        fetchEnvironments();
        fetchPastReports();
    }, []);

    useEffect(() => {
        if (!selectedMonitor || mode !== 'single') return;
        const checkActiveTask = async () => {
            try {
                const res = await api.get(`/monitor/forensics/active/${selectedMonitor}`);
                if (res.data.activeTask) {
                    const task = res.data.activeTask;
                    setTaskId(task.id);
                    setScanning(true);
                    setTaskStatus(task.status === 'pending' ? 'Pending agent heartbeat check-in...' : 'Agent is executing deep OS scan...');
                }
            } catch (err) {
                console.error('Failed to check active task:', err);
            }
        };
        checkActiveTask();
    }, [selectedMonitor, mode]);

    const fetchMonitors = async () => {
        try {
            const res = await api.get('/monitor');
            const list = Array.isArray(res.data) ? res.data : (res.data.monitors || []);
            const enabledList = list.filter(m => m.enabled !== 0);
            setMonitors(enabledList);
            if (enabledList.length > 0) setSelectedMonitor(enabledList[0].id);
        } catch (err) {
            console.error('Failed to fetch monitors:', err);
        }
    };

    const fetchEnvironments = async () => {
        try {
            const res = await api.get('/environments');
            setEnvironments(res.data || []);
        } catch (err) {
            console.error('Failed to fetch environments:', err);
        }
    };

    const fetchPastReports = async () => {
        try {
            const res = await api.get('/monitor/forensics/reports');
            setPastReports(res.data || []);
        } catch (err) {
            console.error('Failed to fetch reports:', err);
        }
    };

    const startScan = async () => {
        if (!selectedMonitor) return;
        setLoading(true);
        setReport(null);
        setFleetResults(null);
        setAiAnalysis(null);
        setAiNotice(null);
        setAiError(null);
        const hostObj = monitors.find(m => m.id === selectedMonitor);
        setReportHostName(hostObj ? hostObj.name : 'Target Host');
        setTaskStatus('Initializing forensic scan...');
        try {
            const res = await api.post('/monitor/forensics/scan', {
                monitorId: selectedMonitor,
                scanType,
                options: { days }
            });

            if (res.data.status === 'completed') {
                setReport(res.data.report);
                setTaskStatus('Scan Complete');
                fetchPastReports();
            } else {
                setTaskId(res.data.taskId);
                setScanning(true);
                setTaskStatus('Pending agent heartbeat check-in...');
            }
        } catch (err) {
            console.error('Forensics scan failed:', err);
            setTaskStatus('Scan failed to initialize.');
        } finally {
            setLoading(false);
        }
    };

    const startFleetScan = async () => {
        setLoading(true);
        setReport(null);
        setFleetResults(null);
        setAiAnalysis(null);
        setAiNotice(null);
        setAiError(null);
        setTaskStatus('Running Fleet Sweeping across target hosts...');
        try {
            const res = await api.post('/monitor/forensics/fleet-scan', {
                envId: selectedEnv || undefined,
                monitorIds: selectedMonitorIds.length > 0 ? selectedMonitorIds : undefined,
                days
            });
            setFleetResults(res.data);
            setTaskStatus(`Fleet sweep completed: ${res.data.totalScanned} hosts scanned.`);
            fetchPastReports();
        } catch (err) {
            console.error('Fleet scan failed:', err);
            setTaskStatus('Fleet sweep failed.');
        } finally {
            setLoading(false);
        }
    };

    const cancelScan = async () => {
        if (!taskId) return;
        try {
            await api.post(`/monitor/forensics/task/${taskId}/cancel`);
            setScanning(false);
            setTaskId(null);
            setTaskStatus('Scan cancelled by user.');
        } catch (err) {
            console.error('Failed to cancel scan:', err);
        }
    };

    // Poll for Deep Scan status
    useEffect(() => {
        if (!scanning || !taskId) return;
        const interval = setInterval(async () => {
            try {
                const res = await api.get(`/monitor/forensics/task/${taskId}`);
                if (res.data.status === 'completed') {
                    setReport(res.data.report);
                    setScanning(false);
                    setTaskId(null);
                    setTaskStatus('Scan Complete');
                    fetchPastReports();
                } else if (res.data.status === 'running') {
                    setTaskStatus('Agent is executing deep OS scan...');
                } else if (res.data.status === 'failed') {
                    setScanning(false);
                    setTaskId(null);
                    setTaskStatus('Agent failed to complete scan.');
                }
            } catch (err) {
                console.error('Error polling task:', err);
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [scanning, taskId]);

    const generateAiRemediation = async () => {
        if (!report) return;
        setAiLoading(true);
        setAiError(null);
        setAiNotice(null);
        try {
            const hostObj = monitors.find(m => m.name === reportHostName || m.id === selectedMonitor);
            const res = await api.post('/ai/forensics-remediation', {
                report,
                targetHost: reportHostName,
                os: hostObj?.os || 'windows'
            });
            if (res.data.notConfigured) {
                setAiNotice({ reason: res.data.reason, message: res.data.message });
                setAiAnalysis(null);
                setAiError(null);
            } else if (res.data.success) {
                setAiAnalysis(res.data);
                setAiNotice(null);
                setAiError(null);
            } else {
                setAiError(res.data.error || 'Failed to generate AI remediation.');
            }
        } catch (err) {
            console.error('Failed to generate AI remediation:', err);
            setAiError(err.response?.data?.error || 'Failed to communicate with AI engine.');
        } finally {
            setAiLoading(false);
        }
    };

    const copyToClipboard = (text) => {
        if (!text) return;
        const contentStr = typeof text === 'string' ? text : (text?.analysis || text?.answer || text?.content || JSON.stringify(text, null, 2));
        if (!contentStr) return;

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(contentStr)
                .then(() => {
                    setCopiedScript(true);
                    setTimeout(() => setCopiedScript(false), 2500);
                })
                .catch(() => {
                    fallbackCopyText(contentStr);
                });
        } else {
            fallbackCopyText(contentStr);
        }
    };

    const fallbackCopyText = (contentStr) => {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = contentStr;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            textArea.setAttribute('readonly', '');
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            setCopiedScript(true);
            setTimeout(() => setCopiedScript(false), 2500);
        } catch (err) {
            console.error('Fallback copy failed:', err);
        }
    };

    const loadPastReport = async (repId, hostName) => {
        try {
            setLoading(true);
            setReportHostName(hostName || 'Archive Report');
            setAiAnalysis(null);
            setAiNotice(null);
            setAiError(null);
            const res = await api.get(`/monitor/forensics/task/${repId}`);
            if (res.data.report) {
                setReport(res.data.report);
                setTaskStatus('Viewing Archive Report');
                window.scrollTo({ top: 400, behavior: 'smooth' });
            }
        } catch (err) {
            console.error('Failed to load past report:', err);
        } finally {
            setLoading(false);
        }
    };

    const downloadPDF = () => {
        window.print();
    };

    const exportJSON = () => {
        if (!report) return;
        const payload = {
            ...report,
            targetHost: reportHostName,
            aiIncidentRemediation: aiAnalysis || null
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
        const a = document.createElement('a');
        a.href = dataStr;
        a.download = `forensic_report_${reportHostName}_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const exportCSV = () => {
        if (!report || !report.timeline || report.timeline.length === 0) return;
        const headers = ["Timestamp", "Severity", "Stage", "Tactic", "Title", "Source", "Details"];
        const rows = report.timeline.map(e => [
            `"${e.timestamp}"`,
            `"${e.severity}"`,
            `"${e.stage}"`,
            `"${e.tactic}"`,
            `"${(e.title || '').replace(/"/g, '""')}"`,
            `"${e.source}"`,
            `"${(e.details || '').replace(/"/g, '""')}"`
        ]);
        const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
        const a = document.createElement('a');
        a.href = encodeURI(csvContent);
        a.download = `forensic_timeline_${reportHostName}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const getChartData = () => {
        if (!report || !report.mitreDomains) return [];
        return Object.entries(report.mitreDomains).map(([name, count]) => ({
            name,
            count
        }));
    };

    const chartData = getChartData();
    const mitreColors = ['#3b82f6', '#ec4899', '#8b5cf6', '#f59e0b', '#ef4444', '#10b981', '#06b6d4', '#6366f1', '#d946ef'];

    const filteredTimeline = (report?.timeline || []).filter(e => {
        if (timelineSeverityFilter === 'all') return true;
        return (e.severity || '').toLowerCase() === timelineSeverityFilter.toLowerCase();
    });

    const activeMonitorObj = monitors.find(m => m.id === selectedMonitor);

    return (
        <div style={{ animation: 'fadeIn 0.3s ease' }}>
            {/* Mode Switcher Tabs */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <button
                    onClick={() => { setMode('single'); setFleetResults(null); }}
                    style={{
                        ...S.btnS,
                        background: mode === 'single' ? 'var(--accent-primary)' : 'var(--bg-glass)',
                        color: mode === 'single' ? '#fff' : 'var(--text-primary)',
                        border: mode === 'single' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                    }}
                >
                    <FaSearch /> Single Host Investigation
                </button>
                <button
                    onClick={() => { setMode('fleet'); setReport(null); }}
                    style={{
                        ...S.btnS,
                        background: mode === 'fleet' ? 'var(--accent-primary)' : 'var(--bg-glass)',
                        color: mode === 'fleet' ? '#fff' : 'var(--text-primary)',
                        border: mode === 'fleet' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                    }}
                >
                    <FaLayerGroup /> Fleet Sweeping (Multi-Host Hunt)
                </button>
            </div>

            {/* Mode 1: Single Host Control Form */}
            {mode === 'single' && (
                <div style={S.card}>
                    <div style={S.cardHead}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FaSearch /> On-Demand Forensics Hunt Settings
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Targeted Root-Cause & Threat Investigation</span>
                    </div>
                    <div style={S.cardBody}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280, position: 'relative' }}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SELECT TARGET AGENT</label>
                                <button 
                                    onClick={() => setShowDropdown(!showDropdown)} 
                                    style={{ ...S.select, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: 280 }}
                                >
                                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {activeMonitorObj 
                                            ? `${activeMonitorObj.name} (${activeMonitorObj.ip})`
                                            : 'Select Agent...'}
                                    </span>
                                    <span>▾</span>
                                </button>

                                {showDropdown && (
                                    <div style={{ 
                                        position: 'absolute', 
                                        left: 0, 
                                        top: '100%', 
                                        marginTop: 8, 
                                        background: 'var(--bg-primary)', 
                                        border: '1px solid var(--border-color)', 
                                        borderRadius: 12, 
                                        boxShadow: '0 12px 28px rgba(0,0,0,0.5)', 
                                        zIndex: 1000, 
                                        width: 320, 
                                        padding: 12 
                                    }}>
                                        <input 
                                            type="text" 
                                            placeholder="Filter agents by name/IP..." 
                                            style={{ ...S.input, padding: '6px 12px', fontSize: 12, marginBottom: 8, width: '100%', boxSizing: 'border-box' }} 
                                            value={agentSearch} 
                                            onChange={e => setAgentSearch(e.target.value)} 
                                            onClick={e => e.stopPropagation()}
                                        />
                                        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, background: 'rgba(0,0,0,0.2)', padding: 4 }}>
                                            {(() => {
                                                const filtered = monitors.filter(m => {
                                                    const s = agentSearch.toLowerCase();
                                                    return m.name.toLowerCase().includes(s) || m.ip.includes(s);
                                                });
                                                if (filtered.length === 0) {
                                                    return <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>No matching hosts</div>;
                                                }
                                                return filtered.map(m => {
                                                    const isSelected = m.id === selectedMonitor;
                                                    return (
                                                        <div 
                                                            key={m.id} 
                                                            style={{ 
                                                                padding: '6px 10px', 
                                                                cursor: 'pointer', 
                                                                fontSize: 11, 
                                                                borderRadius: 6, 
                                                                background: isSelected ? 'var(--accent-primary)' : 'transparent',
                                                                color: isSelected ? '#fff' : 'var(--text-primary)',
                                                                display: 'flex',
                                                                justifyContent: 'space-between',
                                                                alignItems: 'center',
                                                                marginBottom: 2
                                                            }}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setSelectedMonitor(m.id);
                                                                setShowDropdown(false);
                                                            }}
                                                        >
                                                            <span style={{ fontWeight: isSelected ? 800 : 500 }}>{m.name}</span>
                                                            <span style={{ fontSize: 10, opacity: 0.7 }}>{m.os?.toUpperCase()} ({m.ip})</span>
                                                        </div>
                                                    );
                                                });
                                            })()}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SCAN METHOD</label>
                                <select value={scanType} onChange={e => setScanType(e.target.value)} style={S.select}>
                                    <option value="local">Local DB Forensics Engine (Instant)</option>
                                    <option value="deep">Deep OS Log Sweep (Go Agent Command)</option>
                                </select>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LOOKBACK WINDOW</label>
                                <select value={days} onChange={e => setDays(Number(e.target.value))} style={S.select}>
                                    <option value={1}>Last 24 Hours</option>
                                    <option value={3}>Last 3 Days</option>
                                    <option value={7}>Last 7 Days</option>
                                    <option value={14}>Last 14 Days</option>
                                    <option value={30}>Last 30 Days</option>
                                </select>
                            </div>

                            <button style={S.btnP} onClick={startScan} disabled={loading || scanning}>
                                {loading || scanning ? <FaSpinner className="spin" /> : <><FaShieldAlt /> Launch Forensic Scan</>}
                            </button>
                        </div>

                        {taskStatus && (
                            <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(0,0,0,0.2)', borderRadius: 10 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: scanning ? '#f59e0b' : '#10b981', display: 'inline-block' }} />
                                    <span>Status: <b style={{ color: 'var(--text-primary)' }}>{taskStatus}</b></span>
                                </div>
                                {scanning && taskId && (
                                    <button 
                                        onClick={cancelScan} 
                                        style={{ 
                                            padding: '4px 12px', 
                                            background: 'rgba(239, 68, 68, 0.15)', 
                                            color: '#ef4444', 
                                            border: '1px solid rgba(239, 68, 68, 0.3)', 
                                            borderRadius: 8, 
                                            fontSize: 11, 
                                            cursor: 'pointer',
                                            fontWeight: 700
                                        }}
                                    >
                                        Cancel Scan
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Mode 2: Fleet Sweeping Control Form */}
            {mode === 'fleet' && (
                <div style={S.card}>
                    <div style={S.cardHead}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FaLayerGroup /> Fleet Sweeping & Multi-Host Threat Hunting
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Scan all servers across an environment for lateral threats</span>
                    </div>
                    <div style={S.cardBody}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 240 }}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TARGET ENVIRONMENT</label>
                                <select value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)} style={S.select}>
                                    <option value="">All Environments ({monitors.length} Hosts)</option>
                                    {environments.map(env => (
                                        <option key={env.id} value={env.id}>{env.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LOOKBACK WINDOW</label>
                                <select value={days} onChange={e => setDays(Number(e.target.value))} style={S.select}>
                                    <option value={1}>Last 24 Hours</option>
                                    <option value={3}>Last 3 Days</option>
                                    <option value={7}>Last 7 Days</option>
                                    <option value={14}>Last 14 Days</option>
                                    <option value={30}>Last 30 Days</option>
                                </select>
                            </div>

                            <button style={S.btnP} onClick={startFleetScan} disabled={loading}>
                                {loading ? <FaSpinner className="spin" /> : <><FaSearch /> Run Fleet Threat Sweep</>}
                            </button>
                        </div>

                        {taskStatus && (
                            <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(0,0,0,0.2)', borderRadius: 10 }}>
                                <div style={{ width: 10, height: 10, borderRadius: '50%', background: loading ? '#f59e0b' : '#10b981', display: 'inline-block' }} />
                                <span>Status: <b style={{ color: 'var(--text-primary)' }}>{taskStatus}</b></span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Fleet Sweeping Results View */}
            {fleetResults && (
                <div style={S.card}>
                    <div style={S.cardHead}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FaServer /> Fleet Threat Sweep Results ({fleetResults.totalScanned} Hosts Scanned)
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <span style={{ ...S.badge, background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>Critical: {fleetResults.criticalCount}</span>
                            <span style={{ ...S.badge, background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Elevated: {fleetResults.elevatedCount}</span>
                            <span style={{ ...S.badge, background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>Clean: {fleetResults.cleanCount}</span>
                        </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Host</th>
                                    <th style={S.th}>IP & OS</th>
                                    <th style={S.th}>Risk Level</th>
                                    <th style={S.th}>Risk Score</th>
                                    <th style={S.th}>Critical Indicators</th>
                                    <th style={S.th}>Failed Logons</th>
                                    <th style={S.th}>Suspicious Cmds</th>
                                    <th style={{ ...S.th, textAlign: 'right' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {fleetResults.results.map((r) => (
                                    <tr key={r.monitorId} style={{ background: r.riskLevel === 'CRITICAL' ? 'rgba(239,68,68,0.05)' : 'transparent' }}>
                                        <td style={{ ...S.td, fontWeight: 700 }}>{r.name}</td>
                                        <td style={S.td}><span style={{ color: 'var(--text-muted)' }}>{r.ip}</span> <span style={{ ...S.badge, background: 'var(--bg-secondary)', fontSize: 10 }}>{r.os?.toUpperCase()}</span></td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, background: `${r.riskColor}22`, color: r.riskColor, border: `1px solid ${r.riskColor}55` }}>
                                                {r.riskLevel}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <div style={{ width: 60, height: 6, background: 'var(--bg-glass)', borderRadius: 3, overflow: 'hidden' }}>
                                                    <div style={{ width: `${r.riskScore}%`, height: '100%', background: r.riskColor }} />
                                                </div>
                                                <span style={{ fontWeight: 800, color: r.riskColor }}>{r.riskScore}/100</span>
                                            </div>
                                        </td>
                                        <td style={{ ...S.td, color: r.criticalThreats > 0 ? '#ef4444' : 'inherit', fontWeight: r.criticalThreats > 0 ? 800 : 400 }}>{r.criticalThreats}</td>
                                        <td style={{ ...S.td, color: r.failedLogons >= 5 ? '#f59e0b' : 'inherit' }}>{r.failedLogons}</td>
                                        <td style={{ ...S.td, color: r.suspiciousCmds > 0 ? '#ef4444' : 'inherit' }}>{r.suspiciousCmds}</td>
                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                            <button
                                                style={{ ...S.btnS, padding: '4px 12px', fontSize: 11 }}
                                                onClick={() => {
                                                    setReport(r.report);
                                                    setReportHostName(r.name);
                                                    window.scrollTo({ top: 450, behavior: 'smooth' });
                                                }}
                                            >
                                                Inspect Report <FaChevronRight size={10} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Results Report Display */}
            {report && (
                <div style={S.reportContainer} className="print-section">
                    {/* Report Top Action Bar */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 18, flexWrap: 'wrap', gap: 16 }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>🛡️ Forensic Sweeping Report</h2>
                                <span style={{ ...S.badge, background: `${report.riskColor}22`, color: report.riskColor, border: `1px solid ${report.riskColor}55`, fontSize: 12, padding: '4px 12px' }}>
                                    {report.riskLevel} RISK (Score: {report.riskScore}/100)
                                </span>
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
                                Target Host: <b>{reportHostName || monitors.find(m => m.id === selectedMonitor)?.name}</b> | Scan Time: {new Date(report.scanTime).toLocaleString()} | Total Logs Analyzed: <b>{report.totalLogsAnalyzed}</b>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 10 }} className="no-print">
                            <button 
                                style={{ ...S.btnP, background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', boxShadow: '0 4px 14px rgba(168,85,247,0.35)', border: 'none' }} 
                                onClick={generateAiRemediation} 
                                disabled={aiLoading}
                                title="Generate AI Incident Remediation Plan with Root Cause and Remediation Scripts"
                            >
                                {aiLoading ? <FaSpinner className="spin" /> : <><FaRobot /> Ask AI Remediation</>}
                            </button>
                            <button style={S.btnS} onClick={exportJSON} title="Export full report as JSON">
                                <FaFileCode /> Export JSON
                            </button>
                            <button style={S.btnS} onClick={exportCSV} title="Export attack chain timeline as CSV">
                                <FaFileCsv /> Export CSV
                            </button>
                            <button style={S.btnP} onClick={downloadPDF} title="Print or save as PDF">
                                <FaDownload /> Print / PDF
                            </button>
                            <button style={{ ...S.btnS, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }} onClick={() => { setReport(null); setTaskStatus(''); setAiAnalysis(null); setAiError(null); }}>
                                Close Report
                            </button>
                        </div>
                    </div>

                    {/* Threat Score & Actionable Remediation Guidance */}
                    <div style={{ ...S.card, background: 'rgba(0,0,0,0.3)', border: `1px solid ${report.riskColor}44`, marginBottom: 24 }}>
                        <div style={{ ...S.cardHead, borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: report.riskColor, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <FaShieldAlt /> Host Risk Assessment & Actionable Guidance
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Risk Index: {report.riskScore}/100</span>
                        </div>
                        <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 24 }}>
                            {/* Score Gauge */}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '16px', borderRight: '1px solid var(--border-color)' }}>
                                <div style={{ fontSize: 48, fontWeight: 900, color: report.riskColor, lineHeight: 1 }}>{report.riskScore}</div>
                                <div style={{ fontSize: 14, fontWeight: 800, color: report.riskColor, marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{report.riskLevel} RISK</div>
                                <div style={{ width: '80%', height: 8, background: 'var(--bg-glass)', borderRadius: 4, marginTop: 12, overflow: 'hidden' }}>
                                    <div style={{ width: `${report.riskScore}%`, height: '100%', background: report.riskColor, transition: 'width 0.5s ease' }} />
                                </div>
                            </div>

                            {/* Remediation Action List */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Recommended Actions</div>
                                {report.recommendations && report.recommendations.map((r, idx) => (
                                    <div key={idx} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ ...S.badge, fontSize: 10, background: r.priority.includes('P1') ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: r.priority.includes('P1') ? '#ef4444' : '#f59e0b' }}>
                                                {r.priority}
                                            </span>
                                            <span style={{ fontWeight: 800, fontSize: 13 }}>{r.action}</span>
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.desc}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* AI Incident Response & Actionable Remediation Advisory Card */}
                    {(aiAnalysis || aiLoading || aiError) && (
                        <div style={{ 
                            ...S.card, 
                            background: 'rgba(99, 102, 241, 0.06)', 
                            border: '1px solid rgba(168, 85, 247, 0.4)', 
                            marginBottom: 24, 
                            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)' 
                        }}>
                            <div style={{ ...S.cardHead, borderBottom: '1px solid rgba(168, 85, 247, 0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 16 }}>🤖</span>
                                    <span style={{ color: '#a855f7', fontWeight: 900, fontSize: 14 }}>
                                        AI Incident Response & Remediation Advisory
                                    </span>
                                    {aiAnalysis && (
                                        <span style={{ ...S.badge, background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)', fontSize: 10 }}>
                                            {aiAnalysis.provider?.toUpperCase()} ({aiAnalysis.model})
                                        </span>
                                    )}
                                </div>
                                <div style={{ display: 'flex', gap: 8 }} className="no-print">
                                    {aiAnalysis && (
                                        <button 
                                            style={{ ...S.btnS, padding: '4px 12px', fontSize: 11 }} 
                                            onClick={() => copyToClipboard(aiAnalysis.analysis)}
                                        >
                                            {copiedScript ? <><FaCheck style={{ color: '#10b981' }} /> Copied!</> : <><FaCopy /> Copy AI Advice</>}
                                        </button>
                                    )}
                                    <button 
                                        style={{ ...S.btnS, padding: '4px 8px', fontSize: 11, background: 'transparent' }} 
                                        onClick={() => { setAiAnalysis(null); setAiError(null); }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                            <div style={S.cardBody}>
                                {aiLoading && (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0', gap: 12, color: '#c084fc' }}>
                                        <FaSpinner className="spin" size={28} />
                                        <div style={{ fontSize: 13, fontWeight: 700 }}>AI Security Engine is analyzing attack chain timeline & telemetry...</div>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Synthesizing root cause diagnosis and tailored remediation scripts...</div>
                                    </div>
                                )}
                                {aiError && (
                                    <div style={{ padding: '14px 18px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, color: '#ef4444', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <FaExclamationTriangle />
                                            <span>{aiError}</span>
                                        </div>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Check <b>Settings &gt; AI Service</b></span>
                                    </div>
                                )}
                                {aiAnalysis && (
                                    <div style={{ color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                                        {aiAnalysis.analysis}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Threat Metric Grid (4 Cards) */}
                    <div style={S.grid4}>
                        <div style={{ ...S.card, margin: 0, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)' }}>
                            <div style={{ ...S.cardHead, color: '#ef4444' }}><FaExclamationTriangle /> Critical Indicators</div>
                            <div style={{ ...S.cardBody, color: '#ef4444', ...S.metVal }}>{report.threatCounts.critical}</div>
                        </div>
                        <div style={{ ...S.card, margin: 0, border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)' }}>
                            <div style={{ ...S.cardHead, color: '#f59e0b' }}><FaExclamationTriangle /> Failed Logons</div>
                            <div style={{ ...S.cardBody, color: '#f59e0b', ...S.metVal }}>{report.threatCounts.failedLogons}</div>
                        </div>
                        <div style={{ ...S.card, margin: 0, border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.05)' }}>
                            <div style={{ ...S.cardHead, color: '#3b82f6' }}><FaShieldAlt /> Suspicious Commands</div>
                            <div style={{ ...S.cardBody, color: '#3b82f6', ...S.metVal }}>{report.threatCounts.suspiciousCmds}</div>
                        </div>
                        <div style={{ ...S.card, margin: 0, border: '1px solid rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.05)' }}>
                            <div style={{ ...S.cardHead, color: '#8b5cf6' }}><FaLayerGroup /> Privilege Changes</div>
                            <div style={{ ...S.cardBody, color: '#8b5cf6', ...S.metVal }}>{report.threatCounts.privilegeChanges || 0}</div>
                        </div>
                    </div>

                    {/* Attack Chain Timeline (時間軸) */}
                    <div style={S.card}>
                        <div style={S.cardHead}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <FaHistory /> Attack Chain Timeline ({filteredTimeline.length} Chronological Events)
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                                {['all', 'critical', 'high', 'warning', 'medium', 'info'].map(sev => (
                                    <button
                                        key={sev}
                                        onClick={() => setTimelineSeverityFilter(sev)}
                                        style={{
                                            ...S.btnS,
                                            padding: '3px 10px',
                                            fontSize: 11,
                                            textTransform: 'uppercase',
                                            background: timelineSeverityFilter === sev ? 'var(--accent-primary)' : 'var(--bg-glass)',
                                            color: timelineSeverityFilter === sev ? '#fff' : 'var(--text-muted)'
                                        }}
                                    >
                                        {sev}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div style={{ ...S.cardBody, maxHeight: 420, overflowY: 'auto' }}>
                            {filteredTimeline.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
                                    No timeline events matching the current severity filter.
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    {filteredTimeline.map((item, idx) => {
                                        const sevColor = item.severity === 'Critical' ? '#ef4444' : item.severity === 'High' ? '#f59e0b' : item.severity === 'Warning' ? '#eab308' : item.severity === 'Medium' ? '#8b5cf6' : '#3b82f6';
                                        return (
                                            <div key={idx} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', borderLeft: `3px solid ${sevColor}`, paddingLeft: 14, paddingBottom: 4 }}>
                                                <div style={{ minWidth: 140, fontSize: 11, color: 'var(--text-muted)', paddingTop: 2 }}>
                                                    {new Date(item.timestamp).toLocaleString()}
                                                </div>
                                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                        <span style={{ ...S.badge, background: `${sevColor}22`, color: sevColor, border: `1px solid ${sevColor}55`, fontSize: 10 }}>
                                                            {item.severity?.toUpperCase()}
                                                        </span>
                                                        <span style={{ ...S.badge, background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', fontSize: 10 }}>
                                                            {item.stage}
                                                        </span>
                                                        <span style={{ fontWeight: 800, fontSize: 13 }}>{item.title}</span>
                                                        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{item.source}</span>
                                                    </div>
                                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: item.details?.includes(' ') && (item.details?.length < 300) ? 'monospace' : 'inherit', background: 'rgba(0,0,0,0.2)', padding: '6px 10px', borderRadius: 6, wordBreak: 'break-all' }}>
                                                        {item.details}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <div style={S.grid2}>
                        {/* MITRE ATT&CK Domains Chart */}
                        <div style={S.card}>
                            <div style={S.cardHead}>MITRE ATT&CK Matrix Domains</div>
                            <div style={{ ...S.cardBody, height: 280 }}>
                                {chartData.some(d => d.count > 0) ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 10 }}>
                                            <XAxis type="number" stroke="var(--text-muted)" fontSize={11} />
                                            <YAxis dataKey="name" type="category" width={130} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="transparent" />
                                            <Tooltip contentStyle={{ background: '#000', border: '1px solid #333', borderRadius: 8 }} />
                                            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                                                {chartData.map((entry, index) => (
                                                    <Cell key={`cell-${index}`} fill={mitreColors[index % mitreColors.length]} />
                                                ))}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', paddingTop: 110, fontSize: 13, fontStyle: 'italic' }}>No MITRE tactics matched in the analyzed logs.</div>
                                )}
                            </div>
                        </div>

                        {/* Logon Accounts Summary */}
                        <div style={S.card}>
                            <div style={S.cardHead}>Logon & Identity Activity</div>
                            <div style={{ ...S.cardBody, display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 10 }}>
                                    <span>Success Logon Attempts:</span>
                                    <span style={{ fontWeight: 800, color: '#10b981' }}>{report.logonSummary.success}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 10 }}>
                                    <span>Failed Logon Attempts:</span>
                                    <span style={{ fontWeight: 800, color: '#ef4444' }}>{report.logonSummary.failure}</span>
                                </div>
                                {report.logonSummary.topBruteTarget && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: 10 }}>
                                        <span>Primary Target Account:</span>
                                        <span style={{ fontWeight: 800, color: '#f59e0b' }}>{report.logonSummary.topBruteTarget}</span>
                                    </div>
                                )}
                                <div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 800 }}>ACTIVE USER SESSIONS</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {Object.entries(report.logonSummary.users).slice(0, 8).map(([user, count]) => (
                                            <span key={user} style={{ ...S.badge, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                                                {user}: {count}
                                            </span>
                                        ))}
                                        {Object.keys(report.logonSummary.users).length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>None recorded</span>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Privilege Changes Log */}
                    <div style={S.card}>
                        <div style={S.cardHead}>🔑 Account & Privilege Escalation Events</div>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>Timestamp</th>
                                        <th style={S.th}>Type</th>
                                        <th style={S.th}>Details</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.privilegeEvents.map((e, idx) => (
                                        <tr key={idx}>
                                            <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleString()}</td>
                                            <td style={S.td}><span style={{ ...S.badge, background: 'rgba(139,92,246,0.2)', color: '#8b5cf6' }}>{e.type}</span></td>
                                            <td style={{ ...S.td, fontSize: 12 }}>{e.details}</td>
                                        </tr>
                                    ))}
                                    {report.privilegeEvents.length === 0 && (
                                        <tr>
                                            <td colSpan={3} style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                No privilege escalation or account change events detected.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Suspicious Commands Log */}
                    <div style={S.card}>
                        <div style={{ ...S.cardHead, color: '#ef4444' }}>🚨 Suspicious System Commands & Activity Match</div>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>Timestamp</th>
                                        <th style={S.th}>Source Log</th>
                                        <th style={S.th}>Pattern Matched</th>
                                        <th style={S.th}>Details</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.suspiciousIndicators.map((e, idx) => (
                                        <tr key={idx}>
                                            <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleString()}</td>
                                            <td style={S.td}><span style={{ ...S.badge, background: 'rgba(239,68,68,0.2)', color: '#ef4444' }}>{e.source}</span></td>
                                            <td style={{ ...S.td, color: '#f59e0b', fontWeight: 800 }}>{e.indicator}</td>
                                            <td style={{ ...S.td, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{e.details}</td>
                                        </tr>
                                    ))}
                                    {report.suspiciousIndicators.length === 0 && (
                                        <tr>
                                            <td colSpan={4} style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                No suspicious commands or tool execution patterns detected.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* Past Reports List */}
            {!report && !fleetResults && (
                <div style={S.card}>
                    <div style={S.cardHead}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FaHistory /> Past Forensic Sweeping Reports
                        </div>
                        <button style={{ ...S.btnS, padding: '4px 12px', fontSize: 11 }} onClick={fetchPastReports}>
                            Refresh Archive
                        </button>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Host</th>
                                    <th style={S.th}>Scan Method</th>
                                    <th style={S.th}>Generated At</th>
                                    <th style={S.th}>Status</th>
                                    <th style={{ ...S.th, textAlign: 'right' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pastReports.map(r => (
                                    <tr key={r.id}>
                                        <td style={{ ...S.td, fontWeight: 700 }}>{r.hostName || 'Unknown Host'}</td>
                                        <td style={S.td}><span style={{ ...S.badge, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}>{r.scanType?.toUpperCase()}</span></td>
                                        <td style={S.td}>{new Date(r.timestamp).toLocaleString()}</td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, background: r.status === 'completed' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)', color: r.status === 'completed' ? '#10b981' : '#ef4444' }}>
                                                {r.status?.toUpperCase()}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                            <button style={{ ...S.btnS, padding: '4px 12px', fontSize: 11, display: 'inline-flex' }} onClick={() => loadPastReport(r.taskId, r.hostName)}>
                                                View Report
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {pastReports.length === 0 && (
                                    <tr>
                                        <td colSpan={5} style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                            No past reports found. Launch a scan above.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* AI Service Setup Notice Modal */}
            {aiNotice && (
                <div style={S.overlay} onClick={() => setAiNotice(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 16, marginBottom: 20 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
                                    💡
                                </div>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>AI Service Setup Required</h3>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Universal AI Service Center Notice</span>
                                </div>
                            </div>
                            <button 
                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }} 
                                onClick={() => setAiNotice(null)}
                            >
                                ✕
                            </button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div style={{ padding: '12px 16px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: 10, color: '#f59e0b', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <FaLightbulb />
                                <span>{aiNotice.message}</span>
                            </div>

                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                                SOMP Vanguard 具備集中式通用 AI 引擎，支援企業私有化 <b>Ollama (內網離線模型，如 llama3, qwen2.5)</b> 或雲端 <b>OpenAI (GPT-4o) / Google Gemini</b>。
                            </div>

                            <div style={{ padding: '14px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 }}>📋 設定指引步驟：</div>
                                1. 請具備權限的管理員前往左側選單 <b>System Settings (系統設定)</b>。<br />
                                2. 切換至 <b>🤖 AI Service</b> 頁籤。<br />
                                3. 選擇 AI Provider，填寫連線 Base URL 與 API Key。<br />
                                4. 開啟 <b>Enabled (啟用)</b> 開關並點擊 <b>Save AI Configuration</b>。
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                            <button 
                                type="button" 
                                style={{ ...S.btnP, background: 'var(--accent-primary)', minWidth: 100 }} 
                                onClick={() => setAiNotice(null)}
                            >
                                Got It (知道了)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
