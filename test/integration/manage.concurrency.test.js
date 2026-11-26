// AF-12: concorrência do gerenciar (design 5.7 e 6.1, critérios 20 a 23), no padrão do AF-22:
// Promise.all por app.inject, rodadas que alternam a ordem de envio e asserção de que os dois
// ramos ocorreram quando há dois.
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
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from '../helpers/session.js';
import { bookingBody, postAppointment } from '../helpers/appointments.js';
import { bookWithLink, tokenOfUrl, getManage, cancelManage, rescheduleManage, versionOf, tokensOf } from '../helpers/manage.js';
import { hashManageToken } from '../../src/modules/appointments/manage-token.js';

// Quinta 26/11/2026, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const WORKER = fileURLToPath(new URL('../helpers/booking-worker.js', import.meta.url));
const DAYS = ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'];
const HOURS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
/** 40 inícios distintos de 60 min sem sobreposição (sexta a quinta seguinte). */
const STARTS = DAYS.flatMap((d) => HOURS.map((h) => `${d}T${h}`));

const phoneOf = (i) => `1197${String(1000000 + i * 37).padStart(7, '0')}`;
const customerOf = (i) => ({ name: `Cliente ${i}`, phone: phoneOf(i), email: `c${i}@example.com` });
/** São Paulo é UTC−3 o ano todo (sem horário de verão desde 2019). */
const utcOf = (local) => new Date(Date.parse(`${local}:00.000Z`) + 3 * 3_600_000).toISOString();

let app;
let ana;
let corte;
let pa;
let seq = 0;
let events;

async function setup() {
  events = [];
  const clock = createClock(NOW);
  const appointmentEvents = {
    confirmed: () => {},
    cancelled: (e) => events.push(['cancelled', e]),
    rescheduled: (e) => events.push(['rescheduled', e]),
  };
  ({ app } = await buildTestApp({ now: clock.now, appointmentEvents }));
  ana = await signupAndLogin(app);
  await createBusinessFor(app, ana);
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60, price: '50' });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  assert.equal((await putHours(app, ana, pa.id, WEEK_9_TO_18)).statusCode, 200);
}

const nextIp = () => {
  seq += 1;
  return `10.0.${Math.trunc(seq / 250)}.${(seq % 250) + 1}`;
};
const book = (start) => {
  seq += 1;
  return bookWithLink(app, SLUG, bookingBody({ serviceId: corte.id, professionalId: pa.id, start, customer: customerOf(seq) }), {
    remoteAddress: nextIp(),
  });
};
const appointmentIdOf = async (token) =>
  (await app.db.get('SELECT appointment_id FROM appointment_manage_tokens WHERE token_hash = ?', [hashManageToken(token)])).appointment_id;
const activeAt = async (startsAt) =>
  (await app.db.all("SELECT id FROM appointments WHERE starts_at = ? AND status <> 'cancelled'", [startsAt])).map((r) => r.id);
