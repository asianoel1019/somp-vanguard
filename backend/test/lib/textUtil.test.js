require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeSlice } = require('../../lib/textUtil');

test('safeSlice never cuts a surrogate pair in half', () => {
    assert.equal(safeSlice('ab\u{1F600}cd', 3), 'ab');          // 😀 starts at index 2 (two UTF-16 units)
    assert.equal(safeSlice('ab\u{1F600}cd', 4), 'ab\u{1F600}');
    assert.equal(safeSlice('abcdef', 3), 'abc');
    assert.equal(safeSlice('short', 100), 'short');
    assert.equal(safeSlice(null, 5), '');
    assert.doesNotThrow(() => encodeURIComponent(safeSlice('x'.repeat(2) + '\u{1F600}', 3)));
});
