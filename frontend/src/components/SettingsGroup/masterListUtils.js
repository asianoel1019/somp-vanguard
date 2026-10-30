// Mirror of backend/lib/provisioningConfig.js splitLines: entries of a software master list are separated by real
// newlines, by the three characters the save route stores for a newline (backslash, backslash, n) or by a legacy
// single backslash + n. A backslash-backslash-n that starts the Path field of a Windows entry is a UNC path.
// Once a stored (two-backslash) separator is present, a single backslash + n is part of a path (soft\notepad\x.exe).
function scan(s, kind, allowLegacy) {
    const parts = [];
    let sawStoredSeparator = false;
    let field = 0;
    let fieldStart = 0;
    let start = 0;
    let i = 0;
    // A legacy single backslash-n only counts as a separator once a whole entry's Path field is behind us
    // (Windows: in Args or later; Linux: in the Command): a backslash-n inside a Path (soft\new\a.exe) is a path part.
    const minLegacyField = kind === 'linux' ? 1 : 2;
    while (i < s.length) {
        const c = s[i];
        if (c === '|') { field++; fieldStart = i + 1; i++; continue; }
        if (c === '\\' && s[i + 1] === '\\' && s[i + 2] === 'n') {
            if (kind !== 'linux' && field === 1 && s.slice(fieldStart, i).trim() === '') { i += 2; continue; }
            sawStoredSeparator = true;
            parts.push(s.slice(start, i));
            i += 3; start = i; field = 0; fieldStart = i;
            continue;
        }
        if (allowLegacy && field >= minLegacyField && c === '\\' && s[i + 1] === 'n' && (i === 0 || s[i - 1] !== '\\')) {
            parts.push(s.slice(start, i));
            i += 2; start = i; field = 0; fieldStart = i;
            continue;
        }
        i++;
    }
    parts.push(s.slice(start));
    return { parts, sawStoredSeparator };
}

export function splitMasterLines(text, kind = 'windows') {
    const s = String(text || '');
    let parts;
    if (/[\r\n]/.test(s)) {
        parts = s.split(/\r?\n/).flatMap(l => scan(l, kind, false).parts);
    } else {
        const storedForm = scan(s, kind, true).sawStoredSeparator;
        parts = scan(s, kind, !storedForm).parts;
    }
    return parts.map(l => l.trim()).filter(l => l.includes('|'));
}

/** Package names (first field) of a master list text. */
export function softwareNames(text, kind = 'windows') {
    return splitMasterLines(text, kind).map(l => l.split('|')[0].trim());
}
