import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBookingInput,
  parseIdempotencyKey,
  IDEMPOTENCY_KEY_RE,
  APPOINTMENT_MESSAGES as M,
  APPOINTMENT_STATUSES,
} from '../../src/shared/appointments.js';

const TODAY = '2026-11-26';
const SERVICE = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const body = (over = {}) => ({ serviceId: SERVICE, professionalId: PRO, start: '2026-11-27T10:00', ...over });
const check = (b) => validateBookingInput(b, { today: TODAY });

describe('validateBookingInput (critérios 1 a 3)', () => {
  test('válido, com UUID e com any', () => {
    assert.deepEqual(check(body()), {
      ok: true,
      value: { serviceId: SERVICE, professionalId: PRO, start: '2026-11-27T10:00', date: '2026-11-27' },
    });
    assert.equal(check(body({ professionalId: 'any' })).value.professionalId, 'any');
  });

  test('sem serviceId (ausente, vazio, não string): serviceRequired', () => {
    for (const serviceId of [undefined, '', 42, null, ['x']]) {
      assert.deepEqual(check(body({ serviceId })).fields, { serviceId: M.serviceRequired });
    }
  });

  test('sem professionalId (ausente, vazio, null, não string): professionalRequired; a ausência não vale "qualquer"', () => {
    const { professionalId, ...rest } = body();
    assert.ok(professionalId);
    assert.deepEqual(check(rest).fields, { professionalId: M.professionalRequired });
    for (const value of ['', null, 7, {}]) {
      assert.deepEqual(check(body({ professionalId: value })).fields, { professionalId: M.professionalRequired });
    }
  });

  test('UUID malformado (serviço ou profissional) dá notFound, mas campo inválido junto dá 400', () => {
    assert.deepEqual(check(body({ serviceId: 'x'.repeat(36) })), { ok: false, notFound: true });
    assert.deepEqual(check(body({ professionalId: 'todos' })), { ok: false, notFound: true });
    assert.deepEqual(check(body({ professionalId: 'ABCDEF00-0000-4000-8000-00000000000A' })), { ok: false, notFound: true });
    assert.deepEqual(check(body({ serviceId: 'x', start: undefined })).fields, { start: M.startRequired });
  });

  test('start ausente, fora do formato, 24:00, minuto fora de 15 e string enorme', () => {
    assert.deepEqual(check(body({ start: undefined })).fields, { start: M.startRequired });
    assert.deepEqual(check(body({ start: '' })).fields, { start: M.startRequired });
    for (const start of ['2026-11-27 10:00', '2026-11-27T10:00Z', '2026-11-27T24:00', '2026-11-27T10:10', '2026-02-30T10:00', 1700000000, ['2026-11-27T10:00']]) {
      assert.deepEqual(check(body({ start })).fields, { start: M.startInvalid }, String(start));
    }
    const huge = '2'.repeat(10_000);
    const t0 = process.hrtime.bigint();
    assert.deepEqual(check(body({ start: huge })).fields, { start: M.startInvalid });
    assert.ok(Number(process.hrtime.bigint() - t0) < 5e6);
  });

  test('horizonte: ontem e hoje + 91 dão outOfHorizon; hoje e hoje + 90 são aceitos', () => {
    assert.deepEqual(check(body({ start: '2026-11-25T10:00' })).fields, { start: M.outOfHorizon });
    assert.deepEqual(check(body({ start: '2027-02-25T10:00' })).fields, { start: M.outOfHorizon });
    assert.equal(check(body({ start: '2026-11-26T18:00' })).ok, true);
    assert.equal(check(body({ start: '2027-02-24T10:00' })).ok, true);
  });

  test('hoje às 09:30 (menos de 1 h) e no passado de hoje são aceitos pela regra de formato (o motor decide, 409)', () => {
    assert.equal(check(body({ start: '2026-11-26T09:30' })).ok, true);
    assert.equal(check(body({ start: '2026-11-26T00:00' })).ok, true);
  });

  test('erros de vários campos voltam juntos', () => {
    assert.deepEqual(check({}).fields, {
      serviceId: M.serviceRequired,
      professionalId: M.professionalRequired,
      start: M.startRequired,
    });
  });

  test('corpo array, string ou null vale {}; campos extras e __proto__ próprio não têm efeito', () => {
    for (const raw of [[], 'x', null, 42]) assert.equal(Object.keys(check(raw).fields).length, 3);
    const extra = JSON.parse(`{"serviceId":"${SERVICE}","professionalId":"any","start":"2026-11-27T10:00","x":1,"__proto__":{"serviceId":"z"}}`);
    assert.equal(check(extra).ok, true);
    const inherited = Object.create({ serviceId: SERVICE, professionalId: PRO, start: '2026-11-27T10:00' });
    assert.equal(Object.keys(check(inherited).fields).length, 3);
  });

  test('nenhuma mensagem contém a entrada', () => {
    const payload = '<script>alert(1)</script>';
    const out = JSON.stringify(check({ serviceId: payload, professionalId: payload, start: payload }));
    assert.equal(out.includes('script'), false);
    for (const message of Object.values(M)) assert.equal(typeof message, 'string');
  });
});

describe('Idempotency-Key', () => {
  test('IDEMPOTENCY_KEY_RE aceita v4 (maiúsculas também) e recusa v1, 35 e 37 caracteres e "a, b"', () => {
    const v4 = '3b241101-e2bb-4255-8caf-4136c566a962';
    assert.ok(IDEMPOTENCY_KEY_RE.test(v4));
    assert.ok(IDEMPOTENCY_KEY_RE.test(v4.toUpperCase()));
    assert.equal(IDEMPOTENCY_KEY_RE.test('3b241101-e2bb-1255-8caf-4136c566a962'), false);
    assert.equal(IDEMPOTENCY_KEY_RE.test(v4.slice(1)), false);
    assert.equal(IDEMPOTENCY_KEY_RE.test(`${v4}0`), false);
    assert.equal(IDEMPOTENCY_KEY_RE.test(`${v4}, ${v4}`), false);
  });

  test('parseIdempotencyKey: ausente, minúsculas, inválido', () => {
    const v4 = '3B241101-E2BB-4255-8CAF-4136C566A962';
    assert.equal(parseIdempotencyKey(undefined), undefined);
    assert.equal(parseIdempotencyKey(v4), v4.toLowerCase());
    for (const bad of ['', 'x', `${v4}, ${v4}`, ['a'], 42, null]) assert.equal(parseIdempotencyKey(bad), null);
  });

  test('status: lista fechada das quatro do AF-14', () => {
    assert.deepEqual([...APPOINTMENT_STATUSES], ['confirmed', 'cancelled', 'completed', 'no_show']);
    assert.ok(Object.isFrozen(APPOINTMENT_STATUSES));
  });
});
