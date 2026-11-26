import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManageToken,
  changeWindow,
  formatChangePolicy,
  validateRescheduleInput,
  validateCancelInput,
  validateManageAvailabilityQuery,
  MANAGE_MESSAGES,
  APPOINTMENT_MESSAGES as M,
} from '../../src/shared/appointments.js';
import { AVAILABILITY_MESSAGES } from '../../src/shared/availability.js';
import {
  AppointmentNotChangeableError,
  AppointmentChangedError,
  RescheduleLimitReachedError,
} from '../../src/http/errors.js';

const TOKEN = `${'a'.repeat(20)}_-${'Z9'.repeat(10)}0`;
const VERSION = 'v'.repeat(43);
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
const TODAY = '2026-11-26';
const MIN = 60_000;

describe('parseManageToken (critério 6)', () => {
  test('43 caracteres base64url passam; o resto dá null', () => {
    assert.equal(TOKEN.length, 43);
    assert.equal(parseManageToken(TOKEN), TOKEN);
    for (const bad of [TOKEN.slice(1), `${TOKEN}a`, `${TOKEN.slice(1)}+`, `${TOKEN.slice(1)}/`, `${TOKEN.slice(1)}=`, 42, null, undefined, {}, [TOKEN]]) {
      assert.equal(parseManageToken(bad), null, String(bad));
    }
  });

  test('10.000 caracteres: null pelo comprimento, sem rodar regex longo', () => {
    const started = process.hrtime.bigint();
    assert.equal(parseManageToken('a'.repeat(10_000)), null);
    assert.ok(Number(process.hrtime.bigint() - started) < 50e6);
  });
});

describe('changeWindow (critério 18)', () => {
  const startsAtMs = Date.parse('2026-11-27T13:00:00.000Z');
  const at = (ms) => changeWindow({ status: 'confirmed', startsAtMs, nowMs: ms, leadMinutes: 120 });

  test('limite inclusivo: exatamente 120 min antes pode; 1 s depois não', () => {
    assert.equal(at(startsAtMs - 120 * MIN).canChange, true);
    assert.equal(at(startsAtMs - 120 * MIN + 1000).canChange, false);
    assert.equal(at(startsAtMs - 120 * MIN).deadlineMs, startsAtMs - 120 * MIN);
  });

  test('antecedência 0: pode até 1 ms antes do início; no início não', () => {
    const w = (ms) => changeWindow({ status: 'confirmed', startsAtMs, nowMs: ms, leadMinutes: 0 });
    assert.equal(w(startsAtMs - 1).canChange, true);
    assert.equal(w(startsAtMs).canChange, false);
    assert.equal(w(startsAtMs + 1).canChange, false);
  });

  test('status diferente de confirmed nunca pode; virada de dia no prazo', () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      assert.equal(changeWindow({ status, startsAtMs, nowMs: 0, leadMinutes: 120 }).canChange, false);
    }
    const early = Date.parse('2026-11-27T03:30:00.000Z'); // 00:30 em São Paulo
    const { deadlineMs } = changeWindow({ status: 'confirmed', startsAtMs: early, nowMs: 0, leadMinutes: 120 });
    assert.equal(new Date(deadlineMs).toISOString(), '2026-11-27T01:30:00.000Z'); // 22:30 do dia 26
  });
});

