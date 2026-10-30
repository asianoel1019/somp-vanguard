#!/usr/bin/env node
/**
 * Read-only alert preview for production: which metric rules would fire right now?
 * Usage (on the server):  scripts\Alert_Preview.bat            (or: node scripts\alert_preview.js [dataDir])
 * Opens scout.sqlite READ-ONLY; writes nothing, sends nothing.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { previewAlerts } = require('../backend/services/alertPreview');

function resolveDataDir() {
    if (process.argv[2]) return process.argv[2];
    if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
    return fs.existsSync('D:\\somp-vanguard\\scout.sqlite') ? 'D:\\somp-vanguard' : 'C:\\ProgramData\\somp-vanguard';
}

const file = path.join(resolveDataDir(), 'scout.sqlite');
if (!fs.existsSync(file)) { console.error(`scout.sqlite not found: ${file}`); process.exit(1); }
let db;
try {
    db = new DatabaseSync(file, { readOnly: true });
} catch (e) {
    console.error(`無法以唯讀方式開啟資料庫：${e.message}`);
    process.exit(1);
}
try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_windows'").get();
    const all = (sql, p = []) => {
        if (!hasTable && sql.includes('maintenance_windows')) return [];   // before the first deploy of this feature
        return db.prepare(sql).all(...p);
    };
    const get = (sql, p = []) => db.prepare(sql).get(...p);
    const r = previewAlerts({ all, get });
    console.log(`SOMP 告警預估（唯讀）  ${new Date(r.generatedAt).toLocaleString()}`);
    console.log(`資料庫：${file}`);
    console.log(`檢查主機 ${r.monitorsChecked} 台（${r.monitorsWithoutMetrics} 台無指標資料，${r.monitorsStale} 台指標超過 10 分鐘未更新），規則 ${r.rulesChecked} 條`);
    console.log(`預計觸發：${r.firing.length} 則（其中維護中 ${r.firing.filter(f => f.inMaintenance).length} 則不會通知）\n`);
    for (const f of r.firing) {
        console.log(`${f.inMaintenance ? '🔧' : '🔴'} ${f.host} (${f.ip})  ${f.ruleName}  ${f.type}${f.target ? ` ${f.target}` : ''}  值=${f.value}  門檻=${f.threshold}`);
    }
    console.log(`\n${r.note}`);
} finally {
    db.close();
}
