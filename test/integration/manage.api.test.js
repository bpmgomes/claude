// AF-12: API e página do gerenciar (design 6.1): contrato, 404 uniforme, dois negócios, cancelar,
// remarcar, cabeçalhos, sessão, CSRF, página, token só no caminho, nada em claro, logs e fuso.
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
  getAvailability,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { bookingBody, postAppointment, countAppointments } from '../helpers/appointments.js';
import {
  bookWithLink,
  getManage,
  cancelManage,
  rescheduleManage,
  manageAvailability,
  versionOf,
  tokensOf,
  everyColumnText,
} from '../helpers/manage.js';
import { PUBLIC_MANAGE_FIELDS, PUBLIC_MANAGE_AVAILABILITY_FIELDS } from '../../src/modules/appointments/manage.view.js';
import { createManageService } from '../../src/modules/appointments/manage.service.js';
import { hashManageToken } from '../../src/modules/appointments/manage-token.js';
import { MANAGE_MESSAGES as MM } from '../../src/shared/appointments.js';
import { MANAGE_PAGE_HTML } from '../../src/modules/appointments/manage-page.render.js';

const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';
const VALID_VERSION = 'v'.repeat(43);

let app;
let logs;
let clock;
let ana;
let corte;
let pa;
let pb;

async function setup(overrides = {}) {
  clock = createClock(NOW);
  ({ app, logs } = await buildTestApp({ now: clock.now, ...overrides }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
}

const body = (over = {}) => bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, ...over });
const reserve = (over = {}) => bookWithLink(app, SLUG, body(over));
const appointmentOf = (token) =>
  app.db.get('SELECT a.* FROM appointments a JOIN appointment_manage_tokens t ON t.appointment_id = a.id WHERE t.token_hash = ?', [
    hashManageToken(token),
  ]);

function assertTree(value, fields, label = 'root') {
  assert.deepEqual(Object.keys(value).sort(), [...fields[label]].sort(), label);
}

function assertManageHeaders(res, label) {
  assert.equal(res.headers['cache-control'], 'no-store', label);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', label);
  assert.equal(res.headers['x-robots-tag'], 'noindex', label);
  assert.ok(res.headers['content-security-policy'], label);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
  assert.ok(res.headers['x-frame-options'], label);
  assert.equal(res.headers['set-cookie'], undefined, label);
}

/** Cabeçalhos sem os que variam por natureza (data e contadores). */
function stableHeaders(res) {
  const out = { ...res.headers };
  for (const k of Object.keys(out)) if (k === 'date' || k.startsWith('x-ratelimit-')) delete out[k];
  return out;
}

const slotStarts = (json, date) => (json.days.find((d) => d.date === date)?.slots ?? []).map((s) => s.start.slice(11));

