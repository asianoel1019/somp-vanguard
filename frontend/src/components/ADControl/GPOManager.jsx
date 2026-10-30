import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect } from 'react';
import api from '../../api';
import { STATUS_BADGE, ActionBtn } from './Shared';

export default function GPOManager() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  
  const [gpos, setGpos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  
  const [nasPath, setNasPath] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [editingGpo, setEditingGpo] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [confirmModal, setConfirmModal] = useState({ show: false, message: '', action: null });

  // Security Policy Edit States
  const [regKey, setRegKey] = useState('HKCU\\Software\\Policies\\Microsoft');
  const [regValueName, setRegValueName] = useState('');
  const [regType, setRegType] = useState('String');
  const [regValue, setRegValue] = useState('');
  const [existingSettings, setExistingSettings] = useState([]);
  const [loadingSettings, setLoadingSettings] = useState(false);

  const loadGPOs = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await api.get('/gpo/list');
      setGpos(res.data.gpos || []);
    } catch (e) {
      const errText = e.response?.data?.error || 'Failed to load GPOs.';
      if (errText.includes('RSAT_GPMC_MISSING') || errText.includes('GroupPolicy') || errText.includes('RSAT') || errText.includes('Get-GPO')) {
        setMessage({ type: 'error', text: 'RSAT-GPMC missing on remote AD Server. Please install Group Policy Management Console (Install-WindowsFeature RSAT-GPMC).' });
      } else {
        setMessage({ type: 'error', text: errText });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGPOs();
  }, []);

  const promptConfirm = (message, action) => {
    setConfirmModal({ show: true, message, action });
  };

  const executeConfirm = () => {
    if (confirmModal.action) confirmModal.action();
    setConfirmModal({ show: false, message: '', action: null });
  };

  const handleBackup = async (guid, name) => {
    promptConfirm(`Backup GPO '${name}'?`, async () => {
      setActionLoading(guid);
    setMessage(null);
    try {
      const payload = { guid, name };
      if (nasPath.trim()) payload.nasPath = nasPath.trim();
      const res = await api.post('/gpo/backup', payload);
      setMessage({ type: 'success', text: res.data.message });
    } catch (e) {
      const errText = e.response?.data?.error || 'Backup failed.';
      if (errText.includes('RSAT_GPMC_MISSING')) {
        setMessage({ type: 'error', text: 'RSAT-GPMC missing on remote AD Server. Please install Group Policy Management Console.' });
      } else {
        setMessage({ type: 'error', text: errText });
      }
    } finally {
      setActionLoading(false);
    }
    });
  };

  const handleStatusChange = async (guid, name, newStatus) => {
    promptConfirm(`Change status of '${name}' to ${newStatus}?`, async () => {
      setActionLoading(guid);
    setMessage(null);
    try {
      await api.post('/gpo/status', { guid, name, status: newStatus });
      setMessage({ type: 'success', text: `Status updated successfully.` });
      loadGPOs();
    } catch (e) {
      const errText = e.response?.data?.error || 'Failed to change status.';
      if (errText.includes('RSAT_GPMC_MISSING')) {
        setMessage({ type: 'error', text: 'RSAT-GPMC missing on remote AD Server. Please install Group Policy Management Console.' });
      } else {
        setMessage({ type: 'error', text: errText });
      }
    } finally {
      setActionLoading(false);
    }
    });
  };

  const openEditModal = async (gpo) => {
    setEditingGpo(gpo);
    setShowEditModal(true);
    setExistingSettings([]);
    setLoadingSettings(true);
    setRegKey('HKCU\\Software\\Policies\\Microsoft');
    setRegValueName('');
    setRegType('String');
    setRegValue('');
    try {
      const res = await api.get(`/gpo/registry-list?guid=${gpo.Id}`);
      setExistingSettings(res.data.settings || []);
    } catch (e) {
      console.error('Failed to load GPO registry settings:', e);
    } finally {
      setLoadingSettings(false);
    }
  };

  const saveSecurityPolicy = async (action = 'Set') => {
    if (!regKey) return showToast('Registry Key is required');
    setActionLoading('security');
    setMessage(null);
    try {
      await api.post('/gpo/security', {
        guid: editingGpo.Id,
        name: editingGpo.DisplayName,
        key: regKey,
        valueName: regValueName,
        type: regType,
        value: regValue,
        action
      });
      setMessage({ type: 'success', text: `Security policy ${action.toLowerCase()} successfully.` });
      setShowEditModal(false);
    } catch (e) {
      const errText = e.response?.data?.error || 'Policy edit failed.';
      if (errText.includes('RSAT_GPMC_MISSING')) {
        setMessage({ type: 'error', text: 'RSAT-GPMC missing on remote AD Server. Please install Group Policy Management Console.' });
      } else {
        setMessage({ type: 'error', text: errText });
      }
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
      {/* Header & NAS Settings */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <h3 style={{ fontSize: '16px', fontWeight: 900, margin: '0 0 8px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            🛡️ Group Policy (GPO) Manager
          </h3>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>Manage, edit, and backup Active Directory Group Policies securely.</p>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(0,0,0,0.2)', padding: '10px 16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 700 }}>💾 Backup Path:</span>
          <input 
            type="text" 
            placeholder="Default: Local System (C:\GPO_Backups)" 
            value={nasPath} 
            onChange={e => setNasPath(e.target.value)} 
            style={{ background: 'transparent', border: 'none', borderBottom: '1px solid var(--accent-primary)', color: 'var(--text-primary)', width: '250px', outline: 'none', fontSize: '12px' }}
          />
          <button 
            onClick={() => handleBackup('ALL', 'ALL GPOs')} 
            disabled={actionLoading === 'ALL'}
            style={{ padding: '4px 12px', borderRadius: '6px', background: 'var(--accent-primary)', color: 'white', border: 'none', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            {actionLoading === 'ALL' ? '⏳' : 'Backup ALL'}
          </button>
        </div>
      </div>

      {message && (
        <div style={{ padding: '0.85rem 1.2rem', borderRadius: '10px', marginBottom: '1.2rem', fontSize: '0.9rem', fontWeight: 500, background: message.type === 'success' ? 'rgba(16,185,129,0.15)' : message.type === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.12)', border: `1px solid ${message.type === 'success' ? '#10b98144' : message.type === 'error' ? '#ef444444' : 'var(--border-color)'}`, color: message.type === 'success' ? '#10b981' : message.type === 'error' ? '#ef4444' : 'var(--text-primary)' }}>
          {message.type === 'success' ? '✅ ' : message.type === 'error' ? '❌ ' : 'ℹ️ '}{message.text}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>Loading GPOs from Domain Controller...
        </div>
      ) : (
        <div style={{ background: 'var(--bg-secondary)', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr', padding: '1rem 1.2rem', background: 'rgba(59,130,246,0.05)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            <span>GPO Name</span><span>Status</span><span>Last Modified</span><span>Actions</span>
          </div>
          
          {gpos.length === 0 && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No GPOs found.</div>}
          
          {gpos.map((gpo, idx) => (
            <div key={gpo.Id} style={{ borderBottom: idx < gpos.length - 1 ? '1px solid var(--border-color)' : 'none', padding: '1rem 1.2rem', display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr', alignItems: 'center' }}>
              <div>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem' }}>{gpo.DisplayName}</div>
                <div style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '0.75rem', marginTop: '4px' }}>{gpo.Id}</div>
              </div>
              
              <div>
                <STATUS_BADGE 
                  ok={gpo.GpoStatus === 'AllSettingsEnabled'} 
                  trueLabel="Enabled" 
                  falseLabel={gpo.GpoStatus === 'AllSettingsDisabled' ? 'Disabled' : gpo.GpoStatus} 
                />
              </div>
              
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                {new Date(parseInt(gpo.ModificationTime.replace('/Date(', '').replace(')/', ''))).toLocaleString()}
              </div>
              
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {role !== 'Viewer' ? (
                  <>
                    <ActionBtn icon="✏️" label="Edit Security" color="blue" disabled={actionLoading} onClick={() => openEditModal(gpo)} />
                    <ActionBtn icon="💾" label="Backup" color="green" loading={actionLoading === gpo.Id} onClick={() => handleBackup(gpo.Id, gpo.DisplayName)} />
                    <select 
                      value={gpo.GpoStatus} 
                      onChange={e => handleStatusChange(gpo.Id, gpo.DisplayName, e.target.value)}
                      disabled={actionLoading === gpo.Id}
                      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11px', outline: 'none', cursor: 'pointer' }}
                    >
                      <option value="AllSettingsEnabled">Enable All</option>
                      <option value="AllSettingsDisabled">Disable All</option>
                      <option value="ComputerSettingsDisabled">Disable Computer Settings</option>
                      <option value="UserSettingsDisabled">Disable User Settings</option>
                    </select>
                  </>
                ) : (
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Read Only</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal.show && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', maxWidth: '400px', width: '90%', boxShadow: 'var(--shadow-lg)', textAlign: 'center' }}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--text-primary)' }}>Confirmation</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{confirmModal.message}</p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button onClick={() => setConfirmModal({ show: false, message: '', action: null })} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={executeConfirm} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: 'var(--accent-primary)', color: 'white', cursor: 'pointer', fontWeight: 700 }}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Security Modal */}
      {showEditModal && editingGpo && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', maxWidth: '500px', width: '90%', boxShadow: 'var(--shadow-lg)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.5rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              ✏️ Edit Security Policy
            </h3>
            <p style={{ color: 'var(--accent-primary)', fontSize: '13px', marginBottom: '1.5rem', fontWeight: 600 }}>Target: {editingGpo.DisplayName}</p>
            
            {/* Existing Registry Settings */}
            <div style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px', textAlign: 'left' }}>
                ⚙️ Configured Registry Settings in GPO:
              </label>
              {loadingSettings ? (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'left' }}>⏳ Reading GPO settings from Domain Controller...</div>
              ) : existingSettings.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'left' }}>No registry settings configured.</div>
              ) : (
                <div style={{ maxHeight: '120px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '6px', background: 'rgba(0,0,0,0.1)' }}>
                  {existingSettings.map((s, sIdx) => {
                    const fullPath = `${s.hive}\\${s.key}`;
                    return (
                      <div 
                        key={sIdx} 
                        onClick={async () => {
                          setRegKey(fullPath);
                          setRegValueName(s.valueName || '');
                          setRegType(s.type || 'String');
                          setRegValue(s.value || '');
                        }}
                        style={{ padding: '6px', borderRadius: '4px', cursor: 'pointer', borderBottom: sIdx < existingSettings.length - 1 ? '1px solid var(--border-color)' : 'none', fontSize: '11px', transition: 'background 0.2s', textAlign: 'left' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--border-color)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <strong style={{ color: 'var(--accent-primary)' }}>[{s.hive}]</strong> {s.key} <br />
                        <span style={{ color: 'var(--text-secondary)' }}>Name: <code>{s.valueName || '(Default)'}</code> | Val: <code>{s.value}</code> ({s.type})</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Registry Key (e.g. HKLM\\Software\\...)</label>
                <input type="text" value={regKey} onChange={e=>setRegKey(e.target.value)} style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Value Name (Optional)</label>
                <input type="text" value={regValueName} onChange={e=>setRegValueName(e.target.value)} style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px' }} />
              </div>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Type</label>
                  <select value={regType} onChange={e=>setRegType(e.target.value)} style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px' }}>
                    <option value="String">String (REG_SZ)</option>
                    <option value="ExpandString">ExpandString (REG_EXPAND_SZ)</option>
                    <option value="Binary">Binary (REG_BINARY)</option>
                    <option value="DWord">DWord (REG_DWORD)</option>
                    <option value="MultiString">MultiString (REG_MULTI_SZ)</option>
                    <option value="QWord">QWord (REG_QWORD)</option>
                  </select>
                </div>
                <div style={{ flex: 2 }}>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Value Data</label>
                  <input type="text" value={regValue} onChange={e=>setRegValue(e.target.value)} style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px' }} />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowEditModal(false)} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button disabled={actionLoading === 'security'} onClick={() => saveSecurityPolicy('Remove')} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{actionLoading==='security'?'...':'Remove Policy'}</button>
              <button disabled={actionLoading === 'security'} onClick={() => saveSecurityPolicy('Set')} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: 'var(--accent-primary)', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{actionLoading==='security'?'...':'Set Policy'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
