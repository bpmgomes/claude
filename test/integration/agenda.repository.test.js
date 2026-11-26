// AF-14 (design 3.2, 4.3 e 6.1, critérios 3, 4, 7, 10, 11 e 14): consultas da agenda no repositório.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { signupAndLogin, createBusinessFor } from '../helpers/session.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { insertServiceDirect, insertProfessionalDirect } from '../helpers/agenda.js';
import { AGENDA_NOT_CANCELLED_STATUSES } from '../../src/modules/appointments/appointments.repository.js';
import { APPOINTMENT_STATUSES } from '../../src/shared/appointments.js';

// Dia local 27/11/2026 em São Paulo (UTC−3): [03:00Z do dia 27, 03:00Z do dia 28).
const D27 = '2026-11-27T03:00:00.000Z';
const D28 = '2026-11-28T03:00:00.000Z';
const D29 = '2026-11-29T03:00:00.000Z';

let app;
let repo;
let biz;
let other;

async function makeBusiness(email) {
  const cookies = await signupAndLogin(app, { email });
  const business = await createBusinessFor(app, cookies, { name: `Negócio ${email}` });
  const serviceId = await insertServiceDirect(app.db, business.id);
  const customerId = await insertCustomerDirect(app.db, business.id);
  const ana = await insertProfessionalDirect(app.db, business.id, 'Ana');
  const bia = await insertProfessionalDirect(app.db, business.id, 'Bia');
  const add = (professionalId, startsAt, over = {}) =>
    insertAppointmentDirect(app.db, { businessId: business.id, professionalId, customerId, serviceId, startsAt, durationMinutes: 30, ...over });
  return { business, serviceId, customerId, ana, bia, add };
}

beforeEach(async () => {
  ({ app } = await buildTestApp());
  repo = app.services.appointmentsRepository;
  biz = await makeBusiness('a@x.com');
  other = await makeBusiness('b@x.com');
});
afterEach(() => app.close());

const list = (over = {}) => repo.listForAgenda(biz.business.id, { fromIso: D27, toIso: D28, limit: 100, ...over });

describe('listForAgenda', () => {
  test('início em [from, to): 23:45 do dia anterior com fim depois de from fora; 23:30 que cruza a meia-noite dentro', async () => {
    const before = await biz.add(biz.ana, '2026-11-27T02:45:00.000Z'); // 26/11 23:45 local, termina 00:15
    const crossing = await biz.add(biz.bia, '2026-11-28T02:30:00.000Z', { durationMinutes: 60 }); // 27/11 23:30 local
    const first = await biz.add(biz.bia, D27);
    const next = await biz.add(biz.ana, D28);
    const ids = (await list()).map((r) => r.id);
    assert.deepEqual(ids, [first, crossing]);
    assert.ok(!ids.includes(before) && !ids.includes(next));
    const row = (await list()).find((r) => r.id === crossing);
    assert.equal(row.endsAt, '2026-11-28T03:30:00.000Z');
  });

  test('ordem por starts_at, name_key e id; limit; filtro de profissional; outro negócio nunca', async () => {
    const at = '2026-11-27T13:00:00.000Z';
    const b1 = await biz.add(biz.bia, at);
    const a1 = await biz.add(biz.ana, at);
    const a0 = await biz.add(biz.ana, '2026-11-27T12:00:00.000Z');
    await other.add(other.ana, at);
    assert.deepEqual((await list()).map((r) => r.id), [a0, a1, b1]);
    assert.deepEqual((await list({ limit: 2 })).map((r) => r.id), [a0, a1]);
    assert.deepEqual((await list({ professionalId: biz.bia })).map((r) => r.id), [b1]);
    assert.deepEqual(await list({ professionalId: other.ana }), []);
    const r = (await list())[0];
    assert.deepEqual(Object.keys(r).sort(), [
      'cancelledAt', 'cancelledBy', 'customerName', 'endsAt', 'id', 'professionalId', 'professionalName', 'professionalNameKey',
      'professionalRemoved', 'serviceName', 'startsAt', 'status', 'updatedAt',
    ]);
  });

  test('cancelados só com includeCancelled; removido com professionalRemoved', async () => {
    const live = await biz.add(biz.ana, '2026-11-27T12:00:00.000Z');
    const gone = await biz.add(biz.bia, '2026-11-27T13:00:00.000Z', { status: 'cancelled', cancelledAt: '2026-11-26T12:00:00.000Z' });
    await app.db.run("UPDATE appointments SET cancelled_by = 'customer' WHERE id = ?", [gone]);
    await app.db.run("UPDATE professionals SET removed_at = '2026-11-26T12:00:00.000Z' WHERE id = ?", [biz.ana]);
    assert.deepEqual((await list()).map((r) => r.id), [live]);
    const all = await list({ includeCancelled: true });
    assert.deepEqual(all.map((r) => r.id), [live, gone]);
    assert.equal(all[0].professionalRemoved, true);
    assert.equal(all[0].professionalName, 'Ana');
    assert.equal(all[1].cancelledBy, 'customer');
    assert.equal(all[1].professionalRemoved, false);
  });
});