describe('contrato (critérios 11, 12 e 24)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('GET com a árvore de PUBLIC_MANAGE_FIELDS e os valores do resumo', async () => {
    const { token } = await reserve();
    const res = await getManage(app, token);
    assert.equal(res.statusCode, 200, res.body);
    assertManageHeaders(res, 'GET 200');
    const json = res.json();
    assertTree(json, PUBLIC_MANAGE_FIELDS);
    assertTree(json.appointment, PUBLIC_MANAGE_FIELDS, 'appointment');
    for (const nested of ['service', 'professional', 'business']) assertTree(json.appointment[nested], PUBLIC_MANAGE_FIELDS, nested);
    assertTree(json.change, PUBLIC_MANAGE_FIELDS, 'change');
    assertTree(json.change.reschedule, PUBLIC_MANAGE_FIELDS, 'reschedule');
    assert.equal(json.appointment.start, `${FRIDAY}T10:00`);
    assert.equal(json.appointment.status, 'confirmed');
    assert.equal(json.appointment.professional.name, 'Ana Souza');
    assert.equal(json.appointment.business.pageUrl, `https://agendafacil.app/${SLUG}`);
    assert.equal(json.change.canChange, true);
    assert.equal(json.change.changeDeadline, `${FRIDAY}T08:00`);
    assert.equal(json.change.cancellationLeadMinutes, 120);
    assert.equal(json.change.policy, 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.');
    assert.equal(res.body.includes(token), false, 'o token não volta no corpo');
    assert.doesNotMatch(res.body, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'nenhum UUID');
  });

  test('availability: árvore sem professionals; o próprio horário aparece livre; sem professionalId usa o atual e any usa todos', async () => {
    const { token } = await reserve();
    // Bia ocupada das 13:00 às 14:00: com any o 13:00 continua (Ana livre); com o atual também.
    await reserve({ professionalId: pb.id, start: `${FRIDAY}T13:00` });
    // Ana ocupada às 15:00 por outro cliente: some sem professionalId e volta com any (Bia livre).
    await reserve({ start: `${FRIDAY}T15:00` });
    const own = await manageAvailability(app, token, { date: FRIDAY });
    assert.equal(own.statusCode, 200, own.body);
    assertManageHeaders(own, 'availability 200');
    const json = own.json();
    assertTree(json, PUBLIC_MANAGE_AVAILABILITY_FIELDS);
    for (const day of json.days) {
      assertTree(day, PUBLIC_MANAGE_AVAILABILITY_FIELDS, 'day');
      for (const slot of day.slots) assertTree(slot, PUBLIC_MANAGE_AVAILABILITY_FIELDS, 'slot');
    }
    const same = slotStarts(json, FRIDAY);
    assert.ok(same.includes('10:00') && same.includes('10:30'), same.join());
    assert.equal(same.includes('15:00'), false);
    const any = slotStarts((await manageAvailability(app, token, { date: FRIDAY, professionalId: 'any' })).json(), FRIDAY);
    assert.ok(any.includes('15:00'));
    assert.ok(any.includes('10:00'));
  });
});

describe('404 uniforme (critérios 6, 7 e 35)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('malformado (42, 44, %2B), inexistente, vencido e cancelado vencido: corpo, status e cabeçalhos idênticos nas 4 rotas', async () => {
    const { token: expired } = await reserve();
    const { token: cancelled } = await reserve({ start: `${FRIDAY}T13:00` });
    assert.equal((await cancelManage(app, cancelled, { version: await versionOf(app, cancelled) })).statusCode, 200);
    // Sábado: os dois agendamentos de sexta já terminaram (expires_at = ends_at).
    clock.advance(2 * 24 * 60 * 60 * 1000);
    const tokens = {
      short: expired.slice(1),
      long: `${expired}a`,
      plus: `${expired.slice(1)}%2B`,
      missing: 'Q'.repeat(43),
      expired,
      cancelled,
    };
    const date = '2026-11-30';
    const routes = {
      get: (t, ip) => getManage(app, t, { remoteAddress: ip }),
      availability: (t, ip) => manageAvailability(app, t, { date }, { remoteAddress: ip }),
      cancel: (t, ip) => cancelManage(app, t, { version: VALID_VERSION, remoteAddress: ip }),
      reschedule: (t, ip) => rescheduleManage(app, t, { start: `${date}T10:00`, version: VALID_VERSION }, { remoteAddress: ip }),
    };
    let ip = 0;
    for (const [route, call] of Object.entries(routes)) {
      let reference;
      for (const [label, t] of Object.entries(tokens)) {
        ip += 1;
        const res = await call(t, `10.0.${Math.floor(ip / 250)}.${ip % 250}`);
        assert.equal(res.statusCode, 404, `${route} ${label}: ${res.body}`);
        assert.deepEqual(res.json(), { error: { code: 'NOT_FOUND', message: MM.linkInvalid } });
        assertManageHeaders(res, `${route} ${label}`);
        if (!reference) reference = res;
        else {
          assert.equal(res.body, reference.body, `${route} ${label}`);
          assert.deepEqual(stableHeaders(res), stableHeaders(reference), `${route} ${label}`);
        }
      }
    }
  });
});

