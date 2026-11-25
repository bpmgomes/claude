import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';

test('hash bcrypt: diferente da senha, começa com $2 e é verificável (critério 11)', async () => {
  const hash = await hashPassword('abcd1234', 4);
  assert.notEqual(hash, 'abcd1234');
  assert.ok(hash.startsWith('$2'), hash);
  assert.equal(await verifyPassword('abcd1234', hash), true);
  assert.equal(await verifyPassword('abcd12345', hash), false);
});

test('hashes da mesma senha diferem (salt)', async () => {
  const a = await hashPassword('abcd1234', 4);
  const b = await hashPassword('abcd1234', 4);
  assert.notEqual(a, b);
});

test('verifyPassword com entradas inválidas devolve false', async () => {
  assert.equal(await verifyPassword(undefined, 'x'), false);
  assert.equal(await verifyPassword('abcd1234', null), false);
});
