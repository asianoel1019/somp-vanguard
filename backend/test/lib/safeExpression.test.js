require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../../lib/safeExpression');

const ctx = {
    node_1: { stdout: '87\n', exitCode: 0 },
    http_step: { status: 200, body: { items: [1, 2, 3], state: 'OK' } },
    name: 'web-01',
    tags: ['prod', 'linux'],
    'check.output': { total: 3 },
};

// ── Supported syntax (documented in WORKFLOW_USER_MANUAL.md) ──

test('manual examples', () => {
    assert.equal(evaluate('parseInt(ctx.node_1.stdout) > 85', ctx), true);
    assert.equal(evaluate('ctx.http_step.status === 200', ctx), true);
    assert.equal(evaluate("ctx.node_1.exitCode === 0 && ctx.http_step.body.state === 'OK'", ctx), true);
});

test('literals and arithmetic', () => {
    assert.equal(evaluate('1 + 2 * 3', {}), 7);
    assert.equal(evaluate('(1 + 2) * 3', {}), 9);
    assert.equal(evaluate('10 % 4 - -1', {}), 3);
    assert.equal(evaluate('"a" + \'b\'', {}), 'ab');
    assert.equal(evaluate('"it\\"s"', {}), 'it"s');
    assert.equal(evaluate('1.5 * 2', {}), 3);
    assert.equal(evaluate('null', {}), null);
    assert.equal(evaluate('undefined', {}), undefined);
});

test('comparison, equality, logic, ternary', () => {
    assert.equal(evaluate('3 >= 3 && 2 < 3 && 4 <= 5 && 6 > 5', {}), true);
    assert.equal(evaluate('"1" == 1', {}), true);
    assert.equal(evaluate('"1" === 1', {}), false);
    assert.equal(evaluate('1 != 2 && 1 !== "1"', {}), true);
    assert.equal(evaluate('!true || !!0', {}), false);
    assert.equal(evaluate('false || "fallback"', {}), 'fallback');
    assert.equal(evaluate('ctx.name === "web-01" ? "yes" : "no"', ctx), 'yes');
});

test('&& and || short-circuit (right side not evaluated)', () => {
    assert.equal(evaluate('false && ctx.missing.deep', ctx), false);
    assert.equal(evaluate('true || ctx.missing.deep', ctx), true);
});

test('member access with dot, brackets and flat legacy keys', () => {
    assert.equal(evaluate('ctx.http_step.body.items[1]', ctx), 2);
    assert.equal(evaluate('ctx["check.output"].total', ctx), 3);
    assert.equal(evaluate('ctx.tags.length', ctx), 2);
    assert.equal(evaluate('ctx.name.length', ctx), 6);
    assert.equal(evaluate('ctx.notThere', ctx), undefined);
});

test('whitelisted string / array methods and global functions', () => {
    assert.equal(evaluate('ctx.node_1.stdout.trim() === "87"', ctx), true);
    assert.equal(evaluate('ctx.name.startsWith("web") && ctx.name.endsWith("01")', ctx), true);
    assert.equal(evaluate('ctx.name.toUpperCase().includes("WEB")', ctx), true);
    assert.equal(evaluate('ctx.tags.includes("prod")', ctx), true);
    assert.equal(evaluate('ctx.tags.join(",")', ctx), 'prod,linux');
    assert.equal(evaluate('ctx.name.split("-")[1]', ctx), '01');
    assert.equal(evaluate('parseFloat("1.5") + Number("2")', {}), 3.5);
    assert.equal(evaluate('Math.max(1, 5, 3) === 5 && Math.round(2.6) === 3', {}), true);
    assert.equal(evaluate('isNaN(parseInt("abc"))', {}), true);
    assert.equal(evaluate('String(42) + Boolean(1)', {}), '42true');
});

// ── Errors are explicit, not silently false ──

test('accessing a property of undefined throws a readable error', () => {
    assert.throws(() => evaluate('ctx.node_9.stdout', ctx), /Cannot read property "stdout" of undefined/);
});

test('syntax errors throw', () => {
    assert.throws(() => evaluate(')(', {}), /Unexpected/);
    assert.throws(() => evaluate('1 +', {}), /Unexpected end/);
    assert.throws(() => evaluate('"unterminated', {}), /Unterminated string/);
    assert.throws(() => evaluate('1 2', {}), /Unexpected token/);
    assert.throws(() => evaluate('', {}), /empty/i);
});

// ── Sandbox: nothing outside the whitelist is reachable ──

test('unknown identifiers are rejected', () => {
    for (const expr of ['process', 'require("fs")', 'globalThis', 'this', 'Function', 'eval("1")', 'module', 'global']) {
        assert.throws(() => evaluate(expr, {}), /Unknown identifier|Unexpected/, expr);
    }
});

test('prototype chain is not reachable', () => {
    for (const expr of [
        'ctx.constructor',
        'ctx.__proto__',
        'ctx["constructor"]["constructor"]("return process")()',
        'ctx.name.constructor',
        'ctx.tags.constructor',
        'ctx.name["__proto__"]',
        'parseInt.constructor',
        'Math.constructor',
        'ctx.toString',
        'ctx.hasOwnProperty("name")',
    ]) {
        assert.throws(() => evaluate(expr, ctx), /not allowed|not a function|Cannot call/, expr);
    }
});

test('only whitelisted methods can be called', () => {
    assert.throws(() => evaluate('ctx.tags.push("x")', ctx), /not allowed/);
    assert.throws(() => evaluate('ctx.tags.map(parseInt)', ctx), /not allowed/);
    assert.throws(() => evaluate('ctx.name.replace("a", "b")', ctx), /not allowed/);
    assert.equal(ctx.tags.length, 2);
});

test('call arguments must be primitives', () => {
    assert.throws(() => evaluate('String(ctx.http_step)', ctx), /primitive/);
    assert.throws(() => evaluate('ctx.tags.includes(ctx.tags)', ctx), /primitive/);
});

test('functions themselves cannot be returned or stored', () => {
    assert.throws(() => evaluate('parseInt', {}), /Cannot use function/);
    assert.throws(() => evaluate('ctx.name.trim', ctx), /not allowed|Cannot use function/);
});

test('assignment and other JS syntax are rejected', () => {
    for (const expr of ['ctx.name = "x"', 'ctx.a++', '() => 1', 'function(){}', '`tpl`', 'new Date()', 'a; b', '[1,2]', '{}']) {
        assert.throws(() => evaluate(expr, ctx), Error, expr);
    }
    assert.equal(ctx.name, 'web-01');
});

test('very long expressions are rejected', () => {
    assert.throws(() => evaluate('1+'.repeat(3000) + '1', {}), /too long/);
});
