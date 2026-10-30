import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatDuration, isNewHost, describeScope, scanTriggerText, scanFlags, describeDegraded, changeText, buildExportQuery, exportFileName,
    parsePorts, keepConfiguredSubnetSettings, subnetSettingsToForm, formToSubnetSettings, buildSubnetSettingsPayload, probeToForm, formToProbe, buildProfileBody, apiErrorText
} from './inventoryHistoryUtils.js';

test('formatDuration', () => {
    assert.equal(formatDuration(null), '-');
    assert.equal(formatDuration(400), '<1s');
    assert.equal(formatDuration(45000), '45s');
    assert.equal(formatDuration(125000), '2m 5s');
    assert.equal(formatDuration(3723000), '1h 2m 3s');
});

test('isNewHost is true within 7 days only', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    assert.equal(isNewHost({ firstSeen: '2026-10-15T00:00:00Z' }, now), true);
    assert.equal(isNewHost({ firstSeen: '2026-10-01T00:00:00Z' }, now), false);
    assert.equal(isNewHost({}, now), false);
    assert.equal(isNewHost({ firstSeen: 'garbage' }, now), false);
});

test('scan row helpers', () => {
    assert.equal(describeScope({ scope: { ip: '10.1.2.3' } }), 'Host 10.1.2.3');
    assert.equal(describeScope({ scope: { subnet: '10.1.2' } }), 'Subnet 10.1.2');
    assert.equal(describeScope({ scope: null }), 'All subnets');
    assert.equal(scanTriggerText({ trigger: 'manual', requestedBy: 'alice' }), 'Manual by alice');
    assert.equal(scanTriggerText({ trigger: 'schedule', requestedBy: 'SYSTEM' }), 'Scheduled');
    const flags = scanFlags({ aborted: true, partial: true, degradedSubnets: [{ subnet: '10.1.2', missed: 9, previouslyOnline: 10 }] }).map(f => f.label);
    assert.deepEqual(flags, ['ABORTED', 'PARTIAL', 'DEGRADED x1']);
    assert.equal(describeDegraded({ degradedSubnets: [{ subnet: '10.1.2', missed: 9, previouslyOnline: 10 }] }), '10.1.2: 9/10 hosts did not answer');
    assert.equal(changeText({ oldValue: null, newValue: 'online' }), '— → online');
});

test('buildExportQuery passes the current filters', () => {
    assert.equal(buildExportQuery({}), 'format=csv');
    assert.equal(buildExportQuery({ statusFilter: 'offline', selectedSubnet: '10.1.2', filter: ' web 01 ' }), 'format=csv&status=offline&subnet=10.1.2&q=web+01');
    assert.equal(buildExportQuery({ statusFilter: 'linux' }), 'format=csv&os=linux');
    assert.equal(buildExportQuery({ statusFilter: 'unknown' }), 'format=csv&os=unknown');
});

test('exportFileName', () => {
    assert.equal(exportFileName('attachment; filename="server-inventory-20261020.csv"'), 'server-inventory-20261020.csv');
    assert.equal(exportFileName(undefined, new Date('2026-10-20T10:00:00Z')), 'server-inventory-20261020.csv');
});

test('parsePorts validates', () => {
    assert.deepEqual(parsePorts('22, 3389 22'), { ports: [22, 3389], error: null });
    assert.match(parsePorts('abc').error, /not a port/);
    assert.match(parsePorts('70000').error, /between 1 and 65535/);
    assert.match(parsePorts('1,2,3,4,5,6,7,8,9,10,11').error, /At most 10/);
});

test('subnet settings form round trip drops empty overrides', () => {
    const form = subnetSettingsToForm({ concurrency: 8, tcpPorts: [22], autoSyncPrometheus: false, credentialProfile: 'dmz', timezoneOffset: 8 });
    assert.deepEqual(form, { concurrency: '8', tcpPorts: '22', autoSyncPrometheus: 'off', credentialProfile: 'dmz', timezoneOffset: '8' });
    assert.deepEqual(formToSubnetSettings(form).entry, { concurrency: 8, tcpPorts: [22], autoSyncPrometheus: false, credentialProfile: 'dmz', timezoneOffset: 8 });
    assert.deepEqual(formToSubnetSettings(subnetSettingsToForm(undefined)).entry, {});
    assert.match(formToSubnetSettings({ concurrency: '100' }).error, /1 and 64/);
    assert.match(formToSubnetSettings({ timezoneOffset: '20' }).error, /-12 and 14/);
    const r = buildSubnetSettingsPayload({ '10.1.2': { concurrency: '4' }, '10.1.3': {} });
    assert.deepEqual(r.settings, { '10.1.2': { concurrency: 4 } });
    assert.match(buildSubnetSettingsPayload({ '10.1.2': { concurrency: 'x' } }).error, /^10\.1\.2:/);
});

test('probe form defaults and validation', () => {
    const f = probeToForm(undefined);
    assert.equal(f.concurrencyPerSubnet, '16');
    assert.equal(f.tcpPorts, '22, 3389, 5985, 5986');
    assert.deepEqual(formToProbe(f).probe, { concurrencyPerSubnet: 16, subnetConcurrency: 4, missesBeforeOffline: 2, outageThresholdPct: 50, tcpPorts: [22, 3389, 5985, 5986] });
    assert.match(formToProbe({ ...f, outageThresholdPct: '5' }).error, /outageThresholdPct/);
    assert.match(formToProbe({ ...f, tcpPorts: '' }).error, /tcpPorts/);
});

test('buildProfileBody: blank password = keep, explicit clear = empty string', () => {
    assert.deepEqual(buildProfileBody({ winUser: ' a ', linuxUser: 'b', winPassword: '', linuxPassword: '' }), { winUser: 'a', linuxUser: 'b' });
    assert.deepEqual(buildProfileBody({ winUser: 'a', winPassword: 'x', linuxPassword: '', clearLinuxPassword: true }), { winUser: 'a', winPassword: 'x', linuxPassword: '' });
});

test('apiErrorText', () => {
    assert.equal(apiErrorText({ response: { data: { error: 'x', errors: ['a', 'b'] } } }), 'a\nb');
    assert.equal(apiErrorText({ response: { data: { error: 'In use', code: 'PROFILE_IN_USE', subnets: ['10.1.2'] } } }), 'In use (10.1.2)');
    assert.equal(apiErrorText({ message: 'boom' }), 'boom');
});

test('keepConfiguredSubnetSettings drops rows of subnets that are no longer configured', () => {
    const settings = { '10.1.2': { concurrency: 4 }, '10.1.3:1~9': { concurrency: 2 }, '10.9.9': { concurrency: 1 } };
    assert.deepEqual(keepConfiguredSubnetSettings(settings, ['10.1.2:5~9', '10.1.3']), { '10.1.2': { concurrency: 4 }, '10.1.3:1~9': { concurrency: 2 } });
});