const statusOf = async (id) => (await app.db.get('SELECT status FROM appointments WHERE id = ?', [id])).status;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('mesmo processo (critérios 20 a 23)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('(a) 10 remarcações do mesmo agendamento com a mesma version, 5 rodadas: 1 × 200 e 9 × 409, um ativo, 1 elo e o token no novo', async () => {
    for (const [round, day] of DAYS.entries()) {
      const { token } = await book(`${day}T09:00`);
      const oldId = await appointmentIdOf(token);
      const customerId = (await app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [oldId])).customer_id;
      const version = await versionOf(app, token);
      const targets = ['10:00', '10:30', '11:00', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'].map((h) => `${day}T${h}`);
      if (round % 2 === 1) targets.reverse();
      const responses = await Promise.all(targets.map((start) => rescheduleManage(app, token, { start, version }, { remoteAddress: nextIp() })));
      const ok = responses.filter((r) => r.statusCode === 200);
      const conflicts = responses.filter((r) => r.statusCode === 409);
      assert.equal(ok.length, 1, `rodada ${round}: ${responses.map((r) => r.statusCode).join()}`);
      assert.equal(conflicts.length, 9, responses.map((r) => r.body).join('\n'));
      for (const r of conflicts) assert.ok(['APPOINTMENT_CHANGED', 'APPOINTMENT_NOT_CHANGEABLE'].includes(r.json().error.code), r.body);

      const rows = await app.db.all('SELECT id, status, starts_at FROM appointments WHERE customer_id = ?', [customerId]);
      const live = rows.filter((r) => r.status !== 'cancelled');
      assert.equal(live.length, 1, JSON.stringify(rows));
      assert.equal(await statusOf(oldId), 'cancelled');
      assert.equal(live[0].starts_at, utcOf(`${day}T${ok[0].json().appointment.start.slice(11)}`));
      const links = await app.db.all('SELECT * FROM appointment_reschedules WHERE previous_appointment_id = ?', [oldId]);
      assert.equal(links.length, 1);
      assert.equal(links[0].appointment_id, live[0].id);
      assert.equal(await appointmentIdOf(token), live[0].id, 'o token está no novo');
    }
  });

  test('(b) cancelar e remarcar ao mesmo tempo, 10 rodadas alternadas: um 200 e um 409, estados válidos e os dois ramos ocorrem', async () => {
    const branches = { cancel: 0, reschedule: 0 };
    for (let round = 0; round < 10; round++) {
      const seed = STARTS[2 * round];
      const target = STARTS[2 * round + 1];
      const { token } = await book(seed);
      const oldId = await appointmentIdOf(token);
      const version = await versionOf(app, token);
      const cancel = () => cancelManage(app, token, { version, remoteAddress: nextIp() });
      const reschedule = () => rescheduleManage(app, token, { start: target, version }, { remoteAddress: nextIp() });
      let c;
      let r;
      if (round % 2 === 0) [c, r] = await Promise.all([cancel(), reschedule()]);
      else [r, c] = await Promise.all([reschedule(), cancel()]);
      const statuses = [c.statusCode, r.statusCode].sort();
      assert.deepEqual(statuses, [200, 409], `rodada ${round}: ${c.body} | ${r.body}`);
      assert.equal(await statusOf(oldId), 'cancelled');
      const newAtTarget = await activeAt(utcOf(target));
      if (c.statusCode === 200) {
        branches.cancel += 1;
        assert.equal(newAtTarget.length, 0, 'cancelamento venceu: nenhum novo');
        assert.equal(await appointmentIdOf(token), oldId);
        assert.ok((await tokensOf(app.db, oldId)).every((t) => t.revoked_at !== null));
      } else {
        branches.reschedule += 1;
        assert.equal(newAtTarget.length, 1, 'remarcação venceu: um novo ativo');
        assert.equal(await appointmentIdOf(token), newAtTarget[0], 'com o token');
        assert.equal(c.json().error.code, 'APPOINTMENT_CHANGED', c.body);
      }
      assert.equal((await activeAt(utcOf(seed))).length, 0);
    }
    assert.ok(branches.cancel > 0 && branches.reschedule > 0, `os dois ramos precisam ocorrer: ${JSON.stringify(branches)}`);
  });

  test('(c) cancelar duas vezes ao mesmo tempo: dois 200 com corpo igual, um cancelled_at, revoked_at único e um evento cancelled', async () => {
    for (const start of STARTS.slice(0, 5)) {
      events.length = 0;
      const { token } = await book(start);
      const id = await appointmentIdOf(token);
      const version = await versionOf(app, token);
      const [a, b] = await Promise.all([cancelManage(app, token, { version }), cancelManage(app, token, { version })]);
      assert.equal(a.statusCode, 200, a.body);
      assert.equal(b.statusCode, 200, b.body);
      assert.equal(a.body, b.body);
      const rows = await tokensOf(app.db, id);
      assert.equal(new Set(rows.map((t) => t.revoked_at)).size, 1);
      assert.ok(rows[0].revoked_at);
      assert.equal(rows[0].revoked_reason, 'cancelled');
      const row = await app.db.get('SELECT cancelled_at, updated_at FROM appointments WHERE id = ?', [id]);
      assert.ok(row.cancelled_at);
      await flush();
      assert.deepEqual(events, [['cancelled', { appointmentId: id, businessId: (await app.db.get('SELECT id FROM businesses')).id }]]);
    }
  });

  test('remarcar contra reservar o mesmo horário, 10 rodadas alternadas: um sucesso e um 409 SLOT_UNAVAILABLE e os dois ramos ocorrem (critério 23)', async () => {
    const branches = { reschedule: 0, booking: 0 };
    for (let round = 0; round < 10; round++) {
      const seed = STARTS[2 * round];
      const target = STARTS[2 * round + 1];
      const { token } = await book(seed);
      const oldId = await appointmentIdOf(token);
      const version = await versionOf(app, token);
      seq += 1;
      const other = bookingBody({ serviceId: corte.id, professionalId: pa.id, start: target, customer: customerOf(seq) });
      const reschedule = () => rescheduleManage(app, token, { start: target, version }, { remoteAddress: nextIp() });
      const post = () => postAppointment(app, SLUG, other, { remoteAddress: nextIp() });
      let r;
      let p;
      if (round % 2 === 0) [r, p] = await Promise.all([reschedule(), post()]);
      else [p, r] = await Promise.all([post(), reschedule()]);
      const loser = r.statusCode === 200 ? p : r;
      assert.ok((r.statusCode === 200) !== (p.statusCode === 201), `rodada ${round}: ${r.body} | ${p.body}`);
      assert.equal(loser.statusCode, 409, loser.body);
      assert.equal(loser.json().error.code, 'SLOT_UNAVAILABLE');
      assert.equal((await activeAt(utcOf(target))).length, 1);
      if (r.statusCode === 200) {
        branches.reschedule += 1;
        assert.equal(await statusOf(oldId), 'cancelled');
      } else {
        branches.booking += 1;
        assert.equal(await statusOf(oldId), 'confirmed', 'a reserva venceu: o antigo continua');
        assert.equal(await appointmentIdOf(token), oldId);
      }
    }
    assert.ok(branches.reschedule > 0 && branches.booking > 0, `os dois ramos precisam ocorrer: ${JSON.stringify(branches)}`);
  });

  test('o resumo depois da corrida mostra o estado vencedor', async () => {
    const { token } = await book(STARTS[0]);
    const version = await versionOf(app, token);
    await Promise.all([cancelManage(app, token, { version }), rescheduleManage(app, token, { start: STARTS[1], version })]);
    const json = (await getManage(app, token)).json();
    assert.ok(
      (json.appointment.status === 'cancelled' && json.appointment.start === STARTS[0]) ||
        (json.appointment.status === 'confirmed' && json.appointment.start === STARTS[1]),
      JSON.stringify(json.appointment),
    );
  });
});

