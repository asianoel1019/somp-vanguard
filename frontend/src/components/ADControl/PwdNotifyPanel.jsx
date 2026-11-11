// AD Control > Reports: password expiry notifications — the settings as they apply, the recent runs, a preview of
// today's notices (Operator+) and Run now (SuperAdmin). Settings live in Settings > System Settings > AD Hierarchy.
import React, { useCallback, useEffect, useState } from 'react';
import { FiMail, FiEye, FiSend, FiRefreshCw } from 'react-icons/fi';
import api from '../../api';
import { formatAdDate } from './adModel';
import { Btn, Banner, Pill, DataTable, ConfirmModal } from './Shared';

const errorText = (e, fallback) => e?.response?.data?.error || fallback;
const accountColumns = [
    { key: 'sam', label: 'Account' },
    { key: 'name', label: 'Name' },
    { key: 'mail', label: 'Email', render: r => r.mail || <span style={{ color: 'var(--text-muted)' }}>none</span> },
    { key: 'daysLeft', label: 'Days left' },
    { key: 'expires', label: 'Expires', render: r => formatAdDate(r.expires) },
];

export default function PwdNotifyPanel() {
    const role = (JSON.parse(localStorage.getItem('user') || '{}').role) || 'Viewer';
    const [status, setStatus] = useState(null);
    const [hidden, setHidden] = useState(false);
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(null);
    const [confirmRun, setConfirmRun] = useState(false);
    const [openRun, setOpenRun] = useState(null);

    const fetchStatus = () => api.get('/ad/pwd-notify/status');
    const applyStatus = useCallback((r) => setStatus(r.data), []);
    const statusFailed = useCallback((e) => {
        if (e?.response?.status === 403) setHidden(true);
        else setMessage({ type: 'error', text: errorText(e, 'Could not read the notification status.') });
    }, []);
    useEffect(() => { fetchStatus().then(applyStatus).catch(statusFailed); }, [applyStatus, statusFailed]);
    const reload = () => fetchStatus().then(applyStatus).catch(statusFailed);

    if (hidden) return null;
    const cfg = status && status.config;

    const runPreview = async () => {
        setBusy(true); setMessage(null);
        try {
            const r = await api.post('/ad/pwd-notify/preview');
            setPreview(r.data);
        } catch (e) {
            setMessage({ type: 'error', text: errorText(e, 'The preview could not run.') });
        } finally { setBusy(false); }
    };
    const runNow = async () => {
        setConfirmRun(false); setBusy(true); setMessage(null);
        try {
            const r = await api.post('/ad/pwd-notify/run');
            const d = r.data;
            setMessage({ type: d.error || d.failed.length ? 'error' : 'success', text: `${d.testMode ? 'Test mode: ' : ''}sent ${d.sent.length}, failed ${d.failed.length}, no email ${d.noEmail.length}. Summary: ${d.summary}.${d.error ? ` ${d.error}` : ''}` });
            setPreview(null);
            reload();
        } catch (e) {
            setMessage({ type: 'error', text: errorText(e, 'The run failed.') });
        } finally { setBusy(false); }
    };

    const stateTone = !cfg ? 'default' : !cfg.enabled ? 'default' : cfg.testMode ? 'warning' : 'success';
    const stateText = !cfg ? '' : !cfg.enabled ? 'Off' : cfg.testMode ? 'Test mode' : 'On';

    return (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px', background: 'var(--bg-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                <FiMail />
                <strong style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Password expiry notifications</strong>
                {cfg && <Pill tone={stateTone}>{stateText}</Pill>}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '6px' }}>
                    <Btn small icon={<FiRefreshCw />} label="Refresh" onClick={reload} disabled={busy} />
                    <Btn small icon={<FiEye />} label={busy ? 'Working…' : 'Preview today'} onClick={runPreview} disabled={busy || !cfg} />
                    {role === 'SuperAdmin' && <Btn small tone="primary" icon={<FiSend />} label="Run now" onClick={() => setConfirmRun(true)} disabled={busy || !cfg} />}
                </span>
            </div>
            {cfg && (
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    Daily at {cfg.time || '—'} · days {cfg.days ? cfg.days.join(', ') : '—'} · scope {cfg.ous.length ? `${cfg.ous.length} OU(s) from ${cfg.ousSource}` : 'whole domain'} ·
                    summary to {cfg.adminTo.length ? cfg.adminTo.join(', ') : 'nobody'}{cfg.adminTo.length ? ` (${cfg.adminToSource})` : ''} · at most {status.maxMails} mails a run.
                    Change these in Settings &gt; System Settings &gt; AD Hierarchy &amp; SearchBase.
                </div>
            )}
            {cfg && cfg.errors.length > 0 && <Banner message={{ type: 'error', text: `Settings need fixing before a run: ${cfg.errors.join('; ')}` }} />}
            <div style={{ marginTop: '8px' }}><Banner message={message} onClose={() => setMessage(null)} /></div>

            {preview && (
                <div style={{ marginTop: '8px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
                        Today {preview.testMode ? '(test mode: these would go to the summary recipient)' : ''}: {preview.due.length} to notify of {preview.scanned} checked
                        {preview.noEmail.length ? `, ${preview.noEmail.length} without email` : ''}{preview.overLimit.length ? `, ${preview.overLimit.length} over the limit` : ''}
                    </div>
                    <DataTable columns={accountColumns} rows={[...preview.due, ...preview.noEmail]} rowKey={r => r.sam} empty="Nobody is due today." />
                </div>
            )}

            {status && status.runs.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>Recent runs</div>
                    <DataTable rowKey={r => r.at} rows={status.runs.slice(0, 10)} columns={[
                        { key: 'at', label: 'When', render: r => formatAdDate(r.at) },
                        { key: 'trigger', label: 'Started by', render: r => (r.trigger === 'schedule' ? 'Schedule' : r.by) },
                        { key: 'mode', label: 'Mode', render: r => (r.testMode ? <Pill tone="warning">Test</Pill> : <Pill tone="success">Live</Pill>) },
                        { key: 'counts', label: 'Result', render: r => `checked ${r.scanned}, sent ${r.sent.length}, failed ${r.failed.length}, no email ${r.noEmail.length}` },
                        { key: 'summary', label: 'Summary mail', render: r => r.summary || '' },
                        { key: 'detail', label: '', render: r => <Btn small label={openRun === r.at ? 'Hide' : 'Details'} onClick={() => setOpenRun(openRun === r.at ? null : r.at)} /> },
                    ]} />
                    {status.runs.filter(r => r.at === openRun).map(r => (
                        <div key={r.at} style={{ marginTop: '8px' }}>
                            {r.error && <Banner message={{ type: 'error', text: r.error }} />}
                            <DataTable rowKey={x => `${x.sam}-${x.status}`} empty="No accounts in this run."
                                rows={[...r.sent.map(x => ({ ...x, status: 'Sent' })), ...r.failed.map(x => ({ ...x, status: 'Failed' })), ...r.noEmail.map(x => ({ ...x, status: 'No email' })), ...(r.overLimit || []).map(x => ({ ...x, status: 'Over the limit' }))]}
                                columns={[...accountColumns, { key: 'status', label: 'Result', render: x => <Pill tone={x.status === 'Sent' ? 'success' : x.status === 'Failed' ? 'danger' : 'warning'}>{x.status}</Pill> }, { key: 'error', label: 'Error' }]} />
                        </div>
                    ))}
                </div>
            )}

            {confirmRun && (
                <ConfirmModal title="Run password expiry notices now" confirmLabel="Run now" busy={busy} onCancel={() => setConfirmRun(false)} onConfirm={runNow}>
                    {cfg && cfg.testMode
                        ? 'Test mode is on: every notice goes to the summary recipient, no user is mailed.'
                        : 'Test mode is off: the users due today are mailed now, and today\'s scheduled run will not mail them again.'}
                </ConfirmModal>
            )}
        </div>
    );
}
