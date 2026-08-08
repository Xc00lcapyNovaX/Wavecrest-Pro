import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'test-secret-do-not-use-in-prod';
process.env.API_KEY_ENCRYPTION_KEY ??= 'test-key-secret';

const {
  createSessionValue, verifySessionValue,
  generateApiKey, hashApiKey, parseCookies
} = await import('../lib/auth.js');

test('session round-trip: sign then verify returns the user id', () => {
  const value = createSessionValue('user-123');
  assert.equal(verifySessionValue(value), 'user-123');
});

test('tampered session payload is rejected', () => {
  const value = createSessionValue('user-123');
  const [payload, sig] = value.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'user-999', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifySessionValue(`${forged}.${sig}`), null);
  assert.equal(verifySessionValue(`${payload}.AAAA${sig.slice(4)}`), null);
});

test('expired session is rejected', () => {
  const value = createSessionValue('user-123', Date.now() - 31 * 24 * 3600 * 1000 - 1);
  assert.equal(verifySessionValue(value), null);
});

test('malformed session values are rejected, not thrown', () => {
  for (const bad of [null, undefined, '', 'no-dot', 'a.b.c', '!!!.###']) {
    assert.equal(verifySessionValue(bad), null);
  }
});

test('API keys: format, hash determinism, uniqueness', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a.key, /^wc_live_[0-9a-f]{48}$/);
  assert.equal(a.prefix, a.key.slice(0, 16));
  assert.equal(hashApiKey(a.key), a.hash);        // deterministic
  assert.notEqual(a.hash, b.hash);                 // unique
  assert.ok(!a.hash.includes(a.key.slice(8, 20))); // hash leaks nothing
});

test('parseCookies handles multiple cookies and values with =', () => {
  const req = { headers: { cookie: 'a=1; wc_session=abc.def; token=x=y' } };
  const c = parseCookies(req);
  assert.equal(c.wc_session, 'abc.def');
  assert.equal(c.token, 'x=y');
  assert.deepEqual(parseCookies({ headers: {} }), {});
});
