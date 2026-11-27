// AF-12: migração 012, CHECKs, FKs compostas e os repositórios de tokens e da cadeia de remarcações.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from '../helpers/session.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CANCELLATION_LEAD_DEFAULT_MINUTES } from '../../src/shared/validation.js';
import { createManageTokensRepository } from '../../src/modules/appointments/manage-tokens.repository.js';
import { createReschedulesRepository } from '../../src/modules/appointments/reschedules.repository.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'migrations');
const NOW = '2026-11-26T12:00:00.000Z';
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

let app;
let business;
let other;
let a1;
let a2;
let otherAppointment;
let tokens;
let reschedules;

async function seedBusiness(email, name) {
  const cookies = await signupAndLogin(app, { email });
  const b = await createBusinessFor(app, cookies, { name });
  const service = await createService(app, cookies, { name: 'Corte', durationMinutes: 60 });
  const pro = await createProfessional(app, cookies, { name: 'Ana Souza', serviceIds: [service.id] });
  assert.equal((await putHours(app, cookies, pro.id, WEEK_9_TO_18)).statusCode, 200);
  const customerId = await insertCustomerDirect(app.db, b.id);
  const base = { businessId: b.id, professionalId: pro.id, customerId, serviceId: service.id };
  return { ...b, base };
}

async function setup() {
  ({ app } = await buildTestApp({ now: createClock(NOW).now }));
  business = await seedBusiness('ana@x.com', 'Salão da Ana');
  other = await seedBusiness('bia@x.com', 'Barbearia da Bia');
  a1 = await insertAppointmentDirect(app.db, { ...business.base, startsAt: '2026-11-27T13:00:00.000Z' });
  a2 = await insertAppointmentDirect(app.db, { ...business.base, startsAt: '2026-11-27T15:00:00.000Z' });
  otherAppointment = await insertAppointmentDirect(app.db, { ...other.base, startsAt: '2026-11-27T13:00:00.000Z' });
  tokens = createManageTokensRepository(app.db);
  reschedules = createReschedulesRepository(app.db);
}

const tokenRow = (over = {}) => ({
  tokenHash: hash(randomUUID()),
  businessId: business.id,
  appointmentId: a1,
  createdAt: NOW,
  expiresAt: '2026-11-27T14:00:00.000Z',
  ...over,
});

