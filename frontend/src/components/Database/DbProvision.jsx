import React, { useState, useEffect } from 'react';
import api from '../../api';
import { normalizeEnvs, defaultEnv } from '../../utils/environments';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    splitView: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 24, alignItems: 'flex-start' },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,0.2)', backdropFilter: 'blur(12px)' },
    cardTitle: { fontSize: 16, fontWeight: 800, margin: '0 0 20px 0', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 },
    formGroup: { marginBottom: 16 },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', display: 'block', marginBottom: 6 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' },
    btnP: { width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '12px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    
    // Tab styles
    tabs: { display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 },
    tab: (active) => ({ padding: '6px 16px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--border-color)', background: active ? 'var(--accent-primary)' : 'transparent', color: active ? '#fff' : 'var(--text-secondary)', transition: 'all 0.2s' }),

    // Table Styles
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)' },
    td: { padding: '12px 16px', verticalAlign: 'middle', fontSize: 13 },
    
    badgePending: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' },
    badgeApproved: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' },
    badgeRejected: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' },
    
    actionBtn: { padding: '6px 12px', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer', marginRight: 8 },
    btnApprove: { background: 'var(--success)', color: '#fff' },
    btnReject: { background: 'var(--danger)', color: '#fff' },

    // Confirmation Modals
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, width: 440, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', backdropFilter: 'blur(16px)' },
    modalBtns: { display: 'flex', gap: 12, marginTop: 24 },
    btnConfirmP: { flex: 1, padding: '10px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, cursor: 'pointer' },
    btnConfirmD: { flex: 1, padding: '10px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, cursor: 'pointer' },
    btnCancel: { flex: 1, padding: '10px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontWeight: 800, cursor: 'pointer' }
};

const DbProvision = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    
    const [requests, setRequests] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Active status filter tab: 'pending', 'approved', 'rejected', or 'all'
    const [activeTab, setActiveTab] = useState('pending');

    // Action confirm modals states
    const [showConfirmModal, setShowConfirmModal] = useState(null); // { request, action: 'approve' | 'reject' }
    const [infoModal, setInfoModal] = useState(null); // { title: '', message: '', type: 'success' | 'error' }
    const [rejectReasonText, setRejectReasonText] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    
    const [formData, setFormData] = useState({
        name: '', engine: 'MySQL', environment: '', size: 'Small', reason: ''
    });

    const loadEnvironments = async () => {
        try {
            const res = await api.get('/environments');
            const envs = normalizeEnvs(res.data);
            setEnvironments(envs);
            // pre-select the isDefault environment (the form holds the environment id)
            const def = defaultEnv(envs);
            if (def) setFormData(prev => ({ ...prev, environment: prev.environment || def.id }));
        } catch (e) { console.error('Failed to load envs:', e); }
    };

    const loadRequests = async () => {
        try {
            const res = await api.get('/database/provision');
            if (res.data.success) {
                setRequests(res.data.requests || []);
            }
        } catch (e) {
            console.error('Failed to load provisioning requests:', e);
        }
    };

    useEffect(() => {
        loadEnvironments();
        loadRequests();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            await api.post('/database/provision', formData);
            setInfoModal({ title: 'Success', message: 'Request submitted successfully!', type: 'success' });
            setFormData({ name: '', engine: 'MySQL', environment: (defaultEnv(environments) || {}).id || '', size: 'Small', reason: '' });
            loadRequests();
        } catch (e) {
            setInfoModal({ title: 'Error', message: 'Failed to submit request', type: 'error' });
            console.error(e);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleConfirmStatusUpdate = async () => {
        if (!showConfirmModal) return;
        const { request, action } = showConfirmModal;
        setErrorMsg('');

        try {
            const res = await api.put(`/database/provision/${request.id}/status`, {
                status: action === 'approve' ? 'approved' : 'rejected',
                rejectReason: action === 'reject' ? rejectReasonText : undefined
            });
            if (res.data.success) {
                setShowConfirmModal(null);
                setRejectReasonText('');
                loadRequests();
            } else {
                setErrorMsg(res.data.error || 'Failed to update status');
            }
        } catch (e) {
            setErrorMsg(e.response?.data?.error || e.message || 'Failed to update status');
            console.error(e);
        }
    };

    const getStatusBadge = (status) => {
        if (status === 'approved') return <span style={S.badgeApproved}>APPROVED</span>;
        if (status === 'rejected') return <span style={S.badgeRejected}>REJECTED</span>;
        return <span style={S.badgePending}>PENDING</span>;
    };

    // Filter list entries based on active selector tab
    const filteredRequests = requests.filter(req => {
        if (activeTab === 'all') return true;
        return req.status === activeTab;
    });

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Self-Service Provisioning</h1>
                    <p style={S.subtitle}>Request and approve new database instances or schemas</p>
                </div>
            </div>

            <div style={S.splitView}>
                {/* Request Form */}
                <div style={S.card}>
                    <h2 style={S.cardTitle}>New Provisioning Request</h2>
                    <form onSubmit={handleSubmit}>
                        <div style={S.formGroup}>
                            <label style={S.label}>Database Name</label>
                            <input 
                                type="text" 
                                style={S.input} 
                                value={formData.name} 
                                onChange={e => setFormData({...formData, name: e.target.value})} 
                                placeholder="e.g. users_db" 
                                required 
                            />
                        </div>
                        <div style={S.formGroup}>
                            <label style={S.label}>Engine</label>
                            <select style={S.input} value={formData.engine} onChange={e => setFormData({...formData, engine: e.target.value})}>
                                <option value="MySQL">MySQL / MariaDB</option>
                                <option value="PostgreSQL">PostgreSQL</option>
                                <option value="SQLServer">SQL Server</option>
                                <option value="SQLite">SQLite (本地檔案型)</option>
                            </select>
                        </div>
                        <div style={S.formGroup}>
                            <label style={S.label}>Environment</label>
                            <select style={S.input} value={formData.environment} onChange={e => setFormData({...formData, environment: e.target.value})}>
                                <option value="" disabled>Choose an environment...</option>
                                {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                            </select>
                        </div>
                        <div style={S.formGroup}>
                            <label style={S.label}>Size/Tier</label>
                            <select style={S.input} value={formData.size} onChange={e => setFormData({...formData, size: e.target.value})}>
                                <option value="Small">Small (2 vCPU, 4GB RAM)</option>
                                <option value="Medium">Medium (4 vCPU, 16GB RAM)</option>
                                <option value="Large">Large (8 vCPU, 32GB RAM)</option>
                            </select>
                        </div>
                        <div style={S.formGroup}>
                            <label style={S.label}>Justification</label>
                            <textarea 
                                style={{ ...S.input, minHeight: 80, resize: 'vertical' }} 
                                value={formData.reason} 
                                onChange={e => setFormData({...formData, reason: e.target.value})} 
                                placeholder="Why do you need this database?" 
                                required 
                            />
                        </div>
                        <button type="submit" style={S.btnP} disabled={isSubmitting}>
                            {isSubmitting ? 'Submitting...' : 'Submit Request'}
                        </button>
                    </form>
                </div>

                {/* Request List */}
                <div style={S.card}>
                    <h2 style={S.cardTitle}>Recent Requests</h2>

                    {/* Filter Tabs */}
                    <div style={S.tabs}>
                        <button style={S.tab(activeTab === 'pending')} onClick={() => setActiveTab('pending')}>Pending</button>
                        <button style={S.tab(activeTab === 'approved')} onClick={() => setActiveTab('approved')}>Approved</button>
                        <button style={S.tab(activeTab === 'rejected')} onClick={() => setActiveTab('rejected')}>Rejected</button>
                        <button style={S.tab(activeTab === 'all')} onClick={() => setActiveTab('all')}>All</button>
                    </div>

                    <div style={{ overflowX: 'auto' }}>
                        <table style={S.tbl}>
                            <thead>
                                <tr>
                                    <th style={S.th}>DB NAME</th>
                                    <th style={S.th}>ENV / ENGINE</th>
                                    <th style={S.th}>REQUESTER</th>
                                    <th style={S.th}>STATUS</th>
                                    {role === 'SuperAdmin' && <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {filteredRequests.slice().reverse().map(req => (
                                    <tr key={req.id} style={S.tr}>
                                        <td style={{ ...S.td, fontWeight: 700 }}>
                                            {req.name}
                                            <br/>
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{req.size}</span>
                                            {req.status === 'rejected' && req.rejectReason && (
                                                <div style={{ fontSize: 11, color: 'var(--danger)', fontStyle: 'italic', marginTop: 4 }}>
                                                    Reason: {req.rejectReason}
                                                </div>
                                            )}
                                        </td>
                                        <td style={S.td}>{req.environment} / {req.engine}</td>
                                        <td style={S.td}>{req.requester}<br/><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(req.requestDate).toLocaleDateString()}</span></td>
                                        <td style={S.td}>{getStatusBadge(req.status)}</td>
                                        {role === 'SuperAdmin' && (
                                            <td style={{ ...S.td, textAlign: 'right' }}>
                                                {req.status === 'pending' && (
                                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                                        <button style={{ ...S.actionBtn, ...S.btnApprove, marginRight: 0 }} onClick={() => setShowConfirmModal({ request: req, action: 'approve' })}>Approve</button>
                                                        <button style={{ ...S.actionBtn, ...S.btnReject, marginRight: 0 }} onClick={() => setShowConfirmModal({ request: req, action: 'reject' })}>Reject</button>
                                                    </div>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                ))}
                                {filteredRequests.length === 0 && (
                                    <tr>
                                        <td colSpan={role === 'SuperAdmin' ? 5 : 4} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                                            No database requests found in this section.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Custom confirmation action modal */}
            {showConfirmModal && (
                <div style={S.overlay} onClick={() => { setShowConfirmModal(null); setRejectReasonText(''); setErrorMsg(''); }}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: showConfirmModal.action === 'approve' ? 'var(--success)' : 'var(--danger)' }}>
                            {showConfirmModal.action === 'approve' ? '👍 Approve Database Provisioning' : '⚠️ Reject Database Request'}
                        </h2>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
                            Are you sure you want to {showConfirmModal.action === 'approve' ? 'Approve' : 'Reject'} the provisioning request for database <strong>{showConfirmModal.request.name}</strong>?
                            <br/><br/>
                            <strong>Details:</strong>
                            <br/>
                            • Engine: {showConfirmModal.request.engine}
                            <br/>
                            • Environment: {showConfirmModal.request.environment}
                            <br/>
                            • Size: {showConfirmModal.request.size}
                            <br/>
                            • Requester: {showConfirmModal.request.requester}
                        </p>

                        {/* Rejection comment field */}
                        {showConfirmModal.action === 'reject' && (
                            <div style={S.formGroup}>
                                <label style={S.label}>Rejection Justification</label>
                                <textarea
                                    style={{ ...S.input, minHeight: 60, resize: 'vertical' }}
                                    placeholder="Explain why this request is being rejected..."
                                    value={rejectReasonText}
                                    onChange={e => setRejectReasonText(e.target.value)}
                                    required
                                />
                            </div>
                        )}

                        {errorMsg && (
                            <div style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 'bold', marginBottom: 12 }}>
                                ❌ {errorMsg}
                            </div>
                        )}

                        <div style={S.modalBtns}>
                            <button style={S.btnCancel} onClick={() => { setShowConfirmModal(null); setRejectReasonText(''); setErrorMsg(''); }}>Cancel</button>
                            <button
                                style={showConfirmModal.action === 'approve' ? S.btnConfirmP : S.btnConfirmD}
                                onClick={handleConfirmStatusUpdate}
                            >
                                Confirm Action
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Info Modal */}
            {infoModal && (
                <div style={S.overlay} onClick={() => setInfoModal(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: infoModal.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
                            {infoModal.type === 'success' ? '✅ ' : '❌ '} {infoModal.title}
                        </h2>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
                            {infoModal.message}
                        </p>
                        <div style={S.modalBtns}>
                            <button style={S.btnCancel} onClick={() => setInfoModal(null)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DbProvision;
