import React, { useState, useEffect } from 'react';
import api from '../../api';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid, Legend } from 'recharts';
import { FaWindows, FaLinux } from 'react-icons/fa';

const MITRE_MAPPING = {
    '4624': { tactic: 'Initial Access', technique: 'T1078 (Valid Accounts)', color: 'rgba(16, 185, 129, 0.2)', text: '#10b981', label: 'Success Logon' },
    '4625': { tactic: 'Credential Access', technique: 'T1110 (Brute Force)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Failed Logon' },
    '4648': { tactic: 'Lateral Movement', technique: 'T1078 (Explicit Creds)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Explicit Logon' },
    '4672': { tactic: 'Privilege Escalation', technique: 'T1078 (Special Privs)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b', label: 'Admin Privilege' },
    '4720': { tactic: 'Persistence', technique: 'T1136 (Create Account)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b', label: 'User Created' },
    '4722': { tactic: 'Persistence', technique: 'T1098 (Enable Account)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b', label: 'User Enabled' },
    '4724': { tactic: 'Credential Access', technique: 'T1098 (Reset Password)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Password Reset' },
    '4726': { tactic: 'Impact', technique: 'T1531 (Delete Account)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'User Deleted' },
    '4728': { tactic: 'Persistence', technique: 'T1098 (Global Group Member)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Group Member Added' },
    '4732': { tactic: 'Privilege Escalation', technique: 'T1098 (Admin Group Member)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Admin Group Member' },
    '4738': { tactic: 'Persistence', technique: 'T1098 (Account Modified)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b', label: 'Account Modified' },
    '4740': { tactic: 'Initial Access', technique: 'T1110 (Account Lockout)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b', label: 'Account Locked' },
    '4756': { tactic: 'Persistence', technique: 'T1098 (Universal Group)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Universal Group Added' },
    '4719': { tactic: 'Defense Evasion', technique: 'T1562 (Audit Policy)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Audit Policy Changed' },
    '1102': { tactic: 'Defense Evasion', technique: 'T1070 (Clear Security Log)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Security Log Cleared' },
    '104': { tactic: 'Defense Evasion', technique: 'T1070 (Clear System Log)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'System Log Cleared' },
    '7045': { tactic: 'Persistence', technique: 'T1543 (Service Installed)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'New Service Created' },
    '7031': { tactic: 'Service Crash', technique: 'Availability (Crash)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Service Crashed' },
    '7034': { tactic: 'Service Crash', technique: 'Availability (Crash)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Service Terminated' },
    '41': { tactic: 'System Crash', technique: 'Availability (BSOD)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Kernel BSOD Crash' },
    '6008': { tactic: 'System Crash', technique: 'Availability (Unexpected Off)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444', label: 'Unexpected Shutdown' },
    '4698': { tactic: 'Execution', technique: 'T1053 (Scheduled Task)', color: 'rgba(139, 92, 246, 0.2)', text: '#8b5cf6', label: 'Scheduled Task Created' }
};

const LOGON_TYPES = {
    '2': { name: 'Interactive', badge: '💻 Console (Type 2)', color: '#3b82f6' },
    '3': { name: 'Network', badge: '🌐 Network (Type 3)', color: '#8b5cf6' },
    '4': { name: 'Batch', badge: '⚙️ Batch (Type 4)', color: '#6b7280' },
    '5': { name: 'Service', badge: '🤖 Service (Type 5)', color: '#6b7280' },
    '7': { name: 'Unlock', badge: '🔓 Unlock (Type 7)', color: '#10b981' },
    '10': { name: 'RemoteInteractive', badge: '🚨 RDP Remote (Type 10)', color: '#ef4444' },
    '11': { name: 'CachedInteractive', badge: '💾 Cached (Type 11)', color: '#f59e0b' }
};

function parseEventData(rawStr) {
    if (!rawStr) return {};
    try {
        const raw = typeof rawStr === 'string' ? JSON.parse(rawStr) : rawStr;
        const fields = {};
        if (raw && raw.EventData) {
            if (Array.isArray(raw.EventData.Data)) {
                raw.EventData.Data.forEach(d => {
                    if (d && d['@Name']) fields[d['@Name']] = d['#text'] || '';
                });
            } else if (typeof raw.EventData === 'object') {
                Object.assign(fields, raw.EventData);
            }
        }
        return fields;
    } catch (e) {
        return {};
    }
}

const S = {
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 24 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' },
    cardBody: { padding: '20px 24px' },
    th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    input: { padding: '8px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnS: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 },
    grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginBottom: 24 },
    titleInfo: { color: 'var(--text-muted)', fontSize: 14, marginTop: 4 },
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 720, overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.5)' },
    modalHead: { padding: '20px 28px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    modalTitle: { fontSize: 17, fontWeight: 900, margin: 0, color: 'var(--text-primary)' },
    modalBody: { padding: '24px 28px', maxHeight: '65vh', overflowY: 'auto' }
};

export default function SiemLocalDashboard() {
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState(null);
    const [timeRange, setTimeRange] = useState(24);
    const [generating, setGenerating] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedEvent, setSelectedEvent] = useState(null);
    const [widgetPrefs, setWidgetPrefs] = useState(() => {
        try {
            const saved = localStorage.getItem('siem_widget_prefs');
            return saved ? JSON.parse(saved) : { trend: true, topHosts: true, topEventIds: true, criticalWin: true, criticalLin: true };
        } catch (e) {
            return { trend: true, topHosts: true, topEventIds: true, criticalWin: true, criticalLin: true };
        }
    });
    const [showWidgetConfig, setShowWidgetConfig] = useState(false);

    const toggleWidget = (key) => {
        setWidgetPrefs(prev => {
            const next = { ...prev, [key]: !prev[key] };
            localStorage.setItem('siem_widget_prefs', JSON.stringify(next));
            return next;
        });
    };

    useEffect(() => {
        const handler = setTimeout(() => {
            fetchStats(searchTerm);
        }, 300);
        return () => clearTimeout(handler);
    }, [timeRange, searchTerm]);

    const fetchStats = async (query = searchTerm) => {
        try {
            setLoading(true);
            const searchParam = query && query.trim() ? `&search=${encodeURIComponent(query.trim())}` : '';
            const res = await api.get(`/monitor-siem/local-stats?hours=${timeRange}${searchParam}`);
            setStats(res.data.stats);
        } catch (error) {
            console.error('Failed to fetch SIEM local stats', error);
        } finally {
            setLoading(false);
        }
    };

    const generateReport = async () => {
        try {
            setGenerating(true);
            const endTime = new Date().toISOString();
            const startTime = new Date(Date.now() - timeRange * 60 * 60 * 1000).toISOString();

            const res = await api.post('/monitor-siem/generate-report', {
                startTime,
                endTime,
                reportType: 'OnDemand'
            });

            alert(`Report Generated Successfully! Report ID: ${res.data.reportId}`);
        } catch (error) {
            alert('Failed to generate report');
        } finally {
            setGenerating(false);
        }
    };

    if (loading && !stats) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading Analytics...</div>;
    if (!stats) return <div style={{ padding: 32, textAlign: 'center', color: '#ef4444' }}>Failed to load Analytics.</div>;

    const winColors = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

    return (
        <div style={{ animation: 'fadeIn 0.3s ease' }}>
            {/* Header and Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
                <div>
                    <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>SIEM Local Analytics</h2>
                    <div style={S.titleInfo}>Native Log Engine | Threat Intelligence & MITRE ATT&CK Mapping</div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <input
                        type="text"
                        placeholder="Search host, Event ID, user..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        style={{ ...S.input, width: 250 }}
                    />
                    {searchTerm && (
                        <button 
                            style={{ ...S.btnS, padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }} 
                            onClick={() => setSearchTerm('')}
                            title="Clear search"
                        >
                            ✕ Clear
                        </button>
                    )}
                    <select value={timeRange} onChange={e => setTimeRange(Number(e.target.value))} style={S.input}>
                        <option value={1}>Last 1 Hour</option>
                        <option value={24}>Last 24 Hours</option>
                        <option value={168}>Last 7 Days</option>
                        <option value={720}>Last 30 Days</option>
                        <option value={0}>All Time</option>
                    </select>
                    <button style={S.btnS} onClick={() => setShowWidgetConfig(!showWidgetConfig)}>
                        ⚙️ Widgets ▾
                    </button>
                    <button style={S.btnP} onClick={generateReport} disabled={generating || loading}>
                        {generating ? 'Generating...' : 'Export PDF Report'}
                    </button>
                </div>
            </div>

            {/* Customize Widgets Modal */}
            {showWidgetConfig && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999, display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={() => setShowWidgetConfig(false)}>
                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 16, padding: '24px 28px', minWidth: 320, maxWidth: 420, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 16px 0', fontSize: 16, fontWeight: 800, textAlign: 'left', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>⚙️ Customize Dashboard Widgets</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start', padding: '4px 0' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                                <input type="checkbox" checked={!!widgetPrefs.trend} onChange={() => toggleWidget('trend')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                                <span style={{ fontWeight: 600 }}>Event Activity Trend Chart</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                                <input type="checkbox" checked={!!widgetPrefs.topHosts} onChange={() => toggleWidget('topHosts')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                                <span style={{ fontWeight: 600 }}>Top Event Sources Chart</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                                <input type="checkbox" checked={!!widgetPrefs.topEventIds} onChange={() => toggleWidget('topEventIds')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                                <span style={{ fontWeight: 600 }}>Top Windows Security Event IDs</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                                <input type="checkbox" checked={!!widgetPrefs.criticalWin} onChange={() => toggleWidget('criticalWin')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                                <span style={{ fontWeight: 600 }}>Recent Critical Windows Events</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                                <input type="checkbox" checked={!!widgetPrefs.criticalLin} onChange={() => toggleWidget('criticalLin')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                                <span style={{ fontWeight: 600 }}>Recent Auth/Security Linux Logs</span>
                            </label>
                        </div>
                        <div style={{ marginTop: 24, textAlign: 'right' }}>
                            <button style={S.btnP} onClick={() => setShowWidgetConfig(false)}>Save & Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Trend Chart */}
            {widgetPrefs.trend && stats.trendData && stats.trendData.length > 0 && (
                <div style={S.card}>
                    <div style={S.cardHead}>Event Activity Trend</div>
                    <div style={{ ...S.cardBody, height: 250 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={stats.trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="colorWin" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="colorLin" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={11} tickFormatter={(timeStr) => {
                                    const d = new Date(timeStr);
                                    return timeRange <= 1 ? `${d.getHours()}:${d.getMinutes()}` : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}h`;
                                }} />
                                <YAxis stroke="var(--text-muted)" fontSize={11} />
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                <Tooltip contentStyle={{ background: '#000', border: '1px solid #333', borderRadius: 8 }} />
                                <Legend verticalAlign="top" height={36} />
                                <Area type="monotone" dataKey="windows" stroke="#3b82f6" fillOpacity={1} fill="url(#colorWin)" name="Windows Events" />
                                <Area type="monotone" dataKey="linux" stroke="#f59e0b" fillOpacity={1} fill="url(#colorLin)" name="Linux Syslogs" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Quick Metrics */}
            <div style={S.gridRow}>
                <div style={{ ...S.card, marginBottom: 0, borderLeft: '4px solid #3b82f6', padding: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Windows Events Captured</div>
                        <div style={{ fontSize: 36, fontWeight: 900, color: 'var(--text-primary)' }}>{stats.windows.total.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 48, opacity: 0.2, color: '#3b82f6' }}><FaWindows /></div>
                </div>
                <div style={{ ...S.card, marginBottom: 0, borderLeft: '4px solid #10b981', padding: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Linux Syslogs Captured</div>
                        <div style={{ fontSize: 36, fontWeight: 900, color: 'var(--text-primary)' }}>{stats.linux.total.toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 48, opacity: 0.2, color: '#eab308' }}><FaLinux /></div>
                </div>
            </div>

            {/* Charts Row */}
            <div style={S.gridRow}>
                {widgetPrefs.topHosts && (
                    <div style={{ ...S.card, marginBottom: 0 }}>
                        <div style={S.cardHead}>🪟 Top Windows Event Sources</div>
                        <div style={{ ...S.cardBody, height: 280 }}>
                            {stats.windows.topHosts.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={stats.windows.topHosts} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                        <XAxis type="number" stroke="var(--text-muted)" fontSize={12} />
                                        <YAxis dataKey="host" type="category" width={100} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} stroke="transparent" />
                                        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                        <Bar dataKey="count" radius={[0, 4, 4, 0]} onClick={(entry) => setSearchTerm(entry.host)} style={{ cursor: 'pointer' }}>
                                            {stats.windows.topHosts.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={winColors[index % winColors.length]} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : (
                                <div style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingTop: 100 }}>No data available in this time range.</div>
                            )}
                        </div>
                    </div>
                )}

                {widgetPrefs.topEventIds && (
                    <div style={{ ...S.card, marginBottom: 0 }}>
                        <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>🛡️ Top Windows Event IDs & MITRE Tactics</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 'normal' }}>Click bar to filter</span>
                        </div>
                        <div style={{ ...S.cardBody, height: 280 }}>
                            {stats.windows.topEventIds && stats.windows.topEventIds.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={stats.windows.topEventIds.map(e => ({
                                        ...e,
                                        displayLabel: `${e.eventID} (${MITRE_MAPPING[e.eventID]?.tactic || 'General'})`
                                    }))} layout="vertical" margin={{ top: 5, right: 30, left: 30, bottom: 5 }}>
                                        <XAxis type="number" stroke="var(--text-muted)" fontSize={12} />
                                        <YAxis dataKey="displayLabel" type="category" width={130} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="transparent" />
                                        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                        <Bar dataKey="count" radius={[0, 4, 4, 0]} onClick={(entry) => setSearchTerm(entry.eventID.toString())} style={{ cursor: 'pointer' }}>
                                            {stats.windows.topEventIds.map((entry, index) => (
                                                <Cell key={`cell-ev-${index}`} fill={MITRE_MAPPING[entry.eventID]?.text || winColors[index % winColors.length]} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : (
                                <div style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingTop: 100 }}>No event data available.</div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Tables Row */}
            <div style={S.gridRow}>
                {widgetPrefs.criticalWin && (
                    <div style={{ ...S.card, marginBottom: 0, overflow: 'hidden' }}>
                        <div style={{ ...S.cardHead, color: searchTerm ? 'var(--accent-primary)' : '#ef4444', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>
                                {searchTerm ? `🔍 Search Results: "${searchTerm}" (${stats.windows.recentCritical.length} found)` : '🚨 Recent Critical & Security Windows Events'}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 'normal' }}>Click row for full forensics</span>
                        </div>
                        <div style={{ overflowY: 'auto', maxHeight: 380 }}>
                            {stats.windows.recentCritical.length > 0 ? (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>Time</th>
                                            <th style={S.th}>Host</th>
                                            <th style={S.th}>EventID & Tactic</th>
                                            <th style={S.th}>Logon / Summary</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {stats.windows.recentCritical.map((ev) => {
                                            const fields = parseEventData(ev.raw);
                                            const logonType = fields.LogonType;
                                            const logonInfo = LOGON_TYPES[logonType];
                                            const mitre = MITRE_MAPPING[ev.eventID];

                                            return (
                                                <tr 
                                                    key={ev.id} 
                                                    style={{ cursor: 'pointer', transition: 'background 0.2s' }} 
                                                    onClick={() => setSelectedEvent(ev)}
                                                    className="hover-highlight"
                                                >
                                                    <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(ev.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                                    <td style={{ ...S.td, fontWeight: 700 }}>{ev.host}</td>
                                                    <td style={{ ...S.td }}>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800 }}>
                                                                <span>{ev.eventID}</span>
                                                                {mitre && (
                                                                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: mitre.color, color: mitre.text, fontWeight: 800 }}>
                                                                        {mitre.tactic}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {mitre && mitre.technique && (
                                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{mitre.technique}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td style={{ ...S.td, fontSize: 12 }}>
                                                        {logonInfo && (
                                                            <span style={{ ...S.badge, background: 'rgba(239,68,68,0.15)', color: logonInfo.color, marginRight: 6 }}>
                                                                {logonInfo.badge}
                                                            </span>
                                                        )}
                                                        {fields.TargetUserName && (
                                                            <span style={{ fontWeight: 600, color: 'var(--accent-primary)', marginRight: 6 }}>
                                                                👤 {fields.TargetUserName}
                                                            </span>
                                                        )}
                                                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                                            {ev.message ? (ev.message.length > 50 ? ev.message.substring(0, 50) + '...' : ev.message) : '-'}
                                                        </span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            ) : (
                                <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
                                    {searchTerm ? `No events matching "${searchTerm}" in selected time range.` : 'No critical events found.'}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {widgetPrefs.criticalLin && (
                    <div style={{ ...S.card, marginBottom: 0, overflow: 'hidden' }}>
                        <div style={{ ...S.cardHead, color: searchTerm ? 'var(--accent-primary)' : '#ef4444' }}>
                            {searchTerm ? `🔍 Linux Search Results: "${searchTerm}" (${stats.linux.recentCritical.length} found)` : '🚨 Recent Auth/Security Linux Logs'}
                        </div>
                        <div style={{ overflowY: 'auto', maxHeight: 380 }}>
                            {stats.linux.recentCritical.length > 0 ? (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>Time</th>
                                            <th style={S.th}>Host</th>
                                            <th style={S.th}>Message</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {stats.linux.recentCritical.map((ev) => (
                                            <tr key={ev.id}>
                                                <td style={{ ...S.td, whiteSpace: 'nowrap', verticalAlign: 'top', fontSize: 12 }}>{new Date(ev.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                                <td style={{ ...S.td, fontWeight: 700, verticalAlign: 'top' }}>{ev.host}</td>
                                                <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                                                    {ev.message.substring(0, 100)}{ev.message.length > 100 ? '...' : ''}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
                                    {searchTerm ? `No linux logs matching "${searchTerm}" in selected time range.` : 'No security logs found.'}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Event Detail / Forensics Modal */}
            {selectedEvent && (
                <div style={S.modalOverlay} onClick={() => setSelectedEvent(null)}>
                    <div style={S.modalContent} onClick={e => e.stopPropagation()}>
                        <div style={S.modalHead}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <h3 style={S.modalTitle}>
                                    🛡️ Event Forensics: Event ID {selectedEvent.eventID}
                                </h3>
                                {MITRE_MAPPING[selectedEvent.eventID] && (
                                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: MITRE_MAPPING[selectedEvent.eventID].color, color: MITRE_MAPPING[selectedEvent.eventID].text, fontWeight: 800 }}>
                                        {MITRE_MAPPING[selectedEvent.eventID].tactic} ({MITRE_MAPPING[selectedEvent.eventID].technique})
                                    </span>
                                )}
                            </div>
                            <button onClick={() => setSelectedEvent(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={S.modalBody}>
                            {/* Summary Pills */}
                            {(() => {
                                const fields = parseEventData(selectedEvent.raw);
                                const logonType = fields.LogonType;
                                const logonInfo = LOGON_TYPES[logonType];

                                return (
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20, padding: 14, background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Target Host:</strong> <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedEvent.host}</div></div>
                                        <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Event Timestamp:</strong> <div style={{ fontSize: 13 }}>{new Date(selectedEvent.timestamp).toLocaleString()}</div></div>
                                        {fields.TargetUserName && (
                                            <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Target Account:</strong> <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent-primary)' }}>👤 {fields.TargetUserName}</div></div>
                                        )}
                                        {fields.IpAddress && fields.IpAddress !== '-' && (
                                            <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Source IP:</strong> <div style={{ fontSize: 13, fontWeight: 800, color: '#f59e0b' }}>🌐 {fields.IpAddress}</div></div>
                                        )}
                                        {logonInfo && (
                                            <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Logon Type:</strong> <div style={{ fontSize: 13, fontWeight: 800, color: logonInfo.color }}>{logonInfo.badge}</div></div>
                                        )}
                                        <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Channel / Provider:</strong> <div style={{ fontSize: 13 }}>{selectedEvent.provider || 'Security'}</div></div>
                                    </div>
                                );
                            })()}

                            <div style={{ marginBottom: 16 }}>
                                <strong style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' }}>Formatted Message:</strong>
                                <div style={{ fontSize: 13, background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8, marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                    {selectedEvent.message || 'No formatted message provided.'}
                                </div>
                            </div>

                            <div>
                                <strong style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' }}>Raw Event Payload:</strong>
                                <pre style={{ fontSize: 11, background: '#111', padding: 12, borderRadius: 8, marginTop: 4, overflowX: 'auto', color: '#10b981', maxHeight: 200 }}>
                                    {JSON.stringify(JSON.parse(selectedEvent.raw || '{}'), null, 2)}
                                </pre>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
