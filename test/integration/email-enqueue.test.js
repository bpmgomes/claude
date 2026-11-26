// AF-18 (critérios 3, 4 e 5): o e-mail nasce NA transação de reservar, cancelar e remarcar;
// ROLLBACK não deixa linha; repetições e erros não enfileiram; queda depois do COMMIT não perde nada.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows, countOutbox, drain, logEntries } from '../helpers/email.js';
import { bookingBody, postAppointment, countAppointments } from '../helpers/appointments.js';
import { bookWithLink, cancelManage, rescheduleManage, versionOf, tokensOf } from '../helpers/manage.js';
import { instrumentDb } from '../helpers/instrumented-db.js';
import { createAppointmentsService } from '../../src/modules/appointments/appointments.service.js';
import { createManageService } from '../../src/modules/appointments/manage.service.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { ServiceUnavailableError } from '../../src/http/errors.js';

let app;
let logs;
let clock;
let seed;

const body = (over = {}) => bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start: `${FRIDAY}T10:00`, ...over });
const reserve = (over = {}, opts) => bookWithLink(app, seed.slug, body(over), opts);
const fails = (promise) => promise.then((v) => assert.fail(`esperava erro: ${JSON.stringify(v)}`), (e) => e);

function buildService(db, extra = {}) {
  const s = app.services;
  return createAppointmentsService({
    db,
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
    reschedulesRepository: s.reschedulesRepository,
    publicBaseUrl: 'https://agendafacil.app',
    now: clock.now,
    ...extra,
  });
}

