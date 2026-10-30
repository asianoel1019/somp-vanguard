require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLogCategory, isNotificationCategoryEnabled, isOptInCategory } = require('../../lib/logger');
const { selectWebhooksForCategory } = require('../../services/webhookService');

function withEnv(t, vars) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    t.after(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

const AGENT_AUDIT = '[Audit] User: alice | Module: AI Agent | Action: Asked: why did login fail on web-03?';

test('AI Agent messages get their own AIAgent category, even when the text mentions login or [audit]', () => {
    assert.equal(resolveLogCategory('AI Agent', AGENT_AUDIT), 'AIAgent');
    assert.equal(resolveLogCategory('ai agent', 'anything'), 'AIAgent');
});

test('other categories are unchanged', () => {
    assert.equal(resolveLogCategory('Settings', '[Audit] User: a | Module: Settings | Action: x'), 'AuditLogs');
    assert.equal(resolveLogCategory('Workflow', 'done'), 'Workflow');
    assert.equal(resolveLogCategory('Auth', 'login ok'), 'AuthSecurity');
    assert.equal(resolveLogCategory('Something', 'hello'), 'GeneralLogs');
});

test('AIAgent is opt-in; existing categories are not', () => {
    assert.equal(isOptInCategory('AIAgent'), true);
    assert.equal(isOptInCategory('AuditLogs'), false);
});

test('Telegram: unset TELEGRAM_ENABLED_LOGS keeps "all enabled" except opt-in AIAgent', (t) => {
    withEnv(t, { TELEGRAM_ENABLED_LOGS: undefined, INTEGRATION_ENABLED_LOGS: undefined });
    assert.equal(isNotificationCategoryEnabled('AuditLogs'), true);
    assert.equal(isNotificationCategoryEnabled('GeneralLogs'), true);
    assert.equal(isNotificationCategoryEnabled('AIAgent'), false);
});

test('Telegram: explicit list enables AIAgent only when listed', (t) => {
    withEnv(t, { TELEGRAM_ENABLED_LOGS: 'AuditLogs,ScoutMonitor', INTEGRATION_ENABLED_LOGS: undefined });
    assert.equal(isNotificationCategoryEnabled('AIAgent'), false);
    assert.equal(isNotificationCategoryEnabled('AuditLogs'), true);
    process.env.TELEGRAM_ENABLED_LOGS = 'AuditLogs, AIAgent';
    assert.equal(isNotificationCategoryEnabled('AIAgent'), true);
});

test('Telegram: legacy INTEGRATION_ENABLED_LOGS is still honoured', (t) => {
    withEnv(t, { TELEGRAM_ENABLED_LOGS: undefined, INTEGRATION_ENABLED_LOGS: 'AIAgent' });
    assert.equal(isNotificationCategoryEnabled('AIAgent'), true);
    assert.equal(isNotificationCategoryEnabled('AuditLogs'), false);
});

test('Webhooks: per-webhook enabledLogs; no list means all except opt-in; disabled webhooks never fire', () => {
    const hooks = [
        { id: 'legacy' },                                        // no enabledLogs saved (old webhook)
        { id: 'audit-only', enabledLogs: ['AuditLogs'] },
        { id: 'agent', enabledLogs: ['AIAgent'] },
        { id: 'off', enabled: false, enabledLogs: ['AIAgent'] },
    ];
    assert.deepEqual(selectWebhooksForCategory(hooks, 'AIAgent').map(h => h.id), ['agent']);
    assert.deepEqual(selectWebhooksForCategory(hooks, 'AuditLogs').map(h => h.id), ['legacy', 'audit-only']);
});
