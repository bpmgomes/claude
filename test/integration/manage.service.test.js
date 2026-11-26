// AF-12: serviço de gerenciar (design 5 e 6.1): transação, changes === 1, rollback, prazo, repetição,
// remarcação, cadeia, sugestões, eventos, 503 e 404 sem diferença.
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
  setBusinessTimezone,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { bookingBody, countAppointments, cancelDirect } from '../helpers/appointments.js';
import { countCustomers } from '../helpers/customers.js';
import { instrumentDb } from '../helpers/instrumented-db.js';
import { bookWithLink, tokensOf } from '../helpers/manage.js';
import { createManageService } from '../../src/modules/appointments/manage.service.js';
import { createAppointmentsService } from '../../src/modules/appointments/appointments.service.js';
import { createAppointmentsRepository } from '../../src/modules/appointments/appointments.repository.js';
import { createAppointmentsPort } from '../../src/modules/appointments/appointments-port.js';
import { createManageTokensRepository } from '../../src/modules/appointments/manage-tokens.repository.js';
import { createReschedulesRepository } from '../../src/modules/appointments/reschedules.repository.js';
import { createAvailabilityService } from '../../src/modules/availability/availability.service.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository } from '../../src/modules/services/services.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createWorkingHoursRepository } from '../../src/modules/working-hours/working-hours.repository.js';
import { createTimeBlocksRepository } from '../../src/modules/time-blocks/time-blocks.repository.js';
import { createCustomersRepository } from '../../src/modules/customers/customers.repository.js';
import { createCustomersService } from '../../src/modules/customers/customers.service.js';
import { MANAGE_MESSAGES as MM } from '../../src/shared/appointments.js';
import { SlotUnavailableError } from '../../src/http/errors.js';

// Quinta 26/11/2026, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';

let app;
let clock;
let ana;
let businessId;
let corte;
let pa;
let pb;

async function setup(now = NOW) {
  clock = createClock(now);
  ({ app } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  businessId = (await app.db.get('SELECT id FROM businesses')).id;
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
}

function recordingLog() {
  const entries = [];
  const push = (level) => (obj) => entries.push({ level, ...obj });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Serviço de gerenciar sobre as dependências do app, com trocas pontuais. */
function buildManage(extra = {}) {
  const s = app.services;
  return createManageService({
    db: app.db,
    businessesRepository: s.businessesRepository,
    servicesRepository: s.servicesRepository,
    professionalsRepository: s.professionalsRepository,
    appointmentsRepository: s.appointmentsRepository,
    manageTokensRepository: s.manageTokensRepository,
    reschedulesRepository: s.reschedulesRepository,
    appointmentsService: s.appointmentsService,
    availabilityService: s.availabilityService,
    config: { publicBaseUrl: 'https://agendafacil.app' },
    now: clock.now,
    ...extra,
  });
}

/** Tudo sobre o banco instrumentado: o `db` global dentro da transação lança (critério 20). */
function instrumentedManage() {
  const idb = instrumentDb(app.db);
  const appointmentsRepository = createAppointmentsRepository(idb);
  const workingHoursRepository = createWorkingHoursRepository(idb);
  const appointments = createAppointmentsPort({ appointmentsRepository, workingHoursRepository });
  const deps = {
    businessesRepository: createBusinessesRepository(idb),
    servicesRepository: createServicesRepository(idb),
    professionalsRepository: createProfessionalsRepository(idb),
    workingHoursRepository,
    timeBlocksRepository: createTimeBlocksRepository(idb),
  };
  const availabilityService = createAvailabilityService({ ...deps, appointments, now: clock.now });
  const manageTokensRepository = createManageTokensRepository(idb);
  const appointmentsService = createAppointmentsService({
    db: idb,
    ...deps,
    appointmentsRepository,
    appointments,
    customersService: createCustomersService({ customersRepository: createCustomersRepository(idb), now: clock.now }),
    availabilityService,
    manageTokensRepository,
    now: clock.now,
  });
  const service = createManageService({
    db: idb,
    ...deps,
    appointmentsRepository,
    manageTokensRepository,
    reschedulesRepository: createReschedulesRepository(idb),
    appointmentsService,
    availabilityService,
    config: { publicBaseUrl: 'https://agendafacil.app' },
    now: clock.now,
  });
  return { idb, service };
}

const fails = (promise) =>
  promise.then(
    (v) => assert.fail(`esperava erro, veio ${JSON.stringify(v)}`),
    (e) => e,
  );
const body = (over = {}) => bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, ...over });
const reserve = async (over = {}) => {
  const { token } = await bookWithLink(app, SLUG, body(over));
  const row = await app.db.get("SELECT * FROM appointments WHERE id = (SELECT appointment_id FROM appointment_manage_tokens ORDER BY created_at DESC, rowid DESC LIMIT 1)");
  return { token, row };
};
const versionOf = async (token, service = buildManage()) => (await service.get(token)).body.change.version;
const statusOf = async (id) => (await app.db.get('SELECT status FROM appointments WHERE id = ?', [id])).status;
const withTimeout = (promise, ms = 2000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('travou')), ms))]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const notWritten = (sql) => sql.every((q) => !/^(UPDATE|INSERT|DELETE)/.test(q));

