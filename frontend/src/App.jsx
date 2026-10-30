import React, { useState, useEffect, useMemo } from 'react';
import Login from './components/Login';
import DnsHub from './components/DnsHub';
import ADControlHub from './components/ADControl/ADControlHub';
import ServerCheck from './components/ServerOperation/ServerCheck';
import RemoteCommand from './components/ServerOperation/RemoteCommand';
import FortiProxy from './components/NetworkService/FortiProxy';
import SquidProxy from './components/NetworkService/SquidProxy';
import MailRelay from './components/ServicePlatform/MailRelay';
import ELKManager from './components/ServicePlatform/ELKManager';
import RemoteInstall from './components/ServerOperation/RemoteInstall';
import PrometheusSD from './components/ServicePlatform/PrometheusSD';
import NutanixManager from './components/ServerOperation/NutanixManager';
import DataCenterHub from './components/DataCenter/DataCenterHub';
import RedisControlPlane from './components/ServicePlatform/RedisControlPlane';
import KubernetesManager from './components/ServicePlatform/KubernetesManager';
import api from './api';
import AgentPanel from './components/Agent/AgentPanel';
import { AgentContext } from './contexts/AgentContext';
import ReadmeModal from './components/ReadmeModal';
import ServerInventory from './components/ServerOperation/ServerInventory';
import ServerList from './components/ServerOperation/ServerList';
import IPAM from './components/NetworkService/IPAM.jsx';
import SSLManager from './components/NetworkService/SSLManager';
import NetworkDevice from './components/NetworkService/NetworkDevice';
import SchedulerManager from './components/ServerOperation/SchedulerManager';
import HmChecker from './components/ServerOperation/HmChecker';
import Settings from './components/SettingsGroup/Settings';
import DevTools from './components/SettingsGroup/DevTools';
import NetSearch from './components/NetworkService/NetSearch';
import AuditLogViewer from './components/SettingsGroup/AuditLogViewer';
import WorkflowEditor from './components/ServicePlatform/WorkflowEditor';
import Runbook from './components/Runbook';
import MonitorHub from './components/MonitorGroup/MonitorHub';
import NasManager from './components/ServicePlatform/NasManager';
import SFTPManager from './components/ServicePlatform/SFTPManager';
import ErrorBoundary from './components/ErrorBoundary';

import DbInventory from './components/Database/DbInventory';
import SqlTerminal from './components/Database/SqlTerminal';
import ComingSoonPage from './components/Database/ComingSoon';
import DbPerformance from './components/Database/DbPerformance';
import DbProvision from './components/Database/DbProvision';
import DbBackup from './components/Database/DbBackup';

import MatrixRain from './components/Themes/MatrixRain';
import SakuraFall from './components/Themes/SakuraFall';
import CyberNodes from './components/Themes/CyberNodes';
import SunlightDust from './components/Themes/SunlightDust';

import { useSync } from './contexts/WebSocketContext';
import { useToast } from './contexts/ToastContext';

