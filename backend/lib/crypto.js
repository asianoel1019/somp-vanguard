const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const SYSTEM_KEY_FILE = path.join(BASE_DATA_DIR, '.system_key');
const LEGACY_KEY_FILE = 'C:\\ProgramData\\somp-vanguard\\.system_key';

/**
 * Retrieves or generates a persistent master key for .env encryption.
 */
function getSystemKey() {
    try {
        if (fs.existsSync(SYSTEM_KEY_FILE)) {
            return fs.readFileSync(SYSTEM_KEY_FILE, 'utf-8').trim();
        }
        if (!process.env.SOMP_DISABLE_LEGACY_PATHS && fs.existsSync(LEGACY_KEY_FILE)) {
            return fs.readFileSync(LEGACY_KEY_FILE, 'utf-8').trim();
        }
    } catch (e) {
        console.error('[Crypto] Failed to read system key:', e);
    }

    // Generate new key
    const newKey = crypto.randomBytes(32).toString('hex');
    const dir = path.dirname(SYSTEM_KEY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    try {
        fs.writeFileSync(SYSTEM_KEY_FILE, newKey, 'utf-8');
    } catch (e) {
        console.error('[Crypto] Failed to write system key:', e);
    }
    return newKey;
}

function encryptPassword(text, secret) {
    if (!text) return '';
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(secret, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + salt + ':' + encrypted;
}

function decryptPassword(text, secret) {
    if (!text) return '';
    try {
        const parts = text.split(':');
        let iv, salt, encrypted;
        
        if (parts.length === 3) {
            iv = Buffer.from(parts[0], 'hex');
            salt = parts[1];
            encrypted = parts[2];
        } else if (parts.length === 2) {
            // Legacy backwards compatibility for hardcoded 'salt'
            iv = Buffer.from(parts[0], 'hex');
            salt = 'salt';
            encrypted = parts[1];
        } else {
            return '';
        }

        const key = crypto.scryptSync(secret, salt, 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) {
        return '';
    }
}

/**
 * Encrypts a string using the persistent system key.
 */
function encryptText(text) {
    if (!text) return '';
    const secret = getSystemKey();
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(secret, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + salt + ':' + encrypted;
}

/**
 * Decrypts a string using the persistent system key.
 */
function decryptText(cipherText) {
    if (!cipherText) return '';
    try {
        const secret = getSystemKey();
        const parts = cipherText.split(':');
        let iv, salt, encrypted;

        if (parts.length === 3) {
            iv = Buffer.from(parts[0], 'hex');
            salt = parts[1];
            encrypted = parts[2];
        } else if (parts.length === 2) {
            // Legacy backwards compatibility for hardcoded 'env_salt'
            iv = Buffer.from(parts[0], 'hex');
            salt = 'env_salt';
            encrypted = parts[1];
        } else {
            throw new Error('INVALID_FORMAT');
        }

        const key = crypto.scryptSync(secret, salt, 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error('[Crypto] Decryption failed:', e.message);
        throw new Error('DECRYPTION_FAILED');
    }
}

module.exports = {
    encryptPassword,
    decryptPassword,
    encryptText,
    decryptText,
    getSystemKey,
    SYSTEM_KEY_FILE
};
