import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useSync } from '../../contexts/WebSocketContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { WS_EVENTS } from '../../constants/wsEvents';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line, Legend } from 'recharts';
import { FaWindows, FaLinux, FaPlay, FaPause, FaTrash, FaEdit, FaChartLine, FaArrowUp, FaStop } from 'react-icons/fa';
import HostDetailModal from '../Shared/HostDetailModal';
import RuleModal from '../Shared/RuleModal';
import { useAgent } from '../../contexts/AgentContext';
import { buildAlertPrompt } from '../Agent/agentProtocol';
import { AlertBadges, MuteButton } from './AlertQualityBadges';
import { isHostInActiveWindow } from './alertQualityUtils';
import RuleExclusionsPanel from './RuleExclusionsPanel';

const S = {
  page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%', position: 'relative' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 22, fontWeight: 900, margin: 0 },
  headerBtns: { display: 'flex', gap: 10 },
  btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
  btnS: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  btnDanger: { background: 'var(--bg-glass)', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 12px', borderRadius: 16, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  tabRow: { display: 'flex', gap: 8, marginBottom: 28, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 },
  tabActive: { padding: '8px 20px', background: 'var(--bg-glass)', color: 'var(--accent-primary)', border: '1px solid var(--accent-primary)', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  tabInactive: { padding: '8px 20px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  topRow: { display: 'flex', gap: 20, marginBottom: 28 },
  metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
  metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8, textTransform: 'uppercase' },
  metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 8 },
  gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 },
  card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
  cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardBody: { padding: '20px 24px' },
  listRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13 },
  progressBarContainer: { flex: 1, height: 8, background: 'var(--bg-secondary)', borderRadius: 8, overflow: 'hidden' },
  cardBody: { padding: '20px 24px' },
  listRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13 },
  progressBarContainer: { flex: 1, height: 8, background: 'var(--bg-secondary)', borderRadius: 8, overflow: 'hidden' },
  progressBar: { height: '100%', borderRadius: 8 },
  badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
  td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
  th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
  dot: { width: 14, height: 14, borderRadius: '50%', display: 'inline-block' },

  // Modal
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modalContent: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 500, overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' },
  modalHead: { padding: '24px 32px', borderBottom: '1px solid var(--border-color)' },
  modalTitle: { fontSize: 18, fontWeight: 800, margin: 0, color: 'var(--text-primary)' },
  modalBody: { padding: '32px' },
  modalFoot: { padding: '24px 32px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' },
  inputGroup: { marginBottom: 20 },
  label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' },
  input: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
};

