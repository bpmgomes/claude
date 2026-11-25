import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from '../helpers/test-app.js';
import {
  signupAndLogin,
  createBusinessFor,
  createProfessional,
  putHours,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { HOURS_MESSAGES as M } from '../../src/shared/working-hours.js';
import { PROFESSIONAL_MESSAGES } from '../../src/shared/professionals.js';
import { createWorkingHoursService } from '../../src/modules/working-hours/working-hours.service.js';

let app;
let logs;
let ana;
let professional;

beforeEach(async () => {
  ({ app, logs } = await buildTestApp());
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
  await createBusinessFor(app, ana);
  professional = await createProfessional(app, ana, { name: 'Profissional Secreta' });
});

afterEach(async () => {
  await app.close();
});

const getHours = (cookies, id) => app.inject({ method: 'GET', url: `/api/professionals/${id}/hours`, cookies });
const countRows = async () => Number((await app.db.get('SELECT COUNT(*) AS n FROM working_hours')).n);
const day = (weekday, ...pairs) => ({ weekday, intervals: pairs.map(([start, end]) => ({ start, end })) });

describe('grade inicial e gravação (critérios 2, 3, 4, 9 e 13)', () => {
  test('profissional novo: 7 dias vazios e hasHours false', async () => {
    const res = await getHours(ana, professional.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      hours: { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [] })), hasHours: false },
    });
  });

  test('WEEK_9_TO_18: 200, hasHours true e o GET devolve exatamente o enviado, na ordem', async () => {
    const res = await putHours(app, ana, professional.id, WEEK_9_TO_18);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body, { hours: { days: WEEK_9_TO_18, hasHours: true }, affectedAppointmentsCount: 0 });
    assert.equal('warnings' in body, false);
    assert.deepEqual((await getHours(ana, professional.id)).json().hours.days, WEEK_9_TO_18);
    // Sem dados internos na representação.
    const text = JSON.stringify(body);
    for (const word of ['businessId', 'professionalId', 'created', 'Minute']) assert.ok(!text.includes(word), word);
  });

  test('PUT só do sábado mantém segunda a sexta; intervals [] na segunda vira folga; 24:00 aceito', async () => {
    await putHours(app, ana, professional.id, WEEK_9_TO_18);
    const sat = await putHours(app, ana, professional.id, [day(6, ['18:00', '24:00'])]);
    assert.equal(sat.statusCode, 200);
    const days = sat.json().hours.days;
    assert.deepEqual(days.slice(0, 5), WEEK_9_TO_18.slice(0, 5));
    assert.deepEqual(days[5], day(6, ['18:00', '24:00']));

    const mon = await putHours(app, ana, professional.id, [day(1)]);
    assert.deepEqual(mon.json().hours.days[0], day(1));
    assert.deepEqual(mon.json().hours.days[1], WEEK_9_TO_18[1]);
  });

  test('intervalos fora de ordem voltam ordenados por início', async () => {
    const res = await putHours(app, ana, professional.id, [day(3, ['13:00', '18:00'], ['09:00', '12:00'])]);
    assert.deepEqual(res.json().hours.days[2], day(3, ['09:00', '12:00'], ['13:00', '18:00']));
  });
});

