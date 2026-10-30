import { softwareNames } from './masterListUtils';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import EnvironmentsSettings from './EnvironmentsSettings';
import FileServicesSettings from './FileServicesSettings';
import { FILE_SERVICES_CATEGORY, resolveCategoryLink } from './fileServicesUtils';
import {
    BUILTIN_NOTE, LOCKED_FEATURE_TOOLTIP, isBuiltinMapping, getEditorCategories, isFeatureLocked,
    normalizeEditorFeatures, toggleCategory, listMappings, listAssignableMappings, mappingActions,
    buildSaveFeaturesPayload, validateNewMappingName
} from './rbacBuiltinUtils';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    layoutRow: { display: 'flex', gap: 32 },
    sidebar: { width: 280, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 },
    sidebarItem: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 12, cursor: 'pointer', transition: 'all 0.2s', border: '1px solid transparent', background: 'transparent' },
    sidebarItemActive: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' },
    iconBox: { width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, transition: 'all 0.2s' },
    iconBoxActive: { background: 'var(--accent-primary)', color: '#fff' },
    contentArea: { flex: 1, display: 'flex', flexDirection: 'column', gap: 20 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden', marginBottom: 16 },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    textarea: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace' },
    select: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box', cursor: 'pointer' },
    btnP: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'transform 0.1s' },
    btnO: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 450, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)', padding: 28, textAlign: 'center' },
    hint: { marginTop: 12, padding: 14, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, lineHeight: 1.6, border: '1px solid var(--border-color)' },
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 },
    fieldBlock: { marginBottom: 16 }
};

const LOG_TYPE_DEFINITIONS = [
    { id: 'AuditLogs', label: '系統操作稽核 (Audit Logs)', desc: '管理者操作、設定變更、服務部屬、RBAC 權限調整' },
    { id: 'AuthSecurity', label: '身分驗證與安全防護 (Auth & Security)', desc: '使用者登入成功、帳號密碼多次錯誤被鎖定' },
    { id: 'ScoutMonitor', label: '主機效能與上下線告警 (Scout Telemetry)', desc: 'CPU / 記憶體 / 磁碟滿載告警、主機上線與下線通知' },
    { id: 'SSLMonitor', label: 'SSL 憑證監控告警 (SSL Certificate)', desc: '憑證即將到期、SSL/TLS 檢查異常' },
    { id: 'Inventory', label: '資產盤點與掃描告警 (Server Inventory)', desc: '主機離線斷線告警、定期資產盤點報告' },
    { id: 'Prometheus', label: 'Prometheus 目標狀態告警 (Target Exporter)', desc: 'Node Exporter 或指標收集端異常斷線' },
    { id: 'Workflow', label: '自動化流程通知 (Workflow & Runbook)', desc: '自動化運維腳本執行完畢與結果通報' },
    { id: 'GeneralLogs', label: '日常一般系統事件 (General System Events)', desc: '系統備份完成、Telegram 機器人指令互動' },
    { id: 'AIAgent', label: '🤖 AI Agent 提問紀錄 (AI Ops Agent)', desc: '使用者向 AI Agent 提出的問題（已遮蔽機密）。預設不推播，需勾選才會送出', optIn: true }
];
const ALL_LOG_TYPE_KEYS = LOG_TYPE_DEFINITIONS.map(d => d.id);
// Used when no list has been saved yet; opt-in types (AIAgent) must be selected explicitly, matching the backend
const DEFAULT_LOG_TYPE_KEYS = LOG_TYPE_DEFINITIONS.filter(d => !d.optIn).map(d => d.id);

