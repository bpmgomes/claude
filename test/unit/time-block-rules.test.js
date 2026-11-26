import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTimeBlockInput,
  validateListQuery,
  toOwnerTimeBlock,
  toOwnerConflict,
  TIME_BLOCK_MESSAGES as M,
  TIME_BLOCK_ID_RE,
  REASON_KINDS,
} from '../../src/shared/time-blocks.js';

const SP = 'America/Sao_Paulo';
const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const opts = { timeZone: SP, nowMs: NOW_MS };
const body = (over = {}) => ({ professionalId: P, start: '2026-12-24T14:00', end: '2026-12-24T16:00', ...over });
const fieldsOf = (input, options = opts) => {
  const result = validateTimeBlockInput(input, options);
  assert.equal(result.ok, false, JSON.stringify(input).slice(0, 80));
  return result.fields;
};

describe('validateTimeBlockInput (critérios 1 a 7)', () => {
  test('parcial (14:00–16:00) é aceito e convertido para UTC no fuso do negócio', () => {
    const result = validateTimeBlockInput(body(), opts);
    assert.deepEqual(result, {
      ok: true,
      value: {
        professionalId: P,
        startsAt: '2026-12-24T17:00:00.000Z',
        endsAt: '2026-12-24T19:00:00.000Z',
        reasonKind: null,
        reasonNote: null,
        adjusted: { start: 'none', end: 'none' },
      },
    });
  });

  test('dia inteiro (00:00 até 00:00 do dia seguinte) e férias de 30 dias são aceitos', () => {
    assert.equal(validateTimeBlockInput(body({ start: '2026-12-24T00:00', end: '2026-12-25T00:00' }), opts).ok, true);
    assert.equal(validateTimeBlockInput(body({ start: '2027-01-05T00:00', end: '2027-02-04T00:00' }), opts).ok, true);
  });

  test('professionalId ausente dá targetRequired; null vira "todos"; tipo errado dá targetRequired', () => {
    const { professionalId, ...rest } = body();
    assert.equal(professionalId, P);
    assert.deepEqual(fieldsOf(rest), { professionalId: M.targetRequired });
    const all = validateTimeBlockInput(body({ professionalId: null }), opts);
    assert.equal(all.ok, true);
    assert.equal(all.value.professionalId, null);
    for (const value of [42, true, {}, []]) {
      assert.deepEqual(fieldsOf(body({ professionalId: value })), { professionalId: M.targetRequired });
    }
  });

  test('início = fim e início > fim dão endBeforeStart (critério 2)', () => {
    assert.deepEqual(fieldsOf(body({ end: '2026-12-24T14:00' })), { end: M.endBeforeStart });
    assert.deepEqual(fieldsOf(body({ end: '2026-12-24T13:00' })), { end: M.endBeforeStart });
  });

  test('passo de 15 min (critério 4) e formato', () => {
    assert.deepEqual(fieldsOf(body({ start: '2026-12-24T14:10' })), { start: M.timeStep });
    assert.deepEqual(fieldsOf(body({ start: '2026-12-24T14:00Z', end: '2026-12-24T16:00:00' })), {
      start: M.dateTimeInvalid,
      end: M.dateTimeInvalid,
    });
    assert.deepEqual(fieldsOf(body({ start: '2026-12-24T14:00-03:00' })), { start: M.dateTimeInvalid });
  });

  test('fim no passado dá endInPast; início no passado com fim no futuro é aceito (critério 5)', () => {
    // 12:00Z = 09:00 em São Paulo.
    assert.deepEqual(fieldsOf(body({ start: '2026-12-01T08:00', end: '2026-12-01T09:00' })), { end: M.endInPast });
    assert.deepEqual(fieldsOf(body({ start: '2026-11-20T08:00', end: '2026-11-21T09:00' })), { end: M.endInPast });
    assert.equal(validateTimeBlockInput(body({ start: '2026-12-01T08:00', end: '2026-12-01T09:15' }), opts).ok, true);
    // Sem nowMs (navegador), a regra não se aplica.
    assert.equal(validateTimeBlockInput(body({ start: '2020-01-01T08:00', end: '2020-01-01T09:00' }), { timeZone: SP }).ok, true);
  });

  test('366 dias exatos são aceitos; 366 dias + 15 min dão tooLong (critério 6)', () => {
    assert.equal(validateTimeBlockInput(body({ start: '2027-01-01T00:00', end: '2028-01-02T00:00' }), opts).ok, true);
    assert.deepEqual(fieldsOf(body({ start: '2027-01-01T00:00', end: '2028-01-02T00:15' })), { end: M.tooLong });
  });

  test('366 dias que atravessam mudanças de horário de verão (America/New_York) são aceitos', () => {
    const ny = { timeZone: 'America/New_York', nowMs: NOW_MS };
    const result = validateTimeBlockInput(body({ start: '2027-01-10T09:00', end: '2028-01-11T09:00' }), ny);
    assert.equal(result.ok, true);
    const ny2 = validateTimeBlockInput(body({ start: '2027-03-01T09:00', end: '2028-03-01T09:00' }), ny);
    assert.equal(ny2.ok, true);
    // 2027-03-01 está em EST e 2028-03-01 também: exatamente 366 dias de parede (2028 é bissexto).
  });

  test('início e fim dentro de um salto que invertem em UTC dão endBeforeStart', () => {
    const ny = { timeZone: 'America/New_York', nowMs: NOW_MS };
    // 02:45 (inexistente) vira 03:45, que vem depois de 03:00.
    assert.deepEqual(fieldsOf(body({ start: '2027-03-14T02:45', end: '2027-03-14T03:00' }), ny), { end: M.endBeforeStart });
    // 02:00 e 03:00 viram o mesmo instante (07:00Z): período vazio.
    assert.deepEqual(fieldsOf(body({ start: '2027-03-14T02:00', end: '2027-03-14T03:00' }), ny), { end: M.endBeforeStart });
    const ok = validateTimeBlockInput(body({ start: '2027-03-14T02:30', end: '2027-03-14T05:00' }), ny);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.adjusted, { start: 'gap', end: 'none' });
  });

  test('motivo: tipo inválido, nota longa, com bidi ou só espaços dão erro; 60 aceitos; nota sem tipo vira other', () => {
    assert.deepEqual(fieldsOf(body({ reasonKind: 'x' })), { reasonKind: M.reasonKindInvalid });
    assert.deepEqual(fieldsOf(body({ reasonKind: 3 })), { reasonKind: M.reasonKindInvalid });
    assert.deepEqual(fieldsOf(body({ reasonNote: 'a'.repeat(61) })), { reasonNote: M.reasonNoteTooLong });
    assert.deepEqual(fieldsOf(body({ reasonNote: 'Férias‮' })), { reasonNote: M.reasonNoteInvalid });
    assert.deepEqual(fieldsOf(body({ reasonNote: '   ' })), { reasonNote: M.reasonNoteInvalid });
    const sixty = validateTimeBlockInput(body({ reasonKind: 'vacation', reasonNote: ` ${'é'.repeat(60)} ` }), opts);
    assert.equal(sixty.ok, true);
    assert.equal(sixty.value.reasonNote, 'é'.repeat(60));
    assert.equal(sixty.value.reasonKind, 'vacation');
    const noteOnly = validateTimeBlockInput(body({ reasonNote: 'Curso' }), opts);
    assert.equal(noteOnly.value.reasonKind, 'other');
    for (const kind of REASON_KINDS) assert.equal(validateTimeBlockInput(body({ reasonKind: kind }), opts).value.reasonKind, kind);
    for (const empty of [null, '']) {
      const r = validateTimeBlockInput(body({ reasonKind: null, reasonNote: empty }), opts);
      assert.equal(r.value.reasonKind, null);
      assert.equal(r.value.reasonNote, null);
    }
  });

  test('erros de vários campos voltam juntos e nenhuma mensagem contém a entrada (critério 7)', () => {
    const long = 'Z'.repeat(10_000);
    const fields = fieldsOf({ start: long, end: '2026-12-24T14:07', reasonKind: long, reasonNote: long });
    assert.deepEqual(fields, {
      professionalId: M.targetRequired,
      start: M.dateTimeInvalid,
      end: M.timeStep,
      reasonKind: M.reasonKindInvalid,
      reasonNote: M.reasonNoteTooLong,
    });
    assert.ok(!JSON.stringify(fields).includes('ZZZ'));
  });

  test('timeAdjusted só interpola HH:MM', () => {
    assert.equal(M.timeAdjusted('03:30'), 'O horário caiu na mudança de horário de verão e foi ajustado para 03:30.');
    assert.ok(!M.timeAdjusted('<b>x</b>').includes('<b>'));
  });

  test('TIME_BLOCK_ID_RE é UUID v4', () => {
    assert.ok(TIME_BLOCK_ID_RE.test(P));
    assert.ok(!TIME_BLOCK_ID_RE.test('123'));
  });
});

