import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import {
  signupAndLogin,
  createBusinessFor,
  createService,
  createProfessional,
  putHours,
  postTimeBlock,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { bookingBody, postAppointment, countAppointments, cancelDirect } from '../helpers/appointments.js';
import { SlotUnavailableError } from '../../src/http/errors.js';
import { countCustomers } from '../helpers/customers.js';

// Quinta 26/11/2026, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';
const WORKER = fileURLToPath(new URL('../helpers/booking-worker.js', import.meta.url));

/** Celular válido e único por índice: (11) 97xxx-xxxx. */
const phoneOf = (i) => `1197${String(1000000 + i * 37).padStart(7, '0')}`;
/** Cliente único (e-mail e telefone) por índice. */
const customerOf = (i) => ({ name: `Cliente ${i}`, phone: phoneOf(i), email: `c${i}@example.com` });
/** 20 inícios distintos de 60 min dentro da grade 09–12 / 13–18 (sexta, segunda e terça). */
const STARTS = ['2026-11-27', '2026-11-30', '2026-12-01']
  .flatMap((d) => ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'].map((h) => `${d}T${h}`))
  .slice(0, 20);
const plusHour = (local) => `${local.slice(0, 11)}${String(Number(local.slice(11, 13)) + 1).padStart(2, '0')}:00`;

let app;
let ana;
let corte;
let pa;
let pb;
let pc;
let seq = 0;

async function setup() {
  const clock = createClock(NOW);
  ({ app } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  pc = await createProfessional(app, ana, { name: 'Caio Reis', serviceIds: [corte.id] });
  for (const p of [pa, pb, pc]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
}

const request = (over = {}, options = {}) => {
  seq += 1;
  return postAppointment(
    app,
    SLUG,
    bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, customer: customerOf(seq), ...over }),
    { remoteAddress: `10.0.${Math.trunc(seq / 250)}.${(seq % 250) + 1}`, ...options },
  );
};
const statusesOf = (responses) => responses.map((r) => r.statusCode).sort();

describe('concorrência no mesmo processo (critérios 19 a 23 e 25)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('20 simultâneas no mesmo início: 1 × 201, 19 × 409 SLOT_UNAVAILABLE, 1 agendamento e 1 cliente (critério 19)', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => request()));
    assert.deepEqual(statusesOf(responses), [201, ...Array(19).fill(409)]);
    for (const res of responses.filter((r) => r.statusCode === 409)) assert.equal(res.json().error.code, 'SLOT_UNAVAILABLE');
    assert.equal(await countAppointments(app.db), 1);
    assert.equal(await countCustomers(app.db), 1);
  });

  test('sobreposição com duração diferente: 10 × 60 min às 10:00 e 10 × 30 min às 10:30 dão 1 agendamento (critério 20)', async () => {
    const curto = await createService(app, ana, { name: 'Franja', durationMinutes: 30 });
    await app.inject({ method: 'PATCH', url: `/api/professionals/${pa.id}`, cookies: ana, payload: { serviceIds: [corte.id, curto.id] } });
    const responses = await Promise.all([
      ...Array.from({ length: 10 }, () => request()),
      ...Array.from({ length: 10 }, () => request({ serviceId: curto.id, start: `${FRIDAY}T10:30` })),
    ]);
    assert.deepEqual(statusesOf(responses), [201, ...Array(19).fill(409)]);
    assert.equal(await countAppointments(app.db), 1);
  });

  test('encostados (10:00–11:00 e 11:00–12:00) simultâneos: os dois gravam', async () => {
    const responses = await Promise.all([request(), request({ start: `${FRIDAY}T11:00` })]);
    assert.deepEqual(statusesOf(responses), [201, 201]);
    assert.equal(await countAppointments(app.db), 2);
  });

  test('"qualquer" com 3 livres e 4 requisições: 3 × 201 com profissionais distintos e 1 × 409, 20 vezes (critério 22)', async () => {
    for (const start of STARTS) {
      const responses = await Promise.all(Array.from({ length: 4 }, () => request({ professionalId: 'any', start })));
      assert.deepEqual(statusesOf(responses), [201, 201, 201, 409], start);
      const rows = await app.db.all(
        "SELECT professional_id FROM appointments WHERE starts_at = ? AND status = 'confirmed'",
        [new Date(Date.parse(`${start}:00.000Z`) + 3 * 3_600_000).toISOString()],
      );
      assert.deepEqual(rows.map((r) => r.professional_id).sort(), [pa.id, pb.id, pc.id].sort(), start);
      const names = responses.filter((r) => r.statusCode === 201).map((r) => r.json().appointment.professional.name);
      assert.equal(new Set(names).size, 3);
    }
    assert.equal(await countAppointments(app.db), 60);
  });

  for (const [label, professionalOf] of [
    ['do profissional', () => pa.id],
    ['de "todos"', () => null],
  ]) {
    test(`reserva contra bloqueio ${label}, 20 rodadas: nunca os dois 201 sem aviso (critério 23)`, async () => {
      const outcomes = new Set();
      for (const start of STARTS) {
        const [booking, block] = await Promise.all([
          request({ start }),
          postTimeBlock(app, ana, { professionalId: professionalOf(), start, end: plusHour(start) }),
        ]);
        if (booking.statusCode === 201) {
          assert.equal(block.statusCode, 409, `${start}: ${block.body}`);
          assert.equal(block.json().error.code, 'TIME_BLOCK_CONFLICTS');
          assert.equal(block.json().error.conflictsTotal, 1);
          assert.equal(block.json().error.conflicts[0].start, start);
          outcomes.add('reserva');
        } else {
          assert.equal(block.statusCode, 201, `${start}: ${block.body}`);
          assert.equal(booking.statusCode, 409);
          assert.equal(booking.json().error.code, 'SLOT_UNAVAILABLE');
          outcomes.add('bloqueio');
        }
      }
      assert.ok(outcomes.size >= 1);
    });
  }

  test('reserva contra remoção do profissional: "404 e removido sem agendamento" ou "201 e remoção 409"', async () => {
    for (let round = 0; round < 10; round++) {
      const p = await createProfessional(app, ana, { name: `Prof ${round}`, serviceIds: [corte.id] });
      assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
      const [booking, removal] = await Promise.all([
        request({ professionalId: p.id }),
        app.inject({ method: 'DELETE', url: `/api/professionals/${p.id}`, cookies: ana }),
      ]);
      const appointments = await countAppointments(app.db, { professional_id: p.id });
      if (removal.statusCode === 204) {
        assert.equal(booking.statusCode, 404, booking.body);
        assert.equal(appointments, 0);
      } else {
        assert.equal(removal.statusCode, 409, removal.body);
        assert.equal(removal.json().error.code, 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS');
        assert.equal(booking.statusCode, 201);
        assert.equal(appointments, 1);
      }
    }
  });

  test('a mesma Idempotency-Key 5 vezes ao mesmo tempo: 5 × 201 com o mesmo appointment, 5 links distintos e 1 agendamento (critério 25; AF-12 critério 8)', async () => {
    const b = bookingBody({ serviceId: corte.id, professionalId: 'any', start: `${FRIDAY}T10:00`, customer: customerOf(9999) });
    const headers = { 'idempotency-key': '3b241101-e2bb-4255-8caf-4136c566a962' };
    const responses = await Promise.all(Array.from({ length: 5 }, () => postAppointment(app, SLUG, b, { headers })));
    assert.deepEqual(statusesOf(responses), Array(5).fill(201));
    assert.equal(new Set(responses.map((r) => JSON.stringify(r.json().appointment))).size, 1);
    const urls = responses.map((r) => r.json().manage.url);
    assert.equal(new Set(urls).size, 5);
    for (const url of urls) assert.match(url, /^https:\/\/agendafacil\.app\/agendamento\/[A-Za-z0-9_-]{43}$/);
    assert.equal(await countAppointments(app.db), 1);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_manage_tokens')).n), 5);
  });
});

