import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState } from 'react';
import api from '../../api';
import { STATUS_BADGE, ActionBtn } from './Shared';
import UserDetailsModal from './UserDetailsModal';

export default function ADObjectSearch() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  const [searchType, setSearchType] = useState('User');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const [passwordResult, setPasswordResult] = useState(null);
  const [selectedSamForDetails, setSelectedSamForDetails] = useState(null);
  const [message, setMessage] = useState(null);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setMessage({ type: 'error', text: 'Please enter a search keyword.' });
      return;
    }
    setSearchLoading(true);
    setSearchResults([]);
    setMessage(null);
    try {
      const r = await api.post('/ad/search', { type: searchType, q: searchQuery });
      const sorted = (r.data.results || []).sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
      setSearchResults(sorted);
      if (sorted.length === 0) setMessage({ type: 'info', text: `No ${searchType.toLowerCase()}s found matching your query.` });
    } catch (e) {
      setMessage({ type: 'error', text: e.response?.data?.error || 'Search failed.' });
    } finally {
      setSearchLoading(false);
    }
  };

  const executeSearchAction = async (sam, action) => {
    setActionLoading(`${sam}_${action}`);
    setMessage(null);
    try {
      const res = await api.post('/ad/action', { sam, action });
      if (action === 'reset_password' && res.data.password) {
        setPasswordResult({ sam, password: res.data.password });
        setMessage({ type: 'success', text: `Password for ${sam} reset successfully.` });
      } else {
        setMessage({ type: 'success', text: `${action.replace('_', ' ')} for ${sam} completed successfully.` });
      }
      handleSearch();
    } catch (e) {
      setMessage({ type: 'error', text: e.response?.data?.error || `Action failed for ${sam}.` });
    } finally {
      setActionLoading('');
      setConfirmAction(null);
    }
  };

  const isLoading = (sam, action) => actionLoading === `${sam}_${action}`;

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    executeSearchAction(confirmAction.sam, confirmAction.action);
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
    <div className="glass-panel animate-fade-in" style={{ padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
      {message && (
        <div style={{ padding: '0.85rem 1.2rem', borderRadius: '10px', marginBottom: '1.2rem', fontSize: '0.9rem', fontWeight: 500, background: message.type === 'success' ? 'rgba(16,185,129,0.15)' : message.type === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.12)', border: `1px solid ${message.type === 'success' ? '#10b98144' : message.type === 'error' ? '#ef444444' : 'var(--border-color)'}`, color: message.type === 'success' ? '#10b981' : message.type === 'error' ? '#ef4444' : 'var(--text-primary)' }}>
          {message.type === 'success' ? '✅ ' : message.type === 'error' ? '❌ ' : 'ℹ️ '}{message.text}
        </div>
      )}

      <h3 style={{ fontSize: '16px', fontWeight: 900, margin: '0 0 16px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        🔍 Query Active Directory Objects
      </h3>
      
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Object Type:</label>
          <select value={searchType} onChange={e => { setSearchType(e.target.value); setSearchResults([]); }} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', cursor: 'pointer', minWidth: '160px', outline: 'none' }}>
            <option value="User">👤 User Accounts</option>
            <option value="Group">👥 Security Groups</option>
            <option value="Computer">🖥️ Domain Computers</option>
          </select>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '250px' }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Search Keyword:</label>
          <input type="text" placeholder={`Search ${searchType.toLowerCase()}s by name or account...`} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', outline: 'none' }} />
        </div>
        
        <button onClick={handleSearch} disabled={searchLoading} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: '24px', fontSize: '13px', fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', height: '40px', opacity: searchLoading ? 0.7 : 1 }}>
          {searchLoading ? '⏳ Querying...' : '🔍 Search AD'}
        </button>
      </div>

      {searchLoading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>Querying Active Directory Database...
        </div>
      )}

      {!searchLoading && searchResults.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <h4 style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', marginBottom: '12px', letterSpacing: '0.04em' }}>
            📊 QUERY MATRIX ({searchResults.length} matches found)
          </h4>
          
          {searchType === 'User' && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 90px 90px 2.2fr', padding: '1rem 1.2rem', background: 'rgba(59,130,246,0.05)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <span>Display Name</span><span>Account (SAM)</span><span>Description</span><span>Enabled</span><span>Locked</span><span>Actions</span>
              </div>
              {searchResults.map((u, idx) => {
                const isDisabled = !u.Enabled;
                const isLocked = u.LockedOut;
                return (
                  <div key={u.SamAccountName} style={{ borderBottom: idx < searchResults.length - 1 ? '1px solid var(--border-color)' : 'none', padding: '0.85rem 1.2rem', display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 90px 90px 2.2fr', alignItems: 'center', transition: 'background 0.2s' }}>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem' }}>{u.Name}</span>
                    <button onClick={() => setSelectedSamForDetails(u.SamAccountName)} style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontFamily: 'monospace', fontSize: '0.85rem', cursor: 'pointer', textDecoration: 'underline', padding: 0, textAlign: 'left' }}>{u.SamAccountName}</button>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.Description || '—'}</span>
                    <span><STATUS_BADGE ok={u.Enabled} trueLabel="Yes" falseLabel="No" /></span>
                    <span>{isLocked ? <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 700, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid #f59e0b44' }}>🔒 Locked</span> : <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>}</span>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {role !== 'Viewer' ? (
                        <>
                          {isDisabled && <ActionBtn icon="✅" label="Enable" color="green" loading={isLoading(u.SamAccountName, 'enable')} onClick={() => setConfirmAction({ sam: u.SamAccountName, action: 'enable', label: 'Enable Account' })} />}
                          {!isDisabled && <ActionBtn icon="🚫" label="Disable" color="red" loading={isLoading(u.SamAccountName, 'disable')} onClick={() => setConfirmAction({ sam: u.SamAccountName, action: 'disable', label: 'Disable Account' })} />}
                          {isLocked && <ActionBtn icon="🔓" label="Unlock" color="yellow" loading={isLoading(u.SamAccountName, 'unlock')} onClick={() => setConfirmAction({ sam: u.SamAccountName, action: 'unlock', label: 'Unlock Account' })} />}
                          <ActionBtn icon="🔑" label="Reset PWD" color="blue" loading={isLoading(u.SamAccountName, 'reset_password')} onClick={() => setConfirmAction({ sam: u.SamAccountName, action: 'reset_password', label: 'Reset Password to a Random Secure Password' })} />
                        </>
                      ) : (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Read Only</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {searchType === 'Group' && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 2.5fr', padding: '1rem 1.2rem', background: 'rgba(59,130,246,0.05)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <span>Group Display Name</span><span>SAM Account Name</span><span>Group Members</span>
              </div>
              {searchResults.map((g, idx) => (
                <div key={g.SamAccountName} style={{ borderBottom: idx < searchResults.length - 1 ? '1px solid var(--border-color)' : 'none', padding: '1rem 1.2rem', display: 'grid', gridTemplateColumns: '1.2fr 1fr 2.5fr', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem' }}>👥 {g.Name}</span>
                  <span style={{ color: 'var(--accent-primary)', fontFamily: 'monospace', fontSize: '0.85rem' }}>{g.SamAccountName}</span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {g.Members && g.Members.length > 0 ? (
                      g.Members.map((m, mIdx) => <span key={mIdx} style={{ display: 'inline-block', padding: '3px 8px', borderRadius: '6px', fontSize: '0.75rem', background: 'rgba(59,130,246,0.1)', color: 'var(--accent-primary)', border: '1px solid var(--border-color)' }}>👤 {m}</span>)
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}><em>No members or empty group</em></span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {searchType === 'Computer' && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '14px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 2.5fr', padding: '1rem 1.2rem', background: 'rgba(59,130,246,0.05)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <span>Computer Name</span><span>SAM Account Name</span><span>Active Directory OU Location Path</span>
              </div>
              {searchResults.map((c, idx) => (
                <div key={c.SamAccountName} style={{ borderBottom: idx < searchResults.length - 1 ? '1px solid var(--border-color)' : 'none', padding: '1rem 1.2rem', display: 'grid', gridTemplateColumns: '1.2fr 1fr 2.5fr', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem' }}>🖥️ {c.Name}</span>
                  <span style={{ color: 'var(--accent-primary)', fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.SamAccountName}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>📂 {c.OU}</span>
                </div>
              ))}
            </div>
          )}
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
              <button onClick={() => setPasswordResult(null)} style={{ padding: '0.65rem 1.5rem', borderRadius: '10px', border: 'none', background: 'var(--bg-primary)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 'bold' }}>Close</button>
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