describe('dois negócios (critério 36)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('o token de A só lê e altera A; o agendamento de B no mesmo horário não aparece nem muda', async () => {
    const beto = await signupAndLogin(app, { email: 'beto@x.com', name: 'Beto' });
    await createBusinessFor(app, beto, { name: 'Barbearia do Beto', slug: 'barbearia-do-beto' });
    const barba = await createService(app, beto, { name: 'Barba', durationMinutes: 60, price: '40' });
    const pc = await createProfessional(app, beto, { name: 'Caio Reis', serviceIds: [barba.id] });
    assert.equal((await putHours(app, beto, pc.id, WEEK_9_TO_18)).statusCode, 200);
    const b = await bookWithLink(app, 'barbearia-do-beto', bookingBody({ serviceId: barba.id, professionalId: pc.id, start: `${FRIDAY}T10:30` }));
    const before = await appointmentOf(b.token);

    const { token } = await reserve();
    const summary = (await getManage(app, token)).json();
    assert.equal(summary.appointment.business.name, 'Salão da Ana');
    assert.equal(summary.appointment.service.name, 'Corte');
    const res = await rescheduleManage(app, token, { start: `${FRIDAY}T10:30`, version: summary.change.version });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().appointment.business.name, 'Salão da Ana');
    // B segue igual e o link de B mostra só B.
    assert.deepEqual({ ...(await appointmentOf(b.token)) }, { ...before });
    const fromB = (await getManage(app, b.token)).json();
    assert.equal(fromB.appointment.business.name, 'Barbearia do Beto');
    assert.equal(fromB.appointment.start, `${FRIDAY}T10:30`);
    // professionalId de B no corpo de A: o profissional não é elegível em A (409, nada gravado).
    const v = await versionOf(app, token);
    const cross = await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, professionalId: pc.id, version: v });
    assert.equal(cross.statusCode, 409, cross.body);
    assert.equal(await countAppointments(app.db, { professional_id: pc.id }), 1);
  });
});

describe('cancelar (critério 17)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('200 com cancelled; o horário volta na página pública e um novo POST no mesmo horário dá 201', async () => {
    const { token } = await reserve();
    const free = async () =>
      slotStarts((await getAvailability(app, SLUG, { serviceId: corte.id, professionalId: pa.id, from: FRIDAY })).json(), FRIDAY);
    assert.equal((await free()).includes('10:00'), false);
    const res = await cancelManage(app, token, { version: await versionOf(app, token) });
    assert.equal(res.statusCode, 200, res.body);
    assertManageHeaders(res, 'cancel 200');
    assert.equal(res.json().appointment.status, 'cancelled');
    assert.equal(res.json().change.canChange, false);
    assert.ok((await free()).includes('10:00'));
    assert.equal((await postAppointment(app, SLUG, body())).statusCode, 201);
  });

  test('cliente com 3 futuros: o 4º dá 409; cancelar um pelo link devolve a folga e o 4º dá 201', async () => {
    const customer = { email: 'carla@example.com', name: 'Carla Dias' };
    const tokens = [];
    for (const start of ['10:00', '13:00', '15:00']) tokens.push((await reserve({ start: `${FRIDAY}T${start}`, customer })).token);
    const fourth = () => postAppointment(app, SLUG, body({ start: `${FRIDAY}T17:00`, customer }));
    assert.equal((await fourth()).statusCode, 409);
    assert.equal((await cancelManage(app, tokens[1], { version: await versionOf(app, tokens[1]) })).statusCode, 200);
    assert.equal((await fourth()).statusCode, 201);
  });

  test('sem corpo ou com versão fora do formato: 400 Requisição inválida., nada gravado (decisão do Gerente)', async () => {
    const { token } = await reserve();
    for (const opts of [{}, { version: 'curta' }, { payload: { version: [VALID_VERSION] } }]) {
      const res = await cancelManage(app, token, opts);
      assert.equal(res.statusCode, 400, JSON.stringify(opts));
      assert.deepEqual(res.json().error, { code: 'VALIDATION_ERROR', message: MM.badRequest });
      assertManageHeaders(res, '400');
    }
    assert.equal((await appointmentOf(token)).status, 'confirmed');
  });
});

