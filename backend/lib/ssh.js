const { Client } = require('ssh2');
const { checkHostKey, HostKeyChangedError } = require('./sshHostKeys');

/**
 * Build the host key pinning part of the ssh2 connect config (trust on first use).
 * Pinning is opt-in (options.pinHostKey) so unrelated callers keep their behaviour.
 * The verifier runs before authentication, so no credentials are sent on a mismatch.
 */
function createPinning(host, options = {}) {
    const state = { error: null, connectOptions: {} };
    if (!options.pinHostKey) return state;
    state.connectOptions = {
        hostHash: 'sha256',
        hostVerifier: (hash) => {
            try {
                const res = checkHostKey(host, hash, options.hostKeyStore);
                if (res.status === 'mismatch') {
                    state.error = new HostKeyChangedError(host, res.expected, res.fingerprint);
                    return false;
                }
                return true;
            } catch (e) {
                // Fail closed: never authenticate when the pin store cannot be consulted
                state.error = new Error(`host key verification failed for ${host}: ${e.message}`);
                return false;
            }
        }
    };
    return state;
}

function newClient(options = {}) {
    return options.clientFactory ? options.clientFactory() : new Client();
}

/**
 * Execute an SSH command.
 * @param {string} host 
 * @param {string} username 
 * @param {string} password 
 * @param {string} command 
 * @param {object} options 
 * @returns {Promise<{ stdout: string, stderr: string, code: number, success: boolean }>}
 */
function executeSSH(host, username, password, command, options = {}) {
    return new Promise((resolve, reject) => {
        const pin = createPinning(host, options);
        const conn = newClient(options);
        let stdout = '';
        let stderr = '';
        // options.maxOutputBytes: stop collecting stdout / stderr past this size (the command keeps running)
        const maxOut = options.maxOutputBytes > 0 ? options.maxOutputBytes : Infinity;

        let execTimer = null;
        let streamRef = null;
        const clearExecTimer = () => { if (execTimer) { clearTimeout(execTimer); execTimer = null; } };

        conn.on('ready', () => {
            if (options.execTimeoutMs > 0) {
                // A hung remote command must not leave the connection open: close the channel and the socket
                execTimer = setTimeout(() => {
                    execTimer = null;
                    try { if (streamRef && streamRef.close) streamRef.close(); } catch (_) {}
                    try { conn.end(); } catch (_) {}
                    try { if (conn.destroy) conn.destroy(); } catch (_) {}
                    reject(new Error(`SSH command timed out after ${Math.round(options.execTimeoutMs / 1000)} s`));
                }, options.execTimeoutMs);
                if (execTimer.unref) execTimer.unref();
            }
            conn.exec(command, (err, stream) => {
                if (err) {
                    clearExecTimer();
                    conn.end();
                    return reject(err);
                }
                streamRef = stream;
                // Secrets such as a sudo password go through stdin, never the command line
                if (options.stdin !== undefined && options.stdin !== null) stream.end(options.stdin);
                stream.on('close', (code) => {
                    clearExecTimer();
                    conn.end();
                    resolve({
                        success: code === 0,
                        stdout,
                        stderr,
                        code
                    });
                }).on('data', (data) => {
                    if (stdout.length < maxOut) stdout += data.toString();
                }).stderr.on('data', (data) => {
                    if (stderr.length < maxOut) stderr += data.toString();
                });
            });
        }).on('error', (err) => {
            reject(pin.error || err);
        }).connect({
            host: host,
            port: options.port || 22,
            username: username,
            password: password,
            readyTimeout: options.timeout || 10000,
            ...pin.connectOptions
        });
    });
}

/**
 * Write a file to a remote server via SFTP.
 * @param {string} host 
 * @param {string} username 
 * @param {string} password 
 * @param {string} remotePath 
 * @param {string|Buffer} content 
 * @param {object} options 
 * @returns {Promise<void>}
 */
function sftpWrite(host, username, password, remotePath, content, options = {}) {
    return new Promise((resolve, reject) => {
        const pin = createPinning(host, options);
        const conn = newClient(options);
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { 
                    conn.end(); 
                    return reject(err); 
                }
                const writeStream = sftp.createWriteStream(remotePath);
                writeStream.on('close', () => { 
                    conn.end(); 
                    resolve(); 
                });
                writeStream.on('error', (e) => { 
                    conn.end(); 
                    reject(e); 
                });
                writeStream.write(content);
                writeStream.end();
            });
        }).on('error', (err) => reject(pin.error || err)).connect({ 
            host: host, 
            port: options.port || 22, 
            username: username, 
            password: password, 
            readyTimeout: options.timeout || 10000,
            ...pin.connectOptions
        });
    });
}

/**
 * Execute multiple commands interactively via SSH Shell.
 * @returns {Promise<string>}
 */
function executeShell(host, username, password, commands, options = {}) {
    return new Promise((resolve, reject) => {
        const pin = createPinning(host, options);
        const conn = newClient(options);
        let logs = [];
        conn.on('ready', () => {
            conn.shell(async (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                stream.on('data', (data) => {
                    logs.push(data.toString());
                });
                stream.on('close', () => {
                    conn.end();
                    resolve(logs.join(''));
                });

                await new Promise(r => setTimeout(r, 1000));
                for (const cmd of commands) {
                    if (cmd.trim()) {
                        stream.write(cmd + '\n');
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                stream.write('exit\n');
            });
        }).on('error', (err) => reject(pin.error || err)).connect({
            host: host,
            port: options.port || 22,
            username: username,
            password: password,
            readyTimeout: options.timeout || 10000,
            algorithms: options.algorithms || undefined,
            ...pin.connectOptions
        });
    });
}

module.exports = {
    executeSSH,
    sftpWrite,
    executeShell
};
