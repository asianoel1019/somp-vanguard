// Contract / warranty expiry notices (worker): once an hour from CONTRACT_NOTIFY_HOUR (default 9) local time, send one
// Telegram message listing the contracts that reached a notice day (CONTRACT_NOTIFY_DAYS, default 60,30,7; "off"
// disables) or expired in the last week. Which notices went out is kept per contract, so a restart never repeats one;
// a changed end date (edit) starts over and a renewed or trashed contract is skipped. Rules: lib/contractModel.js.
const { readDataSync } = require('../lib/db');
const { mutateDocument } = require('../lib/docStore');
const logger = require('../lib/logger');
const model = require('../lib/contractModel');

const CONTRACTS_KEY = 'data_center/contracts.json';
const STATE_KEY = 'data_center/contract_notify.json';
const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;
const MODULE = 'Contracts & Warranties';

let timer = null;
let firstTimer = null;

function notifyHour() {
    const h = Number(process.env.CONTRACT_NOTIFY_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

/**
 * One check. The notice state is committed before the message is sent, so a crash never sends twice.
 * -> { skipped } or { notices: number }
 */
async function tick(now = new Date(), { force = false } = {}) {
    const days = model.parseNotifyDays(process.env.CONTRACT_NOTIFY_DAYS);
    if (!days.length) return { skipped: 'disabled' };
    if (!force && now.getHours() < notifyHour()) return { skipped: 'too-early' };
    const contracts = readDataSync(CONTRACTS_KEY, []);
    let notices = [];
    mutateDocument(STATE_KEY, (state) => {
        const r = model.dueNotices(contracts, state, now, days);
        notices = r.notices;
        if (!r.changed) return false;
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, r.state);
        return true;
    }, { defaultValue: {}, fnName: 'contractNotify.tick', label: 'Contract expiry notices' });
    if (!notices.length) return { notices: 0 };
    const message = model.noticeMessage(notices);
    logger.appendLog(`[${MODULE}] ${message.replace(/\n/g, ' | ')}`);
    try {
        await logger.sendTelegramAlert(message, MODULE);
    } catch (err) {
        logger.appendLog(`[${MODULE}] Expiry notice failed: ${err.message}`);
    }
    return { notices: notices.length };
}

function initContractExpiryNotifier() {
    stop();
    const run = () => { tick().catch(err => console.error('[Contract Notify] Scheduler error:', err.message)); };
    firstTimer = setTimeout(run, FIRST_TICK_MS);
    timer = setInterval(run, TICK_MS);
    if (firstTimer.unref) firstTimer.unref();
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = null;
    firstTimer = null;
}

module.exports = { initContractExpiryNotifier, tick, stop, STATE_KEY };
