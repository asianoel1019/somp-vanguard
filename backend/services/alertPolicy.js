/**
 * Notification policy for Scout alerts (spec §2.3 / §4): maintenance → flapping → cooldown → rate limit.
 * The alert row is always written by the caller first; this only decides whether to notify.
 */
const { getConfig } = require('./alertQualityConfig');
const { findActiveWindow } = require('./maintenanceWindows');
const store = require('./alertPolicyStore');

const MIN = 60000;

// NOTE: the notify_state read-modify-write is not transactional across processes. This is safe because the
// web process only evaluates metric/log rule ids and the worker only offline rule ids, so their stateKeys never collide.
function decide({ monitor, rule, kind, now = new Date(), isTransition = false, wantsNotify = true, digestLine = '' }) {
    const cfg = getConfig(now.getTime());
    const key = store.stateKey(monitor.id, rule.id);
    const state = store.getState(key);
    const t = now.getTime();
    let dirty = false;

    // Release a flap that has been stable long enough — judged on the PREVIOUS transitions, before
    // recording the current one (silent here; the worker sends the status notice)
    if (state.flappingSince) {
        const last = state.transitions.length ? Date.parse(state.transitions[state.transitions.length - 1]) : 0;
        if (t - last >= cfg.flapping.stableMin * MIN) { state.flappingSince = null; state.transitions = []; dirty = true; }
    }

    // Prune stale transitions on every call so a released flap cannot re-arm from old entries
    const pruned = state.transitions.filter(ts => t - Date.parse(ts) < cfg.flapping.windowMin * MIN);
    if (pruned.length !== state.transitions.length) { state.transitions = pruned; dirty = true; }

    if (isTransition && kind !== 'log') {
        state.transitions.push(now.toISOString());
        dirty = true;
    }

    const done = (result) => {
        if (dirty) {
            try { store.saveState(state); } catch (e) { console.error('[AlertPolicy] saveState failed:', e.message); }
        }
        return result;
    };
    const suppressed = (reason, extra = {}) => done({ notify: false, suppressedReason: reason, flapStarted: false, window: null, ...extra });

    const window = findActiveWindow(store.listWindows(t), monitor, rule.id, now);

    let flapStarted = false;
    if (kind !== 'log' && !state.flappingSince && state.transitions.length >= cfg.flapping.transitions) {
        state.flappingSince = now.toISOString();
        dirty = true;
        flapStarted = !window;
    }

    if (!wantsNotify) return done({ notify: false, suppressedReason: null, flapStarted, window: null });
    if (window) return suppressed('maintenance', { window });
    if (state.flappingSince) return suppressed('flapping', { flapStarted });

    const lastField = kind === 'recovery' ? 'lastRecoveryNotifiedAt' : 'lastTriggerNotifiedAt';
    const last = state[lastField] ? Date.parse(state[lastField]) : 0;
    if (t - last < cfg.cooldownMin * MIN) return suppressed('cooldown');

    if (store.bumpRate(store.minuteBucket(now)) > cfg.rateLimitPerMinute) {
        store.addDigest(digestLine || `${monitor.name || monitor.id} ${rule.name || rule.id}`, now.toISOString());
        state[lastField] = now.toISOString(); // stamp cooldown so the same monitor+rule is not re-digested every evaluation
        dirty = true;
        return suppressed('digest');
    }

    state[lastField] = now.toISOString();
    dirty = true;
    return done({ notify: true, suppressedReason: null, flapStarted: false, window: null });
}

module.exports = { decide };
