const { getAllRunbooks, truncateText } = require('./common');
const { ToolInputError } = require('../errors');

module.exports = {
    name: 'get_runbook',
    feature: 'runbook',
    description: 'Read one runbook in full (content truncated at 6000 characters).',
    parameters: {
        type: 'object',
        properties: { id: { type: 'string', maxLength: 100, description: 'Runbook id from search_runbooks' } },
        required: ['id'],
    },
    async run({ id }) {
        const rb = getAllRunbooks().find(r => r.id === id);
        if (!rb) throw new ToolInputError(`Runbook "${id}" not found. Use search_runbooks to find valid ids.`);
        return { id: rb.id, title: rb.title, component: rb.component, tags: rb.tags || [], workflowId: rb.workflowId || null, content: truncateText(rb.content, 6000) };
    },
};
