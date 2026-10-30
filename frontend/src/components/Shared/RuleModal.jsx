import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';

const S = {
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(15,23,42,0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '90%', maxWidth: 580, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', margin: 'auto' },
    modalHead: { padding: '24px 32px 16px 32px', borderBottom: '1px solid var(--border-color)', background: 'rgba(15,23,42,0.2)' },
    modalTitle: { fontSize: 20, fontWeight: 900, margin: 0, color: 'var(--text-primary)', letterSpacing: '-0.02em' },
    tabNav: { display: 'flex', gap: 8, marginTop: 16 },
    tabBtn: (active) => ({
        padding: '8px 18px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 800,
        cursor: 'pointer',
        border: active ? '1px solid var(--accent-primary)' : '1px solid transparent',
        background: active ? 'var(--accent-glow)' : 'transparent',
        color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        gap: 6
    }),
    modalBody: { padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', maxHeight: '70vh' },
    modalFoot: { padding: '18px 32px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' },
    inputGroup: { display: 'flex', flexDirection: 'column', gap: 7 },
    label: { display: 'block', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' },
    input: { width: '100%', padding: '11px 15px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, outline: 'none', transition: 'border-color 0.2s', boxSizing: 'border-box' },
    select: { width: '100%', padding: '11px 15px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, outline: 'none', boxSizing: 'border-box' },
    btnS: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s' },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px var(--accent-glow)', transition: 'all 0.2s' },
    pillBtn: (active) => ({
        padding: '4px 10px',
        borderRadius: 8,
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        border: active ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
        background: active ? 'var(--accent-glow)' : 'var(--bg-primary)',
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
        transition: 'all 0.15s ease'
    })
};

export default function RuleModal({ rule, onClose, onSave, canManageSelfHealing }) {
    const { showToast } = useToast();
    const [modalTab, setModalTab] = useState('metric'); // 'metric' | 'log'
    const [showRemediation, setShowRemediation] = useState(false);
    
    // Core Form
    const [ruleForm, setRuleForm] = useState({
        id: '',
        name: '',
        type: 'cpu',
        target: '',
        threshold: 80,
        cpuThreshold: '',
        memThreshold: '',
        alertHits: 3,
        escalateAfterMin: '',
        emails: '',
        remediationScript: '',
        remediationCooldown: 300,
        remediationMaxRetries: 3
    });

    // Notification Channels (Multi-select: Mail, TG, Webhook)
    const [notifyMail, setNotifyMail] = useState(true);
    const [notifyTg, setNotifyTg] = useState(false);
    const [notifyWebhook, setNotifyWebhook] = useState(false);
    const [selectedWebhookId, setSelectedWebhookId] = useState('all');
    const [availableWebhooks, setAvailableWebhooks] = useState([]);

    // Fetch existing webhooks for dropdown
    useEffect(() => {
        api.get('/webhooks')
            .then(res => setAvailableWebhooks(res.data || []))
            .catch(err => console.error('Failed to load webhooks:', err));
    }, []);

    // Event & Syslog Form
    const [logType, setLogType] = useState('winevent'); // 'winevent' | 'syslog'
    const [winChannel, setWinChannel] = useState('Security');
    const [winEventID, setWinEventID] = useState('4740');
    const [winLevel, setWinLevel] = useState('All');
    const [winKeyword, setWinKeyword] = useState('');
    const [winExcludeUsers, setWinExcludeUsers] = useState('');
    
    const [sysLogPath, setSysLogPath] = useState('/var/log/secure');
    const [sysSeverity, setSysSeverity] = useState('All');
    const [sysKeyword, setSysKeyword] = useState('Failed password');

    useEffect(() => {
        if (rule) {
            const isLogRule = rule.category === 'log' || ['winevent', 'syslog'].includes(rule.type);
            setModalTab(isLogRule ? 'log' : 'metric');

            let parsedActions = [];
            try {
                parsedActions = Array.isArray(rule.actions) ? rule.actions : JSON.parse(rule.actions || '[]');
            } catch (e) {
                parsedActions = [];
            }

            const mailAction = parsedActions.find(e => e.type === 'mail');
            const tgAction = parsedActions.find(e => e.type === 'telegram');
            const whAction = parsedActions.find(e => e.type === 'webhook');

            setNotifyMail(!!mailAction);
            setNotifyTg(!!tgAction);
            setNotifyWebhook(!!whAction);
            setSelectedWebhookId(whAction?.webhookId || 'all');

            const emails = mailAction?.to || '';
            setRuleForm({
                id: rule.id || '',
                name: rule.name || '',
                type: rule.type || 'cpu',
                target: rule.target || '',
                threshold: rule.threshold || 80,
                cpuThreshold: rule.cpuThreshold !== null && rule.cpuThreshold !== undefined ? rule.cpuThreshold : '',
                memThreshold: rule.memThreshold !== null && rule.memThreshold !== undefined ? rule.memThreshold : '',
                alertHits: rule.alertHits || (isLogRule ? 1 : 3),
                escalateAfterMin: rule.escalateAfterMin || '',
                emails: emails,
                remediationScript: rule.remediationScript || '',
                remediationCooldown: rule.remediationCooldown || 300,
                remediationMaxRetries: rule.remediationMaxRetries || 3
            });

            if (isLogRule) {
                const cfg = rule.logConfig || {};
                const lt = rule.type === 'syslog' ? 'syslog' : 'winevent';
                setLogType(lt);
                if (lt === 'winevent') {
                    setWinChannel(cfg.channel || 'Security');
                    setWinEventID(cfg.eventID !== undefined ? String(cfg.eventID) : '');
                    setWinLevel(cfg.level || 'All');
                    setWinKeyword(cfg.keyword || '');
                    setWinExcludeUsers(cfg.excludeUsers || '');
                } else {
                    setSysLogPath(cfg.logPath || '/var/log/secure');
                    setSysSeverity(cfg.severity || 'All');
                    setSysKeyword(cfg.keyword || '');
                }
            }

            setShowRemediation(!!rule.remediationScript);
        } else {
            setModalTab('metric');
            setNotifyMail(true);
            setNotifyTg(false);
            setNotifyWebhook(false);
            setSelectedWebhookId('all');
            setRuleForm({
                id: '',
                name: '',
                type: 'cpu',
                target: '',
                threshold: 80,
                cpuThreshold: '',
                memThreshold: '',
                alertHits: 3,
                escalateAfterMin: '',
                emails: '',
                remediationScript: '',
                remediationCooldown: 300,
                remediationMaxRetries: 3
            });
            setLogType('winevent');
            setWinChannel('Security');
            setWinEventID('4740');
            setWinLevel('All');
            setWinKeyword('');
            setWinExcludeUsers('');
            setSysLogPath('/var/log/secure');
            setSysSeverity('All');
            setSysKeyword('Failed password');
            setShowRemediation(false);
        }
    }, [rule]);

    const handleTabSwitch = (tab) => {
        setModalTab(tab);
        if (tab === 'log') {
            if (!['winevent', 'syslog'].includes(ruleForm.type)) {
                setRuleForm(prev => ({
                    ...prev,
                    type: logType,
                    alertHits: prev.alertHits === 3 ? 1 : prev.alertHits
                }));
            }
        } else {
            if (['winevent', 'syslog'].includes(ruleForm.type)) {
                setRuleForm(prev => ({
                    ...prev,
                    type: 'cpu',
                    threshold: 80,
                    alertHits: prev.alertHits === 1 ? 3 : prev.alertHits
                }));
            }
        }
    };

    const applyWinPreset = (preset) => {
        if (!ruleForm.name || ruleForm.name.includes('Alert') || ruleForm.name.includes('Windows')) {
            setRuleForm(prev => ({ ...prev, name: preset.name }));
        }
        setWinChannel(preset.channel);
        setWinEventID(preset.eventID);
        setWinLevel(preset.level || 'All');
        if (preset.keyword) setWinKeyword(preset.keyword);
    };

    const applySyslogPreset = (preset) => {
        if (!ruleForm.name || ruleForm.name.includes('Alert') || ruleForm.name.includes('Linux')) {
            setRuleForm(prev => ({ ...prev, name: preset.name }));
        }
        setSysLogPath(preset.logPath);
        setSysSeverity(preset.severity || 'All');
        setSysKeyword(preset.keyword || '');
    };

    const handleSave = async () => {
        try {
            let { emails, ...payload } = ruleForm;

            // Construct multi-channel actions
            const actions = [];
            if (notifyMail) {
                actions.push({ type: 'mail', to: (emails || '').trim() });
            }
            if (notifyTg) {
                actions.push({ type: 'telegram' });
            }
            if (notifyWebhook) {
                actions.push({ type: 'webhook', webhookId: selectedWebhookId || 'all' });
            }
            payload.actions = actions;

            payload.category = modalTab === 'log' ? 'log' : 'metric';
            payload.escalateAfterMin = payload.escalateAfterMin === '' ? null : parseInt(payload.escalateAfterMin, 10) || null;

            if (modalTab === 'log') {
                payload.type = logType;
                payload.threshold = 1;
                payload.cpuThreshold = null;
                payload.memThreshold = null;

                if (logType === 'winevent') {
                    const logCfg = {
                        channel: winChannel || 'Security',
                        eventID: winEventID.trim(),
                        level: winLevel,
                        keyword: winKeyword.trim(),
                        excludeUsers: winExcludeUsers.trim()
                    };
                    payload.logConfig = logCfg;
                    payload.target = `[${logCfg.channel}] ID: ${logCfg.eventID || 'All'}`;
                } else {
                    const logCfg = {
                        logPath: sysLogPath || '/var/log/syslog',
                        severity: sysSeverity,
                        keyword: sysKeyword.trim()
                    };
                    payload.logConfig = logCfg;
                    payload.target = logCfg.logPath;
                }
            } else {
                payload.logConfig = null;
                payload.cpuThreshold = payload.cpuThreshold !== '' && !isNaN(parseFloat(payload.cpuThreshold)) ? parseFloat(payload.cpuThreshold) : null;
                payload.memThreshold = payload.memThreshold !== '' && !isNaN(parseFloat(payload.memThreshold)) ? parseFloat(payload.memThreshold) : null;
            }
            
            if (payload.id) {
                await api.put(`/monitor/rules/${payload.id}`, payload);
                showToast('Rule saved successfully', 'success');
            } else {
                await api.post('/monitor/rules', payload);
                showToast('Rule saved successfully', 'success');
            }
            if (onSave) onSave();
            onClose();
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to save rule', 'error');
        }
    };

    return (
        <div style={S.modalOverlay}>
            <div style={S.modalContent}>
                <div style={S.modalHead}>
                    <h2 style={S.modalTitle}>{ruleForm.id ? 'Edit Alert Rule' : 'Create Alert Rule'}</h2>
                    
                    {/* Top Tab Navigation */}
                    <div style={S.tabNav}>
                        <button
                            type="button"
                            style={S.tabBtn(modalTab === 'metric')}
                            onClick={() => handleTabSwitch('metric')}
                        >
                            📊 Metrics
                        </button>
                        <button
                            type="button"
                            style={S.tabBtn(modalTab === 'log')}
                            onClick={() => handleTabSwitch('log')}
                        >
                            📋 Event & Syslogs
                        </button>
                    </div>
                </div>

                <div style={S.modalBody}>
                    {/* Common Field: Name */}
                    <div style={S.inputGroup}>
                        <label style={S.label}>Rule Template Name</label>
                        <input 
                            style={S.input} 
                            value={ruleForm.name} 
                            onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })} 
                            placeholder={modalTab === 'log' ? 'e.g. Account Locked Out (4740), SSH Brute Force' : 'e.g. High CPU Usage Alert, Nginx Process Monitor'} 
                        />
                    </div>

                    {/* ================= TAB 1: METRICS ================= */}
                    {modalTab === 'metric' && (
                        <>
                            {/* Type & Target / Threshold */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Metric Type</label>
                                    <select 
                                        style={S.select} 
                                        value={ruleForm.type} 
                                        onChange={e => {
                                            const nextType = e.target.value;
                                            setRuleForm({ 
                                                ...ruleForm, 
                                                type: nextType, 
                                                target: nextType === 'offline' ? 'Heartbeat' : '', 
                                                threshold: nextType === 'offline' ? 300 : 80 
                                            });
                                        }}
                                    >
                                        <option value="cpu">🖥️ CPU Usage (%)</option>
                                        <option value="memory">💾 Memory Usage (%)</option>
                                        <option value="disk">💽 Disk Usage (%)</option>
                                        <option value="offline">📡 Agent Offline / Connectivity (離線告警)</option>
                                        <option value="ping">🌐 Ping Latency (ms)</option>
                                        <option value="tcp">🔌 TCP Latency (ms)</option>
                                        <option value="service">⚙️ Service Status</option>
                                        <option value="process">📟 Process Monitor</option>
                                    </select>
                                </div>

                                {['cpu', 'memory'].includes(ruleForm.type) && (
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Threshold (Exceeds %)</label>
                                        <input 
                                            type="number" 
                                            style={S.input} 
                                            value={ruleForm.threshold} 
                                            onChange={e => setRuleForm({ ...ruleForm, threshold: parseInt(e.target.value) || 0 })} 
                                        />
                                    </div>
                                )}

                                {ruleForm.type === 'offline' && (
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Offline Buffer Time (Seconds)</label>
                                        <input 
                                            type="number" 
                                            style={S.input} 
                                            value={ruleForm.threshold} 
                                            onChange={e => setRuleForm({ ...ruleForm, threshold: parseInt(e.target.value) || 0 })} 
                                            placeholder="e.g. 300 (5 minutes)"
                                        />
                                    </div>
                                )}

                                {['disk', 'ping', 'tcp', 'service', 'process'].includes(ruleForm.type) && (
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>
                                            Target {ruleForm.type === 'disk' ? 'Mount (e.g. /)' : ruleForm.type === 'tcp' ? 'Host (e.g. 10.0.0.1:80)' : 'Name'}
                                        </label>
                                        <input 
                                            style={S.input} 
                                            value={ruleForm.target} 
                                            onChange={e => setRuleForm({ ...ruleForm, target: e.target.value })} 
                                            placeholder={ruleForm.type === 'disk' ? 'e.g. /' : ruleForm.type === 'tcp' ? 'e.g. localhost:3306' : 'e.g. nginx'}
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Offline Presets */}
                            {ruleForm.type === 'offline' && (
                                <div style={{ padding: 14, background: 'rgba(239, 68, 68, 0.05)', borderRadius: 12, border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Quick Buffer Presets:</span>
                                        <div style={{ display: 'flex', gap: 6 }}>
                                            {[
                                                { label: '3m (180s)', val: 180 },
                                                { label: '5m (300s)', val: 300 },
                                                { label: '10m (600s)', val: 600 },
                                                { label: '15m (900s)', val: 900 }
                                            ].map(preset => (
                                                <button
                                                    key={preset.val}
                                                    type="button"
                                                    onClick={() => setRuleForm({ ...ruleForm, threshold: preset.val })}
                                                    style={S.pillBtn(ruleForm.threshold === preset.val)}
                                                >
                                                    {preset.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                                        💡 Agent will trigger an offline alert only if no heartbeat is received within this buffer time ({ruleForm.threshold}s = {Math.round(ruleForm.threshold / 60)} min).
                                    </div>
                                </div>
                            )}

                            {/* Process Settings */}
                            {ruleForm.type === 'process' && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>CPU Threshold (%) (Optional)</label>
                                        <input 
                                            type="number"
                                            style={S.input} 
                                            value={ruleForm.cpuThreshold} 
                                            onChange={e => setRuleForm({ ...ruleForm, cpuThreshold: e.target.value })} 
                                            placeholder="e.g. 80 (leave blank to skip)"
                                        />
                                    </div>
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Memory Threshold (MB) (Optional)</label>
                                        <input 
                                            type="number"
                                            style={S.input} 
                                            value={ruleForm.memThreshold} 
                                            onChange={e => setRuleForm({ ...ruleForm, memThreshold: e.target.value })} 
                                            placeholder="e.g. 500 (leave blank to skip)"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Disk/Ping/TCP Threshold & Hits */}
                            {['disk', 'ping', 'tcp'].includes(ruleForm.type) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Threshold (Exceeds &gt;)</label>
                                        <input 
                                            type="number" 
                                            style={S.input} 
                                            value={ruleForm.threshold} 
                                            onChange={e => setRuleForm({ ...ruleForm, threshold: parseInt(e.target.value) || 0 })} 
                                        />
                                    </div>
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Alert Hits (Trigger after)</label>
                                        <input 
                                            type="number" 
                                            style={S.input} 
                                            value={ruleForm.alertHits} 
                                            onChange={e => setRuleForm({ ...ruleForm, alertHits: parseInt(e.target.value) || 1 })} 
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Alert Hits for non-disk/ping/tcp */}
                            {!['disk', 'ping', 'tcp'].includes(ruleForm.type) && (
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Alert Hits (Trigger after)</label>
                                    <input 
                                        type="number" 
                                        style={S.input} 
                                        value={ruleForm.alertHits} 
                                        onChange={e => setRuleForm({ ...ruleForm, alertHits: parseInt(e.target.value) || 1 })} 
                                    />
                                </div>
                            )}
                        </>
                    )}

                    {/* ================= TAB 2: EVENT & SYSLOGS ================= */}
                    {modalTab === 'log' && (
                        <>
                            {/* Log Source Selector */}
                            <div style={S.inputGroup}>
                                <label style={S.label}>Log Source System</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                    <button
                                        type="button"
                                        onClick={() => setLogType('winevent')}
                                        style={{
                                            padding: '12px 16px',
                                            borderRadius: 14,
                                            fontSize: 13,
                                            fontWeight: 800,
                                            cursor: 'pointer',
                                            border: logType === 'winevent' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                            background: logType === 'winevent' ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                            color: logType === 'winevent' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: 8,
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        <span>🪟</span> Windows Event Log
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setLogType('syslog')}
                                        style={{
                                            padding: '12px 16px',
                                            borderRadius: 14,
                                            fontSize: 13,
                                            fontWeight: 800,
                                            cursor: 'pointer',
                                            border: logType === 'syslog' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                            background: logType === 'syslog' ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                            color: logType === 'syslog' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: 8,
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        <span>🐧</span> Linux Syslog / Log File
                                    </button>
                                </div>
                            </div>

                            {/* Windows Event Form */}
                            {logType === 'winevent' && (
                                <>
                                    {/* Presets Bar */}
                                    <div style={{ padding: 12, background: 'rgba(59, 130, 246, 0.05)', borderRadius: 12, border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Security & System Presets:</span>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            {[
                                                { name: 'Windows Account Locked Out (4740)', channel: 'Security', eventID: '4740', level: 'Information' },
                                                { name: 'Failed Logon Attempts (4625)', channel: 'Security', eventID: '4625', level: 'Information' },
                                                { name: 'Audit Log Cleared (1102)', channel: 'Security', eventID: '1102', level: 'Information' },
                                                { name: 'Service Stopped or Terminated (7036)', channel: 'System', eventID: '7036', level: 'Information' }
                                            ].map((preset, idx) => (
                                                <button
                                                    key={idx}
                                                    type="button"
                                                    onClick={() => applyWinPreset(preset)}
                                                    style={S.pillBtn(winEventID === preset.eventID && winChannel === preset.channel)}
                                                >
                                                    {preset.eventID ? `[${preset.eventID}] ` : ''}{preset.name.split(' (')[0]}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Channel & Event ID */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Channel / Log Name</label>
                                            <select 
                                                style={S.select} 
                                                value={winChannel} 
                                                onChange={e => setWinChannel(e.target.value)}
                                            >
                                                <option value="Security">Security (安全日誌)</option>
                                                <option value="System">System (系統日誌)</option>
                                                <option value="Application">Application (應用程式)</option>
                                                <option value="Microsoft-Windows-Sysmon/Operational">Sysmon/Operational</option>
                                            </select>
                                        </div>

                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Event ID (e.g. 4740, 4625)</label>
                                            <input 
                                                style={S.input} 
                                                value={winEventID} 
                                                onChange={e => setWinEventID(e.target.value)} 
                                                placeholder="Leave blank for all IDs, or e.g. 4740" 
                                            />
                                        </div>
                                    </div>

                                    {/* Level & Keyword */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Severity Level</label>
                                            <select 
                                                style={S.select} 
                                                value={winLevel} 
                                                onChange={e => setWinLevel(e.target.value)}
                                            >
                                                <option value="All">All Levels</option>
                                                <option value="Critical">Critical (1)</option>
                                                <option value="Error">Error (2)</option>
                                                <option value="Warning">Warning (3)</option>
                                                <option value="Information">Information (4)</option>
                                            </select>
                                        </div>

                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Keyword / Regex (Optional)</label>
                                            <input 
                                                style={S.input} 
                                                value={winKeyword} 
                                                onChange={e => setWinKeyword(e.target.value)} 
                                                placeholder="e.g. locked, admin, failed" 
                                            />
                                        </div>
                                    </div>

                                    {/* Exclude Users */}
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Exclude Users (Optional, Comma separated)</label>
                                        <input 
                                            style={S.input} 
                                            value={winExcludeUsers} 
                                            onChange={e => setWinExcludeUsers(e.target.value)} 
                                            placeholder="e.g. srv.sys-rma, srv.sys-vanguard, SYSTEM" 
                                        />
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            💡 Ignores events triggered by specific service accounts to avoid alert fatigue.
                                        </span>
                                    </div>
                                </>
                            )}

                            {/* Linux Syslog Form */}
                            {logType === 'syslog' && (
                                <>
                                    {/* Presets Bar */}
                                    <div style={{ padding: 12, background: 'rgba(16, 185, 129, 0.05)', borderRadius: 12, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Linux Syslog Presets:</span>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            {[
                                                { name: 'SSH Auth Failed', logPath: '/var/log/secure', severity: 'All', keyword: 'Failed password' },
                                                { name: 'Out of Memory (OOM)', logPath: '/var/log/messages', severity: 'error', keyword: 'Out of memory' },
                                                { name: 'Sudo Command Execution', logPath: '/var/log/secure', severity: 'All', keyword: 'sudo:' },
                                                { name: 'Kernel Panic', logPath: '/var/log/messages', severity: 'critical', keyword: 'Kernel panic' }
                                            ].map((preset, idx) => (
                                                <button
                                                    key={idx}
                                                    type="button"
                                                    onClick={() => applySyslogPreset(preset)}
                                                    style={S.pillBtn(sysLogPath === preset.logPath && sysKeyword === preset.keyword)}
                                                >
                                                    {preset.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Log Path & Severity */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Log Path / Target</label>
                                            <input 
                                                style={S.input} 
                                                value={sysLogPath} 
                                                onChange={e => setSysLogPath(e.target.value)} 
                                                placeholder="e.g. /var/log/secure or /var/log/syslog" 
                                            />
                                        </div>

                                        <div style={S.inputGroup}>
                                            <label style={S.label}>Severity</label>
                                            <select 
                                                style={S.select} 
                                                value={sysSeverity} 
                                                onChange={e => setSysSeverity(e.target.value)}
                                            >
                                                <option value="All">All Severities</option>
                                                <option value="emergency">Emergency</option>
                                                <option value="alert">Alert</option>
                                                <option value="critical">Critical</option>
                                                <option value="error">Error</option>
                                                <option value="warning">Warning</option>
                                                <option value="info">Info</option>
                                            </select>
                                        </div>
                                    </div>

                                    {/* Keyword */}
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Keyword / Regex Pattern (Required / Recommended)</label>
                                        <input 
                                            style={S.input} 
                                            value={sysKeyword} 
                                            onChange={e => setSysKeyword(e.target.value)} 
                                            placeholder="e.g. Failed password, Out of memory, error" 
                                        />
                                    </div>
                                </>
                            )}

                            {/* Trigger Hits for Logs */}
                            <div style={S.inputGroup}>
                                <label style={S.label}>Alert Hits (Trigger after)</label>
                                <input 
                                    type="number" 
                                    style={S.input} 
                                    value={ruleForm.alertHits} 
                                    onChange={e => setRuleForm({ ...ruleForm, alertHits: parseInt(e.target.value) || 1 })} 
                                    placeholder="1"
                                />
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    Default: 1 (Triggers on first matching log event)
                                </span>
                            </div>
                        </>
                    )}

                    {/* Escalation (shared by metric and log rules) */}
                    <div style={{ marginTop: 12 }}>
                        <label style={S.label}>Escalate if unresolved for N minutes (blank = never)</label>
                        <input type="number" min="1" max="10080" style={S.input} placeholder="e.g. 30"
                            value={ruleForm.escalateAfterMin}
                            onChange={e => setRuleForm({ ...ruleForm, escalateAfterMin: e.target.value })} />
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Escalation destinations are configured in Alerts &amp; Rules → ⚙️ Alert Settings.</div>
                    </div>

                    {/* Common Section: Notification Channels (Multi-select) */}
                    <hr style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px', background: 'rgba(15,23,42,0.35)', borderRadius: 16, border: '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <label style={{ ...S.label, margin: 0, color: 'var(--text-primary)', fontSize: 12, fontWeight: 800 }}>
                                🔔 Notification Channels (告警通知管道 - 可複選)
                            </label>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                支援多管道同步派送
                            </span>
                        </div>

                        {/* 3 Channels Checkbox Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                            {/* Email Card */}
                            <div 
                                onClick={() => setNotifyMail(!notifyMail)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    padding: '10px 14px',
                                    borderRadius: 12,
                                    cursor: 'pointer',
                                    border: notifyMail ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                    background: notifyMail ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                    color: notifyMail ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                    fontWeight: 700,
                                    fontSize: 12,
                                    userSelect: 'none',
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <input 
                                    type="checkbox" 
                                    checked={notifyMail} 
                                    onChange={() => {}} 
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)' }} 
                                />
                                <span>📧 Email</span>
                            </div>

                            {/* Telegram Card */}
                            <div 
                                onClick={() => setNotifyTg(!notifyTg)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    padding: '10px 14px',
                                    borderRadius: 12,
                                    cursor: 'pointer',
                                    border: notifyTg ? '1px solid #38bdf8' : '1px solid var(--border-color)',
                                    background: notifyTg ? 'rgba(56, 189, 248, 0.15)' : 'var(--bg-primary)',
                                    color: notifyTg ? '#38bdf8' : 'var(--text-secondary)',
                                    fontWeight: 700,
                                    fontSize: 12,
                                    userSelect: 'none',
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <input 
                                    type="checkbox" 
                                    checked={notifyTg} 
                                    onChange={() => {}} 
                                    style={{ cursor: 'pointer', accentColor: '#38bdf8' }} 
                                />
                                <span>✈️ Telegram</span>
                            </div>

                            {/* Webhook Card */}
                            <div 
                                onClick={() => setNotifyWebhook(!notifyWebhook)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    padding: '10px 14px',
                                    borderRadius: 12,
                                    cursor: 'pointer',
                                    border: notifyWebhook ? '1px solid #c084fc' : '1px solid var(--border-color)',
                                    background: notifyWebhook ? 'rgba(168, 85, 247, 0.15)' : 'var(--bg-primary)',
                                    color: notifyWebhook ? '#c084fc' : 'var(--text-secondary)',
                                    fontWeight: 700,
                                    fontSize: 12,
                                    userSelect: 'none',
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <input 
                                    type="checkbox" 
                                    checked={notifyWebhook} 
                                    onChange={() => {}} 
                                    style={{ cursor: 'pointer', accentColor: '#c084fc' }} 
                                />
                                <span>🔗 Webhook</span>
                            </div>
                        </div>

                        {/* Email Details Input */}
                        {notifyMail && (
                            <div style={S.inputGroup}>
                                <label style={{ ...S.label, fontSize: 10 }}>Email Recipients (逗號分隔收件人，留空則發送至系統預設)</label>
                                <input 
                                    style={S.input} 
                                    value={ruleForm.emails} 
                                    onChange={e => setRuleForm({ ...ruleForm, emails: e.target.value })} 
                                    placeholder="e.g. admin@corp.com, noc@corp.com" 
                                />
                            </div>
                        )}

                        {/* Telegram Info Note */}
                        {notifyTg && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#38bdf8', padding: '6px 10px', background: 'rgba(56, 189, 248, 0.08)', borderRadius: 8 }}>
                                <span>ℹ️</span> 觸發告警時將即時推播至系統設定之 Telegram 機器人群組 (ScoutMonitor 頻道)。
                            </div>
                        )}

                        {/* Webhook Selector */}
                        {notifyWebhook && (
                            <div style={S.inputGroup}>
                                <label style={{ ...S.label, fontSize: 10 }}>Target Webhook (選擇發送目標 Webhook)</label>
                                <select 
                                    style={S.select}
                                    value={selectedWebhookId}
                                    onChange={e => setSelectedWebhookId(e.target.value)}
                                >
                                    <option value="all">🌐 All Enabled Webhooks (所有已啟用的 Webhook)</option>
                                    {availableWebhooks.map(w => (
                                        <option key={w.id} value={w.id}>
                                            {w.name} ({w.method || 'POST'} - {w.url}) {!w.enabled ? '[Disabled]' : ''}
                                        </option>
                                    ))}
                                </select>
                                {availableWebhooks.length === 0 && (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        尚未建立 Webhook 目標，可在 Integration Hub / Webhook Hub 進行設定。
                                    </span>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Common Section: Self-Healing / Edge Remediation */}
                    <hr style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
                    <div 
                        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                        onClick={() => setShowRemediation(!showRemediation)}
                    >
                        <h3 style={{ margin: 0, fontSize: '13px', color: 'var(--text-primary)', flex: 1, fontWeight: 800 }}>Self-Healing / Edge Remediation (Optional)</h3>
                        <span style={{ color: 'var(--text-muted)', transform: showRemediation ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', fontSize: 10 }}>▼</span>
                    </div>

                    {showRemediation && (
                        <div style={{ padding: '20px', backgroundColor: 'var(--bg-secondary)', borderRadius: '16px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 16, opacity: canManageSelfHealing ? 1 : 0.6 }}>
                            {!canManageSelfHealing && (
                                <div style={{ padding: 12, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', borderRadius: 8, color: '#ef4444', fontSize: 12, fontWeight: 700 }}>
                                    ⚠ You do not have permission to manage Self-Healing scripts.
                                </div>
                            )}
                            <div style={S.inputGroup}>
                                <label style={S.label}>Remediation Script (PowerShell / Bash)</label>
                                <textarea 
                                    disabled={!canManageSelfHealing}
                                    style={{ ...S.input, height: '80px', resize: 'vertical', fontFamily: 'monospace', padding: '12px 16px' }} 
                                    value={ruleForm.remediationScript} 
                                    onChange={e => setRuleForm({ ...ruleForm, remediationScript: e.target.value })} 
                                    placeholder={modalTab === 'log' ? 'e.g. Unlock-ADAccount -Identity $User, or Restart-Service' : 'e.g. Restart-Service w3svc -Force'} 
                                />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Cooldown (seconds)</label>
                                    <input 
                                        disabled={!canManageSelfHealing}
                                        type="number" 
                                        style={S.input} 
                                        value={ruleForm.remediationCooldown} 
                                        onChange={e => setRuleForm({ ...ruleForm, remediationCooldown: parseInt(e.target.value) || 0 })} 
                                    />
                                </div>
                                <div style={S.inputGroup}>
                                    <label style={S.label}>Max Retries</label>
                                    <input 
                                        disabled={!canManageSelfHealing}
                                        type="number" 
                                        style={S.input} 
                                        value={ruleForm.remediationMaxRetries} 
                                        onChange={e => setRuleForm({ ...ruleForm, remediationMaxRetries: parseInt(e.target.value) || 0 })} 
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div style={S.modalFoot}>
                    <button style={S.btnS} onClick={onClose}>Cancel</button>
                    <button style={S.btnP} onClick={handleSave}>Save Rule</button>
                </div>
            </div>
        </div>
    );
}
