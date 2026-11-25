import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createUsersRepository, toPublicUser } from '../../src/modules/accounts/users.repository.js';

let db;
let repo;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createUsersRepository(db);
});

afterEach(async () => {
  await db.close();
});

function user(email) {
  return { id: randomUUID(), name: 'Ana', email, passwordHash: '$2a$04$x', createdAt: new Date().toISOString() };
}

test('mesmo e-mail duas vezes direto no repositório lança UniqueViolationError (critério 6)', async () => {
  await repo.insert(user('ana@x.com'));
  await assert.rejects(repo.insert(user('ana@x.com')), (err) => {
    assert.ok(err instanceof UniqueViolationError);
    assert.equal(err.constraint, 'users_email_unique');
    return true;
  });
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users');
  assert.equal(n, 1);
});

test('findById / findByEmail mapeiam colunas para camelCase', async () => {
  const u = user('bia@x.com');
  await repo.insert(u);
  const found = await repo.findById(u.id);
  assert.equal(found.email, 'bia@x.com');
  assert.equal(found.passwordHash, '$2a$04$x');
  assert.equal(found.createdAt, u.createdAt);
  assert.deepEqual(await repo.findByEmail('bia@x.com'), found);
  assert.equal(await repo.findById(randomUUID()), undefined);
});

test('toPublicUser não expõe passwordHash', () => {
  const pub = toPublicUser({ ...user('c@x.com'), updatedAt: 'x' });
  assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'email', 'id', 'name']);
});

test('migrações são idempotentes', async () => {
  assert.deepEqual(await runMigrations(db), []);
  const rows = await db.all('SELECT version FROM schema_migrations');
  assert.deepEqual(rows.map((r) => r.version), ['001_users_sessions', '002_login_attempts']);
});

test('transaction faz rollback em erro', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      await createUsersRepository(tx).insert(user('d@x.com'));
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await repo.findByEmail('d@x.com'), undefined);
});
