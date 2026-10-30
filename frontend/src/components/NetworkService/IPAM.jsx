import { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { useSync } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';
import HostDetailModal from '../Shared/HostDetailModal';
import { normalizeEnvs, defaultEnv } from '../../utils/environments';
import { 
  LuSearch, LuPlus, LuList, LuGrid3X3, LuFilter, LuChevronRight, LuActivity, LuShield, LuHash, LuZap, 
  LuChevronDown, LuSettings, LuTrash2, LuLayoutGrid, LuX, LuFileDown, LuFileUp, LuEllipsisVertical, LuPen,
  LuChevronLeft, LuCheck, LuCircleAlert, LuInfo, LuDatabase, LuGlobe, LuUser, LuShieldCheck
} from 'react-icons/lu';

// ==========================================
// COMPONENT: AssignmentDrawer
// ==========================================
function AssignmentDrawer({ isOpen, onClose, subnets, onComplete, initialData, role }) {
  const { showToast } = useToast();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    subnetId: '', address: '', hostname: '', fqdn: '',
    service: '', owner: '', environment: '', // '' = inherit the subnet's environment
    description: '', createDns: true
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [environments, setEnvironments] = useState([]);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setFormData(prev => ({
          ...prev,
          subnetId: initialData.subnetId || subnets[0]?.id || '',
          address: initialData.address || '',
          hostname: initialData.hostname || '',
          fqdn: initialData.fqdn || '',
          owner: initialData.assignedTo || '',
          service: initialData.service || '',
          environment: initialData.envId || '',
        }));
        if (initialData.address) setStep(3);
      } else if (subnets.length > 0 && !formData.subnetId) {
        setFormData(prev => ({ ...prev, subnetId: subnets[0].id }));
        setStep(1);
      }
    } else {
      resetForm();
    }
  }, [isOpen, initialData, subnets]);

  useEffect(() => {
    const fetchEnvironments = async () => {
      try {
        const res = await api.get('/environments');
        setEnvironments(res.data);
      } catch (e) {}
    };
    if (isOpen) fetchEnvironments();
  }, [isOpen]);

  // Reserves the next available IP for 10 minutes (skips gateway / reserved ranges / other reservations)
  const handleNextAvailable = async () => {
    if (!formData.subnetId) return;
    setError('');
    try {
      const res = await api.post(`/ipam/subnets/${formData.subnetId}/reserve-next`);
      setFormData(prev => ({ ...prev, address: res.data.address }));
      showToast(`已保留 ${res.data.address} 10 分鐘，請於期限內完成指派`, 'success');
    } catch (e) {
      setError(e.response?.data?.error || 'No available IPs found in this subnet');
    }
  };

  const handleAssign = async (force = false) => {
    setLoading(true);
    setError('');
    try {
      await api.put(`/ipam/subnets/${formData.subnetId}/ips`, {
        address: formData.address,
        status: 'used',
        hostname: formData.hostname,
        fqdn: formData.fqdn,
        assignedTo: formData.owner,
        service: formData.service,
        // environment id; empty -> the backend keeps / inherits the subnet's environment
        ...(formData.environment ? { envId: formData.environment } : {}),
        tags: formData.createDns ? ['DNS-Created'] : [],
        ...(force ? { force: true } : {})
      });
      showToast('Assignment completed successfully', 'success');
      onComplete();
      onClose();
    } catch (e) {
      const data = e.response?.data || {};
      if (e.response?.status === 409 && data.managedBy && role === 'SuperAdmin' && !force) {
        // system-managed IP: a SuperAdmin may override (audited)
        if (window.confirm(`${data.error}\n\n此 IP 由 ${data.managedBy} 管理，仍要強制修改嗎？`)) {
          setLoading(false);
          return handleAssign(true);
        }
      }
      setError(data.managedBy ? `${data.error}（由 ${data.managedBy} 管理）` : (data.error || 'System error during assignment'));
    }
    setLoading(false);
  };

  const { lastEvent } = useSync();
  useEffect(() => {
    if (!lastEvent) return;
    switch(lastEvent.type) {
      case 'IPAM_SCAN_FINISHED':
        if (onComplete) onComplete();
        break;
    }
  }, [lastEvent, onComplete]);

  const resetForm = () => {
    setStep(1);
    setFormData({
      subnetId: '', address: '', hostname: '', fqdn: '',
      service: '', owner: '', environment: '',
      description: '', createDns: true
    });
    setError('');
  };

  if (!isOpen) return null;

  const currentSubnet = subnets.find(s => s.id === formData.subnetId);

  return (
    <div className="modal-overlay" style={{ justifyContent: 'flex-end', padding: 0 }} onClick={onClose}>
      <div className="glass-panel animate-slide-in-right" style={{ 
        width: 520, height: '100%', borderRadius: 0, borderLeft: '1px solid var(--border-color)', 
        display: 'flex', flexDirection: 'column', overflow: 'hidden' 
      }} onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div style={{ padding: '32px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: 24, margin: 0 }}>IP Assignment</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>Guided resource allocation workflow</p>
          </div>
          <button onClick={onClose} className="btn-outline" style={{ padding: 8, borderRadius: '50%' }}><LuX size={20} /></button>
        </div>
        
        {/* Progress Stepper */}
        <div style={{ padding: '0 32px', display: 'flex', gap: 6 }}>
          {[1, 2, 3, 4].map(s => (
            <div key={s} style={{ 
              flex: 1, height: 4, borderRadius: 2, 
              background: s <= step ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
              boxShadow: s <= step ? '0 0 8px var(--accent-glow)' : 'none',
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)' 
            }} />
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>
          {error && <div className="error-message mb-4">{error}</div>}

          {step === 1 && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-4 mb-8">
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)' }}>
                  <LuDatabase size={22} />
                </div>
                <h3 style={{ margin: 0 }}>Network Context</h3>
              </div>
              <div className="flex-col gap-4">
                <div>
                  <label>Target Subnet</label>
                  <select className="form-input" value={formData.subnetId} onChange={e => setFormData({...formData, subnetId: e.target.value, address: ''})}>
                    {subnets.map(s => (<option key={s.id} value={s.id}>{s.name} ({s.cidr})</option>))}
                  </select>
                </div>
                {currentSubnet && (
                  <div className="glass-panel" style={{ padding: 20, marginTop: 12, background: 'rgba(255,255,255,0.03)' }}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Region</span>
                        <p style={{ margin: '4px 0 0', fontWeight: 600 }}>{currentSubnet.environment}</p>
                      </div>
                      <div>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>VLAN ID</span>
                        <p style={{ margin: '4px 0 0', fontWeight: 600 }}>{currentSubnet.vlan || 'None'}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-4 mb-8">
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)' }}>
                  <LuGlobe size={22} />
                </div>
                <h3 style={{ margin: 0 }}>IP Selection</h3>
              </div>
              <div className="flex-col gap-4">
                <label>IPv4 Address</label>
                <div className="flex gap-2">
                  <input className="form-input" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} placeholder="e.g. 192.168.1.1" />
                  <button className="btn-outline" onClick={handleNextAvailable} style={{ whiteSpace: 'nowrap' }}>Auto-Pick</button>
                </div>
                <div style={{ padding: 16, border: '1px dashed var(--accent-primary)', borderRadius: 12, marginTop: 12, background: 'var(--accent-glow)' }}>
                  <p style={{ fontSize: 13, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <LuZap size={14} /> Available: <strong>{currentSubnet?.counts?.free ?? '-'}</strong> addresses
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-4 mb-8">
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)' }}>
                  <LuShieldCheck size={22} />
                </div>
                <h3 style={{ margin: 0 }}>Identity & Ownership</h3>
              </div>
              <div className="flex-col gap-4">
                <div><label>Hostname</label><input className="form-input" value={formData.hostname} onChange={e => setFormData({...formData, hostname: e.target.value})} placeholder="SRV-PROD-WEB-01" /></div>
                <div><label>FQDN</label><input className="form-input" value={formData.fqdn} onChange={e => setFormData({...formData, fqdn: e.target.value})} placeholder="srv-web.corp.local" /></div>
                <div><label>Owner / Team</label><input className="form-input" value={formData.owner} onChange={e => setFormData({...formData, owner: e.target.value})} placeholder="Platform Engineering" /></div>
                <div><label>Service / Application</label><input className="form-input" value={formData.service} onChange={e => setFormData({...formData, service: e.target.value})} placeholder="Core API Service" /></div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-4 mb-8">
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                  <LuCheck size={22} />
                </div>
                <h3 style={{ margin: 0 }}>Final Review</h3>
              </div>
              <div className="glass-panel" style={{ padding: 24, background: 'rgba(255,255,255,0.03)' }}>
                <div className="flex-col gap-4">
                  <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>IP Address</span><span style={{ fontWeight: 700, color: 'var(--accent-primary)' }}>{formData.address}</span></div>
                  <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Hostname</span><span>{formData.hostname}</span></div>
                  <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>FQDN</span><span>{formData.fqdn}</span></div>
                  <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Owner</span><span>{formData.owner}</span></div>
                  <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Environment</span><span>{(environments.find(e => e.id === formData.environment) || {}).name || currentSubnet?.environment || 'Unassigned'}</span></div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '32px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: 12, background: 'var(--bg-secondary)' }}>
          {step > 1 && <button className="btn-outline" style={{ flex: 1, height: 48, borderRadius: 12, fontWeight: 700 }} onClick={() => setStep(step - 1)}>Back</button>}
          {step < 4 ? (
            <button className="btn-primary" style={{ flex: 1, height: 48, borderRadius: 12, background: 'var(--accent-primary)', color: 'white', fontWeight: 700, border: 'none' }} onClick={() => setStep(step + 1)}>Continue</button>
          ) : (
            <button className="btn-primary" style={{ flex: 2, height: 48, borderRadius: 12, background: 'var(--accent-primary)', color: 'white', fontWeight: 700, border: 'none' }} onClick={() => handleAssign()} disabled={loading}>{loading ? 'Deploying...' : 'Confirm Assignment'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// COMPONENT: IPAM (Main)
// ==========================================
const STATUS_COLORS = { 
  free: { bg: 'rgba(107, 114, 128, 0.1)', text: 'var(--text-muted)', label: 'Free' }, 
  used: { bg: 'rgba(16, 185, 129, 0.15)', text: 'var(--success)', label: 'Used' }, 
  vip: { bg: 'rgba(168, 85, 247, 0.15)', text: '#c084fc', label: 'VIP' },
  reserved: { bg: 'rgba(245, 158, 11, 0.15)', text: 'var(--warning)', label: 'Reserved' }, 
  conflict: { bg: 'rgba(239, 68, 68, 0.15)', text: 'var(--danger)', label: 'Conflict' }, 
  static: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa', label: 'Static' }
};
// unknown / missing status renders like free instead of crashing the table
const statusStyle = (status) => STATUS_COLORS[status] || STATUS_COLORS.free;

export default function IPAM() {
  const { showToast } = useToast();
  const sessionUser = JSON.parse(localStorage.getItem('user') || '{}');
  const role = sessionUser.role || 'Viewer';
  const [subnets, setSubnets] = useState([]);
  const [selectedSubnet, setSelectedSubnet] = useState(null);
  const [viewMode, setViewMode] = useState('table');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAddSubnet, setShowAddSubnet] = useState(false);
  const [showAssignment, setShowAssignment] = useState(false);
  const [assignmentData, setAssignmentData] = useState(null);
  // envId '' = the isDefault environment (resolved by the backend)
  const [newSubnet, setNewSubnet] = useState({ name: '', cidr: '192.168.1.0/24', vlan: '', envId: '' });
  const [environments, setEnvironments] = useState([]);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Production environments start expanded (isProduction flag, not a hard-coded name)
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [editingSubnet, setEditingSubnet] = useState(null);
  const [expandedSubnetId, setExpandedSubnetId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [confirmModal, setConfirmModal] = useState({ show: false, message: '', action: null });
  // typed confirmation (SuperAdmin delete of a subnet with IPs in use)
  const [confirmText, setConfirmText] = useState('');
  // the list holds summaries (no ips); the selected subnet's IPs come from GET /ipam/subnets/:id
  const [subnetDetail, setSubnetDetail] = useState(null);
  const [sharedModalHost, setSharedModalHost] = useState(null);
  const [integrationSummary, setIntegrationSummary] = useState({});

  const handleIpClick = async (ipObj) => {
    const _s = integrationSummary[String(ipObj.address).trim()];
    try {
      const res = await api.get('/integration/check?ip=' + ipObj.address);
      const hostObj = res.data.monitor || {
          ip: ipObj.address,
          name: res.data.inventory?.hostname || res.data.ipam?.hostname || ipObj.hostname || ipObj.address,
          os: res.data.inventory?.os || 'unknown',
          status: res.data.inventory?.status || 'unknown',
          group: res.data.ipam?.subnetName || 'N/A',
          lastSeen: res.data.inventory?.lastSeen || new Date().toISOString(),
          reportInterval: 0,
          tags: [],
          lastMetric: null
      };
      setSharedModalHost(hostObj);
    } catch (err) {}
  };
  const pageSize = 100;

  useEffect(() => {
    fetchSubnets();
    fetchEnvironments();
    fetchIntegrationSummary();
  }, []);

  const fetchIntegrationSummary = async () => {
    try {
      const res = await api.get('/integration/summary');
      setIntegrationSummary(res.data);
    } catch (e) {}
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [search, selectedSubnet?.id, viewMode]);

  const fetchEnvironments = async () => {
    try {
      const res = await api.get('/environments');
      const envs = normalizeEnvs(res.data);
      setEnvironments(envs);
      setExpandedGroups(prev => new Set([...prev, ...envs.filter(e => e.isProduction).map(e => e.name)]));
    } catch (e) {}
  };

  const openEnvironmentSettings = () => {
    try { sessionStorage.setItem('somp.settings.category', 'environments'); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('somp:navigate', { detail: { view: 'SYS_SETTINGS' } }));
  };

  const fetchSubnets = async () => {
    setIsRefreshing(true);
    try {
      const res = await api.get('/ipam/subnets');
      setSubnets(res.data);
      if (res.data.length > 0 && !selectedSubnet) setSelectedSubnet(res.data[0]);
      else if (selectedSubnet) {
        // keep the selection on the fresh summary (counts / name), or drop it when the subnet is gone
        setSelectedSubnet(res.data.find(s => s.id === selectedSubnet.id) || null);
      }
    } catch (e) {
    } finally {
      setIsRefreshing(false);
      setLoading(false);
    }
  };

  // fetchedAt: when the detail was loaded (reservation badges compare against it, not a clock read during render)
  const fetchSubnetDetail = (id) => {
    if (!id) return Promise.resolve();
    return api.get(`/ipam/subnets/${id}`)
      .then(res => setSubnetDetail({ ...res.data, fetchedAt: Date.now() }))
      .catch(() => setSubnetDetail(null));
  };

  const selectedId = selectedSubnet?.id;
  useEffect(() => {
    if (!selectedId) return;
    api.get(`/ipam/subnets/${selectedId}`)
      .then(res => setSubnetDetail({ ...res.data, fetchedAt: Date.now() }))
      .catch(() => setSubnetDetail(null));
  }, [selectedId]);

  const handleAssignmentComplete = () => {
    fetchSubnets();
    fetchSubnetDetail(selectedSubnet?.id);
    setShowAssignment(false);
  };

  const handleAddSubnet = async () => {
    if (!newSubnet.name || !newSubnet.cidr) return;
    try {
      const res = await api.post('/ipam/subnets', newSubnet);
      if (res.data?.cidrNormalizedFrom) showToast(`CIDR 已正規化為網路位址：${res.data.cidrNormalizedFrom} → ${res.data.cidr}`, 'info');
      setShowAddSubnet(false);
      setNewSubnet({ name: '', cidr: '192.168.1.0/24', vlan: '', envId: '' });
      fetchSubnets();
    } catch (e) {
      setError(e.response?.data?.error || 'System error');
      showToast(e.response?.data?.error || 'System error', 'error');
    }
  };

  // Only the editable fields: the IP list and the CIDR are never sent (the backend ignores them anyway)
  const handleUpdateSubnet = async () => {
    if (!editingSubnet.name) return;
    const reserved = String(editingSubnet.reservedText ?? (editingSubnet.reserved || []).join(', '))
      .split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    try {
      await api.put(`/ipam/subnets/${editingSubnet.id}`, {
        name: editingSubnet.name,
        vlan: editingSubnet.vlan || '',
        ...(editingSubnet.envId ? { envId: editingSubnet.envId } : { environment: editingSubnet.environment }),
        gateway: (editingSubnet.gateway || '').trim(),
        reserved
      });
      setEditingSubnet(null);
      fetchSubnets();
      fetchSubnetDetail(selectedSubnet?.id);
    } catch (e) {
      setError(e.response?.data?.error || 'System error');
      showToast(e.response?.data?.error || 'System error', 'error');
    }
  };

  const doDeleteSubnet = async (subnet, confirmCidr) => {
    try {
      await api.delete(`/ipam/subnets/${subnet.id}`, confirmCidr ? { data: { confirmCidr } } : undefined);
      if (selectedSubnet?.id === subnet.id) setSelectedSubnet(null);
      setEditingSubnet(null);
      fetchSubnets();
      setConfirmModal({ show: false });
    } catch (e) {
      const msg = e.response?.data?.error || 'Failed to delete subnet';
      if (e.response?.status === 400 && role === 'SuperAdmin' && !confirmCidr) {
        // the backend found IPs in use: ask for the typed CIDR
        requestDeleteSubnet(subnet, true);
        return;
      }
      showToast(msg, 'error');
      setConfirmModal({ show: false });
    }
  };

  const requestDeleteSubnet = (subnet, forceTyped = false) => {
    const inUse = subnet.counts ? subnet.counts.total - subnet.counts.free : 0;
    const typed = forceTyped || inUse > 0;
    if (typed && role !== 'SuperAdmin') {
      showToast(`此子網路有 ${inUse} 個使用中的 IP，只有 SuperAdmin 可以刪除`, 'error');
      return;
    }
    setConfirmText('');
    setConfirmModal({
      show: true,
      title: 'Delete Subnet',
      message: typed
        ? `此子網路有使用中的 IP。刪除後所有 IP 資料將一併移除，請輸入 ${subnet.cidr} 以確認。`
        : 'Are you sure you want to delete this subnet and all its IP data?',
      requireText: typed ? subnet.cidr : null,
      onConfirm: (text) => doDeleteSubnet(subnet, typed ? text : undefined)
    });
  };

  const toggleGroup = (env) => {
    const next = new Set(expandedGroups);
    if (next.has(env)) next.delete(env);
    else next.add(env);
    setExpandedGroups(next);
  };

  // from the summary counts (the list carries no ips)
  const calculateUtilization = (subnet) => {
    const c = subnet.counts;
    if (!c || !c.total) return 0;
    return Math.round(((c.total - c.free) / c.total) * 100);
  };

  const groupedSubnets = [...subnets].sort((a, b) => {
    const ipToNum = (ip) => (ip || '0.0.0.0').split('.').reduce((acc, oct) => (acc * 256) + parseInt(oct || 0, 10), 0);
    return ipToNum((a.cidr || '').split('/')[0]) - ipToNum((b.cidr || '').split('/')[0]);
  }).reduce((acc, s) => {
    const env = s.environment || 'Other';
    if (!acc[env]) acc[env] = [];
    acc[env].push(s);
    return acc;
  }, {});

  const detailIps = subnetDetail && subnetDetail.id === selectedSubnet?.id ? subnetDetail.ips : null;
  const filteredIPs = detailIps?.filter(ip =>
    ip.address.includes(search) || 
    (ip.hostname || '').toLowerCase().includes(search.toLowerCase()) ||
    (ip.service || '').toLowerCase().includes(search.toLowerCase())
  ) || [];

  const totalRecords = filteredIPs.length;
  const totalPages = Math.ceil(totalRecords / pageSize) || 1;
  const paginatedIPs = filteredIPs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  if (loading) return (
    <div className="flex-col items-center justify-center h-full gap-4">
      <LuActivity className="animate-spin text-accent-primary" size={32} />
      <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>Initializing Inventory...</span>
    </div>
  );

  return (
    <div className="animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Page Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="page-title">IP Inventory</h1>
          <p className="page-subtitle">Unified address space management and subnet analytics</p>
        </div>
        <div className="flex gap-3 items-center">
          {role !== 'Viewer' && (
            <>
              {role === 'SuperAdmin' && (
                <button 
                  className="btn-outline" 
                  style={{ 
                    borderRadius: 22, height: 44, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 8, 
                    borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontWeight: 700, fontSize: 14, background: 'none'
                  }} 
                  onClick={openEnvironmentSettings}
                  title="Environments are managed in Settings"
                >
                  <LuSettings size={18} /> Manage environments &rarr;
                </button>
              )}
              <button 
                className="btn-outline" 
                style={{ 
                  borderRadius: 22, height: 44, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 8, 
                  borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontWeight: 700, fontSize: 14, background: 'none'
                }} 
                onClick={() => setShowAssignment(true)}
              >
                <LuZap size={18} /> IP Assign
              </button>
              <button 
                className="btn-primary" 
                style={{ 
                  borderRadius: 22, height: 44, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 8,
                  background: 'var(--accent-primary)', color: 'white', fontWeight: 700, fontSize: 14, border: 'none',
                  boxShadow: '0 4px 12px var(--accent-glow)'
                }} 
                onClick={() => setShowAddSubnet(true)}
              >
                <LuPlus size={18} /> New Subnet
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-8 flex-1 min-height-0">
        {/* Sidebar: Subnet Tree */}
        <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="glass-panel" style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {Object.entries(groupedSubnets).map(([env, envSubnets]) => (
              <div key={env} className="mb-4">
                <div 
                  onClick={() => toggleGroup(env)}
                  className="flex items-center gap-3 mb-3"
                  style={{ 
                    fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', 
                    textTransform: 'uppercase', cursor: 'pointer', padding: '8px 4px',
                    letterSpacing: '0.02em'
                  }}
                >
                  {expandedGroups.has(env) ? <LuChevronDown size={18} /> : <LuChevronRight size={18} />}
                  {env} ({envSubnets.length})
                </div>
                {expandedGroups.has(env) && (
                  <div className="flex-col gap-2 pl-2">
                    {envSubnets.map(s => {
                      const util = calculateUtilization(s);
                      const isSelected = selectedSubnet?.id === s.id;
                      const isHighDensity = envSubnets.length > 10;
                      const isExpanded = expandedSubnetId === s.id;
                      
                      return (
                        <div 
                          key={s.id} 
                          onClick={() => {
                            setSelectedSubnet(s);
                            if (isHighDensity) setExpandedSubnetId(isExpanded ? null : s.id);
                          }}
                          className="glass-panel"
                          style={{ 
                            padding: isHighDensity && !isExpanded ? '12px 16px' : '16px 20px', 
                            cursor: 'pointer', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            background: 'var(--accent-primary)',
                            borderColor: isSelected ? 'white' : 'transparent',
                            borderWidth: isSelected ? 2 : 1,
                            color: 'white',
                            borderRadius: 16,
                            marginBottom: 8,
                            position: 'relative',
                            overflow: 'hidden'
                          }}
                        >
                          <div className="flex justify-between items-center">
                            <span style={{ fontSize: isHighDensity && !isExpanded ? 15 : 18, fontWeight: 700 }}>{s.name}</span>
                            <div className="flex items-center gap-4">
                              {( !isHighDensity || isExpanded ) && <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.9 }}>Vlan {s.vlan || '-'}</span>}
                              {role !== 'Viewer' && (
                                <button 
                                  style={{ background: 'none', border: 'none', color: 'white', padding: 0, cursor: 'pointer', display: 'flex', opacity: 0.8, marginLeft: 4 }}
                                  onClick={(e) => { e.stopPropagation(); setEditingSubnet(s); }}
                                >
                                  <LuPen size={16} />
                                </button>
                              )}
                            </div>
                          </div>
                          <p style={{ fontSize: 13, margin: isHighDensity && !isExpanded ? '2px 0 0' : '0 0 16px 0', opacity: 0.9, fontWeight: 500 }}>{s.cidr}{s.truncated && <span title={`僅前 ${s.counts?.total} 個 IP 已建立，其餘 IP 於同步或手動設定時自動建立`} style={{ fontSize: 11, marginLeft: 8, opacity: 0.85 }}>({s.counts?.total} / {s.hostCount} 已建立)</span>}</p>
                          
                          {( !isHighDensity || isExpanded ) && (
                            <div className="animate-fade-in">
                              <div className="flex justify-between" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.9 }}>
                                <span>Utilization</span>
                                <span>{util}%</span>
                              </div>
                              <div style={{ height: 4, background: 'rgba(0,0,0,0.2)', borderRadius: 2 }}>
                                <div style={{ 
                                  width: `${util}%`, height: '100%', borderRadius: 2,
                                  background: 'var(--accent-text)'
                                }} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

                {/* Main: IP Inventory */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {selectedSubnet ? (
            <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: 16, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <LuSearch size={18} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input 
                    type="text" className="form-input" placeholder="Search IP address, Hostname or Service..." 
                    style={{ paddingLeft: 48, margin: 0 }} value={search} onChange={e => setSearch(e.target.value)} 
                  />
                </div>
                <div className="flex" style={{ background: 'var(--bg-tertiary)', borderRadius: 10, padding: 4 }}>
                  <button 
                    onClick={() => setViewMode('table')}
                    style={{ 
                      padding: '8px 16px', borderRadius: 8, border: 'none', 
                      background: viewMode === 'table' ? 'var(--bg-primary)' : 'transparent',
                      color: viewMode === 'table' ? 'var(--accent-primary)' : 'var(--text-muted)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600
                    }}
                  >
                    <LuList size={16} /> Table
                  </button>
                  <button 
                    onClick={() => setViewMode('grid')}
                    style={{ 
                      padding: '8px 16px', borderRadius: 8, border: 'none', 
                      background: viewMode === 'grid' ? 'var(--bg-primary)' : 'transparent',
                      color: viewMode === 'grid' ? 'var(--accent-primary)' : 'var(--text-muted)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600
                    }}
                  >
                    <LuGrid3X3 size={16} /> Grid
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
                {viewMode === 'table' ? (
                  <table style={{ borderCollapse: 'separate', borderSpacing: '0 8px' }}>
                    <thead>
                      <tr>
                        <th style={{ border: 'none' }}>IP ADDRESS</th>
                        <th style={{ border: 'none' }}>STATUS</th>
                        <th style={{ border: 'none' }}>HOSTNAME / FQDN</th>
                        <th style={{ border: 'none' }}>OWNER / SERVICE</th>
                        <th style={{ border: 'none' }}>UPDATED AT</th>
                        <th style={{ border: 'none' }}></th>
                      </tr>
                    </thead>
                      <tbody>
                        {paginatedIPs.map(ip => {
                          const _ss = integrationSummary[String(ip.address).trim()];
                          const hasBoth = [_ss?.hasMonitor, _ss?.hasInventory, _ss?.hasIpam].filter(Boolean).length >= 2;
                          return (
                          <tr key={ip.address} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 12 }}>
                            <td 
                              style={{ 
                                padding: '16px 20px', border: 'none', fontWeight: 800, 
                                color: hasBoth ? 'var(--accent-primary)' : 'inherit', 
                                cursor: hasBoth ? 'pointer' : 'default',
                                textDecoration: hasBoth ? 'underline' : 'none'
                              }} 
                              onClick={() => hasBoth && handleIpClick(ip)}
                            >
                              {ip.address}
                            </td>
                            <td style={{ padding: '16px 20px', border: 'none' }}>
                            <span style={{ 
                              fontSize: 10, fontWeight: 800, padding: '4px 10px', borderRadius: 6,
                              background: statusStyle(ip.status).bg, color: statusStyle(ip.status).text,
                              textTransform: 'uppercase', letterSpacing: '0.05em'
                            }}>{statusStyle(ip.status).label}</span>
                            {ip.reservedUntil && new Date(ip.reservedUntil).getTime() > (subnetDetail?.fetchedAt || 0) && (
                              <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 4 }} title={`保留者：${ip.reservedBy || '-'}`}>
                                保留至 {new Date(ip.reservedUntil).toLocaleTimeString()}
                              </div>
                            )}
                            </td>
                            <td style={{ padding: '16px 20px', border: 'none', maxWidth: 200 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={ip.hostname || ''}>{ip.hostname || '-'}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={ip.fqdn || ''}>{ip.fqdn || '-'}</div>
                            </td>
                            <td style={{ padding: '16px 20px', border: 'none' }}>
                              <div style={{ fontSize: 13, fontWeight: 700 }}>{ip.assignedTo || '-'}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ip.service || '-'}</div>
                            </td>
                            <td style={{ padding: '16px 20px', border: 'none', fontSize: 12, color: 'var(--text-muted)' }}>{ip.updatedAt ? new Date(ip.updatedAt).toLocaleDateString() : '-'}</td>
                            <td style={{ padding: '16px 20px', border: 'none', textAlign: 'right' }}>
                              {role !== 'Viewer' && <button className="btn-outline" style={{ padding: 6, borderRadius: '50%' }} onClick={() => { setAssignmentData({ ...ip, subnetId: selectedSubnet.id }); setShowAssignment(true); }}><LuChevronRight size={16} /></button>}
                            </td>
                          </tr>
                        )})}
                      </tbody>
                  </table>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(16, 1fr)', gap: 8, padding: 24, background: 'var(--bg-secondary)', borderRadius: 16 }}>
                      {filteredIPs.map(ip => {
                        const _sg = integrationSummary[String(ip.address).trim()];
                        const hasBoth = [_sg?.hasMonitor, _sg?.hasInventory, _sg?.hasIpam].filter(Boolean).length >= 2;
                        return (
                        <div 
                          key={ip.address} 
                          onClick={() => {
                            if (hasBoth) {
                              handleIpClick(ip);
                            } else if (role !== 'Viewer') {
                              setAssignmentData({ ...ip, subnetId: selectedSubnet.id }); setShowAssignment(true);
                            }
                          }}
                          title={`${ip.address}\nHostname: ${ip.hostname || '-'}\nFQDN: ${ip.fqdn || '-'}\nStatus: ${(ip.status || 'free').toUpperCase()}\nOwner: ${ip.assignedTo || '-'}\nService: ${ip.service || '-'}`}
                          style={{
                            aspectRatio: '1', borderRadius: 6, cursor: 'pointer',
                            background: statusStyle(ip.status).bg,
                            border: hasBoth ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 800, color: statusStyle(ip.status).text
                          }}
                        >
                          {ip.address.split('.').pop()}
                        </div>
                      )})}
                    </div>
                )}
              </div>
              
              {/* Pagination Controls */}
              {viewMode === 'table' && totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '16px 24px', borderTop: '1px solid var(--border-color)', gap: 16, background: 'var(--bg-tertiary)' }}>
                  <button 
                    className="btn-outline" 
                    disabled={currentPage === 1} 
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    style={{ padding: '6px 12px', borderRadius: 8, color: 'var(--text-primary)', opacity: currentPage === 1 ? 0.5 : 1, cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Page {currentPage} of {totalPages} ({totalRecords} total IPs)
                  </span>
                  <button 
                    className="btn-outline" 
                    disabled={currentPage === totalPages} 
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    style={{ padding: '6px 12px', borderRadius: 8, color: 'var(--text-primary)', opacity: currentPage === totalPages ? 0.5 : 1, cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="glass-panel flex-col items-center justify-center h-full opacity-30">
              <LuActivity size={64} className="mb-4" />
              <p>Select a subnet to audit address space</p>
            </div>
          )}
        </div>
      </div>

      <AssignmentDrawer 
        isOpen={showAssignment} 
        onClose={() => setShowAssignment(false)} 
        subnets={subnets} 
        onComplete={handleAssignmentComplete} 
        initialData={assignmentData}
        role={role}
      />

      <HostDetailModal isOpen={!!sharedModalHost} onClose={() => setSharedModalHost(null)} initialHost={sharedModalHost} />

      {showAddSubnet && (
        <div className="modal-overlay" onClick={() => setShowAddSubnet(false)}>
          <div className="glass-panel animate-scale-in" onClick={e => e.stopPropagation()} style={{ width: 400, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '24px', background: 'var(--accent-primary)', color: 'var(--accent-text)' }}>
              <div className="flex justify-between items-center">
                <h2 style={{ margin: 0, fontSize: 18 }}>New Network Subnet</h2>
                <button onClick={() => setShowAddSubnet(false)} style={{ background: 'none', border: 'none', color: 'var(--accent-text)', cursor: 'pointer' }}><LuX size={20} /></button>
              </div>
            </div>
            <div style={{ padding: '24px' }}>
              <div className="flex-col gap-4">
                <div><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Name / Label</label><input className="form-input" value={newSubnet.name} onChange={e => setNewSubnet({...newSubnet, name: e.target.value})} placeholder="e.g. DMZ Service Network" /></div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Network Address & Mask</label>
                  <div className="flex gap-2">
                    <input 
                      className="form-input" 
                      style={{ flex: 2 }}
                      value={(newSubnet.cidr || '').split('/')[0] || ''} 
                      onChange={e => setNewSubnet({...newSubnet, cidr: `${e.target.value}/${(newSubnet.cidr || '/24').split('/')[1] || '24'}`})} 
                      placeholder="10.0.10.0" 
                    />
                    <select 
                      className="form-input" 
                      style={{ flex: 1 }}
                      value={`/${(newSubnet.cidr || '/24').split('/')[1] || '24'}`} 
                      onChange={e => setNewSubnet({...newSubnet, cidr: `${(newSubnet.cidr || '').split('/')[0] || ''}${e.target.value}`})}
                    >
                      {/* new subnets: /20 (4094 hosts) to /30 */}
                      {[...Array(11)].map((_, i) => <option key={i+20} value={`/${i+20}`}>/{i+20}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div style={{ flex: 1 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>VLAN ID</label><input className="form-input" value={newSubnet.vlan} onChange={e => setNewSubnet({...newSubnet, vlan: e.target.value})} placeholder="100" /></div>
                  <div style={{ flex: 2 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Environment</label>
                    <div className="flex gap-2">
                      <select className="form-input" style={{ flex: 1 }} value={newSubnet.envId} onChange={e => setNewSubnet({...newSubnet, envId: e.target.value})}>
                        <option value="">Default ({(defaultEnv(environments) || {}).name || '-'})</option>
                        {environments.map(env => (<option key={env.id} value={env.id}>{env.name}{env.isProduction ? ' (production)' : ''}</option>))}
                      </select>
                    </div>
                  </div>
                </div>
                <button className="btn-primary w-full mt-4" style={{ height: 48, borderRadius: 12, background: 'var(--accent-primary)', color: 'white', fontWeight: 700, border: 'none', cursor: 'pointer' }} onClick={handleAddSubnet}>Provision Subnet</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingSubnet && (
        <div className="modal-overlay" onClick={() => setEditingSubnet(null)}>
          <div className="glass-panel animate-scale-in" onClick={e => e.stopPropagation()} style={{ width: 400, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '24px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-color)' }}>
              <div className="flex justify-between items-center">
                <h2 style={{ margin: 0, fontSize: 18, color: 'var(--header-text)' }}>Edit Subnet</h2>
                <button onClick={() => setEditingSubnet(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><LuX size={20} /></button>
              </div>
            </div>
            <div style={{ padding: '24px' }}>
              <div className="flex-col gap-4">
                <div><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Name / Label</label><input className="form-input" value={editingSubnet.name} onChange={e => setEditingSubnet({...editingSubnet, name: e.target.value})} /></div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Network Address & Mask</label>
                  {/* the CIDR of an existing subnet cannot change (its IPs depend on it) */}
                  <input className="form-input" value={editingSubnet.cidr || ''} disabled title="子網路建立後 CIDR 無法修改" />
                </div>
                <div className="flex gap-4">
                  <div style={{ flex: 1 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Gateway</label>
                    <input className="form-input" value={editingSubnet.gateway ?? ''} onChange={e => setEditingSubnet({...editingSubnet, gateway: e.target.value})} placeholder="空白 = 無閘道" />
                  </div>
                  <div style={{ flex: 2 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Reserved (IP / 範圍，逗號分隔)</label>
                    <input className="form-input" value={editingSubnet.reservedText ?? (editingSubnet.reserved || []).join(', ')} onChange={e => setEditingSubnet({...editingSubnet, reservedText: e.target.value})} placeholder="10.0.10.2, 10.0.10.200-10.0.10.250" />
                  </div>
                </div>
                <div className="flex gap-4">
                  <div style={{ flex: 1 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>VLAN ID</label><input className="form-input" value={editingSubnet.vlan || ''} onChange={e => setEditingSubnet({...editingSubnet, vlan: e.target.value})} /></div>
                  <div style={{ flex: 2 }}><label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Environment</label>
                    <select className="form-input" value={editingSubnet.envId || ''} onChange={e => {
                      const env = environments.find(x => x.id === e.target.value);
                      setEditingSubnet({...editingSubnet, envId: e.target.value, environment: env ? env.name : editingSubnet.environment});
                    }}>
                      <option value="" disabled>Unassigned{editingSubnet.envUnmapped ? ` (stored: ${editingSubnet.envUnmapped})` : ''}</option>
                      {environments.map(env => (<option key={env.id} value={env.id}>{env.name}</option>))}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 mt-4">
                  <button className="btn-primary" style={{ flex: 1, height: 48, borderRadius: 12, background: 'var(--accent-primary)', color: 'white', fontWeight: 700, border: 'none', cursor: 'pointer' }} onClick={handleUpdateSubnet}>Save Changes</button>
                  <button className="btn-outline" style={{ width: 48, height: 48, borderRadius: 12, color: 'var(--danger)', borderColor: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => requestDeleteSubnet(editingSubnet)}><LuTrash2 size={18} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal.show && (
        <div className="modal-overlay" onClick={() => setConfirmModal({ show: false })}>
          <div className="glass-panel animate-scale-in" onClick={e => e.stopPropagation()} style={{ width: 400, padding: 0, overflow: 'hidden', zIndex: 1000 }}>
            <div style={{ padding: '24px', background: 'var(--danger)', color: 'white' }}>
              <div className="flex items-center gap-3">
                <LuCircleAlert size={24} />
                <h2 style={{ margin: 0, fontSize: 18 }}>{confirmModal.title}</h2>
              </div>
            </div>
            <div style={{ padding: '24px' }}>
              <p style={{ margin: '0 0 24px 0', fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {confirmModal.message}
              </p>
              {confirmModal.requireText && (
                <input className="form-input" style={{ marginBottom: 24 }} value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={confirmModal.requireText} autoFocus />
              )}
              <div className="flex gap-3 justify-end">
                <button className="btn-outline" style={{ flex: 1, height: 44, borderRadius: 10, fontWeight: 600 }} onClick={() => setConfirmModal({ show: false })}>Cancel</button>
                <button
                  className="btn-primary"
                  style={{ flex: 1, height: 44, borderRadius: 10, background: 'var(--danger)', color: 'white', fontWeight: 600, border: 'none', opacity: confirmModal.requireText && confirmText.trim() !== confirmModal.requireText ? 0.5 : 1 }}
                  disabled={!!confirmModal.requireText && confirmText.trim() !== confirmModal.requireText}
                  onClick={() => confirmModal.onConfirm(confirmText.trim())}
                >Confirm Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
