'use strict';
const fs   = require('fs');
const path = require('path');

function resolveDevicePaths(devices, backupRoot) {
  const resolved = [];

  for (const device of devices) {
    const site = device.name.split('-')[0];

    // Collect site folders, exclude UCS
    let folders;
    try {
      folders = fs.readdirSync(backupRoot)
        .filter(f => new RegExp(`^${site}_\\d{8}$`).test(f) && !f.includes('UCS'))
        .sort()
        .reverse(); // newest date first
    } catch (err) {
      console.warn(`[discovery] Cannot read backupRoot ${backupRoot}: ${err.message}`);
      continue;
    }

    if (folders.length === 0) {
      console.warn(`[discovery] No folders found for site ${site} — skipping ${device.name}`);
      continue;
    }

    let found = false;
    for (const folder of folders) {
      const folderPath = path.join(backupRoot, folder);
      let files;
      try {
        files = fs.readdirSync(folderPath);
      } catch (err) {
        console.warn(`[discovery] Cannot read ${folderPath}: ${err.message}`);
        continue;
      }

      // Match device files, exclude UCS
      const candidates = files.filter(f =>
        f.startsWith(device.name + '_') &&
        f.endsWith('.txt') &&
        !f.includes('UCS')
      );

      if (candidates.length === 0) continue;

      // Parse HHMM timestamp from filename: DEVICE_YYYYMMDD-HHMM.txt
      const scored = candidates.map(f => {
        const m = f.match(/_\d{8}-(\d{4})\.txt$/);
        return { f, ts: m ? parseInt(m[1], 10) : -1 };
      });

      // Highest timestamp wins; ties broken by lexicographic order (last wins)
      scored.sort((a, b) => b.ts !== a.ts ? b.ts - a.ts : (b.f > a.f ? 1 : -1));

      const winner = scored[0];
      const absPath = path.join(backupRoot, folder, winner.f);
      resolved.push({ path: absPath, type: device.type });
      console.log(`[discovery] ${device.name} → ${folder}/${winner.f}`);
      found = true;
      break;
    }

    if (!found) {
      console.warn(`[discovery] No backup found for ${device.name} in any ${site}_* folder — skipping`);
    }
  }

  return resolved;
}

module.exports = { resolveDevicePaths };
