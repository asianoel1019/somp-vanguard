// Compact node:test reporter: one progress line, details only for failures.
// Console output from the app under test is hidden unless that test file failed.
import path from 'node:path';

const rel = (file) => (file ? path.relative(process.cwd(), file) : '');

export default async function* summaryReporter(source) {
    const counts = { pass: 0, fail: 0, todo: 0, skip: 0 };
    const failures = [];
    const todos = [];
    const outputByFile = new Map();
    const started = Date.now();

    for await (const event of source) {
        const { type, data } = event;

        if (type === 'test:stdout' || type === 'test:stderr') {
            const key = rel(data.file);
            outputByFile.set(key, (outputByFile.get(key) || '') + data.message);
            continue;
        }
        if (type !== 'test:pass' && type !== 'test:fail') continue;
        // Skip the file-level wrapper entries; count only real tests
        if (data.details?.type === 'suite') continue;

        if (data.todo !== undefined && data.todo !== false) {
            counts.todo++;
            todos.push({ name: data.name, file: rel(data.file), reason: typeof data.todo === 'string' ? data.todo : '' });
        } else if (data.skip !== undefined && data.skip !== false) {
            counts.skip++;
        } else if (type === 'test:pass') {
            counts.pass++;
            if (counts.pass % 20 === 0) yield '.';
        } else {
            counts.fail++;
            failures.push({ name: data.name, file: rel(data.file), error: data.details?.error });
        }
    }

    yield '\n';

    for (const f of failures) {
        const cause = f.error?.cause ?? f.error;
        yield `\n✖ FAIL  ${f.name}\n   at ${f.file}\n`;
        yield `   ${String(cause?.stack || cause?.message || cause).split('\n').slice(0, 8).join('\n   ')}\n`;
    }

    const failedFiles = [...new Set(failures.map(f => f.file))];
    for (const file of failedFiles) {
        const out = (outputByFile.get(file) || '').trim();
        if (out) yield `\n── console output of ${file} (last 30 lines) ──\n${out.split('\n').slice(-30).join('\n')}\n`;
    }

    if (todos.length) {
        yield `\nKnown issues (todo, not counted as failures):\n`;
        for (const t of todos) yield `  ⚠ ${t.name}${t.reason ? ` — ${t.reason}` : ''}\n`;
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const status = counts.fail ? '✖ FAILED' : '✔ ALL PASSED';
    yield `\n${status}  pass ${counts.pass} · fail ${counts.fail} · todo ${counts.todo}${counts.skip ? ` · skip ${counts.skip}` : ''}  (${secs}s)\n`;
}
