import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMasterLines, softwareNames } from './masterListUtils.js';

const ENC = (t) => t.replace(/\r?\n/g, '\\\\n');

test('stored (three-character) separators split Windows entries and keep a UNC path start whole', () => {
    const raw = 'A|\\\\nas01\\soft\\a.exe|/S\nB|b.exe|\nC|c.exe|-q||@detect:reg:C*';
    assert.deepEqual(softwareNames(ENC(raw)), ['A', 'B', 'C']);
    assert.equal(splitMasterLines(ENC(raw))[0], 'A|\\\\nas01\\soft\\a.exe|/S');
});

test('a Linux cmd: detect rule does not swallow the next line; real newlines work too', () => {
    const raw = 'L1|echo|@detect:cmd:test -f /x\nL2|yum install -y foo';
    assert.deepEqual(softwareNames(ENC(raw), 'linux'), ['L1', 'L2']);
    assert.deepEqual(softwareNames(raw, 'linux'), ['L1', 'L2']);
    assert.deepEqual(softwareNames(''), []);
});

test('stored form keeps a single backslash-n inside a relative path', () => {
    const BS = String.fromCharCode(92);
    const v = ['A|soft' + BS + 'notepad' + BS + 'setup.exe|/S', 'B|' + BS + BS + 'nas01' + BS + 'x.msi|'].join(BS + BS + 'n');
    assert.deepEqual(softwareNames(v), ['A', 'B']);
});

test('mis-split 2 and mixed text behave like the backend', () => {
    assert.deepEqual(splitMasterLines('A|soft\\new\\a.exe|\\\\nB|D:\\b.exe|'), ['A|soft\\new\\a.exe|', 'B|D:\\b.exe|']);
    assert.deepEqual(splitMasterLines('A|a.exe|-q\\\\nB|b.exe|\nC|soft\\new\\c.exe|'), ['A|a.exe|-q', 'B|b.exe|', 'C|soft\\new\\c.exe|']);
    const single = 'N|\\\\nas\\soft\\notepad\\setup.exe|/S';
    assert.deepEqual(splitMasterLines(single), [single]);
});
