const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, unifiedDiff } = require('../../lib/netDevices/lineDiff');

const apply = (ops) => ({ a: ops.filter(o => o.t !== '+').map(o => o.s), b: ops.filter(o => o.t !== '-').map(o => o.s) });

test('edit script reproduces both sides', () => {
    const cases = [
        [[], []],
        [['a'], []],
        [[], ['a']],
        [['a', 'b', 'c'], ['a', 'x', 'c']],
        [['x', 'a', 'b', 'a', 'c'], ['a', 'b', 'y', 'a', 'c', 'z']],
        [['end', 'end', 'end'], ['end', 'set x', 'end', 'end']],
    ];
    for (const [a, b] of cases) {
        const r = apply(diffLines(a, b));
        assert.deepEqual(r.a, a);
        assert.deepEqual(r.b, b);
    }
});

test('a changed header line and a change at the end stay two small hunks', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `    set line ${i}`);
    const a = ['#conf_file_ver=1', ...body, 'end'].join('\n');
    const b = ['#conf_file_ver=2', ...body.slice(0, 1990), '    set new value', ...body.slice(1990), 'end'].join('\n');
    const d = unifiedDiff(a, b);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.equal(d.hunks.length, 2);
    assert.equal(d.hunks[0].aStart, 1);
    assert.ok(d.hunks[1].lines.length <= 7);
    assert.deepEqual(d.hunks[1].lines.filter(l => l.t !== ' ').map(l => l.s), ['    set new value']);
});

test('identical texts have no hunks; CRLF is ignored; output is capped', () => {
    assert.deepEqual(unifiedDiff('a\r\nb', 'a\nb').hunks, []);
    const big = unifiedDiff(Array.from({ length: 100 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 100 }, (_, i) => `b${i}`).join('\n'), { maxLines: 50 });
    assert.equal(big.truncated, true);
});
