import { nextPollState } from './provisionUtils.js';

/**
 * Single-chain job poller (no React). Guarantees: at most one request in flight, one timer, nothing after
 * the chain ended (finished / lost / not found) or was stopped. All side effects are injected, so it is testable.
 *
 * deps: fetchLight() -> Promise<data>, fetchFull() -> Promise<data>, isHidden(), setTimer, clearTimer,
 *       onData(data), onFull(data), onFullError(err), onLost(), onNotFound(), onActive(bool), intervalMs, maxErrors
 */
export function createPoller(deps) {
    const {
        fetchLight, fetchFull, isHidden = () => false, setTimer = setTimeout, clearTimer = clearTimeout,
        onData = () => {}, onFull = () => {}, onFullError = () => {}, onLost = () => {}, onNotFound = () => {},
        onActive = () => {}, intervalMs = 2000, maxErrors = 5
    } = deps;
    let timer = null;
    let inFlight = false;
    let ended = false;
    let stopped = false;
    let errors = 0;

    const end = () => { ended = true; onActive(false); };

    async function tick() {
        timer = null;
        if (stopped || ended || inFlight) return;
        if (isHidden()) { timer = setTimer(tick, intervalMs); return; }
        inFlight = true;
        try {
            let outcome;
            try {
                outcome = { data: await fetchLight() };
            } catch (err) {
                if (err && err.response && err.response.status === 404) {
                    if (!stopped) { end(); onNotFound(); }
                    return;
                }
                outcome = { error: true };
            }
            if (stopped) return;
            if (!outcome.error) onData(outcome.data);
            const st = nextPollState(errors, outcome, maxErrors);
            errors = st.errors;
            if (st.action === 'lost') { end(); onLost(); return; }
            if (st.action === 'finish') {
                ended = true;
                try { const full = await fetchFull(); if (!stopped) onFull(full); } catch (err) { if (!stopped) onFullError(err); }
                if (!stopped) onActive(false);
                return;
            }
            timer = setTimer(tick, intervalMs);
        } finally {
            inFlight = false;
        }
    }

    return {
        start() { onActive(true); return tick(); },
        /** Visibility returned: poll now, but only if the chain is alive and idle. */
        resume() {
            if (stopped || ended || inFlight || !timer) return false;
            clearTimer(timer);
            timer = null;
            tick();
            return true;
        },
        stop() {
            stopped = true;
            if (timer) { clearTimer(timer); timer = null; }
        },
        state() { return { inFlight, ended, stopped, hasTimer: !!timer, errors }; }
    };
}
