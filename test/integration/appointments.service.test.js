import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
import { bookingBody, countAppointments, insertAppointmentDirect, cancelDirect } from '../helpers/appointments.js';
import { countCustomers } from '../helpers/customers.js';
import { instrumentDb } from '../helpers/instrumented-db.js';
import { fakeAppointments } from '../helpers/availability.js';
import { createAppointmentsService } from '../../src/modules/appointments/appointments.service.js';
import { createAppointmentsRepository } from '../../src/modules/appointments/appointments.repository.js';
import { createAppointmentsPort } from '../../src/modules/appointments/appointments-port.js';
import { createAvailabilityService } from '../../src/modules/availability/availability.service.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository } from '../../src/modules/services/services.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createWorkingHoursRepository } from '../../src/modules/working-hours/working-hours.repository.js';
import { createTimeBlocksRepository } from '../../src/modules/time-blocks/time-blocks.repository.js';
import { createCustomersRepository } from '../../src/modules/customers/customers.repository.js';
import { createCustomersService } from '../../src/modules/customers/customers.service.js';
import { APPOINTMENT_MESSAGES as M } from '../../src/shared/appointments.js';
import { PUBLIC_APPOINTMENT_FIELDS } from '../../src/modules/appointments/appointments.view.js';
import {
  SlotUnavailableError,
  ConflictError,
  IdempotencyKeyReusedError,
  ServiceUnavailableError,
  NotFoundError,
  ValidationError,
} from '../../src/http/errors.js';

// Quinta 26/11/2026, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start: '00:00', end: '24:00' }] }));

let app;
let clock;
let logs;
let ana;
let businessId;
let corte;
let pa;
let pb;

function recordingLog() {
  const entries = [];
  const push = (level) => (obj) => entries.push({ level, ...obj });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

async function setup(now = NOW) {
  clock = createClock(now);
  ({ app, logs } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  businessId = (await app.db.get('SELECT id FROM businesses')).id;
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
}

/** Serviço com as dependências do app e trocas pontuais. */
function buildService(extra = {}) {
  const s = app.services;
  return createAppointmentsService({
    db: app.db,
    businessesRepository: s.businessesRepository,
    servicesRepository: s.servicesRepository,
    professionalsRepository: s.professionalsRepository,
    workingHoursRepository: s.workingHoursRepository,
    timeBlocksRepository: s.timeBlocksRepository,
    appointmentsRepository: s.appointmentsRepository,
    appointments: s.appointments,
    customersService: s.customersService,
    availabilityService: s.availabilityService,
    manageTokensRepository: s.manageTokensRepository,
    publicBaseUrl: 'https://agendafacil.app',
    now: clock.now,
    ...extra,
  });
}

const body = (over = {}) => bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, ...over });
const book = (b, opts = {}, service = buildService()) => service.book(SLUG, b, opts);
const fails = (promise) => promise.then(
  (v) => assert.fail(`esperava erro, veio ${JSON.stringify(v)}`),
  (e) => e,
);
const localIso = (local, offsetHours = 3) => {
  const ms = Date.parse(`${local}:00.000Z`) + offsetHours * 3_600_000;
  return new Date(ms).toISOString();
};

/** Serviço inteiro sobre o banco instrumentado: o `db` global dentro da transação lança. */
function instrumentedService() {
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
  const service = createAppointmentsService({
    db: idb,
    ...deps,
    appointmentsRepository,
    appointments,
    customersService: createCustomersService({ customersRepository: createCustomersRepository(idb), now: clock.now }),
    availabilityService,
    now: clock.now,
  });
  return { idb, service };
}


