import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';

const S = {
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    title: { fontSize: 16, fontWeight: 900, margin: '0 0 16px' },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginTop: 12 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    select: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box', cursor: 'pointer' },
    btnP: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    row: { display: 'flex', gap: 16 },
    chk: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
};

const DEFAULTS = {
    evaluationEnabled: true, rateLimitPerMinute: 10,
    flapping: { transitions: 4, windowMin: 30, stableMin: 30 },
    cooldownMin: 15,
    escalation: { telegram: { enabled: false, chatId: '' }, email: { enabled: false, to: '' }, webhook: { enabled: false, webhookId: '' } },
};

export default function AlertQualitySettings() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isSuperAdmin = user?.role === 'SuperAdmin';
    const [cfg, setCfg] = useState(null);
    const [webhooks, setWebhooks] = useState([]);
    const [errors, setErrors] = useState([]);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        (async () => {
            try {
                const res = await api.get('/alert-quality/settings');
                const d = res.data || {};
                setCfg({
                    ...DEFAULTS, ...d,
                    flapping: { ...DEFAULTS.flapping, ...(d.flapping || {}) },
                    escalation: {
                        telegram: { ...DEFAULTS.escalation.telegram, ...(d.escalation?.telegram || {}) },
                        email: { ...DEFAULTS.escalation.email, ...(d.escalation?.email || {}) },
                        webhook: { ...DEFAULTS.escalation.webhook, ...(d.escalation?.webhook || {}) },
                    },
                });
            } catch (e) {
                setLoadError(e.response?.data?.error || e.message);
            }
            try {
                const wh = await api.get('/webhooks');
                setWebhooks(Array.isArray(wh.data) ? wh.data : []);
            } catch (e) { setWebhooks([]); }
        })();
    }, []);

    if (loadError) return <div style={{ color: '#ef4444' }}>Failed to load: {loadError}</div>;
    if (!cfg) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

    const num = (v) => (v === '' ? '' : Number(v));
    const set = (patch) => setCfg(c => ({ ...c, ...patch }));
    const setFlap = (patch) => setCfg(c => ({ ...c, flapping: { ...c.flapping, ...patch } }));
    const setEsc = (key, patch) => setCfg(c => ({ ...c, escalation: { ...c.escalation, [key]: { ...c.escalation[key], ...patch } } }));
    const ro = !isSuperAdmin;

    const toggleEval = async (checked) => {
        if (!checked) {
            const yes = await showConfirm('With evaluation off, no metric, log or offline alerts will be evaluated or notified. Continue?', 'Turn Off Alert Evaluation');
            if (!yes) return;
        }
        set({ evaluationEnabled: checked });
    };

    const save = async () => {
        setSaving(true); setErrors([]);
        try {
            const res = await api.put('/alert-quality/settings', cfg);
            if (res.data) setCfg(c => ({ ...c, ...res.data }));
            showToast('✅ Alert settings saved', 'success');
        } catch (e) {
            const d = e.response?.data;
            setErrors(d?.errors?.length ? d.errors : [d?.error || e.message]);
        } finally { setSaving(false); }
    };

    const esc = cfg.escalation;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {ro && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Only SuperAdmin can change these settings.</div>}

            <div style={S.card}>
                <h3 style={S.title}>Evaluation &amp; notifications</h3>
                <label style={S.chk}>
                    <input type="checkbox" disabled={ro} checked={cfg.evaluationEnabled} onChange={e => toggleEval(e.target.checked)} />
                    Alert evaluation (master switch) — can be turned off in an emergency; takes effect within 30 seconds
                </label>
                <div style={S.row}>
                    <div style={{ flex: 1 }}>
                        <label style={S.label}>Notification rate limit (per minute)</label>
                        <input type="number" min="1" max="1000" style={S.input} disabled={ro} value={cfg.rateLimitPerMinute} onChange={e => set({ rateLimitPerMinute: num(e.target.value) })} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={S.label}>Cooldown (minutes)</label>
                        <input type="number" min="1" max="1440" style={S.input} disabled={ro} value={cfg.cooldownMin} onChange={e => set({ cooldownMin: num(e.target.value) })} />
                    </div>
                </div>
            </div>

            <div style={S.card}>
                <h3 style={S.title}>Flapping detection</h3>
                <div style={S.row}>
                    <div style={{ flex: 1 }}>
                        <label style={S.label}>Transitions</label>
                        <input type="number" min="2" max="50" style={S.input} disabled={ro} value={cfg.flapping.transitions} onChange={e => setFlap({ transitions: num(e.target.value) })} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={S.label}>Window (min)</label>
                        <input type="number" min="5" max="1440" style={S.input} disabled={ro} value={cfg.flapping.windowMin} onChange={e => setFlap({ windowMin: num(e.target.value) })} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={S.label}>Stable for (min)</label>
                        <input type="number" min="5" max="1440" style={S.input} disabled={ro} value={cfg.flapping.stableMin} onChange={e => setFlap({ stableMin: num(e.target.value) })} />
                    </div>
                </div>
            </div>

            <div style={S.card}>
                <h3 style={S.title}>Escalation destinations</h3>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>When a rule is set to "Escalate if unresolved for N minutes", these destinations are notified.</div>

                <label style={S.chk}><input type="checkbox" disabled={ro} checked={esc.telegram.enabled} onChange={e => setEsc('telegram', { enabled: e.target.checked })} /> Telegram</label>
                <input style={S.input} disabled={ro || !esc.telegram.enabled} placeholder="Chat ID" value={esc.telegram.chatId} onChange={e => setEsc('telegram', { chatId: e.target.value })} />

                <div style={{ marginTop: 18 }}>
                    <label style={S.chk}><input type="checkbox" disabled={ro} checked={esc.email.enabled} onChange={e => setEsc('email', { enabled: e.target.checked })} /> Email</label>
                    <input style={S.input} disabled={ro || !esc.email.enabled} placeholder="Recipients, comma-separated" value={esc.email.to} onChange={e => setEsc('email', { to: e.target.value })} />
                </div>

                <div style={{ marginTop: 18 }}>
                    <label style={S.chk}><input type="checkbox" disabled={ro} checked={esc.webhook.enabled} onChange={e => setEsc('webhook', { enabled: e.target.checked })} /> Webhook</label>
                    <select style={S.select} disabled={ro || !esc.webhook.enabled} value={esc.webhook.webhookId} onChange={e => setEsc('webhook', { webhookId: e.target.value })}>
                        <option value="">Select a webhook</option>
                        {webhooks.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                </div>
            </div>

            {errors.length > 0 && (
                <div style={{ background: 'rgba(255,59,48,0.1)', border: '1px solid rgba(255,59,48,0.3)', color: '#ff3b30', padding: '12px 16px', borderRadius: 12, fontSize: 13, fontWeight: 600 }}>
                    {errors.map((er, i) => <div key={i}>• {er}</div>)}
                </div>
            )}

            {isSuperAdmin && (
                <div>
                    <button style={S.btnP} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Alert Settings'}</button>
                </div>
            )}
        </div>
    );
}
