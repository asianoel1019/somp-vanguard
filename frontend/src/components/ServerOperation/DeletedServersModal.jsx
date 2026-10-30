import React, { useState, useEffect, useCallback } from 'react';
import { FiRotateCcw, FiRefreshCw, FiX } from 'react-icons/fi';
import api from '../../api';

const S = {
    overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    modal: { width: 640, maxWidth: '92%', maxHeight: '85vh', overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,0.5)', padding: 22 },
    btn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontWeight: 700, fontSize: 12, cursor: 'pointer' },
    btnPrimary: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--accent-primary)', color: '#fff', border: '1px solid var(--accent-primary)', fontWeight: 700, fontSize: 12, cursor: 'pointer' },
    th: { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' },
    td: { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.04)' }
};

/** Lists servers deleted from Server List (GET /server-list/deleted) with a confirmed Restore action. */
export default function DeletedServersModal({ isOpen, onClose, onRestored, showToast }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmIp, setConfirmIp] = useState(null);
    const [restoring, setRestoring] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get('/server-list/deleted');
            setRows(res.data?.servers || []);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load deleted servers');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) { setConfirmIp(null); load(); }
    }, [isOpen, load]);

    if (!isOpen) return null;

    const restore = async (ip) => {
        setRestoring(true);
        try {
            await api.post(`/server-list/${encodeURIComponent(ip)}/restore`);
            showToast?.(`Restored server ${ip}`, 'success');
            setConfirmIp(null);
            await load();
            onRestored?.(ip);
        } catch (err) {
            showToast?.(err.response?.data?.error || 'Failed to restore server', 'error');
        } finally {
            setRestoring(false);
        }
    };

    return (
        <div style={S.overlay} onClick={() => !restoring && onClose()}>
            <div style={S.modal} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Deleted servers</h3>
                    <button type="button" style={S.btn} onClick={onClose} disabled={restoring}><FiX size={14} /> Close</button>
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
                    Restoring brings the Server List entry back. The Scout monitor and Prometheus target return when the agent reports again or via the existing sync.
                </p>
                {loading && <div style={{ color: 'var(--text-muted)' }}><FiRefreshCw className="spin" size={13} /> Loading...</div>}
                {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}
                {!loading && !error && rows.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No deleted servers.</div>}
                {rows.length > 0 && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr><th style={S.th}>IP</th><th style={S.th}>Hostname</th><th style={S.th}>Deleted at</th><th style={S.th}>Deleted by</th><th style={S.th}></th></tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.ip}>
                                    <td style={S.td}>{r.ip}</td>
                                    <td style={S.td}>{r.hostname || '-'}</td>
                                    <td style={S.td}>{r.deletedAt ? new Date(r.deletedAt).toLocaleString() : '-'}</td>
                                    <td style={S.td}>{r.deletedBy || '-'}</td>
                                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                        {confirmIp === r.ip ? (
                                            <>
                                                <span style={{ fontSize: 12, marginRight: 8 }}>Restore {r.ip}?</span>
                                                <button type="button" style={S.btnPrimary} disabled={restoring} onClick={() => restore(r.ip)}>
                                                    {restoring ? <FiRefreshCw className="spin" size={12} /> : <FiRotateCcw size={12} />} Confirm
                                                </button>{' '}
                                                <button type="button" style={S.btn} disabled={restoring} onClick={() => setConfirmIp(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <button type="button" style={S.btn} onClick={() => setConfirmIp(r.ip)}><FiRotateCcw size={12} /> Restore</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
