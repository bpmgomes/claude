import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import {
  signupAndLogin,
  createBusinessFor,
  createService,
  createProfessional,
  putHours,
  setBusinessTimezone,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { insertAppointmentDirect, insertCustomerDirect, cancelDirect } from '../helpers/appointments.js';
import { ExclusionViolationError, UniqueViolationError } from '../../src/db/errors.js';
import { translateError } from '../../src/db/sqlite.js';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { OUTSIDE_HOURS_SCAN_MAX } from '../../src/shared/working-hours.js';

const NOW = '2026-11-26T12:00:00.000Z';
// Sexta 27/11, São Paulo (UTC-3): 10:00 local = 13:00Z.
const at = (hhmm, date = '2026-11-27') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + ((h + 3) * 60 + m) * 60_000).toISOString();
};

let app;
let clock;
let ana;
let business;
let corte;
let pa;
let pb;
let customerId;

async function setup() {
  clock = createClock(NOW);
  ({ app } = await buildTestApp({ now: clock.now }));
  ana = await signupAndLogin(app);
  business = await createBusinessFor(app, ana);
  business.id = (await app.db.get('SELECT id FROM businesses')).id;
  corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60 });
  pa = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
  pb = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
  for (const p of [pa, pb]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
  customerId = await insertCustomerDirect(app.db, business.id);
}

const row = (over = {}) => ({
  businessId: business.id,
  professionalId: pa.id,
  customerId,
  serviceId: corte.id,
  startsAt: at('10:00'),
  ...over,
});
const insert = (over) => insertAppointmentDirect(app.db, row(over));
const port = () => app.services.appointments;

