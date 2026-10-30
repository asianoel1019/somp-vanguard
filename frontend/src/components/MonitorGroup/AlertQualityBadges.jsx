import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { badgesFor } from './alertQualityUtils';

const pill = { display: 'inline-block', marginLeft: 6, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: 'rgba(148,163,184,0.15)', color: 'var(--text-secondary, var(--text-muted))', whiteSpace: 'nowrap' };

export function AlertBadges({ alert }) {
    return badgesFor(alert).map((b, i) => (
        <span key={i} style={pill} title={b.title}>{b.icon ? `${b.icon} ` : ''}{b.label}</span>
    ));
}

export function MuteButton({ alert, onMuted, style, canEdit = false }) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const { showToast } = useToast();
    const wrapRef = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);
    const mute = async (hours) => {
        setBusy(true);
        try {
            await api.post('/alert-quality/mute', { alertId: alert.id, hours });
            showToast(`✅ Muted for ${hours} h`, 'success');
            setOpen(false);
            if (onMuted) onMuted();
        } catch (e) {
            const msg = e.response?.data?.error || e.message;
            showToast(`Mute failed: ${msg}`, 'error');
        } finally { setBusy(false); }
    };
    if (!canEdit) return null;
    const { margin, marginLeft, marginRight, marginTop, marginBottom, ...menuStyle } = style || {};
    return (
        <span ref={wrapRef} style={{ position: 'relative', display: 'inline-block', marginRight: 6 }}>
            <button style={style} disabled={busy} onClick={() => setOpen(o => !o)} title="Stop notifications for this host and rule for a period of time">🔕 Mute</button>
            {open && (
                <span style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 4, display: 'flex', gap: 4 }}>
                    {[1, 4, 24].map(h => <button key={h} style={{ ...menuStyle, whiteSpace: 'nowrap' }} disabled={busy} onClick={() => mute(h)}>{h} h</button>)}
                </span>
            )}
        </span>
    );
}
