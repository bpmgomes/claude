import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { UniqueViolationError } from '../../src/db/errors.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createServicesRepository } from '../../src/modules/services/services.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createWorkingHoursRepository } from '../../src/modules/working-hours/working-hours.repository.js';
import { textKey } from '../../src/shared/validation.js';

const NOW = '2026-03-01T12:00:00.000Z';

let db;
let repo;
let services;
let businessA;
let businessB;

async function makeBusiness(slug) {
  const ownerId = randomUUID();
  await createUsersRepository(db).insert({
    id: ownerId,
    name: 'Dono',
    email: `${slug}@x.com`,
    passwordHash: '$2a$04$x',
    createdAt: NOW,
  });
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

async function makeService(businessId, name, active = true) {
  const id = randomUUID();
  await services.insert({
    id,
    businessId,
    name,
    nameKey: textKey(name),
    durationMinutes: 30,
    priceCents: 100,
    priceOnRequest: false,
    active,
    createdAt: NOW,
  });
  return id;
}

async function makeProfessional(businessId, name, serviceIds = [], id = randomUUID()) {
  await repo.insert({ id, businessId, name, nameKey: textKey(name), createdAt: NOW });
  await repo.replaceServices(id, businessId, serviceIds, NOW);
  return id;
}

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createProfessionalsRepository(db);
  services = createServicesRepository(db);
  businessA = await makeBusiness('salao-a');
  businessB = await makeBusiness('salao-b');
});

afterEach(async () => {
  await db.close();
});

test('FK composta: vínculo com serviço de outro negócio falha no banco', async () => {
  const p = await makeProfessional(businessA, 'Ana');
  const foreign = await makeService(businessB, 'Corte');
  await assert.rejects(
    db.run('INSERT INTO professional_services (professional_id, service_id, business_id, created_at) VALUES (?, ?, ?, ?)', [
      p,
      foreign,
      businessA,
      NOW,
    ]),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    db.run('INSERT INTO professional_services (professional_id, service_id, business_id, created_at) VALUES (?, ?, ?, ?)', [
      p,
      foreign,
      businessB,
      NOW,
    ]),
    /FOREIGN KEY/,
  );
});

test('PK impede duplicata; replaceServices com par repetido não falha nem duplica (critério 9)', async () => {
  const s = await makeService(businessA, 'Corte');
  const p = await makeProfessional(businessA, 'Ana', [s]);
  await assert.rejects(
    db.run('INSERT INTO professional_services (professional_id, service_id, business_id, created_at) VALUES (?, ?, ?, ?)', [
      p,
      s,
      businessA,
      NOW,
    ]),
    (err) => err instanceof UniqueViolationError,
  );
  await repo.replaceServices(p, businessA, [s, s], NOW);
  await repo.replaceServices(p, businessA, [s], NOW);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM professional_services')).n, 1);
});

test('replaceServices substitui a lista inteira e [] limpa', async () => {
  const s1 = await makeService(businessA, 'Corte');
  const s2 = await makeService(businessA, 'Barba');
  const p = await makeProfessional(businessA, 'Ana', [s1]);
  await repo.replaceServices(p, businessA, [s2], NOW);
  assert.deepEqual((await repo.findById(p, businessA)).services.map((s) => s.id), [s2]);
  await repo.replaceServices(p, businessA, [], NOW);
  assert.deepEqual((await repo.findById(p, businessA)).services, []);
});

test('CHECK: removido não guarda foto', async () => {
  const p = await makeProfessional(businessA, 'Ana');
  await assert.rejects(
    db.run('UPDATE professionals SET removed_at = ?, photo_key = ? WHERE id = ?', [NOW, `professionals/${randomUUID()}.png`, p]),
    /CHECK/,
  );
});

test('listagem: só ativos, por name_key e depois id (critério 21)', async () => {
  const [low, high] = [randomUUID(), randomUUID()].sort();
  await makeProfessional(businessA, 'Bruno');
  await makeProfessional(businessA, 'Ana', [], high);
  await makeProfessional(businessA, 'ana', [], low);
  await makeProfessional(businessA, 'Ágata');
  const removed = await makeProfessional(businessA, 'Aaron');
  await repo.markRemoved(removed, businessA, NOW);
  await makeProfessional(businessB, 'Outro');

  const list = await repo.listByBusinessId(businessA);
  assert.deepEqual(
    list.map((p) => p.name),
    ['Ágata', 'ana', 'Ana', 'Bruno'],
  );
  assert.deepEqual([list[1].id, list[2].id], [low, high]);
});

