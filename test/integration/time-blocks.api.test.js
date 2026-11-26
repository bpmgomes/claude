import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import {
  signupAndLogin,
  createBusinessFor,
  createProfessional,
  postTimeBlock,
  listTimeBlocks,
  deleteTimeBlock,
  setBusinessTimezone,
} from '../helpers/session.js';
import { TIME_BLOCK_MESSAGES as M } from '../../src/shared/time-blocks.js';
import { PROFESSIONAL_MESSAGES } from '../../src/shared/professionals.js';
import { createTimeBlocksService } from '../../src/modules/time-blocks/time-blocks.service.js';
import {
  errorHandler,
  TimeBlockConflictsError,
  ProfessionalHasAppointmentsError,
  ValidationError,
  ServiceUnavailableError,
} from '../../src/http/errors.js';

const DAY_MS = 86_400_000;

let app;
let logs;
let clock;
let ana;
let business;
let professional;

async function setup(extra = {}, startIso = '2026-12-01T12:00:00.000Z') {
  clock = createClock(startIso);
  ({ app, logs } = await buildTestApp({ now: clock.now, ...extra }));
  ana = await signupAndLogin(app, { email: 'ana@x.com' });
  business = await createBusinessFor(app, ana);
  professional = await createProfessional(app, ana, { name: 'Ana Souza' });
}

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  await app.close();
});

const countBlocks = async () => Number((await app.db.get('SELECT COUNT(*) AS n FROM time_blocks')).n);
const block = (over = {}) => ({
  professionalId: professional.id,
  start: '2026-12-24T14:00',
  end: '2026-12-24T18:00',
  ...over,
});

async function created(body, cookies = ana) {
  const res = await postTimeBlock(app, cookies, body);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().timeBlock;
}

describe('cadastro (critérios 1 a 5)', () => {
  test('parcial: 201 e o GET devolve start/end enviados e os instantes UTC', async () => {
    const res = await postTimeBlock(app, ana, block({ reasonKind: 'holiday', reasonNote: 'Véspera de Natal' }));
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.acknowledgedConflictsCount, 0);
    assert.equal('warnings' in body, false);
    const { timeBlock } = body;
    assert.deepEqual(
      { ...timeBlock, id: undefined, createdAt: undefined },
      {
        id: undefined,
        professional: { id: professional.id, name: 'Ana Souza' },
        start: '2026-12-24T14:00',
        end: '2026-12-24T18:00',
        startsAt: '2026-12-24T17:00:00.000Z',
        endsAt: '2026-12-24T21:00:00.000Z',
        allDay: false,
        reason: { kind: 'holiday', note: 'Véspera de Natal' },
        createdAt: undefined,
      },
    );
    assert.equal(timeBlock.createdAt, '2026-12-01T12:00:00.000Z');
    assert.ok(!JSON.stringify(body).includes('businessId'));

    const list = (await listTimeBlocks(app, ana)).json();
    assert.deepEqual(list.timeBlocks, [timeBlock]);
    assert.equal(list.timezone, 'America/Sao_Paulo');
    assert.equal(list.now, '2026-12-01T09:00');
    assert.equal(list.truncated, false);
  });

  test('dia inteiro e vários dias: 201 com allDay', async () => {
    const day = await created(block({ professionalId: null, start: '2026-12-25T00:00', end: '2026-12-26T00:00' }));
    assert.equal(day.allDay, true);
    assert.equal(day.professional, null);
    const vacation = await created(block({ start: '2027-01-05T00:00', end: '2027-02-04T00:00', reasonKind: 'vacation' }));
    assert.equal(vacation.allDay, true);
    assert.equal(await countBlocks(), 2);
  });

  test('sobreposição: iguais e sobrepostos dão 201 cada (decisão 4)', async () => {
    await created(block());
    await created(block());
    await created(block({ start: '2026-12-24T16:00', end: '2026-12-24T20:00' }));
    assert.equal(await countBlocks(), 3);
  });

  test('validação por campo: 400 VALIDATION_ERROR e nada gravado', async () => {
    const res = await postTimeBlock(app, ana, block({ start: '2026-12-24T14:10', end: '2026-12-24T14:00' }));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error, { code: 'VALIDATION_ERROR', message: M.checkFields, fields: { start: M.timeStep } });
    const past = await postTimeBlock(app, ana, block({ start: '2026-11-01T10:00', end: '2026-11-01T11:00' }));
    assert.deepEqual(past.json().error.fields, { end: M.endInPast });
    const missing = await postTimeBlock(app, ana, { start: '2026-12-24T14:00', end: '2026-12-24T18:00' });
    assert.deepEqual(missing.json().error.fields, { professionalId: M.targetRequired });
    assert.equal(await countBlocks(), 0);
  });

  test('sem eco: start e reasonNote com 10.000 caracteres dão 400 com corpo < 1 KB', async () => {
    const long = 'A'.repeat(10_000);
    for (const over of [{ start: long }, { reasonNote: long }]) {
      const res = await postTimeBlock(app, ana, block(over));
      assert.equal(res.statusCode, 400);
      assert.ok(res.body.length < 1024, String(res.body.length));
      assert.ok(!res.body.includes('AAAA'));
    }
  });

  test('corpo não JSON dá 415 e acima de 16 KB dá 413', async () => {
    const text = await app.inject({ method: 'POST', url: '/api/time-blocks', cookies: ana, headers: { 'content-type': 'text/plain' }, payload: 'x' });
    assert.equal(text.statusCode, 415);
    const big = await postTimeBlock(app, ana, block({ pad: 'x'.repeat(17 * 1024) }));
    assert.equal(big.statusCode, 413);
    assert.equal(await countBlocks(), 0);
  });
});

