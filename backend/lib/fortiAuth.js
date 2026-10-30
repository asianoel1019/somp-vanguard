// Fortinet Cookie Auth Module
const https = require('https');
const querystring = require('querystring');

async function getFortiCookies(host, username, password) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({
            username: username,
            secretkey: password,
            ajax: 1
        });

        const options = {
            hostname: host,
            port: 443,
            path: '/logincheck',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.headers['set-cookie']) {
                    const cookies = res.headers['set-cookie'];
                    let csrfToken = '';
                    cookies.forEach(c => {
                        if (c.includes('ccsrftoken=')) {
                            csrfToken = c.split('ccsrftoken=')[1].split(';')[0].replace(/"/g, '');
                        }
                    });
                    resolve({ cookieHeader: cookies.map(c => c.split(';')[0]).join('; '), csrfToken });
                } else {
                    reject(new Error('Login failed, no cookies returned'));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// Global cache for cookies so we don't spam logincheck on every refresh
const sessionCache = {};

async function getCachedFortiSession(host, username, password) {
    const key = `${host}_${username}`;
    const now = Date.now();
    
    // Cache for 10 minutes (600000 ms)
    if (sessionCache[key] && (now - sessionCache[key].timestamp < 600000)) {
        return sessionCache[key].session;
    }
    
    const session = await getFortiCookies(host, username, password);
    sessionCache[key] = { session, timestamp: now };
    return session;
}

module.exports = {
    getFortiCookies,
    getCachedFortiSession
};
