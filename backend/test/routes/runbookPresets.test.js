require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESEEDED_RUNBOOKS } = require('../../routes/runbook');
const { PRESETS } = require('../../routes/cmdLibrary');

const commandIds = new Set(PRESETS.map(p => p.id));

test('preset runbook ids are unique and use the sop- prefix', () => {
    const ids = PRESEEDED_RUNBOOKS.map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
    for (const id of ids) assert.match(id, /^sop-[a-z0-9-]+$/, id);
});

test('every preset runbook has the required fields', () => {
    for (const r of PRESEEDED_RUNBOOKS) {
        assert.ok(r.title && typeof r.title === 'string', `${r.id}: title`);
        assert.ok(r.component && typeof r.component === 'string', `${r.id}: component`);
        assert.ok(Array.isArray(r.tags) && r.tags.length > 0, `${r.id}: tags`);
        assert.ok(typeof r.content === 'string' && r.content.startsWith('# '), `${r.id}: content must start with a "# " heading`);
        assert.ok(r.content.length >= 300, `${r.id}: content too short (${r.content.length})`);
        assert.equal(r.workflowId, null, `${r.id}: workflowId`);
        assert.equal(r.updatedBy, 'SYSTEM', `${r.id}: updatedBy`);
        assert.ok(!Number.isNaN(Date.parse(r.updatedAt)), `${r.id}: updatedAt`);
        assert.ok(Array.isArray(r.commandIds), `${r.id}: commandIds`);
    }
});

test('preset runbooks only reference existing Remote Command presets, never Shutdown', () => {
    for (const r of PRESEEDED_RUNBOOKS) {
        for (const id of r.commandIds) {
            assert.ok(commandIds.has(id), `${r.id}: unknown commandId ${id}`);
            assert.notEqual(id, 'p16', `${r.id}: must not link the Shutdown command`);
        }
    }
});

test('content has no unresolved template placeholders', () => {
    for (const r of PRESEEDED_RUNBOOKS) {
        assert.ok(!/\[object Object\]|TODO|TBD/.test(r.content), `${r.id}: leaked placeholder`);
    }
});
