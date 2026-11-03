// Runs the native dump/restore tools for database backups without a shell: every value is a separate argument
// and passwords travel through environment variables or a temporary option file, never the command line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const STDERR_LIMIT = 64 * 1024;

const tsqlName = (name) => `[${String(name).replace(/]/g, ']]')}]`;
const tsqlString = (text) => `N'${String(text).replace(/'/g, "''")}'`;

/**
 * Build the tool invocation for a backup or restore.
 * @param {'backup'|'restore'} kind
 * @returns {{ cmd: string, args: string[], env: object, stdinFile?: string, mysqlPassword?: string }}
 */
function buildCommand(kind, db, file, password) {
    const host = String(db.host);
    if (db.engine === 'MySQL') {
        const base = ['-h', host, '-P', String(db.port || 3306), '-u', String(db.username)];
        return kind === 'backup'
            ? { cmd: 'mysqldump', args: [...base, `--result-file=${file}`, String(db.database)], env: {}, mysqlPassword: password }
            : { cmd: 'mysql', args: [...base, String(db.database)], env: {}, stdinFile: file, mysqlPassword: password };
    }
    if (db.engine === 'PostgreSQL') {
        const base = ['-w', '-h', host, '-p', String(db.port || 5432), '-U', String(db.username), '-d', String(db.database)];
        return kind === 'backup'
            ? { cmd: 'pg_dump', args: [...base, '-F', 'c', '-f', file], env: { PGPASSWORD: password } }
            // --clean --if-exists: drop the objects in the dump first, so a restore replaces instead of colliding
            : { cmd: 'pg_restore', args: [...base, '--clean', '--if-exists', file], env: { PGPASSWORD: password } };
    }
    if (db.engine === 'SQLServer') {
        const server = /\\/.test(host) ? host : `${host},${db.port || 1433}`;
        const name = tsqlName(db.database);
        // Restore: other sessions are rolled back so the database can be replaced, then it is opened again
        const tsql = kind === 'backup'
            ? `BACKUP DATABASE ${name} TO DISK = ${tsqlString(file)}`
            : `ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; `
              + `BEGIN TRY RESTORE DATABASE ${name} FROM DISK = ${tsqlString(file)} WITH REPLACE; END TRY `
              + `BEGIN CATCH ALTER DATABASE ${name} SET MULTI_USER; THROW; END CATCH; `
              + `ALTER DATABASE ${name} SET MULTI_USER;`;
        // -b: exit with an error code when the T-SQL fails, otherwise a failed BACKUP still exits 0;
        // -d master: the restored database cannot be the session's own database
        const args = ['-S', server, '-U', String(db.username), '-b', ...(kind === 'restore' ? ['-d', 'master'] : []), '-Q', tsql];
        if (db.trustServerCertificate === true) args.splice(args.indexOf('-b'), 0, '-C');
        return { cmd: 'sqlcmd', args, env: { SQLCMDPASSWORD: password } };
    }
    throw new Error(`Unsupported database engine for backup: ${db.engine}`);
}

// mysql/mysqldump read the password from an option file so it never appears in the process list
function mysqlOptionFile(password) {
    const escaped = String(password).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const file = path.join(os.tmpdir(), `somp-my-${crypto.randomBytes(8).toString('hex')}.cnf`);
    fs.writeFileSync(file, `[client]\npassword="${escaped}"\n`, { mode: 0o600 });
    return file;
}

function defaultRunner({ cmd, args, env, stdinFile, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: [stdinFile ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
        } catch (e) { reject(e); return; }
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.stderr.on('data', (d) => { if (stderr.length < STDERR_LIMIT) stderr += d.toString(); });
        if (stdinFile) {
            const input = fs.createReadStream(stdinFile);
            input.on('error', (e) => { child.kill(); reject(e); });
            input.pipe(child.stdin);
            child.stdin.on('error', () => { /* the tool exited early; its exit code reports why */ });
        }
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e.code === 'ENOENT' ? new Error(`找不到 ${cmd}，請確認已安裝於 Vanguard 主機並在 PATH 中`) : e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`${cmd} 超過 ${Math.round(timeoutMs / 60000)} 分鐘未完成，已終止`));
            if (code === 0) return resolve({ stderr });
            reject(new Error(`${cmd} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`));
        });
    });
}

let runner = defaultRunner;

/** Run a backup or restore; resolves when the tool exits 0. Errors never contain the password. */
async function run(kind, db, file, password, { timeoutMs = BACKUP_TIMEOUT_MS } = {}) {
    const plan = buildCommand(kind, db, file, password || '');
    let optionFile = null;
    try {
        if (plan.mysqlPassword !== undefined) {
            optionFile = mysqlOptionFile(plan.mysqlPassword);
            plan.args.unshift(`--defaults-extra-file=${optionFile}`);
        }
        return await runner({ cmd: plan.cmd, args: plan.args, env: plan.env, stdinFile: plan.stdinFile, timeoutMs });
    } catch (e) {
        const message = password ? String(e.message).split(password).join('***') : String(e.message);
        throw new Error(message);
    } finally {
        if (optionFile) { try { fs.unlinkSync(optionFile); } catch (e) { /* already gone */ } }
    }
}

/** Test hook: replace the process runner; null restores the real one. */
function setRunnerForTest(fn) { runner = fn || defaultRunner; }

module.exports = { buildCommand, run, setRunnerForTest, BACKUP_TIMEOUT_MS };
