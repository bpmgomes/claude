import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAvailabilityQuery,
  AVAILABILITY_MESSAGES as M,
  ANY_PROFESSIONAL,
  AVAILABILITY_RANGE_MAX_DAYS,
  BOOKING_HORIZON_DAYS,
  PAST_TOLERANCE_DAYS,
  MIN_LEAD_MINUTES,
  SLOT_STEP_MINUTES,
} from '../../src/shared/availability.js';

const TODAY = '2026-11-26';
const S = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
const base = (extra = {}) => ({ serviceId: S, professionalId: 'any', from: '2026-11-27', ...extra });
const validate = (query) => validateAvailabilityQuery(query, { today: TODAY });

describe('constantes (decisões 1, 3 e 5)', () => {
  test('passo, antecedência, período, horizonte e tolerância', () => {
    assert.equal(SLOT_STEP_MINUTES, 15);
    assert.equal(MIN_LEAD_MINUTES, 60);
    assert.equal(AVAILABILITY_RANGE_MAX_DAYS, 31);
    assert.equal(BOOKING_HORIZON_DAYS, 90);
    assert.equal(PAST_TOLERANCE_DAYS, 1);
    assert.equal(ANY_PROFESSIONAL, 'any');
    assert.equal(Object.isFrozen(M), true);
  });
});

describe('validateAvailabilityQuery (critérios 2, 3 e 26)', () => {
  test('consulta válida: to ausente vale from (um dia)', () => {
    assert.deepEqual(validate(base()), {
      ok: true,
      value: { serviceId: S, professionalId: 'any', from: '2026-11-27', to: '2026-11-27', days: 1 },
    });
    assert.equal(validate(base({ to: '' })).value.to, '2026-11-27');
  });

  test('profissional específico (UUID) e any são aceitos', () => {
    assert.equal(validate(base({ professionalId: P })).value.professionalId, P);
    assert.equal(validate(base({ professionalId: 'any' })).value.professionalId, 'any');
  });

  test('sem serviceId dá serviceRequired', () => {
    for (const serviceId of [undefined, '']) {
      assert.deepEqual(validate(base({ serviceId })), { ok: false, fields: { serviceId: M.serviceRequired } });
    }
  });

  test('sem professionalId dá professionalRequired (ausência não vale "qualquer")', () => {
    for (const professionalId of [undefined, '']) {
      assert.deepEqual(validate(base({ professionalId })), { ok: false, fields: { professionalId: M.professionalRequired } });
    }
  });

  test('UUID malformado (serviço ou profissional) dá notFound', () => {
    for (const extra of [
      { serviceId: 'x' },
      { serviceId: S.toUpperCase() },
      { serviceId: `${S}0` },
      { professionalId: 'ANY' },
      { professionalId: 'qualquer' },
      { professionalId: '1b4e28ba-2fa1-1d2b-883f-0016d3cca427' },
    ]) {
      assert.deepEqual(validate(base(extra)), { ok: false, notFound: true }, JSON.stringify(extra));
    }
  });

  test('from > to, 32 dias e data inválida dão erro de campo', () => {
    assert.deepEqual(validate(base({ to: '2026-11-26' })).fields, { to: M.rangeInvalid });
    assert.deepEqual(validate(base({ from: '2026-11-27', to: '2026-12-28' })).fields, { to: M.rangeInvalid });
    assert.deepEqual(validate(base({ from: '2026-02-30' })).fields, { from: M.dateInvalid });
    assert.deepEqual(validate(base({ to: '2026-13-01' })).fields, { to: M.dateInvalid });
    assert.deepEqual(validate(base({ from: undefined })).fields, { from: M.dateInvalid });
    assert.deepEqual(validate(base({ from: '27/11/2026' })).fields, { from: M.dateInvalid });
  });

  test('31 dias exatos são aceitos', () => {
    const result = validate(base({ from: '2026-11-27', to: '2026-12-27' }));
    assert.equal(result.ok, true);
    assert.equal(result.value.days, 31);
  });

  test('from = ontem é aceito; anteontem dá outOfHorizon', () => {
    assert.equal(validate(base({ from: '2026-11-25' })).ok, true);
    assert.deepEqual(validate(base({ from: '2026-11-24', to: '2026-11-26' })).fields, { from: M.outOfHorizon });
  });

  test('to = hoje + 90 é aceito; + 91 dá outOfHorizon', () => {
    assert.equal(validate(base({ from: '2027-02-24' })).ok, true);
    assert.deepEqual(validate(base({ from: '2027-02-20', to: '2027-02-25' })).fields, { to: M.outOfHorizon });
    assert.deepEqual(validate(base({ from: '2027-02-25' })).fields, { to: M.outOfHorizon });
  });

  test('parâmetro repetido (array) e string de 10.000 caracteres dão erro de campo, sem regex longo', () => {
    const long = '2'.repeat(10_000);
    assert.deepEqual(validate(base({ from: ['2026-11-27', '2026-11-28'] })).fields, { from: M.dateInvalid });
    assert.deepEqual(validate(base({ from: long })).fields, { from: M.dateInvalid });
    assert.deepEqual(validate(base({ to: [long] })).fields, { to: M.dateInvalid });
    assert.deepEqual(validate(base({ serviceId: [S, S] })).fields, { serviceId: M.serviceRequired });
    assert.deepEqual(validate(base({ professionalId: ['any', 'any'] })).fields, { professionalId: M.professionalRequired });
    assert.deepEqual(validate(base({ serviceId: 'a'.repeat(10_000) })), { ok: false, notFound: true });
  });

  test('erros de vários campos voltam juntos; com notFound e erro de campo, vale o erro de campo (400)', () => {
    assert.deepEqual(validate({}), {
      ok: false,
      fields: { serviceId: M.serviceRequired, professionalId: M.professionalRequired, from: M.dateInvalid },
    });
    assert.deepEqual(validate({ serviceId: 'x', professionalId: P, from: 'x' }), { ok: false, fields: { from: M.dateInvalid } });
  });

  test('query não objeto e chaves herdadas não valem', () => {
    assert.equal(validate(null).ok, false);
    assert.equal(validate('serviceId=x').ok, false);
    const inherited = Object.create({ serviceId: S, professionalId: 'any', from: '2026-11-27' });
    assert.deepEqual(Object.keys(validate(inherited).fields).sort(), ['from', 'professionalId', 'serviceId']);
  });

  test('nenhuma mensagem contém a entrada; todas são fixas', () => {
    const payload = '<script>alert(1)</script>';
    const results = [
      validate({ serviceId: payload, professionalId: payload, from: payload, to: payload }),
      validate(base({ from: payload })),
      validate(base({ to: payload })),
    ];
    const known = new Set(Object.values(M));
    for (const result of results) {
      const text = JSON.stringify(result);
      assert.equal(text.includes('script'), false);
      for (const message of Object.values(result.fields || {})) assert.ok(known.has(message), message);
    }
  });
});
