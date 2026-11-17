import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROLE_LABELS, validatePassword, validateUsername, statusLabel, quotaText, roleFull, defaultFormRole, rowLimits, QUOTA_MESSAGE, PAID_LOCKED_MESSAGE,
} from './localAccountsUtils.js';

const freeList = { edition: 'free', quota: { SuperAdmin: { used: 1, limit: 1 }, Operator: { used: 0, limit: 1 }, Viewer: { used: 1, limit: 1 } } };
const paidList = { edition: 'paid', quota: { SuperAdmin: { used: 3, limit: null }, Operator: { used: 0, limit: null }, Viewer: { used: 0, limit: null } } };

test('ROLE_LABELS', () => {
    assert.deepEqual(ROLE_LABELS, { SuperAdmin: 'Admin (SuperAdmin)', Operator: 'Operator', Viewer: 'Viewer' });
});

test('validatePassword mirrors the backend rule', () => {
    assert.equal(validatePassword('Correct-horse-42'), '');
    assert.notEqual(validatePassword('short1A'), '');
    assert.notEqual(validatePassword('onlyletterslong'), '');
    assert.notEqual(validatePassword('123456789012'), '');
    assert.notEqual(validatePassword('a1'.repeat(129)), '');
    assert.notEqual(validatePassword(undefined), '');
});

test('validateUsername mirrors the backend rule', () => {
    assert.equal(validateUsername('alice.test-1_', 'admin'), '');
    assert.notEqual(validateUsername('', 'admin'), '');
    assert.notEqual(validateUsername('bad name', 'admin'), '');
    assert.notEqual(validateUsername('a'.repeat(65), 'admin'), '');
    assert.notEqual(validateUsername('ADMIN', 'admin'), '');
    assert.equal(validateUsername('ADMIN', ''), '');
});

test('statusLabel', () => {
    assert.deepEqual(statusLabel({ active: true }), { text: 'Active', tone: 'success', hint: '' });
    assert.equal(statusLabel({ active: false, inactiveReason: 'disabled' }).text, 'Disabled');
    assert.equal(statusLabel({ active: false, inactiveReason: 'disabled' }).tone, 'muted');
    assert.deepEqual(statusLabel({ active: false, inactiveReason: 'free edition' }), {
        text: 'Inactive on free edition', tone: 'warning',
        hint: 'Created on the paid edition; it works again once a license is applied.',
    });
});

test('quotaText', () => {
    assert.equal(quotaText(paidList), '');
    assert.equal(quotaText(null), '');
    assert.equal(quotaText(freeList), 'Free edition: Admin 1/1 · Operator 0/1 · Viewer 1/1');
});

test('roleFull', () => {
    assert.equal(roleFull(freeList, 'SuperAdmin'), true);
    assert.equal(roleFull(freeList, 'Operator'), false);
    assert.equal(roleFull(paidList, 'SuperAdmin'), false);
    assert.equal(roleFull(null, 'Viewer'), false);
});

test('defaultFormRole: the least privileged role with room', () => {
    assert.equal(defaultFormRole(paidList), 'Viewer');
    assert.equal(defaultFormRole(null), 'Viewer');
    assert.equal(defaultFormRole(freeList), 'Operator'); // Viewer full
    const allFull = { edition: 'free', quota: { SuperAdmin: { used: 1, limit: 1 }, Operator: { used: 1, limit: 1 }, Viewer: { used: 1, limit: 1 } } };
    assert.equal(defaultFormRole(allFull), 'Viewer');
    const onlyAdmin = { edition: 'free', quota: { SuperAdmin: { used: 0, limit: 1 }, Operator: { used: 1, limit: 1 }, Viewer: { used: 1, limit: 1 } } };
    assert.equal(defaultFormRole(onlyAdmin), 'SuperAdmin');
    assert.equal(defaultFormRole(freeList, 'Operator'), 'Operator');
});

test('rowLimits: free edition refuses paid-created changes and full roles', () => {
    const none = rowLimits(paidList, { createdEdition: 'paid', role: 'Viewer', disabled: true });
    assert.equal(none.locked, '');
    assert.equal(none.enable, '');
    assert.equal(none.roleOption('SuperAdmin'), '');
    const paidMade = rowLimits(freeList, { createdEdition: 'paid', role: 'Viewer', disabled: false });
    assert.equal(paidMade.locked, PAID_LOCKED_MESSAGE);
    assert.equal(paidMade.enable, PAID_LOCKED_MESSAGE);
    const disabledViewer = rowLimits(freeList, { createdEdition: 'free', role: 'Viewer', disabled: true });
    assert.equal(disabledViewer.enable, QUOTA_MESSAGE);           // Viewer slot taken by someone else
    assert.equal(disabledViewer.roleOption('SuperAdmin'), '');     // a disabled account can change role freely
    const activeOperator = rowLimits(freeList, { createdEdition: 'free', role: 'Operator', disabled: false });
    assert.equal(activeOperator.enable, '');
    assert.equal(activeOperator.roleOption('SuperAdmin'), QUOTA_MESSAGE);
    assert.equal(activeOperator.roleOption('Operator'), '');
});
