// AF-18 (critérios 1, 2, 6 e 10): migração 013, CHECKs, FKs, enqueueEmail, repositório e varredura.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailTestApp, seedBusiness, FRIDAY, outboxRows } from '../helpers/email.js';
import { bookingBody } from '../helpers/appointments.js';
import { bookWithLink } from '../helpers/manage.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { OUTBOX_INSERT_RE } from '../helpers/outbox-scan.js';
import { createEmailOutboxRepository } from '../../src/modules/email/email-outbox.repository.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const COLUMNS = [
  'id', 'business_id', 'kind', 'appointment_id', 'previous_appointment_id', 'status', 'attempts', 'next_attempt_at',
  'locked_until', 'last_error_code', 'created_at', 'updated_at', 'sent_at', 'maybe_delivered_at',
  // AF-03 (migração 015): alvo dos e-mails de conta, aditivo no fim.
  'user_id',
];
const T0 = '2026-11-26T12:00:00.000Z';
const iso = (ms) => new Date(ms).toISOString();
const at = (offsetMs) => iso(Date.parse(T0) + offsetMs);
const DAY = 86_400_000;

let app;
let db;
let repo;
let seed;
let apptA;
let apptB;

/** INSERT cru (fora do enqueueEmail) para testar os CHECKs e montar estados. */
async function insertRaw(over = {}) {
  const row = {
    id: randomUUID(),
    business_id: seed.business.id,
    kind: 'appointment_cancelled',
    appointment_id: apptA,
    previous_appointment_id: null,
    status: 'pending',
    attempts: 0,
    next_attempt_at: T0,
    locked_until: null,
    last_error_code: null,
    created_at: T0,
    updated_at: T0,
    sent_at: null,
    maybe_delivered_at: null,
    user_id: null,
    ...over,
  };
  await db.run(`INSERT INTO email_outbox (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`, COLUMNS.map((c) => row[c]));
  return row.id;
}

async function statusOf(id) {
  return db.get('SELECT status, attempts, last_error_code, locked_until, sent_at FROM email_outbox WHERE id = ?', [id]);
}

beforeEach(async () => {
  ({ app } = await emailTestApp());
  db = app.db;
  repo = createEmailOutboxRepository(db);
  seed = await seedBusiness(app);
  const body = (start) => bookingBody({ serviceId: seed.service.id, professionalId: seed.professionals[0].id, start });
  await bookWithLink(app, seed.slug, body(`${FRIDAY}T10:00`));
  await bookWithLink(app, seed.slug, body(`${FRIDAY}T13:00`));
  const rows = await outboxRows(db);
  [apptA, apptB] = rows.map((r) => r.appointment_id);
  await db.run('DELETE FROM email_outbox');
});
afterEach(() => app.close());