function App() {
  const [user, setUser] = useState(null);
  const { lastEvent } = useSync();
  const { showToast } = useToast();
  
  useEffect(() => {
      if (!lastEvent) return;
      switch(lastEvent.type) {
          case 'USER_ROLE_CHANGED': {
              const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
              if (currentUser.username === lastEvent.payload?.username) {
                  showToast(`Your role has been updated to ${lastEvent.payload?.role || 'None'}`, 'warning');
              }
              break;
          }
          case 'SESSION_TIMEOUT': {
              const loggedUser = JSON.parse(localStorage.getItem('user') || '{}');
              const targetUser = lastEvent.payload?.username || '';
              const myUsername = loggedUser.username ? `${loggedUser.username}@${loggedUser.domain || 'local'}` : '';
              if (!targetUser || targetUser.toLowerCase() === myUsername.toLowerCase() || targetUser.toLowerCase() === (loggedUser.username || '').toLowerCase()) {
                  showToast('Session has timed out due to inactivity.', 'warning');
                  // Silent client cleanup since server poller already sent the alert
                  handleLogout('cold_start_cleanup');
              }
              break;
          }
      }
  }, [lastEvent]);

  const getInitialView = () => {

    const params = new URLSearchParams(window.location.search);
    if (params.get('winCmd') || params.get('nixCmd') || params.get('ips')) {
      return 'SCHEDULER';
    }
    return 'HOME';
  };
  const [activeView, setActiveView] = useState(getInitialView());
  // Screens without a setActiveView prop can switch view with window.dispatchEvent(new CustomEvent('somp:navigate', { detail: { view } }))
  useEffect(() => {
    const onNavigate = (e) => { if (e.detail && e.detail.view) setActiveView(e.detail.view); };
    window.addEventListener('somp:navigate', onNavigate);
    return () => window.removeEventListener('somp:navigate', onNavigate);
  }, []);
  const [expandedGroups, setExpandedGroups] = useState({ 'SERVICE_PLATFORM': false, 'NETWORK_SERVICE': false, 'SERVER_OPERATION': false, 'DATA_CENTER': false, 'DATABASE_SERVICE': false, 'SETTINGS_GROUP': false });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [linuxPassword, setLinuxPassword] = useState('');
  const [linuxAdminUser, setLinuxAdminUser] = useState('xyuser');
  const [frontendTimeout, setFrontendTimeout] = useState(60 * 60 * 1000); // Default 60 mins
  const [isProcessing, setIsProcessing] = useState(false);
  const [featureFlags, setFeatureFlags] = useState({
    dnsHub: true, adControl: true, serverList: true, serverCheck: true, remoteCmd: true,
    fortiProxy: true, squid: true, mail: true, elk: true, install: true, prometheus: true, nutanix: true, dataCenter: true, redisControl: true, inventory: true, ipam: true, sslMonitor: true, scheduler: true, netSearch: true, kubernetes: true, nasControl: true, workflow: true, sftpManager: true, database: true,
    dbInventory: true, dbSqlTerminal: true, dbPerformance: true, dbProvision: true, dbBackup: true, networkDevice: true,
    monitorScout: true, monitorAlerts: true, monitorWinEvent: true, monitorLinuxLog: true, monitorAgents: true,
    hmChecker: true, aiAgent: true
  });
  const [featuresLoaded, setFeaturesLoaded] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'default');
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [showReadmeModal, setShowReadmeModal] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentRequest, setAgentRequest] = useState(null);
  const [aiAgentEnabled, setAiAgentEnabled] = useState(false);
  const [showUserGuideModal, setShowUserGuideModal] = useState(false);
  const [showTroubleshootModal, setShowTroubleshootModal] = useState(false);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const [sslAlerts, setSslAlerts] = useState([]);
  const [contractAlerts, setContractAlerts] = useState([]);
  const [schedulerAlerts, setSchedulerAlerts] = useState([]);
  const [spareAlerts, setSpareAlerts] = useState([]);
  const [dismissedAlerts, setDismissedAlerts] = useState(new Set());

  const dismissAlert = (alertType) => {
    setDismissedAlerts(prev => new Set(prev).add(alertType));
  };

  useEffect(() => {
    // Home banners read feature-gated APIs: wait for this user's flags and call only what the user may see
    // (until /config loads every banner flag counts as off, so no request can draw a 403).
    const allowed = (key) => featuresLoaded && featureFlags[key] === true;
    if (user && activeView === 'HOME' && featuresLoaded) {
      if (allowed('sslMonitor')) {
        api.get('/ssl/list').then(res => {
           const certs = res.data || [];
           // status is computed by the server against SSL_ALERT_THRESHOLD_DAYS (warning = 0..threshold days left)
           const expiring = certs.filter(c => (c.status ? c.status === 'warning' : (c.daysRemaining <= 30 && c.daysRemaining >= 0)));
           setSslAlerts(expiring);
        }).catch(e => console.error("Failed to load SSL for dashboard", e));
      }

      // GET /rack/contracts and /rack/spare-parts require the Data Center feature
      if (allowed('dataCenter')) api.get('/rack/contracts').then(res => {
         const now = new Date();
         const thirtyDaysFromNow = new Date();
         thirtyDaysFromNow.setDate(now.getDate() + 30);
         const expiring = (res.data || []).filter(c => {
             if (!c.endDate) return false;
             const exp = new Date(c.endDate);
             return exp >= now && exp <= thirtyDaysFromNow;
         });
         setContractAlerts(expiring);
      }).catch(e => console.error("Failed to load Contracts for dashboard", e));
      else setContractAlerts([]);

      // GET /scheduler/logs requires the Task Scheduler feature (API returns 403 otherwise)
      if (allowed('scheduler')) {
        api.get('/scheduler/logs').then(res => {
           const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
           const failed = (res.data || []).filter(l => l.runStatus === 'Failed' && new Date(l.runTime) >= oneDayAgo);
           // Group by task name for better display
           const failedByTask = {};
           failed.forEach(l => {
             if (!failedByTask[l.taskName]) failedByTask[l.taskName] = 0;
             failedByTask[l.taskName]++;
           });
           setSchedulerAlerts(Object.entries(failedByTask).map(([name, count]) => ({ name, count })));
        }).catch(e => console.error("Failed to load Scheduler Logs for dashboard", e));
      } else {
        setSchedulerAlerts([]);
      }

      if (allowed('dataCenter')) api.get('/rack/spare-parts').then(res => {
         const parts = res.data?.items || [];
         const low = parts.filter(p => p.quantity < (p.minStock || 0));
         setSpareAlerts(low);
      }).catch(e => console.error("Failed to load spare parts for dashboard", e));
      else setSpareAlerts([]);
    }
  }, [user, activeView, featuresLoaded, featureFlags.sslMonitor, featureFlags.scheduler, featureFlags.dataCenter]);

  // Auto-dismiss alerts after 30 seconds
  useEffect(() => {
    if (user) {
      const timer = setTimeout(() => {
        setDismissedAlerts(prev => new Set([...prev, 'ssl', 'contracts', 'scheduler', 'spare']));
      }, 30000);
      return () => clearTimeout(timer);
    }
  }, [user]);

  const lastActivity = React.useRef(parseInt(localStorage.getItem('lastActivity') || Date.now()));

  // 1. Restore user from localStorage once on mount
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    if (storedUser && token) {
      const initialElapsed = Date.now() - lastActivity.current;
      if (initialElapsed > frontendTimeout) {
        console.warn('Inactivity timeout reached while tab was closed. Cleaning up session silently...');
        handleLogout('cold_start_cleanup');
        return;
      }
      setUser(JSON.parse(storedUser));
    }
  }, []);

  // 2. Manage inactivity listeners and intervals
  useEffect(() => {
    if (!user) return; // Do not run inactivity interval if not logged in

    const resetActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      localStorage.setItem('lastActivity', now);
    };

    const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart', 'app-activity'];
    activityEvents.forEach(evt => window.addEventListener(evt, resetActivity));

    const interval = setInterval(() => {
      if (isProcessing) {
        const now = Date.now();
        lastActivity.current = now;
        localStorage.setItem('lastActivity', now);
        return;
      }

      const elapsed = Date.now() - lastActivity.current;
      if (elapsed > frontendTimeout) {
        console.warn('Inactivity timeout reached. Logging out...');
        handleLogout('timeout');
      }
    }, 10000);

    return () => {
      activityEvents.forEach(evt => window.removeEventListener(evt, resetActivity));
      clearInterval(interval);
    };
  }, [frontendTimeout, isProcessing, user]);

  // Periodic session heartbeat if active
  useEffect(() => {
    if (!user) return;
    const heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - lastActivity.current;
      if (elapsed < frontendTimeout) {
        api.post('/auth/heartbeat').catch(() => {});
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    return () => clearInterval(heartbeatTimer);
  }, [user, frontendTimeout]);

  // 3. Fetch config when user changes (e.g. login/logout)
  useEffect(() => {
    // featuresLoaded = feature flags of THIS user are known (not the defaults / the pre-login response)
    let cancelled = false;
    setFeaturesLoaded(false);
    api.get('/auth/config')
      .then(res => {
        if (cancelled) return;
        setLinuxAdminUser(res.data.linuxAdminUser);
        if (res.data.frontendTimeout) {
          setFrontendTimeout(res.data.frontendTimeout);
          api.defaults.timeout = res.data.frontendTimeout;
          console.log(`Frontend timeout set to ${res.data.frontendTimeout}ms`);
        }
        if (res.data.features) {
          setFeatureFlags(res.data.features);
          console.log('Feature flags loaded:', res.data.features);
          setFeaturesLoaded(!!user);
        }
      })
      .catch(err => console.error('Failed to fetch system config:', err));
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    // GET /ai/config requires the AI Ops Agent feature (or Settings): ask only when the agent may be shown
    if (!user || !featuresLoaded || featureFlags.aiAgent !== true) { setAiAgentEnabled(false); return; }
    api.get('/ai/config')
      .then(res => setAiAgentEnabled(!!(res.data?.enabled && res.data?.agentEnabled)))
      .catch(() => setAiAgentEnabled(false));
  }, [user, featuresLoaded, featureFlags.aiAgent]);

  const agentAvailable = !!user && aiAgentEnabled && featureFlags.aiAgent !== false;
  const agentContextValue = useMemo(() => ({
    available: agentAvailable,
    investigate: (prompt, alertId) => {
      setAgentRequest({ prompt, alertId, at: Date.now() });
      setAgentOpen(true);
    },
  }), [agentAvailable]);

  const handleLogout = (type = 'logout') => {
    setAiAgentEnabled(false);
    setAgentOpen(false);
    setAgentRequest(null);
    const storedUser = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    const currentUser = storedUser ? JSON.parse(storedUser) : user;
    if (currentUser && currentUser.username) {
      const fullUsername = `${currentUser.username}@${currentUser.domain}`;
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fullUsername, type, token }),
        keepalive: true
      }).catch(() => { });
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setLinuxPassword('');
    setUser(null);
    window.history.replaceState({}, '', '/login'); // Simulate navigate('/login', { replace: true })
  };

  const navItems = [
    { id: 'HUB', label: 'DNS Hub', icon: '🌐', flag: 'dnsHub', title: 'Domain Name System Management', component: <DnsHub /> },
    { id: 'AD', label: 'AD Control', icon: '👤', flag: 'adControl', title: 'Active Directory & GPO Control', component: <ADControlHub /> },
    { 
      id: 'MONITOR_GROUP', 
      label: 'Monitor', 
      icon: '👁️', 
      isGroup: true,
      children: [
        { id: 'MONITOR_SCOUT', label: 'Scout Monitor', icon: '📊', flag: 'monitorScout', title: 'Scout Monitor Dashboard', component: <MonitorHub activeTab="scout-monitor" setActiveView={setActiveView} /> },
        { id: 'MONITOR_ALERTS', label: 'Alerts & Rules', icon: '🔔', flag: 'monitorAlerts', title: 'Alerts & Rules', component: <MonitorHub activeTab="alerts" setActiveView={setActiveView} /> },
        { id: 'MONITOR_WINEVENT', label: 'Live Event Viewer', icon: '📺', flag: 'monitorWinEvent', title: 'Live Event Viewer', component: <MonitorHub activeTab="live-viewer" setActiveView={setActiveView} /> },
        { id: 'MONITOR_LINUXLOG', label: 'Log Settings', icon: '⚙️', flag: 'monitorLinuxLog', title: 'Log Settings', component: <MonitorHub activeTab="log-settings" setActiveView={setActiveView} /> },
        { id: 'MONITOR_AGENTS', label: 'Agents', icon: '🤖', flag: 'monitorAgents', title: 'API Keys & Agents', component: <MonitorHub activeTab="agents" setActiveView={setActiveView} /> }
      ]
    },
    { 
      id: 'SERVER_OPERATION', 
      label: 'Server Operation', 
      icon: '🖥️', 
      isGroup: true,
      children: [
        { id: 'SERVER_LIST', label: 'Server List', icon: '💻', flag: 'serverList', title: 'Server List (Simplified CMDB)', component: <ServerList /> },
        { id: 'CHECK', label: 'Server Check', icon: '🔍', flag: 'serverCheck', title: 'Infrastructure Checkup', component: <ServerCheck linuxPassword={linuxPassword} setLinuxPassword={setLinuxPassword} linuxAdminUser={linuxAdminUser} /> },
        { id: 'CMD', label: 'Remote Command', icon: '⚡', flag: 'remoteCmd', title: 'Remote Execution Terminal', component: <RemoteCommand linuxPassword={linuxPassword} setLinuxPassword={setLinuxPassword} linuxAdminUser={linuxAdminUser} /> },
        { id: 'INSTALL', label: 'Server Provision', icon: '🚀', flag: 'install', title: 'Remote Server Provisioning (Windows Only)', component: <RemoteInstall linuxAdminUser={linuxAdminUser} setIsProcessing={setIsProcessing} /> },
        { id: 'NUTANIX', label: 'Nutanix', icon: '🏢', flag: 'nutanix', title: 'Prism Central VM Manager', component: <NutanixManager /> },
        { id: 'INVENTORY', label: 'Server Inventory', icon: '📋', flag: 'inventory', title: 'Server Inventory Dashboard', component: <ServerInventory /> },
        { id: 'SCHEDULER', label: 'Task Scheduler', icon: '⏱️', flag: 'scheduler', title: 'Task Scheduler & Cron Center', component: <SchedulerManager /> },
        { id: 'HM_CHECKER', label: 'HostMonitor Checker', icon: '📡', flag: 'hmChecker', title: 'HostMonitor Coverage Checker', component: <HmChecker /> }
      ]
    },
    { 
      id: 'NETWORK_SERVICE',
      label: 'Network Service',
      icon: '🖧',
      isGroup: true,
      children: [
        { id: 'FORTI', label: 'FortiProxy Manager', icon: '🛡️', flag: 'fortiProxy', title: 'FortiProxy Firewall Management', component: <FortiProxy setIsProcessing={setIsProcessing} /> },
        { id: 'SQUID', label: 'Squid Proxy', icon: '🦑', flag: 'squid', title: 'Squid Proxy Management', component: <SquidProxy linuxPassword={linuxPassword} setLinuxPassword={setLinuxPassword} linuxAdminUser={linuxAdminUser} setIsProcessing={setIsProcessing} /> },
        { id: 'IPAM', label: 'IPAM', icon: '🌐', flag: 'ipam', title: 'IP Address Management', component: <IPAM /> },
        { id: 'NETWORK_DEVICE', label: 'Network Device', icon: '🖧', flag: 'networkDevice', title: 'Network Device Manager', component: <NetworkDevice /> },
        { id: 'SSL', label: 'SSL Certificate', icon: '🔑', flag: 'sslMonitor', title: 'SSL/TLS Certificate Manager', component: <SSLManager /> },
        { id: 'NETSEARCH', label: 'NetSearch', icon: '🔍', flag: 'netSearch', title: 'NetSearch — Network Config Search & Visualizer', component: <NetSearch /> }
      ]
    },
    { 
      id: 'SERVICE_PLATFORM', 
      label: 'Service Platform', 
      icon: '🛠️', 
      isGroup: true,
      children: [
        { id: 'MAIL', label: 'Mail Relay', icon: '📧', flag: 'mail', title: 'Mail Relay Cluster Management', component: <MailRelay linuxPassword={linuxPassword} setLinuxPassword={setLinuxPassword} linuxAdminUser={linuxAdminUser} setIsProcessing={setIsProcessing} /> },
        { id: 'ELK', label: 'ELK Manager', icon: '📊', flag: 'elk', title: 'ELK Platform Analytics Engine', component: <ELKManager linuxPassword={linuxPassword} setLinuxPassword={setLinuxPassword} linuxAdminUser={linuxAdminUser} setIsProcessing={setIsProcessing} /> },
        { id: 'PROMETHEUS', label: 'Prometheus Target', icon: '🎯', flag: 'prometheus', title: 'Target http service', component: <PrometheusSD /> },
        { id: 'REDIS', label: 'Redis Control', icon: '📕', flag: 'redisControl', title: 'Redis Control Plane', component: <RedisControlPlane /> },
        { id: 'KUBERNETES', label: 'Kubernetes', icon: '☸️', flag: 'kubernetes', title: 'Kubernetes Clusters', component: <KubernetesManager setIsProcessing={setIsProcessing} /> },
        { id: 'NAS', label: 'NAS Manager', icon: '💾', flag: 'nasControl', title: 'Unified NAS Storage Management', component: <NasManager /> },
        { id: 'WORKFLOW', label: 'Workflow Editor', icon: '⚡', flag: 'workflow', title: 'Visual Workflow Engine', component: <WorkflowEditor /> },
        { id: 'SFTP_MANAGER', label: 'SFTP Manager', icon: '📁', flag: 'sftpManager', title: 'SFTP Service Management', component: <SFTPManager setActiveView={setActiveView} /> }
      ]
    },
    { 
      id: 'DATA_CENTER', 
      label: 'Data Center', 
      icon: '🗄️', 
      isGroup: true,
      children: [
        { id: 'DC_CENTERS', label: 'Data Centers', icon: '🏢', flag: 'dataCenter', title: 'Data Centers', component: <DataCenterHub activeTab="data-centers" setActiveView={setActiveView} /> },
        { id: 'DC_RACK', label: 'Server Rack', icon: '🗄️', flag: 'dataCenter', title: 'Server Rack', component: <DataCenterHub activeTab="server-rack" setActiveView={setActiveView} /> },
        { id: 'DC_TOPOLOGY', label: 'Topology Map', icon: '🕸️', flag: 'dataCenter', title: 'Topology Map', component: <DataCenterHub activeTab="topology-map" setActiveView={setActiveView} /> },
        { id: 'DC_SPARE', label: 'Spare Parts', icon: '📦', flag: 'dataCenter', title: 'Spare Parts', component: <DataCenterHub activeTab="spare-parts" setActiveView={setActiveView} /> },
        { id: 'DC_ISSUES', label: 'Hardware Issues', icon: '🔧', flag: 'dataCenter', title: 'Hardware Issues', component: <DataCenterHub activeTab="hardware-issues" setActiveView={setActiveView} /> },
        { id: 'DC_CONTRACTS', label: 'Contracts & Warranties', icon: '📜', flag: 'dataCenter', title: 'Contracts & Warranties', component: <DataCenterHub activeTab="contracts" setActiveView={setActiveView} /> }
      ]
    },
    { 
      id: 'DATABASE_SERVICE', 
      label: 'Database', 
      icon: '🛢️', 
      isGroup: true,
      children: [
        { id: 'DB_INVENTORY', label: 'DB Connection Hub', icon: '🗂️', flag: 'dbInventory', title: 'Database Inventory & Connection Hub', component: <DbInventory /> },
        { id: 'DB_PERFORMANCE', label: 'Performance Dashboard', icon: '🚦', flag: 'dbPerformance', title: 'Database Performance Dashboard', component: <DbPerformance /> },
        { id: 'DB_PROVISION', label: 'Self-Service Provisioning', icon: '🛡️', flag: 'dbProvision', title: 'Self-Service DB Provisioning', component: <DbProvision /> },
        { id: 'DB_BACKUP', label: 'Backup & Restore', icon: '💾', flag: 'dbBackup', title: 'Backup & Restore Manager', component: <DbBackup /> },
        { id: 'DB_SQL_TERMINAL', label: 'SQL Query Terminal', icon: '🔍', flag: 'dbSqlTerminal', title: 'Web-based SQL Query Terminal', component: <SqlTerminal /> }
      ]
    },
    { 
      id: 'SETTINGS_GROUP', 
      label: 'Settings', 
      icon: '⚙️', 
      isGroup: true,
      children: [
        { id: 'SYS_SETTINGS', label: 'System Settings', icon: '⚙️', flag: 'settings', title: 'Global System Settings', component: <Settings mode="system" /> },
        { id: 'DEV_TOOLS', label: 'Dev Tools', icon: '🛠️', flag: 'settings', title: 'Developer Tools & API Console', component: <DevTools /> },
        { id: 'RBAC', label: 'RBAC', icon: '👥', flag: 'settings', title: 'Role & Group Mappings', component: <Settings mode="rbac" /> },
        { id: 'AUDIT', label: 'Audit log', icon: '📋', flag: 'settings', title: 'Audit Logs Viewer', component: <AuditLogViewer /> }
      ]
    },

    { id: 'RUNBOOK', label: 'SOP Runbook', icon: '📖', flag: 'runbook', title: 'SOP Runbook Library', component: <Runbook /> }
  ];

  const checkRoleAndFlag = (item) => {
    const role = user?.role || 'Viewer';
    if (item.flag === 'settings' || item.id === 'SYS_SETTINGS' || item.id === 'DEV_TOOLS' || item.id === 'RBAC' || item.id === 'AUDIT') {
      return role === 'SuperAdmin';
    }
    if (featureFlags[item.flag] === false) return false;
    if (role === 'Viewer' && (item.id === 'CMD' || item.id === 'INSTALL' || item.id === 'MONITOR_AGENTS')) return false;
    return true;
  };

  const enabledItems = navItems.reduce((acc, item) => {
    if (item.isGroup) {
      const children = item.children.filter(checkRoleAndFlag);
      if (children.length > 0) acc.push({ ...item, children });
    } else if (checkRoleAndFlag(item)) {
      acc.push(item);
    }
    return acc;
  }, []);

  const currentItem = navItems.reduce((acc, item) => {
    if (item.isGroup) {
      const found = item.children.find(c => c.id === activeView);
      if (found) return found;
    } else if (item.id === activeView) return item;
    return acc;
  }, null);

  const flatEnabledItems = enabledItems.reduce((acc, item) => {
    if (item.isGroup) {
      acc.push(...item.children);
    } else {
      acc.push(item);
    }
    return acc;
  }, []);

  // If activeView is disabled, fallback to HOME or first enabled item
  useEffect(() => {
    if (activeView !== 'HOME' && !flatEnabledItems.find(i => i.id === activeView)) {
      console.warn(`Encountered disabled view "${activeView}". Redirecting to HOME.`);
      setActiveView('HOME');
    }
  }, [featureFlags, activeView, flatEnabledItems]);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <AgentContext.Provider value={agentContextValue}>
    <div className="app-layout animate-fade-in">
      {theme === 'default' && <CyberNodes />}
      {theme === 'bw' && <SunlightDust />}
      {theme === 'gaming' && <MatrixRain />}
      {theme === 'pink' && <SakuraFall />}

      {/* Sidebar Navigation */}
      <aside className="sidebar transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) relative flex flex-col" style={{ width: sidebarOpen ? '260px' : '84px', padding: '1.5rem 0.5rem' }}>

        <div className="sidebar-header flex flex-col items-center" style={{ padding: sidebarOpen ? '0 1rem' : '0', transition: 'all 0.5s' }}>
          <h2 style={{ 
            whiteSpace: 'nowrap', 
            fontSize: sidebarOpen ? '1.5rem' : '1.2rem',
            fontWeight: 800,
            letterSpacing: sidebarOpen ? 'normal' : '2px',
            textAlign: 'center',
            width: '100%'
          }}>
            {sidebarOpen ? 'SOMP Vanguard' : 'SYS'}
          </h2>
          <span className="text-secondary" style={{ 
            fontSize: '0.8rem', 
            whiteSpace: 'nowrap',
            opacity: sidebarOpen ? 1 : 0,
            maxHeight: sidebarOpen ? '20px' : '0',
            overflow: 'hidden',
            transition: 'all 0.3s'
          }}>
            {user.domain}
          </span>
        </div>

        <nav className="sidebar-menu overflow-x-hidden mt-6" style={{ padding: sidebarOpen ? '0 0.5rem' : '0' }}>
          {enabledItems.map(item => {
            if (item.isGroup) {
              const isExpanded = expandedGroups[item.id];
              return (
                <div key={item.id} className="sidebar-group">
                  <div className="sidebar-item group-header" onClick={() => setExpandedGroups(p => ({ ...p, [item.id]: !p[item.id] }))} title={item.label} style={{ justifyContent: sidebarOpen ? 'flex-start' : 'center', padding: sidebarOpen ? '0.75rem 1rem' : '0.75rem 0' }}>
                    <span style={{ fontSize: '1.2rem', minWidth: '24px', textAlign: 'center' }}>{item.icon}</span>
                    {sidebarOpen && <span style={{ whiteSpace: 'nowrap', marginLeft: '12px', flex: 1, fontWeight: 'bold' }}>{item.label}</span>}
                    {sidebarOpen && <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{isExpanded ? '▼' : '▶'}</span>}
                  </div>
                  {isExpanded && sidebarOpen && (
                    <div className="sidebar-group-children" style={{ paddingLeft: '1.5rem', background: 'rgba(0,0,0,0.1)' }}>
                      {item.children.map(child => (
                        <div key={child.id} className={`sidebar-item ${activeView === child.id ? 'active' : ''}`} onClick={() => setActiveView(child.id)} title={child.label} style={{ padding: '0.6rem 1rem', fontSize: '0.9rem' }}>
                          <span style={{ fontSize: '1rem', minWidth: '20px', textAlign: 'center' }}>{child.icon}</span>
                          <span style={{ whiteSpace: 'nowrap', marginLeft: '10px' }}>{child.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {isExpanded && !sidebarOpen && (
                    <div className="sidebar-group-children" style={{ background: 'rgba(0,0,0,0.2)' }}>
                      {item.children.map(child => (
                        <div key={child.id} className={`sidebar-item ${activeView === child.id ? 'active' : ''}`} onClick={() => { setActiveView(child.id); setSidebarOpen(true); }} title={child.label} style={{ padding: '0.75rem 0', justifyContent: 'center' }}>
                          <span style={{ fontSize: '1rem', textAlign: 'center' }}>{child.icon}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={item.id} className={`sidebar-item ${activeView === item.id ? 'active' : ''}`} onClick={() => setActiveView(item.id)} title={item.label} style={{ justifyContent: sidebarOpen ? 'flex-start' : 'center', padding: sidebarOpen ? '0.75rem 1rem' : '0.75rem 0' }}>
                <span style={{ fontSize: '1.2rem', minWidth: '24px', textAlign: 'center' }}>{item.icon}</span>
                {sidebarOpen && <span className="animate-slide-in-right" style={{ whiteSpace: 'nowrap', marginLeft: '12px' }}>{item.label}</span>}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer mt-auto flex flex-col items-center pb-4">
          <div className="flex justify-center mb-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="flex items-center justify-center text-xs text-black bg-white rounded-full w-6 h-6 shadow-md border border-white/50 z-50 transition-transform duration-500 cursor-pointer hover:bg-gray-200"
              style={{ transform: sidebarOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              title="Toggle Sidebar"
            >
              ▶
            </button>
          </div>

          <div className={`relative flex items-center ${sidebarOpen ? 'gap-2 justify-center px-2' : 'justify-center'} w-full transition-all duration-300`}>
            <button
              className={`flex items-center justify-center transition-all duration-300 font-bold ${showSettingsDropdown ? 'bg-white text-black' : ''}`}
              style={{ 
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                border: '1px solid var(--border-color)', 
                background: showSettingsDropdown ? 'white' : 'rgba(255,255,255,0.05)',
                fontSize: '0.9rem',
                color: showSettingsDropdown ? '#000' : 'var(--sidebar-text)',
                boxShadow: showSettingsDropdown ? '0 0 10px rgba(255,255,255,0.2)' : 'none'
              }}
              onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
              title={user.username}
            >
              {user.username?.charAt(0).toUpperCase()}
            </button>
            {agentAvailable && (
              <button
                className="flex items-center justify-center transition-all duration-300"
                style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
                  border: '1px solid var(--border-color)',
                  background: agentOpen ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)',
                  fontSize: '0.9rem', marginLeft: sidebarOpen ? 0 : 4
                }}
                onClick={() => setAgentOpen(o => !o)}
                title="AI Ops Agent"
                aria-label="AI Ops Agent"
              >
                🤖
              </button>
            )}
            {sidebarOpen && (
              <span className="animate-fade-in" style={{ 
                fontSize: 10, 
                fontWeight: 800, 
                color: 'var(--sidebar-text-muted)',
                letterSpacing: '0.02em', 
                whiteSpace: 'nowrap', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis', 
                marginTop: '4px',
                textAlign: 'center'
              }}>
                {user.role} | {user.username}
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1)" style={{ maxWidth: sidebarOpen ? 'calc(100vw - 260px)' : 'calc(100vw - 84px)' }}>


        {/* Dynamic Component Rendering */}
        <div className="content-body h-full min-h-0">
          {activeView === 'HOME' ? (
            <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in py-20 px-10">
              <div className="glass-panel p-12 max-w-2xl transform hover:scale-[1.02] transition-transform duration-500">
                <div className="mb-8 text-6xl">🚀</div>
                <h1 className="text-5xl font-bold mb-6 tracking-tight" style={{ background: 'linear-gradient(to right, #22d3ee, #3b82f6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Welcome To SOMP Vanguard
                </h1>
                <p className="text-xl text-secondary mb-10 leading-relaxed">
                  Welcome back, <span className="text-white font-bold">{user.username}</span>. <br />
                </p>
              </div>
            </div>
          ) : (
            <ErrorBoundary key={currentItem?.id}>
              {currentItem && currentItem.component}
            </ErrorBoundary>
          )}
        </div>
      </main>

      {/* Floating Alerts Container */}
      {activeView === 'HOME' && (
        <div style={{ position: 'fixed', bottom: 32, right: 32, zIndex: 100, display: 'flex', flexDirection: 'column', gap: 16, width: 340 }}>
          
          {/* SSL Alert */}
          {featureFlags.sslMonitor && sslAlerts.length > 0 && !dismissedAlerts.has('ssl') && (
            <div 
              className="animate-slide-in-right" 
              onClick={() => setActiveView('SSL_CERT')}
              style={{ cursor: 'pointer', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderLeft: '4px solid var(--danger)', borderRadius: 12, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  ⚠️ SSL Expiration Alert
                </strong>
                <button onClick={(e) => { e.stopPropagation(); dismissAlert('ssl'); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>&times;</button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, marginTop: 0 }}>
                {sslAlerts.length} certificate(s) expiring soon:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-primary)' }}>
                {sslAlerts.slice(0, 3).map((cert, i) => (
                  <li key={i} style={{ marginBottom: 6 }}><strong style={{ color: cert.daysRemaining <= 7 ? '#ef4444' : '#f59e0b' }}>{cert.domain || cert.name || cert.host}</strong> — {cert.daysRemaining} days left</li>
                ))}
                {sslAlerts.length > 3 && <li style={{ color: 'var(--text-muted)', marginTop: 4 }}>+ {sslAlerts.length - 3} more...</li>}
              </ul>
            </div>
          )}

          {/* Contracts Alert */}
          {contractAlerts.length > 0 && !dismissedAlerts.has('contracts') && (
            <div 
              className="animate-slide-in-right" 
              onClick={() => setActiveView('DC_CONTRACTS')}
              style={{ cursor: 'pointer', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderLeft: '4px solid #f59e0b', borderRadius: 12, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  📜 Contract Expiration Alert
                </strong>
                <button onClick={(e) => { e.stopPropagation(); dismissAlert('contracts'); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>&times;</button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, marginTop: 0 }}>
                {contractAlerts.length} license/contract(s) expiring within 30 days:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-primary)' }}>
                {contractAlerts.slice(0, 3).map((cert, i) => {
                   const days = Math.floor((new Date(cert.endDate) - new Date()) / (1000 * 60 * 60 * 24));
                   return (<li key={i} style={{ marginBottom: 6 }}><strong style={{ color: '#f59e0b' }}>{cert.name || cert.item}</strong> — {days} days left</li>);
                })}
                {contractAlerts.length > 3 && <li style={{ color: 'var(--text-muted)', marginTop: 4 }}>+ {contractAlerts.length - 3} more...</li>}
              </ul>
            </div>
          )}

          {/* Scheduler Alert */}
          {schedulerAlerts.length > 0 && !dismissedAlerts.has('scheduler') && (
            <div 
              className="animate-slide-in-right" 
              onClick={() => setActiveView('SCHEDULER')}
              style={{ cursor: 'pointer', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderLeft: '4px solid var(--danger)', borderRadius: 12, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  🚨 Task Scheduler Alert
                </strong>
                <button onClick={(e) => { e.stopPropagation(); dismissAlert('scheduler'); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>&times;</button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, marginTop: 0 }}>
                {schedulerAlerts.length} task(s) failed in the last 24 hours:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-primary)' }}>
                {schedulerAlerts.slice(0, 3).map((task, i) => (
                  <li key={i} style={{ marginBottom: 6 }}><strong style={{ color: 'var(--danger)' }}>{task.name}</strong> — {task.count} failures</li>
                ))}
                {schedulerAlerts.length > 3 && <li style={{ color: 'var(--text-muted)', marginTop: 4 }}>+ {schedulerAlerts.length - 3} more...</li>}
              </ul>
            </div>
          )}

          {/* Spare Parts Alert */}
          {spareAlerts.length > 0 && !dismissedAlerts.has('spare') && (
            <div 
              className="animate-slide-in-right" 
              onClick={() => setActiveView('DC_SPARE')}
              style={{ cursor: 'pointer', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderLeft: '4px solid var(--danger)', borderRadius: 12, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  📦 Low Stock Alert
                </strong>
                <button onClick={(e) => { e.stopPropagation(); dismissAlert('spare'); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>&times;</button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, marginTop: 0 }}>
                {spareAlerts.length} spare part(s) below minimum stock level:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-primary)' }}>
                {spareAlerts.slice(0, 3).map((part, i) => (
                  <li key={i} style={{ marginBottom: 6 }}><strong style={{ color: 'var(--danger)' }}>{part.name}</strong> — {part.quantity} left (Min: {part.minStock})</li>
                ))}
                {spareAlerts.length > 3 && <li style={{ color: 'var(--text-muted)', marginTop: 4 }}>+ {spareAlerts.length - 3} more...</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {agentAvailable && (
        <AgentPanel
          open={agentOpen}
          onClose={() => setAgentOpen(false)}
          request={agentRequest}
          setActiveView={setActiveView}
        />
      )}
      {showReadmeModal && <ReadmeModal onClose={() => setShowReadmeModal(false)} type="readme" />}
      {showUserGuideModal && <ReadmeModal onClose={() => setShowUserGuideModal(false)} type="userguide" />}
      {showTroubleshootModal && <ReadmeModal onClose={() => setShowTroubleshootModal(false)} type="troubleshoot" />}

      {showSettingsDropdown && (
        <>
          <div className="settings-backdrop" onClick={() => setShowSettingsDropdown(false)} />
          <div className="glass-panel settings-dropdown" style={{ left: sidebarOpen ? '20px' : '70px', bottom: '80px' }}>
            <div className="px-3 py-2 text-xs font-bold text-secondary uppercase tracking-widest border-b border-white/10 mb-2">Themes Style</div>
            <div className="theme-switcher-row">
              {[
                { id: 'default', icon: '💠', title: 'Default', color: '#0096ff' },
                { id: 'bw', icon: '☀️', title: 'Warm', color: '#B58900' },
                { id: 'pink', icon: '🌸', title: 'Pink', color: '#FF8DA1' },
                { id: 'gaming', icon: '🎮', title: 'Power', color: '#85ff51' }
              ].map(t => (
                <div
                  key={t.id}
                  className={`theme-dot ${theme === t.id ? 'active' : ''}`}
                  style={{ background: t.color }}
                  onClick={() => { setTheme(t.id); setShowSettingsDropdown(false); }}
                  title={t.title}
                >
                  <span className="flex flex-col items-center gap-0">
                    <span>{t.icon}</span>
                    <span className="text-[8px] font-bold" style={{ lineHeight: '1' }}>{t.title}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="dropdown-divider" />
            <button className="dropdown-item" onClick={() => { setShowReadmeModal(true); setShowSettingsDropdown(false); }}>
              <span>📖</span> Readme
            </button>
            <button className="dropdown-item" onClick={() => { setShowUserGuideModal(true); setShowSettingsDropdown(false); }}>
              <span>📘</span> User Guide
            </button>
            <button className="dropdown-item" onClick={() => { setShowTroubleshootModal(true); setShowSettingsDropdown(false); }}>
              <span>🔍</span> Troubleshooting
            </button>
            <button className="dropdown-item" onClick={() => handleLogout()}>
              <span>🚪</span> Logout
            </button>
          </div>
        </>
      )}
    </div>
    </AgentContext.Provider>
  );
}

export default App;
