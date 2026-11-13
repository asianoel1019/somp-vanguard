// Small building blocks of the Server Provision page (styles in provision.css).
import React from 'react';
import { TbAlertTriangle, TbCircleCheck, TbInfoCircle, TbCircleX } from 'react-icons/tb';
import { jobStatusTone, toneColor } from './provisionUtils';
import './provision.css';

/** Segmented control: options [{ id, label, icon? }]. */
export function Segmented({ options, value, onChange, disabled, small, ariaLabel }) {
    return (
        <div className={`pv-seg${small ? ' is-small' : ''}`} role="tablist" aria-label={ariaLabel}>
            {options.map(o => {
                const Icon = o.icon;
                return (
                    <button key={o.id} type="button" role="tab" aria-selected={value === o.id}
                        className={value === o.id ? 'is-active' : ''} disabled={disabled} onClick={() => onChange(o.id)}>
                        {Icon && <Icon size={small ? 14 : 16} aria-hidden="true" />}{o.label}
                    </button>
                );
            })}
        </div>
    );
}

/** Status pill of a job or host status (running / queued pulse). */
export function StatusBadge({ status, tone, label }) {
    const t = tone || jobStatusTone(status);
    const live = status === 'running' || status === 'queued' || status === 'cancelling';
    return (
        <span className={`pv-badge${live ? ' is-live' : ''}`} style={{ '--pv-tone': toneColor(t) }}>
            <span className="pv-dot" aria-hidden="true" />{label || status}
        </span>
    );
}

const ALERT_ICONS = { danger: TbCircleX, warning: TbAlertTriangle, success: TbCircleCheck, info: TbInfoCircle };

/** Inline message box. */
export function Alert({ tone = 'info', children }) {
    const Icon = ALERT_ICONS[tone] || TbInfoCircle;
    return (
        <div className="pv-alert" role={tone === 'danger' ? 'alert' : 'status'} style={{ '--pv-tone': toneColor(tone) }}>
            <Icon size={18} aria-hidden="true" />
            <div className="pv-alert-body">{children}</div>
        </div>
    );
}

const SEGMENTS = [['ok', 'is-ok'], ['failed', 'is-failed'], ['running', 'is-running'], ['queued', 'is-queued'], ['other', 'is-other']];

/** Stacked bar of host counts { ok, failed, running, queued, other, total }. */
export function ProgressBar({ segments, thin, label }) {
    const total = segments.total || 0;
    return (
        <div className={`pv-progress${thin ? ' is-thin' : ''}`} role="img" aria-label={label || `${segments.ok} of ${total} hosts ok`}>
            {total > 0 && SEGMENTS.map(([key, cls]) => (segments[key] > 0
                ? <span key={key} className={cls} style={{ width: `${(segments[key] / total) * 100}%` }} />
                : null))}
        </div>
    );
}

/** Placeholder with an icon, a line and a hint. */
export function EmptyState({ icon: Icon, title, hint }) {
    return (
        <div className="pv-empty">
            {Icon && <Icon size={34} aria-hidden="true" />}
            <div>{title}</div>
            {hint && <small>{hint}</small>}
        </div>
    );
}