describe('gravação (critérios 7, 8 e 11)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('201 com status confirmed, snapshots e instantes UTC; com profissional específico fica com ele', async () => {
    const result = await book(body({ customer: { name: '  Ana  Souza ', phone: '(11) 91234-5678' } }));
    assert.equal(result.status, 201);
    assert.equal(result.body.appointment.professional.name, 'Ana Souza');
    const row = await app.db.get('SELECT * FROM appointments');
    assert.equal(row.status, 'confirmed');
    assert.equal(row.professional_id, pa.id);
    assert.equal(row.business_id, businessId);
    assert.equal(row.service_id, corte.id);
    assert.equal(row.service_name, 'Corte');
    assert.equal(row.duration_minutes, 60);
    assert.equal(row.price_cents, 5000);
    assert.equal(row.customer_name, 'Ana  Souza');
    assert.equal(row.customer_phone, '11912345678');
    assert.equal(row.starts_at, '2026-11-27T13:00:00.000Z');
    assert.equal(row.ends_at, '2026-11-27T14:00:00.000Z');
    assert.equal(row.created_at, NOW);
    assert.equal(row.updated_at, NOW);
    assert.equal(row.cancelled_at, null);
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(JSON.stringify(result.body).includes(row.id), false);
  });

  test('editar nome, preço e duração do serviço e desativá-lo depois não altera a linha; o nome do profissional vem por JOIN', async () => {
    await book(body());
    const id = (await app.db.get('SELECT id FROM appointments')).id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/services/${corte.id}`,
      cookies: ana,
      payload: { name: 'Corte Novo', durationMinutes: 90, price: '80' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const deactivate = await app.inject({ method: 'POST', url: `/api/services/${corte.id}/deactivate`, cookies: ana });
    assert.equal(deactivate.statusCode, 200);
    const renamed = await app.inject({ method: 'PATCH', url: `/api/professionals/${pa.id}`, cookies: ana, payload: { name: 'Ana Maria' } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const row = await app.services.appointmentsRepository.findById(id, businessId);
    assert.equal(row.serviceName, 'Corte');
    assert.equal(row.durationMinutes, 60);
    assert.equal(row.priceCents, 5000);
    assert.equal(row.professionalName, 'Ana Maria');
  });

  test('serviço sob consulta grava price_cents NULL', async () => {
    const luzes = await createService(app, ana, { name: 'Luzes', durationMinutes: 30, priceOnRequest: true, price: null });
    await app.inject({ method: 'PATCH', url: `/api/professionals/${pa.id}`, cookies: ana, payload: { serviceIds: [corte.id, luzes.id] } });
    const result = await book(body({ serviceId: luzes.id }));
    assert.equal(result.body.appointment.service.priceOnRequest, true);
    assert.equal((await app.db.get('SELECT price_cents FROM appointments')).price_cents, null);
  });
});

describe('rollback (critério 7)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('insert que lança depois de findOrCreate: nenhum cliente nem agendamento', async () => {
    const repo = app.services.appointmentsRepository;
    const service = buildService({
      appointmentsRepository: {
        ...repo,
        async insert() {
          throw new Error('falha forçada');
        },
      },
    });
    const err = await fails(book(body(), {}, service));
    assert.ok(err instanceof ServiceUnavailableError);
    assert.equal(err.code, 'BOOKING_UNAVAILABLE');
    assert.equal(await countCustomers(app.db), 0);
    assert.equal(await countAppointments(app.db), 0);
  });

  test('o mesmo com SlotUnavailableError e com BOOKING_LIMIT_REACHED: o cliente criado na transação some', async () => {
    await insertAppointmentDirect(app.db, {
      businessId,
      professionalId: pa.id,
      customerId: (await book(body({ start: `${FRIDAY}T15:00` })), (await app.db.get('SELECT id FROM customers')).id),
      serviceId: corte.id,
      startsAt: localIso(`${FRIDAY}T10:00`),
    });
    const before = await countCustomers(app.db);
    const slot = await fails(book(body()));
    assert.ok(slot instanceof SlotUnavailableError);
    assert.equal(await countCustomers(app.db), before);
    // Telefone com 3 futuros: o 4º, com e-mail novo, cria o cliente e é desfeito.
    for (const start of ['13:00', '14:00']) await book(body({ start: `${FRIDAY}T${start}`, customer: { phone: '(11) 98888-7777' } }));
    await book(body({ start: `${FRIDAY}T16:00`, customer: { phone: '(11) 98888-7777' } }));
    const count = await countCustomers(app.db);
    const limit = await fails(book(body({ professionalId: pb.id, customer: { phone: '11988887777' } })));
    assert.ok(limit instanceof ConflictError);
    assert.equal(limit.code, 'BOOKING_LIMIT_REACHED');
    assert.equal(await countCustomers(app.db), count);
  });
});

describe('recheck dentro da transação (critério 10)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('ocupado por agendamento, bloqueio do profissional, bloqueio de "todos", almoço, fora da grade, < 1 h e passado: o mesmo SlotUnavailableError', async () => {
    await book(body({ start: `${FRIDAY}T10:00` }));
    assert.equal((await postTimeBlock(app, ana, { professionalId: pa.id, start: `${FRIDAY}T14:00`, end: `${FRIDAY}T15:00` })).statusCode, 201);
    assert.equal((await postTimeBlock(app, ana, { professionalId: null, start: `${FRIDAY}T16:00`, end: `${FRIDAY}T17:00` })).statusCode, 201);
    const cases = [
      ['agendamento (sobreposição 10:30)', `${FRIDAY}T10:30`],
      ['agendamento (mesmo início)', `${FRIDAY}T10:00`],
      ['bloqueio do profissional', `${FRIDAY}T14:00`],
      ['bloqueio de todos', `${FRIDAY}T16:00`],
      ['almoço', `${FRIDAY}T12:00`],
      ['atravessa o almoço', `${FRIDAY}T11:30`],
      ['fora da grade', `${FRIDAY}T18:00`],
      ['termina depois do expediente', `${FRIDAY}T17:15`],
      ['menos de 1 h (hoje 09:30)', '2026-11-26T09:30'],
      ['passado (hoje 08:00)', '2026-11-26T08:00'],
      ['sábado sem grade', '2026-11-28T10:00'],
    ];
    const bodies = [];
    for (const [label, start] of cases) {
      const err = await fails(book(body({ start })));
      assert.ok(err instanceof SlotUnavailableError, label);
      assert.equal(err.statusCode, 409, label);
      assert.equal(err.message, M.slotUnavailable, label);
      bodies.push(JSON.stringify({ code: err.code, message: err.message }));
    }
    assert.equal(new Set(bodies).size, 1);
    assert.equal(await countAppointments(app.db), 1);
    // Encostado no ocupado e no bloqueio: aceito.
    assert.equal((await book(body({ start: `${FRIDAY}T11:00` }))).status, 201);
    assert.equal((await book(body({ start: `${FRIDAY}T13:00` }))).status, 201);
  });

  test('às 10:00 de hoje (exatamente 1 h) é aceito; o relógio do servidor decide', async () => {
    assert.equal((await book(body({ start: '2026-11-26T10:00' }))).status, 201);
  });

  test('dobra do horário de verão (America/New_York, passo de 15 min): ocupada a 1ª 01:30, a 2ª não é oferecida', async () => {
    await app.close();
    await setup('2027-11-03T16:00:00.000Z');
    await setBusinessTimezone(app, businessId, 'America/New_York');
    for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, ALL_WEEK)).statusCode, 200);
    // Domingo 7/11/2027: 01:00–02:00 acontece duas vezes (EDT 05:00Z, depois EST 06:00Z).
    const first = await book(body({ start: '2027-11-07T01:30' }));
    assert.equal(first.status, 201);
    assert.equal((await app.db.get('SELECT starts_at FROM appointments')).starts_at, '2027-11-07T05:30:00.000Z');
    const err = await fails(book(body({ start: '2027-11-07T01:30' })));
    assert.ok(err instanceof SlotUnavailableError);
    // O mesmo início com outro profissional vai para a 1ª ocorrência.
    await book(body({ professionalId: pb.id, start: '2027-11-07T01:30' }));
    assert.deepEqual(
      (await app.db.all('SELECT starts_at FROM appointments ORDER BY starts_at')).map((r) => r.starts_at),
      ['2027-11-07T05:30:00.000Z', '2027-11-07T05:30:00.000Z'],
    );
  });

  // AF-21 (design 8, lacuna do contrato com o AF-11): reserva em dia de salto.
  test('salto do horário de verão (America/New_York, 14/3/2027): 03:00 é aceito e 02:30 (inexistente) é recusado', async () => {
    await app.close();
    await setup('2027-03-10T16:00:00.000Z');
    await setBusinessTimezone(app, businessId, 'America/New_York');
    for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, ALL_WEEK)).statusCode, 200);
    // 02:00–03:00 não existe; 03:00 EDT = 07:00Z.
    const ok = await book(body({ start: '2027-03-14T03:00' }));
    assert.equal(ok.status, 201);
    assert.equal((await app.db.get('SELECT starts_at FROM appointments')).starts_at, '2027-03-14T07:00:00.000Z');
    const err = await fails(book(body({ professionalId: pb.id, start: '2027-03-14T02:30' })));
    assert.ok(err instanceof SlotUnavailableError, String(err));
    assert.equal(err.message, M.slotUnavailable);
    assert.equal(await countAppointments(app.db), 1);
  });
});

describe('"qualquer profissional" (critérios 12 a 14)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  // Cliente das linhas semeadas, diferente do que agenda (o limite de 3 futuros não interfere).
  const SEED = { name: 'Semente', phone: '(21) 98765-4321', email: 'semente@example.com' };
  const customerIdOf = async () => (await app.db.get('SELECT id FROM customers LIMIT 1')).id;
  async function seedBusy(professionalId, local, status = 'confirmed') {
    if ((await countCustomers(app.db)) === 0) await book(body({ start: '2026-11-30T17:00', professionalId: pb.id, customer: SEED }));
    await app.db.run('DELETE FROM appointments WHERE starts_at = ?', [localIso('2026-11-30T17:00')]);
    return insertAppointmentDirect(app.db, {
      businessId,
      professionalId,
      customerId: await customerIdOf(),
      serviceId: corte.id,
      startsAt: localIso(local),
      status,
    });
  }
  const chosen = async (over = {}) => {
    const result = await book(body({ professionalId: 'any', ...over }));
    return result.body.appointment.professional.name;
  };

  test('A com 2 no dia e B com 1: escolhe B', async () => {
    await seedBusy(pa.id, `${FRIDAY}T09:00`);
    await seedBusy(pa.id, `${FRIDAY}T15:00`);
    await seedBusy(pb.id, `${FRIDAY}T16:00`);
    assert.equal(await chosen(), 'Bia Lima');
  });

  test('contagens iguais: o menor name_key (Ana antes de Bia)', async () => {
    await seedBusy(pa.id, `${FRIDAY}T15:00`);
    await seedBusy(pb.id, `${FRIDAY}T16:00`);
    assert.equal(await chosen(), 'Ana Souza');
  });

  test('name_key igual: o menor id', async () => {
    const homonym = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
    assert.equal((await putHours(app, ana, homonym.id, WEEK_9_TO_18)).statusCode, 200);
    await seedBusy(pb.id, `${FRIDAY}T16:00`);
    await book(body({ professionalId: 'any' }));
    const row = await app.db.get('SELECT professional_id FROM appointments WHERE starts_at = ?', [localIso(`${FRIDAY}T10:00`)]);
    assert.equal(row.professional_id, [pa.id, homonym.id].sort()[0]);
  });

  test('cancelados e agendamentos de outro dia não contam', async () => {
    await seedBusy(pa.id, `${FRIDAY}T15:00`, 'cancelled');
    await seedBusy(pa.id, `${FRIDAY}T16:00`, 'cancelled');
    await seedBusy(pa.id, '2026-11-30T09:00');
    await seedBusy(pa.id, '2026-11-30T10:00');
    await seedBusy(pb.id, `${FRIDAY}T16:00`);
    assert.equal(await chosen(), 'Ana Souza');
  });

  test('só A livre: escolhe A mesmo com mais agendamentos; nenhum livre: SlotUnavailableError', async () => {
    await seedBusy(pa.id, `${FRIDAY}T15:00`);
    await seedBusy(pa.id, `${FRIDAY}T16:00`);
    await seedBusy(pb.id, `${FRIDAY}T10:00`);
    assert.equal(await chosen(), 'Ana Souza');
    const err = await fails(book(body({ professionalId: 'any' })));
    assert.ok(err instanceof SlotUnavailableError);
  });

  test('dia de 25 h (America/New_York, 7/11/2027): agendamento perto da meia-noite contado no dia local certo', async () => {
    await app.close();
    await setup('2027-11-03T16:00:00.000Z');
    await setBusinessTimezone(app, businessId, 'America/New_York');
    for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, ALL_WEEK)).statusCode, 200);
    await book(body({ professionalId: pb.id, start: '2027-11-09T10:00', customer: SEED }));
    await app.db.run('DELETE FROM appointments');
    const customerId = await customerIdOf();
    const direct = (professionalId, startsAt) =>
      insertAppointmentDirect(app.db, { businessId, professionalId, customerId, serviceId: corte.id, startsAt, durationMinutes: 15 });
    // A: domingo 7/11 às 23:30 EST (= 8/11 04:30Z), fora de "UTC" e fora de "meia-noite + 24 h".
    await direct(pa.id, '2027-11-08T04:30:00.000Z');
    // B: sábado 6/11 às 23:30 EDT (= 7/11 03:30Z), no dia UTC mas não no dia local.
    await direct(pb.id, '2027-11-07T03:30:00.000Z');
    assert.equal(await chosen({ start: '2027-11-07T10:00' }), 'Bia Lima');
  });

  test('dia de 23 h (America/New_York, 14/3/2027): agendamento das 23:30 conta no próprio dia', async () => {
    await app.close();
    await setup('2027-03-10T16:00:00.000Z');
    await setBusinessTimezone(app, businessId, 'America/New_York');
    for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, ALL_WEEK)).statusCode, 200);
    await book(body({ professionalId: pb.id, start: '2027-03-16T10:00', customer: SEED }));
    await app.db.run('DELETE FROM appointments');
    const customerId = await customerIdOf();
    // A: domingo 14/3 às 23:30 EDT (= 15/3 03:30Z). Com "meia-noite + 24 h" (05:00Z + 24 h = 15/3 05:00Z)
    // ainda contaria; com o dia UTC (14/3) não contaria. B: segunda 15/3 às 00:15 EDT (= 04:15Z), outro dia.
    await insertAppointmentDirect(app.db, { businessId, professionalId: pa.id, customerId, serviceId: corte.id, startsAt: '2027-03-15T03:30:00.000Z', durationMinutes: 15 });
    await insertAppointmentDirect(app.db, { businessId, professionalId: pb.id, customerId, serviceId: corte.id, startsAt: '2027-03-15T04:15:00.000Z', durationMinutes: 15 });
    assert.equal(await chosen({ start: '2027-03-14T10:00' }), 'Bia Lima');
  });
});

describe('limite por cliente (critério 42)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('3 futuros com o mesmo e-mail (maiúsculas e NFC) bloqueiam o 4º; mesma mensagem que o do telefone', async () => {
    const emails = ['JOSÉ@Example.com', ' josé@example.com', 'JOSÉ@EXAMPLE.COM'];
    const phones = ['11987654321', '11976543210', '11965432109'];
    for (const [i, start] of ['10:00', '13:00', '14:00'].entries()) {
      await book(body({ start: `${FRIDAY}T${start}`, customer: { email: emails[i], phone: phones[i] } }));
    }
    assert.equal(await countCustomers(app.db), 1);
    const byEmail = await fails(book(body({ start: `${FRIDAY}T15:00`, customer: { email: 'josé@example.com', phone: '11954321098' } })));
    assert.equal(byEmail.code, 'BOOKING_LIMIT_REACHED');
    assert.equal(byEmail.message, M.limitReached);

    for (const [i, start] of ['10:00', '13:00', '14:00'].entries()) {
      await book(body({ professionalId: pb.id, start: `${FRIDAY}T${start}`, customer: { email: `fone${i}@x.com`, phone: '(21) 97777-6666' } }));
    }
    const byPhone = await fails(book(body({ professionalId: pb.id, start: `${FRIDAY}T15:00`, customer: { email: 'fone9@x.com', phone: '21977776666' } })));
    assert.equal(byPhone.code, 'BOOKING_LIMIT_REACHED');
    assert.equal(byPhone.message, byEmail.message);
  });

  test('passado e cancelados não contam; o mesmo cliente no mesmo horário com outro profissional é aceito', async () => {
    const customer = { email: 'maria@x.com', phone: '11943210987' };
    const first = await book(body({ start: '2026-11-26T10:00', customer }));
    assert.equal(first.status, 201);
    await book(body({ professionalId: pb.id, start: '2026-11-26T10:00', customer })); // mãe e filha
    const id = (await app.db.get('SELECT id FROM appointments WHERE professional_id = ?', [pb.id])).id;
    await cancelDirect(app.db, id);
    await book(body({ start: `${FRIDAY}T13:00`, customer }));
    clock.advance(2 * 3_600_000); // 11:00: o agendamento das 10:00 de hoje virou passado
    await book(body({ start: `${FRIDAY}T14:00`, customer }));
    await book(body({ start: `${FRIDAY}T15:00`, customer }));
    const err = await fails(book(body({ start: `${FRIDAY}T16:00`, customer })));
    assert.equal(err.code, 'BOOKING_LIMIT_REACHED');
  });
});

describe('idempotência (critério 25)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());
  const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';

  test('mesma chave e mesmo corpo: o mesmo appointment (byte a byte), outro link (AF-12) e COUNT = 1; e-mail com maiúsculas e espaços conta como o mesmo', async () => {
    const b = body({ professionalId: 'any' });
    const first = await book(b, { idempotencyKey: KEY });
    const again = await book(b, { idempotencyKey: KEY.toUpperCase() });
    const variant = await book({ ...b, customer: { ...b.customer, email: `  ${b.customer.email.toUpperCase()} `, phone: '11912345678' } }, { idempotencyKey: KEY });
    assert.equal(JSON.stringify(again.body.appointment), JSON.stringify(first.body.appointment));
    assert.equal(JSON.stringify(variant.body.appointment), JSON.stringify(first.body.appointment));
    assert.equal(new Set([first, again, variant].map((r) => r.body.manage.url)).size, 3);
    assert.equal(await countAppointments(app.db), 1);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM booking_idempotency_keys')).n), 1);
    assert.equal((await app.db.get('SELECT idempotency_key FROM booking_idempotency_keys')).idempotency_key, KEY);
  });

  test('outro corpo com a mesma chave: 422 e nada é gravado', async () => {
    await book(body(), { idempotencyKey: KEY });
    const customers = await countCustomers(app.db);
    const err = await fails(book(body({ start: `${FRIDAY}T13:00` }), { idempotencyKey: KEY }));
    assert.ok(err instanceof IdempotencyKeyReusedError);
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await countAppointments(app.db), 1);
    assert.equal(await countCustomers(app.db), customers);
  });

  test('chave expirada (relógio + 24 h) é tratada como nova; a mesma chave em outro negócio é independente', async () => {
    const b = body({ professionalId: 'any' });
    await book(b, { idempotencyKey: KEY });
    clock.advance(24 * 3_600_000);
    const second = await book(b, { idempotencyKey: KEY });
    assert.equal(second.status, 201);
    assert.equal(await countAppointments(app.db), 2);

    const bia = await signupAndLogin(app, { email: 'bia@x.com', name: 'Bia' });
    const other = await createBusinessFor(app, bia, { name: 'Barbearia da Bia' });
    const barba = await createService(app, bia, { name: 'Barba', durationMinutes: 60 });
    const caio = await createProfessional(app, bia, { name: 'Caio', serviceIds: [barba.id] });
    assert.equal((await putHours(app, bia, caio.id, WEEK_9_TO_18)).statusCode, 200);
    const third = await buildService().book(other.slug, bookingBody({ serviceId: barba.id, professionalId: 'any', start: `${FRIDAY}T10:00` }), { idempotencyKey: KEY });
    assert.equal(third.status, 201);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM booking_idempotency_keys')).n), 2);
  });

  test('chave fora do formato (inclusive repetida "a, b"): 400 Requisição inválida, sem fields', async () => {
    for (const key of ['x', `${KEY}, ${KEY}`, '3b241101-e2bb-1255-8caf-4136c566a962']) {
      const err = await fails(book(body(), { idempotencyKey: key }));
      assert.ok(err instanceof ValidationError);
      assert.equal(err.message, M.badRequest);
      assert.equal(err.fields, undefined);
    }
    assert.equal(await countAppointments(app.db), 0);
  });

  test('purga no boot: remove as expiradas em lotes; uma falha não impede o boot', async () => {
    await book(body(), { idempotencyKey: KEY });
    const appointmentId = (await app.db.get('SELECT id FROM appointments')).id;
    await app.db.transaction(async (tx) => {
      for (let i = 0; i < 1200; i++) {
        await tx.run(
          `INSERT INTO booking_idempotency_keys VALUES (?, ?, ?, ?, '{}', '2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z')`,
          [businessId, randomUUID(), 'b'.repeat(64), appointmentId],
        );
      }
    });
    const calls = [];
    const repo = app.services.appointmentsRepository;
    const counted = {
      ...repo,
      purgeIdempotencyAll: (nowIso, options, conn) => {
        calls.push(nowIso);
        return repo.purgeIdempotencyAll(nowIso, options, conn);
      },
    };
    const log = recordingLog();
    assert.equal(await buildService({ appointmentsRepository: counted, log }).purgeExpiredIdempotencyKeys(), 1200);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM booking_idempotency_keys')).n), 1);
    assert.ok(log.entries.some((e) => e.event === 'booking_idempotency_purged' && e.count === 1200));
    assert.equal(await repo.purgeIdempotencyAll('2026-11-26T12:00:00.000Z', { batch: 1 }), 0);

    const failing = buildService({
      appointmentsRepository: { ...repo, purgeIdempotencyAll: async () => { throw Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }); } },
      log,
    });
    assert.equal(await failing.purgeExpiredIdempotencyKeys(), 0);
    assert.ok(log.entries.some((e) => e.event === 'booking_idempotency_purge_failed' && e.errCode === 'SQLITE_BUSY'));
  });
});

describe('só a transação (critério 24) e o mesmo caminho para cliente novo e antigo (critério 40)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  const withTimeout = (promise, ms = 2000) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('travou')), ms))]);

  test('a reserva conclui sem usar o db global dentro da transação, em menos de 2 s, nos dois modos', async () => {
    const { idb, service } = instrumentedService();
    const specific = await withTimeout(service.book(SLUG, body(), { idempotencyKey: randomUUID() }));
    assert.equal(specific.status, 201);
    const any = await withTimeout(service.book(SLUG, body({ professionalId: 'any', start: `${FRIDAY}T13:00` })));
    assert.equal(any.status, 201);
    assert.ok(idb.calls.some((c) => c.inTx));
    // 409 também: as sugestões são calculadas fora da transação.
    const err = await withTimeout(fails(service.book(SLUG, body())));
    assert.ok(err instanceof SlotUnavailableError);
    assert.ok(err.suggestions.length > 0);
  });

  test('a sequência de SQL de cliente novo e de cliente antigo é idêntica, e as chaves das respostas são iguais', async () => {
    const { idb, service } = instrumentedService();
    const returning = { email: 'volta@x.com', phone: '11912340000', name: 'Cliente Antigo' };
    await service.book(SLUG, body({ start: `${FRIDAY}T09:00`, customer: returning }));
    idb.reset();
    const old = await service.book(SLUG, body({ start: `${FRIDAY}T10:00`, customer: returning }));
    const oldSql = idb.sqlOf();
    idb.reset();
    const fresh = await service.book(SLUG, body({ professionalId: pb.id, start: `${FRIDAY}T10:00`, customer: { email: 'novo@x.com' } }));
    const freshSql = idb.sqlOf();
    assert.deepEqual(freshSql, oldSql);
    assert.ok(oldSql.some((sql) => /INSERT INTO customers .* ON CONFLICT \(business_id, email\) DO NOTHING/.test(sql)));
    assert.ok(oldSql.some((sql) => /SELECT id FROM customers WHERE business_id = \? AND email = \?/.test(sql)));
    const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).map((k) => [k, keysOf(o[k])]) : null);
    assert.deepEqual(keysOf(old.body), keysOf(fresh.body));
    assert.deepEqual(Object.keys(old.body.appointment), PUBLIC_APPOINTMENT_FIELDS.appointment);
  });
});

describe('ordem das travas (critério 23)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  const isProfessionalLock = (c) => /^UPDATE professionals SET updated_at = updated_at WHERE id = \?/.test(String(c.sql).replace(/\s+/g, ' ').trim());
  const isServiceLock = (c) => /^UPDATE services SET/.test(String(c.sql).replace(/\s+/g, ' ').trim());
  const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  test('claimManyForBooking trava em ordem crescente de id, sem repetir, mesmo com os ids fora de ordem; removido não entra no conjunto', async () => {
    const pc = await createProfessional(app, ana, { name: 'Caio Reis', serviceIds: [corte.id] });
    const removed = await createProfessional(app, ana, { name: 'Removido', serviceIds: [corte.id] });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${removed.id}`, cookies: ana })).statusCode, 204);
    const ids = [pa.id, pb.id, pc.id, removed.id];
    const ascending = [...ids].sort(byCode);
    const idb = instrumentDb(app.db);
    const repo = createProfessionalsRepository(idb);
    for (const input of [[...ascending].reverse(), [ascending[2], ascending[0], ascending[3], ascending[1], ascending[0]]]) {
      idb.reset();
      const claimed = await idb.transaction((tx) => repo.claimManyForBooking(input, businessId, tx));
      const locked = idb.calls.filter(isProfessionalLock);
      assert.deepEqual(locked.map((c) => c.params[0]), ascending, 'UPDATE professionals em ordem crescente de id');
      assert.ok(locked.every((c) => c.inTx && c.params[1] === businessId));
      assert.deepEqual([...claimed].sort(byCode), [pa.id, pb.id, pc.id].sort(byCode));
    }
    await assert.rejects(
      idb.transaction((tx) => repo.claimManyForBooking(Array.from({ length: 51 }, () => randomUUID()), businessId, tx)),
      RangeError,
    );
  });

  test('reserva em "qualquer": trava o serviço e depois os profissionais em ordem de id, não na ordem de nome', async () => {
    const pc = await createProfessional(app, ana, { name: 'Caio Reis', serviceIds: [corte.id] });
    assert.equal((await putHours(app, ana, pc.id, WEEK_9_TO_18)).statusCode, 200);
    // Nomes na ordem inversa dos ids: a lista de elegíveis (por name_key) chega fora da ordem de id.
    const ascending = [pa.id, pb.id, pc.id].sort(byCode);
    for (const [i, id] of [...ascending].reverse().entries()) {
      const res = await app.inject({ method: 'PATCH', url: `/api/professionals/${id}`, cookies: ana, payload: { name: `Nome ${'ABC'[i]}` } });
      assert.equal(res.statusCode, 200, res.body);
    }
    const listed = await app.services.professionalsRepository.findListedByBusinessId(businessId);
    assert.notDeepEqual(listed.map((p) => p.id), ascending, 'a ordem de nome difere da ordem de id');

    const { idb, service } = instrumentedService();
    assert.equal((await service.book(SLUG, body({ professionalId: 'any' }))).status, 201);
    const inTx = idb.calls.filter((c) => c.inTx);
    const serviceAt = inTx.findIndex(isServiceLock);
    const professionalLocks = inTx.map((c, i) => [c, i]).filter(([c]) => isProfessionalLock(c));
    assert.ok(serviceAt >= 0, 'trava do serviço');
    assert.ok(professionalLocks.every(([, i]) => i > serviceAt), 'serviço antes dos profissionais');
    assert.deepEqual(professionalLocks.map(([c]) => c.params[0]), ascending);
    assert.equal(inTx.some((c) => /^UPDATE businesses/.test(String(c.sql).trim())), false, 'a reserva não trava businesses');

    // Específico: só o escolhido.
    idb.reset();
    assert.equal((await service.book(SLUG, body({ professionalId: ascending[2], start: `${FRIDAY}T13:00` }))).status, 201);
    assert.deepEqual(idb.calls.filter(isProfessionalLock).map((c) => c.params[0]), [ascending[2]]);
  });
});

