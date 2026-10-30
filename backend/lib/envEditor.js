const fs = require('fs');
const path = require('path');
const { encryptText, decryptText } = require('./crypto');

const envPath = process.env.SOMP_ENV_PATH || path.join(__dirname, '../.env');

// Keys that should be encrypted when saved via the UI
const SENSITIVE_KEY_PATTERNS = [
    '_PWD', '_PASS', '_TOKEN', '_ACCOUNT', '_SECRET'
];
const SENSITIVE_KEY_EXACT = [
    'LOCAL_ADMIN_USER', 'LOCAL_ADMIN_PWD', 'JWT_SECRET', 'TELEGRAM_BOT_TOKEN'
];

function shouldEncrypt(key) {
    if (key === 'PORT') return false; // Always plain
    if (SENSITIVE_KEY_EXACT.includes(key)) return true;
    return SENSITIVE_KEY_PATTERNS.some(pat => key.includes(pat));
}

const ENC_PREFIX = 'enc:';

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads the .env file and returns an object of key-value pairs.
 * Automatically decrypts values starting with 'enc:'.
 */
function readEnv() {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const config = {};

    lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const key = match[1];
                let value = (match[2] || '').trim();
                
                // Remove quotes if present
                if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                
                // Transparent decryption
                if (value.startsWith(ENC_PREFIX)) {
                    try {
                        value = decryptText(value.substring(ENC_PREFIX.length));
                    } catch (e) {
                        console.error(`[EnvEditor] Decryption failed for key ${key}, retaining original encrypted value`);
                        // Keep value as original enc:... string to prevent data loss
                    }
                }

                config[key] = value;
            }
        }
    });

    return config;
}

/**
 * Updates the .env file with new values. 
 * Automatically encrypts sensitive values.
 */
function writeEnv(newConfig, dynamicPrefixes = []) {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    let lines = content.split('\n');

    const keysToUpdate = new Set(Object.keys(newConfig));

    const updatedLines = [];
    lines.forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            const key = match[1];
            if (keysToUpdate.has(key)) {
                // Key exists in new config, update it
                keysToUpdate.delete(key);
                const leadingSpace = line.match(/^\s*/)[0];
                let value = newConfig[key];

                // Transparent encryption
                if (shouldEncrypt(key) && value && !value.startsWith(ENC_PREFIX)) {
                    value = ENC_PREFIX + encryptText(value);
                }

                updatedLines.push(`${leadingSpace}${key}=${value}`);
            } else {
                // Key NOT in new config. Should we keep it or delete it?
                const isDynamic = dynamicPrefixes.some(p => key.startsWith(p));
                if (!isDynamic) {
                    updatedLines.push(line);
                }
            }
        } else {
            updatedLines.push(line);
        }
    });

    // New keys append at the end
    keysToUpdate.forEach(key => {
        let value = newConfig[key];
        if (shouldEncrypt(key) && value && !value.startsWith(ENC_PREFIX)) {
            value = ENC_PREFIX + encryptText(value);
        }
        updatedLines.push(`${key}=${value}`);
    });

    // Atomic replace: readers (e.g. the worker reloading .env) never see a half-written file.
    // On Windows the rename fails while another process (AV, indexer, editor) holds .env open, so retry briefly
    // and finally fall back to the old in-place write. The temp file (it holds secrets) never lingers.
    const newContent = updatedLines.join('\n');
    const tmpPath = `${envPath}.tmp`;
    try {
        fs.writeFileSync(tmpPath, newContent, 'utf-8');
        const RETRYABLE = ['EPERM', 'EACCES', 'EBUSY'];
        const delays = [50, 100, 200];
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tmpPath, envPath);
                break;
            } catch (err) {
                if (!RETRYABLE.includes(err.code)) throw err;
                if (attempt >= delays.length) {
                    fs.writeFileSync(envPath, newContent, 'utf-8');
                    break;
                }
                sleepSync(delays[attempt]);
            }
        }
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
}

module.exports = { readEnv, writeEnv, shouldEncrypt };
