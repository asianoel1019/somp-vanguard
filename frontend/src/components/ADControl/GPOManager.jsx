// Group Policy page laid out like the Group Policy Management Console: the domain / OU tree with linked GPOs and the
// Group Policy Objects / WMI Filters containers on the left, the selected item's tabs on the right, a toolbar and a
// right-click menu for the actions.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiSave, FiEdit2, FiCheck, FiLink, FiAlertCircle, FiLock, FiSlash, FiTrash2, FiPlus, FiCopy, FiType, FiArchive } from 'react-icons/fi';
import api from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { buildGpmcTree, findLink, gpoLocations, formatDate, GPO_STATUS_LABELS, GPO_STATUSES, PERMISSION_LABELS } from './gpmcModel';
import { C } from './gpmcStyle';
import GpmcTree from './GpmcTree';
import GpoPane from './GpoPane';
import ContainerPane from './ContainerPane';
import RegistryEditModal from './RegistryEditModal';
import LinkGpoModal from './LinkGpoModal';
import { NameDialog, CommentDialog, DeleteGpoDialog, TrusteeDialog, BackupsDialog } from './GpoDialogs';

const RSAT_HINT = 'RSAT-GPMC is missing on the domain controller. Install the Group Policy Management Console (Install-WindowsFeature RSAT-GPMC).';
const errorText = (e, fallback) => {
    const t = e?.response?.data?.error || fallback;
    return /RSAT_GPMC_MISSING/.test(t) ? RSAT_HINT : t;
};

const btn = { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '8px', border: C.border, background: 'transparent', color: 'var(--text-primary)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' };

function MenuItem({ children, onClick, checked, disabled }) {
    return (
        <button role="menuitem" disabled={disabled} onClick={onClick}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', padding: '6px 12px', border: 'none', background: 'transparent', color: disabled ? C.muted : 'var(--text-primary)', fontSize: '12.5px', cursor: disabled ? 'default' : 'pointer' }}
            onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'rgba(59,130,246,0.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <span style={{ width: 14, display: 'inline-flex' }}>{checked ? <FiCheck /> : null}</span>{children}
        </button>
    );
}
const MenuSeparator = () => <div style={{ borderTop: C.border, margin: '4px 0' }} />;

