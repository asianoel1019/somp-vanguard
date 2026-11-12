// The password change page: one static page and two API calls, only for clients in ALLOWED_NETS.
const path = require('path');
const express = require('express');
const { inNets, clientIp } = require('./net');
const { parseAccount, isPasswordText } = require('./scope');
const { Limiter } = require('./limiter');

const WINDOW_MS = 15 * 60 * 1000;
const POLICY_CACHE_MS = 10 * 60 * 1000;

const MESSAGES = {
    invalid: '帳號或目前密碼不正確。多次失敗後帳號可能會被鎖定。 / The account or current password is not correct. Repeated failures can lock the account.',
    policy: '新密碼不符合網域的密碼原則：長度、複雜度、不可與最近用過的密碼相同，或距離上次變更的時間太短。 / The new password does not meet the domain password policy: length, complexity, not one of your recent passwords, or changed again too soon.',
    error: '目前無法變更密碼，請稍後再試或聯絡管理員。 / The password cannot be changed right now. Try again later or contact the administrator.',
    input: '請填寫帳號、目前密碼與兩次相同的新密碼。 / Enter the account, the current password and the same new password twice.',
    same: '新密碼不能與目前密碼相同。 / The new password must differ from the current one.',
    rate: (min) => `嘗試次數過多，請在 ${min} 分鐘後再試。 / Too many attempts. Try again in ${min} minute(s).`,
    blocked: '此頁面只開放給公司內部網路使用。 / This page is only available on the internal network.',
};

/**
 * @param {object} deps config (src/config), ad ({ changePassword, passwordPolicy }), audit(entry), sendChanged(mail)
 */
function createApp({ config, ad, audit, sendChanged, limits = { ip: 10, account: 5 } }) {
    const app = express();
    app.disable('x-powered-by');
    const ipLimiter = new Limiter(limits.ip, WINDOW_MS);
    const accountLimiter = new Limiter(limits.account, WINDOW_MS);
    let policyCache = { at: 0, value: null };

    // only the internal networks; everything else gets a short refusal
    app.use((req, res, next) => {
        const ip = clientIp(req, config.trustProxy);
        req.clientIp = ip;
        if (inNets(ip, config.nets)) return next();
        console.warn(`[pwdchange] Refused ${req.method} ${req.path} from ${ip}: not in ALLOWED_NETS`);
        res.status(403).type('text/plain; charset=utf-8').send(MESSAGES.blocked);
    });

    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
        });
        if (!config.allowHttp) res.set('Strict-Transport-Security', 'max-age=31536000');
        next();
    });

    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

    app.get('/api/info', async (req, res) => {
        if (Date.now() - policyCache.at > POLICY_CACHE_MS) {
            try {
                policyCache = { at: Date.now(), value: await ad.passwordPolicy(config) };
            } catch (err) {
                console.warn('[pwdchange] Could not read the password policy:', err.message);
                policyCache = { at: Date.now() - POLICY_CACHE_MS + 60 * 1000, value: null }; // retry in a minute
            }
        }
        res.json({ adminContact: config.adminContact, httpWarning: config.allowHttp && !req.secure, policy: policyCache.value });
    });

    app.post('/api/change', express.json({ limit: '4kb' }), async (req, res) => {
        const ip = req.clientIp;
        const body = req.body || {};
        const typed = typeof body.account === 'string' ? body.account.trim() : '';
        const answer = (status, outcome, reason, message, extra = {}) => {
            audit({ ip, account: typed, outcome, reason });
            res.status(status).json({ ok: outcome === 'ok', message, ...extra });
        };

        if (!ipLimiter.take(ip)) {
            const min = Math.ceil(ipLimiter.retryAfter(ip) / 60);
            return answer(429, 'limited', 'too many attempts from this address', MESSAGES.rate(min), { retryAfter: min * 60 });
        }
        const account = parseAccount(typed);
        const { currentPassword, newPassword, confirmPassword } = body;
        if (!account || !isPasswordText(currentPassword) || !isPasswordText(newPassword) || newPassword !== confirmPassword) {
            return answer(400, 'rejected', 'incomplete or invalid input', MESSAGES.input);
        }
        if (newPassword === currentPassword) return answer(400, 'rejected', 'new password equals the current one', MESSAGES.same);
        const accountKey = account.value.toLowerCase();
        if (!accountLimiter.take(accountKey)) {
            const min = Math.ceil(accountLimiter.retryAfter(accountKey) / 60);
            return answer(429, 'limited', 'too many attempts for this account', MESSAGES.rate(min), { retryAfter: min * 60 });
        }

        const r = await ad.changePassword(config, { account, oldPassword: currentPassword, newPassword });
        if (r.outcome === 'ok') {
            const mailNote = await sendChanged({ to: r.account && r.account.mail, name: r.account && r.account.name, sam: (r.account && r.account.sam) || account.value, ip });
            return answer(200, 'ok', `changed${mailNote ? `; confirmation mail not sent: ${mailNote}` : '; confirmation mail sent'}`,
                '密碼已變更。請在所有裝置（電腦、手機信箱、VPN、Wi-Fi）改用新密碼。 / Your password was changed. Use the new password everywhere you sign in (computer, phone mail, VPN, Wi-Fi).');
        }
        if (r.outcome === 'policy') return answer(400, 'policy', r.reason, MESSAGES.policy);
        if (r.outcome === 'invalid') return answer(400, 'invalid', r.reason, MESSAGES.invalid);
        return answer(503, 'error', r.reason, MESSAGES.error);
    });

    app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Not found'));
    // malformed JSON and other request errors: no stack traces
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
        res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, message: MESSAGES.input });
    });
    return app;
}

module.exports = { createApp, MESSAGES };
