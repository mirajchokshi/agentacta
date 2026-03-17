'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// --- Inline the helpers under test (same logic as index.js) ---

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      crypto.timingSafeEqual(Buffer.alloc(ba.length), Buffer.alloc(ba.length));
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function makeIsAuthenticated(token, authEnabled = true) {
  return function isAuthenticated(req, query) {
    if (!authEnabled) return true;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      if (safeEqual(authHeader.slice(7).trim(), token)) return true;
    }
    const cookies = parseCookies(req);
    if (cookies['agentacta_token'] && safeEqual(cookies['agentacta_token'], token)) return true;
    if (query.token && safeEqual(query.token, token)) return true;
    return false;
  };
}

// --- Tests ---

describe('safeEqual', () => {
  test('returns true for identical strings', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
  });

  test('returns false for different strings of same length', () => {
    assert.equal(safeEqual('abc', 'xyz'), false);
  });

  test('returns false for different lengths', () => {
    assert.equal(safeEqual('short', 'muchlongerstring'), false);
  });

  test('returns false for empty vs non-empty', () => {
    assert.equal(safeEqual('', 'token'), false);
  });

  test('returns true for empty vs empty', () => {
    assert.equal(safeEqual('', ''), true);
  });

  test('handles hex tokens of expected length', () => {
    const token = crypto.randomBytes(32).toString('hex');
    assert.equal(safeEqual(token, token), true);
    assert.equal(safeEqual(token, crypto.randomBytes(32).toString('hex')), false);
  });
});

describe('parseCookies', () => {
  test('parses a single cookie', () => {
    const req = { headers: { cookie: 'agentacta_token=abc123' } };
    assert.deepEqual(parseCookies(req), { agentacta_token: 'abc123' });
  });

  test('parses multiple cookies', () => {
    const req = { headers: { cookie: 'a=1; b=2; c=3' } };
    assert.deepEqual(parseCookies(req), { a: '1', b: '2', c: '3' });
  });

  test('decodes URI-encoded cookie values', () => {
    const encoded = encodeURIComponent('token with spaces');
    const req = { headers: { cookie: `agentacta_token=${encoded}` } };
    assert.equal(parseCookies(req)['agentacta_token'], 'token with spaces');
  });

  test('returns empty object when no cookie header', () => {
    const req = { headers: {} };
    assert.deepEqual(parseCookies(req), {});
  });

  test('handles cookie with no value', () => {
    const req = { headers: { cookie: 'novalue' } };
    assert.deepEqual(parseCookies(req), {});
  });
});

describe('isAuthenticated', () => {
  const token = crypto.randomBytes(32).toString('hex');
  const isAuthenticated = makeIsAuthenticated(token);

  test('auth disabled: always returns true', () => {
    const isAuthOff = makeIsAuthenticated(token, false);
    const req = { headers: {} };
    assert.equal(isAuthOff(req, {}), true);
  });

  test('Bearer header: valid token', () => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    assert.equal(isAuthenticated(req, {}), true);
  });

  test('Bearer header: invalid token', () => {
    const req = { headers: { authorization: 'Bearer wrongtoken' } };
    assert.equal(isAuthenticated(req, {}), false);
  });

  test('cookie: valid token', () => {
    const req = { headers: { cookie: `agentacta_token=${encodeURIComponent(token)}` } };
    assert.equal(isAuthenticated(req, {}), true);
  });

  test('cookie: invalid token', () => {
    const req = { headers: { cookie: 'agentacta_token=badtoken' } };
    assert.equal(isAuthenticated(req, {}), false);
  });

  test('query param: valid token', () => {
    const req = { headers: {} };
    assert.equal(isAuthenticated(req, { token }), true);
  });

  test('query param: invalid token', () => {
    const req = { headers: {} };
    assert.equal(isAuthenticated(req, { token: 'wrongtoken' }), false);
  });

  test('no credentials: returns false', () => {
    const req = { headers: {} };
    assert.equal(isAuthenticated(req, {}), false);
  });
});
