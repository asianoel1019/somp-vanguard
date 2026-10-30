import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import {
    defaultPortForType, emptyDeviceForm, deviceToForm, validateNasDeviceForm,
    buildDevicePayload, buildTestPayload, deviceErrorMessage, NAME_MAX, USERNAME_MAX
} from './fileServicesUtils';

const TYPE_LABELS = {
    synology: 'Synology DSM API',
    qnap: 'QNAP QTS API',
    windows: 'Windows Share (PowerShell)',
    linux: 'Linux SMB (Samba net conf)'
};

// ---------------------------------------------------------------- SFTP Servers (moved from Settings.jsx, behaviour unchanged)
// State, the add/edit modal and the save mechanism (sysConfig + "Save Changes") stay in Settings.jsx and arrive as props.
function SftpServersPanel({ S, servers, testing, testResult, onAdd, onEdit, onDelete, onToggle, onTest }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <h3 style={{ ...S.tblTitle, fontSize: 16, margin: 0 }}>📁 SFTP Multi-Server Management</h3>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                            Configure and manage multiple Python SFTP Server endpoints (Local, Active Directory, Remote Nodes)
                        </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                            type="button"
                            style={{ ...S.btnP, background: 'linear-gradient(135deg, #06b6d4, #3b82f6)' }}
                            onClick={onAdd}
                        >
                            ➕ Add SFTP Server
                        </button>
                    </div>
                </div>

                {/* Configured SFTP Servers Table */}
                <div style={{ ...S.tblWrap, marginBottom: 0 }}>
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>SERVER NAME</th>
                                <th style={S.th}>HOST IP</th>
                                <th style={S.th}>WEB API PORT</th>
                                <th style={S.th}>SFTP PORT</th>
                                <th style={S.th}>PROTOCOL</th>
                                <th style={S.th}>STATUS</th>
                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                            </tr>
                        </thead>
                        <tbody>
                            {servers.map(srv => {
                                const isTestingThis = testing && testResult?.serverId === srv.id;
                                return (
                                    <React.Fragment key={srv.id}>
                                        <tr style={S.tr}>
                                            <td style={{ ...S.td, fontWeight: 800, color: 'var(--text-primary)' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ fontSize: 16 }}>📁</span>
                                                    <span>{srv.name}</span>
                                                </div>
                                            </td>
                                            <td style={{ ...S.td, fontFamily: 'monospace', color: '#38bdf8' }}>
                                                {srv.host}
                                            </td>
                                            <td style={{ ...S.td, fontFamily: 'monospace' }}>
                                                {srv.apiPort}
                                            </td>
                                            <td style={{ ...S.td, fontFamily: 'monospace', color: srv.sftpPort ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                                {srv.sftpPort || 'Auto (Server)'}
                                            </td>
                                            <td style={S.td}>
                                                <span style={{ ...S.badge, background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                                                    {(srv.protocol || 'http').toUpperCase()}
                                                </span>
                                            </td>
                                            <td style={S.td}>
                                                <button
                                                    type="button"
                                                    onClick={() => onToggle(srv.id)}
                                                    style={{
                                                        padding: '4px 10px',
                                                        borderRadius: 12,
                                                        fontSize: 11,
                                                        fontWeight: 800,
                                                        border: 'none',
                                                        cursor: 'pointer',
                                                        background: srv.enabled ? 'rgba(52,199,89,0.15)' : 'rgba(255,255,255,0.08)',
                                                        color: srv.enabled ? '#34c759' : 'var(--text-muted)',
                                                        transition: 'all 0.2s'
                                                    }}
                                                >
                                                    {srv.enabled ? '🟢 Enabled' : '⚪ Disabled'}
                                                </button>
                                            </td>
                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                <div style={{ display: 'inline-flex', gap: 6 }}>
                                                    <button
                                                        type="button"
                                                        style={{ ...S.btnO, padding: '5px 12px', fontSize: 12 }}
                                                        onClick={() => onTest(srv)}
                                                        disabled={testing}
                                                    >
                                                        {isTestingThis ? '⏳' : '⚡ Test'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        style={{ ...S.btnO, padding: '5px 12px', fontSize: 12 }}
                                                        onClick={() => onEdit(srv)}
                                                    >
                                                        ✏️ Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        style={{ ...S.btnO, padding: '5px 12px', fontSize: 12, color: '#ff3b30', borderColor: 'rgba(255,59,48,0.3)' }}
                                                        onClick={() => onDelete(srv.id)}
                                                    >
                                                        🗑️ Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                        {testResult?.serverId === srv.id && (
                                            <tr>
                                                <td colSpan="7" style={{ padding: '8px 20px', background: testResult.success ? 'rgba(52,199,89,0.08)' : 'rgba(255,59,48,0.08)', borderBottom: '1px solid var(--border-color)' }}>
                                                    <div style={{ fontSize: 12, fontWeight: 700, color: testResult.success ? '#34c759' : '#ff3b30', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                        <span>{testResult.success ? '✅' : '❌'}</span>
                                                        <span>{testResult.message || testResult.error}</span>
                                                        {testResult.serverInfo && (
                                                            <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', marginLeft: 'auto', fontSize: 11 }}>
                                                                Status: {testResult.serverInfo.status} | Users: {testResult.serverInfo.total_users} | Sessions: {testResult.serverInfo.active_connections}
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                            {servers.length === 0 && (
                                <tr>
                                    <td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
                                        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>
                                            尚未設定任何 SFTP 伺服器 (No SFTP Servers Configured)
                                        </div>
                                        <div style={{ fontSize: 12, marginBottom: 14 }}>
                                            點擊上方「Add SFTP Server」新增本地或遠端 SFTP 伺服器以啟用集中管理
                                        </div>
                                        <button
                                            type="button"
                                            style={{ ...S.btnP, background: 'linear-gradient(135deg, #06b6d4, #3b82f6)' }}
                                            onClick={onAdd}
                                        >
                                            ➕ Add First SFTP Server
                                        </button>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- NAS Devices
function NasDevicesPanel({ S, sysConfig, onConfigChange }) {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    // Settings is SuperAdmin-only; still gate the write controls here like other SuperAdmin-only content
    const canManage = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'SuperAdmin'; } catch { return false; } })();
    const [devices, setDevices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState(emptyDeviceForm());
    const [formError, setFormError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [testingId, setTestingId] = useState(null); // device id, or 'form' for the modal
    const [testResults, setTestResults] = useState({}); // id -> { success, message }

    const fetchDevices = useCallback(async () => {
        try {
            const res = await api.get('/nas/config');
            setDevices(Array.isArray(res.data) ? res.data : []);
        } catch (e) {
            showToast(deviceErrorMessage(e, 'Failed to load NAS devices'), 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { fetchDevices(); }, [fetchDevices]);

    const clearFormTest = () => setTestResults(prev => {
        const { form: _form, ...rest } = prev;
        return rest;
    });

    const openModal = (dev = null) => {
        clearFormTest();
        setFormError(null);
        setEditingId(dev ? dev.id : null);
        setForm(dev ? deviceToForm(dev) : emptyDeviceForm());
        setShowModal(true);
    };

    const handleTypeChange = (type) => {
        setForm(prev => ({ ...prev, type, port: defaultPortForType(type) }));
    };

    const runTest = async (payloadForm, id, key) => {
        setTestingId(key);
        try {
            const res = await api.post('/nas/test-connection', buildTestPayload(payloadForm, id));
            setTestResults(prev => ({ ...prev, [key]: { success: true, message: res.data.message, sig: JSON.stringify(payloadForm) } }));
            if (key === 'form') showToast(res.data.message, 'success');
        } catch (e) {
            const msg = deviceErrorMessage(e, 'Connection test failed.');
            setTestResults(prev => ({ ...prev, [key]: { success: false, message: msg, sig: JSON.stringify(payloadForm) } }));
            if (key === 'form') showToast(msg, 'error');
        } finally {
            setTestingId(null);
        }
    };

    const handleTestForm = () => {
        const problem = validateNasDeviceForm({ ...form, password: form.password || 'x' }, devices, editingId);
        if (problem && !/already exists/.test(problem)) { setFormError(problem); return; }
        setFormError(null);
        runTest(form, editingId, 'form');
    };

    const handleSave = async (e) => {
        e.preventDefault();
        const problem = validateNasDeviceForm(form, devices, editingId);
        if (problem) { setFormError(problem); return; }
        setFormError(null);
        setSaving(true);
        try {
            const payload = buildDevicePayload(form, !!editingId);
            if (editingId) await api.put(`/nas/devices/${editingId}`, payload);
            else await api.post('/nas/devices', payload);
            showToast(editingId ? 'NAS device updated.' : 'NAS device added.', 'success');
            setShowModal(false);
            fetchDevices();
        } catch (err) {
            setFormError(deviceErrorMessage(err, 'Failed to save NAS device'));
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (dev) => {
        if (!await showConfirm(`Delete NAS device "${dev.name}"? Its share list cache is removed from SOMP; nothing is deleted on the NAS itself.`)) return;
        try {
            await api.delete(`/nas/devices/${dev.id}`);
            showToast('NAS device deleted.', 'success');
            fetchDevices();
        } catch (err) {
            showToast(deviceErrorMessage(err, 'Failed to delete NAS device'), 'error');
        }
    };

    const label = { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <h3 style={{ ...S.tblTitle, fontSize: 16, margin: 0 }}>💾 NAS Devices</h3>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                            Storage devices managed from NAS Manager (Service Platform). Changes here apply immediately.
                        </p>
                    </div>
                    {canManage && <button type="button" style={S.btnP} onClick={() => openModal(null)}>➕ Add NAS Device</button>}
                </div>

                <div style={{ ...S.tblWrap, marginBottom: 0 }}>
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>NAME</th>
                                <th style={S.th}>DRIVER</th>
                                <th style={S.th}>ADDRESS</th>
                                <th style={S.th}>USERNAME</th>
                                <th style={S.th}>PASSWORD</th>
                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                            </tr>
                        </thead>
                        <tbody>
                            {devices.map(dev => (
                                <React.Fragment key={dev.id}>
                                    <tr style={S.tr}>
                                        <td style={{ ...S.td, fontWeight: 800 }}>{dev.name}</td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>{(dev.type || '').toUpperCase()}</span>
                                        </td>
                                        <td style={{ ...S.td, fontFamily: 'monospace', color: '#38bdf8' }}>{dev.ip}{dev.port ? `:${dev.port}` : ''}</td>
                                        <td style={{ ...S.td, fontFamily: 'monospace' }}>{dev.username}</td>
                                        <td style={{ ...S.td, color: dev.passwordNeedsReset ? '#ff9500' : (dev.hasPassword ? 'var(--text-secondary)' : 'var(--text-muted)'), fontWeight: dev.passwordNeedsReset ? 800 : 400 }}>
                                            {dev.passwordNeedsReset ? '⚠️ Password needs to be re-entered' : (dev.hasPassword ? '••••••••' : 'Not set')}
                                        </td>
                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                            {canManage && <div style={{ display: 'inline-flex', gap: 6 }}>
                                                <button type="button" style={{ ...S.btnO, padding: '5px 12px', fontSize: 12 }} disabled={testingId !== null} onClick={() => runTest(deviceToForm(dev), dev.id, dev.id)}>
                                                    {testingId === dev.id ? '⏳' : '⚡ Test'}
                                                </button>
                                                <button type="button" style={{ ...S.btnO, padding: '5px 12px', fontSize: 12 }} onClick={() => openModal(dev)}>✏️ Edit</button>
                                                <button type="button" style={{ ...S.btnO, padding: '5px 12px', fontSize: 12, color: '#ff3b30', borderColor: 'rgba(255,59,48,0.3)' }} onClick={() => handleDelete(dev)}>🗑️ Delete</button>
                                            </div>}
                                        </td>
                                    </tr>
                                    {testResults[dev.id] && (
                                        <tr>
                                            <td colSpan="6" style={{ padding: '8px 20px', background: testResults[dev.id].success ? 'rgba(52,199,89,0.08)' : 'rgba(255,59,48,0.08)', borderBottom: '1px solid var(--border-color)' }}>
                                                <div style={{ fontSize: 12, fontWeight: 700, color: testResults[dev.id].success ? '#34c759' : '#ff3b30' }}>
                                                    {testResults[dev.id].success ? '✅ ' : '❌ '}{testResults[dev.id].message}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                            {!loading && devices.length === 0 && (
                                <tr>
                                    <td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        <div style={{ fontSize: 32, marginBottom: 8 }}>💾</div>
                                        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>No NAS devices configured</div>
                                        <div style={{ fontSize: 12, marginBottom: 14 }}>Add a Synology, QNAP, Windows or Linux SMB device to manage it from NAS Manager.</div>
                                        {canManage && <button type="button" style={S.btnP} onClick={() => openModal(null)}>➕ Add First NAS Device</button>}
                                    </td>
                                </tr>
                            )}
                            {loading && (
                                <tr><td colSpan="6" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)' }}>Loading devices...</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div style={S.card}>
                <h3 style={{ ...S.tblTitle, marginBottom: 4 }}>Global NAS Controller Settings</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                    Applied to every NAS device. Use <b>Save Changes</b> at the top right to store these two values.
                </p>
                <div style={S.gridRow}>
                    <div style={S.fieldBlock}>
                        <label style={label}>NAS_DEFAULT_TIMEOUT_MS <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Default: 1500)</span></label>
                        <input type="number" style={S.input} value={sysConfig.NAS_DEFAULT_TIMEOUT_MS || 1500} onChange={e => onConfigChange('NAS_DEFAULT_TIMEOUT_MS', parseInt(e.target.value) || 1500)} />
                    </div>
                    <div style={S.fieldBlock}>
                        <label style={label}>NAS_DEFAULT_SYNC_ON_LOAD</label>
                        <select style={S.select} value={sysConfig.NAS_DEFAULT_SYNC_ON_LOAD || 'false'} onChange={e => onConfigChange('NAS_DEFAULT_SYNC_ON_LOAD', e.target.value)}>
                            <option value="true">Enable Auto-Sync (Slower Load)</option>
                            <option value="false">Disable Auto-Sync (Fast Load, Use Manual Sync)</option>
                        </select>
                    </div>
                </div>
            </div>

            {showModal && (
                <div style={S.overlay} onClick={() => setShowModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 480, textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 900 }}>{editingId ? '✏️ Edit NAS Device' : '➕ Add NAS Device'}</h3>
                        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} autoComplete="off">
                            <div>
                                <label style={label}>DEVICE NAME</label>
                                <input style={S.input} value={form.name} maxLength={NAME_MAX} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Taipei-Synology" />
                            </div>
                            <div>
                                <label style={label}>DRIVER TYPE</label>
                                <select style={S.select} value={form.type} onChange={e => handleTypeChange(e.target.value)}>
                                    {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                                <div>
                                    <label style={label}>IP ADDRESS / HOSTNAME</label>
                                    <input style={S.input} value={form.ip} onChange={e => setForm({ ...form, ip: e.target.value })} placeholder="e.g. 192.168.10.50" />
                                </div>
                                <div>
                                    <label style={label}>PORT</label>
                                    <input style={S.input} type="number" value={form.port} onChange={e => setForm({ ...form, port: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="e.g. 5000" />
                                </div>
                            </div>
                            <div>
                                <label style={label}>USERNAME</label>
                                <input style={S.input} value={form.username} maxLength={USERNAME_MAX} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="Admin account" autoComplete="off" />
                            </div>
                            <div>
                                <label style={label}>PASSWORD</label>
                                <input style={S.input} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={editingId ? 'Leave blank to keep current password' : 'Device password'} autoComplete="new-password" />
                            </div>
                            {formError && <div style={{ color: '#ff3b30', fontSize: 12, fontWeight: 700 }}>⚠️ {formError}</div>}
                            {testResults.form && testResults.form.sig === JSON.stringify(form) && (
                                <div style={{ color: testResults.form.success ? '#34c759' : '#ff3b30', fontSize: 12, fontWeight: 700 }}>
                                    {testResults.form.success ? '✅ ' : '❌ '}{testResults.form.message}
                                </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 6 }}>
                                <button type="button" style={S.btnO} onClick={handleTestForm} disabled={testingId !== null}>
                                    {testingId === 'form' ? '🔌 Testing...' : '🔌 Test Connection'}
                                </button>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button type="button" style={S.btnO} onClick={() => setShowModal(false)}>Cancel</button>
                                    <button type="submit" style={S.btnP} disabled={saving}>{saving ? 'Saving...' : (editingId ? 'Save Device' : 'Add Device')}</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Category shell with sub-tabs
export default function FileServicesSettings({ S, tab, onTabChange, sftp, sysConfig, onConfigChange }) {
    const tabs = [
        { id: 'sftp', label: '📁 SFTP Servers' },
        { id: 'nas', label: '💾 NAS Devices' }
    ];
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border-color)' }} role="tablist">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => onTabChange(t.id)}
                        style={{
                            background: 'transparent', border: 'none', padding: '10px 16px', cursor: 'pointer',
                            fontSize: 13, fontWeight: 800,
                            color: tab === t.id ? 'var(--accent-primary)' : 'var(--text-muted)',
                            borderBottom: tab === t.id ? '3px solid var(--accent-primary)' : '3px solid transparent'
                        }}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            {tab === 'nas'
                ? <NasDevicesPanel S={S} sysConfig={sysConfig} onConfigChange={onConfigChange} />
                : <SftpServersPanel S={S} {...sftp} />}
        </div>
    );
}
