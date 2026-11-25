import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository, toServiceSnapshot } from '../../src/modules/services/services.repository.js';
import { createServicesService } from '../../src/modules/services/services.service.js';
import { createClock } from '../helpers/clock.js';

let db;
let ownerId;
let businessId;
let servicesRepository;
let businessesRepository;
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
});

afterEach(async () => {
  await db.close();
});

function build(extra = {}) {
  return createServicesService({ db, servicesRepository, businessesRepository, now: clock.now, ...extra });
}

test('porta appointments: deactivate devolve a contagem e a porta recebe (businessId, serviceId, nowIso)', async () => {
  const calls = [];
  const appointments = {
    async countFutureByService(...args) {
      calls.push(args);
      return 3;
    },
  };
  const service = build({ appointments });
  const created = await service.create(ownerId, { name: 'Corte', durationMinutes: 30, price: '50' });
  clock.advance(60_000);
  const result = await service.deactivate(ownerId, created.id);
  assert.equal(result.futureAppointmentsCount, 3);
  assert.equal(result.service.active, false);
  assert.deepEqual(calls, [[businessId, created.id, '2026-03-01T12:01:00.000Z']]);
  assert.equal((await servicesRepository.findById(created.id, businessId)).active, false);
});

test('porta que lança: serviço desativado mesmo assim, futureAppointmentsCount null e log', async () => {
  const warnings = [];
  const log = { info() {}, error() {}, warn: (entry) => warnings.push(entry) };
  const appointments = {
    async countFutureByService() {
      throw new Error('banco de agendamentos fora');
    },
  };
  const service = build({ appointments, log });
  const created = await service.create(ownerId, { name: 'Corte', durationMinutes: 30, price: '50' });
  const result = await service.deactivate(ownerId, created.id);
  assert.equal(result.futureAppointmentsCount, null);
  assert.equal(result.service.active, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'service_future_count_failed');
  assert.equal(warnings[0].serviceId, created.id);
});

test('sem porta: usa noAppointments (0)', async () => {
  const service = build();
  const created = await service.create(ownerId, { name: 'Corte', durationMinutes: 30, price: '50' });
  assert.equal((await service.deactivate(ownerId, created.id)).futureAppointmentsCount, 0);
});

test('editar preço e duração não altera um snapshot tirado antes (critério 11)', async () => {
  const service = build();
  const created = await service.create(ownerId, { name: 'Corte', durationMinutes: 30, price: '50,00' });
  const snapshot = toServiceSnapshot(created);
  const updated = await service.update(ownerId, created.id, { durationMinutes: 60, price: '80' });
  assert.equal(updated.durationMinutes, 60);
  assert.equal(updated.priceCents, 8000);
  await service.deactivate(ownerId, created.id);
  assert.deepEqual(snapshot, {
    serviceId: created.id,
    name: 'Corte',
    durationMinutes: 30,
    priceCents: 5000,
    priceOnRequest: false,
  });
});

test('dono sem negócio: BUSINESS_REQUIRED em todas as operações', async () => {
  const service = build();
  const stranger = randomUUID();
  const id = randomUUID();
  for (const call of [
    () => service.list(stranger, {}),
    () => service.get(stranger, id),
    () => service.create(stranger, { name: 'X', durationMinutes: 30, price: '1' }),
    () => service.update(stranger, id, { name: 'X' }),
    () => service.deactivate(stranger, id),
    () => service.reactivate(stranger, id),
  ]) {
    await assert.rejects(call(), (err) => err.statusCode === 409 && err.code === 'BUSINESS_REQUIRED');
  }
});
