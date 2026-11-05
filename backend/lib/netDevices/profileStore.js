// Management connection of each network device (network_service/device_mgmt.json, keyed by device id).
// Secrets are stored encrypted and shown masked. Changing the address, port or vendor drops the stored secrets:
// a stored token is never sent to a host it was not entered for.
const net = require('net');
const { readDataSync } = require('../db');
const { mutateDocument } = require('../docStore');
const { encryptText, decryptText } = require('../crypto');
const { netError } = require('./errors');

const KEY = 'network_service/device_mgmt.json';
const MASK = '********';
const SECRET_FIELDS = ['token', 'password', 'apiKey', 'enableSecret'];
const TRANSPORTS = ['auto', 'api', 'ssh'];
const DEFAULT_SSH_PORT = 22;

// The vendors of the spec. Only those with a driver are available; the rest are listed so the page can say so.
const VENDORS = {
    fortigate: { label: 'Fortinet FortiGate', types: ['Firewall'], available: true, defaultPort: 443, auth: 'token', scope: 'vdom' },
    paloalto: { label: 'Palo Alto Networks', types: ['Firewall'], available: true, defaultPort: 443, auth: 'apiKey', scope: 'vsys' },
    // Check Point is read through its management server; `target` names the gateway of this device there
    checkpoint: { label: 'Check Point', types: ['Firewall'], available: true, defaultPort: 443, auth: 'apiKey', scope: 'domain', target: 'gateway' },
    // Switch / router vendors: an API (RESTCONF, NX-API, Junos REST) with SSH as fallback (`transports`);
    // `enable`: an optional enable secret for SSH sessions that start below privilege 15
    'cisco-ios': { label: 'Cisco IOS / IOS-XE', types: ['Switch', 'Router'], available: true, defaultPort: 443, auth: 'password', scope: null, transports: ['api', 'ssh'], enable: true },
    'cisco-nxos': { label: 'Cisco NX-OS', types: ['Switch'], available: true, defaultPort: 443, auth: 'password', scope: null, transports: ['api', 'ssh'] },
    juniper: { label: 'Juniper Junos', types: ['Switch', 'Router'], available: true, defaultPort: 3443, auth: 'password', scope: null, transports: ['api', 'ssh'] },
    // F5 is read through iControl REST with a login token; `loginProvider`: tmos (local accounts) or a remote auth provider
    f5: { label: 'F5 BIG-IP', types: ['LoadBalancer'], available: true, defaultPort: 443, auth: 'password', scope: 'partition', loginProvider: true },
};

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const SCOPE_RE = /^[\w.-]{1,64}$/;
const USER_RE = /^[^\x00-\x1f]{1,128}$/;
const TARGET_RE = /^[^\x00-\x1f<>]{1,128}$/;
const PROVIDER_RE = /^[\w.-]{1,64}$/;
const DEFAULT_LOGIN_PROVIDER = 'tmos';

const isHost = (v) => typeof v === 'string' && (net.isIP(v) !== 0 || HOSTNAME_RE.test(v));

