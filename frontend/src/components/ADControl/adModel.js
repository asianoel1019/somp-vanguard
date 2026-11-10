// Pure helpers of AD Control: dates as AD returns them, CSV export, batch previews and the OU tree.

/** A date from AD ("/Date(ms)/", ISO text or empty) for display; '' when there is none. */
export function formatAdDate(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'string' && val.includes('/Date(')) {
        const m = val.match(/-?\d+/);
        return m ? new Date(parseInt(m[0], 10)).toLocaleString() : '';
    }
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? String(val) : d.toLocaleString();
}

/**
 * One CSV cell: quoted when needed; text starting with = + - @ (or a tab / CR) gets a leading ' so spreadsheet
 * programs do not run it as a formula.
 */
export function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (with a BOM so Excel reads UTF-8) of rows; columns: [{ key, label, value?(row) }]. */
export function toCsv(rows, columns) {
    const head = columns.map(c => csvCell(c.label)).join(',');
    const body = (rows || []).map(r => columns.map(c => csvCell(c.value ? c.value(r) : r[c.key])).join(','));
    return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

export const BATCH_ACTIONS = {
    unlock: { label: 'Unlock', done: 'unlocked', applies: (u) => !!u.LockedOut },
    enable: { label: 'Enable', done: 'enabled', applies: (u) => !u.Enabled },
    disable: { label: 'Disable', done: 'disabled', applies: (u) => !!u.Enabled },
};
export const MAX_BATCH = 100;

/**
 * What a batch action would do to the selected accounts: { change, unchanged, protected }.
 * Accounts already in the target state (an unlocked account for Unlock, ...) and protected accounts (administrators:
 * the server refuses them anyway) are left out of the request.
 */
export function batchPreview(users, selected, action) {
    const spec = BATCH_ACTIONS[action];
    const chosen = (users || []).filter(u => selected.has(u.SamAccountName));
    const open = chosen.filter(u => !u.Protected);
    return {
        change: open.filter(u => spec.applies(u)),
        unchanged: open.filter(u => !spec.applies(u)),
        protected: chosen.filter(u => u.Protected),
    };
}

/**
 * Tree of the /ad/ou-tree answer: { root, byDn } with children sorted (containers first, then OUs, by name).
 * A node whose parent was not read (a truncated answer) hangs off the domain.
 */
export function buildOuTree(data) {
    const d = (data && data.domain) || {};
    const root = { dn: d.dn || '', name: d.name || '', kind: 'domain', children: [], parent: null };
    const byDn = new Map([[root.dn.toLowerCase(), root]]);
    const nodes = ((data && data.nodes) || []).map(n => ({ ...n, children: [], parent: null }));
    for (const n of nodes) byDn.set(String(n.dn).toLowerCase(), n);
    for (const n of nodes) {
        const parent = byDn.get(String(n.parentDn).toLowerCase()) || root;
        n.parent = parent;
        parent.children.push(n);
    }
    const order = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'container' ? -1 : 1) || a.name.localeCompare(b.name);
    const sort = (n) => { n.children.sort(order); n.children.forEach(sort); };
    sort(root);
    return { root, byDn };
}

/** "example.test/Workstations/Kiosk" */
export function ouPath(node) {
    const parts = [];
    for (let n = node; n; n = n.parent) parts.unshift(n.name);
    return parts.join('/');
}

/** Rows whose listed fields contain the filter text (case-insensitive). */
export function filterRows(rows, text, fields) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter(r => fields.some(f => String(r[f] || '').toLowerCase().includes(q)));
}

/** Offer text as a file download (CSV export). */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** UserList extra column: a date field formatted for display and export. */
export const dateColumn = (key, label) => ({ key, label, render: u => formatAdDate(u[key]), csv: u => formatAdDate(u[key]) });