describe('migração 012 (critérios 1 e 5)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('registrada; colunas novas; DEFAULT 120 igual à constante', async () => {
    const versions = (await app.db.all('SELECT version FROM schema_migrations')).map((r) => r.version);
    assert.ok(versions.includes('012_appointment_manage'));
    const cols = (table) => app.db.all(`PRAGMA table_info(${table})`);
    assert.deepEqual((await cols('appointment_manage_tokens')).map((c) => c.name), [
      'token_hash', 'business_id', 'appointment_id', 'created_at', 'expires_at', 'revoked_at', 'revoked_reason',
    ]);
    assert.deepEqual((await cols('appointment_reschedules')).map((c) => c.name), [
      'business_id', 'previous_appointment_id', 'appointment_id', 'sequence', 'created_at',
    ]);
    const lead = (await cols('businesses')).find((c) => c.name === 'cancellation_lead_minutes');
    assert.equal(lead.dflt_value, '120');
    assert.equal(lead.notnull, 1);
    assert.equal(CANCELLATION_LEAD_DEFAULT_MINUTES, 120);
  });

  test('negócio criado antes da 012 passa a valer 120', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af12-mig-'));
    const partial = join(dir, 'partial');
    await mkdir(partial);
    try {
      const files = (await readdir(MIGRATIONS)).filter((f) => f < '012');
      for (const f of files) await copyFile(join(MIGRATIONS, f), join(partial, f));
      const db = createDatabase({ databasePath: join(dir, 'db.sqlite') });
      await runMigrations(db, { dir: partial });
      const owner = randomUUID();
      await db.run("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, 'D', 'd@x.com', 'h', ?, ?)", [owner, NOW, NOW]);
      await db.run(
        "INSERT INTO businesses (id, owner_id, name, slug, address, phone, timezone, created_at, updated_at) VALUES (?, ?, 'N', 'antigo', 'R', '11912345678', 'America/Sao_Paulo', ?, ?)",
        [randomUUID(), owner, NOW, NOW],
      );
      // AF-18: a 013 (fila de e-mails) vem junto (critério 33: lista de migrações).
      // AF-14: a 014 (cancelled_by e kind novo) vem junto (critério 43).
      assert.deepEqual(await runMigrations(db), ['012_appointment_manage', '013_email_outbox', '014_owner_cancellation', '015_password_reset']);
      assert.equal((await db.get('SELECT cancellation_lead_minutes AS n FROM businesses')).n, 120);
      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('CHECK da antecedência: 10, -15, 4335, 1.5 e texto não numérico recusados; 0 e 4320 aceitos', async () => {
    // '120' (texto) vira o inteiro 120 pela afinidade INTEGER antes do CHECK: é gravado como integer.
    await app.db.run('UPDATE businesses SET cancellation_lead_minutes = ? WHERE id = ?', ['120', business.id]);
    assert.equal((await app.db.get('SELECT typeof(cancellation_lead_minutes) AS t FROM businesses WHERE id = ?', [business.id])).t, 'integer');
    for (const bad of [10, -15, 4335, 1.5, 'abc', '1.5']) {
      await assert.rejects(app.db.run('UPDATE businesses SET cancellation_lead_minutes = ? WHERE id = ?', [bad, business.id]), /CHECK/, String(bad));
    }
    for (const ok of [0, 4320]) await app.db.run('UPDATE businesses SET cancellation_lead_minutes = ? WHERE id = ?', [ok, business.id]);
  });

  test('CHECKs dos tokens: hash, instantes e par revogado/motivo', async () => {
    const bad = [
      tokenRow({ tokenHash: 'a'.repeat(63) }),
      tokenRow({ tokenHash: 'A'.repeat(64) }),
      tokenRow({ tokenHash: `${'a'.repeat(63)}g` }),
      tokenRow({ createdAt: '2026-11-27T14:00:00.000Z' }),
      tokenRow({ revokedAt: NOW }),
      tokenRow({ revokedReason: 'cancelled' }),
      tokenRow({ revokedAt: NOW, revokedReason: 'x' }),
    ];
    for (const row of bad) await assert.rejects(tokens.insert(row), /CHECK/, JSON.stringify(row));
    await tokens.insert(tokenRow({ revokedAt: NOW, revokedReason: 'rescheduled' }));
  });

  test('CHECKs e PK do elo: sequence 0 e 4, elo para si mesmo; segundo elo do mesmo antigo dá UniqueViolationError', async () => {
    const link = (over) => ({ businessId: business.id, previousAppointmentId: a1, appointmentId: a2, sequence: 1, createdAt: NOW, ...over });
    for (const over of [{ sequence: 0 }, { sequence: 4 }, { appointmentId: a1 }]) {
      await assert.rejects(reschedules.insert(link(over)), /CHECK/, JSON.stringify(over));
    }
    await reschedules.insert(link());
    const a3 = await insertAppointmentDirect(app.db, { ...business.base, startsAt: '2026-11-28T13:00:00.000Z' });
    const err = await reschedules.insert(link({ appointmentId: a3 })).catch((e) => e);
    assert.ok(err instanceof UniqueViolationError);
    assert.equal(err.constraint, 'appointment_reschedules_previous_appointment_id_unique');
    assert.equal(await reschedules.sequenceOf(a2, business.id), 1);
    assert.equal(await reschedules.sequenceOf(a1, business.id), 0);
    assert.equal(await reschedules.sequenceOf(a2, other.id), 0);
  });

  test('FKs compostas (critério 36): token e elo com agendamento de outro negócio falham; apagar o negócio leva tudo', async () => {
    await assert.rejects(tokens.insert(tokenRow({ appointmentId: otherAppointment })), /FOREIGN KEY/);
    await assert.rejects(
      reschedules.insert({ businessId: business.id, previousAppointmentId: a1, appointmentId: otherAppointment, sequence: 1, createdAt: NOW }),
      /FOREIGN KEY/,
    );
    await tokens.insert(tokenRow());
    await reschedules.insert({ businessId: business.id, previousAppointmentId: a1, appointmentId: a2, sequence: 1, createdAt: NOW });
    await app.db.run('DELETE FROM businesses WHERE id = ?', [business.id]);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_manage_tokens')).n), 0);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_reschedules')).n), 0);
  });
});