describe('só a transação e autorização na transação (critério 20)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('cancel e reschedule concluem sem usar o db global dentro da transação, em menos de 2 s', async () => {
    const { token: t1 } = await reserve();
    const { token: t2 } = await reserve({ start: `${FRIDAY}T13:00` });
    const { idb, service } = instrumentedManage();
    const v2 = await versionOf(t2, service);
    assert.equal((await withTimeout(service.reschedule(t2, { start: `${FRIDAY}T14:00`, version: v2 }))).status, 200);
    const v1 = await versionOf(t1, service);
    assert.equal((await withTimeout(service.cancel(t1, { version: v1 }))).status, 200);
    assert.ok(idb.calls.some((c) => c.inTx));
  });

  test('cancelado por outro caminho entre a pré-checagem e a transação: 409 sem efeito', async () => {
    for (const action of ['cancel', 'reschedule']) {
      const { token, row } = await reserve({ start: `${FRIDAY}T${action === 'cancel' ? '10:00' : '14:00'}` });
      const version = await versionOf(token);
      const repo = app.services.manageTokensRepository;
      let calls = 0;
      const spy = {
        ...repo,
        async findLiveByHash(...args) {
          const out = await repo.findLiveByHash(...args);
          calls += 1;
          if (calls === 1) await cancelDirect(app.db, row.id);
          return out;
        },
      };
      const service = buildManage({ manageTokensRepository: spy });
      const input = action === 'cancel' ? { version } : { start: `${FRIDAY}T15:00`, version };
      const err = await fails(service[action](token, input));
      assert.equal(err.statusCode, 409, action);
      assert.equal((await tokensOf(app.db, row.id))[0].revoked_at, null, 'nenhum token revogado');
      assert.equal(await countAppointments(app.db, { status: 'confirmed', starts_at: '2026-11-27T18:00:00.000Z' }), 0);
    }
  });
});

describe('prazo relido na transação (critério 20, QA L1)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  /** Serviço cujo businessesRepository muda o prazo logo depois da 1ª leitura (a pré-checagem). */
  function leadFlipAfterPrecheck(lead) {
    const repo = app.services.businessesRepository;
    let calls = 0;
    const spy = {
      ...repo,
      async findById(...args) {
        const out = await repo.findById(...args);
        calls += 1;
        if (calls === 1) await app.db.run('UPDATE businesses SET cancellation_lead_minutes = ?', [lead]);
        return out;
      },
    };
    return { service: buildManage({ businessesRepository: spy }), calls: () => calls };
  }

  for (const action of ['cancel', 'reschedule']) {
    test(`${action}: aberto na pré-checagem e fechado antes da transação dá 409 sem gravar`, async () => {
      const { token, row } = await reserve();
      const version = await versionOf(token);
      const { service, calls } = leadFlipAfterPrecheck(4320);
      const input = action === 'cancel' ? { version } : { start: `${FRIDAY}T14:00`, version };
      const err = await fails(service[action](token, input));
      assert.ok(calls() >= 2, 'o negócio é relido na transação');
      assert.equal(err.code, 'APPOINTMENT_NOT_CHANGEABLE');
      assert.equal(await statusOf(row.id), 'confirmed');
      assert.equal((await tokensOf(app.db, row.id))[0].revoked_at, null);
      assert.equal(await countAppointments(app.db, { status: 'confirmed', starts_at: '2026-11-27T17:00:00.000Z' }), 0);
    });

    test(`${action}: fechado na pré-checagem e aberto antes da transação dá 200`, async () => {
      const { token, row } = await reserve();
      const version = await versionOf(token);
      await app.db.run('UPDATE businesses SET cancellation_lead_minutes = 4320');
      const { service } = leadFlipAfterPrecheck(60);
      const input = action === 'cancel' ? { version } : { start: `${FRIDAY}T14:00`, version };
      const res = await service[action](token, input);
      assert.equal(res.status, 200);
      assert.equal(res.body.change.cancellationLeadMinutes, 60);
      assert.equal(await statusOf(row.id), 'cancelled');
    });
  }
});

