/**
 * Server Inventory credentials.
 *  - Named credential profiles (document_store `server_operation/inventory_credential_profiles.json`), passwords
 *    encrypted with lib/crypto (`enc:` prefix), referenced by subnets (config.subnetSettings[x].credentialProfile).
 *  - The DEFAULT credentials are the AD_ADMIN_* / LINUX_ADMIN_* settings. They are read through readDefaultCredentials(),
 *    the ONE helper used by the scanner and by deploy-agent: the .env file (readEnv, transparently decrypted) first,
 *    then process.env (an `enc:` value there is decrypted as well, never used as a literal password).
 *  - resolveCredentials(config, subnetOrIp) = profile of the subnet when it has complete credentials for an OS, else the default.
 */
const { readDataSync, writeDataSync } = require('./db');
const { PROFILE_NAME_RE, findSubnetSettings } = require('./inventoryValidation');

const PROFILES_KEY = 'server_operation/inventory_credential_profiles.json';
const ENC_PREFIX = 'enc:';
const MAX_PROFILES = 100;
const MAX_FIELD = 256;

function isValidProfileName(name) {
    return typeof name === 'string' && PROFILE_NAME_RE.test(name);
}

function encryptSecret(plain) {
    if (!plain) return '';
    return ENC_PREFIX + require('./crypto').encryptText(String(plain));
}

function decryptSecret(stored) {
    if (!stored) return '';
    const s = String(stored);
    if (!s.startsWith(ENC_PREFIX)) return s;
    try { return require('./crypto').decryptText(s.slice(ENC_PREFIX.length)); } catch (e) { return ''; }
}

/** Decrypts a stored secret: { value, failed } (failed = something was stored but could not be decrypted). */
function tryDecrypt(stored) {
    if (!stored) return { value: '', failed: false };
    const s = String(stored);
    if (!s.startsWith(ENC_PREFIX)) return { value: s, failed: false };
    try { return { value: require('./crypto').decryptText(s.slice(ENC_PREFIX.length)), failed: false }; } catch (e) { return { value: '', failed: true }; }
}

// Profile writes happen only in the web process (routes/inventory.js); this chain serialises them with the checks
// that must not interleave (profile delete vs. a config save referencing it).
let writeChain = Promise.resolve();
function runExclusive(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
}

function readStore() {
    const doc = readDataSync(PROFILES_KEY, {});
    let data = doc;
    if (typeof doc === 'string') { try { data = JSON.parse(doc); } catch (e) { data = {}; } }
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeStore(data) {
    writeDataSync(PROFILES_KEY, data);
}

/** Profile as the API shows it: never a password, only whether one is stored. */
function publicProfile(name, p) {
    return {
        name,
        winUser: p.winUser || '',
        hasWinPassword: !!p.winPassword_enc,
        linuxUser: p.linuxUser || '',
        hasLinuxPassword: !!p.linuxPassword_enc,
        updatedAt: p.updatedAt || null,
        updatedBy: p.updatedBy || null
    };
}

function listProfiles() {
    const store = readStore();
    return Object.keys(store).sort((a, b) => a.localeCompare(b)).map(n => publicProfile(n, store[n] || {}));
}

function hasProfile(name) {
    return Object.prototype.hasOwnProperty.call(readStore(), name);
}

/** Decrypted profile { winUser, winPassword, linuxUser, linuxPassword } or null. */
function getProfile(name) {
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store, name)) return null;
    const p = store[name] || {};
    const win = tryDecrypt(p.winPassword_enc);
    const lx = tryDecrypt(p.linuxPassword_enc);
    return {
        winUser: p.winUser || '',
        winPassword: win.value,
        linuxUser: p.linuxUser || '',
        linuxPassword: lx.value,
        winDecryptFailed: win.failed,
        linuxDecryptFailed: lx.failed
    };
}

function cleanText(v, label, errors) {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') { errors.push(`${label} must be a string`); return undefined; }
    if (v.length > MAX_FIELD) { errors.push(`${label} is too long`); return undefined; }
    if (/[\r\n\0]/.test(v)) { errors.push(`${label} must not contain line breaks`); return undefined; }
    return v;
}

/**
 * Creates / updates a profile. For each password: undefined = keep the stored one, '' = clear it, text = replace.
 * Returns { profile (public view), created, changed: string[] (field names only) } or { errors }.
 */
