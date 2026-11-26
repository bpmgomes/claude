import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helmetHeadersOf, createSecurityHeaders, SECURITY_HEADERS_PROBE_URL } from '../../src/http/security-headers.js';

const HELMET = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

test('helmetHeadersOf descarta transporte, corpo, cache e rate limit', () => {
  const out = helmetHeadersOf({
    ...HELMET,
    'content-type': 'application/json',
    'content-length': 10,
    date: 'x',
    connection: 'keep-alive',
    'cache-control': 'no-store',
    'x-ratelimit-limit': '3',
    'set-cookie': ['a=1'],
  });
  assert.deepEqual(out, HELMET);
  assert.ok(Object.isFrozen(out));
});

test('createSecurityHeaders: apply define o que foi capturado; sonda sem helmet lança', () => {
  const registry = createSecurityHeaders();
  const set = {};
  const reply = { header: (k, v) => (set[k] = v) };
  registry.apply(reply);
  assert.deepEqual(set, {});
  registry.capture({ ...HELMET, date: 'x' });
  registry.apply(reply);
  assert.deepEqual(set, HELMET);
  assert.throws(() => createSecurityHeaders().capture({ 'content-type': 'text/plain' }), /helmet/);
  assert.match(SECURITY_HEADERS_PROBE_URL, /^\/api\//);
});
