// Trust-on-first-use SSH host key pinning, stored in document_store
// `server_operation/ssh_known_hosts.json` as { "<ip>": { fingerprint: "sha256:<hex>", firstSeen, lastSeen } }.

const KNOWN_HOSTS_KEY = 'server_operation/ssh_known_hosts.json';

const defaultStore = {
    read() {
        const { readDataSync } = require('./db');
        const data = readDataSync(KNOWN_HOSTS_KEY, {});
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    },
    write(data) {
        const { writeDataSync } = require('./db');
        writeDataSync(KNOWN_HOSTS_KEY, data);
    }
};

function normalizeFingerprint(hash) {
    const h = String(hash || '').trim().toLowerCase().replace(/^sha256:/, '');
    return `sha256:${h}`;
}

/**
 * Compare a presented host key hash against the pinned one; pin on first sight.
 * @returns {{ status: 'new'|'match'|'mismatch', expected?: string, fingerprint: string }}
 */
function checkHostKey(host, hash, store = defaultStore) {
    const fingerprint = normalizeFingerprint(hash);
    const known = store.read();
    const entry = known[host];
    const now = new Date().toISOString();
    if (!entry || !entry.fingerprint) {
        known[host] = { fingerprint, firstSeen: now, lastSeen: now };
        store.write(known);
        return { status: 'new', fingerprint };
    }
    if (entry.fingerprint === fingerprint) {
        return { status: 'match', fingerprint };
    }
    return { status: 'mismatch', expected: entry.fingerprint, fingerprint };
}

function forgetHostKey(host, store = defaultStore) {
    const known = store.read();
    if (!Object.prototype.hasOwnProperty.call(known, host)) return false;
    delete known[host];
    store.write(known);
    return true;
}

function listHostKeys(store = defaultStore) {
    return store.read();
}

class HostKeyChangedError extends Error {
    constructor(host, expected, actual) {
        super(`host key changed for ${host} (expected ${expected}, got ${actual}); credentials were not sent. A SuperAdmin must forget the pinned key if the change is legitimate.`);
        this.name = 'HostKeyChangedError';
        this.code = 'HOST_KEY_CHANGED';
    }
}

module.exports = {
    KNOWN_HOSTS_KEY,
    checkHostKey,
    forgetHostKey,
    listHostKeys,
    normalizeFingerprint,
    HostKeyChangedError
};