describe('vários processos sobre o mesmo arquivo SQLite (critério 23)', () => {
  test('2 workers: remarcar no A e reservar o mesmo horário no B, 10 rodadas: um sucesso e um 409, nenhum 500/503', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af12-'));
    const databasePath = join(dir, 'agenda.sqlite');
    const workers = [];
    const outcomes = [];
    try {
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
      const base = (i) => `http://127.0.0.1:${ports[i]}`;
      const jsonPost = (url, payload) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify(payload),
        }).then(async (res) => ({ status: res.status, body: await res.json() }));

      for (let round = 0; round < 10; round++) {
        const seed = STARTS[2 * round];
        const target = STARTS[2 * round + 1];
        const seeded = await jsonPost(
          `${base(0)}/api/public/${SLUG}/appointments`,
          bookingBody({ serviceId: corte.id, professionalId: pa.id, start: seed, customer: customerOf(900 + 2 * round) }),
        );
        assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
        const token = tokenOfUrl(seeded.body.manage.url);
        const summary = await (await fetch(`${base(0)}/api/public/manage/${token}`)).json();
        const reschedule = () => jsonPost(`${base(0)}/api/public/manage/${token}/reschedule`, { start: target, version: summary.change.version });
        const post = () =>
          jsonPost(
            `${base(1)}/api/public/${SLUG}/appointments`,
            bookingBody({ serviceId: corte.id, professionalId: pa.id, start: target, customer: customerOf(901 + 2 * round) }),
          );
        let r;
        let p;
        if (round % 2 === 0) [r, p] = await Promise.all([reschedule(), post()]);
        else [p, r] = await Promise.all([post(), reschedule()]);
        assert.ok((r.status === 200) !== (p.status === 201), `rodada ${round}: ${JSON.stringify(r)} | ${JSON.stringify(p)}`);
        const loser = r.status === 200 ? p : r;
        assert.equal(loser.status, 409, JSON.stringify(loser));
        assert.equal(loser.body.error.code, 'SLOT_UNAVAILABLE');
        outcomes.push({ target, rescheduled: r.status === 200, seed });
      }
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
        for (const { target, rescheduled, seed } of outcomes) {
          const at = (local) => Number(raw.prepare("SELECT COUNT(*) AS n FROM appointments WHERE starts_at = ? AND status <> 'cancelled'").get(utcOf(local)).n);
          assert.equal(at(target), 1, target);
          assert.equal(at(seed), rescheduled ? 0 : 1, seed);
        }
      } finally {
        raw.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
