import React, { useEffect, useState } from 'react';
import { TbKey, TbLock, TbLockOpen, TbTrash, TbUpload } from 'react-icons/tb';
import api from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { PAID_FEATURE_INFO, LICENSE_EVENT } from '../../utils/licenseUtils.js';

const CHANNEL_NAMES = { telegram: 'Telegram 通知', email: 'Email 通知', webhook: 'Webhook 外送' };
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
        if (file.size > 16 * 1024) { setMessage({ type: 'error', text: '授權檔最大 16 KB。' }); return; }
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
            setMessage({ type: 'success', text: `授權已套用：${res.data.licenseId}（${res.data.customer}）。` });
        } catch (err) {
            setMessage({ type: 'error', text: err.response?.data?.error || err.message });
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!await showConfirm('移除授權後，付費功能、AD 帳號登入與往外送通知會立刻關閉（資料保留）。確定移除？')) return;
        setBusy(true);
        setMessage(null);
        try {
            const res = await api.delete('/license');
            setState(res.data);
            announce(res.data);
            setMessage({ type: 'success', text: '授權已移除，目前為免費版。' });
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
                        <span>授權編號</span><span>{state.licenseId}</span>
                        <span>簽發日</span><span>{state.issuedAt}</span>
                    </div>
                )}
                {state && !paid && state.reason && state.reason !== 'no license' && (
                    <div style={{ marginTop: 12, fontSize: 13, color: 'var(--warning)' }}>目前的授權無效：{state.reason}</div>
                )}
            </div>

            <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>付費功能</h3>
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
                        AD 帳號登入與 RBAC
                    </div>
                </div>
            </div>

            <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>{paid ? '更換授權' : '上傳授權'}</h3>
                <textarea value={text} onChange={e => setText(e.target.value)} rows={8} placeholder="貼上授權檔（.lic）內容，或選擇檔案"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 10, borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <label className="btn btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <TbUpload /> 選擇檔案
                        <input type="file" accept=".lic,.json,.txt" onChange={onFile} style={{ display: 'none' }} />
                    </label>
                    <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={upload}>套用授權</button>
                    {paid && (
                        <button type="button" className="btn btn-danger" disabled={busy} onClick={remove} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                            <TbTrash /> 移除授權
                        </button>
                    )}
                </div>
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    升級版本前，可以先把授權檔放到資料目錄的 <code>license.lic</code>：服務啟動時會自動套用，升級後不會有免費版的空窗。
                </div>
            </div>
        </div>
    );
}
