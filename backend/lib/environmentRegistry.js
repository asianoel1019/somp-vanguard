/**
 * Global Environments registry (system/environments.json): the single place that resolves an
 * environment reference (id, name or code, case-insensitive) to the canonical entry.
 *
 * Consumers store the environment ID (authoritative) and keep the name only as a display / rollback copy.
 * Flags: isProduction (boolean), isDefault (exactly one; 'Others' unless another entry is chosen).
 * Missing flags are derived at read time (never written here: only routes/environments.js writes the list).
 */
const { readDataSync } = require('./db');

const ENV_KEY = 'system/environments.json';
const UNASSIGNED = 'Unassigned';
// Names that were treated as "production" by the hard-coded badges before the isProduction flag existed
const LEGACY_PRODUCTION_NAMES = new Set(['prd', 'prod', 'production']);

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

function normalizeEnvList(list) {
    const envs = (Array.isArray(list) ? list : [])
        .filter(e => e && e.id !== undefined && e.id !== null && String(e.id).trim() !== '' && String(e.name || '').trim() !== '')
        .map(e => ({
            ...e,
            id: String(e.id),
            name: String(e.name).trim(),
            isProduction: typeof e.isProduction === 'boolean'
                ? e.isProduction
                : (LEGACY_PRODUCTION_NAMES.has(norm(e.name)) || (e.code ? LEGACY_PRODUCTION_NAMES.has(norm(e.code)) : false)),
            isDefault: e.isDefault === true
        }));
    let def = envs.findIndex(e => e.isDefault);
    if (def === -1) def = envs.findIndex(e => norm(e.name) === 'others');
    if (def === -1 && envs.length > 0) def = 0;
    envs.forEach((e, i) => { e.isDefault = i === def; });
    return envs;
}

function getEnvironments() {
    try {
        return normalizeEnvList(readDataSync(ENV_KEY, []));
    } catch (e) {
        return [];
    }
}

const listOf = (envs) => (Array.isArray(envs) ? envs : getEnvironments());

/** Exact id lookup (ids are authoritative). */
function findById(id, envs) {
    if (id === undefined || id === null || id === '') return null;
    const s = String(id).trim();
    return listOf(envs).find(e => e.id === s) || null;
}

/** Resolve a free-text reference: exact id, then id / name / code case-insensitively. null when unknown or empty. */
function resolveEnv(value, envs) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const list = listOf(envs);
    const n = raw.toLowerCase();
    return list.find(e => e.id === raw)
        || list.find(e => norm(e.id) === n)
        || list.find(e => norm(e.name) === n)
        || list.find(e => e.code && norm(e.code) === n)
        || null;
}

/**
 * Resolve a stored record reference { envId, name }: a valid envId wins; otherwise the envId value
 * (legacy rows stored names in envId) and then the name are resolved as free text.
 */
function resolveRecordEnv(envId, name, envs) {
    const list = listOf(envs);
    return findById(envId, list) || resolveEnv(envId, list) || resolveEnv(name, list);
}

function getDefaultEnv(envs) {
    const list = listOf(envs);
    return list.find(e => e.isDefault) || null;
}

/** Display fields for a stored id: { envId, envName, isProduction }; unknown -> Unassigned (never a silent default). */
function displayFor(envId, envs) {
    const env = findById(envId, envs);
    if (!env) return { envId: null, envName: UNASSIGNED, isProduction: false, assigned: false };
    return { envId: env.id, envName: env.name, isProduction: !!env.isProduction, assigned: true };
}

const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const rawRef = (envId, name) => (given(name) ? String(name).trim() : (given(envId) ? String(envId).trim() : ''));

/**
 * Display for a stored record: the envId decides; a record not migrated yet (name only) still resolves by
 * name so nothing regresses; anything else is Unassigned and carries its raw text as envUnmapped.
 */
function displayForRecord(envId, name, envs) {
    const env = resolveRecordEnv(envId, name, envs);
    if (env) return { envId: env.id, envName: env.name, isProduction: !!env.isProduction, assigned: true };
    return { envId: null, envName: UNASSIGNED, isProduction: false, assigned: false, unmapped: rawRef(envId, name) || null };
}

