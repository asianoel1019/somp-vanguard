require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeDataSync } = require('../../lib/db');
const cfg = require('../../services/alertQualityConfig');

test.beforeEach(() => { writeDataSync(cfg.CONFIG_KEY, {}); cfg.invalidateConfig(); });

test('missing settings fall back to spec defaults', () => {
    const c = cfg.getConfig();
    assert.equal(c.evaluationEnabled, true);
    assert.equal(c.rateLimitPerMinute, 10);
    assert.deepEqual(c.flapping, { transitions: 4, windowMin: 30, stableMin: 30 });
    assert.equal(c.cooldownMin, 15);
    assert.equal(c.escalation.telegram.enabled, false);
});

test('partial / garbage stored values are normalised, never thrown', () => {
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 'abc', flapping: { transitions: 999 }, evaluationEnabled: false });
    cfg.invalidateConfig();
    const c = cfg.getConfig();
    assert.equal(c.rateLimitPerMinute, 10);
    assert.equal(c.flapping.transitions, 50);
    assert.equal(c.evaluationEnabled, false);
});

test('validateConfig rejects out-of-range values with readable errors', () => {
    const r = cfg.validateConfig({ rateLimitPerMinute: 0, cooldownMin: 5000, escalation: { telegram: { enabled: true, chatId: 'not a chat' } } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('rateLimitPerMinute')));
    assert.ok(r.errors.some(e => e.includes('cooldownMin')));
    assert.ok(r.errors.some(e => e.includes('chatId')));
});

test('saveConfig persists and getConfig sees it immediately', () => {
    cfg.saveConfig({ rateLimitPerMinute: 25, escalation: { email: { enabled: true, to: 'a@b.c, d@e.f' } } });
    const c = cfg.getConfig();
    assert.equal(c.rateLimitPerMinute, 25);
    assert.equal(c.escalation.email.to, 'a@b.c, d@e.f');
    assert.equal(c.flapping.windowMin, 30);
});

test('getConfig caches for 30 seconds', () => {
    const t0 = 1_000_000;
    cfg.getConfig(t0);
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 77 });
    assert.equal(cfg.getConfig(t0 + 1000).rateLimitPerMinute, 10);
    assert.equal(cfg.getConfig(t0 + 31000).rateLimitPerMinute, 77);
});