describe('changes === 1 (critério 21, mutação permanente)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('cancelIfConfirmed devolvendo 0: reschedule e cancel dão 409, nada gravado', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const repo = app.services.appointmentsRepository;
    const zero = { ...repo, cancelIfConfirmed: async () => ({ changes: 0 }) };
    const service = buildManage({ appointmentsRepository: zero });
    const total = await countAppointments(app.db);

    const e1 = await fails(service.reschedule(token, { start: `${FRIDAY}T10:30`, version }));
    assert.equal(e1.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal(await countAppointments(app.db), total, 'nenhum agendamento novo');
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_reschedules')).n), 0);
    assert.equal((await tokensOf(app.db, row.id)).length, 1, 'o token continua no antigo');
    assert.equal(await statusOf(row.id), 'confirmed');

    const e2 = await fails(service.cancel(token, { version }));
    assert.equal(e2.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal((await tokensOf(app.db, row.id))[0].revoked_at, null);
  });

  test('releitura (5.3 passo 6): o concorrente cancelou e revogou antes do UPDATE (como no PostgreSQL): 200 de repetição, sem evento', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const repo = app.services.appointmentsRepository;
    const tokens = app.services.manageTokensRepository;
    const late = {
      ...repo,
      async cancelIfConfirmed(id, businessId, nowIso, tx) {
        // O "outro" cancelamento conclui primeiro na mesma linha; este UPDATE vê 0 linhas.
        await repo.cancelIfConfirmed(id, businessId, nowIso, tx);
        await tokens.revokeForAppointment(businessId, id, 'cancelled', nowIso, tx);
        return { changes: 0 };
      },
    };
    const emitted = [];
    const appointmentEvents = { cancelled: (e) => emitted.push(e) };
    const res = await buildManage({ appointmentsRepository: late, appointmentEvents }).cancel(token, { version });
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'cancelled');
    await tick();
    assert.deepEqual(emitted, []);
    assert.equal(await statusOf(row.id), 'cancelled');
  });
});

describe('rollback da remarcação (critério 26)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('bookSlot que lança (slot, genérico, SQLITE_BUSY) e moveToAppointment com 0: o antigo fica intacto', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const total = await countAppointments(app.db);
    const s = app.services;
    const failures = [
      { appointmentsService: { ...s.appointmentsService, bookSlot: async () => { throw new SlotUnavailableError(); } }, status: 409 },
      { appointmentsService: { ...s.appointmentsService, bookSlot: async () => { throw new Error('x'); } }, status: 503 },
      {
        appointmentsService: {
          ...s.appointmentsService,
          bookSlot: async () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); },
        },
        status: 503,
      },
      { manageTokensRepository: { ...s.manageTokensRepository, moveToAppointment: async () => ({ changes: 0 }) }, status: 409 },
    ];
    for (const { status, ...extra } of failures) {
      const err = await fails(buildManage(extra).reschedule(token, { start: `${FRIDAY}T13:00`, version }));
      assert.equal(err.statusCode, status);
      const now = await app.db.get('SELECT status, updated_at FROM appointments WHERE id = ?', [row.id]);
      assert.deepEqual({ ...now }, { status: 'confirmed', updated_at: row.updated_at });
      assert.equal(await countAppointments(app.db), total);
      assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_reschedules')).n), 0);
      assert.equal((await tokensOf(app.db, row.id)).length, 1);
    }
  });
});

