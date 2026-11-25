// Date rules shared by the page (window.LicenseDates) and the server / tests (require). Dates are YYYY-MM-DD strings.
(function (root) {
    'use strict';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var parts = function (s) { return String(s).split('-').map(Number); };
    var fmt = function (d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };

    function isRealDate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        var p = parts(s);
        var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
        return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
    }

    function addDays(s, n) {
        var p = parts(s);
        return fmt(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)));
    }

    /** Same day N years later; 29 Feb becomes 28 Feb in a common year. */
    function addYears(s, n) {
        var p = parts(s);
        var d = new Date(Date.UTC(p[0] + n, p[1] - 1, p[2]));
        if (d.getUTCMonth() !== p[1] - 1) d = new Date(Date.UTC(p[0] + n, p[1], 0)); // overflowed: last day of the month
        return fmt(d);
    }

    /** A term of N years starting on `start`: the day before the anniversary (2026-11-25 + 1y -> 2027-11-24). */
    function termEnd(start, years) {
        var p = parts(start);
        // the anniversary of 29 Feb in a common year is 1 Mar, so the term ends on 28 Feb
        return addDays(fmt(new Date(Date.UTC(p[0] + years, p[1] - 1, p[2]))), -1);
    }

    function daysBetween(from, to) {
        var a = parts(from);
        var b = parts(to);
        return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
    }

    /**
     * Renewal of a registry row: issued today; expires one year after the original expiry while it has not expired,
     * otherwise (expired, or a format-1 row without an expiry date) one year from today.
     */
    function renewDates(originalExpires, today) {
        var expiresAt = isRealDate(originalExpires) && originalExpires >= today ? addYears(originalExpires, 1) : termEnd(today, 1);
        return { issuedAt: today, expiresAt: expiresAt };
    }

    var api = { isRealDate: isRealDate, addDays: addDays, addYears: addYears, termEnd: termEnd, daysBetween: daysBetween, renewDates: renewDates };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LicenseDates = api;
})(this);
