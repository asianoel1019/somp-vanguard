import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from './exportUtils.js';

test('csvCell: quotes doubled, formula prefixes neutralised, plain values untouched', () => {
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    for (const v of ['+1', '-1', '@SUM(A1)']) assert.equal(csvCell(v), `"'${v}"`);
    assert.equal(csvCell('192.0.2.1, 192.0.2.2'), '"192.0.2.1, 192.0.2.2"');
    assert.equal(csvCell(12), '"12"');
    assert.equal(csvCell('app01'), '"app01"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(undefined), '""');
});