test('serviços na ordem do AF-06 e desativado marcado active: false (critério 8)', async () => {
  const zebra = await makeService(businessA, 'Zebra');
  const alfa = await makeService(businessA, 'Alfa', false);
  const beta = await makeService(businessA, 'Beta');
  const p = await makeProfessional(businessA, 'Ana', [alfa, zebra, beta]);
  const found = await repo.findById(p, businessA);
  assert.deepEqual(found.services, [
    { id: beta, name: 'Beta', active: true },
    { id: zebra, name: 'Zebra', active: true },
    { id: alfa, name: 'Alfa', active: false },
  ]);
});

test('findBookableByBusinessId exclui rascunho, removido e quem só tem serviço desativado; reativar volta (critérios 7, 8)', async () => {
  const active = await makeService(businessA, 'Corte');
  const inactive = await makeService(businessA, 'Coloração', false);
  const ana = await makeProfessional(businessA, 'Ana', [active, inactive]);
  await makeProfessional(businessA, 'Rascunho');
  const onlyInactive = await makeProfessional(businessA, 'Bia', [inactive]);
  const removed = await makeProfessional(businessA, 'Carla', [active]);
  await repo.markRemoved(removed, businessA, NOW);

  let bookable = await repo.findBookableByBusinessId(businessA);
  assert.deepEqual(bookable.map((p) => p.id), [ana]);
  assert.deepEqual(bookable[0].services.map((s) => s.id), [active], 'só serviços ativos no contrato público');
  assert.equal(await repo.findBookable(businessA, onlyInactive), undefined);
  assert.equal(await repo.findBookable(businessA, removed), undefined);
  assert.equal((await repo.findBookable(businessA, ana)).id, ana);
  assert.equal(await repo.findBookable(businessB, ana), undefined);

  await services.setActive(inactive, businessA, true, NOW);
  bookable = await repo.findBookableByBusinessId(businessA);
  assert.deepEqual(bookable.map((p) => p.name), ['Ana', 'Bia']);
});

test('findBookableForService: só ativos vinculados; vazio se o serviço estiver desativado (critério 10)', async () => {
  const corte = await makeService(businessA, 'Corte');
  const barba = await makeService(businessA, 'Barba');
  const ana = await makeProfessional(businessA, 'Ana', [corte]);
  const bia = await makeProfessional(businessA, 'Bia', [corte, barba]);
  await makeProfessional(businessA, 'Carla', [barba]);
  const removed = await makeProfessional(businessA, 'Duda', [corte]);
  await repo.markRemoved(removed, businessA, NOW);

  assert.deepEqual((await repo.findBookableForService(businessA, corte)).map((p) => p.id), [ana, bia]);
  assert.deepEqual(await repo.findBookableForService(businessB, corte), []);
  await services.setActive(corte, businessA, false, NOW);
  assert.deepEqual(await repo.findBookableForService(businessA, corte), []);
});

test('claimForBooking: 1 para ativo; 0 para removido e para outro negócio (critério 19)', async () => {
  const p = await makeProfessional(businessA, 'Ana');
  assert.equal((await repo.claimForBooking(p, businessA)).changes, 1);
  assert.equal((await repo.claimForBooking(p, businessB)).changes, 0);
  const before = await repo.findById(p, businessA);
  assert.equal(before.updatedAt, NOW, 'claim não altera updated_at');
  await repo.markRemoved(p, businessA, '2026-03-02T00:00:00.000Z');
  assert.equal((await repo.claimForBooking(p, businessA)).changes, 0);
});