describe('prazo (critério 18) e valor atual (critério 3)', () => {
  afterEach(() => app.close());

  async function edge({ now, timezone, start, lead = 120 }) {
    await setup(now);
    if (timezone) await setBusinessTimezone(app, businessId, timezone);
    const ALL = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start: '00:00', end: '24:00' }] }));
    assert.equal((await putHours(app, ana, pa.id, ALL)).statusCode, 200);
    await app.db.run('UPDATE businesses SET cancellation_lead_minutes = ?', [lead]);
    return reserve({ start });
  }

  for (const { label, now, timezone, start, deadline } of [
    { label: 'dia comum (10:00, prazo 08:00)', now: '2026-11-26T12:00:00.000Z', start: '2026-11-27T10:00', deadline: '2026-11-27T11:00:00.000Z' },
    { label: 'virada de dia (00:30, prazo 22:30 do dia anterior)', now: '2026-11-26T12:00:00.000Z', start: '2026-11-28T00:30', deadline: '2026-11-28T01:30:00.000Z' },
    { label: 'Asia/Tokyo (01:00 locais)', now: '2026-11-26T03:00:00.000Z', timezone: 'Asia/Tokyo', start: '2026-11-28T01:00', deadline: '2026-11-27T14:00:00.000Z' },
  ]) {
    test(`${label}: exatamente no prazo pode; 1 s depois dá 409 e nada é gravado`, async () => {
      const { token, row } = await edge({ now, timezone, start });
      const version = await versionOf(token);
      clock.advance(Date.parse(deadline) - clock.now().getTime() + 1000);
      const late = await fails(buildManage().cancel(token, { version }));
      assert.equal(late.code, 'APPOINTMENT_NOT_CHANGEABLE');
      assert.equal(await statusOf(row.id), 'confirmed');
      assert.equal((await buildManage().get(token)).body.change.canChange, false);
      clock.advance(-1000);
      const body = (await buildManage().get(token)).body;
      assert.equal(body.change.canChange, true);
      assert.equal((await buildManage().cancel(token, { version })).status, 200);
    });
  }

  test('antecedência 0: a 1 s do início pode; no início não', async () => {
    const { token, row } = await edge({ now: NOW, start: '2026-11-27T10:00', lead: 0 });
    const version = await versionOf(token);
    clock.advance(Date.parse(row.starts_at) - clock.now().getTime());
    assert.equal((await fails(buildManage().cancel(token, { version }))).code, 'APPOINTMENT_NOT_CHANGEABLE');
    clock.advance(-1000);
    assert.equal((await buildManage().cancel(token, { version })).status, 200);
  });

  test('valor atual: mudar para 4320 pelo PATCH fecha a janela; voltar para 60 reabre', async () => {
    await setup();
    const { token } = await reserve();
    const patch = (minutes) => app.inject({ method: 'PATCH', url: '/api/business', cookies: ana, payload: { cancellationLeadMinutes: minutes } });
    assert.equal((await patch(4320)).statusCode, 200);
    assert.equal((await buildManage().get(token)).body.change.canChange, false);
    const version = await versionOf(token);
    assert.equal((await fails(buildManage().cancel(token, { version }))).code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal((await patch(60)).statusCode, 200);
    assert.equal((await buildManage().get(token)).body.change.cancellationLeadMinutes, 60);
    assert.equal((await buildManage().cancel(token, { version })).status, 200);
  });
});

