import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { isShareEditor } from '../SettingsGroup/fileServicesUtils';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 10 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2, fontWeight: 600 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 28 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 20, cursor: 'pointer', transition: 'all 0.2s', position: 'relative' },
    activeCard: { border: '1px solid var(--accent-primary)', boxShadow: '0 0 16px var(--accent-glow)' },
    cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' },
    progressBar: { height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginTop: 12 },
    progressFill: { height: '100%', transition: 'width 0.3s' },
    section: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 20, padding: 28, marginTop: 20 },
    secTitle: { fontSize: 18, fontWeight: 900, margin: '0 0 20px 0', display: 'flex', alignItems: 'center', gap: 8 },
    tabs: { display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: 24, gap: 10 },
    tabBtn: { background: 'transparent', border: 'none', padding: '10px 16px', color: 'var(--text-muted)', fontSize: 13, fontWeight: 700, cursor: 'pointer', borderBottom: '3px solid transparent' },
    activeTabBtn: { color: 'var(--accent-primary)', borderBottom: '3px solid var(--accent-primary)' },
    btnP: { padding: '9px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 },
    tbl: { width: '100%', borderCollapse: 'collapse', marginTop: 12 },
    th: { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', letterSpacing: '0.06em' },
    td: { padding: '14px 16px', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    inputGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' },
    input: { width: '100%', padding: '10px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' },
    select: { width: '100%', padding: '10px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
};

// Formats storage capacity dynamically: < 1GB -> MB, < 1TB -> GB, >= 1TB -> TB
function formatCapacity(sizeInGB) {
    if (sizeInGB === undefined || sizeInGB === null || isNaN(sizeInGB) || sizeInGB <= 0) {
        return '0 MB';
    }
    if (sizeInGB < 1) {
        const mb = Math.round(sizeInGB * 1024);
        return `${mb} MB`;
    }
    if (sizeInGB < 1024) {
        const gb = sizeInGB % 1 === 0 ? sizeInGB : sizeInGB.toFixed(1);
        return `${gb} GB`;
    }
    const tb = (sizeInGB / 1024).toFixed(1);
    return `${tb} TB`;
}

// Returns only the volumes that contain active shares or data volumes (excluding non-shared system OS drives like C:)
function getEffectiveVolumes(dev) {
    if (!dev || !dev.volumes || dev.volumes.length === 0) return [];
    if (dev.volumes.length === 1) return dev.volumes;

    const shares = dev.shares || [];
    if (shares.length > 0) {
        const sharePaths = shares.map(s => String(s.path || '').toUpperCase());
        const shareNames = shares.map(s => String(s.name || '').toUpperCase());

        const matchedVolumes = dev.volumes.filter(vol => {
            const volName = String(vol.name || '').toUpperCase().trim();
            const driveMatch = volName.match(/^([A-Z]:)/);
            const driveLetter = driveMatch ? driveMatch[1] : null;

            return sharePaths.some(sp => {
                if (driveLetter && sp.includes(driveLetter)) return true;
                if (volName.length > 1 && sp.includes(volName)) return true;
                return false;
            }) || shareNames.some(sn => {
                if (driveLetter && sn.includes(driveLetter)) return true;
                return false;
            });
        });

        if (matchedVolumes.length > 0) {
            return matchedVolumes;
        }
    }

    // Fallback: If no shares match explicitly, exclude system drives (like C:\) if other data drives exist
    const nonCVolumes = dev.volumes.filter(vol => {
        const vName = String(vol.name || '').toUpperCase();
        return !vName.startsWith('C:') && !vName.startsWith('C:\\');
    });

    if (nonCVolumes.length > 0) {
        return nonCVolumes;
    }

    return dev.volumes;
}

function isSharedVolume(vol, dev) {
    const effVols = getEffectiveVolumes(dev);
    return effVols.some(v => v.name === vol.name);
}

export default function NasManager() {
    const { showToast } = useToast();
    const [devices, setDevices] = useState([]);
    const [selectedDevice, setSelectedDevice] = useState(null);
    const [activeTab, setActiveTab] = useState('shares');
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);

    // Custom confirm dialog state
    const [confirmModal, setConfirmModal] = useState(null); // { title, message, onConfirm }

    // Devices are managed in Settings -> File Services -> NAS Devices (SuperAdmin); this page only uses them.
    const userRole = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role; } catch { return undefined; } })();
    const isSuperAdmin = userRole === 'SuperAdmin';
    // Create/delete shares and edit ACLs need Operator or SuperAdmin (backend enforces it); others get a read-only view
    const canEditShares = isShareEditor(userRole);

    // Share modal states
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newShare, setNewShare] = useState({ name: '', path: '', description: '' });

    // Permission modal states
    const [showPermissionModal, setShowPermissionModal] = useState(false);
    const [permShareName, setPermShareName] = useState('');
    const [sharePermissions, setSharePermissions] = useState([]);
    const [newPerm, setNewPerm] = useState({ name: '', type: 'group', access: 'r' });

    useEffect(() => {
        fetchDevices(false);
    }, []);

    const fetchDevices = async (sync = false) => {
        if (sync) setSyncing(true);
        else setLoading(true);

        try {
            const res = await api.get(`/nas/config${sync ? '?sync=true' : ''}`);
            setDevices(res.data);
            if (res.data.length > 0) {
                if (selectedDevice) {
                    const updated = res.data.find(x => x.id === selectedDevice.id);
                    setSelectedDevice(updated || res.data[0]);
                } else {
                    setSelectedDevice(res.data[0]);
                }
            } else {
                setSelectedDevice(null);
            }
            if (sync) showToast('NAS devices status synchronized successfully.', 'success');
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to fetch NAS configuration', 'error');
        } finally {
            setLoading(false);
            setSyncing(false);
        }
    };

    const openDeviceSettings = () => {
        try {
            sessionStorage.setItem('somp.settings.category', 'fileservices');
            sessionStorage.setItem('somp.settings.tab', 'nas');
        } catch { /* storage unavailable */ }
        window.dispatchEvent(new CustomEvent('somp:navigate', { detail: { view: 'SYS_SETTINGS' } }));
    };

    const handleCreateShare = async (e) => {
        e.preventDefault();
        if (!newShare.name || !newShare.path) return;
        try {
            const res = await api.post('/nas/create-share', {
                deviceId: selectedDevice.id,
                ...newShare
            });
            showToast(res.data.message, 'success');
            setShowCreateModal(false);
            setNewShare({ name: '', path: '', description: '' });
            fetchDevices(false);
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to create share', 'error');
        }
    };

    const handleDeleteShare = (shareName) => {
        setConfirmModal({
            title: 'Delete Share Folder',
            message: `Are you sure you want to delete share folder "${shareName}"?`,
            onConfirm: async () => {
                try {
                    const res = await api.post('/nas/delete-share', {
                        deviceId: selectedDevice.id,
                        name: shareName
                    });
                    showToast(res.data.message, 'success');
                    fetchDevices(false);
                } catch (e) {
                    showToast(e.response?.data?.error || 'Failed to delete share', 'error');
                }
                setConfirmModal(null);
            }
        });
    };

    const openPermissions = async (share) => {
        setPermShareName(share.name);
        setSharePermissions(share.permissions || []);
        setShowPermissionModal(true);

        try {
            const res = await api.post('/nas/get-permissions', {
                deviceId: selectedDevice.id,
                shareName: share.name
            });
            if (res.data && Array.isArray(res.data.permissions) && res.data.permissions.length > 0) {
                setSharePermissions(res.data.permissions);
            }
        } catch (e) {
            console.warn('Failed to fetch live share permissions:', e);
        }
    };

    const handleAddPermission = () => {
        if (!newPerm.name.trim()) return;
        setSharePermissions([...sharePermissions, { ...newPerm }]);
        setNewPerm({ name: '', type: 'group', access: 'r' });
    };

    const handleRemovePermission = (index) => {
        setSharePermissions(sharePermissions.filter((_, i) => i !== index));
    };

    const handleSavePermissions = async () => {
        try {
            const res = await api.post('/nas/set-permissions', {
                deviceId: selectedDevice.id,
                shareName: permShareName,
                permissions: sharePermissions
            });
            showToast(res.data.message, 'success');
            setShowPermissionModal(false);
            fetchDevices(false);
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to save permissions', 'error');
        }
    };

    return (
        <div style={S.page}>
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>💾 NAS Manager</h1>
                    <p style={S.subtitle}>Unified Storage, Volume Monitor & Share Directory Management</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button style={S.btnO} onClick={() => fetchDevices(true)} disabled={syncing}>
                        {syncing ? '🔄 Syncing...' : '🔄 Sync Status'}
                    </button>
                    {isSuperAdmin && <button style={S.btnP} onClick={openDeviceSettings}>Manage devices →</button>}
                </div>
            </div>

            {loading && devices.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading devices...</div>
            ) : devices.length === 0 ? (
                <div style={{ ...S.section, textAlign: 'center', padding: '60px 20px', borderRadius: 24 }}>
                    <span style={{ fontSize: 48, display: 'block', marginBottom: 16 }}>📁</span>
                    <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 8px 0' }}>No NAS Devices Configured</h2>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 400, margin: '0 auto 24px auto', lineHeight: 1.5 }}>
                        A SuperAdmin must add a NAS device in Settings → File Services → NAS Devices before it can be managed here.
                    </p>
                    {isSuperAdmin && <button style={S.btnP} onClick={openDeviceSettings}>Manage devices →</button>}
                </div>
            ) : (
                <>
                    {/* Storage Summary Dashboard (Enhancement 3) */}
                    {(() => {
                        const totalAllGB = devices.reduce((sum, d) => {
                            const eff = getEffectiveVolumes(d);
                            return sum + (eff.reduce((a, b) => a + b.totalGB, 0) || 0);
                        }, 0);
                        const usedAllGB = devices.reduce((sum, d) => {
                            const eff = getEffectiveVolumes(d);
                            return sum + (eff.reduce((a, b) => a + b.usedGB, 0) || 0);
                        }, 0);
                        const freeAllGB = totalAllGB - usedAllGB;
                        const pctAll = totalAllGB > 0 ? ((usedAllGB / totalAllGB) * 100).toFixed(1) : '0';
                        const onlineCount = devices.filter(d => d.status !== 'offline').length;
                        return (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
                                <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '16px 20px' }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>TOTAL DEVICES</div>
                                    <div style={{ fontSize: 24, fontWeight: 900 }}>{devices.length}</div>
                                    <div style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700, marginTop: 4 }}>{onlineCount} Online</div>
                                </div>
                                <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '16px 20px' }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>TOTAL CAPACITY</div>
                                    <div style={{ fontSize: 22, fontWeight: 900 }}>{formatCapacity(totalAllGB)}</div>
                                </div>
                                <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '16px 20px' }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>FREE SPACE</div>
                                    <div style={{ fontSize: 22, fontWeight: 900, color: freeAllGB < 1 ? 'var(--danger)' : 'var(--success)' }}>{formatCapacity(freeAllGB)}</div>
                                </div>
                                <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '16px 20px' }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>OVERALL USAGE</div>
                                    <div style={{ fontSize: 24, fontWeight: 900, color: parseFloat(pctAll) > 85 ? 'var(--danger)' : 'var(--text-primary)' }}>{pctAll}%</div>
                                    <div style={{ ...S.progressBar, marginTop: 8, height: 6 }}>
                                        <div style={{ height: '100%', width: `${pctAll}%`, background: parseFloat(pctAll) > 85 ? 'var(--danger)' : 'var(--success)', borderRadius: 4 }} />
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Device Cards Grid */}
                    <div style={S.grid}>
                        {devices.map(dev => {
                            const isSelected = selectedDevice?.id === dev.id;
                            const effVols = getEffectiveVolumes(dev);
                            const totalCap = effVols.reduce((a, b) => a + b.totalGB, 0) || 0;
                            const usedCap = effVols.reduce((a, b) => a + b.usedGB, 0) || 0;
                            const usagePct = totalCap > 0 ? (usedCap / totalCap) * 100 : 0;
                            return (
                                <div 
                                    key={dev.id} 
                                    style={{ ...S.card, ...(isSelected ? S.activeCard : {}) }}
                                    onClick={() => setSelectedDevice(dev)}
                                >
                                    <div style={S.cardHeader}>
                                        <span style={{ fontWeight: 800, fontSize: 15 }}>{dev.name}</span>
                                        <span style={{ 
                                            ...S.badge, 
                                            background: dev.type === 'synology' ? 'rgba(59,130,246,0.1)' : dev.type === 'qnap' ? 'rgba(245,158,11,0.1)' : dev.type === 'windows' ? 'rgba(16,185,129,0.1)' : 'rgba(99,102,241,0.1)',
                                            color: dev.type === 'synology' ? '#3b82f6' : dev.type === 'qnap' ? '#f59e0b' : dev.type === 'windows' ? '#10b981' : '#6366f1',
                                            border: `1px solid ${dev.type === 'synology' ? '#3b82f6' : dev.type === 'qnap' ? '#f59e0b' : dev.type === 'windows' ? '#10b981' : '#6366f1'}`
                                        }}>
                                            {dev.type}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                                        <span>IP: {dev.ip}</span>
                                        <span style={{ color: dev.status === 'offline' ? 'var(--danger)' : 'var(--success)', fontWeight: 800 }}>
                                            {dev.status === 'offline' ? '● Offline' : '● Online'}
                                        </span>
                                    </div>
                                    
                                    <div style={{ marginTop: 14 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700 }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Storage Capacity</span>
                                            <span>{totalCap > 0 ? `${formatCapacity(totalCap - usedCap)} free` : 'N/A'}</span>
                                        </div>
                                        <div style={S.progressBar}>
                                            <div style={{ 
                                                ...S.progressFill, 
                                                width: `${usagePct}%`, 
                                                background: usagePct > 85 ? 'var(--danger)' : 'var(--success)' 
                                            }} />
                                        </div>
                                    </div>

                                </div>
                            );
                        })}
                    </div>

                    {/* Selected Device Panel */}
                    {selectedDevice && (
                        <div style={S.section}>
                            <div style={S.secTitle}>
                                <span>📁 Managed Panel: {selectedDevice.name}</span>
                                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>({selectedDevice.ip})</span>
                            </div>

                            {/* Tabs */}
                            <div style={S.tabs}>
                                <button 
                                    style={{ ...S.tabBtn, ...(activeTab === 'shares' ? S.activeTabBtn : {}) }}
                                    onClick={() => setActiveTab('shares')}
                                >
                                    Share Folders ({selectedDevice.shares?.length || 0})
                                </button>
                                <button 
                                    style={{ ...S.tabBtn, ...(activeTab === 'volumes' ? S.activeTabBtn : {}) }}
                                    onClick={() => setActiveTab('volumes')}
                                >
                                    Disk Volumes ({selectedDevice.volumes?.length || 0})
                                </button>
                            </div>

                            {/* Tab Content: Shares */}
                            {activeTab === 'shares' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>Active shared directory directories on this node:</span>
                                        {canEditShares && <button style={S.btnP} onClick={() => setShowCreateModal(true)}>+ Create Share</button>}
                                    </div>

                                    <table style={S.tbl}>
                                        <thead>
                                            <tr>
                                                <th style={S.th}>SHARE NAME</th>
                                                <th style={S.th}>PATH</th>
                                                <th style={S.th}>DESCRIPTION</th>
                                                <th style={S.th}>PERMISSIONS</th>
                                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {selectedDevice.shares?.map((share, i) => (
                                                <tr key={i}>
                                                    <td style={{ ...S.td, fontWeight: 800 }}>{share.name}</td>
                                                    <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{share.path}</td>
                                                    <td style={S.td}>{share.description || '-'}</td>
                                                    <td style={S.td}>
                                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                            {share.permissions?.map((p, idx) => (
                                                                <span key={idx} style={{ padding: '2px 6px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
                                                                    {p.name} ({p.access})
                                                                </span>
                                                            ))}
                                                            {(!share.permissions || share.permissions.length === 0) && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Everyone Read/Write</span>}
                                                        </div>
                                                    </td>
                                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                                        <div style={{ display: 'inline-flex', gap: 8 }}>
                                                            <button style={{ ...S.btnO, padding: '4px 10px', fontSize: 11 }} onClick={() => openPermissions(share)}>🔑 Security</button>
                                                            {canEditShares && <button style={{ ...S.btnO, border: '1px solid var(--danger)', color: 'var(--danger)', padding: '4px 10px', fontSize: 11 }} onClick={() => handleDeleteShare(share.name)}>🗑️ Delete</button>}
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                            {(!selectedDevice.shares || selectedDevice.shares.length === 0) && (
                                                <tr>
                                                    <td colSpan="5" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>{canEditShares ? 'No share folders configured. Click "+ Create Share" to add.' : 'No share folders configured.'}</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {/* Tab Content: Volumes */}
                            {activeTab === 'volumes' && (
                                <div>
                                    <table style={S.tbl}>
                                        <thead>
                                            <tr>
                                                <th style={S.th}>VOLUME NAME</th>
                                                <th style={S.th}>TOTAL CAPACITY</th>
                                                <th style={S.th}>USED SPACE</th>
                                                <th style={S.th}>USAGE (%)</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {selectedDevice.volumes?.map((vol, i) => {
                                                const pct = vol.totalGB > 0 ? ((vol.usedGB / vol.totalGB) * 100).toFixed(1) : '0';
                                                const isShared = isSharedVolume(vol, selectedDevice);
                                                return (
                                                    <tr key={i}>
                                                        <td style={{ ...S.td, fontWeight: 800 }}>
                                                            {vol.name}
                                                            {isShared ? (
                                                                <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 6, fontSize: 10, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid #10b981' }}>
                                                                    📌 Shared Storage
                                                                </span>
                                                            ) : (
                                                                <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 6, fontSize: 10, background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}>
                                                                    System OS
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td style={S.td}>{formatCapacity(vol.totalGB)}</td>
                                                        <td style={S.td}>{formatCapacity(vol.usedGB)}</td>
                                                        <td style={S.td}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                                <div style={{ ...S.progressBar, flex: 1, marginTop: 0, height: 6 }}>
                                                                    <div style={{ width: `${pct}%`, height: '100%', background: parseFloat(pct) > 85 ? 'var(--danger)' : 'var(--success)' }} />
                                                                </div>
                                                                <span style={{ fontSize: 12, fontWeight: 700 }}>{pct}%</span>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* Modal: Create Share Folder */}
            {showCreateModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 450, padding: 24, boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}>
                        <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 0, marginBottom: 20 }}>+ Create New Share Folder</h2>
                        <form onSubmit={handleCreateShare} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Share Name</label>
                                <input style={S.input} value={newShare.name} onChange={e => setNewShare({ ...newShare, name: e.target.value })} placeholder="e.g. Finance" required />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Storage Directory Path</label>
                                <input style={S.input} value={newShare.path} onChange={e => setNewShare({ ...newShare, path: e.target.value })} placeholder={selectedDevice?.type === 'windows' ? 'e.g. D:\\Shares\\Finance' : 'e.g. /volume1/Finance'} required />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Description</label>
                                <input style={S.input} value={newShare.description} onChange={e => setNewShare({ ...newShare, description: e.target.value })} placeholder="Optional description" />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowCreateModal(false)}>Cancel</button>
                                <button type="submit" style={S.btnP}>Create</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Modal: Edit Permissions */}
            {showPermissionModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 500, padding: 24, boxShadow: '0 24px 48px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 20 }}>
                        <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 0 }}>🔑 Manage Permissions: {permShareName}</h2>
                        
                        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                            <table style={S.tbl}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>USER/GROUP</th>
                                        <th style={S.th}>TYPE</th>
                                        <th style={S.th}>ACCESS</th>
                                        <th style={{ ...S.th, textAlign: 'right' }}>REMOVE</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sharePermissions.map((p, idx) => (
                                        <tr key={idx}>
                                            <td style={{ ...S.td, fontWeight: 800 }}>{p.name}</td>
                                            <td style={S.td}>{p.type}</td>
                                            <td style={S.td}>
                                                <span style={{ ...S.badge, background: p.access === 'deny' ? 'rgba(239,68,68,0.1)' : p.access === 'rw' ? 'rgba(16,185,129,0.1)' : 'rgba(59,130,246,0.1)', color: p.access === 'deny' ? 'var(--danger)' : p.access === 'rw' ? 'var(--success)' : 'var(--accent-primary)' }}>
                                                    {p.access === 'deny' ? '⛔ Deny' : p.access === 'rw' ? 'Read/Write' : 'Read Only'}
                                                </span>
                                            </td>
                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                {canEditShares && <button style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 16 }} onClick={() => handleRemovePermission(idx)}>✕</button>}
                                            </td>
                                        </tr>
                                    ))}
                                    {sharePermissions.length === 0 && (
                                        <tr>
                                            <td colSpan="4" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 12 }}>No explicit ACLs. Defaults to Everyone Read/Write.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* Add Permission Form (Operator / SuperAdmin only) */}
                        {canEditShares && <div style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Add Permission Row</span>
                            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                                <input style={S.input} value={newPerm.name} onChange={e => setNewPerm({ ...newPerm, name: e.target.value })} placeholder="User/Group Name" />
                                <select style={S.select} value={newPerm.type} onChange={e => setNewPerm({ ...newPerm, type: e.target.value })}>
                                    <option value="group">Group</option>
                                    <option value="user">User</option>
                                </select>
                                <select style={S.select} value={newPerm.access} onChange={e => setNewPerm({ ...newPerm, access: e.target.value })}>
                                    <option value="r">Read Only</option>
                                    <option value="rw">Read/Write</option>
                                    <option value="deny">Deny (Block Access)</option>
                                </select>
                            </div>
                            <button style={{ ...S.btnO, alignSelf: 'flex-end', padding: '6px 12px', fontSize: 11 }} onClick={handleAddPermission}>+ Add Entry</button>
                        </div>}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                            <button style={S.btnO} onClick={() => setShowPermissionModal(false)}>{canEditShares ? 'Cancel' : 'Close'}</button>
                            {canEditShares && <button style={S.btnP} onClick={handleSavePermissions}>Save ACLs</button>}
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Premium Confirm Modal (Satisfies Rule 5: No native confirm boxes) */}
            {confirmModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 400, padding: 24, boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}>
                        <h3 style={{ fontSize: 16, fontWeight: 900, marginTop: 0, color: 'var(--danger)' }}>⚠️ {confirmModal.title}</h3>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '12px 0 20px 0' }}>{confirmModal.message}</p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                            <button style={S.btnO} onClick={() => setConfirmModal(null)}>Cancel</button>
                            <button style={{ ...S.btnP, background: 'var(--danger)', boxShadow: 'none' }} onClick={confirmModal.onConfirm}>Confirm</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