describe('migração 013 (critério 1)', () => {
  test('registrada; colunas fixas (só ids e controle); índices', async () => {
    assert.ok((await db.all('SELECT version FROM schema_migrations')).some((r) => r.version === '013_email_outbox'));
    const info = await db.all('PRAGMA table_info(email_outbox)');
    assert.deepEqual(info.map((c) => c.name), COLUMNS);
    const indexes = (await db.all('PRAGMA index_list(email_outbox)')).map((i) => i.name);
    for (const name of ['email_outbox_status_next_attempt_at_idx', 'email_outbox_status_updated_at_idx', 'email_outbox_business_id_appointment_id_idx']) {
      assert.ok(indexes.includes(name), name);
    }
    assert.ok((await db.all('PRAGMA index_list(customers)')).some((i) => i.name === 'customers_email_idx'));
  });

  test('CHECKs recusam domínio, previous incoerente, attempts, lock, sent_at e last_error_code', async () => {
    const { owner_id: owner } = await db.get('SELECT owner_id FROM businesses WHERE id = ?', [seed.business.id]);
    const bad = [
      { kind: 'appointment_reminder' },
      { status: 'queued' },
      { kind: 'appointment_rescheduled', previous_appointment_id: null },
      { kind: 'appointment_confirmed', previous_appointment_id: apptB },
      { kind: 'appointment_rescheduled', previous_appointment_id: apptA },
      { attempts: 6 },
      { attempts: -1 },
      { attempts: 'um' },
      { attempts: 1.5 },
      { status: 'sending', locked_until: null },
      { status: 'pending', locked_until: at(1) },
      { status: 'sent', sent_at: null },
      { status: 'pending', sent_at: T0 },
      { last_error_code: 'Smtp_4xx' },
      { last_error_code: 'smtp 4xx' },
      { last_error_code: 'a@b' },
      { last_error_code: 'a'.repeat(33) },
      { last_error_code: '' },
      { id: 'curto' },
      { created_at: '2026-11-26' },
      // AF-03 (email_outbox_target_check): agendamento com user_id ou sem alvo; conta com alvo de agendamento.
      { user_id: owner },
      { appointment_id: null },
      { business_id: null },
      { kind: 'password_reset', user_id: owner },
      { kind: 'password_changed', business_id: null, appointment_id: null },
      { kind: 'password_reset', business_id: null, appointment_id: null, previous_appointment_id: apptA, user_id: owner },
    ];
    for (const over of bad) await assert.rejects(insertRaw(over), /CHECK|constraint/i, JSON.stringify(over));
    for (const kind of ['password_reset', 'password_changed']) {
      await insertRaw({ kind, business_id: null, appointment_id: null, user_id: owner });
    }
    await insertRaw({ attempts: 5, last_error_code: 'a'.repeat(32) });
    await insertRaw({ kind: 'appointment_rescheduled', appointment_id: apptB, previous_appointment_id: apptA });
  });

  test('FK composta: agendamento de outro negócio recusado; apagar o negócio apaga a fila', async () => {
    const other = await seedBusiness(app, { email: 'bia@x.com', name: 'Salão da Bia' });
    await assert.rejects(insertRaw({ business_id: other.business.id }), /FOREIGN KEY/i);
    await insertRaw();
    await db.run('DELETE FROM businesses WHERE id = ?', [seed.business.id]);
    assert.equal((await outboxRows(db)).length, 0);
  });
});

describe('enqueueEmail (critérios 2 e 6)', () => {
  const e = (over = {}) => ({ kind: 'appointment_confirmed', businessId: seed.business.id, appointmentId: apptA, nowIso: T0, ...over });

  test('duas chamadas gravam uma linha (enqueued true e depois false)', async () => {
    const first = await db.transaction((tx) => enqueueEmail(tx, e()));
    const second = await db.transaction((tx) => enqueueEmail(tx, e()));
    assert.equal(first.enqueued, true);
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(second, { id: null, enqueued: false });
    const rows = await outboxRows(db);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { status: rows[0].status, attempts: rows[0].attempts, next: rows[0].next_attempt_at, created: rows[0].created_at },
      { status: 'pending', attempts: 0, next: T0, created: T0 },
    );
  });

  test('TypeError para tx ausente, kind desconhecido, id malformado, previous incoerente e nowIso inválido', async () => {
    await assert.rejects(enqueueEmail(null, e()), TypeError);
    for (const over of [
      { kind: 'appointment_reminder' },
      { businessId: 'x' },
      { appointmentId: apptA.toUpperCase() },
      { kind: 'appointment_rescheduled' },
      { previousAppointmentId: apptB },
      { kind: 'appointment_rescheduled', previousAppointmentId: apptA },
      { nowIso: '2026-11-26' },
    ]) {
      await assert.rejects(db.transaction((tx) => enqueueEmail(tx, e(over))), TypeError, JSON.stringify(over));
    }
    assert.equal((await outboxRows(db)).length, 0);
  });

  test('varredura: em src/, só enqueue-email.js contém INSERT INTO email_outbox', async () => {
    const found = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(js|sql)$/.test(entry.name) && OUTBOX_INSERT_RE.test(await readFile(path, 'utf8'))) found.push(path.slice(SRC.length + 1));
      }
    }
    await walk(SRC);
    assert.deepEqual(found, [join('modules', 'email', 'enqueue-email.js')]);
  });
});

