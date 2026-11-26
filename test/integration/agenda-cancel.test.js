// AF-14 (design 5.3 e 6.1, critérios 21 a 30): cancelamento pelo dono.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  agendaApp,
  secondBusiness,
  bookReal,
  cancelAgenda,
  getAgendaAppointment,
  agendaVersionOf,
  assertDetailTree,
  snapshotTables,
  changedTables,
  spUtc,
} from '../helpers/agenda.js';
import { insertAppointmentDirect, insertCustomerDirect, postAppointment, bookingBody } from '../helpers/appointments.js';
import { getManage, cancelManage, rescheduleManage, versionOf, tokensOf } from '../helpers/manage.js';
import { getAvailability } from '../helpers/session.js';
import { outboxRows, drain } from '../helpers/email.js';
import { instrumentDb } from '../helpers/instrumented-db.js';
import { createAgendaService } from '../../src/modules/agenda/agenda.service.js';
import { createAppointmentsRepository } from '../../src/modules/appointments/appointments.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createTimeBlocksRepository } from '../../src/modules/time-blocks/time-blocks.repository.js';
import { createCustomersRepository } from '../../src/modules/customers/customers.repository.js';
import { createManageTokensRepository } from '../../src/modules/appointments/manage-tokens.repository.js';
import { createReschedulesRepository } from '../../src/modules/appointments/reschedules.repository.js';
import { createMemoryMailTransport } from '../../src/modules/email/transports/memory.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { AGENDA_MESSAGES as M } from '../../src/shared/agenda.js';

const FRI = '2026-11-27';
const NOW = '2026-11-26T12:00:00.000Z';
let ctx;

const row = (id) => ctx.app.db.get('SELECT status, cancelled_at, cancelled_by, updated_at FROM appointments WHERE id = ?', [id]);
const v = (id) => agendaVersionOf(ctx.app, ctx.business.id, id);
const cancel = async (id, opts) => cancelAgenda(ctx.app, ctx.cookies, id, opts ?? { version: await v(id) });

/** Serviço com repositórios de um `db` dado e dependências trocadas. */
function serviceWith(db, patch = {}) {
  return createAgendaService({
    db,
    businessesRepository: createBusinessesRepository(db),
    professionalsRepository: createProfessionalsRepository(db),
    appointmentsRepository: createAppointmentsRepository(db),
    timeBlocksRepository: createTimeBlocksRepository(db),
    customersRepository: createCustomersRepository(db),
    manageTokensRepository: createManageTokensRepository(db),
    reschedulesRepository: createReschedulesRepository(db),
    emailEnabled: true,
    now: () => new Date(NOW),
    log: ctx.app.log,
    ...patch,
  });
}

/** Agendamento direto (status/horário livres) no profissional `pro`. */
async function direct(local, { status, pro = 0, durationMinutes = 60 } = {}) {
  const customerId = await insertCustomerDirect(ctx.app.db, ctx.business.id);
  return insertAppointmentDirect(ctx.app.db, {
    businessId: ctx.business.id,
    professionalId: ctx.pros[pro].id,
    customerId,
    serviceId: ctx.service.id,
    startsAt: spUtc(local),
    durationMinutes,
    status,
  });
}

