import React, { useState, useEffect } from 'react';
import { useToast } from '../../contexts/ToastContext';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%', position: 'relative' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    tabRow: { display: 'flex', gap: 8, marginBottom: 28, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 },
    tabActive: { padding: '8px 20px', background: 'var(--bg-glass)', color: 'var(--accent-primary)', border: '1px solid var(--accent-primary)', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    tabInactive: { padding: '8px 20px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800 },
    cardBody: { padding: '20px 24px' },
    inputGroup: { marginBottom: 20 },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' },
    input: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    select: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    btnP: { padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    // Modal
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 700, overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' },
    modalHead: { padding: '24px 32px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between' },
    modalTitle: { fontSize: 18, fontWeight: 800, margin: 0, color: 'var(--text-primary)' },
    modalBody: { padding: '32px', maxHeight: '60vh', overflowY: 'auto' },
};

export default function WindowsEvent({ configOnly = false }) {
    const [activeTab, setActiveTab] = useState('policy'); // policy, live
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isViewer = user?.role === 'Viewer';

    // Policy State (Array of rules)
    const [rules, setRules] = useState([]);
    const [generatedXML, setGeneratedXML] = useState('');
    const [policyCollapsed, setPolicyCollapsed] = useState(false);
    const [outputTab, setOutputTab] = useState('elasticsearch');
    const [yamlCollapsed, setYamlCollapsed] = useState(false);

    // Validation State
    const [validating, setValidating] = useState(false);
    const [validationResult, setValidationResult] = useState(null);
    const [showValidationModal, setShowValidationModal] = useState(false);

    // ES Visual Rules State & Mode
    const [esRules, setEsRules] = useState([
        { channel: 'Security', severity: 'All', includeIds: '', excludeIds: '5379, 4798, 4799', excludeUsers: '' },
        { channel: 'System', severity: 'Warning', includeIds: '', excludeIds: '', excludeUsers: '' },
        { channel: 'Application', severity: 'Error', includeIds: '', excludeIds: '8198', excludeUsers: '' }
    ]);
    const [esEditorMode, setEsEditorMode] = useState('visual'); // 'visual' | 'yaml'

    // Helper to generate compliant YAML from visual ES rules
    const generateEsYaml = (ruleList) => {
        if (!ruleList || ruleList.length === 0) {
            return 'scout_push_policy: []\n';
        }
        let yaml = 'scout_push_policy:\n';
        ruleList.forEach((r, idx) => {
            yaml += `  # Rule ${idx + 1}: ${r.channel || 'Security'} (${r.severity || 'All'})\n`;
            yaml += `  - channel: ${r.channel || 'Security'}\n`;
            yaml += `    level: ${r.severity || 'All'}\n`;

            const inc = (r.includeIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            const exc = (r.excludeIds || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            const excUsers = (r.excludeUsers || '').split(',').map(s => s.trim()).filter(Boolean);

            if (inc.length > 0 || exc.length > 0) {
                yaml += `    event_ids:\n`;
                if (inc.length > 0) {
                    yaml += `      include: [${inc.join(', ')}]\n`;
                }
                if (exc.length > 0) {
                    yaml += `      exclude: [${exc.join(', ')}]\n`;
                }
            }
            if (excUsers.length > 0) {
                yaml += `    exclude_users: [${excUsers.map(u => `"${u}"`).join(', ')}]\n`;
            }
            yaml += '\n';
        });
        return yaml.trimEnd() + '\n';
    };

    const addEsRule = () => {
        const updated = [...esRules, { channel: 'System', severity: 'Warning', includeIds: '', excludeIds: '', excludeUsers: '' }];
        setEsRules(updated);
        const y = generateEsYaml(updated);
        setPushPolicy(prev => ({ ...prev, yamlConfig: y }));
    };

    const deleteEsRule = (idx) => {
        const updated = esRules.filter((_, i) => i !== idx);
        setEsRules(updated);
        const y = generateEsYaml(updated);
        setPushPolicy(prev => ({ ...prev, yamlConfig: y }));
    };

    const updateEsRule = (idx, field, value) => {
        const updated = [...esRules];
        updated[idx][field] = value;
        setEsRules(updated);
        const y = generateEsYaml(updated);
        setPushPolicy(prev => ({ ...prev, yamlConfig: y }));
    };

    // Push Policy State
    const defaultYaml = `scout_push_policy:
  # Rule 1: Audit Logon Events
  - channel: Security
    event_ids:
      include: [4624, 4625, 4634, 4647]
      exclude: [4658, 5156]
    level: Information
    tags: ["security", "auth"]
  
  # Rule 2: Application Errors
  - channel: Application
    level: Error
    tags: ["app-error"]

  # Rule 3: System Warnings & Above
  - channel: System
    level: Warning`;

    const [pushPolicy, setPushPolicy] = useState({
        elasticsearchEnabled: false,
        logEnabled: true,
        url: 'https://localhost:9200',
        username: 'elastic',
        password: '',
        logIndexName: '',
        metricsEnabled: false,
        metricsIndexName: '',
        yamlConfig: defaultYaml
    });

    // Live Viewer State
    const [events, setEvents] = useState([]);
    const [liveTail, setLiveTail] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState(null);

    const handleQuickExcludeUser = (userToExclude) => {
        if (!userToExclude || isViewer) return;
        const currentRules = [...rules];
        if (currentRules.length === 0) {
            currentRules.push({ logName: selectedEvent?.logName || 'Security', includeIds: '', excludeIds: '', excludeUsers: userToExclude, severity: 'All' });
        } else {
            const r0 = { ...currentRules[0] };
            const existing = (r0.excludeUsers || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!existing.includes(userToExclude)) {
                existing.push(userToExclude);
                r0.excludeUsers = existing.join(', ');
                currentRules[0] = r0;
            }
        }
        setRules(currentRules);
        setSelectedEvent(null);
        setActiveTab('policy');
        showToast(`已將「${userToExclude}」加入排除清單，請確認後點擊「Deploy Policy to Agents」部署生效`, 'info');
    };

    // Syntax Validator Function
    const handleValidateSyntax = async (silentOnSuccess = false) => {
        setValidating(true);
        try {
            const res = await fetch('/api/monitor/winevent/validate_push_policy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(pushPolicy)
            });
            const data = await res.json();
            setValidationResult(data);
            if (data.valid) {
                if (!silentOnSuccess) {
                    showToast(`語法驗證通過！共解析出 ${data.ruleCount || 0} 條有效過濾規則。`, 'success');
                }
            } else {
                showToast(`語法檢查發現 ${data.errors?.length || 0} 項問題，請檢閱下方提示`, 'error');
            }
            return data;
        } catch (err) {
            showToast(`語法驗證請求失敗: ${err.message}`, 'error');
            return null;
        } finally {
            setValidating(false);
        }
    };

    // Auto-fix common problematic strings (All Levels -> All, Warning & Above -> Warning)
    const handleAutoFixLevels = () => {
        let fixedYaml = pushPolicy.yamlConfig || '';
        fixedYaml = fixedYaml.replace(/level:\s*All\s+Levels/gi, 'level: All');
        fixedYaml = fixedYaml.replace(/level:\s*Warning\s*&\s*Above/gi, 'level: Warning');
        fixedYaml = fixedYaml.replace(/level:\s*Error\s*&\s*Critical/gi, 'level: Error');
        fixedYaml = fixedYaml.replace(/level:\s*Critical\s*&\s*Error/gi, 'level: Error');

        setPushPolicy(prev => ({
            ...prev,
            yamlConfig: fixedYaml
        }));
        showToast('已自動將 YAML 規則中的 Level 關鍵字修正為 Agent 標準格式 (All / Warning / Error)', 'success');
        setValidationResult(null);
    };

    const switchToVisualMode = async () => {
        const res = await handleValidateSyntax(true);
        if (res && res.valid && Array.isArray(res.parsedRules) && res.parsedRules.length > 0) {
            const converted = res.parsedRules.map(r => ({
                channel: r.channel || 'Security',
                severity: r.severity || r.level || 'All',
                includeIds: r.includeIds || '',
                excludeIds: r.excludeIds || ''
            }));
            setEsRules(converted);
            setPushPolicy(prev => ({ ...prev, yamlConfig: generateEsYaml(converted) }));
            setEsEditorMode('visual');
            showToast('已成功轉為視覺化卡片設定', 'success');
        } else if (res && !res.valid) {
            showToast('YAML 存在語法問題，請先修正或點擊「自動修正格式」後再切換為視覺化模式', 'error');
        } else {
            setEsEditorMode('visual');
        }
    };

    // Load clean compliant template
    const handleLoadDefaultTemplate = () => {
        const defaultTemplateRules = [
            { channel: 'Security', severity: 'All', includeIds: '', excludeIds: '5379, 4798, 4799' },
            { channel: 'System', severity: 'Warning', includeIds: '', excludeIds: '' },
            { channel: 'Application', severity: 'Error', includeIds: '', excludeIds: '8198' }
        ];
        const cleanYaml = generateEsYaml(defaultTemplateRules);
        setEsRules(defaultTemplateRules);
        setPushPolicy(prev => ({
            ...prev,
            yamlConfig: cleanYaml
        }));
        showToast('已套用標準合規過濾規則', 'info');
        setValidationResult(null);
    };

    // Load Policy from backend
    useEffect(() => {
        fetch('/api/monitor/winevent/policy', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        })
        .then(res => res.json())
        .then(data => {
            if (Array.isArray(data) && data.length > 0) {
                setRules(data);
            }
        })
        .catch(err => console.error('Failed to load winevent policy:', err));

        fetch('/api/monitor/winevent/push_policy', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        })
        .then(res => res.json())
        .then(data => {
            if (data && data.yamlConfig) {
                setPushPolicy(data);
                if (Array.isArray(data.structuredRules) && data.structuredRules.length > 0) {
                    setEsRules(data.structuredRules.map(r => ({
                        channel: r.channel || 'Security',
                        severity: r.severity || r.level || 'All',
                        includeIds: r.includeIds || '',
                        excludeIds: r.excludeIds || '',
                        excludeUsers: r.excludeUsers || ''
                    })));
                }
            }
        })
        .catch(err => console.error('Failed to load push policy:', err));
    }, []);

    // Live Events fetch logic
    useEffect(() => {
        let interval;
        const fetchEvents = () => {
            fetch('/api/monitor/winevent/live', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            })
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setEvents(data.slice(0, 500));
                }
            })
            .catch(err => console.error('Failed to fetch live events:', err));
        };

        if (activeTab === 'live') {
            fetchEvents(); // Initial fetch
            if (liveTail) {
                interval = setInterval(fetchEvents, 5000);
            }
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [activeTab, liveTail]);

    useEffect(() => {
        // Generate XML string for preview
        let xml = '<QueryList>\n';
        rules.forEach((policy, idx) => {
            const logName = policy.logName || 'Security';
            let conditions = [];
            
            let idQueries = [];
            if (policy.includeIds) {
                const ids = policy.includeIds.split(',').map(id => id.trim()).filter(Boolean);
                if (ids.length) idQueries.push(`(${ids.map(id => `EventID=${id}`).join(' or ')})`);
            }
            if (policy.excludeIds) {
                const ids = policy.excludeIds.split(',').map(id => id.trim()).filter(Boolean);
                if (ids.length) idQueries.push(`not(${ids.map(id => `EventID=${id}`).join(' or ')})`);
            }
            if (idQueries.length) conditions.push(`(${idQueries.join(' and ')})`);
            
            if (policy.severity && policy.severity !== 'All') {
                const levelMap = { 'Critical': 1, 'Error': 2, 'Warning': 3, 'Information': 4 };
                if (levelMap[policy.severity]) {
                    conditions.push(`Level<=${levelMap[policy.severity]}`);
                }
            }
            
            let query = '*';
            if (conditions.length) {
                query = `*[System[${conditions.join(' and ')}]]`;
            }
            if (policy.excludeUsers) {
                const users = policy.excludeUsers.split(',').map(u => u.trim()).filter(Boolean);
                if (users.length > 0) {
                    const userConds = [];
                    users.forEach(u => {
                        userConds.push(`not(Data[@Name='TargetUserName']='${u}')`);
                        userConds.push(`not(Data[@Name='SubjectUserName']='${u}')`);
                    });
                    query += ` and *[EventData[${userConds.join(' and ')}]]`;
                }
            }
            xml += `  <Query Id="${idx}" Path="${logName}">\n    <Select Path="${logName}">${query}</Select>\n  </Query>\n`;
        });
        xml += '</QueryList>';
        setGeneratedXML(xml);
    }, [rules]);

    const handleDeployPolicy = async () => {
        if (isViewer) {
            showToast('Viewers cannot deploy policies', 'error');
            return;
        }

        // Automatic Syntax Pre-check to prevent outages
        if (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) {
            const val = await handleValidateSyntax(true);
            if (val && !val.valid) {
                setShowValidationModal(true);
                showToast('策略語法檢查未通過，請先修正錯誤後再部署', 'error');
                return;
            }
        }

        fetch('/api/monitor/winevent/policy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(rules)
        })
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                showToast(data.error, 'error');
                return;
            }
            
            // Also deploy Push Policy
            fetch('/api/monitor/winevent/push_policy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(pushPolicy)
            })
            .then(res => res.json())
            .then(pushData => {
                if (pushData.error) {
                    showToast(pushData.error, 'error');
                    if (pushData.validation && !pushData.validation.valid) {
                        setValidationResult(pushData.validation);
                        setShowValidationModal(true);
                    }
                } else {
                    showToast('Windows Event 策略與 Elasticsearch 推送規則已成功部署至全網 Agents', 'success');
                    setValidationResult(null);
                }
            })
            .catch(err => showToast('Failed to deploy push policy', 'error'));
        })
        .catch(err => showToast('Failed to deploy policy', 'error'));
    };

    const addRule = () => {
        setRules([...rules, { logName: 'System', includeIds: '', excludeIds: '', excludeUsers: '', severity: 'All' }]);
    };

    const deleteRule = (idx) => {
        setRules(rules.filter((_, i) => i !== idx));
    };

    const updateRule = (idx, field, value) => {
        const newRules = [...rules];
        newRules[idx][field] = value;
        setRules(newRules);
    };

    const getLevelBadge = (level) => {
        switch(level) {
            case 'Error': case 'Critical': return <span style={{...S.badge, background: 'rgba(239,68,68,0.2)', color: '#ef4444'}}>ERROR</span>;
            case 'Warning': return <span style={{...S.badge, background: 'rgba(245,158,11,0.2)', color: '#f59e0b'}}>WARN</span>;
            default: return <span style={{...S.badge, background: 'rgba(59,130,246,0.2)', color: '#3b82f6'}}>INFO</span>;
        }
    };

    const policyContent = (
        <>
            <div style={S.card}>
                <div 
                    style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                    onClick={() => setPolicyCollapsed(!policyCollapsed)}
                >
                    <span>Configure Event Subscription Policy {policyCollapsed ? '▼' : '▲'}</span>
                    <div style={{ display: 'flex', gap: 12 }}>
                        {!isViewer && !policyCollapsed && (
                            <button style={{ padding: '6px 16px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 12, fontWeight: 800, cursor: 'pointer' }} onClick={e => { e.stopPropagation(); addRule(); }}>+ Add Rule</button>
                        )}
                    </div>
                </div>
                {!policyCollapsed && (
                <div style={S.cardBody}>
                    {rules.map((rule, idx) => (
                        <div key={idx} style={{ padding: 20, border: '1px solid var(--border-color)', borderRadius: 12, marginBottom: 20, position: 'relative' }}>
                            {rules.length > 1 && !isViewer && (
                                <button onClick={() => deleteRule(idx)} style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 20, fontSize: 11, fontWeight: 800, padding: '4px 12px', cursor: 'pointer' }}>Delete</button>
                            )}
                            <h4 style={{ margin: '0 0 16px 0', color: 'var(--accent-primary)' }}>Rule #{idx + 1}</h4>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Event Channel / Log Name</label>
                                    <div style={{ display: 'flex', gap: 12 }}>
                                        <select 
                                            style={{ ...S.select, flex: 1 }}
                                            value={["Security", "System", "Application", "Microsoft-Windows-Sysmon/Operational", "Windows PowerShell", "Microsoft-Windows-Windows Defender/Operational"].includes(rule.logName) ? rule.logName : 'Custom'}
                                            onChange={e => updateRule(idx, 'logName', e.target.value === 'Custom' ? '' : e.target.value)}
                                            disabled={isViewer}
                                        >
                                            <option value="Security">Security</option>
                                            <option value="System">System</option>
                                            <option value="Application">Application</option>
                                            <option value="Microsoft-Windows-Sysmon/Operational">Microsoft-Windows-Sysmon/Operational</option>
                                            <option value="Windows PowerShell">Windows PowerShell</option>
                                            <option value="Microsoft-Windows-Windows Defender/Operational">Microsoft-Windows-Windows Defender/Operational</option>
                                            <option value="Custom">Custom Channel...</option>
                                        </select>
                                        
                                        {!["Security", "System", "Application", "Microsoft-Windows-Sysmon/Operational", "Windows PowerShell", "Microsoft-Windows-Windows Defender/Operational"].includes(rule.logName) && (
                                            <input 
                                                style={{ ...S.input, flex: 1.5 }}
                                                value={rule.logName} 
                                                onChange={e => updateRule(idx, 'logName', e.target.value)} 
                                                placeholder="Type custom channel name..."
                                                disabled={isViewer} 
                                            />
                                        )}
                                    </div>
                                </div>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Severity Level</label>
                                    <select style={S.select} value={rule.severity} onChange={e => updateRule(idx, 'severity', e.target.value)} disabled={isViewer}>
                                        <option value="All">All Levels</option>
                                        <option value="Information">Information & Above</option>
                                        <option value="Warning">Warning & Above</option>
                                        <option value="Error">Error & Critical</option>
                                    </select>
                                </div>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Include Event IDs (comma separated)</label>
                                    <input style={S.input} value={rule.includeIds} onChange={e => updateRule(idx, 'includeIds', e.target.value)} placeholder="e.g. 4624, 4625" disabled={isViewer} />
                                </div>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Exclude Event IDs (comma separated)</label>
                                    <input style={S.input} value={rule.excludeIds} onChange={e => updateRule(idx, 'excludeIds', e.target.value)} placeholder="e.g. 5156, 4658" disabled={isViewer} />
                                </div>
                                <div style={{ ...S.inputGroup, gridColumn: 'span 2' }}>
                                    <label style={{ ...S.label, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span>Exclude Users (排除使用者 / 服務帳號，逗號分隔)</span>
                                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-primary)', textTransform: 'none' }}>
                                            🛡️ 過濾 TargetUserName 與 SubjectUserName (不分大小寫)
                                        </span>
                                    </label>
                                    <input 
                                        style={S.input} 
                                        value={rule.excludeUsers || ''} 
                                        onChange={e => updateRule(idx, 'excludeUsers', e.target.value)} 
                                        placeholder="例: svc_backup, healthcheck, NT AUTHORITY\SYSTEM (支援網域前綴)" 
                                        disabled={isViewer} 
                                    />
                                </div>
                            </div>
                        </div>
                    ))}

                    <div style={{ ...S.inputGroup, background: 'rgba(0,0,0,0.2)', padding: 16, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                        <label style={{...S.label, color: 'var(--accent-primary)'}}>Generated WEVTAPI XML Query (Auto-generated)</label>
                        <pre style={{ fontSize: 12, color: 'var(--text-primary)', overflowX: 'auto', margin: 0, fontFamily: 'monospace' }}>
                            {generatedXML}
                        </pre>
                    </div>
                </div>
                )}
            </div>

            <div style={S.card}>
                <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Configure Advanced Output Routings</span>
                </div>
                
                <div style={{ padding: '0 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: 24, marginTop: 12 }}>
                    <div 
                        style={{ padding: '12px 0', cursor: 'pointer', borderBottom: outputTab === 'elasticsearch' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: outputTab === 'elasticsearch' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: outputTab === 'elasticsearch' ? 800 : 500 }}
                        onClick={() => setOutputTab('elasticsearch')}
                    >
                        Elasticsearch
                    </div>
                    <div 
                        style={{ padding: '12px 0', cursor: 'pointer', borderBottom: outputTab === 'kafka' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: outputTab === 'kafka' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: outputTab === 'kafka' ? 800 : 500 }}
                        onClick={() => setOutputTab('kafka')}
                    >
                        Kafka (Coming Soon)
                    </div>
                    <div 
                        style={{ padding: '12px 0', cursor: 'pointer', borderBottom: outputTab === 'syslog' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: outputTab === 'syslog' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: outputTab === 'syslog' ? 800 : 500 }}
                        onClick={() => setOutputTab('syslog')}
                    >
                        Syslog (Coming Soon)
                    </div>
                </div>

                {outputTab === 'elasticsearch' && (
                    <div style={S.cardBody}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Elasticsearch Output Settings</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: pushPolicy.elasticsearchEnabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {pushPolicy.elasticsearchEnabled ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={pushPolicy.elasticsearchEnabled} onChange={e => setPushPolicy({...pushPolicy, elasticsearchEnabled: e.target.checked})} disabled={isViewer} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: pushPolicy.elasticsearchEnabled ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: pushPolicy.elasticsearchEnabled ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>
                        
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 24, marginBottom: 24, opacity: pushPolicy.elasticsearchEnabled ? 1 : 0.4, pointerEvents: pushPolicy.elasticsearchEnabled ? 'auto' : 'none' }}>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Elasticsearch URL</label>
                                <input style={S.input} value={pushPolicy.url} onChange={e => setPushPolicy({...pushPolicy, url: e.target.value})} placeholder="https://localhost:9200" disabled={isViewer} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Username</label>
                                <input style={S.input} value={pushPolicy.username} onChange={e => setPushPolicy({...pushPolicy, username: e.target.value})} placeholder="elastic" disabled={isViewer} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Password</label>
                                <input style={S.input} type="password" value={pushPolicy.password} onChange={e => setPushPolicy({...pushPolicy, password: e.target.value})} placeholder="********" disabled={isViewer} />
                            </div>
                        </div>

                        {/* Sub-feature 1: Windows Event Log Push */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 16, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
                            <div>
                                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>Windows Event Log Push to ES</span>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Real-time streaming and filtering of Security, System & Application event logs</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {pushPolicy.logEnabled !== false ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={pushPolicy.logEnabled !== false} onChange={e => setPushPolicy({...pushPolicy, logEnabled: e.target.checked})} disabled={isViewer || !pushPolicy.elasticsearchEnabled} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ ...S.inputGroup, opacity: (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) ? 1 : 0.4, pointerEvents: (pushPolicy.elasticsearchEnabled && pushPolicy.logEnabled !== false) ? 'auto' : 'none' }}>
                            <label style={S.label}>Windows Event Log Index Name (Optional)</label>
                            <input style={S.input} value={pushPolicy.logIndexName || ''} onChange={e => setPushPolicy({...pushPolicy, logIndexName: e.target.value})} placeholder="vanguard-winevent-%Y.%m.%d" disabled={isViewer} />
                            
                            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <button 
                                        type="button" 
                                        onClick={() => setYamlCollapsed(!yamlCollapsed)} 
                                        style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 800, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        <span>{yamlCollapsed ? '▶' : '▼'}</span> Elasticsearch Event Filtering Policy
                                    </button>
                                    <span style={{ fontSize: 11, background: 'rgba(16,185,129,0.15)', color: '#10b981', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>
                                        {esRules.length} Rules Active
                                    </span>
                                </div>

                                {!yamlCollapsed && (
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                        {/* Editor Mode Segmented Switch */}
                                        <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 20, padding: 2 }}>
                                            <button
                                                type="button"
                                                onClick={switchToVisualMode}
                                                style={{
                                                    padding: '5px 14px',
                                                    borderRadius: 18,
                                                    border: 'none',
                                                    fontSize: 12,
                                                    fontWeight: 800,
                                                    cursor: 'pointer',
                                                    background: esEditorMode === 'visual' ? 'var(--accent-primary)' : 'transparent',
                                                    color: esEditorMode === 'visual' ? '#fff' : 'var(--text-muted)',
                                                    transition: 'all 0.2s'
                                                }}
                                            >
                                                🎛️ 視覺化設定模式 (防呆推薦)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setEsEditorMode('yaml')}
                                                style={{
                                                    padding: '5px 14px',
                                                    borderRadius: 18,
                                                    border: 'none',
                                                    fontSize: 12,
                                                    fontWeight: 800,
                                                    cursor: 'pointer',
                                                    background: esEditorMode === 'yaml' ? 'var(--accent-primary)' : 'transparent',
                                                    color: esEditorMode === 'yaml' ? '#fff' : 'var(--text-muted)',
                                                    transition: 'all 0.2s'
                                                }}
                                            >
                                                💻 進階 YAML 模式
                                            </button>
                                        </div>

                                        {esEditorMode === 'visual' && !isViewer && (
                                            <button 
                                                type="button"
                                                onClick={addEsRule} 
                                                style={{ padding: '6px 14px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
                                            >
                                                + Add Rule
                                            </button>
                                        )}

                                        <button
                                            type="button"
                                            onClick={handleLoadDefaultTemplate}
                                            disabled={isViewer}
                                            style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: isViewer ? 'not-allowed' : 'pointer' }}
                                            title="載入標準過濾規則範本"
                                        >
                                            📄 載入標準範本
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* Mode 1: Visual Rule Builder */}
                            {!yamlCollapsed && esEditorMode === 'visual' && (
                                <div style={{ marginTop: 14 }}>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                                        採用與上方 Event Subscription Policy 完全一致的卡片選單，系統會自動轉換為標準 YAML。下拉選單值已永久鎖定標準關鍵字，線上 Scout Agent 無需重新派送。
                                    </div>

                                    {esRules.map((rule, idx) => (
                                        <div key={idx} style={{ padding: 18, border: '1px solid var(--border-color)', borderRadius: 12, marginBottom: 16, background: 'rgba(255,255,255,0.02)', position: 'relative' }}>
                                            {esRules.length > 1 && !isViewer && (
                                                <button 
                                                    type="button"
                                                    onClick={() => deleteEsRule(idx)} 
                                                    style={{ position: 'absolute', top: 14, right: 14, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 20, fontSize: 11, fontWeight: 800, padding: '4px 12px', cursor: 'pointer' }}
                                                >
                                                    Delete
                                                </button>
                                            )}
                                            <h4 style={{ margin: '0 0 14px 0', fontSize: 13, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span>ES Filter Rule #{idx + 1}</span>
                                            </h4>
                                            
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                                <div style={S.inputGroup}>
                                                    <label style={S.label}>Event Channel / Log Name</label>
                                                    <div style={{ display: 'flex', gap: 10 }}>
                                                        <select 
                                                            style={{ ...S.select, flex: 1 }}
                                                            value={["Security", "System", "Application", "Microsoft-Windows-Sysmon/Operational", "Windows PowerShell", "Microsoft-Windows-Windows Defender/Operational"].includes(rule.channel) ? rule.channel : 'Custom'}
                                                            onChange={e => updateEsRule(idx, 'channel', e.target.value === 'Custom' ? '' : e.target.value)}
                                                            disabled={isViewer}
                                                        >
                                                            <option value="Security">Security</option>
                                                            <option value="System">System</option>
                                                            <option value="Application">Application</option>
                                                            <option value="Microsoft-Windows-Sysmon/Operational">Microsoft-Windows-Sysmon/Operational</option>
                                                            <option value="Windows PowerShell">Windows PowerShell</option>
                                                            <option value="Microsoft-Windows-Windows Defender/Operational">Microsoft-Windows-Windows Defender/Operational</option>
                                                            <option value="Custom">Custom Channel...</option>
                                                        </select>
                                                        
                                                        {!["Security", "System", "Application", "Microsoft-Windows-Sysmon/Operational", "Windows PowerShell", "Microsoft-Windows-Windows Defender/Operational"].includes(rule.channel) && (
                                                            <input 
                                                                style={{ ...S.input, flex: 1.5 }}
                                                                value={rule.channel} 
                                                                onChange={e => updateEsRule(idx, 'channel', e.target.value)} 
                                                                placeholder="輸入自訂頻道名稱..."
                                                                disabled={isViewer} 
                                                            />
                                                        )}
                                                    </div>
                                                </div>

                                                <div style={S.inputGroup}>
                                                    <label style={S.label}>Severity Level (過濾等級)</label>
                                                    <select 
                                                        style={S.select} 
                                                        value={rule.severity || 'All'} 
                                                        onChange={e => updateEsRule(idx, 'severity', e.target.value)} 
                                                        disabled={isViewer}
                                                    >
                                                        <option value="All">All Levels (全部等級)</option>
                                                        <option value="Information">Information & Above (包含通知)</option>
                                                        <option value="Warning">Warning & Above (警示與嚴重)</option>
                                                        <option value="Error">Error & Critical (錯誤與重大異常)</option>
                                                        <option value="Critical">Critical Only (僅重大嚴重)</option>
                                                    </select>
                                                </div>

                                                <div style={S.inputGroup}>
                                                    <label style={S.label}>Include Event IDs (逗號分隔，選填)</label>
                                                    <input 
                                                        style={S.input} 
                                                        value={rule.includeIds || ''} 
                                                        onChange={e => updateEsRule(idx, 'includeIds', e.target.value)} 
                                                        placeholder="例: 4624, 4625 (留空表示不限制)" 
                                                        disabled={isViewer} 
                                                    />
                                                </div>

                                                <div style={S.inputGroup}>
                                                    <label style={S.label}>Exclude Event IDs (逗號分隔，排除雜訊)</label>
                                                    <input 
                                                        style={S.input} 
                                                        value={rule.excludeIds || ''} 
                                                        onChange={e => updateEsRule(idx, 'excludeIds', e.target.value)} 
                                                        placeholder="例: 5379, 4798, 4799" 
                                                        disabled={isViewer} 
                                                    />
                                                </div>

                                                <div style={{ ...S.inputGroup, gridColumn: 'span 2' }}>
                                                    <label style={{ ...S.label, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <span>Exclude Users (排除推送至 ES 的帳號，逗號分隔)</span>
                                                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-primary)', textTransform: 'none' }}>
                                                            🛡️ 自動轉為 YAML 中的 exclude_users 陣列
                                                        </span>
                                                    </label>
                                                    <input 
                                                        style={S.input} 
                                                        value={rule.excludeUsers || ''} 
                                                        onChange={e => updateEsRule(idx, 'excludeUsers', e.target.value)} 
                                                        placeholder="例: svc_backup, healthcheck (留空表示全部推送)" 
                                                        disabled={isViewer} 
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}

                                    {/* Auto-generated YAML Preview Box */}
                                    <div style={{ ...S.inputGroup, background: 'rgba(0,0,0,0.25)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', marginTop: 8 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <label style={{ ...S.label, color: 'var(--accent-primary)', margin: 0 }}>
                                                Auto-generated Elasticsearch Policy (YAML 即時預覽)
                                            </label>
                                            <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700 }}>
                                                ✓ 由上方視覺化規則即時生成，100% 合規免手寫
                                            </span>
                                        </div>
                                        <pre style={{ fontSize: 12, color: '#10b981', overflowX: 'auto', margin: 0, fontFamily: 'Consolas, Monaco, monospace', lineHeight: 1.5 }}>
                                            {pushPolicy.yamlConfig}
                                        </pre>
                                    </div>
                                </div>
                            )}

                            {/* Mode 2: Advanced YAML Mode */}
                            {!yamlCollapsed && esEditorMode === 'yaml' && (
                                <div style={{ marginTop: 14 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                            進階 YAML 原始碼模式（支援 channel, level, event_ids）
                                        </div>
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                            <button
                                                type="button"
                                                onClick={handleAutoFixLevels}
                                                disabled={isViewer}
                                                style={{ padding: '6px 12px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.4)', borderRadius: 8, color: '#10b981', fontSize: 12, fontWeight: 700, cursor: isViewer ? 'not-allowed' : 'pointer' }}
                                                title="自動將 All Levels, Warning & Above, Error & Critical 等修正為標準 Level"
                                            >
                                                🪄 自動修正格式
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleValidateSyntax(false)}
                                                disabled={validating}
                                                style={{ padding: '6px 14px', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, fontWeight: 800, cursor: validating ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                                                id="btn-validate-yaml-syntax"
                                            >
                                                {validating ? '⏳ 驗證中...' : '🔍 檢查語法'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={switchToVisualMode}
                                                style={{ padding: '6px 14px', background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                                            >
                                                🎛️ 轉為視覺化卡片
                                            </button>
                                        </div>
                                    </div>

                                    <textarea 
                                        style={{ 
                                            ...S.input, 
                                            minHeight: 250, 
                                            fontFamily: 'Consolas, Monaco, "Courier New", monospace', 
                                            fontSize: 13, 
                                            lineHeight: 1.5, 
                                            background: 'rgba(0,0,0,0.25)', 
                                            border: validationResult ? (validationResult.valid ? '1px solid #10b981' : '1px solid #ef4444') : '1px solid var(--border-color)',
                                            marginTop: 6 
                                        }} 
                                        value={pushPolicy.yamlConfig} 
                                        onChange={e => {
                                            setPushPolicy({...pushPolicy, yamlConfig: e.target.value});
                                            if (validationResult) setValidationResult(null);
                                        }}
                                        disabled={isViewer}
                                        spellCheck={false}
                                        placeholder="scout_push_policy:
  - channel: Security
    level: All
    event_ids:
      exclude: [5379, 4798]"
                                    />

                                    {/* Inline Validation Status Box */}
                                    {validationResult && (
                                        <div style={{ 
                                            marginTop: 10, 
                                            padding: '12px 16px', 
                                            borderRadius: 10, 
                                            border: validationResult.valid ? '1px solid rgba(16,185,129,0.35)' : '1px solid rgba(239,68,68,0.35)', 
                                            background: validationResult.valid ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)' 
                                        }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 13, color: validationResult.valid ? '#10b981' : '#ef4444' }}>
                                                    <span>{validationResult.valid ? '✓' : '⚠️'}</span>
                                                    <span>{validationResult.valid ? `語法檢查通過 (成功解析 ${validationResult.ruleCount || 0} 條過濾規則)` : `語法檢查未通過 (發現 ${validationResult.errors?.length || 0} 項格式問題)`}</span>
                                                </div>
                                                {!validationResult.valid && (
                                                    <button 
                                                        type="button" 
                                                        onClick={handleAutoFixLevels}
                                                        style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                    >
                                                        嘗試一鍵修正
                                                    </button>
                                                )}
                                            </div>

                                            {validationResult.errors?.length > 0 && (
                                                <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12, color: '#f87171', lineHeight: 1.6 }}>
                                                    {validationResult.errors.map((err, i) => (
                                                        <li key={i}>{err}</li>
                                                    ))}
                                                </ul>
                                            )}

                                            {validationResult.warnings?.length > 0 && (
                                                <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
                                                    {validationResult.warnings.map((w, i) => (
                                                        <li key={i}><strong>提示：</strong> {w}</li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Sub-feature 2: System Metrics Push */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
                            <div>
                                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>System Metrics Push to ES (ECS Format)</span>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Periodic telemetry reporting of CPU, Memory, Disk, Services & Processes in ECS dotted format</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: (pushPolicy.elasticsearchEnabled && pushPolicy.metricsEnabled) ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                    {pushPolicy.metricsEnabled ? 'Enabled' : 'Disabled'}
                                </span>
                                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                    <input type="checkbox" style={{ opacity: 0, width: 0, height: 0 }} checked={pushPolicy.metricsEnabled} onChange={e => setPushPolicy({...pushPolicy, metricsEnabled: e.target.checked})} disabled={isViewer || !pushPolicy.elasticsearchEnabled} />
                                    <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: (pushPolicy.elasticsearchEnabled && pushPolicy.metricsEnabled) ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                        <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: (pushPolicy.elasticsearchEnabled && pushPolicy.metricsEnabled) ? 'translateX(20px)' : 'none' }}></span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ ...S.inputGroup, opacity: (pushPolicy.elasticsearchEnabled && pushPolicy.metricsEnabled) ? 1 : 0.4, pointerEvents: (pushPolicy.elasticsearchEnabled && pushPolicy.metricsEnabled) ? 'auto' : 'none' }}>
                            <label style={S.label}>Metrics Index Name (Optional)</label>
                            <input style={S.input} value={pushPolicy.metricsIndexName || ''} onChange={e => setPushPolicy({...pushPolicy, metricsIndexName: e.target.value})} placeholder="vanguard-metrics-%Y.%m.%d" disabled={isViewer} />
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Metrics will be pushed in Elastic Common Schema (ECS) dotted key-value format.</div>
                        </div>
                    </div>
                )}
                
                {outputTab === 'kafka' && (
                    <div style={{ ...S.cardBody, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: 48, marginBottom: 16 }}>🚀</div>
                        <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)' }}>Kafka Output (Coming Soon)</h3>
                        <p style={{ margin: 0, textAlign: 'center', maxWidth: 400 }}>Support for producing Windows Event Logs to Apache Kafka topics is on our roadmap. Stay tuned!</p>
                    </div>
                )}
                
                {outputTab === 'syslog' && (
                    <div style={{ ...S.cardBody, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: 48, marginBottom: 16 }}>📡</div>
                        <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)' }}>Syslog Output (Coming Soon)</h3>
                        <p style={{ margin: 0, textAlign: 'center', maxWidth: 400 }}>Support for forwarding Windows Event Logs to Syslog servers (UDP/TCP/TLS) is on our roadmap.</p>
                    </div>
                )}
            </div>
            
            {!isViewer && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                    <button style={S.btnP} onClick={handleDeployPolicy}>Deploy Policy to Agents</button>
                </div>
            )}
        </>
    );

    if (configOnly) {
        return policyContent;
    }

    return (
        <div style={S.page}>
            <div style={S.header}>
                <h1 style={S.title}>📝 Windows Event Monitor</h1>
            </div>

            <div style={S.tabRow}>
                <button style={activeTab === 'policy' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('policy')}>Event Policy Builder</button>
                <button style={activeTab === 'live' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('live')}>Live Event Viewer</button>
            </div>

            {activeTab === 'policy' && policyContent}

            {activeTab === 'live' && (
                <div style={S.card}>
                    <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between' }}>
                        <span>Real-time Event Stream</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                            <input type="checkbox" checked={liveTail} onChange={e => setLiveTail(e.target.checked)} style={{ cursor: 'pointer' }} />
                            🟢 Live Tail (WebSocket)
                        </label>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>Timestamp</th>
                                    <th style={S.th}>Host</th>
                                    <th style={S.th}>Level</th>
                                    <th style={S.th}>Event ID</th>
                                    <th style={S.th}>Provider</th>
                                    <th style={S.th}>Message Preview</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.length === 0 ? (
                                    <tr><td colSpan="6" style={{...S.td, textAlign: 'center', color: 'var(--text-muted)'}}>Listening for events...</td></tr>
                                ) : events.map(ev => (
                                    <tr key={ev.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedEvent(ev)} className="hover-highlight">
                                        <td style={S.td}>{new Date(ev.timestamp).toLocaleTimeString()}</td>
                                        <td style={S.td}>{ev.host}</td>
                                        <td style={S.td}>{getLevelBadge(ev.level)}</td>
                                        <td style={S.td}>{ev.eventID}</td>
                                        <td style={S.td}>{ev.provider}</td>
                                        <td style={{...S.td, color: 'var(--text-muted)'}}>{ev.message}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {selectedEvent && (() => {
                let extractedUser = null;
                if (selectedEvent.raw) {
                    try {
                        const parsedEvt = typeof selectedEvent.raw === 'string' ? JSON.parse(selectedEvent.raw) : selectedEvent.raw;
                        if (parsedEvt && parsedEvt.EventData && Array.isArray(parsedEvt.EventData.Data)) {
                            for (const d of parsedEvt.EventData.Data) {
                                if (!d || !d.Name || !d.Value) continue;
                                const dName = String(d.Name).toLowerCase();
                                if (dName === 'targetusername' || dName === 'subjectusername' || dName === 'user' || dName === 'samaccountname') {
                                    const v = String(d.Value).trim();
                                    if (v && v !== '-' && v.toLowerCase() !== 'system' && !extractedUser) {
                                        extractedUser = v;
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }

                return (
                    <div style={S.modalOverlay} onClick={() => setSelectedEvent(null)}>
                        <div style={S.modalContent} onClick={e => e.stopPropagation()}>
                            <div style={S.modalHead}>
                                <h3 style={S.modalTitle}>Event Detail: {selectedEvent.eventID}</h3>
                                <button onClick={() => setSelectedEvent(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
                            </div>
                            <div style={S.modalBody}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                                    <div><strong style={{color:'var(--text-muted)', fontSize: 12}}>Host:</strong> <div style={{fontSize: 14}}>{selectedEvent.host}</div></div>
                                    <div><strong style={{color:'var(--text-muted)', fontSize: 12}}>Level:</strong> <div style={{fontSize: 14}}>{selectedEvent.level}</div></div>
                                    <div><strong style={{color:'var(--text-muted)', fontSize: 12}}>Provider:</strong> <div style={{fontSize: 14}}>{selectedEvent.provider}</div></div>
                                    <div><strong style={{color:'var(--text-muted)', fontSize: 12}}>Time:</strong> <div style={{fontSize: 14}}>{new Date(selectedEvent.timestamp).toLocaleString()}</div></div>
                                    {extractedUser && (
                                        <div style={{ gridColumn: 'span 2', background: 'rgba(255,255,255,0.03)', padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <strong style={{color:'var(--text-muted)', fontSize: 12}}>Target / Subject User: </strong>
                                                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent-primary)', marginLeft: 6 }}>{extractedUser}</span>
                                            </div>
                                            {!isViewer && (
                                                <button 
                                                    type="button" 
                                                    onClick={() => handleQuickExcludeUser(extractedUser)}
                                                    style={{ padding: '5px 14px', background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 16, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
                                                    title="快速將此帳號加入全域日誌排除名單"
                                                >
                                                    🚫 一鍵加入排除清單
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div style={{ marginBottom: 16 }}>
                                    <strong style={{color:'var(--text-muted)', fontSize: 12}}>Message:</strong>
                                    <div style={{fontSize: 14, background: 'rgba(0,0,0,0.1)', padding: 12, borderRadius: 8, marginTop: 4}}>{selectedEvent.message}</div>
                                </div>
                                <div>
                                    <strong style={{color:'var(--text-muted)', fontSize: 12}}>Raw JSON:</strong>
                                    <pre style={{fontSize: 12, background: '#111', padding: 12, borderRadius: 8, marginTop: 4, overflowX: 'auto', color: '#10b981'}}>
                                        {JSON.stringify(JSON.parse(selectedEvent.raw), null, 2)}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* In-app Syntax Validation Intercept Modal */}
            {showValidationModal && validationResult && !validationResult.valid && (
                <div style={S.modalOverlay} onClick={() => setShowValidationModal(false)}>
                    <div style={{ ...S.modalContent, maxWidth: 580 }} onClick={e => e.stopPropagation()}>
                        <div style={{ ...S.modalHead, borderBottom: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.06)', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 20 }}>⚠️</span>
                                <h3 style={{ ...S.modalTitle, color: '#ef4444', fontSize: 16 }}>YAML 設定語法錯誤 (已阻止部署)</h3>
                            </div>
                            <button onClick={() => setShowValidationModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
                        </div>
                        <div style={{ padding: '24px 32px' }}>
                            <p style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 0, marginBottom: 16, lineHeight: 1.6 }}>
                                為防止 Scout Agent 發生解析錯誤或因 Level 關鍵字不匹配導致 Windows Event Logs 被丟棄，系統已暫停部署。請檢閱以下問題：
                            </p>
                            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 12, padding: '14px 18px', marginBottom: 24 }}>
                                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#f87171', lineHeight: 1.7 }}>
                                    {validationResult.errors?.map((err, i) => (
                                        <li key={i}>{err}</li>
                                    ))}
                                </ul>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                                <button 
                                    type="button" 
                                    onClick={() => setShowValidationModal(false)} 
                                    style={{ padding: '8px 18px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', borderRadius: 10, color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                                >
                                    返回手動修改
                                </button>
                                <button 
                                    type="button" 
                                    onClick={() => {
                                        handleAutoFixLevels();
                                        setShowValidationModal(false);
                                    }} 
                                    style={{ padding: '8px 18px', background: 'var(--accent-primary)', border: 'none', borderRadius: 10, color: '#fff', fontWeight: 800, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                                >
                                    🪄 一鍵自動修正格式
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