test('markRemoved: limpa foto, devolve a anterior; findByIdIncludingRemoved mantém o nome (critério 20)', async () => {
  const p = await makeProfessional(businessA, 'Ana Souza');
  const key = `professionals/${randomUUID()}.png`;
  await repo.setPhotoKey(p, businessA, key, NOW);
  assert.equal(await repo.existsPhotoKey(key), true);
  const result = await repo.markRemoved(p, businessA, NOW);
  assert.deepEqual(result, { previousPhotoKey: key, changes: 1 });
  assert.equal(await repo.existsPhotoKey(key), false);
  assert.equal(await repo.findById(p, businessA), undefined);
  const historic = await repo.findByIdIncludingRemoved(p, businessA);
  assert.equal(historic.name, 'Ana Souza');
  assert.equal(historic.removedAt, NOW);
  assert.deepEqual(await repo.markRemoved(p, businessA, NOW), { previousPhotoKey: null, changes: 0 });
  assert.equal((await repo.setPhotoKey(p, businessA, key, NOW)).changes, 0);
  assert.equal((await repo.updateName(p, businessA, { name: 'X', nameKey: 'x', updatedAt: NOW })).changes, 0);
  assert.equal((await repo.touch(p, businessA, NOW)).changes, 0);
});

test('countActiveByBusinessId, countSameName e findServiceIdsOfBusiness', async () => {
  const a = await makeProfessional(businessA, 'Ana');
  await makeProfessional(businessA, 'ANA');
  const removed = await makeProfessional(businessA, 'Aná');
  await repo.markRemoved(removed, businessA, NOW);
  assert.equal(await repo.countActiveByBusinessId(businessA), 2);
  assert.equal(await repo.countSameName(businessA, 'ana', a), 1);
  assert.equal(await repo.countSameName(businessA, 'ana', null), 2);
  assert.equal(await repo.countSameName(businessB, 'ana', null), 0);

  const own = await makeService(businessA, 'Corte', false);
  const foreign = await makeService(businessB, 'Corte');
  const found = await repo.findServiceIdsOfBusiness(businessA, [own, foreign, randomUUID()]);
  assert.deepEqual([...found], [own]);
  assert.deepEqual([...(await repo.findServiceIdsOfBusiness(businessA, []))], []);
});

test('listagem carrega serviços sem N+1 (2 consultas para 5 profissionais)', async () => {
  const s = await makeService(businessA, 'Corte');
  for (let i = 0; i < 5; i++) await makeProfessional(businessA, `P${i}`, [s]);
  let queries = 0;
  const counting = {
    run: (...a) => (queries++, db.run(...a)),
    get: (...a) => (queries++, db.get(...a)),
    all: (...a) => (queries++, db.all(...a)),
    transaction: (fn) => db.transaction(fn),
  };
  const list = await createProfessionalsRepository(counting).listByBusinessId(businessA);
  assert.equal(list.length, 5);
  assert.ok(list.every((p) => p.services.length === 1));
  assert.equal(queries, 2);

  queries = 0;
  await createProfessionalsRepository(counting).listByBusinessId(businessB);
  assert.equal(queries, 1, 'lista vazia não faz a 2ª consulta');
});

// ---------------------------------------------------------------------------
// AF-09 (critérios 4 e 5, decisão 4): contrato público com grade de horários.
// ---------------------------------------------------------------------------

async function giveHours(professionalId, businessId) {
  await createWorkingHoursRepository(db).replaceDays(
    professionalId,
    businessId,
    [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 600 }] }],
    NOW,
  );
}

test('findListedByBusinessId exclui rascunho, removido, só com serviço desativado e sem grade', async () => {
  const corte = await makeService(businessA, 'Corte');
  const barba = await makeService(businessA, 'Barba');
  const inactive = await makeService(businessA, 'Coloração', false);
  const ana = await makeProfessional(businessA, 'Ana', [corte, barba, inactive]);
  const bia = await makeProfessional(businessA, 'Bia', [corte]);
  const draft = await makeProfessional(businessA, 'Rascunho');
  const onlyInactive = await makeProfessional(businessA, 'Duda', [inactive]);
  const noHours = await makeProfessional(businessA, 'Eva', [corte]);
  const removed = await makeProfessional(businessA, 'Carla', [corte]);
  for (const id of [ana, bia, draft, onlyInactive, removed]) await giveHours(id, businessA);
  await repo.markRemoved(removed, businessA, NOW);

  let listed = await repo.findListedByBusinessId(businessA);
  assert.deepEqual(listed.map((p) => p.id), [ana, bia]);
  assert.deepEqual(listed[0].services.map((s) => s.name), ['Barba', 'Corte'], 'só ativos, na ordem do AF-06');
  assert.ok(listed[0].services.every((s) => s.active === true));
  assert.deepEqual(listed[1].services.map((s) => s.id), [corte]);

  await giveHours(noHours, businessA);
  listed = await repo.findListedByBusinessId(businessA);
  assert.deepEqual(listed.map((p) => p.name), ['Ana', 'Bia', 'Eva']);
});