function buildManage(db, extra = {}) {
  const s = app.services;
  return createManageService({
    db,
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

const throwingEnqueue = async () => {
  throw Object.assign(new Error('fila indisponível'), { code: 'EQUEUE' });
};

beforeEach(async () => {
  ({ app, logs, clock } = await emailTestApp());
  seed = await seedBusiness(app);
});
afterEach(() => app.close());

describe('COMMIT deixa exatamente uma linha (critério 3 (b))', () => {
  test('reserva, cancelamento e remarcação, com kind e ids certos', async () => {
    const r1 = await reserve();
    let rows = await outboxRows(app.db);
    assert.equal(rows.length, 1);
    const a1 = rows[0].appointment_id;
    assert.equal(rows[0].kind, 'appointment_confirmed');
    assert.equal(rows[0].business_id, seed.business.id);
    assert.equal(rows[0].previous_appointment_id, null);
    assert.equal(rows[0].status, 'pending');

    const r2 = await reserve({ start: `${FRIDAY}T13:00` });
    const a2 = (await outboxRows(app.db))[1].appointment_id;
    assert.equal((await cancelManage(app, r1.token, { version: await versionOf(app, r1.token) })).statusCode, 200);
    rows = await outboxRows(app.db, { kind: 'appointment_cancelled' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].appointment_id, a1);

    const res = await rescheduleManage(app, r2.token, { start: `${FRIDAY}T15:00`, version: await versionOf(app, r2.token) });
    assert.equal(res.statusCode, 200);
    rows = await outboxRows(app.db, { kind: 'appointment_rescheduled' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].previous_appointment_id, a2);
    const novo = await app.db.get('SELECT appointment_id FROM appointment_reschedules WHERE previous_appointment_id = ?', [a2]);
    assert.equal(rows[0].appointment_id, novo.appointment_id);
    assert.equal(await countOutbox(app.db), 4);

    // email_enqueued depois do COMMIT, só com outboxId e kind.
    const enq = logEntries(logs).filter((e) => e.event === 'email_enqueued');
    assert.deepEqual(enq.map((e) => e.kind), ['appointment_confirmed', 'appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled']);
    for (const e of enq) {
      const own = Object.keys(e).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k));
      assert.deepEqual(own.sort(), ['event', 'kind', 'outboxId']);
    }
  });
});

describe('ROLLBACK não deixa linha (critério 3 (a))', () => {
  test('409 SLOT_UNAVAILABLE, APPOINTMENT_CHANGED, APPOINTMENT_NOT_CHANGEABLE e RESCHEDULE_LIMIT_REACHED', async () => {
    const r1 = await reserve();
    const before = await countOutbox(app.db);
    assert.equal((await postAppointment(app, seed.slug, body())).statusCode, 409, 'slot ocupado');
    assert.equal((await cancelManage(app, r1.token, { version: 'v'.repeat(43) })).json().error.code, 'APPOINTMENT_CHANGED');
    assert.equal(await countOutbox(app.db), before);

    // Cadeia com 3 remarcações: a 4ª é recusada.
    let version = await versionOf(app, r1.token);
    for (const start of ['11:00', '14:00', '15:00']) {
      const res = await rescheduleManage(app, r1.token, { start: `${FRIDAY}T${start}`, version });
      assert.equal(res.statusCode, 200, res.body);
      version = res.json().change.version;
    }
    const afterChain = await countOutbox(app.db);
    assert.equal(afterChain, before + 3);
    const limit = await rescheduleManage(app, r1.token, { start: `${FRIDAY}T16:00`, version });
    assert.equal(limit.json().error.code, 'RESCHEDULE_LIMIT_REACHED');
    // Remarcação para horário ocupado: 409 SLOT_UNAVAILABLE.
    const r2 = await reserve({ start: `${FRIDAY}T17:00` });
    const busy = await rescheduleManage(app, r2.token, { start: `${FRIDAY}T15:00`, version: await versionOf(app, r2.token) });
    assert.equal(busy.json().error.code, 'SLOT_UNAVAILABLE');
    // Fora do prazo (2 h antes): APPOINTMENT_NOT_CHANGEABLE.
    const countBefore = await countOutbox(app.db);
    const v2 = await versionOf(app, r2.token);
    clock.advance(Date.parse(`${FRIDAY}T19:30:00.000Z`) - clock.now().getTime());
    assert.equal((await cancelManage(app, r2.token, { version: v2 })).json().error.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal(await countOutbox(app.db), countBefore);
  });

  test('enqueueEmail que lança: 503 sem agendamento, sem token e sem linha (reserva, cancelamento e remarcação)', async () => {
    const service = buildService(app.db, { enqueueEmail: throwingEnqueue });
    const err = await fails(service.book(seed.slug, body()));
    assert.ok(err instanceof ServiceUnavailableError);
    assert.equal(await countAppointments(app.db), 0);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_manage_tokens')).n), 0);
    assert.equal(await countOutbox(app.db), 0);

    const r = await reserve();
    const manage = buildManage(app.db, { enqueueEmail: throwingEnqueue });
    const version = await versionOf(app, r.token);
    assert.ok((await fails(manage.cancel(r.token, { version }))) instanceof ServiceUnavailableError);
    assert.ok((await fails(manage.reschedule(r.token, { start: `${FRIDAY}T15:00`, version }))) instanceof ServiceUnavailableError);
    assert.equal(await countAppointments(app.db, { status: 'confirmed' }), 1);
    assert.equal(await countAppointments(app.db), 1);
    assert.equal(await countOutbox(app.db), 1, 'só a da reserva');
  });

  test('bookSlot que lança e moveToAppointment com changes 0 na remarcação: nada gravado', async () => {
    const r = await reserve();
    const before = await countOutbox(app.db);
    const version = await versionOf(app, r.token);
    const brokenBook = buildManage(app.db, {
      appointmentsService: { ...app.services.appointmentsService, bookSlot: async () => { throw Object.assign(new Error('x'), { code: 'EBOOK' }); } },
    });
    assert.ok((await fails(brokenBook.reschedule(r.token, { start: `${FRIDAY}T15:00`, version }))) instanceof ServiceUnavailableError);
    const noMove = buildManage(app.db, {
      manageTokensRepository: { ...app.services.manageTokensRepository, moveToAppointment: async () => ({ changes: 0 }) },
    });
    const e2 = await fails(noMove.reschedule(r.token, { start: `${FRIDAY}T15:00`, version }));
    assert.equal(e2.code, 'APPOINTMENT_NOT_CHANGEABLE');
    assert.equal(await countOutbox(app.db), before);
    assert.equal(await countAppointments(app.db), 1);
  });
});

describe('sem enfileirar (critério 4)', () => {
  test('replay da Idempotency-Key, duplo clique, cancelamento repetido, nada muda, 400/404/409', async () => {
    const key = randomUUID();
    const b = body();
    const first = await postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } });
    assert.equal(first.statusCode, 201);
    const [again, clickTwice] = await Promise.all([
      postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } }),
      postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } }),
    ]);
    assert.equal(again.statusCode, 201);
    assert.equal(clickTwice.statusCode, 201);
    assert.equal(await countOutbox(app.db), 1);

    const token = first.json().manage.url.split('/').pop();
    const version = await versionOf(app, token);
    const noop = await rescheduleManage(app, token, { start: `${FRIDAY}T10:00`, version });
    assert.equal(noop.statusCode, 200);
    assert.equal(await countOutbox(app.db), 1, 'nada muda');

    assert.equal((await cancelManage(app, token, { version })).statusCode, 200);
    assert.equal(await countOutbox(app.db), 2);
    assert.equal((await cancelManage(app, token, { version })).statusCode, 200, 'repetição com a versão antiga');
    assert.equal((await cancelManage(app, token, { version: await versionOf(app, token) })).statusCode, 200, 'repetição com a atual');
    assert.equal(await countOutbox(app.db), 2);

    assert.equal((await postAppointment(app, seed.slug, { ...body(), start: 'x' })).statusCode, 400);
    assert.equal((await postAppointment(app, 'nao-existe', body())).statusCode, 404);
    assert.equal((await postAppointment(app, seed.slug, b, { headers: { 'idempotency-key': key } })).statusCode, 201);
    assert.equal((await postAppointment(app, seed.slug, body({ start: `${FRIDAY}T13:00` }), { headers: { 'idempotency-key': key } })).statusCode, 422);
    assert.equal(await countOutbox(app.db), 2);
    // A repetição idempotente não enfileira, mas emite token (até o teto).
    assert.ok((await tokensOf(app.db, (await outboxRows(app.db))[0].appointment_id)).length >= 1);
  });
});

