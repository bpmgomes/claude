import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  loadHours,
  saveHours,
  timeOptions,
  copyDay,
  copyFromProfessional,
  isDirty,
  errorsByInterval,
  affectedMessage,
  EMPTY_HOURS_MESSAGE,
} = await import('../../web/js/hours-controller.js');
const { HOURS_MESSAGES: M, emptyWeek } = await import('../../src/shared/working-hours.js');
const { PROFESSIONAL_MESSAGES } = await import('../../src/shared/professionals.js');
const { GENERIC_ERROR_MESSAGE } = await import('../../web/js/api.js');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const day = (weekday, ...pairs) => ({ weekday, intervals: pairs.map(([start, end]) => ({ start, end })) });
const HOURS = { days: emptyWeek().map((d) => (d.weekday === 1 ? day(1, ['09:00', '12:00']) : d)), hasHours: true };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
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

describe('loadHours', () => {
  test('200 devolve hours; a URL usa o id', async () => {
    const fetchFn = fakeFetch(200, { hours: HOURS });
    assert.deepEqual(await loadHours(ID, { fetchFn }), { ok: true, hours: HOURS });
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}/hours`);
  });

  test('401 leva a /login; 409 BUSINESS_REQUIRED leva a /onboarding; 404 mostra a mensagem', async () => {
    const r401 = await loadHours(ID, { fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.equal(r401.redirectTo, '/login');
    const r409 = await loadHours(ID, {
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: M.businessRequired } }),
    });
    assert.equal(r409.redirectTo, '/onboarding');
    const r404 = await loadHours(ID, {
      fetchFn: fakeFetch(404, { error: { code: 'PROFESSIONAL_NOT_FOUND', message: PROFESSIONAL_MESSAGES.notFound } }),
    });
    assert.deepEqual(r404, { ok: false, status: 404, message: 'Profissional não encontrado.' });
  });

  test('id inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { hours: HOURS });
    for (const id of ['x', '../api', undefined, `${ID}/../x`]) {
      const r = await loadHours(id, { fetchFn });
      assert.equal(r.ok, false);
      assert.equal(r.status, 404);
    }
    assert.equal(fetchFn.calls.length, 0);
  });

  test('500 dá a mensagem genérica', async () => {
    const r = await loadHours(ID, { fetchFn: fakeFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'stack' } }) });
    assert.equal(r.message, GENERIC_ERROR_MESSAGE);
  });
});

describe('saveHours (critérios 10, 20 e 23)', () => {
  test('sobreposição não chama fetchFn e devolve fields', async () => {
    const fetchFn = fakeFetch(200, { hours: HOURS, affectedAppointmentsCount: 0 });
    const r = await saveHours(ID, [day(1, ['09:00', '12:00'], ['11:00', '13:00'])], { fetchFn });
    assert.equal(r.ok, false);
    assert.deepEqual(r.fields, { 'days.1.intervals.0': M.overlap(2), 'days.1.intervals.1': M.overlap(1) });
    assert.equal(r.message, M.checkFields);
    assert.equal(fetchFn.calls.length, 0);
  });

  test('200 com affectedAppointmentsCount 2 devolve warning no plural; envia PUT com os 7 dias', async () => {
    const fetchFn = fakeFetch(200, { hours: HOURS, affectedAppointmentsCount: 2, warnings: [] });
    const r = await saveHours(ID, HOURS.days, { fetchFn });
    assert.deepEqual(r, {
      ok: true,
      hours: HOURS,
      affectedAppointmentsCount: 2,
      warning: '2 agendamentos futuros ficam fora do novo horário. Eles continuam marcados.',
    });
    assert.equal(fetchFn.calls[0].init.method, 'PUT');
    assert.equal(fetchFn.calls[0].url, `/api/professionals/${ID}/hours`);
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { days: HOURS.days });
  });

  test('affectedAppointmentsCount 0 ou null: sem warning', async () => {
    for (const count of [0, null]) {
      const r = await saveHours(ID, HOURS.days, { fetchFn: fakeFetch(200, { hours: HOURS, affectedAppointmentsCount: count }) });
      assert.equal(r.warning, null);
      assert.equal(r.affectedAppointmentsCount, count);
    }
  });

  test('400 do servidor devolve fields; 401 e 409 redirecionam', async () => {
    const fields = { 'days.2.intervals.0.end': M.endBeforeStart };
    const r400 = await saveHours(ID, HOURS.days, {
      fetchFn: fakeFetch(400, { error: { code: 'VALIDATION_ERROR', message: M.checkFields, fields } }),
    });
    assert.deepEqual(r400, { ok: false, status: 400, fields, message: M.checkFields });
    const r401 = await saveHours(ID, HOURS.days, { fetchFn: fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) });
    assert.equal(r401.redirectTo, '/login');
    const r409 = await saveHours(ID, HOURS.days, {
      fetchFn: fakeFetch(409, { error: { code: 'BUSINESS_REQUIRED', message: 'x' } }),
    });
    assert.equal(r409.redirectTo, '/onboarding');
  });

  test('id inválido não chama fetchFn', async () => {
    const fetchFn = fakeFetch(200, { hours: HOURS });
    const r = await saveHours('nao-e-uuid', HOURS.days, { fetchFn });
    assert.equal(r.status, 404);
    assert.equal(fetchFn.calls.length, 0);
  });
});

describe('timeOptions', () => {
  test('início sem 24:00, fim sem 00:00, 96 opções cada, passo de 15', () => {
    const start = timeOptions({ forEnd: false });
    const end = timeOptions({ forEnd: true });
    assert.equal(start.length, 96);
    assert.equal(end.length, 96);
    assert.equal(start[0], '00:00');
    assert.equal(start.at(-1), '23:45');
    assert.equal(end[0], '00:15');
    assert.equal(end.at(-1), '24:00');
    assert.ok(!start.includes('24:00'));
    assert.ok(!end.includes('00:00'));
    assert.equal(start[1], '00:15');
  });
});

describe('copyDay e copyFromProfessional (critério 10)', () => {
  test('copyDay(segunda -> [terça, quarta]) copia sem compartilhar referências e sem tocar o original', () => {
    const original = emptyWeek();
    original[0] = day(1, ['09:00', '12:00'], ['13:00', '18:00']);
    const snapshot = JSON.stringify(original);
    const copied = copyDay(original, 1, [2, 3]);
    assert.equal(JSON.stringify(original), snapshot);
    assert.deepEqual(copied[1], { ...original[0], weekday: 2 });
    assert.deepEqual(copied[2], { ...original[0], weekday: 3 });
    assert.deepEqual(copied[3].intervals, []);
    assert.notEqual(copied[1].intervals, original[0].intervals);
    assert.notEqual(copied[1].intervals[0], original[0].intervals[0]);
    assert.notEqual(copied[1].intervals, copied[2].intervals);
    copied[1].intervals[0].start = '10:00';
    assert.equal(original[0].intervals[0].start, '09:00');
    assert.equal(copied[2].intervals[0].start, '09:00');
  });

  test('copyFromProfessional produz os 7 dias, na ordem, mesmo com resposta parcial', () => {
    const days = copyFromProfessional({ days: [day(5, ['09:00', '10:00']), day(1)] });
    assert.deepEqual(
      days.map((d) => d.weekday),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(days[4], day(5, ['09:00', '10:00']));
    assert.deepEqual(copyFromProfessional(null), emptyWeek());
  });
});

describe('isDirty (critério 26)', () => {
  test('detecta mudança e ignora a ordem de chaves', () => {
    const saved = copyFromProfessional(HOURS);
    const same = saved.map((d) => ({ intervals: d.intervals.map((i) => ({ end: i.end, start: i.start })), weekday: d.weekday }));
    assert.equal(isDirty(saved, same), false);
    assert.equal(isDirty(saved, copyDay(saved, 1, [2])), true);
    const changed = copyFromProfessional(HOURS);
    changed[0].intervals[0].end = '13:00';
    assert.equal(isDirty(saved, changed), true);
  });
});

describe('errorsByInterval e affectedMessage', () => {
  test('agrupa as chaves por intervalo e por dia', () => {
    const map = errorsByInterval({
      'days.1.intervals.0.start': M.timeInvalid,
      'days.1.intervals.0.end': M.endBeforeStart,
      'days.1.intervals.1': M.overlap(1),
      'days.3': M.intervalsTooMany,
      days: M.daysInvalid,
      outro: 'x',
    });
    assert.deepEqual([...map.keys()].sort(), ['1.0', '1.1', '3']);
    assert.deepEqual(map.get('1.0'), [M.timeInvalid, M.endBeforeStart]);
    assert.deepEqual(map.get('3'), [M.intervalsTooMany]);
    assert.equal(errorsByInterval(null).size, 0);
  });

  test('affectedMessage: 0/null sem aviso, 1 no singular, n no plural', () => {
    assert.equal(affectedMessage(0), null);
    assert.equal(affectedMessage(null), null);
    assert.equal(affectedMessage(1), '1 agendamento futuro fica fora do novo horário. Ele continua marcado.');
    assert.equal(affectedMessage(3), '3 agendamentos futuros ficam fora do novo horário. Eles continuam marcados.');
  });

  test('affectedMessage no teto da varredura (AF-11, decisão 16): "pelo menos 1.000"', () => {
    assert.equal(
      affectedMessage(1000),
      'Pelo menos 1.000 agendamentos futuros ficam fora do novo horário. Eles continuam marcados.',
    );
    assert.equal(affectedMessage(999), '999 agendamentos futuros ficam fora do novo horário. Eles continuam marcados.');
  });

  test('estado vazio explica que o profissional não aparece para clientes (critério 25)', () => {
    assert.match(EMPTY_HOURS_MESSAGE, /não aparecerá para os clientes/);
  });
});
