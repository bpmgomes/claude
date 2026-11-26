// AF-14 (design 3.1 e 6.1, critérios 11 e 25): migração 014. Coluna `cancelled_by` com CHECK e
// recriação de `email_outbox` preservando dados, colunas, constraints e índices, testada com um banco
// migrado só até a 013 e povoado antes da 014.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { enqueueEmail } from '../../src/modules/email/enqueue-email.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { insertServiceDirect, insertProfessionalDirect } from '../helpers/agenda.js';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const NOW = '2026-11-26T12:00:00.000Z';
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'af14-mig-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Diretório só com as migrações abaixo de `limit` (ex.: '014'). */
async function partialDir(dir, limit) {
  const partial = join(dir, `upto-${limit}`);
  await mkdir(partial);
  for (const f of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n < limit)) {
    await copyFile(join(MIGRATIONS, f), join(partial, f));
  }
  return partial;
}

async function seedBusiness(db, slug = `neg-${randomUUID().slice(0, 8)}`) {
  const owner = randomUUID();
  await db.run("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, 'D', ?, 'h', ?, ?)", [owner, `${owner}@x.com`, NOW, NOW]);
  const businessId = randomUUID();
  await db.run(
    "INSERT INTO businesses (id, owner_id, name, slug, address, phone, timezone, created_at, updated_at) VALUES (?, ?, 'N', ?, 'R', '11912345678', 'America/Sao_Paulo', ?, ?)",
    [businessId, owner, slug, NOW, NOW],
  );
  const serviceId = await insertServiceDirect(db, businessId);
  const professionalId = await insertProfessionalDirect(db, businessId, 'Ana');
  const customerId = await insertCustomerDirect(db, businessId);
  const appt = async (hour, status = 'confirmed') =>
    insertAppointmentDirect(db, { businessId, professionalId, customerId, serviceId, startsAt: `2026-11-2${hour}T13:00:00.000Z`, status });
  return { businessId, serviceId, professionalId, customerId, appt };
}

const OUTBOX_COLUMNS = [
  'id', 'business_id', 'kind', 'appointment_id', 'previous_appointment_id', 'status', 'attempts', 'next_attempt_at',
  'locked_until', 'last_error_code', 'created_at', 'updated_at', 'sent_at', 'maybe_delivered_at',
];
const OUTBOX_INDEXES = ['email_outbox_business_id_appointment_id_idx', 'email_outbox_status_next_attempt_at_idx', 'email_outbox_status_updated_at_idx'];

async function rawOutbox(db, row) {
  const r = {
    id: randomUUID(), kind: 'appointment_confirmed', previous_appointment_id: null, status: 'pending', attempts: 0,
    next_attempt_at: NOW, locked_until: null, last_error_code: null, created_at: NOW, updated_at: NOW, sent_at: null,
    maybe_delivered_at: null, ...row,
  };
  await db.run(
    `INSERT INTO "email_outbox" (${OUTBOX_COLUMNS.join(', ')}) VALUES (${OUTBOX_COLUMNS.map(() => '?').join(', ')})`,
    OUTBOX_COLUMNS.map((c) => r[c]),
  );
  return r.id;
}

/** Banco em 013 povoado com uma linha por status e por kind. */
async function populated013(dir) {
  const db = createDatabase({ databasePath: join(dir, 'db.sqlite') });
  await runMigrations(db, { dir: await partialDir(dir, '014') });
  const b = await seedBusiness(db, 'antigo');
  const a1 = await b.appt(7);
  const a2 = await b.appt(8, 'cancelled');
  const a3 = await b.appt(9);
  const a4 = await b.appt(5);
  const a5 = await b.appt(6);
  const a6 = await b.appt(4);
  await rawOutbox(db, { business_id: b.businessId, appointment_id: a1, kind: 'appointment_confirmed', status: 'pending' });
  await rawOutbox(db, { business_id: b.businessId, appointment_id: a2, kind: 'appointment_cancelled', status: 'sent', attempts: 1, sent_at: at(1000) });
  await rawOutbox(db, {
    business_id: b.businessId, appointment_id: a3, previous_appointment_id: a2, kind: 'appointment_rescheduled',
    status: 'sending', attempts: 2, locked_until: at(300_000), maybe_delivered_at: at(500), last_error_code: 'send_timeout',
  });
  await rawOutbox(db, { business_id: b.businessId, appointment_id: a4, status: 'failed', attempts: 5, last_error_code: 'smtp_5xx' });
  await rawOutbox(db, { business_id: b.businessId, appointment_id: a5, status: 'skipped', attempts: 1, last_error_code: 'not_confirmed' });
  await rawOutbox(db, { business_id: b.businessId, appointment_id: a6, status: 'expired', last_error_code: 'expired' });
  return { db, b, ids: { a1, a2, a3, a4, a5, a6 } };
}

