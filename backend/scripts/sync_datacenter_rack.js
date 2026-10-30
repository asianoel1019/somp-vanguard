/**
 * Data Centers & Server Rack Export/Import Utility Script
 * 
 * Usage:
 *   Export:  node backend/scripts/sync_datacenter_rack.js export [outputPath]
 *   Import:  node backend/scripts/sync_datacenter_rack.js import <inputPath>
 */

const fs = require('fs');
const path = require('path');
const { readDataSync, writeDataSync, db } = require('../lib/db');
const rackStore = require('../lib/rackStore');

function formatJson(data) {
    return JSON.stringify(data, null, 2);
}

function getExportKeys() {
    const keysSet = new Set([
        'data_center/datacenters.json',
        'data_center/server_rack.json',
        'data_center/hw_issues.json',
        'data_center/spare_parts.json',
        'data_center/contracts.json'
    ]);

    // 1. Attempt to query SQLite DB for any data_center/ keys
    if (db) {
        try {
            const rows = db.prepare("SELECT key FROM document_store WHERE key LIKE 'data_center/%'").all();
            if (Array.isArray(rows)) {
                // LIKE treats '_' as a wildcard (it also matches legacy 'data/center/...' alias rows): exact prefix only
                rows.forEach(r => { if (r && r.key && r.key.startsWith('data_center/')) keysSet.add(r.key); });
            }
        } catch (e) {
            console.warn(`[Export] Notice querying SQLite directly: ${e.message}. Using fallback discovery.`);
        }
    }

    // 2. Discover dynamically from datacenters list
    try {
        const dcs = readDataSync('data_center/datacenters.json', []);
        if (Array.isArray(dcs)) {
            dcs.forEach(dc => {
                if (dc && dc.id) {
                    keysSet.add(`data_center/server_rack_${dc.id}.json`);
                }
            });
        }
    } catch (e) {
        console.warn(`[Export] Error scanning datacenters list: ${e.message}`);
    }

    // 3. Scan flat files fallback directories (DB_DATA_DIR & backend/data)
    const scanDirs = [
        process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard',
        path.join(__dirname, '..', 'data')
    ];

    scanDirs.forEach(dir => {
        if (fs.existsSync(dir)) {
            try {
                const files = fs.readdirSync(dir);
                files.forEach(f => {
                    if (f.startsWith('data_center_')) {
                        const originalKey = f.replace(/^data_center_/, 'data_center/');
                        keysSet.add(originalKey);
                    }
                });
            } catch (e) {}
        }
    });

    return Array.from(keysSet);
}

function exportData(outputPath) {
    console.log('📦 Starting Data Center & Server Rack export...');
    
    const targetKeys = getExportKeys();
    const exportedData = {};

    let dcCount = 0;
    let rackFileCount = 0;
    let totalRacks = 0;
    let totalDevices = 0;
    let validKeysCount = 0;

    targetKeys.forEach(key => {
        const val = readDataSync(key, null);
        if (val !== null && val !== undefined) {
            exportedData[key] = val;
            validKeysCount++;

            if (key === 'data_center/datacenters.json' && Array.isArray(val)) {
                dcCount = val.length;
            } else if (key.startsWith('data_center/server_rack')) {
                rackFileCount++;
                if (Array.isArray(val)) {
                    totalRacks += val.length;
                    val.forEach(r => {
                        if (Array.isArray(r.devices)) {
                            totalDevices += r.devices.length;
                        }
                    });
                }
            }
        }
    });

    const payload = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        recordCount: validKeysCount,
        data: exportedData
    };

    const defaultPath = path.join(process.cwd(), `datacenter_racks_export_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 10)}.json`);
    const finalPath = outputPath ? path.resolve(outputPath) : defaultPath;

    fs.writeFileSync(finalPath, formatJson(payload), 'utf8');

    console.log('\n========================================');
    console.log('✅ EXPORT SUCCESSFUL');
    console.log('========================================');
    console.log(`📁 Saved to:      ${finalPath}`);
    console.log(`🏢 Data Centers:  ${dcCount}`);
    console.log(`🗄️ Rack Files:    ${rackFileCount} (${totalRacks} racks, ${totalDevices} devices)`);
    console.log(`🔑 Total Keys:    ${validKeysCount}`);
    console.log('========================================\n');
}

