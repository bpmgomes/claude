import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository } from '../../src/modules/services/services.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import {
  createProfessionalsService,
  PROFESSIONALS_PER_BUSINESS_MAX,
} from '../../src/modules/professionals/professionals.service.js';
import { ConflictError, ProfessionalHasAppointmentsError, NotFoundError } from '../../src/http/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { textKey } from '../../src/shared/validation.js';
import { createClock } from '../helpers/clock.js';
import { pngOf } from '../helpers/images.js';

let db;
let ownerId;
let businessId;
let businessesRepository;
let professionalsRepository;
let servicesRepository;
let storage;
let clock;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  clock = createClock('2026-03-01T12:00:00.000Z');
  ownerId = randomUUID();
  await createUsersRepository(db).insert({
    id: ownerId,
    name: 'Ana',
    email: 'ana@x.com',
    passwordHash: '$2a$04$x',
    createdAt: clock.now().toISOString(),
  });
  businessesRepository = createBusinessesRepository(db);
  businessId = randomUUID();
  await businessesRepository.insert({
    id: businessId,
    ownerId,
    name: 'Salão',
    slug: 'salao',
    address: 'Rua A',
    phone: '11912345678',
    timezone: 'America/Sao_Paulo',
    createdAt: clock.now().toISOString(),
  });
  servicesRepository = createServicesRepository(db);
  professionalsRepository = createProfessionalsRepository(db);
  storage = createMemoryStorage();
});

afterEach(async () => {
  await db.close();
});

function build(extra = {}) {
  return createProfessionalsService({
    db,
    professionalsRepository,
    businessesRepository,
    storage,
    now: clock.now,
    ...extra,
  });
}

/**
 * Porta falsa: `byProfessional` é um número fixo ou uma função `(args) => number`.
 * Registra as chamadas e conta usando o `conn` recebido.
 */
function fakeAppointments({ byProfessional = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async countFutureByService() {
      return 0;
    },
    async countFutureByProfessional(...args) {
      calls.push(args);
      return typeof byProfessional === 'function' ? byProfessional(...args) : byProfessional;
    },
  };
}

async function makeService(name = 'Corte') {
  const id = randomUUID();
  await servicesRepository.insert({
    id,
    businessId,
    name,
    nameKey: textKey(name),
    durationMinutes: 30,
    priceCents: 100,
    priceOnRequest: false,
    createdAt: clock.now().toISOString(),
  });
  return id;
}

async function rowOf(id) {
  return db.get('SELECT name, photo_key, removed_at FROM professionals WHERE id = ?', [id]);
}

async function linksOf(id) {
  return (await db.all('SELECT service_id FROM professional_services WHERE professional_id = ? ORDER BY service_id', [id])).map(
    (r) => r.service_id,
  );
}

test('remove com 2 agendamentos futuros: 409, nada muda e a porta recebe (businessId, id, nowIso, tx)', async () => {
  const appointments = fakeAppointments({ byProfessional: 2 });
  const service = build({ appointments });
  const s = await makeService();
  const { professional } = await service.create(ownerId, { name: 'Ana', serviceIds: [s] });
  await service.setPhoto(ownerId, professional.id, await pngOf(10, 10));
  const before = await rowOf(professional.id);
  assert.ok(before.photo_key);
  clock.advance(60_000);

  await assert.rejects(
    service.remove(ownerId, professional.id),
    (err) =>
      err instanceof ProfessionalHasAppointmentsError &&
      err.statusCode === 409 &&
      err.code === 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS' &&
      err.futureAppointmentsCount === 2,
  );
  assert.deepEqual(await rowOf(professional.id), before);
  assert.deepEqual(await linksOf(professional.id), [s]);
  assert.deepEqual(storage.keys(), [before.photo_key]);

  assert.equal(appointments.calls.length, 1);
  const [bId, pId, nowIso, conn] = appointments.calls[0];
  assert.deepEqual([bId, pId, nowIso], [businessId, professional.id, '2026-03-01T12:01:00.000Z']);
  assert.ok(conn && typeof conn.get === 'function');
  assert.notEqual(conn, db, 'a porta recebe a conexão da transação, não o db global');
});

test('critério 18 simulado: depois de realocar ou cancelar (porta volta 0), a remoção passa', async () => {
  for (const path of ['realocar', 'cancelar']) {
    let pending = 3;
    const service = build({ appointments: fakeAppointments({ byProfessional: () => pending }) });
    const { professional } = await service.create(ownerId, { name: `Ana ${path}` });
    await assert.rejects(service.remove(ownerId, professional.id), ProfessionalHasAppointmentsError);
    pending = 0; // o dono realocou ou cancelou os agendamentos
    await service.remove(ownerId, professional.id);
    assert.ok((await rowOf(professional.id)).removed_at, path);
  }
});

