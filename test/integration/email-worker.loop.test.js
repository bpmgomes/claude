// AF-18, achado B1 da revisão: o laço só reagenda com 0 quando o ciclo AVANÇOU linhas sem erro.
// Preparo que lança (a linha volta a `pending` sem consumir tentativa) ou lote inteiro levado por
// outro worker (`taken`) usam `intervalMs`, sem laço quente. Temporizadores falsos: cada
// reagendamento é registrado com o atraso pedido.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emailTestApp, seedBusiness, outboxRows } from '../helpers/email.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { createEmailWorker } from '../../src/modules/email/email-worker.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { EMAIL_BATCH_SIZE } from '../../src/modules/email/email-rules.js';

const INTERVAL = 15_000;
let app;
let clock;
let seed;
let transport;

/** Temporizadores falsos: guardam (fn, ms); `fire()` roda o último e espera o próximo agendamento. */
function fakeTimers() {
  const scheduled = [];
  let pending = null;
  return {
    scheduled,
    setTimeout(fn, ms) {
      const handle = { fn, ms, cleared: false };
      scheduled.push(handle);
      pending = handle;
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    /** Roda o temporizador vivo e espera o laço pedir o próximo. @returns {Promise<number>} o atraso pedido */
    async fire() {
      const current = pending;
      assert.ok(current && !current.cleared, 'nenhum temporizador vivo');
      const before = scheduled.length;
      current.fn();
      for (let i = 0; i < 500 && scheduled.length === before; i++) await new Promise((r) => setImmediate(r));
      assert.ok(scheduled.length > before, 'o laço não reagendou');
      return scheduled.at(-1).ms;
    },
  };
}

function makeWorker(timers, over = {}) {
  const s = app.services;
  return createEmailWorker({
    db: app.db,
    outbox: s.emailOutboxRepository,
    appointmentsRepository: s.appointmentsRepository,
    businessesRepository: s.businessesRepository,
    customersRepository: s.customersRepository,
    reschedulesRepository: s.reschedulesRepository,
    manageTokensRepository: s.manageTokensRepository,
    tokenIssuer: s.tokenIssuer,
    mailTransport: transport,
    emailConfig: app.config.email,
    publicBaseUrl: app.config.publicBaseUrl,
    enabled: true,
    intervalMs: INTERVAL,
    now: clock.now,
    random: () => 0,
    timers,
    ...over,
  });
}

async function seedRows(n) {
  await app.db.transaction(async (tx) => {
    for (let i = 0; i < n; i++) {
      const customerId = await insertCustomerDirect(tx, seed.business.id);
      const startsAt = new Date(Date.parse('2026-12-07T12:00:00.000Z') + Math.floor(i / 2) * 3_600_000).toISOString();
      const id = await insertAppointmentDirect(tx, {
        businessId: seed.business.id,
        professionalId: seed.professionals[i % 2].id,
        customerId,
        serviceId: seed.service.id,
        startsAt,
      });
      await enqueueEmail(tx, { kind: 'appointment_confirmed', businessId: seed.business.id, appointmentId: id, nowIso: clock.now().toISOString() });
    }
  });
}

beforeEach(async () => {
  ({ app, clock, transport } = await emailTestApp());
  seed = await seedBusiness(app);
  await seedRows(EMAIL_BATCH_SIZE + 2);
});
afterEach(() => app.close());

describe('reagendamento do laço (B1)', () => {
  test('controle: lote cheio que avança reagenda com 0; o resto drena e volta ao intervalo', async () => {
    const timers = fakeTimers();
    const w = makeWorker(timers);
    w.start();
    assert.equal(timers.scheduled[0].ms, 0);
    assert.equal(await timers.fire(), 0, 'lote cheio com progresso');
    assert.equal(await timers.fire(), INTERVAL, 'lote parcial');
    assert.equal(transport.messages.length, EMAIL_BATCH_SIZE + 2);
    await w.stop({ graceMs: 100 });
  });

  test('preparo que lança em todo o lote: intervalo, não 0; linhas seguem pending sem tentativa', async () => {
    const timers = fakeTimers();
    const businessesRepository = {
      ...app.services.businessesRepository,
      findById: async () => {
        throw Object.assign(new Error('falha de leitura'), { code: 'ETEST' });
      },
    };
    const w = makeWorker(timers, { businessesRepository });
    w.start();
    for (let i = 0; i < 3; i++) assert.equal(await timers.fire(), INTERVAL, `ciclo ${i + 1}`);
    const rows = await outboxRows(app.db);
    assert.ok(rows.every((r) => r.status === 'pending' && r.attempts === 0));
    assert.equal(transport.calls, 0);
    await w.stop({ graceMs: 100 });
  });

  test('lote inteiro levado por outro worker (claim com changes 0): intervalo, não 0', async () => {
    const timers = fakeTimers();
    const outbox = { ...app.services.emailOutboxRepository, claim: async () => ({ changes: 0 }) };
    const w = makeWorker(timers, { outbox });
    w.start();
    for (let i = 0; i < 3; i++) assert.equal(await timers.fire(), INTERVAL, `ciclo ${i + 1}`);
    assert.equal(transport.calls, 0);
    await w.stop({ graceMs: 100 });
  });

  test('runOnce devolve errors com o número de linhas cujo preparo lançou', async () => {
    const businessesRepository = {
      ...app.services.businessesRepository,
      findById: async () => {
        throw new Error('x');
      },
    };
    const s = await makeWorker(fakeTimers(), { businessesRepository, enabled: false }).runOnce();
    assert.equal(s.errors, EMAIL_BATCH_SIZE);
    assert.equal(s.claimed, 0);
    assert.equal(s.full, true);
  });
});