describe('remarcar (critérios 25 e 37)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('serviceId, customer, name e email extras são ignorados: serviço e cliente iguais', async () => {
    const outro = await createService(app, ana, { name: 'Escova', durationMinutes: 30, price: '30' });
    const { token } = await reserve();
    const old = await appointmentOf(token);
    const res = await rescheduleManage(app, token, {
      start: `${FRIDAY}T14:00`,
      version: await versionOf(app, token),
      serviceId: outro.id,
      customer: { name: 'Intruso', email: 'x@y.z', phone: '11900000000' },
      name: 'Intruso',
      email: 'x@y.z',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().appointment.service.name, 'Corte');
    const now = await appointmentOf(token);
    assert.notEqual(now.id, old.id);
    assert.equal(now.service_id, old.service_id);
    assert.equal(now.customer_id, old.customer_id);
    assert.equal(now.customer_name, old.customer_name);
    assert.equal(now.customer_email, old.customer_email);
    assert.equal(JSON.stringify(now).includes('Intruso'), false);
  });

  test('400 por campo sem eco; __proto__ e corpo não objeto dão 400', async () => {
    const { token } = await reserve();
    const version = await versionOf(app, token);
    const bad = await rescheduleManage(app, token, { start: '<b>x</b>', professionalId: 'evil<i>', version });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.includes('<'), false);
    assert.ok(bad.json().error.fields.start);
    assertManageHeaders(bad, '400');
    const proto = await app.inject({
      method: 'POST',
      url: `/api/public/manage/${token}/reschedule`,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: `{"start":"${FRIDAY}T14:00","version":"${version}","__proto__":{"x":1}}`,
    });
    assert.equal(proto.statusCode, 400);
    const array = await rescheduleManage(app, token, [1]);
    assert.equal(array.statusCode, 400);
    assert.equal((await appointmentOf(token)).status, 'confirmed');
  });
});

describe('cabeçalhos (critérios 10 e 34)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('200, 400, 404, 409, 413, 415 e 503 das 4 rotas e 200 da página', async () => {
    const { token } = await reserve();
    const version = await versionOf(app, token);
    const json = (method, path, payload, contentType = 'application/json') =>
      app.inject({ method, url: `/api/public/manage/${token}${path}`, headers: { 'content-type': contentType, 'sec-fetch-site': 'same-origin' }, payload });
    const checks = {
      'GET 200': await getManage(app, token),
      'availability 400': await manageAvailability(app, token, { date: 'x' }),
      'availability 404': await manageAvailability(app, 'Q'.repeat(43), { date: FRIDAY }),
      'reschedule 409': await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, version: 'w'.repeat(43) }),
      'cancel 413': await json('POST', '/cancel', JSON.stringify({ version, pad: 'x'.repeat(17 * 1024) })),
      'reschedule 415': await json('POST', '/reschedule', 'x', 'text/plain'),
      'page 200': await app.inject({ method: 'GET', url: `/agendamento/${token}` }),
    };
    const expected = { 200: 200, 400: 400, 404: 404, 409: 409, 413: 413, 415: 415 };
    for (const [label, res] of Object.entries(checks)) {
      assert.equal(res.statusCode, expected[label.split(' ')[1]], `${label}: ${res.body.slice(0, 200)}`);
      assertManageHeaders(res, label);
    }
    assert.equal(checks['reschedule 409'].json().error.code, 'APPOINTMENT_CHANGED');

    const s = app.services;
    const busy = async () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    };
    s.manageService = createManageService({
      db: app.db,
      businessesRepository: s.businessesRepository,
      servicesRepository: s.servicesRepository,
      professionalsRepository: s.professionalsRepository,
      appointmentsRepository: s.appointmentsRepository,
      manageTokensRepository: { ...s.manageTokensRepository, findLiveByHash: busy },
      reschedulesRepository: s.reschedulesRepository,
      appointmentsService: s.appointmentsService,
      availabilityService: s.availabilityService,
      config: { publicBaseUrl: 'https://agendafacil.app' },
      now: clock.now,
    });
    const unavailable = [
      await getManage(app, token),
      await manageAvailability(app, token, { date: FRIDAY }),
      await cancelManage(app, token, { version }),
      await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, version }),
    ];
    for (const res of unavailable) {
      assert.equal(res.statusCode, 503, res.body);
      assert.deepEqual(res.json(), { error: { code: 'MANAGE_UNAVAILABLE', message: MM.unavailable } });
      assertManageHeaders(res, '503');
    }
    assert.equal((await appointmentOf(token)).status, 'confirmed');
  });

  test('429 das rotas e da página com os mesmos cabeçalhos', async () => {
    await app.close();
    await setup({ rateLimit: { enabled: true, publicPage: { perIp: 3 }, publicManage: { perIp: 100 }, publicBooking: { perIp: 100 } } });
    const { token } = await bookWithLink(app, SLUG, body(), { remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 3; i++) await getManage(app, token, { remoteAddress: '10.1.1.1' });
    const limited = [
      await getManage(app, token, { remoteAddress: '10.1.1.1' }),
      await manageAvailability(app, token, { date: FRIDAY }, { remoteAddress: '10.1.1.1' }),
      await cancelManage(app, token, { version: VALID_VERSION, remoteAddress: '10.1.1.1' }),
      await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, version: VALID_VERSION }, { remoteAddress: '10.1.1.1' }),
      await app.inject({ method: 'GET', url: `/agendamento/${token}`, remoteAddress: '10.1.1.1' }),
    ];
    for (const res of limited) {
      assert.equal(res.statusCode, 429);
      assertManageHeaders(res, '429');
      assert.ok(Number(res.headers['retry-after']) >= 1);
    }
  });
});

