const fs = require('fs');
const path = require('path');

// Target files relative to project root
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to log with colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m'
};

function log(color, prefix, msg) {
  console.log(`${color}${prefix}${colors.reset} ${msg}`);
}

function updateFile(relPath, transformFn) {
  const fullPath = path.join(ROOT_DIR, relPath);
  if (!fs.existsSync(fullPath)) {
    log(colors.yellow, '[SKIP]', `${relPath} 不存在`);
    return false;
  }
  const oldContent = fs.readFileSync(fullPath, 'utf8');
  const newContent = transformFn(oldContent);
  if (oldContent !== newContent) {
    fs.writeFileSync(fullPath, newContent, 'utf8');
    log(colors.green, '[UPDATE]', `${relPath}`);
    return true;
  } else {
    log(colors.cyan, '[UNCHANGED]', `${relPath}`);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  let rawVersion = args[0];
  let customDate = args[1]; // optional YYYY-MM-DD or MM/DD

  if (!rawVersion) {
    console.error(`${colors.red}請提供版本號！用法: node scripts/update_version.js <版本號> [日期]${colors.reset}`);
    console.error(`範例: node scripts/update_version.js 1.8.0`);
    console.error(`範例: node scripts/update_version.js v1.8.0 2026-09-21`);
    process.exit(1);
  }

  // Normalize versions
  const semver = rawVersion.replace(/^v/i, '').trim(); // e.g. "1.8.0"
  const vSemver = `v${semver}`;                       // e.g. "v1.8.0"
  const majorMinor = semver.split('.').slice(0, 2).join('.'); // e.g. "1.8"

  // Date parsing
  const now = customDate ? new Date(customDate) : new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear();
  const dateShort = `${month}/${day}`; // e.g. "9/21"
  const buildDate = `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`; // e.g. "2026.09.21"

  console.log(`\n${colors.bold}=== SOMP Vanguard 版本自動同步引擎 ===${colors.reset}`);
  console.log(`目標版本號: ${colors.cyan}${vSemver}${colors.reset} (Semver: ${semver}, 主版本: ${majorMinor})`);
  console.log(`發布更新日期: ${colors.cyan}${dateShort}${colors.reset} (Build: ${buildDate})\n`);

  let updatedCount = 0;

  // 1. backend/package.json
  updateFile('backend/package.json', content => {
    return content.replace(/"version":\s*"[^"]+"/, `"version": "${semver}"`);
  }) && updatedCount++;

  // 2. backend/package-lock.json
  updateFile('backend/package-lock.json', content => {
    try {
      const json = JSON.parse(content);
      json.version = semver;
      if (json.packages && json.packages['']) {
        json.packages[''].version = semver;
      }
      return JSON.stringify(json, null, 2) + '\n';
    } catch (e) {
      return content.replace(/"version":\s*"[^"]+"/, `"version": "${semver}"`);
    }
  }) && updatedCount++;

  // 3. frontend/package.json
  updateFile('frontend/package.json', content => {
    return content.replace(/"version":\s*"[^"]+"/, `"version": "${semver}"`);
  }) && updatedCount++;

  // 4. frontend/package-lock.json
  updateFile('frontend/package-lock.json', content => {
    try {
      const json = JSON.parse(content);
      json.version = semver;
      if (json.packages && json.packages['']) {
        json.packages[''].version = semver;
      }
      return JSON.stringify(json, null, 2) + '\n';
    } catch (e) {
      return content.replace(/"version":\s*"[^"]+"/, `"version": "${semver}"`);
    }
  }) && updatedCount++;

  // 5–7. backend/.env VERSION, health.js and openScoutApi.js no longer carry the version:
  //      the backend reads it from backend/package.json (lib/version.js), updated in step 1.

  // 8. frontend/README.md
  updateFile('frontend/README.md', content => {
    return content.replace(
      /(\*\*v)[0-9.]+(\*\*\s*\(Build\s*)[0-9.]+(\))/,
      `$1${semver}$2${buildDate}$3`
    );
  }) && updatedCount++;

  // 9. docs/index.html
  updateFile('docs/index.html', content => transformDocsIndex(content, { semver, vSemver, majorMinor, dateShort })) && updatedCount++;

  // 10. docs/api_documentation.html
  updateFile('docs/api_documentation.html', content => {
    let res = content;
    // Sidebar REST API Reference subtitle
    res = res.replace(
      /(<div class="sidebar-subtitle">REST API Reference \()v[0-9.]+(\)[^<]*<\/div>)/,
      `$1${vSemver}$2`
    );
    // Open scout status example
    res = res.replace(
      /("status":\s*"healthy",\s*"version":\s*")v[0-9.]+(")/,
      `$1${vSemver}$2`
    );
    // Health status example
    res = res.replace(
      /("status":\s*"ok",\s*"uptime":\s*\d+,\s*"version":\s*")v?[0-9.]+(")/,
      `$1${vSemver}$2`
    );
    return res;
  }) && updatedCount++;

  // 11. scripts/Update_Version.ps1
  updateFile('scripts/Update_Version.ps1', content => {
    let res = content;
    // Update default fallback version
    res = res.replace(/(\$currentVer\s*=\s*['"])[^'"]+(['"])/, `$1${vSemver}$2`);
    return res;
  }) && updatedCount++;

  console.log(`\n${colors.bold}${colors.green}✔ 版本同步完成！已變更 ${updatedCount} 個相關檔案。${colors.reset}\n`);
}

/**
 * docs/index.html: always updates the brand badge and the release-notes tag.
 * The "X.Y 版更新全覽 (date)" title and "系統於 date 正式更新至 X.Y 版" text describe when the
 * minor version was released, so they are only rewritten when the minor version changes
 * (e.g. 1.7 -> 1.8). Patch releases (1.7.3 -> 1.7.4) keep the original date and any hand-edited title.
 */
function transformDocsIndex(content, { semver, vSemver, majorMinor, dateShort }) {
  let res = content;
  res = res.replace(
    /<span class="brand-badge">v[0-9.]+\s+ENTERPRISE<\/span>/,
    `<span class="brand-badge">${vSemver} ENTERPRISE</span>`
  );
  res = res.replace(
    /<div class="section-tag"([^>]*)>VERSION\s+[0-9.]+\s+RELEASE NOTES<\/div>/,
    `<div class="section-tag"$1>VERSION ${semver} RELEASE NOTES</div>`
  );
  const titleRe = /<h2 class="section-title">SOMP Vanguard\s+([0-9.]+)\s*版更新全覽\s*\([^)]*\)<\/h2>/;
  const current = titleRe.exec(res);
  if (!current || current[1] !== majorMinor) {
    res = res.replace(titleRe, `<h2 class="section-title">SOMP Vanguard ${majorMinor} 版更新全覽 (${dateShort} 更新)</h2>`);
    res = res.replace(
      /(<p class="section-desc"[^>]*>系統於\s*)[^正]+(正式更新至\s*)[0-9.]+\s*版/,
      `$1${dateShort} $2${majorMinor} 版`
    );
  }
  return res;
}

if (require.main === module) {
  main();
}

module.exports = { transformDocsIndex };