describe('eventos pós-commit (critério 44)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test('a porta recebe só { appointmentId, businessId, manageUrl }, depois do COMMIT (a linha já é visível)', async () => {
    const received = [];
    const service = buildService({
      appointmentEvents: {
        async confirmed(event) {
          const row = await app.db.get('SELECT id, status FROM appointments WHERE id = ?', [event.appointmentId]);
          received.push({ event, row });
        },
      },
    });
    await book(body(), {}, service);
    await tick();
    await tick();
    assert.equal(received.length, 1);
    assert.deepEqual(Object.keys(received[0].event).sort(), ['appointmentId', 'businessId', 'manageUrl']);
    assert.equal(received[0].event.businessId, businessId);
    assert.equal(received[0].row.status, 'confirmed');
  });

  test('porta que lança (síncrona e assíncrona) ou nunca resolve não muda o 201 nem desfaz; gera appointment_event_failed', async () => {
    const ports = [
      { confirmed() { throw Object.assign(new Error('sync'), { code: 'ESYNC' }); } },
      { confirmed: async () => { throw Object.assign(new Error('async'), { code: 'EASYNC' }); } },
      { confirmed: () => new Promise(() => {}) },
    ];
    const log = recordingLog();
    for (const [i, appointmentEvents] of ports.entries()) {
      const result = await book(body({ start: `${FRIDAY}T${['10:00', '13:00', '14:00'][i]}` }), {}, buildService({ appointmentEvents, log }));
      assert.equal(result.status, 201);
    }
    await tick();
    await tick();
    assert.equal(await countAppointments(app.db, { status: 'confirmed' }), 3);
    const failed = log.entries.filter((e) => e.event === 'appointment_event_failed');
    assert.deepEqual(failed.map((e) => e.errCode).sort(), ['EASYNC', 'ESYNC']);
    assert.ok(failed.every((e) => e.level === 'warn' && typeof e.appointmentId === 'string'));
  });

  test('nada é chamado em 409, 422 e replay', async () => {
    let calls = 0;
    const service = buildService({ appointmentEvents: { confirmed: async () => { calls += 1; } } });
    const key = randomUUID();
    await book(body(), { idempotencyKey: key }, service);
    await tick();
    assert.equal(calls, 1);
    await book(body(), { idempotencyKey: key }, service).catch(() => {});
    await fails(book(body({ start: `${FRIDAY}T13:00` }), { idempotencyKey: key }, service));
    await fails(book(body(), {}, service));
    await tick();
    assert.equal(calls, 1);
  });
});

