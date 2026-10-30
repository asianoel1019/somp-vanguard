import React, { useState } from 'react';
import { FiTrash2, FiEdit2, FiPlus } from 'react-icons/fi';
import api from '../../api';
import { PROBE_FIELD_META, buildProfileBody, apiErrorText } from './inventoryHistoryUtils';

const small = { fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 };
const cell = (s) => ({ ...s.input, marginTop: 4, padding: '8px 10px', fontSize: 12 });

/** Per-subnet override editor: one row per subnet entry. Empty field = no override (the global probe settings apply). */
export const SubnetSettingsEditor = ({ s, entries, forms, onChange, profiles, canEdit, canPickProfile }) => {
    if (!entries.length) return <div style={s.hint}>Add target subnets on the Target Subnets tab first.</div>;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {entries.map(key => {
                const f = forms[key] || {};
                const set = (patch) => onChange(key, patch);
                const names = profiles.map(p => p.name);
                if (f.credentialProfile && !names.includes(f.credentialProfile)) names.push(f.credentialProfile);
                return (
                    <div key={key} style={{ padding: 16, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                        <div style={{ fontWeight: 900, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{key}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 8 }}>
                            <label><span style={small}>Concurrency (1-64)</span>
                                <input style={cell(s)} type="number" min="1" max="64" disabled={!canEdit} value={f.concurrency ?? ''} placeholder="global" onChange={e => set({ concurrency: e.target.value })} />
                            </label>
                            <label><span style={small}>TCP ports</span>
                                <input style={cell(s)} type="text" disabled={!canEdit} value={f.tcpPorts ?? ''} placeholder="global" onChange={e => set({ tcpPorts: e.target.value })} />
                            </label>
                            <label><span style={small}>Prometheus auto-sync</span>
                                <select style={cell(s)} disabled={!canEdit} value={f.autoSyncPrometheus ?? ''} onChange={e => set({ autoSyncPrometheus: e.target.value })}>
                                    <option value="">Use global setting</option>
                                    <option value="on">On</option>
                                    <option value="off">Off</option>
                                </select>
                            </label>
                            <label><span style={small}>Credential profile</span>
                                <select style={cell(s)} disabled={!canEdit || !canPickProfile} value={f.credentialProfile ?? ''} onChange={e => set({ credentialProfile: e.target.value })} title={canPickProfile ? '' : 'Only a SuperAdmin can change the credential profile'}>
                                    <option value="">Default credentials</option>
                                    {names.map(n => <option key={n} value={n}>{n}</option>)}
                                </select>
                            </label>
                            <label><span style={small}>Timezone offset (-12..14)</span>
                                <input style={cell(s)} type="number" step="0.5" min="-12" max="14" disabled={!canEdit} value={f.timezoneOffset ?? ''} placeholder="none" onChange={e => set({ timezoneOffset: e.target.value })} />
                            </label>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

/** Global probe settings + retention + new-host alerts. */
export const ProbeSettingsEditor = ({ s, probeForm, onProbeChange, config, onConfigChange, canEdit }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <label style={s.metricLabel}>GLOBAL PROBE SETTINGS</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                {PROBE_FIELD_META.map(({ key, min, max }) => (
                    <label key={key}><span style={small}>{key} ({min}-{max})</span>
                        <input style={cell(s)} type="number" min={min} max={max} disabled={!canEdit} value={probeForm[key] ?? ''} onChange={e => onProbeChange({ [key]: e.target.value })} />
                    </label>
                ))}
                <label><span style={small}>tcpPorts (1-10 ports)</span>
                    <input style={cell(s)} type="text" disabled={!canEdit} value={probeForm.tcpPorts ?? ''} onChange={e => onProbeChange({ tcpPorts: e.target.value })} />
                </label>
            </div>
            <div style={s.hint}>
                <b>missesBeforeOffline</b>: a host is marked offline only after this many scans in a row without an answer.
                <b> outageThresholdPct</b>: when more than this share of a subnet's known-online hosts disappears, the subnet is treated as degraded (probable network outage) and no host is marked offline.
                Per-subnet settings override concurrency and ports.
            </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <div>
                <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>New host alerts</div>
                <div style={small}>Send one summary notification per scan when new or unknown hosts appear</div>
            </div>
            <input type="checkbox" disabled={!canEdit} checked={config.newHostAlerts !== false} onChange={e => onConfigChange({ newHostAlerts: e.target.checked })} style={{ width: 22, height: 22, cursor: 'pointer', accentColor: 'var(--accent-primary)' }} />
        </div>
        <div style={{ padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <label style={s.metricLabel}>SCAN HISTORY RETENTION (30-730 DAYS)</label>
            <input style={{ ...s.input, width: 120, marginTop: 4 }} type="number" min="30" max="730" disabled={!canEdit}
                value={config.historyRetentionDays ?? 180}
                onChange={e => onConfigChange({ historyRetentionDays: e.target.value === '' ? '' : Number(e.target.value) })} />
        </div>
    </div>
);

const EMPTY = { name: '', winUser: '', winPassword: '', linuxUser: '', linuxPassword: '', clearWinPassword: false, clearLinuxPassword: false };

/** SuperAdmin-only credential profile editor. Passwords are write-only: blank keeps the stored one. */
export const CredentialProfilesEditor = ({ s, profiles, onReload, showToast }) => {
    const [form, setForm] = useState(null); // null = closed; { isNew, ...EMPTY }
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const startEdit = (p) => { setError(''); setForm({ ...EMPTY, isNew: false, name: p.name, winUser: p.winUser || '', linuxUser: p.linuxUser || '', hasWin: p.hasWinPassword, hasLinux: p.hasLinuxPassword }); };
    const save = async () => {
        const name = form.name.trim();
        if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(name)) { setError('Name must be 1-64 characters: letters, digits, space, _ . -'); return; }
        setBusy(true); setError('');
        try {
            await api.put(`/inventory/credential-profiles/${encodeURIComponent(name)}`, buildProfileBody(form));
            showToast(`Credential profile "${name}" saved`, 'success');
            setForm(null);
            await onReload();
        } catch (e) { setError(apiErrorText(e, 'Failed to save the profile')); }
        setBusy(false);
    };
    const remove = async (p) => {
        if (!window.confirm(`Delete credential profile "${p.name}"?`)) return;
        try {
            await api.delete(`/inventory/credential-profiles/${encodeURIComponent(p.name)}`);
            showToast(`Credential profile "${p.name}" deleted`, 'success');
            await onReload();
        } catch (e) { showToast(apiErrorText(e, 'Failed to delete the profile'), 'error'); }
    };
    const set = (patch) => setForm(f => ({ ...f, ...patch }));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={s.hint}>
                A profile supplies Windows and/or Linux credentials for the subnets that use it (a user and a password are needed for an OS; otherwise the default
                AD_ADMIN_* / LINUX_ADMIN_* credentials apply for that OS). Passwords are encrypted and never shown again; leave a password blank to keep the stored one.
            </div>
            <table style={s.table}>
                <thead><tr><th style={s.th}>NAME</th><th style={s.th}>WINDOWS</th><th style={s.th}>LINUX</th><th style={s.th}>UPDATED</th><th style={{ ...s.th, textAlign: 'right' }}>ACTIONS</th></tr></thead>
                <tbody>
                    {profiles.length === 0 ? (
                        <tr><td colSpan="5" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)' }}>No credential profiles yet.</td></tr>
                    ) : profiles.map(p => (
                        <tr key={p.name} style={s.tr}>
                            <td style={{ ...s.td, fontWeight: 800 }}>{p.name}</td>
                            <td style={{ ...s.td, fontSize: 12 }}>{p.winUser || '-'} {p.hasWinPassword ? '(password set)' : '(no password)'}</td>
                            <td style={{ ...s.td, fontSize: 12 }}>{p.linuxUser || '-'} {p.hasLinuxPassword ? '(password set)' : '(no password)'}</td>
                            <td style={{ ...s.td, fontSize: 11, color: 'var(--text-muted)' }}>{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '-'}{p.updatedBy ? ` by ${p.updatedBy}` : ''}</td>
                            <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button style={{ ...s.viewBtn, marginRight: 6 }} onClick={() => startEdit(p)}><FiEdit2 size={11} /> EDIT</button>
                                <button style={{ ...s.viewBtn, background: 'transparent', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)', boxShadow: 'none' }} onClick={() => remove(p)}><FiTrash2 size={11} /> DELETE</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {!form && <div><button style={s.btnOutline} onClick={() => { setError(''); setForm({ ...EMPTY, isNew: true }); }}><FiPlus size={14} /> Add profile</button></div>}
            {form && (
                <div style={{ padding: 18, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                    <div style={{ fontWeight: 900, marginBottom: 8 }}>{form.isNew ? 'New profile' : `Edit "${form.name}"`}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
                        <label><span style={small}>Name</span><input style={cell(s)} disabled={!form.isNew} value={form.name} onChange={e => set({ name: e.target.value })} /></label>
                        <span />
                        <label><span style={small}>Windows user</span><input style={cell(s)} autoComplete="off" value={form.winUser} onChange={e => set({ winUser: e.target.value })} /></label>
                        <label><span style={small}>Windows password</span>
                            <input style={cell(s)} type="password" autoComplete="new-password" value={form.winPassword} placeholder={form.hasWin ? 'unchanged' : ''} onChange={e => set({ winPassword: e.target.value })} />
                            {!form.isNew && form.hasWin && <span style={small}><input type="checkbox" checked={form.clearWinPassword} onChange={e => set({ clearWinPassword: e.target.checked })} /> clear stored password</span>}
                        </label>
                        <label><span style={small}>Linux user</span><input style={cell(s)} autoComplete="off" value={form.linuxUser} onChange={e => set({ linuxUser: e.target.value })} /></label>
                        <label><span style={small}>Linux password</span>
                            <input style={cell(s)} type="password" autoComplete="new-password" value={form.linuxPassword} placeholder={form.hasLinux ? 'unchanged' : ''} onChange={e => set({ linuxPassword: e.target.value })} />
                            {!form.isNew && form.hasLinux && <span style={small}><input type="checkbox" checked={form.clearLinuxPassword} onChange={e => set({ clearLinuxPassword: e.target.checked })} /> clear stored password</span>}
                        </label>
                    </div>
                    {error && <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                        <button style={s.btnOutline} disabled={busy} onClick={() => setForm(null)}>CANCEL</button>
                        <button style={s.btnPrimary} disabled={busy} onClick={save}>{busy ? 'SAVING...' : 'SAVE PROFILE'}</button>
                    </div>
                </div>
            )}
        </div>
    );
};
