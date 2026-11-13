import React, { useMemo } from 'react';
import { TbX, TbEdit, TbTrash, TbPackageImport, TbPackageExport, TbClipboardCheck, TbHistory, TbChartBar, TbAlertTriangle, TbBarcode } from 'react-icons/tb';
import { formatNoteTime } from './hwIssueUtils';
import { issuesUsing, monthlyUsage, stockStatus, suggestedOrder, usedWithin } from './sparePartUtils';
import { SPARE_STATUS_META, categoryIcon, movementMeta } from './spareTheme';
import { StatusBadge } from './HwIssueParts';
import './hwIssues.css';
import './contracts.css';
import './spareParts.css';

function Fact({ label, children }) {
    return (
        <div className="ct-fact">
            <div className="ct-fact-label">{label}</div>
            <div className="ct-fact-value">{children || children === 0 ? children : <span className="hw-muted">-</span>}</div>
        </div>
    );
}

export function SpareStatusBadge({ item }) {
    const meta = SPARE_STATUS_META[stockStatus(item)];
    const Icon = meta.icon;
    return <span className="hw-badge" style={{ '--hw-tone': meta.tone }}><Icon size={12} aria-hidden="true" />{meta.label}</span>;
}

// Details of one part: figures, serial numbers, monthly use, the hardware issues it went into and its stock history.
export default function SpareDrawer({ item, issues, now, canWrite, isSuperAdmin, onClose, onEdit, onDelete, onStock }) {
    const usage = useMemo(() => monthlyUsage(item, 12, now), [item, now]);
    const peak = Math.max(1, ...usage.map(u => u.qty));
    const used = useMemo(() => issuesUsing(item, issues), [item, issues]);
    const issuesById = useMemo(() => new Map((issues || []).map(i => [i.id, i])), [issues]);
    const history = [...(item.history || [])].reverse();
    const order = suggestedOrder(item);
    const value = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
    const canDelete = canWrite && (item.quantity === 0 || isSuperAdmin);

    return (
        <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="drawer-panel ct-drawer" role="dialog" aria-modal="true" aria-label={`Spare part ${item.name}`}>
                <div className="drawer-header">
                    <div className="ct-drawer-head">
                        <span className="hw-line">{React.createElement(categoryIcon(item.category), { size: 14, 'aria-hidden': true })}{item.category}</span>
                        <h2 className="ct-drawer-title">{item.name}</h2>
                        <div className="hw-box-row">
                            <SpareStatusBadge item={item} />
                            {item.condition && item.condition !== 'New' && <span className="sp-chip">{item.condition}</span>}
                            {order > 0 && <span className="sp-chip sp-order">Order {order}</span>}
                        </div>
                    </div>
                    <button type="button" className="hw-icon-btn" onClick={onClose} aria-label="Close"><TbX size={20} /></button>
                </div>

                <div className="drawer-body">
                    <div className="ct-facts">
                        <Fact label="In stock">{item.quantity}{item.minStock ? ` (min ${item.minStock})` : ''}</Fact>
                        <Fact label="Stock value">{value ? `${item.currency || 'TWD'} ${value.toLocaleString()}` : ''}</Fact>
                        <Fact label="Brand">{item.vendor}</Fact>
                        <Fact label="Part number"><span className="ct-mono">{item.partNumber}</span></Fact>
                        <Fact label="Model">{item.model}</Fact>
                        <Fact label="Unit price">{item.unitPrice ? `${item.currency || 'TWD'} ${Number(item.unitPrice).toLocaleString()}` : ''}</Fact>
                        <Fact label="Location">{item.location}</Fact>
                        <Fact label="Supplier">{item.supplier}</Fact>
                        <Fact label="Used, last 30 days">{usedWithin(item, 30, now)}</Fact>
                        <Fact label="Used, last 12 months">{usage.reduce((s, u) => s + u.qty, 0)}</Fact>
                    </div>
                    {item.spec && <div className="hw-section"><div className="ct-fact-label">Specification</div><div className="ct-notes">{item.spec}</div></div>}
                    {item.compatibleWith && <div className="hw-section"><div className="ct-fact-label">Compatible with</div><div className="ct-notes">{item.compatibleWith}</div></div>}
                    {item.notes && <div className="hw-section"><div className="ct-fact-label">Notes</div><div className="ct-notes">{item.notes}</div></div>}

                    {(item.serials || []).length > 0 && (
                        <div className="hw-section">
                            <div className="hw-section-head"><span className="hw-section-title"><TbBarcode size={16} aria-hidden="true" /> Serial numbers in stock ({item.serials.length})</span></div>
                            <div className="sp-serials">{item.serials.map(s => <span key={s} className="sp-chip ct-mono">{s}</span>)}</div>
                        </div>
                    )}

                    <div className="hw-section">
                        <div className="hw-section-head"><span className="hw-section-title"><TbChartBar size={16} aria-hidden="true" /> Used per month</span></div>
                        <div className="sp-usage" role="img" aria-label={`Units booked out per month: ${usage.map(u => `${u.label} ${u.qty}`).join(', ')}`}>
                            {usage.map(u => (
                                <div key={u.label} className="sp-usage-bar" title={`${u.label}: ${u.qty}`}>
                                    {u.qty > 0 && <small>{u.qty}</small>}
                                    <span className={u.qty ? '' : 'is-zero'} style={{ height: `${Math.max(3, (u.qty / peak) * 100)}%` }} />
                                </div>
                            ))}
                        </div>
                        <div className="sp-usage-legend"><span>{usage[0].label}</span><span>{usage.at(-1).label}</span></div>
                    </div>

                    <div className="hw-section">
                        <div className="hw-section-head"><span className="hw-section-title"><TbAlertTriangle size={16} aria-hidden="true" /> Used in hardware issues ({used.length})</span></div>
                        <div className="ct-list">
                            {used.slice(0, 8).map((u, idx) => (
                                <div key={idx} className="ct-list-item">
                                    <span>{u.qty} × {u.issue.deviceName || '?'}: {u.issue.failedParts || 'issue'} <span className="hw-muted hw-small">{u.at ? formatNoteTime(u.at) : ''}{u.user ? ` · ${u.user}` : ''}</span></span>
                                    <StatusBadge status={u.issue.status} />
                                </div>
                            ))}
                            {!used.length && <span className="hw-muted hw-small">Not used in any hardware issue.</span>}
                        </div>
                    </div>

                    <div className="hw-section">
                        <div className="hw-section-head"><span className="hw-section-title"><TbHistory size={16} aria-hidden="true" /> Stock history ({history.length})</span></div>
                        <div className="hw-timeline">
                            {history.slice(0, 50).map((h, idx) => {
                                const m = movementMeta(h);
                                const linked = h.issueId ? issuesById.get(h.issueId) : null;
                                const sign = h.type === 'IN' ? '+' : h.type === 'OUT' ? '-' : (h.qty > 0 ? '+' : '');
                                return (
                                    <div key={idx} className="hw-entry" style={{ '--hw-tone': m.tone }}>
                                        <div className="hw-entry-rail" />
                                        <div className="hw-entry-body">
                                            <div className="hw-entry-head">
                                                <span className="hw-entry-status">{m.label} {sign}{h.qty}</span>
                                                <span className="hw-muted hw-small">{formatNoteTime(h.date)}</span>
                                            </div>
                                            {(h.before !== undefined && h.after !== undefined) && <div className="hw-small hw-muted">{h.before} → {h.after}</div>}
                                            {h.note && <div className="hw-entry-note">{h.note}</div>}
                                            {linked && <div className="hw-entry-note">Issue: {linked.deviceName}: {linked.failedParts}</div>}
                                            {Array.isArray(h.serials) && h.serials.length > 0 && <div className="hw-small ct-mono">SN {h.serials.join(', ')}</div>}
                                            <div className="hw-entry-by">{h.user || '-'}</div>
                                        </div>
                                    </div>
                                );
                            })}
                            {history.length > 50 && <span className="hw-muted hw-small">Showing the latest 50 of {history.length} entries.</span>}
                            {!history.length && <span className="hw-muted hw-small">No stock movements yet.</span>}
                        </div>
                    </div>

                    <div className="ct-meta">
                        {item.createdBy && <span>Created by {item.createdBy}{item.createdAt ? `, ${formatNoteTime(item.createdAt)}` : ''}</span>}
                        {item.updatedBy && <span>Last changed by {item.updatedBy}, {formatNoteTime(item.updatedAt)}</span>}
                    </div>
                </div>

                {canWrite && (
                    <div className="drawer-footer ct-drawer-footer">
                        <div>
                            {canDelete && <button type="button" className="btn btn-outline hw-btn hw-btn-danger" onClick={() => onDelete(item)}><TbTrash size={16} aria-hidden="true" /> Delete</button>}
                        </div>
                        <div>
                            <button type="button" className="btn btn-outline hw-btn" onClick={() => onStock(item, 'COUNT')}><TbClipboardCheck size={16} aria-hidden="true" /> Count</button>
                            <button type="button" className="btn btn-outline hw-btn sp-out" onClick={() => onStock(item, 'OUT')} disabled={!item.quantity}><TbPackageExport size={16} aria-hidden="true" /> Out</button>
                            <button type="button" className="btn btn-outline hw-btn sp-in" onClick={() => onStock(item, 'IN')}><TbPackageImport size={16} aria-hidden="true" /> In</button>
                            <button type="button" className="btn btn-primary hw-btn" onClick={() => onEdit(item)}><TbEdit size={16} aria-hidden="true" /> Edit</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
