const fs = require('fs');
const path = require('path');
const sqliteHelper = require('../lib/sqliteHelper');

async function runTest() {
    console.log('--- Testing SQLite Engine ---');
    const testDbPath = path.join(__dirname, 'test_sample.db');

    // Create a real SQLite database file using sql.js
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, created_at DATETIME);');
    db.run("INSERT INTO users VALUES (1, 'alice', 'Admin', '2026-09-10 10:00:00');");
    db.run("INSERT INTO users VALUES (2, 'bob', 'Operator', '2026-09-10 10:05:00');");
    db.run("INSERT INTO users VALUES (3, 'charlie', 'Viewer', '2026-09-10 10:10:00');");
    
    const data = db.export();
    fs.writeFileSync(testDbPath, Buffer.from(data));
    console.log('[OK] Created test SQLite DB at:', testDbPath);

    try {
        // Test connection
        console.log('[TEST] Testing Connection...');
        const connResult = await sqliteHelper.testConnection(testDbPath);
        console.log('[PASS] Connection Result:', connResult);

        // Test query
        console.log('[TEST] Testing Query...');
        const rows = await sqliteHelper.executeQuery(testDbPath, 'SELECT * FROM users WHERE role != "Admin";');
        console.log('[PASS] Query Results:', rows);

        // Test tables list
        console.log('[TEST] Getting tables list...');
        const tables = await sqliteHelper.getTables(testDbPath);
        console.log('[PASS] Tables in DB:', tables);

    } finally {
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
            console.log('[CLEANUP] Removed test database.');
        }
    }
}

runTest().catch(err => {
    console.error('[FAIL] Test threw error:', err);
    process.exit(1);
});