test('formatChangePolicy com 0, 15, 90, 120, 1440 e 4320', () => {
  assert.equal(formatChangePolicy(0), 'Você pode cancelar ou remarcar por este link até o horário de início.');
  assert.equal(formatChangePolicy(15), 'Você pode cancelar ou remarcar por este link até 15 min antes do horário.');
  assert.equal(formatChangePolicy(90), 'Você pode cancelar ou remarcar por este link até 1 h 30 min antes do horário.');
  assert.equal(formatChangePolicy(120), 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.');
  assert.equal(formatChangePolicy(1440), 'Você pode cancelar ou remarcar por este link até 24 h antes do horário.');
  assert.equal(formatChangePolicy(4320), 'Você pode cancelar ou remarcar por este link até 72 h antes do horário.');
});

describe('validateRescheduleInput (critérios 25 e 37)', () => {
  const ok = (body) => validateRescheduleInput(body, { today: TODAY });

  test('válido; professionalId ausente e null viram null; any e UUID passam; extras ignorados', () => {
    assert.deepEqual(ok({ start: '2026-11-27T10:30', version: VERSION }), {
      ok: true,
      value: { start: '2026-11-27T10:30', professionalId: null, version: VERSION },
    });
    assert.equal(ok({ start: '2026-11-27T10:30', professionalId: null, version: VERSION }).value.professionalId, null);
    assert.equal(ok({ start: '2026-11-27T10:30', professionalId: 'any', version: VERSION }).value.professionalId, 'any');
    const full = ok({ start: '2026-11-27T10:30', professionalId: UUID, version: VERSION, serviceId: UUID, customer: { name: 'x' }, email: 'a@b.c' });
    assert.deepEqual(Object.keys(full.value).sort(), ['professionalId', 'start', 'version']);
  });

  test('start com as regras do AF-11 e professionalId malformado: fields sem eco', () => {
    const cases = [
      [{ version: VERSION }, { start: M.startRequired }],
      [{ start: '2026-11-27T10:10', version: VERSION }, { start: M.startInvalid }],
      [{ start: '<script>', version: VERSION }, { start: M.startInvalid }],
      [{ start: '2027-03-01T10:00', version: VERSION }, { start: M.outOfHorizon }],
      [{ start: '2026-11-25T10:00', version: VERSION }, { start: M.outOfHorizon }],
      [{ start: '2026-11-27T10:00', professionalId: 'evil<b>', version: VERSION }, { professionalId: M.professionalRequired }],
    ];
    for (const [body, fields] of cases) {
      const result = ok(body);
      assert.deepEqual(result, { ok: false, fields }, JSON.stringify(body));
      assert.equal(JSON.stringify(result).includes('<'), false);
    }
  });

  test('version ausente ou fora do formato, e corpo não objeto: badRequest', () => {
    for (const body of [{ start: '2026-11-27T10:30' }, { start: '2026-11-27T10:30', version: 'x' }, { start: '2026-11-27T10:30', version: 43 }, null, [], 'x', undefined]) {
      assert.deepEqual(ok(body), { ok: false, badRequest: true }, JSON.stringify(body));
    }
  });
});

test('validateCancelInput: version obrigatória (decisão do Gerente)', () => {
  assert.deepEqual(validateCancelInput({ version: VERSION, extra: 1 }), { ok: true, version: VERSION });
  for (const body of [undefined, null, {}, { version: 'curta' }, { version: `${VERSION}=` }, [], 'x']) {
    assert.deepEqual(validateCancelInput(body), { ok: false, badRequest: true }, JSON.stringify(body));
  }
});

test('validateManageAvailabilityQuery: date de hoje a hoje + 90; professionalId opcional', () => {
  const q = (query) => validateManageAvailabilityQuery(query, { today: TODAY });
  assert.deepEqual(q({ date: '2026-11-27' }), { ok: true, value: { date: '2026-11-27', professionalId: null } });
  assert.equal(q({ date: TODAY, professionalId: 'any', outra: 'x' }).value.professionalId, 'any');
  assert.equal(q({ date: TODAY, professionalId: UUID }).value.professionalId, UUID);
  assert.equal(q({ date: TODAY, professionalId: '' }).value.professionalId, null);
  assert.deepEqual(q({}), { ok: false, fields: { date: AVAILABILITY_MESSAGES.dateInvalid } });
  assert.deepEqual(q({ date: ['2026-11-27'] }), { ok: false, fields: { date: AVAILABILITY_MESSAGES.dateInvalid } });
  assert.deepEqual(q({ date: '2026-11-25' }), { ok: false, fields: { date: AVAILABILITY_MESSAGES.outOfHorizon } });
  assert.deepEqual(q({ date: '2027-02-25' }), { ok: false, fields: { date: AVAILABILITY_MESSAGES.outOfHorizon } });
  assert.deepEqual(q({ date: '2027-02-24', professionalId: 'x' }), { ok: false, fields: { professionalId: AVAILABILITY_MESSAGES.professionalRequired } });
});

test('mensagens fixas: os erros usam MANAGE_MESSAGES e nenhuma interpola entrada', () => {
  assert.equal(new AppointmentNotChangeableError().message, MANAGE_MESSAGES.notChangeable);
  assert.equal(new AppointmentNotChangeableError(MANAGE_MESSAGES.professionalUnavailable).code, 'APPOINTMENT_NOT_CHANGEABLE');
  assert.equal(new AppointmentChangedError().message, MANAGE_MESSAGES.changed);
  assert.equal(new AppointmentChangedError().statusCode, 409);
  assert.equal(new RescheduleLimitReachedError().code, 'RESCHEDULE_LIMIT_REACHED');
  for (const text of Object.values(MANAGE_MESSAGES)) assert.doesNotMatch(text, /\$\{|%s|\{\{/);
});