describe('countForAgenda', () => {
  test('três classes por dia, dias zerados, filtro de profissional e outro negócio fora', async () => {
    await biz.add(biz.ana, '2026-11-27T12:00:00.000Z');
    await biz.add(biz.bia, '2026-11-27T12:00:00.000Z', { status: 'completed' });
    const c1 = await biz.add(biz.ana, '2026-11-27T14:00:00.000Z', { status: 'cancelled' });
    const c2 = await biz.add(biz.ana, '2026-11-27T15:00:00.000Z', { status: 'cancelled' });
    const r1 = await biz.add(biz.bia, '2026-11-27T16:00:00.000Z', { status: 'cancelled' });
    await app.db.run("UPDATE appointments SET cancelled_by = 'owner' WHERE id = ?", [c1]);
    await app.db.run("UPDATE appointments SET cancelled_by = 'reschedule' WHERE id = ?", [r1]);
    await biz.add(biz.ana, '2026-11-29T12:00:00.000Z', { status: 'no_show' });
    await other.add(other.ana, '2026-11-27T12:00:00.000Z');
    const boundaries = [D27, D28, D29, '2026-11-30T03:00:00.000Z'];
    assert.deepEqual(await repo.countForAgenda(biz.business.id, { boundaries }), [
      { active: 2, cancelled: 2, rescheduled: 1 },
      { active: 0, cancelled: 0, rescheduled: 0 },
      { active: 1, cancelled: 0, rescheduled: 0 },
    ]);
    assert.deepEqual(await repo.countForAgenda(biz.business.id, { boundaries, professionalId: biz.bia }), [
      { active: 1, cancelled: 0, rescheduled: 1 },
      { active: 0, cancelled: 0, rescheduled: 0 },
      { active: 0, cancelled: 0, rescheduled: 0 },
    ]);
    assert.deepEqual(await repo.countForAgenda(biz.business.id, { boundaries: [D27, D28] }), [{ active: 2, cancelled: 2, rescheduled: 1 }]);
    void c2;
    await assert.rejects(repo.countForAgenda(biz.business.id, { boundaries: [D27] }), RangeError);
  });
});

describe('EXPLAIN QUERY PLAN (critério 14, R12)', () => {
  test('lista e contagens nas quatro variantes: índice (business_id, starts_at), sem SCAN a e sem índice parcial', async () => {
    // Volume para o planejador ter estatística parecida com a real.
    for (let i = 0; i < 40; i++) await biz.add(i % 2 ? biz.ana : biz.bia, new Date(Date.parse(D27) + i * 3_600_000).toISOString());
    await app.db.exec('ANALYZE');
    const captured = [];
    const spy = {
      all: async (sql, params) => {
        captured.push({ sql, params });
        return [];
      },
    };
    for (const professionalId of [null, biz.ana]) {
      for (const includeCancelled of [false, true]) {
        await repo.listForAgenda(biz.business.id, { fromIso: D27, toIso: D28, professionalId, includeCancelled, limit: 10 }, spy);
      }
      await repo.countForAgenda(biz.business.id, { boundaries: [D27, D28, D29], professionalId }, spy);
    }
    assert.equal(captured.length, 6);
    for (const { sql, params } of captured) {
      assert.doesNotMatch(sql, /<> 'cancelled'/);
      assert.doesNotMatch(sql, /\bIN \(\?/, 'sem IN (...) de ids');
      const plan = (await app.db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((r) => r.detail).join('\n');
      assert.match(plan, /appointments_business_id_starts_at_idx/, plan);
      assert.doesNotMatch(plan, /SCAN a\b(?! USING)/, plan);
      assert.doesNotMatch(plan, /active_idx|starts_at_unique/, plan);
    }
  });

  test('a lista de não cancelados é derivada dos status', () => {
    assert.deepEqual([...AGENDA_NOT_CANCELLED_STATUSES], APPOINTMENT_STATUSES.filter((s) => s !== 'cancelled'));
  });
});

describe('cancelIfConfirmed com cancelledBy (critério 11)', () => {
  test('cada origem grava; ausente grava NULL; valor fora da lista lança TypeError sem gravar', async () => {
    const nowIso = '2026-11-26T12:00:00.000Z';
    for (const [i, by] of ['customer', 'owner', 'reschedule', undefined].entries()) {
      const id = await biz.add(biz.ana, new Date(Date.parse(D27) + (i + 1) * 3_600_000).toISOString());
      const opts = by === undefined ? undefined : { cancelledBy: by };
      const { changes } = await repo.cancelIfConfirmed(id, biz.business.id, nowIso, app.db, opts);
      assert.equal(changes, 1);
      const row = await repo.findById(id, biz.business.id);
      assert.equal(row.status, 'cancelled');
      assert.equal(row.cancelledBy, by ?? null);
      assert.equal(row.professionalRemoved, false);
    }
    const id = await biz.add(biz.bia, D27);
    await assert.rejects(repo.cancelIfConfirmed(id, biz.business.id, nowIso, app.db, { cancelledBy: 'admin' }), TypeError);
    assert.equal((await repo.findById(id, biz.business.id)).status, 'confirmed');
  });
});