describe('migração 014 (critérios 11 e 25)', () => {
  test('014 registrada; cancelled_by por último em appointments; CHECK nas combinações', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      await runMigrations(db);
      const versions = (await db.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
      assert.equal(versions.at(-1), '014_owner_cancellation');
      const cols = (await db.all('PRAGMA table_info(appointments)')).map((c) => c.name);
      assert.equal(cols.at(-1), 'cancelled_by');
      assert.equal(cols.length, 17);
      const b = await seedBusiness(db);
      const id = await b.appt(7);
      const set = (status, by) =>
        db.run('UPDATE appointments SET status = ?, cancelled_at = ?, cancelled_by = ? WHERE id = ?', [status, status === 'cancelled' ? NOW : null, by, id]);
      await assert.rejects(set('cancelled', 'x'), /CHECK constraint failed: appointments_cancelled_by_check/);
      await assert.rejects(set('confirmed', 'owner'), /CHECK constraint failed: appointments_cancelled_by_check/);
      await assert.rejects(set('completed', 'customer'), /appointments_cancelled_by_check/);
      await set('cancelled', null);
      for (const by of ['customer', 'owner', 'reschedule']) await set('cancelled', by);
      await set('confirmed', null);
      // o CHECK de 014 é o que CANCELLED_BY espelha (agenda-rules.test.js lê o mesmo texto).
      const { sql } = await db.get("SELECT sql FROM sqlite_master WHERE name = 'appointments'");
      assert.match(sql, /cancelled_by IN \('customer', 'owner', 'reschedule'\)/);
    } finally {
      await db.close();
    }
  });

  test('recriação de email_outbox com linhas existentes: dados, colunas, índices, FKs e integridade preservados', async () => {
    await withDir(async (dir) => {
      const { db, b, ids } = await populated013(dir);
      try {
        const before = await db.all('SELECT * FROM email_outbox ORDER BY id');
        const customersIdxBefore = await db.get("SELECT sql FROM sqlite_master WHERE name = 'customers_email_idx'");
        assert.equal(before.length, 6);
        assert.deepEqual(await runMigrations(db), ['014_owner_cancellation']);

        assert.deepEqual(await db.all('SELECT * FROM email_outbox ORDER BY id'), before, 'SELECT * idêntico');
        assert.deepEqual((await db.all('PRAGMA table_info(email_outbox)')).map((c) => c.name), OUTBOX_COLUMNS);
        const idx = (await db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_outbox' AND sql IS NOT NULL ORDER BY name")).map((r) => r.name);
        assert.deepEqual(idx, OUTBOX_INDEXES);
        const auto = (await db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_outbox' AND sql IS NULL")).map((r) => r.name);
        assert.ok(auto.includes('sqlite_autoindex_email_outbox_1'), auto.join());
        assert.ok(!auto.some((n) => n.includes('_new')), auto.join());
        assert.deepEqual(await db.get("SELECT sql FROM sqlite_master WHERE name = 'customers_email_idx'"), customersIdxBefore);
        assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'email_outbox_new'"), undefined);
        assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
        assert.equal((await db.get('PRAGMA integrity_check')).integrity_check, 'ok');
        const referencing = await db.all("SELECT name FROM sqlite_master WHERE sql LIKE '%REFERENCES email_outbox%'");
        assert.deepEqual(referencing, []);
        const fks = await db.all('PRAGMA foreign_key_list(email_outbox)');
        assert.deepEqual([...new Set(fks.map((f) => f.table))].sort(), ['appointments', 'businesses']);

        // CHECKs da 013 continuam recusando.
        const bad = [
          ['kind lembrete', { kind: 'appointment_reminder' }],
          ['status', { status: 'queued' }],
          ['attempts 6', { attempts: 6 }],
          ['attempts texto', { attempts: 'x' }],
          ['sending sem lock', { status: 'sending' }],
          ['lock sem sending', { locked_until: NOW }],
          ['sent sem sent_at', { status: 'sent' }],
          ['erro com maiúscula', { last_error_code: 'Bad' }],
          ['instante curto', { created_at: '2026-11-26' }],
          ['id curto', { id: 'abc' }],
          ['rescheduled sem previous', { kind: 'appointment_rescheduled' }],
          ['previous fora de rescheduled', { previous_appointment_id: ids.a2 }],
        ];
        const fresh = await b.appt(3);
        for (const [label, over] of bad) {
          await assert.rejects(rawOutbox(db, { business_id: b.businessId, appointment_id: fresh, ...over }), /constraint failed/, label);
        }
        // O kind novo é aceito; UNIQUE e ON CONFLICT do enqueueEmail funcionam e o nome é reconstruído.
        const ok = await enqueueEmail(db, { kind: 'appointment_cancelled_by_owner', businessId: b.businessId, appointmentId: fresh, nowIso: NOW });
        assert.equal(ok.enqueued, true);
        const again = await enqueueEmail(db, { kind: 'appointment_cancelled_by_owner', businessId: b.businessId, appointmentId: fresh, nowIso: NOW });
        assert.deepEqual(again, { id: null, enqueued: false });
        await assert.rejects(
          rawOutbox(db, { business_id: b.businessId, appointment_id: fresh, kind: 'appointment_cancelled_by_owner' }),
          (err) => err instanceof UniqueViolationError && err.constraint === 'email_outbox_business_id_kind_appointment_id_unique',
        );
        // FK composta: agendamento de outro negócio recusado; cascata do negócio continua.
        const other = await seedBusiness(db);
        await assert.rejects(rawOutbox(db, { business_id: other.businessId, appointment_id: fresh }), /FOREIGN KEY constraint failed/);
        await db.run('DELETE FROM businesses WHERE id = ?', [b.businessId]);
        assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM email_outbox')).n), 0);
        // Rodar de novo não aplica nada.
        assert.deepEqual(await runMigrations(db), []);
      } finally {
        await db.close();
      }
    });
  });

  test('falha no meio da 014: nada muda (nem a coluna, nem a fila)', async () => {
    await withDir(async (dir) => {
      const { db } = await populated013(dir);
      try {
        const broken = join(dir, 'broken');
        await mkdir(broken);
        for (const f of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n < '014')) {
          await copyFile(join(MIGRATIONS, f), join(broken, f));
        }
        const sql = await readFile(join(MIGRATIONS, '014_owner_cancellation.sql'), 'utf8');
        await writeFile(join(broken, '014_owner_cancellation.sql'), `${sql}\nSELECT * FROM tabela_que_nao_existe;\n`);
        const before = await db.all('SELECT * FROM email_outbox ORDER BY id');
        const schemaBefore = await db.all('SELECT type, name, sql FROM sqlite_master ORDER BY name');
        await assert.rejects(runMigrations(db, { dir: broken }), /no such table/);
        assert.deepEqual(await db.all('SELECT * FROM email_outbox ORDER BY id'), before);
        assert.deepEqual(await db.all('SELECT type, name, sql FROM sqlite_master ORDER BY name'), schemaBefore);
        assert.ok(!(await db.all('PRAGMA table_info(appointments)')).some((c) => c.name === 'cancelled_by'));
        assert.equal(await db.get("SELECT version FROM schema_migrations WHERE version = '014_owner_cancellation'"), undefined);
        // E a 014 real ainda aplica depois.
        assert.deepEqual(await runMigrations(db), ['014_owner_cancellation']);
        assert.deepEqual(await db.all('SELECT * FROM email_outbox ORDER BY id'), before);
      } finally {
        await db.close();
      }
    });
  });
});
