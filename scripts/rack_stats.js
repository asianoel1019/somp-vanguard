#!/usr/bin/env node
/**
 * Read-only Server Rack size statistics (for sizing the rack layout performance work).
 * Usage (on the server):  scripts\Rack_Stats.bat            (or: node scripts\rack_stats.js [dataDir])
 * Opens the database READ-ONLY and prints counts only: no data center, rack or device names, no IPs,
 * so the output can be shared. Data centers are shown as DC1, DC2, ... (largest first).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const RAIL_NODES_PER_U = 4;   // rail-u + 2 holes + U number
const SLOT_NODES_PER_U = 1;   // u-slot
const RACK_FRAME_NODES = 30;  // header, title, badges, buttons, face wrappers
const DEVICE_NODES = 14;      // block, inner, info, name, ip, icon wrapper, hidden tooltip (header + rows)

function resolveDataDir() {
    if (process.argv[2]) return process.argv[2];
    if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
    return fs.existsSync('D:\\somp-vanguard') ? 'D:\\somp-vanguard' : 'C:\\ProgramData\\somp-vanguard';
}

/** Rack documents of every data center from the first database that has them. */
function loadDocuments(dir) {
    for (const name of ['scout.sqlite', 'database.sqlite']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        let db;
        try {
            db = new DatabaseSync(file, { readOnly: true });
        } catch (e) {
            console.error(`無法以唯讀方式開啟 ${file}：${e.message}`);
            continue;
        }
        try {
            const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_store'").get();
            if (!hasTable) continue;
            const rows = db.prepare("SELECT key, value FROM document_store WHERE key = 'data_center/datacenters.json' OR key LIKE 'data_center/server_rack%'").all();
            if (rows.some(r => r.key.startsWith('data_center/server_rack'))) return { file, rows };
        } finally {
            db.close();
        }
    }
    return null;
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

function rackStats(racks) {
    const front = racks.filter(r => !r.isBack);
    const back = racks.filter(r => r.isBack);
    const devices = racks.flatMap(r => (Array.isArray(r.devices) ? r.devices : []));
    const byType = {};
    let ports = 0, linkedPorts = 0, livePortDevices = 0, outlets = 0, usedU = 0, totalU = 0, split = 0;
    for (const r of front) {
        totalU += Number(r.height) || 42;
        if (r.isSplitDesign) split += 1;
    }
    for (const d of devices) {
        byType[d.type || '(none)'] = (byType[d.type || '(none)'] || 0) + 1;
        usedU += Number(d.sizeU) || 0;
        const p = Math.min(Number(d.ports) || 0, 24);
        ports += p;
        linkedPorts += d.portLinks ? Object.values(d.portLinks).filter(Boolean).length : 0;
        if (d.livePorts) livePortDevices += 1;
        if (d.type === 'PowerBar') outlets += (Number(d.ways) || 0) * (d.side === 'both' ? 2 : 1);
    }
    const rows = new Map();
    for (const r of front) rows.set(r.rowNumber || 1, (rows.get(r.rowNumber || 1) || 0) + 1);
    const perRack = front.map(r => {
        const partner = racks.find(x => x.id === r.partnerId);
        return (r.devices || []).length + (partner ? (partner.devices || []).length : 0);
    });

    // Estimated DOM elements of the layout today: both faces of every front rack are rendered (back face from the
    // partner rack, or an empty one), each U as rail + slot elements, plus devices, ports (+LEDs) and outlets.
    const uNodes = front.reduce((s, r) => s + 2 * (Number(r.height) || 42) * (RAIL_NODES_PER_U + SLOT_NODES_PER_U), 0);
    const domNow = front.length * RACK_FRAME_NODES + uNodes + devices.length * DEVICE_NODES + ports + linkedPorts + outlets * 2;
    // After stage 1: one face, U drawn by CSS (about 10 elements per rack face), shared tooltip
    const domAfter = front.length * (RACK_FRAME_NODES + 10) + devices.length * 8 + ports + linkedPorts + outlets * 2;
    return {
        frontRacks: front.length, backRacks: back.length, rows: rows.size, maxRacksInRow: Math.max(0, ...rows.values()),
        splitRacks: split, totalU, usedU, devices: devices.length, maxDevicesPerRack: Math.max(0, ...perRack),
        ports, linkedPorts, livePortDevices, outlets, byType, domNow, domAfter,
        heights: [...new Set(racks.map(r => Number(r.height) || 42))].sort((a, b) => a - b),
    };
}

const dir = resolveDataDir();
const loaded = loadDocuments(dir);
if (!loaded) {
    console.error(`在 ${dir} 找不到機櫃資料（scout.sqlite / database.sqlite 的 document_store）。可指定路徑：node scripts\\rack_stats.js <資料夾>`);
    process.exit(1);
}

const dcs = parse((loaded.rows.find(r => r.key === 'data_center/datacenters.json') || {}).value, []);
const rackDocs = loaded.rows.filter(r => r.key.startsWith('data_center/server_rack'));
const results = rackDocs.map(r => {
    const racks = parse(r.value, []);
    return rackStats(Array.isArray(racks) ? racks.filter(x => x && typeof x === 'object') : []);
}).filter(s => s.frontRacks > 0).sort((a, b) => b.domNow - a.domNow);

console.log(`SOMP Server Rack 規模統計（唯讀，只有數量）  ${new Date().toLocaleString()}`);
console.log(`資料庫：${path.basename(loaded.file)}　機房數：${Array.isArray(dcs) ? dcs.length : '?'}　有機櫃的機房：${results.length}`);
console.log('');
results.forEach((s, i) => {
    console.log(`=== DC${i + 1} ===`);
    console.log(`  機櫃：正面 ${s.frontRacks} 座（背面紀錄 ${s.backRacks}），${s.rows} 排，單排最多 ${s.maxRacksInRow} 座，分段式 ${s.splitRacks} 座，高度 ${s.heights.join('/')}U`);
    console.log(`  U 數：正面共 ${s.totalU}U，設備佔用 ${s.usedU}U（含背面設備，${pct(s.usedU, s.totalU)}）`);
    console.log(`  設備：${s.devices} 台，單座機櫃最多 ${s.maxDevicesPerRack} 台（含背面）`);
    console.log(`  連接埠（畫面上最多 24 格/台）：${s.ports} 格，已接線 ${s.linkedPorts}，有 SNMP 即時狀態的設備 ${s.livePortDevices} 台；電源插座 ${s.outlets} 個`);
    console.log(`  類型：${Object.entries(s.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join('、')}`);
    console.log(`  估計畫面元素數（DOM）：目前約 ${s.domNow.toLocaleString()}，第一階段後約 ${s.domAfter.toLocaleString()}`);
    console.log('');
});
const total = results.reduce((a, s) => ({ racks: a.racks + s.frontRacks, devices: a.devices + s.devices, dom: a.dom + s.domNow }), { racks: 0, devices: 0, dom: 0 });
console.log(`合計：機櫃 ${total.racks} 座，設備 ${total.devices} 台。DOM 估計值僅供比較（一次只顯示一個機房）。`);
