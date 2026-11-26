// AF-14 (design 4.1 e 6.1, critérios 1 a 3, 5 a 10, 12 a 20, 32 e 33): leitura da agenda e detalhe.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  agendaApp,
  secondBusiness,
  bookReal,
  getAgenda,
  getAgendaAppointment,
  cancelAgenda,
  agendaVersionOf,
  assertAgendaTree,
  assertDetailTree,
  allItems,
  seedWeek,
  insertServiceDirect,
  spUtc,
} from '../helpers/agenda.js';
import { signupAndLogin, postTimeBlock } from '../helpers/session.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { rescheduleManage, cancelManage, versionOf } from '../helpers/manage.js';
import { createAgendaService } from '../../src/modules/agenda/agenda.service.js';
import { AGENDA_MESSAGES as M } from '../../src/shared/agenda.js';
import { hashManageToken } from '../../src/modules/appointments/manage-token.js';

const WEEK = { from: '2026-11-23', to: '2026-11-29' };
const FRI = '2026-11-27';
let ctx;

const dayOf = (body, date) => body.days.find((d) => d.date === date);
const appointmentsOf = (body) => allItems(body).filter((i) => i.type === 'appointment');

/** Serviço da agenda com uma dependência trocada (503, atomicidade). */
function swapService(app, patch) {
  const s = app.services;
  return createAgendaService({
    db: app.db,
    businessesRepository: s.businessesRepository,
    professionalsRepository: s.professionalsRepository,
    appointmentsRepository: s.appointmentsRepository,
    timeBlocksRepository: s.timeBlocksRepository,
    customersRepository: s.customersRepository,
    manageTokensRepository: s.manageTokensRepository,
    reschedulesRepository: s.reschedulesRepository,
    emailEnabled: app.config.email.enabled,
    now: () => new Date('2026-11-26T12:00:00.000Z'),
    log: app.log,
    ...patch,
  });
}

function assertSecurityHeaders(res, label) {
  assert.equal(res.headers['cache-control'], 'no-store', label);
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, `${label}: CSP`);
  assert.doesNotMatch(csp, /unsafe-inline/, label);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
  assert.ok(res.headers['x-frame-options'], `${label}: x-frame-options`);
}