test('sem agendamentos remove de primeira; foto apagada; nome fica no banco (critério 20)', async () => {
  const service = build();
  const { professional } = await service.create(ownerId, { name: 'Ana Souza' });
  const withPhoto = await service.setPhoto(ownerId, professional.id, await pngOf(10, 10));
  assert.ok(withPhoto.photoKey);
  await service.remove(ownerId, professional.id);
  const row = await rowOf(professional.id);
  assert.equal(row.name, 'Ana Souza');
  assert.equal(row.photo_key, null);
  assert.equal(row.removed_at, clock.now().toISOString());
  assert.deepEqual(storage.keys(), []);
  await assert.rejects(service.remove(ownerId, professional.id), NotFoundError);
});

test('porta que lança: rollback e profissional intacto (R6)', async () => {
  const service = build({
    appointments: {
      countFutureByService: async () => 0,
      countFutureByProfessional: async () => {
        throw new Error('banco de agendamentos fora');
      },
    },
  });
  const { professional } = await service.create(ownerId, { name: 'Ana' });
  await assert.rejects(service.remove(ownerId, professional.id), /banco de agendamentos fora/);
  assert.equal((await rowOf(professional.id)).removed_at, null);
});

test('concorrência (critério 19): remoção x agendamento seguindo o contrato do AF-11, 50 rodadas', async () => {
  await db.exec(`CREATE TABLE test_appointments (
    id TEXT PRIMARY KEY,
    professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE RESTRICT,
    starts_at TEXT NOT NULL,
    cancelled_at TEXT
  )`);
  const appointments = {
    countFutureByService: async () => 0,
    async countFutureByProfessional(bId, professionalId, nowIso, conn) {
      const row = await conn.get(
        'SELECT COUNT(*) AS n FROM test_appointments WHERE professional_id = ? AND cancelled_at IS NULL AND starts_at > ?',
        [professionalId, nowIso],
      );
      return Number(row.n);
    },
  };
  const service = build({ appointments });

  /**
   * Contrato do AF-11: claimForBooking e INSERT na mesma transação. `preReads` simula as
   * leituras que o AF-11 faz antes (negócio, serviço...) e varia o entrelaçamento com a remoção.
   */
  async function createTestAppointment(professionalId, preReads) {
    for (let k = 0; k < preReads; k++) await db.get('SELECT 1 AS x');
    return db.transaction(async (tx) => {
      const { changes } = await professionalsRepository.claimForBooking(professionalId, businessId, tx);
      if (changes === 0) throw new ConflictError('PROFESSIONAL_UNAVAILABLE', 'Profissional indisponível.');
      await tx.run('INSERT INTO test_appointments (id, professional_id, starts_at) VALUES (?, ?, ?)', [
        randomUUID(),
        professionalId,
        '2030-01-01T10:00:00.000Z',
      ]);
    });
  }

  let removedWins = 0;
  let bookingWins = 0;
  for (let i = 0; i < 50; i++) {
    const { professional } = await service.create(ownerId, { name: `P${i}` });
    const ops = [() => service.remove(ownerId, professional.id), () => createTestAppointment(professional.id, i % 3)];
    if (i % 2 === 1) ops.reverse();
    const settled = await Promise.allSettled(ops.map((op) => op()));
    const [removal, booking] = i % 2 === 1 ? [settled[1], settled[0]] : settled;

    for (const r of settled) {
      if (r.status === 'rejected') {
        assert.ok(
          r.reason instanceof ProfessionalHasAppointmentsError ||
            (r.reason instanceof ConflictError && r.reason.code === 'PROFESSIONAL_UNAVAILABLE'),
          `erro inesperado: ${r.reason}`,
        );
      }
    }
    const removed = Boolean((await rowOf(professional.id)).removed_at);
    const booked = Number(
      (await db.get('SELECT COUNT(*) AS n FROM test_appointments WHERE professional_id = ?', [professional.id])).n,
    );
    // Exatamente um efeito, nunca removido com agendamento futuro.
    assert.notEqual(removed && booked > 0, true, `rodada ${i}: removido com agendamento`);
    if (removed) {
      assert.equal(removal.status, 'fulfilled');
      assert.equal(booking.status, 'rejected');
      removedWins += 1;
    } else {
      assert.equal(booked, 1);
      assert.equal(booking.status, 'fulfilled');
      assert.equal(removal.status, 'rejected');
      bookingWins += 1;
    }
    // Remove o profissional da contagem do limite de 50 para as próximas rodadas.
    if (!removed) {
      await db.run('DELETE FROM test_appointments WHERE professional_id = ?', [professional.id]);
      await service.remove(ownerId, professional.id);
    }
  }
  assert.equal(removedWins + bookingWins, 50);
  assert.ok(removedWins > 0 && bookingWins > 0, 'as duas ordens foram exercitadas');
});

