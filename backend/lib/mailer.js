const nodemailer = require('nodemailer');

async function sendMail({ subject, html, text, to }) {
    const server = process.env.MAIL_RELAY_SERVER;
    const account = process.env.MAIL_RELAY_ACCOUNT;
    const pass = process.env.MAIL_RELAY_PWD;
    const sender = process.env.MAIL_RELAY_SENDER;
    const recipient = to || process.env.MAIL_RELAY_RECIPIENT;

    if (!server || !sender || !recipient) {
        console.warn('[Mailer] Missing configuration or recipient, email skipped.');
        return;
    }

    try {
        const transportOpts = {
            host: server,
            port: parseInt(process.env.MAIL_RELAY_PORT) || 25,
            secure: process.env.MAIL_RELAY_SECURE === 'true',
            tls: {
                rejectUnauthorized: false
            }
        };

        if (account && pass) {
            transportOpts.auth = { user: account, pass: pass };
        }

        const transporter = nodemailer.createTransport(transportOpts);
        
        await transporter.sendMail({
            from: sender,
            to: recipient,
            subject: subject,
            html: html,
            text: text
        });
        console.log(`[Mailer] Email sent: ${subject}`);
    } catch (e) {
        console.error('[Mailer] Send failed:', e.message);
    }
}

module.exports = { sendMail };
