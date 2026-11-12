// "Your password was changed" mail to the account owner (when SMTP_* is set and the account has an email address).
const nodemailer = require('nodemailer');

const escapeHtml = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const two = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

/** { subject, text, html } of the confirmation */
function buildChangedMail({ name, sam, ip, adminContact }, now = new Date()) {
    const when = local(now);
    const contactZh = adminContact ? `請立即聯絡 ${adminContact}。` : '請立即聯絡 IT。';
    const contactEn = adminContact ? `contact ${adminContact} immediately.` : 'contact IT immediately.';
    const subject = '您的密碼已變更 / Your password was changed';
    const text = [
        `${name || sam} 您好，`, '',
        `您的帳號 ${sam} 的密碼已於 ${when} 從 ${ip} 透過密碼變更頁面變更。`,
        `如果這不是您本人的操作，${contactZh}`, '',
        '----', '',
        `Hello ${name || sam},`, '',
        `The password of your account ${sam} was changed on ${when} from ${ip} on the password change page.`,
        `If this was not you, ${contactEn}`, '',
        '此信由系統自動寄出 / This message was sent automatically.',
    ].join('\n');
    const p = (s) => `<p style="margin:0 0 10px">${s}</p>`;
    const html = `<div style="font-family:Segoe UI,Microsoft JhengHei,Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
${p(`${escapeHtml(name || sam)} 您好，`)}
${p(`您的帳號 <b>${escapeHtml(sam)}</b> 的密碼已於 ${escapeHtml(when)} 從 ${escapeHtml(ip)} 透過密碼變更頁面變更。`)}
${p(`<span style="color:#b45309">如果這不是您本人的操作，${escapeHtml(contactZh)}</span>`)}
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
${p(`Hello ${escapeHtml(name || sam)},`)}
${p(`The password of your account <b>${escapeHtml(sam)}</b> was changed on ${escapeHtml(when)} from ${escapeHtml(ip)} on the password change page.`)}
${p(`<span style="color:#b45309">If this was not you, ${escapeHtml(contactEn)}</span>`)}
<p style="margin:16px 0 0;color:#888;font-size:12px">此信由系統自動寄出 / This message was sent automatically.</p>
</div>`;
    return { subject, text, html };
}

/** sends the confirmation; resolves to '' or the reason it was not sent (never rejects) */
function createMailer(smtp, adminContact, createTransport = nodemailer.createTransport) {
    return async function sendChanged({ to, name, sam, ip }) {
        if (!smtp) return 'SMTP not configured';
        if (!to || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return 'no email address';
        try {
            const transport = createTransport({
                host: smtp.host, port: smtp.port, secure: smtp.secure,
                ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
            });
            await transport.sendMail({ from: smtp.from, to, ...buildChangedMail({ name, sam, ip, adminContact }) });
            return '';
        } catch (err) {
            return String(err.message || err).replace(/[\x00-\x1f]+/g, ' ').slice(0, 200);
        }
    };
}

module.exports = { buildChangedMail, createMailer, escapeHtml };
