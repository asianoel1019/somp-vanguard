import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PAID_FEATURE_INFO, readStoredLicense, storeLicense, isLockedFlag, isFree, licenseLabel, isLicenseError,
    REMINDER_DAYS, expiryTone, expiryText, reminderThreshold, reminderKey,
    shouldShowReminder, markReminderShown, openLicensePage, SETTINGS_CATEGORY_EVENT,
} from './licenseUtils.js';

const memoryStorage = (init = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('PAID_FEATURE_INFO covers the paid feature keys', () => {
    assert.deepEqual(Object.keys(PAID_FEATURE_INFO).sort(), ['adControl', 'aiAgent', 'dataCenter', 'install', 'ipam', 'manage_self_healing', 'monitorAgents', 'monitorAlerts', 'monitorLinuxLog', 'monitorScout', 'monitorWinEvent', 'netSearch', 'networkDevice', 'nutanixClone', 'remoteCmd', 'scheduler', 'workflow']);
    for (const v of Object.values(PAID_FEATURE_INFO)) assert.ok(v.name && v.desc);
});

test('read / store the license kept with the signed-in user', () => {
    const s = memoryStorage({ user: JSON.stringify({ username: 'admin', license: { edition: 'free', locked: ['ipam'] } }) });
    assert.deepEqual(readStoredLicense(s), { edition: 'free', locked: ['ipam'] });
    storeLicense({ edition: 'paid', customer: 'Example Test Co.', locked: [] }, s);
    assert.equal(JSON.parse(s.getItem('user')).username, 'admin');
    assert.equal(readStoredLicense(s).edition, 'paid');
    assert.equal(readStoredLicense(memoryStorage()), null);
    assert.equal(readStoredLicense(memoryStorage({ user: 'not json' })), null);
});

test('locks, labels and errors', () => {
    const free = { edition: 'free', locked: ['ipam', 'dataCenter'] };
    assert.equal(isLockedFlag('ipam', free), true);
    assert.equal(isLockedFlag('serverList', free), false);
    assert.equal(isLockedFlag('ipam', null), false); // unknown -> no lock shown (the API still enforces)
    assert.equal(isFree(free), true);
    assert.equal(isFree(null), false);
    assert.equal(licenseLabel(free), 'Free');
    assert.equal(licenseLabel({ edition: 'paid', customer: 'Example Test Co.' }), 'Licensed to Example Test Co.');
    assert.equal(licenseLabel(null), '');
    assert.equal(isLicenseError({ response: { data: { code: 'LICENSE_REQUIRED' } } }), true);
    assert.equal(isLicenseError(new Error('x')), false);
});

test('expiry tone, text, reminder threshold and key', () => {
    assert.deepEqual(REMINDER_DAYS, [30, 14, 7, 3, 2, 1]);
    assert.equal(expiryTone(0), 'danger');
    assert.equal(expiryTone(7), 'danger');
    assert.equal(expiryTone(8), 'warning');
    assert.equal(expiryTone(30), 'warning');
    assert.equal(expiryTone(31), 'normal');
    assert.equal(expiryTone(null), 'normal');
    const paid = (daysLeft) => ({ edition: 'paid', expiresAt: '2027-01-31', daysLeft });
    assert.equal(expiryText(paid(45)), 'Expires 2027-01-31 (45 days left)');
    assert.equal(expiryText(paid(1)), 'Expires 2027-01-31 (1 day left)');
    assert.equal(expiryText(paid(0)), 'Expires 2027-01-31 (expires today)');
    assert.equal(expiryText({ edition: 'free', expiredAt: '2026-11-01' }), 'Expired on 2026-11-01');
    assert.equal(expiryText({ edition: 'free', expiredAt: '' }), '');
    assert.equal(expiryText({ edition: 'paid', expiresAt: '', daysLeft: null }), '');
    assert.equal(expiryText(null), '');
    assert.equal(reminderThreshold(0), 1);
    assert.equal(reminderThreshold(1), 1);
    assert.equal(reminderThreshold(2), 2);
    assert.equal(reminderThreshold(7), 7);
    assert.equal(reminderThreshold(8), 14);
    assert.equal(reminderThreshold(30), 30);
    assert.equal(reminderThreshold(31), null);
    assert.equal(reminderThreshold(null), null);
    assert.equal(reminderThreshold(undefined), null);
    assert.equal(reminderKey({ edition: 'paid', licenseId: 'LIC-1', daysLeft: 8 }), 'somp.licenseReminder:LIC-1:14');
    assert.equal(reminderKey({ edition: 'paid', licenseId: 'LIC-1', daysLeft: 40 }), '');
    assert.equal(reminderKey({ edition: 'free', licenseId: 'LIC-1', daysLeft: null }), '');
    assert.equal(reminderKey(null), '');
});

test('the reminder dialog shows once per license and threshold', () => {
    const storage = memoryStorage();
    const at = (daysLeft, licenseId = 'L-2027-0001') => ({ edition: 'paid', licenseId, daysLeft, expiresAt: '2027-12-31' });
    assert.equal(shouldShowReminder(at(40), storage), false, 'more than 30 days left');
    assert.equal(shouldShowReminder(at(30), storage), true);
    markReminderShown(at(30), storage);
    assert.equal(shouldShowReminder(at(30), storage), false, 'same threshold: not again');
    assert.equal(shouldShowReminder(at(20), storage), false, '20 days left is still the 30-day threshold');
    assert.equal(shouldShowReminder(at(14), storage), true, 'next threshold');
    markReminderShown(at(14), storage);
    assert.equal(shouldShowReminder(at(8), storage), false);
    assert.equal(shouldShowReminder(at(7), storage), true);
    assert.equal(shouldShowReminder(at(14, 'L-2027-0002'), storage), true, 'another license starts clean');
    assert.equal(shouldShowReminder({ edition: 'free', licenseId: '', daysLeft: null }, storage), false);
    markReminderShown({ edition: 'free', licenseId: '', daysLeft: null }, storage); // no key: nothing stored, no throw
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    assert.equal(shouldShowReminder(at(3), broken), true, 'unreadable storage still shows the reminder');
    assert.doesNotThrow(() => markReminderShown(at(3), broken));
    assert.equal(shouldShowReminder(at(3), null), true);
});

test('openLicensePage stores the deep link and tells an open Settings screen', (t) => {
    const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
    t.after(() => { globalThis.window = saved.window; globalThis.sessionStorage = saved.sessionStorage; });
    const session = memoryStorage();
    globalThis.sessionStorage = session;
    globalThis.window = new EventTarget();
    const seen = [];
    window.addEventListener(SETTINGS_CATEGORY_EVENT, (e) => seen.push(e.detail.category));
    openLicensePage();
    assert.equal(session.getItem('somp.settings.category'), 'license');
    assert.deepEqual(seen, ['license']);
    delete globalThis.window; delete globalThis.sessionStorage;
    assert.doesNotThrow(() => openLicensePage());
});
