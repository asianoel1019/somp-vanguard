// Minimal Markdown parser producing a safe node tree (rendered by MarkdownView.jsx without innerHTML).
// Images are dropped and only internal links (starting with a single "/") are kept as links.

export function isSafeHref(href) {
    return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !/[\s\\]/.test(href);
}

const INLINE_RE = /(`[^`]+`)|(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]*\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/;

export function parseInline(text) {
    const nodes = [];
    let rest = String(text ?? '');
    const pushText = (value) => {
        if (!value) return;
        const last = nodes[nodes.length - 1];
        if (last && last.type === 'text') last.value += value;
        else nodes.push({ type: 'text', value });
    };
    while (rest) {
        const m = INLINE_RE.exec(rest);
        if (!m) { pushText(rest); break; }
        pushText(rest.slice(0, m.index));
        const token = m[0];
        if (m[1]) {
            nodes.push({ type: 'code', value: token.slice(1, -1) });
        } else if (m[2]) {
            const alt = token.slice(2, token.indexOf(']'));
            pushText(alt);
        } else if (m[3]) {
            const label = token.slice(1, token.indexOf(']'));
            const href = token.slice(token.indexOf('](') + 2, -1).trim();
            if (isSafeHref(href)) nodes.push({ type: 'link', href, children: parseInline(label) });
            else pushText(label);
        } else if (m[4]) {
            nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
        } else {
            nodes.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
        }
        rest = rest.slice(m.index + token.length);
    }
    return nodes;
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => parseInline(c.trim()));
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_RE = /^\s*([-*]|\d+\.)\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function parseMarkdown(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        if (line.trim().startsWith('```')) {
            const lang = line.trim().slice(3).trim();
            const body = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
            i++;
            blocks.push({ type: 'code', lang, value: body.join('\n') });
            continue;
        }

        const h = HEADING_RE.exec(line);
        if (h) {
            blocks.push({ type: 'heading', level: h[1].length, children: parseInline(h[2]) });
            i++;
            continue;
        }

        if (line.trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim())) {
            const header = splitRow(line);
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
            blocks.push({ type: 'table', header, rows });
            continue;
        }

        const li = LIST_RE.exec(line);
        if (li) {
            const ordered = /\d+\./.test(li[1]);
            const items = [];
            while (i < lines.length) {
                const m = LIST_RE.exec(lines[i]);
                if (!m || /\d+\./.test(m[1]) !== ordered) break;
                items.push(parseInline(m[2]));
                i++;
            }
            blocks.push({ type: 'list', ordered, items });
            continue;
        }

        const para = [];
        while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !LIST_RE.test(lines[i])
            && !lines[i].trim().startsWith('```') && !lines[i].trim().startsWith('|')) {
            para.push(lines[i++]);
        }
        if (!para.length) para.push(lines[i++]);
        blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
    }
    return blocks;
}