describe('repositório (critérios 7 e 10)', () => {
  const lease = (attempts, lockedUntil = at(300_000)) => ({ attempts, lockedUntil });

  test('claim só com changes 1 em pendente vencido e em sending vencido; 0 em sending vivo, futuro e attempts = 5', async () => {
    const due = await insertRaw();
    const future = await insertRaw({ kind: 'appointment_confirmed', next_attempt_at: at(60_000) });
    const live = await insertRaw({ kind: 'appointment_rescheduled', appointment_id: apptB, previous_appointment_id: apptA, status: 'sending', attempts: 1, locked_until: at(60_000) });
    const expired = await insertRaw({ appointment_id: apptB, status: 'sending', attempts: 2, locked_until: at(-1) });
    const exhausted = await insertRaw({ kind: 'appointment_confirmed', appointment_id: apptB, status: 'sending', attempts: 5, locked_until: at(-1) });
    const args = { nowIso: T0, lockedUntil: at(300_000) };
    assert.deepEqual(new Set(await repo.findCandidates(T0, 10)), new Set([due, expired]));
    assert.equal((await repo.claim(due, args)).changes, 1);
    assert.equal((await repo.claim(due, args)).changes, 0, 'segunda reivindicação');
    assert.equal((await repo.claim(future, args)).changes, 0);
    assert.equal((await repo.claim(live, args)).changes, 0);
    assert.equal((await repo.claim(expired, args)).changes, 1);
    assert.equal((await repo.claim(exhausted, args)).changes, 0);
    assert.deepEqual(await statusOf(expired), { status: 'sending', attempts: 3, last_error_code: null, locked_until: at(300_000), sent_at: null });
  });

  test('mark* exige o arrendamento exato (locked_until e attempts)', async () => {
    const id = await insertRaw({ status: 'sending', attempts: 1, locked_until: at(300_000) });
    assert.equal((await repo.markSent(id, lease(2), T0)).changes, 0);
    assert.equal((await repo.markSent(id, lease(1, at(1)), T0)).changes, 0);
    assert.equal((await repo.markRetry(id, lease(2), { nextAttemptAt: at(1), errorCode: 'network', nowIso: T0 })).changes, 0);
    assert.equal((await repo.markFailed(id, lease(2), { errorCode: 'smtp_5xx', nowIso: T0 })).changes, 0);
    assert.equal((await repo.markSkipped(id, lease(2), { reason: 'ended', nowIso: T0 })).changes, 0);
    assert.equal((await repo.markRetry(id, lease(1), { nextAttemptAt: at(60_000), errorCode: 'network', nowIso: T0 })).changes, 1);
    assert.deepEqual(await statusOf(id), { status: 'pending', attempts: 1, last_error_code: 'network', locked_until: null, sent_at: null });
  });

  test('failExhausted e expireStale', async () => {
    const exhausted = await insertRaw({ status: 'sending', attempts: 5, locked_until: at(-1) });
    const old = await insertRaw({ kind: 'appointment_confirmed', created_at: at(-7 * DAY) });
    const young = await insertRaw({ kind: 'appointment_confirmed', appointment_id: apptB, created_at: at(-7 * DAY + 1) });
    assert.equal(await repo.failExhausted(T0), 1);
    assert.equal((await statusOf(exhausted)).last_error_code, 'lease_expired');
    assert.equal(await repo.expireStale(at(-7 * DAY), T0), 1);
    assert.deepEqual(await statusOf(old), { status: 'expired', attempts: 0, last_error_code: 'expired', locked_until: null, sent_at: null });
    assert.equal((await statusOf(young)).status, 'pending');
  });

  test('purgeTerminalAll com 1.201 linhas de 31 dias (3 lotes) mantém as de 29 dias e todas as pending', async () => {
    const old = at(-31 * DAY);
    // A FK exige agendamentos reais: 1.201 agendamentos crus, contíguos (sem sobreposição).
    const { insertAppointmentDirect, insertCustomerDirect } = await import('../helpers/appointments.js');
    await db.transaction(async (tx) => {
      const customerId = await insertCustomerDirect(tx, seed.business.id);
      for (let i = 0; i < 1201; i++) {
        const startsAt = iso(Date.parse('2027-01-04T00:00:00.000Z') + i * 3_600_000);
        const aid = await insertAppointmentDirect(tx, {
          businessId: seed.business.id, professionalId: seed.professionals[0].id, customerId, serviceId: seed.service.id, startsAt,
        });
        const status = ['sent', 'failed', 'skipped', 'expired'][i % 4];
        await tx.run(
          `INSERT INTO email_outbox (id, business_id, kind, appointment_id, status, attempts, next_attempt_at, created_at, updated_at, sent_at)
           VALUES (?, ?, 'appointment_confirmed', ?, ?, 1, ?, ?, ?, ?)`,
          [randomUUID(), seed.business.id, aid, status, old, old, old, status === 'sent' ? old : null],
        );
      }
    });
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM email_outbox')).n), 1201);
    const keep = await insertRaw({ status: 'sent', sent_at: at(-29 * DAY), updated_at: at(-29 * DAY) });
    const pending = await insertRaw({ kind: 'appointment_confirmed', updated_at: old, created_at: old });
    assert.equal(await repo.purgeTerminalAll(at(-30 * DAY), { batch: 500 }), 1201);
    const left = (await outboxRows(db)).map((r) => r.id).sort();
    assert.deepEqual(left, [keep, pending].sort());
    assert.equal(await repo.purgeTerminal(at(-30 * DAY)), 0);
  });

  test('countRecentToRecipient soma dois negócios, conta sending, ignora failed/skipped, sent de 25 h e a própria linha', async () => {
    const email = 'mesmo@example.com';
    const other = await seedBusiness(app, { email: 'bia@x.com', name: 'Salão da Bia' });
    const { insertAppointmentDirect } = await import('../helpers/appointments.js');
    const customerOf = async (businessId) => {
      const id = randomUUID();
      await db.run(
        "INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, 'Cliente', '11912345678', ?, ?, ?)",
        [id, businessId, email, T0, T0],
      );
      return id;
    };
    const cA = await customerOf(seed.business.id);
    const cB = await customerOf(other.business.id);
    const mk = (b, c, pro, svc, h) =>
      insertAppointmentDirect(db, { businessId: b, professionalId: pro, customerId: c, serviceId: svc, startsAt: `2026-12-0${h}T13:00:00.000Z` });
    const a1 = await mk(seed.business.id, cA, seed.professionals[0].id, seed.service.id, 1);
    const a2 = await mk(seed.business.id, cA, seed.professionals[0].id, seed.service.id, 2);
    const b1 = await mk(other.business.id, cB, other.professionals[0].id, other.service.id, 1);
    const b2 = await mk(other.business.id, cB, other.professionals[0].id, other.service.id, 2);
    const sent = (bid, aid, kind, sentAt) => insertRaw({ business_id: bid, appointment_id: aid, kind, status: 'sent', sent_at: sentAt, updated_at: sentAt, attempts: 1 });
    const self = await sent(seed.business.id, a1, 'appointment_confirmed', at(-1000));
    await sent(other.business.id, b1, 'appointment_confirmed', at(-23 * 3_600_000));
    await sent(other.business.id, b1, 'appointment_cancelled', at(-25 * 3_600_000));
    await insertRaw({ business_id: seed.business.id, appointment_id: a2, kind: 'appointment_confirmed', status: 'sending', attempts: 1, locked_until: at(60_000) });
    await insertRaw({ business_id: other.business.id, appointment_id: b2, kind: 'appointment_confirmed', status: 'failed', attempts: 5, last_error_code: 'network' });
    await insertRaw({ business_id: other.business.id, appointment_id: b2, kind: 'appointment_cancelled', status: 'skipped', last_error_code: 'ended' });
    const since = at(-24 * 3_600_000);
    assert.equal(await repo.countRecentToRecipient(email, { sinceIso: since, excludeId: randomUUID() }), 3);
    assert.equal(await repo.countRecentToRecipient(email, { sinceIso: since, excludeId: self }), 2);
    assert.equal(await repo.countRecentToRecipient('outro@example.com', { sinceIso: since, excludeId: self }), 0);
  });

  test('B2: tentativa que pode ter sido entregue conta no teto (pending de retry e failed), por 24 h, uma vez por linha', async () => {
    const email = 'talvez@example.com';
    const { insertAppointmentDirect } = await import('../helpers/appointments.js');
    const cid = randomUUID();
    await db.run(
      "INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, 'Cliente', '11912345678', ?, ?, ?)",
      [cid, seed.business.id, email, T0, T0],
    );
    const appts = [];
    for (let h = 1; h <= 4; h++) {
      appts.push(
        await insertAppointmentDirect(db, { businessId: seed.business.id, professionalId: seed.professionals[0].id, customerId: cid, serviceId: seed.service.id, startsAt: `2026-12-0${h}T15:00:00.000Z` }),
      );
    }
    const since = at(-24 * 3_600_000);
    const count = () => repo.countRecentToRecipient(email, { sinceIso: since, excludeId: randomUUID() });
    // Retry pendente com tentativa talvez entregue há 1 h; failed há 2 h; failed sem a marca; marca de 25 h.
    await insertRaw({ appointment_id: appts[0], kind: 'appointment_confirmed', status: 'pending', attempts: 1, last_error_code: 'send_timeout', maybe_delivered_at: at(-3_600_000) });
    await insertRaw({ appointment_id: appts[1], kind: 'appointment_confirmed', status: 'failed', attempts: 5, last_error_code: 'network', maybe_delivered_at: at(-7_200_000) });
    await insertRaw({ appointment_id: appts[2], kind: 'appointment_confirmed', status: 'failed', attempts: 5, last_error_code: 'network' });
    await insertRaw({ appointment_id: appts[3], kind: 'appointment_confirmed', status: 'failed', attempts: 5, last_error_code: 'network', maybe_delivered_at: at(-25 * 3_600_000) });
    assert.equal(await count(), 2);
    // Enviada depois de um talvez-entregue: continua uma linha só.
    await insertRaw({ appointment_id: appts[0], kind: 'appointment_cancelled', status: 'sent', attempts: 2, sent_at: at(-60_000), updated_at: at(-60_000), maybe_delivered_at: at(-120_000) });
    assert.equal(await count(), 3);
  });

  test('B2: markRetry/markFailed com maybeDelivered, reivindicação de sending vencido, failExhausted e expireStale de sending marcam a linha', async () => {
    const mark = async (id) => (await db.get('SELECT maybe_delivered_at AS m FROM email_outbox WHERE id = ?', [id])).m;
    const lease = (n) => ({ lockedUntil: at(300_000), attempts: n });
    const r1 = await insertRaw({ kind: 'appointment_confirmed', appointment_id: apptA });
    assert.equal((await repo.claim(r1, { nowIso: T0, lockedUntil: at(300_000) })).changes, 1);
    assert.equal(await mark(r1), null, 'pendente reivindicado: nada');
    await repo.markRetry(r1, lease(1), { nextAttemptAt: at(60_000), errorCode: 'network', nowIso: T0 });
    assert.equal(await mark(r1), null, 'retry sem maybeDelivered: nada');
    assert.equal((await repo.claim(r1, { nowIso: at(60_000), lockedUntil: at(360_000) })).changes, 1);
    await repo.markRetry(r1, { lockedUntil: at(360_000), attempts: 2 }, { nextAttemptAt: at(120_000), errorCode: 'send_timeout', nowIso: at(60_000), maybeDelivered: true });
    assert.equal(await mark(r1), at(60_000));
    // Queda com a linha em sending: a recuperação marca.
    const r2 = await insertRaw({ kind: 'appointment_confirmed', appointment_id: apptB, status: 'sending', attempts: 1, locked_until: at(-1) });
    assert.equal((await repo.claim(r2, { nowIso: T0, lockedUntil: at(300_000) })).changes, 1);
    assert.equal(await mark(r2), T0);
    await repo.markFailed(r2, { lockedUntil: at(300_000), attempts: 2 }, { errorCode: 'network', nowIso: at(1000), maybeDelivered: true });
    assert.equal(await mark(r2), at(1000));
    const r3 = await insertRaw({ kind: 'appointment_cancelled', appointment_id: apptB, status: 'sending', attempts: 5, locked_until: at(-1) });
    assert.equal(await repo.failExhausted(T0), 1);
    assert.equal(await mark(r3), T0);
    const r4 = await insertRaw({ kind: 'appointment_cancelled', appointment_id: apptA, status: 'sending', attempts: 1, locked_until: at(-1), created_at: at(-8 * DAY) });
    assert.equal(await repo.expireStale(at(-7 * DAY), T0), 1);
    assert.equal(await mark(r4), T0);
  });
});
