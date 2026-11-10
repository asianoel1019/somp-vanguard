// Shaping Active Directory data for AD Control: distinguished names, Windows file times and the OU tree.
// Pure functions, no PowerShell.

// sAMAccountName may not contain " / \ [ ] : ; | = , + * ? < > (a trailing $ marks computer accounts)
const SAM_RE = /^[^\x00-\x1f"/\\[\]:;|=,+*?<>]{1,256}$/;
const isSam = (v) => typeof v === 'string' && SAM_RE.test(v);

/** JSON written by ConvertTo-Json: one object comes back unwrapped, nothing comes back as "" */
function parseList(output) {
    const raw = String(output || '').trim();
    if (!raw || raw === '[]' || raw === 'null') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
}

/** The parts of a DN, split at unescaped commas ("CN=Doe\, John,OU=A,DC=x" -> 3 parts). */
function dnParts(dn) {
    const s = String(dn || '');
    const parts = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === ',') { parts.push(s.slice(start, i)); start = i + 1; }
    }
    if (s.length) parts.push(s.slice(start));
    return parts;
}

/** Value of an RDN with its escapes undone (RFC 4514: "\," "\+" "\\" ... and "\XX" hex bytes as UTF-8). */
function unescapeRdnValue(v) {
    const bytes = [];
    const s = String(v || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
            const hex = s.slice(i + 1, i + 3);
            if (/^[0-9a-f]{2}$/i.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
            bytes.push(...Buffer.from(s[i + 1], 'utf8'));
            i += 1;
            continue;
        }
        bytes.push(...Buffer.from(s[i], 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
}

/** "CN=Doe\, John,OU=A,DC=x" -> "Doe, John" */
function rdnValue(dn) {
    const first = dnParts(dn)[0] || '';
    const eq = first.indexOf('=');
    return eq < 0 ? '' : unescapeRdnValue(first.slice(eq + 1));
}

/** Group names of a memberOf list, sorted. */
function groupNames(dns) {
    const list = Array.isArray(dns) ? dns : dns ? [dns] : [];
    return list.map(rdnValue).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** A DN AD Control may list objects under: only OU= / CN= parts ending in DC= parts, no control characters. */
function isBrowsableDn(dn) {
    const s = String(dn || '');
    if (!s || s.length > 2048 || /[\x00-\x1f]/.test(s)) return false;
    let seenDc = false;
    for (const p of dnParts(s)) {
        const m = p.match(/^(OU|CN|DC)=(.+)$/i);
        if (!m || !m[2].trim()) return false;
        if (m[1].toUpperCase() === 'DC') seenDc = true;
        else if (seenDc) return false;
    }
    return seenDc;
}

/** Windows FILETIME (100 ns since 1601) -> ISO string; 0 / never / invalid -> ''. */
function fileTimeToIso(ft) {
    const s = String(ft === undefined || ft === null ? '' : ft).trim();
    if (!/^\d+$/.test(s)) return '';
    const n = BigInt(s);
    if (n <= 0n || n >= 0x7fffffffffffffffn) return '';
    const ms = Number(n / 10000n) - 11644473600000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Exact last logon from each domain controller's lastLogon: [{ dc, lastLogon (FILETIME), error }]
 * -> { lastLogon (ISO or ''), dc (where it was seen), checked, failed: [dc] }
 */
function newestLogon(perDc) {
    let best = { lastLogon: '', dc: '' };
    const failed = [];
    for (const r of perDc || []) {
        if (r.error) { failed.push(String(r.dc || '')); continue; }
        const iso = fileTimeToIso(r.lastLogon);
        if (iso && (!best.lastLogon || iso > best.lastLogon)) best = { lastLogon: iso, dc: String(r.dc || '') };
    }
    return { ...best, checked: (perDc || []).length - failed.length, failed };
}

/**
 * The /ad/ou-tree answer: { domain: { dn, name }, nodes: [{ dn, name, kind: 'ou' | 'container', parentDn }], truncated }.
 * @param {number} max OUs kept; one more read than this marks the answer truncated.
 */
function shapeOuTree(raw, max) {
    const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const ous = toList(raw && raw.ous);
    const parentOf = (dn) => dnParts(dn).slice(1).join(',');
    const node = (o, kind) => ({ dn: String(o.dn || ''), name: String(o.name || ''), kind, parentDn: parentOf(o.dn) });
    return {
        domain: { dn: String((raw && raw.dn) || ''), name: String((raw && raw.name) || '') },
        nodes: [
            ...toList(raw && raw.containers).map(c => node(c, 'container')),
            ...ous.slice(0, max).map(o => node(o, 'ou')),
        ],
        truncated: ous.length > max,
    };
}

module.exports = { SAM_RE, isSam, parseList, dnParts, unescapeRdnValue, rdnValue, groupNames, isBrowsableDn, fileTimeToIso, newestLogon, shapeOuTree };
