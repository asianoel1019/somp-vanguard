import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { STATUS_BADGE, ActionBtn } from './Shared';
import UserDetailsModal from './UserDetailsModal';

export default function ADDirectoryBrowse() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  const [companies, setCompanies] = useState([]);
  const [grantCompanies, setGrantCompanies] = useState([]);
  const [category, setCategory] = useState('');
  const [buList, setBuList] = useState({});
  const [selectedBU, setSelectedBU] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [message, setMessage] = useState(null);
  const [mappingError, setMappingError] = useState(null);
  const [expandedUser, setExpandedUser] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [passwordResult, setPasswordResult] = useState(null);
  const [filterText, setFilterText] = useState('');
  const [selectedSamForDetails, setSelectedSamForDetails] = useState(null);

  useEffect(() => {
    api.get('/ad/mappings')
      .then(r => {
        const data = r.data;
        setCompanies(data.companies || []);
        setGrantCompanies(data.grantCompanies || []);
        setBuList(data);
        if (data.companies && data.companies.length > 0) {
          setCategory(data.companies[0]);
        }
      })
      .catch(e => {
        const msg = e.response?.data?.error || e.message || 'Unknown error';
        setMappingError(`Failed to load BU list: ${msg}`);
      });
  }, []);

  useEffect(() => {
    setSelectedBU('');
    setUsers([]);
    setExpandedUser(null);
    setMessage(null);
    setFilterText('');
  }, [category]);

  const loadUsers = useCallback(async (bu) => {
    if (!bu) return;
    setLoading(true);
    setUsers([]);
    setExpandedUser(null);
    setMessage(null);
    try {
      const r = await api.post('/ad/users', { category, bu });
      const sorted = (r.data.users || []).sort((a, b) => a.SamAccountName.localeCompare(b.SamAccountName));
      setUsers(sorted);
      if (sorted.length === 0) setMessage({ type: 'info', text: 'No users found in this OU.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.response?.data?.error || 'Failed to load users.' });
    } finally {
      setLoading(false);
    }
  }, [category]);

  const handleBUChange = (e) => {
    const bu = e.target.value;
    setSelectedBU(bu);
    setFilterText('');
    loadUsers(bu);
  };

  const executeAction = async (sam, action) => {
    setActionLoading(`${sam}_${action}`);
    setMessage(null);
    try {
      const res = await api.post('/ad/action', { category, bu: selectedBU, sam, action });
      if (action === 'reset_password' && res.data.password) {
        setPasswordResult({ sam, password: res.data.password });
        setMessage({ type: 'success', text: `Password for ${sam} reset successfully.` });
      } else {
        setMessage({ type: 'success', text: `${action.replace('_', ' ')} for ${sam} completed successfully.` });
      }
      await loadUsers(selectedBU);
    } catch (e) {
      setMessage({ type: 'error', text: e.response?.data?.error || `Action failed for ${sam}.` });
    } finally {
      setActionLoading('');
      setConfirmAction(null);
    }
  };

  const isLoading = (sam, action) => actionLoading === `${sam}_${action}`;
  const currentBUList = buList[category] || [];

  const filteredUsers = users.filter(u => {
    if (!filterText.trim()) return true;
    const q = filterText.toLowerCase();
    return (u.Name || '').toLowerCase().includes(q)
      || (u.SamAccountName || '').toLowerCase().includes(q)
      || (u.Description || '').toLowerCase().includes(q);
  });

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    executeAction(confirmAction.sam, confirmAction.action);
  };

  const copyPassword = (pwd) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(pwd).then(() => showToast('Password copied to clipboard!'));
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = pwd;
      textArea.style.position = 'fixed';
      textArea.style.left = '-99999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast('Password copied to clipboard!');
      } catch (err) {
        showToast('Failed to copy password.');
      }
      document.body.removeChild(textArea);
    }
  };

  return (
    <div className="animate-fade-in">
      {mappingError && (
        <div style={{ padding: '0.85rem 1.2rem', borderRadius: '10px', marginBottom: '1.2rem', fontSize: '0.88rem', background: 'rgba(239,68,68,0.15)', border: '1px solid #ef444444', color: '#ef4444' }}>
          ❌ {mappingError}
        </div>
      )}

      {message && (
        <div style={{ padding: '0.85rem 1.2rem', borderRadius: '10px', marginBottom: '1.2rem', fontSize: '0.9rem', fontWeight: 500, background: message.type === 'success' ? 'rgba(16,185,129,0.15)' : message.type === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.12)', border: `1px solid ${message.type === 'success' ? '#10b98144' : message.type === 'error' ? '#ef444444' : 'var(--border-color)'}`, color: message.type === 'success' ? '#10b981' : message.type === 'error' ? '#ef4444' : 'var(--text-primary)' }}>
          {message.type === 'success' ? '✅ ' : message.type === 'error' ? '❌ ' : 'ℹ️ '}{message.text}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {companies.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)} style={{ padding: '0.75rem 2.5rem', fontSize: '1rem', fontWeight: 700, borderRadius: '12px', cursor: 'pointer', border: '2px solid', borderColor: category === cat ? 'var(--accent-primary)' : 'var(--border-color)', background: category === cat ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.02)', color: category === cat ? 'var(--accent-primary)' : 'var(--text-secondary)', transition: 'all 0.25s', boxShadow: category === cat ? '0 0 15px var(--accent-glow)' : 'none' }}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <label style={{ color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Select BU:</label>
        <select value={selectedBU} onChange={handleBUChange} disabled={loading} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.55rem 1.2rem', fontSize: '0.9rem', cursor: 'pointer', minWidth: '200px', outline: 'none' }}>
          <option value="">-- Select BU --</option>
          {currentBUList.map(bu => <option key={bu} value={bu}>{bu}</option>)}
        </select>
        {selectedBU && (
          <button onClick={() => loadUsers(selectedBU)} disabled={loading} style={{ padding: '0.5rem 1.2rem', borderRadius: '8px', border: '2px solid var(--accent-primary)', background: 'var(--bg-secondary)', color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 700, fontSize: '0.85rem', boxShadow: '0 4px 10px var(--accent-glow)' }}>
            🔄 Refresh
          </button>
        )}
      </div>

      {users.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <input type="text" placeholder="🔍 Filter by Name, Account or Description..." value={filterText} onChange={e => setFilterText(e.target.value)} style={{ width: '100%', maxWidth: '450px', padding: '0.55rem 1rem', fontSize: '0.88rem', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '10px', outline: 'none' }} />
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>Querying Active Directory...
        </div>
      )}

      {!loading && filteredUsers.length > 0 && (
        <div style={{ background: 'var(--bg-secondary)', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 90px 90px 2.2fr', padding: '1rem 1.2rem', background: 'rgba(59,130,246,0.05)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            <span>Display Name</span><span>Account (SAM)</span><span>Description</span><span>Enabled</span><span>Locked</span><span>Actions</span>
          </div>
          {filteredUsers.map((u, idx) => {
            const isExpanded = expandedUser === u.SamAccountName;
            const isDisabled = !u.Enabled;
            const isLocked = u.LockedOut;
            return (
              <div key={u.SamAccountName} style={{ borderBottom: idx < filteredUsers.length - 1 ? '1px solid var(--border-color)' : 'none', background: isExpanded ? 'rgba(59,130,246,0.07)' : 'transparent', transition: 'background 0.2s' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 90px 90px 2.2fr', padding: '0.85rem 1.2rem', alignItems: 'center', cursor: 'pointer' }} onClick={() => setExpandedUser(isExpanded ? null : u.SamAccountName)}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem' }}>{u.Name}</span>
                  <button onClick={(e) => { e.stopPropagation(); setSelectedSamForDetails(u.SamAccountName); }} style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontFamily: 'monospace', fontSize: '0.85rem', cursor: 'pointer', textDecoration: 'underline', padding: 0, textAlign: 'left' }}>{u.SamAccountName}</button>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.Description || '—'}</span>
                  <span><STATUS_BADGE ok={u.Enabled} trueLabel="Yes" falseLabel="No" /></span>
                  <span>
                    {isLocked ? <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 700, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid #f59e0b44' }}>🔒 Locked</span> : <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>}
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {role !== 'Viewer' ? (
                      <>
                        {isDisabled && <ActionBtn icon="✅" label="Enable" color="green" loading={isLoading(u.SamAccountName, 'enable')} onClick={e => { e.stopPropagation(); setConfirmAction({ sam: u.SamAccountName, action: 'enable', label: 'Enable Account' }); }} />}
                        {!isDisabled && <ActionBtn icon="🚫" label="Disable" color="red" loading={isLoading(u.SamAccountName, 'disable')} onClick={e => { e.stopPropagation(); setConfirmAction({ sam: u.SamAccountName, action: 'disable', label: 'Disable Account' }); }} />}
                        {isLocked && <ActionBtn icon="🔓" label="Unlock" color="yellow" loading={isLoading(u.SamAccountName, 'unlock')} onClick={e => { e.stopPropagation(); setConfirmAction({ sam: u.SamAccountName, action: 'unlock', label: 'Unlock Account' }); }} />}
                        <ActionBtn icon="🔑" label="Reset PWD" color="blue" loading={isLoading(u.SamAccountName, 'reset_password')} onClick={e => { e.stopPropagation(); setConfirmAction({ sam: u.SamAccountName, action: 'reset_password', label: 'Reset Password to a Random Secure Password' }); }} />
                        {grantCompanies.includes(category) && <ActionBtn icon="🛡️" label={`Grant (_Guardian_${selectedBU})`} color="purple" loading={isLoading(u.SamAccountName, 'grant')} onClick={e => { e.stopPropagation(); setConfirmAction({ sam: u.SamAccountName, action: 'grant', label: `Grant Permission to _Guardian_${selectedBU}` }); }} />}
                      </>
                    ) : (
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Read Only</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && users.length > 0 && (
        <div style={{ marginTop: '1rem', color: 'var(--text-muted)', fontSize: '0.82rem', textAlign: 'right' }}>
          Showing {filteredUsers.length}{filterText ? ` of ${users.length}` : ''} user{filteredUsers.length !== 1 ? 's' : ''} in {category} / {selectedBU} &nbsp;&nbsp;|&nbsp;&nbsp;
          Enabled: {users.filter(u => u.Enabled).length} &nbsp; Locked: {users.filter(u => u.LockedOut).length}
        </div>
      )}

      {confirmAction && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', maxWidth: '420px', width: '90%', boxShadow: 'var(--shadow-lg)' }}>
            <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-primary)' }}>⚠️ Confirm Action</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              Are you sure you want to perform <strong style={{ color: '#f59e0b' }}>{confirmAction.label}</strong> on account <code style={{ color: 'var(--accent-primary)' }}>{confirmAction.sam}</code>?
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmAction(null)} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleConfirmAction} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer', fontWeight: 700 }}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {passwordResult && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', maxWidth: '420px', width: '90%', boxShadow: 'var(--shadow-lg)' }}>
            <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-primary)' }}>✅ Password Reset Successful</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
              The password for <code style={{ color: 'var(--accent-primary)', background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: '4px' }}>{passwordResult.sam}</code> has been reset.
            </p>
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border-color)' }}>
              <span style={{ fontFamily: 'monospace', fontSize: '1.2rem', color: '#10b981', fontWeight: 'bold' }}>{passwordResult.password}</span>
              <button 
                onClick={() => copyPassword(passwordResult.password)}
                style={{ background: 'var(--accent-primary)', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold' }}
              >
                Copy
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setPasswordResult(null)} style={{ padding: '0.65rem 1.5rem', borderRadius: '10px', border: 'none', background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600 }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {selectedSamForDetails && (
          <UserDetailsModal 
              samAccountName={selectedSamForDetails} 
              onClose={() => setSelectedSamForDetails(null)} 
          />
      )}
    </div>
  );
}
