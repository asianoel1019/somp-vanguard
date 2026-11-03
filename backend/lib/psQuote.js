// Values placed inside PowerShell script text. PowerShell also treats the typographic quotes as quote characters,
// so they are escaped like the ASCII ones.

/** Body of a single-quoted string ('...'): nothing expands, a quote is escaped by doubling it. */
function psSq(value) {
    return String(value == null ? '' : value).replace(/['‘’‚‛]/g, (c) => c + c);
}

/** Body of a double-quoted string ("..."): backtick, $ and double quotes are escaped with a backtick. */
function psDq(value) {
    return String(value == null ? '' : value).replace(/[`$"“”„]/g, (c) => '`' + c);
}

module.exports = { psSq, psDq };
