import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import {
  createBusinessesRepository,
  toOwnerBusiness,
} from '../../src/modules/businesses/businesses.repository.js';

let db;
let repo;
let ownerA;
let ownerB;

async function owner(email) {
  const id = randomUUID();
  await createUsersRepository(db).insert({
    id,
    name: 'Dono',
    email,
    passwordHash: '$2a$04$x',
    createdAt: new Date().toISOString(),
  });
  return id;
}

function business(ownerId, slug, extra = {}) {
  return {
    id: randomUUID(),
    ownerId,
    name: 'Salão',
    slug,
    address: 'Rua A, 10',
    phone: '11912345678',
    timezone: 'America/Sao_Paulo',
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createBusinessesRepository(db);
  ownerA = await owner('a@x.com');
  ownerB = await owner('b@x.com');
});

afterEach(async () => {
  await db.close();
});

test('dois negócios do mesmo dono: UniqueViolationError businesses_owner_id_unique (critério 6)', async () => {
  await repo.insert(business(ownerA, 'salao-a'));
  await assert.rejects(repo.insert(business(ownerA, 'salao-b')), (err) => {
    assert.ok(err instanceof UniqueViolationError);
    assert.equal(err.constraint, 'businesses_owner_id_unique');
    return true;
  });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM businesses')).n, 1);
});

test('mesmo slug para donos diferentes: UniqueViolationError businesses_slug_unique (critério 17)', async () => {
  await repo.insert(business(ownerA, 'salao'));
  await assert.rejects(repo.insert(business(ownerB, 'salao')), (err) => {
    assert.ok(err instanceof UniqueViolationError);
    assert.equal(err.constraint, 'businesses_slug_unique');
    return true;
  });
});

test('update com ownerId errado não altera nada (critério 7)', async () => {
  const b = await repo.insert(business(ownerA, 'salao'));
  const { changes } = await repo.update(b.id, ownerB, { name: 'Invadido', updatedAt: new Date().toISOString() });
  assert.equal(changes, 0);
  assert.equal((await repo.findByOwnerId(ownerA)).name, 'Salão');

  const ok = await repo.update(b.id, ownerA, { name: 'Novo', ownerId: ownerB, updatedAt: 'x' });
  assert.equal(ok.changes, 1);
  const after = await repo.findByOwnerId(ownerA);
  assert.equal(after.name, 'Novo');
  assert.equal(after.ownerId, ownerA, 'ownerId não está na lista de colunas editáveis');
});

test('setLogoKey com ownerId errado não altera nada e devolve a chave anterior com o dono certo', async () => {
  const b = await repo.insert(business(ownerA, 'salao'));
  const key = `logos/${randomUUID()}.png`;
  assert.deepEqual(await repo.setLogoKey(b.id, ownerB, key, 'x'), { previousKey: null, changes: 0 });
  assert.deepEqual(await repo.setLogoKey(b.id, ownerA, key, 'x'), { previousKey: null, changes: 1 });
  assert.equal(await repo.existsLogoKey(key), true);
  const { previousKey } = await repo.setLogoKey(b.id, ownerA, null, 'y');
  assert.equal(previousKey, key);
  assert.equal(await repo.existsLogoKey(key), false);
});

test('timezone usa o DEFAULT da coluna se não for informado', async () => {
  await db.run(
    `INSERT INTO businesses (id, owner_id, name, slug, address, phone, created_at, updated_at)
     VALUES (?, ?, 'S', 'salao', 'R', '11912345678', 'x', 'x')`,
    [randomUUID(), ownerA],
  );
  assert.equal((await repo.findByOwnerId(ownerA)).timezone, 'America/Sao_Paulo');
});

test('findTakenSlugs devolve só os usados', async () => {
  await repo.insert(business(ownerA, 'salao'));
  await repo.insert(business(ownerB, 'salao-2'));
  assert.deepEqual(await repo.findTakenSlugs(['salao', 'salao-2', 'salao-3']), new Set(['salao', 'salao-2']));
  assert.deepEqual(await repo.findTakenSlugs([]), new Set());
});

test('apagar o dono apaga o negócio (ON DELETE CASCADE)', async () => {
  await repo.insert(business(ownerA, 'salao'));
  await db.run('DELETE FROM users WHERE id = ?', [ownerA]);
  assert.equal(await repo.findByOwnerId(ownerA), undefined);
});

test('toOwnerBusiness não expõe ownerId nem logoKey', async () => {
  const b = await repo.insert(business(ownerA, 'salao'));
  const out = toOwnerBusiness(b, { publicBaseUrl: 'https://agendafacil.app' });
  assert.deepEqual(Object.keys(out).sort(), [
    'address', 'createdAt', 'id', 'logoUrl', 'name', 'phone', 'publicUrl', 'slug', 'timezone', 'updatedAt',
  ]);
  assert.equal(out.publicUrl, 'https://agendafacil.app/salao');
  assert.equal(out.logoUrl, null);
});
