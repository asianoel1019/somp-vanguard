import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { normalizeEnvs, defaultEnv } from '../../utils/environments';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    btnBack: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 12, fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    metUnit: { fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' },
    tr: { borderBottom: '1px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--accent-primary)', border: '1px solid var(--accent-primary)' },
    badgeSuccess: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' },
    badgeDanger: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' },
    badgeWarning: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' },
    viewBtn: { padding: '8px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer', letterSpacing: '0.04em', boxShadow: '0 4px 12px var(--accent-glow)' },
    delBtn: { padding: '8px 18px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 550, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', display: 'block' },
    tabRow: { display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '0 4px' },
    tabBtn: { padding: '16px 20px', background: 'none', border: 'none', fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', cursor: 'pointer', borderBottom: '2px solid transparent', position: 'relative', top: 1 },
    tabBtnActive: { color: 'var(--accent-primary)', borderBottomColor: 'var(--accent-primary)' },
    detailsCard: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
};

const KubernetesManager = ({ setIsProcessing }) => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    
    const [clusters, setClusters] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [clusterSearch, setClusterSearch] = useState('');
    const [clusterSort, setClusterSort] = useState({ key: 'name', dir: 'asc' });
    const [selectedEnv, setSelectedEnv] = useState(null);
    const [hoveredEnv, setHoveredEnv] = useState(null);

    // Active Cluster View State
    const [activeCluster, setActiveCluster] = useState(null);
    const [clusterError, setClusterError] = useState(null);
    const [tab, setTab] = useState('DASHBOARD');
    const [nodes, setNodes] = useState([]);
    const [namespaces, setNamespaces] = useState([]);
    const [activeNamespace, setActiveNamespace] = useState('default');
    const [pods, setPods] = useState([]);
    const [deployments, setDeployments] = useState([]);
    const [events, setEvents] = useState([]);

    const [showLogsModal, setShowLogsModal] = useState(false);
    const [logsContent, setLogsContent] = useState('');
    const [activePodLogs, setActivePodLogs] = useState(null);
    const [logContainer, setLogContainer] = useState('');
    const [logPodContainers, setLogPodContainers] = useState([]);
    const [logTailLines, setLogTailLines] = useState(500);
    const [logTimestamps, setLogTimestamps] = useState(false);
    const [logSearch, setLogSearch] = useState('');
    const [logAutoFollow, setLogAutoFollow] = useState(false);

    // Node SSH Diagnosis State (P1)
    const [showNodeDiagModal, setShowNodeDiagModal] = useState(false);
    const [activeDiagNode, setActiveDiagNode] = useState(null);
    const [diagCommandKey, setDiagCommandKey] = useState('kubelet_status');
    const [diagCustomCmd, setDiagCustomCmd] = useState('');
    const [diagPassword, setDiagPassword] = useState('');
    const [diagOutput, setDiagOutput] = useState('');
    const [diagLoading, setDiagLoading] = useState(false);
    const [diagError, setDiagError] = useState('');

    // Pod Web Exec Terminal State (P2)
    const [showExecModal, setShowExecModal] = useState(false);
    const [activeExecPod, setActiveExecPod] = useState(null);
    const [execContainer, setExecContainer] = useState('');
    const [execCommand, setExecCommand] = useState('');
    const [execHistory, setExecHistory] = useState([]);
    const [execHistoryIdx, setExecHistoryIdx] = useState(-1);
    const [execOutput, setExecOutput] = useState([]);
    const [execLoading, setExecLoading] = useState(false);

    const [showYamlModal, setShowYamlModal] = useState(false);
    const [yamlContent, setYamlContent] = useState('');

    const [showScaleModal, setShowScaleModal] = useState(false);
    const [scaleData, setScaleData] = useState({ deploymentName: '', replicas: 1 });

    const [showRolloutModal, setShowRolloutModal] = useState(false);
    const [rolloutData, setRolloutData] = useState({ deploymentName: '', history: [] });

    // P3: Prometheus & Metrics State
    const [metricsData, setMetricsData] = useState(null);
    const [clusterAlerts, setClusterAlerts] = useState([]);
    const [metricsLoading, setMetricsLoading] = useState(false);

    // P4: Networking (Services & Ingresses) and Storage & ConfigMaps
    const [services, setServices] = useState([]);
    const [ingresses, setIngresses] = useState([]);
    const [clusterDomain, setClusterDomain] = useState('');
    const [gatewayUrl, setGatewayUrl] = useState('');
    const [pvcs, setPvcs] = useState([]);
    const [pvs, setPvs] = useState([]);
    const [configMaps, setConfigMaps] = useState([]);
    const [secrets, setSecrets] = useState([]);
    const [storageTab, setStorageTab] = useState('PVCS'); // 'PVCS' | 'PVS'
    const [configTab, setConfigTab] = useState('CONFIGMAPS'); // 'CONFIGMAPS' | 'SECRETS'
    const [showConfigModal, setShowConfigModal] = useState(false);
    const [activeConfigContent, setActiveConfigContent] = useState(null);
    const [revealSecret, setRevealSecret] = useState(false);

    // AI Pod & Event Incident Diagnosis State
    const [showAiDiagModal, setShowAiDiagModal] = useState(false);
    const [aiDiagLoading, setAiDiagLoading] = useState(false);
    const [aiDiagPod, setAiDiagPod] = useState(null);
    const [aiDiagResult, setAiDiagResult] = useState(null);
    const [aiDiagError, setAiDiagError] = useState('');
    const [aiDiagCopied, setAiDiagCopied] = useState(false);

    // Form Modal
    const [showModal, setShowModal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState({
        id: '', name: '', environment: '', authType: 'kubeconfig', kubeconfig: '', apiUrl: '', token: '', skipTlsVerify: false,
        sshUser: '', sshPort: 22, sshPassword: '',
        enablePrometheus: false, prometheusUrl: '', promAuthType: 'none', promUser: '', promPassword: '', promToken: '',
        ingressDomain: '', ingressGatewayUrl: ''
    });
    
    const [confirmAction, setConfirmAction] = useState(null);
    const [autoRefresh, setAutoRefresh] = useState(false);

    const loadClusters = async () => {
        try {
            const res = await api.get('/kubernetes/clusters');
            setClusters(res.data.clusters);
        } catch (e) {
            console.error('[K8s] Failed to load clusters:', e);
        }
    };

    useEffect(() => {
        const fetchEnvironments = async () => {
            try {
                const res = await api.get('/environments');
                setEnvironments(normalizeEnvs(res.data));
            } catch (e) {
                console.error('[K8s] Failed to load environments:', e);
            }
        };
        fetchEnvironments();
        loadClusters();
    }, []);

    useEffect(() => {
        if (!activeCluster) return;
        setClusterError(null);
        if (tab === 'DASHBOARD') {
            loadNodes();
        } else if (tab === 'WORKLOADS') {
            loadNamespaces();
            loadPods();
        } else if (tab === 'DEPLOYMENTS') {
            loadNamespaces();
            loadDeployments();
        } else if (tab === 'SERVICES') {
            loadNamespaces();
            loadServicesAndIngresses();
        } else if (tab === 'STORAGE_CONFIG') {
            loadNamespaces();
            loadStorageAndConfig();
        } else if (tab === 'MONITORING') {
            loadMetrics();
        } else if (tab === 'EVENTS') {
            loadNamespaces();
            loadEvents();
        }
    }, [activeCluster, tab, activeNamespace]);

    useEffect(() => {
        let interval;
        if (autoRefresh && activeCluster) {
            interval = setInterval(() => {
                if (tab === 'DASHBOARD') {
                    api.post('/kubernetes/nodes', { clusterId: activeCluster.id })
                        .then(res => setNodes(res.data.nodes || []))
                        .catch(e => console.error('[K8s] Auto-refresh nodes failed:', e));
                } else if (tab === 'WORKLOADS') {
                    api.post('/kubernetes/pods', { clusterId: activeCluster.id, namespace: activeNamespace })
                        .then(res => setPods(res.data.pods || []))
                        .catch(e => console.error('[K8s] Auto-refresh pods failed:', e));
                } else if (tab === 'DEPLOYMENTS') {
                    api.post('/kubernetes/deployments', { clusterId: activeCluster.id, namespace: activeNamespace })
                        .then(res => setDeployments(res.data.deployments || []))
                        .catch(e => console.error('[K8s] Auto-refresh deps failed:', e));
                } else if (tab === 'SERVICES') {
                    loadServicesAndIngresses();
                } else if (tab === 'STORAGE_CONFIG') {
                    loadStorageAndConfig();
                } else if (tab === 'MONITORING') {
                    loadMetrics();
                } else if (tab === 'EVENTS') {
                    api.post('/kubernetes/events', { clusterId: activeCluster.id, namespace: activeNamespace })
                        .then(res => setEvents(res.data.events || []))
                        .catch(e => console.error('[K8s] Auto-refresh events failed:', e));
                }
            }, 3000);
        }
        return () => clearInterval(interval);
    }, [autoRefresh, activeCluster, tab, activeNamespace]);

    const loadNodes = async () => {
        setClusterError(null);
        try {
            const res = await api.post('/kubernetes/nodes', { clusterId: activeCluster.id });
            setNodes(res.data.nodes || []);
        } catch (e) {
            console.error('[K8s] Failed to load nodes:', e);
            setClusterError(e.response?.data?.error || e.message);
            setNodes([]);
        }
    };

    const loadNamespaces = async () => {
        try {
            const res = await api.post('/kubernetes/namespaces', { clusterId: activeCluster.id });
            setNamespaces(res.data.namespaces || []);
        } catch (e) {
            console.error('[K8s] Failed to load namespaces:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
        }
    };

    const loadPods = async () => {
        try {
            const res = await api.post('/kubernetes/pods', { clusterId: activeCluster.id, namespace: activeNamespace });
            setPods(res.data.pods || []);
        } catch (e) {
            console.error('[K8s] Failed to load pods:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
            setPods([]);
        }
    };

    const loadDeployments = async () => {
        try {
            const res = await api.post('/kubernetes/deployments', { clusterId: activeCluster.id, namespace: activeNamespace });
            setDeployments(res.data.deployments || []);
        } catch (e) {
            console.error('[K8s] Failed to load deployments:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
            setDeployments([]);
        }
    };

    const loadEvents = async () => {
        try {
            const res = await api.post('/kubernetes/events', { clusterId: activeCluster.id, namespace: activeNamespace });
            setEvents(res.data.events || []);
        } catch (e) {
            console.error('[K8s] Failed to load events:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
            setEvents([]);
        }
    };

    // P3 Loaders
    const loadMetrics = async () => {
        setMetricsLoading(true);
        try {
            const [mRes, aRes] = await Promise.all([
                api.post('/kubernetes/metrics/cluster', { clusterId: activeCluster.id }),
                api.post('/kubernetes/metrics/alerts', { clusterId: activeCluster.id })
            ]);
            setMetricsData(mRes.data.metrics || null);
            setClusterAlerts(aRes.data.alerts || []);
        } catch (e) {
            console.error('[K8s] Failed to load metrics:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
        } finally {
            setMetricsLoading(false);
        }
    };

    // P4 Loaders
    const loadServicesAndIngresses = async () => {
        try {
            const [svcRes, ingRes] = await Promise.all([
                api.post('/kubernetes/services', { clusterId: activeCluster.id, namespace: activeNamespace }),
                api.post('/kubernetes/ingresses', { clusterId: activeCluster.id, namespace: activeNamespace })
            ]);
            setServices(svcRes.data.services || []);
            setIngresses(ingRes.data.ingresses || []);
            setClusterDomain(ingRes.data.clusterDomain || '');
            setGatewayUrl(ingRes.data.gatewayUrl || '');
        } catch (e) {
            console.error('[K8s] Failed to load services/ingresses:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
        }
    };

    const loadStorageAndConfig = async () => {
        try {
            const [stgRes, cfgRes] = await Promise.all([
                api.post('/kubernetes/storage', { clusterId: activeCluster.id, namespace: activeNamespace }),
                api.post('/kubernetes/configmaps', { clusterId: activeCluster.id, namespace: activeNamespace })
            ]);
            setPvcs(stgRes.data.pvcs || []);
            setPvs(stgRes.data.pvs || []);
            setConfigMaps(cfgRes.data.configMaps || []);
            setSecrets(cfgRes.data.secrets || []);
        } catch (e) {
            console.error('[K8s] Failed to load storage/config:', e);
            if (!clusterError) setClusterError(e.response?.data?.error || e.message);
        }
    };

    const handleViewConfigContent = async (resourceType, resourceName) => {
        setIsProcessing(true);
        setRevealSecret(false);
        try {
            const res = await api.post('/kubernetes/configmaps/view', {
                clusterId: activeCluster.id,
                namespace: activeNamespace,
                resourceType,
                resourceName
            });
            setActiveConfigContent(res.data);
            setShowConfigModal(true);
        } catch (e) {
            console.error('[K8s] Failed to view config:', e);
        } finally {
            setIsProcessing(false);
        }
    };

    const fetchLogs = async (podName, container, tailLines, timestamps) => {
        try {
            const res = await api.post('/kubernetes/pods/logs', { 
                clusterId: activeCluster.id, 
                namespace: activeNamespace, 
                podName,
                container: container || undefined,
                tailLines: tailLines || logTailLines,
                timestamps: timestamps !== undefined ? timestamps : logTimestamps
            });
            setLogsContent(res.data.logs || 'No logs found.');
        } catch (e) {
            console.error('[K8s] Failed to load logs:', e);
            setLogsContent(`[Error loading logs: ${e.response?.data?.error || e.message}]`);
        }
    };

    const handleViewLogs = async (podName, container = '', containers = []) => {
        setIsProcessing(true);
        setActivePodLogs(podName);
        setLogContainer(container);
        setLogPodContainers(containers);
        setLogSearch('');
        try {
            await fetchLogs(podName, container, logTailLines, logTimestamps);
            setShowLogsModal(true);
        } finally {
            setIsProcessing(false);
        }
    };

    useEffect(() => {
        let logInterval;
        if (showLogsModal && logAutoFollow && activePodLogs && activeCluster) {
            logInterval = setInterval(() => {
                fetchLogs(activePodLogs, logContainer, logTailLines, logTimestamps);
            }, 2000);
        }
        return () => clearInterval(logInterval);
    }, [showLogsModal, logAutoFollow, activePodLogs, logContainer, logTailLines, logTimestamps, activeCluster, activeNamespace]);

    // AI Pod & Event Incident Diagnosis Handler
    const handleOpenAiDiagnose = async (pod, customSnippet = '') => {
        if (!pod) return;
        setAiDiagPod(pod);
        setShowAiDiagModal(true);
        setAiDiagLoading(true);
        setAiDiagError('');
        setAiDiagResult(null);
        setAiDiagCopied(false);
        try {
            const res = await api.post('/kubernetes/ai-diagnose', {
                clusterId: activeCluster?.id,
                namespace: activeNamespace,
                podName: pod.name,
                container: pod.containers?.[0]?.name || '',
                customLogSnippet: customSnippet
            });
            setAiDiagResult(res.data);
        } catch (err) {
            setAiDiagError(err.response?.data?.error || err.message || 'AI 事故診斷連線失敗');
        } finally {
            setAiDiagLoading(false);
        }
    };

    // Node SSH Diagnosis (P1)
    const handleOpenNodeDiag = (node) => {
        setActiveDiagNode(node);
        setDiagCommandKey('kubelet_status');
        setDiagCustomCmd('');
        setDiagOutput('');
        setDiagError('');
        setShowNodeDiagModal(true);
        handleRunNodeDiag('kubelet_status', node);
    };

    const handleRunNodeDiag = async (cmdKey, targetNode = null, customCmd = null, customPass = null) => {
        const node = targetNode || activeDiagNode;
        if (!node || !activeCluster) return;
        setDiagLoading(true);
        setDiagError('');
        try {
            const res = await api.post('/kubernetes/nodes/diagnose', {
                clusterId: activeCluster.id,
                nodeName: node.name,
                commandKey: cmdKey,
                customCommand: customCmd || diagCustomCmd,
                customPassword: customPass || diagPassword
            });
            let out = res.data.stdout || '';
            if (res.data.stderr) out += `\n[STDERR]\n${res.data.stderr}`;
            setDiagOutput(out || '(Command executed with empty output)');
        } catch (e) {
            console.error('[K8s Node Diag Error]', e);
            if (e.response?.data?.requirePassword) {
                setDiagError('SSH Password required. Please enter node credentials below.');
            } else {
                setDiagError(e.response?.data?.error || e.message);
            }
        } finally {
            setDiagLoading(false);
        }
    };

    // Pod Web Exec Terminal (P2)
    const handleOpenExec = (pod) => {
        setActiveExecPod(pod);
        const defaultContainer = pod.containers?.[0]?.name || '';
        setExecContainer(defaultContainer);
        setExecCommand('');
        setExecOutput([
            { type: 'sys', text: `Connected to Pod: ${pod.name} (Namespace: ${activeNamespace})` },
            { type: 'sys', text: `Target Container: ${defaultContainer || 'default'}` },
            { type: 'sys', text: `Type a command below or click quick shortcuts to execute.` }
        ]);
        setShowExecModal(true);
    };

    const handleRunExec = async (cmdToRun = null) => {
        const command = cmdToRun !== null ? cmdToRun : execCommand;
        if (!command || !command.trim() || !activeExecPod || !activeCluster) return;

        const cmdStr = command.trim();
        setExecHistory(prev => [cmdStr, ...prev.filter(c => c !== cmdStr)].slice(0, 50));
        setExecHistoryIdx(-1);
        setExecCommand('');
        setExecLoading(true);

        setExecOutput(prev => [...prev, { type: 'cmd', text: `$ ${cmdStr}`, container: execContainer }]);

        try {
            const res = await api.post('/kubernetes/pods/exec-command', {
                clusterId: activeCluster.id,
                namespace: activeNamespace,
                podName: activeExecPod.name,
                container: execContainer,
                command: cmdStr
            });

            let resText = res.data.stdout || '';
            if (res.data.stderr) resText += (resText ? '\n' : '') + `[STDERR]\n${res.data.stderr}`;
            if (!resText && res.data.success) resText = '(Command finished successfully with no output)';

            setExecOutput(prev => [...prev, { 
                type: res.data.success ? 'out' : 'err', 
                text: resText, 
                status: res.data.status 
            }]);
        } catch (e) {
            console.error('[K8s Exec Error]', e);
            setExecOutput(prev => [...prev, { type: 'err', text: `Error: ${e.response?.data?.error || e.message}` }]);
        } finally {
            setExecLoading(false);
        }
    };

    const handleViewYaml = async (resourceType, resourceName) => {
        setIsProcessing(true);
        try {
            const res = await api.post('/kubernetes/yaml', { clusterId: activeCluster.id, namespace: activeNamespace, resourceType, resourceName });
            setYamlContent(res.data.yaml);
            setShowYamlModal(true);
        } catch (e) {
            console.error('[K8s] Failed to load YAML:', e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleScale = async (e) => {
        e.preventDefault();
        setIsProcessing(true);
        try {
            await api.post('/kubernetes/deployments/scale', {
                clusterId: activeCluster.id,
                namespace: activeNamespace,
                deploymentName: scaleData.deploymentName,
                replicas: scaleData.replicas
            });
            setShowScaleModal(false);
            loadDeployments();
        } catch (e) {
            console.error('[K8s] Failed to scale deployment:', e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleViewRollout = async (deploymentName) => {
        setIsProcessing(true);
        try {
            const res = await api.post('/kubernetes/deployments/rollout', { clusterId: activeCluster.id, namespace: activeNamespace, deploymentName });
            setRolloutData({ deploymentName, history: res.data.history || [] });
            setShowRolloutModal(true);
        } catch (e) {
            console.error('[K8s] Failed to load rollout history:', e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleRollback = (deploymentName, revision) => {
        setConfirmAction({
            title: 'Rollback Deployment',
            message: `Are you sure you want to rollback ${deploymentName} to revision ${revision}?`,
            action: async () => {
                setIsProcessing(true);
                try {
                    await api.post('/kubernetes/deployments/rollback', {
                        clusterId: activeCluster.id,
                        namespace: activeNamespace,
                        deploymentName,
                        revision
                    });
                    setShowRolloutModal(false);
                    loadDeployments();
                } catch (e) {
                    console.error('[K8s] Rollback failed:', e);
                } finally {
                    setIsProcessing(false);
                    setConfirmAction(null);
                }
            }
        });
    };

    const handleSaveCluster = async (e) => {
        e.preventDefault();
        if (!formData.name) return;
        setIsProcessing(true);
        try {
            await api.post('/kubernetes/clusters', formData);
            setShowModal(false);
            loadClusters();
        } catch (e) {
            console.error('[K8s] Failed to save cluster:', e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDeleteCluster = (id) => {
        setConfirmAction({
            title: 'Delete Cluster',
            message: 'Are you sure you want to remove this cluster definition?',
            action: async () => {
                setIsProcessing(true);
                try {
                    await api.delete(`/kubernetes/clusters/${id}`);
                    if (activeCluster && activeCluster.id === id) setActiveCluster(null);
                    loadClusters();
                } catch (e) {
                    console.error('[K8s] Delete failed:', e);
                } finally {
                    setIsProcessing(false);
                    setConfirmAction(null);
                }
            }
        });
    };

    const handleDeletePod = (podName) => {
        setConfirmAction({
            title: 'Restart Pod',
            message: `Restart pod ${podName} in ${activeNamespace}?`,
            action: async () => {
                setIsProcessing(true);
                try {
                    await api.post('/kubernetes/pods/delete', {
                        clusterId: activeCluster.id,
                        namespace: activeNamespace,
                        podName: podName
                    });
                    loadPods();
                } catch (e) {
                    console.error('[K8s] Delete Pod failed:', e);
                } finally {
                    setIsProcessing(false);
                    setConfirmAction(null);
                }
            }
        });
    };

    const openModal = (cluster = null) => {
        if (cluster) {
            setIsEditing(true);
            setFormData({
                id: cluster.id,
                name: cluster.name,
                environment: cluster.envId || '', // the form holds the environment id ('' = Unassigned)
                authType: cluster.authType || 'kubeconfig',
                kubeconfig: '', // Empty for security
                apiUrl: cluster.apiUrl || '',
                token: '', // Empty for security
                skipTlsVerify: cluster.skipTlsVerify || false,
                sshUser: cluster.sshUser || '',
                sshPort: cluster.sshPort || 22,
                sshPassword: '',
                enablePrometheus: !!cluster.enablePrometheus,
                prometheusUrl: cluster.prometheusUrl || '',
                promAuthType: cluster.promAuthType || 'none',
                promUser: cluster.promUser || '',
                promPassword: '',
                promToken: '',
                ingressDomain: cluster.ingressDomain || '',
                ingressGatewayUrl: cluster.ingressGatewayUrl || ''
            });
        } else {
            setIsEditing(false);
            setFormData({
                id: '',
                name: '',
                environment: (defaultEnv(environments) || {}).id || '',
                authType: 'kubeconfig',
                kubeconfig: '',
                apiUrl: '',
                token: '',
                skipTlsVerify: false,
                sshUser: '',
                sshPort: 22,
                sshPassword: '',
                enablePrometheus: false,
                prometheusUrl: '',
                promAuthType: 'none',
                promUser: '',
                promPassword: '',
                promToken: '',
                ingressDomain: '',
                ingressGatewayUrl: ''
            });
        }
        setShowModal(true);
    };

    const requestSort = (key) => { setClusterSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' })); };
    const sortArrow = (key) => clusterSort.key === key ? (clusterSort.dir === 'asc' ? ' \u25b2 ' : ' \u25bc ') : '';

    const sortedClusters = [...clusters]
        .sort((a, b) => {
            const va = (a[clusterSort.key] || '').toString().toLowerCase();
            const vb = (b[clusterSort.key] || '').toString().toLowerCase();
            if (va < vb) return clusterSort.dir === 'asc' ? -1 : 1;
            if (va > vb) return clusterSort.dir === 'asc' ? 1 : -1;
            return 0;
        })
        .filter(c => {
            if (selectedEnv) {
                if (c.environment !== selectedEnv) return false;
            }
            return `${c.name} ${c.apiUrl} ${c.environment}`.toLowerCase().includes(clusterSearch.toLowerCase());
        });

    const envGroups = {};
    clusters.forEach(c => { const env = c.environment || 'Unassigned'; envGroups[env] = (envGroups[env] || 0) + 1; });

    if (activeCluster) {
        return (
            <div style={S.page}>
                <div style={{ ...S.header, marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <button style={S.btnBack} onClick={() => setActiveCluster(null)}>← Back to Clusters</button>
                        <h1 style={{ ...S.title, fontSize: 20 }}>☸️ {activeCluster.name}</h1>
                        <span style={activeCluster.envIsProduction ? S.badgeDanger : S.badgeSuccess}>{activeCluster.environment}</span>
                    </div>
                    <div style={{ ...S.headerBtns, alignItems: 'center' }}>
                        <button 
                            style={{ 
                                ...S.btnO, 
                                marginRight: 12, 
                                whiteSpace: 'nowrap', 
                                background: autoRefresh ? 'var(--accent-primary)' : 'transparent', 
                                color: autoRefresh ? '#fff' : 'var(--text-secondary)',
                                borderColor: autoRefresh ? 'var(--accent-primary)' : 'var(--border-color)',
                                boxShadow: autoRefresh ? '0 4px 12px var(--accent-glow)' : 'none'
                            }} 
                            onClick={() => setAutoRefresh(!autoRefresh)}
                        >
                            {autoRefresh ? '⏳ Auto Refresh: ON' : '⏸️ Auto Refresh: OFF'}
                        </button>
                        <button style={S.btnO} onClick={() => { if(tab==='DASHBOARD') loadNodes(); else loadPods(); }}>🔄 Refresh Data</button>
                    </div>
                </div>

                <div style={S.detailsCard}>
                    <div style={S.tabRow}>
                        <button style={{ ...S.tabBtn, ...(tab === 'DASHBOARD' ? S.tabBtnActive : {}) }} onClick={() => setTab('DASHBOARD')}>Node Dashboard</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'WORKLOADS' ? S.tabBtnActive : {}) }} onClick={() => setTab('WORKLOADS')}>Workloads</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'DEPLOYMENTS' ? S.tabBtnActive : {}) }} onClick={() => setTab('DEPLOYMENTS')}>Deployments</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'SERVICES' ? S.tabBtnActive : {}) }} onClick={() => setTab('SERVICES')}>Services & Ingress</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'STORAGE_CONFIG' ? S.tabBtnActive : {}) }} onClick={() => setTab('STORAGE_CONFIG')}>Storage & Config</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'MONITORING' ? S.tabBtnActive : {}) }} onClick={() => setTab('MONITORING')}>Prometheus Monitoring</button>
                        <button style={{ ...S.tabBtn, ...(tab === 'EVENTS' ? S.tabBtnActive : {}) }} onClick={() => setTab('EVENTS')}>Events</button>
                    </div>

                    <div style={{ flex: 1, padding: 24, background: 'var(--bg-primary)' }}>
                        {clusterError && (
                            <div style={{ padding: 16, border: '1px solid var(--danger)', borderRadius: 12, background: 'rgba(239, 68, 68, 0.1)', marginBottom: 20 }}>
                                <h4 style={{ margin: 0, color: 'var(--danger)', fontSize: 14 }}>Cluster Connection Error</h4>
                                <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 13 }}>{clusterError}</p>
                            </div>
                        )}

                        {tab === 'DASHBOARD' && !clusterError && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
                                {nodes.map((node, i) => (
                                    <div key={i} style={{ padding: 20, background: 'var(--bg-glass)', borderRadius: 14, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span style={{ fontSize: 16 }}>🖥️</span>
                                                <h4 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{node.name}</h4>
                                            </div>
                                            <span style={node.status === 'Ready' ? S.badgeSuccess : S.badgeDanger}>{node.status}</span>
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, background: 'var(--bg-secondary)', padding: 12, borderRadius: 10 }}>
                                            <span style={{ fontWeight: 700 }}>IP Address:</span><span style={{ fontFamily: 'monospace', color: 'var(--accent-primary)', fontWeight: 700 }}>{node.ip || '<none>'}</span>
                                            <span style={{ fontWeight: 700 }}>Roles:</span><span>{node.roles.join(', ') || '<worker>'}</span>
                                            <span style={{ fontWeight: 700 }}>Kubelet:</span><span>{node.version}</span>
                                            <span style={{ fontWeight: 700 }}>Runtime:</span><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{node.containerRuntime || '<unknown>'}</span>
                                            <span style={{ fontWeight: 700 }}>OS Image:</span><span style={{ fontSize: 11 }}>{node.osImage || '<unknown>'}</span>
                                            <span style={{ fontWeight: 700 }}>CPU Capacity:</span><span>{node.metrics ? `${node.metrics.cpu} / ` : ''}{node.cpu}</span>
                                            <span style={{ fontWeight: 700 }}>Memory Cap:</span><span>{node.metrics ? `${node.metrics.memory} / ` : ''}{node.memory}</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                                            <button 
                                                style={{ ...S.btnO, flex: 1, padding: '7px 12px', fontSize: 11, justifyContent: 'center' }}
                                                onClick={() => handleOpenNodeDiag(node)}
                                            >
                                                🛠️ OS Quick Diagnosis
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {nodes.length === 0 && <div style={{ color: 'var(--text-muted)', gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>No nodes available.</div>}
                            </div>
                        )}

                        {tab === 'WORKLOADS' && !clusterError && (
                            <div style={{ display: 'flex', gap: 20 }}>
                                {/* Left Side Namespace Tree Panel */}
                                <div style={{ width: 260, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
                                        📂 NAMESPACES ({namespaces.length})
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 400, overflowY: 'auto', paddingRight: 4 }}>
                                        {namespaces.map(ns => {
                                             const isActive = ns === activeNamespace;
                                             return (
                                                 <button
                                                     key={ns}
                                                     onClick={() => setActiveNamespace(ns)}
                                                     style={{
                                                         display: 'flex',
                                                         alignItems: 'center',
                                                         gap: 10,
                                                         padding: '10px 14px',
                                                         background: isActive ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                                                         border: '1px solid ' + (isActive ? 'rgba(59, 130, 246, 0.25)' : 'transparent'),
                                                         borderRadius: 8,
                                                         color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                                         fontSize: 12.5,
                                                         fontWeight: isActive ? 800 : 600,
                                                         cursor: 'pointer',
                                                         textAlign: 'left',
                                                         transition: 'all 0.2s'
                                                     }}
                                                 >
                                                     <span>{isActive ? '🔷' : '📁'}</span>
                                                     <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}>{ns}</span>
                                                 </button>
                                             );
                                         })}
                                     </div>
                                 </div>

                                 {/* Right Side Pod Table Panel */}
                                 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
                                     <div style={S.tblWrap}>
                                         <table style={S.tbl}>
                                             <thead><tr>
                                                 <th style={S.th}>POD NAME</th>
                                                 <th style={S.th}>STATUS</th>
                                                 <th style={S.th}>RESTARTS</th>
                                                 <th style={S.th}>CPU LIMITS</th>
                                                 <th style={S.th}>MEM LIMITS</th>
                                                 <th style={S.th}>IP</th>
                                                 <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                             </tr></thead>
                                             <tbody>
                                                 {pods.length === 0 ? (
                                                     <tr><td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No pods found in namespace "{activeNamespace}".</td></tr>
                                                 ) : (
                                                     pods.map((pod, i) => {
                                                         const renderProgressBar = (value, max, unit) => {
                                                             const pct = max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0;
                                                             let color = 'var(--success)';
                                                             if (pct >= 85) color = 'var(--danger)';
                                                             else if (pct >= 70) color = 'var(--warning)';

                                                             return (
                                                                 <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 100 }}>
                                                                     <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>
                                                                         <span>{value}{unit} / {max}{unit}</span>
                                                                     </div>
                                                                     <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                                                                         <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
                                                                     </div>
                                                                 </div>
                                                             );
                                                         };

                                                         return (
                                                             <tr key={i} style={S.tr}>
                                                                 <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pod.name}>{pod.name}</td>
                                                                 <td style={S.td}>
                                                                     <span style={pod.status === 'Running' ? S.badgeSuccess : (pod.status.includes('BackOff') || pod.status.includes('Error') ? S.badgeDanger : S.badgeWarning)}>
                                                                         {pod.status}
                                                                     </span>
                                                                 </td>
                                                                 <td style={{ ...S.td, color: pod.restarts > 0 ? 'var(--warning)' : 'var(--text-secondary)' }}>{pod.restarts}</td>
                                                                 <td style={S.td}>
                                                                     {renderProgressBar(pod.cpuUsage || 0, pod.cpuLimit || 1000, 'm')}
                                                                 </td>
                                                                 <td style={S.td}>
                                                                     {renderProgressBar(pod.memUsage || 0, pod.memLimit || 512, 'M')}
                                                                 </td>
                                                                 <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{pod.ip || '<none>'}</td>
                                                                 <td style={{ ...S.td, textAlign: 'right' }}>
                                                                     <select
                                                                         defaultValue=""
                                                                         onChange={e => {
                                                                             const act = e.target.value;
                                                                             if (act === 'ai-diagnose') handleOpenAiDiagnose(pod);
                                                                             else if (act === 'exec') handleOpenExec(pod);
                                                                             else if (act === 'logs') handleViewLogs(pod.name, pod.containers?.[0]?.name || '', pod.containers || []);
                                                                             else if (act === 'yaml') handleViewYaml('pod', pod.name);
                                                                             else if (act === 'restart') handleDeletePod(pod.name);
                                                                             e.target.value = "";
                                                                         }}
                                                                         style={{
                                                                             background: 'var(--bg-secondary)',
                                                                             color: 'var(--text-primary)',
                                                                             border: '1px solid var(--border-color)',
                                                                             borderRadius: 8,
                                                                             padding: '8px 14px',
                                                                             fontSize: 11,
                                                                             fontWeight: 900,
                                                                             cursor: 'pointer',
                                                                             outline: 'none',
                                                                             width: 115,
                                                                             letterSpacing: '0.04em'
                                                                         }}
                                                                     >
                                                                         <option value="" disabled>Action</option>
                                                                         <option value="ai-diagnose" style={{ color: '#818cf8', fontWeight: 800 }}>🤖 AI 事故診斷</option>
                                                                         {role !== 'Viewer' && <option value="exec">💻 Web Exec</option>}
                                                                         <option value="logs">📋 Logs</option>
                                                                         <option value="yaml">⚙️ YAML</option>
                                                                         {role !== 'Viewer' && <option value="restart">🔄 Restart</option>}
                                                                     </select>
                                                                 </td>
                                                             </tr>
                                                         );
                                                     })
                                                 )}
                                             </tbody>
                                         </table>
                                     </div>
                                 </div>
                             </div>
                        )}

                        {tab === 'DEPLOYMENTS' && !clusterError && (
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Namespace:</span>
                                    <select 
                                        value={activeNamespace} 
                                        onChange={e => setActiveNamespace(e.target.value)}
                                        style={{ ...S.input, width: 250, marginTop: 0, padding: '8px 12px' }}
                                    >
                                        {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                                    </select>
                                </div>
                                <div style={S.tblWrap}>
                                    <table style={S.tbl}>
                                        <thead><tr>
                                            <th style={S.th}>DEPLOYMENT NAME</th>
                                            <th style={S.th}>REPLICAS (READY / DESIRED)</th>
                                            <th style={S.th}>AVAILABLE</th>
                                            <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                        </tr></thead>
                                        <tbody>
                                            {deployments.length === 0 ? (
                                                <tr><td colSpan="4" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No deployments found in {activeNamespace}.</td></tr>
                                            ) : (
                                                deployments.map((dep, i) => (
                                                    <tr key={i} style={S.tr}>
                                                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{dep.name}</td>
                                                        <td style={S.td}>
                                                            <span style={dep.readyReplicas === dep.replicas ? S.badgeSuccess : S.badgeWarning}>
                                                                {dep.readyReplicas} / {dep.replicas}
                                                            </span>
                                                        </td>
                                                        <td style={{ ...S.td, color: 'var(--text-secondary)' }}>{dep.availableReplicas}</td>
                                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                                             <select
                                                                 defaultValue=""
                                                                 onChange={e => {
                                                                     const act = e.target.value;
                                                                     if (act === 'yaml') handleViewYaml('deployment', dep.name);
                                                                     else if (act === 'history') handleViewRollout(dep.name);
                                                                     else if (act === 'scale') { setScaleData({ deploymentName: dep.name, replicas: dep.replicas }); setShowScaleModal(true); }
                                                                     e.target.value = "";
                                                                 }}
                                                                 style={{
                                                                     background: 'var(--bg-secondary)',
                                                                     color: 'var(--text-primary)',
                                                                     border: '1px solid var(--border-color)',
                                                                     borderRadius: 8,
                                                                     padding: '8px 14px',
                                                                     fontSize: 11,
                                                                     fontWeight: 900,
                                                                     cursor: 'pointer',
                                                                     outline: 'none',
                                                                     width: 90,
                                                                     letterSpacing: '0.04em'
                                                                 }}
                                                             >
                                                                 <option value="" disabled>Action</option>
                                                                 <option value="yaml">YAML</option>
                                                                 <option value="history">History</option>
                                                                 {role !== 'Viewer' && <option value="scale">Scale</option>}
                                                             </select>
                                                         </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* P4: SERVICES & INGRESS TAB */}
                        {tab === 'SERVICES' && !clusterError && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Namespace:</span>
                                        <select 
                                            value={activeNamespace} 
                                            onChange={e => setActiveNamespace(e.target.value)}
                                            style={{ ...S.input, width: 220, marginTop: 0, padding: '8px 12px' }}
                                        >
                                            {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                                        </select>
                                    </div>
                                    {(clusterDomain || gatewayUrl) && (
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 14 }}>
                                            {clusterDomain && <span>🌐 Ingress Base Domain: <strong style={{ color: 'var(--accent-primary)' }}>*.{clusterDomain}</strong></span>}
                                            {gatewayUrl && <span>🚪 Gateway: <strong style={{ color: 'var(--accent-primary)' }}>{gatewayUrl}</strong></span>}
                                        </div>
                                    )}
                                </div>

                                {/* Ingress Section */}
                                <div>
                                    <h4 style={{ fontSize: 14, fontWeight: 900, marginBottom: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span>🌐</span> HTTP / HTTPS Ingress Routes ({ingresses.length})
                                    </h4>
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>INGRESS NAME</th>
                                                <th style={S.th}>HOST & PATH RULES</th>
                                                <th style={S.th}>BACKEND SERVICES</th>
                                                <th style={S.th}>TLS STATUS</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>DIRECT ACCESS</th>
                                            </tr></thead>
                                            <tbody>
                                                {ingresses.length === 0 ? (
                                                    <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No Ingress routes defined in {activeNamespace}.</td></tr>
                                                ) : (
                                                    ingresses.map((ing, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{ing.name}</td>
                                                            <td style={S.td}>
                                                                {ing.rules.map((r, ri) => (
                                                                    <div key={ri} style={{ marginBottom: 4 }}>
                                                                        <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>{r.host}</span>
                                                                        {r.paths.map((p, pi) => (
                                                                            <span key={pi} style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>({p.path})</span>
                                                                        ))}
                                                                    </div>
                                                                ))}
                                                            </td>
                                                            <td style={{ ...S.td, fontSize: 11, fontFamily: 'monospace' }}>
                                                                {ing.rules.flatMap(r => r.paths).map((p, pi) => (
                                                                    <div key={pi}>{p.serviceName}:{p.servicePort}</div>
                                                                ))}
                                                            </td>
                                                            <td style={S.td}>
                                                                {ing.tls && ing.tls.length > 0 ? (
                                                                    <span style={S.badgeSuccess}>🔒 TLS / HTTPS</span>
                                                                ) : (
                                                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🔓 HTTP Only</span>
                                                                )}
                                                            </td>
                                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                                {ing.directUrls && ing.directUrls.length > 0 ? (
                                                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                                                        {ing.directUrls.map((u, ui) => (
                                                                            <a
                                                                                key={ui}
                                                                                href={u.url}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                                style={{
                                                                                    display: 'inline-flex',
                                                                                    alignItems: 'center',
                                                                                    gap: 4,
                                                                                    padding: '4px 10px',
                                                                                    borderRadius: 6,
                                                                                    background: 'rgba(59, 130, 246, 0.15)',
                                                                                    border: '1px solid var(--accent-primary)',
                                                                                    color: 'var(--accent-primary)',
                                                                                    fontSize: 11,
                                                                                    fontWeight: 700,
                                                                                    textDecoration: 'none'
                                                                                }}
                                                                            >
                                                                                🔗 Open App
                                                                            </a>
                                                                        ))}
                                                                    </div>
                                                                ) : (
                                                                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>-</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Services Section */}
                                <div>
                                    <h4 style={{ fontSize: 14, fontWeight: 900, marginBottom: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span>🔌</span> Kubernetes Services ({services.length})
                                    </h4>
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>SERVICE NAME</th>
                                                <th style={S.th}>TYPE</th>
                                                <th style={S.th}>CLUSTER IP</th>
                                                <th style={S.th}>EXTERNAL / LB IP</th>
                                                <th style={S.th}>PORT MAPPINGS</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>AGE</th>
                                            </tr></thead>
                                            <tbody>
                                                {services.length === 0 ? (
                                                    <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No Services found in {activeNamespace}.</td></tr>
                                                ) : (
                                                    services.map((svc, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{svc.name}</td>
                                                            <td style={S.td}>
                                                                <span style={svc.type === 'LoadBalancer' ? S.badgeSuccess : (svc.type === 'NodePort' ? S.badgeWarning : { ...S.badgeSuccess, background: 'rgba(59, 130, 246, 0.12)', color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' })}>
                                                                    {svc.type}
                                                                </span>
                                                            </td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>{svc.clusterIP || '<none>'}</td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: svc.externalIP !== '<none>' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>{svc.externalIP}</td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>
                                                                {svc.ports.map((p, pi) => (
                                                                    <span key={pi} style={{ display: 'inline-block', marginRight: 8, padding: '2px 6px', background: 'var(--bg-secondary)', borderRadius: 4 }}>
                                                                        {p.port}{p.nodePort ? `:${p.nodePort}` : ''}/{p.protocol} → {p.targetPort}
                                                                    </span>
                                                                ))}
                                                            </td>
                                                            <td style={{ ...S.td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>
                                                                {new Date(svc.age).toLocaleDateString()}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* P4: STORAGE & CONFIGMAPS TAB */}
                        {tab === 'STORAGE_CONFIG' && !clusterError && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Namespace:</span>
                                        <select 
                                            value={activeNamespace} 
                                            onChange={e => setActiveNamespace(e.target.value)}
                                            style={{ ...S.input, width: 220, marginTop: 0, padding: '8px 12px' }}
                                        >
                                            {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                                        </select>
                                    </div>

                                    {/* Storage & Config Sub-navigation */}
                                    <div style={{ display: 'flex', gap: 6, background: 'var(--bg-secondary)', padding: 4, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                                        {[
                                            { key: 'PVCS', label: `📦 PVC (${pvcs.length})` },
                                            { key: 'PVS', label: `💾 PV (${pvs.length})` },
                                            { key: 'CONFIGMAPS', label: `⚙️ ConfigMaps (${configMaps.length})` },
                                            { key: 'SECRETS', label: `🔒 Secrets (${secrets.length})` }
                                        ].map(st => (
                                            <button
                                                key={st.key}
                                                onClick={() => setStorageTab(st.key)}
                                                style={{
                                                    padding: '6px 12px',
                                                    borderRadius: 6,
                                                    fontSize: 11,
                                                    fontWeight: 800,
                                                    border: 'none',
                                                    background: storageTab === st.key ? 'var(--accent-primary)' : 'transparent',
                                                    color: storageTab === st.key ? '#fff' : 'var(--text-secondary)',
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                {st.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* PVC Table */}
                                {storageTab === 'PVCS' && (
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>PVC NAME</th>
                                                <th style={S.th}>STATUS</th>
                                                <th style={S.th}>CAPACITY</th>
                                                <th style={S.th}>STORAGE CLASS</th>
                                                <th style={S.th}>VOLUME</th>
                                                <th style={S.th}>ACCESS MODES</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>AGE</th>
                                            </tr></thead>
                                            <tbody>
                                                {pvcs.length === 0 ? (
                                                    <tr><td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No PersistentVolumeClaims found in {activeNamespace}.</td></tr>
                                                ) : (
                                                    pvcs.map((pvc, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{pvc.name}</td>
                                                            <td style={S.td}>
                                                                <span style={pvc.status === 'Bound' ? S.badgeSuccess : S.badgeWarning}>{pvc.status}</span>
                                                            </td>
                                                            <td style={{ ...S.td, fontWeight: 700, color: 'var(--accent-primary)' }}>{pvc.capacity}</td>
                                                            <td style={{ ...S.td, fontSize: 11 }}>{pvc.storageClass}</td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{pvc.volumeName}</td>
                                                            <td style={{ ...S.td, fontSize: 11 }}>{pvc.accessModes}</td>
                                                            <td style={{ ...S.td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{new Date(pvc.age).toLocaleDateString()}</td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {/* PV Table */}
                                {storageTab === 'PVS' && (
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>PV NAME</th>
                                                <th style={S.th}>STATUS</th>
                                                <th style={S.th}>CAPACITY</th>
                                                <th style={S.th}>STORAGE CLASS</th>
                                                <th style={S.th}>CLAIM REFERENCE</th>
                                                <th style={S.th}>RECLAIM POLICY</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>AGE</th>
                                            </tr></thead>
                                            <tbody>
                                                {pvs.length === 0 ? (
                                                    <tr><td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No PersistentVolumes found in cluster.</td></tr>
                                                ) : (
                                                    pvs.map((pv, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{pv.name}</td>
                                                            <td style={S.td}>
                                                                <span style={pv.status === 'Bound' ? S.badgeSuccess : S.badgeWarning}>{pv.status}</span>
                                                            </td>
                                                            <td style={{ ...S.td, fontWeight: 700, color: 'var(--accent-primary)' }}>{pv.capacity}</td>
                                                            <td style={{ ...S.td, fontSize: 11 }}>{pv.storageClass}</td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{pv.claim}</td>
                                                            <td style={{ ...S.td, fontSize: 11 }}>{pv.reclaimPolicy}</td>
                                                            <td style={{ ...S.td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{new Date(pv.age).toLocaleDateString()}</td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {/* ConfigMaps Table */}
                                {storageTab === 'CONFIGMAPS' && (
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>CONFIGMAP NAME</th>
                                                <th style={S.th}>DATA KEYS COUNT</th>
                                                <th style={S.th}>KEY NAMES</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                            </tr></thead>
                                            <tbody>
                                                {configMaps.length === 0 ? (
                                                    <tr><td colSpan="4" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No ConfigMaps found in {activeNamespace}.</td></tr>
                                                ) : (
                                                    configMaps.map((cm, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{cm.name}</td>
                                                            <td style={S.td}><span style={S.badgeSuccess}>{cm.keyCount} keys</span></td>
                                                            <td style={{ ...S.td, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{cm.keys.join(', ') || '<empty>'}</td>
                                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                                <button style={S.viewBtn} onClick={() => handleViewConfigContent('configmap', cm.name)}>👁️ View Data</button>
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {/* Secrets Table */}
                                {storageTab === 'SECRETS' && (
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>SECRET NAME</th>
                                                <th style={S.th}>TYPE</th>
                                                <th style={S.th}>DATA KEYS</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                            </tr></thead>
                                            <tbody>
                                                {secrets.length === 0 ? (
                                                    <tr><td colSpan="4" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No Secrets found in {activeNamespace}.</td></tr>
                                                ) : (
                                                    secrets.map((sec, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700 }}>{sec.name}</td>
                                                            <td style={{ ...S.td, fontSize: 11, color: 'var(--text-secondary)' }}>{sec.type}</td>
                                                            <td style={{ ...S.td, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{sec.keys.join(', ') || '<empty>'}</td>
                                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                                {role !== 'Viewer' ? (
                                                                    <button style={S.viewBtn} onClick={() => handleViewConfigContent('secret', sec.name)}>🔒 View Decoded</button>
                                                                ) : (
                                                                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Masked</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* P3: PROMETHEUS MONITORING & METRICS TAB */}
                        {tab === 'MONITORING' && !clusterError && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <span style={{ fontSize: 18 }}>📊</span>
                                        <div>
                                            <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>Cluster Resource Monitoring & Metrics</h3>
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                Data Source: {metricsData?.source === 'prometheus' ? (
                                                    <strong style={{ color: 'var(--success)' }}>🟢 Prometheus API Live ({activeCluster.prometheusUrl || 'Configured'})</strong>
                                                ) : (
                                                    <strong style={{ color: 'var(--warning)' }}>⚪ K8s Native Capacity Estimation</strong>
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                    <button style={S.btnP} onClick={loadMetrics} disabled={metricsLoading}>
                                        {metricsLoading ? 'Refreshing...' : '🔄 Refresh Metrics'}
                                    </button>
                                </div>

                                {/* Top Metric Cards */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                                    {/* CPU Usage Card */}
                                    <div style={{ padding: 20, background: 'var(--bg-glass)', borderRadius: 14, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)' }}>CLUSTER CPU USAGE</span>
                                            <span style={{ fontSize: 18, fontWeight: 900, color: metricsData?.cpuPercent >= 80 ? 'var(--danger)' : (metricsData?.cpuPercent >= 60 ? 'var(--warning)' : 'var(--success)') }}>
                                                {metricsData?.cpuPercent || 0}%
                                            </span>
                                        </div>
                                        <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-primary)' }}>
                                            {metricsData?.cpuUsageCores ? metricsData.cpuUsageCores.toFixed(2) : '0'} / {metricsData?.cpuTotalCores || '0'} Cores
                                        </div>
                                        <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: `${metricsData?.cpuPercent || 0}%`, background: metricsData?.cpuPercent >= 80 ? 'var(--danger)' : 'var(--accent-primary)', borderRadius: 4, transition: 'width 0.4s' }} />
                                        </div>
                                    </div>

                                    {/* Memory Usage Card */}
                                    <div style={{ padding: 20, background: 'var(--bg-glass)', borderRadius: 14, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)' }}>CLUSTER MEMORY USAGE</span>
                                            <span style={{ fontSize: 18, fontWeight: 900, color: metricsData?.memPercent >= 85 ? 'var(--danger)' : (metricsData?.memPercent >= 70 ? 'var(--warning)' : 'var(--success)') }}>
                                                {metricsData?.memPercent || 0}%
                                            </span>
                                        </div>
                                        <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-primary)' }}>
                                            {metricsData?.memUsageBytes ? (metricsData.memUsageBytes / (1024 * 1024 * 1024)).toFixed(2) : '0'} / {metricsData?.memTotalBytes ? (metricsData.memTotalBytes / (1024 * 1024 * 1024)).toFixed(1) : '0'} GB
                                        </div>
                                        <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: `${metricsData?.memPercent || 0}%`, background: metricsData?.memPercent >= 85 ? 'var(--danger)' : '#10b981', borderRadius: 4, transition: 'width 0.4s' }} />
                                        </div>
                                    </div>

                                    {/* Network I/O Card */}
                                    <div style={{ padding: 20, background: 'var(--bg-glass)', borderRadius: 14, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)' }}>NETWORK THROUGHPUT</span>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                                            <div>
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>⬇️ INGRESS (RX)</span>
                                                <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--accent-primary)' }}>
                                                    {metricsData?.netRxBytesPerSec ? (metricsData.netRxBytesPerSec / 1024).toFixed(1) : '0'} KB/s
                                                </div>
                                            </div>
                                            <div>
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>⬆️ EGRESS (TX)</span>
                                                <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-secondary)' }}>
                                                    {metricsData?.netTxBytesPerSec ? (metricsData.netTxBytesPerSec / 1024).toFixed(1) : '0'} KB/s
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Top Resource Consumers */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: 16 }}>
                                    <div style={{ padding: 18, background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 900, color: 'var(--accent-primary)' }}>🔥 Top CPU Consuming Workloads</h4>
                                        {metricsData?.topCpuPods && metricsData.topCpuPods.length > 0 ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                {metricsData.topCpuPods.map((p, pi) => (
                                                    <div key={pi} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 6, fontSize: 11, fontFamily: 'monospace' }}>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{p.pod}</span>
                                                        <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{p.value}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: 20 }}>No pod metrics available.</div>
                                        )}
                                    </div>

                                    <div style={{ padding: 18, background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 900, color: '#10b981' }}>🧠 Top Memory Consuming Workloads</h4>
                                        {metricsData?.topMemPods && metricsData.topMemPods.length > 0 ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                {metricsData.topMemPods.map((p, pi) => (
                                                    <div key={pi} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 6, fontSize: 11, fontFamily: 'monospace' }}>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{p.pod}</span>
                                                        <span style={{ color: 'var(--success)', fontWeight: 700 }}>{p.value}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: 20 }}>No pod metrics available.</div>
                                        )}
                                    </div>
                                </div>

                                {/* Cluster Alerts Section */}
                                <div>
                                    <h4 style={{ fontSize: 14, fontWeight: 900, marginBottom: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span>🚨</span> Active Cluster Health Alerts ({clusterAlerts.length})
                                    </h4>
                                    <div style={S.tblWrap}>
                                        <table style={S.tbl}>
                                            <thead><tr>
                                                <th style={S.th}>ALERT NAME</th>
                                                <th style={S.th}>SEVERITY</th>
                                                <th style={S.th}>STATE</th>
                                                <th style={S.th}>SUMMARY & DETAILS</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>TRIGGERED TIME</th>
                                            </tr></thead>
                                            <tbody>
                                                {clusterAlerts.length === 0 ? (
                                                    <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 30, color: 'var(--success)' }}>✅ All systems normal. No firing alerts detected.</td></tr>
                                                ) : (
                                                    clusterAlerts.map((alt, i) => (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={{ ...S.td, fontWeight: 800, color: 'var(--danger)' }}>{alt.name}</td>
                                                            <td style={S.td}>
                                                                <span style={alt.severity === 'critical' ? S.badgeDanger : S.badgeWarning}>{alt.severity}</span>
                                                            </td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>{alt.state}</td>
                                                            <td style={{ ...S.td, fontSize: 12 }}>{alt.summary}</td>
                                                            <td style={{ ...S.td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{new Date(alt.activeAt).toLocaleString()}</td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        )}

                        {tab === 'EVENTS' && !clusterError && (
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Namespace:</span>
                                    <select 
                                        value={activeNamespace} 
                                        onChange={e => setActiveNamespace(e.target.value)}
                                        style={{ ...S.input, width: 250, marginTop: 0, padding: '8px 12px' }}
                                    >
                                        {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                                    </select>
                                </div>
                                <div style={S.tblWrap}>
                                    <table style={S.tbl}>
                                        <thead><tr>
                                            <th style={S.th}>TYPE</th>
                                            <th style={S.th}>REASON</th>
                                            <th style={S.th}>OBJECT</th>
                                            <th style={S.th}>MESSAGE</th>
                                            <th style={S.th}>AGE</th>
                                        </tr></thead>
                                        <tbody>
                                            {events.length === 0 ? (
                                                <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No events found in {activeNamespace}.</td></tr>
                                            ) : (
                                                events.map((ev, i) => {
                                                    const isPodEvent = ev.object && (ev.object.startsWith('Pod/') || ev.object.startsWith('pod/'));
                                                    const podNameFromEv = isPodEvent ? ev.object.split('/')[1] : null;
                                                    return (
                                                        <tr key={i} style={S.tr}>
                                                            <td style={S.td}>
                                                                <span style={ev.type === 'Normal' ? S.badgeSuccess : S.badgeDanger}>{ev.type}</span>
                                                            </td>
                                                            <td style={{ ...S.td, fontWeight: 700 }}>{ev.reason}</td>
                                                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{ev.object}</td>
                                                            <td style={{ ...S.td, fontSize: 12, maxWidth: 420 }}>
                                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                                                    <span>{ev.message}</span>
                                                                    {isPodEvent && ev.type !== 'Normal' && (
                                                                        <button
                                                                            onClick={() => handleOpenAiDiagnose({ name: podNameFromEv, status: ev.reason }, `Event [${ev.reason}]: ${ev.message}`)}
                                                                            style={{
                                                                                padding: '3px 8px',
                                                                                fontSize: 10,
                                                                                fontWeight: 800,
                                                                                background: 'rgba(99, 102, 241, 0.18)',
                                                                                border: '1px solid rgba(99, 102, 241, 0.4)',
                                                                                color: '#a5b4fc',
                                                                                borderRadius: 6,
                                                                                cursor: 'pointer',
                                                                                whiteSpace: 'nowrap',
                                                                                flexShrink: 0
                                                                            }}
                                                                            title="以此事件為線索啟動 AI Pod 事故診斷"
                                                                        >
                                                                            🤖 AI 診斷
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td style={{ ...S.td, color: 'var(--text-muted)', fontSize: 11 }}>{new Date(ev.lastTimestamp).toLocaleString()}</td>
                                                        </tr>
                                                    );
                                                })
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Node SSH OS Diagnosis Modal (P1) */}
                {showNodeDiagModal && activeDiagNode && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowNodeDiagModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 880, width: '92%', height: '84vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 18 }}>🛠️</span>
                                    <div>
                                        <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>Node SSH OS Diagnostics: {activeDiagNode.name}</h3>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>IP: {activeDiagNode.ip || 'Unknown'} | Kubelet: {activeDiagNode.version} | Runtime: {activeDiagNode.containerRuntime || 'unknown'}</span>
                                    </div>
                                </div>
                                <button style={S.closeBtn} onClick={() => setShowNodeDiagModal(false)}>✕</button>
                            </div>

                            {/* Quick Tabs */}
                            <div style={{ display: 'flex', gap: 6, padding: '12px 18px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
                                {[
                                    { key: 'kubelet_status', label: '⚡ Kubelet Process / Status' },
                                    { key: 'kubelet_logs', label: '📋 Kubelet Logs' },
                                    { key: 'crictl_ps', label: '🐳 Runtime Containers' },
                                    { key: 'crictl_pods', label: '📦 Runtime Pods' },
                                    { key: 'disk_free', label: '💾 Disk Usage' },
                                    { key: 'mem_top', label: '🧠 Memory & Processes' },
                                    { key: 'custom', label: '⌨️ Custom Shell Cmd' }
                                ].map(t => (
                                    <button
                                        key={t.key}
                                        onClick={() => {
                                            setDiagCommandKey(t.key);
                                            if (t.key !== 'custom') handleRunNodeDiag(t.key);
                                        }}
                                        style={{
                                            padding: '6px 14px',
                                            borderRadius: 8,
                                            fontSize: 12,
                                            fontWeight: 800,
                                            border: '1px solid ' + (diagCommandKey === t.key ? 'var(--accent-primary)' : 'var(--border-color)'),
                                            background: diagCommandKey === t.key ? 'var(--accent-primary)' : 'transparent',
                                            color: diagCommandKey === t.key ? '#fff' : 'var(--text-secondary)',
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {t.label}
                                    </button>
                                ))}
                            </div>

                            {/* Custom Command input bar */}
                            {diagCommandKey === 'custom' && (
                                <div style={{ display: 'flex', gap: 10, padding: '12px 18px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)' }}>
                                    <input 
                                        type="text" 
                                        style={{ ...S.input, marginTop: 0, flex: 1, fontFamily: 'monospace' }}
                                        placeholder="e.g., uptime && uname -a or dmesg -T | tail -n 20"
                                        value={diagCustomCmd}
                                        onChange={e => setDiagCustomCmd(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleRunNodeDiag('custom'); }}
                                    />
                                    <button style={S.btnP} onClick={() => handleRunNodeDiag('custom')} disabled={diagLoading}>
                                        {diagLoading ? 'Running...' : 'Run'}
                                    </button>
                                </div>
                            )}

                            {/* Password input if needed */}
                            {diagError && diagError.includes('Password') && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: 'rgba(239, 68, 68, 0.1)', borderBottom: '1px solid var(--danger)' }}>
                                    <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 700 }}>🔒 Node Password:</span>
                                    <input 
                                        type="password" 
                                        style={{ ...S.input, width: 220, marginTop: 0, padding: '6px 12px' }}
                                        placeholder="Enter SSH password"
                                        value={diagPassword}
                                        onChange={e => setDiagPassword(e.target.value)}
                                    />
                                    <button style={{ ...S.btnP, padding: '6px 16px' }} onClick={() => handleRunNodeDiag(diagCommandKey)}>Retry</button>
                                </div>
                            )}

                            {/* Output Box */}
                            <div style={{ flex: 1, padding: 18, background: '#0b1120', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                                {diagLoading ? (
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--accent-primary)', fontWeight: 800 }}>
                                        <span>⏳ Executing diagnostic command over SSH...</span>
                                    </div>
                                ) : (
                                    <pre style={{ margin: 0, color: '#38bdf8', fontSize: 12, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                        {diagOutput || (diagError ? `[Error]\n${diagError}` : 'No output yet.')}
                                    </pre>
                                )}
                            </div>

                            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-secondary)' }}>
                                <button 
                                    style={{ ...S.btnO, padding: '6px 14px', fontSize: 11 }}
                                    onClick={() => { navigator.clipboard.writeText(diagOutput); }}
                                >
                                    📋 Copy Output
                                </button>
                                <button style={{ ...S.btnP, padding: '6px 16px', fontSize: 12 }} onClick={() => handleRunNodeDiag(diagCommandKey)} disabled={diagLoading}>
                                    🔄 Re-run Diagnosis
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Pod Web Exec Terminal Modal (P2) */}
                {showExecModal && activeExecPod && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowExecModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 920, width: '92%', height: '84vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 18 }}>💻</span>
                                    <div>
                                        <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>Pod Web Exec Terminal: {activeExecPod.name}</h3>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Namespace: {activeNamespace} | Node: {activeExecPod.node}</span>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    {activeExecPod.containers && activeExecPod.containers.length > 1 && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Container:</span>
                                            <select 
                                                style={{ ...S.input, marginTop: 0, padding: '4px 10px', fontSize: 11, width: 140 }}
                                                value={execContainer}
                                                onChange={e => {
                                                    setExecContainer(e.target.value);
                                                    setExecOutput(prev => [...prev, { type: 'sys', text: `Switched target container to: ${e.target.value}` }]);
                                                }}
                                            >
                                                {activeExecPod.containers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                                            </select>
                                        </div>
                                    )}
                                    <button style={S.closeBtn} onClick={() => setShowExecModal(false)}>✕</button>
                                </div>
                            </div>

                            {/* Quick Command Chips */}
                            <div style={{ display: 'flex', gap: 6, padding: '8px 16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
                                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 4 }}>Quick:</span>
                                {[
                                    'env', 'ps aux', 'df -h', 'netstat -tuln', 'cat /etc/os-release', 'top -b -n 1', 'ls -la'
                                ].map(cmd => (
                                    <button
                                        key={cmd}
                                        onClick={() => handleRunExec(cmd)}
                                        style={{
                                            padding: '4px 10px',
                                            borderRadius: 6,
                                            fontSize: 11,
                                            fontFamily: 'monospace',
                                            fontWeight: 700,
                                            border: '1px solid var(--border-color)',
                                            background: 'var(--bg-primary)',
                                            color: 'var(--accent-primary)',
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {cmd}
                                    </button>
                                ))}
                            </div>

                            {/* Terminal Output Area */}
                            <div style={{ flex: 1, padding: 16, background: '#090d16', overflowY: 'auto', fontFamily: 'Consolas, monospace', fontSize: 12 }}>
                                {execOutput.map((item, idx) => {
                                    if (item.type === 'sys') {
                                        return <div key={idx} style={{ color: '#64748b', marginBottom: 4 }}>[SYS] {item.text}</div>;
                                    } else if (item.type === 'cmd') {
                                        return <div key={idx} style={{ color: '#38bdf8', fontWeight: 'bold', marginTop: 10, marginBottom: 4 }}>{item.text}</div>;
                                    } else if (item.type === 'err') {
                                        return <pre key={idx} style={{ color: '#f87171', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{item.text}</pre>;
                                    }
                                    return <pre key={idx} style={{ color: '#e2e8f0', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{item.text}</pre>;
                                })}
                                {execLoading && (
                                    <div style={{ color: '#38bdf8', marginTop: 6, animation: 'pulse 1.5s infinite' }}>⏳ Executing command...</div>
                                )}
                            </div>

                            {/* Command Input Bar */}
                            <form 
                                onSubmit={e => { e.preventDefault(); handleRunExec(); }}
                                style={{ display: 'flex', gap: 8, padding: '12px 16px', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)' }}
                            >
                                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 900, color: 'var(--accent-primary)', alignSelf: 'center' }}>$</span>
                                <input 
                                    type="text" 
                                    style={{ ...S.input, marginTop: 0, flex: 1, fontFamily: 'monospace', background: 'var(--bg-primary)' }}
                                    placeholder="Type container command (e.g. ls /app, env, ps aux)..."
                                    value={execCommand}
                                    onChange={e => setExecCommand(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'ArrowUp') {
                                            if (execHistory.length > 0) {
                                                const nextIdx = Math.min(execHistoryIdx + 1, execHistory.length - 1);
                                                setExecHistoryIdx(nextIdx);
                                                setExecCommand(execHistory[nextIdx]);
                                            }
                                        } else if (e.key === 'ArrowDown') {
                                            if (execHistoryIdx > 0) {
                                                const nextIdx = execHistoryIdx - 1;
                                                setExecHistoryIdx(nextIdx);
                                                setExecCommand(execHistory[nextIdx]);
                                            } else if (execHistoryIdx === 0) {
                                                setExecHistoryIdx(-1);
                                                setExecCommand('');
                                            }
                                        }
                                    }}
                                    autoFocus
                                    disabled={execLoading}
                                />
                                <button type="submit" style={S.btnP} disabled={execLoading || !execCommand.trim()}>
                                    Send
                                </button>
                                <button 
                                    type="button" 
                                    style={{ ...S.btnO, padding: '8px 14px' }} 
                                    onClick={() => setExecOutput([])}
                                    title="Clear Terminal Output"
                                >
                                    🧹 Clear
                                </button>
                            </form>
                        </div>
                    </div>
                )}

                {/* Enhanced Logs Modal (P2) */}
                {showLogsModal && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowLogsModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 950, width: '92%', height: '84vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 18 }}>📄</span>
                                    <div>
                                        <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0, fontFamily: 'monospace' }}>Logs: {activePodLogs}</h3>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Namespace: {activeNamespace}</span>
                                    </div>
                                </div>
                                <button style={S.closeBtn} onClick={() => setShowLogsModal(false)}>✕</button>
                            </div>

                            {/* Log Toolbar */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 10 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    {logPodContainers && logPodContainers.length > 1 && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Container:</span>
                                            <select 
                                                style={{ ...S.input, marginTop: 0, padding: '4px 10px', fontSize: 11, width: 130 }}
                                                value={logContainer}
                                                onChange={e => {
                                                    setLogContainer(e.target.value);
                                                    fetchLogs(activePodLogs, e.target.value, logTailLines, logTimestamps);
                                                }}
                                            >
                                                {logPodContainers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                                            </select>
                                        </div>
                                    )}

                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>Lines:</span>
                                        <select 
                                            style={{ ...S.input, marginTop: 0, padding: '4px 8px', fontSize: 11, width: 90 }}
                                            value={logTailLines}
                                            onChange={e => {
                                                const val = Number(e.target.value);
                                                setLogTailLines(val);
                                                fetchLogs(activePodLogs, logContainer, val, logTimestamps);
                                            }}
                                        >
                                            <option value={100}>100 lines</option>
                                            <option value={500}>500 lines</option>
                                            <option value={1000}>1000 lines</option>
                                            <option value={5000}>5000 lines</option>
                                        </select>
                                    </div>

                                    <button 
                                        style={{
                                            padding: '4px 12px',
                                            borderRadius: 6,
                                            fontSize: 11,
                                            fontWeight: 800,
                                            border: '1px solid ' + (logAutoFollow ? 'var(--accent-primary)' : 'var(--border-color)'),
                                            background: logAutoFollow ? 'var(--accent-primary)' : 'transparent',
                                            color: logAutoFollow ? '#fff' : 'var(--text-secondary)',
                                            cursor: 'pointer'
                                        }}
                                        onClick={() => setLogAutoFollow(!logAutoFollow)}
                                    >
                                        {logAutoFollow ? '🟢 Streaming (2s)' : '⏸️ Stream: OFF'}
                                    </button>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input 
                                        type="text" 
                                        placeholder="Filter logs..." 
                                        style={{ ...S.input, marginTop: 0, padding: '4px 10px', fontSize: 11, width: 140 }}
                                        value={logSearch}
                                        onChange={e => setLogSearch(e.target.value)}
                                    />
                                    <button 
                                        style={{ ...S.btnO, padding: '5px 12px', fontSize: 11 }}
                                        onClick={() => {
                                            const blob = new Blob([logsContent], { type: 'text/plain;charset=utf-8' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `${activePodLogs}-${logContainer || 'default'}.log`;
                                            a.click();
                                        }}
                                    >
                                        ⬇️ Download
                                    </button>
                                    <button 
                                        style={{ ...S.btnO, padding: '5px 14px', fontSize: 11, background: 'rgba(99, 102, 241, 0.15)', borderColor: 'rgba(99, 102, 241, 0.4)', color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800 }}
                                        onClick={() => handleOpenAiDiagnose({ name: activePodLogs, containers: [{ name: logContainer }] }, logsContent)}
                                        title="以 AI 專家深度診斷當前日誌中之錯誤與崩潰根因"
                                    >
                                        🤖 AI 診斷日誌
                                    </button>
                                    <button 
                                        style={{ ...S.btnP, padding: '5px 12px', fontSize: 11 }}
                                        onClick={() => fetchLogs(activePodLogs, logContainer, logTailLines, logTimestamps)}
                                    >
                                        🔄 Refresh
                                    </button>
                                </div>
                            </div>

                            {/* Logs Display */}
                            <div style={{ flex: 1, padding: 16, background: '#0b1120', overflowY: 'auto' }}>
                                <pre style={{ margin: 0, color: '#e2e8f0', fontSize: 12, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                    {logSearch ? (
                                        logsContent.split('\n').filter(line => line.toLowerCase().includes(logSearch.toLowerCase())).join('\n') || '[No matching log lines]'
                                    ) : logsContent}
                                </pre>
                            </div>
                        </div>
                    </div>
                )}

                {showYamlModal && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowYamlModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 800, width: '90%', height: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>⚙️ Raw Configuration (YAML)</h3>
                                <button style={S.closeBtn} onClick={() => setShowYamlModal(false)}>✕</button>
                            </div>
                            <div style={{ flex: 1, padding: 16, background: '#1e1e1e', overflowY: 'auto' }}>
                                <pre style={{ margin: 0, color: '#d4d4d4', fontSize: 12, fontFamily: 'monospace' }}>
                                    {yamlContent}
                                </pre>
                            </div>
                        </div>
                    </div>
                )}

                {showScaleModal && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowScaleModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 400 }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>⚖️ Scale Deployment</h3>
                                <button style={S.closeBtn} onClick={() => setShowScaleModal(false)}>✕</button>
                            </div>
                            <form onSubmit={handleScale} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <div>
                                    <label style={S.label}>Target Deployment</label>
                                    <input type="text" style={{ ...S.input, background: 'var(--bg-secondary)', color: 'var(--text-muted)' }} value={scaleData.deploymentName} disabled />
                                </div>
                                <div>
                                    <label style={S.label}>Desired Replicas</label>
                                    <input type="number" min="0" max="100" style={S.input} value={scaleData.replicas} onChange={e => setScaleData({...scaleData, replicas: e.target.value})} required autoFocus />
                                </div>
                                <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                                    <button type="submit" style={{ ...S.btnP, flex: 1, justifyContent: 'center' }}>Apply Scale</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {showRolloutModal && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowRolloutModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 800, width: '90%', height: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>⏪ Rollout History: {rolloutData.deploymentName}</h3>
                                <button style={S.closeBtn} onClick={() => setShowRolloutModal(false)}>✕</button>
                            </div>
                            <div style={{ flex: 1, padding: 24, background: 'var(--bg-primary)', overflowY: 'auto' }}>
                                <div style={S.tblWrap}>
                                    <table style={S.tbl}>
                                        <thead>
                                            <tr>
                                                <th style={S.th}>REVISION</th>
                                                <th style={S.th}>IMAGES</th>
                                                <th style={S.th}>REPLICAS</th>
                                                <th style={S.th}>AGE</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>ACTION</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rolloutData.history.length === 0 ? (
                                                <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No history found.</td></tr>
                                            ) : (
                                                rolloutData.history.map((hist, i) => (
                                                    <tr key={i} style={S.tr}>
                                                        <td style={{ ...S.td, fontWeight: 800 }}>{hist.revision}</td>
                                                        <td style={{ ...S.td, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{hist.images}</td>
                                                        <td style={{ ...S.td, color: 'var(--text-secondary)' }}>{hist.replicas}</td>
                                                        <td style={{ ...S.td, color: 'var(--text-muted)', fontSize: 11 }}>{new Date(hist.age).toLocaleString()}</td>
                                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                                            {role !== 'Viewer' && (
                                                                <button style={S.viewBtn} onClick={() => handleRollback(rolloutData.deploymentName, hist.revision)}>Rollback to this</button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ConfigMap / Secret Content Inspector Modal (P4) */}
                {showConfigModal && activeConfigContent && (
                    <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowConfigModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 720, width: '90%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 18 }}>{activeConfigContent.resourceType === 'secret' ? '🔒' : '⚙️'}</span>
                                    <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>
                                        {activeConfigContent.resourceType === 'secret' ? 'Secret Data: ' : 'ConfigMap Data: '}
                                        <span style={{ color: 'var(--accent-primary)', fontFamily: 'monospace' }}>{activeConfigContent.resourceName}</span>
                                    </h3>
                                </div>
                                <button style={S.closeBtn} onClick={() => setShowConfigModal(false)}>✕</button>
                            </div>
                            <div style={{ padding: 20, flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
                                {activeConfigContent.resourceType === 'secret' && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8 }}>
                                        <span style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 700 }}>⚠️ Base64 values automatically decoded</span>
                                        <button
                                            style={{ ...S.btnO, padding: '4px 12px', fontSize: 11 }}
                                            onClick={() => setRevealSecret(!revealSecret)}
                                        >
                                            {revealSecret ? '🔒 Mask Values' : '👁️ Reveal Values'}
                                        </button>
                                    </div>
                                )}

                                {Object.keys(activeConfigContent.content || {}).length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No data keys found in this resource.</div>
                                ) : (
                                    Object.entries(activeConfigContent.content || {}).map(([k, v]) => (
                                        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-secondary)', padding: 14, borderRadius: 10, border: '1px solid var(--border-color)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <strong style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent-primary)' }}>{k}</strong>
                                                <button
                                                    style={{ ...S.btnO, padding: '2px 8px', fontSize: 10 }}
                                                    onClick={() => navigator.clipboard.writeText(v)}
                                                >
                                                    📋 Copy
                                                </button>
                                            </div>
                                            <pre style={{ margin: 0, padding: 12, background: 'var(--bg-primary)', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                                                {activeConfigContent.resourceType === 'secret' && !revealSecret ? '••••••••••••••••••••••••••••••••' : (typeof v === 'string' ? v : JSON.stringify(v, null, 2))}
                                            </pre>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* AI Pod & Event Incident Diagnosis Modal */}
                {showAiDiagModal && (
                    <div style={{ ...S.overlay, zIndex: 350 }} onClick={() => setShowAiDiagModal(false)}>
                        <div style={{ ...S.modal, maxWidth: 900, width: '92%', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={{ ...S.modalH, background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(6,182,212,0.06))', borderBottom: '1px solid rgba(99,102,241,0.3)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <span style={{ fontSize: 24 }}>🤖</span>
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <h3 style={{ fontSize: 16, fontWeight: 900, margin: 0, color: '#fff' }}>Kubernetes AI Pod & Event 事故診斷專家</h3>
                                            {aiDiagResult && (
                                                <span style={{
                                                    fontSize: 10,
                                                    padding: '2px 8px',
                                                    borderRadius: 10,
                                                    fontWeight: 800,
                                                    background: aiDiagResult.isAiGenerated ? 'rgba(99, 102, 241, 0.25)' : 'rgba(16, 185, 129, 0.25)',
                                                    color: aiDiagResult.isAiGenerated ? '#a5b4fc' : '#6ee7b7',
                                                    border: '1px solid ' + (aiDiagResult.isAiGenerated ? 'rgba(99, 102, 241, 0.4)' : 'rgba(16, 185, 129, 0.4)')
                                                }}>
                                                    {aiDiagResult.isAiGenerated ? `✨ LLM (${aiDiagResult.model || 'AI'})` : '⚡ 內建離線專家規則引擎'}
                                                </span>
                                            )}
                                        </div>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                                            Pod: <strong style={{ color: '#38bdf8' }}>{aiDiagPod?.name}</strong> • Namespace: <strong>{activeNamespace}</strong>
                                        </span>
                                    </div>
                                </div>
                                <button style={S.closeBtn} onClick={() => setShowAiDiagModal(false)}>✕</button>
                            </div>

                            <div style={{ flex: 1, padding: 24, overflowY: 'auto', background: 'var(--bg-primary)' }}>
                                {aiDiagLoading ? (
                                    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                                        <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
                                        <h4 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--text-primary)', fontWeight: 800 }}>AI SRE 事故專家正在診斷中...</h4>
                                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left', background: 'rgba(0,0,0,0.3)', padding: 16, borderRadius: 10, border: '1px solid var(--border-color)', marginTop: 12 }}>
                                            <span>🔍 1. 解析 Pod 狀態、終止原因與重啟次數...</span>
                                            <span>📡 2. 檢索 Namespace 關聯 Warning / BackOff 事件...</span>
                                            <span>📜 3. 讀取崩潰前 Previous 容器執行階段日誌...</span>
                                            <span>🧠 4. 深度推導根因並生成 kubectl 修復腳本...</span>
                                        </div>
                                    </div>
                                ) : aiDiagError ? (
                                    <div style={{ padding: 20, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 12, color: '#fca5a5' }}>
                                        <h4 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 800 }}>❌ 診斷失敗</h4>
                                        <p style={{ margin: 0, fontSize: 12.5 }}>{aiDiagError}</p>
                                        <button 
                                            style={{ ...S.btnP, marginTop: 12, padding: '6px 14px', fontSize: 11 }}
                                            onClick={() => handleOpenAiDiagnose(aiDiagPod)}
                                        >
                                            🔄 重試
                                        </button>
                                    </div>
                                ) : aiDiagResult ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                        {/* Summary Badges */}
                                        {aiDiagResult.podSummary && (
                                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-color)', borderRadius: 10, fontSize: 11.5 }}>
                                                <span>狀態: <strong style={{ color: aiDiagResult.podSummary.status === 'Running' ? '#10b981' : '#f87171' }}>{aiDiagResult.podSummary.status}</strong></span>
                                                <span>•</span>
                                                <span>原因: <strong style={{ color: '#fbbf24' }}>{aiDiagResult.podSummary.reason}</strong></span>
                                                <span>•</span>
                                                <span>Exit Code: <strong style={{ fontFamily: 'monospace', color: '#38bdf8' }}>{aiDiagResult.podSummary.exitCode !== null ? aiDiagResult.podSummary.exitCode : 'N/A'}</strong></span>
                                                <span>•</span>
                                                <span>重啟次數: <strong>{aiDiagResult.podSummary.restarts}</strong></span>
                                                <span>•</span>
                                                <span>節點: <strong style={{ fontFamily: 'monospace' }}>{aiDiagResult.podSummary.nodeName}</strong></span>
                                            </div>
                                        )}

                                        {/* Analysis Content */}
                                        <div style={{
                                            padding: 20,
                                            background: 'rgba(0,0,0,0.35)',
                                            border: '1px solid var(--border-color)',
                                            borderRadius: 12,
                                            fontSize: 13,
                                            lineHeight: 1.7,
                                            color: '#e2e8f0',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            fontFamily: 'inherit'
                                        }}>
                                            {aiDiagResult.analysis}
                                        </div>
                                    </div>
                                ) : null}
                            </div>

                            {/* Modal Footer */}
                            <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-secondary)' }}>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    💡 可於「System Settings &gt; AI Service」設定專屬大模型與 API 金鑰
                                </span>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    {aiDiagResult && (
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(aiDiagResult.analysis);
                                                setAiDiagCopied(true);
                                                setTimeout(() => setAiDiagCopied(false), 2000);
                                            }}
                                            style={{ ...S.btnO, padding: '7px 16px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                                        >
                                            {aiDiagCopied ? '✅ 已複製報告' : '📋 複製報告'}
                                        </button>
                                    )}
                                    {aiDiagResult && (
                                        <button
                                            onClick={() => handleOpenAiDiagnose(aiDiagPod)}
                                            disabled={aiDiagLoading}
                                            style={{ ...S.btnO, padding: '7px 16px', fontSize: 12 }}
                                        >
                                            🔄 重新分析
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowAiDiagModal(false)}
                                        style={{ ...S.btnP, padding: '7px 20px', fontSize: 12 }}
                                    >
                                        關閉
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Custom Confirm Modal for Actions inside Active Cluster View */}
                {confirmAction && (
                    <div style={{ ...S.overlay, zIndex: 300 }}>
                        <div style={{ ...S.modal, maxWidth: 400, padding: 24 }} onClick={e => e.stopPropagation()}>
                            <h3 style={{ margin: '0 0 16px', color: 'white', fontSize: 18 }}>⚠️ {confirmAction.title}</h3>
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 14 }}>{confirmAction.message}</p>
                            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                                <button style={S.btnO} onClick={() => setConfirmAction(null)}>Cancel</button>
                                <button style={S.delBtn} onClick={confirmAction.action}>Confirm Action</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div style={S.page}>
            {/* Header */}
            <div style={S.header}>
                <div><h1 className="page-title">Kubernetes Control Plane</h1><p className="page-subtitle">Manage clusters, workloads, and node health</p></div>
                <div style={S.headerBtns}>
                    {role !== 'Viewer' && <button style={S.btnP} onClick={() => openModal(null)}>+ Add Cluster</button>}
                </div>
            </div>

            {/* Top Stats */}
            <div style={S.topRow}>
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <span style={{ fontSize: 14, fontWeight: 900, letterSpacing: '0.06em' }}>CLUSTER OVERVIEW</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                        {Object.entries(envGroups).map(([env, cnt]) => (
                            <div 
                                key={env} 
                                onClick={() => setSelectedEnv(selectedEnv === env ? null : env)}
                                onMouseEnter={() => setHoveredEnv(env)}
                                onMouseLeave={() => setHoveredEnv(null)}
                                style={{ 
                                    background: selectedEnv === env ? 'var(--bg-glass)' : (hoveredEnv === env ? 'var(--bg-glass-hover)' : 'var(--bg-primary)'), 
                                    border: selectedEnv === env ? '1.5px solid var(--accent-primary)' : (hoveredEnv === env ? '1.5px solid var(--text-muted)' : '1px solid var(--border-color)'), 
                                    borderRadius: 12, 
                                    padding: 16,
                                    cursor: 'pointer',
                                    boxShadow: selectedEnv === env ? '0 8px 20px var(--accent-glow)' : 'none',
                                    transform: selectedEnv === env || hoveredEnv === env ? 'translateY(-2px)' : 'translateY(0)',
                                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                    <span style={{ fontSize: 14 }}>⏱️</span>
                                    <span style={{ fontSize: 13, fontWeight: 800 }}>{env}</span>
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cnt} cluster{cnt > 1 ? 's' : ''}</span>
                                <div style={{ height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', borderRadius: 10, background: 'var(--accent-primary)', width: `${clusters.length ? (cnt / clusters.length) * 100 : 0}%` }} />
                                </div>
                            </div>
                        ))}
                        {Object.keys(envGroups).length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>No clusters yet</div>}
                    </div>
                </div>
                <div style={S.metCol}>
                    <div style={S.metCard}><span style={S.metLabel}>TOTAL CLUSTERS</span><div style={S.metVal}>{clusters.length}</div></div>
                    <div style={S.metCard}><span style={S.metLabel}>ENVIRONMENTS</span><div style={S.metVal}>{Object.keys(envGroups).length}</div></div>
                </div>
            </div>

            {/* Clusters Table */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <h3 style={S.tblTitle}>Clusters</h3>
                        {selectedEnv && (
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', borderRadius: 16, fontSize: 11, fontWeight: 800,
                                background: 'var(--bg-secondary)', border: '1px solid var(--accent-primary)', color: 'var(--text-primary)',
                                boxShadow: '0 2px 8px var(--accent-glow)', animation: 'fadeIn 0.2s ease-out'
                            }}>
                                <span>Env: <strong>{selectedEnv}</strong></span>
                                <button onClick={() => setSelectedEnv(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Clear Env Filter">✕</button>
                            </div>
                        )}
                        <div style={S.sBox}><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>🔍</span><input type="text" placeholder="Filter clusters..." style={S.sInput} value={clusterSearch} onChange={e => setClusterSearch(e.target.value)} /></div>
                    </div>
                </div>
                <table style={S.tbl}>
                    <thead><tr>
                        <th style={S.th} onClick={() => requestSort('name')}>NAME{sortArrow('name')}</th>
                        <th style={S.th} onClick={() => requestSort('environment')}>ENVIRONMENT{sortArrow('environment')}</th>
                        <th style={S.th} onClick={() => requestSort('authType')}>AUTH TYPE{sortArrow('authType')}</th>
                        <th style={S.th}>API URL</th>
                        <th style={S.th}>SSH AUTH</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                    </tr></thead>
                    <tbody>
                        {sortedClusters.map(c => (
                            <tr key={c.id} style={{ ...S.tr, cursor: 'pointer' }} onClick={() => { setActiveCluster(c); setTab('DASHBOARD'); }}>
                                <td style={{ ...S.td, fontWeight: 800 }}>{c.name}</td>
                                <td style={S.td}>
                                    <span style={c.envIsProduction ? S.badgeDanger : S.badgeSuccess} title={c.envUnmapped ? `Stored value "${c.envUnmapped}" is not in Settings -> Environments` : ''}>
                                        {c.environment}
                                    </span>
                                </td>
                                <td style={{ ...S.td, fontFamily: 'monospace' }}>{c.authType}</td>
                                <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{c.apiUrl || '<via kubeconfig>'}</td>
                                <td style={S.td}>
                                    {c.hasSshAuth ? (
                                        <span style={S.badgeSuccess}>🔑 Configured</span>
                                    ) : (
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fallback</span>
                                    )}
                                </td>
                                <td style={{ ...S.td, textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                        {role !== 'Viewer' ? (
                                            <>
                                                <button style={S.viewBtn} onClick={e => { e.stopPropagation(); openModal(c); }}>EDIT</button>
                                                <button style={S.delBtn} onClick={e => { e.stopPropagation(); handleDeleteCluster(c.id); }}>DELETE</button>
                                            </>
                                        ) : (
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Read Only</span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {sortedClusters.length === 0 && <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No clusters found.</td></tr>}
                    </tbody>
                </table>
            </div>

            {/* Custom Confirm Modal */}
            {confirmAction && (
                <div style={{ ...S.overlay, zIndex: 300 }}>
                    <div style={{ ...S.modal, maxWidth: 400, padding: 24 }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 16px', color: 'white', fontSize: 18 }}>⚠️ {confirmAction.title}</h3>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 14 }}>{confirmAction.message}</p>
                        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                            <button style={S.btnO} onClick={() => setConfirmAction(null)}>Cancel</button>
                            <button style={S.delBtn} onClick={confirmAction.action}>Confirm Action</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit/Add Cluster Modal with SSH Section */}
            {showModal && (
                <div style={{ ...S.overlay, zIndex: 300 }} onClick={() => setShowModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 540 }} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>{isEditing ? '✏️ Edit Cluster Config' : '☸️ Add New Cluster'}</h3>
                            <button style={S.closeBtn} onClick={() => setShowModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSaveCluster} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '80vh', overflowY: 'auto' }}>
                            <div>
                                <label style={S.label}>Cluster Name</label>
                                <input type="text" style={S.input} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g., prod-k8s-01" required />
                            </div>
                            
                            <div>
                                <label style={S.label}>Environment</label>
                                <select style={S.input} value={formData.environment} onChange={e => setFormData({...formData, environment: e.target.value})}>
                                    <option value="" disabled>Choose an environment...</option>
                                    {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                                </select>
                            </div>

                            <div>
                                <label style={S.label}>Authentication Method</label>
                                <select style={S.input} value={formData.authType} onChange={e => setFormData({...formData, authType: e.target.value})}>
                                    <option value="kubeconfig">Kubeconfig File Content</option>
                                    <option value="token">Service Account Token + API URL</option>
                                </select>
                            </div>

                            {formData.authType === 'kubeconfig' && (
                                <div>
                                    <label style={S.label}>Kubeconfig YAML {isEditing && <span style={{ color: 'var(--warning)', fontWeight: 500 }}>(Encrypted. Leave blank to keep existing)</span>}</label>
                                    <textarea 
                                        style={{ ...S.input, height: 110, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
                                        placeholder={isEditing ? 'Paste new YAML to overwrite...' : 'Paste full kubeconfig content here...'}
                                        value={formData.kubeconfig}
                                        onChange={e => setFormData({...formData, kubeconfig: e.target.value})}
                                        required={!isEditing}
                                    />
                                </div>
                            )}

                            {formData.authType === 'token' && (
                                <>
                                    <div>
                                        <label style={S.label}>API Server URL</label>
                                        <input type="text" style={{ ...S.input, fontFamily: 'monospace' }} placeholder="https://10.0.0.1:6443" value={formData.apiUrl} onChange={e => setFormData({...formData, apiUrl: e.target.value})} required />
                                    </div>
                                    <div>
                                        <label style={S.label}>Bearer Token {isEditing && <span style={{ color: 'var(--warning)', fontWeight: 500 }}>(Encrypted. Leave blank to keep existing)</span>}</label>
                                        <input type="password" style={{ ...S.input, fontFamily: 'monospace' }} placeholder="ey..." value={formData.token} onChange={e => setFormData({...formData, token: e.target.value})} required={!isEditing} />
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
                                        <input type="checkbox" id="skipTls" checked={formData.skipTlsVerify} onChange={e => setFormData({...formData, skipTlsVerify: e.target.checked})} style={{ accentColor: 'var(--accent-primary)' }} />
                                        <label htmlFor="skipTls" style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', cursor: 'pointer' }}>Skip TLS Verify (Insecure)</label>
                                    </div>
                                </>
                            )}

                            {/* SSH Credentials Card */}
                            <div style={{ padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 13 }}>🔑</span>
                                    <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent-primary)', letterSpacing: '0.04em' }}>NODE SSH CREDENTIALS (Auto-Encrypted)</span>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                                    <div>
                                        <label style={S.label}>SSH User</label>
                                        <input type="text" style={S.input} placeholder="Default: LINUX_ADMIN_USER" value={formData.sshUser || ''} onChange={e => setFormData({...formData, sshUser: e.target.value})} />
                                    </div>
                                    <div>
                                        <label style={S.label}>Port</label>
                                        <input type="number" style={S.input} placeholder="22" value={formData.sshPort || 22} onChange={e => setFormData({...formData, sshPort: e.target.value})} />
                                    </div>
                                </div>
                                <div>
                                    <label style={S.label}>SSH Password {isEditing && <span style={{ color: 'var(--warning)', fontWeight: 500 }}>(Encrypted. Leave blank to keep existing)</span>}</label>
                                    <input type="password" style={S.input} placeholder={isEditing ? '••••••••' : 'Preset node password (AES-256 Encrypted)'} value={formData.sshPassword || ''} onChange={e => setFormData({...formData, sshPassword: e.target.value})} />
                                </div>
                            </div>

                            {/* P3: Prometheus Monitoring Configuration Card */}
                            <div style={{ padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontSize: 13 }}>📊</span>
                                        <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent-primary)', letterSpacing: '0.04em' }}>PROMETHEUS MONITORING INTEGRATION</span>
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: formData.enablePrometheus ? 'var(--success)' : 'var(--text-muted)' }}>
                                        <input
                                            type="checkbox"
                                            checked={formData.enablePrometheus}
                                            onChange={e => setFormData({...formData, enablePrometheus: e.target.checked})}
                                            style={{ accentColor: 'var(--accent-primary)' }}
                                        />
                                        Enable
                                    </label>
                                </div>

                                {formData.enablePrometheus && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                                        <div>
                                            <label style={S.label}>Prometheus Server URL</label>
                                            <input
                                                type="text"
                                                style={{ ...S.input, fontFamily: 'monospace' }}
                                                placeholder="http://prometheus-k8s.monitoring.svc:9090"
                                                value={formData.prometheusUrl || ''}
                                                onChange={e => setFormData({...formData, prometheusUrl: e.target.value})}
                                            />
                                        </div>
                                        <div>
                                            <label style={S.label}>Authentication Method</label>
                                            <select
                                                style={S.input}
                                                value={formData.promAuthType || 'none'}
                                                onChange={e => setFormData({...formData, promAuthType: e.target.value})}
                                            >
                                                <option value="none">No Auth (Direct / Internal)</option>
                                                <option value="basic">Basic Auth (Username + Password)</option>
                                                <option value="bearer">Bearer Token</option>
                                            </select>
                                        </div>

                                        {formData.promAuthType === 'basic' && (
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                                <div>
                                                    <label style={S.label}>Prometheus User</label>
                                                    <input
                                                        type="text"
                                                        style={S.input}
                                                        placeholder="admin"
                                                        value={formData.promUser || ''}
                                                        onChange={e => setFormData({...formData, promUser: e.target.value})}
                                                    />
                                                </div>
                                                <div>
                                                    <label style={S.label}>Prometheus Password {isEditing && <span style={{ color: 'var(--warning)', fontSize: 10 }}>(Encrypted)</span>}</label>
                                                    <input
                                                        type="password"
                                                        style={S.input}
                                                        placeholder={isEditing ? '••••••••' : 'Password'}
                                                        value={formData.promPassword || ''}
                                                        onChange={e => setFormData({...formData, promPassword: e.target.value})}
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        {formData.promAuthType === 'bearer' && (
                                            <div>
                                                <label style={S.label}>Prometheus Bearer Token {isEditing && <span style={{ color: 'var(--warning)', fontSize: 10 }}>(Encrypted)</span>}</label>
                                                <input
                                                    type="password"
                                                    style={{ ...S.input, fontFamily: 'monospace' }}
                                                    placeholder={isEditing ? '••••••••' : 'eyJhbG...'}
                                                    value={formData.promToken || ''}
                                                    onChange={e => setFormData({...formData, promToken: e.target.value})}
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* P4: Networking & Ingress Domain Card */}
                            <div style={{ padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 13 }}>🌐</span>
                                    <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent-primary)', letterSpacing: '0.04em' }}>INGRESS & GATEWAY ROUTING</span>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                    <div>
                                        <label style={S.label}>Ingress Domain Suffix</label>
                                        <input
                                            type="text"
                                            style={S.input}
                                            placeholder="e.g., apps.k8s.corp.net"
                                            value={formData.ingressDomain || ''}
                                            onChange={e => setFormData({...formData, ingressDomain: e.target.value})}
                                        />
                                    </div>
                                    <div>
                                        <label style={S.label}>Gateway / LB IP</label>
                                        <input
                                            type="text"
                                            style={S.input}
                                            placeholder="e.g., http://10.10.20.100"
                                            value={formData.ingressGatewayUrl || ''}
                                            onChange={e => setFormData({...formData, ingressGatewayUrl: e.target.value})}
                                        />
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                                <button type="submit" style={{ ...S.btnP, flex: 1, justifyContent: 'center' }}>{isEditing ? 'Update Configuration' : 'Save Configuration'}</button>
                                <button type="button" style={{ ...S.btnO, flex: 1, justifyContent: 'center' }} onClick={() => setShowModal(false)}>Cancel</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default KubernetesManager;
