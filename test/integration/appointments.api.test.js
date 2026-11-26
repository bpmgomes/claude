import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import {
  signupAndLogin,
  createBusinessFor,
  createService,
  createProfessional,
  putHours,
  postTimeBlock,
  getAvailability,
  setBusinessTimezone,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { bookingBody, postAppointment, countAppointments, cancelDirect } from '../helpers/appointments.js';
import { countCustomers } from '../helpers/customers.js';
import { PUBLIC_APPOINTMENT_FIELDS } from '../../src/modules/appointments/appointments.view.js';
import { createAppointmentsService } from '../../src/modules/appointments/appointments.service.js';
import { APPOINTMENT_MESSAGES as M } from '../../src/shared/appointments.js';

// Quinta 26/11/2026, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';
const MANAGE_URL_RE = /^https:\/\/agendafacil\.app\/agendamento\/[A-Za-z0-9_-]{43}$/;
/** O token muda a cada resposta (AF-12): fora dele, os corpos se comparam byte a byte. */
const withoutToken = (text) => text.replace(/\/agendamento\/[A-Za-z0-9_-]{43}/g, '/agendamento/<token>');

let app;
let clock;
let ana;
let businessId;
let corte;
let pa;
let pb;

async function setup() {
  clock = createClock(NOW);
  ({ app } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  businessId = (await app.db.get('SELECT id FROM businesses')).id;
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
}

const body = (over = {}) => bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, ...over });
const post = (b, options) => postAppointment(app, SLUG, b, options);
const availability = (over = {}, slug = SLUG) =>
  getAvailability(app, slug, { serviceId: corte.id, professionalId: 'any', from: FRIDAY, ...over });
const daySlots = async (over = {}) => {
  const res = await availability(over);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().days.find((d) => d.date === FRIDAY).slots;
};

/** Árvore de chaves de um 201, conferida contra PUBLIC_APPOINTMENT_FIELDS. */
function assertContractTree(json) {
  const F = PUBLIC_APPOINTMENT_FIELDS;
  assert.deepEqual(Object.keys(json).sort(), [...F.root].sort());
  const a = json.appointment;
  assert.deepEqual(Object.keys(a).sort(), [...F.appointment].sort());
  for (const nested of ['service', 'professional', 'business']) {
    assert.deepEqual(Object.keys(a[nested]).sort(), [...F[nested]].sort(), nested);
    for (const value of Object.values(a[nested])) assert.notEqual(typeof value, 'object', `${nested} sem objetos aninhados`);
  }
  // AF-12 (critério 8): o link de gerenciar e a política, sempre com as mesmas chaves.
  assert.deepEqual(Object.keys(json.manage).sort(), [...F.manage].sort());
  assert.match(json.manage.url, MANAGE_URL_RE);
}

function assertSecurityHeaders(res, label) {
  assert.equal(res.headers['cache-control'], 'no-store', label);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
  assert.ok(res.headers['content-security-policy'], label);
  assert.ok(res.headers['x-frame-options'], label);
  assert.equal(res.headers['set-cookie'], undefined, label);
}

