const test = require('node:test');
const assert = require('node:assert/strict');
const { isContainedError } = require('../../lib/processErrors');

const withStack = (message, frame) => { const e = new Error(message); e.stack = `Error: ${message}\n    at x (${frame})`; return e; };

test('network failures and the remote-access stack are contained', () => {
    assert.ok(isContainedError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
    assert.ok(isContainedError(new Error('socket hang up')));
    assert.ok(isContainedError(withStack('Cannot read properties of undefined', 'C:\\app\\node_modules\\guacamole-lite\\lib\\ClientConnection.js:40:1')));
    assert.ok(isContainedError(withStack('Invalid frame', '/app/node_modules/ws/lib/receiver.js:10:1')));
    assert.ok(isContainedError(withStack('boom', 'C:\\app\\backend\\services\\guacamoleProxy.js:120:5')));
});

test('everything else is not, even when it mentions a connection, a token or a socket', () => {
    assert.ok(!isContainedError(withStack('SQLITE_BUSY: database connection is locked', 'C:\\app\\backend\\services\\db.js:10:1')));
    assert.ok(!isContainedError(withStack('Invalid token in JSON', 'C:\\app\\backend\\routes\\settings.js:5:1')));
    assert.ok(!isContainedError(withStack('socket option missing in config', 'C:\\app\\backend\\lib\\nas.js:5:1')));
    assert.ok(!isContainedError(new TypeError('x is not a function')));
    assert.ok(!isContainedError(undefined));
    assert.ok(!isContainedError('a string reason'));
});
