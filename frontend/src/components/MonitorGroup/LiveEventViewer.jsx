import React, { useState, useEffect } from 'react';
import SiemLocalDashboard from './SiemLocalDashboard';
import OnDemandForensics from './OnDemandForensics';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%', position: 'relative' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    tabRow: { display: 'flex', gap: 24, borderBottom: '1px solid var(--border-color)', marginBottom: 24 },
    tabActive: { padding: '12px 16px', cursor: 'pointer', borderBottom: '2px solid var(--accent-primary)', color: 'var(--text-primary)', fontWeight: 800, background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none', fontSize: 15 },
    tabInactive: { padding: '12px 16px', cursor: 'pointer', borderBottom: '2px solid transparent', color: 'var(--text-muted)', fontWeight: 500, background: 'none', border: 'none', fontSize: 15 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800 },
    cardBody: { padding: '20px 24px' },
    th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    input: { padding: '10px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 13, outline: 'none', minWidth: 260 },
    // Modal
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 700, overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' },
    modalHead: { padding: '24px 32px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between' },
    modalTitle: { fontSize: 18, fontWeight: 800, margin: 0, color: 'var(--text-primary)' },
    modalBody: { padding: '32px', maxHeight: '60vh', overflowY: 'auto' },
};

const MITRE_MAPPING = {
    '4624': { tactic: 'Initial Access', technique: 'T1078 (Valid Accounts)', color: 'rgba(16, 185, 129, 0.2)', text: '#10b981' },
    '4625': { tactic: 'Credential Access', technique: 'T1110 (Brute Force)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4648': { tactic: 'Lateral Movement', technique: 'T1078 (Explicit Creds)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4672': { tactic: 'Privilege Escalation', technique: 'T1078 (Special Privs)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b' },
    '4720': { tactic: 'Persistence', technique: 'T1136 (Create Account)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b' },
    '4722': { tactic: 'Persistence', technique: 'T1098 (Enable Account)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b' },
    '4724': { tactic: 'Credential Access', technique: 'T1098 (Reset Password)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4726': { tactic: 'Impact', technique: 'T1531 (Delete Account)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4728': { tactic: 'Persistence', technique: 'T1098 (Global Group Member)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4732': { tactic: 'Privilege Escalation', technique: 'T1098 (Admin Group Member)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4738': { tactic: 'Persistence', technique: 'T1098 (Account Modified)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b' },
    '4740': { tactic: 'Initial Access', technique: 'T1110 (Account Lockout)', color: 'rgba(245, 158, 11, 0.2)', text: '#f59e0b' },
    '4756': { tactic: 'Persistence', technique: 'T1098 (Universal Group)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4719': { tactic: 'Defense Evasion', technique: 'T1562 (Audit Policy)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '1102': { tactic: 'Defense Evasion', technique: 'T1070 (Clear Security Log)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '104': { tactic: 'Defense Evasion', technique: 'T1070 (Clear System Log)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '7045': { tactic: 'Persistence', technique: 'T1543 (Service Installed)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '7031': { tactic: 'Service Crash', technique: 'Availability (Crash)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '7034': { tactic: 'Service Crash', technique: 'Availability (Crash)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '41': { tactic: 'System Crash', technique: 'Availability (BSOD)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '6008': { tactic: 'System Crash', technique: 'Availability (Unexpected Off)', color: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' },
    '4698': { tactic: 'Execution', technique: 'T1053 (Scheduled Task)', color: 'rgba(139, 92, 246, 0.2)', text: '#8b5cf6' }
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

export default function LiveEventViewer() {
    const [activeTab, setActiveTab] = useState('windows');
    const [winEvents, setWinEvents] = useState([]);
    const [nixEvents, setNixEvents] = useState([]);
    const [liveTail, setLiveTail] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState(null);
    const [filterText, setFilterText] = useState('');

    useEffect(() => {
        let interval;
        const fetchEvents = () => {
            const searchParam = filterText && filterText.trim() ? `?search=${encodeURIComponent(filterText.trim())}` : '';
            const endpoint = activeTab === 'windows' 
                ? `/api/monitor/winevent/live${searchParam}` 
                : `/api/monitor/linuxlog/live${searchParam}`;
                
            fetch(endpoint, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            })
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    const cappedData = data.slice(0, 500);
                    if (activeTab === 'windows') {
                        setWinEvents(cappedData);
                    } else {
                        setNixEvents(cappedData);
                    }
                }
            })
            .catch(err => console.error('Failed to fetch live logs:', err));
        };

        fetchEvents();
        if (liveTail) {
            interval = setInterval(fetchEvents, 5000);
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [activeTab, liveTail, filterText]);

    const getLevelBadge = (level) => {
        switch(level) {
            case 'Error': case 'Critical': return <span style={{...S.badge, background: 'rgba(239,68,68,0.2)', color: '#ef4444'}}>ERROR</span>;
            case 'Warning': return <span style={{...S.badge, background: 'rgba(245,158,11,0.2)', color: '#f59e0b'}}>WARN</span>;
            default: return <span style={{...S.badge, background: 'rgba(59,130,246,0.2)', color: '#3b82f6'}}>INFO</span>;
        }
    };

    const currentEvents = activeTab === 'windows' ? winEvents : nixEvents;
    const filteredEvents = currentEvents.filter(ev => {
        if (!filterText.trim()) return true;
        const search = filterText.toLowerCase();
        return (
            (ev.host && ev.host.toLowerCase().includes(search)) ||
            (ev.eventID && ev.eventID.toString().includes(search)) ||
            (ev.message && ev.message.toLowerCase().includes(search)) ||
            (ev.provider && ev.provider.toLowerCase().includes(search)) ||
            (ev.filePath && ev.filePath.toLowerCase().includes(search))
        );
    });

    return (
        <div style={S.page}>
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>📺 Live Event Viewer</h1>
                    <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>Real-time aggregated stream of agent logging infrastructure.</div>
                </div>
                <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                    <input 
                        style={S.input} 
                        value={filterText} 
                        onChange={e => setFilterText(e.target.value)} 
                        placeholder="Filter by host, Event ID, message..." 
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', userSelect: 'none', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={liveTail} onChange={e => setLiveTail(e.target.checked)} style={{ cursor: 'pointer' }} />
                        Live Tail (5s)
                    </label>
                </div>
            </div>

            <div style={S.tabRow}>
                <button 
                    style={activeTab === 'windows' ? S.tabActive : S.tabInactive} 
                    onClick={() => { setActiveTab('windows'); setFilterText(''); }}
                >
                    Windows Event Logs
                </button>
                <button 
                    style={activeTab === 'linux' ? S.tabActive : S.tabInactive} 
                    onClick={() => { setActiveTab('linux'); setFilterText(''); }}
                >
                    Linux System Logs
                </button>
                <button 
                    style={activeTab === 'siem_analytics' ? S.tabActive : S.tabInactive} 
                    onClick={() => { setActiveTab('siem_analytics'); setFilterText(''); }}
                >
                    🚨 SIEM Analytics
                </button>
                <button 
                    style={activeTab === 'forensics' ? S.tabActive : S.tabInactive} 
                    onClick={() => { setActiveTab('forensics'); setFilterText(''); }}
                >
                    🔍 On-Demand Forensics
                </button>
            </div>

            {activeTab === 'siem_analytics' && (
                <SiemLocalDashboard />
            )}

            {activeTab === 'forensics' && (
                <OnDemandForensics />
            )}

            {activeTab !== 'siem_analytics' && activeTab !== 'forensics' && (
            <div style={S.card}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            {activeTab === 'windows' ? (
                                <tr>
                                    <th style={S.th}>Timestamp</th>
                                    <th style={S.th}>Host</th>
                                    <th style={S.th}>Level</th>
                                    <th style={S.th}>Event ID & MITRE</th>
                                    <th style={S.th}>Provider</th>
                                    <th style={S.th}>Message Preview</th>
                                </tr>
                            ) : (
                                <tr>
                                    <th style={S.th}>Timestamp</th>
                                    <th style={S.th}>Host</th>
                                    <th style={S.th}>Format</th>
                                    <th style={S.th}>File Path</th>
                                    <th style={S.th}>Tags</th>
                                    <th style={S.th}>Message</th>
                                </tr>
                            )}
                        </thead>
                        <tbody>
                            {filteredEvents.length === 0 ? (
                                <tr>
                                    <td colSpan={6} style={{...S.td, textAlign: 'center', color: 'var(--text-muted)'}}>
                                        No matching events found. Listening for stream...
                                    </td>
                                </tr>
                            ) : filteredEvents.map(ev => {
                                const mitre = activeTab === 'windows' ? MITRE_MAPPING[ev.eventID] : null;

                                return (
                                    <tr key={ev.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedEvent(ev)} className="hover-highlight">
                                        {activeTab === 'windows' ? (
                                            <>
                                                <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                                                <td style={{ ...S.td, fontWeight: 700 }}>{ev.host}</td>
                                                <td style={S.td}>{getLevelBadge(ev.level)}</td>
                                                <td style={S.td}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800 }}>
                                                        <span>{ev.eventID}</span>
                                                        {mitre && (
                                                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: mitre.color, color: mitre.text, fontWeight: 800 }}>
                                                                {mitre.tactic}
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ ...S.td, fontSize: 12 }}>{ev.provider}</td>
                                                <td style={{...S.td, color: 'var(--text-muted)', fontSize: 12}}>
                                                    {ev.message ? (ev.message.length > 80 ? ev.message.substring(0, 80) + '...' : ev.message) : '-'}
                                                </td>
                                            </>
                                        ) : (
                                            <>
                                                <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                                                <td style={{ ...S.td, fontWeight: 700 }}>{ev.host}</td>
                                                <td style={S.td}><span style={{...S.badge, background: 'rgba(16,185,129,0.2)', color: '#10b981'}}>{ev.format.toUpperCase()}</span></td>
                                                <td style={{ ...S.td, fontSize: 12 }}>{ev.filePath}</td>
                                                <td style={{ ...S.td, fontSize: 12 }}>{ev.tags ? ev.tags : '-'}</td>
                                                <td style={{...S.td, color: 'var(--text-muted)', fontSize: 12}}>
                                                    {ev.message ? (ev.message.length > 80 ? ev.message.substring(0, 80) + '...' : ev.message) : '-'}
                                                </td>
                                            </>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
            )}

            {selectedEvent && (
                <div style={S.modalOverlay} onClick={() => setSelectedEvent(null)}>
                    <div style={S.modalContent} onClick={e => e.stopPropagation()}>
                        <div style={S.modalHead}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <h3 style={S.modalTitle}>
                                    {activeTab === 'windows' ? `🛡️ Windows Event: ${selectedEvent.eventID}` : `🐧 Linux Log Entry`}
                                </h3>
                                {activeTab === 'windows' && MITRE_MAPPING[selectedEvent.eventID] && (
                                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: MITRE_MAPPING[selectedEvent.eventID].color, color: MITRE_MAPPING[selectedEvent.eventID].text, fontWeight: 800 }}>
                                        {MITRE_MAPPING[selectedEvent.eventID].tactic} ({MITRE_MAPPING[selectedEvent.eventID].technique})
                                    </span>
                                )}
                            </div>
                            <button onClick={() => setSelectedEvent(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={S.modalBody}>
                            {/* Summary Pills for Windows */}
                            {activeTab === 'windows' ? (() => {
                                const fields = parseEventData(selectedEvent.raw);
                                const logonType = fields.LogonType;
                                const logonInfo = LOGON_TYPES[logonType];

                                return (
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20, padding: 14, background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Target Host:</strong> <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedEvent.host}</div></div>
                                        <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Timestamp:</strong> <div style={{ fontSize: 13 }}>{new Date(selectedEvent.timestamp).toLocaleString()}</div></div>
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
                            })() : (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20, padding: 14, background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                    <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Host:</strong> <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedEvent.host}</div></div>
                                    <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Timestamp:</strong> <div style={{ fontSize: 13 }}>{new Date(selectedEvent.timestamp).toLocaleString()}</div></div>
                                    <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>File Path:</strong> <div style={{ fontSize: 13, fontFamily: 'monospace' }}>{selectedEvent.filePath}</div></div>
                                    <div><strong style={{ color: 'var(--text-muted)', fontSize: 11 }}>Format:</strong> <div style={{ fontSize: 13 }}><span style={{ ...S.badge, background: 'rgba(16,185,129,0.2)', color: '#10b981' }}>{selectedEvent.format?.toUpperCase()}</span></div></div>
                                </div>
                            )}

                            <div style={{ marginBottom: 16 }}>
                                <strong style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' }}>Message Content:</strong>
                                <div style={{ fontSize: 13, background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8, marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                    {selectedEvent.message || '-'}
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