function importData(inputPath) {
    if (!inputPath) {
        console.error('❌ Error: Please specify the input JSON file path to import.');
        console.log('Usage: node backend/scripts/sync_datacenter_rack.js import <filePath>');
        process.exit(1);
    }

    const resolvedPath = path.resolve(inputPath);
    if (!fs.existsSync(resolvedPath)) {
        console.error(`❌ Error: Input file not found at ${resolvedPath}`);
        process.exit(1);
    }

    console.log(`📥 Reading export file from ${resolvedPath}...`);
    let payload;
    try {
        const raw = fs.readFileSync(resolvedPath, 'utf8');
        payload = JSON.parse(raw);
    } catch (e) {
        console.error('❌ Error: Invalid JSON file:', e.message);
        process.exit(1);
    }

    if (!payload.data || typeof payload.data !== 'object') {
        console.error('❌ Error: Invalid export file format (missing data object).');
        process.exit(1);
    }

    const keys = Object.keys(payload.data);
    console.log(`🔄 Importing ${keys.length} keys into system storage...`);

    let importedCount = 0;
    let dcCount = 0;
    let totalRacks = 0;
    let totalDevices = 0;

    keys.forEach(rawKey => {
        let key = rawKey;
        // Auto-fix/normalize any malformed keys from older export files
        if (key.startsWith('data/center/')) {
            key = key.replace(/^data\/center\//, 'data_center/');
            if (key === 'data_center/hw/issues.json') key = 'data_center/hw_issues.json';
            if (key === 'data_center/spare/parts.json') key = 'data_center/spare_parts.json';
        }

        if (!key.startsWith('data_center/')) {
            console.warn(`⚠️ Skipping non-datacenter key: ${rawKey}`);
            return;
        }

        // Revisions are per installation: importing racks bumps them instead of restoring old numbers
        if (key === rackStore.REVISIONS_KEY) return;

        const val = payload.data[rawKey];
        if (rackStore.dcIdFromKey(key) !== null) rackStore.saveRacksByKey(key, val);
        else writeDataSync(key, val);
        importedCount++;

        if (key === 'data_center/datacenters.json' && Array.isArray(val)) {
            dcCount = val.length;
        } else if (key.startsWith('data_center/server_rack')) {
            if (Array.isArray(val)) {
                totalRacks += val.length;
                val.forEach(r => {
                    if (Array.isArray(r.devices)) {
                        totalDevices += r.devices.length;
                    }
                });
            }
        }
    });

    console.log('\n========================================');
    console.log('✅ IMPORT SUCCESSFUL');
    console.log('========================================');
    console.log(`🏢 Data Centers Imported: ${dcCount}`);
    console.log(`🗄️ Racks Imported:       ${totalRacks} racks (${totalDevices} devices)`);
    console.log(`🔑 Total Keys Imported:   ${importedCount}`);
    console.log('========================================\n');
}

// CLI Command Dispatch
const command = process.argv[2];
const targetPath = process.argv[3];

if (command === 'export') {
    exportData(targetPath);
} else if (command === 'import') {
    importData(targetPath);
} else {
    console.log(`
================================================
 Data Center & Server Rack Export/Import Utility
================================================

Usage:
  node backend/scripts/sync_datacenter_rack.js export [outputPath]
  node backend/scripts/sync_datacenter_rack.js import <inputPath>

Examples:
  # 1. Export Data Center & Rack data on local machine:
  node backend/scripts/sync_datacenter_rack.js export datacenter_backup.json

  # 2. Import on Remote Server:
  node backend/scripts/sync_datacenter_rack.js import datacenter_backup.json
`);
}