describe('validação e atomicidade (critérios 5–8, 11, 12 e 14)', () => {
  test('segunda válida e terça inválida: 400 com fields e a segunda continua a antiga', async () => {
    await putHours(app, ana, professional.id, WEEK_9_TO_18);
    const res = await putHours(app, ana, professional.id, [day(1, ['07:00', '08:00']), day(2, ['10:00', '09:00'])]);
    assert.equal(res.statusCode, 400);
    const { error } = res.json();
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Verifique os horários destacados.');
    assert.deepEqual(error.fields, { 'days.2.intervals.0.end': M.endBeforeStart });
    assert.deepEqual((await getHours(ana, professional.id)).json().hours.days, WEEK_9_TO_18);
  });

  test('sobreposição, passo e formato por campo', async () => {
    const res = await putHours(app, ana, professional.id, [
      day(1, ['09:00', '12:00'], ['11:00', '13:00']),
      day(2, ['09:10', '25:00']),
    ]);
    assert.deepEqual(res.json().error.fields, {
      'days.1.intervals.0': M.overlap(2),
      'days.1.intervals.1': M.overlap(1),
      'days.2.intervals.0.start': M.timeStep,
      'days.2.intervals.0.end': M.timeInvalid,
    });
    assert.equal(await countRows(), 0);
  });

  test('{} e days [] dão "Nada para atualizar."; 7 intervalos dão intervalsTooMany', async () => {
    for (const payload of [{}, { days: [] }]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/professionals/${professional.id}/hours`,
        cookies: ana,
        payload,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.message, 'Nada para atualizar.');
    }
    const seven = Array.from({ length: 7 }, (_, i) => [`0${i}:00`, `0${i}:30`]);
    const res = await putHours(app, ana, professional.id, [day(1, ...seven)]);
    assert.deepEqual(res.json().error.fields, { 'days.1': M.intervalsTooMany });
  });

  test('sem eco: start com 10.000 caracteres dá 400 com corpo < 1 KB e sem a entrada', async () => {
    const long = 'A'.repeat(10_000);
    const res = await putHours(app, ana, professional.id, [{ weekday: 1, intervals: [{ start: long, end: '10:00' }] }]);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.length < 1024, String(res.body.length));
    assert.ok(!res.body.includes('AAAA'));
  });

  test('corpo acima de 16 KB dá 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await putHours(app, ana, professional.id, [{ weekday: 1, intervals: [], pad: 'x'.repeat(17 * 1024) }]);
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(await countRows(), 0);
  });
});

describe('aviso de agendamentos afetados (critério 20)', () => {
  test('porta que devolve 3: 200 com affectedAppointmentsCount 3 e warning HOURS_APPOINTMENTS_OUTSIDE', async () => {
    const original = app.services.workingHoursService;
    app.services.workingHoursService = createWorkingHoursService({
      db: app.db,
      workingHoursRepository: app.services.workingHoursRepository,
      professionalsRepository: app.services.professionalsRepository,
      businessesRepository: app.services.businessesRepository,
      appointments: { countFutureOutsideHours: async () => 3 },
    });
    try {
      const res = await putHours(app, ana, professional.id, WEEK_9_TO_18);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.affectedAppointmentsCount, 3);
      assert.deepEqual(body.warnings, [{ code: 'HOURS_APPOINTMENTS_OUTSIDE', message: M.appointmentsOutside }]);
      assert.equal(await countRows(), 10);
    } finally {
      app.services.workingHoursService = original;
    }
  });
});

describe('isolamento e segurança (critérios 15, 16, 17 e 19)', () => {
  test('401 em GET e PUT, sem tocar a tabela', async () => {
    assert.equal((await getHours({}, professional.id)).statusCode, 401);
    const put = await putHours(app, {}, professional.id, WEEK_9_TO_18);
    assert.equal(put.statusCode, 401);
    assert.equal(put.json().error.code, 'UNAUTHENTICATED');
    assert.equal(await countRows(), 0);
  });

  test('dono sem negócio: 409 BUSINESS_REQUIRED em GET e PUT', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    for (const res of [await getHours(bia, professional.id), await putHours(app, bia, professional.id, WEEK_9_TO_18)]) {
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json().error, { code: 'BUSINESS_REQUIRED', message: M.businessRequired });
    }
    assert.equal(await countRows(), 0);
  });

  test('outro dono, UUID inexistente, removido e id inválido: o mesmo 404', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    await createBusinessFor(app, bia, { name: 'Salão da Bia' });
    const removed = await createProfessional(app, ana, { name: 'Removida' });
    await app.inject({ method: 'DELETE', url: `/api/professionals/${removed.id}`, cookies: ana });

    const expected = { error: { code: 'PROFESSIONAL_NOT_FOUND', message: PROFESSIONAL_MESSAGES.notFound } };
    const responses = [
      await getHours(bia, professional.id),
      await putHours(app, bia, professional.id, WEEK_9_TO_18),
      await getHours(ana, randomUUID()),
      await putHours(app, ana, randomUUID(), WEEK_9_TO_18),
      await getHours(ana, removed.id),
      await putHours(app, ana, removed.id, WEEK_9_TO_18),
      await getHours(ana, 'nao-e-uuid'),
      await putHours(app, ana, 'nao-e-uuid', WEEK_9_TO_18),
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), expected);
    }
    assert.equal(await countRows(), 0);
  });

  test('businessId no corpo é ignorado', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const biaBusiness = await createBusinessFor(app, bia, { name: 'Salão da Bia' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/professionals/${professional.id}/hours`,
      cookies: ana,
      payload: { businessId: biaBusiness.id, professionalId: randomUUID(), days: WEEK_9_TO_18 },
    });
    assert.equal(res.statusCode, 200);
    const rows = await app.db.all('SELECT DISTINCT business_id, professional_id FROM working_hours');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].professional_id, professional.id);
    assert.notEqual(rows[0].business_id, biaBusiness.id);
  });

  test('remoção: depois do DELETE do profissional, GET e PUT dão 404 e as linhas continuam no banco', async () => {
    await putHours(app, ana, professional.id, WEEK_9_TO_18);
    const del = await app.inject({ method: 'DELETE', url: `/api/professionals/${professional.id}`, cookies: ana });
    assert.equal(del.statusCode, 204);
    assert.equal((await getHours(ana, professional.id)).statusCode, 404);
    assert.equal((await putHours(app, ana, professional.id, [day(1)])).statusCode, 404);
    assert.equal(await countRows(), 10);
    const business = await app.services.businessesRepository.findByOwnerId(
      (await app.db.get('SELECT id FROM users WHERE email = ?', ['ana@x.com'])).id,
    );
    assert.equal(await app.services.workingHoursRepository.hasHours(business.id, professional.id), false);
  });

  test('CSRF: Origin de outro site no PUT dá 403 e nada muda', async () => {
    await putHours(app, ana, professional.id, WEEK_9_TO_18);
    const res = await putHours(app, ana, professional.id, [day(1)], { headers: { origin: 'https://evil.example' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
    assert.deepEqual((await getHours(ana, professional.id)).json().hours.days, WEEK_9_TO_18);
  });
});

describe('fuso, efeito imediato e logs (critérios 21 e 22)', () => {
  test('com TZ do servidor em UTC, Asia/Tokyo e America/Sao_Paulo, o mesmo PUT e GET devolvem a mesma grade', async () => {
    const original = process.env.TZ;
    const days = [day(1, ['09:00', '12:00'], ['22:00', '24:00']), day(7, ['00:00', '02:00'])];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        const put = await putHours(app, ana, professional.id, days);
        assert.equal(put.statusCode, 200);
        const got = (await getHours(ana, professional.id)).json().hours.days;
        assert.deepEqual(got[0], days[0], tz);
        assert.deepEqual(got[6], days[1], tz);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('sem reinício: findWeekly na mesma instância já vê a grade nova', async () => {
    const userId = (await app.db.get('SELECT id FROM users WHERE email = ?', ['ana@x.com'])).id;
    const business = await app.services.businessesRepository.findByOwnerId(userId);
    const repo = app.services.workingHoursRepository;
    assert.equal((await repo.findWeekly(business.id, [professional.id])).size, 0);
    await putHours(app, ana, professional.id, [day(2, ['10:00', '11:00'])]);
    assert.deepEqual((await repo.findWeekly(business.id, [professional.id])).get(professional.id), [
      { weekday: 2, startMinute: 600, endMinute: 660 },
    ]);
    assert.equal(await repo.hasHours(business.id, professional.id), true);
  });

  test('logs: working_hours_replaced sem horários nem nome', async () => {
    await putHours(app, ana, professional.id, [day(4, ['07:45', '11:15'])]);
    const text = logs();
    assert.ok(text.includes('working_hours_replaced'));
    assert.ok(!text.includes('07:45'));
    assert.ok(!text.includes('11:15'));
    assert.ok(!text.includes('Profissional Secreta'));
  });
});

test('GET /horarios serve a página', async () => {
  const res = await app.inject({ method: 'GET', url: '/horarios' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.body.includes('/js/horarios-page.js'));
});
