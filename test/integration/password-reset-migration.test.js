// AF-03 (design 3.1 e 6.1, critérios 4, 8, 11 e 35): migração 015. Segunda recriação de
// `email_outbox` (user_id, business_id/appointment_id anuláveis, target_check), testada com um banco
// migrado só até a 014 e povoado antes da 015; tabelas novas e colunas novas com os CHECKs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { insertServiceDirect, insertProfessionalDirect } from '../helpers/agenda.js';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const NOW = '2026-11-26T12:00:00.000Z';
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
const HASH = (c) => c.repeat(64);

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'af03-mig-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Diretório só com as migrações abaixo de `limit` (ex.: '015'). */
async function partialDir(dir, limit) {
  const partial = join(dir, `upto-${limit}`);
  await mkdir(partial, { recursive: true });
  for (const f of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n < limit)) {
    await copyFile(join(MIGRATIONS, f), join(partial, f));
  }
  return partial;
}

async function insertUser(db, email = `${randomUUID()}@x.com`) {
  const id = randomUUID();
  await db.run("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, 'D', ?, 'h', ?, ?)", [id, email, NOW, NOW]);
  return id;
}

async function seedBusiness(db) {
  const owner = await insertUser(db);
  const businessId = randomUUID();
  await db.run(
    "INSERT INTO businesses (id, owner_id, name, slug, address, phone, timezone, created_at, updated_at) VALUES (?, ?, 'N', ?, 'R', '11912345678', 'America/Sao_Paulo', ?, ?)",
    [businessId, owner, `neg-${randomUUID().slice(0, 8)}`, NOW, NOW],
  );
  const serviceId = await insertServiceDirect(db, businessId);
  const professionalId = await insertProfessionalDirect(db, businessId, 'Ana');
  const customerId = await insertCustomerDirect(db, businessId);
  const appt = async (day, status = 'confirmed') =>
    insertAppointmentDirect(db, { businessId, professionalId, customerId, serviceId, startsAt: `2026-11-${day}T13:00:00.000Z`, status });
  return { owner, businessId, appt };
}

const OLD_COLUMNS = [
  'id', 'business_id', 'kind', 'appointment_id', 'previous_appointment_id', 'status', 'attempts', 'next_attempt_at',
  'locked_until', 'last_error_code', 'created_at', 'updated_at', 'sent_at', 'maybe_delivered_at',
];
const COLUMNS = [...OLD_COLUMNS, 'user_id'];
const OLD_INDEXES = ['email_outbox_business_id_appointment_id_idx', 'email_outbox_status_next_attempt_at_idx', 'email_outbox_status_updated_at_idx'];
const COPIED_CHECKS = ['status', 'attempts', 'lock', 'sent', 'error_code', 'instants'];

