import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const {
  loadTimeBlocks,
  toRequestBody,
  createTimeBlock,
  removeTimeBlock,
  describeTimeBlock,
  describeConflict,
  conflictsSummary,
  timeOptions,
  defaultFormTimes,
  EMPTY_TIME_BLOCKS_MESSAGE,
} = await import('../../web/js/time-blocks-controller.js');
const { TIME_BLOCK_MESSAGES: M } = await import('../../src/shared/time-blocks.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TB = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
const TOKEN = 'a'.repeat(43);

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('no body');
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const form = (over = {}) => ({
  professionalId: P,
  allDay: false,
  startDate: '2026-12-24',
  startTime: '14:00',
  endDate: '2026-12-24',
  endTime: '18:00',
  reasonKind: '',
  reasonNote: '',
  ...over,
});

const BLOCK = {
  id: TB,
  professional: { id: P, name: 'Ana Souza' },
  start: '2026-12-24T14:00',
  end: '2026-12-24T18:00',
  startsAt: '2026-12-24T17:00:00.000Z',
  endsAt: '2026-12-24T21:00:00.000Z',
  allDay: false,
  reason: { kind: 'holiday', note: 'Véspera de Natal' },
  createdAt: '2026-12-01T12:00:00.000Z',
};

describe('toRequestBody (decisão 2)', () => {
  test('dia inteiro: 24/12 a 26/12 vira 2026-12-24T00:00–2026-12-27T00:00; 31/12 vira 2027-01-01', () => {
    assert.deepEqual(toRequestBody(form({ allDay: true, startDate: '2026-12-24', endDate: '2026-12-26' })), {
      professionalId: P,
      start: '2026-12-24T00:00',
      end: '2026-12-27T00:00',
    });
    assert.equal(toRequestBody(form({ allDay: true, startDate: '2026-12-31', endDate: '2026-12-31' })).end, '2027-01-01T00:00');
  });

  test('parcial, "todos" (null explícito) e motivo', () => {
    assert.deepEqual(toRequestBody(form({ professionalId: null, reasonKind: 'other', reasonNote: 'Curso' })), {
      professionalId: null,
      start: '2026-12-24T14:00',
      end: '2026-12-24T18:00',
      reasonKind: 'other',
      reasonNote: 'Curso',
    });
    assert.equal('professionalId' in toRequestBody({}), true);
  });
});

describe('createTimeBlock', () => {
  test('erro local não chama fetchFn', async () => {
    const fetchFn = fakeFetch(201, {});
    const result = await createTimeBlock(form({ endTime: '13:00' }), { fetchFn });
    assert.deepEqual(result, { ok: false, fields: { end: M.endBeforeStart }, message: M.checkFields });
    assert.equal(fetchFn.calls.length, 0);
  });

  test('201: timeBlock, contagem e avisos', async () => {
    const fetchFn = fakeFetch(201, {
      timeBlock: BLOCK,
      acknowledgedConflictsCount: 2,
      warnings: [{ code: 'TIME_BLOCK_TIME_ADJUSTED', field: 'start', message: M.timeAdjusted('03:30') }],
    });
    const result = await createTimeBlock(form(), { fetchFn });
    assert.deepEqual(result, {
      ok: true,
      timeBlock: BLOCK,
      acknowledgedConflictsCount: 2,
      warnings: [M.timeAdjusted('03:30')],
    });
    assert.equal(fetchFn.calls[0].url, '/api/time-blocks');
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.equal('confirmConflictsToken' in fetchFn.calls[0].body, false);
  });

  test('409 TIME_BLOCK_CONFLICTS devolve needsConfirmation com a lista e o token', async () => {
    const conflicts = [{ start: '2026-12-24T14:30', end: '2026-12-24T15:00', serviceName: 'Corte', professionalName: 'Ana', customerName: 'Bia' }];
    const fetchFn = fakeFetch(409, {
      error: { code: 'TIME_BLOCK_CONFLICTS', message: M.conflicts, conflicts, conflictsTotal: 3, conflictsToken: TOKEN },
    });
    assert.deepEqual(await createTimeBlock(form(), { fetchFn }), {
      ok: false,
      needsConfirmation: true,
      changed: false,
      conflicts,
      conflictsTotal: 3,
      conflictsToken: TOKEN,
    });
  });

  test('reenvio leva confirmConflictsToken no corpo; …_CHANGED devolve changed: true', async () => {
    const fetchFn = fakeFetch(409, {
      error: { code: 'TIME_BLOCK_CONFLICTS_CHANGED', message: M.conflictsChanged, conflicts: [], conflictsTotal: 1, conflictsToken: 'b'.repeat(43) },
    });
    const result = await createTimeBlock(form(), { fetchFn, confirmConflictsToken: TOKEN });
    assert.equal(fetchFn.calls[0].body.confirmConflictsToken, TOKEN);
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.changed, true);
    assert.equal(result.conflictsToken, 'b'.repeat(43));
  });

  test('401 leva a /login; 409 BUSINESS_REQUIRED leva a /onboarding; 400 traz fields; 500 é genérico', async () => {
    const r401 = await createTimeBlock(form(), { fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.equal(r401.redirectTo, '/login');
    const r409 = await createTimeBlock(form(), {
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(r409.redirectTo, '/onboarding');
    const r400 = await createTimeBlock(form(), {
      fetchFn: fakeFetch(400, { error: { code: 'VALIDATION_ERROR', message: M.checkFields, fields: { end: M.endInPast } } }),
    });
    assert.deepEqual(r400, { ok: false, status: 400, fields: { end: M.endInPast }, message: M.checkFields });
    const r500 = await createTimeBlock(form(), { fetchFn: fakeFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'detalhe' } }) });
    assert.equal(r500.message, GENERIC_ERROR_MESSAGE);
  });
});

describe('loadTimeBlocks e removeTimeBlock', () => {
  test('GET com filtros na query; vazios ficam de fora', async () => {
    const fetchFn = fakeFetch(200, { timeBlocks: [BLOCK], timezone: 'America/Sao_Paulo', now: '2026-12-01T09:00', truncated: false });
    const result = await loadTimeBlocks({ professionalId: 'all', from: '2026-12-01', to: '' }, { fetchFn });
    assert.deepEqual(result, { ok: true, timeBlocks: [BLOCK], timezone: 'America/Sao_Paulo', now: '2026-12-01T09:00', truncated: false });
    assert.equal(fetchFn.calls[0].url, '/api/time-blocks?professionalId=all&from=2026-12-01');
    await loadTimeBlocks({}, { fetchFn });
    assert.equal(fetchFn.calls[1].url, '/api/time-blocks');
  });

  test('GET 401 leva a /login', async () => {
    const result = await loadTimeBlocks({}, { fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.equal(result.redirectTo, '/login');
  });

  test('removeTimeBlock: id inválido não chama fetchFn; 204 dá ok', async () => {
    const fetchFn = fakeFetch(204);
    assert.deepEqual(await removeTimeBlock('../x', { fetchFn }), { ok: false, status: 404, fields: {}, message: M.notFound });
    assert.equal(fetchFn.calls.length, 0);
    assert.deepEqual(await removeTimeBlock(TB, { fetchFn }), { ok: true });
    assert.equal(fetchFn.calls[0].url, `/api/time-blocks/${TB}`);
    assert.equal(fetchFn.calls[0].init.method, 'DELETE');
  });
});

describe('textos da tela (critérios 18, 24 e 26)', () => {
  test('describeTimeBlock: parcial, vários dias, dia inteiro e "todos"', () => {
    assert.deepEqual(describeTimeBlock(BLOCK), {
      targetLabel: 'Ana Souza',
      periodLabel: '24/12/2026 14:00 – 18:00',
      reasonLabel: 'Feriado: Véspera de Natal',
    });
    const multi = describeTimeBlock({ ...BLOCK, end: '2026-12-26T10:00', reason: null });
    assert.equal(multi.periodLabel, '24/12/2026 14:00 – 26/12/2026 10:00');
    assert.equal(multi.reasonLabel, '');
    const allDay = describeTimeBlock({
      ...BLOCK,
      professional: null,
      start: '2026-12-24T00:00',
      end: '2026-12-27T00:00',
      allDay: true,
      reason: { kind: 'other', note: 'Recesso' },
    });
    assert.deepEqual(allDay, { targetLabel: 'Todos os profissionais', periodLabel: '24/12 a 26/12/2026 (dia inteiro)', reasonLabel: 'Recesso' });
    const oneDay = describeTimeBlock({ ...BLOCK, start: '2026-12-25T00:00', end: '2026-12-26T00:00', allDay: true, reason: { kind: 'day_off', note: null } });
    assert.equal(oneDay.periodLabel, '25/12/2026 (dia inteiro)');
    assert.equal(oneDay.reasonLabel, 'Folga');
    const newYear = describeTimeBlock({ ...BLOCK, start: '2026-12-30T00:00', end: '2027-01-03T00:00', allDay: true });
    assert.equal(newYear.periodLabel, '30/12/2026 a 02/01/2027 (dia inteiro)');
  });

  test('describeTimeBlock não usa Date: o mesmo resultado com TZ diferente', async () => {
    const original = process.env.TZ;
    const results = [];
    try {
      for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        results.push(JSON.stringify(describeTimeBlock({ ...BLOCK, start: '2026-12-24T00:00', end: '2026-12-27T00:00', allDay: true })));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(new Set(results).size, 1);
    const source = await readFile(fileURLToPath(new URL('../../web/js/time-blocks-controller.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /new Date|Date\.now|getTimezoneOffset/);
  });

  test('describeConflict e conflictsSummary no singular, no plural e com "e mais N"', () => {
    assert.deepEqual(
      describeConflict({ start: '2026-12-24T14:30', end: '2026-12-24T15:00', serviceName: 'Corte', professionalName: 'Ana', customerName: 'Bia' }),
      { when: '24/12/2026 14:30 – 15:00', serviceName: 'Corte', professionalName: 'Ana', customerName: 'Bia' },
    );
    assert.equal(conflictsSummary(1, 1), '1 agendamento neste período. Ele continua marcado.');
    assert.equal(conflictsSummary(3, 3), '3 agendamentos neste período. Eles continuam marcados.');
    assert.equal(conflictsSummary(120, 50), '120 agendamentos neste período. Eles continuam marcados. Abaixo, os 50 primeiros, e mais 70.');
  });

  test('timeOptions: 96 opções de 00:00 a 23:45', () => {
    const options = timeOptions();
    assert.equal(options.length, 96);
    assert.equal(options[0], '00:00');
    assert.equal(options[1], '00:15');
    assert.equal(options[95], '23:45');
  });

  test('defaultFormTimes usa o `now` local do servidor', () => {
    assert.deepEqual(defaultFormTimes('2026-12-01T09:20'), { date: '2026-12-01', startTime: '10:00', endTime: '11:00' });
    assert.deepEqual(defaultFormTimes('2026-12-01T23:10'), { date: '2026-12-01', startTime: '23:00', endTime: '23:45' });
  });

  test('estado vazio explica o bloqueio e o efeito nos agendamentos', () => {
    assert.match(EMPTY_TIME_BLOCKS_MESSAGE, /não oferece horários para novos agendamentos/);
    assert.match(EMPTY_TIME_BLOCKS_MESSAGE, /continuam valendo/);
  });
});
