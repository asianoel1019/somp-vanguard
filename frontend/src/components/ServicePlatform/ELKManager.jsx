import React, { useState, useEffect } from 'react';
import api from '../../api';
import { FaCheckCircle, FaExclamationTriangle, FaShieldAlt, FaBan, FaSyncAlt, FaServer, FaPlayCircle, FaInfoCircle, FaRandom, FaHeartbeat, FaHdd, FaCode, FaSearch, FaTrashAlt, FaCopy, FaRocket } from 'react-icons/fa';

const ELKManager = ({ linuxPassword, setLinuxPassword, linuxAdminUser, setIsProcessing }) => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [tab, setTab] = useState('HEALTH');
    const [envsMap, setEnvsMap] = useState({});
    const envs = Object.keys(envsMap);
    const [activeEnv, setActiveEnv] = useState('');
    const [loading, setLoading] = useState(false);
    const [loadingMsg, setLoadingMsg] = useState('');
    const [tempPassword, setTempPassword] = useState('');
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [confirmAction, setConfirmAction] = useState(null);
    const [infoModal, setInfoModal] = useState(null);
    const pollingRef = React.useRef(null);

    useEffect(() => {
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
        };
    }, []);

    const [siemConfig, setSiemConfig] = useState({ enabled: false, tasks: [] });
    const [topThreat, setTopThreat] = useState(null);

    const fetchTelemetry = () => {
        api.get('/siem/telemetry')
            .then(res => {
                if (res.data && res.data.topThreat) setTopThreat(res.data.topThreat);
            })
            .catch(err => console.error('[SIEM] Telemetry failed:', err));
    };

    const [lifecycleDays, setLifecycleDays] = useState({ short: 7, medium: 60, long: 365 });
    const [lifecycleMap, setLifecycleMap] = useState({});

    // Lifecycle Violation State
    const [violationPattern, setViolationPattern] = useState('');
    const [violationSchedule, setViolationSchedule] = useState('1 day');
    const [violationList, setViolationList] = useState([]);
    const [violationStats, setViolationStats] = useState({ totalChecked: 0, lastScanTime: null, lastScanStatus: 'Idle', lastError: null });
    const [isScanningViolations, setIsScanningViolations] = useState(false);
    const [isSavingSchedule, setIsSavingSchedule] = useState(false);
    const [selectedViolations, setSelectedViolations] = useState([]);
    const [isDeletingViolations, setIsDeletingViolations] = useState(false);

    const fetchViolationData = () => {
        api.get('/elk/lifecycle-violations')
            .then(res => {
                if (res.data) {
                    setViolationSchedule(res.data.schedule || '1 day');
                    if (res.data.indexPattern) setViolationPattern(res.data.indexPattern);
                    setViolationList(res.data.violations || []);
                    setViolationStats({
                        totalChecked: res.data.totalChecked || 0,
                        lastScanTime: res.data.lastScanTime,
                        lastScanStatus: res.data.lastScanStatus || 'Idle',
                        lastError: res.data.lastError
                    });
                }
            })
            .catch(err => console.error('[ELK] Failed to fetch violations:', err));
    };

    useEffect(() => {
        api.get('/elk/envs').then(res => {
            const map = res.data;
            console.log('[ELK] Loaded envs from backend:', Object.keys(map));
            setEnvsMap(map);
            const list = Object.keys(map);
            if (list.length > 0) {
                setActiveEnv(list[0]);
            }
        }).catch(err => console.error('[ELK] Failed to fetch envs:', err));

        api.get('/elk/lifecycle-config')
            .then(res => {
                if (res.data) {
                    setLifecycleDays(res.data);
                    if (res.data.byEnv) setLifecycleMap(res.data.byEnv);
                }
            })
            .catch(err => console.error('[ELK] Failed to fetch lifecycle config:', err));

        fetchViolationData();

        api.get('/siem').then(res => {
            if (res.data) setSiemConfig(res.data);
            fetchTelemetry();
        }).catch(err => console.error('[SIEM] Failed to fetch siem config:', err));
    }, []);

    // Active Environment details
    const activeEnvData = envsMap[activeEnv] || {};
    const hasAuth = !!linuxPassword || !!activeEnvData.hasPresetAuth;
    const hasLogstash = !!activeEnvData.ls_path && activeEnvData.ls?.length > 0;
    const esVersion = activeEnvData.version || '7.17';
    const isModernES = (() => {
        const clean = String(esVersion).trim().toLowerCase().replace(/^v/, '');
        const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
        const major = parts[0] || 0;
        const minor = parts[1] || 0;
        if (major > 7) return true;
        if (major === 7) return minor >= 6;
        return false;
    })();

    // Health State
    const [healthData, setHealthData] = useState(null);
    const [diskData, setDiskData] = useState(null);

    // Ops State
    const [opsResult, setOpsResult] = useState(null);
    const [nodeIp, setNodeIp] = useState('');
    const [envNodes, setEnvNodes] = useState([]);

    useEffect(() => {
        if (!activeEnv) return;
        api.get(`/elk/nodes/${activeEnv}`).then(r => {
            setEnvNodes(r.data);
            if (r.data.length > 0) setNodeIp(r.data[0]);
        }).catch(console.error);
    }, [activeEnv]);

    // Logstash State
    const [lsFolder, setLsFolder] = useState('');
    const [lsResult, setLsResult] = useState(null);

    // Tools State
    const [toolTab, setToolTab] = useState('INDEX');

    // Index Builder
    const [idxName, setIdxName] = useState('');
    const [idxTemplate, setIdxTemplate] = useState('');
    const [idxPattern, setIdxPattern] = useState('');
    const [idxPolicy, setIdxPolicy] = useState('');
    const [idxOutput, setIdxOutput] = useState('');
    const [isDeployingIndex, setIsDeployingIndex] = useState(false);
    const [deployIndexResult, setDeployIndexResult] = useState(null);
    const [isCopied, setIsCopied] = useState(false);

    // Delete By Query
    const [delIndex, setDelIndex] = useState('');
    const [delStart, setDelStart] = useState('');
    const [delEnd, setDelEnd] = useState('');
    const [delResult, setDelResult] = useState(null);

    // SIEM Handlers
    const saveSiemConfig = async (newConfig) => {
        setIsProcessing(true);
        try {
            await api.post('/siem/save', newConfig);
            setSiemConfig(newConfig);
            setInfoModal({ title: 'Success', message: '✅ SIEM configuration saved!', type: 'success' });
        } catch (e) {
            setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' });
        } finally {
            setIsProcessing(false);
        }
    };

    const toggleSiem = () => {
        const next = { ...siemConfig, enabled: !siemConfig.enabled };
        setSiemConfig(next);
        saveSiemConfig(next);
    };

    const addSiemTask = (template = 'custom') => {
        let newTask = {
            id: Date.now().toString(),
            name: 'New Custom Task',
            env: 'ALL',
            eventIds: '',
            interval: 10,
            threshold: 1,
            type: 'custom',
            enableMail: false,
            enableTelegram: false,
            enabled: true
        };

        if (template === 'escalation') {
            newTask.name = '🛡️ Group Permission Escalation';
            newTask.eventIds = '4728, 4732';
            newTask.type = 'escalation';
        } else if (template === 'log_cleared') {
            newTask.name = '⚠️ Log Event Cleared';
            newTask.eventIds = '1102';
            newTask.type = 'log_cleared';
        } else if (template === 'new_service') {
            newTask.name = '⚙️ New Service Installed';
            newTask.eventIds = '7045';
            newTask.type = 'new_service';
        } else if (template === 'rdp_login') {
            newTask.name = '🔑 RDP Login (Type 10)';
            newTask.eventIds = '4624';
            newTask.type = 'rdp_login';
        } else if (template === 'ps_attack') {
            newTask.name = '🐚 PowerShell Attack Detected';
            newTask.eventIds = '4104, 4103';
            newTask.type = 'ps_attack';
        }

        const next = { ...siemConfig, tasks: [...siemConfig.tasks, newTask] };
        setSiemConfig(next);
    };

    const [siemTestResult, setSiemTestResult] = useState(null);
    const [siemTestTask, setSiemTestTask] = useState(null);

    const testRunSiemTask = async (task) => {
        setIsProcessing(true);
        setSiemTestResult(null);
        setSiemTestTask(task);
        try {
            const res = await api.post('/siem/test-run', { task });
            setSiemTestResult(res.data.results);
        } catch (e) {
            setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' });
            setSiemTestResult([{ env: 'Error', status: e.response?.data?.error || e.message }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const renderSSHAuth = () => (
        <div className="glass-panel p-6 animate-fade-in text-center mx-auto" style={{ maxWidth: '400px', marginTop: '5%' }}>
            <h3 className="mb-4">🔒 sudo Authentication Required</h3>
            <p className="text-secondary mb-4">
                Accessing <strong>{tab === 'OPS' ? 'Cluster Operations' : tab === 'LOGSTASH' ? 'Logstash Deployer' : 'Dev Tools'}</strong> requires <strong>{activeEnvData.user || linuxAdminUser}</strong> privileges to execute SSH commands.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); setLinuxPassword(tempPassword); }}>
                <input
                    type="password"
                    placeholder={`Enter password for ${activeEnvData.user || linuxAdminUser}...`}
                    value={tempPassword}
                    onChange={(e) => setTempPassword(e.target.value)}
                    autoFocus
                    className="mb-4 w-full p-2 rounded bg-black/50 border border-white/10"
                />
                <button type="submit" className="btn btn-primary w-full shadow-lg shadow-primary/20" disabled={!tempPassword}>
                    Authenticate & Unlock Features
                </button>
            </form>
            <p className="mt-4 text-xs text-muted">Once authenticated, this password will be used for all SSH-based tasks in this session.</p>
        </div>
    );

    const startRecoveryPolling = () => {
        if (pollingRef.current) clearInterval(pollingRef.current);
        setOpsResult('[Polling] Started tracking shard recovery...\n');
        pollingRef.current = setInterval(async () => {
            try {
                const res = await api.post('/elk/health', { env: activeEnv });
                const h = res.data.health;
                if (!h) return;

                const status = h.status;
                const unassigned = h.unassigned_shards;
                const relocating = h.relocating_shards;
                const timestamp = new Date().toLocaleTimeString();

                setOpsResult(prev => {
                    const prevStr = typeof prev === 'string' ? prev : JSON.stringify(prev);
                    return `${prevStr}\n[${timestamp}] Status: ${status} | Unassigned: ${unassigned} | Relocating: ${relocating}`;
                });

                if (unassigned === 0 && relocating === 0 && (status === 'green' || status === 'yellow')) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                    setOpsResult(prev => prev + '\n\n✅ Recovery Complete. Cluster is stable.');
                }
            } catch (err) {
                setOpsResult(prev => prev + `\n[Polling Error] ${err.message}`);
            }
        }, 5000);
    };

    const WrapLoad = async (msg, fn, errorToOpsResult = false) => {
        setLoading(true); setLoadingMsg(msg);
        setIsProcessing(true);
        try { await fn(); } catch (e) {
            if (errorToOpsResult) {
                setOpsResult(e.response?.data?.error || e.message);
            } else {
                setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' });
            }
        }
        setLoading(false); setLoadingMsg('');
        setIsProcessing(false);
    };

    // --- Tab 1: Health Actions ---
    const fetchHealth = () => WrapLoad('Fetching ES Health...', async () => {
        const res = await api.post('/elk/health', { env: activeEnv });
        setHealthData(res.data);
    });

    const fetchDisk = () => {
        if (!hasAuth) {
            setShowAuthModal(true);
            return;
        }
        WrapLoad(`Checking disks via SSH on all ${activeEnv} nodes...`, async () => {
            const res = await api.post('/elk/disk', { env: activeEnv, linuxPassword });
            setDiskData(res.data);
        });
    };

    // --- Tab 2: Ops Actions ---
    const runESAction = (action_type) => {
        setConfirmAction({
            title: `Execute ${action_type}`,
            message: `Execute ${action_type} on ${activeEnv} cluster?`,
            onConfirm: () => {
                setConfirmAction(null);
                WrapLoad(`Executing ${action_type}...`, async () => {
                    const res = await api.post('/elk/action', { env: activeEnv, action_type });
                    setOpsResult(res.data.response);

                    if (action_type === 'enable_allocation') {
                        startRecoveryPolling();
                    }
                }, true);
            }
        });
    };

    const restartNode = () => {
        if (!nodeIp) return setInfoModal({ title: 'Validation Error', message: 'Enter a Node IP', type: 'error' });
        if (!hasAuth) {
            setShowAuthModal(true);
            return;
        }
        setConfirmAction({
            title: 'Restart Node',
            message: `Restart elasticsearch service on ${nodeIp}?`,
            onConfirm: () => {
                setConfirmAction(null);
                setOpsResult(`[Node Restart] Dispatching systemctl restart to ${nodeIp}... please wait.`);
                WrapLoad(`Restarting elasticsearch on ${nodeIp}...`, async () => {
                    const res = await api.post('/elk/restart-node', { nodeIp, linuxPassword, env: activeEnv });
                    setOpsResult(`[Node Restart] Completed.\n\nLogs:\n${res.data.logs}`);
                }, true);
            }
        });
    };

    // --- Tab 3: Logstash Actions ---
    const deployLogstash = () => {
        if (!lsFolder) return setInfoModal({ title: 'Validation Error', message: 'Enter folder name', type: 'error' });
        if (!hasAuth) {
            setShowAuthModal(true);
            return;
        }
        setConfirmAction({
            title: 'Deploy Logstash',
            message: `Deploy conf files from your NAS into ${activeEnv} logstash servers?`,
            onConfirm: () => {
                setConfirmAction(null);
                WrapLoad(`Deploying ${lsFolder} to ${activeEnv}...`, async () => {
                    const res = await api.post('/elk/logstash-deploy', { env: activeEnv, folderName: lsFolder, linuxPassword });
                    setLsResult(res.data.deploymentLogs);
                });
            }
        });
    };

    // --- Tab 4: Tools Actions ---
    const handleIdxNameChange = (e) => {
        const val = e.target.value;
        setIdxName(val);
        if (val) {
            setIdxTemplate(`${val}-template`);
            setIdxPattern(`${val}-*`);
        } else {
            setIdxTemplate('');
            setIdxPattern('');
        }
    };

    const getPolicies = () => {
        if (!activeEnv) return [];
        const e = activeEnv.toLowerCase();
        return [`${e}-ilm-long-policy`, `${e}-ilm-medium-policy`, `${e}-ilm-short-policy`];
    };

    const copyToClipboard = (text) => {
        if (!text) return;
        const fallbackCopy = (content) => {
            try {
                const textArea = document.createElement('textarea');
                textArea.value = content;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                textArea.setAttribute('readonly', '');
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                const successful = document.execCommand('copy');
                document.body.removeChild(textArea);
                if (successful) {
                    setIsCopied(true);
                    setTimeout(() => setIsCopied(false), 2500);
                    setInfoModal({ title: 'Copied', message: 'Script copied to clipboard!', type: 'success' });
                } else {
                    throw new Error('execCommand returned false');
                }
            } catch (err) {
                console.error('Fallback copy failed:', err);
                setInfoModal({ title: 'Copy Notice', message: 'Unable to access clipboard automatically. Please select the script and press Ctrl+C to copy.', type: 'error' });
            }
        };

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text)
                .then(() => {
                    setIsCopied(true);
                    setTimeout(() => setIsCopied(false), 2500);
                    setInfoModal({ title: 'Copied', message: 'Script copied to clipboard!', type: 'success' });
                })
                .catch(() => {
                    fallbackCopy(text);
                });
        } else {
            fallbackCopy(text);
        }
    };

    const generateIndex = () => {
        if (!idxName || !idxTemplate || !idxPattern || !idxPolicy) return setInfoModal({ title: 'Validation Error', message: '- Fill all fields -', type: 'error' });
        if (idxPattern.startsWith('*')) return setInfoModal({ title: 'Validation Error', message: 'Index Pattern cannot start with "*"', type: 'error' });
        if (/\s/.test(idxPattern)) return setInfoModal({ title: 'Validation Error', message: 'Index Pattern cannot contain spaces', type: 'error' });
        if (idxPattern.length > 200) return setInfoModal({ title: 'Validation Error', message: 'Index Pattern is too long (max 200 characters)', type: 'error' });
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const json = `PUT _index_template/${idxTemplate}\n{\n  "index_patterns" : ["${idxPattern}"],\n  "template" : {\n    "settings" : {\n      "index" : {\n        "lifecycle" : {\n          "name" : "${idxPolicy}",\n          "rollover_alias" : "${idxName}"\n        },\n        "refresh_interval" : "10s",\n        "number_of_shards" : "1",\n        "number_of_replicas" : "1"\n      }\n    }\n  },\n  "composed_of" : [ ],\n  "priority" : 100,\n  "version" : ${date}\n}\n\nPUT ${idxName}-000001\n{\n  "aliases": {\n    "${idxName}": {\n      "is_write_index":true\n    }\n  }\n}`;
        setIdxOutput(json);
    };

    const deployIndexTemplate = () => {
        if (!activeEnv) {
            return setInfoModal({ title: 'Validation Error', message: 'Please select an ELK environment cluster first.', type: 'error' });
        }
        if (!idxName || !idxTemplate || !idxPattern || !idxPolicy) {
            return setInfoModal({ title: 'Validation Error', message: '- Fill all fields -', type: 'error' });
        }
        if (idxPattern.startsWith('*')) {
            return setInfoModal({ title: 'Validation Error', message: 'Index Pattern cannot start with "*"', type: 'error' });
        }
        if (/\s/.test(idxPattern)) {
            return setInfoModal({ title: 'Validation Error', message: 'Index Pattern cannot contain spaces', type: 'error' });
        }
        if (idxPattern.length > 200) {
            return setInfoModal({ title: 'Validation Error', message: 'Index Pattern is too long (max 200 characters)', type: 'error' });
        }

        // Auto construct JSON in preview if not already done
        if (!idxOutput) {
            generateIndex();
        }

        setConfirmAction({
            title: `Deploy Index Template to ${activeEnv}`,
            message: `Are you sure you want to deploy Index Template [${idxTemplate}] and initial bootstrap index [${idxName}-000001] to the ${activeEnv} Elasticsearch cluster?`,
            isDanger: false,
            onConfirm: async () => {
                setConfirmAction(null);
                setIsDeployingIndex(true);
                setDeployIndexResult(null);
                setLoading(true);
                setLoadingMsg(`Deploying Index Template [${idxTemplate}] to ${activeEnv}...`);

                try {
                    const res = await api.post('/elk/deploy-index-template', {
                        env: activeEnv,
                        templateName: idxTemplate,
                        indexPattern: idxPattern,
                        aliasName: idxName,
                        policyName: idxPolicy,
                        customScript: idxOutput
                    });
                    setDeployIndexResult(res.data);
                    setInfoModal({
                        title: 'Deployment Successful',
                        message: `✅ Successfully deployed Index Template [${idxTemplate}] and initial index [${idxName}-000001] to ${activeEnv} cluster!`,
                        type: 'success'
                    });
                } catch (e) {
                    const errMsg = e.response?.data?.error || e.message;
                    setDeployIndexResult({ error: errMsg });
                    setInfoModal({
                        title: 'Deployment Failed',
                        message: errMsg,
                        type: 'error'
                    });
                } finally {
                    setLoading(false);
                    setLoadingMsg('');
                    setIsDeployingIndex(false);
                }
            }
        });
    };

    const renderIlmPreview = () => {
        if (!idxPolicy) return null;
        const envConf = (lifecycleMap && (lifecycleMap[activeEnv] || lifecycleMap[activeEnv?.toUpperCase()])) || lifecycleDays || {};
        const shortDays = envConf.short || 7;
        const mediumDays = envConf.medium || 60;
        const longDays = envConf.long || 365;

        let phases = [];
        if (idxPolicy.includes('short')) {
            const total = Number(shortDays) || 7;
            phases = [
                { name: 'HOT', icon: '🔥', duration: `${total} Days`, color: '#ef4444' },
                { name: 'DELETE', icon: '🗑️', duration: 'Forever', color: '#64748b' }
            ];
        } else if (idxPolicy.includes('medium')) {
            const total = Number(mediumDays) || 60;
            const hot = Math.round(total / 2);
            const warm = total;
            phases = [
                { name: 'HOT', icon: '🔥', duration: `${hot} Days`, color: '#ef4444' },
                { name: 'WARM', icon: '🌡️', duration: `${warm} Days`, color: '#f59e0b' },
                { name: 'DELETE', icon: '🗑️', duration: 'Forever', color: '#64748b' }
            ];
        } else if (idxPolicy.includes('long')) {
            const total = Number(longDays) || 365;
            const hot = Math.round(total / 2);
            const remaining = total - hot;
            const warmIncr = Math.round(remaining / 2);
            const warm = hot + warmIncr;
            const cold = total;
            phases = [
                { name: 'HOT', icon: '🔥', duration: `${hot} Days`, color: '#ef4444' },
                { name: 'WARM', icon: '🌡️', duration: `${warm} Days`, color: '#f59e0b' },
                { name: 'COLD', icon: '❄️', duration: `${cold} Days`, color: '#3b82f6' },
                { name: 'DELETE', icon: '🗑️', duration: 'Forever', color: '#64748b' }
            ];
        } else {
            return null;
        }

        return (
            <div className="mt-4 p-4 bg-black/40 rounded-lg border border-white/10">
                <h5 className="text-xs text-secondary mb-3 font-bold uppercase tracking-wider">
                    Lifecycle Transition Preview <span style={{ color: '#facc15' }}>({activeEnv || 'Cluster'})</span>
                </h5>
                <div className="flex items-center gap-2 overflow-x-auto pb-2">
                    {phases.map((p, i) => (
                        <React.Fragment key={p.name}>
                            <div className="flex flex-col items-center justify-center p-3 rounded bg-black/50 border border-white/5 min-w-[100px]" style={{ borderTop: `3px solid ${p.color}` }}>
                                <span className="text-xl mb-1">{p.icon}</span>
                                <span className="text-xs font-bold text-white mb-1">{p.name}</span>
                                <span className="text-[10px] text-secondary">{p.duration}</span>
                            </div>
                            {i < phases.length - 1 && (
                                <div className="text-secondary text-lg px-1 animate-pulse">➔</div>
                            )}
                        </React.Fragment>
                    ))}
                </div>
            </div>
        );
    };

    // Lifecycle Violation Handlers
    const handleSaveViolationSchedule = async () => {
        setIsSavingSchedule(true);
        try {
            await api.post('/elk/lifecycle-violations/config', {
                schedule: violationSchedule,
                targetEnv: activeEnv,
                indexPattern: violationPattern
            });
            setInfoModal({
                title: 'Schedule Configured',
                message: `✅ Periodic scan configured (${violationSchedule}) on ${activeEnv}!`,
                type: 'success'
            });
        } catch (e) {
            setInfoModal({
                title: 'Save Failed',
                message: e.response?.data?.error || e.message,
                type: 'error'
            });
        } finally {
            setIsSavingSchedule(false);
        }
    };

    const handleScanViolations = async () => {
        setIsScanningViolations(true);
        try {
            const res = await api.post('/elk/lifecycle-violations/scan', {
                env: activeEnv,
                indexPattern: violationPattern || '*'
            });
            const result = res.data?.result || {};
            setViolationList(result.violations || []);
            setViolationStats({
                totalChecked: result.totalChecked || 0,
                lastScanTime: result.lastScanTime,
                lastScanStatus: result.lastScanStatus || 'Success',
                lastError: result.lastError
            });
            setSelectedViolations([]);
            setInfoModal({
                title: 'Scan Finished',
                message: `Found ${result.violations?.length || 0} unmanaged indices without lifecycle policy across ${result.totalChecked || 0} indices on ${activeEnv}.`,
                type: 'success'
            });
        } catch (e) {
            setInfoModal({
                title: 'Scan Error',
                message: e.response?.data?.error || e.message,
                type: 'error'
            });
        } finally {
            setIsScanningViolations(false);
        }
    };

    const handleDeleteViolationIndices = (targets) => {
        const list = Array.isArray(targets) ? targets : [targets];
        if (list.length === 0) return;

        setConfirmAction({
            title: 'Delete Unmanaged Indices',
            message: `⚠️ Are you sure you want to PERMANENTLY DELETE ${list.length} index(es) on ${activeEnv}?\n\nTarget indices:\n${list.slice(0, 5).join('\n')}${list.length > 5 ? `\n...and ${list.length - 5} more` : ''}\n\nTHIS ACTION CANNOT BE UNDONE. All data in these index(es) will be wiped!`,
            isDanger: true,
            onConfirm: async () => {
                setConfirmAction(null);
                setIsDeletingViolations(true);
                try {
                    const res = await api.post('/elk/lifecycle-violations/delete', {
                        env: activeEnv,
                        indices: list
                    });
                    const count = res.data?.results?.filter(r => r.success)?.length || 0;
                    setViolationList(prev => prev.filter(v => !list.includes(v.index)));
                    setSelectedViolations(prev => prev.filter(x => !list.includes(x)));
                    setInfoModal({
                        title: 'Indices Deleted',
                        message: `✅ Successfully deleted ${count} unmanaged index(es) from ${activeEnv}!`,
                        type: 'success'
                    });
                } catch (e) {
                    setInfoModal({
                        title: 'Deletion Failed',
                        message: e.response?.data?.error || e.message,
                        type: 'error'
                    });
                } finally {
                    setIsDeletingViolations(false);
                }
            }
        });
    };

    const toggleSelectAllViolations = () => {
        if (selectedViolations.length === violationList.length) {
            setSelectedViolations([]);
        } else {
            setSelectedViolations(violationList.map(v => v.index));
        }
    };

    const toggleSelectViolation = (idxName) => {
        setSelectedViolations(prev => 
            prev.includes(idxName) ? prev.filter(x => x !== idxName) : [...prev, idxName]
        );
    };

    const execDeleteByQuery = () => {
        setConfirmAction({
            title: 'Delete By Query',
            message: `Execute Delete By Query on ${activeEnv} for ${delIndex}? THIS CANNOT BE UNDONE.`,
            isDanger: true,
            onConfirm: () => {
                setConfirmAction(null);
                WrapLoad(`Deleting indices on ${activeEnv}...`, async () => {
                    const res = await api.post('/elk/delete-by-query', { env: activeEnv, index: delIndex, startTime: delStart, endTime: delEnd });
                    setDelResult(res.data.response);
                });
            }
        });
    };

    if (envs.length === 0) {
        return (
            <div className="animate-fade-in relative p-4">
                <div className="mb-6 flex justify-between items-center px-1">
                    <div>
                        <h1 className="page-title">ELK Manager</h1>
                        <p className="page-subtitle">ELK Platform Analytics Engine</p>
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
                        尚未設定 ELK 伺服器 (No ELK Servers Configured)
                    </h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 24px 0' }}>
                        目前系統尚未配置任何 ELK / SIEM 伺服器節點。請先前往 <strong>Settings (系統設定)</strong> 進行伺服器設定。
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
        <div className="animate-fade-in relative p-4">
            {/* Header */}
            <div className="mb-6 flex justify-between items-center px-1">
                <div>
                    <h1 className="page-title">
                        ELK Manager
                    </h1>
                    <p className="page-subtitle">ELK Platform Analytics Engine</p>
                </div>
            </div>

            {loading && (
                <div className="absolute inset-0 bg-black/50 z-50 flex items-center justify-center rounded">
                    <div className="glass-panel p-6 text-center animate-pulse">
                        <h4 className="text-primary mb-2">Executing Command...</h4>
                        <span className="text-secondary">{loadingMsg}</span>
                    </div>
                </div>
            )}

            <div className="glass-panel p-4 mb-6 flex justify-between items-center bg-black/30">
                <div className="flex gap-2">
                    <button className={`tab ${tab === 'HEALTH' ? 'active' : ''}`} onClick={() => setTab('HEALTH')}>Health & Disk</button>
                    <button className={`tab ${tab === 'OPS' ? 'active' : ''}`} onClick={() => setTab('OPS')}>Cluster Operations</button>
                    {hasLogstash && (
                        <button className={`tab ${tab === 'LOGSTASH' ? 'active' : ''}`} onClick={() => setTab('LOGSTASH')}>
                            Logstash Deployer
                        </button>
                    )}
                    <button className={`tab ${tab === 'TOOLS' ? 'active' : ''}`} onClick={() => setTab('TOOLS')}>
                        Dev Tools & Indexing
                    </button>
                    <button className={`tab ${tab === 'SIEM' ? 'active' : ''}`} onClick={() => { setTab('SIEM'); fetchTelemetry(); }}>
                        🚨 SIEM
                    </button>
                </div>
                {tab !== 'SIEM' && (
                    <div className="flex items-center gap-2" style={{ flexWrap: 'nowrap' }}>
                        <span className="font-bold text-xl mr-2 tracking-wider" style={{ whiteSpace: 'nowrap', color: '#facc15', textShadow: '0 0 8px rgba(250, 204, 21, 0.5)' }}>🎯 Target Cluster:</span>
                        {envs.length > 0 ? (
                            <select value={activeEnv} onChange={e => { setActiveEnv(e.target.value); setHealthData(null); setDiskData(null); setOpsResult(null); setLsResult(null); setIdxPolicy(''); }} className="font-extrabold py-2 px-6 rounded-lg cursor-pointer outline-none transition-all" style={{ backgroundColor: '#111827', color: '#facc15', border: '2px solid #facc15', boxShadow: '0 0 15px rgba(250,204,21,0.3)', fontSize: '1.25rem' }}>
                                {envs.map(e => <option key={e} value={e} style={{ backgroundColor: '#1f2937', color: 'white', fontSize: '1rem' }}>{e} ELK Engine</option>)}
                            </select>
                        ) : (
                            <span className="text-secondary italic">Loading environments from backend...</span>
                        )}
                    </div>
                )}
            </div>

            {/* Conditional Authentication Gate */}
            {['OPS', 'LOGSTASH', 'TOOLS'].includes(tab) && !hasAuth ? renderSSHAuth() : (
                <>
                    {tab === 'HEALTH' && (
                        <div className="grid grid-cols-2 gap-6">
                            <div className="flex flex-col gap-6">
                                <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                                        <div>
                                            <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span>💓</span> Elasticsearch Cluster Status
                                            </h4>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Fetch real-time cluster health, thread pool metrics, and active nodes from <strong style={{ color: '#facc15' }}>{activeEnv}</strong>
                                            </div>
                                        </div>
                                    </div>

                                    <button 
                                        className="btn btn-primary w-full mb-4 font-bold flex items-center justify-center gap-2" 
                                        onClick={fetchHealth}
                                        style={{ padding: '10px 18px', borderRadius: 12, fontSize: 13, background: 'linear-gradient(135deg, var(--accent-primary) 0%, #2563eb 100%)', boxShadow: '0 4px 12px var(--accent-glow)' }}
                                    >
                                        <FaHeartbeat size={14} /> Fetch ES Health APIs
                                    </button>

                                    {healthData && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                            <div style={{ background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 12, padding: 14 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#facc15', letterSpacing: '0.05em', textTransform: 'uppercase' }}>_cluster/health</span>
                                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(250, 204, 21, 0.15)', color: '#facc15', borderRadius: 6, fontWeight: 700 }}>Cluster Health</span>
                                                </div>
                                                <pre style={{ margin: 0, padding: '10px 12px', background: 'rgba(0, 0, 0, 0.4)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#38bdf8', maxHeight: 180, overflow: 'auto', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                                    {typeof healthData.health === 'object' ? JSON.stringify(healthData.health, null, 2) : String(healthData.health)}
                                                </pre>
                                            </div>

                                            <div style={{ background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 12, padding: 14 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#facc15', letterSpacing: '0.05em', textTransform: 'uppercase' }}>_cat/thread_pool/search,write</span>
                                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(250, 204, 21, 0.15)', color: '#facc15', borderRadius: 6, fontWeight: 700 }}>Thread Pools</span>
                                                </div>
                                                <pre style={{ margin: 0, padding: '10px 12px', background: 'rgba(0, 0, 0, 0.4)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#a7f3d0', maxHeight: 180, overflow: 'auto', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                                    {typeof healthData.threads === 'object' ? JSON.stringify(healthData.threads, null, 2) : String(healthData.threads)}
                                                </pre>
                                            </div>

                                            <div style={{ background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 12, padding: 14 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#facc15', letterSpacing: '0.05em', textTransform: 'uppercase' }}>_cat/nodes</span>
                                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(250, 204, 21, 0.15)', color: '#facc15', borderRadius: 6, fontWeight: 700 }}>Cluster Nodes</span>
                                                </div>
                                                <pre style={{ margin: 0, padding: '10px 12px', background: 'rgba(0, 0, 0, 0.4)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#c084fc', maxHeight: 180, overflow: 'auto', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                                    {typeof healthData.nodes === 'object' ? JSON.stringify(healthData.nodes, null, 2) : String(healthData.nodes)}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="glass-panel p-6 min-h-[500px]" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                                    <div>
                                        <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span>💾</span> Filesystem Disk Usage
                                        </h4>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                            Execute parallel SSH inspection across all nodes in <strong style={{ color: '#facc15' }}>{activeEnv}</strong>
                                        </div>
                                    </div>
                                </div>
                                <button 
                                    className="btn btn-warning w-full mb-4 font-bold flex items-center justify-center gap-2" 
                                    onClick={fetchDisk}
                                    style={{ padding: '10px 18px', borderRadius: 12, fontSize: 13, background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#fff', border: 'none', boxShadow: '0 4px 12px rgba(245, 158, 11, 0.3)' }}
                                >
                                    <FaHdd size={14} /> Parallel SSH <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4, marginLeft: 4 }}>df -lh</code>
                                </button>
                                {diskData && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        {diskData.map((d, i) => (
                                            <div key={i} style={{ background: 'rgba(0, 0, 0, 0.35)', border: `1px solid ${d.status === 'Success' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`, borderRadius: 12, padding: 14 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                    <span style={{ fontWeight: 800, fontSize: 13, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                        <FaServer size={12} style={{ color: 'var(--text-muted)' }} /> {d.host}
                                                    </span>
                                                    <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: d.status === 'Success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: d.status === 'Success' ? '#10b981' : '#ef4444' }}>
                                                        {d.status}
                                                    </span>
                                                </div>
                                                <pre style={{ margin: 0, padding: '10px 12px', background: 'rgba(0, 0, 0, 0.4)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', overflow: 'auto', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                                    {d.val}
                                                </pre>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {tab === 'OPS' && (
                        <div className="grid grid-cols-2 gap-6">
                            <div className="flex flex-col gap-6">
                                <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                                        <div>
                                            <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span>🔄</span> Cluster Rolling Restart Workflow
                                            </h4>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Follow sequential steps to safely perform rolling maintenance on <strong style={{ color: '#facc15' }}>{activeEnv}</strong> nodes
                                            </div>
                                        </div>
                                        <span style={{ fontSize: 11, fontWeight: 800, padding: '4px 10px', background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)', borderRadius: 12 }}>
                                            4-Step Safe Workflow
                                        </span>
                                    </div>

                                    {role === 'Viewer' ? (
                                        <div className="text-secondary p-4 bg-black/20 rounded" style={{ fontSize: 13, border: '1px dashed var(--border-color)' }}>
                                            🔒 Cluster restart operations are restricted to Operator and SuperAdmin.
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                            {/* Step 1 */}
                                            <div style={{
                                                background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                                borderRadius: 14,
                                                padding: '14px 18px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 16,
                                                transition: 'all 0.2s',
                                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                                    <div style={{
                                                        width: 38,
                                                        height: 38,
                                                        borderRadius: 10,
                                                        background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                                        color: '#fff',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        fontWeight: 900,
                                                        fontSize: 14,
                                                        boxShadow: '0 4px 10px rgba(239, 68, 68, 0.35)',
                                                        flexShrink: 0
                                                    }}>
                                                        1
                                                    </div>
                                                    <div>
                                                        <div style={{ fontSize: 13, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            Disable Shard Allocation
                                                        </div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                            Pause shard rebalancing before shutting down node
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => runESAction('disable_allocation')}
                                                    style={{
                                                        background: 'rgba(239, 68, 68, 0.15)',
                                                        border: '1px solid #ef4444',
                                                        color: '#fca5a5',
                                                        borderRadius: 10,
                                                        padding: '8px 18px',
                                                        fontSize: 12,
                                                        fontWeight: 800,
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        whiteSpace: 'nowrap',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.color = '#fff'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'; e.currentTarget.style.color = '#fca5a5'; }}
                                                >
                                                    <FaBan size={11} /> Disable
                                                </button>
                                            </div>

                                            {/* Step 2 */}
                                            <div style={{
                                                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                                border: '1px solid rgba(245, 158, 11, 0.25)',
                                                borderRadius: 14,
                                                padding: '14px 18px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 16,
                                                transition: 'all 0.2s',
                                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                                    <div style={{
                                                        width: 38,
                                                        height: 38,
                                                        borderRadius: 10,
                                                        background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                                                        color: '#fff',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        fontWeight: 900,
                                                        fontSize: 14,
                                                        boxShadow: '0 4px 10px rgba(245, 158, 11, 0.35)',
                                                        flexShrink: 0
                                                    }}>
                                                        2
                                                    </div>
                                                    <div>
                                                        <div style={{ fontSize: 13, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            Perform Flush {isModernES ? '(_flush?pretty)' : 'Synced Flush'}
                                                        </div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                            Flush all pending transaction log operations to disk
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => runESAction('synced_flush')}
                                                    style={{
                                                        background: 'rgba(245, 158, 11, 0.15)',
                                                        border: '1px solid #f59e0b',
                                                        color: '#fde68a',
                                                        borderRadius: 10,
                                                        padding: '8px 18px',
                                                        fontSize: 12,
                                                        fontWeight: 800,
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        whiteSpace: 'nowrap',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = '#f59e0b'; e.currentTarget.style.color = '#fff'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.15)'; e.currentTarget.style.color = '#fde68a'; }}
                                                >
                                                    <FaSyncAlt size={11} /> Flush
                                                </button>
                                            </div>

                                            {/* Step 3 */}
                                            <div style={{
                                                background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                                border: '1px solid rgba(99, 102, 241, 0.25)',
                                                borderRadius: 14,
                                                padding: '14px 18px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 16,
                                                transition: 'all 0.2s',
                                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
                                                    <div style={{
                                                        width: 38,
                                                        height: 38,
                                                        borderRadius: 10,
                                                        background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                                                        color: '#fff',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        fontWeight: 900,
                                                        fontSize: 14,
                                                        boxShadow: '0 4px 10px rgba(99, 102, 241, 0.35)',
                                                        flexShrink: 0
                                                    }}>
                                                        3
                                                    </div>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ fontSize: 13, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            Restart Target Node
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                                            <select
                                                                value={nodeIp}
                                                                onChange={e => setNodeIp(e.target.value)}
                                                                style={{
                                                                    background: 'rgba(0, 0, 0, 0.5)',
                                                                    border: '1px solid rgba(255, 255, 255, 0.15)',
                                                                    borderRadius: 8,
                                                                    padding: '4px 10px',
                                                                    color: '#e2e8f0',
                                                                    fontSize: 12,
                                                                    fontWeight: 700,
                                                                    outline: 'none',
                                                                    cursor: 'pointer',
                                                                    flex: 1,
                                                                    minWidth: 140
                                                                }}
                                                            >
                                                                {envNodes.map(ip => <option key={ip} value={ip} style={{ background: '#1e293b' }}>{ip}</option>)}
                                                                {envNodes.length === 0 && <option value="">No nodes exist...</option>}
                                                            </select>
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={restartNode}
                                                    style={{
                                                        background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                                        border: 'none',
                                                        color: '#fff',
                                                        borderRadius: 10,
                                                        padding: '8px 18px',
                                                        fontSize: 12,
                                                        fontWeight: 800,
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        whiteSpace: 'nowrap',
                                                        boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
                                                >
                                                    <FaServer size={11} /> Restart Node
                                                </button>
                                            </div>

                                            {/* Step 4 */}
                                            <div style={{
                                                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                                border: '1px solid rgba(16, 185, 129, 0.25)',
                                                borderRadius: 14,
                                                padding: '14px 18px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 16,
                                                transition: 'all 0.2s',
                                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                                    <div style={{
                                                        width: 38,
                                                        height: 38,
                                                        borderRadius: 10,
                                                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                                                        color: '#fff',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        fontWeight: 900,
                                                        fontSize: 14,
                                                        boxShadow: '0 4px 10px rgba(16, 185, 129, 0.35)',
                                                        flexShrink: 0
                                                    }}>
                                                        4
                                                    </div>
                                                    <div>
                                                        <div style={{ fontSize: 13, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            Re-enable Shard Allocation
                                                        </div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                            Resume shard allocation & auto-recover cluster health
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => runESAction('enable_allocation')}
                                                    style={{
                                                        background: 'rgba(16, 185, 129, 0.15)',
                                                        border: '1px solid #10b981',
                                                        color: '#a7f3d0',
                                                        borderRadius: 10,
                                                        padding: '8px 18px',
                                                        fontSize: 12,
                                                        fontWeight: 800,
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        whiteSpace: 'nowrap',
                                                        transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = '#10b981'; e.currentTarget.style.color = '#fff'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(16, 185, 129, 0.15)'; e.currentTarget.style.color = '#a7f3d0'; }}
                                                >
                                                    <FaPlayCircle size={11} /> Re-enable
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20, marginTop: 24 }}>
                                    <h4 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 16px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span>🛠️</span> Cluster Diagnostic & Shard Rerouting
                                    </h4>
                                    {role === 'Viewer' ? (
                                        <div className="text-secondary p-4 bg-black/20 rounded" style={{ fontSize: 13, border: '1px dashed var(--border-color)' }}>Operations are restricted.</div>
                                    ) : (
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                            <button 
                                                onClick={() => runESAction('explain')}
                                                style={{
                                                    background: 'rgba(245, 158, 11, 0.08)',
                                                    border: '1px solid rgba(245, 158, 11, 0.3)',
                                                    borderRadius: 12,
                                                    padding: '12px 16px',
                                                    color: '#f59e0b',
                                                    fontWeight: 800,
                                                    fontSize: 12,
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: 8,
                                                    transition: 'all 0.2s'
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.2)'; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'; }}
                                            >
                                                <FaInfoCircle size={13} /> Explain Allocation
                                            </button>
                                            <button 
                                                onClick={() => runESAction('reroute')}
                                                style={{
                                                    background: 'rgba(239, 68, 68, 0.08)',
                                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                                    borderRadius: 12,
                                                    padding: '12px 16px',
                                                    color: '#ef4444',
                                                    fontWeight: 800,
                                                    fontSize: 12,
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: 8,
                                                    transition: 'all 0.2s'
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; }}
                                            >
                                                <FaRandom size={13} /> Force Reroute Shards
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="glass-panel p-6 flex flex-col min-h-[400px] min-w-0">
                                <h4 className="mb-4 text-warning">Execution Results Console</h4>
                                <div className="flex-grow bg-black/40 p-4 rounded overflow-auto font-mono text-sm max-h-[60vh] max-w-full">
                                    {opsResult ? <pre className="text-success">{typeof opsResult === 'string' ? opsResult : JSON.stringify(opsResult, null, 2)}</pre> : <span className="text-secondary">Awaiting command dispatch...</span>}
                                </div>
                            </div>
                        </div>
                    )}

                    {tab === 'LOGSTASH' && hasLogstash && (
                        <div className="grid grid-cols-2 gap-6">
                            <div className="glass-panel p-6 flex flex-col items-center justify-center relative">
                                <div className="absolute top-4 left-6 right-6">
                                    <h4 className="text-warning mb-1">Logstash Deployment</h4>
                                    <p className="text-muted text-sm italic border-b border-warning/10 pb-2 mb-4 break-all">
                                        Source Directory: <span className="text-primary font-bold">{activeEnvData.ls_path}</span>
                                    </p>
                                </div>
                                <i className="fas fa-file-export text-6xl text-primary/30 mb-8 mt-12"></i>
                                <div className="w-full max-w-sm mb-6">
                                    <label className="text-warning block mb-2">Target Filter Directory (MUST exist on NAS)</label>
                                    <input type="text" placeholder="e.g. NBG_20220315" value={lsFolder} onChange={e => setLsFolder(e.target.value)} className="w-full text-center" disabled={role === 'Viewer'} />
                                </div>
                                {role !== 'Viewer' && <button className="btn btn-danger w-full max-w-sm" onClick={deployLogstash}>Copy *.conf from NAS to /etc/logstash/conf.d/</button>}
                            </div>

                            <div className="glass-panel p-6 flex flex-col min-h-[400px]">
                                <h4 className="mb-4 text-warning">SFTP Pipeline Logs</h4>
                                <div className="flex-grow bg-black/40 p-4 rounded overflow-auto font-mono text-sm max-h-[60vh]">
                                    {lsResult ? (
                                        lsResult.map((res, i) => (
                                            <div key={i} className="mb-4 pb-2 border-b border-white/10">
                                                <div className="font-bold text-success">{res.host}</div>
                                                {res.copied.length > 0 && <div className="text-secondary">Copied: {res.copied.join(', ')}</div>}
                                                {res.errors.length > 0 && <div className="text-danger">Failed: {res.errors.join(' | ')}</div>}
                                            </div>
                                        ))
                                    ) : <span className="text-secondary">Awaiting dispatch...</span>}
                                </div>
                            </div>
                        </div>
                    )}

                    {tab === 'TOOLS' && (
                        <div className="flex flex-col gap-6">
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <button 
                                    style={{
                                        padding: '8px 18px',
                                        borderRadius: 14,
                                        fontSize: 12,
                                        fontWeight: 800,
                                        cursor: 'pointer',
                                        border: 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        background: toolTab === 'INDEX' ? 'linear-gradient(135deg, var(--accent-primary) 0%, #2563eb 100%)' : 'rgba(255, 255, 255, 0.05)',
                                        color: toolTab === 'INDEX' ? '#fff' : 'var(--text-muted)',
                                        boxShadow: toolTab === 'INDEX' ? '0 4px 12px var(--accent-glow)' : 'none',
                                        transition: 'all 0.2s'
                                    }}
                                    onClick={() => setToolTab('INDEX')}
                                >
                                    <FaCode size={12} /> Index Create Builder
                                </button>
                                <button 
                                    style={{
                                        padding: '8px 18px',
                                        borderRadius: 14,
                                        fontSize: 12,
                                        fontWeight: 800,
                                        cursor: 'pointer',
                                        border: 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        background: toolTab === 'VIOLATION' ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' : 'rgba(255, 255, 255, 0.05)',
                                        color: toolTab === 'VIOLATION' ? '#fff' : 'var(--text-muted)',
                                        boxShadow: toolTab === 'VIOLATION' ? '0 4px 12px rgba(245, 158, 11, 0.3)' : 'none',
                                        transition: 'all 0.2s'
                                    }}
                                    onClick={() => setToolTab('VIOLATION')}
                                >
                                    <FaExclamationTriangle size={12} /> Lifecycle Violation
                                    {violationList.length > 0 && (
                                        <span style={{ background: '#ef4444', color: '#fff', fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 900, marginLeft: 4 }}>
                                            {violationList.length}
                                        </span>
                                    )}
                                </button>
                                {role === 'SuperAdmin' && (
                                    <button 
                                        style={{
                                            padding: '8px 18px',
                                            borderRadius: 14,
                                            fontSize: 12,
                                            fontWeight: 800,
                                            cursor: 'pointer',
                                            border: 'none',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            background: toolTab === 'DEL' ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' : 'rgba(239, 68, 68, 0.1)',
                                            color: toolTab === 'DEL' ? '#fff' : '#ef4444',
                                            boxShadow: toolTab === 'DEL' ? '0 4px 12px rgba(239, 68, 68, 0.3)' : 'none',
                                            transition: 'all 0.2s'
                                        }}
                                        onClick={() => setToolTab('DEL')}
                                    >
                                        <FaTrashAlt size={12} /> _delete_by_query Engine
                                    </button>
                                )}
                            </div>

                            {toolTab === 'INDEX' && (
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                        <div style={{ marginBottom: 18 }}>
                                            <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span>🏗️</span> Index Template & ILM Creator
                                            </h4>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Generate and configure ILM rollover policies for <strong style={{ color: '#facc15' }}>{activeEnv}</strong>
                                            </div>
                                        </div>

                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Index Name (Alias)</label>
                                                <input type="text" value={idxName} onChange={handleIdxNameChange} placeholder="cwd-vault-log" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Index Template Name</label>
                                                <input type="text" value={idxTemplate} onChange={e => setIdxTemplate(e.target.value)} placeholder="cwd-vault-log-template" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Index Patterns</label>
                                                <input type="text" value={idxPattern} onChange={e => setIdxPattern(e.target.value)} placeholder="cwd-vault-log-*" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Lifecycle Policy applied</label>
                                                <select value={idxPolicy} onChange={e => setIdxPolicy(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }}>
                                                    <option value="" style={{ background: '#1e293b' }}>-- Select ILM Policy --</option>
                                                    {getPolicies().map(p => <option key={p} value={p} style={{ background: '#1e293b' }}>{p}</option>)}
                                                </select>
                                                {renderIlmPreview()}
                                            </div>
                                            <div style={{ display: 'flex', gap: 12, paddingTop: 6 }}>
                                                <button 
                                                    onClick={generateIndex}
                                                    style={{
                                                        flex: 1,
                                                        padding: '10px 16px',
                                                        borderRadius: 12,
                                                        background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                                                        color: '#fff',
                                                        border: 'none',
                                                        fontWeight: 800,
                                                        fontSize: 13,
                                                        cursor: 'pointer',
                                                        boxShadow: '0 4px 12px rgba(245, 158, 11, 0.25)',
                                                        transition: 'all 0.2s'
                                                    }}
                                                >
                                                    ⚡ Generate JSON Body
                                                </button>
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        onClick={deployIndexTemplate}
                                                        disabled={isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy}
                                                        style={{
                                                            flex: 1,
                                                            padding: '10px 16px',
                                                            borderRadius: 12,
                                                            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                                                            color: '#fff',
                                                            border: 'none',
                                                            fontWeight: 800,
                                                            fontSize: 13,
                                                            cursor: (isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy) ? 'not-allowed' : 'pointer',
                                                            opacity: (isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy) ? 0.6 : 1,
                                                            boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            gap: 6
                                                        }}
                                                        title={`Directly deploy to ${activeEnv} Elasticsearch cluster`}
                                                    >
                                                        <FaRocket size={12} /> {isDeployingIndex ? 'Deploying...' : `Deploy to ${activeEnv || 'Cluster'}`}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="glass-panel p-0 flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                        <div style={{ padding: '12px 18px', background: 'rgba(0, 0, 0, 0.4)', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                    Elasticsearch Payload Preview & Dispatch
                                                </span>
                                                <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)', fontWeight: 700 }}>
                                                    可編輯微調
                                                </span>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                {idxOutput && (
                                                    <button 
                                                        style={{
                                                            background: isCopied ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                                                            border: isCopied ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.15)',
                                                            color: isCopied ? '#34d399' : '#fff',
                                                            padding: '5px 12px',
                                                            borderRadius: 8,
                                                            fontSize: 11,
                                                            fontWeight: 700,
                                                            cursor: 'pointer',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 4,
                                                            transition: 'all 0.2s'
                                                        }}
                                                        onClick={() => copyToClipboard(idxOutput)}
                                                    >
                                                        {isCopied ? <FaCheckCircle size={10} /> : <FaCopy size={10} />}
                                                        {isCopied ? 'Copied!' : 'Copy Script'}
                                                    </button>
                                                )}
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        style={{ background: '#10b981', border: 'none', color: '#fff', padding: '5px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: (isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy) ? 'not-allowed' : 'pointer', opacity: (isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }}
                                                        onClick={deployIndexTemplate}
                                                        disabled={isDeployingIndex || !idxName || !idxTemplate || !idxPattern || !idxPolicy}
                                                    >
                                                        <FaRocket size={10} /> Deploy Directly
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <textarea 
                                            value={idxOutput} 
                                            onChange={(e) => setIdxOutput(e.target.value)}
                                            spellCheck={false}
                                            className="code-editor p-4 text-xs flex-grow" 
                                            style={{ 
                                                background: 'rgba(0,0,0,0.3)', 
                                                border: 'none', 
                                                outline: 'none', 
                                                color: '#38bdf8', 
                                                fontFamily: 'monospace',
                                                lineHeight: 1.5,
                                                minHeight: 280,
                                                resize: 'vertical'
                                            }} 
                                            placeholder="點擊「Generate JSON Body」產出腳本，或直接在此輸入 / 貼上微調內容..."
                                        />
                                        {deployIndexResult && (
                                            <div style={{ padding: 14, background: 'rgba(0, 0, 0, 0.6)', borderTop: '1px solid rgba(255, 255, 255, 0.1)', maxHeight: 160, overflow: 'auto', fontSize: 11, fontFamily: 'monospace' }}>
                                                <div style={{ fontWeight: 800, color: '#10b981', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                    <span>⚡ Deployment Dispatch Logs:</span>
                                                    <button style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setDeployIndexResult(null)}>✖ Clear</button>
                                                </div>
                                                <pre style={{ margin: 0, color: 'var(--text-secondary)', overflow: 'auto' }}>{JSON.stringify(deployIndexResult, null, 2)}</pre>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {toolTab === 'VIOLATION' && (
                                <div className="flex flex-col gap-6">
                                    {/* Configuration & Trigger Bar */}
                                    <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                        <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                                            <div>
                                                <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ color: '#f59e0b' }}>⚠️</span> Index Lifecycle Policy Violation Scanner
                                                </h4>
                                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    Periodically queries indices on <strong style={{ color: '#facc15' }}>{activeEnv}</strong> to detect unmanaged indices without an ILM lifecycle policy.
                                                </div>
                                            </div>
                                            {violationStats.lastScanTime && (
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                                                    <span>Last Scanned: </span>
                                                    <strong style={{ color: '#38bdf8' }}>{new Date(violationStats.lastScanTime).toLocaleString()}</strong>
                                                    <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800, background: violationStats.lastScanStatus === 'Success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: violationStats.lastScanStatus === 'Success' ? '#10b981' : '#ef4444' }}>
                                                        {violationStats.lastScanStatus}
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'flex-end' }}>
                                            <div style={{ flex: 2 }}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>
                                                    Target Index Pattern(s) <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(e.g. cwd-*, logstash-*, or * for all)</span>
                                                </label>
                                                <input 
                                                    type="text" 
                                                    value={violationPattern} 
                                                    onChange={e => setViolationPattern(e.target.value)} 
                                                    placeholder="cwd-*, logstash-*" 
                                                    style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} 
                                                />
                                            </div>

                                            <div style={{ minWidth: 180 }}>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>
                                                    Periodic Scan Frequency
                                                </label>
                                                <select 
                                                    value={violationSchedule} 
                                                    onChange={e => setViolationSchedule(e.target.value)} 
                                                    style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }}
                                                >
                                                    <option value="1 day" style={{ background: '#1e293b' }}>Every 1 Day (Daily)</option>
                                                    <option value="7 day" style={{ background: '#1e293b' }}>Every 7 Days (Weekly)</option>
                                                    <option value="30 day" style={{ background: '#1e293b' }}>Every 30 Days (Monthly)</option>
                                                    <option value="disabled" style={{ background: '#1e293b' }}>Disabled (Manual Only)</option>
                                                </select>
                                            </div>

                                            <div style={{ display: 'flex', gap: 10 }}>
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        onClick={handleSaveViolationSchedule} 
                                                        disabled={isSavingSchedule}
                                                        style={{
                                                            padding: '10px 18px',
                                                            borderRadius: 12,
                                                            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                                                            color: '#fff',
                                                            border: 'none',
                                                            fontWeight: 800,
                                                            fontSize: 13,
                                                            cursor: isSavingSchedule ? 'not-allowed' : 'pointer',
                                                            opacity: isSavingSchedule ? 0.7 : 1,
                                                            boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
                                                            whiteSpace: 'nowrap'
                                                        }}
                                                    >
                                                        {isSavingSchedule ? 'Saving...' : '💾 Save Schedule'}
                                                    </button>
                                                )}
                                                <button 
                                                    onClick={handleScanViolations} 
                                                    disabled={isScanningViolations}
                                                    style={{
                                                        padding: '10px 20px',
                                                        borderRadius: 12,
                                                        background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                                                        color: '#fff',
                                                        border: 'none',
                                                        fontWeight: 800,
                                                        fontSize: 13,
                                                        cursor: isScanningViolations ? 'not-allowed' : 'pointer',
                                                        opacity: isScanningViolations ? 0.7 : 1,
                                                        boxShadow: '0 4px 12px rgba(245, 158, 11, 0.3)',
                                                        whiteSpace: 'nowrap',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6
                                                    }}
                                                >
                                                    <FaSyncAlt className={isScanningViolations ? 'animate-spin' : ''} size={12} />
                                                    {isScanningViolations ? 'Scanning Cluster...' : '⚡ Scan Violations Now'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Stats Counters */}
                                    <div className="grid grid-cols-4 gap-4">
                                        <div className="glass-panel p-4" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase' }}>Indices Checked</div>
                                            <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>{violationStats.totalChecked}</div>
                                        </div>
                                        <div className="glass-panel p-4" style={{ background: violationList.length > 0 ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-glass)', border: `1px solid ${violationList.length > 0 ? 'rgba(239, 68, 68, 0.4)' : 'var(--border-color)'}`, borderRadius: 16 }}>
                                            <div style={{ fontSize: 11, color: violationList.length > 0 ? '#f87171' : 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase' }}>Violations Detected</div>
                                            <div style={{ fontSize: 24, fontWeight: 900, color: violationList.length > 0 ? '#ef4444' : '#10b981', marginTop: 4 }}>{violationList.length}</div>
                                        </div>
                                        <div className="glass-panel p-4" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase' }}>Scan Frequency</div>
                                            <div style={{ fontSize: 20, fontWeight: 800, color: '#38bdf8', marginTop: 4 }}>{violationSchedule}</div>
                                        </div>
                                        <div className="glass-panel p-4" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 }}>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase' }}>Selected for Action</div>
                                            <div style={{ fontSize: 24, fontWeight: 900, color: selectedViolations.length > 0 ? '#f59e0b' : 'var(--text-muted)', marginTop: 4 }}>{selectedViolations.length}</div>
                                        </div>
                                    </div>

                                    {/* Violations Data Table */}
                                    <div className="glass-panel p-6" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <h5 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                                                    Unmanaged Indices Missing Lifecycle Policy ({violationList.length})
                                                </h5>
                                            </div>

                                            {selectedViolations.length > 0 && role !== 'Viewer' && (
                                                <button
                                                    onClick={() => handleDeleteViolationIndices(selectedViolations)}
                                                    disabled={isDeletingViolations}
                                                    style={{
                                                        padding: '8px 16px',
                                                        borderRadius: 10,
                                                        background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                                        color: '#fff',
                                                        border: 'none',
                                                        fontWeight: 800,
                                                        fontSize: 12,
                                                        cursor: isDeletingViolations ? 'not-allowed' : 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)'
                                                    }}
                                                >
                                                    <FaTrashAlt size={12} />
                                                    {isDeletingViolations ? 'Deleting...' : `Delete Selected (${selectedViolations.length})`}
                                                </button>
                                            )}
                                        </div>

                                        {violationList.length === 0 ? (
                                            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                                                <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
                                                <div style={{ fontSize: 14, fontWeight: 800, color: '#10b981' }}>No Lifecycle Violations Found</div>
                                                <div style={{ fontSize: 12, marginTop: 4 }}>
                                                    All indices matching pattern "{violationPattern || '*'}" on {activeEnv} have active ILM policies attached.
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', color: 'var(--text-muted)', textAlign: 'left' }}>
                                                            {role !== 'Viewer' && (
                                                                <th style={{ padding: '10px 12px', width: 36 }}>
                                                                    <input 
                                                                        type="checkbox" 
                                                                        checked={selectedViolations.length === violationList.length && violationList.length > 0} 
                                                                        onChange={toggleSelectAllViolations}
                                                                        style={{ cursor: 'pointer' }}
                                                                    />
                                                                </th>
                                                            )}
                                                            <th style={{ padding: '10px 12px' }}>Index Name</th>
                                                            <th style={{ padding: '10px 12px' }}>Health</th>
                                                            <th style={{ padding: '10px 12px' }}>Docs Count</th>
                                                            <th style={{ padding: '10px 12px' }}>Storage Size</th>
                                                            <th style={{ padding: '10px 12px' }}>Creation Date</th>
                                                            <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {violationList.map((item) => {
                                                            const isSelected = selectedViolations.includes(item.index);
                                                            return (
                                                                <tr 
                                                                    key={item.index} 
                                                                    style={{ 
                                                                        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                                                                        background: isSelected ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                                                                        transition: 'background 0.2s'
                                                                    }}
                                                                >
                                                                    {role !== 'Viewer' && (
                                                                        <td style={{ padding: '10px 12px' }}>
                                                                            <input 
                                                                                type="checkbox" 
                                                                                checked={isSelected} 
                                                                                onChange={() => toggleSelectViolation(item.index)}
                                                                                style={{ cursor: 'pointer' }}
                                                                            />
                                                                        </td>
                                                                    )}
                                                                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 700, color: '#38bdf8' }}>
                                                                        {item.index}
                                                                    </td>
                                                                    <td style={{ padding: '10px 12px' }}>
                                                                        <span style={{ 
                                                                            padding: '2px 8px', 
                                                                            borderRadius: 6, 
                                                                            fontSize: 10, 
                                                                            fontWeight: 800,
                                                                            background: item.health === 'green' ? 'rgba(16, 185, 129, 0.2)' : item.health === 'yellow' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                                                                            color: item.health === 'green' ? '#10b981' : item.health === 'yellow' ? '#f59e0b' : '#ef4444'
                                                                        }}>
                                                                            {item.health}
                                                                        </span>
                                                                    </td>
                                                                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                                                                        {Number(item.docsCount || 0).toLocaleString()}
                                                                    </td>
                                                                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                                                                        {item.storeSize}
                                                                    </td>
                                                                    <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                                                                        {item.creationDate ? new Date(item.creationDate).toLocaleString() : 'N/A'}
                                                                    </td>
                                                                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                                                                        {role !== 'Viewer' ? (
                                                                            <button 
                                                                                onClick={() => handleDeleteViolationIndices(item.index)}
                                                                                disabled={isDeletingViolations}
                                                                                style={{
                                                                                    padding: '5px 12px',
                                                                                    borderRadius: 8,
                                                                                    background: 'rgba(239, 68, 68, 0.15)',
                                                                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                                                                    color: '#ef4444',
                                                                                    fontSize: 11,
                                                                                    fontWeight: 800,
                                                                                    cursor: 'pointer',
                                                                                    display: 'inline-flex',
                                                                                    alignItems: 'center',
                                                                                    gap: 4,
                                                                                    transition: 'all 0.2s'
                                                                                }}
                                                                                onMouseEnter={e => { e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.color = '#fff'; }}
                                                                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'; e.currentTarget.style.color = '#ef4444'; }}
                                                                            >
                                                                                <FaTrashAlt size={10} /> Delete
                                                                            </button>
                                                                        ) : (
                                                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Read Only</span>
                                                                        )}
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
                            )}

                            {toolTab === 'DEL' && (
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="glass-panel p-6" style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(0, 0, 0, 0.4) 100%)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 20 }}>
                                        <div style={{ marginBottom: 18 }}>
                                            <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span>⚠️</span> Danger Zone: Execute _delete_by_query
                                            </h4>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Warning: Executed directly against <strong style={{ color: '#facc15' }}>{activeEnv}</strong> cluster. Operations cannot be undone.
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Index Name</label>
                                                <input type="text" value={delIndex} onChange={e => setDelIndex(e.target.value)} placeholder="e.g. system-log-*" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>Start Range (dd/MM/yyyy)</label>
                                                <input type="text" value={delStart} onChange={e => setDelStart(e.target.value)} placeholder="01/01/2023" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <div>
                                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' }}>End Range (dd/MM/yyyy)</label>
                                                <input type="text" value={delEnd} onChange={e => setDelEnd(e.target.value)} placeholder="31/01/2023" style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 13 }} />
                                            </div>
                                            <button 
                                                onClick={execDeleteByQuery} 
                                                disabled={!delIndex || !delStart || !delEnd}
                                                style={{
                                                    padding: '10px 16px',
                                                    borderRadius: 12,
                                                    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                                    color: '#fff',
                                                    border: 'none',
                                                    fontWeight: 800,
                                                    fontSize: 13,
                                                    cursor: (!delIndex || !delStart || !delEnd) ? 'not-allowed' : 'pointer',
                                                    opacity: (!delIndex || !delStart || !delEnd) ? 0.6 : 1,
                                                    boxShadow: '0 4px 12px rgba(239, 68, 68, 0.35)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: 6
                                                }}
                                            >
                                                <FaTrashAlt size={12} /> Execute Purge Task
                                            </button>
                                        </div>
                                    </div>
                                    <div className="glass-panel p-6 flex flex-col min-h-[400px]" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20 }}>
                                        <h4 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 16px 0', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span>⚡</span> API Dispatch Result
                                        </h4>
                                        <div style={{ flexGrow: 1, background: 'rgba(0, 0, 0, 0.4)', padding: 16, borderRadius: 12, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, maxHeight: '60vh', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                                            {delResult ? <pre style={{ margin: 0, color: '#10b981' }}>{JSON.stringify(delResult, null, 2)}</pre> : <span style={{ color: 'var(--text-muted)' }}>Ready for purge command dispatch...</span>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'SIEM' && (
                        <div className="flex flex-col gap-6 animate-fade-in">
                            {/* SIEM Metrics Trend Gauges */}
                            <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
                                <div className="glass-panel" style={{ flex: 1.2, padding: '20px 24px', background: topThreat && topThreat.hits > 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255,255,255,0.02)', border: '1px solid ' + (topThreat && topThreat.hits > 0 ? 'rgba(239, 68, 68, 0.25)' : 'var(--border-color)'), borderRadius: 16, display: 'flex', alignItems: 'center', gap: 20 }}>
                                    <div style={{ fontSize: 36, color: topThreat && topThreat.hits > 0 ? '#ef4444' : '#10b981' }}>
                                        {topThreat && topThreat.hits > 0 ? <FaExclamationTriangle /> : <FaCheckCircle />}
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                            {topThreat && topThreat.hits > 0 ? 'Top Threat Triggered Today' : 'System Status'}
                                        </div>
                                        <div style={{ fontSize: 16, fontWeight: 900, color: topThreat && topThreat.hits > 0 ? 'var(--danger)' : 'var(--success)', marginTop: 4 }}>
                                            {topThreat ? topThreat.name : 'Analyzing threats...'}
                                        </div>
                                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                                            {topThreat && topThreat.hits > 0 ? (
                                                <>Trigger count: <strong style={{ color: 'var(--danger)', fontSize: 13 }}>{topThreat.hits} times</strong> {topThreat.eventIds && `| Event IDs: ${topThreat.eventIds}`}</>
                                            ) : (
                                                'All monitored logs are within normal thresholds.'
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="glass-panel" style={{ flex: 0.8, padding: '20px 24px', background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: 16, display: 'flex', alignItems: 'center', gap: 20 }}>
                                    <div style={{ fontSize: 36, color: '#10b981' }}><FaShieldAlt /></div>
                                    <div>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Active Policy Rules</div>
                                        <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>
                                            {siemConfig.tasks.filter(t => t.enabled).length} <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>Active SIEM Rules</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="glass-panel p-6 mb-6">
                                <div className="flex justify-between items-center mb-6">
                                    <h4 className="text-xl font-bold flex items-center gap-2">🚨 SIEM Polling Engine (winlogbeat)</h4>
                                    <div className="flex items-center gap-4">
                                        <label className="flex items-center cursor-pointer gap-2 mr-6">
                                            <div className="relative">
                                                <input type="checkbox" className="sr-only" checked={siemConfig.enabled} onChange={toggleSiem} disabled={role === 'Viewer'} />
                                                <div className={`block w-14 h-8 rounded-full ${siemConfig.enabled ? 'bg-success' : 'bg-gray-600'} ${role === 'Viewer' ? 'opacity-50' : ''}`}></div>
                                                <div className={`dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition transform ${siemConfig.enabled ? 'translate-x-6' : ''}`}></div>
                                            </div>
                                            <span className="font-bold">{siemConfig.enabled ? 'ENGINE ONLINE' : 'ENGINE OFFLINE'}</span>
                                        </label>
                                        {role !== 'Viewer' && <button className="btn btn-primary" onClick={() => saveSiemConfig(siemConfig)}>💾 Save All</button>}
                                    </div>
                                </div>

                                {role === 'Viewer' && <div className="text-secondary p-4 bg-black/20 rounded mb-4">SIEM Configuration is read-only for Viewers.</div>}

                                <div className={`space-y-4 ${role === 'Viewer' ? 'pointer-events-none opacity-80' : ''}`}>
                                    {siemConfig.tasks.map((task, idx) => (
                                        <div key={task.id} className="bg-black/30 p-4 rounded border border-white/10 flex items-center justify-between gap-6">

                                            <div className="flex items-center gap-6 flex-grow">
                                                <input type="checkbox" checked={task.enabled} onChange={e => {
                                                    const t = [...siemConfig.tasks]; t[idx].enabled = e.target.checked; setSiemConfig({ ...siemConfig, tasks: t });
                                                }} className="cursor-pointer" style={{ width: '24px', height: '24px', flexShrink: 0 }} title="Enable Task" />

                                                <div className="flex flex-col gap-3 flex-grow max-w-2xl">
                                                    <div className="flex gap-4 items-center">
                                                        <div className="flex flex-col gap-1 flex-grow">
                                                            <input type="text" placeholder="Task Name" value={task.name} className="bg-black/40 border border-white/20 p-2 rounded text-sm w-full outline-none focus:border-accent-primary focus:ring-1" onChange={e => {
                                                                const t = [...siemConfig.tasks]; t[idx].name = e.target.value; setSiemConfig({ ...siemConfig, tasks: t });
                                                            }} />
                                                        </div>
                                                        <div className="flex flex-col gap-1 w-48 flex-shrink-0">
                                                            <select value={task.env} className="bg-black/40 border border-white/20 p-2 rounded text-sm outline-none focus:border-accent-primary focus:ring-1" onChange={e => {
                                                                const t = [...siemConfig.tasks]; t[idx].env = e.target.value; setSiemConfig({ ...siemConfig, tasks: t });
                                                            }}>
                                                                <option value="ALL">Global (All Envs)</option>
                                                                {envs.map(e => <option key={e} value={e}>{e}</option>)}
                                                            </select>
                                                        </div>
                                                        <div className="flex flex-col gap-1 w-32 flex-shrink-0">
                                                            <div className="flex items-center bg-black/40 border border-white/20 rounded focus-within:border-accent-primary focus-within:ring-1 w-full relative">
                                                                <input type="number" min="1" max="1440" value={task.interval || 10} onChange={e => { const t = [...siemConfig.tasks]; t[idx].interval = parseInt(e.target.value, 10) || 10; setSiemConfig({ ...siemConfig, tasks: t }); }} className="bg-transparent border-0 text-center outline-none w-full text-warning font-bold p-2 pr-12 text-sm" style={{ MozAppearance: 'textfield' }} />
                                                                <span className="text-xs font-bold text-secondary absolute right-3 pointer-events-none">MINS</span>
                                                            </div>
                                                        </div>
                                                        <div className="flex flex-col gap-1 w-32 flex-shrink-0">
                                                            <div className="flex items-center bg-black/40 border border-white/20 rounded focus-within:border-accent-primary focus-within:ring-1 w-full relative">
                                                                <input type="number" min="1" value={task.threshold || 1} onChange={e => { const t = [...siemConfig.tasks]; t[idx].threshold = parseInt(e.target.value, 10) || 1; setSiemConfig({ ...siemConfig, tasks: t }); }} className="bg-transparent border-0 text-center outline-none w-full text-success font-bold p-2 pr-12 text-sm" style={{ MozAppearance: 'textfield' }} />
                                                                <span className="text-xs font-bold text-secondary absolute right-3 pointer-events-none">HITS</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col gap-1 relative">
                                                        <input type="text" placeholder={task.type === 'rdp_login' ? 'Locked to 4624 + LogonType 10' : 'Event IDs (e.g. 4624, 4625)'} value={task.eventIds} disabled={task.type === 'rdp_login'} className={`bg-black/40 border border-white/20 p-2 rounded text-sm w-full outline-none focus:border-accent-primary focus:ring-1 ${task.type === 'rdp_login' ? 'opacity-50 italic' : ''}`} onChange={e => {
                                                            const t = [...siemConfig.tasks]; t[idx].eventIds = e.target.value; setSiemConfig({ ...siemConfig, tasks: t });
                                                        }} />
                                                        {task.type !== 'custom' && <span className="absolute right-3 top-2 text-[10px] text-accent-primary font-bold opacity-70 uppercase tracking-tighter">Template Mode: {task.type}</span>}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-6 flex-shrink-0">
                                                <div className="flex flex-col gap-3 border-l border-white/10 pl-6">
                                                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none whitespace-nowrap"><input type="checkbox" checked={task.enableMail} onChange={e => { const t = [...siemConfig.tasks]; t[idx].enableMail = e.target.checked; setSiemConfig({ ...siemConfig, tasks: t }); }} style={{ width: '16px', height: '16px', flexShrink: 0 }} /> 📧 Email</label>
                                                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none whitespace-nowrap"><input type="checkbox" checked={task.enableTelegram} onChange={e => { const t = [...siemConfig.tasks]; t[idx].enableTelegram = e.target.checked; setSiemConfig({ ...siemConfig, tasks: t }); }} style={{ width: '16px', height: '16px', flexShrink: 0 }} /> 📱 Telegram</label>
                                                </div>

                                                <div className="flex flex-col gap-2 border-l border-white/10 pl-6">
                                                    <button className="btn btn-outline border-warning text-warning font-bold flex items-center justify-center gap-2" onClick={() => testRunSiemTask(task)} title="Catch Once" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', width: '110px' }}>🎯 Catch</button>
                                                    {role !== 'Viewer' && (
                                                        <button className="btn btn-outline border-danger text-danger font-bold flex items-center justify-center gap-2" onClick={() => {
                                                            setConfirmAction({
                                                                title: 'Delete Task',
                                                                message: `Delete SIEM task: ${task.name}?`,
                                                                isDanger: true,
                                                                onConfirm: () => {
                                                                    setConfirmAction(null);
                                                                    setSiemConfig({ ...siemConfig, tasks: siemConfig.tasks.filter((_, i) => i !== idx) });
                                                                }
                                                            });
                                                        }} title="Delete Task" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', width: '110px' }}>🗑️ Delete</button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    <div className="mt-12 pt-8 border-t border-white/10">
                                        <div className="flex items-center gap-4">
                                            <div className="flex flex-col">
                                                <span className="text-secondary text-[10px] italic">Add SIEM Task</span>
                                            </div>

                                            <div className="relative w-72">
                                                <select
                                                    defaultValue=""
                                                    className="w-full bg-[#111827] border-2 border-primary/50 text-white p-2 rounded-lg outline-none focus:border-primary transition-all cursor-pointer font-bold"
                                                    onChange={(e) => {
                                                        if (e.target.value) {
                                                            addSiemTask(e.target.value);
                                                            e.target.value = ""; // Reset after adding
                                                        }
                                                    }}
                                                >
                                                    <option value="" disabled>--- Select Security Template ---</option>
                                                    <option value="custom" title="For manual event ID monitoring.">➕ Custom Monitor</option>
                                                    <option value="escalation" title="4728 / 4732: Permission escalation detection.">🛡️ Group Escalation</option>
                                                    <option value="log_cleared" title="1102: Detection for log clearing events.">⚠️ Log Cleared</option>
                                                    <option value="new_service" title="7045: Notification for new service installations.">⚙️ New Service</option>
                                                    <option value="rdp_login" title="4624 (RDP): Specialized rule for RDP logins.">🔑 RDP Login (Type 10)</option>
                                                    <option value="ps_attack" title="4104 / 4103: Monitoring for PowerShell command attacks.">🐚 PS Attack</option>
                                                </select>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {siemTestResult && (
                                <div className="glass-panel p-6 flex flex-col mb-6 border border-warning relative">
                                    <button className="absolute top-2 right-4 text-secondary hover:text-white font-bold" onClick={() => setSiemTestResult(null)}>✖</button>
                                    <h4 className="mb-4 text-warning">🎯 Catch Once Execution Results</h4>
                                    <div className="flex-grow bg-black/40 p-4 rounded overflow-auto font-mono text-sm max-h-[60vh]">
                                        {siemTestResult.map((res, i) => (
                                            <div key={i} className="mb-6 pb-4 border-b border-white/10 last:border-b-0">
                                                <div className="font-bold text-lg mb-2">Environment: <span className="text-accent-primary">{res.env}</span></div>
                                                <div className="mb-2">Status: <span className={res.status === 'Success' ? 'text-success' : 'text-danger'}>{res.status}</span></div>
                                                {res.status === 'Success' && (
                                                    <>
                                                        <div className="mb-2 font-bold flex gap-4">
                                                            <span>Total Hits (Last {siemTestTask?.interval}m): <span className="text-warning text-xl">{res.hits}</span></span>
                                                            <span className="text-secondary">(Threshold: {siemTestTask?.threshold || 1})</span>
                                                        </div>
                                                        {res.samples && res.samples.length > 0 && (
                                                            <div className="text-xs text-secondary mt-2 bg-black/30 p-2 rounded">
                                                                <div className="mb-1 text-white underline">Latest Samples:</div>
                                                                {res.samples.map((s, j) => <div key={j} className="mb-1">{s}</div>)}
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {/* END SIEM TAB JSX (Truncated in diff view) */}
                        </div>
                    )}
                </>
            )}

            {/* Compact SSH Auth Modal for Health Tab */}
            {showAuthModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 20 }}>
                    <div style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, width: '100%', maxWidth: 360, padding: 24, textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
                        <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px 0', color: '#fff' }}>Authentication Required</h3>
                        <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 20px 0', lineHeight: 1.5 }}>
                            Checking disk usage requires SSH privileges.
                        </p>
                        <form onSubmit={(e) => {
                            e.preventDefault();
                            setLinuxPassword(tempPassword);
                            setShowAuthModal(false);
                            setTimeout(() => {
                                WrapLoad(`Checking disks via SSH on all ${activeEnv} nodes...`, async () => {
                                    const res = await api.post('/elk/disk', { env: activeEnv, linuxPassword: tempPassword });
                                    setDiskData(res.data);
                                });
                            }, 50);
                        }}>
                            <input
                                type="password"
                                placeholder={`Enter password...`}
                                value={tempPassword}
                                onChange={(e) => setTempPassword(e.target.value)}
                                autoFocus
                                style={{ boxSizing: 'border-box', width: '100%', padding: '10px 14px', borderRadius: 8, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: 13, marginBottom: 16, outline: 'none' }}
                            />
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button type="button" onClick={() => setShowAuthModal(false)} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#cbd5e1', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                                <button type="submit" disabled={!tempPassword} style={{ flex: 1, padding: '10px', background: '#3b82f6', border: 'none', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: tempPassword ? 1 : 0.5 }}>Submit</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {/* Custom Confirmation Modal */}
            {confirmAction && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 20 }}>
                    <div style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, width: '100%', maxWidth: 360, padding: 24, textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>{confirmAction.isDanger ? '⚠️' : '❓'}</div>
                        <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px 0', color: '#fff' }}>{confirmAction.title}</h3>
                        <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 24px 0', lineHeight: 1.5 }}>
                            {confirmAction.message}
                        </p>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => setConfirmAction(null)} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#cbd5e1', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                            <button onClick={confirmAction.onConfirm} style={{ flex: 1, padding: '10px', background: confirmAction.isDanger ? '#ef4444' : '#3b82f6', border: 'none', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Confirm</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Info Modal */}
            {infoModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
                    <div style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, width: '100%', maxWidth: 400, overflow: 'hidden', display: 'flex', flexDirection: 'column', textAlign: 'center', padding: 24, boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>{infoModal.type === 'success' ? '✅' : '❌'}</div>
                        <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px 0', color: infoModal.type === 'success' ? '#4ade80' : '#f87171' }}>{infoModal.title}</h3>
                        <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 24px 0', lineHeight: 1.5 }}>
                            {infoModal.message}
                        </p>
                        <button onClick={() => setInfoModal(null)} style={{ padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Close</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ELKManager;