describe('sucesso, regra e repetição (critérios 21 a 24)', () => {
  beforeEach(async () => {
    ctx = await agendaApp({ mailTransport: createMemoryMailTransport(), email: { worker: { enabled: true, intervalMs: 15_000 } } });
  });
  afterEach(() => ctx.app.close());

  test('200 cancelled: status, cancelled_at = agora, cancelled_by owner, tokens revogados, uma linha na fila, link mostra cancelado', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    const res = await cancel(b.id);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assertDetailTree(body, { withOutcome: true });
    assert.equal(body.outcome, 'cancelled');
    assert.equal(body.emailEnabled, true);
    assert.equal(body.appointment.status, 'cancelled');
    assert.deepEqual(body.appointment.cancelled, { by: 'owner', at: '2026-11-26T09:00' });
    assert.equal(body.appointment.canCancel, false);
    assert.deepEqual(await row(b.id), { status: 'cancelled', cancelled_at: NOW, cancelled_by: 'owner', updated_at: NOW });
    const tokens = await tokensOf(ctx.app.db, b.id);
    assert.ok(tokens.length >= 1);
    for (const t of tokens) assert.deepEqual([t.revoked_at, t.revoked_reason], [NOW, 'cancelled']);
    const owner = await outboxRows(ctx.app.db, { kind: 'appointment_cancelled_by_owner' });
    assert.equal(owner.length, 1);
    assert.equal(owner[0].status, 'pending');
    assert.equal(owner[0].appointment_id, b.id);
    const manage = await getManage(ctx.app, b.token);
    assert.equal(manage.statusCode, 200);
    assert.equal(manage.json().appointment.status, 'cancelled');
    // R6: o cliente que cancela pelo link depois do dono recebe o 200 de repetição do AF-12, sem gravar.
    const before = await snapshotTables(ctx.app.db);
    const late = await cancelManage(ctx.app, b.token, { version: manage.json().change.version });
    assert.equal(late.statusCode, 200, late.body);
    assert.equal(late.json().appointment.status, 'cancelled');
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), []);
  });

  test('emailEnabled falso com transporte none', async () => {
    await ctx.app.close();
    ctx = await agendaApp({ email: { transport: 'none' } });
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    const res = await cancel(b.id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().emailEnabled, false);
    assert.equal((await outboxRows(ctx.app.db, { kind: 'appointment_cancelled_by_owner' })).length, 1, 'a fila é gravada mesmo assim');
  });

  test('regra: em andamento e a 10 min do início com antecedência 120 dão 200; encerrado, completed e no_show dão 409', async () => {
    assert.equal(ctx.business.cancellationLeadMinutes, 120);
    const ongoing = await direct('2026-11-26T08:30');
    const soon = await direct('2026-11-26T09:10', { pro: 1 });
    assert.equal((await cancel(ongoing)).statusCode, 200);
    assert.equal((await cancel(soon)).statusCode, 200);
    for (const id of [await direct('2026-11-26T07:00'), await direct(`${FRI}T10:00`, { status: 'completed' }), await direct(`${FRI}T12:00`, { status: 'no_show' })]) {
      const before = await snapshotTables(ctx.app.db);
      const res = await cancel(id);
      assert.equal(res.statusCode, 409, res.body);
      assert.deepEqual(res.json().error, { code: 'APPOINTMENT_NOT_CHANGEABLE', message: M.notChangeable });
      assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), []);
    }
    assert.match(ctx.logs(), /"event":"appointment_owner_cancel_refused".*"reason":"ended"/);
  });

  test('repetição: 200 unchanged sem gravar; cancelado pelo cliente: unchanged com by customer; antigo de remarcação: 409', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    const version = await v(b.id);
    assert.equal((await cancel(b.id, { version })).statusCode, 200);
    const before = await snapshotTables(ctx.app.db);
    const again = await cancel(b.id, { version });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().outcome, 'unchanged');
    assert.equal(again.json().appointment.cancelled.by, 'owner');
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), []);

    const c = await bookReal(ctx.app, ctx, { start: `${FRI}T11:00` });
    assert.equal((await cancelManage(ctx.app, c.token, { version: await versionOf(ctx.app, c.token) })).statusCode, 200);
    const snap = await snapshotTables(ctx.app.db);
    const byCustomer = await cancel(c.id);
    assert.equal(byCustomer.statusCode, 200);
    assert.equal(byCustomer.json().outcome, 'unchanged');
    assert.equal(byCustomer.json().appointment.cancelled.by, 'customer');
    assert.deepEqual(changedTables(snap, await snapshotTables(ctx.app.db)), []);
    assert.equal((await outboxRows(ctx.app.db, { appointment_id: c.id, kind: 'appointment_cancelled_by_owner' })).length, 0);

    const r = await bookReal(ctx.app, ctx, { start: `${FRI}T13:00` });
    assert.equal((await rescheduleManage(ctx.app, r.token, { start: `${FRI}T14:00`, version: await versionOf(ctx.app, r.token) })).statusCode, 200);
    for (const by of ['reschedule', null]) {
      await ctx.app.db.run('UPDATE appointments SET cancelled_by = ? WHERE id = ?', [by, r.id]);
      const res = await cancel(r.id);
      assert.equal(res.statusCode, 409, `${by}: ${res.body}`);
      assert.deepEqual(res.json().error, { code: 'APPOINTMENT_CHANGED', message: M.changed });
    }
  });

  test('version: ausente, número, 42 e 44 caracteres dão 400; diferente dá 409 APPOINTMENT_CHANGED', async () => {
    const id = await direct(`${FRI}T10:00`);
    for (const payload of [undefined, {}, { version: 42 }, { version: 'a'.repeat(42) }, { version: 'a'.repeat(44) }, [], '"texto"']) {
      const opts = payload === undefined ? {} : typeof payload === 'string' ? { payload, headers: { 'content-type': 'application/json' } } : { payload };
      const res = await cancelAgenda(ctx.app, ctx.cookies, id, opts);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.deepEqual(res.json().error, { code: 'VALIDATION_ERROR', message: M.badRequest });
    }
    const old = await v(id);
    await ctx.app.db.run("UPDATE appointments SET updated_at = '2026-11-26T11:59:00.000Z' WHERE id = ?", [id]);
    const res = await cancel(id, { version: old });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'APPOINTMENT_CHANGED');
    assert.equal((await row(id)).status, 'confirmed');
  });

  test('ordem: :id malformado antes da version; JSON malformado 400; 413; 415; __proto__ e extras sem efeito; CSRF 403 sem tocar no banco', async () => {
    const id = await direct(`${FRI}T10:00`);
    const bad = await cancelAgenda(ctx.app, ctx.cookies, 'nao-e-uuid', { payload: { nada: 1 } });
    assert.equal(bad.statusCode, 404);
    assert.equal(bad.json().error.code, 'APPOINTMENT_NOT_FOUND');
    const malformed = await cancelAgenda(ctx.app, ctx.cookies, id, { payload: '{"version":', headers: { 'content-type': 'application/json' } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'VALIDATION_ERROR');
    assert.equal((await cancelAgenda(ctx.app, ctx.cookies, id, { payload: { version: await v(id), pad: 'x'.repeat(17_000) } })).statusCode, 413);
    assert.equal((await cancelAgenda(ctx.app, ctx.cookies, id, { payload: 'version', headers: { 'content-type': 'text/plain' } })).statusCode, 415);
    const before = await snapshotTables(ctx.app.db);
    const csrf = await cancelAgenda(ctx.app, ctx.cookies, id, { version: await v(id), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(csrf.statusCode, 403);
    assert.equal(csrf.json().error.code, 'FORBIDDEN_ORIGIN');
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), []);
    // `__proto__`: o parser do Fastify recusa (400 "Requisição inválida."), como no AF-11/12; nada muda.
    const proto = await cancelAgenda(ctx.app, ctx.cookies, id, {
      payload: `{"version":"${await v(id)}","__proto__":{"status":"x"}}`,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(proto.statusCode, 400, proto.body);
    assert.equal((await row(id)).status, 'confirmed');
    const extras = await cancelAgenda(ctx.app, ctx.cookies, id, {
      payload: { version: await v(id), businessId: randomUUID(), cancelledBy: 'customer', status: 'confirmed' },
    });
    assert.equal(extras.statusCode, 200, extras.body);
    assert.equal((await row(id)).cancelled_by, 'owner');
  });

  test('isolamento: :id de outro negócio dá 404 e nada muda', async () => {
    const other = await secondBusiness(ctx.app);
    const foreign = await bookReal(ctx.app, other, { start: `${FRI}T10:00` });
    const version = await agendaVersionOf(ctx.app, other.business.id, foreign.id);
    const before = await snapshotTables(ctx.app.db);
    const res = await cancelAgenda(ctx.app, ctx.cookies, foreign.id, { version });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json().error, { code: 'APPOINTMENT_NOT_FOUND', message: M.notFound });
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), []);
    assert.equal((await getAgendaAppointment(ctx.app, ctx.cookies, foreign.id)).statusCode, 404);
  });

  test('nada mais muda: só appointments, appointment_manage_tokens e email_outbox diferem', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    const before = await snapshotTables(ctx.app.db);
    assert.equal((await cancel(b.id)).statusCode, 200);
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), ['appointment_manage_tokens', 'appointments', 'email_outbox']);
    const counts = await ctx.app.db.get('SELECT (SELECT COUNT(*) FROM appointments) AS a, (SELECT COUNT(*) FROM time_blocks) AS t, (SELECT COUNT(*) FROM customers) AS c');
    assert.deepEqual(counts, { a: 1, t: 0, c: 1 });
  });
});

