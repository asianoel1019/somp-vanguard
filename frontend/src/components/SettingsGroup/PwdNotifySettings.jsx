// Settings > System Settings > AD Hierarchy & SearchBase: the "Password expiry notifications" card.
// Values are PWD_NOTIFY_* settings saved with Save Changes; preview and run now live in AD Control > Reports,
// which work on the saved settings.
import React, { useEffect, useState } from 'react';
import api from '../../api';
import { pwdNotifyProblems, normalizeDays, pwdNotifyState, enabledOn, testModeOn, PWD_NOTIFY_DEFAULTS } from './pwdNotifySettingsUtils';

const STATE_PILL = {
    off: { text: 'Off', color: 'var(--text-muted)', bg: 'rgba(127,127,127,0.12)' },
    test: { text: 'Test mode', color: '#b45309', bg: 'rgba(245,158,11,0.15)' },
    on: { text: 'On', color: '#059669', bg: 'rgba(16,185,129,0.15)' },
};

function Switch({ checked, onChange, label }) {
    return (
        <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
            style={{ width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
                background: checked ? 'var(--accent-primary)' : 'rgba(127,127,127,0.35)', transition: 'background 0.2s' }}>
            <span style={{ position: 'absolute', top: 3, left: checked ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </button>
    );
}

export default function PwdNotifySettings({ sysConfig, onChange, S, onOpenMailRelay }) {
    const [lastRun, setLastRun] = useState(null);
    const problems = pwdNotifyProblems(sysConfig);
    const { state, mailReady } = pwdNotifyState(sysConfig);
    const pill = STATE_PILL[state];

    useEffect(() => {
        let alive = true;
        api.get('/ad/pwd-notify/status')
            .then(r => { if (alive) setLastRun((r.data.runs || [])[0] || null); })
            .catch(() => { /* no AD Control access or not reachable: the card works without the last run */ });
        return () => { alive = false; };
    }, []);

    const label = (key, hint) => (
        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
            {key}{hint && <span style={{ fontWeight: 'normal' }}> ({hint})</span>}
        </label>
    );
    const error = (key) => problems[key] && <div role="alert" style={{ fontSize: 11, color: 'var(--danger, #ef4444)', marginTop: 4 }}>{problems[key]}</div>;
    const input = (key, props = {}) => (
        <input type="text" style={{ ...S.input, ...(problems[key] ? { borderColor: 'var(--danger, #ef4444)' } : {}) }} value={sysConfig[key] || ''}
            onChange={e => onChange(key, e.target.value)} aria-invalid={!!problems[key]} {...props} />
    );
    const ouFallback = sysConfig.AD_OU_SEARCH ? `Empty: uses AD_OU_SEARCH (${sysConfig.AD_OU_SEARCH})` : 'Empty: the whole domain';
    const adminFallback = sysConfig.MAIL_RELAY_RECIPIENT ? `Empty: MAIL_RELAY_RECIPIENT (${sysConfig.MAIL_RELAY_RECIPIENT})` : 'Empty: MAIL_RELAY_RECIPIENT (not set)';

    return (
        <div style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <h3 style={{ ...S.tblTitle, margin: 0 }}>Password expiry notifications</h3>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 999, color: pill.color, background: pill.bg }}>{pill.text}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                Every day, mails users whose password expires in one of the configured days, then mails a summary to the administrator.
            </div>

            {!mailReady && (
                <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 10, marginBottom: 16, color: '#b45309', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' }}>
                    Mail Relay is not configured (MAIL_RELAY_SERVER and MAIL_RELAY_SENDER), so no mail can be sent.{' '}
                    <button type="button" onClick={onOpenMailRelay} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline' }}>Open Mail Relay</button>
                </div>
            )}

            <div style={S.gridRow}>
                <div style={{ ...S.fieldBlock, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Switch label="PWD_NOTIFY_ENABLED" checked={enabledOn(sysConfig)} onChange={v => onChange('PWD_NOTIFY_ENABLED', v ? 'true' : 'false')} />
                    <div>
                        {label('PWD_NOTIFY_ENABLED')}
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Run every day</div>
                    </div>
                </div>
                <div style={{ ...S.fieldBlock, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Switch label="PWD_NOTIFY_TEST_MODE" checked={testModeOn(sysConfig)} onChange={v => onChange('PWD_NOTIFY_TEST_MODE', v ? 'true' : 'false')} />
                    <div>
                        {label('PWD_NOTIFY_TEST_MODE')}
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>All user notices go to the summary recipient instead</div>
                    </div>
                </div>
            </div>

            <div style={S.gridRow}>
                <div style={S.fieldBlock}>
                    {label('PWD_NOTIFY_TIME', 'daily run time')}
                    <input type="time" style={{ ...S.input, ...(problems.PWD_NOTIFY_TIME ? { borderColor: 'var(--danger, #ef4444)' } : {}) }}
                        value={sysConfig.PWD_NOTIFY_TIME || PWD_NOTIFY_DEFAULTS.time} onChange={e => onChange('PWD_NOTIFY_TIME', e.target.value)} />
                    {error('PWD_NOTIFY_TIME')}
                </div>
                <div style={S.fieldBlock}>
                    {label('PWD_NOTIFY_DAYS', 'days left when a notice is sent')}
                    {input('PWD_NOTIFY_DAYS', { placeholder: PWD_NOTIFY_DEFAULTS.days, onBlur: e => onChange('PWD_NOTIFY_DAYS', normalizeDays(e.target.value)) })}
                    {error('PWD_NOTIFY_DAYS')}
                </div>
            </div>

            <div style={S.fieldBlock}>
                {label('PWD_NOTIFY_OUS', 'OU DNs separated by ;')}
                {input('PWD_NOTIFY_OUS', { placeholder: ouFallback })}
                {error('PWD_NOTIFY_OUS')}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Only enabled accounts whose password can expire are checked, including sub-OUs.</div>
            </div>

            <div style={S.gridRow}>
                <div style={S.fieldBlock}>
                    {label('PWD_NOTIFY_ADMIN_TO', 'summary recipient')}
                    {input('PWD_NOTIFY_ADMIN_TO', { placeholder: adminFallback })}
                    {error('PWD_NOTIFY_ADMIN_TO')}
                </div>
                <div style={S.fieldBlock}>
                    {label('PWD_NOTIFY_CHANGE_URL', 'optional change-password page')}
                    {input('PWD_NOTIFY_CHANGE_URL', { placeholder: 'https://passwordreset.example.test' })}
                    {error('PWD_NOTIFY_CHANGE_URL')}
                </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                Preview who would be notified and run it now in AD Control &gt; Reports (uses the saved settings).
                {lastRun && (
                    <> Last run: {new Date(lastRun.at).toLocaleString()}{lastRun.testMode ? ' (test mode)' : ''} — sent {lastRun.sent.length}, failed {lastRun.failed.length}, no email {lastRun.noEmail.length}{lastRun.error ? `, error: ${lastRun.error}` : ''}.</>
                )}
            </div>
        </div>
    );
}
