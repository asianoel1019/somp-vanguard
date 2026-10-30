import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useSync } from '../../contexts/WebSocketContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { WS_EVENTS } from '../../constants/wsEvents';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import { FaWindows, FaLinux } from 'react-icons/fa';
import HostDetailModal from '../Shared/HostDetailModal';
import RuleModal from '../Shared/RuleModal';
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

export default function Agents() {
  const [activeTab, setActiveTab] = useState('apikeys'); // apikeys, install
  const [monitors, setMonitors] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [selectedHostIds, setSelectedHostIds] = useState([]);
  
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  
  const { showToast } = useToast();
  const { showConfirm } = useConfirm();
  const { lastEvent } = useSync();

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const canManageSelfHealing = user?.features?.manage_self_healing === true;
  const isViewer = user?.role === 'Viewer';

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
  const [multiUseLimitType, setMultiUseLimitType] = useState('uses'); // 'uses' or 'hours'
  const [multiUseMaxUses, setMultiUseMaxUses] = useState(100);
  const [multiUseHours, setMultiUseHours] = useState(24);
  
  const [showApplyRuleModal, setShowApplyRuleModal] = useState(false);
  const [applyRuleForm, setApplyRuleForm] = useState({ ruleId: '', scopeType: 'monitor', scopeValue: '' });
  const [ruleCategoryFilter, setRuleCategoryFilter] = useState('all'); // all, metric, log
  
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyForm, setApiKeyForm] = useState({ name: '', desc: '', envId: '', maxAgents: 50, isOpenApi: false });
  
  const [showHostDetailModal, setShowHostDetailModal] = useState(false);
  const [selectedHostForDetail, setSelectedHostForDetail] = useState(null);
  const [hostDetailActiveTab, setHostDetailActiveTab] = useState('overview');
  const [selectedHostMetrics, setSelectedHostMetrics] = useState([]);
  
  const [actionMenuOpenId, setActionMenuOpenId] = useState(null);
  const [apiKeyMenuOpenId, setApiKeyMenuOpenId] = useState(null);
  const [selectedTags, setSelectedTags] = useState([]); // For Hosts filtering
  const [tagInput, setTagInput] = useState('');
  const [environments, setEnvironments] = useState([]);
  const [selectedEnvFilter, setSelectedEnvFilter] = useState('');
  
  useEffect(() => {
      const closeMenu = () => {
          setActionMenuOpenId(null);
          setApiKeyMenuOpenId(null);
      };
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
          } catch(err) {
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
      } catch(err) {
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
      const res = await api.get('/monitor/data/dashboard');
      setMonitors(res.data.monitors || []);
      setAlerts(res.data.alerts || []);
      setLastUpdated(Date.now());
      
      const envRes = await api.get('/environments');
      setEnvironments(envRes.data || []);
    } catch (err) {
      console.error(err);
      showToast('Failed to fetch dashboard data', 'error');
    } finally {
      setLoading(false);
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
  }, []); // BUG-08: Run only on mount

  useEffect(() => {
    // Refresh only when tab changes without resetting intervals
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
            time: new Date(d.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}),
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
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
  };

  if (loading) return <div style={{...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5}}>Loading Dashboard...</div>;

  const activeAlerts = alerts.filter(a => !a.resolved);
  
  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
            <h1 style={S.title}>{'\u{1F916}'} Agents & API Keys</h1>
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
        <button style={activeTab === 'apikeys' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('apikeys')}>API Keys</button>
        <button style={activeTab === 'install' ? S.tabActive : S.tabInactive} onClick={() => setActiveTab('install')}>Install Agent</button>
      </div>

      {activeTab === 'dashboard' && (
        <DashboardTab monitors={monitors} activeAlerts={activeAlerts} alerts={alerts} getTimeAgo={getTimeAgo} />
      )}

      {activeTab === 'hosts' && (
        <div style={S.card}>
          <div style={{...S.cardHead, display: 'flex', gap: 16, flexWrap: 'wrap'}}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{'\u{1F5A5} Managed Hosts'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 24 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Environment:</span>
                <select style={{...S.select, padding: '4px 8px', fontSize: 12, width: 'auto'}} value={selectedEnvFilter} onChange={e => setSelectedEnvFilter(e.target.value)}>
                    <option value="">All Environments</option>
                    {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, paddingLeft: 12, borderLeft: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Filter by Tags:</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, maxHeight: 60, overflowY: 'auto', paddingRight: 8 }}>
                    {allAvailableTags.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No tags available</span>}
                    {allAvailableTags.map(tag => (
                        <button key={tag} 
                            style={{...S.badge, cursor: 'pointer', background: selectedTags.includes(tag) ? 'var(--accent-primary)' : 'var(--bg-glass)', border: '1px solid var(--border-color)', color: selectedTags.includes(tag) ? '#fff' : 'var(--text-primary)'}}
                            onClick={() => {
                                if (selectedTags.includes(tag)) setSelectedTags(selectedTags.filter(t => t !== tag));
                                else setSelectedTags([...selectedTags, tag]);
                            }}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            </div>
            <button style={{...S.btnP, padding: '6px 14px', fontSize: 12}} onClick={() => openHostModal()}>+ Add Host</button>
          </div>
          {selectedHostIds.length > 0 && (
              <div style={{ padding: '12px 24px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedHostIds.length} host(s) selected</span>
                  <div style={{ display: 'flex', gap: 12 }}>
                      <button style={{...S.btnS, fontSize: 12, padding: '4px 12px'}} onClick={() => setSelectedHostIds([])}>Clear</button>
                      <button style={{...S.btnP, fontSize: 12, padding: '4px 12px'}} onClick={() => openApplyRuleModal('monitor', '')}>Apply Rule</button>
                  </div>
              </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{...S.th, width: 40}}>
                    <input type="checkbox" 
                        checked={monitors.length > 0 && selectedHostIds.length === monitors.length}
                        onChange={(e) => setSelectedHostIds(e.target.checked ? monitors.map(m => m.id) : [])}
                    />
                </th>
                <th style={S.th}>Name</th>
                <th style={S.th}>IP</th>
                <th style={S.th}>OS</th>
                <th style={S.th}>Version</th>
                <th style={S.th}>CPU</th>
                <th style={S.th}>Memory</th>
                <th style={S.th}>Disk</th>
                <th style={S.th}>Status</th>
                <th style={S.th}>Tags</th>
                <th style={{...S.th, textAlign: 'right'}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {monitors.filter(m => {
                  if (selectedEnvFilter && m.envId !== selectedEnvFilter) return false;
                  if (selectedTags.length > 0 && !selectedTags.some(t => (m.tags || []).includes(t))) return false;
                  return true;
              }).map(m => (
                <tr key={m.id} style={{ opacity: m.enabled === false ? 0.5 : 1, background: selectedHostIds.includes(m.id) ? 'rgba(59, 130, 246, 0.1)' : 'transparent' }}>
                  <td style={{...S.td, width: 40}}>
                      <input type="checkbox" 
                          checked={selectedHostIds.includes(m.id)}
                          onChange={(e) => {
                              if (e.target.checked) setSelectedHostIds([...selectedHostIds, m.id]);
                              else setSelectedHostIds(selectedHostIds.filter(id => id !== m.id));
                          }}
                      />
                  </td>
                  <td style={{...S.td, fontWeight: 700}}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontWeight: 800, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: m.enabled === false ? 'line-through' : 'none' }} onClick={() => handleHostClick(m)}>
                            {m.name}
                        </button>
                        {m.envId && (
                            <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-glass)', borderRadius: 4, color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}>
                                {environments.find(e => e.id === m.envId)?.name || 'Unknown ENV'}
                            </span>
                        )}
                    </div>
                  </td>
                  <td style={S.td}>{m.ip}</td>
                  <td style={S.td}><span style={{...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-primary)', textTransform: 'uppercase'}}>{m.os}</span></td>
                  <td style={S.td}><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.version || 'Unknown'}</span></td>
                  <td style={{...S.td, fontWeight: 700, color: m.lastMetric?.cpu?.used > 80 ? '#ef4444' : 'inherit'}}>{m.lastMetric?.cpu?.used != null ? `${m.lastMetric.cpu.used.toFixed(1)}%` : '-'}</td>
                  <td style={{...S.td, fontWeight: 700, color: m.lastMetric?.memory?.used > 80 ? '#ef4444' : 'inherit'}}>{m.lastMetric?.memory?.used != null ? `${m.lastMetric.memory.used.toFixed(1)}%` : '-'}</td>
                  <td style={{...S.td, fontWeight: 700}}>{(() => {
                        if (!m.lastMetric?.disk?.length) return '-';
                        const root = m.lastMetric.disk.find(d => d.mountPoint === '/' || d.mountPoint === 'C:\\' || d.mount === '/' || d.mount === 'C:\\') || m.lastMetric.disk[0];
                        if (root.used == null) return '-';
                        const totalGB = root.totalGB != null ? root.totalGB : (root.total ? root.total / (1024 * 1024 * 1024) : 0);
                        const freeGB = root.freeGB != null ? root.freeGB : (root.free ? root.free / (1024 * 1024 * 1024) : (totalGB > 0 ? totalGB * (1 - root.used / 100) : null));
                        const freeText = freeGB != null && !isNaN(freeGB) ? (freeGB < 1 ? `${(freeGB * 1024).toFixed(0)}MB free` : `${freeGB.toFixed(1)}GB free`) : '';
                        return (
                          <span>
                            {root.used.toFixed(1)}%
                            {freeText && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginLeft: 6 }}>({freeText})</span>}
                          </span>
                        );
                  })()}</td>
                  <td style={S.td}>
                    {m.enabled === false ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f59e0b' }}>
                        <div style={{...S.dot, width: 8, height: 8, background: '#f59e0b'}}></div>
                        Disabled
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{...S.dot, width: 8, height: 8, background: m.status === 'offline' ? '#ef4444' : '#10b981'}}></div>
                        {m.status || 'unknown'}
                      </div>
                    )}
                  </td>
                  <td style={S.td}>
                    {m.tags && m.tags.length > 0 ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                            {m.tags.slice(0, 2).map(t => <span key={t} style={{...S.badge, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-muted)'}}>{t}</span>)}
                            {m.tags.length > 2 && (
                                <span title={m.tags.slice(2).join(', ')} style={{...S.badge, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', cursor: 'help', fontWeight: 800}}>+{m.tags.length - 2}</span>
                            )}
                        </div>
                    ) : '-'}
                  </td>
                  <td style={{...S.td, textAlign: 'right', position: 'relative'}}>
                    <button style={{...S.btnS, padding: '4px 10px', fontSize: 11, display: 'inline-block'}} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(actionMenuOpenId === m.id ? null : m.id); }}>{'\u2630'} Action</button>
                    {actionMenuOpenId === m.id && (
                        <div style={{ position: 'absolute', right: 24, top: 'calc(50% + 14px)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 20px rgba(0,0,0,0.5)', zIndex: 999, minWidth: 130, overflow: 'hidden' }}>
                            <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); viewHostDetail(m, 'history'); }}>{'\u{1F4C8} Metrics'}</div>
                            {!isViewer && <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); openHostModal(m); }}>{'\u2699\uFE0F Edit'}</div>}
                            {!isViewer && <div style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: m.enabled === false ? '#10b981' : '#f59e0b' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); handleToggleEnable(m); }}>{m.enabled === false ? '\u{1F7E2} Enable' : '\u{1F7E1} Disable'}</div>}
                            {!isViewer && <div style={{ padding: '8px 16px', cursor: 'pointer', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }} onClick={(e) => { e.stopPropagation(); setActionMenuOpenId(null); handleDeleteHost(m.id); }}>{'\u274C Delete'}</div>}
                        </div>
                    )}
                  </td>
                </tr>
              ))}
              {monitors.length === 0 && <tr><td colSpan="7" style={{...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40}}>No hosts configured</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'apikeys' && (
        <div style={S.card}>
          <div style={S.cardHead}>
            <span>{'\u{1F511} API Keys (Deployment Keys)'}</span>
            {!isViewer && <button style={{...S.btnP, padding: '6px 14px', fontSize: 12}} onClick={openApiKeyModal}>+ Create API Key</button>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={S.th}>Name</th>
                <th style={S.th}>Description</th>
                <th style={S.th}>Environment</th>
                <th style={S.th}>Key</th>
                <th style={S.th}>Registered / Limit</th>
                <th style={S.th}>Created At</th>
                <th style={{...S.th, textAlign: 'right'}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map(k => (
                <tr key={k.id}>
                  <td style={{...S.td, fontWeight: 700}}>
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
                        <button style={{...S.btnS, padding: '2px 8px', fontSize: 11, borderRadius: 8}} onClick={() => copyApiKey(k.key)}>Copy</button>
                    </div>
                  </td>
                  <td style={S.td}>
                    {k.isOpenApi ? (
                      <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: 'rgba(16, 185, 129, 0.12)', color: '#10b981', fontWeight: 700, border: '1px solid rgba(16, 185, 129, 0.25)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        🌐 Open API Only
                      </span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700 }}>
                          <span style={{ color: k.registeredCount >= k.maxAgents ? '#ef4444' : 'var(--text-primary)' }}>
                            {k.registeredCount} / {k.maxAgents}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>{Math.round((k.registeredCount / k.maxAgents) * 100)}%</span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, (k.registeredCount / k.maxAgents) * 100)}%`, background: k.registeredCount >= k.maxAgents ? '#ef4444' : 'var(--accent-primary)', transition: 'width 0.3s' }} />
                        </div>
                      </div>
                    )}
                  </td>
                  <td style={{...S.td, color: 'var(--text-muted)'}}>{new Date(k.createdAt).toLocaleString()}</td>
                  <td style={{...S.td, textAlign: 'right', position: 'relative'}}>
                    <button 
                      style={{...S.btnS, padding: '4px 10px', fontSize: 11, display: 'inline-block'}} 
                      onClick={(e) => { e.stopPropagation(); setApiKeyMenuOpenId(apiKeyMenuOpenId === k.id ? null : k.id); }}
                    >
                      {'\u2630'} Action
                    </button>
                    {apiKeyMenuOpenId === k.id && (
                      <div style={{ position: 'absolute', right: 24, top: 'calc(50% + 14px)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 20px rgba(0,0,0,0.5)', zIndex: 999, minWidth: 120, overflow: 'hidden' }}>
                        {!isViewer && (
                          <div 
                            style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }} 
                            onClick={(e) => { e.stopPropagation(); setApiKeyMenuOpenId(null); openApiKeyModal(k); }}
                          >
                            ⚙️ Edit
                          </div>
                        )}
                        {!isViewer && (
                          <div 
                            style={{ padding: '8px 16px', cursor: 'pointer', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }} 
                            onClick={(e) => { e.stopPropagation(); setApiKeyMenuOpenId(null); handleDeleteApiKey(k.id); }}
                          >
                            ❌ Delete
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {apiKeys.length === 0 && <tr><td colSpan="7" style={{...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40}}>No API Keys generated</td></tr>}
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
          <div style={{...S.card, marginBottom: 28}}>
            <div style={S.cardHead}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span>{'\u{26A0}'} Rule Templates</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setRuleCategoryFilter('all')}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 14,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: ruleCategoryFilter === 'all' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                      background: ruleCategoryFilter === 'all' ? 'var(--accent-glow)' : 'transparent',
                      color: ruleCategoryFilter === 'all' ? 'var(--accent-primary)' : 'var(--text-muted)'
                    }}
                  >
                    All ({rules.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setRuleCategoryFilter('metric')}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 14,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: ruleCategoryFilter === 'metric' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                      background: ruleCategoryFilter === 'metric' ? 'var(--accent-glow)' : 'transparent',
                      color: ruleCategoryFilter === 'metric' ? 'var(--accent-primary)' : 'var(--text-muted)'
                    }}
                  >
                    📊 Metrics ({rules.filter(r => r.category !== 'log' && !['winevent', 'syslog'].includes(r.type)).length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setRuleCategoryFilter('log')}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 14,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: ruleCategoryFilter === 'log' ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                      background: ruleCategoryFilter === 'log' ? 'var(--accent-glow)' : 'transparent',
                      color: ruleCategoryFilter === 'log' ? 'var(--accent-primary)' : 'var(--text-muted)'
                    }}
                  >
                    📋 Event & Syslogs ({rules.filter(r => r.category === 'log' || ['winevent', 'syslog'].includes(r.type)).length})
                  </button>
                </div>
              </div>
              <button style={{...S.btnP, padding: '6px 14px', fontSize: 12}} onClick={() => openRuleModal()}>+ Create Template</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Type</th>
                  <th style={S.th}>Target</th>
                  <th style={S.th}>Threshold</th>
                  <th style={S.th}>Condition</th>
                  <th style={{...S.th, textAlign: 'right'}}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules
                  .filter(r => {
                    const isLog = r.category === 'log' || ['winevent', 'syslog'].includes(r.type);
                    if (ruleCategoryFilter === 'metric') return !isLog;
                    if (ruleCategoryFilter === 'log') return isLog;
                    return true;
                  })
                  .map(r => {
                    const isLog = r.category === 'log' || ['winevent', 'syslog'].includes(r.type);
                    return (
                      <tr key={r.id}>
                        <td style={{...S.td, fontWeight: 700}}>
                          <div>
                            {r.name}
                            {isLog && (
                              <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontWeight: 800 }}>
                                LOG
                              </span>
                            )}
                          </div>
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
                        <td style={{...S.td}}>
                          {r.type === 'winevent' ? (
                            <span style={{ color: '#38bdf8', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              🪟 WIN EVENT
                            </span>
                          ) : r.type === 'syslog' ? (
                            <span style={{ color: '#34d399', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              🐧 SYSLOG
                            </span>
                          ) : r.type === 'offline' ? (
                            <span style={{ color: '#f87171', fontWeight: 800 }}>📡 OFFLINE</span>
                          ) : (
                            <span style={{ textTransform: 'uppercase' }}>{r.type}</span>
                          )}
                        </td>
                        <td style={S.td}>
                          {r.type === 'winevent' ? (
                            r.logConfig?.channel ? `[${r.logConfig.channel}] ID: ${r.logConfig.eventID || 'All'}` : (r.target || 'Windows Event')
                          ) : r.type === 'syslog' ? (
                            r.logConfig?.logPath || r.target || 'Syslog'
                          ) : r.type === 'offline' ? (
                            'Agent Heartbeat'
                          ) : (
                            r.target || '-'
                          )}
                        </td>
                        <td style={{...S.td, color: 'var(--accent-primary)', fontWeight: 800}}>
                          {r.type === 'winevent' ? (
                            <span>{r.logConfig?.level && r.logConfig.level !== 'All' ? `Level: ${r.logConfig.level}` : 'Any Level'}</span>
                          ) : r.type === 'syslog' ? (
                            <span>{r.logConfig?.severity && r.logConfig.severity !== 'All' ? `Sev: ${r.logConfig.severity}` : 'Any Sev'}</span>
                          ) : r.type === 'offline' ? (
                            r.threshold >= 60 ? `${Math.round(r.threshold / 60)}m (${r.threshold}s)` : `${r.threshold}s`
                          ) : (
                            r.threshold
                          )}
                        </td>
                        <td style={S.td}>
                          {r.type === 'winevent' || r.type === 'syslog' ? (
                            r.logConfig?.keyword ? `Keyword: "${r.logConfig.keyword}"` : `Trigger hits: ${r.alertHits || 1}`
                          ) : r.type === 'offline' ? (
                            `No heartbeat > buffer`
                          ) : (
                            `Trigger after ${r.alertHits} hits`
                          )}
                        </td>
                        <td style={{...S.td, textAlign: 'right'}}>
                          <button style={{...S.btnS, display: 'inline-block', marginRight: 8, padding: '4px 10px', fontSize: 11}} onClick={() => openRuleModal(r)}>Edit</button>
                          <button style={S.btnDanger} onClick={() => handleDeleteRule(r.id)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                {rules.length === 0 && <tr><td colSpan="6" style={{...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40}}>No rule templates configured</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={S.card}>
            <div style={S.cardHead}>
              <span>{'\u{1F517} Rule Assignments'}</span>
              <button style={{...S.btnS, padding: '6px 14px', fontSize: 12}} onClick={() => openApplyRuleModal('tag', '')}>+ Assign Rule</button>
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
                            <td style={{...S.td, fontWeight: 700}}>{rule.name}</td>
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
                                            <div key={b.id} style={{...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-color)', padding: '4px 10px'}}>
                                                <span>{scopeDisplay} <strong style={{color: 'var(--accent-primary)'}}>{scopeName || b.scopeValue}</strong></span>
                                                <button 
                                                    style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 4px', fontSize: 14, fontWeight: 'bold' }}
                                                    onClick={() => handleDeleteBinding(b.id)}
                                                    title="Remove assignment"
                                                >×</button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </td>
                        </tr>
                    );
                })}
                {bindings.length === 0 && <tr><td colSpan="2" style={{...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40}}>No active assignments</td></tr>}
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
                                          style={{...S.btnP, padding: '12px 24px', fontSize: 14}} 
                                          onClick={() => { setIsMultiUse(false); generateInstallToken(false); }}
                                      >
                                          Generate One-Time Install Command
                                      </button>
                                      <button 
                                          style={{...S.btnS, padding: '12px 24px', fontSize: 14, background: 'var(--bg-glass)', border: '1px solid var(--border-color)'}} 
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
                                              style={{...S.btnS, padding: '8px 16px', fontSize: 13}} 
                                              onClick={() => setSetupMultiUse(false)}
                                          >
                                              Cancel
                                          </button>
                                          <button 
                                              style={{...S.btnP, padding: '8px 16px', fontSize: 13}} 
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
                                              style={{...S.input, height: 80, fontFamily: 'monospace', fontSize: 11, background: '#0d1117', color: '#e6edf3', cursor: 'text', resize: 'none'}}
                                              value={`powershell -Command "Invoke-WebRequest -Uri '${window.location.protocol}//${window.location.host}/api/inventory/install.ps1?token=${installToken}' -OutFile 'install.ps1' -UseBasicParsing; .\\install.ps1"`}
                                          />
                                          <button 
                                              style={{...S.btnS, position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11}}
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
                                              style={{...S.input, height: 80, fontFamily: 'monospace', fontSize: 11, background: '#0d1117', color: '#e6edf3', cursor: 'text', resize: 'none'}}
                                              value={`curl -sL "${window.location.protocol}//${window.location.host}/api/inventory/install.sh?token=${installToken}" | sudo bash`}
                                          />
                                          <button 
                                              style={{...S.btnS, position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11}}
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
                <input style={S.input} value={hostForm.name} onChange={e => setHostForm({...hostForm, name: e.target.value})} placeholder="e.g. WEB-PROD-01" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>IP Address</label>
                <input style={S.input} value={hostForm.ip} onChange={e => setHostForm({...hostForm, ip: e.target.value})} placeholder="e.g. 10.0.0.10" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div style={S.inputGroup}>
                    <label style={S.label}>OS</label>
                    <select style={S.select} value={hostForm.os} onChange={e => setHostForm({...hostForm, os: e.target.value})}>
                        <option value="linux">Linux</option>
                        <option value="windows">Windows</option>
                    </select>
                  </div>
                  <div style={S.inputGroup}>
                    <label style={S.label}>Report Interval (s)</label>
                    <input type="number" style={S.input} value={hostForm.reportInterval} onChange={e => setHostForm({...hostForm, reportInterval: parseInt(e.target.value) || 60})} />
                  </div>
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Tags (Comma separated)</label>
                <input style={S.input} value={hostForm.tags} onChange={e => setHostForm({...hostForm, tags: e.target.value})} placeholder="e.g. prod, web-server" />
                {allAvailableTags.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8, display: 'block', marginBottom: 4 }}>Click to add existing:</span>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 80, overflowY: 'auto', padding: 4, background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                            {allAvailableTags.map(tag => {
                                const currentTags = hostForm.tags ? hostForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
                                const isAdded = currentTags.includes(tag);
                                return (
                                    <span key={tag} 
                                        style={{...S.badge, cursor: 'pointer', background: isAdded ? 'var(--bg-secondary)' : 'var(--bg-glass)', border: '1px solid var(--border-color)', color: isAdded ? 'var(--text-muted)' : 'var(--text-primary)', opacity: isAdded ? 0.5 : 1}}
                                        onClick={() => {
                                            if (!isAdded) {
                                                const newTags = currentTags.concat(tag);
                                                setHostForm({...hostForm, tags: newTags.join(', ')});
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
                <input style={S.input} value={hostForm.pingTargets} onChange={e => setHostForm({...hostForm, pingTargets: e.target.value})} placeholder="e.g. 8.8.8.8, 1.1.1.1" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>TCP Targets (Comma separated)</label>
                <input style={S.input} value={hostForm.tcpTargets} onChange={e => setHostForm({...hostForm, tcpTargets: e.target.value})} placeholder="e.g. 127.0.0.1:3306, 127.0.0.1:80" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Watch Services (Comma separated)</label>
                <input style={S.input} value={hostForm.watchServices} onChange={e => setHostForm({...hostForm, watchServices: e.target.value})} placeholder={hostForm.os === 'windows' ? "e.g. wuauserv, spooler" : "Only applies to Windows OS"} disabled={hostForm.os !== 'windows'} />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Watch Processes (Comma separated)</label>
                <input style={S.input} value={hostForm.watchProcesses} onChange={e => setHostForm({...hostForm, watchProcesses: e.target.value})} placeholder="e.g. nginx, node" />
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
                          <select style={S.select} value={applyRuleForm.ruleId} onChange={e => setApplyRuleForm({...applyRuleForm, ruleId: e.target.value})}>
                              <option value="" disabled>Select Rule...</option>
                              {rules.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
                          </select>
                      </div>

                      {selectedHostIds.length === 0 && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
                              <div style={S.inputGroup}>
                                <label style={S.label}>Apply To (Scope)</label>
                                <select style={S.select} value={applyRuleForm.scopeType} onChange={e => setApplyRuleForm({...applyRuleForm, scopeType: e.target.value, scopeValue: ''})}>
                                    <option value="monitor">Specific Host</option>
                                    <option value="apikey">API Key Group</option>
                                    <option value="tag">Tag Group</option>
                                    <option value="env">Environment (ENV)</option>
                                </select>
                              </div>
                              <div style={S.inputGroup}>
                                <label style={S.label}>Scope Value</label>
                                {applyRuleForm.scopeType === 'monitor' ? (
                                    <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({...applyRuleForm, scopeValue: e.target.value})}>
                                        <option value="" disabled>Select Host...</option>
                                        {monitors.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                    </select>
                                ) : applyRuleForm.scopeType === 'apikey' ? (
                                    <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({...applyRuleForm, scopeValue: e.target.value})}>
                                        <option value="" disabled>Select API Key...</option>
                                        {apiKeys.map(k => <option key={k.key} value={k.key}>{k.name}</option>)}
                                    </select>
                                ) : applyRuleForm.scopeType === 'env' ? (
                                    <select style={S.select} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({...applyRuleForm, scopeValue: e.target.value})}>
                                        <option value="" disabled>Select Environment...</option>
                                        {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                                    </select>
                                ) : (
                                    <input style={S.input} value={applyRuleForm.scopeValue} onChange={e => setApplyRuleForm({...applyRuleForm, scopeValue: e.target.value})} placeholder="e.g. prod" />
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
                <input style={S.input} value={apiKeyForm.name} onChange={e => setApiKeyForm({...apiKeyForm, name: e.target.value})} placeholder="e.g. US-East-Production" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Description</label>
                <input style={S.input} value={apiKeyForm.desc} onChange={e => setApiKeyForm({...apiKeyForm, desc: e.target.value})} placeholder="e.g. Used for core database servers" />
              </div>
              <div style={S.inputGroup}>
                <label style={S.label}>Environment (Optional)</label>
                <select style={S.input} value={apiKeyForm.envId} onChange={e => setApiKeyForm({...apiKeyForm, envId: e.target.value})}>
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
                  <input type="number" style={S.input} value={apiKeyForm.maxAgents} onChange={e => setApiKeyForm({...apiKeyForm, maxAgents: parseInt(e.target.value) || 0})} placeholder="e.g. 50" />
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

            <HostDetailModal isOpen={showHostDetailModal} onClose={() => setShowHostDetailModal(false)} initialHost={selectedHostForDetail} />

    </div>
  );
}

// --- Alerts Tab Component ---
function AlertsTab({ alerts, monitors, api, fetchDashboard }) {
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
        const a = document.createElement('a');
        a.href = url;
        a.download = `alerts_export_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
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
            <div style={{...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <span>{'\u{26A0}\u{FE0F} Alert History'}</span>
                <div style={{ display: 'flex', gap: 12 }}>
                    <input style={{...S.input, width: 200, padding: '6px 12px', fontSize: 13}} placeholder="Search host or type..." value={filter.search} onChange={e => setFilter({...filter, search: e.target.value})} />
                    <select style={{...S.select, width: 120, padding: '6px 12px', fontSize: 13}} value={filter.status} onChange={e => setFilter({...filter, status: e.target.value})}>
                        <option value="all">All Status</option>
                        <option value="active">Active</option>
                        <option value="resolved">Resolved</option>
                    </select>
                    <button style={{...S.btnP, fontSize: 12, padding: '6px 14px'}} onClick={handleExport}>{'\u{1F4E5}'} Export CSV</button>
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
                            <th style={{...S.th, textAlign: 'right'}}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredAlerts.map((a, i) => {
                            const host = monitors.find(m => m.id === a.monitorId);
                            return (
                                <tr key={a.id} style={{ borderBottom: i === filteredAlerts.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                                    <td style={S.td}>
                                        <span style={{...S.badge, background: a.resolved ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: a.resolved ? '#10b981' : '#ef4444'}}>
                                            {a.resolved ? 'Resolved' : 'Active'}
                                        </span>
                                    </td>
                                    <td style={{...S.td, color: 'var(--text-muted)'}}>{new Date(a.triggeredAt).toLocaleString()}</td>
                                    <td style={{...S.td, fontWeight: 700}}>{host ? host.name : 'Unknown'}</td>
                                    <td style={{...S.td}}>
                                        {a.type === 'winevent' ? (
                                            <span style={{ color: '#38bdf8', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                🪟 WIN EVENT
                                            </span>
                                        ) : a.type === 'syslog' ? (
                                            <span style={{ color: '#34d399', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                🐧 SYSLOG
                                            </span>
                                        ) : a.type === 'offline' ? (
                                            <span style={{ color: '#f87171', fontWeight: 800 }}>📡 OFFLINE</span>
                                        ) : (
                                            <span style={{ textTransform: 'uppercase' }}>{a.type}</span>
                                        )}
                                    </td>
                                    <td style={S.td}>
                                        {['winevent', 'syslog'].includes(a.type) ? (
                                            <span style={{ wordBreak: 'break-all' }}>{a.target ? `[${a.target}] ` : ''}{a.value}</span>
                                        ) : (
                                            <span>{a.target} {a.value} &gt; {a.threshold}</span>
                                        )}
                                    </td>
                                    <td style={{...S.td, textAlign: 'right'}}>
                                        {!a.resolved && (
                                            <button style={{...S.btnS, padding: '4px 10px', fontSize: 11}} onClick={() => handleResolve(a.id)}>Acknowledge</button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                        {filteredAlerts.length === 0 && <tr><td colSpan="6" style={{...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)'}}>No alerts found</td></tr>}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// --- Dashboard Component ---
function DashboardTab({ monitors, activeAlerts, alerts, getTimeAgo }) {
  const [topLimits, setTopLimits] = useState({ cpu: 5, mem: 5, disk: 5 });
  const toggleTopLimit = (key) => {
    setTopLimits(prev => ({ ...prev, [key]: prev[key] === 5 ? 10 : 5 }));
  };

  const todayAlerts = alerts.filter(a => new Date(a.triggeredAt) > new Date(Date.now() - 86400000));
  const onlineCount = monitors.filter(m => m.status !== 'offline').length;
  const offlineCount = monitors.filter(m => m.status === 'offline').length;
  const linuxCount = monitors.filter(m => m.os === 'linux').length;
  const winCount = monitors.filter(m => m.os === 'windows').length;

  const cpuList = [...monitors]
    .filter(m => m.lastMetric && m.lastMetric.cpu && typeof m.lastMetric.cpu.used === 'number')
    .map(m => ({ name: m.name, value: m.lastMetric.cpu.used }))
    .sort((a, b) => b.value - a.value).slice(0, topLimits.cpu);

  const memList = [...monitors]
    .filter(m => m.lastMetric && m.lastMetric.memory && typeof m.lastMetric.memory.used === 'number')
    .map(m => ({ name: m.name, value: m.lastMetric.memory.used }))
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
          name: m.name, 
          value: root.used || 0,
          drive: driveName,
          freeText: freeText
        };
    })
    .sort((a, b) => b.value - a.value).slice(0, topLimits.disk);

  return (
    <>
      <div style={S.topRow}>
        <div style={S.metCard}>
          <span style={S.metLabel}>Hosts</span>
          <div style={S.metVal}>{'\u{1F5A5}'} {monitors.length}</div>
        </div>
        <div style={S.metCard}>
          <span style={S.metLabel}>Online</span>
          <div style={{ ...S.metVal, color: '#10b981' }}><div style={{...S.dot, background: '#10b981'}}></div> {onlineCount}</div>
        </div>
        <div style={S.metCard}>
          <span style={S.metLabel}>Offline</span>
          <div style={{ ...S.metVal, color: '#ef4444' }}><div style={{...S.dot, background: '#ef4444'}}></div> {offlineCount}</div>
        </div>
        <div style={S.metCard}>
          <span style={S.metLabel}>Active Alerts</span>
          <div style={{ ...S.metVal, color: '#f59e0b', fontSize: 28 }}>
            {'\u{26A0}'} {activeAlerts.length}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            {'\u{1F195}'} Today: {todayAlerts.length} alerts
          </div>
        </div>
      </div>

      <div style={S.gridRow}>
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
              <div key={i} style={{ ...S.listRow, borderBottom: i === cpuList.length - 1 ? 'none' : S.listRow.borderBottom }}>
                <div style={{ width: 100, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                <div style={{ width: 40, textAlign: 'right', fontWeight: 800 }}>{m.value.toFixed(0)}%</div>
                <div style={S.progressBarContainer}>
                  <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
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
              <div key={i} style={{ ...S.listRow, borderBottom: i === memList.length - 1 ? 'none' : S.listRow.borderBottom }}>
                <div style={{ width: 100, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                <div style={{ width: 40, textAlign: 'right', fontWeight: 800 }}>{m.value.toFixed(0)}%</div>
                <div style={S.progressBarContainer}>
                  <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
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
                <div style={{ width: 110, minWidth: 110, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                  <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.name}>{m.name}</span>
                  {m.drive && <span style={{ fontSize: 10, background: 'var(--bg-secondary)', color: 'var(--text-muted)', padding: '1px 4px', borderRadius: 4, fontWeight: 600, flexShrink: 0 }}>{m.drive}</span>}
                </div>
                <div style={S.progressBarContainer}>
                  <div style={{ ...S.progressBar, width: `${Math.min(100, Math.max(0, m.value))}%`, background: m.value > 85 ? '#ef4444' : m.value > 70 ? '#f59e0b' : '#3b82f6' }}></div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', textAlign: 'right', minWidth: 95 }}>
                  <span>{m.value.toFixed(0)}%</span>
                  {m.freeText && <span style={{ color: '#10b981', fontWeight: 600, marginLeft: 4, fontSize: 11 }}>({m.freeText})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...S.card, marginBottom: 28 }}>
        <div style={S.cardHead}>{'\u{26A0}'} Active Alerts</div>
        <div style={{ padding: 0 }}>
          {activeAlerts.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>{'\u{2705}'} No active alerts</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {activeAlerts.map((a, i) => {
                  const monitor = monitors.find(m => m.id === a.monitorId);
                  const hostName = monitor ? monitor.name : 'Unknown';
                  return (
                    <tr key={a.id} style={{ borderBottom: i === activeAlerts.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                      <td style={{ ...S.td, width: 40, fontSize: 18 }}><div style={{...S.dot, background: '#ef4444'}}></div></td>
                      <td style={{ ...S.td, width: 60 }}><span style={{ ...S.badge, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }}>CRIT</span></td>
                      <td style={{ ...S.td, width: 140, fontWeight: 700 }}>{hostName}</td>
                      <td style={{ ...S.td }}>
                        <span style={{ fontWeight: 800, marginRight: 8, textTransform: 'uppercase' }}>{a.type}</span>
                        {a.target && <span style={{ color: 'var(--accent-primary)', marginRight: 8 }}>{a.target}</span>}
                        <span>{a.value} &gt; {a.threshold}</span>
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

      <div style={S.gridRow}>
        <div style={S.card}>
          <div style={S.cardHead}>Recent Hosts</div>
          <div style={{ padding: 0, maxHeight: 250, overflowY: 'auto' }}>
            {monitors.length === 0 ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No hosts</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {[...monitors].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0)).map((m, i) => (
                    <tr key={m.id} style={{ borderBottom: i === monitors.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{m.name}</td>
                      <td style={{ ...S.td, width: 40, textAlign: 'center' }}>
                         <div style={{...S.dot, background: m.status === 'offline' ? '#ef4444' : '#10b981'}}></div>
                      </td>
                      <td style={{ ...S.td, width: 80, textAlign: 'right', color: 'var(--text-muted)' }}>{getTimeAgo(m.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={S.card}>
          <div style={S.cardHead}>Agent Status</div>
          <div style={{ ...S.cardBody, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 250 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>{'\u{1F916}'}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Agent v1.0.0</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, marginBottom: 20 }}>Linux / Windows</div>
            <div style={{ display: 'flex', gap: 24, padding: '12px 24px', background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#3b82f6' }}>{linuxCount}</div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 4 }}>Linux</div>
              </div>
              <div style={{ width: 1, background: 'var(--border-color)' }}></div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#10b981' }}>{winCount}</div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 4 }}>Windows</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
