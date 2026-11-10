// Pure helpers of the DNS Hub delete preview: which records start ticked and what the delete request sends.

// Ticked by default: address and alias records. TXT / MX / PTR are deleted only when the user ticks them.
const DEFAULT_TICKED = ['A', 'AAAA', 'CNAME'];

/** Key of record j of preview row i. */
export const deleteKey = (i, j) => `${i}:${j}`;

/** Keys of the records ticked when the preview opens. */
export function defaultDeleteSelection(preview) {
    const keys = [];
    (preview || []).forEach((p, i) => (p.records || []).forEach((rec, j) => {
        if (rec.deletable && DEFAULT_TICKED.includes(String(rec.type).toUpperCase())) keys.push(deleteKey(i, j));
    }));
    return keys;
}

/** Records to send to /records/delete: one { fqdn, type, data } per ticked, deletable record. */
export function deleteItems(preview, selected) {
    const items = [];
    (preview || []).forEach((p, i) => (p.records || []).forEach((rec, j) => {
        if (rec.deletable && selected.has(deleteKey(i, j))) items.push({ fqdn: p.fqdn, type: rec.type, data: rec.data });
    }));
    return items;
}
