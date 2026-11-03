// Login tokens carry the role they were issued with and stay valid for 24 h. When RBAC changes a user's or a group's
// role, every token issued before that moment is refused, so the change applies on the next request instead of
// after the token expires. Entries older than the token lifetime are dropped because no token can predate them.
const { readDataSync, writeDataSync } = require('./db');

const KEY = 'system/session_revocations.json';
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

let cache = null;

function load() {
    if (!cache) {
        const doc = readDataSync(KEY, null);
        cache = { users: { ...(doc && doc.users) }, groups: { ...(doc && doc.groups) } };
    }
    return cache;
}

function save(now) {
    const doc = load();
    for (const kind of ['users', 'groups']) {
        for (const [k, at] of Object.entries(doc[kind])) if (now - at > TOKEN_LIFETIME_MS) delete doc[kind][k];
    }
    writeDataSync(KEY, doc);
}

const userKey = (username, domain) => `${username}@${domain}`.toLowerCase();

/** Refuse every token of username@domain issued before now. */
function revokeUser(username, domain, now = Date.now()) {
    load().users[userKey(username, domain)] = now;
    save(now);
}

/** Refuse every token that was issued with this mapping group before now. */
function revokeGroup(groupName, now = Date.now()) {
    load().groups[String(groupName).toLowerCase()] = now;
    save(now);
}

/** @param {object} decoded verified JWT payload (iat in seconds) */
function isRevoked(decoded) {
    if (!decoded || !decoded.iat || !decoded.username) return false;
    const doc = load();
    // a token issued in the same second as the revocation is kept (iat has 1 s resolution)
    const issuedBefore = (at) => at !== undefined && decoded.iat < Math.floor(at / 1000);
    if (issuedBefore(doc.users[userKey(decoded.username, decoded.domain)])) return true;
    return (decoded.groups || []).some(g => issuedBefore(doc.groups[String(g).toLowerCase()]));
}

/** Test hook: forget the in-memory copy so the next call reads the stored document. */
function resetForTest() { cache = null; }

module.exports = { revokeUser, revokeGroup, isRevoked, resetForTest };