/** Instante UTC de um início local de São Paulo (UTC-3, sem horário de verão). */
const utcOf = (local) => new Date(Date.parse(`${local}:00.000Z`) + 3 * 3_600_000).toISOString();
const activeAt = async (startsAt) =>
  (await app.db.all("SELECT id FROM appointments WHERE professional_id = ? AND starts_at = ? AND status <> 'cancelled'", [pa.id, startsAt])).map(
    (r) => r.id,
  );

describe('AF-22: cancelar, reservar e bookSlot direto (critérios 8 a 10)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('cancelar e reservar ao mesmo tempo, 10 rodadas alternando quem entra primeiro: 201 ou 409 SLOT_UNAVAILABLE, no máximo 1 não cancelado e os dois ramos ocorrem', async () => {
    /**
     * Com o POST primeiro, o cancelamento só é enfileirado quando a transação da reserva já está na
     * fila do adapter (FIFO): o recheck e o trigger ainda veem o agendamento ativo. Sem esse gancho,
     * o `inject` é assíncrono e o cancelamento entra sempre antes, mesmo com o POST antes no Promise.all.
     */
    const postFirst = (start, cancelledId) => {
      let cancelled;
      const original = app.db.transaction;
      app.db.transaction = function hooked(fn) {
        app.db.transaction = original;
        const result = original.call(this, fn);
        cancelled = cancelDirect(app.db, cancelledId);
        return result;
      };
      const posted = request({ start }).finally(() => {
        app.db.transaction = original;
      });
      return Promise.all([posted, posted.then(() => cancelled ?? cancelDirect(app.db, cancelledId))]).then(([res]) => res);
    };
    const branches = { 201: 0, 409: 0 };
    for (const [round, start] of STARTS.slice(0, 10).entries()) {
      const first = await request({ start });
      assert.equal(first.statusCode, 201, `${start}: ${first.body}`);
      const startsAt = utcOf(start);
      const [cancelledId] = await activeAt(startsAt);
      assert.ok(cancelledId, start);
      const second =
        round % 2 === 0
          ? (await Promise.all([cancelDirect(app.db, cancelledId), request({ start })]))[1]
          : await postFirst(start, cancelledId);
      const active = await activeAt(startsAt);
      if (second.statusCode === 201) {
        assert.equal(active.length, 1, start);
        assert.notEqual(active[0], cancelledId, start);
      } else {
        assert.equal(second.statusCode, 409, `${start}: ${second.body}`);
        assert.equal(second.json().error.code, 'SLOT_UNAVAILABLE');
        assert.equal(active.length, 0, start);
      }
      branches[second.statusCode] += 1;
      const cancelled = await app.db.get('SELECT status FROM appointments WHERE id = ?', [cancelledId]);
      assert.equal(cancelled.status, 'cancelled');
    }
    assert.ok(branches[201] > 0 && branches[409] > 0, `os dois ramos precisam ocorrer: ${JSON.stringify(branches)}`);
  });

  for (const [label, start, extra] of [
    ['parâmetros padrão (POST público)', '2026-11-27T10:00', {}],
    ['parâmetros do AF-15 (leadMinutes 0, customerLimit null)', '2026-11-30T10:00', { leadMinutes: 0, customerLimit: null }],
  ]) {
    test(`bookSlot(tx, ...) direto com duas transações no mesmo horário, ${label}: uma conclui, a outra SlotUnavailableError, sem cliente órfão`, async () => {
      const business = await app.db.get('SELECT id, timezone FROM businesses');
      const before = await countCustomers(app.db);
      const customers = [customerOf(7001 + seq), customerOf(7101 + seq)];
      seq += 1;
      const results = await Promise.allSettled(
        customers.map((customerInput) =>
          app.db.transaction((tx) =>
            app.services.appointmentsService.bookSlot(tx, {
              business,
              serviceId: corte.id,
              professionalId: pa.id,
              start,
              customerInput,
              nowMs: Date.parse(NOW),
              ...extra,
            }),
          ),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof SlotUnavailableError, String(rejected[0].reason));
      assert.equal(fulfilled[0].value.professional.id, pa.id);
      assert.equal(fulfilled[0].value.startsAt, utcOf(start));
      assert.equal((await activeAt(utcOf(start))).length, 1);
      assert.equal(await countCustomers(app.db), before + 1);
      const loser = customers[results.findIndex((r) => r.status === 'rejected')];
      const winner = customers[results.findIndex((r) => r.status === 'fulfilled')];
      const byEmail = async (email) => Number((await app.db.get('SELECT COUNT(*) AS n FROM customers WHERE email = ?', [email])).n);
      assert.equal(await byEmail(loser.email), 0, 'cliente do perdedor não fica gravado');
      assert.equal(await byEmail(winner.email), 1);
    });
  }
});

