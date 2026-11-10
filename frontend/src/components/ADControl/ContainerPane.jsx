// Right pane for everything that is not a GPO, as in GPMC: a domain or OU (Linked Group Policy Objects, Group Policy
// Inheritance), the Group Policy Objects container, the WMI Filters container and one WMI filter.
import React, { useState } from 'react';
import { linkedGpos, inheritance, sortedGpos, canonicalPath, formatDate, GPO_STATUS_LABELS } from './gpmcModel';
import { Tabs, SectionLabel, Table, KeyValues, Notice } from './gpmcUi';
import { yesNo } from './gpmcStyle';

const Title = ({ children, sub }) => (
    <div style={{ padding: '14px 16px 6px' }}>
        <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>{children}</div>
        {sub && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
);

const statusLabel = (s) => GPO_STATUS_LABELS[s] || s || '';

function OuPane({ node, tree, onOpenGpo, onGpoContextMenu }) {
    const [tab, setTab] = useState('links');
    const links = linkedGpos(node, tree.gpoById);
    const inherited = inheritance(node, tree.gpoById);
    return (
        <>
            <Title sub={canonicalPath(node)}>{node.name}</Title>
            <Tabs tabs={[{ id: 'links', label: 'Linked Group Policy Objects' }, { id: 'inherit', label: 'Group Policy Inheritance' }]} active={tab} onChange={setTab} />
            <div style={{ padding: '4px 16px 16px' }}>
                {node.blockInheritance && (
                    <div style={{ margin: '12px 0 0', fontSize: '12.5px', color: '#3b82f6' }}>This {node.kind === 'domain' ? 'domain' : 'OU'} blocks inheritance: only enforced links from above apply.</div>
                )}
                {tab === 'links' && (
                    <>
                        <SectionLabel>Link order 1 has the highest precedence</SectionLabel>
                        <Table
                            columns={[
                                { key: 'order', label: 'Link Order', width: '80px' },
                                { key: 'name', label: 'GPO' },
                                { key: 'enforced', label: 'Enforced', render: r => yesNo(r.enforced) },
                                { key: 'enabled', label: 'Link Enabled', render: r => yesNo(r.enabled) },
                                { key: 'status', label: 'GPO Status', render: r => statusLabel(r.status) },
                                { key: 'wmiFilter', label: 'WMI Filter', render: r => r.wmiFilter || 'None' },
                                { key: 'modified', label: 'Modified', render: r => formatDate(r.modified) },
                            ]}
                            rows={links.map(l => ({ ...l, key: `${l.guid}:${l.order}` }))}
                            empty="No GPOs are linked here."
                            onRowDoubleClick={(r) => onOpenGpo(r.guid)}
                            onRowContextMenu={(e, r) => onGpoContextMenu(e, r.guid, node.dn)}
                        />
                    </>
                )}
                {tab === 'inherit' && (
                    <>
                        <SectionLabel>The GPOs that apply here, precedence 1 first (disabled links and blocked parents left out)</SectionLabel>
                        <Table
                            columns={[
                                { key: 'precedence', label: 'Precedence', width: '90px' },
                                { key: 'name', label: 'GPO', render: r => <>{r.name}{r.enforced ? ' (Enforced)' : ''}</> },
                                { key: 'location', label: 'Location' },
                                { key: 'status', label: 'GPO Status', render: r => statusLabel(r.status) },
                                { key: 'wmiFilter', label: 'WMI Filter', render: r => r.wmiFilter || 'None' },
                            ]}
                            rows={inherited.map(e => ({ ...e, key: `${e.precedence}` }))}
                            empty="No GPOs apply here."
                            onRowDoubleClick={(r) => onOpenGpo(r.guid)}
                        />
                    </>
                )}
            </div>
        </>
    );
}

export default function ContainerPane({ selection, tree, wmiFilters, wmiError, onOpenGpo, onGpoContextMenu }) {
    if (selection.type === 'domain' || selection.type === 'ou') {
        const node = tree.byDn.get(String(selection.dn).toLowerCase());
        if (!node) return <Notice>This container is no longer in the tree. Refresh to reload it.</Notice>;
        return <OuPane key={node.dn} node={node} tree={tree} onOpenGpo={onOpenGpo} onGpoContextMenu={onGpoContextMenu} />;
    }

    if (selection.type === 'gpos') {
        const gpos = sortedGpos(tree.gpoById);
        return (
            <>
                <Title sub={`${gpos.length} GPO(s) in ${tree.root.name}`}>Group Policy Objects</Title>
                <div style={{ padding: '4px 16px 16px' }}>
                    <Table
                        columns={[
                            { key: 'name', label: 'Name' },
                            { key: 'status', label: 'GPO Status', render: r => statusLabel(r.status) },
                            { key: 'wmiFilter', label: 'WMI Filter', render: r => r.wmiFilter || 'None' },
                            { key: 'modified', label: 'Modified', render: r => formatDate(r.modified) },
                        ]}
                        rows={gpos.map(g => ({ ...g, key: g.id }))}
                        empty="No GPOs found."
                        onRowDoubleClick={(r) => onOpenGpo(r.id)}
                        onRowContextMenu={(e, r) => onGpoContextMenu(e, r.id)}
                    />
                </div>
            </>
        );
    }

    if (selection.type === 'wmis') {
        return (
            <>
                <Title>WMI Filters</Title>
                <div style={{ padding: '4px 16px 16px' }}>
                    {wmiError ? <Notice tone="error">{wmiError}</Notice> : (
                        <Table
                            columns={[{ key: 'name', label: 'Name' }, { key: 'description', label: 'Description' }, { key: 'modified', label: 'Modified', render: r => formatDate(r.modified) }]}
                            rows={(wmiFilters || []).map(f => ({ ...f, key: f.id }))}
                            empty="No WMI filters in this domain."
                        />
                    )}
                </div>
            </>
        );
    }

    if (selection.type === 'wmi') {
        const f = (wmiFilters || []).find(x => x.id === selection.wmiId);
        if (!f) return <Notice>This WMI filter is no longer listed. Refresh to reload it.</Notice>;
        const users = sortedGpos(tree.gpoById).filter(g => g.wmiFilter && g.wmiFilter === f.name);
        return (
            <>
                <Title>{f.name}</Title>
                <div style={{ padding: '12px 16px 16px' }}>
                    <KeyValues items={[['Description', f.description || ''], ['Modified', formatDate(f.modified)], ['ID', f.id]]} />
                    <SectionLabel>Queries</SectionLabel>
                    <Table columns={[{ key: 'namespace', label: 'Namespace' }, { key: 'query', label: 'Query', render: r => <code style={{ wordBreak: 'break-all' }}>{r.query}</code> }]}
                        rows={f.queries} empty="No queries." />
                    <SectionLabel>GPOs that use this WMI filter</SectionLabel>
                    <Table columns={[{ key: 'name', label: 'GPO' }, { key: 'status', label: 'GPO Status', render: r => statusLabel(r.status) }]}
                        rows={users.map(g => ({ ...g, key: g.id }))} empty="No GPO uses this filter." onRowDoubleClick={(r) => onOpenGpo(r.id)} />
                </div>
            </>
        );
    }

    return <Notice>Select an item in the tree.</Notice>;
}
