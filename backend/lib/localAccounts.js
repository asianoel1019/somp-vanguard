// Local accounts. The break-glass SuperAdmin stays in .env (LOCAL_ADMIN_USER / LOCAL_ADMIN_PWD, both editions, never
// listed). Every other local account lives in system/local_accounts.json (encrypted like rbac.json) with an scrypt
// hash and the edition it was created on: on the free edition only free-created accounts sign in, one per role.
// Spec: docs/superpowers/specs/2026-11-17-local-accounts-design.md
const crypto = require('crypto');
const { promisify } = require('util');
const { encryptText, decryptText } = require('./crypto');
const { readDataSync, deleteDataSync } = require('./db');
const { mutateDocument } = require('./docStore');
const { isPaid } = require('./license');

const KEY = 'system/local_accounts.json';
const ROLES = Object.freeze(['SuperAdmin', 'Operator', 'Viewer']);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const QUOTA_MESSAGE = 'The free edition allows one local account per role.';
const MSG = {
    disabled: 'Account disabled.',
    free: 'This account is inactive on the free edition.',
    gone: 'Your account no longer exists.',
    unavailable: 'Local accounts are unavailable.',
    staleBreakGlass: 'Your session ended: please sign in again.',
};
// When this process started, in seconds like a JWT iat (see sessionCheck: break-glass name collision)
const PROCESS_START_S = Math.floor((Date.now() - process.uptime() * 1000) / 1000);

class LocalAccountError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const env = (k) => String(process.env[k] || '').trim();
const lc = (s) => String(s || '').trim().toLowerCase();
const breakGlass = () => ({ user: env('LOCAL_ADMIN_USER') || 'admin', pass: env('LOCAL_ADMIN_PWD') });
const isBreakGlassName = (name) => lc(name) === lc(breakGlass().user);

function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
    try {
        const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
        if (kind !== 'scrypt' || !salt || !hash) return false;
        const expected = Buffer.from(hash, 'base64');
        const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
        return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    } catch { return false; }
}
const DUMMY_HASH = hashPassword('dummy-password-0'); // equalises timing for unknown names

