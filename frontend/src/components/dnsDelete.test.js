import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteKey, defaultDeleteSelection, deleteItems } from './dnsDelete.js';

const preview = [
    { fqdn: 'app.example.test', serverName: 'DNS-1', status: 'Ready', records: [
        { type: 'A', data: '192.0.2.10', ttl: 3600, deletable: true },
        { type: 'TXT', data: 'note', ttl: 300, deletable: true },
        { type: 'NS', data: 'ns1.example.test', ttl: 3600, deletable: false },
    ] },
    { fqdn: 'gone.example.test', serverName: 'DNS-1', status: 'Not found', records: [] },
    { fqdn: 'alias.example.test', serverName: 'DNS-2', status: 'Ready', records: [{ type: 'CNAME', data: 'app.example.test', ttl: 3600, deletable: true }] },
];

test('A / AAAA / CNAME start ticked; TXT and undeletable records do not', () => {
    assert.deepEqual(defaultDeleteSelection(preview), ['0:0', '2:0']);
    assert.deepEqual(defaultDeleteSelection(null), []);
});

test('the request names each ticked record exactly; undeletable ones never go out', () => {
    const sel = new Set([deleteKey(0, 1), deleteKey(0, 2), deleteKey(2, 0)]);
    assert.deepEqual(deleteItems(preview, sel), [
        { fqdn: 'app.example.test', type: 'TXT', data: 'note' },
        { fqdn: 'alias.example.test', type: 'CNAME', data: 'app.example.test' },
    ]);
    assert.deepEqual(deleteItems(preview, new Set()), []);
});
