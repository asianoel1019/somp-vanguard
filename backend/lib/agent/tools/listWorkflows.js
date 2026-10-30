const { getAllWorkflows } = require('../../workflow');
const { truncateText } = require('./common');

module.exports = {
    name: 'list_workflows',
    feature: 'workflow',
    description: 'List automation workflows that could be recommended to the user (up to 20), optionally filtered by keyword in name or description. Workflows are never executed by you.',
    parameters: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 100, description: 'Optional keyword' } },
    },
    async run({ query }) {
        const q = (query || '').toLowerCase();
        const list = getAllWorkflows()
            .filter(w => !q || `${w.name || ''} ${w.description || ''}`.toLowerCase().includes(q))
            .slice(0, 20)
            .map(w => ({
                id: w.id,
                name: w.name,
                description: truncateText(w.description, 200),
                nodeTypes: [...new Set((w.nodes || []).map(n => n.type).filter(t => t !== 'start' && t !== 'end'))],
            }));
        return { count: list.length, workflows: list };
    },
};