describe('validateListQuery', () => {
  test('sem filtros: tudo null (lista padrão só de ativos)', () => {
    assert.deepEqual(validateListQuery({}, { timeZone: SP }), {
      ok: true,
      value: { professionalId: null, fromIso: null, toIso: null },
    });
  });

  test('período em hora local do negócio, com `to` inclusive', () => {
    const result = validateListQuery({ professionalId: 'all', from: '2026-12-24', to: '2026-12-26' }, { timeZone: SP });
    assert.deepEqual(result.value, {
      professionalId: 'all',
      fromIso: '2026-12-24T03:00:00.000Z',
      toIso: '2026-12-27T03:00:00.000Z',
    });
    assert.equal(validateListQuery({ professionalId: P }, { timeZone: SP }).value.professionalId, P);
  });

  test('366 dias aceitos; 367 dias e from > to dão rangeInvalid', () => {
    assert.equal(validateListQuery({ from: '2027-01-01', to: '2028-01-01' }, { timeZone: SP }).ok, true);
    assert.deepEqual(validateListQuery({ from: '2027-01-01', to: '2028-01-02' }, { timeZone: SP }).fields, { to: M.rangeInvalid });
    assert.deepEqual(validateListQuery({ from: '2026-12-02', to: '2026-12-01' }, { timeZone: SP }).fields, { to: M.rangeInvalid });
  });

  test('só from ou só to: período de 366 dias a partir/até a data', () => {
    const onlyFrom = validateListQuery({ from: '2026-12-01' }, { timeZone: SP }).value;
    assert.equal(onlyFrom.fromIso, '2026-12-01T03:00:00.000Z');
    assert.equal(onlyFrom.toIso, '2027-12-02T03:00:00.000Z');
    const onlyTo = validateListQuery({ to: '2026-12-01' }, { timeZone: SP }).value;
    assert.equal(onlyTo.toIso, '2026-12-02T03:00:00.000Z');
  });

  test('valores inválidos dão erro por campo, sem eco', () => {
    const long = 'Q'.repeat(5000);
    const result = validateListQuery({ professionalId: long, from: '2026-02-30', to: ['2026-12-01'] }, { timeZone: SP });
    assert.deepEqual(result.fields, { professionalId: M.targetRequired, from: M.dateInvalid, to: M.dateInvalid });
    assert.ok(!JSON.stringify(result).includes('QQQ'));
  });
});

