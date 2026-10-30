require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInventoryConfig, parseSubnetEntry, assertIpv4, isIpv4, escapeHtml } = require('../../lib/inventoryValidation');

test('parseSubnetEntry accepts plain prefixes and ranges', () => {
    assert.deepEqual(parseSubnetEntry('10.1.2'), { prefix: '10.1.2', start: 1, end: 254, normalized: '10.1.2' });
    assert.deepEqual(parseSubnetEntry('192.168.1:10~50'), { prefix: '192.168.1', start: 10, end: 50, normalized: '192.168.1:10~50' });
    assert.deepEqual(parseSubnetEntry(' 10.0.0:1~254 '), { prefix: '10.0.0', start: 1, end: 254, normalized: '10.0.0:1~254' });
    assert.deepEqual(parseSubnetEntry('10.0.0', [5, 9]), { prefix: '10.0.0', start: 5, end: 9, normalized: '10.0.0' });
});

test('parseSubnetEntry rejects injection strings and bad numbers', () => {
    const bad = [
        "10.1.2'; Remove-Item C:\\ -Recurse; '",
        '10.1.2.3',
        '10.1.2;calc',
        '10.1.2 && whoami',
        '10.1.2:1~255',
        '10.1.2:0~10',
        '10.1.2:50~10',
        '300.1.2',
        '$(calc)',
        '10.1.2\n10.1.3',
        '',
        42,
        null
    ];
    for (const entry of bad) {
        assert.ok(parseSubnetEntry(entry).error, `should reject ${JSON.stringify(entry)}`);
    }
});

test('legacy range syntaxes are accepted and normalised to the canonical form', () => {
    const cases = {
        '10.1.2:1-5': '10.1.2:1~5',
        '10.0.0.1-100': '10.0.0:1~100',
        '10.0.0.1~100': '10.0.0:1~100',
        '10.0.0|1~100': '10.0.0:1~100',
        '10.0.0:1~100': '10.0.0:1~100',
        '10.0.0': '10.0.0'
    };
    for (const [input, canonical] of Object.entries(cases)) {
        const p = parseSubnetEntry(input);
        assert.equal(p.normalized, canonical, input);
        assert.equal(p.prefix, input.startsWith('10.1.2') ? '10.1.2' : '10.0.0');
    }
    assert.ok(parseSubnetEntry('10.0.0.1-300').error);
    assert.ok(parseSubnetEntry('10.0.0.50-10').error);
    assert.ok(parseSubnetEntry('10.0.300.1-10').error);
    const v = validateInventoryConfig({ subnets: ['10.0.0.1-100', '10.1.2'] });
    assert.equal(v.valid, true);
    assert.deepEqual(v.subnets, ['10.0.0:1~100', '10.1.2']);
});

test('monitoredIps are trimmed and invalid ones dropped with a warning', () => {
    const v = validateInventoryConfig({ monitoredIps: [' 10.0.0.1 ', 'bad;ip', '10.0.0.2'] });
    assert.equal(v.valid, true);
    assert.deepEqual(v.monitoredIps, ['10.0.0.1', '10.0.0.2']);
    assert.equal(v.warnings.length, 1);
});

test('validateInventoryConfig rejects the whole config with readable errors', () => {
    const res = validateInventoryConfig({ subnets: ['10.1.2', '10.1.2;calc', '999.1.1', '10.1.2:9~3'] });
    assert.equal(res.valid, false);
    assert.equal(res.errors.length, 3);
    assert.match(res.errors[0], /subnets\[1\]/);
    assert.match(res.errors[1], /0 and 255/);
    assert.match(res.errors[2], /start must not exceed/);
});

test('validateInventoryConfig enforces the 500 entry cap and passes valid configs', () => {
    const many = Array.from({ length: 501 }, (_, i) => `10.${Math.floor(i / 250)}.${i % 250}`);
    assert.equal(validateInventoryConfig({ subnets: many }).valid, false);
    assert.equal(validateInventoryConfig({ subnets: many.slice(0, 500) }).valid, true);
    assert.equal(validateInventoryConfig({ subnets: ['10.1.2:1~20'], schedule: { enabled: true, time: '08:30' }, monitoredIps: ['10.1.2.3'] }).valid, true);
    assert.equal(validateInventoryConfig({ subnets: [], schedule: { enabled: true, time: '25:00' } }).valid, false);
    assert.equal(validateInventoryConfig([]).valid, false);
    assert.equal(validateInventoryConfig({ subnets: 'x' }).valid, false);
});

test('assertIpv4 is strict', () => {
    assert.equal(assertIpv4('10.0.0.1'), '10.0.0.1');
    assert.equal(isIpv4('255.255.255.255'), true);
    for (const bad of ['10.0.0.256', '10.0.0', '10.0.0.1; calc', '10.0.0.1\n', ' 10.0.0.1', '01.2.3.4x', 'localhost', '$(calc)', '10.0.0.1"', null, undefined, 5]) {
        assert.throws(() => assertIpv4(bad), /Invalid IPv4/, `should reject ${JSON.stringify(bad)}`);
    }
});

test('escapeHtml escapes markup', () => {
    assert.equal(escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    assert.equal(escapeHtml(undefined), '');
});

test('shellQuote / psQuote neutralise quotes (verified with a POSIX parser when available)', () => {
    const { shellQuote, psQuote, isValidApiKey } = require('../../lib/inventoryValidation');
    const evil = "x'; id; '";
    assert.equal(shellQuote(evil), "'x'\\''; id; '\\'''");
    assert.equal(psQuote(evil), "'x''; id; '''");
    const { spawnSync } = require('child_process');
    const probe = spawnSync('sh', ['-c', 'echo ok']);
    if (!probe.error && probe.status === 0) {
        const out = spawnSync('sh', ['-c', `API_KEY=${shellQuote(evil)}; printf %s "$API_KEY"`]);
        assert.equal(out.stdout.toString(), evil, 'shell must see the key verbatim, with no command executed');
    }
    assert.equal(isValidApiKey('abcdef12-_.'), true);
    for (const bad of ["short", evil, 'a'.repeat(257), 'abcdefgh"', 'abcdefgh$x', 'abcdefgh\n', 5]) assert.equal(isValidApiKey(bad), false);
    assert.equal(isValidApiKey('a'.repeat(64)), true);
});
