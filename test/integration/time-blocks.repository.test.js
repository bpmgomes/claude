import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import {
  createTimeBlocksRepository,
  FIND_APPLICABLE_RANGE_MAX_DAYS,
} from '../../src/modules/time-blocks/time-blocks.repository.js';
import { textKey } from '../../src/shared/validation.js';

const NOW = '2026-12-01T12:00:00.000Z';

let db;
let repo;
let professionals;
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

async function makeProfessional(businessId, name) {
  const id = randomUUID();
  await professionals.insert({ id, businessId, name, nameKey: textKey(name), createdAt: NOW });
  return id;
}

async function block(businessId, professionalId, startsAt, endsAt, extra = {}) {
  const id = extra.id || randomUUID();
  await repo.insert({
    id,
    businessId,
    professionalId,
    startsAt,
    endsAt,
    reasonKind: extra.reasonKind ?? null,
    reasonNote: extra.reasonNote ?? null,
    createdAt: NOW,
  });
  return id;
}

const rawInsert = (values) =>
  db.run(
    `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    values,
  );

const iso = (text) => `${text}:00.000Z`;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  repo = createTimeBlocksRepository(db);
  professionals = createProfessionalsRepository(db);
  businessA = await makeBusiness('salao-a');
  businessB = await makeBusiness('salao-b');
});

afterEach(async () => {
  await db.close();
});

describe('constraints (critério 8)', () => {
  test('CHECK recusa início >= fim, offset e reason_kind desconhecido', async () => {
    await assert.rejects(rawInsert([randomUUID(), businessA, null, iso('2026-12-24T21:00'), iso('2026-12-24T17:00'), null, null, NOW]), /CHECK/);
    await assert.rejects(rawInsert([randomUUID(), businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T17:00'), null, null, NOW]), /CHECK/);
    await assert.rejects(
      rawInsert([randomUUID(), businessA, null, '2026-12-24T14:00:00.000-03:00', iso('2026-12-24T21:00'), null, null, NOW]),
      /CHECK/,
    );
    await assert.rejects(rawInsert([randomUUID(), businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'), 'x', null, NOW]), /CHECK/);
    await assert.rejects(
      rawInsert([randomUUID(), businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'), 'other', 'a'.repeat(61), NOW]),
      /CHECK/,
    );
  });

  test('FK: profissional de outro negócio falha; professional_id NULL é aceito', async () => {
    const foreign = await makeProfessional(businessB, 'Bia');
    await assert.rejects(
      rawInsert([randomUUID(), businessA, foreign, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'), null, null, NOW]),
      /FOREIGN KEY/,
    );
    await rawInsert([randomUUID(), businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'), 'holiday', 'Natal', NOW]);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM time_blocks')).n), 1);
  });
});

describe('findApplicable (contrato do AF-10, critério 16)', () => {
  test('devolve os do profissional e os de "todos", por intersecção semiaberta', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const bia = await makeProfessional(businessA, 'Bia');
    await block(businessA, ana, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    await block(businessA, null, iso('2026-12-25T03:00'), iso('2026-12-26T03:00'));
    await block(businessA, bia, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    // Termina exatamente em fromIso: não entra.
    await block(businessA, ana, iso('2026-12-23T10:00'), iso('2026-12-24T03:00'));
    // Começa exatamente em toIso: não entra.
    await block(businessA, null, iso('2026-12-27T03:00'), iso('2026-12-27T05:00'));
    // De outro negócio.
    await block(businessB, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));

    const result = await repo.findApplicable(businessA, ana, iso('2026-12-24T03:00'), iso('2026-12-27T03:00'));
    assert.deepEqual(result, [
      { professionalId: ana, startsAt: iso('2026-12-24T17:00'), endsAt: iso('2026-12-24T21:00') },
      { professionalId: null, startsAt: iso('2026-12-25T03:00'), endsAt: iso('2026-12-26T03:00') },
    ]);
  });

  test('profissional removido ou de outro negócio dá [] (nem os de "todos")', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const range = [iso('2026-12-24T00:00'), iso('2026-12-25T00:00')];
    const foreign = await makeProfessional(businessB, 'Bia');
    assert.deepEqual(await repo.findApplicable(businessA, foreign, ...range), []);
    assert.deepEqual(await repo.findApplicable(businessA, randomUUID(), ...range), []);
    await professionals.markRemoved(ana, businessA, NOW);
    assert.deepEqual(await repo.findApplicable(businessA, ana, ...range), []);
  });

  test('bloqueio de "todos" criado antes do profissional se aplica a ele (decisão 9)', async () => {
    await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const later = await makeProfessional(businessA, 'Nova');
    const result = await repo.findApplicable(businessA, later, iso('2026-12-24T00:00'), iso('2026-12-25T00:00'));
    assert.equal(result.length, 1);
    assert.equal(result[0].professionalId, null);
  });

  test('período acima de 400 dias, vazio ou invertido dá RangeError', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const from = Date.parse(iso('2026-01-01T00:00'));
    const ok = new Date(from + FIND_APPLICABLE_RANGE_MAX_DAYS * 86_400_000).toISOString();
    const tooLong = new Date(from + FIND_APPLICABLE_RANGE_MAX_DAYS * 86_400_000 + 60_000).toISOString();
    assert.deepEqual(await repo.findApplicable(businessA, ana, iso('2026-01-01T00:00'), ok), []);
    await assert.rejects(repo.findApplicable(businessA, ana, iso('2026-01-01T00:00'), tooLong), RangeError);
    await assert.rejects(repo.findApplicable(businessA, ana, ok, ok), RangeError);
    await assert.rejects(repo.findApplicableByBusiness(businessA, ok, iso('2026-01-01T00:00')), RangeError);
    await assert.rejects(repo.findApplicableByBusiness(businessA, iso('2026-01-01T00:00'), tooLong), RangeError);
  });
});

describe('findApplicableByBusiness', () => {
  test('uma consulta só, sem IN (; "todos" em all e os demais por profissional; removido não aparece', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const bia = await makeProfessional(businessA, 'Bia');
    const cris = await makeProfessional(businessA, 'Cris');
    await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    await block(businessA, ana, iso('2026-12-24T12:00'), iso('2026-12-24T13:00'));
    await block(businessA, ana, iso('2026-12-24T18:00'), iso('2026-12-24T19:00'));
    await block(businessA, bia, iso('2026-12-24T12:00'), iso('2026-12-24T13:00'));
    await block(businessA, cris, iso('2026-12-24T12:00'), iso('2026-12-24T13:00'));
    // markRemoved apaga; aqui simulamos uma linha retida para conferir o JOIN de defesa.
    await db.run('UPDATE professionals SET removed_at = ? WHERE id = ?', [NOW, cris]);
    await block(businessB, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));

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
    const result = await createTimeBlocksRepository(counting).findApplicableByBusiness(
      businessA,
      iso('2026-12-24T00:00'),
      iso('2026-12-25T00:00'),
    );
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /\bIN\s*\(/i);
    assert.equal(result.all.length, 1);
    assert.deepEqual(
      result.byProfessional.get(ana).map((b) => b.startsAt),
      [iso('2026-12-24T12:00'), iso('2026-12-24T18:00')],
    );
    assert.equal(result.byProfessional.get(bia).length, 1);
    assert.equal(result.byProfessional.has(cris), false);
  });

  test('findApplicable também não usa IN (', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const calls = [];
    const counting = { all: (sql, params) => (calls.push(sql), db.all(sql, params)) };
    await createTimeBlocksRepository(counting).findApplicable(businessA, ana, iso('2026-12-24T00:00'), iso('2026-12-25T00:00'));
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /\bIN\s*\(/i);
  });
});

describe('listagem, contagem e retenção', () => {
  test('list: ativos por padrão, período por intersecção, filtro e truncated', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const ended = await block(businessA, ana, iso('2026-11-01T12:00'), iso('2026-11-01T13:00'));
    const b1 = await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const b2 = await block(businessA, ana, iso('2026-12-20T17:00'), iso('2026-12-20T21:00'), { reasonKind: 'day_off' });
    await block(businessB, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));

    const active = await repo.list(businessA, { nowIso: NOW, limit: 10 });
    assert.deepEqual(active.rows.map((r) => r.id), [b2, b1]);
    assert.equal(active.truncated, false);
    assert.equal(active.rows[0].professionalName, 'Ana');
    assert.equal(active.rows[0].reasonKind, 'day_off');

    const period = await repo.list(businessA, { fromIso: iso('2026-11-01T00:00'), toIso: iso('2026-11-02T00:00'), nowIso: NOW, limit: 10 });
    assert.deepEqual(period.rows.map((r) => r.id), [ended]);

    assert.deepEqual((await repo.list(businessA, { professionalId: 'all', nowIso: NOW, limit: 10 })).rows.map((r) => r.id), [b1]);
    assert.deepEqual((await repo.list(businessA, { professionalId: ana, nowIso: NOW, limit: 10 })).rows.map((r) => r.id), [b2, b1]);

    const cut = await repo.list(businessA, { nowIso: NOW, limit: 1 });
    assert.equal(cut.rows.length, 1);
    assert.equal(cut.truncated, true);
  });

  test('countActive conta só ends_at > now do negócio', async () => {
    await block(businessA, null, iso('2026-11-01T12:00'), iso('2026-12-01T12:00')); // termina agora: encerrado
    await block(businessA, null, iso('2026-11-01T12:00'), iso('2026-12-01T12:15'));
    await block(businessB, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    assert.equal(await repo.countActive(businessA, NOW), 1);
  });

  test('purgeEnded e trimEnded apagam só encerrados e só do negócio', async () => {
    const old = await block(businessA, null, iso('2026-08-01T12:00'), iso('2026-08-02T12:00'));
    const recent = await block(businessA, null, iso('2026-11-01T12:00'), iso('2026-11-02T12:00'));
    const newer = await block(businessA, null, iso('2026-11-10T12:00'), iso('2026-11-11T12:00'));
    const active = await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const other = await block(businessB, null, iso('2026-08-01T12:00'), iso('2026-08-02T12:00'));

    assert.equal((await repo.purgeEnded(businessA, iso('2026-09-02T12:00'))).changes, 1);
    const ids = async () => (await db.all('SELECT id FROM time_blocks')).map((r) => r.id).sort();
    assert.deepEqual(await ids(), [recent, newer, active, other].sort());
    assert.ok(!(await ids()).includes(old));

    assert.equal((await repo.trimEnded(businessA, NOW, 1)).changes, 1);
    assert.deepEqual(await ids(), [newer, active, other].sort());

    assert.equal((await repo.purgeEndedAll(iso('2026-09-02T12:00'))).changes, 1);
    assert.deepEqual(await ids(), [newer, active].sort());
  });

  test('deleteById filtra por negócio', async () => {
    const id = await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    assert.equal((await repo.deleteById(id, businessB)).changes, 0);
    assert.equal((await repo.deleteById(id, businessA)).changes, 1);
    assert.equal(await repo.findById(id, businessA), undefined);
  });

  test('markRemoved apaga os bloqueios do profissional e mantém os de "todos" e os de outros (critério 17)', async () => {
    const ana = await makeProfessional(businessA, 'Ana');
    const bia = await makeProfessional(businessA, 'Bia');
    await block(businessA, ana, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const keepAll = await block(businessA, null, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    const keepBia = await block(businessA, bia, iso('2026-12-24T17:00'), iso('2026-12-24T21:00'));
    await professionals.markRemoved(ana, businessA, NOW);
    const ids = (await db.all('SELECT id FROM time_blocks')).map((r) => r.id).sort();
    assert.deepEqual(ids, [keepAll, keepBia].sort());
  });
});
