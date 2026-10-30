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
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 12 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    dropzone: { border: '2px dashed var(--border-color)', borderRadius: 16, padding: 40, textAlign: 'center', background: 'rgba(0,0,0,0.2)', cursor: 'pointer', transition: 'border 0.2s', marginBottom: 24 },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 500, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 }
};

// --- Subcomponents ---

const AnalyticsTab = ({ env }) => {
    const { lastEvent } = useSync();
    useEffect(() => {
        if (!lastEvent) return;
        switch(lastEvent.type) {
            case 'PROXY_RULES_UPDATED':
                if (typeof fetchConfig !== "undefined") fetchConfig(); else if (typeof fetchData !== "undefined") fetchData();
                break;
        }
    }, [lastEvent]);

    const { showToast } = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!env) return;
        setLoading(true);
        api.post('/fortiproxy/analytics', { env })
            .then(res => setData(res.data))
            .catch(err => console.error(err))
            .finally(() => setLoading(false));
    }, [env]);

    if (loading || !data) {
        return <div style={{ textAlign: 'center', padding: 40 }}>Loading Analytics...</div>;
    }

    return (
        <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 10, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(8px)', background: 'var(--bg-overlay, rgba(128,128,128,0.1))', borderRadius: 16 }}>
                <div style={{ background: 'var(--surface)', padding: '24px 48px', borderRadius: 24, border: '1px solid var(--border)', boxShadow: '0 20px 40px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 48 }}>🚧</span>
                    <h3 style={{ fontSize: 24, fontWeight: 900, letterSpacing: 1, margin: 0, color: 'var(--text-primary)' }}>COMING SOON</h3>
                    <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 14 }}>We are optimizing the FortiProxy Analytics Engine.</p>
                </div>
            </div>
            <div className="animate-fade-in" style={{ opacity: 0.4, pointerEvents: 'none' }}>
                <div style={S.topRow}>
                    <div style={{ ...S.card, textAlign: 'center', padding: '24px' }}>
                        <span style={S.metLabel}>CPU USAGE</span>
                        <div style={{ ...S.metVal, color: data.performance.cpu > 80 ? 'var(--danger)' : 'var(--success)' }}>
                            {data.performance.cpu}%
                        </div>
                    </div>
                    <div style={{ ...S.card, textAlign: 'center', padding: '24px' }}>
                        <span style={S.metLabel}>MEMORY USAGE</span>
                        <div style={{ ...S.metVal, color: data.performance.mem > 80 ? 'var(--warning)' : 'var(--accent-primary)' }}>
                            {data.performance.mem}%
                        </div>
                    </div>
                    <div style={{ ...S.card, textAlign: 'center', padding: '24px' }}>
                        <span style={S.metLabel}>ACTIVE SESSIONS</span>
                        <div style={{ ...S.metVal }}>
                            {data.performance.sessions.toLocaleString()}
                        </div>
                    </div>
                </div>

                <div style={S.gridRow}>
                    <div style={S.card}>
                        <h4 style={S.tblTitle}>🔥 Top Hit Rules</h4>
                        <p style={S.subtitle}>Rules with highest traffic volume</p>
                        <table style={{ ...S.tbl, marginTop: 16 }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Rule ID / Name</th>
                                    <th style={S.th}>Hits</th>
                                    <th style={S.th}>Bytes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.topRules.map((r, i) => (
                                    <tr key={i} style={S.tr}>
                                        <td style={{ ...S.td, fontWeight: 700, color: 'var(--accent-primary)' }}>{r.name} (#{r.id})</td>
                                        <td style={S.td}>{r.hits.toLocaleString()}</td>
                                        <td style={S.td}>{r.bytes}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={S.card}>
                            <h4 style={{ ...S.tblTitle, color: 'var(--danger)' }}>🛡️ Blocked Threats</h4>
                            <table style={{ ...S.tbl, marginTop: 16 }}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>Source</th>
                                        <th style={S.th}>Target</th>
                                        <th style={S.th}>Time</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.threats.map((t, i) => (
                                        <tr key={i} style={S.tr}>
                                            <td style={S.td}>{t.source}</td>
                                            <td style={{ ...S.td, color: 'var(--danger)', fontWeight: 600 }}>{t.target}</td>
                                            <td style={{ ...S.td, fontSize: 11, color: 'var(--text-muted)' }}>{t.time}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div style={S.card}>
                            <h4 style={S.tblTitle}>🌐 Traffic By Zone</h4>
                            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                                {data.zones.map((z, i) => (
                                    <div key={i} style={{ flex: 1, background: 'rgba(0,0,0,0.2)', padding: 16, borderRadius: 12, textAlign: 'center' }}>
                                        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-secondary)' }}>{z.name}</div>
                                        <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>{z.traffic}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const DeployTab = ({ env, bus, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const [deployType, setDeployType] = useState('ProxyURL');
    const [deployBu, setDeployBu] = useState(bus.length ? bus[0] : '');
    const [deployItems, setDeployItems] = useState('');
    const [deployPort, setDeployPort] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showDiffModal, setShowDiffModal] = useState(false);

    const triggerDeployPreview = (e) => {
        e.preventDefault();
        if (!env) return;
        setShowDiffModal(true);
    };

    const executeDeployment = async () => {
        setShowDiffModal(false);
        setLoading(true); setIsProcessing(true);
        const payload = {
            envs: [env], type: deployType,
            bu: deployType !== 'ServicePort' ? deployBu : undefined,
            items: deployItems.split('\n').map(i => i.trim()).filter(i => i),
            portRange: deployType === 'ServicePort' ? deployPort : undefined
        };
        try {
            const res = await api.post('/fortiproxy/execute', payload);
            setResults(res.data.results);
            showToast("Deployment execution requested");
        } catch (err) {
            setResults({ Error: { status: 'Failed', error: err.response?.data?.error || err.message } });
            showToast("Deployment failed", "error");
        }
        setLoading(false); setIsProcessing(false);
    };

    return (
        <div className="animate-fade-in grid grid-cols-2 gap-6" style={S.gridRow}>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, marginBottom: 16 }}>FortiProxy Rule Configurator</h4>
                <form onSubmit={triggerDeployPreview} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                        <label style={S.metLabel}>OPERATION TYPE</label>
                        <select style={S.input} value={deployType} onChange={(e) => setDeployType(e.target.value)}>
                            <option value="ProxyURL">Add Proxy Address (URL Regex)</option>
                            <option value="ProxyIP">Add Proxy Address (Dst IP)</option>
                            <option value="SourceIP">Add Source IP Address</option>
                            <option value="ServicePort">Add Service Port</option>
                        </select>
                    </div>
                    {deployType !== 'ServicePort' && (
                        <div>
                            <label style={S.metLabel}>BUSINESS UNIT (BU)</label>
                            <select style={S.input} value={deployBu} onChange={(e) => setDeployBu(e.target.value)}>
                                {bus.map(b => <option key={b} value={b}>{b}</option>)}
                            </select>
                        </div>
                    )}
                    {deployType === 'ServicePort' ? (
                        <div>
                            <label style={S.metLabel}>PORT RANGE (1-65535)</label>
                            <input required type="number" min="1" max="65535" style={S.input} value={deployPort} onChange={(e) => setDeployPort(e.target.value)} placeholder="e.g. 8080" />
                        </div>
                    ) : (
                        <div>
                            <label style={S.metLabel}>INPUT LIST (ONE PER LINE)</label>
                            <textarea required style={{ ...S.textarea, height: 120 }} value={deployItems} onChange={(e) => setDeployItems(e.target.value)} placeholder={`192.168.1.5\nexample.com`} />
                        </div>
                    )}
                    {role !== 'Viewer' ? (
                        <button type="submit" style={{ ...S.btnP, marginTop: 8 }} disabled={loading || !env}>
                            {loading ? 'Deploying...' : 'Execute Deployment'}
                        </button>
                    ) : (
                        <div style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 800 }}>Only Operator or Admin can deploy configurations.</div>
                    )}
                </form>
            </div>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, color: 'var(--warning)', marginBottom: 16 }}>Execution Results</h4>
                {results ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {Object.keys(results).map(resultEnv => (
                            <div key={resultEnv} style={{ background: 'rgba(0,0,0,0.3)', padding: 16, borderRadius: 12 }}>
                                <h5 style={{ margin: 0, fontSize: 14, color: results[resultEnv].status === 'Success' ? 'var(--success)' : 'var(--danger)' }}>
                                    {resultEnv} - {results[resultEnv].status}
                                </h5>
                                {results[resultEnv].error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{results[resultEnv].error}</div>}
                                {results[resultEnv].protocol && (
                                    <pre style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
                                        {results[resultEnv].protocol}
                                    </pre>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>Submit a deployment to see the output here.</div>
                )}
            </div>

            {showDiffModal && (
                <div style={S.overlay} onClick={() => setShowDiffModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>🛡️ FortiProxy Config Diff Preview</h3>
                            <button style={S.closeBtn} onClick={() => setShowDiffModal(false)}>✕</button>
                        </div>
                        <div style={{ padding: '24px 28px' }}>
                            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
                                Please review the following rules before syncing to FortiProxy cluster.
                            </p>
                            
                            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                                <div style={{ display: 'flex', justifycontent: 'space-between', justifyContent: 'space-between', fontSize: 12 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Target Environment:</span>
                                    <strong style={{ color: 'var(--accent-primary)' }}>{env}</strong>
                                </div>
                                <div style={{ display: 'flex', justifycontent: 'space-between', justifyContent: 'space-between', fontSize: 12 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Operation Type:</span>
                                    <strong>{deployType}</strong>
                                </div>
                                {deployType !== 'ServicePort' && (
                                    <div style={{ display: 'flex', justifycontent: 'space-between', justifyContent: 'space-between', fontSize: 12 }}>
                                        <span style={{ color: 'var(--text-muted)' }}>Business Unit (BU):</span>
                                        <strong>{deployBu}</strong>
                                    </div>
                                )}
                            </div>

                            <h5 style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginTop: 24, marginBottom: 8 }}>Configuration Diff</h5>
                            <div style={{ maxHeight: 200, overflowY: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: 12, border: '1px solid var(--border-color)' }}>
                                {deployType === 'ServicePort' ? (
                                    <div style={{ color: '#10b981', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                                        + service port: {deployPort}
                                    </div>
                                ) : (
                                    deployItems.split('\n').map(i => i.trim()).filter(i => i).map((item, idx) => (
                                        <div key={idx} style={{ color: '#10b981', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                                            + [{deployBu}] {item}
                                        </div>
                                    ))
                                )}
                            </div>

                            <div style={{ display: 'flex', gap: 12, marginTop: 28 }}>
                                <button style={{ ...S.btnO, flex: 1 }} onClick={() => setShowDiffModal(false)}>Cancel</button>
                                <button style={{ ...S.btnP, flex: 1, background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24 }} onClick={executeDeployment}>Confirm & Deploy</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const CheckTab = ({ env }) => {
    const { showToast } = useToast();
    const [checkType, setCheckType] = useState('ProxyAddress');
    const [checkTarget, setCheckTarget] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);

    const handleCheck = async (e) => {
        e.preventDefault();
        setLoading(true); setResults(null);
        try {
            const res = await api.post('/fortiproxy/check', { envs: [env], type: checkType, target: checkTarget.trim() });
            if (res.data.results) res.data.results.sort((a,b) => (b.found === a.found ? 0 : b.found ? 1 : -1));
            setResults(res.data);
        } catch (err) {
            setResults({ error: err.response?.data?.error || err.message });
        }
        setLoading(false);
    };

    return (
        <div className="animate-fade-in grid grid-cols-2 gap-6" style={S.gridRow}>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, marginBottom: 16 }}>FortiProxy REST API Checker</h4>
                <form onSubmit={handleCheck} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                        <label style={S.metLabel}>CHECK TYPE</label>
                        <select style={S.input} value={checkType} onChange={(e) => setCheckType(e.target.value)}>
                            <option value="ProxyAddress">Proxy Address Match</option>
                            <option value="SourceIP">Source IP Match</option>
                        </select>
                    </div>
                    <div>
                        <label style={S.metLabel}>TARGET QUERY</label>
                        <input required style={S.input} value={checkTarget} onChange={(e) => setCheckTarget(e.target.value)} placeholder="e.g. 10.18.16.23 or example.com" />
                    </div>
                    <button type="submit" style={{ ...S.btnP, marginTop: 8 }} disabled={loading || !env}>
                        {loading ? 'Querying API...' : 'Check Status'}
                    </button>
                </form>
            </div>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, color: 'var(--warning)', marginBottom: 16 }}>API Response</h4>
                {results ? (
                    <div>
                        {results.error ? (
                            <div style={{ color: 'var(--danger)' }}>{results.error}</div>
                        ) : (
                            <div>
                                <div style={{ marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
                                    Target: <span style={{ color: 'var(--accent-primary)' }}>{results.target}</span>
                                </div>
                                <table style={S.tbl}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>Env</th>
                                            <th style={S.th}>Group Assessed</th>
                                            <th style={S.th}>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {results.results.map((r, idx) => (
                                            <tr key={idx} style={{ ...S.tr, background: r.found ? 'rgba(16,185,129,0.05)' : 'transparent' }}>
                                                <td style={{ ...S.td, fontWeight: 600 }}>{r.env}</td>
                                                <td style={S.td}>{r.group}</td>
                                                <td style={S.td}>
                                                    <span style={{ ...S.badge, background: r.found?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: r.found?'var(--success)':'var(--danger)' }}>
                                                        {r.found ? 'Match Found' : 'No Record'}
                                                    </span>
                                                    {r.error && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>{r.error}</div>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>Enter a query to check CMDB bindings.</div>
                )}
            </div>
        </div>
    );
};

// --- Advance Features Tab Components ---

const BulkManager = ({ env, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const [csvData, setCsvData] = useState([]);
    const [rawText, setRawText] = useState('');
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState(null);

    const parseCSV = (text) => {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('Type')); // ignore header
        const parsed = lines.map(line => {
            const parts = line.split(',');
            return { type: parts[0]?.trim() || '', item: parts[1]?.trim() || '', bu: parts[2]?.trim() || '', portRange: parts[3]?.trim() || '' };
        });
        setCsvData(parsed);
    };

    const handleFileDrop = (e) => {
        e.preventDefault();
        const file = e.dataTransfer ? e.dataTransfer.files[0] : e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            setRawText(ev.target.result);
            parseCSV(ev.target.result);
        };
        reader.readAsText(file);
    };

    const handleDeploy = async () => {
        if (csvData.length === 0) return;
        if (role === 'Viewer') return showToast('Viewer cannot deploy');

        const confirmed = window.sysConfirm 
            ? await new Promise(res => window.sysConfirm(`Execute ${csvData.length} rules to ${env}?`, res))
            : await showConfirm(`Execute ${csvData.length} rules to ${env}?`);
        if (!confirmed) return;

        setLoading(true); setIsProcessing(true);
        try {
            const res = await api.post('/fortiproxy/execute/bulk/api', { env, rules: csvData });
            setResults(res.data);
        } catch (e) {
            showToast(e.message);
        }
        setLoading(false); setIsProcessing(false);
    };

    const exportTemplate = () => {
        const header = "Type,Item,BusinessUnit,PortRange\n";
        const row1 = "ProxyURL,example.com,188,\n";
        const row2 = "ProxyIP,192.168.1.5,BI,\n";
        const row3 = "ServicePort,, ,8080\n";
        const blob = new Blob([header + row1 + row2 + row3], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', 'forti_rules_template.csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    if (results) return (
        <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h4 style={S.tblTitle}>Bulk Deployment Results</h4>
                <button style={S.btnO} onClick={async () => { setResults(null); setCsvData([]); setRawText(''); }}>Back to Import</button>
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 24 }}>
                <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid var(--success)', padding: '16px 24px', borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--success)', fontWeight: 800 }}>SUCCESS</div>
                    <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--success)' }}>{results.summary.success}</div>
                </div>
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', padding: '16px 24px', borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 800 }}>FAILED</div>
                    <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--danger)' }}>{results.summary.failed}</div>
                </div>
            </div>
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
                <table style={S.tbl}>
                    <thead><tr><th style={S.th}>Rule</th><th style={S.th}>Status</th><th style={S.th}>Error (if any)</th></tr></thead>
                    <tbody>
                        {results.results.map((r, i) => (
                            <tr key={i} style={S.tr}>
                                <td style={{ ...S.td, fontWeight: 600 }}>[{r.type}] {r.item || `Port: ${r.portRange}`}</td>
                                <td style={S.td}><span style={{ ...S.badge, background: r.status==='Success'?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: r.status==='Success'?'var(--success)':'var(--danger)' }}>{r.status}</span></td>
                                <td style={{ ...S.td, fontSize: 12, color: 'var(--danger)' }}>{r.error}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );

    return (
        <div style={S.gridRow}>
            <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                    <h4 style={S.tblTitle}>Import CSV</h4>
                    <button style={{ ...S.btnO, padding: '4px 12px', fontSize: 11 }} onClick={exportTemplate}>📥 Download Template</button>
                </div>
                <label style={{ display: 'block', ...S.dropzone }} onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}>
                    <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleFileDrop} />
                    <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>Drag & Drop CSV file here</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>or click to browse</div>
                </label>
                <textarea style={{ ...S.textarea, height: 150 }} placeholder="Or paste CSV data here..." value={rawText} onChange={(e) => { setRawText(e.target.value); parseCSV(e.target.value); }} />
            </div>
            <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h4 style={S.tblTitle}>Preview Data ({csvData.length} rules)</h4>
                    <button style={S.btnP} disabled={csvData.length === 0 || loading} onClick={handleDeploy}>
                        {loading ? 'Executing API...' : '🚀 Execute Bulk Deployment'}
                    </button>
                </div>
                <div style={{ maxHeight: 500, overflow: 'auto' }}>
                    <table style={S.tbl}>
                        <thead><tr><th style={S.th}>#</th><th style={S.th}>Type</th><th style={S.th}>Item / Target</th><th style={S.th}>BU</th><th style={S.th}>Port</th></tr></thead>
                        <tbody>
                            {csvData.length === 0 && <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)' }}>No data loaded.</td></tr>}
                            {csvData.map((row, i) => (
                                <tr key={i} style={S.tr}>
                                    <td style={{ ...S.td, color: 'var(--text-muted)' }}>{i+1}</td>
                                    <td style={{ ...S.td, fontWeight: 800 }}>{row.type}</td>
                                    <td style={{ ...S.td, color: 'var(--accent-primary)', fontWeight: 600 }}>{row.item}</td>
                                    <td style={S.td}>{row.bu}</td>
                                    <td style={S.td}>{row.portRange}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

const CleanupManager = ({ env, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const [orphans, setOrphans] = useState(null);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState([]);

    const scan = async () => {
        setLoading(true); setOrphans(null); setSelected([]); setIsProcessing(true);
        try {
            const res = await api.post('/fortiproxy/cleanup/scan', { env });
            setOrphans(res.data.results);
        } catch (e) { showToast(e.message); }
        setLoading(false); setIsProcessing(false);
    };

    const deleteSelected = async () => {
        if(role === 'Viewer') return;
        const confirmed = window.sysConfirm ? await new Promise(r => window.sysConfirm(`Delete ${selected.length} objects?`, r)) : await showConfirm(`Delete ${selected.length} objects?`);
        if(!confirmed) return;
        setLoading(true); setIsProcessing(true);
        try {
            await api.post('/fortiproxy/cleanup/delete', { env, items: selected });
            showToast("Cleanup Successful");
            setOrphans(orphans.filter(o => !selected.includes(o.name)));
            setSelected([]);
        } catch (e) { showToast(e.message); }
        setLoading(false); setIsProcessing(false);
    };

    return (
        <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                    <h4 style={S.tblTitle}>♻️ Object Cleanup (Orphan Finder)</h4>
                    <p style={S.subtitle}>Scan for proxy addresses not bound to any group.</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button style={S.btnO} onClick={scan} disabled={loading}>{loading ? 'Scanning...' : '🔍 Scan for Orphans'}</button>
                    {orphans && orphans.length > 0 && role !== 'Viewer' && (
                        <button style={S.btnDanger} onClick={deleteSelected} disabled={selected.length === 0 || loading}>
                            🗑️ Delete Selected
                        </button>
                    )}
                </div>
            </div>
            {orphans ? (
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>Select</th>
                            <th style={S.th}>Object Name</th>
                            <th style={S.th}>Type</th>
                            <th style={S.th}>Last Used</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orphans.length === 0 && <tr><td colSpan={4} style={{...S.td, textAlign: 'center'}}>No orphaned objects found.</td></tr>}
                        {orphans.map((o, i) => (
                            <tr key={i} style={S.tr}>
                                <td style={S.td}><input type="checkbox" checked={selected.includes(o.name)} onChange={e => {
                                    if(e.target.checked) setSelected([...selected, o.name]);
                                    else setSelected(selected.filter(s => s !== o.name));
                                }}/></td>
                                <td style={{...S.td, color: 'var(--accent-primary)', fontWeight: 700}}>{o.name}</td>
                                <td style={S.td}>{o.type}</td>
                                <td style={S.td}>{o.lastUsed}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Click "Scan for Orphans" to analyze the CMDB.</div>
            )}
        </div>
    );
};

const UrlRating = ({ env }) => {
    const { showToast } = useToast();
    const [url, setUrl] = useState('');
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);

    const check = async (e) => {
        e.preventDefault();
        if(!url) return;
        setLoading(true); setResult(null);
        try {
            const res = await api.post('/fortiproxy/url-rating', { env, url });
            setResult(res.data);
        } catch(e) { showToast(e.message); }
        setLoading(false);
    };

    return (
        <div style={S.gridRow}>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, marginBottom: 16 }}>🛡️ URL Rating & Tester</h4>
                <form onSubmit={check}>
                    <label style={S.metLabel}>TEST URL</label>
                    <input style={S.input} placeholder="e.g. facebook.com" value={url} onChange={e => setUrl(e.target.value)} required />
                    <button style={{ ...S.btnP, marginTop: 12 }} type="submit" disabled={loading}>{loading ? 'Testing...' : 'Check FortiGuard Rating'}</button>
                </form>
            </div>
            <div style={S.card}>
                <h4 style={{ ...S.tblTitle, color: 'var(--warning)', marginBottom: 16 }}>Rating Result</h4>
                {result ? (
                    <div>
                        <div style={{ marginBottom: 12 }}><strong>Target:</strong> <span style={{ color: 'var(--accent-primary)' }}>{result.url}</span></div>
                        <div style={{ marginBottom: 12 }}><strong>FortiGuard Category:</strong> {result.category}</div>
                        <div>
                            <strong>Simulated Policy Action: </strong> 
                            <span style={{ ...S.badge, background: result.blocked ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', color: result.blocked ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>
                                {result.action}
                            </span>
                        </div>
                    </div>
                ) : <div style={{ color: 'var(--text-muted)' }}>Enter a URL to check rating.</div>}
            </div>
        </div>
    );
};

const BackupManager = ({ env }) => {
    const { showToast } = useToast();
    const [files, setFiles] = useState([]);
    const [selected, setSelected] = useState('');
    const [content, setContent] = useState('');

    useEffect(() => {
        if (!env) return;
        api.get(`/fortiproxy/backups?env=${encodeURIComponent(env)}`).then(r => setFiles(r.data.files)).catch(e => console.error(e));
    }, [env]);

    const read = async (f) => {
        setSelected(f);
        api.post('/fortiproxy/backups/read', { filename: f, env }).then(r => setContent(r.data.content)).catch(e => console.error(e));
    };

    return (
        <div style={S.gridRow}>
            <div style={{ ...S.card, height: 400, overflowY: 'auto' }}>
                <h4 style={{ ...S.tblTitle, marginBottom: 16 }}>📦 Configuration Backups</h4>
                {files.map(f => (
                    <div key={f} onClick={() => read(f)} style={{ padding: '10px 14px', marginBottom: 8, cursor: 'pointer', borderRadius: 8, fontSize: 12, fontWeight: 600, border: `1px solid ${selected === f ? 'var(--accent-primary)' : 'var(--border-color)'}`, background: selected === f ? 'rgba(59,130,246,0.1)' : 'transparent', color: selected === f ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                        {f}
                    </div>
                ))}
            </div>
            <div style={{ ...S.card, display: 'flex', flexDirection: 'column', height: 400, padding: 0 }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)' }}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>VIEWER: {selected || 'Select a file'}</h4>
                </div>
                <textarea readOnly style={{ ...S.textarea, flex: 1, border: 'none', borderRadius: 0, margin: 0, resize: 'none' }} value={content} placeholder="File contents will appear here..." />
            </div>
        </div>
    );
};

const PolicyManager = ({ env, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const [policies, setPolicies] = useState([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if(!env) return;
        setLoading(true);
        api.post('/fortiproxy/policies', { env }).then(r => setPolicies(r.data.policies)).catch(e=>console.error(e)).finally(()=>setLoading(false));
    }, [env]);

    const toggle = async (id, action) => {
        if(role === 'Viewer') return;
        const confirmed = window.sysConfirm ? await new Promise(r => window.sysConfirm(`Are you sure you want to ${action} policy ${id}?`, r)) : await showConfirm(`Are you sure you want to ${action} policy ${id}?`);
        if(!confirmed) return;
        setLoading(true); setIsProcessing(true);
        try {
            await api.post('/fortiproxy/policies/toggle', { env, policyId: id, action });
            setPolicies(policies.map(p => p.id === id ? { ...p, status: action } : p));
        } catch(e) { showToast(e.message); }
        setLoading(false); setIsProcessing(false);
    };

    return (
        <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                    <h4 style={S.tblTitle}>🔀 Policy Manager</h4>
                    <p style={S.subtitle}>View and toggle Firewall Policies on {env}.</p>
                </div>
                <button style={S.btnO} onClick={async () => {
                    setLoading(true); api.post('/fortiproxy/policies', { env }).then(r => setPolicies(r.data.policies)).finally(()=>setLoading(false));
                }}>{loading ? 'Refreshing...' : '🔄 Refresh'}</button>
            </div>
            <table style={S.tbl}>
                <thead>
                    <tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={S.th}>Source</th><th style={S.th}>Destination</th><th style={S.th}>Action</th><th style={S.th}>Status</th><th style={S.th}>Emergency Toggle</th></tr>
                </thead>
                <tbody>
                    {policies.map(p => (
                        <tr key={p.id} style={{ ...S.tr, opacity: p.status === 'disable' ? 0.6 : 1 }}>
                            <td style={S.td}>{p.id}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{p.name}</td>
                            <td style={S.td}>{p.src}</td>
                            <td style={S.td}>{p.dst}</td>
                            <td style={S.td}><span style={{ ...S.badge, background: p.action==='accept'?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: p.action==='accept'?'var(--success)':'var(--danger)' }}>{p.action.toUpperCase()}</span></td>
                            <td style={S.td}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, color: p.status === 'enable' ? 'var(--success)' : 'var(--danger)' }}>
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.status === 'enable' ? 'var(--success)' : 'var(--danger)' }}></div>
                                    {p.status === 'enable' ? 'ON' : 'OFF'}
                                </div>
                            </td>
                            <td style={S.td}>
                                {role !== 'Viewer' && (
                                    p.status === 'enable' ? 
                                    <button style={{ ...S.btnDanger, padding: '4px 10px', fontSize: 11 }} onClick={()=>toggle(p.id, 'disable')}>Disable</button> :
                                    <button style={{ ...S.btnSuccess, padding: '4px 10px', fontSize: 11 }} onClick={()=>toggle(p.id, 'enable')}>Enable</button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const SessionTroubleshoot = ({ env }) => {
    const { showToast } = useToast();
    const [ip, setIp] = useState('');
    const [sessions, setSessions] = useState(null);
    const [loading, setLoading] = useState(false);

    const check = async (e) => {
        e.preventDefault();
        if(!ip) return;
        setLoading(true);
        try {
            const res = await api.post('/fortiproxy/sessions', { env, ip });
            setSessions(res.data.sessions);
        } catch(e) { showToast(e.message); }
        setLoading(false);
    };

    return (
        <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                    <h4 style={S.tblTitle}>🔍 Live Session Troubleshooting</h4>
                    <p style={S.subtitle}>Check real-time active sessions for a specific IP.</p>
                </div>
            </div>
            <form onSubmit={check} style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
                <input style={{ ...S.input, margin: 0, flex: 1 }} placeholder="Enter Source IP (e.g. 192.168.1.100)" value={ip} onChange={e => setIp(e.target.value)} required />
                <button type="submit" style={S.btnP} disabled={loading || !env}>{loading ? 'Querying...' : 'Trace Live Sessions'}</button>
            </form>
            {sessions && (
                <table style={S.tbl}>
                    <thead>
                        <tr><th style={S.th}>Session ID</th><th style={S.th}>Destination IP</th><th style={S.th}>Port</th><th style={S.th}>Policy Hit</th><th style={S.th}>State</th><th style={S.th}>Data Transfer</th></tr>
                    </thead>
                    <tbody>
                        {sessions.length === 0 && <tr><td colSpan={6} style={{...S.td, textAlign: 'center'}}>No active sessions found for {ip}.</td></tr>}
                        {sessions.map((s, i) => (
                            <tr key={i} style={S.tr}>
                                <td style={S.td}>{s.id}</td>
                                <td style={{ ...S.td, fontWeight: 700 }}>{s.dst}</td>
                                <td style={S.td}>{s.port}</td>
                                <td style={{ ...S.td, color: 'var(--accent-primary)' }}>{s.policy}</td>
                                <td style={S.td}><span style={{ ...S.badge, background: s.state==='ESTABLISHED'?'rgba(16,185,129,0.1)':s.state==='DENY'?'rgba(239,68,68,0.1)':'rgba(255,255,255,0.1)', color: s.state==='ESTABLISHED'?'var(--success)':s.state==='DENY'?'var(--danger)':'var(--text-secondary)' }}>{s.state}</span></td>
                                <td style={S.td}>{s.bytes}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

const AdvanceFeaturesTab = ({ env, role, setIsProcessing }) => {
    const { showToast } = useToast();
    const [subTab, setSubTab] = useState('BULK'); // BULK, CLEANUP, RATING, BACKUP, POLICY, SESSION

    return (
        <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button style={subTab === 'BULK' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('BULK')}>📦 Bulk Import / Export</button>
                <button style={subTab === 'CLEANUP' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('CLEANUP')}>♻️ Object Cleanup</button>
                <button style={subTab === 'RATING' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('RATING')}>🛡️ Web Filter Tester</button>
                <button style={subTab === 'BACKUP' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('BACKUP')}>📦 Config Backups</button>
                <button style={subTab === 'POLICY' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('POLICY')}>🔀 Policy Manager</button>
                <button style={subTab === 'SESSION' ? { ...S.btnP, justifyContent: 'flex-start' } : { ...S.btnO, justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => setSubTab('SESSION')}>🔍 Session Tracer</button>
            </div>
            <div style={{ flex: 1 }}>
                {subTab === 'BULK' && <BulkManager env={env} role={role} setIsProcessing={setIsProcessing} />}
                {subTab === 'CLEANUP' && <CleanupManager env={env} role={role} setIsProcessing={setIsProcessing} />}
                {subTab === 'RATING' && <UrlRating env={env} />}
                {subTab === 'BACKUP' && <BackupManager env={env} />}
                {subTab === 'POLICY' && <PolicyManager env={env} role={role} setIsProcessing={setIsProcessing} />}
                {subTab === 'SESSION' && <SessionTroubleshoot env={env} />}
            </div>
        </div>
    );
};

// --- Main Container ---

const FortiProxy = ({ setIsProcessing }) => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [config, setConfig] = useState({ envs: [], hosts: {}, tokens: {}, bus: [] });
    const [tab, setTab] = useState('DEPLOY'); // ANALYTICS, DEPLOY, CHECK, ADVANCED
    
    // Unified Environment State
    const [currentEnv, setCurrentEnv] = useState('');

    useEffect(() => {
        api.get('/fortiproxy/config')
            .then(res => {
                setConfig(res.data);
                if (res.data.envs.length > 0) {
                    setCurrentEnv(res.data.envs[0]);
                }
            })
            .catch(err => console.error('Failed to fetch config:', err));
    }, []);

    if (!config.envs || config.envs.length === 0) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}>🛡️ FortiProxy Manager</h1>
                        <p style={S.subtitle}>Next-Gen Firewall Management & Analytics</p>
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
                        尚未設定 FortiProxy 伺服器 (No FortiProxy Servers Configured)
                    </h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 24px 0' }}>
                        目前系統尚未配置任何 FortiProxy 伺服器節點。請先前往 <strong>Settings (系統設定)</strong> 進行伺服器設定。
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
                    <h1 style={S.title}>🛡️ FortiProxy Manager</h1>
                    <p style={S.subtitle}>Next-Gen Firewall Management & Analytics</p>
                </div>
                {/* Environment selector pulled to top right for ALL tabs */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', padding: '8px 16px', borderRadius: 10 }}>
                    <label style={{ ...S.metLabel, margin: 0, color: 'var(--text-primary)', fontSize: 13 }}>TARGET NODE:</label>
                    <select 
                        style={S.select} 
                        value={currentEnv} 
                        onChange={e => setCurrentEnv(e.target.value)}
                    >
                        {config.envs.map(env => <option key={env} value={env}>{env} ({config.hosts[env]})</option>)}
                    </select>
                </div>
            </div>

            {/* Browser-like main tabs (4 tabs only as requested) */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
                <button style={tab === 'ANALYTICS' ? S.btnP : S.btnO} onClick={() => setTab('ANALYTICS')}>📊 Usage Analytics</button>
                <button style={tab === 'DEPLOY' ? S.btnP : S.btnO} onClick={() => setTab('DEPLOY')}>🚀 Single Deployment</button>
                <button style={tab === 'CHECK' ? S.btnP : S.btnO} onClick={() => setTab('CHECK')}>🔍 CMDB Status Checker</button>
                <button style={tab === 'ADVANCED' ? S.btnP : S.btnO} onClick={() => setTab('ADVANCED')}>🛠️ Advance Feature</button>
            </div>

            <main className="animate-fade-in">
                {tab === 'ANALYTICS' && <AnalyticsTab env={currentEnv} />}
                {tab === 'DEPLOY' && <DeployTab env={currentEnv} bus={config.bus} role={role} setIsProcessing={setIsProcessing} />}
                {tab === 'CHECK' && <CheckTab env={currentEnv} />}
                {tab === 'ADVANCED' && <AdvanceFeaturesTab env={currentEnv} role={role} setIsProcessing={setIsProcessing} />}
            </main>
        </div>
    );
};

export default FortiProxy;