describe('cancelar: repetição e outro caminho (critérios 19 e 20)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('a segunda chamada dá 200 com o mesmo corpo, sem UPDATE, e cancelled_at/revoked_at iguais; com a versão antiga também', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const { idb, service } = instrumentedManage();
    const first = await service.cancel(token, { version });
    const after = await app.db.get('SELECT cancelled_at, updated_at FROM appointments WHERE id = ?', [row.id]);
    const revoked = (await tokensOf(app.db, row.id))[0].revoked_at;
    clock.advance(60_000);
    idb.reset();
    const again = await service.cancel(token, { version });
    assert.equal(JSON.stringify(again.body.appointment), JSON.stringify(first.body.appointment));
    assert.equal(again.body.change.version, first.body.change.version);
    assert.ok(notWritten(idb.sqlOf()), idb.sqlOf().join('\n'));
    assert.deepEqual(await app.db.get('SELECT cancelled_at, updated_at FROM appointments WHERE id = ?', [row.id]), after);
    assert.equal((await tokensOf(app.db, row.id))[0].revoked_at, revoked);
    assert.equal(first.body.appointment.status, 'cancelled');
    assert.equal((await buildManage().get(token)).body.appointment.status, 'cancelled');
  });

  test('cancelado direto no banco: get mostra cancelled e cancel dá 409', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    await cancelDirect(app.db, row.id);
    assert.equal((await buildManage().get(token)).body.appointment.status, 'cancelled');
    const err = await fails(buildManage().cancel(token, { version: (await buildManage().get(token)).body.change.version }));
    assert.equal(err.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal((await fails(buildManage().cancel(token, { version }))).code, 'APPOINTMENT_CHANGED');
  });

  test('completed e no_show: 409 APPOINTMENT_NOT_CHANGEABLE', async () => {
    for (const [status, start] of [['completed', '10:00'], ['no_show', '13:00']]) {
      const { token, row } = await reserve({ start: `${FRIDAY}T${start}` });
      await app.db.run('UPDATE appointments SET status = ? WHERE id = ?', [status, row.id]);
      const version = await versionOf(token);
      assert.equal((await fails(buildManage().cancel(token, { version }))).code, 'APPOINTMENT_NOT_CHANGEABLE');
      assert.equal((await fails(buildManage().reschedule(token, { start: `${FRIDAY}T15:00`, version }))).code, 'APPOINTMENT_NOT_CHANGEABLE');
    }
  });
});