async function rawOutbox(db, row, columns = COLUMNS) {
  const r = {
    id: randomUUID(), kind: 'appointment_confirmed', business_id: null, appointment_id: null, previous_appointment_id: null,
    status: 'pending', attempts: 0, next_attempt_at: NOW, locked_until: null, last_error_code: null, created_at: NOW,
    updated_at: NOW, sent_at: null, maybe_delivered_at: null, user_id: null, ...row,
  };
  await db.run(
    `INSERT INTO "email_outbox" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => r[c]),
  );
  return r.id;
}

/** Texto de cada `CONSTRAINT email_outbox_<nome>_check` do CREATE TABLE (normalizado em espaços). */
function checkText(sql, name) {
  const start = sql.indexOf(`CONSTRAINT email_outbox_${name}_check`);
  assert.ok(start >= 0, name);
  const rest = sql.slice(start);
  const end = rest.search(/,\s*(?:CONSTRAINT|FOREIGN|--)|\s*\)\s*$/);
  return rest.slice(0, end).replace(/\s+/g, ' ').trim();
}

/** Banco em 014 povoado com uma linha por status e por kind. */
async function populated014(dir) {
  const db = createDatabase({ databasePath: join(dir, 'db.sqlite') });
  await runMigrations(db, { dir: await partialDir(dir, '015') });
  const b = await seedBusiness(db);
  const a = [];
  for (const [day, status] of [[20, 'confirmed'], [21, 'cancelled'], [22, 'confirmed'], [23, 'confirmed'], [24, 'confirmed'], [25, 'confirmed'], [19, 'cancelled']]) {
    a.push(await b.appt(day, status));
  }
  const old = (row) => rawOutbox(db, { business_id: b.businessId, ...row }, OLD_COLUMNS);
  await old({ appointment_id: a[0], kind: 'appointment_confirmed', status: 'pending' });
  await old({ appointment_id: a[1], kind: 'appointment_cancelled', status: 'sent', attempts: 1, sent_at: at(1000) });
  await old({
    appointment_id: a[2], previous_appointment_id: a[1], kind: 'appointment_rescheduled',
    status: 'sending', attempts: 2, locked_until: at(300_000), maybe_delivered_at: at(500), last_error_code: 'send_timeout',
  });
  await old({ appointment_id: a[3], status: 'failed', attempts: 5, last_error_code: 'smtp_5xx' });
  await old({ appointment_id: a[4], status: 'skipped', attempts: 1, last_error_code: 'not_confirmed' });
  await old({ appointment_id: a[5], status: 'expired', last_error_code: 'expired' });
  await old({ appointment_id: a[6], kind: 'appointment_cancelled_by_owner', status: 'sent', attempts: 1, sent_at: at(2000) });
  return { db, b, a };
}

describe('migração 015 (critérios 4, 8, 11 e 35)', () => {
  test('recriação de email_outbox com linhas: dados, colunas, índices, CHECKs copiados, FKs e integridade', async () => {
    await withDir(async (dir) => {
      const { db, b, a } = await populated014(dir);
      try {
        const before = await db.all(`SELECT ${OLD_COLUMNS.join(', ')} FROM email_outbox ORDER BY id`);
        const { sql: sql014 } = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_outbox'");
        const customersIdx = await db.get("SELECT sql FROM sqlite_master WHERE name = 'customers_email_idx'");
        assert.equal(before.length, 7);
        assert.deepEqual(await runMigrations(db), ['015_password_reset']);

        assert.deepEqual(await db.all(`SELECT ${OLD_COLUMNS.join(', ')} FROM email_outbox ORDER BY id`), before, '14 colunas idênticas');
        assert.deepEqual((await db.all('SELECT DISTINCT user_id FROM email_outbox')).map((r) => r.user_id), [null]);
        assert.deepEqual((await db.all('PRAGMA table_info(email_outbox)')).map((c) => c.name), COLUMNS);
        const idx = (await db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_outbox' AND sql IS NOT NULL ORDER BY name")).map((r) => r.name);
        assert.deepEqual(idx, [...OLD_INDEXES, 'email_outbox_user_id_kind_created_at_idx'].sort());
        assert.deepEqual(await db.get("SELECT sql FROM sqlite_master WHERE name = 'customers_email_idx'"), customersIdx);
        assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'email_outbox_new'"), undefined);
        assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
        assert.equal((await db.get('PRAGMA integrity_check')).integrity_check, 'ok');
        const { sql: sql015 } = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_outbox'");
        for (const name of COPIED_CHECKS) assert.equal(checkText(sql015, name), checkText(sql014, name), name);
        const fks = await db.all('PRAGMA foreign_key_list(email_outbox)');
        assert.deepEqual([...new Set(fks.map((f) => f.table))].sort(), ['appointments', 'businesses', 'users']);

        // target_check (R2).
        const user = await insertUser(db);
        const fresh = await b.appt(18);
        const bad = [
          ['conta com business_id', { kind: 'password_reset', user_id: user, business_id: b.businessId }],
          ['conta sem user_id', { kind: 'password_changed' }],
          ['agendamento com user_id', { business_id: b.businessId, appointment_id: fresh, user_id: user }],
          ['agendamento sem appointment_id', { business_id: b.businessId }],
          ['agendamento sem business_id', { appointment_id: fresh }],
          ['password_reset com previous', { kind: 'password_reset', user_id: user, previous_appointment_id: fresh }],
          ['kind desconhecido', { kind: 'account_deleted', user_id: user }],
        ];
        for (const [label, over] of bad) await assert.rejects(rawOutbox(db, over), /constraint failed/, label);
        // Duas linhas de conta do mesmo usuário coexistem (UNIQUE com NULL não colide).
        await rawOutbox(db, { kind: 'password_reset', user_id: user });
        await rawOutbox(db, { kind: 'password_reset', user_id: user });
        await rawOutbox(db, { kind: 'password_changed', user_id: user });
        const viaEnqueue = await enqueueEmail(db, { kind: 'password_reset', userId: user, nowIso: NOW });
        assert.equal(viaEnqueue.enqueued, true);
        // Agendamento continua com ON CONFLICT.
        assert.equal((await enqueueEmail(db, { kind: 'appointment_confirmed', businessId: b.businessId, appointmentId: fresh, nowIso: NOW })).enqueued, true);
        assert.equal((await enqueueEmail(db, { kind: 'appointment_confirmed', businessId: b.businessId, appointmentId: fresh, nowIso: NOW })).enqueued, false);
        // FK de users: apagar a conta apaga as linhas de conta e os tokens.
        await db.run("INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [HASH('a'), user, NOW, at(3_600_000)]);
        await db.run('DELETE FROM users WHERE id = ?', [user]);
        assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM email_outbox WHERE user_id IS NOT NULL')).n), 0);
        assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM password_reset_tokens')).n), 0);
        assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM email_outbox')).n), 8);
        assert.ok(a.length > 0);
        assert.deepEqual(await runMigrations(db), []);
      } finally {
        await db.close();
      }
    });
  });

  test('falha no meio da 015: nada muda (fila, users, login_attempts, tabelas novas)', async () => {
    await withDir(async (dir) => {
      const { db } = await populated014(dir);
      try {
        const broken = join(dir, 'broken');
        await mkdir(broken);
        for (const f of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n < '015')) {
          await copyFile(join(MIGRATIONS, f), join(broken, f));
        }
        const sql = await readFile(join(MIGRATIONS, '015_password_reset.sql'), 'utf8');
        await writeFile(join(broken, '015_password_reset.sql'), `${sql}\nSELECT * FROM tabela_que_nao_existe;\n`);
        const before = await db.all('SELECT * FROM email_outbox ORDER BY id');
        const schemaBefore = await db.all('SELECT type, name, sql FROM sqlite_master ORDER BY name');
        await assert.rejects(runMigrations(db, { dir: broken }), /no such table/);
        assert.deepEqual(await db.all('SELECT * FROM email_outbox ORDER BY id'), before);
        assert.deepEqual(await db.all('SELECT type, name, sql FROM sqlite_master ORDER BY name'), schemaBefore);
        assert.equal(await db.get("SELECT version FROM schema_migrations WHERE version = '015_password_reset'"), undefined);
        assert.deepEqual(await runMigrations(db), ['015_password_reset']);
      } finally {
        await db.close();
      }
    });
  });

  test('users.password_changed_at, login_attempts.email_hash, password_reset_tokens, auth_rate_limits e auth_rate_events', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      await runMigrations(db);
      const user = await insertUser(db);
      assert.equal((await db.all('PRAGMA table_info(users)')).at(-1).name, 'password_changed_at');
      await assert.rejects(db.run('UPDATE users SET password_changed_at = ? WHERE id = ?', ['2026-11-26', user]), /users_password_changed_at_check/);
      await db.run('UPDATE users SET password_changed_at = ? WHERE id = ?', [NOW, user]);

      assert.equal((await db.all('PRAGMA table_info(login_attempts)')).at(-1).name, 'email_hash');
      const attempt = (emailHash) =>
        db.run('INSERT INTO login_attempts (key_hash, failed_count, locked_until, updated_at, email_hash) VALUES (?, 0, NULL, ?, ?)', [randomUUID(), NOW, emailHash]);
      await assert.rejects(attempt('A'.repeat(64)), /login_attempts_email_hash_check/);
      await assert.rejects(attempt('a'.repeat(63)), /login_attempts_email_hash_check/);
      await attempt(null);
      await attempt(HASH('b'));
      assert.ok((await db.all('PRAGMA index_list(login_attempts)')).some((i) => i.name === 'login_attempts_email_hash_idx'));

      const token = (hash, over = {}) =>
        db.run('INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [
          hash, over.user ?? user, over.created ?? NOW, over.expires ?? at(3_600_000), over.used ?? null,
        ]);
      await assert.rejects(token('x'.repeat(64)), /password_reset_tokens_hash_check/);
      await assert.rejects(token(HASH('c'), { expires: NOW }), /password_reset_tokens_instants_check/);
      await assert.rejects(token(HASH('c'), { used: '2026' }), /password_reset_tokens_instants_check/);
      await assert.rejects(token(HASH('c'), { user: randomUUID() }), /FOREIGN KEY/);
      await token(HASH('c'));
      // Índice parcial: dois pendentes da mesma conta recusados; pendente + usado aceitos.
      await assert.rejects(token(HASH('d')), /unique/i);
      await token(HASH('d'), { used: NOW });
      await token(HASH('e'), { used: NOW });
      const cols = (await db.all('PRAGMA table_info(password_reset_tokens)')).map((c) => c.name);
      assert.deepEqual(cols, ['token_hash', 'user_id', 'created_at', 'expires_at', 'used_at']);

      const bucket = (scope, key = HASH('f'), hits = 1) =>
        db.run('INSERT INTO auth_rate_limits (scope, key_hash, window_started_at, hits) VALUES (?, ?, ?, ?)', [scope, key, NOW, hits]);
      await assert.rejects(bucket('login'), /auth_rate_limits_scope_check/);
      await assert.rejects(bucket('password_reset_request_ip', 'z'.repeat(64)), /auth_rate_limits_key_check/);
      await assert.rejects(bucket('password_reset_request_ip', HASH('f'), -1), /auth_rate_limits_hits_check/);
      // O e-mail saiu da janela fixa (revisão de segurança): vai para auth_rate_events.
      await assert.rejects(bucket('password_reset_request_email'), /auth_rate_limits_scope_check/);
      for (const scope of ['password_reset_request_ip', 'password_reset_confirm_ip']) await bucket(scope);
      await assert.rejects(bucket('password_reset_request_ip'), /unique/i);

      const event = (scope, key = HASH('a'), occurredAt = NOW) =>
        db.run('INSERT INTO auth_rate_events (scope, key_hash, occurred_at) VALUES (?, ?, ?)', [scope, key, occurredAt]);
      await assert.rejects(event('password_reset_request_ip'), /auth_rate_events_scope_check/);
      await assert.rejects(event('password_reset_request_email', 'G'.repeat(64)), /auth_rate_events_key_check/);
      await assert.rejects(event('password_reset_request_email', HASH('a'), '2026-11-26'), /auth_rate_events_instant_check/);
      // Sem chave única: um evento por pedido aceito, mesmo no mesmo instante.
      await event('password_reset_request_email');
      await event('password_reset_request_email');
      const eventIdx = (await db.all('PRAGMA index_list(auth_rate_events)')).map((i) => i.name).sort();
      assert.deepEqual(eventIdx, ['auth_rate_events_occurred_at_idx', 'auth_rate_events_scope_key_hash_occurred_at_idx']);
    } finally {
      await db.close();
    }
  });
});