const Settings = ({ mode = 'system' }) => {
    const { showConfirm } = useConfirm();
    const [rbacData, setRbacData] = useState({ roles: [], users: {}, defaultRole: 'Viewer' });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [backupStatus, setBackupStatus] = useState(null);
    const [backupRunning, setBackupRunning] = useState(false);
    const backupPollRef = useRef(null);
    const [newUser,setNewUser] = useState({ username: '', role: 'Operator' });
    const [adUsers, setAdUsers] = useState([]);
    const [groups, setGroups] = useState({});
    const [newGroup, setNewGroup] = useState({ name: '', type: 'ou', target: '' });
    const [selectedGroup, setSelectedGroup] = useState('');
    const [loadingAdUsers, setLoadingAdUsers] = useState(false);
    const [editingGroup, setEditingGroup] = useState(null);
    const [devicesText, setDevicesText] = useState('');
    const [webhooks, setWebhooks] = useState([]);
    const [isEditingWebhook, setIsEditingWebhook] = useState(false);
    const [webhookForm, setWebhookForm] = useState({ id: '', name: '', url: '', method: 'POST', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '{\n  "text": "{{message}}"\n}', enabled: true, enabledLogs: DEFAULT_LOG_TYPE_KEYS });
    const [testingWebhookId, setTestingWebhookId] = useState(null);
    const [deletingWebhook, setDeletingWebhook] = useState(null);
    const [webhookDebug, setWebhookDebug] = useState(null);

    // Scout Open API Documentation modal state
    const [showDocModal, setShowDocModal] = useState(false);

    // Legacy Settings configuration state
    const [sysConfig, setSysConfig] = useState({});
    const [savingSettings, setSavingSettings] = useState(false);
    const deepLinkRef = useRef(undefined);
    const [activeCategory, setActiveCategory] = useState(mode === 'rbac' ? 'rbac' : 'core');
    const [fileServicesTab, setFileServicesTab] = useState('sftp');
    const [isProxyExpanded, setIsProxyExpanded] = useState(false);
    const [isTelegramLogsExpanded, setIsTelegramLogsExpanded] = useState(false);
    const [isWebhookLogsExpanded, setIsWebhookLogsExpanded] = useState(false);

    // Custom confirm dialog states
    const [deleteConfirmGroup, setDeleteConfirmGroup] = useState(null);
    const [deleteConfirmUser, setDeleteConfirmUser] = useState(null);

    // Universal AI Service State
    const [aiConfig, setAiConfig] = useState({
        enabled: false,
        provider: 'opencode',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey: '',
        model: 'claude-3-7-sonnet',
        temperature: 0.3,
        timeout: 120000,
        maxTokens: 2048,
        enableThinking: false,
        reasoningEffort: 'medium',
        systemPrompt: '',
        hasApiKey: false,
        agentEnabled: false,
        agentModel: '',
        agentRateLimitPerHour: 30
    });
    const [agentTesting, setAgentTesting] = useState(false);
    const [agentTestResult, setAgentTestResult] = useState(null);
    const [aiTesting, setAiTesting] = useState(false);
    const [aiTestResult, setAiTestResult] = useState(null);
    const [aiSaving, setAiSaving] = useState(false);
    const [availableModels, setAvailableModels] = useState([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelsFetchError, setModelsFetchError] = useState(null);

    // SFTP Multi-Server Management State
    const [sftpServers, setSftpServers] = useState([]);
    const [showSftpServerModal, setShowSftpServerModal] = useState(false);
    const [isEditingSftpServer, setIsEditingSftpServer] = useState(false);
    const [sftpServerForm, setSftpServerForm] = useState({
        id: '',
        name: '',
        host: '127.0.0.1',
        apiPort: 8443,
        sftpPort: 2222,
        apiKey: '',
        protocol: 'http',
        enabled: true
    });
    const [sftpServerTesting, setSftpServerTesting] = useState(false);
    const [sftpServerTestResult, setSftpServerTestResult] = useState(null);
    const [showModalSftpKey, setShowModalSftpKey] = useState(false);

    const allCategories = [
        { id: 'core', label: 'Core System', desc: 'Core system variables', icon: '⚙️', title: 'Core System Settings', subtitle: 'Manage core system parameters, ports, timezones, and administrator credentials' },
        { id: 'ai', label: 'AI Service', desc: 'Centralized AI & LLM integration', icon: '🤖', title: 'Universal AI Service Center', subtitle: 'Configure centralized AI / LLM providers (Ollama, OpenAI, Gemini, Custom API) for system-wide intelligence' },
        { id: 'openapi', label: 'Scout Open API', desc: 'External REST API & Access Logs', icon: '🌐', title: 'Scout Open API Gateway Settings', subtitle: 'Configure external Open API endpoint accessibility, access audit logging, rate limiting, and security rules' },
        { id: FILE_SERVICES_CATEGORY, label: 'File Services', desc: 'SFTP servers & NAS devices', icon: '📁', title: 'File Services', subtitle: 'Manage SFTP servers (Web API, keys, remote service control) and NAS storage devices' },
        { id: 'rbac', label: 'RBAC & Groups', desc: 'Role and group management', icon: '👥', title: 'RBAC & Group Mappings', subtitle: 'Manage custom user roles and AD group OU configurations for feature access' },
        { id: 'integration', label: 'Integration Hub', desc: 'Webhook & Telegram settings', icon: '🔌', title: 'Webhook & API Integration Hub', subtitle: 'Configure webhooks, Telegram bot alerts, and API settings' },
        { id: 'ad', label: 'AD Hierarchy', desc: 'Active Directory mapping', icon: '👤', title: 'AD Hierarchy & SearchBase', subtitle: 'Configure Active Directory search base, business units, and organizational unit mapping' },
        { id: 'forti', label: 'FortiProxy', desc: 'Firewall configurations', icon: '🛡️', title: 'FortiProxy Integration', subtitle: 'Manage FortiProxy host connection parameters and security tokens by environment' },
        { id: 'squid', label: 'Squid Proxy', desc: 'Squid proxy server list', icon: '🦑', title: 'Squid Proxy Servers', subtitle: 'Configure Squid proxy server IP targets across environments' },
        { id: 'netsearch', label: 'NetSearch', desc: 'Backup directories & devices', icon: '🔍', title: 'NetSearch Configuration', subtitle: 'Configure backup root folder, FQDN lookup path, cron schedule, and target device list' },
        { id: 'mail', label: 'Mail Relay', desc: 'Email alerts configuration', icon: '📧', title: 'Mail Relay & Alerting', subtitle: 'Set up SMTP mail relay servers, sender credentials, and recipient alert routing' },
        { id: 'elk', label: 'ELK Manager', desc: 'Log analytics engine', icon: '📊', title: 'ELK Manager Integration', subtitle: 'Manage Elasticsearch and Logstash cluster connection endpoints by environment' },
        { id: 'nutanix', label: 'Nutanix', desc: 'Virtualization parameters', icon: '🏢', title: 'Nutanix Configurator', subtitle: 'Configure Prism Central/Element modes, VM credentials, and remote console paths' },
        { id: 'provision', label: 'Server Provision', desc: 'Server deployment scripts', icon: '🚀', title: 'Server Provisioning', subtitle: 'Manage software deployment repositories, execution commands, and path settings' },
        { id: 'environments', label: 'Environments', desc: 'Global environment list', icon: '🌍', title: 'Global Environments', subtitle: 'Manage the environment list shared by IPAM, SSL, Database, Kubernetes, Scout, CMDB and other screens' },
        { id: 'others', label: 'Others Service', desc: 'Background jobs & misc', icon: '⏱️', title: 'Others Service Configuration', subtitle: 'Manage background jobs, SSL monitoring, and Prometheus targets' }
    ];

    const CATEGORIES = allCategories.filter(c => {
        if (mode === 'rbac') return c.id === 'rbac';
        return c.id !== 'rbac';
    });

    useEffect(() => {
        fetchData();
    }, []);

    useEffect(() => {
        if (mode === 'rbac') return undefined;
        api.get('/settings/backup-status')
            .then(res => {
                const st = res.data || {};
                if (st.finishedAt) {
                    setBackupStatus(st);
                } else if (st.startedAt && st.requestId && Date.now() - new Date(st.startedAt).getTime() < 30 * 60 * 1000) {
                    // A backup is still running (started before this page was opened): resume watching it
                    setBackupRunning(true);
                    startBackupPolling(st.requestId);
                }
            })
            .catch(() => {});
        return () => stopBackupPolling();
    }, []);

    useEffect(() => {
        // Other screens can deep-link to a category (e.g. IPAM -> Environments) through sessionStorage
        // Read once and keep it in a ref so React StrictMode's second effect run still sees it
        if (deepLinkRef.current === undefined) {
            let pending = null;
            try {
                const cat = sessionStorage.getItem('somp.settings.category');
                const tab = sessionStorage.getItem('somp.settings.tab');
                if (cat) sessionStorage.removeItem('somp.settings.category');
                if (tab) sessionStorage.removeItem('somp.settings.tab');
                // the retired 'sftp' category maps to File Services -> SFTP Servers
                pending = resolveCategoryLink(cat, tab);
            } catch { /* storage unavailable */ }
            deepLinkRef.current = pending;
            setTimeout(() => { deepLinkRef.current = null; }, 0);
        }
        const pending = deepLinkRef.current;
        const valid = pending && mode !== 'rbac' && allCategories.some(c => c.id === pending.category);
        setActiveCategory(mode === 'rbac' ? 'rbac' : (valid ? pending.category : 'core'));
        if (valid && pending.tab) setFileServicesTab(pending.tab);
        setError(null);
        setSuccess(null);
    }, [mode]);

    const fetchData = async () => {
        try {
            setLoading(true);
            const [rbacRes, groupsRes, settingsRes, webhooksRes, aiRes] = await Promise.all([
                api.get('/rbac'),
                api.get('/rbac/groups').catch(() => ({ data: {} })),
                api.get('/settings').catch(() => ({ data: {} })),
                api.get('/webhooks').catch(() => ({ data: [] })),
                api.get('/ai/config').catch(() => ({ data: {} }))
            ]);
            setRbacData(rbacRes.data);
            setGroups(groupsRes.data);
            setWebhooks(webhooksRes.data || []);
            if (aiRes.data) {
                setAiConfig(prev => ({ ...prev, ...aiRes.data, apiKey: '' }));
            }
            const cfg = settingsRes.data || {};
            setSysConfig(cfg);
            if (cfg.NETSEARCH_DEVICES) {
                try {
                    const parsed = JSON.parse(cfg.NETSEARCH_DEVICES);
                    if (Array.isArray(parsed)) {
                        setDevicesText(parsed.map(d => `${d.name}|${d.type}`).join('\n'));
                    } else {
                        setDevicesText('');
                    }
                } catch(e) {
                    setDevicesText(cfg.NETSEARCH_DEVICES);
                }
            } else {
                setDevicesText('');
            }

            if (cfg.SFTP_SERVERS) {
                try {
                    const parsed = JSON.parse(cfg.SFTP_SERVERS);
                    setSftpServers(Array.isArray(parsed) ? parsed : []);
                } catch(e) {
                    setSftpServers([]);
                }
            } else if (cfg.SFTP_HOST) {
                setSftpServers([{
                    id: 'sftp-1',
                    name: 'Local SFTP Server',
                    host: cfg.SFTP_HOST || '127.0.0.1',
                    apiPort: parseInt(cfg.SFTP_API_PORT || '8443', 10),
                    sftpPort: parseInt(cfg.SFTP_PORT || '2222', 10),
                    apiKey: cfg.SFTP_API_KEY || '',
                    protocol: cfg.SFTP_USE_HTTPS === 'true' ? 'https' : 'http',
                    enabled: cfg.SFTP_ENABLED !== 'false'
                }]);
            } else {
                setSftpServers([]);
            }

            setError(null);
        } catch (err) {
            console.error('Failed to fetch system config, Webhooks & RBAC:', err);
            setError('Failed to load configuration. Ensure you are logged in as SuperAdmin.');
        } finally {
            setLoading(false);
        }
    };

    const handleConfigChange = (key, val) => {
        setSysConfig(prev => ({ ...prev, [key]: val }));
    };

    const handleDevicesTextChange = (text) => {
        setDevicesText(text);
        const list = text.split('\n')
            .map(line => line.trim())
            .filter(line => line.includes('|'))
            .map(line => {
                const [name, type] = line.split('|');
                return { name: name.trim(), type: type.trim().toLowerCase() };
            });
        handleConfigChange('NETSEARCH_DEVICES', JSON.stringify(list));
    };

    const handleSaveAiConfig = async () => {
        setAiSaving(true);
        setError(null);
        setSuccess(null);
        try {
            await api.post('/ai/config', aiConfig);
            setSuccess('AI Service Center configuration saved successfully.');
            const res = await api.get('/ai/config');
            if (res.data) {
                setAiConfig(prev => ({ ...prev, ...res.data, apiKey: '' }));
            }
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save AI configuration');
        } finally {
            setAiSaving(false);
        }
    };

    const handleTestAi = async () => {
        setAiTesting(true);
        setAiTestResult(null);
        try {
            const res = await api.post('/ai/test', aiConfig);
            setAiTestResult({ success: true, latencyMs: res.data.latencyMs, model: res.data.model, provider: res.data.provider, reply: res.data.reply });
        } catch (err) {
            setAiTestResult({ success: false, error: err.response?.data?.error || err.message });
        } finally {
            setAiTesting(false);
        }
    };

    const handleTestAgent = async () => {
        setAgentTesting(true);
        setAgentTestResult(null);
        try {
            const res = await api.post('/agent/test');
            setAgentTestResult(res.data);
        } catch (err) {
            setAgentTestResult({ ok: false, error: err.response?.data?.error || err.message });
        } finally {
            setAgentTesting(false);
        }
    };

    const handleFetchModels = async () => {
        setLoadingModels(true);
        setModelsFetchError(null);
        try {
            const res = await api.post('/ai/fetch-models', {
                provider: aiConfig.provider,
                baseUrl: aiConfig.baseUrl,
                apiKey: aiConfig.apiKey
            });
            if (res.data?.models && res.data.models.length > 0) {
                setAvailableModels(res.data.models);
            } else {
                setModelsFetchError('No models returned from provider');
            }
        } catch (err) {
            setModelsFetchError(err.response?.data?.error || err.message);
        } finally {
            setLoadingModels(false);
        }
    };

    const handleOpenAddSftpServer = () => {
        setIsEditingSftpServer(false);
        setSftpServerTestResult(null);
        setShowModalSftpKey(false);
        setSftpServerForm({
            id: `sftp-${Date.now().toString(36)}`,
            name: '',
            host: '127.0.0.1',
            apiPort: 8443,
            sftpPort: '',
            apiKey: '',
            protocol: 'http',
            enabled: true
        });
        setShowSftpServerModal(true);
    };

    const handleOpenEditSftpServer = (srv) => {
        setIsEditingSftpServer(true);
        setSftpServerTestResult(null);
        setShowModalSftpKey(false);
        setSftpServerForm({ ...srv });
        setShowSftpServerModal(true);
    };

    const handleSaveSftpServerFromModal = (e) => {
        e.preventDefault();
        if (!sftpServerForm.name.trim()) return;
        if (!sftpServerForm.host.trim()) return;

        let updatedList = [];
        if (isEditingSftpServer) {
            updatedList = sftpServers.map(s => s.id === sftpServerForm.id ? { ...sftpServerForm } : s);
        } else {
            updatedList = [...sftpServers, { ...sftpServerForm }];
        }
        setSftpServers(updatedList);
        handleConfigChange('SFTP_SERVERS', JSON.stringify(updatedList));

        // Sync first server to legacy keys for single-server compatibility
        if (updatedList.length > 0) {
            handleConfigChange('SFTP_HOST', updatedList[0].host);
            handleConfigChange('SFTP_API_PORT', String(updatedList[0].apiPort));
            handleConfigChange('SFTP_PORT', String(updatedList[0].sftpPort));
            handleConfigChange('SFTP_API_KEY', updatedList[0].apiKey);
            handleConfigChange('SFTP_ENABLED', updatedList.some(s => s.enabled) ? 'true' : 'false');
        } else {
            handleConfigChange('SFTP_ENABLED', 'false');
        }

        setShowSftpServerModal(false);
    };

    const handleDeleteSftpServer = (id) => {
        const updatedList = sftpServers.filter(s => s.id !== id);
        setSftpServers(updatedList);
        handleConfigChange('SFTP_SERVERS', JSON.stringify(updatedList));
        if (updatedList.length > 0) {
            handleConfigChange('SFTP_HOST', updatedList[0].host);
            handleConfigChange('SFTP_API_PORT', String(updatedList[0].apiPort));
            handleConfigChange('SFTP_PORT', String(updatedList[0].sftpPort));
            handleConfigChange('SFTP_API_KEY', updatedList[0].apiKey);
            handleConfigChange('SFTP_ENABLED', updatedList.some(s => s.enabled) ? 'true' : 'false');
        } else {
            handleConfigChange('SFTP_ENABLED', 'false');
        }
    };

    const handleToggleSftpServerEnabled = (id) => {
        const updatedList = sftpServers.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
        setSftpServers(updatedList);
        handleConfigChange('SFTP_SERVERS', JSON.stringify(updatedList));
        handleConfigChange('SFTP_ENABLED', updatedList.some(s => s.enabled) ? 'true' : 'false');
    };

    const handleTestSingleSftpServer = async (srv) => {
        setSftpServerTesting(true);
        setSftpServerTestResult(null);
        try {
            const res = await api.post('/sftp/test-connection', {
                host: srv.host || '127.0.0.1',
                apiPort: srv.apiPort || 8443,
                apiKey: srv.apiKey || '',
                protocol: srv.protocol || 'http'
            });
            setSftpServerTestResult({
                serverId: srv.id,
                success: true,
                message: res.data.message || 'Connected successfully!',
                serverInfo: res.data.serverInfo
            });
        } catch (err) {
            setSftpServerTestResult({
                serverId: srv.id,
                success: false,
                error: err.response?.data?.message || err.response?.data?.error || err.message || 'Connection failed'
            });
        } finally {
            setSftpServerTesting(false);
        }
    };

    const handleSaveSettings = async () => {
        setSavingSettings(true);
        setError(null);
        setSuccess(null);
        try {
            await api.post('/settings/save', sysConfig);
            setSuccess('System configurations updated successfully.');
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSavingSettings(false);
        }
    };

    const stopBackupPolling = () => {
        if (backupPollRef.current) {
            clearInterval(backupPollRef.current);
            backupPollRef.current = null;
        }
    };

    const handleBackupNow = async () => {
        setError(null);
        setSuccess(null);
        setBackupStatus(null);
        setBackupRunning(true);
        let requestId;
        try {
            const res = await api.post('/settings/backup-now');
            requestId = res.data?.requestId;
        } catch (err) {
            setBackupRunning(false);
            setError(err.response?.data?.error || err.message);
            return;
        }

        startBackupPolling(requestId);
    };

    const startBackupPolling = (requestId) => {
        const pollStartedAt = Date.now();
        stopBackupPolling();
        backupPollRef.current = setInterval(async () => {
            if (Date.now() - pollStartedAt > 10 * 60 * 1000) {
                stopBackupPolling();
                setBackupRunning(false);
                setError('Backup is taking longer than 10 minutes. Check the backup status again later.');
                return;
            }
            try {
                const res = await api.get('/settings/backup-status');
                const st = res.data || {};
                if (st.requestId === requestId && st.finishedAt) {
                    stopBackupPolling();
                    setBackupRunning(false);
                    setBackupStatus(st);
                }
            } catch (e) {
                // transient network error: keep polling until the timeout
            }
        }, 3000);
    };

    const handleRunNow = async (moduleName) => {
        try {
            setError(null);
            setSuccess(null);
            const res = await api.post(`/scheduler/run-now/${moduleName}`);
            setSuccess(res.data?.message || 'Task triggered successfully.');
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    const handleGroupChange = async (groupName) => {
        setSelectedGroup(groupName);
        setAdUsers([]);
        if (!groupName || !groups[groupName]) return;

        setLoadingAdUsers(true);
        try {
            const grp = groups[groupName];
            const gType = grp.type || (grp.adOu ? 'ou' : 'group');
            const gTarget = grp.target || grp.adOu || '';
            const res = await api.get(`/rbac/ad-users?target=${encodeURIComponent(gTarget)}&type=${encodeURIComponent(gType)}`);
            setAdUsers(res.data || []);
        } catch (err) {
            console.error('Failed to fetch AD users for mapping:', err);
            setError('Failed to load users from AD for the selected mapping.');
        } finally {
            setLoadingAdUsers(false);
        }
    };

    const handleToggleGroupEnabled = async (name, currentVal) => {
        const group = groups[name];
        if (!group || !mappingActions(name, group).canToggle) return;
        try {
            setError(null);
            setSuccess(null);
            const res = await api.post('/rbac/groups', {
                name,
                type: group.type || 'ou',
                target: group.target || group.adOu,
                adOu: group.target || group.adOu,
                enabled: !currentVal,
                features: group.features || {},
                auditLogs: group.auditLogs || {}
            });
            setGroups(res.data.groups);
            setSuccess(`AD Mapping "${name}" ${!currentVal ? 'enabled' : 'disabled'} successfully.`);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    const handleSaveGroupFeatures = async (name, features, auditLogs) => {
        const group = groups[name];
        if (!group) return;
        try {
            setError(null);
            setSuccess(null);
            // The built-in SuperAdmin mapping only sends its feature switches
            const res = await api.post('/rbac/groups', buildSaveFeaturesPayload(name, group, features, auditLogs));
            setGroups(res.data.groups);
            setSuccess(`Saved feature configurations for AD mapping "${name}".`);
            setEditingGroup(null);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    const handleAddGroup = async (e) => {
        e.preventDefault();
        const targetVal = (newGroup.target || '').trim();
        const nameVal = (newGroup.name || '').trim();

        if (!targetVal) return;
        if (newGroup.type !== 'account' && !nameVal) return;
        const reservedError = validateNewMappingName(nameVal, newGroup.type, targetVal);
        if (reservedError) {
            setSuccess(null);
            setError(reservedError);
            return;
        }

        try {
            setSuccess(null);
            setError(null);
            const res = await api.post('/rbac/groups', {
                name: nameVal || targetVal,
                type: newGroup.type,
                target: targetVal,
                adOu: targetVal,
                enabled: true,
                role: 'None',
                features: {},
                auditLogs: {}
            });

            if (res.data.isAccount) {
                fetchData();
                setSuccess(`AD Account "${targetVal}" added directly to Role Assignments with default role "None".`);
                setNewGroup({ name: '', type: 'account', target: '' });
            } else {
                setGroups(res.data.groups);
                setSuccess(`AD Mapping "${nameVal}" created successfully.`);
                setNewGroup({ name: '', type: newGroup.type, target: '' });
            }
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    const handleConfirmDeleteGroup = async () => {
        if (!deleteConfirmGroup) return;
        if (!mappingActions(deleteConfirmGroup, groups[deleteConfirmGroup]).canDelete) {
            setDeleteConfirmGroup(null);
            return;
        }
        try {
            setSuccess(null);
            setError(null);
            const res = await api.delete(`/rbac/groups/${encodeURIComponent(deleteConfirmGroup)}`);
            setGroups(res.data.groups || {});
            if (selectedGroup === deleteConfirmGroup) {
                setSelectedGroup('');
                setAdUsers([]);
            }
            setSuccess(`Group "${deleteConfirmGroup}" deleted.`);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setDeleteConfirmGroup(null);
        }
    };

    const [selectedAccounts, setSelectedAccounts] = useState([]);
    const handleUpdateRole = async (username, domain, role, groupName, refresh = true) => {
        try {
            if (refresh) setSuccess(null);
            setError(null);
            await api.post('/rbac', { username, domain, role, groupName });
            if (refresh) {
                setSuccess(`Role updated successfully for ${username}@${domain}`);
                fetchData();
            }
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    const handleConfirmRemoveRole = async () => {
        if (!deleteConfirmUser) return;
        const { username, domain } = deleteConfirmUser;
        try {
            setSuccess(null);
            setError(null);
            await api.delete('/rbac', { data: { username, domain } });
            setSuccess(`Custom role removed for ${username}@${domain}`);
            setSelectedAccounts(prev => prev.filter(acc => acc !== `${username}@${domain}`));
            fetchData();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setDeleteConfirmUser(null);
        }
    };

    const handleBulkDeleteAccounts = async () => {
        if (selectedAccounts.length === 0) return;
        if (!await showConfirm(`Are you sure you want to delete ${selectedAccounts.length} selected accounts?`)) return;
        
        try {
            setSuccess(null);
            setError(null);
            await Promise.all(selectedAccounts.map(account => {
                const [username, domain] = account.split('@');
                return api.delete('/rbac', { data: { username, domain: domain || '' } });
            }));
            setSuccess(`Successfully removed ${selectedAccounts.length} selected accounts.`);
            setSelectedAccounts([]);
            fetchData();
        } catch (err) {
            setError('Error during bulk deletion: ' + err.message);
        }
    };

    const handleAddUser = async (e) => {
        e.preventDefault();
        
        if (!newUser.username) {
            if (!selectedGroup) {
                setError('Please select a group.');
                return;
            }
            const fakeUsername = `[Group] ${selectedGroup}`;
            await handleUpdateRole(fakeUsername, 'local', newUser.role, selectedGroup, true);
            setNewUser({ username: '', role: 'Operator' });
            return;
        }

        await handleUpdateRole(newUser.username, '', newUser.role, selectedGroup, true);
        setNewUser({ username: '', role: 'Operator' });
    };

    const handleSaveWebhook = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        try {
            let parsedHeaders = {};
            if (webhookForm.headers.trim()) {
                parsedHeaders = JSON.parse(webhookForm.headers);
            }
            
            const payload = {
                name: webhookForm.name,
                url: webhookForm.url,
                method: webhookForm.method,
                headers: parsedHeaders,
                bodyTemplate: webhookForm.bodyTemplate,
                enabled: webhookForm.enabled,
                enabledLogs: Array.isArray(webhookForm.enabledLogs) ? webhookForm.enabledLogs : DEFAULT_LOG_TYPE_KEYS
            };

            let res;
            if (webhookForm.id) {
                res = await api.put(`/webhooks/${webhookForm.id}`, payload);
                setSuccess(`Webhook "${webhookForm.name}" updated successfully.`);
            } else {
                res = await api.post('/webhooks', payload);
                setSuccess(`Webhook "${webhookForm.name}" created successfully.`);
            }

            setWebhooks(res.data.webhooks || []);
            setIsEditingWebhook(false);
            setWebhookForm({ id: '', name: '', url: '', method: 'POST', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '{\n  "text": "{{message}}"\n}', enabled: true, enabledLogs: DEFAULT_LOG_TYPE_KEYS });
        } catch (err) {
            console.error('Failed to save webhook:', err);
            setError(err.response?.data?.error || err.message || 'JSON Parse error in Headers field.');
        }
    };

    const handleDeleteWebhook = async () => {
        if (!deletingWebhook) return;
        setError(null);
        setSuccess(null);
        try {
            const res = await api.delete(`/webhooks/${deletingWebhook.id}`);
            setWebhooks(res.data.webhooks || []);
            setSuccess(`Webhook "${deletingWebhook.name}" deleted.`);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setDeletingWebhook(null);
        }
    };

    const handleTestWebhook = async (id, name) => {
        setTestingWebhookId(id);
        setError(null);
        setSuccess(null);
        setWebhookDebug(null);
        try {
            const res = await api.post(`/webhooks/test/${id}`);
            setSuccess(res.data.message || `Test webhook "${name}" dispatched successfully.`);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
            if (err.response?.data?.debug) {
                setWebhookDebug(err.response.data.debug);
            }
        } finally {
            setTestingWebhookId(null);
        }
    };

    const openEditWebhook = (wh) => {
        setWebhookForm({
            id: wh.id,
            name: wh.name,
            url: wh.url,
            method: wh.method,
            headers: JSON.stringify(wh.headers || {}, null, 2),
            bodyTemplate: wh.bodyTemplate,
            enabled: wh.enabled !== false,
            enabledLogs: Array.isArray(wh.enabledLogs) ? wh.enabledLogs : DEFAULT_LOG_TYPE_KEYS
        });
        setIsWebhookLogsExpanded(false);
        setIsEditingWebhook(true);
    };

    const getEnvsArray = (str) => {
        if (!str) return [];
        return str.split(',').map(s => s.trim()).filter(s => s);
    };

    const getSoftwareItems = (masterText, kind = 'windows') => softwareNames(masterText, kind);

    const handleCheckboxArrayChange = (key, item, checked) => {
        const currentVal = sysConfig[key] || '';
        let selected = currentVal.split(',').map(s => s.trim()).filter(s => s);
        if (checked) {
            if (!selected.includes(item)) {
                selected.push(item);
            }
        } else {
            selected = selected.filter(s => s !== item);
        }
        handleConfigChange(key, selected.join(','));
    };

    const activeCat = CATEGORIES.find(c => c.id === activeCategory);

    return (
        <div style={S.page} className="animate-fade-in">
            {/* Main Layout Row */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: 100 }}><span className="animate-pulse">Loading settings...</span></div>
            ) : (
                <div style={S.layoutRow}>
                    
                    {/* Left Category Sidebar */}
                    {CATEGORIES.length > 1 && (
                        <div style={S.sidebar}>
                            <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase', paddingLeft: 16 }}>Settings Categories</div>
                            {CATEGORIES.map(cat => {
                                const isActive = activeCategory === cat.id;
                                return (
                                    <div 
                                        key={cat.id} 
                                        style={isActive ? { ...S.sidebarItem, ...S.sidebarItemActive } : S.sidebarItem}
                                        onClick={async () => { setActiveCategory(cat.id); setError(null); setSuccess(null); }}
                                    >
                                        <div style={isActive ? { ...S.iconBox, ...S.iconBoxActive } : S.iconBox}>
                                            {cat.icon}
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: 13, fontWeight: 800, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{cat.label}</span>
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{cat.desc}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Right Configuration Area */}
                    <div style={S.contentArea}>
                        {/* Dynamic Subheader */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 16, marginBottom: 8 }}>
                            <div>
                                <h2 style={{ fontSize: 20, fontWeight: 900, margin: 0 }}>{activeCat?.title}</h2>
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>{activeCat?.subtitle}</p>
                            </div>
                            {activeCategory !== 'rbac' && activeCategory !== 'ai' && activeCategory !== 'environments' && (
                                <button style={S.btnP} onClick={handleSaveSettings} disabled={savingSettings}>
                                    {savingSettings ? 'Saving...' : 'Save Changes'}
                                </button>
                            )}
                            {activeCategory === 'ai' && (
                                <button style={S.btnP} onClick={handleSaveAiConfig} disabled={aiSaving}>
                                    {aiSaving ? 'Saving...' : 'Save AI Configuration'}
                                </button>
                            )}
                        </div>

                        {error && (
                            <div style={{ background: 'rgba(255,59,48,0.1)', border: '1px solid rgba(255,59,48,0.3)', color: '#ff3b30', padding: '12px 16px', borderRadius: 12, marginBottom: 16, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Inter', sans-serif" }}>
                                <span>⚠️</span> {error}
                            </div>
                        )}
                        {success && (
                            <div style={{ background: 'rgba(52,199,89,0.1)', border: '1px solid rgba(52,199,89,0.3)', color: '#34c759', padding: '12px 16px', borderRadius: 12, marginBottom: 16, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'Inter', sans-serif" }}>
                                <span>✅</span> {success}
                            </div>
                        )}

                        {/* Config Panel Content Router */}
                        {activeCategory === 'core' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>System Basics</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PORT</label>
                                            <input type="text" style={S.input} value={sysConfig.PORT || ''} onChange={e => handleConfigChange('PORT', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>FRONTEND_TIMEOUT_MINS</label>
                                            <input type="text" style={S.input} value={sysConfig.FRONTEND_TIMEOUT_MINS || ''} onChange={e => handleConfigChange('FRONTEND_TIMEOUT_MINS', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>JWT_SECRET</label>
                                            <input type="password" style={S.input} value={sysConfig.JWT_SECRET || ''} onChange={e => handleConfigChange('JWT_SECRET', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>ALLOWED_AD_DOMAIN</label>
                                            <input type="text" style={S.input} value={sysConfig.ALLOWED_AD_DOMAIN || ''} onChange={e => handleConfigChange('ALLOWED_AD_DOMAIN', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LOCAL_ADMIN_USER</label>
                                            <input type="text" style={S.input} value={sysConfig.LOCAL_ADMIN_USER || ''} onChange={e => handleConfigChange('LOCAL_ADMIN_USER', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LOCAL_ADMIN_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.LOCAL_ADMIN_PWD || ''} onChange={e => handleConfigChange('LOCAL_ADMIN_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AD_ADMIN_USER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Domain\\admin)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.AD_ADMIN_USER || ''} onChange={e => handleConfigChange('AD_ADMIN_USER', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AD_ADMIN_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.AD_ADMIN_PWD || ''} onChange={e => handleConfigChange('AD_ADMIN_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LINUX_ADMIN_USER</label>
                                            <input type="text" style={S.input} value={sysConfig.LINUX_ADMIN_USER || ''} onChange={e => handleConfigChange('LINUX_ADMIN_USER', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LINUX_ADMIN_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.LINUX_ADMIN_PWD || ''} onChange={e => handleConfigChange('LINUX_ADMIN_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SYSTEM_TIMEZONE</label>
                                            <input type="text" style={S.input} value={sysConfig.SYSTEM_TIMEZONE || ''} onChange={e => handleConfigChange('SYSTEM_TIMEZONE', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>DB_DATA_DIR <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Database & Telemetry Directory Path)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.DB_DATA_DIR || ''} placeholder="C:\ProgramData\somp-vanguard" onChange={e => handleConfigChange('DB_DATA_DIR', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>ENABLE_DEV_TOOLS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Developer Tools Console)</span></label>
                                            <select style={S.input} value={sysConfig.ENABLE_DEV_TOOLS !== 'false' ? 'true' : 'false'} onChange={e => handleConfigChange('ENABLE_DEV_TOOLS', e.target.value)}>
                                                <option value="true">Enabled (SuperAdmin only)</option>
                                                <option value="false">Disabled</option>
                                            </select>
                                        </div>
                                        <div style={S.fieldBlock}>
                                        </div>
                                    </div>
                                </div>

                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>🖥️ Web Remote Gateway (Apache Guacamole / guacd)</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>FEATURE_WEB_REMOTE <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(純瀏覽器 Web-RDP / Web-SSH 全域開關)</span></label>
                                            <select style={S.input} value={sysConfig.FEATURE_WEB_REMOTE !== 'false' ? 'true' : 'false'} onChange={e => handleConfigChange('FEATURE_WEB_REMOTE', e.target.value)}>
                                                <option value="true">Enabled (啟用)</option>
                                                <option value="false">Disabled (停用)</option>
                                            </select>
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GUACAMOLE_ENDPOINT <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(例如 192.0.2.50:4822 或 http://guac-gateway:8080)</span></label>
                                            <input type="text" style={S.input} placeholder="192.0.2.50:4822" value={sysConfig.GUACAMOLE_ENDPOINT || ''} onChange={e => handleConfigChange('GUACAMOLE_ENDPOINT', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GUACD_HOST <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(guacd 守護進程主機 IP 或 FQDN)</span></label>
                                            <input type="text" style={S.input} placeholder="192.0.2.50" value={sysConfig.GUACD_HOST || ''} onChange={e => handleConfigChange('GUACD_HOST', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GUACD_PORT <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(guacd TCP 埠號，預設 4822)</span></label>
                                            <input type="number" style={S.input} placeholder="4822" value={sysConfig.GUACD_PORT || '4822'} onChange={e => handleConfigChange('GUACD_PORT', e.target.value)} />
                                        </div>
                                    </div>
                                </div>

                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>Network Settings</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>HTTPS_PROXY</label>
                                            <input type="text" style={S.input} value={sysConfig.HTTPS_PROXY || ''} onChange={e => handleConfigChange('HTTPS_PROXY', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROXY_USER</label>
                                            <input type="text" style={S.input} value={sysConfig.PROXY_USER || ''} onChange={e => handleConfigChange('PROXY_USER', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROXY_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.PROXY_PWD || ''} onChange={e => handleConfigChange('PROXY_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={{ ...S.fieldBlock, flex: 'none', width: '100%' }}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROXY_ENABLED_MODULES</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
                                                onClick={() => setIsProxyExpanded(!isProxyExpanded)}
                                            >
                                                <span style={{ color: 'var(--text-color)' }}>
                                                    {(() => {
                                                        const m = Array.isArray(sysConfig.PROXY_ENABLED_MODULES) ? sysConfig.PROXY_ENABLED_MODULES : (sysConfig.PROXY_ENABLED_MODULES || '').split(',').filter(Boolean);
                                                        return m.length > 0 ? `${m.length} module(s) enabled` : 'Click to select modules';
                                                    })()}
                                                </span>
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isProxyExpanded ? '▼' : '▶'}</span>
                                            </div>
                                            {isProxyExpanded && (
                                                <div style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-color)', animation: 'fadeIn 0.2s ease-out' }}>
                                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                        <thead>
                                                            <tr style={{ background: 'rgba(255,255,255,0.05)', borderBottom: '1px solid var(--border-color)' }}>
                                                                <th style={{ width: 80, padding: '10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Enabled</th>
                                                                <th style={{ padding: '10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Module Name</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                        {['Telegram', 'Webhooks', 'SIEM', 'Inventory', 'Prometheus', 'Kubernetes', 'Nutanix', 'AI'].map((mod, idx, arr) => {
                                                            const currentModules = Array.isArray(sysConfig.PROXY_ENABLED_MODULES) ? sysConfig.PROXY_ENABLED_MODULES : (sysConfig.PROXY_ENABLED_MODULES || '').split(',').filter(Boolean);
                                                            const isChecked = currentModules.includes(mod);
                                                            const labels = {
                                                                Telegram: 'Telegram (System Alerts)',
                                                                Webhooks: 'Webhooks (Alert Forwarding)',
                                                                SIEM: 'SIEM (Splunk Poller)',
                                                                Inventory: 'Server Inventory',
                                                                Prometheus: 'Prometheus Target Scanner',
                                                                Kubernetes: 'Kubernetes Operations',
                                                                Nutanix: 'Nutanix Manager',
                                                                AI: 'AI Engine (OpenAI, Gemini, Ollama, Custom)'
                                                            };
                                                            return (
                                                                <tr key={mod} style={{ borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)', background: isChecked ? 'rgba(0,123,255,0.05)' : 'transparent', transition: 'background 0.2s' }}>
                                                                    <td style={{ textAlign: 'center', padding: '10px' }}>
                                                                        <input type="checkbox" checked={isChecked} onChange={e => {
                                                                            let newModules = [...currentModules];
                                                                            if (e.target.checked) {
                                                                                if (!newModules.includes(mod)) newModules.push(mod);
                                                                            } else {
                                                                                newModules = newModules.filter(m => m !== mod);
                                                                            }
                                                                            handleConfigChange('PROXY_ENABLED_MODULES', newModules);
                                                                        }} style={{ cursor: 'pointer', transform: 'scale(1.2)' }} />
                                                                    </td>
                                                                    <td style={{ padding: '10px', fontSize: 13, color: isChecked ? 'var(--text-color)' : 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={async () => {
                                                                        let newModules = [...currentModules];
                                                                        if (!isChecked) {
                                                                            if (!newModules.includes(mod)) newModules.push(mod);
                                                                        } else {
                                                                            newModules = newModules.filter(m => m !== mod);
                                                                        }
                                                                        handleConfigChange('PROXY_ENABLED_MODULES', newModules);
                                                                    }}>
                                                                        {labels[mod]}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>FRONTEND_ALLOWED_IPS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma-separated)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.FRONTEND_ALLOWED_IPS || ''} onChange={e => handleConfigChange('FRONTEND_ALLOWED_IPS', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>BACKEND_ALLOWED_IPS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma-separated)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.BACKEND_ALLOWED_IPS || ''} onChange={e => handleConfigChange('BACKEND_ALLOWED_IPS', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>API_ALLOWED_IPS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma-separated)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.API_ALLOWED_IPS || ''} onChange={e => handleConfigChange('API_ALLOWED_IPS', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                        </div>
                                    </div>
                                </div>

                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>Database Snapshot & Auto-Backup Settings</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Auto-Backup</label>
                                            <select
                                                style={S.select}
                                                value={sysConfig.DB_BACKUP_ENABLED !== 'true' ? 'disabled' : (['system', 'scout'].includes(String(sysConfig.DB_BACKUP_TARGETS || '').trim().toLowerCase()) ? String(sysConfig.DB_BACKUP_TARGETS).trim().toLowerCase() : 'both')}
                                                onChange={e => {
                                                    const v = e.target.value;
                                                    if (v === 'disabled') {
                                                        handleConfigChange('DB_BACKUP_ENABLED', 'false');
                                                    } else {
                                                        setSysConfig(prev => ({ ...prev, DB_BACKUP_ENABLED: 'true', DB_BACKUP_TARGETS: v }));
                                                    }
                                                }}
                                            >
                                                <option value="disabled">Disabled</option>
                                                <option value="system">System only (database.sqlite)</option>
                                                <option value="scout">Scout only (scout.sqlite)</option>
                                                <option value="both">Both (default)</option>
                                            </select>
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>System key and .env are always included.</span>
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Backup Frequency (Scan Time, e.g. 03:00)</label>
                                            <input type="text" style={S.input} value={sysConfig.DB_BACKUP_SCAN_TIME || '03:00'} onChange={e => handleConfigChange('DB_BACKUP_SCAN_TIME', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Backup Path (Directory)</label>
                                            <input 
                                                type="text" 
                                                style={S.input} 
                                                value={sysConfig.DB_BACKUP_PATH || 'C:\\ProgramData\\somp-vanguard\\config_backup'} 
                                                placeholder="C:\ProgramData\somp-vanguard\config_backup"
                                                onChange={e => handleConfigChange('DB_BACKUP_PATH', e.target.value)} 
                                            />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Backup Retention (Days)</label>
                                            <input 
                                                type="number" 
                                                style={S.input} 
                                                min="1" 
                                                max="365"
                                                value={sysConfig.DB_BACKUP_RETENTION_DAYS || '30'} 
                                                placeholder="30"
                                                onChange={e => handleConfigChange('DB_BACKUP_RETENTION_DAYS', e.target.value)}
                                            />
                                        </div>
                                    </div>
                                    <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                                        <button style={S.btnO} onClick={handleBackupNow} disabled={backupRunning}>
                                            {backupRunning ? 'Backing up…' : '💾 Back Up Now'}
                                        </button>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            Runs a full backup now (database.sqlite, scout.sqlite, system key, .env). Works even when auto-backup is disabled.
                                        </span>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            A manual backup overwrites today's dated backup files.
                                        </span>
                                        {backupStatus && backupStatus.finishedAt && (
                                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                <div style={{ fontWeight: 700 }}>
                                                    Last backup: {new Date(backupStatus.finishedAt).toLocaleString()}{backupStatus.requestedBy ? ` (${backupStatus.requestedBy})` : ''}
                                                </div>
                                                {backupStatus.error && <div style={{ color: '#ff3b30' }}>✗ {backupStatus.error}</div>}
                                                {(backupStatus.items || []).map((it, idx) => (
                                                    <div key={idx} style={{ color: it.ok ? '#34c759' : '#ff3b30', fontFamily: 'monospace' }}>
                                                        {it.ok
                                                            ? `✓ ${it.name} (${((it.bytes || 0) / 1048576).toFixed(1)} MB)`
                                                            : `✗ ${it.name} — ${it.error}`}
                                                    </div>
                                                ))}
                                                {backupStatus.dir && <div style={{ color: 'var(--text-muted)' }}>Backup folder: {backupStatus.dir}</div>}
                                            </div>
                                        )}
                                    </div>
                                </div>

                            </div>
                        )}

                        {activeCategory === 'ai' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                {/* Master AI Engine Switch & Provider */}
                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>🤖 Centralized AI Engine Configuration</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AI INTEGRATION STATUS</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                                                onClick={() => setAiConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                                            >
                                                <input 
                                                    type="checkbox" 
                                                    checked={!!aiConfig.enabled} 
                                                    onChange={() => {}} 
                                                    style={{ cursor: 'pointer', width: 16, height: 16, marginRight: 8, pointerEvents: 'none' }} 
                                                />
                                                <span style={{ fontSize: 13, fontWeight: 700, color: aiConfig.enabled ? 'var(--success)' : 'var(--text-muted)', userSelect: 'none' }}>
                                                    {aiConfig.enabled ? '🟢 Enabled (System-Wide AI Active)' : '🔴 Disabled (AI Features Inactive)'}
                                                </span>
                                            </div>
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AI PROVIDER</label>
                                            <select 
                                                style={S.select} 
                                                value={aiConfig.provider || 'opencode'} 
                                                onChange={e => {
                                                    const p = e.target.value;
                                                    const defaults = {
                                                        opencode: { url: 'https://opencode.ai/zen/v1', model: 'claude-3-7-sonnet' },
                                                        openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                                                        anthropic: { url: 'https://api.anthropic.com', model: 'claude-3-7-sonnet-latest' },
                                                        deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-chat' },
                                                        gemini: { url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
                                                        azure: { url: '', model: 'gpt-4o' },
                                                        ollama: { url: 'http://localhost:11434', model: 'llama3:8b' },
                                                        custom: { url: 'http://localhost:8080/v1', model: 'default' }
                                                    };
                                                    const def = defaults[p] || defaults.custom;
                                                    setAiConfig(prev => ({
                                                        ...prev,
                                                        provider: p,
                                                        baseUrl: def.url,
                                                        model: def.model
                                                    }));
                                                    setAvailableModels([]);
                                                    setModelsFetchError(null);
                                                }}
                                            >
                                                <option value="opencode">🚀 OpenCode (Zen / Go Gateway - Claude 3.7, GPT-4o, DeepSeek)</option>
                                                <option value="openai">🟢 OpenAI (GPT-4o, GPT-4o-mini, o1, o3-mini)</option>
                                                <option value="anthropic">🟣 Anthropic Claude (Claude 3.7 Sonnet, Claude 3.5 Haiku)</option>
                                                <option value="deepseek">🐋 DeepSeek Official Cloud (deepseek-chat, deepseek-reasoner)</option>
                                                <option value="gemini">✨ Google Gemini (Gemini 2.0 Flash, Gemini 1.5 Pro)</option>
                                                <option value="azure">🏢 Azure OpenAI Service</option>
                                                <option value="ollama">🦙 Ollama (Local Host / Air-Gapped)</option>
                                                <option value="custom">⚡ Custom OpenAI-Compatible (vLLM, llama.cpp, LocalAI, Groq, OpenRouter)</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                API BASE URL {
                                                    aiConfig.provider === 'opencode' ? '(Default: https://opencode.ai/zen/v1)' :
                                                    aiConfig.provider === 'anthropic' ? '(Default: https://api.anthropic.com)' :
                                                    aiConfig.provider === 'deepseek' ? '(Default: https://api.deepseek.com)' :
                                                    aiConfig.provider === 'gemini' ? '(Default: https://generativelanguage.googleapis.com)' :
                                                    aiConfig.provider === 'ollama' ? '(Default: http://localhost:11434)' :
                                                    aiConfig.provider === 'openai' ? '(Default: https://api.openai.com/v1)' :
                                                    '(e.g. http://host:port/v1)'
                                                }
                                            </label>
                                            <input 
                                                type="text" 
                                                style={S.input} 
                                                value={aiConfig.baseUrl || ''} 
                                                placeholder={
                                                    aiConfig.provider === 'opencode' ? 'https://opencode.ai/zen/v1 (or /zen/go/v1)' :
                                                    aiConfig.provider === 'anthropic' ? 'https://api.anthropic.com' :
                                                    aiConfig.provider === 'deepseek' ? 'https://api.deepseek.com' :
                                                    aiConfig.provider === 'gemini' ? 'https://generativelanguage.googleapis.com' :
                                                    aiConfig.provider === 'ollama' ? 'http://localhost:11434' :
                                                    aiConfig.provider === 'openai' ? 'https://api.openai.com/v1' :
                                                    'http://host:port/v1'
                                                } 
                                                onChange={e => setAiConfig(prev => ({ ...prev, baseUrl: e.target.value }))} 
                                            />
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                API KEY {aiConfig.provider === 'ollama' ? '(Optional for Ollama)' : '(Encrypted in Database)'}
                                            </label>
                                            <input 
                                                type="password" 
                                                style={S.input} 
                                                value={aiConfig.apiKey || ''} 
                                                placeholder={aiConfig.hasApiKey ? '🔑 Key encrypted (Leave blank to keep existing)' : 'Enter API Key (Bearer Token / sk-...)'} 
                                                onChange={e => setAiConfig(prev => ({ ...prev, apiKey: e.target.value }))} 
                                            />
                                        </div>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MODEL NAME</label>
                                                <button
                                                    type="button"
                                                    onClick={handleFetchModels}
                                                    disabled={loadingModels}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: 'var(--accent-primary)',
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 4
                                                    }}
                                                >
                                                    {loadingModels ? '⏳ Fetching Models...' : '🔄 Fetch Available Models'}
                                                </button>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                                <input 
                                                    type="text" 
                                                    list="ai-models-list"
                                                    style={{ ...S.input, marginTop: 0 }} 
                                                    value={aiConfig.model || ''} 
                                                    placeholder={
                                                        aiConfig.provider === 'opencode' ? 'claude-3-7-sonnet, gpt-4o, deepseek-r1' :
                                                        aiConfig.provider === 'anthropic' ? 'claude-3-7-sonnet-latest, claude-3-5-haiku-latest' :
                                                        aiConfig.provider === 'deepseek' ? 'deepseek-chat, deepseek-reasoner' :
                                                        aiConfig.provider === 'openai' ? 'gpt-4o, gpt-4o-mini, o3-mini, o1' :
                                                        aiConfig.provider === 'gemini' ? 'gemini-2.0-flash, gemini-1.5-pro' :
                                                        aiConfig.provider === 'ollama' ? 'llama3:8b, qwen2.5:14b, deepseek-r1:14b' :
                                                        'Model Identifier (e.g. Qwen3.6-35B, deepseek-r1)'
                                                    } 
                                                    onChange={e => setAiConfig(prev => ({ ...prev, model: e.target.value }))} 
                                                />
                                                <datalist id="ai-models-list">
                                                    {availableModels.map(m => (
                                                        <option key={m} value={m} />
                                                    ))}
                                                </datalist>
                                            </div>
                                            {availableModels.length > 0 && (
                                                <div style={{ fontSize: 11, color: '#10b981', marginTop: 4, fontWeight: 600 }}>
                                                    ✓ 已成功載入 {availableModels.length} 個可用模型，您可點選輸入框直接選擇或打字搜尋。
                                                </div>
                                            )}
                                            {modelsFetchError && (
                                                <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4, fontWeight: 600 }}>
                                                    ⚠️ 模型清單載入失敗：{modelsFetchError}
                                                </div>
                                            )}
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TEMPERATURE (CREATIVITY vs DETERMINISM)</label>
                                                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)' }}>{aiConfig.temperature}</span>
                                            </div>
                                            <input 
                                                type="range" 
                                                min="0" 
                                                max="1" 
                                                step="0.05" 
                                                value={aiConfig.temperature ?? 0.3} 
                                                onChange={e => setAiConfig(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))} 
                                                style={{ width: '100%', marginTop: 12, cursor: 'pointer' }} 
                                            />
                                        </div>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                REQUEST TIMEOUT (SECONDS) <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default: 120s)</span>
                                            </label>
                                            <input 
                                                type="number" 
                                                min="10" 
                                                max="900" 
                                                style={S.input} 
                                                value={Math.round((aiConfig.timeout || 120000) / 1000)} 
                                                placeholder="120" 
                                                onChange={e => setAiConfig(prev => ({ ...prev, timeout: (parseInt(e.target.value) || 120) * 1000 }))} 
                                            />
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                MAX OUTPUT TOKENS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default: 2048)</span>
                                            </label>
                                            <input 
                                                type="number" 
                                                min="256" 
                                                max="65536" 
                                                step="256" 
                                                style={S.input} 
                                                value={aiConfig.maxTokens || 2048} 
                                                placeholder="2048" 
                                                onChange={e => setAiConfig(prev => ({ ...prev, maxTokens: parseInt(e.target.value) || 2048 }))} 
                                            />
                                        </div>
                                    </div>

                                    {/* Thinking Mode & Reasoning Effort */}
                                    <div style={{ ...S.fieldBlock, background: 'rgba(255, 255, 255, 0.02)', padding: '14px 18px', borderRadius: 10, border: '1px solid var(--border-color)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                                                <input 
                                                    type="checkbox"
                                                    checked={!!aiConfig.enableThinking}
                                                    onChange={e => setAiConfig(prev => ({ ...prev, enableThinking: e.target.checked }))}
                                                    style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                                                />
                                                <span>🧠 Enable Thinking / Reasoning Mode (啟用深度思考推理)</span>
                                            </label>

                                            {(aiConfig.enableThinking || /^(o1|o3|o4)/i.test(aiConfig.model) || (aiConfig.model || '').toLowerCase().includes('reasoner')) && (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)' }}>REASONING EFFORT:</span>
                                                    <select
                                                        style={{ ...S.select, width: 'auto', padding: '4px 10px', fontSize: 12, marginTop: 0 }}
                                                        value={aiConfig.reasoningEffort || 'medium'}
                                                        onChange={e => setAiConfig(prev => ({ ...prev, reasoningEffort: e.target.value }))}
                                                    >
                                                        <option value="low">Low (快速思考)</option>
                                                        <option value="medium">Medium (標準平衡)</option>
                                                        <option value="high">High (深度推論)</option>
                                                    </select>
                                                </div>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6, paddingLeft: 26 }}>
                                            💡 <strong>思考模型支援說明</strong>：相容 Claude 3.7 Extended Thinking、DeepSeek-R1、OpenAI o1/o3-mini 以及 Qwen/vLLM 推理格式；當模型進行長思考時建議調大上方 Timeout 時間。
                                        </div>
                                    </div>

                                    {/* AI Ops Agent */}
                                    <div style={{ ...S.fieldBlock, background: 'rgba(255, 255, 255, 0.02)', padding: '14px 18px', borderRadius: 10, border: '1px solid var(--border-color)' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                                            <input
                                                type="checkbox"
                                                checked={!!aiConfig.agentEnabled}
                                                onChange={e => setAiConfig(prev => ({ ...prev, agentEnabled: e.target.checked }))}
                                                style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                                            />
                                            <span>🤖 啟用 AI Ops Agent（告警調查助理，只讀）</span>
                                        </label>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                                            Agent 會把指標、告警、日誌與 CMDB 資料（已遮蔽密碼與金鑰）送給上方設定的 AI 服務，並且只能查詢、無法執行任何動作。
                                            使用者需具備「🤖 AI Ops Agent」功能權限。
                                        </div>
                                        <div style={{ ...S.gridRow, marginTop: 12 }}>
                                            <div style={S.fieldBlock}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                    AGENT MODEL <span style={{ fontWeight: 'normal' }}>(選填，留空沿用上方 Model)</span>
                                                </label>
                                                <input
                                                    style={S.input}
                                                    value={aiConfig.agentModel || ''}
                                                    placeholder="例如 claude-sonnet-5-5 / gpt-4.1 / qwen3:14b"
                                                    onChange={e => setAiConfig(prev => ({ ...prev, agentModel: e.target.value }))}
                                                />
                                            </div>
                                            <div style={S.fieldBlock}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                    每人每小時提問上限 <span style={{ fontWeight: 'normal' }}>(Default: 30)</span>
                                                </label>
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="500"
                                                    style={S.input}
                                                    value={aiConfig.agentRateLimitPerHour || 30}
                                                    onChange={e => setAiConfig(prev => ({ ...prev, agentRateLimitPerHour: parseInt(e.target.value, 10) || 30 }))}
                                                />
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                                            <button style={S.btnP} onClick={handleTestAgent} disabled={agentTesting}>
                                                {agentTesting ? 'Testing...' : '🧪 測試 Agent 工具呼叫'}
                                            </button>
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>使用「已儲存」的設定測試，請先按 Save AI Configuration。</span>
                                        </div>
                                        {agentTestResult && (
                                            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: agentTestResult.ok ? '#10b981' : '#ef4444' }}>
                                                {agentTestResult.ok
                                                    ? `✅ ${agentTestResult.message}（${agentTestResult.model}，${agentTestResult.latencyMs}ms）`
                                                    : `❌ ${agentTestResult.error || agentTestResult.message}`}
                                            </div>
                                        )}
                                    </div>

                                    <div style={S.fieldBlock}>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GLOBAL BASE SYSTEM PROMPT</label>
                                        <textarea 
                                            style={S.textarea} 
                                            rows="3" 
                                            value={aiConfig.systemPrompt || ''} 
                                            placeholder="You are an elite Incident Response and Enterprise IT Operations assistant for SOMP Vanguard..." 
                                            onChange={e => setAiConfig(prev => ({ ...prev, systemPrompt: e.target.value }))} 
                                        />
                                    </div>

                                    {/* Test Connection Button & Result */}
                                    <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                                        <button 
                                            type="button" 
                                            style={{ ...S.btnO, background: 'var(--bg-glass)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }} 
                                            onClick={handleTestAi} 
                                            disabled={aiTesting}
                                        >
                                            {aiTesting ? 'Testing Connectivity...' : '⚡ Test AI Engine Connection'}
                                        </button>
                                        {aiTestResult && (
                                            <div style={{ 
                                                padding: '8px 16px', 
                                                borderRadius: 12, 
                                                fontSize: 12, 
                                                fontWeight: 700, 
                                                background: aiTestResult.success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', 
                                                color: aiTestResult.success ? '#10b981' : '#ef4444',
                                                border: `1px solid ${aiTestResult.success ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`
                                            }}>
                                                {aiTestResult.success ? (
                                                    <span>🟢 Connection OK ({aiTestResult.provider} / {aiTestResult.model}, Latency: {aiTestResult.latencyMs}ms)</span>
                                                ) : (
                                                    <span>🔴 Connection Failed: {aiTestResult.error}</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Universal AI Service Usage Guide Card */}
                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 12 }}>💡 Universal AI Integration Across Vanguard</h3>
                                    <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                        Once configured and enabled, this central AI engine powers multiple intelligence features across Vanguard:
                                        <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                                            <li><b>On-Demand Forensics</b>: Generates attack story reconstruction, threat root cause analysis, and actionable PowerShell/Bash remediation scripts.</li>
                                            <li><b>Future Vanguard Modules</b>: Shared across Log Analysis, SIEM Alert summarization, Network anomaly diagnosis, and AD security audit explanation without redefining AI credentials.</li>
                                            <li><b>Enterprise Security</b>: API Keys are AES-256 encrypted on disk and never exposed to the frontend. Local Ollama or On-Prem mode guarantees zero external data leakage.</li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeCategory === 'openapi' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                {/* 1. Master Open API Gateway Switch & Security */}
                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>🌐 Scout Open API Gateway Status & Security</h3>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SCOUT OPEN API STATUS (ENABLE_SCOUT_OPEN_API)</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('ENABLE_SCOUT_OPEN_API', sysConfig.ENABLE_SCOUT_OPEN_API === 'false' ? 'true' : 'false')}
                                            >
                                                <input 
                                                    type="checkbox" 
                                                    checked={sysConfig.ENABLE_SCOUT_OPEN_API !== 'false'} 
                                                    onChange={() => {}} 
                                                    style={{ cursor: 'pointer', width: 16, height: 16, marginRight: 8, pointerEvents: 'none' }} 
                                                />
                                                <span style={{ fontSize: 13, fontWeight: 700, color: sysConfig.ENABLE_SCOUT_OPEN_API !== 'false' ? 'var(--success)' : 'var(--text-muted)', userSelect: 'none' }}>
                                                    {sysConfig.ENABLE_SCOUT_OPEN_API !== 'false' ? '🟢 Enabled (Open API Endpoints Active)' : '🔴 Disabled (Open API Endpoints Blocked 403)'}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                                Master switch controlling all <code>/api/v1/open/*</code> and <code>/api/open/scout/*</code> endpoints.
                                            </div>
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>ACCESS & AUDIT LOGGING (ENABLE_OPEN_API_LOGGING)</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('ENABLE_OPEN_API_LOGGING', sysConfig.ENABLE_OPEN_API_LOGGING === 'false' ? 'true' : 'false')}
                                            >
                                                <input 
                                                    type="checkbox" 
                                                    checked={sysConfig.ENABLE_OPEN_API_LOGGING !== 'false'} 
                                                    onChange={() => {}} 
                                                    style={{ cursor: 'pointer', width: 16, height: 16, marginRight: 8, pointerEvents: 'none' }} 
                                                />
                                                <span style={{ fontSize: 13, fontWeight: 700, color: sysConfig.ENABLE_OPEN_API_LOGGING !== 'false' ? 'var(--success)' : 'var(--text-muted)', userSelect: 'none' }}>
                                                    {sysConfig.ENABLE_OPEN_API_LOGGING !== 'false' ? '🟢 Enabled (Write Access Records to Audit Log)' : '⚪ Disabled (Silent Mode)'}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                                Automatically logs caller IP, API Key name, endpoint path, status code, and latency in system Audit Logs.
                                            </div>
                                        </div>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>RATE LIMIT PER MINUTE (OPEN_API_RATE_LIMIT)</label>
                                            <input 
                                                type="number" 
                                                style={S.input} 
                                                min="10" 
                                                max="10000"
                                                value={sysConfig.OPEN_API_RATE_LIMIT || '120'} 
                                                placeholder="120"
                                                onChange={e => handleConfigChange('OPEN_API_RATE_LIMIT', e.target.value)} 
                                            />
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                                Maximum requests allowed per minute per API Key + IP pair before returning HTTP 429.
                                            </div>
                                        </div>

                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>API AUTHENTICATION FORMAT</label>
                                            <input 
                                                type="text" 
                                                style={{ ...S.input, background: 'rgba(255,255,255,0.02)', color: 'var(--text-secondary)' }} 
                                                disabled 
                                                value="Authorization: Bearer <API_KEY>  or  X-API-Key: <API_KEY>" 
                                            />
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                                All requests must provide an authorized Open API Key generated in Agent Manager.
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* 2. Scout Open API (Metrics & Event Logs) Card */}
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🌐 Scout Open API (Metrics & Event Logs)</h3>
                                        <div style={{ display: 'flex', gap: 10 }}>
                                            <button 
                                                style={{ ...S.btnO, padding: '6px 14px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                                onClick={() => setShowDocModal(true)}
                                            >
                                                📖 API Documentation
                                            </button>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
                                        Allow external monitoring systems (Grafana, SIEM, Prometheus, scripts) to securely query Scout host telemetry metrics and Windows/Linux event logs using API Keys.
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Scout Open API Master Switch</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('ENABLE_SCOUT_OPEN_API', sysConfig.ENABLE_SCOUT_OPEN_API === 'false' ? 'true' : 'false')}
                                            >
                                                <input 
                                                    type="checkbox" 
                                                    checked={sysConfig.ENABLE_SCOUT_OPEN_API !== 'false'} 
                                                    onChange={() => {}} 
                                                    style={{ cursor: 'pointer', width: 16, height: 16, marginRight: 8, pointerEvents: 'none' }} 
                                                />
                                                <span style={{ fontSize: 13, fontWeight: 700, color: sysConfig.ENABLE_SCOUT_OPEN_API !== 'false' ? 'var(--success)' : 'var(--text-muted)', userSelect: 'none' }}>
                                                    {sysConfig.ENABLE_SCOUT_OPEN_API !== 'false' ? '🟢 Enabled (Endpoints Active)' : '🔴 Disabled (Blocked)'}
                                                </span>
                                            </div>
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAX QUERY TIME RANGE (DAYS)</label>
                                            <input 
                                                type="number" 
                                                style={S.input} 
                                                value={sysConfig.SCOUT_OPEN_API_MAX_DAYS || '30'} 
                                                onChange={e => handleConfigChange('SCOUT_OPEN_API_MAX_DAYS', e.target.value)} 
                                                min="1"
                                                max="365"
                                                placeholder="30"
                                            />
                                        </div>
                                    </div>

                                    {/* Quick cURL Example */}
                                    <div style={{ marginTop: 8, padding: '14px 18px', background: 'rgba(0,0,0,0.25)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                ⚡ QUICK CURL QUERY EXAMPLE
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                🔑 API Key 請至 <strong style={{ color: 'var(--accent-primary)' }}>Monitor Service &gt; Agents &gt; API Keys</strong> 產生與取得
                                            </div>
                                        </div>
                                        <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.3)', padding: '8px 12px', borderRadius: 8, overflowX: 'auto', whiteSpace: 'pre' }}>
{`curl -H "Authorization: Bearer <YOUR_API_KEY>" "${window.location.origin}/api/v1/open/metrics/realtime?host=198.51.100.56"
curl -H "Authorization: Bearer <YOUR_API_KEY>" "${window.location.origin}/api/v1/open/logs/windows?host=198.51.100.74&level=Error"`}
                                        </div>
                                    </div>
                                </div>

                                {/* 3. Open API Resources & Quick Links Card */}
                                <div style={S.card}>
                                    <h3 style={{ ...S.tblTitle, marginBottom: 16 }}>📖 Open API Resources & Quick Links</h3>
                                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                                        <a 
                                            href="/docs/index.html#api" 
                                            target="_blank" 
                                            rel="noopener noreferrer" 
                                            style={{ ...S.btnP, textDecoration: 'none', background: 'var(--accent-gradient)' }}
                                        >
                                            📑 View Interactive API Documentation
                                        </a>
                                        <a 
                                            href="/docs/api_documentation.html" 
                                            target="_blank" 
                                            rel="noopener noreferrer" 
                                            style={{ ...S.btnO, textDecoration: 'none' }}
                                        >
                                            🔍 Open Swagger-Style Reference
                                        </a>
                                    </div>

                                    <div style={{ marginTop: 20, padding: 16, background: 'rgba(0,0,0,0.2)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>⚡ Quick Test Command:</div>
                                        <pre style={{ margin: 0, padding: '10px 14px', background: '#0b1120', borderRadius: 8, fontSize: 12, color: '#38bdf8', overflowX: 'auto', fontFamily: 'monospace' }}>
{`curl -H "X-API-Key: <YOUR_OPEN_API_KEY>" "${window.location.protocol}//${window.location.host}/api/v1/open/hosts"`}
                                        </pre>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeCategory === 'environments' && <EnvironmentsSettings />}

                        {activeCategory === 'others' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🎯 Prometheus Targets Configuration</h3>
                                        <button style={{ ...S.btnO, padding: '4px 12px', fontSize: 12 }} onClick={() => handleRunNow('prometheus')}>⚡ Run Scan Now</button>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROMETHEUS_SD_TOKEN</label>
                                            <input type="password" style={S.input} value={sysConfig.PROMETHEUS_SD_TOKEN || ''} onChange={e => handleConfigChange('PROMETHEUS_SD_TOKEN', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROMETHEUS_SCAN_TIME <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(e.g., 05:00)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.PROMETHEUS_SCAN_TIME || ''} onChange={e => handleConfigChange('PROMETHEUS_SCAN_TIME', e.target.value)} />
                                        </div>
                                    </div>
                                </div>
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🔒 SSL Certificate Monitoring</h3>
                                        <button style={{ ...S.btnO, padding: '4px 12px', fontSize: 12 }} onClick={() => handleRunNow('ssl')}>⚡ Run Scan Now</button>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SSL_ALERT_THRESHOLD_DAYS</label>
                                            <input type="text" style={S.input} value={sysConfig.SSL_ALERT_THRESHOLD_DAYS || ''} onChange={e => handleConfigChange('SSL_ALERT_THRESHOLD_DAYS', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SSL_MONITOR_SCAN_TIME <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(e.g., 04:00)</span></label>
                                            <input type="text" style={S.input} value={sysConfig.SSL_MONITOR_SCAN_TIME || ''} onChange={e => handleConfigChange('SSL_MONITOR_SCAN_TIME', e.target.value)} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeCategory === 'integration' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                                {/* Telegram Settings Card */}
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🤖 Telegram Alert Settings</h3>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button 
                                                type="button" 
                                                style={{ ...S.btnO, padding: '4px 12px', fontSize: 11, borderRadius: 6, cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('TELEGRAM_ENABLED_LOGS', ALL_LOG_TYPE_KEYS)}
                                            >
                                                Select All Logs
                                            </button>
                                            <button 
                                                type="button" 
                                                style={{ ...S.btnO, padding: '4px 12px', fontSize: 11, borderRadius: 6, cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('TELEGRAM_ENABLED_LOGS', [])}
                                            >
                                                Clear All Logs
                                            </button>
                                        </div>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TELEGRAM_BOT_TOKEN</label>
                                            <input type="password" style={S.input} value={sysConfig.TELEGRAM_BOT_TOKEN || ''} onChange={e => handleConfigChange('TELEGRAM_BOT_TOKEN', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TELEGRAM_CHAT_ID</label>
                                            <input type="text" style={S.input} value={sysConfig.TELEGRAM_CHAT_ID || ''} onChange={e => handleConfigChange('TELEGRAM_CHAT_ID', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Enable Command Listener (Polling)</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                                                onClick={() => handleConfigChange('TELEGRAM_LISTENER_ENABLED', sysConfig.TELEGRAM_LISTENER_ENABLED !== 'false' ? 'false' : 'true')}
                                            >
                                                <input 
                                                    type="checkbox" 
                                                    checked={sysConfig.TELEGRAM_LISTENER_ENABLED !== 'false'} 
                                                    onChange={() => {}} 
                                                    style={{ cursor: 'pointer', width: 16, height: 16, marginRight: 8, pointerEvents: 'none' }} 
                                                />
                                                <span style={{ fontSize: 13, color: 'var(--text-color)', userSelect: 'none' }}>
                                                    {sysConfig.TELEGRAM_LISTENER_ENABLED !== 'false' ? 'Enabled' : 'Disabled'}
                                                </span>
                                            </div>
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Long Polling Interval (Sec)</label>
                                            <input 
                                                type="number" 
                                                style={S.input} 
                                                value={sysConfig.TELEGRAM_POLL_INTERVAL || '30'} 
                                                onChange={e => handleConfigChange('TELEGRAM_POLL_INTERVAL', e.target.value)} 
                                                min="1"
                                                max="3600"
                                            />
                                        </div>
                                    </div>

                                    {/* Telegram Event Log Type Filter */}
                                    <div style={{ marginTop: 8 }}>
                                        <div style={{ ...S.fieldBlock, flex: 'none', width: '100%', marginBottom: 0 }}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TELEGRAM_ENABLED_LOGS (Telegram 接收之日誌種類)</label>
                                            <div 
                                                style={{ ...S.input, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
                                                onClick={() => setIsTelegramLogsExpanded(!isTelegramLogsExpanded)}
                                            >
                                                <span style={{ color: 'var(--text-color)' }}>
                                                    {(() => {
                                                        const currentLogs = sysConfig.TELEGRAM_ENABLED_LOGS === undefined
                                                            ? (sysConfig.INTEGRATION_ENABLED_LOGS !== undefined 
                                                                ? (Array.isArray(sysConfig.INTEGRATION_ENABLED_LOGS) ? sysConfig.INTEGRATION_ENABLED_LOGS : sysConfig.INTEGRATION_ENABLED_LOGS.split(',').filter(Boolean))
                                                                : DEFAULT_LOG_TYPE_KEYS)
                                                            : (Array.isArray(sysConfig.TELEGRAM_ENABLED_LOGS) 
                                                                ? sysConfig.TELEGRAM_ENABLED_LOGS 
                                                                : (sysConfig.TELEGRAM_ENABLED_LOGS || '').split(',').map(s => s.trim()).filter(Boolean));
                                                        if (currentLogs.length === 0) return 'No log types enabled (Telegram notifications muted)';
                                                        if (currentLogs.length === ALL_LOG_TYPE_KEYS.length) return `All ${currentLogs.length} log types enabled`;
                                                        return `${currentLogs.length} / ${ALL_LOG_TYPE_KEYS.length} log types enabled`;
                                                    })()}
                                                </span>
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isTelegramLogsExpanded ? '▼' : '▶'}</span>
                                            </div>
                                            {isTelegramLogsExpanded && (
                                                <div style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-color)', animation: 'fadeIn 0.2s ease-out' }}>
                                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                        <thead>
                                                            <tr style={{ background: 'rgba(255,255,255,0.05)', borderBottom: '1px solid var(--border-color)' }}>
                                                                <th style={{ width: 80, padding: '10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Enabled</th>
                                                                <th style={{ padding: '10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Log Category / Event Type</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                        {LOG_TYPE_DEFINITIONS.map((item, idx, arr) => {
                                                            const currentLogs = sysConfig.TELEGRAM_ENABLED_LOGS === undefined
                                                                ? (sysConfig.INTEGRATION_ENABLED_LOGS !== undefined 
                                                                    ? (Array.isArray(sysConfig.INTEGRATION_ENABLED_LOGS) ? sysConfig.INTEGRATION_ENABLED_LOGS : sysConfig.INTEGRATION_ENABLED_LOGS.split(',').filter(Boolean))
                                                                    : DEFAULT_LOG_TYPE_KEYS)
                                                                : (Array.isArray(sysConfig.TELEGRAM_ENABLED_LOGS) 
                                                                    ? sysConfig.TELEGRAM_ENABLED_LOGS 
                                                                    : (sysConfig.TELEGRAM_ENABLED_LOGS || '').split(',').map(s => s.trim()).filter(Boolean));
                                                            const isChecked = currentLogs.includes(item.id);
                                                            return (
                                                                <tr 
                                                                    key={item.id} 
                                                                    style={{ 
                                                                        borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)', 
                                                                        background: isChecked ? 'rgba(0,123,255,0.05)' : 'transparent', 
                                                                        transition: 'background 0.2s',
                                                                        cursor: 'pointer'
                                                                    }}
                                                                    onClick={() => {
                                                                        let newTypes = [...currentLogs];
                                                                        if (!isChecked) {
                                                                            if (!newTypes.includes(item.id)) newTypes.push(item.id);
                                                                        } else {
                                                                            newTypes = newTypes.filter(t => t !== item.id);
                                                                        }
                                                                        handleConfigChange('TELEGRAM_ENABLED_LOGS', newTypes);
                                                                    }}
                                                                >
                                                                    <td style={{ textAlign: 'center', padding: '10px' }}>
                                                                        <input 
                                                                            type="checkbox" 
                                                                            checked={isChecked} 
                                                                            onChange={e => {
                                                                                e.stopPropagation();
                                                                                let newTypes = [...currentLogs];
                                                                                if (e.target.checked) {
                                                                                    if (!newTypes.includes(item.id)) newTypes.push(item.id);
                                                                                } else {
                                                                                    newTypes = newTypes.filter(t => t !== item.id);
                                                                                }
                                                                                handleConfigChange('TELEGRAM_ENABLED_LOGS', newTypes);
                                                                            }} 
                                                                            style={{ cursor: 'pointer', transform: 'scale(1.2)' }} 
                                                                        />
                                                                    </td>
                                                                    <td style={{ padding: '10px', userSelect: 'none' }}>
                                                                        <div style={{ fontSize: 13, fontWeight: 700, color: isChecked ? 'var(--text-color)' : 'var(--text-muted)' }}>
                                                                            {item.label}
                                                                        </div>
                                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                                            {item.desc}
                                                                        </div>
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Webhook Hub Card */}
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🔌 Webhook Integration Targets</h3>
                                        <button 
                                            style={{ ...S.btnP, padding: '6px 16px', fontSize: 12 }}
                                            onClick={async () => {
                                                setWebhookForm({ id: '', name: '', url: '', method: 'POST', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '{\n  "text": "{{message}}"\n}', enabled: true, enabledLogs: DEFAULT_LOG_TYPE_KEYS });
                                                setIsWebhookLogsExpanded(false);
                                                setIsEditingWebhook(true);
                                            }}
                                        >
                                            + Add Webhook
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
                                        Trigger HTTP callbacks when critical alert events occur. Customize headers and body payloads to integrate with Slack, MS Teams, LINE, etc.
                                    </div>

                                    {webhookDebug && (
                                        <div style={{ background: 'rgba(0, 0, 0, 0.45)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: 12, padding: 16, marginBottom: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ fontSize: 13, fontWeight: 900, color: '#ef4444' }}>
                                                        🔍 Webhook 請求失敗診斷資訊 (Full Request Debug Dump)
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', gap: 8 }}>
                                                    <button 
                                                        type="button" 
                                                        style={{ ...S.btnO, padding: '4px 12px', fontSize: 11, background: 'rgba(255,255,255,0.06)' }}
                                                        onClick={() => {
                                                            const txt = JSON.stringify(webhookDebug, null, 2);
                                                            if (navigator.clipboard) {
                                                                navigator.clipboard.writeText(txt);
                                                            } else {
                                                                const ta = document.createElement('textarea');
                                                                ta.value = txt;
                                                                document.body.appendChild(ta);
                                                                ta.select();
                                                                document.execCommand('copy');
                                                                document.body.removeChild(ta);
                                                            }
                                                            setSuccess('Debug JSON copied to clipboard!');
                                                        }}
                                                    >
                                                        📋 複製除錯 JSON
                                                    </button>
                                                    <button 
                                                        type="button" 
                                                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                                                        onClick={() => setWebhookDebug(null)}
                                                    >
                                                        ✖ 關閉
                                                    </button>
                                                </div>
                                            </div>
                                            <pre style={{ margin: 0, padding: 14, background: 'rgba(0,0,0,0.5)', borderRadius: 8, fontSize: 11, color: '#38bdf8', overflowX: 'auto', fontFamily: 'monospace', maxHeight: 320, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                                {JSON.stringify(webhookDebug, null, 2)}
                                            </pre>
                                        </div>
                                    )}

                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead>
                                                <tr>
                                                    <th style={S.th}>NAME</th>
                                                    <th style={S.th}>METHOD</th>
                                                    <th style={S.th}>URL</th>
                                                    <th style={S.th}>SUBSCRIBED LOGS</th>
                                                    <th style={S.th}>STATUS</th>
                                                    <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {webhooks.map(wh => {
                                                    const logs = Array.isArray(wh.enabledLogs) ? wh.enabledLogs : DEFAULT_LOG_TYPE_KEYS;
                                                    return (
                                                    <tr key={wh.id} style={S.tr}>
                                                        <td style={{ ...S.td, fontWeight: 800 }}>{wh.name}</td>
                                                        <td style={S.td}><span style={{ ...S.btnO, border: 'none', padding: '2px 8px', fontSize: 11, background: 'var(--bg-secondary)', fontWeight: 800 }}>{wh.method}</span></td>
                                                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wh.url}</td>
                                                        <td style={S.td}>
                                                            <span style={{
                                                                fontSize: 11,
                                                                padding: '3px 8px',
                                                                borderRadius: 6,
                                                                background: 'rgba(255,255,255,0.05)',
                                                                border: '1px solid var(--border-color)',
                                                                color: logs.length === 0 ? 'var(--text-muted)' : 'var(--accent-primary)',
                                                                fontWeight: 700
                                                            }}>
                                                                {logs.length === 0 ? `0 / ${ALL_LOG_TYPE_KEYS.length} (Muted)` : (logs.length === ALL_LOG_TYPE_KEYS.length ? `All ${ALL_LOG_TYPE_KEYS.length} Types` : `${logs.length} / ${ALL_LOG_TYPE_KEYS.length} Types`)}
                                                            </span>
                                                        </td>
                                                        <td style={S.td}>
                                                            <span style={{
                                                                fontSize: 11,
                                                                fontWeight: 700,
                                                                color: wh.enabled !== false ? 'var(--success)' : 'var(--text-muted)'
                                                            }}>
                                                                {wh.enabled !== false ? '🟢 Enabled' : '⚪ Disabled'}
                                                            </span>
                                                        </td>
                                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                                            <div style={{ display: 'inline-flex', gap: 6 }}>
                                                                <button 
                                                                    style={{ ...S.btnO, padding: '4px 10px', fontSize: 11 }}
                                                                    onClick={() => handleTestWebhook(wh.id, wh.name)}
                                                                    disabled={testingWebhookId === wh.id}
                                                                >
                                                                    {testingWebhookId === wh.id ? 'Sending...' : '⚡ Test'}
                                                                </button>
                                                                <button 
                                                                    style={{ ...S.btnO, padding: '4px 10px', fontSize: 11 }}
                                                                    onClick={() => openEditWebhook(wh)}
                                                                >
                                                                    ✏️ Edit
                                                                </button>
                                                                <button 
                                                                    style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '4px 10px', fontSize: 11 }}
                                                                    onClick={() => setDeletingWebhook(wh)}
                                                                >
                                                                    🗑️ Delete
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    );
                                                })}
                                                {webhooks.length === 0 && (
                                                    <tr>
                                                        <td colSpan="6" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
                                                            No webhooks configured. Click "+ Add Webhook" to create one.
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeCategory === 'forti' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_ENVS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated, e.g. UAT,PRD)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.FORTI_ENVS || ''} onChange={e => handleConfigChange('FORTI_ENVS', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_BU_LIST <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated, e.g. IT,HR)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.FORTI_BU_LIST || ''} onChange={e => handleConfigChange('FORTI_BU_LIST', e.target.value)} />
                                </div>

                                {getEnvsArray(sysConfig.FORTI_ENVS).map(env => (
                                    <div key={env} style={S.hint}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', display: 'block', marginBottom: 8 }}>Environment: {env}</span>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_HOST_{env}</label>
                                                <input type="text" style={S.input} value={sysConfig[`FORTI_HOST_${env}`] || ''} onChange={e => handleConfigChange(`FORTI_HOST_${env}`, e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_TOKEN_{env}</label>
                                                <input type="password" style={S.input} value={sysConfig[`FORTI_TOKEN_${env}`] || ''} onChange={e => handleConfigChange(`FORTI_TOKEN_${env}`, e.target.value)} />
                                            </div>
                                        </div>
                                        <div style={{ ...S.gridRow, marginTop: 12 }}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_SSH_USER_{env} <span style={{fontWeight: 'normal'}}>(Default: admin)</span></label>
                                                <input type="text" style={S.input} placeholder="admin" value={sysConfig[`FORTI_SSH_USER_${env}`] || ''} onChange={e => handleConfigChange(`FORTI_SSH_USER_${env}`, e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>FORTI_SSH_PWD_{env}</label>
                                                <input type="password" style={S.input} value={sysConfig[`FORTI_SSH_PWD_${env}`] || ''} onChange={e => handleConfigChange(`FORTI_SSH_PWD_${env}`, e.target.value)} />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeCategory === 'squid' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SQUID_ENVS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.SQUID_ENVS || ''} onChange={e => handleConfigChange('SQUID_ENVS', e.target.value)} />
                                </div>

                                {getEnvsArray(sysConfig.SQUID_ENVS).map(env => (
                                    <div key={env} style={S.hint}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', display: 'block', marginBottom: 8 }}>Environment: {env}</span>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>SQUID_SERVERS_{env} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated IPs)</span></label>
                                            <input type="text" style={S.input} value={sysConfig[`SQUID_SERVERS_${env}`] || ''} onChange={e => handleConfigChange(`SQUID_SERVERS_${env}`, e.target.value)} />
                                        </div>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>SQUID_{env}_USER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default: LINUX_ADMIN_USER)</span></label>
                                                <input type="text" style={S.input} placeholder={sysConfig.LINUX_ADMIN_USER || 'xyuser'} value={sysConfig[`SQUID_${env}_USER`] || ''} onChange={e => handleConfigChange(`SQUID_${env}_USER`, e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>SQUID_{env}_PWD <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Auto-Encrypted)</span></label>
                                                <input type="password" style={S.input} placeholder="Preset password (leave blank for manual input)" value={sysConfig[`SQUID_${env}_PWD`] || ''} onChange={e => handleConfigChange(`SQUID_${env}_PWD`, e.target.value)} />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeCategory === 'mail' && (
                            <>
                                <div style={S.card}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                                        <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '0.04em' }}>✉️ GLOBAL MAIL RELAY SETTINGS</span>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>(System Alerts & Notification Relay Only)</span>
                                    </div>

                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_RELAY_SERVER</label>
                                            <input type="text" style={S.input} value={sysConfig.MAIL_RELAY_SERVER || ''} onChange={e => handleConfigChange('MAIL_RELAY_SERVER', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_RELAY_ACCOUNT</label>
                                            <input type="text" style={S.input} value={sysConfig.MAIL_RELAY_ACCOUNT || ''} onChange={e => handleConfigChange('MAIL_RELAY_ACCOUNT', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={S.gridRow}>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_RELAY_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.MAIL_RELAY_PWD || ''} onChange={e => handleConfigChange('MAIL_RELAY_PWD', e.target.value)} />
                                        </div>
                                        <div style={S.fieldBlock}>
                                            <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_RELAY_SENDER</label>
                                            <input type="text" style={S.input} value={sysConfig.MAIL_RELAY_SENDER || ''} onChange={e => handleConfigChange('MAIL_RELAY_SENDER', e.target.value)} />
                                        </div>
                                    </div>
                                    <div style={{ ...S.fieldBlock, marginBottom: 0 }}>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_RELAY_RECIPIENT <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default alerts receiver)</span></label>
                                        <input type="text" style={S.input} value={sysConfig.MAIL_RELAY_RECIPIENT || ''} onChange={e => handleConfigChange('MAIL_RELAY_RECIPIENT', e.target.value)} />
                                    </div>
                                </div>

                                <div style={S.card}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                                        <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--accent-primary)', letterSpacing: '0.04em' }}>🌐 ENVIRONMENT MAIL SERVERS (MAIL_ENVS)</span>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>(Mail Node SSH Management & Operations)</span>
                                    </div>

                                    <div style={S.fieldBlock}>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_ENVS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated, e.g. UAT,PRD)</span></label>
                                        <input type="text" style={S.input} value={sysConfig.MAIL_ENVS || ''} onChange={e => handleConfigChange('MAIL_ENVS', e.target.value)} />
                                    </div>

                                    {getEnvsArray(sysConfig.MAIL_ENVS).map(env => (
                                        <div key={env} style={{ ...S.hint, marginTop: 12 }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', display: 'block', marginBottom: 8 }}>Environment: {env}</span>
                                            <div style={{ ...S.fieldBlock, marginBottom: 0 }}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_SERVERS_{env} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated IPs)</span></label>
                                                <input type="text" style={S.input} value={sysConfig[`MAIL_SERVERS_${env}`] || ''} onChange={e => handleConfigChange(`MAIL_SERVERS_${env}`, e.target.value)} />
                                            </div>
                                            <div style={S.gridRow}>
                                                <div>
                                                    <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_{env}_USER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default: LINUX_ADMIN_USER)</span></label>
                                                    <input type="text" style={S.input} placeholder={sysConfig.LINUX_ADMIN_USER || 'xyuser'} value={sysConfig[`MAIL_${env}_USER`] || ''} onChange={e => handleConfigChange(`MAIL_${env}_USER`, e.target.value)} />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>MAIL_{env}_PWD <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Auto-Encrypted)</span></label>
                                                    <input type="password" style={S.input} placeholder="Preset password (leave blank for manual input)" value={sysConfig[`MAIL_${env}_PWD`] || ''} onChange={e => handleConfigChange(`MAIL_${env}_PWD`, e.target.value)} />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {activeCategory === 'elk' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_ENVS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.ELK_ENVS || ''} onChange={e => handleConfigChange('ELK_ENVS', e.target.value)} />
                                </div>

                                {getEnvsArray(sysConfig.ELK_ENVS).map(env => (
                                    <div key={env} style={S.hint}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', display: 'block', marginBottom: 8 }}>Environment: {env}</span>
                                        <div style={S.gridRow}>
                                            <div style={{ flex: 2 }}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                    ELK_{env}_MASTER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(IP, Host, or https://host:9200)</span>
                                                </label>
                                                <input 
                                                    type="text" 
                                                    style={S.input} 
                                                    placeholder="198.51.100.10 or https://198.51.100.10:9200"
                                                    value={sysConfig[`ELK_${env}_MASTER`] || ''} 
                                                    onChange={e => handleConfigChange(`ELK_${env}_MASTER`, e.target.value)} 
                                                />
                                            </div>
                                            <div style={{ width: 120 }}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>PROTOCOL</label>
                                                <select
                                                    style={S.select}
                                                    value={sysConfig[`ELK_${env}_PROTO`] || (sysConfig[`ELK_${env}_MASTER`]?.startsWith('https') ? 'https' : 'http')}
                                                    onChange={e => handleConfigChange(`ELK_${env}_PROTO`, e.target.value)}
                                                >
                                                    <option value="http">HTTP (9200)</option>
                                                    <option value="https">HTTPS (9200)</option>
                                                </select>
                                            </div>
                                            <div style={{ width: 130 }}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                    ES VERSION <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>*</span>
                                                </label>
                                                <input 
                                                    type="text" 
                                                    style={S.input} 
                                                    placeholder="7.17 / 8.12 / 7.5"
                                                    value={sysConfig[`ELK_${env}_VERSION`] || ''} 
                                                    onChange={e => handleConfigChange(`ELK_${env}_VERSION`, e.target.value)} 
                                                />
                                            </div>
                                            <div style={{ flex: 2 }}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_{env}_NODES</label>
                                                <input 
                                                    type="text" 
                                                    style={S.input} 
                                                    placeholder="198.51.100.11,198.51.100.12"
                                                    value={sysConfig[`ELK_${env}_NODES`] || ''} 
                                                    onChange={e => handleConfigChange(`ELK_${env}_NODES`, e.target.value)} 
                                                />
                                            </div>
                                        </div>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_{env}_API_USER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(ES Cluster REST API User)</span></label>
                                                <input type="text" style={S.input} placeholder="elastic" value={sysConfig[`ELK_${env}_API_USER`] || sysConfig[`ELK_${env}_ACCOUNT`] || ''} onChange={e => { handleConfigChange(`ELK_${env}_API_USER`, e.target.value); handleConfigChange(`ELK_${env}_ACCOUNT`, e.target.value); }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_{env}_API_PWD <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Cluster API Password, Auto-Encrypted)</span></label>
                                                <input type="password" style={S.input} placeholder="Cluster API password" value={sysConfig[`ELK_${env}_API_PWD`] || ''} onChange={e => handleConfigChange(`ELK_${env}_API_PWD`, e.target.value)} />
                                            </div>
                                        </div>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_{env}_USER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Host SSH User, Default: LINUX_ADMIN_USER)</span></label>
                                                <input type="text" style={S.input} placeholder={sysConfig.LINUX_ADMIN_USER || 'xyuser'} value={sysConfig[`ELK_${env}_USER`] || ''} onChange={e => handleConfigChange(`ELK_${env}_USER`, e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>ELK_{env}_PWD <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Host SSH Password, Auto-Encrypted)</span></label>
                                                <input type="password" style={S.input} placeholder="Preset password (leave blank for manual input)" value={sysConfig[`ELK_${env}_PWD`] || ''} onChange={e => handleConfigChange(`ELK_${env}_PWD`, e.target.value)} />
                                            </div>
                                        </div>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>LS_{env}_NODES <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Optional)</span></label>
                                                <input type="text" style={S.input} value={sysConfig[`LS_${env}_NODES`] || ''} onChange={e => handleConfigChange(`LS_${env}_NODES`, e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>SYSNAS_LS_{env}_PATH <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Optional)</span></label>
                                                <input type="text" style={S.input} value={sysConfig[`SYSNAS_LS_${env}_PATH`] || ''} onChange={e => handleConfigChange(`SYSNAS_LS_${env}_PATH`, e.target.value)} />
                                            </div>
                                        </div>

                                        <div style={{
                                            marginTop: 14,
                                            padding: 14,
                                            borderRadius: 12,
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            border: '1px solid rgba(255, 255, 255, 0.08)'
                                        }}>
                                            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span>⏱️</span> {env} ILM Lifecycle Retention Settings (Days)
                                            </div>
                                            <div style={S.gridRow}>
                                                <div>
                                                    <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                        {env}_LIFECYCLE_SHORT <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Days, Default: 7)</span>
                                                    </label>
                                                    <input 
                                                        type="number" 
                                                        min="1" 
                                                        style={S.input} 
                                                        placeholder="7" 
                                                        value={sysConfig[`${env}_LIFECYCLE_SHORT`] || sysConfig[`ELK_${env}_LIFECYCLE_SHORT`] || ''} 
                                                        onChange={e => handleConfigChange(`${env}_LIFECYCLE_SHORT`, e.target.value)} 
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                        {env}_LIFECYCLE_MEDIUM <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Days, Default: 60)</span>
                                                    </label>
                                                    <input 
                                                        type="number" 
                                                        min="1" 
                                                        style={S.input} 
                                                        placeholder="60" 
                                                        value={sysConfig[`${env}_LIFECYCLE_MEDIUM`] || sysConfig[`ELK_${env}_LIFECYCLE_MEDIUM`] || ''} 
                                                        onChange={e => handleConfigChange(`${env}_LIFECYCLE_MEDIUM`, e.target.value)} 
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                        {env}_LIFECYCLE_LONG <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Days, Default: 365)</span>
                                                    </label>
                                                    <input 
                                                        type="number" 
                                                        min="1" 
                                                        style={S.input} 
                                                        placeholder="365" 
                                                        value={sysConfig[`${env}_LIFECYCLE_LONG`] || sysConfig[`ELK_${env}_LIFECYCLE_LONG`] || ''} 
                                                        onChange={e => handleConfigChange(`${env}_LIFECYCLE_LONG`, e.target.value)} 
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeCategory === 'nutanix' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_MODE</label>
                                    <select 
                                        style={S.select}
                                        value={sysConfig.NUTANIX_MODE || 'PC'}
                                        onChange={e => handleConfigChange('NUTANIX_MODE', e.target.value)}
                                    >
                                        <option value="PC">Prism Central (PC) Mode</option>
                                        <option value="PE">Prism Element (PE) Mode</option>
                                    </select>
                                </div>

                                {(sysConfig.NUTANIX_MODE || 'PC') !== 'PE' && (
                                    <div style={{ borderTop: '1px solid var(--border-color)', margin: '16px 0', paddingTop: 16 }}>
                                        <span style={{ fontSize: 12, fontWeight: 900, color: 'var(--accent-primary)', display: 'block', marginBottom: 12 }}>--- Prism Central (PC) Settings ---</span>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PC_IP</label>
                                                <input type="text" style={S.input} value={sysConfig.NUTANIX_PC_IP || ''} onChange={e => handleConfigChange('NUTANIX_PC_IP', e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PC_ACCOUNT</label>
                                                <input type="text" style={S.input} value={sysConfig.NUTANIX_PC_ACCOUNT || ''} onChange={e => handleConfigChange('NUTANIX_PC_ACCOUNT', e.target.value)} />
                                            </div>
                                        </div>
                                        <div style={{ ...S.fieldBlock, marginTop: 12 }}>
                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PC_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.NUTANIX_PC_PWD || ''} onChange={e => handleConfigChange('NUTANIX_PC_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                )}

                                {sysConfig.NUTANIX_MODE === 'PE' && (
                                    <div style={{ borderTop: '1px solid var(--border-color)', margin: '16px 0', paddingTop: 16 }}>
                                        <span style={{ fontSize: 12, fontWeight: 900, color: 'var(--accent-primary)', display: 'block', marginBottom: 12 }}>--- Prism Element (PE) Settings ---</span>
                                        <div style={S.gridRow}>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PE_IP <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma-separated)</span></label>
                                                <input type="text" style={S.input} value={sysConfig.NUTANIX_PE_IP || ''} onChange={e => handleConfigChange('NUTANIX_PE_IP', e.target.value)} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PE_ACCOUNT</label>
                                                <input type="text" style={S.input} value={sysConfig.NUTANIX_PE_ACCOUNT || ''} onChange={e => handleConfigChange('NUTANIX_PE_ACCOUNT', e.target.value)} />
                                            </div>
                                        </div>
                                        <div style={{ ...S.fieldBlock, marginTop: 12 }}>
                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>NUTANIX_PE_PWD</label>
                                            <input type="password" style={S.input} value={sysConfig.NUTANIX_PE_PWD || ''} onChange={e => handleConfigChange('NUTANIX_PE_PWD', e.target.value)} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}


                        {activeCategory === 'provision' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>REMOTE_INSTALL_BUS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.REMOTE_INSTALL_BUS || ''} onChange={e => handleConfigChange('REMOTE_INSTALL_BUS', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SYSNAS_SOFTWARE_PATH</label>
                                    <input type="text" style={S.input} value={sysConfig.SYSNAS_SOFTWARE_PATH || ''} onChange={e => handleConfigChange('SYSNAS_SOFTWARE_PATH', e.target.value)} />
                                </div>
                                <div style={{ ...S.fieldBlock, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROVISION_HOST_CONCURRENCY <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(1-10, default 4)</span></label>
                                        <input type="number" min="1" max="10" step="1" placeholder="4" style={S.input} value={sysConfig.PROVISION_HOST_CONCURRENCY || ''} onChange={e => handleConfigChange('PROVISION_HOST_CONCURRENCY', e.target.value)} />
                                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Hosts provisioned in parallel (all jobs together).</span>
                                    </div>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROVISION_HISTORY_RETENTION_DAYS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(30-730, default 180)</span></label>
                                        <input type="number" min="30" max="730" step="1" placeholder="180" style={S.input} value={sysConfig.PROVISION_HISTORY_RETENTION_DAYS || ''} onChange={e => handleConfigChange('PROVISION_HISTORY_RETENTION_DAYS', e.target.value)} />
                                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Finished jobs older than this are deleted daily.</span>
                                    </div>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>PROVISION_MIN_FREE_GB <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(1-500, default 5)</span></label>
                                        <input type="number" min="1" max="500" step="1" placeholder="5" style={S.input} value={sysConfig.PROVISION_MIN_FREE_GB || ''} onChange={e => handleConfigChange('PROVISION_MIN_FREE_GB', e.target.value)} />
                                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Free space required on drive X: (pre-check). Changes apply without a restart.</span>
                                    </div>
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>REMOTE_INSTALL_SOFTWARE_MASTER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Windows: Name|NAS_Path|Args - One entry per line. A UNC path such as \\nas01\soft is only allowed at the start of the Path field. Known limitation: a hand-edited single-line value with a \n path part is ambiguous; saving through this screen makes it unambiguous. Optional: append |@detect:reg:DisplayName*[&gt;=1.2.3] or |@detect:file:C:\path\app.exe to skip when installed)</span></label>
                                    <textarea style={S.textarea} rows="4" value={sysConfig.REMOTE_INSTALL_SOFTWARE_MASTER || ''} onChange={e => handleConfigChange('REMOTE_INSTALL_SOFTWARE_MASTER', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>REMOTE_INSTALL_LINUX_SOFTWARE_MASTER <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Linux: Name|Command - One entry per line; a command must not contain a backslash-n sequence. Optional: append |@detect:rpm:pkg, |@detect:dpkg:pkg or |@detect:cmd:command to skip when installed)</span></label>
                                    <textarea style={S.textarea} rows="4" value={sysConfig.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER || ''} onChange={e => handleConfigChange('REMOTE_INSTALL_LINUX_SOFTWARE_MASTER', e.target.value)} />
                                </div>

                                {getEnvsArray(sysConfig.REMOTE_INSTALL_BUS).map(env => {
                                    const buSafe = env.replace(/-/g, '_');
                                    const winKey = `REMOTE_INSTALL_SOFTWARE_${buSafe}`;
                                    const winSelected = (sysConfig[winKey] || '').split(',').map(s => s.trim()).filter(s => s);

                                    const linuxKey = `REMOTE_INSTALL_LINUX_SOFTWARE_${buSafe}`;
                                    const linuxSelected = (sysConfig[linuxKey] || '').split(',').map(s => s.trim()).filter(s => s);

                                    const winItems = getSoftwareItems(sysConfig.REMOTE_INSTALL_SOFTWARE_MASTER);
                                    const linuxItems = getSoftwareItems(sysConfig.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER, 'linux');

                                    return (
                                        <div key={env} style={S.hint}>
                                            <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--accent-primary)', display: 'block', marginBottom: 12 }}>Business Unit (BU): {env}</span>
                                            
                                            <div style={{ marginBottom: 16 }}>
                                                <strong style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Windows Software Package Mapping:</strong>
                                                {winItems.length > 0 ? (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                                                        {winItems.map(sw => {
                                                            const isChecked = winSelected.includes(sw);
                                                            return (
                                                                <label key={sw} style={{ fontWeight: 'normal', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                                                                    <input 
                                                                        type="checkbox" 
                                                                        checked={isChecked} 
                                                                        onChange={e => handleCheckboxArrayChange(winKey, sw, e.target.checked)} 
                                                                        style={{ width: 14, height: 14, cursor: 'pointer' }} 
                                                                    />
                                                                    {sw}
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    <em style={{ fontSize: 11, color: 'var(--text-muted)' }}>No Windows software defined in master list</em>
                                                )}
                                            </div>

                                            <div>
                                                <strong style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Linux Commands / Packages Mapping:</strong>
                                                {linuxItems.length > 0 ? (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                                                        {linuxItems.map(sw => {
                                                            const isChecked = linuxSelected.includes(sw);
                                                            return (
                                                                <label key={sw} style={{ fontWeight: 'normal', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                                                                    <input 
                                                                        type="checkbox" 
                                                                        checked={isChecked} 
                                                                        onChange={e => handleCheckboxArrayChange(linuxKey, sw, e.target.checked)} 
                                                                        style={{ width: 14, height: 14, cursor: 'pointer' }} 
                                                                    />
                                                                    {sw}
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    <em style={{ fontSize: 11, color: 'var(--text-muted)' }}>No Linux software defined in master list</em>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {activeCategory === FILE_SERVICES_CATEGORY && (
                            <FileServicesSettings
                                S={S}
                                tab={fileServicesTab}
                                onTabChange={setFileServicesTab}
                                sysConfig={sysConfig}
                                onConfigChange={handleConfigChange}
                                sftp={{
                                    servers: sftpServers,
                                    testing: sftpServerTesting,
                                    testResult: sftpServerTestResult,
                                    onAdd: handleOpenAddSftpServer,
                                    onEdit: handleOpenEditSftpServer,
                                    onDelete: handleDeleteSftpServer,
                                    onToggle: handleToggleSftpServerEnabled,
                                    onTest: handleTestSingleSftpServer
                                }}
                            />
                        )}

                        {activeCategory === 'netsearch' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>NETSEARCH_BACKUP_ROOT <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(e.g. /home/oxidized/backups)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.NETSEARCH_BACKUP_ROOT || ''} onChange={e => handleConfigChange('NETSEARCH_BACKUP_ROOT', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>NETSEARCH_FQDN_FILE <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(e.g. /home/oxidized/backups/all_fqdn.csv)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.NETSEARCH_FQDN_FILE || ''} onChange={e => handleConfigChange('NETSEARCH_FQDN_FILE', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>NETSEARCH_CRON_SCHEDULE <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma-separated cron expressions, leave blank to disable)</span></label>
                                    <input 
                                        type="text" 
                                        style={S.input} 
                                        value={sysConfig.NETSEARCH_CRON_SCHEDULE !== undefined ? sysConfig.NETSEARCH_CRON_SCHEDULE : ''} 
                                        onChange={e => handleConfigChange('NETSEARCH_CRON_SCHEDULE', e.target.value)} 
                                        placeholder="0 5 * * *,0 17 * * *" 
                                    />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>NETSEARCH_DEVICES <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Format: Name|Type - e.g. FRI-FW01|paloalto - One per line)</span></label>
                                    <textarea 
                                        style={S.textarea} 
                                        rows="8" 
                                        value={devicesText} 
                                        onChange={e => handleDevicesTextChange(e.target.value)} 
                                        placeholder="FRI-FW01|paloalto&#10;FRI-LTM01|f5&#10;GICT-FW01|fortigate"
                                    />
                                </div>
                            </div>
                        )}

                        {activeCategory === 'ad' && (
                            <div style={S.card}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AD_OU_SEARCH</label>
                                    <input type="text" style={S.input} value={sysConfig.AD_OU_SEARCH || ''} onChange={e => handleConfigChange('AD_OU_SEARCH', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AD_COMPANIES <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.AD_COMPANIES || ''} onChange={e => handleConfigChange('AD_COMPANIES', e.target.value)} />
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AD_GRANT_COMPANIES <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(comma separated permissions)</span></label>
                                    <input type="text" style={S.input} value={sysConfig.AD_GRANT_COMPANIES || ''} onChange={e => handleConfigChange('AD_GRANT_COMPANIES', e.target.value)} />
                                </div>

                                {getEnvsArray(sysConfig.AD_COMPANIES).map(comp => {
                                    const busKey = `AD_BUS_${comp}`;
                                    const busValue = sysConfig[busKey] || '';
                                    return (
                                        <div key={comp} style={S.hint}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', display: 'block', marginBottom: 8 }}>Company: {comp}</span>
                                            <div style={S.fieldBlock}>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>{busKey} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(business name, e.g. IT,HR)</span></label>
                                                <input type="text" style={S.input} value={busValue} onChange={e => handleConfigChange(busKey, e.target.value)} />
                                            </div>
                                            
                                            <div style={{ marginLeft: 24, marginTop: 12, borderLeft: '2px dashed var(--border-color)', paddingLeft: 16 }}>
                                                {getEnvsArray(busValue).map(bu => {
                                                    const buSafe = bu.replace(/-/g, '_');
                                                    const ouKey = `AD_OU_${comp}_${buSafe}`;
                                                    return (
                                                        <div key={bu} style={{ marginBottom: 12 }}>
                                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>{ouKey}</label>
                                                            <input type="text" style={S.input} value={sysConfig[ouKey] || ''} onChange={e => handleConfigChange(ouKey, e.target.value)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {activeCategory === 'rbac' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                {/* Role Assignments Card */}
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>👥 Role Assignments</h3>
                                        {selectedAccounts.length > 0 && (
                                            <button 
                                                style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '4px 10px', fontSize: 11 }}
                                                onClick={handleBulkDeleteAccounts}
                                            >
                                                🗑️ Delete Selected ({selectedAccounts.length})
                                            </button>
                                        )}
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
                                        By default, all authenticated AD users receive the <b>{rbacData.defaultRole}</b> role. Add overrides below.
                                    </div>

                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead>
                                                <tr>
                                                    <th style={{ ...S.th, width: 40, textAlign: 'center' }}>
                                                        <input 
                                                            type="checkbox" 
                                                            style={{ cursor: 'pointer' }}
                                                            checked={Object.keys(rbacData.users || {}).length > 0 && selectedAccounts.length === Object.keys(rbacData.users || {}).length}
                                                            onChange={(e) => {
                                                                if (e.target.checked) {
                                                                    setSelectedAccounts(Object.keys(rbacData.users));
                                                                } else {
                                                                    setSelectedAccounts([]);
                                                                }
                                                            }}
                                                        />
                                                    </th>
                                                    <th style={S.th}>USER / GROUP ACCOUNT</th>
                                                    <th style={S.th}>ASSIGNED ROLE</th>
                                                    <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {Object.entries(rbacData.users).map(([account, data]) => {
                                                    const [username, domain] = account.split('@');
                                                    const role = typeof data === 'string' ? data : data.role;
                                                    const groupName = typeof data === 'string' ? null : data.groupName;
                                                    const isGroup = !!groupName;
                                                    const displayAccount = isGroup ? username : account;
                                                    const isChecked = selectedAccounts.includes(account);
                                                    return (
                                                        <tr key={account} style={S.tr}>
                                                            <td style={{ ...S.td, textAlign: 'center' }}>
                                                                <input 
                                                                    type="checkbox" 
                                                                    style={{ cursor: 'pointer' }}
                                                                    checked={isChecked}
                                                                    onChange={(e) => {
                                                                        if (e.target.checked) setSelectedAccounts(prev => [...prev, account]);
                                                                        else setSelectedAccounts(prev => prev.filter(a => a !== account));
                                                                    }}
                                                                />
                                                            </td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 800 }}>
                                                                {displayAccount}
                                                                {isGroup && <span style={{ marginLeft: 8, padding: '2px 6px', background: 'rgba(255,255,255,0.1)', borderRadius: 4, fontSize: 10, color: 'var(--text-muted)' }}>{groupName}</span>}
                                                            </td>
                                                            <td style={S.td}>
                                                                <select 
                                                                    style={{ ...S.select, marginTop: 0, padding: '6px 12px' }}
                                                                    value={role}
                                                                    onChange={(e) => handleUpdateRole(username, domain, e.target.value, groupName)}
                                                                >
                                                                    {rbacData.roles.map(r => <option key={r} value={r}>{r}</option>)}
                                                                </select>
                                                            </td>
                                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                                <button 
                                                                    style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '6px 12px', fontSize: 11 }}
                                                                    onClick={() => setDeleteConfirmUser({ username, domain })}
                                                                >
                                                                    Remove
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                                {Object.keys(rbacData.users).length === 0 && (
                                                    <tr><td colSpan="4" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)' }}>No custom role assignments found.</td></tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    <h4 style={{ fontSize: 13, fontWeight: 900, marginBottom: 12, color: 'var(--accent-primary)', textTransform: 'uppercase' }}>➕ Add Custom Role Override</h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        <div>
                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>SELECT AD MAPPING (OU / GROUP)</label>
                                            <select 
                                                style={S.select}
                                                value={selectedGroup}
                                                onChange={(e) => handleGroupChange(e.target.value)}
                                            >
                                                <option value="">-- Choose an AD Mapping (OU / Group) --</option>
                                                {listAssignableMappings(groups)
                                                    .map(([gName, gData]) => (
                                                        <option key={gName} value={gName}>
                                                            {gName} ({gData.type === 'group' ? '👥 Group' : '🏢 OU'})
                                                        </option>
                                                    ))}
                                            </select>
                                        </div>
                                        
                                        {selectedGroup && (
                                            <form onSubmit={handleAddUser} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                                                <div style={{ flex: 1 }}>
                                                    <input 
                                                        type="text" 
                                                        style={S.input}
                                                        placeholder={loadingAdUsers ? "Loading users from AD..." : "Select account or leave empty to add entire group..."} 
                                                        list="ad-users-list"
                                                        value={newUser.username}
                                                        onChange={(e) => setNewUser({...newUser, username: e.target.value})}
                                                        disabled={loadingAdUsers}
                                                    />
                                                    <datalist id="ad-users-list">
                                                        {adUsers.filter(u => !Object.keys(rbacData.users || {}).some(acc => acc.split('@')[0] === u)).map(u => <option key={u} value={u} />)}
                                                    </datalist>
                                                </div>
                                                <div style={{ width: 140 }}>
                                                    <select 
                                                        style={S.select}
                                                        value={newUser.role}
                                                        onChange={(e) => setNewUser({...newUser, role: e.target.value})}
                                                    >
                                                        {rbacData.roles.map(r => <option key={r} value={r}>{r}</option>)}
                                                    </select>
                                                </div>
                                                <button type="submit" style={S.btnP} disabled={loadingAdUsers}>Add</button>
                                            </form>
                                        )}
                                    </div>
                                </div>

                                {/* AD Mappings Panel */}
                                <div style={S.card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                                        <h3 style={{ ...S.tblTitle, margin: 0 }}>🔗 AD Mappings</h3>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Supported Types: 🏢 OU, 👥 Group, 👤 Account</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
                                        Define mappings linked to Active Directory OUs or Security Groups to discover members and assign roles, or add single accounts directly.
                                    </div>

                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead>
                                                <tr>
                                                    <th style={{ ...S.th, width: 60 }}>STATE</th>
                                                    <th style={S.th}>MAPPING NAME</th>
                                                    <th style={S.th}>TYPE</th>
                                                    <th style={S.th}>MAPPED TARGET</th>
                                                    <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {listMappings(groups)
                                                    .map(([name, gData]) => {
                                                        const isEditing = editingGroup === name;
                                                        const isGroupType = gData.type === 'group';
                                                        const isBuiltin = isBuiltinMapping(name, gData);
                                                        const actions = mappingActions(name, gData);
                                                        if (isBuiltin) {
                                                            return (
                                                                <React.Fragment key={name}>
                                                                    <tr style={S.tr}>
                                                                        <td style={S.td}>
                                                                            <input
                                                                                type="checkbox"
                                                                                checked
                                                                                disabled
                                                                                title="The built-in mapping is always enabled"
                                                                                style={{ width: 16, height: 16, cursor: 'not-allowed' }}
                                                                            />
                                                                        </td>
                                                                        <td style={{ ...S.td, fontWeight: 800 }}>
                                                                            {name}{' '}
                                                                            <span style={{ ...S.badge, marginLeft: 6, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.4)' }}>Built-in</span>
                                                                        </td>
                                                                        <td style={S.td}>
                                                                            <span style={{ ...S.badge, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.4)' }}>🛡️ Role</span>
                                                                        </td>
                                                                        <td style={{ ...S.td, fontSize: 11, color: 'var(--text-muted)' }}>
                                                                            {BUILTIN_NOTE}
                                                                        </td>
                                                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                                                            <button
                                                                                style={{ ...S.btnO, padding: '6px 12px', fontSize: 11, background: isEditing ? 'var(--accent-primary)' : 'transparent', color: isEditing ? '#fff' : 'var(--text-secondary)' }}
                                                                                onClick={() => setEditingGroup(isEditing ? null : name)}
                                                                            >
                                                                                Edit
                                                                            </button>
                                                                        </td>
                                                                    </tr>
                                                                    {isEditing && (
                                                                        <tr>
                                                                            <td colSpan="5" style={{ padding: 24, background: 'rgba(255,255,255,0.02)' }}>
                                                                                <h5 style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>
                                                                                    Configure SuperAdmin Features
                                                                                </h5>
                                                                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>{BUILTIN_NOTE}</div>
                                                                                <GroupFeatureEditor
                                                                                    groupName={name}
                                                                                    isBuiltin
                                                                                    initialFeatures={gData.features || {}}
                                                                                    initialAuditLogs={{}}
                                                                                    onSave={(feats, audits) => handleSaveGroupFeatures(name, feats, audits)}
                                                                                    onCancel={() => setEditingGroup(null)}
                                                                                />
                                                                            </td>
                                                                        </tr>
                                                                    )}
                                                                </React.Fragment>
                                                            );
                                                        }
                                                        return (
                                                            <React.Fragment key={name}>
                                                                <tr style={S.tr}>
                                                                    <td style={S.td}>
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={gData.enabled !== false}
                                                                            disabled={!actions.canToggle}
                                                                            onChange={() => handleToggleGroupEnabled(name, gData.enabled !== false)}
                                                                            style={{ cursor: 'pointer', width: 16, height: 16 }}
                                                                        />
                                                                    </td>
                                                                    <td style={{ ...S.td, fontWeight: 800 }}>{name}</td>
                                                                    <td style={S.td}>
                                                                        <span style={{
                                                                            ...S.badge, 
                                                                            background: isGroupType ? 'rgba(139,92,246,0.15)' : 'rgba(56,189,248,0.15)',
                                                                            color: isGroupType ? '#c084fc' : '#38bdf8',
                                                                            border: isGroupType ? '1px solid rgba(139,92,246,0.4)' : '1px solid rgba(56,189,248,0.4)'
                                                                        }}>
                                                                            {isGroupType ? '👥 AD Group' : '🏢 AD OU'}
                                                                        </span>
                                                                    </td>
                                                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>
                                                                        {gData.target || gData.adOu}
                                                                    </td>
                                                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                                                        <div style={{ display: 'inline-flex', gap: 6 }}>
                                                                            <button 
                                                                                style={{ ...S.btnO, padding: '6px 12px', fontSize: 11, background: isEditing ? 'var(--accent-primary)' : 'transparent', color: isEditing ? '#fff' : 'var(--text-secondary)' }}
                                                                                onClick={() => setEditingGroup(isEditing ? null : name)}
                                                                            >
                                                                                Configure
                                                                            </button>
                                                                            {actions.canDelete && (
                                                                                <button
                                                                                    style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '6px 12px', fontSize: 11 }}
                                                                                    onClick={() => setDeleteConfirmGroup(name)}
                                                                                >
                                                                                    Delete
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                </tr>
                                                                {isEditing && (
                                                                    <tr>
                                                                        <td colSpan="5" style={{ padding: 24, background: 'rgba(255,255,255,0.02)' }}>
                                                                            <h5 style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 16, textTransform: 'uppercase' }}>
                                                                                Configure Features & Audits for {name}
                                                                            </h5>
                                                                            <GroupFeatureEditor 
                                                                                groupName={name}
                                                                                initialFeatures={gData.features || {}}
                                                                                initialAuditLogs={gData.auditLogs || {}}
                                                                                onSave={(feats, audits) => handleSaveGroupFeatures(name, feats, audits)}
                                                                                onCancel={() => setEditingGroup(null)}
                                                                            />
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </React.Fragment>
                                                        );
                                                    })}
                                                {listMappings(groups).length === 0 && (
                                                    <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)' }}>No AD OU or Group mappings configured.</td></tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    <h4 style={{ fontSize: 13, fontWeight: 900, marginBottom: 12, color: 'var(--accent-primary)', textTransform: 'uppercase' }}>➕ Define AD Mapping</h4>
                                    
                                    {/* 3 Mapping Types Selector */}
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
                                        {[
                                            { id: 'ou', label: '🏢 1. Specific OU', desc: 'Search AD Organizational Unit' },
                                            { id: 'group', label: '👥 2. Specific Group', desc: 'Discover AD Security Group members' },
                                            { id: 'account', label: '👤 3. Specific Account', desc: 'Add account directly (Default None)' }
                                        ].map(t => (
                                            <button
                                                key={t.id}
                                                type="button"
                                                style={{
                                                    padding: '12px 14px',
                                                    borderRadius: 12,
                                                    border: newGroup.type === t.id ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                                    background: newGroup.type === t.id ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.02)',
                                                    color: newGroup.type === t.id ? '#fff' : 'var(--text-secondary)',
                                                    cursor: 'pointer',
                                                    textAlign: 'left',
                                                    transition: 'all 0.2s'
                                                }}
                                                onClick={() => setNewGroup({ ...newGroup, type: t.id })}
                                            >
                                                <div style={{ fontWeight: 900, fontSize: 13, color: newGroup.type === t.id ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{t.label}</div>
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t.desc}</div>
                                            </button>
                                        ))}
                                    </div>

                                    <form onSubmit={handleAddGroup} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        {newGroup.type !== 'account' && (
                                            <div>
                                                <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>MAPPING / GROUP NAME *</label>
                                                <input 
                                                    type="text" 
                                                    style={S.input}
                                                    placeholder={newGroup.type === 'ou' ? "e.g. IT Team, HR Department" : "e.g. IT Admins, DevOps Engineers"} 
                                                    value={newGroup.name}
                                                    onChange={(e) => setNewGroup({...newGroup, name: e.target.value})}
                                                    required={newGroup.type !== 'account'}
                                                />
                                            </div>
                                        )}

                                        <div>
                                            <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                {newGroup.type === 'ou' && 'AD OU DISTINGUISHED NAME (SEARCHBASE) *'}
                                                {newGroup.type === 'group' && 'AD SECURITY GROUP NAME OR DISTINGUISHED NAME *'}
                                                {newGroup.type === 'account' && 'AD ACCOUNT DISTINGUISHED NAME OR USERNAME *'}
                                            </label>
                                            <input 
                                                type="text" 
                                                style={S.input}
                                                placeholder={
                                                    newGroup.type === 'ou' ? "e.g. OU=Users,OU=IT,DC=sso,DC=trz" :
                                                    newGroup.type === 'group' ? "e.g. Domain Admins, IT_Security, or CN=IT_Security,OU=Groups,DC=sso,DC=trz" :
                                                    "e.g. CN=ait80192,OU=TA,OU=Privilege Accounts,OU=TWDC,DC=sso,DC=ait"
                                                } 
                                                value={newGroup.target}
                                                onChange={(e) => setNewGroup({...newGroup, target: e.target.value})}
                                                required 
                                            />
                                        </div>

                                        {newGroup.type === 'account' && (
                                            <div style={{ padding: '10px 14px', background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: 10, fontSize: 12, color: '#38bdf8', lineHeight: 1.5 }}>
                                                💡 <b>Note</b>: This account will be directly registered in <b>Role Assignments</b> above with a default <b>None</b> role (no access). Administrators can adjust its role anytime in the table above.
                                            </div>
                                        )}

                                        <button type="submit" style={{ ...S.btnP, width: '100%', marginTop: 6 }}>
                                            {newGroup.type === 'account' ? '➕ Add Account with None Role' : '➕ Create AD Mapping'}
                                        </button>
                                    </form>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Add/Edit Webhook Modal */}
            {isEditingWebhook && (
                <div style={S.overlay} onClick={() => setIsEditingWebhook(false)}>
                    <div style={{ ...S.modal, maxWidth: 600 }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 16 }}>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>{webhookForm.id ? '✏️ Edit Webhook Configuration' : '🔌 Add Webhook Target'}</h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }} onClick={() => setIsEditingWebhook(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSaveWebhook} style={{ textAlign: 'left', maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
                            <div style={S.fieldBlock}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>WEBHOOK NAME *</label>
                                <input type="text" style={S.input} required value={webhookForm.name} onChange={e => setWebhookForm({ ...webhookForm, name: e.target.value })} placeholder="e.g. Teams DevOps Alert" />
                            </div>
                            <div style={S.fieldBlock}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>TARGET URL *</label>
                                <input type="text" style={S.input} required value={webhookForm.url} onChange={e => setWebhookForm({ ...webhookForm, url: e.target.value })} placeholder="https://outlook.office.com/webhook/..." />
                            </div>
                            <div style={S.gridRow}>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>HTTP METHOD *</label>
                                    <select style={S.select} value={webhookForm.method} onChange={e => setWebhookForm({ ...webhookForm, method: e.target.value })}>
                                        <option value="POST">POST</option>
                                        <option value="PUT">PUT</option>
                                        <option value="GET">GET</option>
                                    </select>
                                </div>
                                <div style={S.fieldBlock}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>STATE</label>
                                    <select style={S.select} value={webhookForm.enabled ? 'true' : 'false'} onChange={e => setWebhookForm({ ...webhookForm, enabled: e.target.value === 'true' })}>
                                        <option value="true">Enabled</option>
                                        <option value="false">Disabled</option>
                                    </select>
                                </div>
                            </div>
                            <div style={S.fieldBlock}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>HTTP HEADERS (JSON FORMAT)</label>
                                <textarea style={S.textarea} rows="4" value={webhookForm.headers} onChange={e => setWebhookForm({ ...webhookForm, headers: e.target.value })} placeholder='{"Content-Type": "application/json"}' />
                            </div>
                            <div style={S.fieldBlock}>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>BODY TEMPLATE <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Use placeholders: {"{{message}}"}, {"{{module}}"}, {"{{timestamp}}"})</span></label>
                                <textarea style={S.textarea} rows="5" value={webhookForm.bodyTemplate} onChange={e => setWebhookForm({ ...webhookForm, bodyTemplate: e.target.value })} placeholder='{"text": "{{message}}"}' />
                            </div>
                            <div style={S.fieldBlock}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        EVENT LOG TYPES (此 Webhook 接收之日誌種類)
                                    </label>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button 
                                            type="button" 
                                            style={{ ...S.btnO, padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer' }}
                                            onClick={() => setWebhookForm({ ...webhookForm, enabledLogs: ALL_LOG_TYPE_KEYS })}
                                        >
                                            Select All
                                        </button>
                                        <button 
                                            type="button" 
                                            style={{ ...S.btnO, padding: '2px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer' }}
                                            onClick={() => setWebhookForm({ ...webhookForm, enabledLogs: [] })}
                                        >
                                            Clear All
                                        </button>
                                    </div>
                                </div>
                                <div 
                                    style={{ ...S.input, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
                                    onClick={() => setIsWebhookLogsExpanded(!isWebhookLogsExpanded)}
                                >
                                    <span style={{ color: 'var(--text-color)' }}>
                                        {(() => {
                                            const logs = Array.isArray(webhookForm.enabledLogs) ? webhookForm.enabledLogs : DEFAULT_LOG_TYPE_KEYS;
                                            if (logs.length === 0) return 'No log types enabled (Webhook muted)';
                                            if (logs.length === ALL_LOG_TYPE_KEYS.length) return `All ${logs.length} log types enabled`;
                                            return `${logs.length} / ${ALL_LOG_TYPE_KEYS.length} log types enabled`;
                                        })()}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isWebhookLogsExpanded ? '▼' : '▶'}</span>
                                </div>
                                {isWebhookLogsExpanded && (
                                    <div style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-color)', animation: 'fadeIn 0.2s ease-out' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                            <thead>
                                                <tr style={{ background: 'rgba(255,255,255,0.05)', borderBottom: '1px solid var(--border-color)' }}>
                                                    <th style={{ width: 60, padding: '8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600 }}>Enabled</th>
                                                    <th style={{ padding: '8px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600 }}>Log Category</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                            {LOG_TYPE_DEFINITIONS.map((item, idx, arr) => {
                                                const logs = Array.isArray(webhookForm.enabledLogs) ? webhookForm.enabledLogs : DEFAULT_LOG_TYPE_KEYS;
                                                const isChecked = logs.includes(item.id);
                                                return (
                                                    <tr 
                                                        key={item.id} 
                                                        style={{ 
                                                            borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)', 
                                                            background: isChecked ? 'rgba(0,123,255,0.05)' : 'transparent', 
                                                            transition: 'background 0.2s',
                                                            cursor: 'pointer'
                                                        }}
                                                        onClick={() => {
                                                            let newLogs = [...logs];
                                                            if (!isChecked) {
                                                                if (!newLogs.includes(item.id)) newLogs.push(item.id);
                                                            } else {
                                                                newLogs = newLogs.filter(t => t !== item.id);
                                                            }
                                                            setWebhookForm({ ...webhookForm, enabledLogs: newLogs });
                                                        }}
                                                    >
                                                        <td style={{ textAlign: 'center', padding: '8px' }}>
                                                            <input 
                                                                type="checkbox" 
                                                                checked={isChecked} 
                                                                onChange={e => {
                                                                    e.stopPropagation();
                                                                    let newLogs = [...logs];
                                                                    if (e.target.checked) {
                                                                        if (!newLogs.includes(item.id)) newLogs.push(item.id);
                                                                    } else {
                                                                        newLogs = newLogs.filter(t => t !== item.id);
                                                                    }
                                                                    setWebhookForm({ ...webhookForm, enabledLogs: newLogs });
                                                                }} 
                                                                style={{ cursor: 'pointer', transform: 'scale(1.1)' }} 
                                                            />
                                                        </td>
                                                        <td style={{ padding: '8px', userSelect: 'none' }}>
                                                            <div style={{ fontSize: 12, fontWeight: 700, color: isChecked ? 'var(--text-color)' : 'var(--text-muted)' }}>
                                                                {item.label}
                                                            </div>
                                                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                                                                {item.desc}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                                <button type="button" style={{ ...S.btnO, flex: 1 }} onClick={() => setIsEditingWebhook(false)}>Cancel</button>
                                <button type="submit" style={{ ...S.btnP, flex: 1 }}>Save webhook</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Webhook Delete Confirm Modal */}
            {deletingWebhook && (
                <div style={S.overlay} onClick={() => setDeletingWebhook(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>Confirm Delete</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0' }}>
                            Are you sure you want to delete the webhook target <strong>{deletingWebhook.name}</strong>? This action cannot be undone.
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" style={{ ...S.btnO, flex: 1 }} onClick={() => setDeletingWebhook(null)}>
                                Cancel
                            </button>
                            <button type="button" style={{ ...S.btnP, background: 'var(--danger)', boxShadow: 'none', flex: 1 }} onClick={handleDeleteWebhook}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}



            {/* Open API Documentation Modal */}
            {showDocModal && (
                <div style={S.overlay} onClick={() => setShowDocModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 750, maxHeight: '85vh', display: 'flex', flexDirection: 'column', textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 16 }}>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>📖 Scout Open API Quick Reference</h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }} onClick={() => setShowDocModal(false)}>✕</button>
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 8, fontSize: 13, lineHeight: 1.6 }}>
                            <h4 style={{ color: 'var(--accent-primary)', margin: '0 0 8px 0' }}>1. Authentication</h4>
                            <p style={{ color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                                Add the HTTP header <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>Authorization: Bearer &lt;YOUR_API_KEY&gt;</code> or <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>X-API-Key: &lt;YOUR_API_KEY&gt;</code> to every request.
                            </p>

                            <h4 style={{ color: 'var(--accent-primary)', margin: '16px 0 8px 0' }}>2. Available Endpoints</h4>
                            <table style={{ ...S.tbl, fontSize: 12, marginBottom: 16 }}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>METHOD</th>
                                        <th style={S.th}>ENDPOINT</th>
                                        <th style={S.th}>DESCRIPTION</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/hosts</code></td><td style={S.td}>List all monitored hosts and status</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/metrics/realtime</code></td><td style={S.td}>Latest real-time CPU/RAM/Disk metrics</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/metrics/history</code></td><td style={S.td}>Historical metrics time-series (from/to)</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/logs/windows</code></td><td style={S.td}>Query Windows Event Logs</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/logs/linux</code></td><td style={S.td}>Query Linux Syslog and file logs</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/logs/events</code></td><td style={S.td}>Unified cross-platform logs search</td></tr>
                                    <tr style={S.tr}><td style={S.td}><span style={{ color: '#10b981', fontWeight: 800 }}>GET</span></td><td style={S.td}><code>/api/v1/open/prometheus</code></td><td style={S.td}>Prometheus text metrics scrape exporter</td></tr>
                                </tbody>
                            </table>

                            <h4 style={{ color: 'var(--accent-primary)', margin: '16px 0 8px 0' }}>3. Query Parameters</h4>
                            <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-secondary)' }}>
                                <li><code>host</code>: Filter by host name, IP address, or Monitor ID</li>
                                <li><code>level</code>: Filter log severity (e.g. <code>Error</code>, <code>Warning</code>, <code>Information</code>)</li>
                                <li><code>keyword</code>: Full-text message search</li>
                                <li><code>from</code> / <code>to</code>: ISO 8601 timestamps (e.g. <code>2026-08-14T00:00:00Z</code>)</li>
                                <li><code>limit</code>: Number of records (default 100, max 1000)</li>
                            </ul>
                        </div>
                        <div style={{ marginTop: 16, textAlign: 'right', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                            <button style={S.btnP} onClick={() => setShowDocModal(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Group Delete Confirmation Modal */}
            {deleteConfirmGroup && (
                <div style={S.overlay} onClick={() => setDeleteConfirmGroup(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>Confirm Delete</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0' }}>
                            Are you sure you want to delete AD group mapping for <strong>{deleteConfirmGroup}</strong>? This action cannot be undone.
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" style={{ ...S.btnO, flex: 1 }} onClick={() => setDeleteConfirmGroup(null)}>
                                Cancel
                            </button>
                            <button type="button" style={{ ...S.btnP, background: 'var(--danger)', boxShadow: 'none', flex: 1 }} onClick={handleConfirmDeleteGroup}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add / Edit SFTP Server Modal */}
            {showSftpServerModal && (
                <div style={S.overlay} onClick={() => setShowSftpServerModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 540, textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 14, marginBottom: 18 }}>
                            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span>📁</span> {isEditingSftpServer ? 'Edit SFTP Server Endpoint' : 'Add New SFTP Server Endpoint'}
                            </h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowSftpServerModal(false)}>
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleSaveSftpServerFromModal} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    SERVER DISPLAY NAME *
                                </label>
                                <input
                                    type="text"
                                    style={S.input}
                                    placeholder="e.g. Local SFTP Server, Taipei AD SFTP"
                                    value={sftpServerForm.name}
                                    onChange={e => setSftpServerForm({ ...sftpServerForm, name: e.target.value })}
                                    required
                                />
                            </div>

                            <div style={S.gridRow}>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        HOST / IP ADDRESS *
                                    </label>
                                    <input
                                        type="text"
                                        style={S.input}
                                        placeholder="127.0.0.1 or 192.168.1.10"
                                        value={sftpServerForm.host}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, host: e.target.value })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        PROTOCOL
                                    </label>
                                    <select
                                        style={S.select}
                                        value={sftpServerForm.protocol || 'http'}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, protocol: e.target.value })}
                                    >
                                        <option value="http">HTTP</option>
                                        <option value="https">HTTPS</option>
                                    </select>
                                </div>
                            </div>

                            <div style={S.gridRow}>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        WEB API PORT (REST / ADMIN) *
                                    </label>
                                    <input
                                        type="number"
                                        style={S.input}
                                        placeholder="8443"
                                        value={sftpServerForm.apiPort}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, apiPort: parseInt(e.target.value, 10) || 8443 })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        SFTP SERVICE PORT <span style={{ fontWeight: 'normal', color: 'var(--text-muted)' }}>(Optional / Auto-detected)</span>
                                    </label>
                                    <input
                                        type="number"
                                        style={S.input}
                                        placeholder="Auto from server (default 2222)"
                                        value={sftpServerForm.sftpPort}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, sftpPort: e.target.value ? parseInt(e.target.value, 10) : '' })}
                                    />
                                </div>
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    MANAGEMENT API SECRET KEY
                                </label>
                                <div style={{ position: 'relative' }}>
                                    <input
                                        type={showModalSftpKey ? 'text' : 'password'}
                                        style={{ ...S.input, paddingRight: 40 }}
                                        placeholder="Enter server API secret key"
                                        value={sftpServerForm.apiKey || ''}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, apiKey: e.target.value })}
                                    />
                                    <button
                                        type="button"
                                        style={{
                                            position: 'absolute',
                                            right: 10,
                                            top: '50%',
                                            transform: 'translateY(-20%)',
                                            background: 'transparent',
                                            border: 'none',
                                            color: 'var(--text-muted)',
                                            cursor: 'pointer',
                                            fontSize: 14
                                        }}
                                        onClick={() => setShowModalSftpKey(!showModalSftpKey)}
                                    >
                                        {showModalSftpKey ? '👁️' : '🙈'}
                                    </button>
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                    Encrypted with AES-256 upon saving
                                </span>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                                    <input
                                        type="checkbox"
                                        checked={sftpServerForm.enabled}
                                        onChange={e => setSftpServerForm({ ...sftpServerForm, enabled: e.target.checked })}
                                        style={{ accentColor: '#34c759', transform: 'scale(1.2)' }}
                                    />
                                    <span>Enable Server Endpoint</span>
                                </label>

                                <button
                                    type="button"
                                    style={{ ...S.btnO, padding: '6px 14px', fontSize: 12 }}
                                    onClick={() => handleTestSingleSftpServer(sftpServerForm)}
                                    disabled={sftpServerTesting}
                                >
                                    {sftpServerTesting ? '⏳ Testing...' : '⚡ Test Connection'}
                                </button>
                            </div>

                            {sftpServerTestResult && (
                                <div style={{
                                    padding: 10,
                                    borderRadius: 10,
                                    background: sftpServerTestResult.success ? 'rgba(52,199,89,0.1)' : 'rgba(255,59,48,0.1)',
                                    border: `1px solid ${sftpServerTestResult.success ? 'rgba(52,199,89,0.3)' : 'rgba(255,59,48,0.3)'}`,
                                    color: sftpServerTestResult.success ? '#34c759' : '#ff3b30',
                                    fontSize: 12,
                                    fontWeight: 700
                                }}>
                                    {sftpServerTestResult.success ? '✅ ' : '❌ '}{sftpServerTestResult.message || sftpServerTestResult.error}
                                </div>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 10 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowSftpServerModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" style={S.btnP}>
                                    {isEditingSftpServer ? 'Save Changes' : 'Add Server'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Custom User Role Override Remove Confirmation Modal */}
            {deleteConfirmUser && (
                <div style={S.overlay} onClick={() => setDeleteConfirmUser(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>Revert Role Override</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0' }}>
                            Are you sure you want to remove the custom role override for <strong>{deleteConfirmUser.username}@{deleteConfirmUser.domain}</strong> and revert them to default role?
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" style={{ ...S.btnO, flex: 1 }} onClick={() => setDeleteConfirmUser(null)}>
                                Cancel
                            </button>
                            <button type="button" style={{ ...S.btnP, background: 'var(--danger)', boxShadow: 'none', flex: 1 }} onClick={handleConfirmRemoveRole}>
                                Revert
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const GroupFeatureEditor = ({ isBuiltin = false, initialFeatures, initialAuditLogs, onSave, onCancel }) => {
    // Built-in SuperAdmin mapping: lock-out-guard keys are always on and cannot be unticked;
    // SuperAdmin actions are always audited, so the per-feature audit column is not shown.
    const [features, setFeatures] = useState(() => normalizeEditorFeatures(isBuiltin, initialFeatures));
    const [auditLogs, setAuditLogs] = useState({ ...initialAuditLogs });
    const categories = getEditorCategories(isBuiltin);
    const showAudit = !isBuiltin;

    const handleFeatureChange = (key, val) => {
        if (isFeatureLocked(isBuiltin, key)) return;
        setFeatures(prev => ({ ...prev, [key]: val }));
    };

    const handleAuditChange = (key, val) => {
        setAuditLogs(prev => ({ ...prev, [key]: val }));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ ...S.tblWrap, marginBottom: 8, maxHeight: 350, overflowY: 'auto' }}>
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={{ ...S.th, padding: '10px 16px' }}>FEATURE NAME</th>
                            <th style={{ ...S.th, padding: '10px 16px', textAlign: 'center', width: 80 }}>ENABLE</th>
                            {showAudit && <th style={{ ...S.th, padding: '10px 16px', textAlign: 'center', width: 90 }}>AUDIT LOG</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {categories.map(category => {
                            const categoryLocked = category.items.every(item => isFeatureLocked(isBuiltin, item.key));
                            return (
                            <React.Fragment key={category.label}>
                                <tr>
                                    <td style={{ padding: '10px 16px', fontWeight: 900, color: 'var(--accent-primary)', fontSize: 10, letterSpacing: '0.08em', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.01)' }}>
                                        {category.label}
                                    </td>
                                    <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.01)' }}>
                                        <input 
                                            type="checkbox" 
                                            checked={category.items.every(item => features[item.key] === true)}
                                            disabled={categoryLocked}
                                            onChange={(e) => setFeatures(toggleCategory(isBuiltin, features, category, e.target.checked))}
                                            style={{ cursor: categoryLocked ? 'not-allowed' : 'pointer', accentColor: 'var(--danger)', transform: 'scale(1.2)' }}
                                            title={categoryLocked ? LOCKED_FEATURE_TOOLTIP : 'Toggle All Enable'}
                                        />
                                    </td>
                                    {showAudit && (
                                    <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.01)' }}>
                                        <input 
                                            type="checkbox" 
                                            checked={category.items.every(item => auditLogs[item.key] === true)}
                                            onChange={(e) => {
                                                const nextState = e.target.checked;
                                                const newAuditLogs = { ...auditLogs };
                                                category.items.forEach(item => { newAuditLogs[item.key] = nextState; });
                                                setAuditLogs(newAuditLogs);
                                            }}
                                            style={{ cursor: 'pointer', accentColor: 'var(--danger)', transform: 'scale(1.2)' }}
                                            title="Toggle All Audit Logs"
                                        />
                                    </td>
                                    )}
                                </tr>
                                {category.items.map(item => {
                                    const locked = isFeatureLocked(isBuiltin, item.key);
                                    return (
                                    <tr key={item.key} style={S.tr}>
                                        <td style={{ padding: '8px 16px 8px 24px', fontSize: 12 }}>{item.label}</td>
                                        <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                                            <input
                                                type="checkbox"
                                                checked={locked || features[item.key] === true}
                                                disabled={locked}
                                                title={locked ? LOCKED_FEATURE_TOOLTIP : undefined}
                                                onChange={(e) => handleFeatureChange(item.key, e.target.checked)}
                                                style={{ width: 14, height: 14, cursor: locked ? 'not-allowed' : 'pointer' }}
                                            />
                                        </td>
                                        {showAudit && (
                                        <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                                            <input 
                                                type="checkbox"
                                                checked={auditLogs[item.key] === true}
                                                onChange={(e) => handleAuditChange(item.key, e.target.checked)}
                                                style={{ width: 14, height: 14, cursor: 'pointer' }}
                                            />
                                        </td>
                                        )}
                                    </tr>
                                    );
                                })}
                            </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" style={{ ...S.btnO, padding: '6px 16px', fontSize: 12 }} onClick={onCancel}>
                    Cancel
                </button>
                <button type="button" style={{ ...S.btnP, padding: '6px 16px', fontSize: 12 }} onClick={() => onSave(normalizeEditorFeatures(isBuiltin, features), auditLogs)}>
                    Save Features
                </button>
            </div>
        </div>
    );
};

export default Settings;
