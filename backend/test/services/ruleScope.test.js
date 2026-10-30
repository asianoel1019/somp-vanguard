require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const scope = require('../../services/ruleScope');

const bindings = [
    { ruleId: 'r-env', scopeType: 'env', scopeValue: 'prod' },
    { ruleId: 'r-mon', scopeType: 'monitor', scopeValue: 'm1' },
    { ruleId: 'r-tag', scopeType: 'tag', scopeValue: 'web' },
    { ruleId: 'r-all', scopeType: 'all', scopeValue: '' },
    { ruleId: 'r-other', scopeType: 'env', scopeValue: 'prod' },
];
const m1 = { id: 'm1', apiKey: 'k1', tags: '["web","db"]', envId: 'prod' };
const m2 = { id: 'm2', apiKey: 'k2', tags: ['web'], envId: 'prod' };
const ctxOf = (exclusions) => scope.buildRuleScope(bindings, exclusions);

test('no exclusions: same result as the inclusion index', () => {
    const ctx = ctxOf([]);
    assert.deepEqual(scope.applicableRuleIds(m1, ctx.index, ctx.exclusions).sort(), ['r-env', 'r-mon', 'r-other', 'r-tag']);
    assert.deepEqual(scope.applicableRuleIds(m1, ctx.index, ctx.exclusions, { includeGlobal: true }).sort(), ['r-all', 'r-env', 'r-mon', 'r-other', 'r-tag']);
});

test('env binding + monitor exclusion: not applicable to that monitor only; other rules unaffected', () => {
    const ctx = ctxOf([{ ruleId: 'r-env', scopeType: 'monitor', scopeValue: 'm1' }]);
    assert.equal(scope.isRuleApplicable('r-env', m1, ctx.index, ctx.exclusions), false);
    assert.equal(scope.isRuleApplicable('r-other', m1, ctx.index, ctx.exclusions), true, 'other rules unaffected');
    assert.equal(scope.isRuleApplicable('r-env', m2, ctx.index, ctx.exclusions), true, 'other monitors unaffected');
    assert.ok(!scope.applicableRuleIds(m1, ctx.index, ctx.exclusions).includes('r-env'));
    assert.ok(scope.applicableRuleIds(m2, ctx.index, ctx.exclusions).includes('r-env'));
});

test('tag exclusion: any of the monitor tags excludes it', () => {
    const ctx = ctxOf([{ ruleId: 'r-env', scopeType: 'tag', scopeValue: 'db' }]);
    assert.equal(scope.isRuleApplicable('r-env', m1, ctx.index, ctx.exclusions), false);
    assert.equal(scope.isRuleApplicable('r-env', m2, ctx.index, ctx.exclusions), true);
});

test('exclusion wins over an explicit monitor binding', () => {
    const ctx = ctxOf([{ ruleId: 'r-mon', scopeType: 'monitor', scopeValue: 'm1' }]);
    assert.equal(scope.isRuleApplicable('r-mon', m1, ctx.index, ctx.exclusions), false);
    assert.ok(!scope.applicableRuleIds(m1, ctx.index, ctx.exclusions).includes('r-mon'));
});

test('exclusion also beats a global binding', () => {
    const ctx = ctxOf([{ ruleId: 'r-all', scopeType: 'monitor', scopeValue: 'm1' }]);
    assert.ok(!scope.applicableRuleIds(m1, ctx.index, ctx.exclusions, { includeGlobal: true }).includes('r-all'));
    assert.ok(scope.applicableRuleIds(m2, ctx.index, ctx.exclusions, { includeGlobal: true }).includes('r-all'));
});

test('unbound rules (log semantics: no binding = everywhere) still honour exclusions; exclusions are not bindings', () => {
    const ctx = ctxOf([{ ruleId: 'r-unbound', scopeType: 'monitor', scopeValue: 'm1' }]);
    assert.equal(ctx.boundRuleIds.has('r-unbound'), false, 'an exclusion must not make a rule "bound"');
    const opts = { includeGlobal: true, unboundApplies: true, boundRuleIds: ctx.boundRuleIds };
    assert.equal(scope.isRuleApplicable('r-unbound', m1, ctx.index, ctx.exclusions, opts), false);
    assert.equal(scope.isRuleApplicable('r-unbound', m2, ctx.index, ctx.exclusions, opts), true);
    assert.equal(scope.isRuleApplicable('r-unbound', m2, ctx.index, ctx.exclusions), false, 'without unboundApplies an unbound rule does not apply');
});

test('unknown exclusion scope types are ignored; string/number ids compare equal', () => {
    const ctx = ctxOf([{ ruleId: 'r-env', scopeType: 'env', scopeValue: 'prod' }, { ruleId: 'r-tag', scopeType: 'monitor', scopeValue: 7 }]);
    assert.equal(scope.isRuleApplicable('r-env', m1, ctx.index, ctx.exclusions), true);
    const m7 = { id: '7', tags: '["web"]' };
    assert.equal(scope.isRuleApplicable('r-tag', m7, ctx.index, ctx.exclusions), false);
});

test('excludedRuleIds lists every rule excluded for a monitor; bad tags JSON is tolerated', () => {
    const ex = scope.buildExclusionIndex([
        { ruleId: 'a', scopeType: 'monitor', scopeValue: 'm1' },
        { ruleId: 'b', scopeType: 'tag', scopeValue: 'web' },
        { ruleId: 'c', scopeType: 'tag', scopeValue: 'none' },
    ]);
    assert.deepEqual([...scope.excludedRuleIds(ex, m1)].sort(), ['a', 'b']);
    assert.deepEqual([...scope.excludedRuleIds(ex, { id: 'x', tags: 'not json' })], []);
    assert.deepEqual([...scope.excludedRuleIds(undefined, m1)], [], 'a missing exclusion index means no exclusions');
});

test('ruleScope.js is pure (no db / logger)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../services/ruleScope.js'), 'utf8');
    assert.doesNotMatch(src, /require\(['"][^'"]*(scoutDb|\/db|logger)['"]\)/);
});

test('every evaluation site goes through ruleScope (no direct inclusion-only matching left)', () => {
    const dir = path.join(__dirname, '../../services');
    const sites = ['scoutAlertEngine.js', 'telemetryIngestionService.js', 'alertPreview.js'];
    for (const f of sites) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.match(src, /require\(['"]\.\/ruleScope['"]\)/, `${f} uses ruleScope`);
        assert.doesNotMatch(src, /scopeType === ['"](monitor|apikey|tag|env)['"]/, `${f} has no hand-written binding matching`);
        assert.doesNotMatch(src, /require\(['"]\.\/alertRuleEval['"]\)[^\n]*applicableRuleIds/, `${f} does not use the inclusion-only applicableRuleIds`);
    }
});