describe('503 BOOKING_UNAVAILABLE (critério 43)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('porta de ocupados que lança e repositório com SQLITE_BUSY: 503, nada gravado, log com errCode/errName', async () => {
    const log = recordingLog();
    const busyPort = { ...app.services.appointments, findBusyByBusiness: async () => { throw Object.assign(new Error('fora'), { code: 'EPORT' }); } };
    const e1 = await fails(book(body(), {}, buildService({ appointments: busyPort, log })));
    assert.ok(e1 instanceof ServiceUnavailableError);
    assert.equal(e1.code, 'BOOKING_UNAVAILABLE');
    assert.equal(e1.message, M.unavailable);
    const repo = app.services.appointmentsRepository;
    const busyRepo = { ...repo, countFutureForCustomer: async () => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); } };
    const e2 = await fails(book(body(), {}, buildService({ appointmentsRepository: busyRepo, log })));
    assert.equal(e2.code, 'BOOKING_UNAVAILABLE');
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(await countCustomers(app.db), 0);
    const failed = log.entries.filter((e) => e.event === 'appointment_booking_failed');
    assert.deepEqual(failed.map((e) => e.errCode), ['EPORT', 'ERR_SQLITE_ERROR']);
    assert.ok(failed.every((e) => e.errName === 'Error'));
  });

  test('404 e 400 passam como estão', async () => {
    assert.ok((await fails(buildService().book('nao-existe', body()))) instanceof NotFoundError);
    assert.ok((await fails(book({ ...body(), start: 'x' }))) instanceof ValidationError);
  });
});

