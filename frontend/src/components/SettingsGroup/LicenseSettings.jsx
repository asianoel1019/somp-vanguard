import React, { useEffect, useState } from 'react';
import { TbKey, TbLock, TbLockOpen, TbTrash, TbUpload } from 'react-icons/tb';
import api from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { PAID_FEATURE_INFO, LICENSE_EVENT, expiryTone } from '../../utils/licenseUtils.js';

const CHANNEL_NAMES = { telegram: 'Telegram notifications', email: 'Email notifications', webhook: 'Outbound webhooks' };
const TONE_COLOR = { danger: 'var(--danger, #ef4444)', warning: 'var(--warning)', normal: 'inherit' };
const announce = (state) => window.dispatchEvent(new CustomEvent(LICENSE_EVENT, { detail: state }));

// System Settings -> License (SuperAdmin): current edition, paid features, upload / remove the license file.
export default function LicenseSettings() {
    const { showConfirm } = useConfirm();
    const [state, setState] = useState(null);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null); // { type: 'error' | 'success', text }

    useEffect(() => {
        api.get('/license').then(res => setState(res.data)).catch(err => setMessage({ type: 'error', text: err.response?.data?.error || err.message }));
    }, []);

    const onFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 16 * 1024) { setMessage({ type: 'error', text: 'A license file is at most 16 KB.' }); return; }
        setText(await file.text());
    };

    const upload = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const res = await api.post('/license', { text });
            setState(res.data);
            setText('');
            announce(res.data);
            setMessage({ type: 'success', text: `License applied: ${res.data.licenseId} (${res.data.customer}).` });
        } catch (err) {
            setMessage({ type: 'error', text: err.response?.data?.error || err.message });
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!await showConfirm('Removing the license turns off the paid features, AD sign-in and outbound notifications right away (all data is kept). Remove the license?')) return;
        setBusy(true);
        setMessage(null);
        try {
            const res = await api.delete('/license');
            setState(res.data);
            announce(res.data);
            setMessage({ type: 'success', text: 'License removed. This is now the free edition.' });
        } catch (err) {
            setMessage({ type: 'error', text: err.response?.data?.error || err.message });
        } finally {
            setBusy(false);
        }
    };

    const paid = state && state.edition === 'paid';
    const tone = paid ? 'var(--success)' : 'var(--warning)';
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {message && (
                <div role={message.type === 'error' ? 'alert' : 'status'} style={{ padding: '10px 14px', borderRadius: 12, fontSize: 13, fontWeight: 600,
                    color: message.type === 'error' ? 'var(--danger)' : 'var(--success)', border: '1px solid currentColor', background: 'var(--bg-secondary)' }}>
                    {message.text}
                </div>
            )}

            <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, fontWeight: 800, color: tone, border: `1px solid ${tone}` }}>
                        <TbKey /> {state ? (paid ? 'Paid' : 'Free') : '…'}
                    </span>
                    {paid && <span style={{ fontWeight: 700 }}>Licensed to {state.customer}</span>}
                </div>
                {paid && (
                    <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
                        <span>License ID</span><span>{state.licenseId}</span>
                        <span>Issued</span><span>{state.issuedAt}</span>
                        {state.expiresAt && (
                            <>
                                <span>Expires</span>
                                <span>
                                    {state.expiresAt}
                                    {typeof state.daysLeft === 'number' && (
                                        <span style={{ marginLeft: 8, fontWeight: 700, color: TONE_COLOR[expiryTone(state.daysLeft)] }}>
                                            {state.daysLeft === 0 ? '(expires today)' : state.daysLeft === 1 ? '(1 day left)' : `(${state.daysLeft} days left)`}
                                        </span>
                                    )}
                                </span>
                            </>
                        )}
                    </div>
                )}
                {state && !paid && state.expiredAt && (
                    <div style={{ marginTop: 12, fontSize: 13, color: 'var(--warning)' }}>Expired on {state.expiredAt}. Upload a renewed license to restore the paid features.</div>
                )}
                {state && !paid && !state.expiredAt && state.reason && state.reason !== 'no license' && (
                    <div style={{ marginTop: 12, fontSize: 13, color: 'var(--warning)' }}>The stored license is not valid: {state.reason}</div>
                )}
            </div>

            <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Paid features</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                    {Object.entries(PAID_FEATURE_INFO).map(([key, info]) => {
                        const locked = state && Array.isArray(state.locked) && state.locked.includes(key);
                        return (
                            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                                {locked ? <TbLock style={{ color: 'var(--warning)' }} /> : <TbLockOpen style={{ color: 'var(--success)' }} />}
                                {info.name}
                            </div>
                        );
                    })}
                    {Object.entries(CHANNEL_NAMES).map(([key, name]) => {
                        const locked = state && Array.isArray(state.lockedChannels) && state.lockedChannels.includes(key);
                        return (
                            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                                {locked ? <TbLock style={{ color: 'var(--warning)' }} /> : <TbLockOpen style={{ color: 'var(--success)' }} />}
                                {name}
                            </div>
                        );
                    })}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        {paid ? <TbLockOpen style={{ color: 'var(--success)' }} /> : <TbLock style={{ color: 'var(--warning)' }} />}
                        AD sign-in and RBAC
                    </div>
                </div>
            </div>

            <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>{paid ? 'Replace license' : 'Upload license'}</h3>
                <textarea value={text} onChange={e => setText(e.target.value)} rows={8} placeholder="Paste the license file (.lic) contents, or choose a file"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 10, borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <label className="btn btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <TbUpload /> Choose file
                        <input type="file" accept=".lic,.json,.txt" onChange={onFile} style={{ display: 'none' }} />
                    </label>
                    <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={upload}>Apply license</button>
                    {paid && (
                        <button type="button" className="btn btn-danger" disabled={busy} onClick={remove} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                            <TbTrash /> Remove license
                        </button>
                    )}
                </div>
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    Before an upgrade, you can put the license file (any name ending in <code>.lic</code>) in the data directory: at startup the service applies the newest valid one by issue date, so the upgrade never starts as the free edition. Every license carries an expiry date; after that date the system switches to the free edition until a renewed license is uploaded.
                </div>
            </div>
        </div>
    );
}
