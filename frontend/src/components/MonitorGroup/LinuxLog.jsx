import React, { useState, useEffect } from 'react';
import { useToast } from '../../contexts/ToastContext';

const S = {
    page: { padding: '0', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', position: 'relative' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 20, fontWeight: 900, margin: 0 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, display: 'flex', justifyContent: 'space-between' },
    cardBody: { padding: '20px 24px' },
    inputGroup: { marginBottom: 20 },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' },
    input: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    select: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    btnP: { padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnS: { padding: '6px 14px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    btnDanger: { padding: '6px 14px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer' }
};

export default function LinuxLog() {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isViewer = user?.role === 'Viewer';

    const [backendRules, setBackendRules] = useState([]);
    const [policyCollapsed, setPolicyCollapsed] = useState(false);
    const [outputTab, setOutputTab] = useState('elasticsearch');
    const [watchersCollapsed, setWatchersCollapsed] = useState(true);
    const [esPushPolicy, setEsPushPolicy] = useState({
        elasticsearchEnabled: false,
        logEnabled: true,
        url: '',
        username: '',
        password: '',
        logIndexName: '',
        metricsEnabled: false,
        metricsIndexName: '',
        rules: []
    });

    useEffect(() => {
        // Load backend policy
        fetch('/api/monitor/linuxlog/policy', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        })
        .then(res => res.json())
        .then(data => {
            if (Array.isArray(data) && data.length > 0) {
                setBackendRules(data);
            } else {
                setBackendRules([
                    { filePath: '/var/log/auth.log', format: 'syslog', tags: 'auth, security', includeRegex: '', excludeRegex: '' },
                    { filePath: '/var/log/syslog', format: 'syslog', tags: 'system', includeRegex: '', excludeRegex: '' },
                    { filePath: '/var/log/audit/audit.log', format: 'auditd', tags: 'auditd', includeRegex: '', excludeRegex: '' }
                ]);
            }
        })
        .catch(err => console.error('Failed to load linux log policy:', err));

        // Load push policy
        fetch('/api/monitor/linuxlog/push_policy', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        })
        .then(res => res.json())
        .then(data => {
            if (data && typeof data === 'object') {
                setEsPushPolicy({
                    elasticsearchEnabled: !!data.elasticsearchEnabled,
                    url: data.url || '',
                    username: data.username || '',
                    password: data.password || '',
                    logIndexName: data.logIndexName || '',
                    metricsEnabled: !!data.metricsEnabled,
                    metricsIndexName: data.metricsIndexName || '',
                    rules: data.rules || []
                });
            }
        })
        .catch(err => console.error('Failed to load linux log ES push policy:', err));
    }, []);

    const handleDeployPolicy = async () => {
        if (isViewer) {
            showToast('Viewers cannot deploy policies', 'error');
            return;
        }

        try {
            // Save backend policy
            const res1 = await fetch('/api/monitor/linuxlog/policy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(backendRules)
            });
            const data1 = await res1.json();
            if (data1.error) {
                showToast(`Failed to deploy Backend policy: ${data1.error}`, 'error');
                return;
            }

            // Save ES push policy
            const res2 = await fetch('/api/monitor/linuxlog/push_policy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(esPushPolicy)
            });
            const data2 = await res2.json();
            if (data2.error) {
                showToast(`Failed to deploy Elasticsearch policy: ${data2.error}`, 'error');
                return;
            }

            showToast('All Linux Log Policies deployed successfully to Agent', 'success');
        } catch (err) {
            showToast('Failed to deploy policies to Agent', 'error');
        }
    };

    // Rule helpers for Backend Rules
    const addBackendRule = () => {
        setBackendRules([...backendRules, { filePath: '/var/log/', format: 'syslog', tags: '', includeRegex: '', excludeRegex: '' }]);
    };
    const removeBackendRule = (idx) => {
        setBackendRules(backendRules.filter((_, i) => i !== idx));
    };
    const updateBackendRule = (idx, field, value) => {
        const newRules = [...backendRules];
        newRules[idx][field] = value;
        setBackendRules(newRules);
    };

    // Rule helpers for ES Push Rules
    const addEsRule = () => {
        setEsPushPolicy({
            ...esPushPolicy,
            rules: [...(esPushPolicy.rules || []), { filePath: '/var/log/', format: 'syslog', tags: '', includeRegex: '', excludeRegex: '' }]
        });
    };
    const removeEsRule = (idx) => {
        setEsPushPolicy({
            ...esPushPolicy,
            rules: esPushPolicy.rules.filter((_, i) => i !== idx)
        });
    };
    const updateEsRule = (idx, field, value) => {
        const newRules = [...(esPushPolicy.rules || [])];
        newRules[idx][field] = value;
        setEsPushPolicy({
            ...esPushPolicy,
            rules: newRules
        });
    };

    return (
        <div style={S.page}>
            {/* Card 1: Log Subscription Policy Builder (Backend) */}
            <div style={S.card}>
                <div 
                    style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                    onClick={() => setPolicyCollapsed(!policyCollapsed)}
                >
                    <span>Configure Log Subscription Policy {policyCollapsed ? '▼' : '▲'}</span>
                    <div style={{ display: 'flex', gap: 12 }}>
                        {!isViewer && !policyCollapsed && (
                            <button 
                                style={{ padding: '6px 16px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 12, fontWeight: 800, cursor: 'pointer' }} 
                                onClick={e => { e.stopPropagation(); addBackendRule(); }}
                            >
                                + Add File
                            </button>
                        )}
                    </div>
                </div>
                
                {!policyCollapsed && (
                    <div style={S.cardBody}>
                        <div style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 13 }}>
                            Logs configured here are collected by the local Linux Agent and securely forwarded back to the central Vanguard Backend. The logs will be queryable via the Live Event Viewer.
                        </div>

                        {backendRules.map((rule, idx) => (
                            <div key={idx} style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 12, marginBottom: 16, position: 'relative', border: '1px solid var(--border-color)' }}>
                                {backendRules.length > 1 && !isViewer && (
                                    <button 
                                        onClick={() => removeBackendRule(idx)} 
                                        style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 20, fontSize: 11, fontWeight: 800, padding: '4px 12px', cursor: 'pointer' }}
                                    >
                                        Delete
                                    </button>
                                )}
                                <h4 style={{ margin: '0 0 16px 0', color: 'var(--accent-primary)' }}>Rule #{idx + 1}</h4>
                                <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                                    <div style={{ flex: 2 }}>
                                        <label style={S.label}>File Path</label>
                                        <input style={S.input} value={rule.filePath} onChange={e => updateBackendRule(idx, 'filePath', e.target.value)} placeholder="e.g. /var/log/auth.log" disabled={isViewer} />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={S.label}>Format</label>
                                        <select style={S.select} value={rule.format} onChange={e => updateBackendRule(idx, 'format', e.target.value)} disabled={isViewer}>
                                            <option value="syslog">Syslog</option>
                                            <option value="auditd">Auditd</option>
                                            <option value="json">JSON</option>
                                            <option value="raw">Raw Text</option>
                                        </select>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={S.label}>Tags (comma separated)</label>
                                        <input style={S.input} value={rule.tags} onChange={e => updateBackendRule(idx, 'tags', e.target.value)} placeholder="auth, security" disabled={isViewer} />
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 16 }}>
                                    <div style={{ flex: 1 }}>
                                        <label style={S.label}>Include Regex (Optional)</label>
                                        <input style={S.input} value={rule.includeRegex} onChange={e => updateBackendRule(idx, 'includeRegex', e.target.value)} placeholder="e.g. Failed password" disabled={isViewer} />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={S.label}>Exclude Regex (Optional)</label>
                                        <input style={S.input} value={rule.excludeRegex} onChange={e => updateBackendRule(idx, 'excludeRegex', e.target.value)} placeholder="e.g. CRON" disabled={isViewer} />
                                    </div>
                                </div>
                            </div>
                        ))}
                        {backendRules.length === 0 && (
                            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                                No backend log files configured. Click "+ Add File" to start collecting.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Card 2: Advanced Output Routings (Elasticsearch/Kafka) */}
            <div style={S.card}>
                <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Configure Advanced Output Routings</span>
                </div>
                
                <div style={{ padding: '0 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: 24, marginTop: 12 }}>
                    <div 
                        style={{ padding: '12px 0', cursor: 'pointer', borderBottom: outputTab === 'elasticsearch' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: outputTab === 'elasticsearch' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: outputTab === 'elasticsearch' ? 800 : 500 }}
                        onClick={() => setOutputTab('elasticsearch')}
                    >
                        Elasticsearch (ELK)
                    </div>
                    <div 
                        style={{ padding: '12px 0', cursor: 'pointer', borderBottom: outputTab === 'kafka' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: outputTab === 'kafka' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: outputTab === 'kafka' ? 800 : 500 }}
                        onClick={() => setOutputTab('kafka')}
                    >
                        Kafka (Coming Soon)
                    </div>
                </div>

                {outputTab === 'elasticsearch' && (
                    <div style={S.cardBody}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                Logs configured here will be pushed directly from the Linux Agent to the target Elasticsearch cluster.
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: esPushPolicy.elasticsearchEnabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {esPushPolicy.elasticsearchEnabled ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={esPushPolicy.elasticsearchEnabled} onChange={e => setEsPushPolicy({...esPushPolicy, elasticsearchEnabled: e.target.checked})} disabled={isViewer} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: esPushPolicy.elasticsearchEnabled ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: esPushPolicy.elasticsearchEnabled ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 24, marginBottom: 24, opacity: esPushPolicy.elasticsearchEnabled ? 1 : 0.4, pointerEvents: esPushPolicy.elasticsearchEnabled ? 'auto' : 'none' }}>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Elasticsearch URL</label>
                                <input style={S.input} value={esPushPolicy.url} onChange={e => setEsPushPolicy({...esPushPolicy, url: e.target.value})} placeholder="http://localhost:9200" disabled={isViewer || !esPushPolicy.elasticsearchEnabled} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Username</label>
                                <input style={S.input} value={esPushPolicy.username} onChange={e => setEsPushPolicy({...esPushPolicy, username: e.target.value})} placeholder="elastic" disabled={isViewer || !esPushPolicy.elasticsearchEnabled} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Password</label>
                                <input style={S.input} type="password" value={esPushPolicy.password} onChange={e => setEsPushPolicy({...esPushPolicy, password: e.target.value})} placeholder="********" disabled={isViewer || !esPushPolicy.elasticsearchEnabled} />
                            </div>
                        </div>

                        {/* Sub-feature 1: Linux Log File Watchers Push */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 16, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
                            <div>
                                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>Linux Log File Watchers Push to ES</span>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Real-time streaming of target log files (syslog, nginx, auditd, auth.log, etc.) directly to Elasticsearch</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: (esPushPolicy.elasticsearchEnabled && esPushPolicy.logEnabled !== false) ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {esPushPolicy.logEnabled !== false ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={esPushPolicy.logEnabled !== false} onChange={e => setEsPushPolicy({...esPushPolicy, logEnabled: e.target.checked})} disabled={isViewer || !esPushPolicy.elasticsearchEnabled} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: (esPushPolicy.elasticsearchEnabled && esPushPolicy.logEnabled !== false) ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: (esPushPolicy.elasticsearchEnabled && esPushPolicy.logEnabled !== false) ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ ...S.inputGroup, opacity: (esPushPolicy.elasticsearchEnabled && esPushPolicy.logEnabled !== false) ? 1 : 0.4, pointerEvents: (esPushPolicy.elasticsearchEnabled && esPushPolicy.logEnabled !== false) ? 'auto' : 'none' }}>
                            <label style={S.label}>Linux Log Index Name (Optional)</label>
                            <input style={S.input} value={esPushPolicy.logIndexName || ''} onChange={e => setEsPushPolicy({...esPushPolicy, logIndexName: e.target.value})} placeholder="vanguard-linuxlog-%Y.%m.%d" disabled={isViewer || !esPushPolicy.elasticsearchEnabled || esPushPolicy.logEnabled === false} />
                            
                            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <button 
                                    type="button" 
                                    onClick={() => setWatchersCollapsed(!watchersCollapsed)} 
                                    style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 800, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                                >
                                    <span>{watchersCollapsed ? '▶' : '▼'}</span> Log File Watchers (Elasticsearch Push)
                                </button>
                                {!watchersCollapsed && (
                                    <button style={S.btnS} onClick={addEsRule} disabled={isViewer || !esPushPolicy.elasticsearchEnabled || esPushPolicy.logEnabled === false}>+ Add File</button>
                                )}
                            </div>
                            
                            {!watchersCollapsed && (
                                <div style={{ marginTop: 16 }}>
                                    {(esPushPolicy.rules || []).map((rule, idx) => (
                                        <div key={idx} style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 12, marginBottom: 16, position: 'relative', border: '1px solid var(--border-color)' }}>
                                            {esPushPolicy.rules.length > 1 && !isViewer && (
                                                <button 
                                                    onClick={() => removeEsRule(idx)} 
                                                    style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 20, fontSize: 11, fontWeight: 800, padding: '4px 12px', cursor: 'pointer' }}
                                                >
                                                    Delete
                                                </button>
                                            )}
                                            <h4 style={{ margin: '0 0 16px 0', color: 'var(--accent-primary)' }}>Rule #{idx + 1}</h4>
                                            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                                                <div style={{ flex: 2 }}>
                                                    <label style={S.label}>File Path</label>
                                                    <input style={S.input} value={rule.filePath} onChange={e => updateEsRule(idx, 'filePath', e.target.value)} placeholder="e.g. /var/log/nginx/access.log" disabled={isViewer} />
                                                </div>
                                                <div style={{ flex: 1 }}>
                                                    <label style={S.label}>Format</label>
                                                    <select style={S.select} value={rule.format} onChange={e => updateEsRule(idx, 'format', e.target.value)} disabled={isViewer}>
                                                        <option value="syslog">Syslog</option>
                                                        <option value="auditd">Auditd</option>
                                                        <option value="json">JSON</option>
                                                        <option value="raw">Raw Text</option>
                                                    </select>
                                                </div>
                                                <div style={{ flex: 1 }}>
                                                    <label style={S.label}>Tags (comma separated)</label>
                                                    <input style={S.input} value={rule.tags} onChange={e => updateEsRule(idx, 'tags', e.target.value)} placeholder="nginx, access" disabled={isViewer} />
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: 16 }}>
                                                <div style={{ flex: 1 }}>
                                                    <label style={S.label}>Include Regex (Optional)</label>
                                                    <input style={S.input} value={rule.includeRegex} onChange={e => updateEsRule(idx, 'includeRegex', e.target.value)} placeholder="e.g. ERROR" disabled={isViewer} />
                                                </div>
                                                <div style={{ flex: 1 }}>
                                                    <label style={S.label}>Exclude Regex (Optional)</label>
                                                    <input style={S.input} value={rule.excludeRegex} onChange={e => updateEsRule(idx, 'excludeRegex', e.target.value)} placeholder="e.g. healthcheck" disabled={isViewer} />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    {(esPushPolicy.rules || []).length === 0 && (
                                        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                                            No Elasticsearch push log files configured. Click "+ Add File" to start collecting.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Sub-feature 2: System Metrics Push */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
                            <div>
                                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>System Metrics Push to ES (ECS Format)</span>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Periodic telemetry reporting of CPU, Memory, Disk & Processes in ECS dotted format</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: (esPushPolicy.elasticsearchEnabled && esPushPolicy.metricsEnabled) ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {esPushPolicy.metricsEnabled ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={esPushPolicy.metricsEnabled} onChange={e => setEsPushPolicy({...esPushPolicy, metricsEnabled: e.target.checked})} disabled={isViewer || !esPushPolicy.elasticsearchEnabled} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: (esPushPolicy.elasticsearchEnabled && esPushPolicy.metricsEnabled) ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: (esPushPolicy.elasticsearchEnabled && esPushPolicy.metricsEnabled) ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ ...S.inputGroup, opacity: (esPushPolicy.elasticsearchEnabled && esPushPolicy.metricsEnabled) ? 1 : 0.4, pointerEvents: (esPushPolicy.elasticsearchEnabled && esPushPolicy.metricsEnabled) ? 'auto' : 'none' }}>
                            <label style={S.label}>Metrics Index Name (Optional)</label>
                            <input style={S.input} value={esPushPolicy.metricsIndexName || ''} onChange={e => setEsPushPolicy({...esPushPolicy, metricsIndexName: e.target.value})} placeholder="vanguard-metrics-%Y.%m.%d" disabled={isViewer || !esPushPolicy.elasticsearchEnabled || !esPushPolicy.metricsEnabled} />
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 24, marginTop: 8 }}>Metrics will be pushed in Elastic Common Schema (ECS) dotted key-value format.</div>
                        </div>
                    </div>
                )}

                {outputTab === 'kafka' && (
                    <div style={{ ...S.cardBody, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: 32, marginBottom: 12 }}>🚀</div>
                        <h4 style={{ margin: '0 0 4px 0', color: 'var(--text-primary)' }}>Kafka Output (Coming Soon)</h4>
                        <p style={{ margin: 0, fontSize: 13, textAlign: 'center', maxWidth: 400 }}>Support for streaming Linux Syslog & custom audit logs to Apache Kafka is under development.</p>
                    </div>
                )}
            </div>

            {!isViewer && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                    <button style={S.btnP} onClick={handleDeployPolicy}>Deploy Policy to Agents</button>
                </div>
            )}
        </div>
    );
}