describe('acesso, validação e isolamento (critérios 1 a 3)', () => {
  beforeEach(async () => {
    ctx = await agendaApp();
  });
  afterEach(() => ctx.app.close());

  test('401 sem sessão nas três rotas, sem chamar o serviço; 409 BUSINESS_REQUIRED sem negócio', async () => {
    const { app } = ctx;
    const real = app.services.agendaService;
    const calls = [];
    app.services.agendaService = new Proxy(real, { get: (t, k) => (calls.push(k), t[k]) });
    const id = randomUUID();
    for (const res of [await getAgenda(app, undefined), await getAgendaAppointment(app, undefined, id), await cancelAgenda(app, undefined, id, { version: 'a'.repeat(43) })]) {
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().error.code, 'UNAUTHENTICATED');
    }
    assert.deepEqual(calls, []);
    app.services.agendaService = real;
    const noBiz = await signupAndLogin(app, { email: 'sem@x.com' });
    for (const res of [await getAgenda(app, noBiz), await getAgendaAppointment(app, noBiz, id), await cancelAgenda(app, noBiz, id, { version: 'a'.repeat(43) })]) {
      assert.equal(res.statusCode, 409, res.body);
      assert.deepEqual(res.json().error, { code: 'BUSINESS_REQUIRED', message: M.businessRequired });
    }
  });

  test('400 com fields e mensagens fixas; datas ausentes = hoje; businessId na query ignorado', async () => {
    const { app, cookies } = ctx;
    const cases = [
      [{ from: '2026-11-27' }, { to: M.datePairRequired }],
      [{ from: '2026-11-23', to: '2026-11-30' }, { to: M.rangeInvalid }],
      [{ from: '2026-02-30', to: '2026-02-30' }, { from: M.dateInvalid, to: M.dateInvalid }],
      [{ from: '2025-11-24', to: '2025-11-24' }, { from: M.outOfWindow, to: M.outOfWindow }],
      [{ professionalId: 'nao-e-uuid' }, { professionalId: M.professionalInvalid }],
      [{ includeCancelled: '1' }, { includeCancelled: M.includeCancelledInvalid }],
    ];
    for (const [query, fields] of cases) {
      const res = await getAgenda(app, cookies, query);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
      assert.deepEqual(res.json().error, { code: 'VALIDATION_ERROR', message: M.checkFields, fields });
      assertSecurityHeaders(res, '400');
    }
    const today = (await getAgenda(app, cookies)).json();
    assert.equal(today.from, '2026-11-26');
    assert.equal(today.to, '2026-11-26');
    assert.equal(today.now, '2026-11-26T09:00');
    assert.equal(today.timezone, 'America/Sao_Paulo');
    assert.deepEqual(today.days.map((d) => [d.date, d.weekday]), [['2026-11-26', 4]]);
    const other = await secondBusiness(app);
    const withForeign = (await getAgenda(app, cookies, { businessId: other.business.id })).json();
    assert.deepEqual(withForeign, today);
  });

  test('dois negócios no mesmo horário: nada do outro aparece; professionalId alheio, inexistente e removido dão o mesmo 200 vazio', async () => {
    const { app, cookies } = ctx;
    const other = await secondBusiness(app);
    const mine = await bookReal(app, ctx, { start: `${FRI}T10:00` });
    await bookReal(app, other, { start: `${FRI}T10:00` });
    await postTimeBlock(app, other.cookies, { professionalId: null, start: `${FRI}T15:00`, end: `${FRI}T16:00`, reasonNote: 'Segredo do outro' });
    const body = (await getAgenda(app, cookies, { ...WEEK, includeCancelled: 'true' })).json();
    const items = allItems(body);
    assert.deepEqual(items.map((i) => i.id), [mine.id]);
    const text = JSON.stringify(body);
    for (const leak of [other.business.id, other.pros[0].id, 'Caio Prado', 'Escova', 'Segredo do outro']) assert.ok(!text.includes(leak), leak);

    // Removido: a rota de remoção do AF-07 (sem agendamentos futuros).
    const extra = await (await import('../helpers/session.js')).createProfessional(app, cookies, { name: 'Removida' });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${extra.id}`, cookies, headers: { 'sec-fetch-site': 'same-origin' } })).statusCode, 204);
    const bodies = [];
    for (const pid of [other.pros[0].id, randomUUID(), extra.id]) {
      const res = await getAgenda(app, cookies, { ...WEEK, professionalId: pid });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.ok(json.days.every((d) => d.items.length === 0 && d.counts.active === 0));
      bodies.push(res.body);
    }
    assert.equal(new Set(bodies).size, 1);
  });

  test('varredura: nenhuma rota /api/agenda/export*; toda rota sob /api/agenda exige sessão', async () => {
    const routes = ctx.app.printRoutes({ commonPrefix: false });
    assert.doesNotMatch(routes, /export/i);
    for (const url of ['/api/agenda/export', '/api/agenda/export.csv', '/api/agenda/appointments/export']) {
      const res = await ctx.app.inject({ method: 'GET', url, cookies: ctx.cookies });
      assert.ok([404, 401].includes(res.statusCode), `${url}: ${res.statusCode}`);
      assert.notEqual(res.headers['content-type']?.includes('csv'), true);
    }
  });
});

describe('formato e conteúdo (critérios 4 a 13)', () => {
  beforeEach(async () => {
    ctx = await agendaApp();
  });
  afterEach(() => ctx.app.close());

  test('árvore de chaves fixa, quatro status, cancelados ocultos com counts, origens e remarcado', async () => {
    const { app, cookies, business, service, pros } = ctx;
    const a = await bookReal(app, ctx, { start: `${FRI}T09:00` });
    const byCustomer = await bookReal(app, ctx, { start: `${FRI}T10:00` });
    const byOwner = await bookReal(app, ctx, { start: `${FRI}T11:00` });
    const moved = await bookReal(app, ctx, { start: `${FRI}T13:00` });
    const legacy = await bookReal(app, ctx, { start: `${FRI}T14:00` });
    assert.equal((await cancelManage(app, byCustomer.token, { version: await versionOf(app, byCustomer.token) })).statusCode, 200);
    assert.equal((await cancelAgenda(app, cookies, byOwner.id, { version: await agendaVersionOf(app, business.id, byOwner.id) })).statusCode, 200);
    const rs = await rescheduleManage(app, moved.token, { start: `${FRI}T16:00`, version: await versionOf(app, moved.token) });
    assert.equal(rs.statusCode, 200, rs.body);
    await app.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = '2026-11-26T11:00:00.000Z', updated_at = '2026-11-26T11:00:00.000Z' WHERE id = ?", [legacy.id]);
    const customerId = await insertCustomerDirect(app.db, business.id);
    const done = await insertAppointmentDirect(app.db, { businessId: business.id, professionalId: pros[1].id, customerId, serviceId: service.id, startsAt: spUtc(`${FRI}T09:00`), status: 'completed' });
    const noShow = await insertAppointmentDirect(app.db, { businessId: business.id, professionalId: pros[1].id, customerId, serviceId: service.id, startsAt: spUtc(`${FRI}T10:00`), status: 'no_show' });
    assert.equal((await postTimeBlock(app, cookies, { professionalId: pros[1].id, start: `${FRI}T12:00`, end: `${FRI}T13:00`, reasonKind: 'other', reasonNote: 'Almoço' })).statusCode, 201);

    const hidden = (await getAgenda(app, cookies, WEEK)).json();
    assertAgendaTree(hidden);
    assert.equal(hidden.days.length, 7);
    assert.deepEqual(hidden.days.map((d) => d.weekday), [1, 2, 3, 4, 5, 6, 7]);
    const fri = dayOf(hidden, FRI);
    assert.deepEqual(fri.counts, { active: 4, cancelled: 3, rescheduled: 1 });
    const newId = (await app.db.get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [moved.id])).appointment_id;
    assert.deepEqual(fri.items.filter((i) => i.type === 'appointment').map((i) => i.id).sort(), [a.id, done, noShow, newId].sort());
    assert.deepEqual(new Set(appointmentsOf(hidden).map((i) => i.status)), new Set(['confirmed', 'completed', 'no_show']));

    const shown = (await getAgenda(app, cookies, { ...WEEK, includeCancelled: 'true' })).json();
    const tree = assertAgendaTree(shown);
    assert.equal(tree.blocks, 1);
    assert.deepEqual(dayOf(shown, FRI).counts, fri.counts, 'counts independem do interruptor');
    const byId = new Map(appointmentsOf(shown).map((i) => [i.id, i]));
    assert.deepEqual(byId.get(byCustomer.id).cancelled, { by: 'customer', at: '2026-11-26T09:00' });
    assert.deepEqual(byId.get(byOwner.id).cancelled, { by: 'owner', at: '2026-11-26T09:00' });
    assert.equal(byId.get(moved.id).cancelled.by, 'reschedule');
    assert.deepEqual(byId.get(legacy.id).cancelled, { by: null, at: '2026-11-26T08:00' });
    assert.equal(byId.get(a.id).cancelled, null);
    assert.equal(byId.get(a.id).start, `${FRI}T09:00`);
    assert.equal(byId.get(a.id).professional.name, 'Ana Souza');
    // Ordem (critério 7): início, bloqueio antes, nome do profissional, id.
    const order = dayOf(shown, FRI).items.map((i) => `${i.start}|${i.type}|${i.professional?.name ?? ''}`);
    assert.deepEqual(order, [...order].sort((x, y) => {
      const [sx, tx, nx] = x.split('|');
      const [sy, ty, ny] = y.split('|');
      if (sx !== sy) return sx < sy ? -1 : 1;
      if (tx !== ty) return tx === 'block' ? -1 : 1;
      return nx < ny ? -1 : nx > ny ? 1 : 0;
    }));
    // Lista não tem contato: nenhum telefone nem e-mail.
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(a.customer.email) && !text.includes(a.customer.phone));
    assert.doesNotMatch(text, /Z"/, 'nenhum instante UTC');
  });

  test('profissional removido continua com nome e removed: true em all; bloqueios de todos, do profissional, de outro e de 3 dias', async () => {
    const { app, cookies, business, service, pros } = ctx;
    const customerId = await insertCustomerDirect(app.db, business.id);
    const old = await insertAppointmentDirect(app.db, { businessId: business.id, professionalId: pros[1].id, customerId, serviceId: service.id, startsAt: spUtc('2026-11-24T10:00') });
    await app.db.run("UPDATE professionals SET removed_at = '2026-11-25T12:00:00.000Z' WHERE id = ?", [pros[1].id]);
    const allDay = await postTimeBlock(app, cookies, { professionalId: null, start: '2026-11-25T00:00', end: '2026-11-28T00:00', reasonKind: 'holiday', reasonNote: 'Feriado local' });
    assert.equal(allDay.statusCode, 201, allDay.body);
    const extra = await (await import('../helpers/session.js')).createProfessional(app, cookies, { name: 'Carla' });
    const own = await postTimeBlock(app, cookies, { professionalId: pros[0].id, start: `${FRI}T15:00`, end: `${FRI}T16:00` });
    const foreign = await postTimeBlock(app, cookies, { professionalId: extra.id, start: `${FRI}T15:00`, end: `${FRI}T16:00` });
    assert.equal(own.statusCode, 201);
    assert.equal(foreign.statusCode, 201);

    const all = (await getAgenda(app, cookies, WEEK)).json();
    const item = appointmentsOf(all).find((i) => i.id === old);
    assert.deepEqual(item.professional, { id: pros[1].id, name: 'Bia Lima', removed: true });
    const blockDays = all.days.filter((d) => d.items.some((i) => i.id === allDay.json().timeBlock.id)).map((d) => d.date);
    assert.deepEqual(blockDays, ['2026-11-25', '2026-11-26', '2026-11-27']);
    const holiday = dayOf(all, '2026-11-26').items.find((i) => i.type === 'block');
    assert.deepEqual(holiday, { type: 'block', id: allDay.json().timeBlock.id, start: '2026-11-25T00:00', end: '2026-11-28T00:00', allDay: true, professional: null, reason: { kind: 'holiday', note: 'Feriado local' } });
    assert.equal(dayOf(all, FRI).items.filter((i) => i.type === 'block').length, 3);

    const filtered = (await getAgenda(app, cookies, { ...WEEK, professionalId: pros[0].id })).json();
    const ids = dayOf(filtered, FRI).items.map((i) => i.id);
    assert.ok(ids.includes(own.json().timeBlock.id));
    assert.ok(ids.includes(allDay.json().timeBlock.id));
    assert.ok(!ids.includes(foreign.json().timeBlock.id));
    assert.ok(!appointmentsOf(filtered).some((i) => i.id === old));
    // Filtrar pelo removido: lista vazia (C-2).
    const removedFilter = (await getAgenda(app, cookies, { ...WEEK, professionalId: pros[1].id })).json();
    assert.equal(allItems(removedFilter).length, 0);
  });
});

describe('teto, volume e bloqueios demais (critério 14)', () => {
  before(async () => {
    ctx = await agendaApp();
  });
  after(() => ctx.app.close());

  test('1.001 agendamentos na semana: 1.000 itens, truncated, counts exatos', async () => {
    const { app, cookies, business } = ctx;
    const serviceId = await insertServiceDirect(app.db, business.id, { durationMinutes: 15 });
    const days = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];
    await seedWeek(app.db, { businessId: business.id, serviceId, days, perDay: 13, professionals: 11 }); // 1.001
    const res = await getAgenda(app, cookies, WEEK);
    const body = res.json();
    assert.equal(appointmentsOf(body).length, 1000);
    assert.equal(body.truncated, true);
    assert.deepEqual(body.days.map((d) => d.counts.active), [143, 143, 143, 143, 143, 143, 143]);
    assert.equal(body.days[6].items.length, 142, 'o corte é no fim, na ordem dos dias');
    assertAgendaTree(body);
  });

  test('volume: 1.000 agendamentos em 20 profissionais, mediana de 5 GET da semana abaixo de 300 ms', async () => {
    const { app, cookies } = ctx;
    await app.db.run('DELETE FROM appointments');
    const serviceId = (await app.db.get('SELECT id FROM services WHERE duration_minutes = 15')).id;
    const days = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'];
    await seedWeek(app.db, { businessId: ctx.business.id, serviceId, days, perDay: 10, professionals: 20 });
    await getAgenda(app, cookies, WEEK);
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      const res = await getAgenda(app, cookies, WEEK);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.equal(appointmentsOf(res.json()).length, 1000);
      assert.equal(res.json().truncated, false);
    }
    times.sort((x, y) => x - y);
    assert.ok(times[2] < 300, `mediana ${times[2]} ms`);
  });

  test('mais de 500 bloqueios no período: truncated', async () => {
    const { app, cookies, business } = ctx;
    await app.db.run('DELETE FROM appointments');
    for (let i = 0; i < 501; i++) {
      const start = new Date(Date.parse('2026-11-24T12:00:00.000Z') + i * 60_000 * 15).toISOString();
      await app.db.run(
        `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL, '2026-11-20T12:00:00.000Z')`,
        [randomUUID(), business.id, start, new Date(Date.parse(start) + 15 * 60_000).toISOString()],
      );
    }
    const body = (await getAgenda(app, cookies, WEEK)).json();
    assert.equal(body.truncated, true);
    assert.equal(allItems(body).length, 500);
  });
});

describe('detalhe (critérios 17 a 19)', () => {
  beforeEach(async () => {
    ctx = await agendaApp();
  });
  afterEach(() => ctx.app.close());

  test('árvore fixa, contato do snapshot e e-mail de customers, tel:, cadeia de 2 remarcações e createdAt local', async () => {
    const { app, cookies, business } = ctx;
    const first = await bookReal(app, ctx, { start: `${FRI}T09:00`, customer: { name: 'Bia Cliente', phone: '(11) 91234-5678', email: 'Bia@Example.com' } });
    assert.equal((await rescheduleManage(app, first.token, { start: `${FRI}T10:00`, version: await versionOf(app, first.token) })).statusCode, 200);
    const secondId = (await app.db.get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [first.id])).appointment_id;
    assert.equal((await rescheduleManage(app, first.token, { start: `${FRI}T11:00`, version: await versionOf(app, first.token) })).statusCode, 200);
    const thirdId = (await app.db.get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [secondId])).appointment_id;

    const res = await getAgendaAppointment(app, cookies, secondId);
    assert.equal(res.statusCode, 200, res.body);
    assertSecurityHeaders(res, 'detalhe 200');
    const body = res.json();
    assertDetailTree(body);
    const a = body.appointment;
    assert.deepEqual(a.customer, { name: 'Bia Cliente', phoneDisplay: '(11) 91234-5678', phoneHref: 'tel:+5511912345678', email: 'bia@example.com' });
    assert.deepEqual(a.rescheduledFrom, { start: `${FRI}T09:00` });
    assert.deepEqual(a.rescheduledTo, { start: `${FRI}T11:00` });
    assert.equal(a.status, 'cancelled');
    assert.equal(a.cancelled.by, 'reschedule');
    assert.equal(a.canCancel, false);
    assert.equal(a.createdAt, '2026-11-26T09:00');
    assert.equal(a.weekday, 5);
    assert.equal(a.service.priceLabel, 'R$ 50,00');
    assert.equal(body.emailEnabled, app.config.email.enabled);
    const third = (await getAgendaAppointment(app, cookies, thirdId)).json();
    assert.equal(third.appointment.canCancel, true);
    assert.equal(third.appointment.rescheduledTo, null);
    // Sem ids internos, instantes UTC, token ou hash.
    const text = res.body;
    assert.doesNotMatch(text, /Z"/);
    assert.ok(!text.includes(business.id));
    const customerId = (await app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [secondId])).customer_id;
    assert.ok(!text.includes(customerId));
    for (const t of await app.db.all('SELECT token_hash FROM appointment_manage_tokens')) assert.ok(!text.includes(t.token_hash));
    assert.ok(!text.includes(first.token));
    assert.doesNotMatch(text, /customerId|businessId|serviceId|token/);
  });

  test('canCancel: futuro, em andamento e encerrado', async () => {
    const { app, cookies, business, service, pros } = ctx;
    const customerId = await insertCustomerDirect(app.db, business.id);
    const ins = (local) => insertAppointmentDirect(app.db, { businessId: business.id, professionalId: pros[0].id, customerId, serviceId: service.id, startsAt: spUtc(local) });
    const ongoing = await ins('2026-11-26T08:30');
    const ended = await ins('2026-11-26T07:00');
    const future = await ins('2026-11-26T10:00');
    const can = async (id) => (await getAgendaAppointment(app, cookies, id)).json().appointment.canCancel;
    assert.equal(await can(future), true);
    assert.equal(await can(ongoing), true);
    assert.equal(await can(ended), false);
  });

  test('404 idêntico para malformado, inexistente e de outro negócio', async () => {
    const { app, cookies } = ctx;
    const other = await secondBusiness(app);
    const foreign = await bookReal(app, other, { start: `${FRI}T10:00` });
    const responses = [];
    for (const id of ['nao-e-uuid', 'x'.repeat(99), randomUUID(), foreign.id, foreign.id.toUpperCase()]) {
      const res = await getAgendaAppointment(app, cookies, id);
      assert.equal(res.statusCode, 404, id);
      assertSecurityHeaders(res, '404');
      responses.push(res);
    }
    const strip = (h) => {
      const { date: _d, 'content-length': _l, ...rest } = h;
      return rest;
    };
    for (const r of responses) {
      assert.equal(r.body, responses[0].body);
      assert.deepEqual(strip(r.headers), strip(responses[0].headers));
    }
    assert.deepEqual(responses[0].json().error, { code: 'APPOINTMENT_NOT_FOUND', message: M.notFound });
  });
});

describe('cabeçalhos, limites, 503 e logs (critérios 15, 16, 29 e 33)', () => {
  afterEach(() => ctx.app.close());

  test('cabeçalhos de segurança e no-store em 200, 400, 401, 404, 409, 413, 415 e 503', async () => {
    ctx = await agendaApp();
    const { app, cookies } = ctx;
    const id = randomUUID();
    const noBiz = await signupAndLogin(app, { email: 'nb@x.com' });
    const checks = [
      ['200', await getAgenda(app, cookies), 200],
      ['400', await getAgenda(app, cookies, { from: 'x', to: 'y' }), 400],
      ['401', await getAgenda(app, undefined), 401],
      ['404', await getAgendaAppointment(app, cookies, id), 404],
      ['409', await getAgenda(app, noBiz), 409],
      ['413', await cancelAgenda(app, cookies, id, { payload: { version: 'a'.repeat(43), pad: 'x'.repeat(17 * 1024) } }), 413],
      ['415', await cancelAgenda(app, cookies, id, { payload: 'version=x', headers: { 'content-type': 'text/plain' } }), 415],
    ];
    app.services.agendaService = swapService(app, {
      appointmentsRepository: { ...app.services.appointmentsRepository, listForAgenda: async () => { throw Object.assign(new Error('segredo interno do banco'), { code: 'SQLITE_IOERR' }); } },
    });
    checks.push(['503', await getAgenda(app, cookies), 503]);
    for (const [label, res, status] of checks) {
      assert.equal(res.statusCode, status, `${label}: ${res.body}`);
      assertSecurityHeaders(res, label);
    }
    const unavailable = checks.at(-1)[1];
    assert.deepEqual(unavailable.json().error, { code: 'AGENDA_UNAVAILABLE', message: M.unavailable });
    assert.doesNotMatch(unavailable.body, /segredo/);
    assert.match(ctx.logs(), /"event":"agenda_failed","operation":"list","errCode":"SQLITE_IOERR"/);
    assert.doesNotMatch(ctx.logs(), /segredo interno/);
  });

  test('agendaRead (usuário e IP) e agendaCancel independentes nos dois sentidos, com Retry-After', async () => {
    ctx = await agendaApp({
      rateLimit: { enabled: true, signupMax: 100, agendaRead: { perUser: 2, perIp: 100 }, agendaCancel: { perUser: 2, perIp: 100 } },
    });
    const { app, cookies } = ctx;
    const id = randomUUID();
    const v = { version: 'a'.repeat(43) };
    assert.equal((await getAgenda(app, cookies)).statusCode, 200);
    assert.equal((await getAgenda(app, cookies)).statusCode, 200);
    const limited = await getAgenda(app, cookies);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assertSecurityHeaders(limited, '429');
    // Detalhe tem contador próprio; o cancelamento também.
    assert.equal((await getAgendaAppointment(app, cookies, id)).statusCode, 404);
    assert.equal((await cancelAgenda(app, cookies, id, v)).statusCode, 404);
    assert.equal((await cancelAgenda(app, cookies, id, v)).statusCode, 404);
    const cancelLimited = await cancelAgenda(app, cookies, id, v);
    assert.equal(cancelLimited.statusCode, 429);
    assert.ok(cancelLimited.headers['retry-after']);
    assert.equal((await getAgendaAppointment(app, cookies, id)).statusCode, 404, 'o cancelamento não consome a leitura');
    await app.close();

    ctx = await agendaApp({
      rateLimit: { enabled: true, signupMax: 100, agendaRead: { perUser: 100, perIp: 2 }, agendaCancel: { perUser: 100, perIp: 100 } },
    });
    const other = await signupAndLogin(ctx.app, { email: 'b@x.com' });
    assert.equal((await getAgenda(ctx.app, ctx.cookies)).statusCode, 200);
    assert.equal((await getAgenda(ctx.app, other)).statusCode, 409);
    assert.equal((await getAgenda(ctx.app, ctx.cookies)).statusCode, 429, 'o IP soma os usuários');
    assert.equal((await getAgenda(ctx.app, ctx.cookies, {}, { remoteAddress: '10.1.1.1' })).statusCode, 200);
  });

  test('logs em debug: nenhuma linha com nome, telefone, e-mail ou horário local do agendamento', async () => {
    ctx = await agendaApp({ logLevel: 'debug' });
    const { app, cookies, business } = ctx;
    const customer = { name: 'Zuleica Marcadora', phone: '(31) 97777-1234', email: 'zuleica.marcadora@example.com' };
    const b = await bookReal(app, ctx, { start: `${FRI}T14:00`, customer });
    const mark = ctx.logs().length;
    await getAgenda(app, cookies, { ...WEEK, includeCancelled: 'true' });
    await getAgendaAppointment(app, cookies, b.id);
    const res = await cancelAgenda(app, cookies, b.id, { version: await agendaVersionOf(app, business.id, b.id) });
    assert.equal(res.statusCode, 200);
    await cancelAgenda(app, cookies, b.id, { version: await agendaVersionOf(app, business.id, b.id) });
    const out = ctx.logs().slice(mark);
    for (const needle of ['Zuleica', 'zuleica', '31977771234', '97777-1234', `${FRI}T14:00`, '2026-11-27T17:00', hashManageToken(b.token)]) {
      assert.ok(!out.includes(needle), needle);
    }
    assert.match(out, /"event":"appointment_cancelled_by_owner"/);
    assert.match(out, /"event":"appointment_owner_cancel_repeated"/);
  });
});