describe('remarcar (critérios 25 a 32, 41 e 42)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('10:00 para 10:30 (sobre o próprio horário): antigo cancelled, novo com snapshot do cliente e preço novo; o mesmo token', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const customers = await countCustomers(app.db);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/services/${corte.id}`, cookies: ana, payload: { price: '70' } })).statusCode, 200);
    const res = await buildManage().reschedule(token, { start: `${FRIDAY}T10:30`, version });
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.start, `${FRIDAY}T10:30`);
    assert.equal(res.body.appointment.service.priceCents, 7000);
    assert.notEqual(res.body.change.version, version);
    const old = await app.db.get('SELECT * FROM appointments WHERE id = ?', [row.id]);
    assert.equal(old.status, 'cancelled');
    assert.ok(old.cancelled_at);
    assert.equal(old.price_cents, 5000);
    const fresh = await app.db.get("SELECT * FROM appointments WHERE status = 'confirmed'");
    assert.equal(fresh.customer_id, row.customer_id);
    assert.equal(fresh.customer_name, row.customer_name);
    assert.equal(fresh.customer_phone, row.customer_phone);
    assert.equal(fresh.price_cents, 7000);
    assert.equal(await countCustomers(app.db), customers, 'sem findOrCreate');
    const [t] = await tokensOf(app.db, fresh.id);
    assert.equal(t.expires_at, fresh.ends_at);
    assert.equal((await tokensOf(app.db, row.id)).length, 0, 'o antigo fica sem token');
    assert.equal((await buildManage().get(token)).body.appointment.start, `${FRIDAY}T10:30`);
    const link = await app.db.get('SELECT * FROM appointment_reschedules');
    assert.deepEqual([link.previous_appointment_id, link.appointment_id, link.sequence], [row.id, fresh.id, 1]);
  });

  test('cliente com 3 futuros remarca um deles (o antigo já não conta, critério 29)', async () => {
    const customer = { email: 'limite@x.com', phone: '(11) 97777-0000' };
    const { token } = await reserve({ customer });
    await reserve({ customer, start: `${FRIDAY}T13:00` });
    await reserve({ customer, start: `${FRIDAY}T14:00` });
    const version = await versionOf(token);
    assert.equal((await buildManage().reschedule(token, { start: `${FRIDAY}T16:00`, version })).status, 200);
  });

  test('any atribui pelo menor número de agendamentos e mostra o nome (critério 32)', async () => {
    await reserve({ professionalId: pa.id, start: `${FRIDAY}T15:00` });
    const { token } = await reserve({ professionalId: pa.id });
    const version = await versionOf(token);
    const res = await buildManage().reschedule(token, { start: `${FRIDAY}T16:00`, professionalId: 'any', version });
    assert.equal(res.body.appointment.professional.name, 'Bia Lima');
  });

  test('serviço desativado: remarcar dá rescheduleServiceUnavailable e cancelar funciona (critério 42)', async () => {
    const { token } = await reserve();
    const version = await versionOf(token);
    assert.equal((await app.inject({ method: 'POST', url: `/api/services/${corte.id}/deactivate`, cookies: ana })).statusCode, 200);
    const get = (await buildManage().get(token)).body;
    assert.equal(get.change.reschedule.allowed, false);
    assert.equal(get.change.reschedule.notice, MM.rescheduleServiceUnavailable);
    const err = await fails(buildManage().reschedule(token, { start: `${FRIDAY}T13:00`, version }));
    assert.equal(err.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal(err.message, MM.rescheduleServiceUnavailable);
    assert.equal((await buildManage().cancel(token, { version })).status, 200);
  });

  test('profissional sem grade: professionalUnavailable sem professionalId; com any funciona', async () => {
    const { token } = await reserve();
    const version = await versionOf(token);
    assert.equal((await putHours(app, ana, pa.id, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [] })))).statusCode, 200);
    assert.equal((await buildManage().get(token)).body.change.reschedule.sameProfessional, false);
    const err = await fails(buildManage().reschedule(token, { start: `${FRIDAY}T13:00`, version }));
    assert.equal(err.message, MM.professionalUnavailable);
    const res = await buildManage().reschedule(token, { start: `${FRIDAY}T13:00`, professionalId: 'any', version });
    assert.equal(res.body.appointment.professional.name, 'Bia Lima');
  });

  test('bloqueio criado depois dá SLOT_UNAVAILABLE e o antigo fica confirmed (critério 41)', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const block = await postTimeBlock(app, ana, { professionalId: pa.id, start: `${FRIDAY}T13:00`, end: `${FRIDAY}T14:00`, reason: 'x' });
    assert.equal(block.statusCode, 201, block.body);
    const err = await fails(buildManage().reschedule(token, { start: `${FRIDAY}T13:00`, version }));
    assert.equal(err.code, 'SLOT_UNAVAILABLE');
    assert.equal(await statusOf(row.id), 'confirmed');
  });

  test('nada muda (critério 31): mesmo início e profissional, e mesmo início com any, sem gravar; retry com a versão antiga dá 200', async () => {
    const { token } = await reserve();
    const version = await versionOf(token);
    const { idb, service } = instrumentedManage();
    for (const professionalId of [undefined, pa.id, 'any']) {
      idb.reset();
      const res = await service.reschedule(token, { start: `${FRIDAY}T10:00`, professionalId, version: 'x'.repeat(43) });
      assert.equal(res.status, 200);
      assert.ok(notWritten(idb.sqlOf()), idb.sqlOf().join('\n'));
    }
    const done = await service.reschedule(token, { start: `${FRIDAY}T13:00`, version });
    const retry = await service.reschedule(token, { start: `${FRIDAY}T13:00`, version });
    assert.equal(JSON.stringify(retry.body), JSON.stringify(done.body));
  });

  test('limite de cadeia: 3 remarcações e a 4ª dá RESCHEDULE_LIMIT_REACHED; o token da repetição idempotente segue a cadeia e não zera', async () => {
    const key = '3b241101-e2bb-4255-8caf-4136c566a962';
    const b = body({ start: `${FRIDAY}T09:00` });
    const { token } = await bookWithLink(app, SLUG, b, { headers: { 'idempotency-key': key } });
    let current = token;
    for (const [i, start] of ['13:00', '14:00', '15:00'].entries()) {
      const res = await buildManage().reschedule(current, { start: `${FRIDAY}T${start}`, version: await versionOf(current) });
      assert.equal(res.status, 200, String(i));
      if (i === 0) {
        // Repetição idempotente (QA D2): o token novo segue a cadeia até o atual (13:00, confirmed), e as
        // próximas remarcações por ele continuam contando a mesma cadeia.
        const replay = await bookWithLink(app, SLUG, b, { headers: { 'idempotency-key': key } });
        const view = (await buildManage().get(replay.token)).body;
        assert.equal(view.appointment.status, 'confirmed');
        assert.equal(view.appointment.start, `${FRIDAY}T13:00`);
        current = replay.token;
      }
    }
    const get = (await buildManage().get(current)).body;
    assert.equal(get.change.reschedule.allowed, false);
    assert.equal(get.change.reschedule.notice, MM.rescheduleLimit);
    const err = await fails(buildManage().reschedule(current, { start: `${FRIDAY}T16:00`, version: get.change.version }));
    assert.equal(err.code, 'RESCHEDULE_LIMIT_REACHED');
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_reschedules')).n), 3);
  });

  test('sugestões (critério 30): com 10:30 ocupado, até 3, e o horário do próprio antigo aparece', async () => {
    const { token } = await reserve();
    await reserve({ start: `${FRIDAY}T11:00` });
    const version = await versionOf(token);
    const err = await fails(buildManage().reschedule(token, { start: `${FRIDAY}T10:30`, version }));
    assert.equal(err.code, 'SLOT_UNAVAILABLE');
    assert.ok(err.suggestions.length > 0 && err.suggestions.length <= 3);
    const avail = (await buildManage().availability(token, { date: FRIDAY })).body;
    const starts = avail.days[0].slots.map((s) => s.start);
    assert.ok(starts.includes(`${FRIDAY}T10:00`), 'o próprio horário não ocupa');
    assert.equal(starts.includes(`${FRIDAY}T11:00`), false);
  });

  test('QA L2: as sugestões do 409 sobrepõem o próprio horário antigo (excludeAppointmentId em findSuggestions)', async () => {
    // Antigo 10:00–11:00 com Ana; outro cliente 09:00–10:00 com Ana; pedido 09:30 (ocupado pelo outro).
    const { token, row } = await reserve();
    await reserve({ start: `${FRIDAY}T09:00` });
    const version = await versionOf(token);
    const err = await fails(buildManage().reschedule(token, { start: `${FRIDAY}T09:30`, version }));
    assert.equal(err.code, 'SLOT_UNAVAILABLE');
    // Sem o filtro, o antigo ocuparia 10:00–11:00 e as sugestões seriam 11:00, 13:00 e 13:15.
    assert.deepEqual(
      err.suggestions.map((sug) => sug.start),
      [`${FRIDAY}T10:00`, `${FRIDAY}T10:15`, `${FRIDAY}T10:30`],
    );
    assert.equal(await statusOf(row.id), 'confirmed', 'o ROLLBACK devolve o antigo');
  });
});