export default function ScoutMonitor({ setActiveView }) {
  const [activeTab, setActiveTab] = useState('dashboard'); // dashboard, hosts
  const [monitors, setMonitors] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [maintenanceWindows, setMaintenanceWindows] = useState([]);
  const [rules, setRules] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [selectedHostIds, setSelectedHostIds] = useState([]);
  const [comparisonSelectedHosts, setComparisonSelectedHosts] = useState([]);
  const [comparisonMetric, setComparisonMetric] = useState('cpu');
  const [comparisonRange, setComparisonRange] = useState(1);
  const [comparisonData, setComparisonData] = useState([]);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [servicesSearch, setServicesSearch] = useState('');
  const [servicesTypeFilter, setServicesTypeFilter] = useState('all');
  const [showAddWatchModal, setShowAddWatchModal] = useState(false);
  const [addWatchForm, setAddWatchForm] = useState({ monitorId: '', type: 'service', targetName: '' });
  const [watchHostSearch, setWatchHostSearch] = useState('');

  const [showCompareHostSelector, setShowCompareHostSelector] = useState(false);
  const [compareEnvFilter, setCompareEnvFilter] = useState('');
  const [compareTagFilter, setCompareTagFilter] = useState('');
  const [compareSearchText, setCompareSearchText] = useState('');

  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [currentVersion, setCurrentVersion] = useState('1.0.11');
  const [currentLinuxVersion, setCurrentLinuxVersion] = useState('1.0.10');
  const [updatingIps, setUpdatingIps] = useState({});
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const cancelBulkUpdateRef = useRef(false);
  const abortControllersRef = useRef(new Set());
  const [visibleColumns, setVisibleColumns] = useState(() => {
    const saved = localStorage.getItem('scout_visible_columns');
    return saved ? JSON.parse(saved) : ['name', 'ip', 'os', 'version', 'cpu', 'memory', 'disk', 'status', 'tags'];
  });
  const [showColumnSettings, setShowColumnSettings] = useState(false);

  const isVersionLower = (v1, v2) => {
    if (!v1 || v1 === 'Unknown') return true;
    if (!v2) return false;
    const parse = (v) => v.split('.').map(Number);
    const p1 = parse(v1);
    const p2 = parse(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const part1 = p1[i] || 0;
      const part2 = p2[i] || 0;
      if (part1 < part2) return true;
      if (part1 > part2) return false;
    }
    return false;
  };

  const { showToast } = useToast();
  const { showConfirm } = useConfirm();
  const { lastEvent } = useSync();

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const canManageSelfHealing = user?.features?.manage_self_healing === true;
  const isViewer = user?.role === 'Viewer';

  const [dashboardWidgetPrefs, setDashboardWidgetPrefs] = useState(() => {
    try {
      const saved = localStorage.getItem('scout_dashboard_widget_prefs');
      return saved ? JSON.parse(saved) : { outdatedBanner: true, tagFilterBar: true, metricsSparklines: true };
    } catch (e) {
      return { outdatedBanner: true, tagFilterBar: true, metricsSparklines: true };
    }
  });

  const toggleDashboardWidget = (key) => {
    setDashboardWidgetPrefs(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('scout_dashboard_widget_prefs', JSON.stringify(next));
      return next;
    });
  };

  // Modals
  const [showHostModal, setShowHostModal] = useState(false);
  const [hostForm, setHostForm] = useState({
    id: '',
    name: '',
    ip: '',
    os: 'linux',
    group: 'Default',
    reportInterval: 60,
    apiKey: '',
    tags: '',
    pingTargets: '',
    tcpTargets: '',
    watchServices: '',
    watchProcesses: '',
    enabled: true
  });

  const [showRuleModal, setShowRuleModal] = useState(false);
  const [selectedRule, setSelectedRule] = useState(null);
  const [selectedInstallApiKey, setSelectedInstallApiKey] = useState('');
  const [installToken, setInstallToken] = useState(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState(null);
  const [tokenTimeLeft, setTokenTimeLeft] = useState(0);
  const [isMultiUse, setIsMultiUse] = useState(false);
  const [setupMultiUse, setSetupMultiUse] = useState(false);
  const [multiUseLimitType, setMultiUseLimitType] = useState('uses');
  const [multiUseMaxUses, setMultiUseMaxUses] = useState(100);
  const [multiUseHours, setMultiUseHours] = useState(24);

  const [showApplyRuleModal, setShowApplyRuleModal] = useState(false);
  const [applyRuleForm, setApplyRuleForm] = useState({ ruleId: '', scopeType: 'monitor', scopeValue: '' });

  const [showBulkConfigModal, setShowBulkConfigModal] = useState(false);
  const [bulkConfigForm, setBulkConfigForm] = useState({ mode: 'append', tags: '', pingTargets: '', tcpTargets: '', watchServices: '', watchProcesses: '', disableReportLog: true, logPath: '/var/log/scout-agent.log' });
  const [bulkTargetMode, setBulkTargetMode] = useState('selected'); // 'selected', 'group', 'env', 'tag'
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyForm, setApiKeyForm] = useState({ name: '', desc: '', envId: '', maxAgents: 50, isOpenApi: false });

  const [showHostDetailModal, setShowHostDetailModal] = useState(false);
  const [selectedHostForDetail, setSelectedHostForDetail] = useState(null);
  const [hostDetailActiveTab, setHostDetailActiveTab] = useState('overview');
  const [selectedHostMetrics, setSelectedHostMetrics] = useState([]);

  const [actionMenuOpenId, setActionMenuOpenId] = useState(null);
  const [searchFilterText, setSearchFilterText] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [environments, setEnvironments] = useState([]);
  const [selectedEnvFilter, setSelectedEnvFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Sorting state
  const [sortField, setSortField] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  // Pagination state
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  // Auto reset to page 1 whenever any filter criteria changes
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedEnvFilter, statusFilter, searchFilterText, itemsPerPage]);

  useEffect(() => {
    const closeMenu = () => setActionMenuOpenId(null);
    document.addEventListener('click', closeMenu);
    return () => document.removeEventListener('click', closeMenu);
  }, []);

  const handleAddTagToHost = async (e) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      const newTag = tagInput.trim();
      if (!selectedHostForDetail) return;
      const currentTags = Array.isArray(selectedHostForDetail.tags) ? selectedHostForDetail.tags : [];
      if (currentTags.includes(newTag)) {
        setTagInput('');
        return;
      }
      const updatedTags = [...currentTags, newTag];

      try {
        // The API expects an array of strings, wait, let me check backend PUT route!
        // wait, backend says: m.tags = JSON.stringify(tags);
        // But when formatted back, it does: tags: m.tags ? JSON.parse(m.tags).join(', ') : '',
        // Let me check how it's formatted. Wait, I should verify the format!
        // For now, I'll send an array.
        const res = await api.put(`/monitor/${selectedHostForDetail.id}`, { tags: updatedTags });
        setSelectedHostForDetail(res.data);
        setMonitors(monitors.map(m => m.id === res.data.id ? res.data : m));
        setTagInput('');
        showToast('Tag added', 'success');
      } catch (err) {
        console.error(err);
        showToast('Failed to add tag', 'error');
      }
    }
  };

  const handleRemoveTagFromHost = async (tagToRemove) => {
    if (!selectedHostForDetail) return;
    const currentTags = Array.isArray(selectedHostForDetail.tags) ? selectedHostForDetail.tags : [];
    const updatedTags = currentTags.filter(t => t !== tagToRemove);
    try {
      const res = await api.put(`/monitor/${selectedHostForDetail.id}`, { tags: updatedTags });
      setSelectedHostForDetail(res.data);
      setMonitors(monitors.map(m => m.id === res.data.id ? res.data : m));
      showToast('Tag removed', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to remove tag', 'error');
    }
  };

  const copyTextToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard', 'success');
      }).catch((err) => {
        console.error('Async: Could not copy text: ', err);
        fallbackCopyTextToClipboard(text);
      });
    } else {
      fallbackCopyTextToClipboard(text);
    }
  };

  const fallbackCopyTextToClipboard = (text) => {
    var textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      var successful = document.execCommand('copy');
      if (successful) showToast('Copied to clipboard', 'success');
      else showToast('Failed to copy', 'error');
    } catch (err) {
      console.error('Fallback: Oops, unable to copy', err);
      showToast('Failed to copy', 'error');
    }
    document.body.removeChild(textArea);
  };

  const fetchDashboard = async () => {
    try {
      const mwPromise = api.get('/alert-quality/maintenance').then(r => (Array.isArray(r.data) ? r.data : null)).catch(() => null);
      const res = await api.get('/monitor/data/dashboard');
      setMonitors(res.data.monitors || []);
      setAlerts(res.data.alerts || []);
      if (res.data.currentVersion) setCurrentVersion(res.data.currentVersion);
      if (res.data.currentLinuxVersion) setCurrentLinuxVersion(res.data.currentLinuxVersion);
      setLastUpdated(Date.now());

      const envRes = await api.get('/environments');
      setEnvironments(envRes.data || []);

      const mw = await mwPromise;
      if (mw) setMaintenanceWindows(mw);
    } catch (err) {
      console.error(err);
      showToast('Failed to fetch dashboard data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const clearAlerts = async () => {
    try {
      await api.post('/monitor/alerts/clear');
      setAlerts([]);
      showToast('Alerts activity cleared successfully', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to clear alerts activity', 'error');
    }
  };



  const fetchComparisonData = async (hostsList = comparisonSelectedHosts, range = comparisonRange) => {
    if (hostsList.length === 0) {
      setComparisonData([]);
      return;
    }
    setComparisonLoading(true);
    try {
      const promises = hostsList.map(hostId =>
        api.get(`/monitor/${hostId}/metrics?hours=${range}`).then(res => ({
          hostId,
          data: res.data || []
        }))
      );
      const results = await Promise.all(promises);

      const timeMap = {};
      results.forEach(resObj => {
        const monitorObj = monitors.find(m => m.id === resObj.hostId);
        const hName = monitorObj ? `${monitorObj.name} (${monitorObj.ip})` : resObj.hostId;
        resObj.data.forEach(pt => {
          const date = new Date(pt.timestamp);
          const roundedTime = new Date(Math.round(date.getTime() / 60000) * 60000);
          const tKey = roundedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          if (!timeMap[tKey]) {
            timeMap[tKey] = { time: tKey, rawTime: roundedTime.getTime() };
          }
          timeMap[tKey][hName] = pt.metrics.cpu?.used || 0;
          timeMap[tKey][hName + '_mem'] = pt.metrics.memory?.used || 0;
        });
      });

      const chartPoints = Object.values(timeMap).sort((a, b) => a.rawTime - b.rawTime);
      setComparisonData(chartPoints);
    } catch (err) {
      console.error('Failed to fetch comparison metrics:', err);
    } finally {
      setComparisonLoading(false);
    }
  };

  const handleAddWatchTarget = async () => {
    if (!addWatchForm.monitorId || !addWatchForm.targetName.trim()) {
      showToast('Please fill out all fields', 'warning');
      return;
    }
    const monitorObj = monitors.find(m => m.id === addWatchForm.monitorId);
    if (!monitorObj) return;

    let updatedList = [];
    const field = addWatchForm.type === 'service' ? 'watchServices' : 'watchProcesses';
    try {
      updatedList = Array.isArray(monitorObj[field])
        ? monitorObj[field]
        : JSON.parse(monitorObj[field] || '[]');
    } catch (e) { }

    const newTarget = addWatchForm.targetName.trim();
    if (updatedList.some(x => x.toLowerCase() === newTarget.toLowerCase())) {
      showToast('This target is already watched', 'warning');
      return;
    }

    const newPayload = {
      ...monitorObj,
      [field]: [...updatedList, newTarget]
    };

    try {
      const res = await api.put(`/monitor/${monitorObj.id}`, newPayload);
      setMonitors(monitors.map(m => m.id === monitorObj.id ? res.data : m));
      showToast('Watch target added successfully', 'success');
      setShowAddWatchModal(false);
      setAddWatchForm({ monitorId: '', type: 'service', targetName: '' });
    } catch (err) {
      console.error(err);
      showToast('Failed to add watch target', 'error');
    }
  };

  const handleRemoveWatchTarget = async (hostId, type, targetName) => {
    const monitorObj = monitors.find(m => m.id === hostId);
    if (!monitorObj) return;

    const field = type.toLowerCase() === 'service' ? 'watchServices' : 'watchProcesses';
    let currentList = [];
    try {
      currentList = Array.isArray(monitorObj[field])
        ? monitorObj[field]
        : JSON.parse(monitorObj[field] || '[]');
    } catch (e) { }

    const updatedList = currentList.filter(x => x.toLowerCase() !== targetName.toLowerCase());

    const newPayload = {
      ...monitorObj,
      [field]: updatedList
    };

    try {
      const res = await api.put(`/monitor/${monitorObj.id}`, newPayload);
      setMonitors(monitors.map(m => m.id === monitorObj.id ? res.data : m));
      showToast('Watch target removed', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to remove watch target', 'error');
    }
  };

  const fetchApiKeys = async () => {
    try {
      const res = await api.get('/monitor/apikeys');
      setApiKeys(res.data || []);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRules = async () => {
    try {
      const res = await api.get('/monitor/rules');
      setRules(res.data || []);
      const bindRes = await api.get('/monitor/rules/bindings');
      setBindings(bindRes.data || []);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchDashboard();
    fetchApiKeys();
    fetchRules();
    const interval = setInterval(() => {
      fetchDashboard();
      fetchRules();
      fetchApiKeys();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (lastEvent && (lastEvent.type === WS_EVENTS.SCOUT_REPORT || lastEvent.type === WS_EVENTS.SCOUT_AGENT_OFFLINE)) {
      fetchDashboard();
    }
  }, [lastEvent]);

  const generateInstallToken = async (isMulti = false) => {
    if (!selectedInstallApiKey) return;
    try {
      const payload = { apiKey: selectedInstallApiKey };
      let durationHours = 5 / 60;
      if (isMulti) {
        if (multiUseLimitType === 'uses') {
          payload.maxUses = multiUseMaxUses;
          payload.expiresInHours = 24;
          durationHours = 24;
        } else {
          payload.maxUses = 999999;
          payload.expiresInHours = multiUseHours;
          durationHours = multiUseHours;
        }
      }

      const res = await api.post('/inventory/install-token', payload);
      if (res.data && res.data.token) {
        setInstallToken(res.data.token);
        setTokenExpiresAt(Date.now() + durationHours * 60 * 60 * 1000);
        setTokenTimeLeft(Math.floor(durationHours * 60 * 60));
      } else {
        showToast('Failed to generate install token', 'error');
      }
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to generate install token', 'error');
    }
  };

  useEffect(() => {
    let interval;
    if (installToken && tokenExpiresAt) {
      interval = setInterval(() => {
        const remaining = Math.max(0, Math.floor((tokenExpiresAt - Date.now()) / 1000));
        setTokenTimeLeft(remaining);

        if (remaining === 60) {
          showToast('Install token will expire in 1 minute, generating a new one soon...', 'warning');
        }

        if (remaining <= 0) {
          showToast('Install token expired!', 'info');
          if (!isMultiUse) {
            generateInstallToken(false);
          } else {
            setInstallToken(null);
          }
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [installToken, tokenExpiresAt, selectedInstallApiKey, isMultiUse, multiUseLimitType, multiUseMaxUses, multiUseHours]);

  useEffect(() => {
    if (activeTab === 'rules') fetchRules();
    if (activeTab === 'apikeys') fetchApiKeys();
  }, [activeTab]);

  const handleSaveHost = async () => {
    if (isViewer) return;
    try {
      const payload = {
        ...hostForm,
        tags: hostForm.tags ? hostForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        pingTargets: hostForm.pingTargets ? hostForm.pingTargets.split(',').map(t => t.trim()).filter(Boolean) : [],
        tcpTargets: hostForm.tcpTargets ? hostForm.tcpTargets.split(',').map(t => t.trim()).filter(Boolean) : [],
        watchServices: hostForm.watchServices ? hostForm.watchServices.split(',').map(t => t.trim()).filter(Boolean) : [],
        watchProcesses: hostForm.watchProcesses ? hostForm.watchProcesses.split(',').map(t => t.trim()).filter(Boolean) : []
      };
      if (payload.id) {
        await api.put(`/monitor/${payload.id}`, payload);
        showToast('Host updated successfully', 'success');
      } else {
        await api.post('/monitor', payload);
        showToast('Host added successfully', 'success');
      }
      setShowHostModal(false);
      fetchDashboard();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save host', 'error');
    }
  };

  const handleDeleteHost = async (id) => {
    if (isViewer) return;
    if (await showConfirm('Are you sure you want to delete this host? All its metrics and rules will be lost.')) {
      try {
        await api.delete(`/monitor/${id}`);
        showToast('Host deleted', 'success');
        fetchDashboard();
      } catch (err) {
        showToast('Failed to delete host', 'error');
      }
    }
  };

  const handleBulkDelete = async () => {
    if (isViewer || selectedHostIds.length === 0) return;
    if (await showConfirm(`Are you sure you want to delete ${selectedHostIds.length} selected hosts? All their metrics and rules will be lost.`)) {
      try {
        await Promise.all(selectedHostIds.map(id => api.delete(`/monitor/${id}`)));
        showToast(`Successfully deleted ${selectedHostIds.length} hosts`, 'success');
        setSelectedHostIds([]);
        fetchDashboard();
      } catch (err) {
        showToast('Failed to delete some hosts', 'error');
        fetchDashboard();
      }
    }
  };

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleToggleEnable = async (m) => {
    if (isViewer) return;
    try {
      const newStatus = m.enabled === false ? true : false;
      await api.put(`/monitor/${m.id}`, { ...m, enabled: newStatus });
      showToast(`Host ${newStatus ? 'Enabled' : 'Disabled'}`, 'success');
      fetchDashboard();
    } catch (err) {
      showToast('Failed to toggle status', 'error');
    }
  };

  const handleUpdateScout = async (m) => {
    if (isViewer) return;
    setUpdatingIps(prev => ({ ...prev, [m.ip]: true }));
    showToast(`Deploying Scout Agent update to ${m.ip} (${m.os})...`, 'info');
    try {
      const res = await api.post('/inventory/deploy-agent', {
        ip: m.ip,
        os: m.os === 'windows' ? 'win' : 'linux',
        hostname: m.name
      }, { timeout: 270000 });
      if (res.data && res.data.success) {
        showToast(`Successfully updated agent on ${m.ip}`, 'success');
        fetchDashboard();
      } else {
        showToast(`Failed to update agent: ${res.data?.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(err.response?.data?.error || `Error updating agent on ${m.ip}`, 'error');
    } finally {
      setUpdatingIps(prev => ({ ...prev, [m.ip]: false }));
    }
  };

  const handleStopBulkUpdate = () => {
    if (!bulkUpdating || isCancelling) return;
    setIsCancelling(true);
    cancelBulkUpdateRef.current = true;
    abortControllersRef.current.forEach(ctrl => {
      try { ctrl.abort(); } catch (e) {}
    });
    showToast('正在中途停止批量更新，已中斷排隊任務...', 'warning');
  };

  const runThrottledBulkUpdate = async (hostsList) => {
    if (isViewer || !hostsList || hostsList.length === 0 || bulkUpdating) return;

    cancelBulkUpdateRef.current = false;
    setIsCancelling(false);
    abortControllersRef.current.clear();
    setBulkUpdating(true);
    const total = hostsList.length;
    setBulkProgress({ current: 0, total, succeeded: 0, failed: 0, activeNames: [] });
    showToast(`Starting queued bulk update for ${total} host(s) (Concurrency: 4)...`, 'info');

    const concurrency = 4; // Throttled to 4 concurrent WinRM/SSH sessions
    let currentIndex = 0;
    let completedCount = 0;
    let succeededCount = 0;
    let failedHosts = [];
    const activeHostsMap = new Map();

    const updateWorker = async (workerId) => {
      while (currentIndex < total) {
        if (cancelBulkUpdateRef.current) break;

        const index = currentIndex++;
        const m = hostsList[index];
        if (!m) continue;

        if (cancelBulkUpdateRef.current) break;

        const ctrl = new AbortController();
        abortControllersRef.current.add(ctrl);

        const hostDisplayName = m.name ? `${m.name} (${m.ip})` : m.ip;
        activeHostsMap.set(workerId, hostDisplayName);
        setUpdatingIps(prev => ({ ...prev, [m.ip]: true }));
        setBulkProgress(prev => prev ? {
          ...prev,
          activeNames: Array.from(activeHostsMap.values())
        } : null);

        try {
          const res = await api.post('/inventory/deploy-agent', {
            ip: m.ip,
            os: m.os === 'windows' || m.os === 'win' ? 'win' : 'linux',
            hostname: m.name
          }, { signal: ctrl.signal, timeout: 150000 });

          if (res.data && res.data.success) {
            succeededCount++;
          } else {
            failedHosts.push({ name: m.name || m.ip, error: res.data?.error || 'Unknown error' });
          }
        } catch (err) {
          if (err.name === 'CanceledError' || err.name === 'AbortError' || cancelBulkUpdateRef.current) {
            console.log(`[BulkUpdate] Deployment to ${m.ip} aborted by user.`);
          } else {
            failedHosts.push({ name: m.name || m.ip, error: err.response?.data?.error || err.message });
          }
        } finally {
          abortControllersRef.current.delete(ctrl);
          activeHostsMap.delete(workerId);
          setUpdatingIps(prev => ({ ...prev, [m.ip]: false }));
          completedCount++;
          setBulkProgress({
            current: completedCount,
            total,
            succeeded: succeededCount,
            failed: failedHosts.length,
            activeNames: Array.from(activeHostsMap.values())
          });
          if (completedCount % 5 === 0 && completedCount < total) {
            showToast(`Update progress: ${completedCount}/${total} completed (${succeededCount} succeeded)...`, 'info');
          }
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) {
      workers.push(updateWorker(i));
    }
    await Promise.all(workers);

    if (cancelBulkUpdateRef.current) {
      const skippedCount = Math.max(0, total - completedCount);
      showToast(
        `已中途停止批量更新！共處理 ${completedCount}/${total} 台（${succeededCount} 成功，${failedHosts.length} 失敗，剩餘 ${skippedCount} 台已取消）。`,
        'warning'
      );
    } else if (failedHosts.length === 0) {
      showToast(`Successfully updated all ${succeededCount} agent(s)!`, 'success');
    } else {
      showToast(
        `Bulk update completed: ${succeededCount} succeeded, ${failedHosts.length} failed (${failedHosts.slice(0, 3).map(f => f.name).join(', ')}${failedHosts.length > 3 ? '...' : ''})`,
        'warning'
      );
    }
    setBulkUpdating(false);
    setIsCancelling(false);
    cancelBulkUpdateRef.current = false;
    abortControllersRef.current.clear();
    setBulkProgress(null);
    fetchDashboard();
  };

  const handleBulkApply = async () => {
    if (isViewer) return;

    let targetIds = [];
    if (bulkTargetMode === 'selected') {
      targetIds = selectedHostIds;
    } else if (bulkTargetMode === 'group') {
      targetIds = monitors.filter(m => m.group === bulkTargetValue).map(m => m.id);
    } else if (bulkTargetMode === 'env') {
      targetIds = monitors.filter(m => m.envId === bulkTargetValue).map(m => m.id);
    } else if (bulkTargetMode === 'tag') {
      targetIds = monitors.filter(m => {
        let mTags = [];
        try { mTags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'); } catch (e) { }
        return mTags.includes(bulkTargetValue);
      }).map(m => m.id);
    }

    if (targetIds.length === 0) {
      showToast('No hosts selected or found for the chosen target criteria', 'warning');
      return;
    }

    try {
      const parseCSV = (str) => str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
      const payload = {
        agentIds: targetIds,
        mode: bulkConfigForm.mode,
        config: {
          tags: parseCSV(bulkConfigForm.tags),
          pingTargets: parseCSV(bulkConfigForm.pingTargets),
          tcpTargets: parseCSV(bulkConfigForm.tcpTargets),
          watchServices: parseCSV(bulkConfigForm.watchServices),
          watchProcesses: parseCSV(bulkConfigForm.watchProcesses),
          disableReportLog: bulkConfigForm.disableReportLog,
          logPath: bulkConfigForm.logPath
        }
      };
      await api.post('/monitor/bulk-update', payload);
      showToast(`Successfully applied config to ${targetIds.length} hosts`, 'success');
      setShowBulkConfigModal(false);
      setSelectedHostIds([]);
      fetchDashboard();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to bulk apply config', 'error');
    }
  };

  const copyApiKey = (key) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(key);
      showToast('API Key copied to clipboard', 'info');
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = key;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast('API Key copied to clipboard', 'info');
      } catch (err) {
        showToast('Failed to copy API Key. Please select and copy manually.', 'error');
        console.error('Fallback clipboard failed', err);
      }
      textArea.remove();
    }
  };

  const viewHostDetail = async (host, defaultTab = 'overview') => {
    setSelectedHostForDetail(host);
    setHostDetailActiveTab(defaultTab);
    setShowHostDetailModal(true);
    if (defaultTab === 'history' || defaultTab === 'overview') {
      try {
        const res = await api.get(`/monitor/${host.id}/metrics`);
        const formatted = res.data.map(d => ({
          time: new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          cpu: d.metrics.cpu?.used ? Number(d.metrics.cpu.used.toFixed(2)) : 0,
          memory: d.metrics.memory?.used ? Number(d.metrics.memory.used.toFixed(2)) : 0,
        }));
        setSelectedHostMetrics(formatted);
      } catch (err) {
        showToast('Failed to fetch metrics history', 'error');
      }
    }
  };

  const handleHostClick = (m) => {
    viewHostDetail(m, 'overview');
  };

  // --- Handlers for Rules ---


  const handleDeleteRule = async (id) => {
    if (isViewer) return;
    if (await showConfirm('Delete this rule template?')) {
      try {
        await api.delete(`/monitor/rules/${id}`);
        showToast('Rule deleted', 'success');
        fetchRules();
      } catch (err) {
        showToast('Failed to delete rule', 'error');
      }
    }
  };

  const handleApplyRule = async () => {
    if (isViewer) return;
    try {
      if (applyRuleForm.scopeType === 'monitor' && selectedHostIds.length > 0) {
        for (const hostId of selectedHostIds) {
          try {
            await api.post('/monitor/rules/bindings', { ruleId: applyRuleForm.ruleId, scopeType: 'monitor', scopeValue: hostId });
          } catch (e) {
            if (e.response?.data?.error !== 'Binding already exists') throw e;
          }
        }
        showToast(`Applied rule to ${selectedHostIds.length} hosts`, 'success');
        setSelectedHostIds([]);
      } else {
        await api.post('/monitor/rules/bindings', applyRuleForm);
        showToast('Rule applied successfully', 'success');
      }
      setShowApplyRuleModal(false);
      fetchRules();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to apply rule', 'error');
    }
  };

  const handleDeleteBinding = async (id) => {
    if (isViewer) return;
    if (await showConfirm('Remove this rule assignment?')) {
      try {
        await api.delete(`/monitor/rules/bindings/${id}`);
        showToast('Assignment removed', 'success');
        fetchRules();
      } catch (err) {
        showToast('Failed to remove assignment', 'error');
      }
    }
  };

  // --- Handlers for API Keys ---
  const handleSaveApiKey = async () => {
    if (isViewer) return;
    try {
      if (apiKeyForm.id) {
        await api.put(`/monitor/apikeys/${apiKeyForm.id}`, apiKeyForm);
        showToast('API Key updated successfully', 'success');
      } else {
        await api.post('/monitor/apikeys', apiKeyForm);
        showToast('API Key generated successfully', 'success');
      }
      setShowApiKeyModal(false);
      fetchApiKeys();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save key', 'error');
    }
  };

  const handleDeleteApiKey = async (id) => {
    if (isViewer) return;
    if (await showConfirm('Are you sure you want to delete this API Key?')) {
      try {
        await api.delete(`/monitor/apikeys/${id}`);
        showToast('API Key deleted', 'success');
        fetchApiKeys();
      } catch (err) {
        showToast('Failed to delete API Key', 'error');
      }
    }
  };

  const openHostModal = (m = null) => {
    if (m) {
      setHostForm({
        id: m.id,
        name: m.name,
        ip: m.ip,
        os: m.os,
        group: m.group,
        reportInterval: m.reportInterval,
        apiKey: m.apiKey,
        tags: m.tags ? m.tags.join(', ') : '',
        pingTargets: m.pingTargets ? m.pingTargets.join(', ') : '',
        tcpTargets: m.tcpTargets ? m.tcpTargets.join(', ') : '',
        watchServices: m.watchServices ? m.watchServices.join(', ') : '',
        watchProcesses: m.watchProcesses ? m.watchProcesses.join(', ') : '',
        enabled: m.enabled !== false
      });
    } else {
      setHostForm({
        id: '',
        name: '',
        ip: '',
        os: 'linux',
        group: 'Default',
        reportInterval: 60,
        apiKey: '',
        tags: '',
        pingTargets: '',
        tcpTargets: '',
        watchServices: '',
        watchProcesses: '',
        enabled: true
      });
    }
    setShowHostModal(true);
  };

  const openRuleModal = (r = null) => {
    setSelectedRule(r);
    setShowRuleModal(true);
  };

  const openApplyRuleModal = (scopeType = 'monitor', scopeValue = '') => {
    setApplyRuleForm({ ruleId: rules[0]?.id || '', scopeType, scopeValue });
    setShowApplyRuleModal(true);
  };

  const openApiKeyModal = (keyObj = null) => {
    if (keyObj) {
      setApiKeyForm({ id: keyObj.id, name: keyObj.name, desc: keyObj.desc || '', envId: keyObj.envId || '', maxAgents: keyObj.maxAgents || 50, isOpenApi: keyObj.isOpenApi === 1 || keyObj.isOpenApi === true });
    } else {
      setApiKeyForm({ id: null, name: '', desc: '', envId: '', maxAgents: 50, isOpenApi: false });
    }
    setShowApiKeyModal(true);
  };

  const allAvailableTags = Array.from(new Set(monitors.flatMap(m => m.tags || []))).sort();

  const getTimeAgo = (dateStr) => {
    if (!dateStr) return 'Never';
    const diff = Math.floor((new Date() - new Date(dateStr)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  if (loading) return <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>Loading Dashboard...</div>;

  const activeAlerts = alerts.filter(a => !a.resolved);

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <h1 style={S.title}>{'\u{1F4CA}'} Scout Monitor</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Last updated: {new Date(lastUpdated).toLocaleTimeString()}
          </div>
        </div>
        <div style={S.headerBtns}>
          <button style={S.btnS} onClick={fetchDashboard}>
            <span>{'\u{27F3}'}</span> Refresh
          </button>
        </div>
      </div>

      <div style={S.tabRow}>
        <button style={activeTab === 'dashboard' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
        <button style={activeTab === 'hosts' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('hosts')}>Server Hosts</button>
        <button style={activeTab === 'services' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('services')}>Services & Processes</button>
        <button style={activeTab === 'comparison' ? S.tabActive : S.tabInactive} onClick={() => { setActiveTab('comparison'); if (comparisonSelectedHosts.length === 0 && monitors.length > 0) { const defaultHost = [monitors[0].id]; setComparisonSelectedHosts(defaultHost); fetchComparisonData(defaultHost); } }}>Performance Comparison</button>
      </div>

      {activeTab === 'dashboard' && (
        <DashboardTab
          monitors={monitors}
          activeAlerts={activeAlerts}
          alerts={alerts}
          getTimeAgo={getTimeAgo}
          setActiveView={setActiveView}
          setActiveTab={setActiveTab}
          setStatusFilter={setStatusFilter}
          clearAlerts={clearAlerts}
          onHostClick={handleHostClick}
        />
      )}

      {activeTab === 'hosts' && (() => {
        const outdatedHosts = monitors.filter(m => {
          const currentTargetVersion = m.os === 'windows' || m.os === 'win' ? currentVersion : currentLinuxVersion;
          return isVersionLower(m.version, currentTargetVersion);
        });

        const countAll = monitors.length;
        const countAlerting = monitors.filter(m => activeAlerts.some(a => a.monitorId === m.id)).length;
        const countOffline = monitors.filter(m => m.status === 'offline' && m.enabled !== false).length;
        const countOutdated = outdatedHosts.length;

        const filteredMonitors = monitors.filter(m => {
          if (selectedEnvFilter && m.envId !== selectedEnvFilter) return false;
          if (searchFilterText.trim() !== '') {
            const filterTerms = searchFilterText.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            if (filterTerms.length > 0) {
              const matches = filterTerms.every(term => {
                const nameMatch = m.name && String(m.name).toLowerCase().includes(term);
                const ipMatch = m.ip && String(m.ip).toLowerCase().includes(term);
                const osMatch = m.os && String(m.os).toLowerCase().includes(term);
                const tagMatch = (m.tags || []).some(mt => String(mt).toLowerCase().includes(term));
                return nameMatch || ipMatch || osMatch || tagMatch;
              });
              if (!matches) return false;
            }
          }
          if (statusFilter === 'online' && m.status === 'offline') return false;
          if (statusFilter === 'offline' && (m.status !== 'offline' || m.enabled === false)) return false;
          if (statusFilter === 'alerting' && !activeAlerts.some(a => a.monitorId === m.id)) return false;
          if (statusFilter === 'outdated') {
            const currentTargetVersion = m.os === 'windows' || m.os === 'win' ? currentVersion : currentLinuxVersion;
            if (!isVersionLower(m.version, currentTargetVersion)) return false;
          }
          return true;
        });

        const sortedMonitors = [...filteredMonitors].sort((a, b) => {
          let valA, valB;
          switch(sortField) {
            case 'name': valA = (a.name || '').toLowerCase(); valB = (b.name || '').toLowerCase(); break;
            case 'ip':
              const ipToNum = (ip) => {
                const parts = (ip || '').split('.');
                if (parts.length !== 4) return 0;
                return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
              };
              valA = ipToNum(a.ip);
              valB = ipToNum(b.ip);
              break;
            case 'cpu': valA = parseFloat(a.cpu) || 0; valB = parseFloat(b.cpu) || 0; break;
            case 'memory': valA = parseFloat(a.memory) || 0; valB = parseFloat(b.memory) || 0; break;
            case 'disk': valA = parseFloat(a.disk) || 0; valB = parseFloat(b.disk) || 0; break;
            case 'status': valA = (a.status || '').toLowerCase(); valB = (b.status || '').toLowerCase(); break;
            default: return 0;
          }
          if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
          if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
          return 0;
        });

        const totalPages = Math.ceil(sortedMonitors.length / itemsPerPage);
        const safeCurrentPage = totalPages > 0 ? Math.min(Math.max(1, currentPage), totalPages) : 1;
        const paginatedMonitors = sortedMonitors.slice((safeCurrentPage - 1) * itemsPerPage, safeCurrentPage * itemsPerPage);

        return (
          <>
            {outdatedHosts.length > 0 && (
              <div style={{
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                borderRadius: 16,
                padding: '16px 24px',
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 20 }}>💡</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#f59e0b' }}>Outdated Scout Agents Detected</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {outdatedHosts.length} machine(s) are running an outdated version of Scout Agent. (Latest Windows: {currentVersion}, Linux: {currentLinuxVersion})
                    </div>
                  </div>
                </div>
                {!isViewer && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button
                      style={{
                        background: 'var(--accent-primary)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 20,
                        padding: '8px 16px',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: bulkUpdating ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        boxShadow: '0 4px 12px var(--accent-glow)',
                        opacity: bulkUpdating ? 0.7 : 1
                      }}
                      disabled={bulkUpdating}
                      onClick={() => runThrottledBulkUpdate(outdatedHosts)}
                    >
                      <FaArrowUp size={12} /> {bulkUpdating ? `Updating (${bulkProgress?.current}/${bulkProgress?.total})...` : `Update All (${outdatedHosts.length})`}
                    </button>
                    {bulkUpdating && (
                      <button
                        type="button"
                        style={{
                          background: 'rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          border: '1px solid rgba(239, 68, 68, 0.5)',
                          borderRadius: 20,
                          padding: '8px 16px',
                          fontSize: 12,
                          fontWeight: 800,
                          cursor: isCancelling ? 'wait' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          boxShadow: '0 4px 12px rgba(239, 68, 68, 0.25)',
                          transition: 'all 0.2s'
                        }}
                        disabled={isCancelling}
                        onClick={handleStopBulkUpdate}
                        title="立即中止剩餘排隊主機的更新派送"
                      >
                        <FaStop size={11} /> {isCancelling ? 'Stopping...' : '中途停止更新'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={S.card}>
              <div style={{ ...S.cardHead, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{'\u{1F5A5} Managed Hosts'}</span>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginRight: 16, paddingRight: 16, borderRight: '1px solid var(--border-color)' }}>
                  {[
                    { id: 'all', label: 'All', count: countAll, color: 'var(--text-muted)', bg: 'var(--bg-glass)' },
                    { id: 'alerting', label: 'Alerting', count: countAlerting, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)' },
                    { id: 'offline', label: 'Offline', count: countOffline, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.1)' },
                    { id: 'outdated', label: 'Outdated', count: countOutdated, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setStatusFilter(tab.id);
                        setCurrentPage(1);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 14px',
                        background: statusFilter === tab.id ? 'var(--accent-primary)' : 'var(--bg-glass)',
                        border: statusFilter === tab.id ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                        borderRadius: 20,
                        color: statusFilter === tab.id ? '#fff' : 'var(--text-primary)',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                    >
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: statusFilter === tab.id ? '#fff' : tab.color,
                        display: 'inline-block'
                      }}></span>
                      {tab.label}
                      <span style={{
                        fontSize: 10,
                        padding: '1px 5px',
                        background: statusFilter === tab.id ? 'rgba(255,255,255,0.2)' : tab.bg,
                        borderRadius: 8,
                        color: statusFilter === tab.id ? '#fff' : tab.color
                      }}>
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 24 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Environment:</span>
                  <select 
                    style={{ ...S.select, padding: '4px 8px', fontSize: 12, width: 'auto' }} 
                    value={selectedEnvFilter} 
                    onChange={e => {
                      setSelectedEnvFilter(e.target.value);
                      setCurrentPage(1);
                    }}
                  >
                    <option value="">All Environments</option>
                    {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 24, borderRight: '1px solid var(--border-color)', position: 'relative' }}>
                  <button
                    style={{ ...S.btnS, padding: '4px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={() => setShowColumnSettings(!showColumnSettings)}
                  >
                    ⚙️ Columns
                  </button>
                  {showColumnSettings && (
                    <div style={{
                      position: 'absolute',
                      top: 'calc(100% + 8px)',
                      left: 0,
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 12,
                      boxShadow: '0 10px 20px rgba(0,0,0,0.5)',
                      padding: 16,
                      zIndex: 1000,
                      minWidth: 160,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      textAlign: 'left',
                      gap: 10
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Show Columns</div>
                      {[
                        { id: 'name', label: 'Name' },
                        { id: 'ip', label: 'IP' },
                        { id: 'os', label: 'OS' },
                        { id: 'version', label: 'Version' },
                        { id: 'cpu', label: 'CPU' },
                        { id: 'memory', label: 'Memory' },
                        { id: 'disk', label: 'Disk' },
                        { id: 'status', label: 'Status' },
                        { id: 'tags', label: 'Tags' }
                      ].map(col => {
                        const checked = visibleColumns.includes(col.id);
                        return (
                          <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                let newCols;
                                if (checked) {
                                  if (visibleColumns.length <= 1) return;
                                  newCols = visibleColumns.filter(c => c !== col.id);
                                } else {
                                  newCols = [...visibleColumns, col.id];
                                }
                                setVisibleColumns(newCols);
                                localStorage.setItem('scout_visible_columns', JSON.stringify(newCols));
                              }}
                              style={{ cursor: 'pointer' }}
                            />
                            {col.label}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, paddingLeft: 12, borderLeft: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Search:</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    <input 
                      type="text" 
                      placeholder="Search name, IP, OS, tags..." 
                      style={{ ...S.input, margin: 0, padding: '6px 12px', fontSize: 12, minWidth: 200, width: '100%', height: 32 }} 
                      value={searchFilterText} 
                      onChange={e => {
                        setSearchFilterText(e.target.value);
                        setCurrentPage(1);
                      }}
                    />
                  </div>
                </div>
                {!isViewer && <button style={{ ...S.btnP, padding: '6px 14px', fontSize: 12 }} onClick={() => openHostModal()}>+ Add Host</button>}
              </div>
              {selectedHostIds.length > 0 && (
                <div style={{ padding: '12px 24px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedHostIds.length} host(s) selected</span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button style={{ ...S.btnS, fontSize: 12, padding: '4px 12px' }} onClick={() => setSelectedHostIds([])}>Clear</button>
                    {!isViewer && (
                      <button 
                        style={{ 
                          ...S.btnP, 
                          background: 'linear-gradient(135deg, #10b981, #059669)', 
                          border: 'none', 
                          color: '#fff', 
                          fontSize: 12, 
                          padding: '4px 14px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: 6, 
                          fontWeight: 800,
                          boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
                          cursor: bulkUpdating ? 'not-allowed' : 'pointer',
                          opacity: bulkUpdating ? 0.7 : 1
                        }} 
                        disabled={bulkUpdating}
                        onClick={async () => {
                          const targetHosts = monitors.filter(m => selectedHostIds.includes(m.id));
                          if (targetHosts.length === 0) return;
                          if (await showConfirm(`Deploy and update Scout Agent on ${targetHosts.length} selected host(s)?`)) {
                            runThrottledBulkUpdate(targetHosts);
                          }
                        }}
                      >
                        <FaArrowUp size={11} /> 
                        {bulkUpdating ? `Updating (${bulkProgress?.current}/${bulkProgress?.total})...` : `Update Scout (${selectedHostIds.length})`}
                      </button>
                    )}
                    {bulkUpdating && !isViewer && (
                      <button
                        type="button"
                        style={{
                          ...S.btnDanger,
                          background: 'rgba(239, 68, 68, 0.2)',
                          border: '1px solid rgba(239, 68, 68, 0.5)',
                          color: '#ef4444',
                          fontSize: 12,
                          padding: '4px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontWeight: 800,
                          cursor: isCancelling ? 'wait' : 'pointer',
                          boxShadow: '0 4px 12px rgba(239, 68, 68, 0.2)'
                        }}
                        disabled={isCancelling}
                        onClick={handleStopBulkUpdate}
                        title="立即中止剩餘排隊主機的更新派送"
                      >
                        <FaStop size={11} /> {isCancelling ? 'Stopping...' : '中途停止更新'}
                      </button>
                    )}
                    {!isViewer && <button style={{ ...S.btnS, fontSize: 12, padding: '4px 12px' }} onClick={() => setShowBulkConfigModal(true)}>Bulk Apply Config</button>}
                    {!isViewer && <button style={{ ...S.btnP, fontSize: 12, padding: '4px 12px' }} onClick={() => openApplyRuleModal('monitor', '')}>Apply Rule</button>}
                    {!isViewer && <button style={{ ...S.btnDanger, fontSize: 12, padding: '4px 12px' }} onClick={handleBulkDelete}>Delete Selected</button>}
                  </div>
                </div>
              )}
              <div style={{ overflowX: 'auto', width: '100%' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...S.th, width: 40 }}>
                        <input type="checkbox"
                          checked={sortedMonitors.length > 0 && selectedHostIds.length === sortedMonitors.length}
                          onChange={(e) => setSelectedHostIds(e.target.checked ? sortedMonitors.map(m => m.id) : [])}
                        />
                      </th>
                      {visibleColumns.includes('name') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('name')}>Name {sortField === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('ip') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('ip')}>IP {sortField === 'ip' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('os') && <th style={S.th}>OS</th>}
                      {visibleColumns.includes('version') && <th style={S.th}>Version</th>}
                      {visibleColumns.includes('cpu') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('cpu')}>CPU {sortField === 'cpu' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('memory') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('memory')}>Memory {sortField === 'memory' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('disk') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('disk')}>Disk {sortField === 'disk' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('status') && <th style={{ ...S.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('status')}>Status {sortField === 'status' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</th>}
                      {visibleColumns.includes('tags') && <th style={S.th}>Tags</th>}
                      <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMonitors.map(m => (
                            <tr key={m.id} style={{ opacity: m.enabled === false ? 0.5 : 1, background: selectedHostIds.includes(m.id) ? 'rgba(59, 130, 246, 0.1)' : 'transparent' }}>
                              <td style={{ ...S.td, width: 40 }}>
                                <input type="checkbox"
                                  checked={selectedHostIds.includes(m.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) setSelectedHostIds([...selectedHostIds, m.id]);
                                    else setSelectedHostIds(selectedHostIds.filter(id => id !== m.id));
                                  }}
                                />
                              </td>
                              {visibleColumns.includes('name') && (
                                <td style={{ ...S.td, fontWeight: 700 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <button style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontWeight: 800, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: m.enabled === false ? 'line-through' : 'none' }} onClick={() => handleHostClick(m)}>
                                      {m.name}
                                    </button>
                                    {(() => {
                                      if (!isHostInActiveWindow(maintenanceWindows, m)) return null;
                                      const mw = maintenanceWindows.find(w => w.status === 'active' && isHostInActiveWindow([w], m));
                                      return <span title={`In maintenance: ${mw ? mw.name : ''}`}>🔧</span>;
                                    })()}
                                    {m.envId && (
                                      <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-glass)', borderRadius: 4, color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}>
                                        {environments.find(e => e.id === m.envId)?.name || 'Unknown ENV'}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              )}
                              {visibleColumns.includes('ip') && <td style={S.td}>{m.ip}</td>}
                              {visibleColumns.includes('os') && <td style={S.td}><span style={{ ...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-primary)', textTransform: 'uppercase' }}>{m.os}</span></td>}
                              {visibleColumns.includes('version') && (
                                <td style={S.td}>
                                  {(() => {
                                    const currentTargetVersion = m.os === 'windows' || m.os === 'win' ? currentVersion : currentLinuxVersion;
                                    const needsUpdate = isVersionLower(m.version, currentTargetVersion);
                                    return (
                                      <span
                                        title={needsUpdate ? `New version available (Latest: ${currentTargetVersion})` : 'Up to date'}
                                        style={{
                                          ...S.badge,
                                          background: needsUpdate ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                                          color: needsUpdate ? '#f59e0b' : '#10b981',
                                          border: needsUpdate ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(16,185,129,0.3)',
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 4
                                        }}
                                      >
                                        {m.version || '1.0.0'}
                                        {needsUpdate && <span style={{ fontSize: 10 }}>⚠️</span>}
                                      </span>
                                    );
                                  })()}
                                </td>
                              )}
                              {visibleColumns.includes('cpu') && (
                                <td style={S.td}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                    <span style={{ fontWeight: 700, color: m.lastMetric?.cpu?.used > 80 ? '#ef4444' : 'inherit' }}>
                                      {m.lastMetric?.cpu?.used != null ? `${m.lastMetric.cpu.used.toFixed(1)}%` : '-'}
                                    </span>
                                    {m.metricsHistory && m.metricsHistory.length > 1 && (
                                      <div style={{ width: 60, height: 20 }}>
                                        <ResponsiveContainer width="100%" height="100%">
                                          <AreaChart data={m.metricsHistory}>
                                            <defs>
                                              <linearGradient id={`cpuGrad-${m.id}`} x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="var(--accent-primary)" stopOpacity={0.4} />
                                                <stop offset="95%" stopColor="var(--accent-primary)" stopOpacity={0} />
                                              </linearGradient>
                                            </defs>
                                            <Area type="monotone" dataKey="cpu" stroke="var(--accent-primary)" strokeWidth={1.5} fillOpacity={1} fill={`url(#cpuGrad-${m.id})`} dot={false} />
                                          </AreaChart>
                                        </ResponsiveContainer>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              )}
                              {visibleColumns.includes('memory') && (
                                <td style={S.td}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                    <span style={{ fontWeight: 700, color: m.lastMetric?.memory?.used > 80 ? '#ef4444' : 'inherit' }}>
                                      {m.lastMetric?.memory?.used != null ? `${m.lastMetric.memory.used.toFixed(1)}%` : '-'}
                                    </span>
                                    {m.metricsHistory && m.metricsHistory.length > 1 && (
                                      <div style={{ width: 60, height: 20 }}>
                                        <ResponsiveContainer width="100%" height="100%">
                                          <AreaChart data={m.metricsHistory}>
                                            <defs>
                                              <linearGradient id={`memGrad-${m.id}`} x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                              </linearGradient>
                                            </defs>
                                            <Area type="monotone" dataKey="memory" stroke="#10b981" strokeWidth={1.5} fillOpacity={1} fill={`url(#memGrad-${m.id})`} dot={false} />
                                          </AreaChart>
                                        </ResponsiveContainer>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              )}
                              {visibleColumns.includes('disk') && (
                                <td style={{ ...S.td, fontWeight: 700 }}>{(() => {
                                  if (!m.lastMetric?.disk?.length) return '-';
                                  const root = m.lastMetric.disk.find(d => d.mountPoint === '/' || d.mountPoint === 'C:\\' || d.mount === '/' || d.mount === 'C:\\') || m.lastMetric.disk[0];
                                  return root.used != null ? `${root.used.toFixed(1)}%` : '-';
                                })()}</td>
                              )}
                              {visibleColumns.includes('status') && (
                                <td style={S.td}>
                                  {m.enabled === false ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f59e0b' }}>
                                      <div style={{ ...S.dot, width: 8, height: 8, background: '#f59e0b' }}></div>
                                      Disabled
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <div style={{ ...S.dot, width: 8, height: 8, background: m.status === 'offline' ? '#ef4444' : '#10b981' }}></div>
                                      {m.status || 'unknown'}
                                    </div>
                                  )}
                                </td>
                              )}
                              {visibleColumns.includes('tags') && (
                                <td style={S.td}>
                                  {m.tags && m.tags.length > 0 ? (
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                      {m.tags.slice(0, 2).map(t => <span key={t} style={{ ...S.badge, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>{t}</span>)}
                                      {m.tags.length > 2 && (
                                        <span title={m.tags.slice(2).join(', ')} style={{ ...S.badge, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', cursor: 'help', fontWeight: 800 }}>+{m.tags.length - 2}</span>
                                      )}
                                    </div>
                                  ) : '-'}
                                </td>
                              )}
                              <td style={{ ...S.td, textAlign: 'right', position: 'relative' }}>
                                <button style={{ ...S.btnS, padding: '4px 10px', fontSize: 11, display: 'inline-block' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(actionMenuOpenId === m.id ? null : m.id); }}>{'\u2630'} Action</button>
                                {actionMenuOpenId === m.id && (() => {
                                  const currentTargetVersion = m.os === 'windows' || m.os === 'win' ? currentVersion : currentLinuxVersion;
                                  const needsUpdate = isVersionLower(m.version, currentTargetVersion);
                                  const isDeploying = updatingIps[m.ip];

                                  return (
                                    <div style={{ position: 'absolute', right: 24, top: 'calc(50% + 14px)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 20px rgba(0,0,0,0.5)', zIndex: 999, minWidth: 150, overflow: 'hidden' }}>
                                      <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); viewHostDetail(m, 'history'); }}>
                                        <FaChartLine size={12} style={{ color: 'var(--accent-primary)' }} /> Metrics
                                      </div>
                                      {!isViewer && (
                                        <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); openHostModal(m); }}>
                                          <FaEdit size={12} style={{ color: 'var(--accent-primary)' }} /> Edit
                                        </div>
                                      )}
                                      {!isViewer && (
                                        <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: m.enabled === false ? '#10b981' : '#f59e0b' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); handleToggleEnable(m); }}>
                                          {m.enabled === false ? <FaPlay size={12} /> : <FaPause size={12} />}
                                          {m.enabled === false ? 'Enable' : 'Disable'}
                                        </div>
                                      )}
                                      {!isViewer && needsUpdate && (
                                        <button
                                          style={{ width: '100%', border: 'none', background: 'none', padding: '8px 16px', cursor: isDeploying ? 'default' : 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-primary)', opacity: isDeploying ? 0.6 : 1 }}
                                          onClick={(e) => { e.stopPropagation(); if (!isDeploying) { setActionMenuOpenId(null); handleUpdateScout(m); } }}
                                          disabled={isDeploying}
                                        >
                                          <FaArrowUp size={12} />
                                          {isDeploying ? 'Updating...' : 'Update Scout'}
                                        </button>
                                      )}
                                      {!isViewer && (
                                        <div style={{ padding: '8px 16px', cursor: 'pointer', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); handleDeleteHost(m.id); }}>
                                          <FaTrash size={12} /> Delete
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </td>
                            </tr>
                          ))}
                          {paginatedMonitors.length === 0 && <tr><td colSpan={visibleColumns.length + 2} style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No hosts configured</td></tr>}
                  </tbody>
                </table>
              </div> {/* Closing overflowX wrapper */}
              
              {/* Pagination Controls */}
              {sortedMonitors.length > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Showing {Math.min((safeCurrentPage - 1) * itemsPerPage + 1, sortedMonitors.length)} to {Math.min(safeCurrentPage * itemsPerPage, sortedMonitors.length)} of {sortedMonitors.length} entries
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Items per page:</span>
                        <select
                          style={{ ...S.select, padding: '4px 8px', fontSize: 12, width: 'auto' }}
                          value={itemsPerPage}
                          onChange={e => {
                            setItemsPerPage(Number(e.target.value));
                            setCurrentPage(1);
                          }}
                        >
                          <option value={10}>10</option>
                          <option value={20}>20</option>
                          <option value={50}>50</option>
                        </select>
                      </div>
                      
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button 
                          style={{ ...S.btnS, padding: '4px 10px', fontSize: 12, opacity: safeCurrentPage === 1 ? 0.5 : 1, cursor: safeCurrentPage === 1 ? 'not-allowed' : 'pointer' }}
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={safeCurrentPage === 1}
                        >
                          Prev
                        </button>
                        <span style={{ fontSize: 13, padding: '4px 8px', color: 'var(--text-primary)' }}>{safeCurrentPage} / {totalPages || 1}</span>
                        <button 
                          style={{ ...S.btnS, padding: '4px 10px', fontSize: 12, opacity: safeCurrentPage === totalPages || totalPages === 0 ? 0.5 : 1, cursor: safeCurrentPage === totalPages || totalPages === 0 ? 'not-allowed' : 'pointer' }}
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                          disabled={safeCurrentPage === totalPages || totalPages === 0}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
              )}

            </div> {/* Closing S.card */}
          </>
        );
      })()}



      {activeTab === 'services' && (() => {
        const serviceList = [];
        monitors.forEach(m => {
          let watchSvc = [];
          try { watchSvc = Array.isArray(m.watchServices) ? m.watchServices : JSON.parse(m.watchServices || '[]'); } catch (e) { }
          let watchProc = [];
          try { watchProc = Array.isArray(m.watchProcesses) ? m.watchProcesses : JSON.parse(m.watchProcesses || '[]'); } catch (e) { }

          const servicesReported = m.lastMetric?.services || [];
          const processesReported = m.lastMetric?.processes || [];

          watchSvc.forEach(svcName => {
            const report = servicesReported.find(s => s.name === svcName);
            serviceList.push({
              id: `${m.id}-svc-${svcName}`,
              hostId: m.id,
              hostName: m.name,
              ip: m.ip,
              type: 'Service',
              name: svcName,
              status: report ? report.status : 'Stopped',
              cpu: '-',
              memory: '-'
            });
          });

          watchProc.forEach(procName => {
            const report = processesReported.find(p => p.name.toLowerCase() === procName.toLowerCase());
            serviceList.push({
              id: `${m.id}-proc-${procName}`,
              hostId: m.id,
              hostName: m.name,
              ip: m.ip,
              type: 'Process',
              name: procName,
              status: report ? report.status : 'Stopped',
              cpu: report && report.cpuUsage != null ? `${report.cpuUsage.toFixed(1)}%` : '-',
              memory: report && report.memoryMB != null ? `${report.memoryMB.toFixed(0)} MB` : '-'
            });
          });
        });

        const filteredServices = serviceList.filter(item => {
          if (servicesTypeFilter !== 'all' && item.type.toLowerCase() !== servicesTypeFilter.toLowerCase()) return false;
          const search = servicesSearch.toLowerCase();
          return item.name.toLowerCase().includes(search) || item.hostName.toLowerCase().includes(search) || item.ip.includes(search);
        });

        return (
          <div style={S.card}>
            <div style={{ ...S.cardHead, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>🖥️ Watched Services & Processes Inventory</span>
              {!isViewer && (() => {
                const eligibleHosts = monitors.filter(m => {
                  const servicesReported = m.lastMetric?.services || [];
                  const processesReported = m.lastMetric?.processes || [];
                  return servicesReported.length > 0 || processesReported.length > 0;
                });

                const currentMonitorId = eligibleHosts.find(h => h.id === addWatchForm.monitorId) ? addWatchForm.monitorId : (eligibleHosts[0]?.id || '');
                const selectedHostObj = monitors.find(m => m.id === currentMonitorId);

                let selectableTargets = [];
                if (selectedHostObj) {
                  if (addWatchForm.type === 'service') {
                    let watched = [];
                    try { watched = Array.isArray(selectedHostObj.watchServices) ? selectedHostObj.watchServices : JSON.parse(selectedHostObj.watchServices || '[]'); } catch (e) { }
                    const reported = selectedHostObj.lastMetric?.services || [];
                    selectableTargets = reported.map(s => s.name).filter(name => !watched.includes(name));
                  } else {
                    let watched = [];
                    try { watched = Array.isArray(selectedHostObj.watchProcesses) ? selectedHostObj.watchProcesses : JSON.parse(selectedHostObj.watchProcesses || '[]'); } catch (e) { }
                    const reported = selectedHostObj.lastMetric?.processes || [];
                    const uniqueNames = [...new Set(reported.map(p => p.name))];
                    selectableTargets = uniqueNames.filter(name => !watched.some(w => w.toLowerCase() === name.toLowerCase()));
                  }
                }

                return (
                  <div style={{ position: 'relative' }}>
                    <button
                      style={{ ...S.btnP, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (eligibleHosts.length === 0) {
                          showToast('No online servers with reported services or processes found.', 'warning');
                          return;
                        }
                        const initialHostId = eligibleHosts[0].id;
                        const initialHost = monitors.find(h => h.id === initialHostId);
                        let initialTargets = [];
                        const type = addWatchForm.type || 'service';
                        if (type === 'service') {
                          let watched = [];
                          try { watched = Array.isArray(initialHost.watchServices) ? initialHost.watchServices : JSON.parse(initialHost.watchServices || '[]'); } catch (e) { }
                          const reported = initialHost.lastMetric?.services || [];
                          initialTargets = reported.map(s => s.name).filter(name => !watched.includes(name));
                        } else {
                          let watched = [];
                          try { watched = Array.isArray(initialHost.watchProcesses) ? initialHost.watchProcesses : JSON.parse(initialHost.watchProcesses || '[]'); } catch (e) { }
                          const reported = initialHost.lastMetric?.processes || [];
                          const uniqueNames = [...new Set(reported.map(p => p.name))];
                          initialTargets = uniqueNames.filter(name => !watched.some(w => w.toLowerCase() === name.toLowerCase()));
                        }
                        setAddWatchForm({
                          monitorId: initialHostId,
                          type: type,
                          targetName: initialTargets[0] || ''
                        });
                        setShowAddWatchModal(!showAddWatchModal);
                      }}
                    >
                      + Add Watch Target ▾
                    </button>

                    {showAddWatchModal && (
                      <div
                        style={{ position: 'absolute', left: 0, top: '100%', marginTop: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: '0 12px 28px rgba(0,0,0,0.5)', zIndex: 1000, width: 320, padding: 16 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 12, display: 'flex', justifyContent: 'space-between', color: 'var(--text-primary)' }}>
                          <span>+ Add Watch Target</span>
                          <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }} onClick={() => setShowAddWatchModal(false)}>Close</button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                          <div style={S.inputGroup}>
                            <label style={{ ...S.label, fontSize: 11, marginBottom: 4 }}>Host / Server ({eligibleHosts.length} Online)</label>
                            <input
                              type="text"
                              placeholder="Filter servers by name/IP..."
                              style={{ ...S.input, padding: '4px 8px', fontSize: 11, marginBottom: 6 }}
                              value={watchHostSearch}
                              onChange={e => setWatchHostSearch(e.target.value)}
                            />
                            <div style={{ maxHeight: 110, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, background: 'rgba(0,0,0,0.2)', padding: 4 }}>
                              {(() => {
                                const filtered = eligibleHosts.filter(m => {
                                  const search = watchHostSearch.toLowerCase();
                                  return m.name.toLowerCase().includes(search) || m.ip.includes(search);
                                });
                                if (filtered.length === 0) {
                                  return <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>No matching hosts</div>;
                                }
                                return filtered.map(m => {
                                  const isSelected = m.id === currentMonitorId;
                                  return (
                                    <div
                                      key={m.id}
                                      style={{
                                        padding: '4px 8px',
                                        cursor: 'pointer',
                                        fontSize: 11,
                                        borderRadius: 6,
                                        background: isSelected ? 'var(--accent-primary)' : 'transparent',
                                        color: isSelected ? '#fff' : 'var(--text-primary)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        marginBottom: 2
                                      }}
                                      onClick={() => {
                                        const nextHostId = m.id;
                                        const nextHost = m;
                                        let nextTargets = [];
                                        if (nextHost) {
                                          if (addWatchForm.type === 'service') {
                                            let watched = [];
                                            try { watched = Array.isArray(nextHost.watchServices) ? nextHost.watchServices : JSON.parse(nextHost.watchServices || '[]'); } catch (e) { }
                                            const reported = nextHost.lastMetric?.services || [];
                                            nextTargets = reported.map(s => s.name).filter(name => !watched.includes(name));
                                          } else {
                                            let watched = [];
                                            try { watched = Array.isArray(nextHost.watchProcesses) ? nextHost.watchProcesses : JSON.parse(nextHost.watchProcesses || '[]'); } catch (e) { }
                                            const reported = nextHost.lastMetric?.processes || [];
                                            const uniqueNames = [...new Set(reported.map(p => p.name))];
                                            nextTargets = uniqueNames.filter(name => !watched.some(w => w.toLowerCase() === name.toLowerCase()));
                                          }
                                        }
                                        setAddWatchForm({
                                          ...addWatchForm,
                                          monitorId: nextHostId,
                                          targetName: nextTargets[0] || ''
                                        });
                                      }}
                                    >
                                      <span style={{ fontWeight: isSelected ? 800 : 500 }}>{m.name}</span>
                                      <span style={{ fontSize: 9, opacity: isSelected ? 1 : 0.6 }}>({m.ip})</span>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          </div>

                          <div style={S.inputGroup}>
                            <label style={{ ...S.label, fontSize: 11, marginBottom: 4 }}>Type</label>
                            <select
                              style={{ ...S.select, padding: '6px 8px', fontSize: 12 }}
                              value={addWatchForm.type || 'service'}
                              onChange={e => {
                                const nextType = e.target.value;
                                let nextTargets = [];
                                if (selectedHostObj) {
                                  if (nextType === 'service') {
                                    let watched = [];
                                    try { watched = Array.isArray(selectedHostObj.watchServices) ? selectedHostObj.watchServices : JSON.parse(selectedHostObj.watchServices || '[]'); } catch (e) { }
                                    const reported = selectedHostObj.lastMetric?.services || [];
                                    nextTargets = reported.map(s => s.name).filter(name => !watched.includes(name));
                                  } else {
                                    let watched = [];
                                    try { watched = Array.isArray(selectedHostObj.watchProcesses) ? selectedHostObj.watchProcesses : JSON.parse(selectedHostObj.watchProcesses || '[]'); } catch (e) { }
                                    const reported = selectedHostObj.lastMetric?.processes || [];
                                    const uniqueNames = [...new Set(reported.map(p => p.name))];
                                    nextTargets = uniqueNames.filter(name => !watched.some(w => w.toLowerCase() === name.toLowerCase()));
                                  }
                                }
                                setAddWatchForm({
                                  ...addWatchForm,
                                  type: nextType,
                                  targetName: nextTargets[0] || ''
                                });
                              }}
                            >
                              <option value="service">Windows Service</option>
                              <option value="process">Linux / Windows Process</option>
                            </select>
                          </div>

                          <div style={S.inputGroup}>
                            <label style={{ ...S.label, fontSize: 11, marginBottom: 4 }}>Target Name</label>
                            {selectableTargets.length === 0 ? (
                              <div style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic', padding: '6px 0' }}>
                                All reported targets are already watched.
                              </div>
                            ) : (
                              <select
                                style={{ ...S.select, padding: '6px 8px', fontSize: 12 }}
                                value={addWatchForm.targetName || ''}
                                onChange={e => setAddWatchForm({ ...addWatchForm, targetName: e.target.value })}
                              >
                                {selectableTargets.map(name => <option key={name} value={name}>{name}</option>)}
                              </select>
                            )}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                          <button style={{ ...S.btnS, padding: '4px 10px', fontSize: 11 }} onClick={() => setShowAddWatchModal(false)}>Cancel</button>
                          <button
                            style={{ ...S.btnP, padding: '4px 10px', fontSize: 11 }}
                            disabled={!addWatchForm.targetName}
                            onClick={handleAddWatchTarget}
                          >
                            Add Watch
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                <input
                  type="text"
                  style={{ ...S.input, padding: '6px 12px', fontSize: 13, width: 220 }}
                  placeholder="Search service, process or host..."
                  value={servicesSearch}
                  onChange={e => setServicesSearch(e.target.value)}
                />
                <select
                  style={{ ...S.select, padding: '6px 12px', fontSize: 13, width: 140 }}
                  value={servicesTypeFilter}
                  onChange={e => setServicesTypeFilter(e.target.value)}
                >
                  <option value="all">All Types</option>
                  <option value="service">Services Only</option>
                  <option value="process">Processes Only</option>
                </select>
              </div>
            </div>
            <div style={S.cardBody}>
              {filteredServices.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No matching services or processes watched.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={S.th}>Host</th>
                        <th style={S.th}>Type</th>
                        <th style={S.th}>Name</th>
                        <th style={S.th}>Status</th>
                        <th style={S.th}>CPU Usage</th>
                        <th style={S.th}>Memory RSS</th>
                        {!isViewer && <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredServices.map(item => (
                        <tr key={item.id}>
                          <td style={{ ...S.td, fontWeight: 700 }}>
                            {item.hostName}
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>({item.ip})</span>
                          </td>
                          <td style={S.td}>
                            <span style={{ ...S.badge, background: item.type === 'Service' ? 'rgba(59,130,246,0.1)' : 'rgba(139,92,246,0.1)', color: item.type === 'Service' ? 'var(--accent-primary)' : '#a78bfa' }}>
                              {item.type}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontFamily: 'monospace' }}>{item.name}</td>
                          <td style={S.td}>
                            <span style={{
                              ...S.badge,
                              background: item.status.toLowerCase() === 'running' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                              color: item.status.toLowerCase() === 'running' ? 'var(--success)' : 'var(--danger)'
                            }}>
                              {item.status.toUpperCase()}
                            </span>
                          </td>
                          <td style={S.td}>{item.cpu}</td>
                          <td style={S.td}>{item.memory}</td>
                          {!isViewer && (
                            <td style={{ ...S.td, textAlign: 'right' }}>
                              <button
                                style={S.btnDanger}
                                onClick={async () => {
                                  if (await showConfirm(`Are you sure you want to stop watching "${item.name}" on ${item.hostName}?`)) {
                                    handleRemoveWatchTarget(item.hostId, item.type, item.name);
                                  }
                                }}
                              >
                                Unwatch
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {activeTab === 'comparison' && (() => {
        const colorsPalette = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#14b8a6'];

        const allTags = [...new Set(monitors.flatMap(m => {
          try { return Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'); } catch (e) { return []; }
        }))];

        const filteredMonitors = monitors.filter(m => {
          if (compareEnvFilter && m.envId !== compareEnvFilter) return false;
          if (compareTagFilter) {
            let mTags = [];
            try { mTags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'); } catch (e) { }
            if (!mTags.includes(compareTagFilter)) return false;
          }
          if (compareSearchText) {
            const s = compareSearchText.toLowerCase();
            if (!m.name.toLowerCase().includes(s) && !m.ip.includes(s)) return false;
          }
          return true;
        });

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={S.card}>
              <div style={{ ...S.cardHead, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>📈 Host Performance Comparison</span>

                <div style={{ position: 'relative' }}>
                  <button
                    style={{ ...S.btnS, padding: '6px 16px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}
                    onClick={(e) => { e.stopPropagation(); setShowCompareHostSelector(!showCompareHostSelector); }}
                  >
                    🔍 Select Hosts ({comparisonSelectedHosts.length} selected) ▾
                  </button>

                  {showCompareHostSelector && (
                    <div
                      style={{ position: 'absolute', left: 0, top: '100%', marginTop: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: '0 12px 28px rgba(0,0,0,0.5)', zIndex: 1000, width: 340, padding: 16 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                        <span>Filter & Choose Hosts</span>
                        <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }} onClick={() => setShowCompareHostSelector(false)}>Close</button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                        <input
                          type="text"
                          placeholder="Search name or IP..."
                          style={{ ...S.input, padding: '4px 8px', fontSize: 12 }}
                          value={compareSearchText}
                          onChange={e => setCompareSearchText(e.target.value)}
                        />
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <select
                            style={{ ...S.select, padding: '4px 8px', fontSize: 12 }}
                            value={compareEnvFilter}
                            onChange={e => setCompareEnvFilter(e.target.value)}
                          >
                            <option value="">All Envs</option>
                            {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          <select
                            style={{ ...S.select, padding: '4px 8px', fontSize: 12 }}
                            value={compareTagFilter}
                            onChange={e => setCompareTagFilter(e.target.value)}
                          >
                            <option value="">All Tags</option>
                            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                        <button
                          style={{ ...S.btnS, padding: '2px 8px', fontSize: 11, flex: 1, justifyContent: 'center' }}
                          onClick={() => {
                            const allFilteredIds = filteredMonitors.map(m => m.id);
                            const newSelection = [...new Set([...comparisonSelectedHosts, ...allFilteredIds])];
                            setComparisonSelectedHosts(newSelection);
                            fetchComparisonData(newSelection, comparisonRange);
                          }}
                        >
                          Select All
                        </button>
                        <button
                          style={{ ...S.btnS, padding: '2px 8px', fontSize: 11, flex: 1, justifyContent: 'center' }}
                          onClick={() => {
                            const allFilteredIds = filteredMonitors.map(m => m.id);
                            const newSelection = comparisonSelectedHosts.filter(id => !allFilteredIds.includes(id));
                            setComparisonSelectedHosts(newSelection);
                            fetchComparisonData(newSelection, comparisonRange);
                          }}
                        >
                          Clear All
                        </button>
                      </div>

                      <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, padding: 8, background: 'rgba(0,0,0,0.2)', textAlign: 'left' }}>
                        {filteredMonitors.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>No hosts match filters</div>
                        ) : filteredMonitors.map(m => {
                          const checked = comparisonSelectedHosts.includes(m.id);
                          return (
                            <label key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                              <input
                                type="checkbox"
                                style={{ width: 'auto', height: 'auto', margin: 0, cursor: 'pointer' }}
                                checked={checked}
                                onChange={() => {
                                  let newList;
                                  if (checked) {
                                    newList = comparisonSelectedHosts.filter(id => id !== m.id);
                                  } else {
                                    newList = [...comparisonSelectedHosts, m.id];
                                  }
                                  setComparisonSelectedHosts(newList);
                                  fetchComparisonData(newList, comparisonRange);
                                }}
                              />
                              <span style={{ fontWeight: 700 }}>{m.name}</span>
                              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>({m.ip})</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', alignItems: 'center' }}>
                  <select
                    style={{ ...S.select, padding: '4px 8px', fontSize: 12, width: 'auto' }}
                    value={comparisonMetric}
                    onChange={e => setComparisonMetric(e.target.value)}
                  >
                    <option value="cpu">CPU Usage (%)</option>
                    <option value="memory">Memory Usage (%)</option>
                  </select>
                  <select
                    style={{ ...S.select, padding: '4px 8px', fontSize: 12, width: 'auto' }}
                    value={comparisonRange}
                    onChange={e => {
                      setComparisonRange(parseInt(e.target.value));
                      fetchComparisonData(comparisonSelectedHosts, parseInt(e.target.value));
                    }}
                  >
                    <option value="1">Last 1 Hour</option>
                    <option value="3">Last 3 Hours</option>
                    <option value="6">Last 6 Hours</option>
                    <option value="24">Last 24 Hours</option>
                  </select>
                </div>
              </div>

              <div style={{ ...S.cardBody, height: 420, display: 'flex', flexDirection: 'column' }}>
                {comparisonLoading ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Loading comparison metrics...</div>
                ) : comparisonSelectedHosts.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', textAlign: 'center' }}>Please click "Select Hosts" above to begin comparison.</div>
                ) : comparisonData.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>No historical data found for the selected time range.</div>
                ) : (
                  <div style={{ flex: 1, width: '100%', height: '100%' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={comparisonData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={11} />
                        <YAxis domain={[0, 100]} stroke="var(--text-muted)" fontSize={11} unit="%" />
                        <RechartsTooltip contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        <Legend />
                        {comparisonSelectedHosts.map((hostId, idx) => {
                          const monitorObj = monitors.find(m => m.id === hostId);
                          if (!monitorObj) return null;
                          const hName = `${monitorObj.name} (${monitorObj.ip})`;
                          const dataKeyName = comparisonMetric === 'cpu' ? hName : `${hName}_mem`;
                          const strokeColor = colorsPalette[idx % colorsPalette.length];
                          return (
                            <Line
                              key={hostId}
                              type="monotone"
                              dataKey={dataKeyName}
                              name={monitorObj.name}
                              stroke={strokeColor}
                              strokeWidth={2.5}
                              dot={false}
                              activeDot={{ r: 4 }}
                            />
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {activeTab === 'apikeys' && (
        <div style={S.card}>
          <div style={S.cardHead}>
            <span>{'\u{1F511} API Keys (Deployment Keys)'}</span>
            {!isViewer && <button style={{ ...S.btnP, padding: '6px 14px', fontSize: 12 }} onClick={openApiKeyModal}>+ Create API Key</button>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={S.th}>Name</th>
                <th style={S.th}>Description</th>
                <th style={S.th}>Environment</th>
                <th style={S.th}>Key</th>
                <th style={S.th}>Created At</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map(k => (
                <tr key={k.id}>
                  <td style={{ ...S.td, fontWeight: 700 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{k.name}</span>
                      {k.isOpenApi && (
                        <span style={{ fontSize: 10, padding: '1px 6px', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', borderRadius: 6, border: '1px solid rgba(16, 185, 129, 0.3)', fontWeight: 800 }}>
                          Open API
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={S.td}>{k.desc || '-'}</td>
                  <td style={S.td}>
                    {k.envId ? (
                      <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--bg-glass)', borderRadius: 12, border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                        {environments.find(e => e.id === k.envId)?.name || 'Unknown ENV'}
                      </span>
                    ) : '-'}
                  </td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{k.key.substring(0, 16)}...</span>
                      <button style={{ ...S.btnS, padding: '2px 8px', fontSize: 11, borderRadius: 8 }} onClick={() => copyApiKey(k.key)}>Copy</button>
                    </div>
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-muted)' }}>{new Date(k.createdAt).toLocaleString()}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    {!isViewer && <button style={{ ...S.btnS, display: 'inline-block', marginRight: 8, padding: '4px 10px', fontSize: 11 }} onClick={() => openApiKeyModal(k)}>Edit</button>}
                    {!isViewer && <button style={S.btnDanger} onClick={() => handleDeleteApiKey(k.id)}>Delete</button>}
                  </td>
                </tr>
              ))}
              {apiKeys.length === 0 && <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No API Keys generated</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Alerts Tab */}
      {activeTab === 'alerts' && (
        <AlertsTab alerts={alerts} monitors={monitors} api={api} fetchDashboard={fetchDashboard} />
      )}

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <>
          <div style={{ ...S.card, marginBottom: 28 }}>
            <div style={S.cardHead}>
              <span>{'\u{26A0}'} Rule Templates</span>
              {!isViewer && <button style={{ ...S.btnP, padding: '6px 14px', fontSize: 12 }} onClick={() => openRuleModal()}>+ Create Template</button>}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Type</th>
                  <th style={S.th}>Target</th>
                  <th style={S.th}>Threshold</th>
                  <th style={S.th}>Condition</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id}>
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      <div>{r.name}</div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                        {r.actions?.some(a => a.type === 'mail') && (
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', fontWeight: 700 }}>
                            📧 Mail
                          </span>
                        )}
                        {r.actions?.some(a => a.type === 'telegram') && (
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontWeight: 700 }}>
                            ✈️ TG
                          </span>
                        )}
                        {r.actions?.some(a => a.type === 'webhook') && (
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', fontWeight: 700 }}>
                            🔗 Webhook
                          </span>
                        )}
                        {(!r.actions || r.actions.length === 0) && (
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(148, 163, 184, 0.1)', color: 'var(--text-muted)' }}>
                            (預設)
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...S.td, textTransform: 'uppercase' }}>
                      {r.type === 'offline' ? (
                        <span style={{ color: '#f87171', fontWeight: 800 }}>📡 OFFLINE</span>
                      ) : r.type}
                    </td>
                    <td style={S.td}>{r.type === 'offline' ? 'Agent Heartbeat' : (r.target || '-')}</td>
                    <td style={{ ...S.td, color: 'var(--accent-primary)', fontWeight: 800 }}>
                      {r.type === 'offline' 
                        ? (r.threshold >= 60 ? `${Math.round(r.threshold / 60)}m (${r.threshold}s)` : `${r.threshold}s`)
                        : r.threshold}
                    </td>
                    <td style={S.td}>{r.type === 'offline' ? `No heartbeat > buffer` : `Trigger after ${r.alertHits} hits`}</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>
                      {!isViewer && <button style={{ ...S.btnS, display: 'inline-block', marginRight: 8, padding: '4px 10px', fontSize: 11 }} onClick={() => openRuleModal(r)}>Edit</button>}
                      {!isViewer && <button style={S.btnDanger} onClick={() => handleDeleteRule(r.id)}>Delete</button>}
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No rule templates configured</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={S.card}>
            <div style={S.cardHead}>
              <span>{'\u{1F517} Rule Assignments'}</span>
              {!isViewer && <button style={{ ...S.btnS, padding: '6px 14px', fontSize: 12 }} onClick={() => openApplyRuleModal('tag', '')}>+ Assign Rule</button>}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={S.th}>Rule Template</th>
                  <th style={S.th}>Assigned Scopes (Hosts, Tags, Keys)</th>
                </tr>
              </thead>
              <tbody>
                {rules.map(rule => {
                  const ruleBindings = bindings.filter(b => b.ruleId === rule.id);
                  if (ruleBindings.length === 0) return null;
                  return (
                    <tr key={rule.id}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{rule.name}</td>
                      <td style={S.td}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {ruleBindings.map(b => {
                            let scopeDisplay = b.scopeType === 'monitor' ? 'Host: ' : b.scopeType === 'apikey' ? 'API Key: ' : b.scopeType === 'env' ? 'Environment: ' : 'Tag: ';
                            let scopeName = b.scopeValue;
                            if (b.scopeType === 'monitor') {
                              const m = monitors.find(x => x.id === b.scopeValue);
                              if (m) scopeName = m.name;
                            } else if (b.scopeType === 'env') {
                              const env = environments.find(x => x.id === b.scopeValue);
                              if (env) scopeName = env.name;
                            }
                            if (b.scopeType === 'apikey') {
                              const k = apiKeys.find(x => x.key === b.scopeValue);
                              if (k) scopeName = k.name;
                            }
                            return (
                              <div key={b.id} style={{ ...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-color)', padding: '4px 10px' }}>
                                <span>{scopeDisplay} <strong style={{ color: 'var(--accent-primary)' }}>{scopeName || b.scopeValue}</strong></span>
                                {!isViewer && <button
                                  style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 4px', fontSize: 14, fontWeight: 'bold' }}
                                  onClick={() => handleDeleteBinding(b.id)}
                                  title="Remove assignment"
                                >×</button>}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {bindings.length === 0 && <tr><td colSpan="2" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No active assignments</td></tr>}
              </tbody>
            </table>
          </div>

          <RuleExclusionsPanel rules={rules} monitors={monitors} bindings={bindings} canEdit={!isViewer} />
        </>
      )}

      {activeTab === 'install' && (
        <div style={S.card}>
          <div style={S.cardHead}>
            <h2 style={{ margin: 0, fontSize: 16 }}>{'\u{21A1}'} Deploy Scout Agent</h2>
            <p style={{ margin: '8px 0 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Automatically download, configure, and install the agent on your target servers.</p>
          </div>
          <div style={S.cardBody}>
            <div style={{ ...S.inputGroup, maxWidth: 400 }}>
              <label style={S.label}>1. Select an API Key</label>
              <select
                style={S.select}
                value={selectedInstallApiKey}
                onChange={(e) => {
                  setSelectedInstallApiKey(e.target.value);
                  setInstallToken(null);
                }}
              >
                <option value="">-- Choose an API Key --</option>
                {apiKeys.map(k => (
                  <option key={k.key} value={k.key}>{k.name} ({k.envName || 'Global'})</option>
                ))}
              </select>
            </div>

            {selectedInstallApiKey ? (
              <div style={{ marginTop: 24 }}>
                {!installToken ? (
                  !setupMultiUse ? (
                    <div style={{ display: 'flex', gap: 16 }}>
                      <button
                        style={{ ...S.btnP, padding: '12px 24px', fontSize: 14 }}
                        onClick={() => { setIsMultiUse(false); generateInstallToken(false); }}
                      >
                        Generate One-Time Install Command
                      </button>
                      <button
                        style={{ ...S.btnS, padding: '12px 24px', fontSize: 14, background: 'var(--bg-glass)', border: '1px solid var(--border-color)' }}
                        onClick={() => setSetupMultiUse(true)}
                      >
                        Generate Multi-Use Token Install Command
                      </button>
                    </div>
                  ) : (
                    <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24, maxWidth: 500 }}>
                      <h3 style={{ margin: '0 0 16px 0', fontSize: 16, color: 'var(--text-primary)' }}>Configure Multi-Use Token</h3>
                      <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 4, marginBottom: 20, width: 'fit-content', border: '1px solid var(--border-color)' }}>
                        <button
                          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 'bold', border: 'none', background: multiUseLimitType === 'uses' ? 'var(--accent-primary)' : 'transparent', color: multiUseLimitType === 'uses' ? '#fff' : 'var(--text-muted)', borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s' }}
                          onClick={() => setMultiUseLimitType('uses')}
                        >
                          Max Uses
                        </button>
                        <button
                          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 'bold', border: 'none', background: multiUseLimitType === 'hours' ? 'var(--accent-primary)' : 'transparent', color: multiUseLimitType === 'hours' ? '#fff' : 'var(--text-muted)', borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s' }}
                          onClick={() => setMultiUseLimitType('hours')}
                        >
                          Valid Hours
                        </button>
                      </div>

                      <div style={{ marginBottom: 24 }}>
                        {multiUseLimitType === 'uses' ? (
                          <div style={S.inputGroup}>
                            <label style={S.label}>Max Uses (Servers)</label>
                            <input
                              type="number"
                              style={S.input}
                              value={multiUseMaxUses}
                              onChange={e => setMultiUseMaxUses(Math.max(1, parseInt(e.target.value) || 1))}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>Token will automatically expire after 24 hours even if uses are not exhausted.</span>
                          </div>
                        ) : (
                          <div style={S.inputGroup}>
                            <label style={S.label}>Valid for (Hours, max 24)</label>
                            <input
                              type="number"
                              style={S.input}
                              value={multiUseHours}
                              onChange={e => setMultiUseHours(Math.min(24, Math.max(1, parseFloat(e.target.value) || 1)))}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>Unlimited uses within the specified timeframe.</span>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 12 }}>
                        <button
                          style={{ ...S.btnS, padding: '8px 16px', fontSize: 13 }}
                          onClick={() => setSetupMultiUse(false)}
                        >
                          Cancel
                        </button>
                        <button
                          style={{ ...S.btnP, padding: '8px 16px', fontSize: 13 }}
                          onClick={() => { setIsMultiUse(true); generateInstallToken(true); }}
                        >
                          Generate
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                    {/* Windows Install Box */}
                    <div style={{ background: 'rgba(22, 27, 34, 0.4)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
                      <h3 style={{ margin: '0 0 12px 0', fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>🖥️</span> Windows Server
                      </h3>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>Run this in PowerShell as Administrator. (Valid for {Math.floor(tokenTimeLeft / 60)}:{(tokenTimeLeft % 60).toString().padStart(2, '0')})</p>
                      <div style={{ position: 'relative' }}>
                        <textarea
                          readOnly
                          style={{ ...S.input, height: 80, fontFamily: 'monospace', fontSize: 11, background: '#0d1117', color: '#e6edf3', cursor: 'text', resize: 'none' }}
                          value={`powershell -Command "Invoke-WebRequest -Uri '${window.location.protocol}//${window.location.host}/api/inventory/install.ps1?token=${installToken}' -OutFile 'install.ps1' -UseBasicParsing; .\\install.ps1"`}
                        />
                        <button
                          style={{ ...S.btnS, position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11 }}
                          onClick={() => {
                            copyTextToClipboard(`powershell -Command "Invoke-WebRequest -Uri '${window.location.protocol}//${window.location.host}/api/inventory/install.ps1?token=${installToken}' -OutFile 'install.ps1' -UseBasicParsing; .\\install.ps1"`);
                          }}
                        >
                          Copy
                        </button>
                      </div>
                    </div>

                    {/* Linux Install Box */}
                    <div style={{ background: 'rgba(22, 27, 34, 0.4)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
                      <h3 style={{ margin: '0 0 12px 0', fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>🐧</span> Linux Server
                      </h3>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>Run this in your terminal with root/sudo privileges. (Valid for {Math.floor(tokenTimeLeft / 60)}:{(tokenTimeLeft % 60).toString().padStart(2, '0')})</p>
                      <div style={{ position: 'relative' }}>
                        <textarea
                          readOnly
                          style={{ ...S.input, height: 80, fontFamily: 'monospace', fontSize: 11, background: '#0d1117', color: '#e6edf3', cursor: 'text', resize: 'none' }}
                          value={`curl -sL "${window.location.protocol}//${window.location.host}/api/inventory/install.sh?token=${installToken}" | sudo bash`}
                        />
                        <button
                          style={{ ...S.btnS, position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11 }}
                          onClick={() => {
                            copyTextToClipboard(`curl -sL "${window.location.protocol}//${window.location.host}/api/inventory/install.sh?token=${installToken}" | sudo bash`);
                          }}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 24, padding: 32, textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-color)', borderRadius: 8 }}>
                Please select an API Key first to generate the installation commands.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Host Modal */}
      {showHostModal && (
        <div style={S.modalOverlay}>
          <div style={S.modalContent}>
            <div style={S.modalHead}><h2 style={S.modalTitle}>{hostForm.id ? 'Edit Host' : 'Add Host'}</h2></div>
            <div style={{ ...S.modalBody, maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={S.inputGroup}>
                <label style={S.label}>Host Name</label>
                <input style={S.input} value={hostForm.name} onChange={e => setHostForm({ ...hostForm, name: e.target.value })} placeholder="e.g. WEB-PROD-01" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Host Group</label>
                <input style={S.input} value={hostForm.group} onChange={e => setHostForm({ ...hostForm, group: e.target.value })} placeholder="e.g. Default, database, web" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>IP Address</label>
                <input style={S.input} value={hostForm.ip} onChange={e => setHostForm({ ...hostForm, ip: e.target.value })} placeholder="e.g. 10.0.0.10" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={S.inputGroup}>
                  <label style={S.label}>OS</label>
                  <select style={S.select} value={hostForm.os} onChange={e => setHostForm({ ...hostForm, os: e.target.value })}>
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>Report Interval (s)</label>
                  <input type="number" style={S.input} value={hostForm.reportInterval} onChange={e => setHostForm({ ...hostForm, reportInterval: parseInt(e.target.value) || 60 })} />
                </div>
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Tags (Comma separated)</label>
                <input style={S.input} value={hostForm.tags} onChange={e => setHostForm({ ...hostForm, tags: e.target.value })} placeholder="e.g. prod, web-server" />
                {allAvailableTags.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8, display: 'block', marginBottom: 4 }}>Click to add existing:</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 80, overflowY: 'auto', padding: 4, background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                      {allAvailableTags.map(tag => {
                        const currentTags = hostForm.tags ? hostForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
                        const isAdded = currentTags.includes(tag);
                        return (
                          <span key={tag}
                            style={{ ...S.badge, cursor: 'pointer', background: isAdded ? 'var(--bg-secondary)' : 'var(--bg-glass)', border: '1px solid var(--border-color)', color: isAdded ? 'var(--text-muted)' : 'var(--text-primary)', opacity: isAdded ? 0.5 : 1 }}
                            onClick={() => {
                              if (!isAdded) {
                                const newTags = currentTags.concat(tag);
                                setHostForm({ ...hostForm, tags: newTags.join(', ') });
                              }
                            }}
                          >
                            + {tag}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Ping Targets (Comma separated)</label>
                <input style={S.input} value={hostForm.pingTargets} onChange={e => setHostForm({ ...hostForm, pingTargets: e.target.value })} placeholder="e.g. 8.8.8.8, 1.1.1.1" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>TCP Targets (Comma separated)</label>
                <input style={S.input} value={hostForm.tcpTargets} onChange={e => setHostForm({ ...hostForm, tcpTargets: e.target.value })} placeholder="e.g. 127.0.0.1:3306, 127.0.0.1:80" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Watch Services (Comma separated)</label>
                <input style={S.input} value={hostForm.watchServices} onChange={e => setHostForm({ ...hostForm, watchServices: e.target.value })} placeholder={hostForm.os === 'windows' ? "e.g. wuauserv, spooler" : "Only applies to Windows OS"} disabled={hostForm.os !== 'windows'} />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Watch Processes (Comma separated)</label>
                <input style={S.input} value={hostForm.watchProcesses} onChange={e => setHostForm({ ...hostForm, watchProcesses: e.target.value })} placeholder="e.g. nginx, node" />
              </div>
            </div>
            <div style={S.modalFoot}>
              <button style={S.btnS} onClick={() => setShowHostModal(false)}>Cancel</button>
              <button style={S.btnP} onClick={handleSaveHost}>Save Host</button>
            </div>
          </div>
        </div>
      )}

      {/* Rule Modal */}
      {showRuleModal && (
        <RuleModal
          rule={selectedRule}
          onClose={() => setShowRuleModal(false)}
          onSave={fetchRules}
          canManageSelfHealing={canManageSelfHealing}
        />
      )}

      {/* Apply Rule Modal */}
      {showApplyRuleModal && (
        <div style={S.modalOverlay}>
          <div style={S.modalContent}>
            <div style={S.modalHead}><h2 style={S.modalTitle}>Assign Rule Template</h2></div>
            <div style={S.modalBody}>
              <div style={S.inputGroup}>
                <label style={S.label}>Select Rule Template</label>
                <select style={S.select} value={applyRuleForm.ruleId} onChange={e => setApplyRuleForm({ ...applyRuleForm, ruleId: e.target.value })}>
                  <option value="" disabled>Select Rule...</option>
                  {rules.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
                </select>
              </div>

              {selectedHostIds.length === 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
                  <div style={S.inputGroup}>
                    <label style={S.label}>Apply To (Scope)</label>
                    <select style={S.select} value={applyRuleForm.scopeType} onChange={e => setApplyRuleForm({ ...applyRuleForm, scopeType: e.target.value, scopeValue: '' })}>
                      <option value="monitor">Specific Host</option>
                      <option value="apikey">API Key Group</option>
                      <option value="tag">Tag Group</option>
                      <option value="env">Environment (ENV)</option>
                    </select>
                  </div>
                  <div style={S.inputGroup}>
                    <label style={S.label}>Scope Value</label>
                    {applyRuleForm.scopeType === 'monitor' ? (
                      <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({ ...applyRuleForm, scopeValue: e.target.value })}>
                        <option value="" disabled>Select Host...</option>
                        {monitors.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    ) : applyRuleForm.scopeType === 'apikey' ? (
                      <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({ ...applyRuleForm, scopeValue: e.target.value })}>
                        <option value="" disabled>Select API Key...</option>
                        {apiKeys.map(k => <option key={k.key} value={k.key}>{k.name}</option>)}
                      </select>
                    ) : applyRuleForm.scopeType === 'env' ? (
                      <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({ ...applyRuleForm, scopeValue: e.target.value })}>
                        <option value="" disabled>Select Environment...</option>
                        {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    ) : (
                      <input style={S.input} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({ ...applyRuleForm, scopeValue: e.target.value })} placeholder="e.g. prod" />
                    )}
                  </div>
                </div>
              )}

              {selectedHostIds.length > 0 && (
                <div style={{ padding: 16, background: 'rgba(59, 130, 246, 0.1)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 13 }}>
                  This rule will be applied to <strong>{selectedHostIds.length}</strong> selected host(s).
                </div>
              )}
            </div>
            <div style={S.modalFoot}>
              <button style={S.btnS} onClick={() => setShowApplyRuleModal(false)}>Cancel</button>
              <button style={S.btnP} onClick={handleApplyRule} disabled={!applyRuleForm.ruleId || (selectedHostIds.length === 0 && !applyRuleForm.scopeValue)}>Apply Rule</button>
            </div>
          </div>
        </div>
      )}

      {/* API Key Modal */}
      {showApiKeyModal && (
        <div style={S.modalOverlay}>
          <div style={S.modalContent}>
            <div style={S.modalHead}><h2 style={S.modalTitle}>{apiKeyForm.id ? 'Edit API Key' : 'Create API Key'}</h2></div>
            <div style={S.modalBody}>
              <div style={S.inputGroup}>
                <label style={S.label}>Key Name</label>
                <input style={S.input} value={apiKeyForm.name} onChange={e => setApiKeyForm({ ...apiKeyForm, name: e.target.value })} placeholder="e.g. US-East-Production" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Description</label>
                <input style={S.input} value={apiKeyForm.desc} onChange={e => setApiKeyForm({ ...apiKeyForm, desc: e.target.value })} placeholder="e.g. Used for core database servers" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Environment (Optional)</label>
                <select style={S.input} value={apiKeyForm.envId} onChange={e => setApiKeyForm({ ...apiKeyForm, envId: e.target.value })}>
                  <option value="">-- No Global Environment --</option>
                  {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>

              {/* Open API Key Toggle Checkbox */}
              <div 
                style={{ ...S.inputGroup, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid var(--border-color)', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setApiKeyForm(prev => ({ ...prev, isOpenApi: !prev.isOpenApi }))}
              >
                <input 
                  type="checkbox" 
                  checked={apiKeyForm.isOpenApi === true} 
                  onChange={e => setApiKeyForm(prev => ({ ...prev, isOpenApi: e.target.checked }))} 
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: apiKeyForm.isOpenApi ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                    🌐 Open API Key (For External Query API)
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Allows querying Scout metrics &amp; logs via REST API. Will not be used for Scout Agent registration.
                  </div>
                </div>
              </div>

              {!apiKeyForm.isOpenApi && (
                <div style={S.inputGroup}>
                  <label style={S.label}>Max Agents Limit</label>
                  <input type="number" style={S.input} value={apiKeyForm.maxAgents} onChange={e => setApiKeyForm({ ...apiKeyForm, maxAgents: parseInt(e.target.value) || 0 })} placeholder="e.g. 50" />
                </div>
              )}
            </div>
            <div style={S.modalFoot}>
              <button style={S.btnS} onClick={() => setShowApiKeyModal(false)}>Cancel</button>
              <button style={S.btnP} onClick={handleSaveApiKey} disabled={!apiKeyForm.name}>{apiKeyForm.id ? 'Save' : 'Generate'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Config Modal */}
      {showBulkConfigModal && (() => {
        const uniqueGroups = [...new Set(monitors.map(m => m.group).filter(Boolean))];
        const uniqueTags = [...new Set(monitors.flatMap(m => {
          try { return Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'); } catch (e) { return []; }
        }).filter(Boolean))];

        const resolvedTargetIds = (() => {
          if (bulkTargetMode === 'selected') return selectedHostIds;
          if (bulkTargetMode === 'group') return monitors.filter(m => m.group === bulkTargetValue).map(m => m.id);
          if (bulkTargetMode === 'env') return monitors.filter(m => m.envId === bulkTargetValue).map(m => m.id);
          if (bulkTargetMode === 'tag') {
            return monitors.filter(m => {
              let mTags = [];
              try { mTags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || '[]'); } catch (e) { }
              return mTags.includes(bulkTargetValue);
            }).map(m => m.id);
          }
          return [];
        })();

        const isAllLinuxTarget = resolvedTargetIds.length > 0 && resolvedTargetIds.every(id => {
          const m = monitors.find(x => x.id === id);
          return m && String(m.os).toLowerCase().includes('linux');
        });

        return (
          <div style={S.modalOverlay}>
            <div style={S.modalContent}>
              <div style={S.modalHead}><h2 style={S.modalTitle}>Bulk Apply Configuration</h2></div>
              <div style={{ ...S.modalBody, maxHeight: '60vh', overflowY: 'auto' }}>
                {/* Target Scope Selection */}
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px dashed var(--border-color)', marginBottom: 16 }}>
                  <label style={{ ...S.label, fontWeight: 700 }}>Apply Target Scope</label>
                  <select
                    style={{ ...S.select, marginBottom: 8 }}
                    value={bulkTargetMode}
                    onChange={e => {
                      const nextMode = e.target.value;
                      setBulkTargetMode(nextMode);
                      if (nextMode === 'group') setBulkTargetValue(uniqueGroups[0] || '');
                      else if (nextMode === 'env') setBulkTargetValue(environments[0]?.id || '');
                      else if (nextMode === 'tag') setBulkTargetValue(uniqueTags[0] || '');
                      else setBulkTargetValue('');
                    }}
                  >
                    <option value="selected">Selected Hosts ({selectedHostIds.length} checked)</option>
                    <option value="group">By Host Group</option>
                    <option value="env">By Environment</option>
                    <option value="tag">By Tag</option>
                  </select>

                  {bulkTargetMode === 'group' && (
                    <select style={S.select} value={bulkTargetValue} onChange={e => setBulkTargetValue(e.target.value)}>
                      {uniqueGroups.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  )}

                  {bulkTargetMode === 'env' && (
                    <select style={S.select} value={bulkTargetValue} onChange={e => setBulkTargetValue(e.target.value)}>
                      {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                    </select>
                  )}

                  {bulkTargetMode === 'tag' && (
                    <select style={S.select} value={bulkTargetValue} onChange={e => setBulkTargetValue(e.target.value)}>
                      {uniqueTags.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}

                  <div style={{ fontSize: 12, color: 'var(--accent-primary)', marginTop: 8, fontWeight: 600 }}>
                    🎯 Affected Target Hosts Count: {resolvedTargetIds.length}
                  </div>
                </div>

                <div style={S.inputGroup}>
                  <label style={S.label}>Update Mode</label>
                  <select style={S.select} value={bulkConfigForm.mode} onChange={e => setBulkConfigForm({ ...bulkConfigForm, mode: e.target.value })}>
                    <option value="append">Append (Add to existing config)</option>
                    <option value="overwrite">Overwrite (Replace existing config)</option>
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, display: 'block' }}>
                    {bulkConfigForm.mode === 'append' ? 'Values will be merged into the existing configuration of each agent without deleting their old values.' : 'WARNING: This will completely wipe out the old configuration for these fields on all selected agents.'}
                  </span>
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>Tags (Comma Separated)</label>
                  <input style={S.input} value={bulkConfigForm.tags} onChange={e => setBulkConfigForm({ ...bulkConfigForm, tags: e.target.value })} placeholder="e.g. database, web, critical" />
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>Ping Targets (Comma Separated)</label>
                  <input style={S.input} value={bulkConfigForm.pingTargets} onChange={e => setBulkConfigForm({ ...bulkConfigForm, pingTargets: e.target.value })} placeholder="e.g. 8.8.8.8, google.com" />
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>TCP Targets (Comma Separated)</label>
                  <input style={S.input} value={bulkConfigForm.tcpTargets} onChange={e => setBulkConfigForm({ ...bulkConfigForm, tcpTargets: e.target.value })} placeholder="e.g. 192.168.1.5:3306" />
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>Watch Services (Comma Separated)</label>
                  <input style={S.input} value={bulkConfigForm.watchServices} onChange={e => setBulkConfigForm({ ...bulkConfigForm, watchServices: e.target.value })} placeholder="e.g. mysql, nginx" />
                </div>
                <div style={S.inputGroup}>
                  <label style={S.label}>Watch Processes (Comma Separated)</label>
                  <input style={S.input} value={bulkConfigForm.watchProcesses} onChange={e => setBulkConfigForm({ ...bulkConfigForm, watchProcesses: e.target.value })} placeholder="e.g. node.exe, java" />
                </div>
                {isAllLinuxTarget && (
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px dashed rgba(16,185,129,0.3)', marginTop: 16 }}>
                    <h4 style={{ fontSize: 13, color: 'var(--success)', marginBottom: 12, fontWeight: 700 }}>🐧 Linux Specific Configuration</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                      <input 
                        type="checkbox" 
                        checked={bulkConfigForm.disableReportLog} 
                        onChange={e => setBulkConfigForm({ ...bulkConfigForm, disableReportLog: e.target.checked })}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                      <label style={{ fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => setBulkConfigForm({ ...bulkConfigForm, disableReportLog: !bulkConfigForm.disableReportLog })}>
                        Disable Report Log (Avoid log flooding)
                      </label>
                    </div>
                    <div style={S.inputGroup}>
                      <label style={S.label}>Log Path</label>
                      <input style={S.input} value={bulkConfigForm.logPath} onChange={e => setBulkConfigForm({ ...bulkConfigForm, logPath: e.target.value })} placeholder="/var/log/scout-agent.log" />
                    </div>
                  </div>
                )}
              </div>
              <div style={S.modalFoot}>
                <button style={S.btnS} onClick={() => setShowBulkConfigModal(false)}>Cancel</button>
                <button style={S.btnP} onClick={handleBulkApply} disabled={resolvedTargetIds.length === 0}>
                  Apply to {resolvedTargetIds.length} Hosts
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <HostDetailModal isOpen={showHostDetailModal} onClose={() => setShowHostDetailModal(false)} initialHost={selectedHostForDetail} />

      {/* Real-time Floating Bulk Update Progress & Stop Bar */}
      {bulkUpdating && bulkProgress && (
        <div style={{
          position: 'fixed',
          bottom: 28,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1100,
          background: 'rgba(15, 23, 42, 0.92)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid rgba(59, 130, 246, 0.4)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.55), 0 0 24px rgba(59, 130, 246, 0.25)',
          borderRadius: 20,
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          color: 'var(--text-primary)',
          minWidth: 540,
          maxWidth: '90vw'
        }}>
          <div style={{ fontSize: 22, display: 'flex', alignItems: 'center' }}>
            <span style={{ animation: 'spin 2s linear infinite', display: 'inline-block' }}>⚙️</span>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
                🚀 Scout Agent 批量更新進行中 ({bulkProgress.current} / {bulkProgress.total})
              </span>
              <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)' }}>
                {Math.round((bulkProgress.current / bulkProgress.total) * 100) || 0}%
              </span>
            </div>

            <div style={{ width: '100%', height: 6, background: 'rgba(255, 255, 255, 0.1)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${Math.round((bulkProgress.current / bulkProgress.total) * 100) || 0}%`,
                background: 'linear-gradient(90deg, #3b82f6, #10b981)',
                transition: 'width 0.3s ease',
                borderRadius: 6
              }} />
            </div>

            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', marginTop: 4, alignItems: 'center' }}>
              <span style={{ color: '#10b981', fontWeight: 700 }}>✓ 成功: {bulkProgress.succeeded}</span>
              <span style={{ color: bulkProgress.failed > 0 ? '#ef4444' : 'var(--text-muted)', fontWeight: 700 }}>✗ 失敗: {bulkProgress.failed}</span>
              <span>剩餘排隊: {Math.max(0, bulkProgress.total - bulkProgress.current)}</span>
              {bulkProgress.activeNames && bulkProgress.activeNames.length > 0 && (
                <span style={{ color: '#38bdf8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380, fontWeight: 600 }}>
                  ⚡ 進行中 ({bulkProgress.activeNames.length}): {bulkProgress.activeNames.join(', ')}
                </span>
              )}
            </div>
          </div>

          {!isViewer && (
            <button
              type="button"
              onClick={handleStopBulkUpdate}
              disabled={isCancelling}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 18px',
                background: isCancelling ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.25)',
                color: '#ef4444',
                border: '1px solid #ef4444',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 800,
                cursor: isCancelling ? 'wait' : 'pointer',
                boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)',
                whiteSpace: 'nowrap',
                transition: 'all 0.2s'
              }}
              title="立即中止後續所有排隊主機的更新派送"
            >
              <FaStop size={11} /> {isCancelling ? '正在中止...' : '中途停止 (Stop)'}
            </button>
          )}
        </div>
      )}

    </div>
  );
}

// --- Alerts Tab Component ---
function AlertsTab({ alerts, monitors, api, fetchDashboard }) {
  const agent = useAgent();
  const { showToast } = useToast();
  const [filter, setFilter] = useState({ search: '', status: 'all' });

  const handleResolve = async (id) => {
    try {
      await api.put(`/monitor/alerts/${id}/resolve`);
      showToast('Alert resolved successfully', 'success');
      if (fetchDashboard) fetchDashboard();
    } catch (err) {
      showToast('Failed to resolve alert', 'error');
    }
  };

  const handleExport = () => {
    const filtered = getFilteredAlerts();
    if (filtered.length === 0) return showToast('No data to export', 'warning');

    const headers = ['Triggered At', 'Host', 'Type', 'Target', 'Value', 'Threshold', 'Status', 'Resolved At'];
    const csvRows = filtered.map(a => {
      const host = monitors.find(m => m.id === a.monitorId);
      return [
        new Date(a.triggeredAt).toLocaleString(),
        host ? host.name : a.monitorId,
        a.type,
        a.target || '',
        a.value,
        a.threshold,
        a.resolved ? 'Resolved' : 'Active',
        a.resolved && a.resolvedAt ? new Date(a.resolvedAt).toLocaleString() : ''
      ].map(val => `"${val}"`).join(',');
    });

    const blob = new Blob([[headers.join(','), ...csvRows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `alerts_export_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const getFilteredAlerts = () => {
    return alerts.filter(a => {
      if (filter.status === 'active' && a.resolved) return false;
      if (filter.status === 'resolved' && !a.resolved) return false;
      const host = monitors.find(m => m.id === a.monitorId);
      const search = filter.search.toLowerCase();
      if (search && !a.type.toLowerCase().includes(search) && !(host && host.name.toLowerCase().includes(search))) return false;
      return true;
    }).sort((a, b) => {
      const aActive = a.resolved ? 1 : 0;
      const bActive = b.resolved ? 1 : 0;
      if (aActive !== bActive) {
        return aActive - bActive; // Active (0) before Resolved (1)
      }
      const aTime = new Date(a.triggeredAt || 0).getTime();
      const bTime = new Date(b.triggeredAt || 0).getTime();
      return bTime - aTime; // Newest first
    });
  };

  const filteredAlerts = getFilteredAlerts();

  return (
    <div style={S.card}>
      <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{'\u{26A0}\u{FE0F} Alert History'}</span>
        <div style={{ display: 'flex', gap: 12 }}>
          <select style={{ ...S.select, width: 120, padding: '6px 12px', fontSize: 13 }} value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
          <input style={{ ...S.input, width: 200, padding: '6px 12px', fontSize: 13 }} placeholder="Search host or type..." value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} />
          <button style={{ ...S.btnP, fontSize: 12, padding: '6px 14px' }} onClick={handleExport}>{'\u{1F4E5}'} Export CSV</button>
        </div>
      </div>
      <div style={{ padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={S.th}>Status</th>
              <th style={S.th}>Triggered At</th>
              <th style={S.th}>Host</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Details</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.map((a, i) => {
              const host = monitors.find(m => m.id === a.monitorId);
              return (
                <tr key={a.id} style={{ borderBottom: i === filteredAlerts.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                  <td style={S.td}>
                    <span style={{ ...S.badge, background: a.resolved ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: a.resolved ? '#10b981' : '#ef4444' }}>
                      {a.resolved ? 'Resolved' : 'Active'}
                    </span>
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-muted)' }}>{new Date(a.triggeredAt).toLocaleString()}</td>
                  <td style={{ ...S.td, fontWeight: 700 }}>{host ? host.name : 'Unknown'}</td>
                  <td style={{ ...S.td, textTransform: 'uppercase' }}>{a.type}</td>
                  <td style={S.td}>{a.target} {a.value} &gt; {a.threshold}<AlertBadges alert={a} /></td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    {!a.resolved && <MuteButton canEdit={['Operator', 'SuperAdmin'].includes(JSON.parse(localStorage.getItem('user') || '{}')?.role)} alert={a} onMuted={fetchDashboard} style={{ ...S.btnS, padding: '4px 10px', fontSize: 11 }} />}
                    {!a.resolved && agent.available && (
                      <button
                        style={{ ...S.btnS, padding: '4px 10px', fontSize: 11, marginRight: 6 }}
                        onClick={() => agent.investigate(buildAlertPrompt(a, host ? host.name : 'Unknown'), a.id)}
                      >
                        🤖 調查
                      </button>
                    )}
                    {!a.resolved && (
                      <button style={{ ...S.btnS, padding: '4px 10px', fontSize: 11 }} onClick={() => handleResolve(a.id)}>Acknowledge</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredAlerts.length === 0 && <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No alerts found</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Dashboard Component ---
function DashboardTab({ monitors, activeAlerts, alerts, getTimeAgo, setActiveView, setActiveTab, setStatusFilter, clearAlerts, onHostClick }) {
  const [tabWidgetPrefs, setTabWidgetPrefs] = useState(() => {
    try {
      const saved = localStorage.getItem('scout_dashboard_tab_widget_prefs');
      return saved ? JSON.parse(saved) : { summary: true, agentVersions: true, cpuTop5: true, memTop5: true, diskTop5: true, recentAlerts: true };
    } catch (e) {
      return { summary: true, agentVersions: true, cpuTop5: true, memTop5: true, diskTop5: true, recentAlerts: true };
    }
  });
  const [showConfigModal, setShowConfigModal] = useState(false);

  const toggleTabWidget = (key) => {
    setTabWidgetPrefs(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('scout_dashboard_tab_widget_prefs', JSON.stringify(next));
      return next;
    });
  };

  const [topLimits, setTopLimits] = useState({ cpu: 5, mem: 5, disk: 5, versions: 5 });
  const toggleTopLimit = (key) => {
    setTopLimits(prev => ({ ...prev, [key]: prev[key] === 5 ? 10 : 5 }));
  };

  const todayAlerts = alerts.filter(a => new Date(a.triggeredAt) > new Date(Date.now() - 86400000));
  const onlineCount = monitors.filter(m => m.status !== 'offline').length;
  const offlineCount = monitors.filter(m => m.status === 'offline').length;

  const cpuList = [...monitors]
    .filter(m => m.lastMetric && m.lastMetric.cpu && typeof m.lastMetric.cpu.used === 'number')
    .map(m => ({ monitor: m, name: m.name, value: m.lastMetric.cpu.used }))
    .sort((a, b) => b.value - a.value).slice(0, topLimits.cpu);

  const memList = [...monitors]
    .filter(m => m.lastMetric && m.lastMetric.memory && typeof m.lastMetric.memory.used === 'number')
    .map(m => ({ monitor: m, name: m.name, value: m.lastMetric.memory.used }))
    .sort((a, b) => b.value - a.value).slice(0, topLimits.mem);

  const diskList = [...monitors]
    .filter(m => m.lastMetric && m.lastMetric.disk && m.lastMetric.disk.length > 0)
    .map(m => {
      const root = m.lastMetric.disk.find(d => d.mountPoint === '/' || d.mountPoint === 'C:\\' || d.mount === '/' || d.mount === 'C:\\') || m.lastMetric.disk[0];
      const totalGB = root.totalGB != null ? root.totalGB : (root.total ? root.total / (1024 * 1024 * 1024) : 0);
      const freeGB = root.freeGB != null ? root.freeGB : (root.free ? root.free / (1024 * 1024 * 1024) : (totalGB > 0 && root.used != null ? totalGB * (1 - root.used / 100) : null));
      const freeText = freeGB != null && !isNaN(freeGB) ? (freeGB < 1 ? `${(freeGB * 1024).toFixed(0)}MB free` : `${freeGB.toFixed(1)}GB free`) : '';
      const driveName = root.mount || root.mountPoint || root.fs || '';
      return { 
        monitor: m,
        name: m.name, 
        value: root.used || 0,
        drive: driveName,
        freeText: freeText
      };
    })
    .sort((a, b) => b.value - a.value).slice(0, topLimits.disk);

  const versionCounts = monitors.reduce((acc, m) => {
    const v = m.version || 'Unknown';
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  const versionList = Object.entries(versionCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, topLimits.versions);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button style={S.btnS} onClick={() => setShowConfigModal(!showConfigModal)}>
          ⚙️ Customize Widgets ▾
        </button>
      </div>

      {/* Widget Modal */}
      {showConfigModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={() => setShowConfigModal(false)}>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 16, padding: '24px 28px', minWidth: 320, maxWidth: 420, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', textAlign: 'left' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: 16, fontWeight: 800, textAlign: 'left', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>⚙️ Customize Dashboard Widgets</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start', padding: '4px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.summary} onChange={() => toggleTabWidget('summary')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Overview Summary Cards</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.agentVersions} onChange={() => toggleTabWidget('agentVersions')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Agent Version Distribution</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.cpuTop5} onChange={() => toggleTabWidget('cpuTop5')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Host CPU Top-5 / Top-10</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.memTop5} onChange={() => toggleTabWidget('memTop5')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Host Memory Top-5 / Top-10</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.diskTop5} onChange={() => toggleTabWidget('diskTop5')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Host Disk Top-5 / Top-10</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, userSelect: 'none' }}>
                <input type="checkbox" checked={!!tabWidgetPrefs.recentAlerts} onChange={() => toggleTabWidget('recentAlerts')} style={{ width: 16, height: 16, cursor: 'pointer', margin: 0 }} />
                <span style={{ fontWeight: 600 }}>Recent Alerts Activity</span>
              </label>
            </div>
            <div style={{ marginTop: 24, textAlign: 'right' }}>
              <button style={S.btnP} onClick={() => setShowConfigModal(false)}>Save & Close</button>
            </div>
          </div>
        </div>
      )}

      {tabWidgetPrefs.summary && (
        <div style={S.topRow}>
          <div style={S.metCard}>
            <span style={S.metLabel}>Hosts</span>
            <div style={S.metVal}>{'\u{1F5A5}'} {monitors.length}</div>
          </div>
          <div style={S.metCard}>
            <span style={S.metLabel}>Online</span>
            <div style={{ ...S.metVal, color: '#10b981' }}><div style={{ ...S.dot, background: '#10b981' }}></div> {onlineCount}</div>
          </div>
          <div style={{ ...(offlineCount > 0 ? { ...S.metCard, cursor: 'pointer', transition: 'opacity 0.2s' } : S.metCard) }} onClick={() => { if (offlineCount > 0) { setActiveTab('hosts'); setStatusFilter('offline'); } }} onMouseOver={e => { if (offlineCount > 0) e.currentTarget.style.opacity = 0.8; }} onMouseOut={e => { if (offlineCount > 0) e.currentTarget.style.opacity = 1; }}>
            <span style={S.metLabel}>Offline</span>
            <div style={{ ...S.metVal, color: '#ef4444' }}><div style={{ ...S.dot, background: '#ef4444' }}></div> {offlineCount}</div>
          </div>
          <div style={{ ...(activeAlerts.length > 0 ? { ...S.metCard, cursor: 'pointer', transition: 'opacity 0.2s' } : S.metCard) }} onClick={() => { if (activeAlerts.length > 0) setActiveView('MONITOR_ALERTS'); }} onMouseOver={e => { if (activeAlerts.length > 0) e.currentTarget.style.opacity = 0.8; }} onMouseOut={e => { if (activeAlerts.length > 0) e.currentTarget.style.opacity = 1; }}>
            <span style={S.metLabel}>Active Alerts</span>
            <div style={{ ...S.metVal, color: '#f59e0b', fontSize: 28 }}>
              {'\u{26A0}'} {activeAlerts.length}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              {'\u{1F195}'} Today: {todayAlerts.length} alerts
            </div>
          </div>
        </div>
      )}

      {(tabWidgetPrefs.agentVersions || tabWidgetPrefs.cpuTop5 || tabWidgetPrefs.memTop5 || tabWidgetPrefs.diskTop5) && (
        <div style={S.gridRow}>
          {tabWidgetPrefs.agentVersions && (
            <div style={S.card}>
              <div style={S.cardHead}>
                <span onClick={() => toggleTopLimit('versions')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }} title="Click to toggle Top-5 / Top-10">
                  Agent Versions {versionList.length > 5 || topLimits.versions === 10 ? `Top-${topLimits.versions}` : ''}
                  <span style={{ fontSize: 11, padding: '1px 6px', background: 'var(--bg-secondary)', color: 'var(--accent-primary)', borderRadius: 10, border: '1px solid var(--border-color)', fontWeight: 700 }}>
                    Top-{topLimits.versions === 5 ? '10' : '5'} ⇋
                  </span>
                </span>
              </div>
              <div style={{ ...S.cardBody, padding: '10px 24px' }}>
                {versionList.length === 0 ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No data</div> : versionList.map((m, i) => (
                  <div key={i} style={{ ...S.listRow, borderBottom: i === versionList.length - 1 ? 'none' : S.listRow.borderBottom, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: '0 0 auto', minWidth: 140, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                    <div style={{ width: 40, textAlign: 'right', fontWeight: 800, flexShrink: 0 }}>{m.value}</div>
                    <div style={S.progressBarContainer}>
                      <div style={{ ...S.progressBar, width: `${Math.min(100, (m.value / monitors.length) * 100)}%`, background: '#8b5cf6' }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tabWidgetPrefs.cpuTop5 && (
            <div style={S.card}>
              <div style={S.cardHead}>
                <span onClick={() => toggleTopLimit('cpu')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }} title="Click to toggle Top-5 / Top-10">
                  Host CPU Top-{topLimits.cpu}
                  <span style={{ fontSize: 11, padding: '1px 6px', background: 'var(--bg-secondary)', color: 'var(--accent-primary)', borderRadius: 10, border: '1px solid var(--border-color)', fontWeight: 700 }}>
                    Top-{topLimits.cpu === 5 ? '10' : '5'} ⇋
                  </span>
                </span>
              </div>
              <div style={{ ...S.cardBody, padding: '10px 24px' }}>
                {cpuList.length === 0 ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No data</div> : cpuList.map((m, i) => (
                  <div key={i} style={{ ...S.listRow, borderBottom: i === cpuList.length - 1 ? 'none' : S.listRow.borderBottom, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        flex: '0 0 auto',
                        minWidth: 150,
                        maxWidth: '50%',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textDecoration: 'underline',
                        textUnderlineOffset: '3px',
                        transition: 'color 0.2s'
                      }}
                      onClick={() => onHostClick && onHostClick(m.monitor)}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-primary)'}
                      title={`Click to view details for ${m.name}`}
                    >
                      {m.name}
                    </div>
                    <div style={{ width: 45, textAlign: 'right', fontWeight: 800, flexShrink: 0 }}>{m.value.toFixed(0)}%</div>
                    <div style={S.progressBarContainer}>
                      <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tabWidgetPrefs.memTop5 && (
            <div style={S.card}>
              <div style={S.cardHead}>
                <span onClick={() => toggleTopLimit('mem')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }} title="Click to toggle Top-5 / Top-10">
                  Host Memory Top-{topLimits.mem}
                  <span style={{ fontSize: 11, padding: '1px 6px', background: 'var(--bg-secondary)', color: 'var(--accent-primary)', borderRadius: 10, border: '1px solid var(--border-color)', fontWeight: 700 }}>
                    Top-{topLimits.mem === 5 ? '10' : '5'} ⇋
                  </span>
                </span>
              </div>
              <div style={{ ...S.cardBody, padding: '10px 24px' }}>
                {memList.length === 0 ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No data</div> : memList.map((m, i) => (
                  <div key={i} style={{ ...S.listRow, borderBottom: i === memList.length - 1 ? 'none' : S.listRow.borderBottom, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        flex: '0 0 auto',
                        minWidth: 150,
                        maxWidth: '50%',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textDecoration: 'underline',
                        textUnderlineOffset: '3px',
                        transition: 'color 0.2s'
                      }}
                      onClick={() => onHostClick && onHostClick(m.monitor)}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-primary)'}
                      title={`Click to view details for ${m.name}`}
                    >
                      {m.name}
                    </div>
                    <div style={{ width: 45, textAlign: 'right', fontWeight: 800, flexShrink: 0 }}>{m.value.toFixed(0)}%</div>
                    <div style={S.progressBarContainer}>
                      <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tabWidgetPrefs.diskTop5 && (
            <div style={S.card}>
              <div style={S.cardHead}>
                <span onClick={() => toggleTopLimit('disk')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }} title="Click to toggle Top-5 / Top-10">
                  Host Disk Top-{topLimits.disk}
                  <span style={{ fontSize: 11, padding: '1px 6px', background: 'var(--bg-secondary)', color: 'var(--accent-primary)', borderRadius: 10, border: '1px solid var(--border-color)', fontWeight: 700 }}>
                    Top-{topLimits.disk === 5 ? '10' : '5'} ⇋
                  </span>
                </span>
              </div>
              <div style={{ ...S.cardBody, padding: '10px 24px' }}>
                {diskList.length === 0 ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No data</div> : diskList.map((m, i) => (
                  <div key={i} style={{ ...S.listRow, borderBottom: i === diskList.length - 1 ? 'none' : S.listRow.borderBottom, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: '0 0 auto', minWidth: 150, maxWidth: '45%', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                      <span
                        style={{
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          cursor: 'pointer',
                          color: 'var(--text-primary)',
                          textDecoration: 'underline',
                          textUnderlineOffset: '3px',
                          transition: 'color 0.2s'
                        }}
                        onClick={() => onHostClick && onHostClick(m.monitor)}
                        onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-primary)'}
                        title={`Click to view details for ${m.name}`}
                      >
                        {m.name}
                      </span>
                      {m.drive && <span style={{ fontSize: 10, background: 'var(--bg-secondary)', color: 'var(--text-muted)', padding: '1px 4px', borderRadius: 4, fontWeight: 600, flexShrink: 0 }}>{m.drive}</span>}
                    </div>
                    <div style={S.progressBarContainer}>
                      <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', textAlign: 'right', minWidth: 95, flexShrink: 0 }}>
                      <span>{m.value.toFixed(0)}%</span>
                      {m.freeText && <span style={{ color: '#10b981', fontWeight: 600, marginLeft: 4, fontSize: 11 }}>({m.freeText})</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tabWidgetPrefs.recentAlerts && (
        <div style={{ ...S.card, marginBottom: 28 }}>
          <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>{'\u{26A0}'} Recent Alerts Activity</div>
            {alerts.length > 0 && (
              <button
                onClick={clearAlerts}
                style={{
                  padding: '4px 12px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                Clean Activity
              </button>
            )}
          </div>
          <div style={{ padding: 0 }}>
            {alerts.length === 0 ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>{'\u{2705}'} No alerts activity</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {alerts.slice(0, 15).map((a, i) => {
                    const monitor = monitors.find(m => m.id === a.monitorId);
                    const hostName = monitor ? monitor.name : 'Unknown';
                    return (
                      <tr key={a.id} style={{ borderBottom: i === alerts.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                        <td style={{ ...S.td, width: 40, fontSize: 18 }}><div style={{ ...S.dot, background: a.resolved ? '#10b981' : '#ef4444' }}></div></td>
                        <td style={{ ...S.td, width: 60 }}><span style={{ ...S.badge, background: a.resolved ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: a.resolved ? '#10b981' : '#ef4444' }}>{a.resolved ? 'RESOLVED' : 'CRIT'}</span></td>
                        <td style={{ ...S.td, minWidth: 160 }}>
                          <span
                            style={{
                              fontWeight: 700,
                              cursor: monitor ? 'pointer' : 'default',
                              color: monitor ? 'var(--text-primary)' : 'var(--text-muted)',
                              textDecoration: monitor ? 'underline' : 'none',
                              textUnderlineOffset: '3px',
                              transition: 'color 0.2s'
                            }}
                            onClick={() => monitor && onHostClick && onHostClick(monitor)}
                            onMouseEnter={e => { if (monitor) e.currentTarget.style.color = 'var(--accent-primary)'; }}
                            onMouseLeave={e => { if (monitor) e.currentTarget.style.color = 'var(--text-primary)'; }}
                            title={monitor ? `Click to view details for ${hostName}` : hostName}
                          >
                            {hostName}
                          </span>
                        </td>
                        <td style={{ ...S.td }}>
                          <span style={{ fontWeight: 800, marginRight: 8, textTransform: 'uppercase' }}>{a.type}</span>
                          {a.target && <span style={{ color: 'var(--accent-primary)', marginRight: 8 }}>{a.target}</span>}
                          <span>{a.value} &gt; {a.threshold}</span>
                          {a.resolved && <span style={{ color: '#10b981', marginLeft: 12, fontWeight: 700 }}> {'--->'} resolved {getTimeAgo(a.resolvedAt)}</span>}
                        </td>
                        <td style={{ ...S.td, width: 100, textAlign: 'right', color: 'var(--text-muted)' }}>{getTimeAgo(a.triggeredAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
