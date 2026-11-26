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
    'address', 'cancellationLeadMinutes', 'createdAt', 'id', 'logoUrl', 'name', 'phone', 'publicUrl', 'slug', 'timezone', 'updatedAt',
  ]);
  assert.equal(out.cancellationLeadMinutes, 120);
  assert.equal(out.publicUrl, 'https://agendafacil.app/salao');
  assert.equal(out.logoUrl, null);
});

// ---------------------------------------------------------------------------
// AF-09: página pública e quarentena do slug (critério 24).
// ---------------------------------------------------------------------------

test('findBySlug é exato: maiúsculas não casam', async () => {
  const b = await repo.insert(business(ownerA, 'salao-da-ana'));
  assert.equal((await repo.findBySlug('salao-da-ana')).id, b.id);
  assert.equal(await repo.findBySlug('Salao-Da-Ana'), undefined);
  assert.equal(await repo.findBySlug('salao'), undefined);
});

test('findTakenSlugs sem opções ignora a quarentena; com cutoffIso inclui a vigente de outro negócio', async () => {
  const a = await repo.insert(business(ownerA, 'salao'));
  const b = await repo.insert(business(ownerB, 'outro'));
  await repo.quarantineSlug('vigente', a.id, '2026-03-10T00:00:00.000Z');
  await repo.quarantineSlug('expirada', a.id, '2026-01-01T00:00:00.000Z');
  const candidates = ['salao', 'vigente', 'expirada', 'livre'];

  assert.deepEqual(await repo.findTakenSlugs(candidates), new Set(['salao']));
  const cutoffIso = '2026-02-01T00:00:00.000Z';
  assert.deepEqual(await repo.findTakenSlugs(candidates, { cutoffIso }), new Set(['salao', 'vigente']));
  assert.deepEqual(
    await repo.findTakenSlugs(candidates, { cutoffIso, exceptBusinessId: b.id }),
    new Set(['salao', 'vigente']),
  );
  // A quarentena do próprio negócio não conta.
  assert.deepEqual(await repo.findTakenSlugs(candidates, { cutoffIso, exceptBusinessId: a.id }), new Set(['salao']));

  assert.equal(await repo.isSlugQuarantined('vigente', { cutoffIso, exceptBusinessId: b.id }), true);
  assert.equal(await repo.isSlugQuarantined('vigente', { cutoffIso, exceptBusinessId: a.id }), false);
  assert.equal(await repo.isSlugQuarantined('expirada', { cutoffIso, exceptBusinessId: b.id }), false);
  assert.equal(await repo.isSlugQuarantined('livre', { cutoffIso, exceptBusinessId: null }), false);
});

test('quarantineSlug faz upsert; releaseQuarantine só apaga o do próprio negócio', async () => {
  const a = await repo.insert(business(ownerA, 'salao'));
  const b = await repo.insert(business(ownerB, 'outro'));
  await repo.quarantineSlug('x', a.id, '2026-01-01T00:00:00.000Z');
  await repo.quarantineSlug('x', b.id, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(await db.all('SELECT slug, business_id, released_at FROM slug_quarantine'), [
    { slug: 'x', business_id: b.id, released_at: '2026-03-01T00:00:00.000Z' },
  ]);
  assert.equal((await repo.releaseQuarantine('x', a.id)).changes, 0);
  assert.equal((await repo.releaseQuarantine('x', b.id)).changes, 1);
  assert.deepEqual(await db.all('SELECT slug FROM slug_quarantine'), []);
});

test('trimQuarantine mantém os 3 mais recentes do negócio e não toca os de outro', async () => {
  const a = await repo.insert(business(ownerA, 'salao'));
  const b = await repo.insert(business(ownerB, 'outro'));
  for (const [i, slug] of ['a1', 'a2', 'a3', 'a4', 'a5'].entries()) {
    await repo.quarantineSlug(slug, a.id, `2026-03-0${i + 1}T00:00:00.000Z`);
  }
  await repo.quarantineSlug('b1', b.id, '2026-01-01T00:00:00.000Z');
  await repo.trimQuarantine(a.id, 3);
  assert.deepEqual(
    (await db.all('SELECT slug FROM slug_quarantine ORDER BY slug')).map((r) => r.slug),
    ['a3', 'a4', 'a5', 'b1'],
  );
});
