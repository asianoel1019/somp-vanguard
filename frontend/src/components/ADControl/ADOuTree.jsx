// OU Tree mode: the domain's real OU hierarchy (plus Users / Computers style containers) on the left, the users,
// groups and computers directly in the selected OU on the right. Runs side by side with the BU mode.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FiChevronRight, FiChevronDown, FiGlobe, FiFolder, FiBox, FiRefreshCw } from 'react-icons/fi';
import api from '../../api';
import { buildOuTree, ouPath, dateColumn, formatAdDate } from './adModel';
import { Btn, Banner, Pill } from './Shared';
import UserList from './UserList';
import ObjectList from './ObjectList';

const KINDS = [
    { id: 'users', label: 'Users' },
    { id: 'groups', label: 'Groups' },
    { id: 'computers', label: 'Computers' },
];

function TreeRow({ node, depth, selectedDn, expanded, onToggle, onSelect }) {
    const open = expanded.has(node.dn);
    const sel = selectedDn === node.dn;
    const Icon = node.kind === 'domain' ? FiGlobe : node.kind === 'container' ? FiBox : FiFolder;
    return (
        <>
            <div role="treeitem" aria-selected={sel} aria-expanded={node.children.length ? open : undefined}
                onClick={() => onSelect(node)} onDoubleClick={() => onToggle(node.dn)}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: `4px 8px 4px ${8 + depth * 16}px`, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '13px',
                    borderRadius: '6px', userSelect: 'none', background: sel ? 'rgba(59,130,246,0.18)' : 'transparent', color: sel ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                <span onClick={(e) => { e.stopPropagation(); if (node.children.length) onToggle(node.dn); }} style={{ width: 14, display: 'inline-flex', color: 'var(--text-muted)' }}>
                    {node.children.length ? (open ? <FiChevronDown /> : <FiChevronRight />) : null}
                </span>
                <Icon style={{ color: sel ? 'var(--accent-primary)' : 'var(--text-secondary)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
            </div>
            {open && node.children.map(c => (
                <TreeRow key={c.dn} node={c} depth={depth + 1} selectedDn={selectedDn} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
            ))}
        </>
    );
}

export default function ADOuTree() {
    const [treeData, setTreeData] = useState(null);
    const [treeError, setTreeError] = useState(null);
    const [expanded, setExpanded] = useState(() => new Set());
    const [selectedDn, setSelectedDn] = useState(null);
    const [kind, setKind] = useState('users');
    const [objects, setObjects] = useState({ dn: null, data: null, error: null, loading: false });

    const tree = useMemo(() => (treeData ? buildOuTree(treeData) : null), [treeData]);
    const selectedNode = tree && selectedDn ? tree.byDn.get(selectedDn.toLowerCase()) : null;

    const fetchTree = () => api.get('/ad/ou-tree');
    const applyTree = useCallback((r) => {
        setTreeData(r.data);
        setTreeError(null);
        setExpanded(prev => (prev.size ? prev : new Set([r.data.domain.dn])));
    }, []);
    const treeFailed = (e) => setTreeError(e?.response?.data?.error || 'Could not read the OU tree.');
    useEffect(() => { fetchTree().then(applyTree).catch(treeFailed); }, [applyTree]);

    const loadObjects = useCallback(async (dn) => {
        setObjects(o => ({ ...o, dn, loading: true, error: null }));
        try {
            const r = await api.get('/ad/ou-objects', { params: { dn } });
            setObjects({ dn, data: r.data, error: null, loading: false });
        } catch (e) {
            setObjects({ dn, data: null, error: e?.response?.data?.error || 'Could not read this OU.', loading: false });
        }
    }, []);

    const select = (node) => { setSelectedDn(node.dn); loadObjects(node.dn); };
    const toggle = (dn) => setExpanded(prev => { const n = new Set(prev); if (n.has(dn)) n.delete(dn); else n.add(dn); return n; });
    const refresh = async () => {
        try { applyTree(await fetchTree()); } catch (e) { treeFailed(e); }
        if (selectedDn) loadObjects(selectedDn);
    };

    const data = objects.dn === selectedDn ? objects.data : null;
    const exportBase = selectedNode ? `ad-${selectedNode.name}` : 'ad-ou';

    return (
        <div className="glass-panel animate-fade-in" style={{ padding: '16px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                <Btn icon={<FiRefreshCw />} label="Refresh" onClick={refresh} />
                {selectedNode && <span style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedNode.dn}</span>}
            </div>
            {treeError && <Banner message={{ type: 'error', text: treeError }} />}
            {treeData && treeData.truncated && <div style={{ fontSize: '12.5px', color: '#f59e0b', marginBottom: '8px' }}>This domain has more OUs than the page reads; some OUs are not shown.</div>}
            {!tree && !treeError && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Reading the OU tree…</div>}
            {tree && (
                <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden', background: 'var(--bg-secondary)', minHeight: '60vh' }}>
                    <div role="tree" aria-label="Organizational units" style={{ flex: '0 1 300px', minWidth: '230px', maxHeight: '75vh', overflow: 'auto', padding: '8px 4px', borderRight: '1px solid var(--border-color)', background: 'rgba(127,127,127,0.04)' }}>
                        <TreeRow node={tree.root} depth={0} selectedDn={selectedDn} expanded={expanded} onToggle={toggle} onSelect={select} />
                    </div>
                    <div style={{ flex: '1 1 520px', minWidth: 0, padding: '12px 16px' }}>
                        {!selectedNode ? (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Select an OU or container to list what is directly in it.</div>
                        ) : (
                            <>
                                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>{selectedNode.name}</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>{ouPath(selectedNode)} · objects directly in this {selectedNode.kind === 'domain' ? 'domain root' : selectedNode.kind === 'container' ? 'container' : 'OU'}</div>
                                <div role="tablist" style={{ display: 'flex', gap: '18px', borderBottom: '1px solid var(--border-color)', marginBottom: '12px' }}>
                                    {KINDS.map(k => (
                                        <button key={k.id} role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)}
                                            style={{ background: 'transparent', border: 'none', padding: '8px 0', cursor: 'pointer', fontSize: '13px', fontWeight: kind === k.id ? 700 : 500,
                                                color: kind === k.id ? 'var(--text-primary)' : 'var(--text-secondary)', borderBottom: kind === k.id ? '2px solid var(--accent-primary)' : '2px solid transparent' }}>
                                            {k.label}{data ? ` (${data[k.id].length}${data.truncated.includes(k.id.slice(0, -1)) ? '+' : ''})` : ''}
                                        </button>
                                    ))}
                                </div>
                                {objects.error && objects.dn === selectedDn && <Banner message={{ type: 'error', text: objects.error }} />}
                                {!data && !objects.error && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Reading…</div>}
                                {data && data.truncated.includes(kind.slice(0, -1)) && (
                                    <div style={{ fontSize: '12.5px', color: '#f59e0b', marginBottom: '8px' }}>Only the first {data.limit} {kind} are listed.</div>
                                )}
                                {data && kind === 'users' && (
                                    <UserList users={data.users} exportName={`${exportBase}-users`} onChanged={() => loadObjects(selectedDn)}
                                        extraColumns={[{ ...dateColumn('LastLogonDate', 'Last logon (approx.)'), render: u => formatAdDate(u.LastLogonDate) || 'Never' }]} />
                                )}
                                {data && kind === 'groups' && (
                                    <ObjectList rows={data.groups} exportName={`${exportBase}-groups`} empty="No groups directly in here." columns={[
                                        { key: 'Name', label: 'Group', render: g => <span style={{ fontWeight: 600 }}>{g.Name}</span> },
                                        { key: 'GroupScope', label: 'Scope' },
                                        { key: 'GroupCategory', label: 'Type' },
                                        { key: 'Description', label: 'Description' },
                                    ]} />
                                )}
                                {data && kind === 'computers' && (
                                    <ObjectList rows={data.computers} exportName={`${exportBase}-computers`} empty="No computers directly in here." columns={[
                                        { key: 'Name', label: 'Computer', render: c => <span style={{ fontWeight: 600 }}>{c.Name}</span> },
                                        { key: 'OperatingSystem', label: 'Operating system' },
                                        { ...dateColumn('LastLogonDate', 'Last logon (approx.)'), render: c => formatAdDate(c.LastLogonDate) || 'Never' },
                                        { key: 'Enabled', label: 'Status', csv: c => (c.Enabled ? 'Enabled' : 'Disabled'), render: c => (c.Enabled ? <Pill tone="success">Enabled</Pill> : <Pill tone="danger">Disabled</Pill>) },
                                        { key: 'Description', label: 'Description' },
                                    ]} />
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
