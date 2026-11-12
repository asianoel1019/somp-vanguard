// Duplicate indexes of a SQLite database: indexes on the same table with the same key, so every write maintains the
// same data twice. Pure functions; scoutDbOptimize.js reads the schema and applies the result.
//
// Two indexes are duplicates when, after dropping a trailing rowid column (every index already ends with the rowid,
// and an INTEGER PRIMARY KEY column is the rowid), their columns are the same in the same order and either all
// directions match or all are reversed (SQLite walks an index both ways). Indexes on expressions are left alone.

// Index names the service creates itself at every start (services/db): those are the ones kept.
const SERVICE_INDEXES = new Set(['idx_metrics_monId', 'idx_metrics_ts', 'idx_win_events_ts', 'idx_lin_logs_ts', 'idx_alerts_active', 'idx_monitors_envid',
    'idx_rule_bindings_scope', 'idx_rule_exclusions_rule', 'idx_rule_exclusions_scope', 'idx_rule_exclusions_unique']);

/**
 * index: { name, table, unique: bool, origin: 'c' | 'u' | 'pk', columns: [{ name, desc }] } (name null = expression)
 * rowidAlias: { [table]: column name of its INTEGER PRIMARY KEY, if any }
 */
function keyOf(index, rowidAlias = {}) {
    if (index.columns.some(c => c.name === null || c.name === undefined)) return null;
    const alias = rowidAlias[index.table];
    let cols = index.columns.map(c => ({ name: String(c.name).toLowerCase(), desc: !!c.desc }));
    while (cols.length > 1 && (cols[cols.length - 1].name === 'rowid' || (alias && cols[cols.length - 1].name === alias.toLowerCase()))) cols = cols.slice(0, -1);
    if (cols.length && cols[0].desc) cols = cols.map(c => ({ ...c, desc: !c.desc })); // a fully reversed index is the same index
    return `${index.table.toLowerCase()}|${cols.map(c => `${c.name}${c.desc ? ' desc' : ''}`).join(',')}`;
}

const rank = (ix) => (ix.unique || ix.origin !== 'c' ? 0 : SERVICE_INDEXES.has(ix.name) ? 1 : 2);

/**
 * -> [{ table, columns, keep, drop: [names] }] for every group of duplicates. Unique / primary-key indexes are never
 * dropped; among the others the service's own index is kept, else the first by name.
 */
function findDuplicateIndexes(indexes, rowidAlias = {}) {
    const groups = new Map();
    for (const ix of indexes) {
        const key = keyOf(ix, rowidAlias);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ix);
    }
    const out = [];
    for (const [key, list] of groups) {
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
        const drop = sorted.slice(1).filter(ix => !ix.unique && ix.origin === 'c').map(ix => ix.name);
        if (drop.length) out.push({ table: list[0].table, columns: key.split('|')[1], keep: sorted[0].name, drop });
    }
    return out.sort((a, b) => a.table.localeCompare(b.table) || a.keep.localeCompare(b.keep));
}

/** Bytes VACUUM needs free: a full copy of the used pages, plus 10 %. */
function vacuumSpaceNeeded({ pageSize, pageCount, freePages }) {
    return Math.ceil((pageCount - freePages) * pageSize * 1.1);
}

module.exports = { keyOf, findDuplicateIndexes, vacuumSpaceNeeded, SERVICE_INDEXES };
