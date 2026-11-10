// Left pane of the GPMC-style Group Policy page: domain > OUs with their linked GPOs, then the Group Policy Objects
// and WMI Filters containers. Enforced links carry a lock, disabled links are dimmed, blocked OUs a blue mark.
import React from 'react';
import { FiChevronRight, FiChevronDown, FiGlobe, FiFolder, FiFileText, FiLock, FiAlertCircle, FiLayers, FiFilter } from 'react-icons/fi';
import { linkedGpos, sortedGpos } from './gpmcModel';
import { C } from './gpmcStyle';

const INDENT = 16;

function Row({ depth, icon, label, badge, selected, dim, expandable, expanded, onToggle, onSelect, onContextMenu, title }) {
    return (
        <div role="treeitem" aria-selected={selected} aria-expanded={expandable ? expanded : undefined} title={title}
            onClick={onSelect} onDoubleClick={expandable ? onToggle : undefined}
            onContextMenu={(e) => { e.preventDefault(); onSelect(); if (onContextMenu) onContextMenu(e); }}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: `4px 8px 4px ${8 + depth * INDENT}px`, cursor: 'pointer', whiteSpace: 'nowrap',
                borderRadius: '6px', fontSize: '13px', userSelect: 'none', opacity: dim ? 0.55 : 1,
                background: selected ? 'rgba(59,130,246,0.18)' : 'transparent', color: selected ? C.accent : 'var(--text-primary)' }}>
            <span onClick={(e) => { e.stopPropagation(); if (expandable) onToggle(); }} style={{ width: 14, display: 'inline-flex', color: C.muted }}>
                {expandable ? (expanded ? <FiChevronDown /> : <FiChevronRight />) : null}
            </span>
            <span style={{ display: 'inline-flex', color: selected ? C.accent : C.secondary }}>{icon}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            {badge}
        </div>
    );
}

export default function GpmcTree({ tree, wmiFilters, selection, expanded, onToggle, onSelect, onContextMenu }) {
    const isOpen = (key) => expanded.has(key);
    const sel = selection && selection.key;

    const renderContainer = (node, depth) => {
        const key = `c:${node.dn}`;
        const links = linkedGpos(node, tree.gpoById);
        const hasChildren = links.length > 0 || node.children.length > 0;
        const target = { type: node.kind, key, dn: node.dn };
        return (
            <React.Fragment key={key}>
                <Row depth={depth} icon={node.kind === 'domain' ? <FiGlobe /> : <FiFolder />} label={node.name} selected={sel === key}
                    expandable={hasChildren} expanded={isOpen(key)} onToggle={() => onToggle(key)} onSelect={() => onSelect(target)}
                    onContextMenu={(e) => onContextMenu(e, target)}
                    title={node.blockInheritance ? 'Inheritance blocked' : undefined}
                    badge={node.blockInheritance ? <FiAlertCircle style={{ color: '#3b82f6' }} aria-label="Inheritance blocked" /> : null} />
                {isOpen(key) && (
                    <>
                        {links.map(l => {
                            const lkey = `l:${node.dn}:${l.guid}:${l.order}`;
                            const lt = { type: 'link', key: lkey, dn: node.dn, guid: l.guid };
                            return (
                                <Row key={lkey} depth={depth + 1} icon={<FiFileText />} label={l.name} selected={sel === lkey} dim={!l.enabled}
                                    title={[l.enforced ? 'Enforced' : '', l.enabled ? '' : 'Link disabled'].filter(Boolean).join(', ') || undefined}
                                    onSelect={() => onSelect(lt)} onContextMenu={(e) => onContextMenu(e, lt)}
                                    badge={l.enforced ? <FiLock style={{ color: '#f59e0b' }} aria-label="Enforced" /> : null} />
                            );
                        })}
                        {node.children.map(c => renderContainer(c, depth + 1))}
                        {node.kind === 'domain' && renderSpecial(depth + 1)}
                    </>
                )}
            </React.Fragment>
        );
    };

    const renderSpecial = (depth) => {
        const gpos = sortedGpos(tree.gpoById);
        const gt = { type: 'gpos', key: 'gpos' };
        const wt = { type: 'wmis', key: 'wmis' };
        return (
            <>
                <Row depth={depth} icon={<FiLayers />} label="Group Policy Objects" selected={sel === 'gpos'} expandable={gpos.length > 0}
                    expanded={isOpen('gpos')} onToggle={() => onToggle('gpos')} onSelect={() => onSelect(gt)} onContextMenu={(e) => onContextMenu(e, gt)} />
                {isOpen('gpos') && gpos.map(g => {
                    const k = `g:${g.id}`;
                    const t = { type: 'gpo', key: k, guid: g.id };
                    return <Row key={k} depth={depth + 1} icon={<FiFileText />} label={g.name} selected={sel === k}
                        dim={g.status === 'AllSettingsDisabled'} onSelect={() => onSelect(t)} onContextMenu={(e) => onContextMenu(e, t)} />;
                })}
                <Row depth={depth} icon={<FiFilter />} label="WMI Filters" selected={sel === 'wmis'} expandable={(wmiFilters || []).length > 0}
                    expanded={isOpen('wmis')} onToggle={() => onToggle('wmis')} onSelect={() => onSelect(wt)} onContextMenu={(e) => onContextMenu(e, wt)} />
                {isOpen('wmis') && (wmiFilters || []).map(f => {
                    const k = `w:${f.id}`;
                    const t = { type: 'wmi', key: k, wmiId: f.id };
                    return <Row key={k} depth={depth + 1} icon={<FiFilter />} label={f.name} selected={sel === k} onSelect={() => onSelect(t)} onContextMenu={(e) => onContextMenu(e, t)} />;
                })}
            </>
        );
    };

    return <div role="tree" aria-label="Group Policy Management">{renderContainer(tree.root, 0)}</div>;
}
