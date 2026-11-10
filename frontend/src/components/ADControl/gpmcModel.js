// Pure helpers of the GPMC-style Group Policy page: the domain / OU tree, where a GPO is linked, and the
// Group Policy Inheritance list of a container, computed the way the Group Policy Management Console shows them.

export const GPO_STATUS_LABELS = {
    AllSettingsEnabled: 'Enabled',
    UserSettingsDisabled: 'User configuration settings disabled',
    ComputerSettingsDisabled: 'Computer configuration settings disabled',
    AllSettingsDisabled: 'All settings disabled',
};
export const GPO_STATUSES = Object.keys(GPO_STATUS_LABELS);

export const PERMISSION_LABELS = {
    GpoApply: 'Read (from Security Filtering)',
    GpoRead: 'Read',
    GpoEdit: 'Edit settings',
    GpoEditDeleteModifySecurity: 'Edit settings, delete, modify security',
    GpoCustom: 'Custom',
    None: 'None',
};

/**
 * Tree of the /gpo/tree answer.
 * @returns {{ root: object, byDn: Map<string, object>, gpoById: Map<string, object>, nodes: object[] }}
 */
export function buildGpmcTree(data) {
    const d = (data && data.domain) || {};
    const root = { kind: 'domain', dn: d.dn || '', name: d.name || '', links: d.links || [], blockInheritance: !!d.blockInheritance, children: [], parent: null };
    const byDn = new Map([[root.dn.toLowerCase(), root]]);
    const ous = ((data && data.ous) || []).map(o => ({ kind: 'ou', dn: o.dn, name: o.name, parentDn: o.parentDn || '', links: o.links || [], blockInheritance: !!o.blockInheritance, children: [], parent: null }));
    for (const ou of ous) byDn.set(String(ou.dn).toLowerCase(), ou);
    for (const ou of ous) {
        // an OU whose parent was not read (a truncated answer) hangs off the domain
        const parent = byDn.get(String(ou.parentDn).toLowerCase()) || root;
        ou.parent = parent;
        parent.children.push(ou);
    }
    const sortChildren = (n) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sortChildren); };
    sortChildren(root);
    const gpoById = new Map(((data && data.gpos) || []).map(g => [String(g.id).toLowerCase(), g]));
    return { root, byDn, gpoById, nodes: [root, ...ous] };
}

/** "example.test/Workstations/Kiosk" */
export function canonicalPath(node) {
    const parts = [];
    for (let n = node; n; n = n.parent) parts.unshift(n.name);
    return parts.join('/');
}

const gpoInfo = (guid, gpoById) => {
    const g = gpoById.get(String(guid).toLowerCase());
    return g
        ? { name: g.name, status: g.status, wmiFilter: g.wmiFilter || '', modified: g.modified || '', missing: false }
        : { name: '(GPO not found)', status: '', wmiFilter: '', modified: '', missing: true };
};

/** The GPOs linked to a container, in link order. */
export function linkedGpos(node, gpoById) {
    return [...(node.links || [])].sort((a, b) => a.order - b.order).map(l => ({ ...l, ...gpoInfo(l.guid, gpoById) }));
}

/**
 * Group Policy Inheritance of a container, highest precedence first.
 * - Disabled links never apply.
 * - Links of the container come first, then its parent's, up to the domain; a container that blocks inheritance
 *   stops its parents' links.
 * - Enforced links apply through a block and come before all others, the domain's (highest container's) first.
 */
export function inheritance(node, gpoById) {
    const chain = [];
    for (let n = node; n; n = n.parent) chain.push(n);
    const enforced = [];
    const normal = [];
    let blocked = false;
    chain.forEach((level, depth) => {
        for (const l of [...(level.links || [])].sort((a, b) => a.order - b.order)) {
            if (!l.enabled) continue;
            const entry = { ...l, ...gpoInfo(l.guid, gpoById), location: level.name, depth };
            if (l.enforced) enforced.push(entry);
            else if (!blocked) normal.push(entry);
        }
        if (level.blockInheritance) blocked = true;
    });
    // enforced: the highest container wins, so it goes first
    enforced.sort((a, b) => b.depth - a.depth || a.order - b.order);
    return [...enforced, ...normal].map((e, i) => {
        const out = { ...e, precedence: i + 1 };
        delete out.depth;
        return out;
    });
}

/** Every container a GPO is linked to (Scope tab). */
export function gpoLocations(guid, tree) {
    const id = String(guid).toLowerCase();
    const out = [];
    for (const node of tree.nodes) {
        for (const l of node.links || []) {
            if (l.guid === id) out.push({ node, location: node.name, path: canonicalPath(node), enforced: l.enforced, enabled: l.enabled, order: l.order });
        }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

const trusteeName = (p) => (p.domain ? `${p.domain}\\${p.trustee}` : p.trustee);

/** Security Filtering: who the GPO applies to. */
export function securityFiltering(permissions) {
    return (permissions || []).filter(p => p.permission === 'GpoApply' && !p.denied).map(p => ({ name: trusteeName(p), sidType: p.sidType || '' }));
}

/** Delegation tab rows. */
export function delegationRows(permissions) {
    return (permissions || []).map(p => ({
        name: trusteeName(p),
        allowed: (p.denied ? 'Deny: ' : '') + (PERMISSION_LABELS[p.permission] || p.permission),
        inherited: p.inherited ? 'Yes' : 'No',
    })).sort((a, b) => a.name.localeCompare(b.name));
}

/** All GPOs, by name (the Group Policy Objects container). */
export function sortedGpos(gpoById) {
    return [...gpoById.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/** The link of a GPO on a container, or null. */
export function findLink(tree, dn, guid) {
    const node = tree.byDn.get(String(dn).toLowerCase());
    if (!node) return null;
    const link = (node.links || []).find(l => l.guid === String(guid).toLowerCase());
    return link ? { node, link } : null;
}

/** GPOs not yet linked to a container, by name (Link an Existing GPO). */
export function linkableGpos(node, gpoById, filter = '') {
    const linked = new Set((node.links || []).map(l => l.guid));
    const f = String(filter).trim().toLowerCase();
    return sortedGpos(gpoById).filter(g => !linked.has(g.id) && (!f || g.name.toLowerCase().includes(f)));
}

/** New link order after moving a link up (-1) or down (+1), or null at either end. */
export function movedOrder(node, guid, delta) {
    const link = (node.links || []).find(l => l.guid === guid);
    if (!link) return null;
    const next = link.order + delta;
    return next >= 1 && next <= node.links.length ? next : null;
}
