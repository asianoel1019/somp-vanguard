// Must be required before any backend module: crypto.js, db.js and logger.js read DB_DATA_DIR at load time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-test-'));

process.env.DB_DATA_DIR = dataDir;
process.env.SOMP_ENV_PATH = path.join(dataDir, '.env');
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.LOCAL_ADMIN_USER = 'admin';
process.env.DB_TYPE = 'sqlite';
// Skip the hardcoded C:\ProgramData fallbacks in crypto.js / db.js / sqliteDriver.js
process.env.SOMP_DISABLE_LEGACY_PATHS = '1';
delete process.env.DB_HOST;

// Never let a test reach real external services
for (const key of [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
    'AD_ADMIN_USER', 'AD_ADMIN_PWD',
    'LINUX_ADMIN_USER', 'LINUX_ADMIN_PWD',
]) {
    delete process.env[key];
}

process.on('exit', () => {
    // Windows keeps open SQLite files locked, so close any handles before removing the temp dir
    const dbModule = require.cache[require.resolve('../../lib/db')];
    try { dbModule?.exports.db?.close(); } catch (e) {}
    const dbManager = require.cache[require.resolve('../../services/db')];
    try { dbManager?.exports.getDriver?.().db?.close(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
});

module.exports = { dataDir };
