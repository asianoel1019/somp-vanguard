// Set_Password.bat: asks for the sign-in password twice (not shown on screen) and writes its scrypt hash to
// PASSWORD_HASH in license-issuer/.env (created from .env.example when missing). The password itself is never stored.
const fs = require('fs');
const path = require('path');
const { APP_DIR } = require('./config');
const { hashPassword, MIN_PASSWORD } = require('./auth');

/** Sets KEY=value in .env text: replaces the first uncommented KEY= line, else appends; keeps the line endings. */
function upsertEnvLine(text, key, value) {
    const src = String(text || '');
    const eol = /\r\n/.test(src) ? '\r\n' : '\n';
    const lines = src.length ? src.split(/\r?\n/) : [];
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else {
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push(`${key}=${value}`, '');
    }
    return lines.join(eol);
}

/** One line from the terminal without echo; falls back to a plain (visible) line when stdin is not a terminal. */
function askHidden(prompt, lineReader) {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) return lineReader();
    return new Promise((resolve, reject) => {
        let value = '';
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const done = (err) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            if (err) reject(err); else resolve(value);
        };
        function onData(chunk) {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') return done();
                if (ch === '\u0003') return done(new Error('cancelled'));
                if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);
                else if (ch >= ' ') value += ch;
            }
        }
        stdin.on('data', onData);
    });
}

/** Lines of piped stdin, one per call (for scripted use; the text is visible to whoever pipes it). */
function pipedLines() {
    let lines = null;
    return () => {
        if (!lines) lines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
        process.stdout.write('\n');
        return Promise.resolve(lines.length ? lines.shift() : '');
    };
}

async function main(appDir = APP_DIR) {
    if (!process.stdin.isTTY) console.warn('Input is not a terminal: the password is read from standard input.');
    const reader = pipedLines();
    const first = await askHidden(`New sign-in password (at least ${MIN_PASSWORD} characters): `, reader);
    if (first.length < MIN_PASSWORD) { console.error(`Too short: use at least ${MIN_PASSWORD} characters. Nothing was changed.`); return 1; }
    const second = await askHidden('Type it again: ', reader);
    if (first !== second) { console.error('The two passwords differ. Nothing was changed.'); return 1; }
    const hash = await hashPassword(first);
    const envFile = path.join(appDir, '.env');
    const example = path.join(appDir, '.env.example');
    let text = '';
    if (fs.existsSync(envFile)) text = fs.readFileSync(envFile, 'utf8');
    else if (fs.existsSync(example)) text = fs.readFileSync(example, 'utf8');
    fs.writeFileSync(envFile, upsertEnvLine(text, 'PASSWORD_HASH', hash));
    console.log(`PASSWORD_HASH written to ${envFile}. Restart the license issuer to use the new password.`);
    return 0;
}

if (require.main === module) {
    main().then((rc) => process.exit(rc), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { upsertEnvLine, main };