test('setPhoto com profissional removido no meio do processamento: 404 e a chave nova não fica', async () => {
  let targetId;
  const processImage = async () => {
    await professionalsRepository.markRemoved(targetId, businessId, clock.now().toISOString());
    return pngOf(256, 256);
  };
  const service = build({ processImage });
  const { professional } = await service.create(ownerId, { name: 'Ana' });
  targetId = professional.id;
  await assert.rejects(
    service.setPhoto(ownerId, professional.id, Buffer.from('x')),
    (err) => err instanceof NotFoundError && err.code === 'PROFESSIONAL_NOT_FOUND',
  );
  assert.deepEqual(storage.keys(), []);
});

test('setPhoto: 404 antes de processar (o processador nem é chamado)', async () => {
  let calls = 0;
  const service = build({
    processImage: async () => {
      calls += 1;
      return pngOf(1, 1);
    },
  });
  await assert.rejects(service.setPhoto(ownerId, randomUUID(), Buffer.from('x')), NotFoundError);
  await assert.rejects(service.setPhoto(ownerId, '../x', Buffer.from('x')), NotFoundError);
  assert.equal(calls, 0);
});

test('setPhoto usa o limitador de imagem só no processamento', async () => {
  const ran = [];
  const imageLimiter = {
    async run(task) {
      ran.push('limiter');
      const out = await task();
      ran.push('done');
      return out;
    },
  };
  const service = build({ imageLimiter, processImage: async () => pngOf(4, 4) });
  const { professional } = await service.create(ownerId, { name: 'Ana' });
  const updated = await service.setPhoto(ownerId, professional.id, Buffer.from('x'));
  assert.deepEqual(ran, ['limiter', 'done']);
  assert.match(updated.photoKey, /^professionals\/[0-9a-f-]{36}\.png$/);
});

test(`limite de ${PROFESSIONALS_PER_BUSINESS_MAX} ativos; duas criações simultâneas com 49 dão um sucesso e um 409`, async () => {
  const service = build();
  for (let i = 0; i < PROFESSIONALS_PER_BUSINESS_MAX - 1; i++) {
    await professionalsRepository.insert({
      id: randomUUID(),
      businessId,
      name: `P${i}`,
      nameKey: `p${i}`,
      createdAt: clock.now().toISOString(),
    });
  }
  const results = await Promise.allSettled([
    service.create(ownerId, { name: 'X' }),
    service.create(ownerId, { name: 'Y' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'PROFESSIONAL_LIMIT_REACHED');
  assert.equal(await professionalsRepository.countActiveByBusinessId(businessId), 50);
});

test('logs não levam o nome', async () => {
  const entries = [];
  const log = { info: (e) => entries.push(e), warn: (e) => entries.push(e), error() {} };
  const service = build({ log, appointments: fakeAppointments({ byProfessional: 1 }) });
  const { professional } = await service.create(ownerId, { name: 'Nome Secreto' });
  await service.update(ownerId, professional.id, { name: 'Outro Secreto' });
  await assert.rejects(service.remove(ownerId, professional.id));
  const events = entries.map((e) => e.event);
  assert.deepEqual(events, ['professional_created', 'professional_updated', 'professional_remove_blocked']);
  assert.equal(entries[2].futureAppointmentsCount, 1);
  assert.equal(JSON.stringify(entries).includes('Secreto'), false);
  for (const e of entries) {
    assert.deepEqual([e.userId, e.businessId, e.professionalId], [ownerId, businessId, professional.id]);
  }
});

test('dono sem negócio: BUSINESS_REQUIRED em todas as operações', async () => {
  const service = build();
  const stranger = randomUUID();
  const id = randomUUID();
  for (const call of [
    () => service.list(stranger),
    () => service.get(stranger, id),
    () => service.create(stranger, { name: 'X' }),
    () => service.update(stranger, id, { name: 'X' }),
    () => service.remove(stranger, id),
    () => service.setPhoto(stranger, id, Buffer.from('x')),
    () => service.removePhoto(stranger, id),
  ]) {
    await assert.rejects(call(), (err) => err.statusCode === 409 && err.code === 'BUSINESS_REQUIRED');
  }
});
