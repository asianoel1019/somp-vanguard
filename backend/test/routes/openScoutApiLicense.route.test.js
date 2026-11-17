require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { setPaid, setFree } = require('../helpers/license');

// Accept every request at the key check: this test is about the license gate behind it
require.cache[require.resolve('../../middleware/openApiAuth')] = {
    id: 'openApiAuth-stub', loaded: true, exports: { openApiAuth: () => (req, res, next) => next() },
};

let app;
test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json());
    app.use('/api/v1/open', require('../../routes/openScoutApi'));
});
test.after(async () => { setPaid(); await dbManager.closeDB(); });

test('the Scout Open API is a paid feature', async () => {
    setFree();
    const free = await request(app).get('/api/v1/open/status');
    assert.equal(free.status, 403);
    assert.equal(free.body.code, 'LICENSE_REQUIRED');
    assert.equal(free.body.error, 'The Scout Open API requires a paid license.');
    setPaid();
    const paid = await request(app).get('/api/v1/open/status');
    assert.notEqual(paid.body && paid.body.code, 'LICENSE_REQUIRED');
});
