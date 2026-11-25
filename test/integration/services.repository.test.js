import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository } from '../../src/modules/services/services.repository.js';
import { serviceNameKey } from '../../src/shared/services.js';

let db;
let repo;
let businessA;
let businessB;

async function business(email, slug) {
  const ownerId = randomUUID();
  await createUsersRepository(db).insert({
    id: ownerId,
    name: 'Dono',
    email,
    passwordHash: '$2a$04$x',
    createdAt: new Date().toISOString(),
  });
  const b = await createBusinessesRepository(db).insert({
    id: randomUUID(),
    ownerId,
    name: 'Salão',
    slug,
    address: 'Rua A',
    phone: '11912345678',
    timezone: 'America/Sao_Paulo',
    createdAt: new Date().toISOString(),
  });
  return b.id;
}

function service(businessId, name, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    businessId,
    name,
    nameKey: serviceNameKey(name),
    durationMinutes: 30,
    priceCents: 5000,
    priceOnRequest: false,
    active: true,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function rawInsert(values) {
  const v = {
    id: randomUUID(),
    business_id: businessA,
    name: 'X',
    name_key: `x-${randomUUID()}`,
    duration_minutes: 30,
    price_cents: 100,
    price_on_request: 0,
    active: 1,
    ...values,
  };
  return db.run(
    `INSERT INTO services (id, business_id, name, name_key, duration_minutes, price_cents, price_on_request, active,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`,
    [v.id, v.business_id, v.name, v.name_key, v.duration_minutes, v.price_cents, v.price_on_request, v.active],
  );
}

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createServicesRepository(db);
  businessA = await business('a@x.com', 'salao-a');
  businessB = await business('b@x.com', 'salao-b');
});

afterEach(async () => {
  await db.close();
});

test('mesmo name_key no mesmo negócio: UniqueViolationError services_business_id_name_key_unique (critério 20)', async () => {
  await repo.insert(service(businessA, 'Corte Masculino'));
  await assert.rejects(repo.insert(service(businessA, 'CÓRTE  masculino')), (err) => {
    assert.ok(err instanceof UniqueViolationError);
    assert.equal(err.constraint, 'services_business_id_name_key_unique');
    return true;
  });
  // vale também contra desativados
  await repo.insert(service(businessA, 'Barba', { active: false }));
  await assert.rejects(repo.insert(service(businessA, 'barba')), UniqueViolationError);
});

test('mesmo name_key em negócios diferentes é aceito', async () => {
  await repo.insert(service(businessA, 'Corte'));
  await repo.insert(service(businessB, 'Corte'));
  assert.equal(await repo.countByBusinessId(businessA), 1);
  assert.equal(await repo.countByBusinessId(businessB), 1);
});

test('as regras estão no banco: CHECK rejeita INSERT direto inválido', async () => {
  for (const values of [
    { duration_minutes: 20 },
    { duration_minutes: 495 },
    { duration_minutes: 0 },
    { price_cents: -1 },
    { price_cents: 10000000 },
    { price_on_request: 1, price_cents: 100 },
    { price_on_request: 0, price_cents: null },
    { price_on_request: 2 },
    { active: 2 },
  ]) {
    await assert.rejects(rawInsert(values), /CHECK constraint failed/, JSON.stringify(values));
  }
  await rawInsert({ price_on_request: 1, price_cents: null });
  await rawInsert({ price_cents: 0 });
});

test('price_cents é gravado como inteiro', async () => {
  const s = await repo.insert(service(businessA, 'Corte', { priceCents: 5050 }));
  const row = await db.get('SELECT typeof(price_cents) AS t, price_cents FROM services WHERE id = ?', [s.id]);
  assert.equal(row.t, 'integer');
  assert.equal(row.price_cents, 5050);
});

test('update e setActive com business_id errado dão changes = 0', async () => {
  const s = await repo.insert(service(businessA, 'Corte'));
  const now = new Date().toISOString();
  assert.equal((await repo.update(s.id, businessB, { name: 'Hack', nameKey: 'hack', updatedAt: now })).changes, 0);
  assert.equal((await repo.setActive(s.id, businessB, false, now)).changes, 0);
  assert.equal(await repo.findById(s.id, businessB), undefined);
  const still = await repo.findById(s.id, businessA);
  assert.equal(still.name, 'Corte');
  assert.equal(still.active, true);
});

