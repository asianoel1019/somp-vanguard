import React from 'react';
import { TbShieldCheck, TbShieldX, TbPackage, TbServer2 } from 'react-icons/tb';
import { warrantyFor, sparePartsUsed, formatNoteTime } from './hwIssueUtils';
import './hwIssues.css';

// Drawer panel: the device's hardware warranty, the spare parts used on the issue, and a link to its rack.
export default function HwIssueLinked({ issue, contracts, spareItems, now, dc, onShowInRack }) {
    const w = warrantyFor(issue, contracts, now);
    const used = sparePartsUsed(issue, spareItems);
    const tone = !w ? 'var(--text-muted)' : !w.active ? 'var(--danger)' : w.daysLeft <= 30 ? 'var(--warning)' : 'var(--success)';
    const WIcon = w && w.active ? TbShieldCheck : TbShieldX;
    return (
        <div className="hw-linked">
            <div className="hw-box">
                <span className="hw-linked-title"><WIcon size={14} aria-hidden="true" /> Warranty</span>
                {w ? (
                    <>
                        <span className="hw-linked-state" style={{ '--hw-tone': tone }}>
                            {w.active ? (w.daysLeft <= 30 ? `Ends in ${w.daysLeft} day(s)` : 'Under warranty') : `Expired ${Math.abs(w.daysLeft ?? 0)} day(s) ago`}
                        </span>
                        <span className="hw-line">{w.contract.name || '(unnamed)'}{w.contract.vendor ? ` · ${w.contract.vendor}` : ''}</span>
                        <span className="hw-muted hw-small">Until {w.contract.endDate || '-'}</span>
                    </>
                ) : (
                    <span className="hw-muted hw-small">No hardware warranty linked to this device or serial number (Contracts &amp; Warranties).</span>
                )}
            </div>
            <div className="hw-box">
                <span className="hw-linked-title"><TbPackage size={14} aria-hidden="true" /> Spare parts used</span>
                {used.length ? used.map((u, idx) => (
                    <span key={idx} className="hw-line is-strong">
                        {u.qty} × {u.name}{u.category ? ` (${u.category})` : ''}
                        <span className="hw-muted">{u.user ? ` · ${u.user}` : ''}{u.at ? ` · ${formatNoteTime(u.at)}` : ''}</span>
                    </span>
                )) : <span className="hw-muted hw-small">None.</span>}
            </div>
            {dc && onShowInRack && (
                <div className="hw-linked-full">
                    <button type="button" className="btn btn-outline hw-btn hw-btn-sm" onClick={() => onShowInRack(dc.id, issue.rackId || null)}>
                        <TbServer2 size={14} aria-hidden="true" /> Show in rack view ({dc.name}{issue.rackLoc ? ` · ${issue.rackLoc}` : ''})
                    </button>
                </div>
            )}
        </div>
    );
}
