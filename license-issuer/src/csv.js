// CSV export of the sales report: UTF-8 with BOM (Excel opens it as UTF-8), CRLF lines, RFC 4180 quoting, and text that
// a spreadsheet could run as a formula (starting with = + - @, or a tab / CR) prefixed with an apostrophe.
const R = require('./store/rules');

const BOM = '\uFEFF';

/** One CSV cell. */
function cell(value) {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (typeof value !== 'number' && (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = `'${s}`;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV text of rows (arrays of cells), BOM first. */
function toCsv(rows) {
    return BOM + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Currencies that appear in the amounts, in the fixed list's order (others after, alphabetically). */
function currenciesOf(lines) {
    const seen = new Set(lines.flatMap((l) => Object.keys(l.amounts || {})));
    return [...R.CURRENCIES.filter((c) => seen.has(c)), ...[...seen].filter((c) => !R.CURRENCIES.includes(c)).sort()];
}

/** Summary CSV (reportSummary result): one row per sales person, then Total; one amount column per currency. */
function summaryCsv(summary) {
    const curs = currenciesOf([...summary.rows, summary.totals]);
    const head = ['Sales', 'Licenses', 'New', 'Renewal', 'Trial', ...curs.map((c) => `Amount ${c}`)];
    const row = (name, l) => [name, l.count, l.new, l.renewal, l.trial, ...curs.map((c) => (l.amounts[c] === undefined ? '' : l.amounts[c]))];
    return toCsv([head, ...summary.rows.map((l) => row(l.salesId === null ? '(unassigned)' : l.salesName, l)), row('Total', summary.totals)]);
}

const kindText = (l) => (l.type === 'trial' ? 'Trial' : l.isRenewal ? 'Renewal' : 'New');

/** Detail CSV (reportDetail result): one row per license. */
function detailCsv(detail) {
    const head = ['License ID', 'Customer', 'Licensed to', 'Type', 'New/Renewal', 'Issued', 'Expires', 'Sales', 'Amount', 'Currency', 'Order no.',
        'Plan', 'Status', 'Revoked at', 'Revoke reason', 'Replaces', 'Replaced by'];
    return toCsv([head, ...detail.rows.map((l) => [
        l.licenseId, l.customerName, l.licensedTo, l.type === 'trial' ? 'Trial' : 'Paid', kindText(l), l.issuedAt, l.expiresAt || '', l.salesName || '',
        l.amount, l.currency || '', l.orderNo || '', l.planName || '', l.status, l.revokedAt || '', l.revokeReason || '', l.replacesLicenseId || '',
        l.replacedByLicenseId || '',
    ])]);
}

module.exports = { BOM, cell, toCsv, summaryCsv, detailCsv };