describe('sessão, CSRF e página (critérios 10 e 13)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('com o cookie do dono a resposta é a mesma e last_seen_at não muda', async () => {
    const { token } = await reserve();
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(5 * 60 * 1000);
    const withCookie = await getManage(app, token, { cookies: ana });
    const without = await getManage(app, token);
    assert.equal(withCookie.statusCode, 200);
    assert.equal(withCookie.headers['set-cookie'], undefined);
    assert.equal(withCookie.body, without.body);
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
  });

  test('CSRF: cross-site e Origin alheio dão 403 em cancel e reschedule sem gravar', async () => {
    const { token } = await reserve();
    const version = await versionOf(app, token);
    const attempts = [
      await cancelManage(app, token, { version, headers: { 'sec-fetch-site': 'cross-site' } }),
      await rescheduleManage(app, token, { start: `${FRIDAY}T14:00`, version }, { headers: { 'sec-fetch-site': 'cross-site' } }),
      await app.inject({ method: 'POST', url: `/api/public/manage/${token}/cancel`, headers: { origin: 'https://evil.example' }, payload: { version } }),
      await app.inject({
        method: 'POST',
        url: `/api/public/manage/${token}/reschedule`,
        headers: { origin: 'https://evil.example' },
        payload: { start: `${FRIDAY}T14:00`, version },
      }),
    ];
    for (const res of attempts) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN_ORIGIN');
      assertManageHeaders(res, '403');
    }
    assert.equal((await appointmentOf(token)).status, 'confirmed');
    assert.equal(await countAppointments(app.db), 1);
  });

  test('GET /agendamento/<qualquer> dá 200 com o mesmo corpo, sem o token; /agendamento dá o 404 HTML', async () => {
    const { token } = await reserve();
    const pages = [token, 'Q'.repeat(43), 'abc', `${token}x`];
    for (const t of pages) {
      const res = await app.inject({ method: 'GET', url: `/agendamento/${t}` });
      assert.equal(res.statusCode, 200, t);
      assert.ok(res.rawPayload.equals(MANAGE_PAGE_HTML), t);
      assert.equal(res.body.includes(t), false);
      assert.match(res.headers['content-type'], /^text\/html/);
      assertManageHeaders(res, 'página');
    }
    const bare = await app.inject({ method: 'GET', url: '/agendamento' });
    assert.equal(bare.statusCode, 404);
    assert.match(bare.headers['content-type'], /^text\/html/);
  });
});

