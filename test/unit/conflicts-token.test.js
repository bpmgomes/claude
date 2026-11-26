import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  signConflictsToken,
  verifyConflictsToken,
  crypto as tokenCrypto,
  CONFLICTS_TOKEN_RE,
  CONFLICTS_TOKEN_TTL_SECONDS,
} from '../../src/modules/time-blocks/conflicts-token.js';

const SECRET = 's'.repeat(43);
const NOW = Date.parse('2026-12-01T12:00:00.000Z');
const CLAIMS = Object.freeze({
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  professionalId: '33333333-3333-4333-8333-333333333333',
  startsAt: '2026-12-24T17:00:00.000Z',
  endsAt: '2026-12-24T21:00:00.000Z',
  versionKey: 'k'.repeat(43),
});

test('assina e verifica; formato v1.<exp>.<mac> de 57 caracteres e prazo de 10 min', () => {
  const token = signConflictsToken(SECRET, CLAIMS, NOW);
  assert.match(token, CONFLICTS_TOKEN_RE);
  assert.equal(token.length, 57);
  assert.equal(CONFLICTS_TOKEN_TTL_SECONDS, 600);
  assert.equal(Number(token.slice(3, 13)), NOW / 1000 + 600);
  assert.equal(verifyConflictsToken(SECRET, token, CLAIMS, NOW), true);
});

test('mudar usuário, negócio, alvo (null contra UUID), startsAt, endsAt ou versionKey: false', () => {
  const token = signConflictsToken(SECRET, CLAIMS, NOW);
  for (const over of [
    { userId: '44444444-4444-4444-8444-444444444444' },
    { businessId: '44444444-4444-4444-8444-444444444444' },
    { professionalId: null },
    { startsAt: '2026-12-24T17:15:00.000Z' },
    { endsAt: '2026-12-24T21:15:00.000Z' },
    { versionKey: 'j'.repeat(43) },
  ]) {
    assert.equal(verifyConflictsToken(SECRET, token, { ...CLAIMS, ...over }, NOW), false, JSON.stringify(over));
  }
  const forAll = signConflictsToken(SECRET, { ...CLAIMS, professionalId: null }, NOW);
  assert.equal(verifyConflictsToken(SECRET, forAll, CLAIMS, NOW), false);
  assert.equal(verifyConflictsToken(SECRET, forAll, { ...CLAIMS, professionalId: null }, NOW), true);
});

test('expirado com relógio + 601 s; ainda válido com + 599 s', () => {
  const token = signConflictsToken(SECRET, CLAIMS, NOW);
  assert.equal(verifyConflictsToken(SECRET, token, CLAIMS, NOW + 599_000), true);
  assert.equal(verifyConflictsToken(SECRET, token, CLAIMS, NOW + 601_000), false);
});

test('formato inválido, formato antigo de 43 caracteres, null, número e 10.000 caracteres: false sem lançar', () => {
  for (const bad of ['', 'x', 'a'.repeat(43), null, undefined, 42, {}, 'v1.' + '9'.repeat(10_000), 'v1.12345.abc']) {
    assert.equal(verifyConflictsToken(SECRET, bad, CLAIMS, NOW), false);
  }
  const token = signConflictsToken(SECRET, CLAIMS, NOW);
  // MAC adulterado no último caractere e exp adulterado.
  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyConflictsToken(SECRET, flipped, CLAIMS, NOW), false);
  const later = `v1.${Number(token.slice(3, 13)) + 600}.${token.slice(14)}`;
  assert.equal(verifyConflictsToken(SECRET, later, CLAIMS, NOW), false);
});

test('segredo diferente: false', () => {
  const token = signConflictsToken(SECRET, CLAIMS, NOW);
  assert.equal(verifyConflictsToken('t'.repeat(43), token, CLAIMS, NOW), false);
});

test('usa timingSafeEqual na comparação do MAC', () => {
  const spy = mock.method(tokenCrypto, 'timingSafeEqual');
  try {
    const token = signConflictsToken(SECRET, CLAIMS, NOW);
    verifyConflictsToken(SECRET, token, CLAIMS, NOW);
    assert.equal(spy.mock.callCount(), 1);
  } finally {
    spy.mock.restore();
  }
});