describe('eventos (critério 38)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('cancelled e rescheduled só com ids (AF-18: sem manageUrl), depois do COMMIT; nada em 409, repetição e nada muda', async () => {
    const received = [];
    const appointmentEvents = {
      async cancelled(event) {
        received.push({ name: 'cancelled', event, row: await app.db.get('SELECT status FROM appointments WHERE id = ?', [event.appointmentId]) });
      },
      async rescheduled(event) {
        received.push({ name: 'rescheduled', event, row: await app.db.get('SELECT status FROM appointments WHERE id = ?', [event.appointmentId]) });
      },
    };
    const service = buildManage({ appointmentEvents });
    const { token: t1, row: r1 } = await reserve();
    const { token: t2, row: r2 } = await reserve({ start: `${FRIDAY}T13:00` });
    const v2 = await versionOf(t2);
    await service.reschedule(t2, { start: `${FRIDAY}T14:00`, version: v2 });
    await service.reschedule(t2, { start: `${FRIDAY}T14:00`, version: v2 });
    await fails(service.reschedule(t2, { start: `${FRIDAY}T15:00`, version: v2 }));
    const v1 = await versionOf(t1);
    await service.cancel(t1, { version: v1 });
    await service.cancel(t1, { version: v1 });
    await tick();
    await tick();
    assert.deepEqual(received.map((r) => r.name), ['rescheduled', 'cancelled']);
    const [resc, canc] = received;
    assert.deepEqual(Object.keys(resc.event).sort(), ['appointmentId', 'businessId', 'previousAppointmentId']);
    assert.equal(resc.event.previousAppointmentId, r2.id);
    assert.equal(resc.row.status, 'confirmed');
    assert.deepEqual(canc.event, { appointmentId: r1.id, businessId });
    assert.equal(canc.row.status, 'cancelled');
  });

  test('porta que lança, assíncrona ou que nunca resolve não muda o 200; porta só com confirmed não quebra', async () => {
    const log = recordingLog();
    const ports = [
      { cancelled() { throw Object.assign(new Error('s'), { code: 'ESYNC' }); } },
      { cancelled: async () => { throw Object.assign(new Error('a'), { code: 'EASYNC' }); } },
      { cancelled: () => new Promise(() => {}) },
      { confirmed: async () => {} },
    ];
    for (const [i, appointmentEvents] of ports.entries()) {
      const { token } = await reserve({ start: `${FRIDAY}T${['10:00', '13:00', '14:00', '15:00'][i]}` });
      const res = await buildManage({ appointmentEvents, log }).cancel(token, { version: await versionOf(token) });
      assert.equal(res.status, 200);
    }
    await tick();
    await tick();
    const failed = log.entries.filter((e) => e.event === 'appointment_event_failed');
    assert.deepEqual(failed.map((e) => e.errCode).sort(), ['EASYNC', 'ESYNC']);
    assert.ok(failed.every((e) => e.eventName === 'cancelled' && !('manageUrl' in e)));
  });
});