describe('migração 010 (critérios 8, 9 e 45)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('colunas de appointments e de booking_idempotency_keys', async () => {
    const cols = (await app.db.all('PRAGMA table_info(appointments)')).map((c) => c.name);
    assert.deepEqual(cols, [
      'id', 'business_id', 'professional_id', 'customer_id', 'service_id', 'service_name', 'duration_minutes',
      'price_cents', 'customer_name', 'customer_phone', 'starts_at', 'ends_at', 'status', 'created_at',
      'updated_at', 'cancelled_at',
    ]);
    const keys = (await app.db.all('PRAGMA table_info(booking_idempotency_keys)')).map((c) => c.name);
    assert.deepEqual(keys, ['business_id', 'idempotency_key', 'request_hash', 'appointment_id', 'response_body', 'created_at', 'expires_at']);
  });

  test('CHECKs recusam status, cancelled_at, instantes, duração, ends_at, preço, telefone e nome inválidos', async () => {
    const bad = [
      ['status pending', { status: 'pending', cancelledAt: null }],
      ['cancelled sem cancelled_at', { status: 'cancelled', cancelledAt: null }],
      ['confirmed com cancelled_at', { cancelledAt: NOW }],
      ['instante de 29 caracteres', { startsAt: '2026-11-27T13:00:00.000000+00', endsAt: '2026-11-27T14:00:00.000000+00' }],
      ['starts_at >= ends_at', { endsAt: at('10:00') }],
      ['duração 10', { durationMinutes: 10 }],
      ['duração 495', { durationMinutes: 495 }],
      ['ends_at diferente de início + duração', { endsAt: at('10:45') }],
      ['starts_at inválido com ends_at qualquer', { startsAt: 'xxxx-11-27T13:00:00.000Z', endsAt: at('11:00') }],
      ['preço negativo', { priceCents: -1 }],
      ['telefone de 9 dígitos', { customerPhone: '119123456' }],
      ['nome de 1 caractere', { customerName: 'A' }],
    ];
    for (const [label, over] of bad) {
      await assert.rejects(insert(over), /CHECK constraint failed/, label);
    }
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointments')).n), 0);
    for (const status of ['confirmed', 'completed', 'no_show']) {
      await insert({ status, startsAt: at(status === 'confirmed' ? '09:00' : status === 'completed' ? '13:00' : '15:00') });
    }
    await insert({ status: 'cancelled', startsAt: at('09:00') });
    await insert({ priceCents: null, startsAt: at('16:00') });
  });

  test('FKs compostas: profissional, cliente e serviço de outro negócio falham', async () => {
    const bia = await signupAndLogin(app, { email: 'bia@x.com', name: 'Bia' });
    await createBusinessFor(app, bia, { name: 'Barbearia' });
    const otherBusinessId = (await app.db.get('SELECT id FROM businesses WHERE id <> ?', [business.id])).id;
    const otherService = await createService(app, bia, { name: 'Barba' });
    const otherPro = await createProfessional(app, bia, { name: 'Caio', serviceIds: [otherService.id] });
    const otherCustomer = await insertCustomerDirect(app.db, otherBusinessId);
    await assert.rejects(insert({ professionalId: otherPro.id }), /FOREIGN KEY/);
    await assert.rejects(insert({ customerId: otherCustomer }), /FOREIGN KEY/);
    await assert.rejects(insert({ serviceId: otherService.id }), /FOREIGN KEY/);
  });

  test('apagar direto um cliente, profissional ou serviço com agendamento falha; apagar o negócio apaga tudo', async () => {
    const id = await insert();
    await app.db.run(
      `INSERT INTO booking_idempotency_keys VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      [business.id, randomUUID(), 'a'.repeat(64), id, NOW, '2026-11-27T12:00:00.000Z'],
    );
    await assert.rejects(app.db.run('DELETE FROM customers WHERE id = ?', [customerId]), /FOREIGN KEY/);
    await assert.rejects(app.db.run('DELETE FROM professionals WHERE id = ?', [pa.id]), /FOREIGN KEY/);
    await assert.rejects(app.db.run('DELETE FROM services WHERE id = ?', [corte.id]), /FOREIGN KEY/);
    await app.db.run('DELETE FROM users');
    for (const table of ['businesses', 'appointments', 'customers', 'professionals', 'services', 'booking_idempotency_keys']) {
      assert.equal(Number((await app.db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n), 0, table);
    }
  });
});

describe('não sobreposição no banco (critério 21)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('INSERT direto [10:30, 11:30) sobre [10:00, 11:00) do mesmo profissional falha com ExclusionViolationError', async () => {
    await insert();
    const err = await insert({ startsAt: at('10:30') }).catch((e) => e);
    assert.ok(err instanceof ExclusionViolationError, String(err));
    assert.equal(err.constraint, 'appointments_no_overlap');
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointments')).n), 1);
  });

  test('encostado [11:00, 12:00) passa; outro profissional no mesmo horário passa', async () => {
    await insert();
    await insert({ startsAt: at('11:00') });
    await insert({ professionalId: pb.id });
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM appointments')).n), 3);
  });

  test('durações diferentes: 15 min dentro de 480 e 480 cobrindo 15 falham', async () => {
    await insert({ startsAt: at('09:00'), durationMinutes: 480 });
    await assert.rejects(insert({ startsAt: at('12:15'), durationMinutes: 15 }), ExclusionViolationError);
    await insert({ professionalId: pb.id, startsAt: at('12:15'), durationMinutes: 15 });
    await assert.rejects(insert({ professionalId: pb.id, startsAt: at('08:00'), durationMinutes: 480 }), ExclusionViolationError);
  });

  test('o mesmo início também falha (o trigger roda antes da unicidade)', async () => {
    await insert();
    await assert.rejects(insert(), ExclusionViolationError);
  });

  test('INSERT sobreposto com status cancelled passa; cancelar e inserir de novo no mesmo horário passa', async () => {
    const id = await insert();
    await insert({ status: 'cancelled' });
    await cancelDirect(app.db, id);
    await insert();
    assert.equal(Number((await app.db.get("SELECT COUNT(*) AS n FROM appointments WHERE status <> 'cancelled'")).n), 1);
  });

  test('UPDATE que move um agendamento para cima de outro falha; reativar cancelado sobre ocupado falha', async () => {
    await insert();
    const later = await insert({ startsAt: at('13:00') });
    await assert.rejects(
      app.db.run('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?', [at('10:30'), at('11:30'), later]),
      ExclusionViolationError,
    );
    await assert.rejects(
      app.db.run('UPDATE appointments SET professional_id = ? WHERE id = ?', [pa.id, await insert({ professionalId: pb.id })]),
      ExclusionViolationError,
    );
    const cancelled = await insert({ status: 'cancelled' });
    await assert.rejects(
      app.db.run("UPDATE appointments SET status = 'confirmed', cancelled_at = NULL WHERE id = ?", [cancelled]),
      ExclusionViolationError,
    );
    // Atualizar o próprio agendamento sem conflito passa (o trigger ignora a própria linha).
    await app.db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", [later]);
  });

  test('com foreign_keys desligado, um business_id falso com o mesmo professional_id não escapa do trigger (QA F4)', async () => {
    await insert();
    const fake = '00000000-0000-4000-8000-000000000000';
    await app.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      const err = await insert({ businessId: fake, startsAt: at('10:30') }).catch((e) => e);
      assert.ok(err instanceof ExclusionViolationError, String(err));
      const later = await insert({ businessId: fake, startsAt: at('13:00') });
      await assert.rejects(
        app.db.run('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?', [at('10:15'), at('11:15'), later]),
        ExclusionViolationError,
      );
    } finally {
      await app.db.exec('PRAGMA foreign_keys = ON;');
    }
    assert.equal(Number((await app.db.get("SELECT COUNT(*) AS n FROM appointments WHERE starts_at < ? AND ends_at > ?", [at('11:00'), at('10:00')])).n), 1);
  });

  test('índice parcial sem os triggers: o mesmo início falha com UniqueViolationError appointments_professional_id_starts_at_unique', async () => {
    await app.db.exec('DROP TRIGGER appointments_no_overlap_insert; DROP TRIGGER appointments_no_overlap_update;');
    await insert();
    const err = await insert().catch((e) => e);
    assert.ok(err instanceof UniqueViolationError, String(err));
    assert.equal(err.constraint, 'appointments_professional_id_starts_at_unique');
    // Sem trigger, só o mesmo início é coberto: a rede mínima não impede início diferente.
    await insert({ startsAt: at('10:30') });
  });
});

describe('segunda conexão no mesmo arquivo (o banco recusa sem o adapter)', () => {
  test('um DatabaseSync à parte também não consegue gravar o INSERT sobreposto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af11-repo-'));
    const file = join(dir, 'db.sqlite');
    const db = createDatabase({ databasePath: file });
    try {
      await runMigrations(db);
      const ids = { b: randomUUID(), u: randomUUID(), s: randomUUID(), p: randomUUID(), c: randomUUID() };
      await db.exec(`
        INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ('${ids.u}', 'U', 'u@x.com', 'h', '${NOW}', '${NOW}');
        INSERT INTO businesses (id, owner_id, name, slug, address, phone, created_at, updated_at)
          VALUES ('${ids.b}', '${ids.u}', 'N', 'neg', 'R', '11912345678', '${NOW}', '${NOW}');
        INSERT INTO services (id, business_id, name, name_key, duration_minutes, price_cents, created_at, updated_at)
          VALUES ('${ids.s}', '${ids.b}', 'Corte', 'corte', 60, 100, '${NOW}', '${NOW}');
        INSERT INTO professionals (id, business_id, name, name_key, created_at, updated_at)
          VALUES ('${ids.p}', '${ids.b}', 'Ana', 'ana', '${NOW}', '${NOW}');
        INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at)
          VALUES ('${ids.c}', '${ids.b}', 'Cli', '11912345678', 'c@x.com', '${NOW}', '${NOW}');`);
      await insertAppointmentDirect(db, {
        businessId: ids.b, professionalId: ids.p, customerId: ids.c, serviceId: ids.s, startsAt: '2026-11-27T13:00:00.000Z',
      });
      await db.close();
      const raw = new DatabaseSync(file);
      try {
        raw.exec('PRAGMA foreign_keys = ON;');
        const err = (() => {
          try {
            raw
              .prepare(
                `INSERT INTO appointments (id, business_id, professional_id, customer_id, service_id, service_name,
                   duration_minutes, price_cents, customer_name, customer_phone, starts_at, ends_at, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'Corte', 60, 100, 'Outra', '11912345678', ?, ?, 'confirmed', ?, ?)`,
              )
              .run(randomUUID(), ids.b, ids.p, ids.c, ids.s, '2026-11-27T13:30:00.000Z', '2026-11-27T14:30:00.000Z', NOW, NOW);
          } catch (e) {
            return e;
          }
          return null;
        })();
        assert.ok(err, 'o INSERT direto deveria falhar');
        assert.ok(translateError(err) instanceof ExclusionViolationError);
        assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM appointments').get().n), 1);
      } finally {
        raw.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('porta real de agendamentos (critérios 32 a 34 e 37)', () => {
  beforeEach(setup);
  afterEach(() => app.close());

  test('findBusyByBusiness exclui cancelados e removidos, aceita conn e não usa IN (', async () => {
    await insert({ startsAt: at('10:00') });
    await insert({ professionalId: pb.id, startsAt: at('14:00') });
    await insert({ startsAt: at('15:00'), status: 'cancelled' });
    await insert({ startsAt: at('10:00', '2026-11-30') });
    const from = at('00:00');
    const to = at('00:00', '2026-11-28');
    const all = await port().findBusyByBusiness(business.id, { professionalId: null }, from, to);
    assert.deepEqual([...all.keys()].sort(), [pa.id, pb.id].sort());
    assert.deepEqual(all.get(pa.id), [{ startsAt: at('10:00'), endsAt: at('11:00') }]);
    const onlyB = await app.db.transaction((tx) => port().findBusyByBusiness(business.id, { professionalId: pb.id }, from, to, tx));
    assert.deepEqual([...onlyB.keys()], [pb.id]);
    // Atendimento em andamento: começou antes do período e termina dentro dele.
    const partial = await port().findBusyByBusiness(business.id, { professionalId: null }, at('10:30'), at('10:45'));
    assert.deepEqual(partial.get(pa.id), [{ startsAt: at('10:00'), endsAt: at('11:00') }]);
    // Remover o profissional (com o agendamento cancelado antes) o tira da leitura.
    await app.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE professional_id = ?", [NOW, pb.id]);
    await insertAppointmentDirect(app.db, row({ professionalId: pb.id, startsAt: at('16:00') }));
    await app.db.run('UPDATE professionals SET removed_at = ? WHERE id = ?', [NOW, pb.id]);
    const afterRemoval = await port().findBusyByBusiness(business.id, { professionalId: null }, from, to);
    assert.equal(afterRemoval.has(pb.id), false);
    // SQL sem IN (.
    const seen = [];
    const original = app.db.all;
    app.db.all = function recorded(sql, params) {
      seen.push(sql);
      return original.call(this, sql, params);
    };
    try {
      await port().findBusyByBusiness(business.id, { professionalId: null }, from, to);
    } finally {
      app.db.all = original;
    }
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0], /\bIN\s*\(/i);
  });

  test('countFutureByService e countFutureByProfessional contam só starts_at > now não cancelados', async () => {
    await insert({ startsAt: at('10:00') });
    await insert({ startsAt: at('13:00'), status: 'cancelled' });
    await insert({ startsAt: at('08:00', '2026-11-26') }); // 11:00Z, antes de agora (12:00Z)
    await insert({ professionalId: pb.id, startsAt: at('10:00') });
    const nowIso = clock.now().toISOString();
    assert.equal(await port().countFutureByService(business.id, corte.id, nowIso), 2);
    const byA = await app.db.transaction((tx) => port().countFutureByProfessional(business.id, pa.id, nowIso, tx));
    assert.equal(byA, 1);
    assert.equal(await port().countFutureByService(business.id, randomUUID(), nowIso), 0);
  });

  test('findConflictsForBlock: total real, items cortado, ordem, snapshot e versionKey que muda ao inserir e ao cancelar', async () => {
    await app.db.run("UPDATE customers SET name = 'Nome Guardado' WHERE id = ?", [customerId]);
    const first = await insert({ startsAt: at('13:00'), customerName: 'Snapshot Um' });
    await insert({ startsAt: at('10:00'), customerName: 'Snapshot Dois' });
    await insert({ professionalId: pb.id, startsAt: at('10:00'), customerName: 'Outra Pessoa' });
    const block = { professionalId: pa.id, startsAt: at('09:00'), endsAt: at('18:00') };
    const run = (b = block, limit = 50) => app.db.transaction((tx) => port().findConflictsForBlock(business.id, b, limit, tx));
    const found = await run();
    assert.equal(found.total, 2);
    assert.deepEqual(found.items.map((i) => i.customerName), ['Snapshot Dois', 'Snapshot Um']);
    assert.deepEqual(Object.keys(found.items[0]).sort(), ['customerName', 'endsAt', 'id', 'professionalId', 'professionalName', 'serviceName', 'startsAt']);
    assert.equal(found.items[0].professionalName, 'Ana Souza');
    assert.equal(found.items[0].serviceName, 'Corte');
    assert.match(found.versionKey, /^[A-Za-z0-9_-]{43}$/);
    const limited = await run(block, 1);
    assert.equal(limited.total, 2);
    assert.equal(limited.items.length, 1);
    assert.equal(limited.versionKey, found.versionKey, 'o versionKey cobre o conjunto todo, não só os itens');
    assert.equal((await run()).versionKey, found.versionKey, 'não muda quando nada muda');
    const forAll = await run({ ...block, professionalId: null });
    assert.equal(forAll.total, 3);
    await insert({ startsAt: at('15:00') });
    const added = await run();
    assert.notEqual(added.versionKey, found.versionKey);
    await cancelDirect(app.db, first);
    const cancelled = await run();
    assert.equal(cancelled.total, 2);
    assert.notEqual(cancelled.versionKey, added.versionKey);
    // Intersecção semiaberta: terminar exatamente no início do bloqueio não conflita.
    const touching = await run({ professionalId: pa.id, startsAt: at('11:00'), endsAt: at('12:00') });
    assert.equal(touching.total, 0);
  });

  test('countFutureOutsideHours: dentro, fora no fim, no almoço, dia sem grade', async () => {
    const nowIso = clock.now().toISOString();
    const count = () => port().countFutureOutsideHours(business.id, pa.id, nowIso);
    assert.equal(await count(), 0);
    await insert({ startsAt: at('09:00') });
    assert.equal(await count(), 0);
    await insert({ startsAt: at('17:30') }); // termina 18:30, fora
    assert.equal(await count(), 1);
    await insert({ startsAt: at('11:30') }); // atravessa o almoço (12:00–13:00)
    assert.equal(await count(), 2);
    await insert({ startsAt: at('10:00', '2026-11-28') }); // sábado sem grade
    assert.equal(await count(), 3);
    await insert({ startsAt: at('14:00'), status: 'cancelled' });
    assert.equal(await count(), 3);
  });

  test('countFutureOutsideHours em America/New_York antes e depois do salto de 14/3/2027 (offset muda de -5 para -4)', async () => {
    await setBusinessTimezone(app, business.id, 'America/New_York');
    const nowIso = clock.now().toISOString();
    // Segunda 15/3 (EDT, UTC-4) e sexta 12/3 (EST, UTC-5): o mesmo 09:00 local em instantes diferentes.
    await insert({ startsAt: '2027-03-15T13:00:00.000Z' }); // 09:00 EDT: dentro
    await insert({ startsAt: '2027-03-12T14:00:00.000Z' }); // sexta 09:00 EST: dentro
    await insert({ startsAt: '2027-03-12T13:00:00.000Z' }); // sexta 08:00 EST: fora
    assert.equal(await port().countFutureOutsideHours(business.id, pa.id, nowIso), 1);
  });

  test(`countFutureOutsideHours varre no máximo ${OUTSIDE_HOURS_SCAN_MAX} agendamentos (limite inferior)`, async () => {
    // Sem grade, todo agendamento futuro fica fora. 1001 agendamentos de 15 min, sem sobreposição.
    const empty = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [] }));
    assert.equal((await putHours(app, ana, pa.id, empty)).statusCode, 200);
    await app.db.transaction(async (tx) => {
      for (let i = 0; i < OUTSIDE_HOURS_SCAN_MAX + 1; i++) {
        const startsAt = new Date(Date.parse('2026-11-28T00:00:00.000Z') + i * 15 * 60_000).toISOString();
        await insertAppointmentDirect(tx, row({ startsAt, durationMinutes: 15 }));
      }
    });
    const n = await port().countFutureOutsideHours(business.id, pa.id, clock.now().toISOString());
    assert.equal(n, OUTSIDE_HOURS_SCAN_MAX);
  });
});
