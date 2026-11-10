// Shaping the raw Active Directory data the GPMC-style Group Policy page reads: gPLink / gPOptions attributes,
// distinguished names and WMI filter queries. Pure functions, no PowerShell.

const GUID_IN_LINK_RE = /cn=(\{[0-9a-f-]{36}\})/i;

/**
 * Links of a gPLink attribute ("[LDAP://cn={GUID},cn=policies,...;0][...;2]").
 * Option bits: 1 = link disabled, 2 = enforced. The last entry in the string is link order 1, as GPMC shows it.
 * @returns {{ guid: string, enabled: boolean, enforced: boolean, order: number }[]} sorted by order
 */
function parseGpLink(value) {
    const entries = String(value || '').match(/\[[^\]]*\]/g) || [];
    const links = [];
    for (const entry of entries) {
        const m = entry.match(/^\[(.*);(\d+)\]$/);
        if (!m) continue;
        const g = m[1].match(GUID_IN_LINK_RE);
        if (!g) continue;
        const options = parseInt(m[2], 10) || 0;
        links.push({ guid: g[1].replace(/[{}]/g, '').toLowerCase(), enabled: (options & 1) === 0, enforced: (options & 2) !== 0 });
    }
    return links.reverse().map((l, i) => ({ ...l, order: i + 1 }));
}

/** gPOptions = 1 means the container blocks inheritance. */
const blocksInheritance = (gPOptions) => (parseInt(gPOptions, 10) || 0) & 1 ? true : false;

/** "OU=b,OU=a,DC=x" -> "OU=a,DC=x" (commas escaped as "\," stay inside their part). */
function parentDn(dn) {
    const s = String(dn || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === ',') return s.slice(i + 1);
    }
    return '';
}

/**
 * WMI filter queries from msWMI-Parm2: "<count>;" then per query "3;<nsLen>;<queryLen>;WQL;<namespace>;<query>;".
 * Lengths are used so a ';' inside a query does not split it. Unknown formats come back as one raw entry.
 */
function parseWmiQueries(parm2) {
    const s = String(parm2 || '');
    if (!s) return [];
    try {
        let pos = 0;
        const next = () => {
            const end = s.indexOf(';', pos);
            if (end < 0) throw new Error('format');
            const v = s.slice(pos, end);
            pos = end + 1;
            return v;
        };
        const count = parseInt(next(), 10);
        if (!(count >= 0)) throw new Error('format');
        const queries = [];
        for (let q = 0; q < count; q++) {
            next(); // 3
            const nsLen = parseInt(next(), 10);
            const queryLen = parseInt(next(), 10);
            const language = next();
            if (!(nsLen >= 0) || !(queryLen >= 0)) throw new Error('format');
            const namespace = s.substr(pos, nsLen); pos += nsLen + 1;
            const query = s.substr(pos, queryLen); pos += queryLen + 1;
            queries.push({ language, namespace, query });
        }
        return queries;
    } catch {
        return [{ language: '', namespace: '', query: s }];
    }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * The /gpo/tree answer from the PowerShell output { domain, ous, gpos }.
 * @param {number} max OUs kept; one more read than this marks the answer truncated.
 */
function shapeTree(raw, max) {
    const d = raw && raw.domain ? raw.domain : {};
    const ousRaw = arr(raw && raw.ous);
    const truncated = ousRaw.length > max;
    return {
        domain: {
            dn: str(d.dn), name: str(d.dns), links: parseGpLink(d.gPLink), blockInheritance: blocksInheritance(d.gPOptions),
        },
        ous: ousRaw.slice(0, max).map(o => ({
            dn: str(o.dn), name: str(o.name), parentDn: parentDn(o.dn), links: parseGpLink(o.gPLink), blockInheritance: blocksInheritance(o.gPOptions),
        })),
        gpos: arr(raw && raw.gpos).map(g => ({
            id: str(g.id).replace(/[{}]/g, '').toLowerCase(), name: str(g.name), status: str(g.status), wmiFilter: str(g.wmi),
            created: str(g.created), modified: str(g.modified),
        })),
        truncated,
    };
}

module.exports = { parseGpLink, blocksInheritance, parentDn, parseWmiQueries, shapeTree };