describe('503 e 404 sem diferença (critérios 34 e 35)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('banco que lança em findLiveByHash e em cancelIfConfirmed, e SQLITE_BUSY: 503 MANAGE_UNAVAILABLE sem gravar', async () => {
    const { token, row } = await reserve();
    const version = await versionOf(token);
    const busy = () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
    const log = recordingLog();
    const s = app.services;
    const broken = [
      buildManage({ manageTokensRepository: { ...s.manageTokensRepository, findLiveByHash: async () => busy() }, log }),
      buildManage({ appointmentsRepository: { ...s.appointmentsRepository, cancelIfConfirmed: async () => busy() }, log }),
    ];
    for (const service of broken) {
      for (const call of [() => service.cancel(token, { version }), () => service.reschedule(token, { start: `${FRIDAY}T13:00`, version })]) {
        const err = await fails(call());
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, 'MANAGE_UNAVAILABLE');
        assert.equal(err.message, MM.unavailable);
      }
    }
    assert.equal(await fails(broken[0].get(token)).then((e) => e.code), 'MANAGE_UNAVAILABLE');
    assert.equal(await statusOf(row.id), 'confirmed');
    assert.equal(await countAppointments(app.db), 1);
    assert.ok(log.entries.some((e) => e.event === 'appointment_manage_failed' && e.errCode === 'SQLITE_BUSY'));
  });

  test('inexistente e vencido executam a mesma sequência de SQL; malformado não executa SQL', async () => {
    const { token, row } = await reserve();
    const { idb, service } = instrumentedManage();
    const missing = 'Q'.repeat(43);
    await fails(service.get(missing));
    const missingSql = idb.sqlOf();
    idb.reset();
    clock.advance(Date.parse(row.ends_at) - clock.now().getTime());
    const err = await fails(service.get(token));
    assert.equal(err.statusCode, 404);
    assert.equal(err.message, MM.linkInvalid);
    assert.deepEqual(idb.sqlOf(), missingSql);
    idb.reset();
    for (const bad of ['x', `${token}a`, '']) assert.equal((await fails(service.get(bad))).statusCode, 404);
    assert.deepEqual(idb.calls, []);
  });
});
