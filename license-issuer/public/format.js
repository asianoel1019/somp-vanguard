// Display and form helpers shared by the page (window.LicenseFormat) and the tests (require). No DOM access here.
(function (root) {
    'use strict';
    var D = typeof module !== 'undefined' && module.exports ? require('./dates') : root.LicenseDates;

    var STATUS_BADGE = { 'Active': 'ok', 'Expires soon': 'warn', 'Expired': 'bad', 'Format 1 (invalid)': 'bad', 'Revoked': 'muted' };
    var REASONS = { replaced: 'Replaced', terminated: 'Terminated', issued_in_error: 'Issued in error', other: 'Other' };
    var VIA = { download: 'download', mail: 'email', other: 'other way' };
    var AMOUNT_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

    function plural(n, word) { return n + ' ' + word + (Math.abs(n) === 1 ? '' : 's'); }

    /** 12345.5 -> "12,345.50"; whole numbers without decimals ("12,000"). */
    function number(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '';
        var whole = Math.round(n * 100) % 100 === 0;
        var s = Math.abs(n).toFixed(whole ? 0 : 2);
        var parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (n < 0 ? '-' : '') + parts.join('.');
    }

    /** "TWD 12,000"; '' when there is no amount. */
    function money(amount, currency) {
        if (amount === null || amount === undefined || amount === '') return '';
        return (currency ? currency + ' ' : '') + number(Number(amount));
    }

    /** { TWD: 1000, USD: 50 } -> "TWD 1,000 · USD 50" in the given currency order (others after); '—' when empty. */
    function amountsText(amounts, order) {
        var keys = Object.keys(amounts || {});
        if (!keys.length) return '—';
        var list = order || [];
        keys.sort(function (a, b) {
            var ia = list.indexOf(a); var ib = list.indexOf(b);
            if (ia < 0) ia = 999; if (ib < 0) ib = 999;
            return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
        });
        return keys.map(function (k) { return money(amounts[k], k); }).join(' · ');
    }

    /** Currencies present in summary rows, in the fixed list's order. */
    function currenciesOf(rows, order) {
        var seen = {};
        (rows || []).forEach(function (r) { Object.keys(r.amounts || {}).forEach(function (k) { seen[k] = true; }); });
        return Object.keys(seen).sort(function (a, b) {
            var ia = (order || []).indexOf(a); var ib = (order || []).indexOf(b);
            if (ia < 0) ia = 999; if (ib < 0) ib = 999;
            return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
        });
    }

    /** 0.5 -> "50%", 0.3333 -> "33.3%", null -> "—". */
    function percent(rate) {
        if (rate === null || rate === undefined || !isFinite(rate)) return '—';
        var p = Math.round(rate * 1000) / 10;
        return (p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)) + '%';
    }

    function badgeClass(status) { return STATUS_BADGE[status] || ''; }
    function typeLabel(type) { return type === 'trial' ? 'Trial' : 'Paid'; }
    function kindLabel(l) { return l.type === 'trial' ? 'Trial' : l.isRenewal ? 'Renewal' : 'New'; }
    function reasonText(reason) { return REASONS[reason] || reason || ''; }

    /** "a=1&b=x%20y" from an object; empty, null and undefined values are left out. */
    function query(params) {
        return Object.keys(params || {}).filter(function (k) {
            var v = params[k];
            return v !== '' && v !== null && v !== undefined && v !== false;
        }).map(function (k) {
            var v = params[k] === true ? '1' : String(params[k]);
            return encodeURIComponent(k) + '=' + encodeURIComponent(v);
        }).join('&');
    }

    /**
     * The typed amount: { value: number|null, error: '' }. Empty -> null; at most 2 decimals; no signs, spaces inside,
     * thousands separators or exponents.
     */
    function parseAmount(text) {
        var s = String(text === undefined || text === null ? '' : text).trim();
        if (!s) return { value: null, error: '' };
        if (!AMOUNT_PATTERN.test(s)) return { value: null, error: 'Amount must be a number of at least 0 with at most 2 decimals (e.g. 12000 or 99.50).' };
        return { value: Number(s), error: '' };
    }

    /** Customers whose name, email, tax ID, contact person or phone contain every word of the search text (any case). */
    function filterCustomers(list, text) {
        var words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return (list || []).slice();
        return (list || []).filter(function (c) {
            var hay = [c.name, c.email, c.taxId, c.contactPerson, c.phone].filter(Boolean).join(' ').toLowerCase();
            return words.every(function (w) { return hay.indexOf(w) >= 0; });
        });
    }

    /** Expiry of a plan (or a number of months / days) starting on `start`. */
    function planExpiry(start, plan) {
        if (!plan || !D.isRealDate(start)) return '';
        return D.planEnd(start, plan.termValue, plan.termUnit);
    }

    /**
     * Start of a renewal: the day after the old expiry while the old license is still valid on `today`, else today
     * (expired, revoked or format 1). A renewal license is issued today and runs on from that start.
     */
    function renewalStart(oldExpires, today) {
        return D.isRealDate(oldExpires) && oldExpires >= today ? D.addDays(oldExpires, 1) : today;
    }

    /**
     * The plan a renewal starts from: the license's own plan when it is an active paid plan, otherwise the active paid
     * plan of 12 months, otherwise the first active paid plan, otherwise null.
     */
    function renewalPlan(license, plans) {
        var paid = (plans || []).filter(function (p) { return p.active && p.type === 'paid'; });
        var own = paid.filter(function (p) { return p.id === license.planId; })[0];
        if (own) return own;
        var year = paid.filter(function (p) { return p.termUnit === 'months' && p.termValue === 12; })[0];
        return year || paid[0] || null;
    }

    /**
     * Issue-form values for Renew: same customer and sales person, a paid plan, issued today, expiring one term after
     * renewalStart (1 year when there is no plan), the plan's price (else the old paid amount) and currency.
     */
    function renewalDefaults(license, plans, today, defaultCurrency) {
        var plan = renewalPlan(license, plans);
        var start = renewalStart(license.revokedAt ? null : license.expiresAt, today);
        var expiresAt = plan ? planExpiry(start, plan) : D.planEnd(start, 12, 'months');
        var amount = plan && plan.price !== null && plan.price !== undefined ? plan.price
            : license.type === 'paid' && license.amount !== null && license.amount !== undefined ? license.amount : null;
        var currency = plan && plan.price !== null && plan.price !== undefined ? plan.currency
            : license.type === 'paid' && license.currency ? license.currency : (plan && plan.currency) || defaultCurrency || 'TWD';
        return {
            customerId: license.customerId, renewalOf: license.licenseId, planId: plan ? plan.id : null, salesId: license.salesId || null,
            issuedAt: today, expiresAt: expiresAt, amount: amount, currency: currency, orderNo: '',
        };
    }

    /** One line describing a license event for the timeline. */
    function eventText(e) {
        var d = e.detail || {};
        switch (e.type) {
            case 'issued': {
                var bits = [];
                if (d.source) bits.push('via ' + (d.source === 'cli' ? 'command line' : 'web page'));
                if (d.plan) bits.push('plan ' + d.plan);
                if (d.renewalOf) bits.push('renews ' + d.renewalOf);
                if (d.replaces) bits.push('replaces ' + d.replaces);
                return 'Issued' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
            }
            case 'delivered': return 'Sent to ' + (d.to || '?') + (d.attachment ? ' with ' + d.attachment : '');
            case 'delivery_failed': return 'Sending to ' + (d.to || '?') + ' failed' + (d.error ? ': ' + d.error : '');
            case 'downloaded': return 'Downloaded';
            case 'reissued': return 'Reissued by ' + (VIA[d.via] || d.via || 'download') + (d.to ? ' to ' + d.to : '') + (d.reason ? ': ' + d.reason : '');
            case 'revoked': return 'Revoked: ' + reasonText(d.reason) + (d.note ? ' (' + d.note + ')' : '');
            case 'replaced': return 'Replaced by ' + (d.replacedBy || '?') + (d.note ? ' (' + d.note + ')' : '');
            case 'edited': {
                var before = d.before || {}; var after = d.after || {};
                var names = { sales: 'sales', amount: 'amount', currency: 'currency', orderNo: 'order no.' };
                var parts = Object.keys(names).filter(function (k) { return k in after; }).map(function (k) {
                    var show = function (v) { return v === null || v === undefined || v === '' ? '(none)' : String(v); };
                    return names[k] + ' ' + show(before[k]) + ' → ' + show(after[k]);
                });
                return 'Edited' + (parts.length ? ': ' + parts.join('; ') : '');
            }
            case 'imported': return 'Imported from the old registry' + (d.line ? ' (line ' + d.line + ')' : '');
            default: return e.type;
        }
    }

    /** "2026-11-25T10:00:00+08:00" -> "2026-11-25 10:00". */
    function stampText(s) {
        var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(s || ''));
        return m ? m[1] + ' ' + m[2] : String(s || '');
    }

    /** 1536 -> "1.5 KB". */
    function sizeText(bytes) {
        if (typeof bytes !== 'number' || !isFinite(bytes)) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (Math.round(bytes / 102.4) / 10) + ' KB';
        return (Math.round(bytes / 104857.6) / 10) + ' MB';
    }

    /** "12 days left", "today", "3 days ago", '—'. */
    function daysText(daysLeft) {
        if (daysLeft === null || daysLeft === undefined) return '—';
        if (daysLeft === 0) return 'today';
        return daysLeft > 0 ? plural(daysLeft, 'day') + ' left' : plural(-daysLeft, 'day') + ' ago';
    }

    /** File name from a Content-Disposition header (RFC 5987 filename* first); `fallback` otherwise. */
    function dispositionName(header, fallback) {
        var cd = String(header || '');
        var star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        if (star) { try { return decodeURIComponent(star[1]); } catch (e) { /* fall through */ } }
        var m = /filename="?([^";]+)"?/i.exec(cd);
        return m ? m[1] : fallback;
    }

    var api = {
        plural: plural, number: number, money: money, amountsText: amountsText, currenciesOf: currenciesOf, percent: percent,
        badgeClass: badgeClass, typeLabel: typeLabel, kindLabel: kindLabel, reasonText: reasonText, query: query, parseAmount: parseAmount,
        filterCustomers: filterCustomers, planExpiry: planExpiry, renewalStart: renewalStart, renewalPlan: renewalPlan,
        renewalDefaults: renewalDefaults, eventText: eventText, stampText: stampText, sizeText: sizeText, daysText: daysText,
        dispositionName: dispositionName,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LicenseFormat = api;
})(this);