describe('POST /api/public/:slug/appointments: contrato (critério 26)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('201 com a árvore de PUBLIC_APPOINTMENT_FIELDS e os valores da 4.1', async () => {
    const res = await post(body());
    assert.equal(res.statusCode, 201, res.body);
    assert.match(res.headers['content-type'], /^application\/json/);
    assertContractTree(res.json());
    const json = res.json();
    assert.deepEqual(json, {
      manage: {
        url: json.manage.url,
        cancellationLeadMinutes: 120,
        policy: 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.',
      },
      appointment: {
        start: `${FRIDAY}T10:00`,
        end: `${FRIDAY}T11:00`,
        weekday: 5,
        timezone: 'America/Sao_Paulo',
        service: { name: 'Corte', durationMinutes: 60, durationLabel: '1 h', priceCents: 5000, priceOnRequest: false, priceLabel: 'R$ 50,00' },
        professional: { name: 'Ana Souza' },
        business: { name: 'Salão da Ana', address: 'Rua A, 10', phoneDisplay: '(11) 91234-5678', phoneHref: 'tel:+5511912345678' },
      },
    });
    assert.equal(UUID_RE.test(res.body), false);
  });

  test('cliente novo e cliente antigo recebem a mesma árvore; nenhum dado do cliente volta', async () => {
    const customer = { name: 'Carla Dias', phone: '(11) 97654-3210', email: 'carla@example.com' };
    const first = await post(body({ customer }));
    const second = await post(body({ start: `${FRIDAY}T13:00`, customer }));
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(await countCustomers(app.db), 1);
    assertContractTree(first.json());
    assertContractTree(second.json());
    for (const res of [first, second]) {
      for (const text of ['Carla', 'carla@', '97654', '9765-4321', 'bem-vind']) assert.equal(res.body.includes(text), false, text);
    }
  });

  test('em "qualquer", o profissional escolhido aparece no 201', async () => {
    await post(body({ professionalId: pa.id }));
    const res = await post(body({ professionalId: 'any' }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().appointment.professional.name, 'Bia Lima');
  });

  test('campos extras no topo e no cliente são ignorados', async () => {
    const b = body();
    const res = await post({ ...b, id: 'x', status: 'cancelled', businessId: 'y', customer: { ...b.customer, id: 'z' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((await app.db.get('SELECT status FROM appointments')).status, 'confirmed');
  });
});

describe('404 uniforme e paridade com o AF-10 (critérios 4 e 5)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('todos os casos dão o corpo de GET /api/nao-existe, e o GET de horários dá o mesmo status', async () => {
    const reference = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    assert.equal(reference.statusCode, 404);

    const inativo = await createService(app, ana, { name: 'Inativo', durationMinutes: 60 });
    await app.inject({ method: 'PATCH', url: `/api/professionals/${pa.id}`, cookies: ana, payload: { serviceIds: [corte.id, inativo.id] } });
    assert.equal((await app.inject({ method: 'POST', url: `/api/services/${inativo.id}/deactivate`, cookies: ana })).statusCode, 200);
    const oculto = await createService(app, ana, { name: 'Oculto', durationMinutes: 60 });
    const outro = await createService(app, ana, { name: 'Outro', durationMinutes: 60 });
    const semGrade = await createProfessional(app, ana, { name: 'Sem Grade', serviceIds: [corte.id] });
    const naoFaz = await createProfessional(app, ana, { name: 'Não Faz', serviceIds: [outro.id] });
    assert.equal((await putHours(app, ana, naoFaz.id, WEEK_9_TO_18)).statusCode, 200);
    const removido = await createProfessional(app, ana, { name: 'Removido', serviceIds: [corte.id] });
    assert.equal((await putHours(app, ana, removido.id, WEEK_9_TO_18)).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${removido.id}`, cookies: ana })).statusCode, 204);

    const bia = await signupAndLogin(app, { email: 'bia@x.com', name: 'Bia' });
    const other = await createBusinessFor(app, bia, { name: 'Barbearia da Bia' });
    const barba = await createService(app, bia, { name: 'Barba', durationMinutes: 60 });
    const caio = await createProfessional(app, bia, { name: 'Caio', serviceIds: [barba.id] });
    assert.equal((await putHours(app, bia, caio.id, WEEK_9_TO_18)).statusCode, 200);

    const cases = [
      ['slug inexistente', 'nao-existe', {}],
      ['slug com maiúsculas', 'Salao-Da-Ana', {}],
      ['serviço desativado', SLUG, { serviceId: inativo.id }],
      ['serviço de outro negócio', SLUG, { serviceId: barba.id }],
      ['serviço oculto (sem profissional)', SLUG, { serviceId: oculto.id, professionalId: 'any' }],
      ['serviceId malformado', SLUG, { serviceId: 'nao-e-uuid' }],
      ['profissional removido', SLUG, { professionalId: removido.id }],
      ['profissional de outro negócio', SLUG, { professionalId: caio.id }],
      ['profissional sem grade', SLUG, { professionalId: semGrade.id }],
      ['profissional que não realiza o serviço', SLUG, { professionalId: naoFaz.id }],
      ['professionalId malformado', SLUG, { professionalId: 'x' }],
      ['serviço do outro negócio no slug dele com profissional daqui', other.slug, { serviceId: barba.id, professionalId: pa.id }],
    ];
    for (const [label, slug, over] of cases) {
      const res = await postAppointment(app, slug, body(over));
      assert.equal(res.statusCode, 404, `${label}: ${res.body}`);
      assert.equal(res.body, reference.body, label);
      assertSecurityHeaders(res, label);
      const b = body(over);
      const get = await availability({ serviceId: b.serviceId, professionalId: b.professionalId }, slug);
      assert.equal(get.statusCode, 404, `paridade: ${label}`);
    }
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(await countCustomers(app.db), 0);
  });
});

describe('400 (critério 2) e 413/415 (critério 6)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('todos os campos juntos, corpo pequeno e sem a entrada; slug inexistente com corpo inválido também dá 400', async () => {
    const bad = { start: '2026-11-27T10:10<b>', customer: { name: '   ', phone: '12<i>', email: 'naoemail@' } };
    for (const slug of [SLUG, 'nao-existe']) {
      const res = await postAppointment(app, slug, bad);
      assert.equal(res.statusCode, 400, res.body);
      const { error } = res.json();
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, M.checkFields);
      assert.deepEqual(Object.keys(error.fields).sort(), ['email', 'name', 'phone', 'professionalId', 'serviceId', 'start']);
      assert.ok(Buffer.byteLength(res.body) < 1024, `${res.body.length} bytes`);
      for (const echoed of ['<b>', '<i>', 'naoemail', '10:10']) assert.equal(res.body.includes(echoed), false, echoed);
      assertSecurityHeaders(res, '400');
    }
    assert.equal(await countCustomers(app.db), 0);
  });

  test('customer que não é objeto simples vale {}: os três campos voltam obrigatórios', async () => {
    for (const customer of [[], 'x', null, 42]) {
      const res = await post({ ...body(), customer });
      assert.equal(res.statusCode, 400, JSON.stringify(customer));
      assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['email', 'name', 'phone']);
    }
  });

  test('__proto__ no topo e em customer dá 400 "Requisição inválida." sem fields e nada é gravado', async () => {
    const b = body();
    const raw = JSON.stringify(b);
    const payloads = [
      raw.replace('{', '{"__proto__":{"admin":true},'),
      raw.replace('"customer":{', '"customer":{"__proto__":{"name":"x"},'),
      raw.replace('{', '{"constructor":{"prototype":{"admin":true}},'),
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/public/${SLUG}/appointments`,
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        payload,
      });
      assert.equal(res.statusCode, 400, payload);
      assert.deepEqual(res.json(), { error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.' } });
    }
    const malformed = await app.inject({
      method: 'POST',
      url: `/api/public/${SLUG}/appointments`,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: '{"serviceId":',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(await countCustomers(app.db), 0);
  });

  test('Idempotency-Key fora do formato dá 400 sem fields', async () => {
    const res = await post(body(), { headers: { 'idempotency-key': 'abc' } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.' } });
  });

  test('corpo não JSON dá 415 e acima de 16 KB dá 413; nada é gravado', async () => {
    const text = await app.inject({
      method: 'POST',
      url: `/api/public/${SLUG}/appointments`,
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' },
      payload: 'x',
    });
    assert.equal(text.statusCode, 415);
    assertSecurityHeaders(text, '415');
    const big = await post({ ...body(), pad: 'x'.repeat(17 * 1024) });
    assert.equal(big.statusCode, 413);
    assertSecurityHeaders(big, '413');
    assert.equal(await countAppointments(app.db), 0);
  });
});

describe('409 sem vazamento (critérios 15 e 17)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('sem UUID, nome de cliente nem motivo de bloqueio; igual para cliente novo e antigo', async () => {
    const secret = { name: 'Cliente Secreto', phone: '(11) 97654-3210', email: 'secreto@example.com' };
    assert.equal((await post(body({ customer: secret }))).statusCode, 201);
    const block = await postTimeBlock(app, ana, {
      professionalId: pa.id,
      start: `${FRIDAY}T14:00`,
      end: `${FRIDAY}T15:00`,
      reasonKind: 'other',
      reasonNote: 'Motivo Reservado',
    });
    assert.equal(block.statusCode, 201, block.body);

    const responses = [
      await post(body()), // cliente novo, ocupado por agendamento
      await post(body({ customer: secret })), // cliente antigo, mesmo horário
      await post(body({ start: `${FRIDAY}T14:00` })), // ocupado por bloqueio
      await post(body({ start: '2026-11-26T09:30' })), // antecedência de 1 h
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json().error.code, 'SLOT_UNAVAILABLE');
      assert.equal(res.json().error.message, M.slotUnavailable);
      assert.equal(UUID_RE.test(res.body), false, res.body);
      for (const text of ['Secreto', 'secreto', 'Motivo', 'Reservado', 'Ana Souza', 'Bia Lima', 'other']) {
        assert.equal(res.body.includes(text), false, text);
      }
      for (const s of res.json().error.suggestions) assert.deepEqual(Object.keys(s).sort(), ['end', 'start']);
      assertSecurityHeaders(res, '409');
    }
    assert.equal(responses[0].body, responses[1].body);
    assert.equal(await countAppointments(app.db), 1);
  });

  test('409 BOOKING_LIMIT_REACHED não diz qual dado estourou', async () => {
    const customer = { phone: '(11) 97654-3210' };
    for (const start of ['10:00', '13:00', '14:00']) assert.equal((await post(body({ start: `${FRIDAY}T${start}`, customer }))).statusCode, 201);
    const res = await post(body({ start: `${FRIDAY}T15:00`, customer }));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: { code: 'BOOKING_LIMIT_REACHED', message: M.limitReached } });
  });
});

