// AF-18 (critérios 7 e 10): dois workers sobre as mesmas linhas enviam cada e-mail exatamente uma
// vez; sem `changes === 1` nada sai; worker e cancelamento ao mesmo tempo nunca mandam "confirmado"
// depois de um cancelamento já confirmado no banco.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows, drain } from '../helpers/email.js';
import { bookingBody, insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { bookWithLink, cancelManage, versionOf } from '../helpers/manage.js';
import { createEmailWorker } from '../../src/modules/email/email-worker.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';

let app;
let clock;
let seed;
let keepAlive;

function makeWorker(transport, over = {}) {
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
    enabled: false,
    intervalMs: 1000,
    now: clock.now,
    random: () => 0,
    ...over,
  });
}

/** 20 agendamentos crus, cada um com cliente próprio, e a linha da fila de cada um. */
async function seedRows(n = 20) {
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
  ({ app, clock } = await emailTestApp());
  seed = await seedBusiness(app);
  // Os temporizadores do adaptador e do teto de envio têm unref: o teste segura o event loop.
  keepAlive = setInterval(() => {}, 20);
});
afterEach(async () => {
  clearInterval(keepAlive);
  await app.close();
});

describe('dois workers (critério 7)', () => {
  for (let round = 0; round < 5; round++) {
    test(`rodada ${round + 1}: 20 linhas, cada e-mail enviado exatamente uma vez`, async () => {
      await seedRows();
      const transport = createMemoryMailTransport();
      transport.setBehavior({ mode: 'delay', delayMs: 5 });
      const a = makeWorker(transport);
      const b = makeWorker(transport);
      const pair = round % 2 === 0 ? [a, b] : [b, a];
      let claimed = 0;
      for (let i = 0; i < 10; i++) {
        const summaries = await Promise.all(pair.map((w) => w.runOnce()));
        const total = summaries.reduce((n, s) => n + s.claimed, 0);
        claimed += total;
        if (total === 0) break;
      }
      assert.equal(claimed, 20);
      assert.equal(transport.messages.length, 20);
      assert.equal(new Set(transport.messages.map((m) => m.messageId)).size, 20);
      const rows = await outboxRows(app.db);
      assert.ok(rows.every((r) => r.status === 'sent' && r.attempts === 1), JSON.stringify(rows.map((r) => [r.status, r.attempts])));
    });
  }

  test('mutação permanente: claim com changes 0 não envia nada', async () => {
    await seedRows(5);
    const transport = createMemoryMailTransport();
    const outbox = { ...app.services.emailOutboxRepository, claim: async () => ({ changes: 0 }) };
    const summary = await makeWorker(transport, { outbox }).runOnce();
    assert.equal(summary.claimed, 0);
    assert.equal(transport.calls, 0);
    assert.ok((await outboxRows(app.db)).every((r) => r.status === 'pending' && r.attempts === 0));
  });
});

describe('worker contra cancelamento (critérios 10 e 5.7 do design)', () => {
  test('10 rodadas: nunca "confirmado" depois de um cancelamento confirmado antes do preparo; os dois ramos ocorrem', async () => {
    const branches = new Set();
    const transport = app.services.mailTransport;
    for (let round = 0; round < 10; round++) {
      transport.clear();
      const start = `${FRIDAY}T${['10:00', '11:00', '13:00', '14:00', '15:00'][round % 5]}`;
      const { token } = await bookWithLink(
        app,
        seed.slug,
        bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[round < 5 ? 0 : 1].id, start, customer: { phone: `119123400${String(round).padStart(2, '0')}` } }),
      );
      const version = await versionOf(app, token);
      const confirmedRow = (await outboxRows(app.db, { kind: 'appointment_confirmed' })).at(-1);
      let cancelFirst;
      if (round % 2 === 0) {
        // O cancelamento confirma antes do preparo.
        cancelFirst = true;
        await cancelManage(app, token, { version });
        await app.services.emailWorker.runOnce();
      } else {
        // O preparo do worker entra na fila do banco antes do cancelamento.
        cancelFirst = false;
        const run = app.services.emailWorker.runOnce();
        await cancelManage(app, token, { version });
        await run;
      }
      await drain(app);
      const status = (await outboxRows(app.db, { id: confirmedRow.id }))[0];
      const subjects = transport.messages.map((m) => m.subject.split(':')[0]);
      if (status.status === 'sent') {
        branches.add('confirmado-saiu');
        assert.equal(cancelFirst, false, 'confirmado depois de cancelamento já confirmado');
        assert.deepEqual(subjects, ['Agendamento confirmado', 'Agendamento cancelado']);
      } else {
        branches.add('confirmado-pulado');
        assert.equal(status.last_error_code, 'not_confirmed');
        assert.deepEqual(subjects, ['Agendamento cancelado']);
      }
    }
    assert.deepEqual([...branches].sort(), ['confirmado-pulado', 'confirmado-saiu']);
  });
});