describe('repositório de tokens (critérios 5, 7 e 35)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('findLiveByHash: vivo e revogado sim; vencido (expires_at = agora) não', async () => {
    const live = tokenRow();
    const revoked = tokenRow({ revokedAt: NOW, revokedReason: 'cancelled' });
    const expired = tokenRow({ expiresAt: '2026-11-27T14:00:00.000Z' });
    for (const r of [live, revoked, expired]) await tokens.insert(r);
    assert.deepEqual(await tokens.findLiveByHash(live.tokenHash, NOW), {
      businessId: business.id, appointmentId: a1, expiresAt: live.expiresAt, revokedAt: null, revokedReason: null,
    });
    assert.equal((await tokens.findLiveByHash(revoked.tokenHash, NOW)).revokedReason, 'cancelled');
    assert.equal(await tokens.findLiveByHash(expired.tokenHash, '2026-11-27T14:00:00.000Z'), undefined);
    assert.equal(await tokens.findLiveByHash(hash('nada'), NOW), undefined);
  });

  test('revokeForAppointment só nos vivos e do negócio; moveToAppointment troca appointment_id e expires_at', async () => {
    const t1 = tokenRow();
    const t2 = tokenRow();
    const old = tokenRow({ revokedAt: '2026-11-26T11:00:00.000Z', revokedReason: 'cancelled' });
    for (const r of [t1, t2, old]) await tokens.insert(r);
    assert.equal((await tokens.revokeForAppointment(other.id, a1, 'cancelled', NOW)).changes, 0);
    assert.equal((await tokens.moveToAppointment(business.id, a1, a2, '2026-11-27T16:00:00.000Z')).changes, 2);
    const moved = await tokens.findLiveByHash(t1.tokenHash, NOW);
    assert.equal(moved.appointmentId, a2);
    assert.equal(moved.expiresAt, '2026-11-27T16:00:00.000Z');
    assert.equal((await tokens.findLiveByHash(old.tokenHash, NOW)).appointmentId, a1, 'revogado não se move');
    assert.equal((await tokens.revokeForAppointment(business.id, a2, 'cancelled', NOW)).changes, 2);
    assert.equal((await tokens.revokeForAppointment(business.id, a2, 'cancelled', NOW)).changes, 0);
  });

  test('purgeExpiredAll em lotes: 1.201 vencidos há 31 dias saem; os vencidos há 29 dias ficam; purgeExpired é um lote do negócio', async () => {
    const day = 86_400_000;
    const nowMs = Date.parse(NOW);
    const iso = (ms) => new Date(ms).toISOString();
    await app.db.transaction(async (tx) => {
      const repo = createManageTokensRepository(tx);
      for (let i = 0; i < 1201; i++) {
        await repo.insert(tokenRow({ createdAt: iso(nowMs - 32 * day), expiresAt: iso(nowMs - 31 * day) }));
      }
      for (let i = 0; i < 3; i++) await repo.insert(tokenRow({ createdAt: iso(nowMs - 30 * day), expiresAt: iso(nowMs - 29 * day) }));
    });
    const cutoff = iso(nowMs - 30 * day);
    let statements = 0;
    const counting = {
      run: (sql, params) => {
        statements += 1;
        return app.db.run(sql, params);
      },
    };
    assert.equal(await createManageTokensRepository(app.db).purgeExpired(business.id, cutoff, { batch: 100 }).then((r) => r.changes), 100);
    assert.equal(await tokens.purgeExpiredAll(cutoff, {}, counting), 1101);
    assert.equal(statements, 3);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointment_manage_tokens')).n), 3);
  });
});

describe('appointmentsRepository.findBusy com excludeAppointmentId (critério 24)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('o agendamento excluído sai do resultado; sem a opção, nada muda', async () => {
    const repo = app.services.appointmentsRepository;
    const from = '2026-11-27T03:00:00.000Z';
    const to = '2026-11-28T03:00:00.000Z';
    assert.equal((await repo.findBusy(business.id, null, from, to)).length, 2);
    assert.equal((await repo.findBusy(business.id, null, from, to, undefined, { excludeAppointmentId: a1 })).length, 1);
    const map = await app.services.appointments.findBusyByBusiness(business.id, { professionalId: null, excludeAppointmentId: a1 }, from, to);
    assert.equal([...map.values()].flat().length, 1);
  });
});
