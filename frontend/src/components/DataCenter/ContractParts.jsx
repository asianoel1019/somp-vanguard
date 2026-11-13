// Small building blocks of the Contracts & Warranties page (styles in contracts.css / hwIssues.css).
import React from 'react';
import { TbClockHour4 } from 'react-icons/tb';
import { contractDaysLeft, contractStatus, daysLeftText, termProgress } from './contractUtils';
import { CONTRACT_STATUS_META, daysChipClass } from './contractTheme';
import './hwIssues.css';
import './contracts.css';

export function ContractStatusBadge({ contract, now }) {
    const status = contract.deletedAt ? null : contractStatus(contract, now);
    const meta = status ? CONTRACT_STATUS_META[status] : { tone: 'var(--text-muted)', label: 'In trash' };
    const Icon = meta.icon;
    return (
        <span className="hw-badge" style={{ '--hw-tone': meta.tone }}>
            {Icon && <Icon size={12} aria-hidden="true" />}{meta.label}
        </span>
    );
}

export function DaysChip({ contract, now }) {
    if (contract.renewedTo) return <span className="hw-age">Replaced by renewal</span>;
    const left = contractDaysLeft(contract, now);
    return (
        <span className={daysChipClass(left)}>
            <TbClockHour4 size={12} aria-hidden="true" />{daysLeftText(left)}
        </span>
    );
}

/** Start and end dates over a bar of the term used so far. */
export function TermBar({ contract, now }) {
    const status = contractStatus(contract, now);
    const pct = termProgress(contract, now);
    return (
        <div className="ct-term" style={{ '--hw-tone': CONTRACT_STATUS_META[status].tone }}>
            <div className="ct-term-dates"><span>{contract.startDate || '-'}</span><strong>{contract.endDate || '-'}</strong></div>
            <div className="ct-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Term used">
                <span style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}
