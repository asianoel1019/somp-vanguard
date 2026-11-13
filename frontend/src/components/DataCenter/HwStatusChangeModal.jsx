import React, { useState } from 'react';
import api from '../../api';
import { RESOLUTIONS } from './hwIssueUtils';

const STATUS_TEXT = { Open: 'Reopen', Processing: 'Move to Processing', Closed: 'Close' };

// Asks for the note (and, when closing, the resolution) of a status change made by dragging a card.
export default function HwStatusChangeModal({ issue, to, onCancel, onSaved, onError }) {
    const [note, setNote] = useState('');
    const [resolution, setResolution] = useState('');
    const [saving, setSaving] = useState(false);

    const submit = (e) => {
        e.preventDefault();
        if (!note.trim()) return;
        setSaving(true);
        const body = { type: to, note: note.trim() };
        if (to === 'Closed' && resolution) body.resolution = resolution;
        api.post(`/rack/issues/${issue.id}/notes`, body)
            .then(res => onSaved(res.data.issue))
            .catch(err => { setSaving(false); onError(err.response?.data?.error || 'Failed to update issue.'); });
    };

    return (
        <div className="drawer-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
            <form className="glass-panel" onSubmit={submit} role="dialog" aria-modal="true" aria-label={`${STATUS_TEXT[to]} ${issue.deviceName}`}
                style={{ width: 'min(460px, 92vw)', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, borderRadius: 12 }}>
                <h3 style={{ margin: 0, fontSize: 17 }}>{STATUS_TEXT[to]}: {issue.deviceName}</h3>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {issue.status} → <strong>{to}</strong>. The note is added to the process timeline.
                </div>
                {to === 'Closed' && (
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                        Resolution
                        <select value={resolution} onChange={e => setResolution(e.target.value)} style={{ padding: 8, borderRadius: 6 }}>
                            <option value="">(not specified)</option>
                            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </label>
                )}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                    Note (required)
                    <textarea value={note} onChange={e => setNote(e.target.value)} rows={4} maxLength={2000} autoFocus required
                        placeholder={to === 'Closed' ? 'What was done to fix it?' : 'What is happening now?'}
                        style={{ padding: 8, borderRadius: 6, resize: 'vertical' }} />
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={saving || !note.trim()}>{saving ? 'Saving...' : STATUS_TEXT[to]}</button>
                </div>
            </form>
        </div>
    );
}