describe('sugestões (critério 16)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());
  const starts = (err) => err.suggestions.map((s) => s.start);

  test('com 10:00–11:00 ocupado (serviço de 60 min, almoço 12–13): 11:00, 13:00 e 13:15, só start e end', async () => {
    await book(body());
    const err = await fails(book(body()));
    assert.deepEqual(err.suggestions, [
      { start: `${FRIDAY}T11:00`, end: `${FRIDAY}T12:00` },
      { start: `${FRIDAY}T13:00`, end: `${FRIDAY}T14:00` },
      { start: `${FRIDAY}T13:15`, end: `${FRIDAY}T14:15` },
    ]);
  });

  test('com o resto do dia ocupado, vêm do próximo dia útil', async () => {
    assert.equal((await postTimeBlock(app, ana, { professionalId: pa.id, start: `${FRIDAY}T10:00`, end: `${FRIDAY}T18:00` })).statusCode, 201);
    const err = await fails(book(body()));
    assert.deepEqual(starts(err), ['2026-11-30T09:00', '2026-11-30T09:15', '2026-11-30T09:30']);
  });

  test('com 14 dias ocupados: []', async () => {
    assert.equal((await postTimeBlock(app, ana, { professionalId: pa.id, start: `${FRIDAY}T00:00`, end: '2026-12-11T00:00' })).statusCode, 201);
    const err = await fails(book(body()));
    assert.deepEqual(err.suggestions, []);
    // O 15º dia (11/12) fica de fora da janela.
    assert.equal(err.message, M.slotUnavailable);
  });

  test('nunca passam de hoje + 90', async () => {
    await book(body({ start: '2027-02-24T17:00' }));
    const err = await fails(book(body({ start: '2027-02-24T17:00' })));
    assert.deepEqual(err.suggestions, []);
  });

  test('em "qualquer", um início livre para A ou B aparece uma vez', async () => {
    await book(body({ professionalId: pa.id }));
    await book(body({ professionalId: pb.id }));
    const err = await fails(book(body({ professionalId: 'any' })));
    assert.deepEqual(starts(err), [`${FRIDAY}T11:00`, `${FRIDAY}T13:00`, `${FRIDAY}T13:15`]);
  });

  test('uma porta que falha só no cálculo das sugestões dá 409 com []', async () => {
    await book(body());
    const s = app.services;
    const log = recordingLog();
    const availabilityService = createAvailabilityService({
      businessesRepository: s.businessesRepository,
      servicesRepository: s.servicesRepository,
      professionalsRepository: s.professionalsRepository,
      workingHoursRepository: s.workingHoursRepository,
      timeBlocksRepository: s.timeBlocksRepository,
      appointments: fakeAppointments({ throws: Object.assign(new Error('x'), { code: 'EX' }) }),
      now: clock.now,
      log,
    });
    const err = await fails(book(body(), {}, buildService({ availabilityService })));
    assert.ok(err instanceof SlotUnavailableError);
    assert.deepEqual(err.suggestions, []);
    assert.ok(log.entries.some((e) => e.event === 'appointment_suggestions_failed' && e.level === 'warn'));
  });
});

