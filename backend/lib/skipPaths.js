/**
 * Wrap a middleware so it is skipped for exact request paths (used so a route with its own, larger body parser
 * is not consumed by the global one). Case / trailing-slash variants intentionally do NOT match: they fall back to
 * the global (smaller) limit, which is the safe direction.
 */
function skipPaths(middleware, paths) {
    const set = new Set(paths);
    return (req, res, next) => (set.has(req.path) ? next() : middleware(req, res, next));
}

module.exports = { skipPaths };
