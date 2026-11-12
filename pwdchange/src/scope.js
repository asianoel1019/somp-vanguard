// OU distinguished names (ALLOWED_OUS) and account names typed into the page.

/** Split at ';' not escaped as "\;" */
function splitDns(value) {
    const out = [];
    let cur = '';
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
        if (s[i] === ';') { out.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
}

/** OU= / CN= parts ending in DC= parts, no control characters */
function isScopeDn(dn) {
    if (!dn || dn.length > 2048 || /[\x00-\x1f]/.test(dn)) return false;
    const parts = dn.split(/(?<!\\),/).map(p => p.trim());
    let seenDc = false;
    for (const p of parts) {
        const m = /^(OU|CN|DC)=(.+)$/i.exec(p);
        if (!m) return false;
        if (m[1].toUpperCase() === 'DC') seenDc = true;
        else if (seenDc) return false;
    }
    return seenDc;
}

// sAMAccountName may not contain " / \ [ ] : ; | = , + * ? < > @ (and no control characters or spaces at the ends)
const SAM_RE = /^[^\x00-\x1f"/\\[\]:;|=,+*?<>@']{1,64}$/;
const UPN_RE = /^[^\x00-\x1f\s"/\\[\]:;|=,+*?<>@'()]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/**
 * What the user typed as the account -> { kind: 'sam' | 'upn', value } or null.
 * "alice", "CORP\alice" (the domain part is dropped: the page serves one domain) and "alice@example.test".
 */
function parseAccount(input) {
    const s = String(input || '').trim();
    if (!s || s.length > 256) return null;
    if (s.includes('@')) return UPN_RE.test(s) ? { kind: 'upn', value: s } : null;
    const sam = s.includes('\\') ? s.slice(s.indexOf('\\') + 1) : s;
    if (s.indexOf('\\') !== s.lastIndexOf('\\')) return null;
    return SAM_RE.test(sam) && sam.trim() === sam ? { kind: 'sam', value: sam } : null;
}

/** A password field: a string of 1-256 characters without control characters. */
function isPasswordText(v) {
    return typeof v === 'string' && v.length >= 1 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
}

module.exports = { splitDns, isScopeDn, parseAccount, isPasswordText };
