// Child process for test/services/logTables.test.js: runs the log table migration against DB_DATA_DIR (set by the
// parent to a temp directory) and prints the result as JSON. Started twice at the same time to simulate the web
// process and the worker migrating concurrently.
process.env.DB_TYPE = 'sqlite';
process.env.SOMP_DISABLE_LEGACY_PATHS = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
delete process.env.DB_HOST;

const logTables = require('../../../services/logTables');
const res = logTables.migrateAll();
const h = logTables.getHandle();
const counts = Object.fromEntries(logTables.TABLE_NAMES.map(t => [t, h.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
process.stdout.write(JSON.stringify({ res, counts }));
try { require('../../../lib/db').db.close(); } catch (e) {}
try { require('../../../services/db').getDriver().db.close(); } catch (e) {}
