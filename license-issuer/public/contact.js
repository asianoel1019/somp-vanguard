// Vendor contact rules shared by the page (window.LicenseContact) and the tests (require). They match the product's
// rules (backend/lib/licenseFormat.js contactError, used by the server through scripts/licenseIssuerCore.js makeContact):
// both values optional (trimmed; empty = not set), vendor at most 100 characters, email at most 200 and name@domain, no control characters in either.
(function (root) {
    'use strict';
    var VENDOR_MAX = 100;
    var EMAIL_MAX = 200;
    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
    var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
    var trim = function (v) { return typeof v === 'string' ? v.trim() : ''; };

    /** { vendor: message or '', email: message or '' } for the two typed values. */
    function check(vendor, email) {
        var v = trim(vendor);
        var e = trim(email);
        return {
            vendor: v.length > VENDOR_MAX ? 'Vendor must be at most ' + VENDOR_MAX + ' characters.'
                : CONTROL_CHARS.test(v) ? 'Vendor must not contain line breaks or control characters.' : '',
            email: !e ? '' : e.length > EMAIL_MAX ? 'Contact email must be at most ' + EMAIL_MAX + ' characters.'
                : CONTROL_CHARS.test(e) ? 'Contact email must not contain line breaks or control characters.'
                : !EMAIL_PATTERN.test(e) ? 'Contact email must look like name@domain (no spaces).' : '',
        };
    }

    /** "vendor (email)", "vendor", "email", or '' when neither is set. */
    function text(vendor, email) {
        var v = trim(vendor);
        var e = trim(email);
        if (v && e) return v + ' (' + e + ')';
        return v || e;
    }

    var api = { VENDOR_MAX: VENDOR_MAX, EMAIL_MAX: EMAIL_MAX, check: check, text: text };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LicenseContact = api;
})(this);
