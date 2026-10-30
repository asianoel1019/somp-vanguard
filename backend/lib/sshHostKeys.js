// Trust-on-first-use SSH host key pinning, stored in document_store
// `server_operation/ssh_known_hosts.json` as { "<ip>": { fingerprint: "sha256:<hex>", firstSeen, lastSeen } }.

const KNOWN_HOSTS_KEY = 'server_operation/ssh_known_hosts.json';

// Both processes pin keys (inventory scans in the worker, deploy / remote actions in the web): the default store
// changes the document only through an atomic read-modify-write (lib/docStore.js), never read -> write.
const defaultStore = {
    read() {
        const { readDataSync } = require('./db');
        const data = readDataSync(KNOWN_HOSTS_KEY, {});
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    },
    mutate(fn) {
        const { mutateDocument } = require('./docStore');
        return mutateDocument(KNOWN_HOSTS_KEY, fn, { defaultValue: {}, fnName: 'sshHostKeys.mutate', label: 'SSH known hosts' });
    }
};

/** fn(known) on the store: atomically via store.mutate when it has one, else read -> fn -> write (test stores). */
function mutateKnown(store, fn) {
    if (typeof store.mutate === 'function') return store.mutate(fn);
    const known = store.read();
    const before = JSON.stringify(known);
    const result = fn(known);
    if (JSON.stringify(known) !== before) store.write(known);
    return result;
}

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
    const entry = store.read()[host];
    if (entry && entry.fingerprint) {
        if (entry.fingerprint === fingerprint) return { status: 'match', fingerprint };
        return { status: 'mismatch', expected: entry.fingerprint, fingerprint };
    }
    // first sight: pin on the CURRENT document (another process may have pinned this host meanwhile)
    return mutateKnown(store, (known) => {
        const cur = known[host];
        if (cur && cur.fingerprint) {
            if (cur.fingerprint === fingerprint) return { status: 'match', fingerprint };
            return { status: 'mismatch', expected: cur.fingerprint, fingerprint };
        }
        const now = new Date().toISOString();
        known[host] = { fingerprint, firstSeen: now, lastSeen: now };
        return { status: 'new', fingerprint };
    });
}

function forgetHostKey(host, store = defaultStore) {
    return mutateKnown(store, (known) => {
        if (!Object.prototype.hasOwnProperty.call(known, host)) return false;
        delete known[host];
        return true;
    });
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
