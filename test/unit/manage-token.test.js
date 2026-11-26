import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  newManageToken,
  hashManageToken,
  manageUrlOf,
  appointmentVersionOf,
} from '../../src/modules/appointments/manage-token.js';
import { MANAGE_TOKEN_RE, MANAGE_VERSION_RE } from '../../src/shared/appointments.js';

test('newManageToken: 43 caracteres base64url e hash = sha256 hex do token (critérios 4 e 5)', () => {
  const { token, tokenHash } = newManageToken();
  assert.equal(token.length, 43);
  assert.match(token, MANAGE_TOKEN_RE);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.equal(hashManageToken(token), tokenHash);
});

test('o gerador injetado é a única entrada: 32 bytes fixos dão o token esperado', () => {
  const sizes = [];
  const fixed = (size) => {
    sizes.push(size);
    return Buffer.alloc(size, 0xab);
  };
  const { token } = newManageToken(fixed);
  assert.deepEqual(sizes, [32]);
  assert.equal(token, Buffer.alloc(32, 0xab).toString('base64url'));
});

test('1.000 tokens: distintos, sem prefixo de 8 comum e sem ordem crescente (critério 4)', () => {
  const tokens = Array.from({ length: 1000 }, () => newManageToken().token);
  assert.equal(new Set(tokens).size, 1000);
  assert.equal(new Set(tokens.map((t) => t.slice(0, 8))).size, 1000);
  let ascending = 0;
  for (let i = 1; i < tokens.length; i++) if (tokens[i] > tokens[i - 1]) ascending += 1;
  const fraction = ascending / (tokens.length - 1);
  assert.ok(fraction > 0.4 && fraction < 0.6, String(fraction));
});

test('o token não contém id, e-mail nem início usados na reserva', () => {
  const values = ['3b241101-e2bb-4255-8caf-4136c566a962', 'ana@example.com', '2026-11-27T10:00', '2026', 'ana'];
  for (let i = 0; i < 200; i++) {
    const { token } = newManageToken();
    for (const v of values) assert.equal(token.includes(v), false);
  }
});

test('manageUrlOf usa a base dada, com ou sem barra final', () => {
  assert.equal(manageUrlOf('https://agendafacil.app', 'x'.repeat(43)), `https://agendafacil.app/agendamento/${'x'.repeat(43)}`);
  assert.equal(manageUrlOf('https://agendafacil.app//', 'abc'), 'https://agendafacil.app/agendamento/abc');
});

test('appointmentVersionOf: 43 base64url, muda com id, status e updated_at', () => {
  const base = { id: 'a', status: 'confirmed', updatedAt: '2026-11-26T12:00:00.000Z' };
  const v = appointmentVersionOf(base);
  assert.match(v, MANAGE_VERSION_RE);
  assert.equal(appointmentVersionOf({ ...base }), v);
  assert.notEqual(appointmentVersionOf({ ...base, id: 'b' }), v);
  assert.notEqual(appointmentVersionOf({ ...base, status: 'cancelled' }), v);
  assert.notEqual(appointmentVersionOf({ ...base, updatedAt: '2026-11-26T12:00:01.000Z' }), v);
});
