/** Text helpers shared by notification code. */

/**
 * Like String#slice(0, max) but never ends on the first half of a UTF-16 surrogate pair (e.g. an emoji),
 * which would make encodeURIComponent throw and the whole message be dropped.
 */
function safeSlice(text, max) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    let cut = max;
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
    return s.slice(0, cut);
}

module.exports = { safeSlice };
