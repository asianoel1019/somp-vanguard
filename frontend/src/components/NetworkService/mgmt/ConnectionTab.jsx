import React, { useState } from 'react';
import api from '../../../api';
import { SECRET_MASK, SCOPE_LABELS, TRANSPORT_LABELS, apiName, transportHint, formFromProfile, targetChanged, payloadFromForm, describeError } from './mgmtTabs.js';

// Management (vendor API) connection of one device: vendor, address, token, TLS, test and save.
// The parent remounts it (key) when the saved profile changes, which resets the form.
export default function ConnectionTab({ device, info, role, s, onSaved, onAlert, onConfirm }) {
    const vendors = (info && info.vendors) || [];
    const profile = info && info.profile;
    const [form, setForm] = useState(() => formFromProfile(profile, vendors));
    const [busy, setBusy] = useState('');
    const [testResult, setTestResult] = useState(null);
    const canEdit = role !== 'Viewer';

    const vendor = vendors.find(v => v.id === form.vendor);
    const changed = targetChanged(profile, form);
    const set = (patch) => setForm(f => ({ ...f, ...patch }));
    const secretValue = (k) => (changed && form[k] === SECRET_MASK ? '' : form[k]);
    const body = () => payloadFromForm({ ...form, token: secretValue('token'), password: secretValue('password'), apiKey: secretValue('apiKey'), enableSecret: secretValue('enableSecret') }, vendor);

    const test = () => {
        setBusy('test');
        setTestResult(null);
        api.post(`/network-device/${device.id}/mgmt/test`, body())
            .then(res => setTestResult({ ok: true, facts: res.data.facts || {} }))
            .catch(err => setTestResult({ ok: false, message: describeError(err) }))
            .finally(() => setBusy(''));
    };

    const save = () => {
        setBusy('save');
        api.put(`/network-device/${device.id}/mgmt`, body())
            .then(res => { onAlert('管理連線已儲存'); onSaved({ ...info, profile: res.data.profile, capabilities: res.data.capabilities || [], backup: !!res.data.backup }); })
            .catch(err => onAlert('儲存失敗：' + describeError(err)))
            .finally(() => setBusy(''));
    };

    const remove = () => onConfirm('確定要移除這台設備的管理連線？已儲存的 token 會一併刪除。', () => {
        api.delete(`/network-device/${device.id}/mgmt`)
            .then(() => { onAlert('管理連線已移除'); onSaved({ ...info, profile: null, capabilities: [], backup: false }); })
            .catch(err => onAlert('移除失敗：' + describeError(err)));
    });

    const resetHostKey = () => onConfirm('重設這台設備的 SSH 主機金鑰？下次 SSH 連線會記住設備目前的金鑰；只在確定設備更換過（或重新產生過金鑰）時才這樣做。', () => {
        api.post(`/network-device/${device.id}/mgmt/hostkey/reset`)
            .then(res => onAlert(res.data.removed ? '已重設主機金鑰，下次連線會重新記住。' : '這台設備尚未記錄主機金鑰。'))
            .catch(err => onAlert('重設失敗：' + describeError(err)));
    });

    const box = { padding: 16, border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-primary)', marginBottom: 16 };
    const hint = { margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' };
    const secondary = { ...s.btnPrimary, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' };

    if (!vendors.length) return <p style={{ color: 'var(--text-muted)' }}>此設備類型（{device.type}）目前沒有可整合的廠牌。</p>;
    if (!profile && !vendors.some(v => v.available)) {
        return <p style={{ color: 'var(--text-muted)' }}>{device.type} 的廠牌整合（{vendors.map(v => v.label).join('、')}）尚在開發中，之後的版本會提供。</p>;
    }

    return (
        <div style={{ maxWidth: 640 }}>
            <div style={box}>
                <h4 style={{ margin: '0 0 16px', fontSize: 16 }}>Management Connection</h4>
                <p style={{ ...hint, margin: '0 0 16px' }}>
                    透過廠牌 API 唯讀讀取設備狀態、介面、政策等資料。建議在設備上建立唯讀權限的 API 帳號，token 會加密儲存，畫面上只顯示遮罩。
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 14, fontWeight: 700 }}>
                    <input type="checkbox" checked={form.enabled} disabled={!canEdit} onChange={e => set({ enabled: e.target.checked })} />
                    啟用管理連線
                </label>
                <div style={s.inputGroup}>
                    <label style={s.label}>Vendor</label>
                    <select style={s.input} value={form.vendor} disabled={!canEdit} onChange={e => { const v = vendors.find(x => x.id === e.target.value); set({ vendor: e.target.value, port: v ? v.defaultPort : form.port }); }}>
                        {vendors.map(v => <option key={v.id} value={v.id} disabled={!v.available}>{v.label}{v.available ? '' : '（尚未支援）'}</option>)}
                    </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                    <div style={s.inputGroup}>
                        <label style={s.label}>Management Address</label>
                        <input type="text" style={s.input} disabled={!canEdit} placeholder={device.ip || 'fw01.example.com'} value={form.mgmtHost} onChange={e => set({ mgmtHost: e.target.value })} />
                        {!form.mgmtHost && device.ip && canEdit && (
                            <button type="button" style={{ ...hint, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-primary)', textAlign: 'left' }} onClick={() => set({ mgmtHost: device.ip })}>使用設備 IP {device.ip}</button>
                        )}
                    </div>
                    <div style={s.inputGroup}>
                        <label style={s.label}>{vendor && vendor.transports ? 'API Port' : 'Port'}</label>
                        <input type="number" style={s.input} disabled={!canEdit} value={form.port} onChange={e => set({ port: e.target.value })} />
                    </div>
                </div>
                {vendor && vendor.scope && (
                    <div style={s.inputGroup}>
                        <label style={s.label}>{SCOPE_LABELS[vendor.scope] || vendor.scope}（選填）</label>
                        <input type="text" style={s.input} disabled={!canEdit} placeholder={vendor.scope === 'vdom' ? 'root' : ''} value={form.scope} onChange={e => set({ scope: e.target.value })} />
                    </div>
                )}
                {vendor && vendor.target && (
                    <div style={s.inputGroup}>
                        <label style={s.label}>Gateway 名稱 / IP（管理伺服器上的物件）</label>
                        <input type="text" style={s.input} disabled={!canEdit} placeholder={device.hostname || ''} value={form.target} onChange={e => set({ target: e.target.value })} />
                        <p style={hint}>Check Point 透過管理伺服器（Security Management / MDS）讀取：上方位址填管理伺服器，這裡填這台設備在 SmartConsole 中的 Gateway 或 Cluster 名稱。管理伺服器只有一台 Gateway 時可留空。</p>
                    </div>
                )}
                {vendor && vendor.auth === 'token' && (
                    <div style={s.inputGroup}>
                        <label style={s.label}>API Token</label>
                        <input type="password" autoComplete="new-password" style={s.input} disabled={!canEdit} value={secretValue('token')} onChange={e => set({ token: e.target.value })} />
                        <p style={hint}>{form.token === SECRET_MASK && !changed ? '已儲存 token；留空或保持遮罩即沿用。' : 'FortiGate：System → Administrators → REST API Admin 建立。'}</p>
                    </div>
                )}
                {vendor && vendor.auth === 'apiKey' && (
                    <div style={s.inputGroup}>
                        <label style={s.label}>API Key</label>
                        <input type="password" autoComplete="new-password" style={s.input} disabled={!canEdit} value={secretValue('apiKey')} onChange={e => set({ apiKey: e.target.value })} />
                        <p style={hint}>
                            {form.apiKey === SECRET_MASK && !changed
                                ? '已儲存 API key；留空或保持遮罩即沿用。'
                                : '建議使用唯讀 Admin Role 的帳號產生 API key；也可不填 key，改填下方帳號密碼（Vanguard 會自動換取 key，只存在記憶體）。'}
                        </p>
                    </div>
                )}
                {vendor && (vendor.auth === 'password' || vendor.auth === 'apiKey') && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div style={s.inputGroup}>
                            <label style={s.label}>User</label>
                            <input type="text" style={s.input} disabled={!canEdit} value={form.username} onChange={e => set({ username: e.target.value })} />
                        </div>
                        <div style={s.inputGroup}>
                            <label style={s.label}>Password</label>
                            <input type="password" autoComplete="new-password" style={s.input} disabled={!canEdit} value={secretValue('password')} onChange={e => set({ password: e.target.value })} />
                        </div>
                    </div>
                )}
                {vendor && vendor.transports && (
                    <div style={{ display: 'grid', gridTemplateColumns: vendor.enable ? '2fr 1fr 2fr' : '2fr 1fr', gap: 16 }}>
                        <div style={s.inputGroup}>
                            <label style={s.label}>連線方式</label>
                            <select style={s.input} disabled={!canEdit} value={form.transport} onChange={e => set({ transport: e.target.value })}>
                                {['auto', ...vendor.transports].map(k => <option key={k} value={k}>{TRANSPORT_LABELS[k]}</option>)}
                            </select>
                        </div>
                        <div style={s.inputGroup}>
                            <label style={s.label}>SSH Port</label>
                            <input type="number" style={s.input} disabled={!canEdit} value={form.sshPort} onChange={e => set({ sshPort: e.target.value })} />
                        </div>
                        {vendor.enable && (
                            <div style={s.inputGroup}>
                                <label style={s.label}>Enable 密碼（選填）</label>
                                <input type="password" autoComplete="new-password" style={s.input} disabled={!canEdit} value={secretValue('enableSecret')} onChange={e => set({ enableSecret: e.target.value })} />
                            </div>
                        )}
                    </div>
                )}
                {vendor && vendor.transports && (
                    <p style={{ ...hint, margin: '0 0 12px' }}>
                        {transportHint(vendor.id)}
                    </p>
                )}
                {changed && profile && (
                    <p style={{ ...hint, color: 'var(--warning)', margin: '0 0 12px' }}>位址、埠號、SSH Port 或廠牌已變更：已儲存的密碼不會帶到新位址，請重新輸入。</p>
                )}
                {!(vendor && vendor.transports && form.transport === 'ssh') && (<>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 14 }}>
                    <input type="checkbox" checked={form.tlsVerify} disabled={!canEdit} onChange={e => set({ tlsVerify: e.target.checked })} />
                    驗證設備憑證（TLS）
                </label>
                {!form.tlsVerify && <p style={{ ...hint, margin: '0 0 12px' }}>設備多半使用自簽憑證，預設不驗證；若要驗證，請貼上簽發設備憑證的 CA。</p>}
                {form.tlsVerify && (
                    <div style={s.inputGroup}>
                        <label style={s.label}>CA Certificate (PEM，選填)</label>
                        <textarea style={{ ...s.input, minHeight: 90, fontFamily: 'monospace', fontSize: 12 }} disabled={!canEdit} placeholder="-----BEGIN CERTIFICATE-----" value={form.caCert} onChange={e => set({ caCert: e.target.value })} />
                    </div>
                )}
                </>)}
                {canEdit && (
                    <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                        <button style={{ ...secondary, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={test}>{busy === 'test' ? 'Testing...' : 'Test Connection'}</button>
                        <button style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving...' : 'Save Connection'}</button>
                        {profile && <button style={{ ...s.btnPrimary, background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', color: 'var(--danger)' }} onClick={remove}>Remove</button>}
                        {profile && vendor && vendor.transports && <button style={secondary} onClick={resetHostKey}>重設主機金鑰</button>}
                    </div>
                )}
                {testResult && (
                    <div style={{ marginTop: 16, padding: 12, borderRadius: 8, fontSize: 13, background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                        {testResult.ok
                            ? `連線成功：${[testResult.facts.model, testResult.facts.hostname, testResult.facts.version].filter(Boolean).join(' / ') || 'OK'}${testResult.facts.transport ? `（${String(testResult.facts.transport).toUpperCase()}）` : ''}`
                            : `連線失敗：${testResult.message}`}
                        {testResult.ok && testResult.facts.note && <div style={{ marginTop: 4, color: 'var(--warning)' }}>{testResult.facts.note}</div>}
                    </div>
                )}
            </div>
            {profile && (
                <div style={{ ...box, fontSize: 13, color: 'var(--text-secondary)' }}>
                    <div>最後狀態：<b style={{ color: profile.lastStatus === 'ok' ? 'var(--success)' : profile.lastStatus === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>{profile.lastStatus || 'unknown'}</b>{profile.lastCheckedAt ? `（${new Date(profile.lastCheckedAt).toLocaleString()}）` : ''}</div>
                    {profile.transport === 'auto' && vendor && vendor.transports && <div style={{ marginTop: 4 }}>自動判斷目前使用：<b>{profile.lastTransport === 'api' ? `API（${apiName(vendor.id)}）` : profile.lastTransport === 'ssh' ? 'SSH' : '尚未判斷（下次讀取時決定）'}</b></div>}
                    {profile.lastError && <div style={{ marginTop: 4, color: 'var(--danger)' }}>{profile.lastError}</div>}
                    {profile.updatedBy && <div style={{ marginTop: 4 }}>設定者：{profile.updatedBy}{profile.updatedAt ? `，${new Date(profile.updatedAt).toLocaleString()}` : ''}</div>}
                </div>
            )}
        </div>
    );
}
