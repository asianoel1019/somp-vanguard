const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const backup = require('../../lib/dbBackupCommand');

const PASSWORD = 'p"a$s w\\rd';

test('commands are argument arrays and never carry the password', () => {
    const file = 'C:\\data\\backups\\snap-1.bak';
    for (const engine of ['MySQL', 'PostgreSQL', 'SQLServer']) {
        for (const kind of ['backup', 'restore']) {
            const plan = backup.buildCommand(kind, { engine, host: 'db01', port: 1, username: 'u', database: 'app' }, file, PASSWORD);
            assert.ok(Array.isArray(plan.args));
            assert.ok(!plan.args.some(a => a.includes(PASSWORD)), `${engine} ${kind} args`);
        }
    }
    const pg = backup.buildCommand('backup', { engine: 'PostgreSQL', host: 'db01', username: 'u', database: 'app' }, file, PASSWORD);
    assert.equal(pg.env.PGPASSWORD, PASSWORD);
    assert.ok(pg.args.includes('-w'), 'never prompts for a password');
    const ms = backup.buildCommand('backup', { engine: 'SQLServer', host: 'sql01', port: 1433, username: 'u', database: "a]b'c" }, "C:\\x'y.bak", PASSWORD);
    assert.equal(ms.env.SQLCMDPASSWORD, PASSWORD);
    assert.ok(ms.args.includes('-b'), 'T-SQL errors become a non-zero exit');
    assert.equal(ms.args[ms.args.indexOf('-Q') + 1], "BACKUP DATABASE [a]]b'c] TO DISK = N'C:\\x''y.bak'");
    const named = backup.buildCommand('backup', { engine: 'SQLServer', host: 'sql01\\INST', port: 1433, username: 'u', database: 'a' }, 'f', '');
    assert.equal(named.args[named.args.indexOf('-S') + 1], 'sql01\\INST');
});

test('MySQL gets its password from a temporary option file that is removed afterwards', async () => {
    let seen;
    backup.setRunnerForTest(async ({ cmd, args }) => {
        const opt = args[0].replace('--defaults-extra-file=', '');
        seen = { cmd, opt, content: fs.readFileSync(opt, 'utf8'), args };
        return {};
    });
    try {
        await backup.run('backup', { engine: 'MySQL', host: 'db01', username: 'u', database: 'app' }, 'out.sql', PASSWORD);
    } finally {
        backup.setRunnerForTest(null);
    }
    assert.equal(seen.cmd, 'mysqldump');
    assert.ok(seen.args.includes('--result-file=out.sql'));
    assert.equal(seen.content, '[client]\npassword="p\\"a$s w\\\\rd"\n');
    assert.equal(fs.existsSync(seen.opt), false);
});

test('a failing tool rejects with its message, minus the password', async () => {
    backup.setRunnerForTest(async () => { throw new Error(`pg_dump exited with code 1: auth failed for ${PASSWORD}`); });
    try {
        await assert.rejects(
            backup.run('backup', { engine: 'PostgreSQL', host: 'db01', username: 'u', database: 'app' }, 'f', PASSWORD),
            (e) => e.message.includes('auth failed for ***') && !e.message.includes(PASSWORD)
        );
    } finally {
        backup.setRunnerForTest(null);
    }
});

test('restores replace the database instead of colliding with it', () => {
    const pg = backup.buildCommand('restore', { engine: 'PostgreSQL', host: 'db01', username: 'u', database: 'app' }, 'f.dump', '');
    assert.ok(pg.args.includes('--clean') && pg.args.includes('--if-exists'));
    const ms = backup.buildCommand('restore', { engine: 'SQLServer', host: 'sql01', port: 1433, username: 'u', database: 'app', trustServerCertificate: true }, 'C:/b/x.bak', '');
    const tsql = ms.args[ms.args.indexOf('-Q') + 1];
    assert.match(tsql, /SET SINGLE_USER WITH ROLLBACK IMMEDIATE/);
    assert.match(tsql, /WITH REPLACE/);
    assert.match(tsql, /SET MULTI_USER;$/);
    assert.equal(ms.args[ms.args.indexOf('-d') + 1], 'master');
    assert.ok(ms.args.includes('-C'), 'trusts the server certificate when the record says so');
});
