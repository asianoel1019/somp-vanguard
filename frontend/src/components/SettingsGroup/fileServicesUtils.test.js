import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FILE_SERVICES_CATEGORY, resolveCategoryLink, defaultPortForType, emptyDeviceForm, deviceToForm,
    validateNasDeviceForm, buildDevicePayload, buildTestPayload, deviceErrorMessage, isShareEditor
} from './fileServicesUtils.js';

test('legacy sftp category maps to File Services / SFTP Servers', () => {
    assert.deepEqual(resolveCategoryLink('sftp'), { category: FILE_SERVICES_CATEGORY, tab: 'sftp' });
    assert.deepEqual(resolveCategoryLink('fileservices'), { category: FILE_SERVICES_CATEGORY, tab: 'sftp' });
    assert.deepEqual(resolveCategoryLink('fileservices', 'nas'), { category: FILE_SERVICES_CATEGORY, tab: 'nas' });
    assert.deepEqual(resolveCategoryLink('fileservices', 'bogus'), { category: FILE_SERVICES_CATEGORY, tab: 'sftp' });
    assert.deepEqual(resolveCategoryLink('environments'), { category: 'environments', tab: null });
    assert.equal(resolveCategoryLink(null), null);
    assert.equal(resolveCategoryLink(''), null);
});

test('default ports per driver type', () => {
    assert.equal(defaultPortForType('synology'), 5000);
    assert.equal(defaultPortForType('qnap'), 8080);
    assert.equal(defaultPortForType('windows'), '');
    assert.equal(defaultPortForType('linux'), '');
});

test('deviceToForm never carries a password', () => {
    const f = deviceToForm({ id: 'a', name: 'N', type: 'qnap', ip: '1.1.1.1', port: 8080, username: 'u', hasPassword: true });
    assert.equal(f.password, '');
    assert.equal(f.name, 'N');
    assert.equal(emptyDeviceForm().type, 'synology');
});

test('validateNasDeviceForm', () => {
    const base = { name: 'NAS', type: 'synology', ip: '10.0.0.1', port: 5000, username: 'u', password: 'p' };
    assert.equal(validateNasDeviceForm(base, [], null), null);
    assert.match(validateNasDeviceForm({ ...base, name: ' ' }, [], null), /name/i);
    assert.match(validateNasDeviceForm({ ...base, name: 'x'.repeat(65) }, [], null), /64/);
    assert.match(validateNasDeviceForm({ ...base, type: 'ftp' }, [], null), /type/i);
    assert.match(validateNasDeviceForm({ ...base, ip: 'bad host' }, [], null), /IP|host/i);
    assert.match(validateNasDeviceForm({ ...base, ip: '300.1.1.1' }, [], null), /IP|host/i);
    assert.equal(validateNasDeviceForm({ ...base, ip: 'nas01.corp.local' }, [], null), null);
    assert.match(validateNasDeviceForm({ ...base, port: 0 }, [], null), /port/i);
    assert.match(validateNasDeviceForm({ ...base, port: 70000 }, [], null), /port/i);
    assert.equal(validateNasDeviceForm({ ...base, port: '' }, [], null), null);
    assert.match(validateNasDeviceForm({ ...base, username: 'u'.repeat(129) }, [], null), /128/);
    assert.match(validateNasDeviceForm({ ...base, username: '' }, [], null), /username/i);
    // password required on create, optional on edit
    assert.match(validateNasDeviceForm({ ...base, password: '' }, [], null), /password/i);
    assert.equal(validateNasDeviceForm({ ...base, password: '' }, [{ id: 'a', name: 'Other' }], 'a'), null);
    // duplicate name (case-insensitive), except self
    assert.match(validateNasDeviceForm(base, [{ id: 'z', name: 'nas' }], null), /already/i);
    assert.equal(validateNasDeviceForm(base, [{ id: 'z', name: 'nas' }], 'z'), null);
});

test('buildDevicePayload omits a blank password and coerces port', () => {
    const p = buildDevicePayload({ name: ' N ', type: 'qnap', ip: ' 1.1.1.1 ', port: '8080', username: 'u', password: '' });
    assert.deepEqual(p, { name: 'N', type: 'qnap', ip: '1.1.1.1', port: 8080, username: 'u' });
    assert.equal('password' in p, false);
    const q = buildDevicePayload({ name: 'N', type: 'windows', ip: 'h', port: '', username: 'u', password: 'secret' });
    assert.equal(q.password, 'secret');
    assert.equal('port' in q, false);
});

test('buildTestPayload sends id for stored-password reuse', () => {
    const p = buildTestPayload({ name: 'N', type: 'qnap', ip: '1.1.1.1', port: 8080, username: 'u', password: '' }, 'dev-1');
    assert.equal(p.id, 'dev-1');
    assert.equal('password' in p, false);
    assert.equal(buildTestPayload({ name: 'N', type: 'qnap', ip: '1.1.1.1', username: 'u', password: 'x' }, null).id, undefined);
});

test('blank port on edit is sent as null; share editors are Operator/SuperAdmin only', () => {
    const f = { name: 'N', type: 'windows', ip: 'h', port: '', username: 'u', password: '' };
    assert.equal(buildDevicePayload(f, true).port, null);
    assert.equal('port' in buildDevicePayload(f, false), false);
    assert.equal(buildTestPayload(f, 'id1').port, null);
    assert.equal(isShareEditor('Operator'), true);
    assert.equal(isShareEditor('SuperAdmin'), true);
    assert.equal(isShareEditor('Viewer'), false);
    assert.equal(isShareEditor(undefined), false);
});

test('deviceErrorMessage prefers backend message', () => {
    assert.equal(deviceErrorMessage({ response: { data: { error: 'Bad port' } } }, 'fallback'), 'Bad port');
    assert.equal(deviceErrorMessage({ response: { data: { message: 'offline' } } }, 'fallback'), 'offline');
    assert.equal(deviceErrorMessage({}, 'fallback'), 'fallback');
});
