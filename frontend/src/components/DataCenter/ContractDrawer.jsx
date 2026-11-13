import React, { useState } from 'react';
import {
    TbX, TbEdit, TbRefresh, TbTrash, TbRestore, TbDownload, TbEye, TbEyeOff, TbCopy, TbServer2, TbAlertTriangle, TbNotes,
    TbFileText, TbUsers, TbHistory, TbArrowRight,
} from 'react-icons/tb';
import { contractDaysLeft, daysLeftText, formatMoney, relatedIssues, seatUsage } from './contractUtils';
import { formatNoteTime } from './hwIssueUtils';
import { ContractStatusBadge, DaysChip, TermBar } from './ContractParts';
import { StatusBadge } from './HwIssueParts';
import { TYPE_ICON } from './contractTheme';
import './hwIssues.css';
import './contracts.css';

function Fact({ label, children }) {
    return (
        <div className="ct-fact">
            <div className="ct-fact-label">{label}</div>
            <div className="ct-fact-value">{children || <span className="hw-muted">-</span>}</div>
        </div>
    );
}

// Details of one contract, with its devices, hardware issues, file, renewal links and the actions the role allows.
export default function ContractDrawer({
    contract: c, contracts, devicesById, issues, now, canWrite, isSuperAdmin,
    onClose, onEdit, onRenew, onTrash, onRestore, onForceDelete, onDownload, onSelect, onShowInRack, onCopy,
}) {
    const [showKey, setShowKey] = useState(false);
    const TypeIcon = TYPE_ICON[c.type] || TbFileText;
    const seats = seatUsage(c);
    const related = relatedIssues(c, issues);
    const openIssues = related.filter(i => i.status !== 'Closed').length;
    const left = contractDaysLeft(c, now);
    const prevTerm = c.renewedFrom ? contracts.find(x => x.id === c.renewedFrom) : null;
    const nextTerm = c.renewedTo ? contracts.find(x => x.id === c.renewedTo) : null;
    const isHw = c.type === 'Hardware Warranties';

    return (
        <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="drawer-panel ct-drawer" role="dialog" aria-modal="true" aria-label={`Contract ${c.name}`}>
                <div className="drawer-header">
                    <div className="ct-drawer-head">
                        <span className="hw-line"><TypeIcon size={14} aria-hidden="true" />{c.type}</span>
                        <h2 className="ct-drawer-title">{c.name}</h2>
                        <div className="hw-box-row"><ContractStatusBadge contract={c} now={now} />{!c.deletedAt && <DaysChip contract={c} now={now} />}</div>
                    </div>
                    <button type="button" className="hw-icon-btn" onClick={onClose} aria-label="Close"><TbX size={20} /></button>
                </div>

                <div className="drawer-body">
                    {nextTerm && (
                        <div className="ct-info hw-section">
                            Renewed: the next term runs {nextTerm.startDate} to {nextTerm.endDate}.{' '}
                            <button type="button" className="hw-link" onClick={() => onSelect(nextTerm.id)}>Open it <TbArrowRight size={12} aria-hidden="true" /></button>
                        </div>
                    )}
                    <div className="hw-section"><TermBar contract={c} now={now} /></div>
                    <div className="ct-facts">
                        <Fact label="Vendor">{c.vendor}</Fact>
                        <Fact label="Cost">{c.cost !== '' && c.cost !== null && c.cost !== undefined ? formatMoney(c.cost, c.currency) : ''}</Fact>
                        <Fact label="Term">{c.startDate} to {c.endDate}</Fact>
                        <Fact label="Remaining">{c.renewedTo ? 'Replaced by renewal' : daysLeftText(left)}</Fact>
                        {isHw && <Fact label="Serial number"><span className="ct-mono">{c.serialNumber}</span></Fact>}
                        <Fact label="Support contact">{c.contact}</Fact>
                    </div>

                    {seats && (
                        <div className="hw-section">
                            <div className="hw-section-head">
                                <span className="hw-section-title"><TbUsers size={16} aria-hidden="true" /> Seats</span>
                                <span className={seats.over ? 'hw-badge' : 'hw-muted hw-small'} style={seats.over ? { '--hw-tone': 'var(--danger)' } : undefined}>
                                    {seats.used} / {seats.total} used{seats.source === 'devices' ? ' (linked devices)' : ''}{seats.over ? ' · over the licence' : ''}
                                </span>
                            </div>
                            <div className="ct-bar" style={{ '--hw-tone': seats.over ? 'var(--danger)' : 'var(--accent-primary)' }}>
                                <span style={{ width: `${seats.pct}%` }} />
                            </div>
                        </div>
                    )}

                    {!isHw && c.licenseKey && (
                        <div className="hw-section">
                            <div className="hw-section-head"><span className="hw-section-title">License key</span></div>
                            <div className="ct-key">
                                <code>{showKey ? c.licenseKey : '•'.repeat(Math.min(24, c.licenseKey.length))}</code>
                                <button type="button" className="hw-icon-btn" onClick={() => setShowKey(v => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>{showKey ? <TbEyeOff size={16} /> : <TbEye size={16} />}</button>
                                <button type="button" className="hw-icon-btn" onClick={() => onCopy(c.licenseKey)} aria-label="Copy key"><TbCopy size={16} /></button>
                            </div>
                        </div>
                    )}

                    <div className="hw-section">
                        <div className="hw-section-head"><span className="hw-section-title"><TbServer2 size={16} aria-hidden="true" /> Linked devices ({(c.linkedDevices || []).length})</span></div>
                        <div className="ct-list">
                            {(c.linkedDevices || []).map(id => {
                                const d = devicesById.get(id);
                                return (
                                    <div key={id} className="ct-list-item">
                                        <span>
                                            <strong>{d ? d.hostname || id : id}</strong>{' '}
                                            <span className="hw-muted hw-small">{d ? [d.dcName, d.rackName && `${d.rackName} U${d.u ?? '?'}`, d.sn && `SN ${d.sn}`].filter(Boolean).join(' · ') : 'no longer in the racks'}</span>
                                        </span>
                                        {d && onShowInRack && (
                                            <button type="button" className="btn btn-outline hw-btn hw-btn-sm" onClick={() => onShowInRack(d.dcId, d.rackId)}>Show in rack</button>
                                        )}
                                    </div>
                                );
                            })}
                            {!(c.linkedDevices || []).length && <span className="hw-muted hw-small">No devices linked.</span>}
                        </div>
                    </div>

                    <div className="hw-section">
                        <div className="hw-section-head">
                            <span className="hw-section-title"><TbAlertTriangle size={16} aria-hidden="true" /> Hardware issues ({related.length})</span>
                            {openIssues > 0 && <span className="hw-badge" style={{ '--hw-tone': 'var(--warning)' }}>{openIssues} open</span>}
                        </div>
                        <div className="ct-list">
                            {related.slice(0, 8).map(i => (
                                <div key={i.id} className="ct-list-item">
                                    <span>{i.deviceName || '?'}: {i.failedParts || i.issueTitle || 'no part given'} <span className="hw-muted hw-small">{i.date}</span></span>
                                    <StatusBadge status={i.status} />
                                </div>
                            ))}
                            {related.length > 8 && <span className="hw-muted hw-small">+ {related.length - 8} more in Hardware Issues</span>}
                            {!related.length && <span className="hw-muted hw-small">No hardware issues on these devices.</span>}
                        </div>
                    </div>

                    {c.savedFileName && (
                        <div className="hw-section">
                            <div className="hw-section-head"><span className="hw-section-title"><TbFileText size={16} aria-hidden="true" /> File</span></div>
                            <button type="button" className="btn btn-outline hw-btn" onClick={() => onDownload(c)}>
                                <TbDownload size={16} aria-hidden="true" /> {c.originalFileName || c.savedFileName}
                            </button>
                        </div>
                    )}

                    {c.notes && (
                        <div className="hw-section">
                            <div className="hw-section-head"><span className="hw-section-title"><TbNotes size={16} aria-hidden="true" /> Notes</span></div>
                            <div className="ct-notes">{c.notes}</div>
                        </div>
                    )}

                    <div className="hw-section">
                        <div className="hw-section-head"><span className="hw-section-title"><TbHistory size={16} aria-hidden="true" /> Record</span></div>
                        <div className="ct-meta">
                            {prevTerm && <span>Renews <button type="button" className="hw-link" onClick={() => onSelect(prevTerm.id)}>{prevTerm.name} ({prevTerm.startDate} to {prevTerm.endDate})</button></span>}
                            {c.createdBy && <span>Created by {c.createdBy}{c.createdAt ? `, ${formatNoteTime(c.createdAt)}` : ''}</span>}
                            {c.updatedBy && c.updatedAt !== c.createdAt && <span>Last changed by {c.updatedBy}, {formatNoteTime(c.updatedAt)}</span>}
                            {c.deletedAt && <span>Moved to trash{c.deletedBy ? ` by ${c.deletedBy}` : ''}, {formatNoteTime(c.deletedAt)}</span>}
                            {!c.createdBy && !c.updatedBy && <span>Created before changes were recorded.</span>}
                        </div>
                    </div>
                </div>

                {canWrite && (
                    <div className="drawer-footer ct-drawer-footer">
                        {c.deletedAt ? (
                            <>
                                <div>{isSuperAdmin && <button type="button" className="btn btn-outline hw-btn hw-btn-danger" onClick={() => onForceDelete(c)}><TbTrash size={16} aria-hidden="true" /> Delete permanently</button>}</div>
                                <div><button type="button" className="btn btn-primary hw-btn" onClick={() => onRestore(c)}><TbRestore size={16} aria-hidden="true" /> Restore</button></div>
                            </>
                        ) : (
                            <>
                                <div><button type="button" className="btn btn-outline hw-btn hw-btn-danger" onClick={() => onTrash(c)}><TbTrash size={16} aria-hidden="true" /> Move to trash</button></div>
                                <div>
                                    {!c.renewedTo && <button type="button" className="btn btn-outline hw-btn" onClick={() => onRenew(c)}><TbRefresh size={16} aria-hidden="true" /> Renew</button>}
                                    <button type="button" className="btn btn-primary hw-btn" onClick={() => onEdit(c)}><TbEdit size={16} aria-hidden="true" /> Edit</button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
