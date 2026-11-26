// AF-18 (critérios 5 e 32, R12, R16): o transporte de e-mail nunca afeta as rotas. Worker LIGADO
// (start() explícito, intervalo de 100 ms: o mínimo da config; a porta acorda o worker na hora) com adaptador que trava, que lança (síncrono e assíncrono)
// e que demora 30 s: reservar, cancelar e remarcar respondem igual ao adaptador `ok`, no mesmo tempo,
// e `app.close()` com envio travado termina sem erro de banco fechado.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows, logEntries } from '../helpers/email.js';
import { bookingBody, countAppointments, postAppointment } from '../helpers/appointments.js';
import { tokenOfUrl, cancelManage, rescheduleManage, versionOf } from '../helpers/manage.js';
import { buildTestApp } from '../helpers/test-app.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const GRACE_MS = 5000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Corpo sem `manage.url` e com ids, `version` (hash que inclui os ids) e e-mails gerados trocados por marcadores (comparável entre apps). */
function normalize(json) {
  const copy = structuredClone(json);
  if (copy?.manage) delete copy.manage.url;
  return JSON.parse(
    JSON.stringify(copy)
      .replace(UUID_RE, 'ID')
      .replace(/cliente\d+-\d+@example\.com/g, 'EMAIL')
      .replace(/"version":"[A-Za-z0-9_-]+"/g, '"version":"V"'),
  );
}

/** Reserva duas vezes, cancela a 1ª e remarca a 2ª; devolve status, corpos normalizados e tempo. */
async function scenario(app, seed) {
  const timings = [];
  const timed = async (fn) => {
    const t0 = process.hrtime.bigint();
    const res = await fn();
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
    // Dá ao worker a chance de reivindicar e entrar no envio antes da próxima rota.
    await pause(30);
    return res;
  };
  const book = (start, phone) =>
    timed(() =>
      postAppointment(
        app,
        seed.slug,
        bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start: `${FRIDAY}T${start}`, customer: { phone } }),
      ),
    );
  const b1 = await book('10:00', '11912340001');
  const b2 = await book('11:00', '11912340002');
  const t1 = tokenOfUrl(b1.json().manage?.url);
  const t2 = tokenOfUrl(b2.json().manage?.url);
  const v1 = await versionOf(app, t1);
  const v2 = await versionOf(app, t2);
  const cancel = await timed(() => cancelManage(app, t1, { version: v1 }));
  const resched = await timed(() => rescheduleManage(app, t2, { start: `${FRIDAY}T15:00`, version: v2 }));
  return {
    statuses: [b1.statusCode, b2.statusCode, cancel.statusCode, resched.statusCode],
    bodies: [b1, b2, cancel, resched].map((r) => normalize(r.json())),
    totalMs: timings.reduce((a, b) => a + b, 0),
  };
}

async function runWith(behavior) {
  const transport = createMemoryMailTransport();
  transport.setBehavior(behavior);
  const { app, logs } = await emailTestApp({ mailTransport: transport, email: { worker: { enabled: true, intervalMs: 100 } } });
  const keepAlive = setInterval(() => {}, 20);
  try {
    const seed = await seedBusiness(app);
    app.services.emailWorker.start();
    assert.equal(app.services.emailWorker.started, true);
    const result = await scenario(app, seed);
    const appointments = {
      confirmed: await countAppointments(app.db, { status: 'confirmed' }),
      cancelled: await countAppointments(app.db, { status: 'cancelled' }),
    };
    const rows = await outboxRows(app.db);
    const t0 = Date.now();
    await app.close();
    const closeMs = Date.now() - t0;
    return { ...result, appointments, rows, closeMs, logs, transport };
  } finally {
    clearInterval(keepAlive);
  }
}

describe('isolamento do transporte (critérios 5 e 32)', () => {
  let baseline;

  test('adaptador ok: 201/201/200/200 e os 4 e-mails saem pelo laço', async () => {
    baseline = await runWith({ mode: 'ok' });
    assert.deepEqual(baseline.statuses, [201, 201, 200, 200]);
    assert.ok(baseline.closeMs < GRACE_MS + 1000, `close ${baseline.closeMs} ms`);
  });

  const cases = [
    ['trava para sempre', { mode: 'hang' }],
    ['lança síncrono', { mode: 'throwSync' }],
    ['rejeita (assíncrono)', { mode: 'reject' }],
    ['demora 30 s', { mode: 'delay', delayMs: 30_000 }],
  ];
  for (const [label, behavior] of cases) {
    test(`adaptador que ${label}: mesmas respostas, mesmo tempo, dados gravados e close limpo`, async () => {
      assert.ok(baseline, 'o caso ok roda antes');
      const r = await runWith(behavior);
      assert.deepEqual(r.statuses, baseline.statuses);
      assert.deepEqual(r.bodies, baseline.bodies);
      assert.ok(Math.abs(r.totalMs - baseline.totalMs) < 200, `tempo ${r.totalMs.toFixed(1)} ms contra ${baseline.totalMs.toFixed(1)} ms`);
      // 3 agendamentos ativos (o 2º remarcado vira um novo; o antigo e o 1º ficam cancelados).
      assert.deepEqual(r.appointments, baseline.appointments);
      assert.equal(r.rows.length, 4);
      assert.ok(r.transport.calls >= 1, 'o worker tentou enviar');
      assert.ok(r.closeMs < GRACE_MS + 1000, `close ${r.closeMs} ms`);
      const text = r.logs();
      assert.doesNotMatch(text, /database is not open|database is closed|not open/i);
      const failures = logEntries(r.logs).filter((e) => e.event === 'email_worker_failed' || e.level >= 50);
      assert.deepEqual(
        failures.filter((e) => e.event !== 'email_transport_misconfigured'),
        [],
        JSON.stringify(failures),
      );
    });
  }

  test('ok: todas as linhas enviadas pelo laço', async () => {
    assert.ok(baseline.rows.every((row) => row.status === 'sent'), JSON.stringify(baseline.rows.map((x) => x.status)));
    assert.equal(baseline.transport.messages.length, 4);
  });
});

describe('transporte none (buildTestApp padrão)', () => {
  test('a reserva funciona igual e a linha fica pending', async () => {
    const { app } = await buildTestApp();
    try {
      assert.equal(app.config.email.enabled, false);
      const seed = await seedBusiness(app);
      const res = await postAppointment(app, seed.slug, bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start: `${FRIDAY}T10:00` }));
      assert.equal(res.statusCode, 201);
      assert.ok(res.json().manage.url);
      const summary = await app.services.emailWorker.runOnce();
      assert.equal(summary.claimed, 0);
      const rows = await outboxRows(app.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'pending');
      assert.equal(rows[0].attempts, 0);
    } finally {
      await app.close();
    }
  });
});
