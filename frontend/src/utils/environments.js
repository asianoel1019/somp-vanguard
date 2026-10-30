// Global Environments helpers shared by every screen (mirror of backend/lib/environmentRegistry.js).
// Records store the environment id; the name shown is derived from the global list (GET /api/environments).
export const UNASSIGNED = 'Unassigned';
const LEGACY_PRODUCTION_NAMES = new Set(['prd', 'prod', 'production']);
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Same normalisation as the backend: isProduction boolean (derived from the name when missing), exactly one isDefault
export function normalizeEnvs(list) {
    const envs = (Array.isArray(list) ? list : [])
        .filter(e => e && e.id != null && String(e.id).trim() !== '' && String(e.name || '').trim() !== '')
        .map(e => ({
            ...e,
            id: String(e.id),
            name: String(e.name).trim(),
            isProduction: typeof e.isProduction === 'boolean' ? e.isProduction : LEGACY_PRODUCTION_NAMES.has(norm(e.name)),
            isDefault: e.isDefault === true
        }));
    let def = envs.findIndex(e => e.isDefault);
    if (def === -1) def = envs.findIndex(e => norm(e.name) === 'others');
    if (def === -1 && envs.length > 0) def = 0;
    envs.forEach((e, i) => { e.isDefault = i === def; });
    return envs;
}

// id (exact), then id / name / code case-insensitively; null when unknown or empty
export function resolveEnv(value, envs) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const list = Array.isArray(envs) ? envs : [];
    const n = raw.toLowerCase();
    return list.find(e => String(e.id) === raw)
        || list.find(e => norm(e.id) === n)
        || list.find(e => norm(e.name) === n)
        || list.find(e => e.code && norm(e.code) === n)
        || null;
}

export function defaultEnv(envs) {
    const list = Array.isArray(envs) ? envs : [];
    return list.find(e => e.isDefault) || null;
}

// Display name for a stored reference (envId preferred, legacy name as fallback); unknown -> Unassigned
export function envDisplayName(envId, name, envs) {
    const env = resolveEnv(envId, envs) || resolveEnv(name, envs);
    return env ? env.name : UNASSIGNED;
}

// Production badge: driven by the isProduction flag of the referenced environment (never by hard-coded names)
export function isProductionRef(ref, envs, name) {
    const env = resolveEnv(ref, envs) || resolveEnv(name, envs);
    return !!(env && env.isProduction);
}

// Validates free text (Excel / paste import): { env } | { error } | { empty: true }
export function validateEnvValue(value, envs) {
    if (value === undefined || value === null || String(value).trim() === '') return { empty: true };
    const env = resolveEnv(value, envs);
    if (!env) {
        return { error: `Unknown environment "${String(value).trim()}". Allowed: ${(envs || []).map(e => e.name).join(', ')}` };
    }
    return { env };
}

/**
 * Excel rows (Server List diff import): a known Env value (name, id or code) becomes the canonical name + envId;
 * an unknown value marks the row with envError (never synced: no silent default). Empty = keep current env.
 */
export function applyEnvValidation(rows, envs) {
    if (!Array.isArray(rows)) return [];
    if (!Array.isArray(envs) || envs.length === 0) return rows;
    return rows.map(r => {
        const v = validateEnvValue(r.Env, envs);
        if (v.empty) return r;
        if (v.error) return { ...r, envError: v.error };
        return { ...r, Env: v.env.name, envName: v.env.name, envId: v.env.id };
    });
}

// Label values (zone / env / environment) of a Prometheus target that are not an environment name
export function unknownPromEnvValues(labels, envs) {
    const l = labels || {};
    const out = [];
    for (const k of ['zone', 'env', 'environment']) {
        const v = l[k];
        if (v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '-') continue;
        if (!(envs || []).some(e => norm(e.name) === norm(v))) out.push({ label: k, value: String(v).trim() });
    }
    return out;
}
