// Public keys that verify license files (lib/license.js), by keyId. Public keys are safe to publish; the private keys
// stay with the vendor (scripts/license_keygen.js). Several keys can be listed so licenses signed with an older key
// keep working after a key change.
const KEYS = {
    k1: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAu5kVJ3B97CJL41/vk12o6rJQNrQM8OF1/T5yN/VQdRs=
-----END PUBLIC KEY-----
`,
};

module.exports = { KEYS };
