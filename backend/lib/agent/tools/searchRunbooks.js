const { getAllRunbooks, truncateText } = require('./common');

function snippet(content, terms) {
    const text = String(content || '');
    const lower = text.toLowerCase();
    const hit = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    const start = hit === undefined ? 0 : Math.max(0, hit - 60);
    return truncateText(text.slice(start).replace(/\s+/g, ' '), 200);
}

module.exports = {
    name: 'search_runbooks',
    feature: 'runbook',
    description: 'Search the SOP runbook library by keywords (title, component, tags, content). Returns up to 10 matches with an excerpt. Use get_runbook to read one in full.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', maxLength: 100, description: 'Keywords separated by spaces, e.g. "IIS cpu" or "磁碟 清理"' },
            component: { type: 'string', maxLength: 50, description: 'Optional exact component filter' },
        },
        required: ['query'],
    },
    async run({ query, component }) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const scored = getAllRunbooks()
            .filter(rb => !component || String(rb.component || '').toLowerCase() === component.toLowerCase())
            .map(rb => {
                const title = String(rb.title || '').toLowerCase();
                const comp = String(rb.component || '').toLowerCase();
                const tags = (rb.tags || []).join(' ').toLowerCase();
                const content = String(rb.content || '').toLowerCase();
                const score = terms.reduce((s, t) => s
                    + (title.includes(t) ? 3 : 0) + (comp.includes(t) ? 2 : 0) + (tags.includes(t) ? 2 : 0) + (content.includes(t) ? 1 : 0), 0);
                return { rb, score };
            })
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
        return {
            count: scored.length,
            results: scored.map(({ rb }) => ({ id: rb.id, title: rb.title, component: rb.component, tags: rb.tags || [], snippet: snippet(rb.content, terms) })),
        };
    },
};
