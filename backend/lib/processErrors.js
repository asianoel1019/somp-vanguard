// Which uncaught exceptions / unhandled rejections the backend survives.
// Only network-level failures (a peer resetting or dropping a socket) and failures raised inside the Guacamole /
// WebSocket stack are contained. Anything else (a database error, a bug in a route) still stops the process, so
// the service manager restarts it in a known state instead of running on half-broken.
const NETWORK_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
// stack frames of the remote-access stack (guacamole-lite, ws, our proxy)
const REMOTE_STACK_RE = /[\\/](guacamole-lite|ws)[\\/]|guacamoleProxy\.js/;

/** true when the error may be logged and the process kept running */
function isContainedError(err) {
    if (!err) return false;
    if (err.code && NETWORK_CODES.has(err.code)) return true;
    const msg = String(err.message || err);
    if (/^(read |write )?(ECONNRESET|EPIPE)\b|socket hang up/i.test(msg)) return true;
    return REMOTE_STACK_RE.test(String(err.stack || ''));
}

module.exports = { isContainedError };
