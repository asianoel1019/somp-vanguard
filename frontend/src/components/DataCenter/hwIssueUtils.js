// Pure helpers of the Hardware Issues page.

/** Timeline time: ISO (current server) shown in local time; older free-form text as it was saved. */
export function formatNoteTime(ts) {
    if (!ts) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return String(ts);
}

/** A CSV cell: quoted, and text Excel would run as a formula (= + - @, tab, CR) prefixed with ' so it stays text. */
export function csvCell(val) {
    let v = String(val === undefined || val === null ? '' : val);
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return `"${v.replace(/"/g, '""')}"`;
}

/** First letter of a name for the avatar; '?' when there is none. */
export function initialOf(name) {
    return (String(name || '?').trim().charAt(0) || '?').toUpperCase();
}
