import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createCustomersRepository } from '../../src/modules/customers/customers.repository.js';
import { countCustomers } from '../helpers/customers.js';

const NOW = '2026-11-26T12:00:00.000Z';
const LATER = '2026-11-27T12:00:00.000Z';

let db;
let repo;
let businessA;
let businessB;

async function makeBusiness(slug) {
  const ownerId = randomUUID();
  await createUsersRepository(db).insert({ id: ownerId, name: 'Dono', email: `${slug}@x.com`, passwordHash: '$2a$04$x', createdAt: NOW });
  const id = randomUUID();
  await createBusinessesRepository(db).insert({
    id,
    ownerId,
    name: slug,
    slug,
    address: 'Rua A',
    phone: '11912345678',
    timezone: 'America/Sao_Paulo',
    createdAt: NOW,
  });
  return id;
}

const customer = (businessId, overrides = {}) => ({
  id: randomUUID(),
  businessId,
  name: 'Ana Souza',
  phone: '11912345678',
  email: 'ana@example.com',
  createdAt: NOW,
  ...overrides,
});

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createCustomersRepository(db);
  businessA = await makeBusiness('negocio-a');
  businessB = await makeBusiness('negocio-b');
});

afterEach(async () => {
  await db.close();
});

test('insertIfAbsent cria com changes 1; findById devolve as 7 colunas (critério 15)', async () => {
  const input = customer(businessA);
  assert.deepEqual(await repo.insertIfAbsent(input), { changes: 1 });
  assert.deepEqual(await repo.findById(input.id, businessA), {
    id: input.id,
    businessId: businessA,
    name: 'Ana Souza',
    phone: '11912345678',
    email: 'ana@example.com',
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(await repo.findIdByEmail(businessA, 'ana@example.com'), input.id);
});

test('repetido: changes 0 e a linha existente não muda (decisão 1, critério 8)', async () => {
  const first = customer(businessA);
  await repo.insertIfAbsent(first);
  const again = customer(businessA, { name: 'Outra Pessoa', phone: '21987654321', createdAt: LATER });
  assert.deepEqual(await repo.insertIfAbsent(again), { changes: 0 });
  const row = await repo.findById(first.id, businessA);
  assert.equal(row.name, 'Ana Souza');
  assert.equal(row.phone, '11912345678');
  assert.equal(row.updatedAt, NOW);
  assert.equal(await repo.findById(again.id, businessA), undefined);
  assert.equal(await countCustomers(db, businessA), 1);
});

test('INSERT direto repetido: UniqueViolationError customers_business_id_email_unique (critério 12)', async () => {
  await repo.insertIfAbsent(customer(businessA));
  await assert.rejects(
    db.run(
      `INSERT INTO customers (id, business_id, name, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), businessA, 'Bia', '11912345679', 'ana@example.com', NOW, NOW],
    ),
    (err) => err instanceof UniqueViolationError && err.constraint === 'customers_business_id_email_unique',
  );
});

test('o mesmo e-mail em outro negócio é outra linha; nenhuma busca cruza negócios (critério 9)', async () => {
  const a = customer(businessA);
  const b = customer(businessB, { name: 'Ana do B' });
  assert.equal((await repo.insertIfAbsent(a)).changes, 1);
  assert.equal((await repo.insertIfAbsent(b)).changes, 1);
  assert.notEqual(a.id, b.id);
  assert.equal(await repo.findIdByEmail(businessA, 'ana@example.com'), a.id);
  assert.equal(await repo.findIdByEmail(businessB, 'ana@example.com'), b.id);
  assert.equal(await repo.findById(a.id, businessB), undefined);
  assert.equal(await repo.findById(b.id, businessA), undefined);
  assert.equal(await repo.findIdByEmail(randomUUID(), 'ana@example.com'), undefined);
});

test('CHECKs recusam telefone de 9 dígitos e nome de 1 caractere', async () => {
  await assert.rejects(repo.insertIfAbsent(customer(businessA, { phone: '119123456' })), /CHECK constraint failed/);
  await assert.rejects(repo.insertIfAbsent(customer(businessA, { name: 'A' })), /CHECK constraint failed/);
  await assert.rejects(repo.insertIfAbsent(customer(businessA, { email: 'a@' })), /CHECK constraint failed/);
  assert.equal(await countCustomers(db), 0);
});

test('negócio inexistente: a FK recusa', async () => {
  await assert.rejects(repo.insertIfAbsent(customer(randomUUID())), /FOREIGN KEY constraint failed/);
});

test('apagar o negócio apaga os clientes (cascade)', async () => {
  await repo.insertIfAbsent(customer(businessA));
  await repo.insertIfAbsent(customer(businessB));
  await db.run('DELETE FROM businesses WHERE id = ?', [businessA]);
  assert.equal(await countCustomers(db, businessA), 0);
  assert.equal(await countCustomers(db, businessB), 1);
});

test('a tabela tem só as 7 colunas da seção 3 (minimização, critério 15)', async () => {
  const columns = (await db.all('PRAGMA table_info(customers)')).map((c) => c.name);
  assert.deepEqual(columns, ['id', 'business_id', 'name', 'phone', 'email', 'created_at', 'updated_at']);
});
