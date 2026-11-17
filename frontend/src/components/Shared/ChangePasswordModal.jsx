import React, { useState } from 'react';
import api from '../../api';
import { validatePassword } from '../SettingsGroup/localAccountsUtils';

const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'inherit', fontSize: 13 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, opacity: 0.8 };

// Lets a local (page-managed) account change its own password. Success signs the user out.
export default function ChangePasswordModal({ onClose, onSignOut }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const pwError = next ? validatePassword(next) : '';
    const mismatch = confirm && next !== confirm ? 'Passwords do not match.' : '';
    const canSubmit = !busy && current && next && confirm && !validatePassword(next) && next === confirm;

    const submit = async (e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setBusy(true);
        setError('');
        try {
            await api.put('/local-accounts/me/password', { currentPassword: current, newPassword: next });
            try { sessionStorage.setItem('somp.logoutReason', 'Password changed. Sign in with your new password.'); } catch { /* storage unavailable */ }
            onSignOut();
        } catch (err) {
            setError((err.response && err.response.data && err.response.data.error) || 'Could not change the password.');
            setBusy(false);
        }
    };

    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
            <form className="glass-panel" onSubmit={submit} onClick={e => e.stopPropagation()} style={{ width: 380, maxWidth: '90vw', padding: 24, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>Change password</h3>
                <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle} htmlFor="cp-current">Current password</label>
                    <input id="cp-current" type="password" autoComplete="current-password" style={inputStyle} value={current} onChange={e => setCurrent(e.target.value)} autoFocus />
                </div>
                <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle} htmlFor="cp-new">New password</label>
                    <input id="cp-new" type="password" autoComplete="new-password" style={inputStyle} value={next} onChange={e => setNext(e.target.value)} />
                    {pwError && <div style={{ color: 'var(--danger, #f87171)', fontSize: 12, marginTop: 4 }}>{pwError}</div>}
                </div>
                <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle} htmlFor="cp-confirm">Confirm new password</label>
                    <input id="cp-confirm" type="password" autoComplete="new-password" style={inputStyle} value={confirm} onChange={e => setConfirm(e.target.value)} />
                    {mismatch && <div style={{ color: 'var(--danger, #f87171)', fontSize: 12, marginTop: 4 }}>{mismatch}</div>}
                </div>
                {error && <div role="alert" style={{ color: 'var(--danger, #f87171)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busy ? 'Changing...' : 'Change password'}</button>
                </div>
            </form>
        </div>
    );
}
