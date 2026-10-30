import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFallbackToConfig } from './webRemoteUtils.js';

test('a 403 / 401 from /remote/status hides Web Remote (no fallback to /auth/config)', () => {
    assert.equal(shouldFallbackToConfig({ response: { status: 403 } }), false);
    assert.equal(shouldFallbackToConfig({ response: { status: 401 } }), false);
});

test('network errors and server errors may still fall back to /auth/config', () => {
    assert.equal(shouldFallbackToConfig(new Error('Network Error')), true);
    assert.equal(shouldFallbackToConfig({ response: { status: 500 } }), true);
    assert.equal(shouldFallbackToConfig(undefined), true);
});
