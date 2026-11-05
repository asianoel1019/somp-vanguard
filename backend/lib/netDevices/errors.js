// Classified failures of a device call. The HTTP status is what Vanguard answers its own caller with: a device that
// rejects the stored credentials is a gateway failure (502), never 401/403, which the page reads as "you are logged out".
const STATUS = {
    AUTH: 502,          // the device rejected the credentials
    FORBIDDEN: 502,     // the account lacks the permission for this call
    UNREACHABLE: 504,   // no answer: DNS, refused, timeout
    TLS: 502,           // certificate verification failed
    UNSUPPORTED: 400,   // this vendor / firmware does not offer the call
    BAD_REQUEST: 400,   // the request to Vanguard was incomplete or invalid
    NOT_CONFIGURED: 409, // the device has no management connection
    HOSTKEY: 502,       // the SSH host key differs from the pinned one (replaced device, or someone in between)
    OTHER: 502,
};

class NetDeviceError extends Error {
    constructor(code, message) {
        super(message);
        this.code = STATUS[code] ? code : 'OTHER';
        this.status = STATUS[this.code];
    }
}

const netError = (code, message) => new NetDeviceError(code, message);

module.exports = { NetDeviceError, netError, STATUS };
