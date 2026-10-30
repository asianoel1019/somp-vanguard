const { getWorkflow } = require('../../workflow');
const { hasFeature } = require('../../permissions');
const { getAllRunbooks } = require('./common');

const idList = { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 100 } };

module.exports = {
    name: 'suggest_actions',
    feature: null,
    description: 'Attach recommended runbooks and/or workflows to your final answer as clickable cards. Use only ids returned by search_runbooks or list_workflows. This does NOT execute anything; the user reviews and runs them.',
    parameters: {
        type: 'object',
        properties: {
            runbookIds: idList,
            workflowIds: idList,
            reason: { type: 'string', maxLength: 500, description: 'Why these are recommended' },
        },
    },
    async run({ runbookIds = [], workflowIds = [] }, { user }) {
        const accepted = [];
        const rejected = [];

        const runbooks = getAllRunbooks();
        for (const id of runbookIds) {
            const rb = runbooks.find(r => r.id === id);
            if (rb) accepted.push({ type: 'runbook', id, title: rb.title });
            else rejected.push({ type: 'runbook', id, reason: 'not found' });
        }

        const canWorkflow = hasFeature(user, 'workflow');
        for (const id of workflowIds) {
            if (!canWorkflow) { rejected.push({ type: 'workflow', id, reason: 'no workflow permission' }); continue; }
            const w = getWorkflow(id);
            if (w) accepted.push({ type: 'workflow', id, title: w.name });
            else rejected.push({ type: 'workflow', id, reason: 'not found' });
        }

        return { accepted: accepted.length, rejected, suggestions: accepted };
    },
};
