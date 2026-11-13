// Small building blocks of the Hardware Issues page (styles in hwIssues.css).
import React from 'react';
import { TbClockHour4, TbAlarm } from 'react-icons/tb';
import { ageDays, isOverdue, URGENCY_LABELS } from './hwIssueUtils';
import { URGENCY_TONE, STATUS_META } from './hwIssueTheme';
import './hwIssues.css';

export function UrgencyBadge({ urgency }) {
    return (
        <span className="hw-badge" style={{ '--hw-tone': URGENCY_TONE[urgency] || URGENCY_TONE.M }}>
            {URGENCY_LABELS[urgency] || urgency || 'Medium'}
        </span>
    );
}

export function StatusBadge({ status }) {
    const meta = STATUS_META[status] || { tone: 'var(--text-muted)' };
    const Icon = meta.icon;
    return (
        <span className="hw-badge" style={{ '--hw-tone': meta.tone }}>
            {Icon && <Icon size={12} aria-hidden="true" />}{status}
        </span>
    );
}

/** Days open; red with "overdue" when past its deadline. */
export function AgeChip({ issue, now }) {
    const days = ageDays(issue, now);
    if (days === null) return null;
    const late = isOverdue(issue, now);
    const Icon = late ? TbAlarm : TbClockHour4;
    return (
        <span className={`hw-age${late ? ' is-late' : ''}`} title={late ? 'Past its due date' : issue.status === 'Closed' ? 'Days it was open' : 'Days open'}>
            <Icon size={12} aria-hidden="true" />{days}d{late ? ' · overdue' : ''}
        </span>
    );
}
