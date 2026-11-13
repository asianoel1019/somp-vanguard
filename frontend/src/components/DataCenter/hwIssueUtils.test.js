import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNoteTime, csvCell, initialOf } from './hwIssueUtils.js';

test('csvCell quotes, doubles quotes, and keeps formula-like text as text', () => {
    assert.equal(csvCell('PSU "A"'), '"PSU ""A"""');
    assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${lead}cmd`).startsWith(`"'${lead}`), JSON.stringify(lead));
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(0), '"0"');
});

test('formatNoteTime shows server ISO times in local time and older text unchanged', () => {
    const iso = '2026-11-13T01:02:03.000Z';
    assert.equal(formatNoteTime(iso), new Date(iso).toLocaleString());
    assert.equal(formatNoteTime('2024/1/2 上午10:00:00'), '2024/1/2 上午10:00:00');
    assert.equal(formatNoteTime(''), '');
    assert.equal(formatNoteTime(undefined), '');
});

test('initialOf never fails on a missing reporter', () => {
    assert.equal(initialOf('alice'), 'A');
    assert.equal(initialOf(''), '?');
    assert.equal(initialOf(undefined), '?');
    assert.equal(initialOf('  bob'), 'B');
});