/** Read-side copy of a document record: derived name in nameField, envId, envIsProduction (+ envUnmapped). */
function decorateRecord(rec, envs, nameField = 'environment') {
    if (!rec || typeof rec !== 'object') return rec;
    const d = displayForRecord(rec.envId, rec[nameField], envs);
    const out = { ...rec, envId: d.envId, [nameField]: d.envName, envIsProduction: d.isProduction };
    if (d.assigned) delete out.envUnmapped;
    else out.envUnmapped = d.unmapped;
    return out;
}

/**
 * Normalises a record sent back by a client (pass-through arrays such as IPAM ips): display-only fields are
 * stripped, a valid envId / resolvable name is stored as id + canonical name, and a record the client
 * received as Unassigned keeps its original raw value (never overwritten with "Unassigned").
 */
function normalizeIncomingRecord(rec, envs, nameField = 'environment') {
    if (!rec || typeof rec !== 'object') return rec;
    const r = { ...rec };
    const unmapped = r.envUnmapped;
    delete r.envUnmapped;
    delete r.envIsProduction;
    const byId = findById(r.envId, envs);
    if (byId) { r.envId = byId.id; r[nameField] = byId.name; return r; }
    if (r[nameField] === UNASSIGNED || !given(r[nameField])) {
        if (given(unmapped)) { r[nameField] = unmapped; delete r.envId; return r; }
    }
    const env = resolveEnv(r[nameField], envs) || resolveEnv(r.envId, envs);
    if (env) { r.envId = env.id; r[nameField] = env.name; }
    else if (!given(r.envId)) delete r.envId;
    return r;
}

/**
 * Fields to store for an explicit user / API value (id, name or code). Empty -> the isDefault environment
 * when useDefault, else { error }. Unknown -> { error } listing the allowed names.
 */
function envWriteFields(value, envs, { useDefault = false, nameField = 'environment', label = 'Environment' } = {}) {
    const list = listOf(envs);
    const v = validateEnvInput(value, list);
    if (v.error) return { error: v.error };
    let env = v.env;
    if (v.empty) {
        env = useDefault ? getDefaultEnv(list) : null;
        if (!env) return { error: `${label} is required` };
    }
    return { env, fields: { envId: env.id, [nameField]: env.name } };
}

/**
 * True when an edit form sent back "no change" for the environment: nothing, or the Unassigned display value
 * (a record whose stored environment is unknown keeps it until the user picks a real one).
 */
function isUnchangedEnvInput(envId, name) {
    if (given(envId)) return false;
    return !given(name) || String(name).trim().toLowerCase() === UNASSIGNED.toLowerCase();
}

/** { envId, environment } of the isDefault environment (for records created without an explicit value). */
function defaultEnvFields(envs, nameField = 'environment') {
    const env = getDefaultEnv(envs);
    return env ? { envId: env.id, [nameField]: env.name } : { [nameField]: 'Others' };
}

/** Canonical name for free text, or null. */
function canonicalName(value, envs) {
    const env = resolveEnv(value, envs);
    return env ? env.name : null;
}

const allowedNames = (envs) => listOf(envs).map(e => e.name);

/**
 * Validates an explicit user / API value. Returns { env } or { error } (unknown) or { empty: true }.
 */
function validateEnvInput(value, envs) {
    const list = listOf(envs);
    if (value === undefined || value === null || String(value).trim() === '') return { empty: true };
    const env = resolveEnv(value, list);
    if (!env) {
        return { error: `Unknown environment "${String(value).trim()}". Allowed: ${allowedNames(list).join(', ')}` };
    }
    return { env };
}

module.exports = {
    ENV_KEY,
    UNASSIGNED,
    norm,
    normalizeEnvList,
    getEnvironments,
    findById,
    resolveEnv,
    resolveRecordEnv,
    getDefaultEnv,
    displayFor,
    displayForRecord,
    decorateRecord,
    normalizeIncomingRecord,
    envWriteFields,
    isUnchangedEnvInput,
    defaultEnvFields,
    canonicalName,
    allowedNames,
    validateEnvInput
};
