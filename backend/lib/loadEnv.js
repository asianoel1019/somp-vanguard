/**
 * Loads backend/.env into process.env (shared by the web process and the background worker).
 *
 * Only the web process may pass { rewrite: true }: that migrates plain-text secrets in the file to enc: values.
 * The worker passes { rewrite: false } and must never write .env - a read that overlaps a Save in the web process
 * can see a half-written file, and writing that back would corrupt a secret.
 */
const path = require('path');
const dotenv = require('dotenv');

const ENC_PREFIX = 'enc:';

function resolveTimezone(tz) {
    if (!tz) return 'Asia/Taipei';
    const match = tz.match(/^UTC([+-]\d+)$/i);
    if (match) {
        const offset = parseInt(match[1]);
        return `Etc/GMT${offset > 0 ? '-' + offset : '+' + Math.abs(offset)}`;
    }
    return tz;
}

function envFilePath() {
    return process.env.SOMP_ENV_PATH || path.join(__dirname, '..', '.env');
}

/** @param {{ rewrite?: boolean, logger?: { log: Function, warn: Function } | null }} options */
function loadEnv({ rewrite = false, logger = null } = {}) {
    const log = (...a) => { if (logger) logger.log(...a); };
    const warn = (...a) => { if (logger) logger.warn(...a); };
    const file = envFilePath();

    log('[Env] Reloading and decrypting environment variables...');
    dotenv.config({ path: file, override: true });

    const { decryptText } = require('./crypto');

    if (rewrite) {
        // Optional plain->encrypted migration: a failure here must never stop the process from starting
        // (it is retried on the next reload).
        try {
            const { readEnv, writeEnv, shouldEncrypt } = require('./envEditor');
            const currentFileEnv = readEnv();
            let needsRewrite = false;
            for (const key of Object.keys(currentFileEnv)) {
                if (shouldEncrypt(key) && currentFileEnv[key] && !currentFileEnv[key].startsWith(ENC_PREFIX)) {
                    needsRewrite = true;
                    log(`[Env] Auto-encrypting plain-text secret for: ${key}`);
                }
            }
            if (needsRewrite) {
                writeEnv(currentFileEnv);
                log('[Env] Rewrote .env file with encrypted secrets.');
                dotenv.config({ path: file, override: true });
            }
        } catch (err) {
            const msg = `[Env] Skipped .env secret migration: ${err && err.message ? err.message : err}`;
            if (logger) logger.warn(msg); else console.warn(msg);
        }
    }

    Object.keys(process.env).forEach(key => {
        const val = process.env[key];
        if (val && typeof val === 'string' && val.startsWith(ENC_PREFIX)) {
            try {
                process.env[key] = decryptText(val.substring(ENC_PREFIX.length));
                log(`[Env] Decrypted ${key}`);
            } catch (err) {
                warn(`[Env] FAILED to decrypt ${key} (Value remains: ${val})`);
            }
        }
    });

    process.env.TZ = resolveTimezone(process.env.SYSTEM_TIMEZONE);
    log(`[Env] Global Timezone updated to: ${process.env.TZ}`);

    // Mask proxy from environment variables to enforce module opt-in
    global.SYSTEM_PROXY = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    if (global.SYSTEM_PROXY) {
        log('[Env] Global Proxy detected and masked. Opt-in modules only.');
    }
}

module.exports = { loadEnv, resolveTimezone };
