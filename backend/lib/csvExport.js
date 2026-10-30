// Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection.
const BOM = String.fromCharCode(0xFEFF);
const FORMULA_START_RE = /^[=+\-@\t\r]/;

/** One CSV field: always quoted, quotes doubled, values that a spreadsheet would execute are prefixed with '. */
function csvField(value) {
    let s = value === undefined || value === null ? '' : String(value);
    if (FORMULA_START_RE.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(values) {
    return values.map(csvField).join(',') + '\r\n';
}

module.exports = { BOM, csvField, csvRow };