test('findListedByBusinessId não vaza profissional nem serviço de outro negócio', async () => {
  const corteA = await makeService(businessA, 'Corte');
  const corteB = await makeService(businessB, 'Corte');
  const ana = await makeProfessional(businessA, 'Ana', [corteA]);
  const bia = await makeProfessional(businessB, 'Bia', [corteB]);
  await giveHours(ana, businessA);
  await giveHours(bia, businessB);
  const listedA = await repo.findListedByBusinessId(businessA);
  assert.deepEqual(listedA.map((p) => p.id), [ana]);
  assert.deepEqual(listedA[0].services.map((s) => s.id), [corteA]);
  assert.deepEqual((await repo.findListedByBusinessId(businessB)).map((p) => p.id), [bia]);
});

test('findListedByBusinessId faz 2 consultas, nenhuma com IN (', async () => {
  const ids = [];
  const corte = await makeService(businessA, 'Corte');
  for (const name of ['Ana', 'Bia', 'Cris', 'Duda', 'Eva']) {
    const id = await makeProfessional(businessA, name, [corte]);
    await giveHours(id, businessA);
    ids.push(id);
  }
  const calls = [];
  const counting = {
    all: (sql, params) => {
      calls.push(sql);
      return db.all(sql, params);
    },
    get: (sql, params) => {
      calls.push(sql);
      return db.get(sql, params);
    },
  };
  const listed = await createProfessionalsRepository(counting).findListedByBusinessId(businessA);
  assert.equal(listed.length, 5);
  assert.equal(calls.length, 2);
  for (const sql of calls) assert.doesNotMatch(sql, /\bIN\s*\(/i);
  // Sem ninguém listado: uma consulta só.
  calls.length = 0;
  assert.deepEqual(await createProfessionalsRepository(counting).findListedByBusinessId(businessB), []);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// AF-16: markRemoved apaga os bloqueios do profissional; lockAllActive.
// ---------------------------------------------------------------------------

async function insertBlock(businessId, professionalId) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
     VALUES (?, ?, ?, '2026-12-24T17:00:00.000Z', '2026-12-24T21:00:00.000Z', NULL, NULL, ?)`,
    [id, businessId, professionalId, NOW],
  );
  return id;
}

const blockIds = async () => (await db.all('SELECT id FROM time_blocks ORDER BY id')).map((r) => r.id).sort();

test('markRemoved apaga os time_blocks do profissional e mantém os de "todos" e os de outros (AF-16, critério 17)', async () => {
  const ana = await makeProfessional(businessA, 'Ana');
  const bia = await makeProfessional(businessA, 'Bia');
  await insertBlock(businessA, ana);
  await insertBlock(businessA, ana);
  const keep = [await insertBlock(businessA, bia), await insertBlock(businessA, null), await insertBlock(businessB, null)];
  const result = await repo.markRemoved(ana, businessA, NOW);
  assert.equal(result.changes, 1);
  assert.deepEqual(await blockIds(), keep.sort());
});

test('markRemoved sem efeito (já removido ou de outro negócio) não apaga bloqueios', async () => {
  const ana = await makeProfessional(businessA, 'Ana');
  const block = await insertBlock(businessA, ana);
  assert.equal((await repo.markRemoved(ana, businessB, NOW)).changes, 0);
  assert.deepEqual(await blockIds(), [block]);
});

test('lockAllActive só afeta os ativos do negócio e não altera dados', async () => {
  await makeProfessional(businessA, 'Ana');
  await makeProfessional(businessA, 'Bia');
  const removed = await makeProfessional(businessA, 'Cris');
  await repo.markRemoved(removed, businessA, NOW);
  await makeProfessional(businessB, 'Duda');
  const before = await db.all('SELECT id, updated_at FROM professionals ORDER BY id');
  assert.deepEqual(await repo.lockAllActive(businessA), { changes: 2 });
  assert.deepEqual(await db.all('SELECT id, updated_at FROM professionals ORDER BY id'), before);
});