export default function GPOManager() {
    const { showConfirm } = useConfirm();
    const role = (JSON.parse(localStorage.getItem('user') || '{}').role) || 'Viewer';
    const canEdit = role !== 'Viewer';
    const canReport = role === 'SuperAdmin' || role === 'Operator';
    const isSuperAdmin = role === 'SuperAdmin';

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [wmi, setWmi] = useState({ list: [], error: null });
    const [selection, setSelection] = useState(null);
    const [expanded, setExpanded] = useState(() => new Set());
    const [menu, setMenu] = useState(null);
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(false);
    const [backup, setBackup] = useState(null); // { guid, name, path }
    const [registryGpo, setRegistryGpo] = useState(null);
    const [linkTarget, setLinkTarget] = useState(null); // dn of the container to link a GPO to
    const [dialog, setDialog] = useState(null); // { kind, ... } of the open GPO dialog
    const [refreshKey, setRefreshKey] = useState(0);

    const tree = useMemo(() => (data ? buildGpmcTree(data) : null), [data]);

    // fetching and applying are separate so the first load runs from an effect without a synchronous setState
    const fetchAll = () => Promise.allSettled([api.get('/gpo/tree'), api.get('/gpo/wmi-filters')]);
    const apply = useCallback(([t, w]) => {
        if (t.status === 'fulfilled') {
            setData(t.value.data);
            setLoadError(null);
            const rootKey = `c:${t.value.data.domain.dn}`;
            setExpanded(prev => (prev.size ? prev : new Set([rootKey])));
            setSelection(prev => prev || { type: 'domain', key: rootKey, dn: t.value.data.domain.dn });
        } else {
            setLoadError(errorText(t.reason, 'Could not read Group Policy from the domain controller.'));
        }
        setWmi(w.status === 'fulfilled' ? { list: w.value.data.filters || [], error: null } : { list: [], error: errorText(w.reason, 'Could not read the WMI filters.') });
        setRefreshKey(k => k + 1);
        setLoading(false);
    }, []);
    const load = async () => {
        setLoading(true);
        apply(await fetchAll());
    };

    useEffect(() => { fetchAll().then(apply); }, [apply]);

    useEffect(() => {
        if (!menu) return undefined;
        const close = () => setMenu(null);
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        window.addEventListener('click', close);
        window.addEventListener('keydown', onKey);
        window.addEventListener('scroll', close, true);
        return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', close, true); };
    }, [menu]);

    const toggle = (key) => setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

    const openGpo = (guid) => {
        setExpanded(prev => new Set([...prev, 'gpos']));
        setSelection({ type: 'gpo', key: `g:${guid}`, guid });
    };
    const openContainer = (dn) => {
        const node = tree && tree.byDn.get(String(dn).toLowerCase());
        if (!node) return;
        setExpanded(prev => { const next = new Set(prev); for (let n = node.parent; n; n = n.parent) next.add(`c:${n.dn}`); return next; });
        setSelection({ type: node.kind, key: `c:${node.dn}`, dn: node.dn });
    };

    const gpoName = (guid) => (tree && tree.gpoById.get(guid) ? tree.gpoById.get(guid).name : guid);
    const selectedGuid = selection && (selection.type === 'gpo' || selection.type === 'link') ? selection.guid : null;

    const setStatus = async (guid, name, status) => {
        const ok = await showConfirm(`Change the status of '${name}' to "${GPO_STATUS_LABELS[status]}"?`, 'GPO Status');
        if (!ok) return;
        setBusy(true);
        try {
            await api.post('/gpo/status', { guid, name, status });
            setMessage({ type: 'success', text: `'${name}': ${GPO_STATUS_LABELS[status]}.` });
            await load();
        } catch (e) {
            setMessage({ type: 'error', text: errorText(e, 'Could not change the GPO status.') });
        } finally {
            setBusy(false);
        }
    };

    // One AD change: optional confirmation, then the request, a message and a reload of the tree.
    // Resolves to the request's response, or null when it was cancelled or failed.
    const runChange = async ({ confirm, title, request, success, failure }) => {
        if (confirm && !(await showConfirm(confirm, title))) return null;
        setBusy(true);
        try {
            const r = await request();
            setMessage({ type: 'success', text: typeof success === 'function' ? success(r) : success });
            await load();
            return r;
        } catch (e) {
            setMessage({ type: 'error', text: errorText(e, failure) });
            return null;
        } finally {
            setBusy(false);
        }
    };

    // ---- GPO lifecycle and permissions ----
    const closeDialog = () => setDialog(null);

    const createGpo = async ({ name, comment }, linkNode) => {
        closeDialog();
        const r = await runChange({
            request: () => api.post('/gpo/create', { name, comment, linkTo: linkNode ? linkNode.dn : undefined }),
            success: linkNode ? `GPO '${name}' was created and linked to ${linkNode.name}.` : `GPO '${name}' was created.`,
            failure: 'Could not create the GPO.',
        });
        if (r && r.data && r.data.id) openGpo(r.data.id);
    };
    const renameGpo = (guid, oldName, { name }) => {
        closeDialog();
        runChange({
            request: () => api.post('/gpo/rename', { guid, name: oldName, newName: name }),
            success: `'${oldName}' was renamed to '${name}'.`, failure: 'Could not rename the GPO.',
        });
    };
    const copyGpo = async (guid, oldName, { name, copyAcl }) => {
        closeDialog();
        const r = await runChange({
            request: () => api.post('/gpo/copy', { guid, name: oldName, newName: name, copyAcl }),
            success: `'${oldName}' was copied to '${name}'. The copy has no links.`, failure: 'Could not copy the GPO.',
        });
        if (r && r.data && r.data.id) openGpo(r.data.id);
    };
    const saveComment = (guid, name, comment) => {
        closeDialog();
        runChange({
            request: () => api.post('/gpo/comment', { guid, name, comment }),
            success: `The comment of '${name}' was saved.`, failure: 'Could not save the comment.',
        });
    };
    const deleteGpo = async (guid, name) => {
        closeDialog();
        const r = await runChange({
            request: () => api.post('/gpo/delete', { guid, name, confirmName: name }),
            success: `GPO '${name}' and its links were deleted.`, failure: 'Could not delete the GPO.',
        });
        if (r) setSelection({ type: 'gpos', key: 'gpos' });
    };
    const gpoActions = {
        addFiltering: (guid, name) => setDialog({ kind: 'filtering', guid, name }),
        removeFiltering: (guid, name, row) => runChange({
            confirm: `Remove ${row.name} from the security filtering of '${name}'? It keeps Read access, so the GPO stays readable, but no longer applies to it.`,
            title: 'Security Filtering',
            request: () => api.post('/gpo/filtering', { guid, name, action: 'remove', trustee: row.trustee, trusteeType: row.trusteeType }),
            success: `${row.name} was removed from the security filtering of '${name}'.`, failure: 'Could not change the security filtering.',
        }),
        setWmiFilter: (guid, name, filterId) => {
            const f = filterId ? wmi.list.find(x => x.id === filterId) : null;
            runChange({
                confirm: f ? `Link '${name}' to the WMI filter '${f.name}'?` : `Remove the WMI filter from '${name}'?`, title: 'WMI Filtering',
                request: () => api.post('/gpo/wmi-filter', { guid, name, filterId: filterId || null }),
                success: f ? `'${name}' now uses the WMI filter '${f.name}'.` : `'${name}' no longer uses a WMI filter.`,
                failure: 'Could not change the WMI filter.',
            });
        },
        editComment: (guid, name, comment) => setDialog({ kind: 'comment', guid, name, comment }),
        addDelegation: (guid, name, row) => setDialog({ kind: 'delegation', guid, name, row }),
        removeDelegation: (guid, name, row) => runChange({
            confirm: `Remove every permission of ${row.name} on '${name}'?`, title: 'Delegation',
            request: () => api.post('/gpo/delegation', { guid, name, action: 'remove', trustee: row.trustee, trusteeType: row.trusteeType }),
            success: `The permissions of ${row.name} on '${name}' were removed.`, failure: 'Could not change the delegation.',
        }),
    };
    const addFiltering = (guid, name, { trustee, trusteeType }) => {
        closeDialog();
        runChange({
            request: () => api.post('/gpo/filtering', { guid, name, action: 'add', trustee, trusteeType }),
            success: `'${name}' now applies to ${trustee}.`, failure: 'Could not change the security filtering.',
        });
    };
    const setDelegation = (guid, name, { trustee, trusteeType, permission }) => {
        closeDialog();
        runChange({
            confirm: `Give ${trustee} "${PERMISSION_LABELS[permission]}" on '${name}'?`, title: 'Delegation',
            request: () => api.post('/gpo/delegation', { guid, name, action: 'set', trustee, trusteeType, permission }),
            success: `${trustee}: ${PERMISSION_LABELS[permission]} on '${name}'.`, failure: 'Could not change the delegation.',
        });
    };
    const restoreBackup = (b, path) => runChange({
        confirm: tree && tree.gpoById.has(b.gpoId)
            ? `Restore '${b.name}' from the backup of ${formatDate(b.time)}? Its current settings are replaced.`
            : `'${b.name}' no longer exists. Create it again from the backup of ${formatDate(b.time)}? It gets a new id and no links.`,
        title: 'Restore GPO',
        request: () => api.post('/gpo/restore', { backupId: b.id, path, name: b.name }),
        success: (r) => (r && r.data && r.data.result === 'Imported' ? `'${b.name}' was created again from the backup.` : `'${b.name}' was restored from the backup.`),
        failure: 'Could not restore the backup.',
    });

    const linkGpo = (node, gpo) => {
        setLinkTarget(null);
        if (!gpo) return;
        runChange({
            request: () => api.post('/gpo/link', { guid: gpo.id, target: node.dn, name: gpo.name }),
            success: `'${gpo.name}' is now linked to ${node.name}.`, failure: 'Could not link the GPO.',
        });
    };
    const deleteLink = (dn, guid) => {
        const found = findLink(tree, dn, guid);
        if (!found) return;
        runChange({
            confirm: `Delete the link of '${gpoName(guid)}' from ${found.node.name}? The GPO itself is not deleted.`, title: 'Delete link',
            request: () => api.post('/gpo/link/delete', { guid, target: dn, name: gpoName(guid) }),
            success: `The link of '${gpoName(guid)}' was deleted from ${found.node.name}.`, failure: 'Could not delete the link.',
        });
    };
    const setLinkOption = (dn, guid, option, value) => {
        const found = findLink(tree, dn, guid);
        if (!found) return;
        const label = option === 'enforced' ? 'Enforced' : 'Link Enabled';
        const what = option === 'enforced' ? (value ? 'Enforce' : 'Stop enforcing') : (value ? 'Enable' : 'Disable');
        runChange({
            confirm: `${what} the link of '${gpoName(guid)}' on ${found.node.name}?`, title: label,
            request: () => api.post('/gpo/link/set', { guid, target: dn, name: gpoName(guid), [option]: value }),
            success: `Link of '${gpoName(guid)}' on ${found.node.name}: ${label} = ${value ? 'Yes' : 'No'}.`,
            failure: 'Could not change the link.',
        });
    };
    const moveLink = (node, row, order) => {
        if (order === null) return;
        runChange({
            request: () => api.post('/gpo/link/set', { guid: row.guid, target: node.dn, name: row.name, order }),
            success: `'${row.name}' is now link order ${order} on ${node.name}.`, failure: 'Could not change the link order.',
        });
    };
    const setBlock = (node, blocked) => runChange({
        confirm: blocked
            ? `Block inheritance on ${node.name}? GPOs linked above it will no longer apply here, except enforced links.`
            : `Stop blocking inheritance on ${node.name}?`,
        title: 'Block Inheritance',
        request: () => api.post('/gpo/inheritance', { target: node.dn, blocked }),
        success: `${node.name}: inheritance ${blocked ? 'blocked' : 'no longer blocked'}.`, failure: 'Could not change inheritance blocking.',
    });

    const runBackup = async () => {
        const { guid, name, path } = backup;
        setBackup(null);
        setBusy(true);
        try {
            const payload = { guid, name };
            if (path.trim()) payload.nasPath = path.trim();
            const res = await api.post('/gpo/backup', payload);
            setMessage({ type: 'success', text: res.data.message || 'Backup finished.' });
        } catch (e) {
            setMessage({ type: 'error', text: errorText(e, 'Backup failed.') });
        } finally {
            setBusy(false);
        }
    };

    const openMenu = (e, target) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: Math.min(e.clientX, window.innerWidth - 270), y: Math.min(e.clientY, window.innerHeight - 260), target });
    };

    const gpoMenuItems = (guid, linkDn) => {
        const g = tree && tree.gpoById.get(guid);
        const name = gpoName(guid);
        return (
            <>
                {linkDn && canEdit && (() => {
                    const found = findLink(tree, linkDn, guid);
                    if (!found) return null;
                    return (
                        <>
                            <MenuItem checked={found.link.enforced} disabled={busy} onClick={() => setLinkOption(linkDn, guid, 'enforced', !found.link.enforced)}>Enforced</MenuItem>
                            <MenuItem checked={found.link.enabled} disabled={busy} onClick={() => setLinkOption(linkDn, guid, 'enabled', !found.link.enabled)}>Link Enabled</MenuItem>
                            <MenuItem disabled={busy} onClick={() => deleteLink(linkDn, guid)}>Delete link</MenuItem>
                            <MenuSeparator />
                        </>
                    );
                })()}
                {linkDn && <MenuItem onClick={() => openGpo(guid)}>Go to GPO</MenuItem>}
                {canEdit && <MenuItem onClick={() => setRegistryGpo({ guid, name })}>Edit registry settings…</MenuItem>}
                {canEdit && <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'copy', guid, name })}>Copy…</MenuItem>}
                {canEdit && <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'rename', guid, name })}>Rename…</MenuItem>}
                {isSuperAdmin && !linkDn && <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'delete', guid, name })}>Delete GPO…</MenuItem>}
                {canEdit && (
                    <>
                        <MenuSeparator />
                        <div style={{ padding: '4px 12px', fontSize: '11px', color: C.muted }}>GPO Status</div>
                        {GPO_STATUSES.map(s => (
                            <MenuItem key={s} checked={g && g.status === s} disabled={busy || (g && g.status === s)} onClick={() => setStatus(guid, name, s)}>{GPO_STATUS_LABELS[s]}</MenuItem>
                        ))}
                        <MenuSeparator />
                        <MenuItem disabled={busy} onClick={() => setBackup({ guid, name, path: '' })}>Back Up…</MenuItem>
                    </>
                )}
            </>
        );
    };

    const renderMenu = () => {
        const t = menu.target;
        return (
            <div role="menu" onClick={e => e.stopPropagation()}
                style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1100, minWidth: '250px', padding: '4px 0', background: 'var(--bg-secondary)', border: C.border, borderRadius: '10px', boxShadow: 'var(--shadow-lg)' }}
                onClickCapture={() => setTimeout(() => setMenu(null), 0)}>
                {(t.type === 'gpo' || t.type === 'link') && gpoMenuItems(t.guid, t.type === 'link' ? t.dn : null)}
                {(t.type === 'domain' || t.type === 'ou') && canEdit && (() => {
                    const node = tree.byDn.get(String(t.dn).toLowerCase());
                    if (!node) return null;
                    return (
                        <>
                            <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'create', linkDn: node.dn })}>Create a GPO in this domain, and Link it here…</MenuItem>
                            <MenuItem disabled={busy} onClick={() => setLinkTarget(node.dn)}>Link an Existing GPO…</MenuItem>
                            <MenuItem checked={node.blockInheritance} disabled={busy} onClick={() => setBlock(node, !node.blockInheritance)}>Block Inheritance</MenuItem>
                            <MenuSeparator />
                        </>
                    );
                })()}
                {t.type === 'gpos' && canEdit && (
                    <>
                        <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'create' })}>New…</MenuItem>
                        <MenuItem disabled={busy} onClick={() => setBackup({ guid: 'ALL', name: 'all GPOs', path: '' })}>Back Up All…</MenuItem>
                        <MenuItem disabled={busy} onClick={() => setDialog({ kind: 'backups' })}>Manage Backups…</MenuItem>
                    </>
                )}
                {(t.type === 'gpo' || t.type === 'link' || (t.type === 'gpos' && canEdit)) && <MenuSeparator />}
                <MenuItem onClick={load}>Refresh</MenuItem>
            </div>
        );
    };

    return (
        <div className="glass-panel animate-fade-in" style={{ padding: '16px', borderRadius: '16px', border: C.border }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                <div style={{ fontSize: '15px', fontWeight: 900, color: 'var(--text-primary)', marginRight: '8px' }}>Group Policy Management</div>
                <button style={btn} onClick={load} disabled={loading}><FiRefreshCw /> {loading ? 'Loading…' : 'Refresh'}</button>
                {canEdit && selectedGuid && (
                    <>
                        <button style={btn} disabled={busy} onClick={() => setRegistryGpo({ guid: selectedGuid, name: gpoName(selectedGuid) })}><FiEdit2 /> Edit registry settings</button>
                        <button style={btn} disabled={busy} onClick={() => setBackup({ guid: selectedGuid, name: gpoName(selectedGuid), path: '' })}><FiSave /> Back up</button>
                        <button style={btn} disabled={busy} onClick={() => setDialog({ kind: 'rename', guid: selectedGuid, name: gpoName(selectedGuid) })}><FiType /> Rename</button>
                        <button style={btn} disabled={busy} onClick={() => setDialog({ kind: 'copy', guid: selectedGuid, name: gpoName(selectedGuid) })}><FiCopy /> Copy</button>
                        {isSuperAdmin && selection.type === 'gpo' && (
                            <button style={{ ...btn, color: '#ef4444' }} disabled={busy} onClick={() => setDialog({ kind: 'delete', guid: selectedGuid, name: gpoName(selectedGuid) })}><FiTrash2 /> Delete GPO</button>
                        )}
                    </>
                )}
                {canEdit && tree && selection && selection.type === 'link' && (() => {
                    const found = findLink(tree, selection.dn, selection.guid);
                    if (!found) return null;
                    return (
                        <>
                            <button style={btn} disabled={busy} onClick={() => setLinkOption(selection.dn, selection.guid, 'enforced', !found.link.enforced)}><FiLock /> {found.link.enforced ? 'Stop enforcing' : 'Enforce'}</button>
                            <button style={btn} disabled={busy} onClick={() => setLinkOption(selection.dn, selection.guid, 'enabled', !found.link.enabled)}><FiSlash /> {found.link.enabled ? 'Disable link' : 'Enable link'}</button>
                            <button style={btn} disabled={busy} onClick={() => deleteLink(selection.dn, selection.guid)}><FiTrash2 /> Delete link</button>
                        </>
                    );
                })()}
                {canEdit && tree && selection && (selection.type === 'domain' || selection.type === 'ou') && (() => {
                    const node = tree.byDn.get(String(selection.dn).toLowerCase());
                    if (!node) return null;
                    return (
                        <>
                            <button style={btn} disabled={busy} onClick={() => setLinkTarget(node.dn)}><FiLink /> Link an existing GPO</button>
                            <button style={btn} disabled={busy} onClick={() => setBlock(node, !node.blockInheritance)}><FiAlertCircle /> {node.blockInheritance ? 'Stop blocking inheritance' : 'Block inheritance'}</button>
                        </>
                    );
                })()}
                {canEdit && selection && selection.type === 'gpos' && (
                    <>
                        <button style={btn} disabled={busy} onClick={() => setDialog({ kind: 'create' })}><FiPlus /> New GPO</button>
                        <button style={btn} disabled={busy} onClick={() => setBackup({ guid: 'ALL', name: 'all GPOs', path: '' })}><FiSave /> Back up all</button>
                        <button style={btn} disabled={busy} onClick={() => setDialog({ kind: 'backups' })}><FiArchive /> Manage backups</button>
                    </>
                )}
                {tree && <span style={{ marginLeft: 'auto', fontSize: '12px', color: C.muted }}>Forest: {tree.root.name} · right-click an item for its actions</span>}
            </div>

            {message && (
                <div onClick={() => setMessage(null)} style={{ cursor: 'pointer', padding: '0.7rem 1rem', borderRadius: '10px', marginBottom: '12px', fontSize: '0.88rem',
                    background: message.type === 'success' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: message.type === 'success' ? '#10b981' : '#ef4444',
                    border: `1px solid ${message.type === 'success' ? '#10b98144' : '#ef444444'}` }}>
                    {message.text}
                </div>
            )}
            {data && data.truncated && (
                <div style={{ fontSize: '12.5px', color: '#f59e0b', marginBottom: '10px' }}>This domain has more OUs than the page reads; some OUs are not shown.</div>
            )}

            {loadError && !tree ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>{loadError}</div>
            ) : !tree ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: C.secondary }}>Reading Group Policy from the domain controller…</div>
            ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', border: C.border, borderRadius: '12px', overflow: 'hidden', background: 'var(--bg-secondary)', minHeight: '60vh' }}>
                    <div style={{ flex: '0 1 300px', minWidth: '240px', maxHeight: '75vh', overflow: 'auto', padding: '8px 4px', borderRight: C.border, background: 'rgba(127,127,127,0.04)' }}>
                        <GpmcTree tree={tree} wmiFilters={wmi.list} selection={selection} expanded={expanded} onToggle={toggle} onSelect={setSelection} onContextMenu={openMenu} />
                    </div>
                    <div style={{ flex: '1 1 480px', minWidth: 0 }}>
                        {selectedGuid ? (
                            <GpoPane key={selectedGuid} guid={selectedGuid} tree={tree} canEdit={canEdit} canReport={canReport} canDelegate={isSuperAdmin}
                                wmiFilters={wmi.list} busy={busy} actions={gpoActions} refreshKey={refreshKey}
                                onSetStatus={setStatus} onOpenContainer={openContainer} onLinkContextMenu={(e, dn) => openMenu(e, { type: 'link', guid: selectedGuid, dn })} />
                        ) : selection ? (
                            <ContainerPane selection={selection} tree={tree} wmiFilters={wmi.list} wmiError={wmi.error} canEdit={canEdit} busy={busy} onOpenGpo={openGpo} onMoveLink={moveLink}
                                onGpoContextMenu={(e, guid, dn) => openMenu(e, dn ? { type: 'link', guid, dn } : { type: 'gpo', guid })} />
                        ) : null}
                    </div>
                </div>
            )}

            {menu && renderMenu()}

            {backup && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div role="dialog" aria-label="Back up GPO" style={{ background: 'var(--bg-secondary)', border: C.border, borderRadius: '16px', padding: '1.6rem', maxWidth: '460px', width: '92%', boxShadow: 'var(--shadow-lg)' }}>
                        <h3 style={{ marginTop: 0, color: 'var(--text-primary)' }}>Back up {backup.guid === 'ALL' ? 'all GPOs' : `'${backup.name}'`}</h3>
                        <label style={{ display: 'block', fontSize: '12px', color: C.secondary, marginBottom: '6px' }}>Location on the domain controller or a share</label>
                        <input type="text" value={backup.path} placeholder="C:\GPO_Backups (default) or \\server\share\GPO" onChange={e => setBackup({ ...backup, path: e.target.value })}
                            style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: C.border, color: 'var(--text-primary)', borderRadius: '6px', marginBottom: '1.2rem' }} />
                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                            <button style={btn} onClick={() => setBackup(null)}>Cancel</button>
                            <button style={{ ...btn, background: 'var(--accent-primary)', color: 'white', border: 'none' }} onClick={runBackup}>Back Up</button>
                        </div>
                    </div>
                </div>
            )}

            {linkTarget && tree && tree.byDn.get(linkTarget.toLowerCase()) && (
                <LinkGpoModal node={tree.byDn.get(linkTarget.toLowerCase())} gpoById={tree.gpoById} onCancel={() => setLinkTarget(null)}
                    onLink={(gpo) => linkGpo(tree.byDn.get(linkTarget.toLowerCase()), gpo)} />
            )}

            {dialog && dialog.kind === 'create' && (() => {
                const node = dialog.linkDn && tree ? tree.byDn.get(dialog.linkDn.toLowerCase()) : null;
                return (
                    <NameDialog title={node ? `New GPO linked to ${node.name}` : 'New GPO'} withComment okLabel="Create"
                        intro={node ? 'The GPO is created in the Group Policy Objects container and linked here, enabled and last in link order.' : 'The GPO is created without links.'}
                        onCancel={closeDialog} onOk={(v) => createGpo(v, node)} />
                );
            })()}
            {dialog && dialog.kind === 'rename' && (
                <NameDialog title="Rename GPO" initialName={dialog.name} requireChange okLabel="Rename" onCancel={closeDialog} onOk={(v) => renameGpo(dialog.guid, dialog.name, v)} />
            )}
            {dialog && dialog.kind === 'copy' && (
                <NameDialog title="Copy GPO" initialName={`Copy of ${dialog.name}`} withCopyAcl okLabel="Copy"
                    intro={`A new GPO with the settings of '${dialog.name}'. Links are not copied.`} onCancel={closeDialog} onOk={(v) => copyGpo(dialog.guid, dialog.name, v)} />
            )}
            {dialog && dialog.kind === 'comment' && (
                <CommentDialog gpoName={dialog.name} initial={dialog.comment} onCancel={closeDialog} onOk={(c) => saveComment(dialog.guid, dialog.name, c)} />
            )}
            {dialog && dialog.kind === 'delete' && (
                <DeleteGpoDialog gpo={{ guid: dialog.guid, name: dialog.name }} linkCount={tree ? gpoLocations(dialog.guid, tree).length : 0}
                    onCancel={closeDialog} onOk={() => deleteGpo(dialog.guid, dialog.name)} />
            )}
            {dialog && dialog.kind === 'filtering' && (
                <TrusteeDialog title="Security Filtering" intro={`'${dialog.name}' will also apply to this user, group or computer.`}
                    onCancel={closeDialog} onOk={(v) => addFiltering(dialog.guid, dialog.name, v)} />
            )}
            {dialog && dialog.kind === 'delegation' && (
                <TrusteeDialog title={dialog.row ? `Change permissions of ${dialog.row.name}` : 'Add a user or group'} withPermission initial={dialog.row}
                    intro={`Permissions on '${dialog.name}'.`} onCancel={closeDialog} onOk={(v) => setDelegation(dialog.guid, dialog.name, v)} />
            )}
            {dialog && dialog.kind === 'backups' && (
                <BackupsDialog gpoExists={(id) => !!(tree && tree.gpoById.has(id))} onClose={closeDialog} onRestore={restoreBackup} />
            )}

            {registryGpo && (
                <RegistryEditModal gpo={registryGpo} onClose={() => setRegistryGpo(null)}
                    onDone={(msg) => { setMessage(msg); if (msg.type === 'success') setRegistryGpo(null); }} />
            )}
        </div>
    );
}
