const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'test-jwt-secret';

function mockRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function signToken(payload) {
    return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

module.exports = { mockRes, signToken, TEST_JWT_SECRET };
