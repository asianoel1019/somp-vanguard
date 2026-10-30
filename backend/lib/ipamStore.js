/**
 * IPAM document store: the ONLY way to write network_service/ipam/subnets.json.
 *
 * The web process and the forked worker both write the document. A plain readDataSync -> modify -> writeDataSync
 * works on the RAM-cached copy of one process and silently overwrites a change the other process made in between.
 * mutateSubnets(fn) delegates to lib/docStore.js mutateDocument (see there for the details):
 *   - local SQLite present (normal case): BEGIN IMMEDIATE on the shared database.sqlite, CURRENT row read,
 *     fn(subnets) run synchronously, written through writeDataSync, COMMIT.
 *   - no local SQLite (VFS JSON mode): optimistic revision check on network_service/ipam/revision.json.
 *
 * fn(subnets) mutates the array IN PLACE (use splice to remove) and must be synchronous; its return value is
 * returned by mutateSubnets. Keep fn's outputs in that return value (do not accumulate into outer variables):
 * in fallback mode fn can run more than once. Nothing is written when the document is unchanged.
 */
const dbMod = require('./db');
const { mutateDocument } = require('./docStore');

const IPAM_KEY = 'network_service/ipam/subnets.json';
const REVISION_KEY = 'network_service/ipam/revision.json';

const arr = (v) => (Array.isArray(v) ? v : []);

/** Current subnets for READ-ONLY use (RAM cache allowed). Never mutate and write this copy back. */
function readSubnets() {
    return arr(dbMod.readDataSync(IPAM_KEY, []));
}

/**
 * Atomic read-modify-write of the IPAM document. opts: { username, reason } (diagnostics only).
 * Returns fn's return value.
 */
function mutateSubnets(fn, opts = {}) {
    if (typeof fn !== 'function') throw new TypeError('ipamStore.mutateSubnets: fn must be a function');
    return mutateDocument(IPAM_KEY, fn, {
        fallbackRevisionKey: REVISION_KEY,
        defaultValue: [],
        normalize: arr,
        fnName: 'ipamStore.mutateSubnets',
        label: 'IPAM',
        reason: opts && opts.reason,
    });
}

module.exports = { IPAM_KEY, REVISION_KEY, readSubnets, mutateSubnets };