test('update grava NULL em priceCents junto com priceOnRequest e lança UniqueViolationError', async () => {
  const s = await repo.insert(service(businessA, 'Corte'));
  await repo.insert(service(businessA, 'Barba'));
  const now = new Date().toISOString();
  assert.equal((await repo.update(s.id, businessA, { priceCents: null, priceOnRequest: true, updatedAt: now })).changes, 1);
  const updated = await repo.findById(s.id, businessA);
  assert.equal(updated.priceCents, null);
  assert.equal(updated.priceOnRequest, true);
  assert.equal(updated.updatedAt, now);
  await assert.rejects(
    repo.update(s.id, businessA, { name: 'BARBA', nameKey: 'barba', updatedAt: now }),
    (err) => err instanceof UniqueViolationError && err.constraint === 'services_business_id_name_key_unique',
  );
});

test('listByBusinessId: ativos primeiro, depois nome sem acento, desempate por id; filtro por estado', async () => {
  await repo.insert(service(businessA, 'Barba'));
  await repo.insert(service(businessA, 'Ácido'));
  await repo.insert(service(businessA, 'Zebra', { active: false }));
  await repo.insert(service(businessA, 'Alisamento', { active: false }));
  await repo.insert(service(businessB, 'Outro'));
  const names = (await repo.listByBusinessId(businessA)).map((s) => s.name);
  assert.deepEqual(names, ['Ácido', 'Barba', 'Alisamento', 'Zebra']);
  assert.deepEqual((await repo.listByBusinessId(businessA, { status: 'active' })).map((s) => s.name), ['Ácido', 'Barba']);
  assert.deepEqual(
    (await repo.listByBusinessId(businessA, { status: 'inactive' })).map((s) => s.name),
    ['Alisamento', 'Zebra'],
  );
  assert.equal(await repo.countByBusinessId(businessA), 4);
});

test('listByBusinessId é estável: mesma ordem a cada chamada, com id como último critério', async () => {
  // Dentro de um negócio, (active, name_key) nunca empata por causa da constraint única;
  // o `id` no ORDER BY só garante determinismo. Aqui conferimos a ordem estável.
  for (const name of ['Corte', 'Barba', 'Escova', 'Hidratação']) await repo.insert(service(businessA, name));
  await repo.insert(service(businessA, 'Progressiva', { active: false }));
  const first = (await repo.listByBusinessId(businessA)).map((s) => s.id);
  for (let i = 0; i < 3; i++) assert.deepEqual((await repo.listByBusinessId(businessA)).map((s) => s.id), first);
  assert.deepEqual(
    (await repo.findActiveByBusinessId(businessA)).map((s) => s.name),
    ['Barba', 'Corte', 'Escova', 'Hidratação'],
  );
});

test('findActiveByBusinessId e findBookable ignoram desativados e incluem sob consulta (critério 14)', async () => {
  const active = await repo.insert(service(businessA, 'Corte'));
  const onRequest = await repo.insert(service(businessA, 'Coloração', { priceCents: null, priceOnRequest: true }));
  const inactive = await repo.insert(service(businessA, 'Barba', { active: false }));
  const listed = (await repo.findActiveByBusinessId(businessA)).map((s) => s.name);
  assert.deepEqual(listed, ['Coloração', 'Corte']);
  assert.equal((await repo.findBookable(businessA, active.id)).id, active.id);
  assert.equal((await repo.findBookable(businessA, onRequest.id)).priceOnRequest, true);
  assert.equal(await repo.findBookable(businessA, inactive.id), undefined);
  assert.equal(await repo.findBookable(businessB, active.id), undefined);
});

test('excluir o negócio remove os serviços (ON DELETE CASCADE)', async () => {
  await repo.insert(service(businessA, 'Corte'));
  await db.run('DELETE FROM businesses WHERE id = ?', [businessA]);
  assert.equal(await repo.countByBusinessId(businessA), 0);
});
