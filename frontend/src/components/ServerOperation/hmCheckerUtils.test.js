import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveBackupFilename, buildCompareRequest, nextPinnedFile, pinChipLabel, describeFileSource, formatFileSize,
    interpretCompareFailure, activeFileFromStatus, normalizePin, ignoredEnvsToNames, namesToIgnoredEnvs, envBadgeIsProduction
} from './hmCheckerUtils.js';

test('ignoredEnvs: stored ids <-> modal names; unknown values kept; production badge from the flag', () => {
    const envs = [{ id: 'd', name: 'DEV' }, { id: 't', name: 'TRUST', isProduction: true }];
    assert.deepEqual(ignoredEnvsToNames(['d', 'trust', 'Gone'], envs), ['DEV', 'TRUST', 'Gone']);
    assert.deepEqual(namesToIgnoredEnvs(['DEV', 'TRUST', 'Gone'], envs), ['d', 't', 'Gone']);
    assert.equal(envBadgeIsProduction({ env: 'TRUST' }, envs), true);
    assert.equal(envBadgeIsProduction({ envId: 'd', env: 'DEV' }, envs), false);
    assert.equal(envBadgeIsProduction({ env: 'UNKNOWN' }, envs), false);
});

test('no pin means "latest" (empty backupFilename) for every kind of action', () => {
    for (const pin of ['', undefined, null, '   ', {}, { filename: '  ' }]) {
        assert.equal(resolveBackupFilename(pin), '');
    }
    assert.equal(resolveBackupFilename(' a.txt '), 'a.txt');
    for (const args of [
        { source: 'cmdb' },
        { source: 'cmdb', envFilter: 'TRUST', force: true },
        { source: 'custom', customText: 'x' },
        { source: 'cmdb', force: true }
    ]) {
        const req = buildCompareRequest(args);
        assert.equal(req.backupFilename, '');
        assert.equal('backupDirectory' in req, false);
    }
});

test('a picked file is sent with its directory only while pinned', () => {
    const req = buildCompareRequest({ source: 'cmdb', pinnedFile: { filename: 'a.txt', directory: 'D:\\x' }, force: true });
    assert.equal(req.backupFilename, 'a.txt');
    assert.equal(req.backupDirectory, 'D:\\x');
    assert.equal(req.force, true);
    assert.equal(buildCompareRequest({ pinnedFile: null }).backupFilename, '');
    assert.deepEqual(normalizePin('b.txt'), { filename: 'b.txt', directory: '' });
});

test('request defaults and upload source', () => {
    assert.deepEqual(buildCompareRequest({}), { source: 'cmdb', backupFilename: '', envFilter: 'ALL', customText: '', force: false });
    assert.equal(buildCompareRequest({ useUploads: true }).backupSource, 'upload');
    assert.equal('backupSource' in buildCompareRequest({ useUploads: false }), false);
});

test('pin transitions: page load never pins; pick pins; clear returns to latest', () => {
    const pin = { filename: 'a.txt', directory: 'D' };
    assert.equal(nextPinnedFile(pin, { type: 'pageLoad' }), null);
    assert.deepEqual(nextPinnedFile(null, { type: 'pick', filename: 'a.txt', directory: 'D' }), pin);
    assert.equal(nextPinnedFile(pin, { type: 'clear' }), null);
    assert.deepEqual(nextPinnedFile(pin, { type: 'other' }), pin);
    assert.equal(nextPinnedFile(pin, { type: 'pick', filename: '' }), null);
});

test('labels', () => {
    assert.equal(pinChipLabel({ filename: 'a.txt', directory: 'D' }), '已固定：a.txt（改用最新）');
    assert.equal(describeFileSource('unc'), 'UNC 共享');
    assert.equal(describeFileSource('upload'), '已上傳的備份');
    assert.equal(describeFileSource(undefined), '');
    assert.equal(formatFileSize(1048576), '1.00 MB');
    assert.equal(formatFileSize(2048), '2.0 KB');
    assert.equal(formatFileSize(12), '12 B');
    assert.equal(formatFileSize(undefined), '');
});

test('compare failure: UNC error clears the view and keeps the reason; pinned 404 clears view and unpins', () => {
    const unc = interpretCompareFailure({ status: 503, data: { error: 'x', uncError: 'timeout' }, pinned: false });
    assert.deepEqual([unc.clearView, unc.uncError, unc.unpin], [true, 'timeout', false]);
    const gone = interpretCompareFailure({ status: 404, data: { error: '找不到', pinnedMissing: true }, pinned: true });
    assert.deepEqual([gone.clearView, gone.unpin, gone.uncError], [true, true, '']);
    assert.match(gone.message, /找不到/);
    const noFiles = interpretCompareFailure({ status: 404, data: { error: '沒有備份檔' }, pinned: false });
    assert.deepEqual([noFiles.clearView, noFiles.unpin], [false, false]);
    const other = interpretCompareFailure({ status: 500, data: null, fallbackMessage: 'net down', pinned: true });
    assert.deepEqual([other.clearView, other.unpin], [false, false]);
    assert.match(other.message, /net down/);
});

test('header file after a status refresh', () => {
    const st = { hasBackup: true, activeFile: { filename: 'n.txt' } };
    assert.deepEqual(activeFileFromStatus(st, null), { set: true, file: { filename: 'n.txt' } });
    assert.deepEqual(activeFileFromStatus(st, { filename: 'p.txt' }), { set: false, file: null });
    assert.deepEqual(activeFileFromStatus({ hasBackup: false }, null), { set: true, file: null });
    assert.deepEqual(activeFileFromStatus({ hasBackup: true, uncError: 'x', activeFile: {} }, null), { set: true, file: null });
    assert.deepEqual(activeFileFromStatus({ hasBackup: false }, { filename: 'p.txt' }), { set: true, file: null });
});
