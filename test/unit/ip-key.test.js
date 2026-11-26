import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitKey } from '../../src/http/ip-key.js';

test('IPv4 e IPv4 mapeado em IPv6 dão o próprio IPv4', () => {
  assert.equal(rateLimitKey('1.2.3.4'), '1.2.3.4');
  assert.equal(rateLimitKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(rateLimitKey('::FFFF:1.2.3.4'), '1.2.3.4');
});

test('IPv6 é agrupado no /64 (AF-02 item 1, rotas públicas)', () => {
  const a = rateLimitKey('2001:db8:1:2:aaaa::1');
  assert.equal(a, '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), a);
  assert.equal(rateLimitKey('2001:0db8:0001:0002::5'), a);
  assert.equal(rateLimitKey('2001:DB8:1:2::9'), a);
  assert.notEqual(rateLimitKey('2001:db8:1:3::1'), a);
  assert.equal(rateLimitKey('2001:db8::1'), rateLimitKey('2001:db8::2'));
  assert.notEqual(rateLimitKey('2001:db8::1'), rateLimitKey('2001:db8:0:1::1'));
});

test('::1 tem chave própria e estável', () => {
  assert.equal(rateLimitKey('::1'), rateLimitKey('::1'));
  assert.match(rateLimitKey('::1'), /\/64$/);
  assert.notEqual(rateLimitKey('::1'), 'ip:unknown');
});

test('entrada inválida dá ip:unknown', () => {
  for (const ip of ['', 'abc', '1.2.3', '1.2.3.4.5', '2001:db8:::1', undefined, null, 42]) {
    assert.equal(rateLimitKey(ip), 'ip:unknown', String(ip));
  }
});