describe('logs (critério 38)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());

  test('criação, reaproveitamento, 400, 409, 422 e 503 não escrevem nome, telefone nem e-mail', async () => {
    const secret = { name: 'Zuleica Secreta', phone: '(31) 98765-4321', email: 'zuleica.secreta@exemplo.com' };
    const post = (b, headers = {}) =>
      app.inject({ method: 'POST', url: `/api/public/${SLUG}/appointments`, headers: { 'sec-fetch-site': 'same-origin', ...headers }, payload: b });
    const key = randomUUID();
    assert.equal((await post(body({ customer: secret }), { 'idempotency-key': key })).statusCode, 201);
    assert.equal((await post(body({ customer: secret }), { 'idempotency-key': key })).statusCode, 201); // replay
    assert.equal((await post(body({ start: `${FRIDAY}T13:00`, customer: secret }))).statusCode, 201); // reaproveita
    assert.equal((await post(body({ customer: { ...secret, phone: '123' } }))).statusCode, 400);
    assert.equal((await post(body({ customer: secret }))).statusCode, 409);
    assert.equal((await post(body({ start: `${FRIDAY}T14:00`, customer: secret }), { 'idempotency-key': key })).statusCode, 422);
    const original = app.services.appointmentsService;
    app.services.appointmentsService = buildService({
      log: app.log,
      appointments: { ...app.services.appointments, findBusyByBusiness: async () => { throw new Error('fora'); } },
    });
    try {
      assert.equal((await post(body({ start: `${FRIDAY}T15:00`, customer: secret }))).statusCode, 503);
    } finally {
      app.services.appointmentsService = original;
    }
    // Um log de propósito com o retorno de findOrCreate e a entrada: redigidos.
    app.log.debug({ event: 'teste_redact', snapshot: { name: secret.name }, input: secret, body: { customer: secret } });
    const text = logs();
    for (const word of [secret.name, secret.email, '98765-4321', '31987654321', 'Zuleica', key]) {
      assert.equal(text.includes(word), false, word);
    }
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const created = lines.filter((l) => l.event === 'appointment_created');
    assert.equal(created.length, 2);
    for (const entry of created) {
      const own = Object.keys(entry).filter((k) => !['level', 'time', 'pid', 'hostname', 'reqId', 'msg'].includes(k));
      assert.deepEqual(own.sort(), ['appointmentId', 'businessId', 'durationMinutes', 'event', 'professionalId', 'target']);
    }
    assert.ok(lines.some((l) => l.event === 'appointment_replayed'));
    assert.ok(lines.some((l) => l.event === 'appointment_slot_taken' && l.suggestionsCount === 3 && l.target === 'professional'));
    assert.ok(lines.some((l) => l.event === 'appointment_booking_failed' && l.errName === 'Error'));
    const redacted = lines.find((l) => l.event === 'teste_redact');
    assert.equal(redacted.snapshot, '[REDACTED]');
    assert.equal(redacted.input, '[REDACTED]');
  });
});