describe('cabeçalhos, sessão e CSRF (critérios 30 e 41)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('201, 409 e 422 com no-store, helmet e sem set-cookie', async () => {
    const created = await post(body(), { headers: { 'idempotency-key': KEY } });
    assert.equal(created.statusCode, 201);
    assertSecurityHeaders(created, '201');
    const conflict = await post(body());
    assert.equal(conflict.statusCode, 409);
    assertSecurityHeaders(conflict, '409');
    const reused = await post(body({ start: `${FRIDAY}T13:00` }), { headers: { 'idempotency-key': KEY } });
    assert.equal(reused.statusCode, 422);
    assert.deepEqual(reused.json(), { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: M.idempotencyReused } });
    assertSecurityHeaders(reused, '422');
  });

  test('503 BOOKING_UNAVAILABLE com os mesmos cabeçalhos e nada gravado', async () => {
    const s = app.services;
    s.appointmentsService = createAppointmentsService({
      db: app.db,
      businessesRepository: s.businessesRepository,
      servicesRepository: s.servicesRepository,
      professionalsRepository: s.professionalsRepository,
      workingHoursRepository: s.workingHoursRepository,
      timeBlocksRepository: s.timeBlocksRepository,
      appointmentsRepository: s.appointmentsRepository,
      appointments: {
        ...s.appointments,
        async findBusyByBusiness() {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
      },
      customersService: s.customersService,
      availabilityService: s.availabilityService,
      now: clock.now,
    });
    const res = await post(body());
    assert.equal(res.statusCode, 503, res.body);
    assert.deepEqual(res.json(), { error: { code: 'BOOKING_UNAVAILABLE', message: M.unavailable } });
    assertSecurityHeaders(res, '503');
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(await countCustomers(app.db), 0);
  });

  test('429 do teto publicBooking com os mesmos cabeçalhos', async () => {
    const limited = await buildTestApp({
      now: clock.now,
      rateLimit: { enabled: true, publicPage: { perIp: 100 }, publicBooking: { perIp: 1 } },
    });
    try {
      const first = await postAppointment(limited.app, 'nao-existe', bookingBody({ serviceId: corte.id }));
      assert.equal(first.statusCode, 404);
      const res = await postAppointment(limited.app, 'nao-existe', bookingBody({ serviceId: corte.id }));
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().error.code, 'RATE_LIMITED');
      assert.ok(Number(res.headers['retry-after']) >= 1);
      assertSecurityHeaders(res, '429');
    } finally {
      await limited.app.close();
    }
  });

  test('com o cookie do dono a resposta é a mesma e last_seen_at não muda', async () => {
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(5 * 60 * 1000);
    const withCookie = await post(body(), { cookies: ana });
    const without = await post(body({ professionalId: pb.id }));
    assert.equal(withCookie.statusCode, 201);
    assert.equal(withCookie.headers['set-cookie'], undefined);
    assert.equal(withoutToken(withCookie.body).replace('Ana Souza', 'X'), withoutToken(without.body).replace('Bia Lima', 'X'));
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
  });

  test('CSRF: sec-fetch-site cross-site e Origin alheio dão 403 sem gravar; same-origin sem cookie passa', async () => {
    const cross = await post(body(), { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.statusCode, 403);
    assert.equal(cross.json().error.code, 'FORBIDDEN_ORIGIN');
    const evil = await app.inject({
      method: 'POST',
      url: `/api/public/${SLUG}/appointments`,
      headers: { origin: 'https://evil.example' },
      payload: body(),
    });
    assert.equal(evil.statusCode, 403);
    assert.equal(evil.json().error.code, 'FORBIDDEN_ORIGIN');
    assertSecurityHeaders(evil, '403');
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(await countCustomers(app.db), 0);
    assert.equal((await post(body())).statusCode, 201);
  });
});