describe('listagem (critério 13)', () => {
  test('ordem por início; encerrado sai da lista padrão e volta com from/to', async () => {
    const later = await created(block({ start: '2026-12-24T14:00', end: '2026-12-24T18:00' }));
    const soon = await created(block({ start: '2026-12-02T08:00', end: '2026-12-02T09:00' }));
    assert.deepEqual((await listTimeBlocks(app, ana)).json().timeBlocks.map((b) => b.id), [soon.id, later.id]);

    clock.advance(2 * DAY_MS); // 2026-12-03
    assert.deepEqual((await listTimeBlocks(app, ana)).json().timeBlocks.map((b) => b.id), [later.id]);
    const period = (await listTimeBlocks(app, ana, { from: '2026-12-02', to: '2026-12-02' })).json();
    assert.deepEqual(period.timeBlocks.map((b) => b.id), [soon.id]);
  });

  test('filtro: <P> traz P + "todos"; all traz só "todos"; UUID alheio e inexistente dão o mesmo corpo vazio', async () => {
    const other = await createProfessional(app, ana, { name: 'Bia Lima' });
    const mine = await created(block());
    const all = await created(block({ professionalId: null }));
    await created(block({ professionalId: other.id }));

    const forP = (await listTimeBlocks(app, ana, { professionalId: professional.id })).json().timeBlocks;
    assert.deepEqual(forP.map((b) => b.id).sort(), [mine.id, all.id].sort());
    const onlyAll = (await listTimeBlocks(app, ana, { professionalId: 'all' })).json().timeBlocks;
    assert.deepEqual(onlyAll.map((b) => b.id), [all.id]);

    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    await createBusinessFor(app, bia, { name: 'Salão da Bia' });
    const foreignP = await createProfessional(app, bia);
    const foreign = await listTimeBlocks(app, ana, { professionalId: foreignP.id });
    const missing = await listTimeBlocks(app, ana, { professionalId: randomUUID() });
    assert.equal(foreign.statusCode, 200);
    assert.deepEqual(foreign.json(), missing.json());
    assert.deepEqual(foreign.json().timeBlocks, []);
  });

  test('query inválida: 400 com fields fixos', async () => {
    const res = await listTimeBlocks(app, ana, { professionalId: 'x', from: '2026-02-30', to: '2026-12-01' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, { professionalId: M.targetRequired, from: M.dateInvalid });
    const range = await listTimeBlocks(app, ana, { from: '2026-12-02', to: '2026-12-01' });
    assert.deepEqual(range.json().error.fields, { to: M.rangeInvalid });
  });

  test('truncated com mais de 500 no período', async () => {
    for (let i = 0; i < 501; i++) {
      await app.db.run(
        `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
         VALUES (?, ?, NULL, '2026-11-20T12:00:00.000Z', '2026-11-20T13:00:00.000Z', NULL, NULL, ?)`,
        [randomUUID(), business.id, '2026-11-01T00:00:00.000Z'],
      );
    }
    const res = (await listTimeBlocks(app, ana, { from: '2026-11-20', to: '2026-11-20' })).json();
    assert.equal(res.timeBlocks.length, 500);
    assert.equal(res.truncated, true);
  });
});

describe('remoção (critérios 14 e 15)', () => {
  test('204 e findApplicable deixa de devolver, sem reinício', async () => {
    const tb = await created(block());
    const range = ['2026-12-24T00:00:00.000Z', '2026-12-25T00:00:00.000Z'];
    const repo = app.services.timeBlocksRepository;
    assert.equal((await repo.findApplicable(business.id, professional.id, ...range)).length, 1);
    const res = await deleteTimeBlock(app, ana, tb.id);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
    assert.deepEqual(await repo.findApplicable(business.id, professional.id, ...range), []);
    assert.deepEqual((await listTimeBlocks(app, ana)).json().timeBlocks, []);
  });

  test('remover encerrado (ainda retido) é permitido', async () => {
    const tb = await created(block({ start: '2026-12-02T08:00', end: '2026-12-02T09:00' }));
    clock.advance(2 * DAY_MS);
    assert.equal((await deleteTimeBlock(app, ana, tb.id)).statusCode, 204);
  });
});

describe('isolamento e segurança (critérios 19 a 21)', () => {
  test('401 sem sessão em GET, POST e DELETE, sem alterar nada', async () => {
    const tb = await created(block());
    for (const res of [
      await listTimeBlocks(app, {}),
      await postTimeBlock(app, {}, block()),
      await deleteTimeBlock(app, {}, tb.id),
    ]) {
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
    }
    assert.equal(await countBlocks(), 1);
  });

  test('409 BUSINESS_REQUIRED para dono sem negócio', async () => {
    const cris = await signupAndLogin(app, { email: 'cris@x.com' });
    for (const res of [
      await listTimeBlocks(app, cris),
      await postTimeBlock(app, cris, block({ professionalId: null })),
      await deleteTimeBlock(app, cris, randomUUID()),
    ]) {
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json().error, { code: 'BUSINESS_REQUIRED', message: M.businessRequired });
    }
  });

  test('dono B: profissional de A, inexistente e removido dão o mesmo 404; bloqueio de A dá TIME_BLOCK_NOT_FOUND', async () => {
    const tb = await created(block());
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    await createBusinessFor(app, bia, { name: 'Salão da Bia' });
    const removed = await createProfessional(app, bia, { name: 'Removida' });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${removed.id}`, cookies: bia })).statusCode, 204);

    const bodies = [];
    for (const id of [professional.id, randomUUID(), removed.id, 'nao-e-uuid']) {
      const res = await postTimeBlock(app, bia, block({ professionalId: id }));
      assert.equal(res.statusCode, 404);
      bodies.push(res.body);
    }
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(JSON.parse(bodies[0]), {
      error: { code: 'PROFESSIONAL_NOT_FOUND', message: PROFESSIONAL_MESSAGES.notFound },
    });

    const foreign = await deleteTimeBlock(app, bia, tb.id);
    const missing = await deleteTimeBlock(app, bia, randomUUID());
    const malformed = await deleteTimeBlock(app, bia, 'x');
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.body, missing.body);
    assert.equal(foreign.body, malformed.body);
    assert.deepEqual(foreign.json().error, { code: 'TIME_BLOCK_NOT_FOUND', message: M.notFound });
    assert.equal(await countBlocks(), 1);
    assert.deepEqual((await listTimeBlocks(app, bia)).json().timeBlocks, []);
  });

  test('businessId no corpo e na query é ignorado', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com' });
    const biaBusiness = await createBusinessFor(app, bia, { name: 'Salão da Bia' });
    await created(block({ professionalId: null, businessId: biaBusiness.id }));
    const row = await app.db.get('SELECT business_id FROM time_blocks');
    assert.equal(row.business_id, business.id);
    assert.deepEqual((await listTimeBlocks(app, bia, { businessId: business.id })).json().timeBlocks, []);
  });

  test('CSRF: Origin de outro site em POST e DELETE dá 403 e nada muda', async () => {
    const tb = await created(block());
    const headers = { origin: 'https://evil.example' };
    const post = await postTimeBlock(app, ana, block(), { headers });
    const del = await deleteTimeBlock(app, ana, tb.id, { headers });
    for (const res of [post, del]) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
    }
    assert.equal(await countBlocks(), 1);
  });
});

describe('remoção do profissional (critério 17)', () => {
  test('depois do DELETE /api/professionals/:id, o bloqueio dele some do GET e do banco; o de "todos" fica', async () => {
    await created(block());
    const all = await created(block({ professionalId: null }));
    const res = await app.inject({ method: 'DELETE', url: `/api/professionals/${professional.id}`, cookies: ana });
    assert.equal(res.statusCode, 204);
    assert.deepEqual((await listTimeBlocks(app, ana)).json().timeBlocks.map((b) => b.id), [all.id]);
    assert.equal(await countBlocks(), 1);
  });
});

describe('fuso (critério 18) e horário de verão', () => {
  test('com process.env.TZ em UTC, Asia/Tokyo e America/Sao_Paulo, o mesmo POST grava o mesmo startsAt', async () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = zone;
        const tb = await created(block());
        assert.equal(tb.startsAt, '2026-12-24T17:00:00.000Z', zone);
        const listed = (await listTimeBlocks(app, ana)).json().timeBlocks.find((b) => b.id === tb.id);
        assert.equal(listed.start, '2026-12-24T14:00', zone);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('o fuso do negócio manda: em Asia/Tokyo, 14:00 vira 05:00Z', async () => {
    await setBusinessTimezone(app, business.id, 'Asia/Tokyo');
    const tb = await created(block());
    assert.equal(tb.startsAt, '2026-12-24T05:00:00.000Z');
    assert.equal(tb.start, '2026-12-24T14:00');
    assert.equal((await listTimeBlocks(app, ana)).json().timezone, 'Asia/Tokyo');
  });

  test('America/New_York: 02:30 de 2027-03-14 dá 201 com TIME_BLOCK_TIME_ADJUSTED e start 03:30', async () => {
    // Relógio em 2027-03-01 desde o cadastro (avançar 3 meses expiraria a sessão).
    await app.close();
    await setup({}, '2027-03-01T12:00:00.000Z');
    await setBusinessTimezone(app, business.id, 'America/New_York');
    const res = await postTimeBlock(app, ana, block({ start: '2027-03-14T02:30', end: '2027-03-14T06:00' }));
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.warnings[0].code, 'TIME_BLOCK_TIME_ADJUSTED');
    assert.equal(body.warnings[0].message, M.timeAdjusted('03:30'));
    assert.equal(body.timeBlock.start, '2027-03-14T03:30');
    assert.equal(body.timeBlock.startsAt, '2027-03-14T07:30:00.000Z');
  });
});

describe('conflitos pela API (critérios 9 a 11)', () => {
  function swapService(port) {
    app.services.timeBlocksService = createTimeBlocksService({
      db: app.db,
      timeBlocksRepository: app.services.timeBlocksRepository,
      professionalsRepository: app.services.professionalsRepository,
      businessesRepository: app.services.businessesRepository,
      appointments: port,
      now: clock.now,
    });
  }

  test('409 TIME_BLOCK_CONFLICTS com lista e token; reenvio com o token dá 201', async () => {
    swapService({
      findConflictsForBlock: async () => ({
        total: 1,
        versionKey: 'v1',
        items: [
          {
            id: randomUUID(),
            startsAt: '2026-12-24T17:30:00.000Z',
            endsAt: '2026-12-24T18:00:00.000Z',
            serviceName: 'Corte',
            professionalId: professional.id,
            professionalName: 'Ana Souza',
            customerName: 'Bia',
          },
        ],
      }),
    });
    const first = await postTimeBlock(app, ana, block());
    assert.equal(first.statusCode, 409);
    const { error } = first.json();
    assert.equal(error.code, 'TIME_BLOCK_CONFLICTS');
    assert.equal(error.message, M.conflicts);
    assert.equal(error.conflictsTotal, 1);
    assert.deepEqual(error.conflicts, [
      { start: '2026-12-24T14:30', end: '2026-12-24T15:00', serviceName: 'Corte', professionalName: 'Ana Souza', customerName: 'Bia' },
    ]);
    assert.equal(error.conflictsToken.length, 43);
    assert.equal(await countBlocks(), 0);

    const second = await postTimeBlock(app, ana, block({ confirmConflictsToken: error.conflictsToken }));
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().acknowledgedConflictsCount, 1);
  });

  test('porta que falha: 503 CONFLICTS_UNAVAILABLE', async () => {
    swapService({
      findConflictsForBlock: async () => {
        throw new Error('fora');
      },
    });
    const res = await postTimeBlock(app, ana, block());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json().error, { code: 'CONFLICTS_UNAVAILABLE', message: M.conflictsUnavailable });
  });
});

describe('corpo dos erros (body)', () => {
  function render(error) {
    let status;
    let payload;
    const reply = {
      header() {
        return reply;
      },
      status(code) {
        status = code;
        return reply;
      },
      send(body) {
        payload = body;
        return reply;
      },
    };
    errorHandler(error, { log: { error() {} }, routeOptions: {} }, reply);
    return { status, payload };
  }

  test('campos de conflito só em TimeBlockConflictsError; os outros erros não mudam', () => {
    const conflicts = render(
      new TimeBlockConflictsError('TIME_BLOCK_CONFLICTS', M.conflicts, { conflicts: [], conflictsTotal: 0, conflictsToken: 't' }),
    );
    assert.deepEqual(conflicts, {
      status: 409,
      payload: { error: { code: 'TIME_BLOCK_CONFLICTS', message: M.conflicts, conflictsTotal: 0, conflicts: [], conflictsToken: 't' } },
    });
    assert.deepEqual(render(new ProfessionalHasAppointmentsError(2)).payload.error, {
      code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS',
      message: PROFESSIONAL_MESSAGES.hasFutureAppointments,
      futureAppointmentsCount: 2,
    });
    assert.deepEqual(render(new ValidationError({ a: 'b' })).payload, {
      error: { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields: { a: 'b' } },
    });
    assert.deepEqual(render(new ServiceUnavailableError('X', 'y')), { status: 503, payload: { error: { code: 'X', message: 'y' } } });
  });
});

describe('página pública e logs (critério 23)', () => {
  test('GET /<slug> não contém o motivo nem "bloque"; rotas sem sessão não expõem time_blocks', async () => {
    await created(block({ reasonKind: 'vacation', reasonNote: 'Férias da Ana' }));
    const page = await app.inject({ method: 'GET', url: `/${business.slug}`, headers: { accept: 'text/html' } });
    assert.equal(page.statusCode, 200);
    assert.ok(!page.body.includes('Férias da Ana'));
    assert.ok(!/bloque/i.test(page.body));
    const anon = await listTimeBlocks(app, {});
    assert.equal(anon.statusCode, 401);
    assert.ok(!anon.body.includes('Férias'));
  });

  test('a página /bloqueios é servida', async () => {
    const res = await app.inject({ method: 'GET', url: '/bloqueios' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /bloqueios-page\.js/);
  });

  test('logs sem motivo nem nomes', async () => {
    const tb = await created(block({ reasonNote: 'Motivo Secreto' }));
    await deleteTimeBlock(app, ana, tb.id);
    const text = logs();
    assert.ok(text.includes('time_block_created'));
    assert.ok(text.includes('time_block_removed'));
    assert.ok(!text.includes('Motivo Secreto'));
    assert.ok(!text.includes('Ana Souza'));
  });
});

describe('boot', () => {
  test('purgeExpired roda no boot: encerrado há mais de 90 dias some ao reabrir o banco', async () => {
    // O banco :memory: não sobrevive ao fechamento: chama o serviço do app como o boot faz.
    await app.db.run(
      `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
       VALUES (?, ?, NULL, '2026-08-01T12:00:00.000Z', '2026-08-02T12:00:00.000Z', NULL, NULL, ?)`,
      [randomUUID(), business.id, '2026-08-01T00:00:00.000Z'],
    );
    assert.equal(await app.services.timeBlocksService.purgeExpired(), 1);
    assert.equal(await countBlocks(), 0);
  });
});