describe('só tx (critério 3, AF-11 critério 24)', () => {
  test('com o banco instrumentado, os três fluxos terminam e o INSERT da fila é feito na transação', async () => {
    const idb = instrumentDb(app.db);
    const service = buildService(idb);
    const res = await service.book(seed.slug, body());
    assert.equal(res.status, 201);
    const token = res.body.manage.url.split('/').pop();
    const r2 = await service.book(seed.slug, body({ start: `${FRIDAY}T13:00` }));
    const token2 = r2.body.manage.url.split('/').pop();
    const manage = buildManage(idb);
    await manage.reschedule(token2, { start: `${FRIDAY}T15:00`, version: await versionOf(app, token2) });
    await manage.cancel(token, { version: await versionOf(app, token) });
    const inserts = idb.calls.filter((c) => /INSERT INTO email_outbox/.test(c.sql));
    assert.equal(inserts.length, 4);
    assert.ok(inserts.every((c) => c.inTx));
  });
});

describe('queda depois do COMMIT (critério 3 (c))', () => {
  test('app A reserva com porta que lança e cai; app B no mesmo arquivo envia no próximo ciclo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af18-queda-'));
    const databasePath = join(dir, 'db.sqlite');
    try {
      const a = await emailTestApp({
        databasePath,
        appointmentEvents: { confirmed() { throw new Error('processo caiu'); } },
      });
      app = a.app;
      seed = await seedBusiness(a.app);
      await bookWithLink(a.app, seed.slug, body());
      assert.equal(a.transport.messages.length, 0, 'sem worker em A');
      await a.app.close();

      const transport = createMemoryMailTransport();
      const b = await emailTestApp({ databasePath, mailTransport: transport });
      app = b.app;
      assert.equal((await outboxRows(b.app.db))[0].status, 'pending');
      await drain(b.app);
      assert.equal(transport.messages.length, 1);
      assert.equal((await outboxRows(b.app.db))[0].status, 'sent');
    } finally {
      await app.close();
      app = { close: async () => {} };
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('enqueueEmail com o db global fora de transação ainda exige tx válido (contrato)', async () => {
  await assert.rejects(enqueueEmail(undefined, {}), TypeError);
});
