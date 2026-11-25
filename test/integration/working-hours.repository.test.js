import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createWorkingHoursRepository } from '../../src/modules/working-hours/working-hours.repository.js';
import { textKey } from '../../src/shared/validation.js';

const NOW = '2026-03-01T12:00:00.000Z';

let db;
let professionals;
let hours;
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

async function makeProfessional(businessId, name = 'Ana') {
  const id = randomUUID();
  await professionals.insert({ id, businessId, name, nameKey: textKey(name), createdAt: NOW });
  return id;
}

function insertRaw(professionalId, businessId, weekday, start, end) {
  return db.run(
    `INSERT INTO working_hours (professional_id, business_id, weekday, start_minute, end_minute, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [professionalId, businessId, weekday, start, end, NOW],
  );
}

const interval = (startMinute, endMinute) => ({ startMinute, endMinute });

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  professionals = createProfessionalsRepository(db);
  hours = createWorkingHoursRepository(db);
  businessA = await makeBusiness('salao-a');
  businessB = await makeBusiness('salao-b');
});

afterEach(async () => {
  await db.close();
});

test('CHECK do banco: weekday 8, end 1441, start fora do passo e start >= end falham', async () => {
  const p = await makeProfessional(businessA);
  await insertRaw(p, businessA, 1, 540, 720); // válido
  for (const [weekday, start, end] of [
    [8, 540, 600],
    [0, 540, 600],
    [2, 1380, 1441],
    [2, 10, 60],
    [2, 600, 600],
    [2, 700, 600],
    [2, -15, 60],
  ]) {
    await assert.rejects(insertRaw(p, businessA, weekday, start, end), /CHECK constraint failed/, `${weekday} ${start} ${end}`);
  }
  assert.equal(await hours.countByProfessional(p, businessA), 1);
});

test('FK composta: grade com business_id de outro negócio falha no banco', async () => {
  const p = await makeProfessional(businessA);
  await assert.rejects(insertRaw(p, businessB, 1, 540, 600), /FOREIGN KEY constraint failed/);
});

test('replaceDays substitui só os dias enviados; [] vira folga', async () => {
  const p = await makeProfessional(businessA);
  await hours.replaceDays(
    p,
    businessA,
    [
      { weekday: 1, intervals: [interval(540, 720), interval(780, 1080)] },
      { weekday: 2, intervals: [interval(540, 720)] },
      { weekday: 3, intervals: [interval(600, 660)] },
    ],
    NOW,
  );
  await hours.replaceDays(
    p,
    businessA,
    [
      { weekday: 1, intervals: [interval(0, 1440)] },
      { weekday: 2, intervals: [] },
    ],
    NOW,
  );
  assert.deepEqual(await hours.findByProfessional(businessA, p), [
    { weekday: 1, startMinute: 0, endMinute: 1440 },
    { weekday: 3, startMinute: 600, endMinute: 660 },
  ]);
  assert.equal(await hours.countByProfessional(p, businessA), 2);
});

test('findByProfessional ordena por dia e início e filtra pelo negócio', async () => {
  const p = await makeProfessional(businessA);
  await insertRaw(p, businessA, 5, 780, 1080);
  await insertRaw(p, businessA, 1, 780, 1080);
  await insertRaw(p, businessA, 1, 540, 720);
  assert.deepEqual(
    (await hours.findByProfessional(businessA, p)).map((r) => [r.weekday, r.startMinute]),
    [
      [1, 540],
      [1, 780],
      [5, 780],
    ],
  );
  assert.deepEqual(await hours.findByProfessional(businessB, p), []);
  assert.equal(await hours.hasHours(businessB, p), false);
});

test('hasHours: recém-criado não tem expediente (critério 2)', async () => {
  const p = await makeProfessional(businessA);
  assert.equal(await hours.hasHours(businessA, p), false);
  await insertRaw(p, businessA, 1, 540, 600);
  assert.equal(await hours.hasHours(businessA, p), true);
});

test('depois de markRemoved, nada é devolvido, mas as linhas continuam na tabela (decisão 5)', async () => {
  const p = await makeProfessional(businessA);
  const other = await makeProfessional(businessA, 'Bia');
  await insertRaw(p, businessA, 1, 540, 600);
  await insertRaw(other, businessA, 2, 540, 600);
  await db.transaction((tx) => professionals.markRemoved(p, businessA, NOW, tx));

  assert.deepEqual(await hours.findByProfessional(businessA, p), []);
  assert.equal(await hours.hasHours(businessA, p), false);
  const weekly = await hours.findWeekly(businessA, [p, other]);
  assert.equal(weekly.has(p), false);
  assert.deepEqual(weekly.get(other), [{ weekday: 2, startMinute: 540, endMinute: 600 }]);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM working_hours WHERE professional_id = ?', [p])).n, 1);
});

test('findWeekly com 3 profissionais faz uma consulta só', async () => {
  const ids = [];
  for (const name of ['Ana', 'Bia', 'Cris']) {
    const id = await makeProfessional(businessA, name);
    await insertRaw(id, businessA, 1, 540, 600);
    await insertRaw(id, businessA, 3, 600, 660);
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
    run: (sql, params) => {
      calls.push(sql);
      return db.run(sql, params);
    },
  };
  const weekly = await createWorkingHoursRepository(counting).findWeekly(businessA, ids);
  assert.equal(calls.length, 1);
  assert.equal(weekly.size, 3);
  for (const id of ids) assert.equal(weekly.get(id).length, 2);
  // Lista vazia: nenhuma consulta.
  assert.equal((await createWorkingHoursRepository(counting).findWeekly(businessA, [])).size, 0);
  assert.equal(calls.length, 1);
});

test('lockActive: changes 1 para ativo, 0 para removido e para outro negócio', async () => {
  const p = await makeProfessional(businessA);
  const before = await db.get('SELECT updated_at FROM professionals WHERE id = ?', [p]);
  assert.equal((await professionals.lockActive(p, businessA)).changes, 1);
  assert.equal((await professionals.lockActive(p, businessB)).changes, 0);
  const after = await db.get('SELECT updated_at FROM professionals WHERE id = ?', [p]);
  assert.equal(after.updated_at, before.updated_at);
  await db.transaction((tx) => professionals.markRemoved(p, businessA, NOW, tx));
  assert.equal((await professionals.lockActive(p, businessA)).changes, 0);
  assert.equal((await professionals.claimForBooking(p, businessA)).changes, 0);
});