describe('concorrência entre processos sobre o mesmo arquivo SQLite (critério 19)', () => {
  test('2 workers, 20 fetch reais no mesmo início: 1 × 201, 19 × 409, nenhum 500/503 e COUNT = 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af11-'));
    const databasePath = join(dir, 'agenda.sqlite');
    const workers = [];
    try {
      // O pai aplica as migrações e semeia antes (sem corrida em schema_migrations).
      const clock = createClock(NOW);
      ({ app } = await buildTestApp({ now: clock.now, databasePath }));
      ana = await signupAndLogin(app);
      await createBusinessFor(app, ana);
      corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
      pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
      assert.equal((await putHours(app, ana, pa.id, WEEK_9_TO_18)).statusCode, 200);
      await app.close();

      const ports = await Promise.all(
        [0, 1].map(
          () =>
            new Promise((resolve, reject) => {
              const child = fork(WORKER, [databasePath, NOW], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
              workers.push(child);
              child.once('message', (msg) => resolve(msg.port));
              child.once('error', reject);
              child.once('exit', (code) => reject(new Error(`worker saiu com ${code}`)));
            }),
        ),
      );
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          fetch(`http://127.0.0.1:${ports[i % 2]}/api/public/${SLUG}/appointments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
            body: JSON.stringify(
              bookingBody({ serviceId: corte.id, professionalId: pa.id, start: `${FRIDAY}T10:00`, customer: customerOf(500 + i) }),
            ),
          }).then(async (res) => ({ status: res.status, body: await res.json() })),
        ),
      );
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, ...Array(19).fill(409)], JSON.stringify(responses.filter((r) => r.status !== 409 && r.status !== 201)));
      for (const r of responses.filter((x) => x.status === 409)) assert.equal(r.body.error.code, 'SLOT_UNAVAILABLE');
    } finally {
      await Promise.all(
        workers.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.removeAllListeners('exit');
              child.once('exit', resolve);
              child.send('stop');
            }),
        ),
      );
      const raw = new DatabaseSync(databasePath);
      try {
        const n = Number(raw.prepare('SELECT COUNT(*) AS n FROM appointments').get().n);
        const customers = Number(raw.prepare('SELECT COUNT(*) AS n FROM customers').get().n);
        assert.equal(n, 1);
        assert.equal(customers, 1);
      } finally {
        raw.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