// Async variants for request paths (crypto.scrypt runs on the libuv pool, not on the event loop)
const scryptAsync = promisify(crypto.scrypt);
async function hashPasswordAsync(pw) {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(String(pw), salt, 64, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPasswordAsync(pw, stored) {
    try {
        const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
        if (kind !== 'scrypt' || !salt || !hash) return false;
        const expected = Buffer.from(hash, 'base64');
        const got = await scryptAsync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
        return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    } catch { return false; }
}

function validateUsername(name) {
    const n = String(name || '').trim();
    if (!NAME_RE.test(n)) return 'User names use letters, digits, ".", "_" or "-" (1-64 characters).';
    if (isBreakGlassName(n)) return 'That name is reserved for the break-glass admin.';
    return '';
}

function validatePassword(pw) {
    const s = String(pw || '');
    if (s.length < 12 || s.length > 256) return 'Passwords need 12 to 256 characters.';
    if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Passwords need at least one letter and one digit.';
    return '';
}

const emptyDoc = () => ({ version: 1, migratedEnv: false, accounts: [] });
function normalize(v) {
    const d = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    if (d.version === undefined) d.version = 1;
    if (typeof d.migratedEnv !== 'boolean') d.migratedEnv = false;
    if (!Array.isArray(d.accounts)) d.accounts = [];
    return d;
}

/** Stored value -> document; throws when the value is present but not an encrypted document (never auto-replaced). */
function decodeStored(stored) {
    if (stored === null || stored === undefined) return null;
    if (typeof stored !== 'string' || !stored.includes(':') || stored.startsWith('{')) throw new Error('local accounts document is not encrypted');
    const plain = decryptText(stored);
    if (plain === stored) throw new Error('local accounts document cannot be decrypted');
    const doc = JSON.parse(plain);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('local accounts document is malformed');
    return doc;
}

const codec = {
    decode: decodeStored,
    encode: (doc) => encryptText(JSON.stringify(doc)),
    normalize,
    defaultValue: {},
};

let cache = { raw: undefined, state: null };
function readState() {
    let raw;
    try { raw = readDataSync(KEY, null); } catch (e) { return { ok: false, error: e.message }; }
    if (cache.state && cache.raw === raw) return cache.state;
    let state;
    try { state = { ok: true, doc: normalize(decodeStored(raw) || emptyDoc()) }; }
    catch (e) { state = { ok: false, error: e.message }; }
    cache = { raw, state };
    return state;
}

/** Atomic read-modify-write; refuses (503) when the stored document cannot be read, so it is never overwritten. */
function mutate(fn, fnName) {
    const st = readState();
    if (!st.ok) throw new LocalAccountError(503, `Local accounts are unavailable: ${st.error}`, 'ACCOUNTS_UNAVAILABLE');
    // Defence in depth: docStore turns an undecodable row into an empty document, so the row it re-reads inside the
    // write lock is checked here as well (the pre-check above reads the RAM copy).
    let decodeError = null;
    const decode = (raw) => {
        try { const d = decodeStored(raw); decodeError = null; return d; } catch (e) { decodeError = e; throw e; }
    };
    return mutateDocument(KEY, (doc) => {
        if (decodeError) throw new LocalAccountError(503, `Local accounts are unavailable: ${decodeError.message}`, 'ACCOUNTS_UNAVAILABLE');
        return fn(normalize(doc));
    }, { ...codec, decode, fnName: `localAccounts.${fnName}`, label: 'Local accounts' });
}

const findIn = (doc, name) => doc.accounts.find(a => lc(a.username) === lc(name)) || null;
function findAccount(name) {
    const st = readState();
    return st.ok ? findIn(st.doc, name) : null;
}

function accountStatus(acc, paid = isPaid()) {
    if (acc.disabled) return { active: false, inactiveReason: 'disabled' };
    if (!paid && acc.createdEdition !== 'free') return { active: false, inactiveReason: 'free edition' };
    return { active: true, inactiveReason: '' };
}

function publicAccount(acc, paid = isPaid()) {
    const { username, role, createdEdition, createdAt, createdBy, disabled, passwordChangedAt } = acc;
    return { username, role, createdEdition, createdAt, createdBy, disabled: !!disabled, passwordChangedAt, ...accountStatus(acc, paid) };
}

/** Free-edition quota use of a role: free-created, not disabled, optionally excluding one account. */
const freeUsed = (doc, role, exceptName) => doc.accounts.filter(a => a.role === role && a.createdEdition === 'free'
    && !a.disabled && lc(a.username) !== lc(exceptName)).length;

function listAccounts() {
    const paid = isPaid();
    const st = readState();
    const doc = st.ok ? st.doc : emptyDoc();
    const quota = {};
    for (const r of ROLES) quota[r] = { used: freeUsed(doc, r, null), limit: paid ? null : 1 };
    return {
        ok: st.ok, error: st.ok ? '' : st.error,
        accounts: doc.accounts.map(a => publicAccount(a, paid)),
        breakGlass: { username: breakGlass().user }, edition: paid ? 'paid' : 'free', quota,
    };
}

const inactiveError = (reason) => (reason === 'disabled'
    ? { code: 'ACCOUNT_INACTIVE', error: MSG.disabled } : { code: 'LICENSE_REQUIRED', error: MSG.free });

function authenticate(username, password) {
    if (!readState().ok) return { ok: false, found: false, unavailable: true };
    const acc = findAccount(username);
    if (!acc) { verifyPassword(password, DUMMY_HASH); return { ok: false, found: false }; }
    if (!verifyPassword(password, acc.passwordHash)) return { ok: false, found: true };
    const s = accountStatus(acc);
    if (!s.active) return { ok: false, found: true, ...inactiveError(s.inactiveReason) };
    return { ok: true, account: acc };
}

function sessionCheck(user) {
    if (!user || user.domain !== 'local') return { ok: true, role: user && user.role };
    if (isBreakGlassName(user.username)) {
        // LOCAL_ADMIN_USER renamed onto a stored page account: that account's tokens from before the restart must not
        // turn into break-glass tokens. Tokens issued since this process started belong to the break-glass admin.
        const st = readState();
        if (st.ok && findIn(st.doc, user.username) && !(Number(user.iat) >= PROCESS_START_S)) {
            return { ok: false, code: 'ACCOUNT_INACTIVE', error: MSG.staleBreakGlass };
        }
        return { ok: true, role: user.role };
    }
    if (!readState().ok) return { ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: MSG.unavailable };
    const acc = findAccount(user.username);
    if (!acc) return { ok: false, code: 'ACCOUNT_INACTIVE', error: MSG.gone };
    const s = accountStatus(acc);
    if (!s.active) return { ok: false, ...inactiveError(s.inactiveReason) };
    return { ok: true, role: acc.role };
}

function localAccountRole(user) {
    if (!user || user.domain !== 'local' || isBreakGlassName(user.username)) return null;
    const acc = findAccount(user.username);
    return acc && accountStatus(acc).active ? acc.role : null;
}

const bad = (msg) => new LocalAccountError(400, msg, 'INVALID');
const SELF_MSG = 'You cannot disable, delete or demote your own account.';
const SELF_PASSWORD_MSG = 'Use Change password to change your own password.';

/** actor: a local user name (string) or { username, domain }; only a local actor can be "self" of a local account. */
function isSelf(username, actor) {
    const a = actor && typeof actor === 'object' ? actor : { username: actor, domain: 'local' };
    return a.domain === 'local' && lc(username) === lc(a.username);
}

/** opts.passwordHash: a hash of this password the caller already computed (hashPasswordAsync). */
function createAccount({ username, role, password } = {}, by, opts = {}) {
    const name = String(username || '').trim();
    const nameErr = validateUsername(name); if (nameErr) throw bad(nameErr);
    if (!ROLES.includes(role)) throw bad('Role must be SuperAdmin, Operator or Viewer.');
    const pwErr = validatePassword(password); if (pwErr) throw bad(pwErr);
    const passwordHash = opts.passwordHash || hashPassword(password);
    return mutate((doc) => {
        if (findIn(doc, name)) throw new LocalAccountError(409, 'An account with that name already exists.', 'EXISTS');
        const paid = isPaid();
        if (!paid && freeUsed(doc, role, null) >= 1) throw new LocalAccountError(403, QUOTA_MESSAGE, 'LICENSE_REQUIRED');
        const now = new Date().toISOString();
        const acc = { username: name, role, passwordHash, createdEdition: paid ? 'paid' : 'free', createdAt: now,
            createdBy: String(by || ''), disabled: false, passwordChangedAt: now };
        doc.accounts.push(acc);
        return publicAccount(acc, paid);
    }, 'createAccount');
}

function updateAccount(username, changes = {}, actor, opts = {}) {
    return updateAccountDetailed(username, changes, actor, opts).account;
}

/** updateAccount that also says what actually changed: { account, changed: { role, disabled, password } }. */
function updateAccountDetailed(username, changes = {}, actor, opts = {}) {
    const { role, disabled, password } = changes;
    const self = isSelf(username, actor);
    if (role !== undefined && !ROLES.includes(role)) throw bad('Role must be SuperAdmin, Operator or Viewer.');
    if (disabled !== undefined && typeof disabled !== 'boolean') throw bad('disabled must be true or false.');
    if (self && (disabled === true || (role !== undefined && role !== 'SuperAdmin'))) throw bad(SELF_MSG);
    if (self && password !== undefined) throw bad(SELF_PASSWORD_MSG);
    let passwordHash;
    if (password !== undefined) {
        const e = validatePassword(password); if (e) throw bad(e);
        passwordHash = opts.passwordHash || hashPassword(password);
    }
    return mutate((doc) => {
        const acc = findIn(doc, username);
        if (!acc) throw new LocalAccountError(404, 'Account not found.', 'NOT_FOUND');
        const paid = isPaid();
        const roleChange = role !== undefined && role !== acc.role;
        const enabling = disabled === false && acc.disabled;
        if (!paid && (roleChange || enabling)) {
            if (acc.createdEdition !== 'free') {
                throw new LocalAccountError(403, 'Accounts created on the paid edition cannot be changed on the free edition; you can reset their password or delete them.', 'LICENSE_REQUIRED');
            }
            const willBeActive = disabled === false || (disabled === undefined && !acc.disabled);
            if (willBeActive && freeUsed(doc, roleChange ? role : acc.role, acc.username) >= 1) {
                throw new LocalAccountError(403, QUOTA_MESSAGE, 'LICENSE_REQUIRED');
            }
        }
        const changed = { role: roleChange, disabled: disabled !== undefined && disabled !== !!acc.disabled, password: !!passwordHash };
        if (roleChange) acc.role = role;
        if (changed.disabled) acc.disabled = disabled;
        if (passwordHash) { acc.passwordHash = passwordHash; acc.passwordChangedAt = new Date().toISOString(); }
        return { account: publicAccount(acc, paid), changed };
    }, 'updateAccount');
}

function deleteAccount(username, actor) {
    if (isSelf(username, actor)) throw bad(SELF_MSG);
    mutate((doc) => {
        const i = doc.accounts.findIndex(a => lc(a.username) === lc(username));
        if (i < 0) throw new LocalAccountError(404, 'Account not found.', 'NOT_FOUND');
        doc.accounts.splice(i, 1);
    }, 'deleteAccount');
}

function changeOwnPassword(username, currentPassword, newPassword) {
    const acc = findAccount(username);
    if (!acc || !verifyPassword(currentPassword, acc.passwordHash)) throw bad('Current password is incorrect.');
    const e = validatePassword(newPassword); if (e) throw bad(e);
    const passwordHash = hashPassword(newPassword);
    mutate((doc) => {
        const a = findIn(doc, username);
        if (!a) throw new LocalAccountError(404, 'Account not found.', 'NOT_FOUND');
        a.passwordHash = passwordHash; a.passwordChangedAt = new Date().toISOString();
    }, 'changeOwnPassword');
}

/** Request path (async scrypt). A wrong current password throws with .wrongPassword = true; the route counts those. */
async function changeOwnPasswordAsync(username, currentPassword, newPassword) {
    const acc = findAccount(username);
    const ok = await verifyPasswordAsync(currentPassword, acc ? acc.passwordHash : DUMMY_HASH);
    if (!acc || !ok) throw Object.assign(bad('Current password is incorrect.'), { wrongPassword: true });
    const e = validatePassword(newPassword); if (e) throw bad(e);
    const passwordHash = await hashPasswordAsync(newPassword);
    mutate((doc) => {
        const a = findIn(doc, username);
        if (!a) throw new LocalAccountError(404, 'Account not found.', 'NOT_FOUND');
        a.passwordHash = passwordHash; a.passwordChangedAt = new Date().toISOString();
    }, 'changeOwnPassword');
}

/** Startup check: the break-glass name when a stored page account carries it (LOCAL_ADMIN_USER renamed onto it), else ''. */
function breakGlassCollision() {
    const st = readState();
    return st.ok && findIn(st.doc, breakGlass().user) ? breakGlass().user : '';
}

/** Startup: LOCAL_OPERATOR_* / LOCAL_VIEWER_* from .env become free-edition accounts, once. */
function migrateEnvAccounts() {
    const st = readState();
    if (!st.ok) return { migrated: [], error: st.error };
    if (st.doc.migratedEnv) return { migrated: [] };
    const pending = [['LOCAL_OPERATOR', 'Operator'], ['LOCAL_VIEWER', 'Viewer']]
        .map(([p, role]) => ({ user: env(`${p}_USER`), pass: env(`${p}_PWD`), role }))
        .filter(c => c.user && c.pass && NAME_RE.test(c.user) && !isBreakGlassName(c.user))
        .map(c => ({ ...c, hash: hashPassword(c.pass) }));
    const migrated = mutate((doc) => {
        if (doc.migratedEnv) return [];
        const out = [];
        const now = new Date().toISOString();
        for (const c of pending) {
            if (findIn(doc, c.user)) continue;
            doc.accounts.push({ username: c.user, role: c.role, passwordHash: c.hash, createdEdition: 'free', createdAt: now,
                createdBy: '.env', disabled: false, passwordChangedAt: now });
            out.push(c.user);
        }
        doc.migratedEnv = true;
        return out;
    }, 'migrateEnvAccounts');
    return { migrated };
}

function _resetCacheForTest() { cache = { raw: undefined, state: null }; }
function _resetForTest() { try { deleteDataSync(KEY); } catch { /* absent */ } _resetCacheForTest(); }

module.exports = {
    KEY, ROLES, QUOTA_MESSAGE, MSG, PROCESS_START_S, LocalAccountError, breakGlass, isBreakGlassName, hashPassword,
    verifyPassword, hashPasswordAsync, verifyPasswordAsync, validateUsername, validatePassword, readState, findAccount,
    accountStatus, publicAccount, listAccounts, authenticate, sessionCheck, localAccountRole, createAccount,
    updateAccount, updateAccountDetailed, deleteAccount, changeOwnPassword, changeOwnPasswordAsync, breakGlassCollision,
    migrateEnvAccounts, _resetForTest, _resetCacheForTest,
};