describe('integração com o AF-10, AF-06, AF-07 e AF-08 (critérios 32 e 47)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('reservar tira o horário do GET (específico e "qualquer"); cancelar no banco o devolve', async () => {
    const starts = (slots) => slots.map((s) => s.start);
    assert.ok(starts(await daySlots({ professionalId: pa.id })).includes(`${FRIDAY}T10:00`));
    assert.equal((await post(body())).statusCode, 201);
    assert.equal(starts(await daySlots({ professionalId: pa.id })).includes(`${FRIDAY}T10:00`), false);
    assert.ok(starts(await daySlots()).includes(`${FRIDAY}T10:00`), 'B ainda está livre');
    assert.equal((await post(body({ professionalId: 'any' }))).statusCode, 201);
    assert.equal(starts(await daySlots()).includes(`${FRIDAY}T10:00`), false);
    const id = (await app.db.get('SELECT id FROM appointments WHERE professional_id = ?', [pa.id])).id;
    await cancelDirect(app.db, id);
    assert.ok(starts(await daySlots({ professionalId: pa.id })).includes(`${FRIDAY}T10:00`));
    assert.ok(starts(await daySlots()).includes(`${FRIDAY}T10:00`));
    // AF-22, critério 8 (b): depois de cancelar, um novo POST de pa às 10:00 dá 201.
    assert.equal((await post(body())).statusCode, 201);
    const active = await app.db.get(
      "SELECT COUNT(*) AS n FROM appointments WHERE professional_id = ? AND starts_at = ? AND status <> 'cancelled'",
      [pa.id, '2026-11-27T13:00:00.000Z'],
    );
    assert.equal(Number(active.n), 1);
  });

  test('contrato novo do AF-10: em "qualquer" nenhum horário tem professionals; no específico continua [0]', async () => {
    for (const slot of await daySlots()) assert.deepEqual(Object.keys(slot).sort(), ['end', 'start']);
    for (const slot of await daySlots({ professionalId: pa.id })) assert.deepEqual(slot.professionals, [0]);
  });

  test('trocar a grade e criar bloqueio valem na próxima reserva', async () => {
    const afternoon = WEEK_9_TO_18.map((d) => ({ weekday: d.weekday, intervals: d.intervals.length ? [{ start: '13:00', end: '18:00' }] : [] }));
    assert.equal((await putHours(app, ana, pa.id, afternoon)).statusCode, 200);
    assert.equal((await post(body())).statusCode, 409);
    assert.equal((await postTimeBlock(app, ana, { professionalId: pb.id, start: `${FRIDAY}T10:00`, end: `${FRIDAY}T11:00` })).statusCode, 201);
    assert.equal((await post(body({ professionalId: pb.id }))).statusCode, 409);
    assert.equal((await post(body({ professionalId: 'any' }))).statusCode, 409);
    assert.equal(await countAppointments(app.db), 0);
  });

  test('remoção do profissional bloqueada com agendamento futuro; depois de cancelar, remove', async () => {
    assert.equal((await post(body())).statusCode, 201);
    const blocked = await app.inject({ method: 'DELETE', url: `/api/professionals/${pa.id}`, cookies: ana });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS');
    assert.equal(blocked.json().error.futureAppointmentsCount, 1);
    await cancelDirect(app.db, (await app.db.get('SELECT id FROM appointments')).id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${pa.id}`, cookies: ana })).statusCode, 204);
  });

  test('desativar o serviço informa futureAppointmentsCount 1; a grade que tira as 10:00 informa affectedAppointmentsCount 1', async () => {
    assert.equal((await post(body())).statusCode, 201);
    const afternoon = WEEK_9_TO_18.map((d) => ({ weekday: d.weekday, intervals: d.intervals.length ? [{ start: '13:00', end: '18:00' }] : [] }));
    const hours = await putHours(app, ana, pa.id, afternoon);
    assert.equal(hours.statusCode, 200);
    assert.equal(hours.json().affectedAppointmentsCount, 1);
    const deactivate = await app.inject({ method: 'POST', url: `/api/services/${corte.id}/deactivate`, cookies: ana });
    assert.equal(deactivate.statusCode, 200);
    assert.equal(deactivate.json().futureAppointmentsCount, 1);
    assert.equal((await app.db.get('SELECT status FROM appointments')).status, 'confirmed');
  });

  test('AF-16 de ponta a ponta: 409 com o item, confirmar com o token cria o bloqueio, o agendamento continua e o período fica ocupado (critério 35)', async () => {
    assert.equal((await post(body({ customer: { name: 'Dora Reis' } }))).statusCode, 201);
    const block = { professionalId: pa.id, start: `${FRIDAY}T09:00`, end: `${FRIDAY}T12:00` };
    const first = await postTimeBlock(app, ana, block);
    assert.equal(first.statusCode, 409, first.body);
    const { error } = first.json();
    assert.equal(error.code, 'TIME_BLOCK_CONFLICTS');
    assert.equal(error.conflictsTotal, 1);
    assert.deepEqual(error.conflicts, [
      { start: `${FRIDAY}T10:00`, end: `${FRIDAY}T11:00`, serviceName: 'Corte', professionalName: 'Ana Souza', customerName: 'Dora Reis' },
    ]);
    assert.equal(error.conflictsToken.length, 57);
    const second = await postTimeBlock(app, ana, { ...block, confirmConflictsToken: error.conflictsToken });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().acknowledgedConflictsCount, 1);
    assert.equal((await app.db.get('SELECT status FROM appointments')).status, 'confirmed');
    const again = await post(body({ start: `${FRIDAY}T11:00` }));
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'SLOT_UNAVAILABLE');
  });

  test('uma reserva nova entre o 409 e a confirmação muda o token: TIME_BLOCK_CONFLICTS_CHANGED', async () => {
    assert.equal((await post(body())).statusCode, 201);
    const block = { professionalId: null, start: `${FRIDAY}T09:00`, end: `${FRIDAY}T12:00` };
    const first = await postTimeBlock(app, ana, block);
    assert.equal(first.statusCode, 409);
    assert.equal((await post(body({ professionalId: pb.id }))).statusCode, 201);
    const second = await postTimeBlock(app, ana, { ...block, confirmConflictsToken: first.json().error.conflictsToken });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
    assert.equal(second.json().error.conflictsTotal, 2);
  });
});

describe('fuso (critério 18 do AF-10 aplicado à reserva)', () => {
  test('process.env.TZ em UTC, Asia/Tokyo e America/Sao_Paulo: o mesmo starts_at e o mesmo start', async () => {
    const original = process.env.TZ;
    const seen = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        await setup();
        try {
          const res = await post(body());
          assert.equal(res.statusCode, 201, `${tz}: ${res.body}`);
          seen.push([res.json().appointment.start, (await app.db.get('SELECT starts_at FROM appointments')).starts_at]);
        } finally {
          await app.close();
        }
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.deepEqual(seen, Array(3).fill([`${FRIDAY}T10:00`, '2026-11-27T13:00:00.000Z']));
  });

  test('negócio em Asia/Tokyo: 10:00 local vira 01:00Z', async () => {
    await setup();
    try {
      await setBusinessTimezone(app, businessId, 'Asia/Tokyo');
      const res = await post(body());
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().appointment.timezone, 'Asia/Tokyo');
      assert.equal(res.json().appointment.start, `${FRIDAY}T10:00`);
      assert.equal((await app.db.get('SELECT starts_at FROM appointments')).starts_at, '2026-11-27T01:00:00.000Z');
    } finally {
      await app.close();
    }
  });
});
