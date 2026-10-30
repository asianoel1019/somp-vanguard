import React, { useState, useEffect } from 'react';
import { FiX } from 'react-icons/fi';
import api from '../../api';
import { fieldLabel, changeText, apiErrorText } from './inventoryHistoryUtils';

const LIMIT = 50;

/** Small modal with the change history of one host (GET /hosts/:ip/changes). */
const HostChangesModal = ({ s, ip, onClose }) => {
    const [state, setState] = useState({ loading: true, error: '', changes: [], total: 0 });
    const [offset, setOffset] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setState(p => ({ ...p, loading: true, error: '' }));
        api.get(`/inventory/hosts/${ip}/changes`, { params: { limit: LIMIT, offset } })
            .then(r => { if (!cancelled) setState({ loading: false, error: '', changes: r.data.changes || [], total: r.data.total || 0 }); })
            .catch(e => { if (!cancelled) setState({ loading: false, error: apiErrorText(e, 'Failed to load the host history'), changes: [], total: 0 }); });
        return () => { cancelled = true; };
    }, [ip, offset]);
    return (
        <div style={s.modalOverlay} onClick={onClose}>
            <div style={{ ...s.modal, maxWidth: 620 }} onClick={e => e.stopPropagation()}>
                <div style={s.modalHeader}>
                    <h3 style={{ ...s.overviewTitle, fontSize: 18 }}>Change history of {ip}</h3>
                    <button onClick={onClose} style={s.closeBtn} aria-label="Close"><FiX size={20} /></button>
                </div>
                <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
                    {state.error && <div style={{ padding: 16, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{state.error}</div>}
                    <table style={s.table}>
                        <thead><tr><th style={s.th}>TIME</th><th style={s.th}>FIELD</th><th style={s.th}>CHANGE</th></tr></thead>
                        <tbody>
                            {state.loading ? (
                                <tr><td colSpan="3" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>
                            ) : state.changes.length === 0 ? (
                                <tr><td colSpan="3" style={{ ...s.td, textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>No changes recorded for this host.</td></tr>
                            ) : state.changes.map(c => (
                                <tr key={c.id} style={s.tr}>
                                    <td style={{ ...s.td, fontSize: 12, color: 'var(--text-muted)' }}>{new Date(c.at).toLocaleString()}</td>
                                    <td style={s.td}>{fieldLabel(c.field)}</td>
                                    <td style={s.td}>{changeText(c)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {state.total > LIMIT && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 24px', borderTop: '1px solid var(--border-color)' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{offset + 1}–{Math.min(offset + LIMIT, state.total)} of {state.total}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button style={s.filterBtn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>&lt;</button>
                            <button style={s.filterBtn} disabled={offset + LIMIT >= state.total} onClick={() => setOffset(offset + LIMIT)}>&gt;</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default HostChangesModal;
