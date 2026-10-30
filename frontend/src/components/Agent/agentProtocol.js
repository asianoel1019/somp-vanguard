// Pure helpers shared by the AI Agent UI (no React, no browser APIs) — unit tested with node --test.

export function parseSseBuffer(buffer) {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    const rest = parts.pop();
    const events = [];
    for (const block of parts) {
        if (!block.trim()) continue;
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // Blocks without a data line (e.g. ": ping" heartbeat comments) are not events.
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        let data = raw;
        try { data = JSON.parse(raw); } catch { /* keep raw text */ }
        events.push({ event, data });
    }
    return { events, rest };
}

export function buildAlertPrompt(alert, hostName) {
    const when = alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleString('zh-TW', { hour12: false }) : '未知';
    const target = alert.target ? ` / ${alert.target}` : '';
    return `調查這筆告警：主機 ${hostName}，類型 ${alert.type}${target}，觸發值 ${alert.value}，門檻 ${alert.threshold}，觸發時間 ${when}。請找出可能原因並建議處置方式。`;
}