describe('AF-12: link de gerenciar na reserva (critérios 8, 9 e 27)', () => {
  beforeEach(() => setup());
  afterEach(() => app.close());
  const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';
  const URL_RE = /^https:\/\/agendafacil\.app\/agendamento\/([A-Za-z0-9_-]{43})$/;
  const tokenOf = (url) => URL_RE.exec(url)?.[1];
  const sha = (t) => createHash('sha256').update(t).digest('hex');

  test('201 com manage.url no formato, para cliente novo e antigo; token com hash e expires_at = ends_at; corpo guardado sem manage', async () => {
    const customer = { email: 'carla@example.com', name: 'Carla Dias' };
    const first = await book(body({ customer }), { idempotencyKey: KEY });
    const second = await book(body({ customer, start: `${FRIDAY}T13:00` }));
    for (const res of [first, second]) {
      assert.match(res.body.manage.url, URL_RE);
      assert.equal(res.body.manage.cancellationLeadMinutes, 120);
      const token = tokenOf(res.body.manage.url);
      const row = await app.db.get(
        'SELECT t.*, a.ends_at FROM appointment_manage_tokens t JOIN appointments a ON a.id = t.appointment_id WHERE t.token_hash = ?',
        [sha(token)],
      );
      assert.ok(row, 'linha do token pelo hash');
      assert.equal(row.expires_at, row.ends_at);
      assert.equal(row.revoked_at, null);
    }
    const stored = (await app.db.get('SELECT response_body FROM booking_idempotency_keys')).response_body;
    assert.deepEqual(Object.keys(JSON.parse(stored)), ['appointment']);
    assert.equal(stored.includes(tokenOf(first.body.manage.url)), false);
    assert.equal(stored.includes('agendamento/'), false);
  });

  test('repetição depois de cancelar devolve um link que mostra cancelled; depois de ends_at dá manage: null', async () => {
    const b0 = body();
    const first = await book(b0, { idempotencyKey: KEY });
    const manage = app.services.manageService;
    const token = tokenOf(first.body.manage.url);
    const version = (await manage.get(token)).body.change.version;
    assert.equal((await manage.cancel(token, { version })).status, 200);
    const replay = await book(b0, { idempotencyKey: KEY });
    assert.notEqual(replay.body.manage.url, first.body.manage.url);
    assert.equal((await manage.get(tokenOf(replay.body.manage.url))).body.appointment.status, 'cancelled');
    assert.equal(JSON.stringify(replay.body.appointment), JSON.stringify(first.body.appointment));

    // Hoje às 10:00 (1 h de antecedência): termina às 14:00Z, antes de a chave vencer.
    const key2 = 'a3b0e8c4-6f2d-4f1a-9c3e-2b7d5e8f9a10';
    const b = body({ start: '2026-11-26T10:00' });
    assert.ok((await book(b, { idempotencyKey: key2 })).body.manage);
    clock.advance(2 * 60 * 60 * 1000 + 1000);
    const late = await book(b, { idempotencyKey: key2 });
    assert.equal(late.status, 201);
    assert.equal(late.body.manage, null);
  });

  test('QA D2: repetição depois de remarcar emite link do agendamento atual da cadeia; cadeia cancelada aponta para o último', async () => {
    const b0 = body();
    const first = await book(b0, { idempotencyKey: KEY });
    const manage = app.services.manageService;
    const original = tokenOf(first.body.manage.url);
    const reschedule = async (start) => {
      const version = (await manage.get(original)).body.change.version;
      assert.equal((await manage.reschedule(original, { start, version })).status, 200);
    };
    await reschedule(`${FRIDAY}T14:00`);
    const replay = await book(b0, { idempotencyKey: KEY });
    const fresh = tokenOf(replay.body.manage.url);
    const view = (await manage.get(fresh)).body;
    assert.equal(view.appointment.start, `${FRIDAY}T14:00`);
    assert.equal(view.appointment.status, 'confirmed');
    assert.deepEqual((await manage.get(fresh)).body, (await manage.get(original)).body);
    // O corpo da repetição continua o appointment original (contrato do AF-11).
    assert.equal(JSON.stringify(replay.body.appointment), JSON.stringify(first.body.appointment));
    // A linha do token novo aponta para o agendamento ativo, com o expires_at dele.
    const row = await app.db.get(
      'SELECT t.expires_at, a.ends_at, a.status FROM appointment_manage_tokens t JOIN appointments a ON a.id = t.appointment_id WHERE t.token_hash = ?',
      [sha(fresh)],
    );
    assert.deepEqual({ ...row }, { expires_at: row.ends_at, ends_at: row.ends_at, status: 'confirmed' });

    // Mais dois elos e o cancelamento no fim: a repetição aponta para o último, cancelado.
    await reschedule(`${FRIDAY}T15:00`);
    await reschedule(`${FRIDAY}T16:00`);
    const version = (await manage.get(original)).body.change.version;
    assert.equal((await manage.cancel(original, { version })).status, 200);
    const late = await book(b0, { idempotencyKey: KEY });
    const lateView = (await manage.get(tokenOf(late.body.manage.url))).body;
    assert.equal(lateView.appointment.start, `${FRIDAY}T16:00`);
    assert.equal(lateView.appointment.status, 'cancelled');
  });

  test('bookSlot com customerId e customerSnapshot grava o snapshot dado e não chama findOrCreate; os dois modos ou nenhum: TypeError', async () => {
    const business = await app.db.get('SELECT id, timezone FROM businesses');
    await book(body());
    const { customer_id: customerId } = await app.db.get('SELECT customer_id FROM appointments');
    let calls = 0;
    const s = app.services;
    const customersService = {
      ...s.customersService,
      async findOrCreate(...args) {
        calls += 1;
        return s.customersService.findOrCreate(...args);
      },
    };
    const service = buildService({ customersService });
    const base = { business, serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T13:00`, nowMs: Date.parse(NOW) };
    const booked = await app.db.transaction((tx) =>
      service.bookSlot(tx, { ...base, customerId, customerSnapshot: { name: 'Nome Antigo', phone: '11987654321' } }),
    );
    assert.equal(calls, 0);
    const row = await app.db.get('SELECT customer_id, customer_name, customer_phone FROM appointments WHERE id = ?', [booked.appointmentId]);
    assert.deepEqual({ ...row }, { customer_id: customerId, customer_name: 'Nome Antigo', customer_phone: '11987654321' });

    const total = await countAppointments(app.db);
    const customerInput = body().customer;
    for (const args of [
      { ...base, start: `${FRIDAY}T14:00` },
      { ...base, start: `${FRIDAY}T14:00`, customerInput, customerId, customerSnapshot: { name: 'x', phone: '11987654321' } },
      { ...base, start: `${FRIDAY}T14:00`, customerId },
      { ...base, start: `${FRIDAY}T14:00`, customerId, customerSnapshot: { name: 'x' } },
    ]) {
      await assert.rejects(app.db.transaction((tx) => service.bookSlot(tx, args)), TypeError);
    }
    assert.equal(await countAppointments(app.db), total);
    assert.equal(calls, 0);
  });

  test('lockForBooking repetido na mesma tx é idempotente e devolve os mesmos elegíveis', async () => {
    const business = await app.db.get('SELECT id, timezone FROM businesses');
    const service = buildService();
    const [first, second] = await app.db.transaction(async (tx) => [
      await service.lockForBooking(tx, { business, serviceId: corte.id, professionalId: 'any' }),
      await service.lockForBooking(tx, { business, serviceId: corte.id, professionalId: 'any' }),
    ]);
    assert.deepEqual(second.eligible.map((p) => p.id), first.eligible.map((p) => p.id));
    assert.deepEqual(first.eligible.map((p) => p.id).sort(), [pa.id, pb.id].sort());
    assert.deepEqual(second.service, first.service);
    const one = await app.db.transaction(async (tx) => {
      await service.lockForBooking(tx, { business, serviceId: corte.id, professionalId: pa.id });
      return service.lockForBooking(tx, { business, serviceId: corte.id, professionalId: pa.id });
    });
    assert.deepEqual(one.eligible.map((p) => p.id), [pa.id]);
  });
});
