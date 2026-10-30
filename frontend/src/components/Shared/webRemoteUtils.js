// Helpers for the Web Remote (Guacamole) button shown by HostDetailModal and NutanixManager.

/**
 * When GET /remote/status fails: a 401/403 means this user may not use Web Remote (feature switch
 * or session) -> hide the button. Any other failure (network, 5xx) may fall back to /auth/config hasGuacamole.
 */
export function shouldFallbackToConfig(err) {
    const status = err && err.response && err.response.status;
    return !(status === 401 || status === 403);
}
