// Edit a registry-based policy value (Software\Policies) inside a GPO. Lists the registry settings the GPO already
// holds; clicking one fills the form.
import React, { useEffect, useState } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';

const input = { width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px' };
const label = { display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' };

export default function RegistryEditModal({ gpo, onClose, onDone }) {
    const { showToast } = useToast();
    const [regKey, setRegKey] = useState('HKCU\\Software\\Policies\\Microsoft');
    const [regValueName, setRegValueName] = useState('');
    const [regType, setRegType] = useState('String');
    const [regValue, setRegValue] = useState('');
    const [settings, setSettings] = useState({ loading: true, list: [] });
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let alive = true;
        api.get('/gpo/registry-list', { params: { guid: gpo.guid } })
            .then(r => { if (alive) setSettings({ loading: false, list: r.data.settings || [] }); })
            .catch(e => { console.error('Failed to load GPO registry settings:', e); if (alive) setSettings({ loading: false, list: [] }); });
        return () => { alive = false; };
    }, [gpo.guid]);

    const save = async (action) => {
        if (!regKey) return showToast('Registry Key is required');
        setSaving(true);
        try {
            await api.post('/gpo/security', { guid: gpo.guid, name: gpo.name, key: regKey, valueName: regValueName, type: regType, value: regValue, action });
            onDone({ type: 'success', text: `Registry policy ${action === 'Set' ? 'set' : 'removed'} in '${gpo.name}'.` });
        } catch (e) {
            onDone({ type: 'error', text: e.response?.data?.error || 'Policy edit failed.' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div role="dialog" aria-label="Edit registry settings" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '2rem', maxWidth: '520px', width: '92%', boxShadow: 'var(--shadow-lg)' }}>
                <h3 style={{ marginTop: 0, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Edit registry settings</h3>
                <p style={{ color: 'var(--accent-primary)', fontSize: '13px', marginBottom: '1.2rem', fontWeight: 600 }}>GPO: {gpo.name}</p>

                <div style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Registry settings in this GPO</div>
                    {settings.loading ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reading GPO settings from the domain controller…</div>
                    ) : settings.list.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No registry settings configured.</div>
                    ) : (
                        <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '6px', background: 'rgba(0,0,0,0.1)' }}>
                            {settings.list.map((s, i) => (
                                <div key={i} onClick={() => { setRegKey(`${s.hive}\\${s.key}`); setRegValueName(s.valueName || ''); setRegType(s.type || 'String'); setRegValue(s.value || ''); }}
                                    style={{ padding: '6px', borderRadius: '4px', cursor: 'pointer', borderBottom: i < settings.list.length - 1 ? '1px solid var(--border-color)' : 'none', fontSize: '11px' }}>
                                    <strong style={{ color: 'var(--accent-primary)' }}>[{s.hive}]</strong> {s.key}<br />
                                    <span style={{ color: 'var(--text-secondary)' }}>Name: <code>{s.valueName || '(Default)'}</code> | Value: <code>{s.value}</code> ({s.type})</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
                    <div>
                        <label style={label}>Registry key (HKLM\Software\Policies\… or HKCU\Software\Policies\…)</label>
                        <input type="text" value={regKey} onChange={e => setRegKey(e.target.value)} style={input} />
                    </div>
                    <div>
                        <label style={label}>Value name (optional)</label>
                        <input type="text" value={regValueName} onChange={e => setRegValueName(e.target.value)} style={input} />
                    </div>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <div style={{ flex: 1 }}>
                            <label style={label}>Type</label>
                            <select value={regType} onChange={e => setRegType(e.target.value)} style={input}>
                                <option value="String">String (REG_SZ)</option>
                                <option value="ExpandString">ExpandString (REG_EXPAND_SZ)</option>
                                <option value="Binary">Binary (REG_BINARY)</option>
                                <option value="DWord">DWord (REG_DWORD)</option>
                                <option value="MultiString">MultiString (REG_MULTI_SZ)</option>
                                <option value="QWord">QWord (REG_QWORD)</option>
                            </select>
                        </div>
                        <div style={{ flex: 2 }}>
                            <label style={label}>Value data</label>
                            <input type="text" value={regValue} onChange={e => setRegValue(e.target.value)} style={input} />
                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                    <button onClick={onClose} disabled={saving} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
                    <button disabled={saving} onClick={() => save('Remove')} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{saving ? '…' : 'Remove value'}</button>
                    <button disabled={saving} onClick={() => save('Set')} style={{ padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none', background: 'var(--accent-primary)', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{saving ? '…' : 'Set value'}</button>
                </div>
            </div>
        </div>
    );
}