describe('token só no caminho e nada em claro (critérios 5 e 10)', () => {
  test('o 201 tem o token só em manage.url; nenhuma resposta das rotas novas o contém; nenhuma tabela o guarda; logs sem token', async () => {
    await setup({ logLevel: 'debug' });
    try {
      const key = '3b241101-e2bb-4255-8caf-4136c566a962';
      const b = body();
      const first = await bookWithLink(app, SLUG, b, { headers: { 'idempotency-key': key } });
      const replay = await bookWithLink(app, SLUG, b, { headers: { 'idempotency-key': key } });
      const second = await reserve({ start: `${FRIDAY}T13:00` });
      const tokens = [first.token, replay.token, second.token];
      for (const r of [first, replay, second]) {
        assert.equal(r.res.body.split(r.token).length - 1, 1, 'o token aparece uma vez (manage.url)');
        assert.equal(JSON.stringify(r.body.appointment).includes(r.token), false);
      }
      const responses = [];
      responses.push(await getManage(app, first.token));
      responses.push(await manageAvailability(app, first.token, { date: FRIDAY }));
      responses.push(await rescheduleManage(app, first.token, { start: `${FRIDAY}T14:00`, version: await versionOf(app, first.token) }));
      responses.push(await rescheduleManage(app, first.token, { start: `${FRIDAY}T15:00`, version: VALID_VERSION })); // 409
      responses.push(await cancelManage(app, second.token, { version: await versionOf(app, second.token) }));
      responses.push(await getManage(app, 'Q'.repeat(43))); // 404
      responses.push(await app.inject({ method: 'GET', url: `/agendamento/${first.token}?utm=1` }));
      // QA D1: `%2F` dentro do segmento não deixa o token no log.
      responses.push(await app.inject({ method: 'GET', url: `/agendamento/x%2F${first.token}` }));
      responses.push(await app.inject({ method: 'GET', url: `/api/public/manage/x%2F${first.token}` }));
      responses.push(await cancelManage(app, `x%2F${second.token}`, { version: VALID_VERSION }));
      for (const res of responses) for (const t of tokens) assert.equal(res.body.includes(t), false);

      const dump = await everyColumnText(app.db);
      for (const t of tokens) assert.equal(dump.includes(t), false, 'token em claro no banco');

      const text = logs();
      for (const t of tokens) {
        assert.equal(text.includes(t), false, 'token no log');
        assert.equal(text.includes(hashManageToken(t)), false, 'hash no log');
        assert.equal(text.includes(`/agendamento/${t}`), false);
      }
      const incoming = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((l) => l.msg === 'incoming request' && /manage|agendamento/.test(l.req?.url ?? ''));
      assert.ok(incoming.length >= 7, String(incoming.length));
      for (const l of incoming) {
        assert.match(l.req.url, /\[REDACTED\]/);
        assert.equal(l.req.url.includes('?'), false);
      }
    } finally {
      await app.close();
    }
  });
});

describe('fuso (TZ do processo)', () => {
  test('process.env.TZ em UTC, Asia/Tokyo e America/Sao_Paulo: changeDeadline, start e policy iguais', async () => {
    const original = process.env.TZ;
    const seen = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        await setup();
        try {
          const { token } = await reserve();
          const json = (await getManage(app, token)).json();
          seen.push([json.appointment.start, json.change.changeDeadline, json.change.policy, json.change.reschedule.today]);
          assert.equal((await tokensOf(app.db, (await appointmentOf(token)).id))[0].expires_at, '2026-11-27T14:00:00.000Z');
        } finally {
          await app.close();
        }
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.deepEqual(
      seen,
      Array(3).fill([`${FRIDAY}T10:00`, `${FRIDAY}T08:00`, 'Você pode cancelar ou remarcar por este link até 2 h antes do horário.', '2026-11-26']),
    );
  });
});
