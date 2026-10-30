import React, { useState, useEffect, useMemo } from 'react';
import { FiAlertTriangle, FiTrash2, FiRefreshCw } from 'react-icons/fi';
import api from '../../api';
import {
    COLLAPSE_AFTER, EMPTY_CLEANUP, formatCount, aggregatePreviews, prometheusLabel,
    scoutHistoryLabel, ruleBindingsLabel, deleteButtonLabel, buildDeleteRequest,
    SCOUT_HISTORY_DETAIL, PERMANENT_NOTE, logsNotDeletedNote, deletableIps, cleanupFailures,
    collectExtraLines, blockedByGuard, canOfferForce, buildInventoryDeleteRequest
} from './serverDeleteUtils';

const S = {
    overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    modal: { width: 640, maxWidth: '92%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,0.5)', padding: 22 },
    box: { background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13, lineHeight: 1.55 },
    heading: { fontSize: 12, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 },
    vip: { color: '#ef4444', fontWeight: 700 },
    btn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
    btnDanger: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, background: '#ef4444', color: '#fff', border: '1px solid #ef4444', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
    th: { textAlign: 'left', padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' },
    td: { padding: '4px 8px', fontSize: 12, borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' }
};

function CleanupOption({ checked, disabled, onChange, label, detail }) {
    return (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
                <span style={{ fontWeight: 600 }}>{label}</span>
                {detail ? <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{detail}</span> : null}
            </span>
        </label>
    );
}

/**
 * Delete confirmation for Server List. Loads POST /server-list/delete-preview on open and shows exactly what
 * will be deleted, the optional (default OFF) cleanups with counts, and what is not touched.
 *
 * variant="inventory" is the Server Inventory delete: same modal, previews come from POST /inventory/delete-preview
 * (Server List preview plus inventory / IPAM lines, listed in an extra section), the server-side offline guard is
 * shown, and a SuperAdmin-only "force" checkbox appears only when that guard blocks. bulkDays switches the request
 * to "delete hosts offline > N days".
 */
export default function ServerDeleteModal({ isOpen, ips, servers, onClose, onDeleted, showToast, variant = 'serverList', role = 'Viewer', bulkDays = null }) {
    const isInv = variant === 'inventory';
    const [force, setForce] = useState(false);
    const [refused, setRefused] = useState(false);
    const [previews, setPreviews] = useState([]);
    const [loading, setLoading] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [cleanup, setCleanup] = useState(EMPTY_CLEANUP);
    const [deleting, setDeleting] = useState(false);

    const ipKey = (ips || []).join(',');

    useEffect(() => {
        if (!isOpen || !ips || ips.length === 0) return undefined;
        let cancelled = false;
        setCleanup(EMPTY_CLEANUP);
        setPreviews([]);
        setPreviewError('');
        setForce(false);
        setRefused(false);
        setLoading(true);
        api.post(isInv ? '/inventory/delete-preview' : '/server-list/delete-preview', { ips })
            .then(res => { if (!cancelled) setPreviews(res.data?.previews || []); })
            .catch(err => { if (!cancelled) setPreviewError(err.response?.data?.error || err.message || 'Failed to load delete preview'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, ipKey]);

    const totals = useMemo(() => aggregatePreviews(previews), [previews]);
    const hostnameOf = useMemo(() => {
        const m = {};
        (servers || []).forEach(s => { m[s.ip] = s.hostname; });
        previews.forEach(p => { if (p.hostname) m[p.ip] = p.hostname; });
        return m;
    }, [servers, previews]);

    if (!isOpen) return null;

    const previewOk = !loading && !previewError;
    // Inventory delete acts on inventory rows, so hosts missing from Server List are still deletable
    const toDelete = isInv ? ips : deletableIps(ips, previews, previewOk);
    const extraLines = isInv && previewOk ? collectExtraLines(previews) : [];
    const blocked = isInv && previewOk ? blockedByGuard(previews) : [];
    const offerForce = isInv && !bulkDays && canOfferForce({ role, blocked, refused });
    const guardStops = isInv && !bulkDays && (blocked.length > 0 || refused) && !(offerForce && force);
    const missingIps = ips.filter(ip => !toDelete.includes(ip));
    const logsNote = previewOk ? logsNotDeletedNote(totals) : '';
    const collapsed = ips.length > COLLAPSE_AFTER;
    const set = (k) => (v) => setCleanup(c => ({ ...c, [k]: v }));

    const execute = async () => {
        setDeleting(true);
        try {
            const req = isInv
                ? buildInventoryDeleteRequest({ ips: toDelete, cleanup, previewOk, force: offerForce && force, bulkDays })
                : buildDeleteRequest({ ips: toDelete, cleanup, previewOk });
            const res = req.method === 'delete'
                ? await api.delete(req.url, { data: req.data })
                : await api.post(req.url, req.data);
            const started = res.data?.cleanup === 'started' || res.data?.result?.cleanup === 'started' || res.data?.cleanupStarted === true;
            const extra = started ? ' Scout history cleanup is running in the background.' : '';
            const deletedCount = bulkDays ? (res.data?.deleted?.length ?? 0) : toDelete.length;
            showToast?.(`Deleted ${deletedCount} ${deletedCount === 1 ? 'server' : 'servers'}.${extra}`, 'success');
            (res.data?.skipped || []).slice(0, 5).forEach(sk => showToast?.(`Skipped ${sk.ip}: ${sk.reason}`, 'warning'));
            cleanupFailures(res.data?.result || res.data).forEach(f => showToast?.(`The server was deleted, but this cleanup FAILED: ${f}`, 'warning'));
            onDeleted?.(ips);
        } catch (err) {
            console.error('Delete server error:', err);
            if (err.response?.data?.code === 'OFFLINE_GUARD') setRefused(true);
            showToast?.(err.response?.data?.error || 'Failed to delete server', 'error');
        } finally {
            setDeleting(false);
        }
    };

    const vipList = totals.linkedVips;

    return (
        <div style={S.overlay} onClick={() => !deleting && onClose()}>
            <div style={S.modal} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(239,68,68,0.15)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <FiAlertTriangle size={22} />
                    </div>
                    <div>
                        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                            {isInv ? (bulkDays ? `Delete Hosts Offline > ${bulkDays} Days` : 'Confirm Inventory Host Deletion') : (ips.length > 1 ? 'Confirm Bulk Server Deletion' : 'Confirm Server Deletion')}
                        </h3>
                        <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                            Review exactly what will be removed before you confirm.
                        </p>
                    </div>
                </div>

                <div style={S.box}>
                    <div style={S.heading}>Servers</div>
                    {collapsed ? (
                        <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: 12 }}>
                            <strong>{ips.length}</strong> servers: {ips.join(', ')}
                            {missingIps.length > 0 ? <div style={{ color: '#f59e0b' }}>Not in CMDB, nothing to delete: {missingIps.join(', ')}</div> : null}
                        </div>
                    ) : ips.map(ip => (
                        <div key={ip}>
                            <strong style={{ color: 'var(--accent-primary)' }}>{ip}</strong>{hostnameOf[ip] ? ` (${hostnameOf[ip]})` : ''}
                            {missingIps.includes(ip) ? <span style={{ color: '#f59e0b' }}> — not in CMDB, nothing to delete</span> : null}
                        </div>
                    ))}
                </div>

                {loading && (
                    <div style={{ ...S.box, color: 'var(--text-muted)' }}>
                        <FiRefreshCw className="spin" size={13} /> Loading what will be affected...
                    </div>
                )}
                {previewError && (
                    <div style={{ ...S.box, borderColor: 'rgba(239,68,68,0.5)', color: '#ef4444' }}>
                        Could not load the delete preview: {previewError}. You can still delete the server(s); the optional cleanup is unavailable.
                    </div>
                )}

                <div style={S.box}>
                    <div style={S.heading}>Will be deleted</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        <li>CMDB record{ips.length > 1 ? 's' : ''} (Server List entry, marked as deleted; can be restored)</li>
                        <li>
                            Linked VIPs{previewOk ? ` (${vipList.length})` : ''}:{' '}
                            {previewOk ? (vipList.length === 0 ? 'none' : vipList.map((v, i) => (
                                <span key={v.ip} style={S.vip}>{i > 0 ? ', ' : ''}{v.ip}{v.hostname ? ` (${v.hostname})` : ''}</span>
                            ))) : 'unknown (preview unavailable) - linked VIPs are deleted together with their primary'}
                        </li>
                        <li>Scout monitor entry{previewOk ? ` (${totals.monitors})` : ''}</li>
                        <li>A CMDB history entry is recorded</li>
                    </ul>
                </div>

                {isInv && previewOk && (
                    <div style={S.box}>
                        <div style={S.heading}>Server Inventory &amp; IPAM</div>
                        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: collapsed ? 160 : undefined, overflowY: collapsed ? 'auto' : undefined }}>
                            {extraLines.map((l, i) => (
                                <li key={i} style={/^Blocked:/.test(l.line) ? { color: '#ef4444', fontWeight: 600 } : undefined}>
                                    {ips.length > 1 ? <strong>{l.ip}: </strong> : null}{l.line}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {guardStops || offerForce || (bulkDays && blocked.length > 0) ? (
                    <div style={{ ...S.box, borderColor: 'rgba(239,68,68,0.5)' }}>
                        <div style={{ ...S.heading, color: '#ef4444' }}>{bulkDays ? 'These hosts no longer pass the offline guard and will be skipped' : 'Delete blocked by the offline guard'}</div>
                        {blocked.length > 0 ? (
                            <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
                                {blocked.map(b => <li key={b.ip}><strong>{b.ip}</strong>: {b.reason}</li>)}
                            </ul>
                        ) : <div style={{ marginBottom: 6 }}>The server refused the delete: the host has not been offline long enough.</div>}
                        {offerForce ? (
                            <CleanupOption
                                checked={force} disabled={false} onChange={setForce}
                                label="Force delete (SuperAdmin) — bypass the offline guard"
                                detail="The forced delete is recorded in the audit log."
                            />
                        ) : bulkDays ? null : (
                            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Only a SuperAdmin can force the delete of a host that is not offline long enough.</div>
                        )}
                    </div>
                ) : null}

                {collapsed && previewOk && (
                    <div style={{ ...S.box, maxHeight: 180, overflowY: 'auto' }}>
                        <div style={S.heading}>Per-server summary</div>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    <th style={S.th}>IP</th><th style={S.th}>VIPs</th><th style={S.th}>Prom.</th>
                                    <th style={S.th}>Metrics</th><th style={S.th}>Bindings</th>
                                </tr>
                            </thead>
                            <tbody>
                                {previews.map(p => (
                                    <tr key={p.ip}>
                                        <td style={S.td}>{p.ip}</td>
                                        <td style={{ ...S.td, ...(p.linkedVips.length ? S.vip : {}) }}>{p.linkedVips.map(v => v.ip).join(', ') || '-'}</td>
                                        <td style={S.td}>{p.prometheusTargets.length}</td>
                                        <td style={S.td}>{formatCount(p.scout.metricRows)}</td>
                                        <td style={S.td}>{p.ruleBindings.length}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div style={S.box}>
                    <div style={S.heading}>Optional cleanup (off by default)</div>
                    <CleanupOption
                        checked={cleanup.prometheus} disabled={!previewOk} onChange={set('prometheus')}
                        label={previewOk ? prometheusLabel(totals) : 'Remove from Prometheus targets'}
                        detail={previewOk && !collapsed && previews.some(p => p.prometheusTargets.length) ? previews.flatMap(p => p.prometheusTargets.map(t => t.target)).join(', ') : ''}
                    />
                    <CleanupOption
                        checked={cleanup.scoutHistory} disabled={!previewOk} onChange={set('scoutHistory')}
                        label={previewOk ? scoutHistoryLabel(totals) : 'Delete Scout history'}
                        detail={SCOUT_HISTORY_DETAIL}
                    />
                    <CleanupOption
                        checked={cleanup.ruleBindings} disabled={!previewOk} onChange={set('ruleBindings')}
                        label={previewOk ? ruleBindingsLabel(totals) : 'Remove alert rule bindings & maintenance windows for this host'}
                        detail="Maintenance windows that also cover other hosts are left untouched."
                    />
                </div>

                <div style={S.box}>
                    <div style={S.heading}>Not affected (manual cleanup)</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {isInv ? (
                            <li>IPAM records in status reserved / vip (only records in status used are released), rack position, DNS records.</li>
                        ) : (
                            <>
                                <li>IPAM IP records, rack position, DNS records.</li>
                                <li>Server Inventory record (the host stays in Server Inventory; scans will not re-add it to Server List).</li>
                            </>
                        )}
                        {logsNote ? <li>{logsNote}</li> : null}
                    </ul>
                </div>

                <div style={{ ...S.box, borderColor: 'rgba(239,68,68,0.5)', color: '#ef4444' }}>
                    {PERMANENT_NOTE}
                </div>

                <div style={{ ...S.box, borderColor: 'rgba(245,158,11,0.5)', color: '#f59e0b' }}>
                    If a Scout agent is still installed on this host it will report again; deleted servers are not re-registered — uninstall the agent or restore the server.
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button type="button" style={S.btn} disabled={deleting} onClick={onClose}>Cancel</button>
                    <button type="button" style={{ ...S.btnDanger, opacity: (loading || deleting) ? 0.6 : 1 }} disabled={loading || deleting || toDelete.length === 0 || guardStops} onClick={execute}>
                        {deleting ? <FiRefreshCw className="spin" size={14} /> : <FiTrash2 size={14} />} {deleteButtonLabel(toDelete.length)}
                    </button>
                </div>
            </div>
        </div>
    );
}