function readAll() {
    const doc = readDataSync(KEY, {});
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

function decryptSecrets(stored) {
    const out = {};
    for (const f of SECRET_FIELDS) {
        if (!stored || !stored[f]) continue;
        try { out[f] = decryptText(stored[f]); } catch (e) { out[f] = ''; }
    }
    return out;
}

/** Profile with decrypted secrets, or null. */
function getProfile(id) {
    const p = readAll()[id];
    if (!p) return null;
    return { ...p, secrets: decryptSecrets(p.secrets) };
}

/** What the browser may see: secrets replaced by MASK (or ''), everything else as stored. */
function publicProfile(p) {
    if (!p) return null;
    const masked = {};
    for (const f of SECRET_FIELDS) masked[f] = p.secrets && p.secrets[f] ? MASK : '';
    const { secrets, ...rest } = p;
    return { ...rest, secrets: masked };
}

/** Short status for the device list: vendor, model, version, connection state. */
function listSummaries() {
    const out = {};
    for (const [id, p] of Object.entries(readAll())) {
        out[id] = {
            vendor: p.vendor,
            vendorLabel: (VENDORS[p.vendor] || {}).label || p.vendor,
            enabled: p.enabled !== false,
            model: p.facts && p.facts.model || null,
            version: p.facts && p.facts.version || null,
            lastStatus: p.lastStatus || 'unknown',
            lastError: p.lastError || null,
            lastCheckedAt: p.lastCheckedAt || null,
        };
    }
    return out;
}

/**
 * Validate the page's input against the previous profile and the device type.
 * @returns {object} the profile to store (secrets in plain text; the caller encrypts)
 */
function buildProfile(deviceType, input, previous) {
    const body = input && typeof input === 'object' ? input : {};
    const vendor = body.vendor;
    const meta = VENDORS[vendor];
    if (!meta) throw netError('BAD_REQUEST', `Unknown vendor: ${vendor}`);
    if (!meta.available) throw netError('BAD_REQUEST', `${meta.label} is not supported yet`);
    if (!meta.types.includes(deviceType)) throw netError('BAD_REQUEST', `${meta.label} cannot be used for a ${deviceType}`);

    const mgmtHost = String(body.mgmtHost || '').trim();
    if (!isHost(mgmtHost)) throw netError('BAD_REQUEST', 'Management address must be a host name or an IP address');
    const port = body.port === undefined || body.port === null || body.port === '' ? meta.defaultPort : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw netError('BAD_REQUEST', 'Port must be 1-65535');

    const scope = String(body.scope || '').trim();
    if (scope && (!meta.scope || !SCOPE_RE.test(scope))) throw netError('BAD_REQUEST', 'Invalid scope (VDOM / vsys / domain / partition) name');
    const username = String(body.username || '').trim();
    if (username && !USER_RE.test(username)) throw netError('BAD_REQUEST', 'Invalid user name');
    const target = String(body.target || '').trim();
    if (target && (!meta.target || !TARGET_RE.test(target))) throw netError('BAD_REQUEST', 'Invalid gateway name');
    let transport = 'auto';
    let sshPort = DEFAULT_SSH_PORT;
    if (meta.transports) {
        transport = body.transport === undefined || body.transport === null || body.transport === '' ? 'auto' : String(body.transport);
        if (!TRANSPORTS.includes(transport)) throw netError('BAD_REQUEST', `Connection method must be one of ${TRANSPORTS.join(', ')}`);
        sshPort = body.sshPort === undefined || body.sshPort === null || body.sshPort === '' ? DEFAULT_SSH_PORT : Number(body.sshPort);
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw netError('BAD_REQUEST', 'SSH port must be 1-65535');
    }
    let loginProvider = DEFAULT_LOGIN_PROVIDER;
    if (meta.loginProvider) {
        loginProvider = String(body.loginProvider || '').trim() || DEFAULT_LOGIN_PROVIDER;
        if (!PROVIDER_RE.test(loginProvider)) throw netError('BAD_REQUEST', 'Invalid login provider name');
    }
    const caCert = body.caCert ? String(body.caCert) : '';
    if (caCert && (caCert.length > 65536 || !/-----BEGIN CERTIFICATE-----/.test(caCert))) throw netError('BAD_REQUEST', 'CA certificate must be PEM text (max 64 KB)');

    // Stored secrets survive only when the device address and vendor stay the same
    const sameTarget = previous && previous.vendor === vendor && previous.mgmtHost === mgmtHost && Number(previous.port) === port
        && (!meta.transports || Number(previous.sshPort || DEFAULT_SSH_PORT) === sshPort);
    const prevSecrets = sameTarget && body.clearSecrets !== true ? (previous.secrets || {}) : {};
    const secrets = {};
    for (const f of SECRET_FIELDS) {
        if (f === 'enableSecret' && !meta.enable) continue;
        const v = body[f];
        if (typeof v === 'string' && v && v !== MASK) {
            if (v.length > 4096) throw netError('BAD_REQUEST', `${f} is too long`);
            secrets[f] = v;
        } else if (prevSecrets[f]) {
            secrets[f] = prevSecrets[f];
        }
    }
    if (meta.auth === 'token' && !secrets.token) {
        throw netError('BAD_REQUEST', previous && !sameTarget ? 'Address, port or vendor changed: enter the API token again' : 'API token is required');
    }
    if (meta.auth === 'password' && (!username || !secrets.password)) {
        throw netError('BAD_REQUEST', previous && !sameTarget ? 'Address, port, SSH port or vendor changed: enter the password again' : 'User name and password are required');
    }
    if (meta.auth === 'apiKey' && !secrets.apiKey && !(username && secrets.password)) {
        throw netError('BAD_REQUEST', 'API key, or user name and password, is required');
    }

    return {
        vendor, mgmtHost, port,
        username: username || '',
        scope: meta.scope ? scope : '',
        target: meta.target ? target : '',
        ...(meta.transports ? { transport, sshPort } : {}),
        ...(meta.loginProvider ? { loginProvider } : {}),
        tlsVerify: body.tlsVerify === true,
        caCert: body.tlsVerify === true ? caCert : '',
        enabled: body.enabled !== false,
        secrets,
        // facts and status belong to the old target; keep them only when it did not change
        ...(sameTarget ? { facts: previous.facts, factsAt: previous.factsAt, lastStatus: previous.lastStatus, lastError: previous.lastError, lastCheckedAt: previous.lastCheckedAt } : {}),
    };
}

const encryptSecrets = (secrets) => Object.fromEntries(Object.entries(secrets || {}).filter(([, v]) => v).map(([k, v]) => [k, encryptText(v)]));

/** Validate and store; returns the public profile. */
function saveProfile(id, deviceType, input, actor) {
    const previous = getProfile(id);
    const profile = buildProfile(deviceType, input, previous);
    const stored = { ...profile, secrets: encryptSecrets(profile.secrets), updatedBy: actor || '', updatedAt: new Date().toISOString() };
    mutateDocument(KEY, (doc) => { doc[id] = stored; }, { defaultValue: {}, fnName: 'netDevices.saveProfile', label: 'Device management' });
    return publicProfile({ ...stored, secrets: profile.secrets });
}

function removeProfile(id) {
    let existed = false;
    mutateDocument(KEY, (doc) => { existed = !!doc[id]; delete doc[id]; }, { defaultValue: {}, fnName: 'netDevices.removeProfile', label: 'Device management' });
    return existed;
}

/** Remember the outcome of the last call (and the device facts when a summary was read). */
function recordStatus(id, { ok, error, facts }) {
    mutateDocument(KEY, (doc) => {
        const p = doc[id];
        if (!p) return;
        p.lastStatus = ok ? 'ok' : 'error';
        p.lastError = ok ? null : String(error || '').slice(0, 300);
        p.lastCheckedAt = new Date().toISOString();
        if (facts) { p.facts = facts; p.factsAt = p.lastCheckedAt; }
    }, { defaultValue: {}, fnName: 'netDevices.recordStatus', label: 'Device management' });
}

/** Remember which way ('api' / 'ssh') works for a device on 'auto'; null forgets it so the next call finds out again. */
function recordTransport(id, transport) {
    if (transport !== null && !['api', 'ssh'].includes(transport)) return;
    mutateDocument(KEY, (doc) => {
        const p = doc[id];
        if (!p) return;
        if (transport) p.lastTransport = transport;
        else delete p.lastTransport;
    }, { defaultValue: {}, fnName: 'netDevices.recordTransport', label: 'Device management' });
}

/**
 * Connection target for a test with values from the page: secrets left blank or masked are taken from the stored
 * profile only when vendor, address and port are unchanged.
 */
function testTarget(id, deviceType, input) {
    const previous = getProfile(id);
    return buildProfile(deviceType, input, previous);
}

module.exports = { KEY, MASK, VENDORS, getProfile, publicProfile, listSummaries, saveProfile, removeProfile, recordStatus, recordTransport, testTarget, buildProfile };