function putProfile(name, input, username = 'system') {
    if (!isValidProfileName(name)) return { errors: [`Profile name must match ${PROFILE_NAME_RE}`] };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['Body must be an object'] };
    const errors = [];
    const winUser = cleanText(input.winUser, 'winUser', errors);
    const linuxUser = cleanText(input.linuxUser, 'linuxUser', errors);
    const winPassword = cleanText(input.winPassword, 'winPassword', errors);
    const linuxPassword = cleanText(input.linuxPassword, 'linuxPassword', errors);
    if (errors.length) return { errors };
    const store = readStore();
    const exists = Object.prototype.hasOwnProperty.call(store, name);
    if (!exists && Object.keys(store).length >= MAX_PROFILES) return { errors: [`At most ${MAX_PROFILES} profiles are supported`] };
    const prev = exists ? (store[name] || {}) : {};
    const next = { ...prev };
    const changed = [];
    if (winUser !== undefined && winUser !== (prev.winUser || '')) { next.winUser = winUser; changed.push('winUser'); }
    if (linuxUser !== undefined && linuxUser !== (prev.linuxUser || '')) { next.linuxUser = linuxUser; changed.push('linuxUser'); }
    if (winPassword !== undefined) { next.winPassword_enc = encryptSecret(winPassword); changed.push('winPassword'); }
    if (linuxPassword !== undefined) { next.linuxPassword_enc = encryptSecret(linuxPassword); changed.push('linuxPassword'); }
    next.winUser = next.winUser || '';
    next.linuxUser = next.linuxUser || '';
    next.winPassword_enc = next.winPassword_enc || '';
    next.linuxPassword_enc = next.linuxPassword_enc || '';
    next.updatedAt = new Date().toISOString();
    next.updatedBy = username;
    store[name] = next;
    writeStore(store);
    return { profile: publicProfile(name, next), created: !exists, changed };
}

/** Names of the subnet entries whose settings reference the profile. */
function subnetsUsingProfile(config, name) {
    const settings = config && config.subnetSettings && typeof config.subnetSettings === 'object' ? config.subnetSettings : {};
    return Object.keys(settings).filter(k => settings[k] && settings[k].credentialProfile === name);
}

function deleteProfile(name) {
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store, name)) return false;
    delete store[name];
    writeStore(store);
    return true;
}

function decryptIfEncrypted(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return s.startsWith(ENC_PREFIX) ? decryptSecret(s) : s;
}

/**
 * The default credentials (AD_ADMIN_* / LINUX_ADMIN_*): .env via readEnv first, then process.env. ONE source for the
 * scanner and for deploy-agent. adDomain / allowedAdDomain qualify a bare Windows user name (deploy / scanner).
 */
function readDefaultCredentials(deps = {}) {
    let envFile = {};
    try { envFile = (deps.readEnv || require('./envEditor').readEnv)() || {}; } catch (e) { envFile = {}; }
    const pick = (key) => decryptIfEncrypted(envFile[key] || process.env[key] || '');
    return {
        winUser: pick('AD_ADMIN_USER'),
        winPassword: pick('AD_ADMIN_PWD'),
        linuxUser: pick('LINUX_ADMIN_USER'),
        linuxPassword: pick('LINUX_ADMIN_PWD'),
        adDomain: pick('AD_DOMAIN'),
        allowedAdDomain: pick('ALLOWED_AD_DOMAIN')
    };
}

/**
 * Credentials for a subnet entry or IP: { winUser, winPassword, linuxUser, linuxPassword, adDomain, allowedAdDomain, source }.
 * source is 'default' or 'profile:<name>' (per OS the default fills in when the profile has no complete pair).
 */
function resolveCredentials(config, target, deps = {}) {
    const def = readDefaultCredentials(deps);
    const out = { ...def, source: 'default' };
    const settings = target ? findSubnetSettings(config || {}, String(target)) : null;
    const name = settings && settings.credentialProfile;
    if (!name || !isValidProfileName(name)) return out;
    let prof = null;
    try { prof = getProfile(name); } catch (e) { prof = null; }
    if (!prof) {
        console.error(`[Inventory] credential profile '${name}' is referenced by a subnet but does not exist; the default credentials are used`);
        return out;
    }
    let used = false;
    // A stored password that cannot be decrypted (changed / restored system key) must NEVER fall back to the default
    // (privileged) credentials: the OS gets no credentials and an error text that the probe reports as specsError.
    const failMsg = `credential profile '${name}' cannot be decrypted`;
    if (prof.winDecryptFailed) {
        console.error(`[Inventory] ${failMsg} (Windows password)`);
        out.winUser = ''; out.winPassword = ''; out.winError = failMsg; used = true;
    } else if (prof.winUser && prof.winPassword) { out.winUser = prof.winUser; out.winPassword = prof.winPassword; used = true; }
    if (prof.linuxDecryptFailed) {
        console.error(`[Inventory] ${failMsg} (Linux password)`);
        out.linuxUser = ''; out.linuxPassword = ''; out.linuxError = failMsg; used = true;
    } else if (prof.linuxUser && prof.linuxPassword) { out.linuxUser = prof.linuxUser; out.linuxPassword = prof.linuxPassword; used = true; }
    if (used) out.source = `profile:${name}`;
    return out;
}

module.exports = {
    PROFILES_KEY, runExclusive, isValidProfileName, listProfiles, hasProfile, getProfile, putProfile, deleteProfile, subnetsUsingProfile,
    readDefaultCredentials, resolveCredentials, encryptSecret, decryptSecret
};
