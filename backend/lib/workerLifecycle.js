/**
 * Background Worker lifecycle helpers (kept out of worker.js so they can be unit-tested without starting the worker).
 */

/**
 * A forked worker shuts down gracefully when the IPC channel to the web closes (the web died). On Windows the job
 * object already kills the child with its parent; elsewhere (dev / POSIX, or a detached start) this prevents a second
 * worker from running next to the one the new web forks. A standalone worker (no IPC channel) is left alone.
 * Returns true when the handler was attached.
 */
function attachParentDisconnect(proc, shutdown) {
    if (!proc || typeof proc.send !== 'function' || typeof proc.on !== 'function') return false;
    proc.on('disconnect', () => {
        try { console.warn('[Worker] IPC channel to the web process closed; shutting down.'); } catch (e) { /* logging only */ }
        shutdown('PARENT_DISCONNECTED');
    });
    return true;
}

module.exports = { attachParentDisconnect };
