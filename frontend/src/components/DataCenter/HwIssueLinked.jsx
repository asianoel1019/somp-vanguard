import React from 'react';
import { warrantyFor, sparePartsUsed, formatNoteTime } from './hwIssueUtils';

const box = { background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 };
const title = { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' };

// Drawer panel: the device's hardware warranty, the spare parts used on the issue, and a link to its rack.
export default function HwIssueLinked({ issue, contracts, spareItems, now, dc, onShowInRack }) {
    const w = warrantyFor(issue, contracts, now);
    const used = sparePartsUsed(issue, spareItems);
    const wColor = !w ? 'var(--text-muted)' : !w.active ? 'var(--danger)' : w.daysLeft <= 30 ? '#f59e0b' : 'var(--success)';
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
            <div style={box}>
                <span style={title}>Warranty</span>
                {w ? (
                    <>
                        <span style={{ fontSize: 13, fontWeight: 700, color: wColor }}>
                            {w.active ? (w.daysLeft <= 30 ? `Ends in ${w.daysLeft} day(s)` : 'Under warranty') : `Expired ${Math.abs(w.daysLeft ?? 0)} day(s) ago`}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.contract.name || '(unnamed)'}{w.contract.vendor ? ` · ${w.contract.vendor}` : ''}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Until {w.contract.endDate || '-'}</span>
                    </>
                ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        No hardware warranty linked to this device or serial number (Contracts &amp; Warranties).
                    </span>
                )}
            </div>
            <div style={box}>
                <span style={title}>Spare parts used</span>
                {used.length ? used.map((u, idx) => (
                    <span key={idx} style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                        {u.qty} × {u.name}{u.category ? ` (${u.category})` : ''}
                        <span style={{ color: 'var(--text-muted)' }}>{u.user ? ` · ${u.user}` : ''}{u.at ? ` · ${formatNoteTime(u.at)}` : ''}</span>
                    </span>
                )) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>None.</span>}
            </div>
            {dc && onShowInRack && (
                <div style={{ gridColumn: '1 / -1' }}>
                    <button type="button" className="btn btn-outline" style={{ fontSize: 12, padding: '6px 12px' }}
                        onClick={() => onShowInRack(dc.id, issue.rackId || null)}>
                        🗄️ Show in rack view ({dc.name}{issue.rackLoc ? ` · ${issue.rackLoc}` : ''})
                    </button>
                </div>
            )}
        </div>
    );
}
