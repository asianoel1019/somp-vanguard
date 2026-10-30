/**
 * Running version — single source of truth: backend/package.json, which is deployed with the code and
 * bumped by scripts/Update_Version. (The VERSION key in .env is not used: SCP_to_Prod never uploads .env,
 * so production kept reporting a stale value.)
 */
let cached = null;

function getVersion() {
    if (!cached) cached = `v${require('../package.json').version}`;
    return cached;
}

module.exports = { getVersion };