describe('toOwnerTimeBlock e toOwnerConflict', () => {
  const row = {
    id: P,
    professionalId: null,
    professionalName: null,
    startsAt: '2026-12-24T03:00:00.000Z',
    endsAt: '2026-12-27T03:00:00.000Z',
    reasonKind: 'holiday',
    reasonNote: null,
    createdAt: '2026-12-01T12:00:00.000Z',
  };

  test('allDay só com 00:00–00:00; start/end recalculados no fuso; sem businessId', () => {
    const block = toOwnerTimeBlock(row, SP);
    assert.deepEqual(block, {
      id: P,
      professional: null,
      start: '2026-12-24T00:00',
      end: '2026-12-27T00:00',
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: true,
      reason: { kind: 'holiday', note: null },
      createdAt: row.createdAt,
    });
    const tokyo = toOwnerTimeBlock(row, 'Asia/Tokyo');
    assert.equal(tokyo.start, '2026-12-24T12:00');
    assert.equal(tokyo.allDay, false);
    const partial = toOwnerTimeBlock({ ...row, endsAt: '2026-12-24T17:00:00.000Z' }, SP);
    assert.equal(partial.allDay, false);
  });

  test('professional e reason', () => {
    const block = toOwnerTimeBlock({ ...row, professionalId: P, professionalName: 'Ana', reasonKind: null }, SP);
    assert.deepEqual(block.professional, { id: P, name: 'Ana' });
    assert.equal(block.reason, null);
  });

  test('toOwnerConflict converte para hora local e não expõe ids', () => {
    const conflict = toOwnerConflict(
      {
        id: 'x',
        professionalId: P,
        startsAt: '2026-12-24T17:30:00.000Z',
        endsAt: '2026-12-24T18:00:00.000Z',
        serviceName: 'Corte',
        professionalName: 'Ana',
        customerName: 'Bia',
      },
      SP,
    );
    assert.deepEqual(conflict, {
      start: '2026-12-24T14:30',
      end: '2026-12-24T15:00',
      serviceName: 'Corte',
      professionalName: 'Ana',
      customerName: 'Bia',
    });
  });
});