describe('atomicidade e só tx (critério 23)', () => {
  beforeEach(async () => {
    ctx = await agendaApp();
  });
  afterEach(() => ctx.app.close());

  let hour = 9;
  async function expect503(patchOf, label) {
    hour += 1;
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T${String(hour === 12 ? (hour = 13) : hour).padStart(2, '0')}:00` });
    const version = await v(b.id);
    const before = await snapshotTables(ctx.app.db);
    ctx.app.services.agendaService = serviceWith(ctx.app.db, patchOf(ctx.app.db));
    const res = await cancel(b.id, { version });
    assert.equal(res.statusCode, 503, `${label}: ${res.body}`);
    assert.deepEqual(res.json().error, { code: 'AGENDA_UNAVAILABLE', message: M.cancelUnavailable });
    assert.deepEqual(changedTables(before, await snapshotTables(ctx.app.db)), [], label);
    return b;
  }

  test('enqueueEmail que lança, revokeForAppointment que lança, cancelIfConfirmed TypeError e SQLITE_BUSY: 503 e nada gravado', async () => {
    await expect503(() => ({ enqueueEmail: async () => { throw new TypeError('kind'); } }), 'enqueueEmail');
    await expect503((db) => ({ manageTokensRepository: { ...createManageTokensRepository(db), revokeForAppointment: async () => { throw new Error('x'); } } }), 'revoke');
    await expect503((db) => {
      const repo = createAppointmentsRepository(db);
      return { appointmentsRepository: { ...repo, cancelIfConfirmed: (id, b, n, tx) => repo.cancelIfConfirmed(id, b, n, tx, { cancelledBy: 'admin' }) } };
    }, 'cancelledBy inválido');
    await expect503((db) => {
      const repo = createAppointmentsRepository(db);
      return {
        enqueueEmail: async (tx, e) => {
          await enqueueEmail(tx, e);
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
        appointmentsRepository: repo,
      };
    }, 'SQLITE_BUSY depois da fila');
    assert.match(ctx.logs(), /"event":"agenda_failed","operation":"cancel","errCode":"SQLITE_BUSY"/);
  });

  test('cancelIfConfirmed com changes 0 (PostgreSQL): releitura decide repetição, 409 CHANGED ou 409 NOT_CHANGEABLE, sem revogar nem enfileirar', async () => {
    const scenarios = [
      ['confirmed ainda (nada explica)', null, 409, 'APPOINTMENT_NOT_CHANGEABLE'],
      ['cancelado pelo cliente no meio', 'customer', 200, 'unchanged'],
      ['remarcado no meio', 'reschedule', 409, 'APPOINTMENT_CHANGED'],
    ];
    for (const [label, by, status, expected] of scenarios) {
      const b = await bookReal(ctx.app, ctx, { start: `${FRI}T${String(9 + scenarios.findIndex((s) => s[0] === label)).padStart(2, '0')}:00` });
      const version = await v(b.id);
      let next = null;
      if (by === 'reschedule') {
        next = await insertAppointmentDirect(ctx.app.db, { businessId: ctx.business.id, professionalId: ctx.pros[1].id, customerId: (await ctx.app.db.get('SELECT customer_id FROM appointments WHERE id = ?', [b.id])).customer_id, serviceId: ctx.service.id, startsAt: spUtc(`${FRI}T16:00`) });
      }
      const repo = createAppointmentsRepository(ctx.app.db);
      ctx.app.services.agendaService = serviceWith(ctx.app.db, {
        appointmentsRepository: {
          ...repo,
          cancelIfConfirmed: async (id, businessId, nowIso, tx) => {
            // Simula o vencedor concorrente: grava o estado dele e devolve 0 linhas.
            if (by) {
              await tx.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ?, cancelled_by = ? WHERE id = ?", [nowIso, nowIso, by, id]);
              if (next) await tx.run('INSERT INTO appointment_reschedules (business_id, previous_appointment_id, appointment_id, sequence, created_at) VALUES (?, ?, ?, 1, ?)', [businessId, id, next, nowIso]);
            }
            return { changes: 0 };
          },
        },
      });
      const res = await cancel(b.id, { version });
      assert.equal(res.statusCode, status, `${label}: ${res.body}`);
      if (status === 200) assert.equal(res.json().outcome, expected);
      else assert.equal(res.json().error.code, expected);
      assert.ok((await tokensOf(ctx.app.db, b.id)).every((t) => t.revoked_at === null), `${label}: nenhuma revogação`);
      assert.equal((await outboxRows(ctx.app.db, { kind: 'appointment_cancelled_by_owner' })).length, 0, label);
      ctx.app.services.agendaService = serviceWith(ctx.app.db);
    }
  });

  test('só tx: com o banco instrumentado, nenhuma consulta no db global dentro da transação (sucesso e repetição)', async () => {
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    const idb = instrumentDb(ctx.app.db);
    ctx.app.services.agendaService = serviceWith(idb);
    const version = await v(b.id);
    const res = await cancel(b.id, { version });
    assert.equal(res.statusCode, 200, res.body);
    const again = await cancel(b.id, { version });
    assert.equal(again.statusCode, 200, again.body);
    const inTx = idb.sqlOf((c) => c.inTx);
    assert.ok(inTx.some((s) => s.startsWith('UPDATE appointments SET status')));
    const writes = inTx.filter((s) => /^(UPDATE|INSERT|DELETE)/.test(s));
    assert.deepEqual(writes.map((s) => s.split(' ').slice(0, 3).join(' ')), ['UPDATE appointments SET', 'UPDATE appointment_manage_tokens SET', 'INSERT INTO email_outbox'], 'ordem de travas, fila por último');
  });
});

describe('efeitos (critérios 24, 27 e 28)', () => {
  afterEach(() => ctx.app.close());

  test('o horário volta na disponibilidade pública; o cliente com 3 futuros reserva de novo; confirmed pendente vira not_confirmed', async () => {
    const transport = createMemoryMailTransport();
    ctx = await agendaApp({ mailTransport: transport, email: { worker: { enabled: true, intervalMs: 15_000 } } });
    const customer = { name: 'Três Vezes', phone: '(11) 95555-0001', email: 'tres@example.com' };
    const ids = [];
    for (const h of ['09:00', '10:00', '11:00']) ids.push((await bookReal(ctx.app, ctx, { start: `${FRI}T${h}`, customer })).id);
    const fourth = bookingBody({ serviceId: ctx.service.id, professionalId: ctx.pros[0].id, start: `${FRI}T14:00`, customer });
    assert.equal((await postAppointment(ctx.app, ctx.business.slug, fourth, { remoteAddress: '10.7.0.1' })).json().error.code, 'BOOKING_LIMIT_REACHED');
    const slots = async () =>
      (await getAvailability(ctx.app, ctx.business.slug, { serviceId: ctx.service.id, professionalId: ctx.pros[0].id, from: FRI, to: FRI })).json().days.find((d) => d.date === FRI).slots.map((s) => s.start);
    assert.ok(!(await slots()).includes(`${FRI}T10:00`));
    assert.equal((await cancel(ids[1])).statusCode, 200);
    assert.ok((await slots()).includes(`${FRI}T10:00`));
    assert.equal((await postAppointment(ctx.app, ctx.business.slug, fourth, { remoteAddress: '10.7.0.2' })).statusCode, 201);

    await drain(ctx.app);
    const rows = await outboxRows(ctx.app.db, { appointment_id: ids[1] });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    assert.equal(byKind.appointment_confirmed.status, 'skipped');
    assert.equal(byKind.appointment_confirmed.last_error_code, 'not_confirmed');
    assert.equal(byKind.appointment_cancelled_by_owner.status, 'sent');
    const toCustomer = transport.messages.filter((m) => m.to === 'tres@example.com' && /estabelecimento/.test(m.subject));
    assert.equal(toCustomer.length, 1);
  });

  test('o envio nunca bloqueia: transporte travado com o worker enviando, 200 no mesmo tempo', async () => {
    let released = false;
    const waiting = [];
    const release = () => {
      released = true;
      for (const r of waiting.splice(0)) r();
    };
    let sends = 0;
    const stuck = {
      send: () => {
        sends += 1;
        return released ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve));
      },
      close: async () => release(),
    };
    ctx = await agendaApp({ mailTransport: stuck, email: { worker: { enabled: true, intervalMs: 15_000 } } });
    const first = await bookReal(ctx.app, ctx, { start: `${FRI}T09:00` });
    const b = await bookReal(ctx.app, ctx, { start: `${FRI}T10:00` });
    void first;
    const cycle = ctx.app.services.emailWorker.runOnce(); // fica preso no envio da confirmação
    while (sends === 0) await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    const res = await cancel(b.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    release();
    await cycle;
  });
});
