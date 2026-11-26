import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createProfessionalsService } from '../../src/modules/professionals/professionals.service.js';
import { createTimeBlocksRepository } from '../../src/modules/time-blocks/time-blocks.repository.js';
import { createTimeBlocksService } from '../../src/modules/time-blocks/time-blocks.service.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  TimeBlockConflictsError,
  ServiceUnavailableError,
  ProfessionalHasAppointmentsError,
} from '../../src/http/errors.js';
import { TIME_BLOCK_MESSAGES as M, CONFLICTS_LIST_MAX, TIME_BLOCKS_ACTIVE_MAX } from '../../src/shared/time-blocks.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { textKey } from '../../src/shared/validation.js';
import { createClock } from '../helpers/clock.js';
import { TEST_CONFLICTS_TOKEN_SECRET } from '../helpers/test-app.js';
import { signConflictsToken, CONFLICTS_TOKEN_RE } from '../../src/modules/time-blocks/conflicts-token.js';

const DAY_MS = 86_400_000;

let db;
let ownerId;
let businessId;
let businessesRepository;
let professionalsRepository;
let timeBlocksRepository;
let clock;

beforeEach(async () => {
  db = createDatabase({ databasePath: ':memory:' });
  await runMigrations(db);
  clock = createClock('2026-12-01T12:00:00.000Z');
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
  professionalsRepository = createProfessionalsRepository(db);
  timeBlocksRepository = createTimeBlocksRepository(db);
});

afterEach(async () => {
  await db.close();
});

function build(extra = {}) {
  return createTimeBlocksService({
    db,
    timeBlocksRepository,
    professionalsRepository,
    businessesRepository,
    conflictsTokenSecret: TEST_CONFLICTS_TOKEN_SECRET,
    now: clock.now,
    ...extra,
  });
}

/** versionKey no formato da porta real (43 caracteres base64url). */
const VK1 = 'a'.repeat(43);
const VK2 = 'b'.repeat(43);

async function makeProfessional(name = 'Ana Souza') {
  const id = randomUUID();
  await professionalsRepository.insert({ id, businessId, name, nameKey: textKey(name), createdAt: clock.now().toISOString() });
  return id;
}

const countBlocks = async () => Number((await db.get('SELECT COUNT(*) AS n FROM time_blocks')).n);

function conflictItem(n) {
  const start = Date.parse('2026-12-24T17:00:00.000Z') + n * 30 * 60_000;
  return {
    id: randomUUID(),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 30 * 60_000).toISOString(),
    serviceName: 'Corte',
    professionalId: randomUUID(),
    professionalName: 'Ana Souza',
    customerName: `Cliente ${n}`,
  };
}

/** Porta falsa: `state.total` e `state.versionKey` podem mudar entre chamadas. Usa só o `conn`. */
function fakePort(state) {
  const calls = [];
  return {
    calls,
    async findConflictsForBlock(bId, block, limit, conn) {
      calls.push({ bId, block, limit, conn });
      if (state.fail) throw new Error('banco de agendamentos fora');
      // Consulta pelo conn: com o `db` global, o adapter SQLite travaria esperando a transação.
      await conn.get('SELECT 1 AS ok');
      const items = Array.from({ length: Math.min(state.total, limit) }, (_, n) => conflictItem(n));
      return { total: state.total, items, versionKey: 'versionKey' in state ? state.versionKey : VK1 };
    },
  };
}

const input = (professionalId, over = {}) => ({
  professionalId,
  start: '2026-12-24T14:00',
  end: '2026-12-24T18:00',
  ...over,
});

async function insertBlocks(n, { startsAt, endsAt }) {
  for (let i = 0; i < n; i++) {
    await db.run(
      `INSERT INTO time_blocks (id, business_id, professional_id, starts_at, ends_at, reason_kind, reason_note, created_at)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)`,
      [randomUUID(), businessId, startsAt, endsAt, clock.now().toISOString()],
    );
  }
}

function captureLog() {
  const entries = [];
  const push = (level) => (obj) => entries.push({ level, ...obj });
  return { entries, log: { info: push('info'), warn: push('warn'), error: push('error') } };
}

describe('conflitos com agendamentos (critérios 9 a 12)', () => {
  test('1º create lança TIME_BLOCK_CONFLICTS com lista e token e nada grava; o 2º com o token cria', async () => {
    const p = await makeProfessional();
    const port = fakePort({ total: 2 });
    const service = build({ appointments: port });
    let error;
    try {
      await service.create(ownerId, input(p));
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof TimeBlockConflictsError);
    assert.equal(error.code, 'TIME_BLOCK_CONFLICTS');
    assert.equal(error.message, M.conflicts);
    assert.equal(error.conflictsTotal, 2);
    assert.equal(error.conflicts.length, 2);
    assert.deepEqual(error.conflicts[0], {
      start: '2026-12-24T14:00',
      end: '2026-12-24T14:30',
      serviceName: 'Corte',
      professionalName: 'Ana Souza',
      customerName: 'Cliente 0',
    });
    assert.match(error.conflictsToken, CONFLICTS_TOKEN_RE);
    assert.equal(await countBlocks(), 0);
    assert.deepEqual(port.calls[0].block, {
      professionalId: p,
      startsAt: '2026-12-24T17:00:00.000Z',
      endsAt: '2026-12-24T21:00:00.000Z',
    });
    assert.equal(port.calls[0].bId, businessId);
    assert.equal(port.calls[0].limit, CONFLICTS_LIST_MAX);
    assert.notEqual(port.calls[0].conn, db);

    const created = await service.create(ownerId, input(p, { confirmConflictsToken: error.conflictsToken }));
    assert.equal(created.acknowledgedConflictsCount, 2);
    assert.equal(created.timeBlock.start, '2026-12-24T14:00');
    assert.equal(await countBlocks(), 1);
  });

  test('a lista mudou: o token antigo dá …_CHANGED com o token novo e nada é criado', async () => {
    const p = await makeProfessional();
    const state = { total: 2, versionKey: VK1 };
    const service = build({ appointments: fakePort(state) });
    const first = await service.create(ownerId, input(p)).catch((err) => err);
    state.total = 3;
    state.versionKey = VK2;
    const second = await service.create(ownerId, input(p, { confirmConflictsToken: first.conflictsToken })).catch((err) => err);
    assert.ok(second instanceof TimeBlockConflictsError);
    assert.equal(second.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
    assert.equal(second.message, M.conflictsChanged);
    assert.equal(second.conflictsTotal, 3);
    assert.notEqual(second.conflictsToken, first.conflictsToken);
    assert.equal(await countBlocks(), 0);
    const third = await service.create(ownerId, input(p, { confirmConflictsToken: second.conflictsToken }));
    assert.equal(third.acknowledgedConflictsCount, 3);
  });

  test('token de outro período não serve; token malformado dá …_CHANGED sem eco', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    const other = await service.create(ownerId, input(p, { end: '2026-12-24T19:00' })).catch((err) => err);
    const reuse = await service.create(ownerId, input(p, { confirmConflictsToken: other.conflictsToken })).catch((err) => err);
    assert.equal(reuse.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
    for (const bad of ['x', 'A'.repeat(10_000), 42]) {
      const err = await service.create(ownerId, input(p, { confirmConflictsToken: bad })).catch((e) => e);
      assert.equal(err.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
      assert.ok(!JSON.stringify({ message: err.message, conflicts: err.conflicts }).includes('AAAA'));
    }
    // Token de "todos" não serve para um profissional.
    const all = await service.create(ownerId, input(null)).catch((err) => err);
    const cross = await service.create(ownerId, input(p, { confirmConflictsToken: all.conflictsToken })).catch((err) => err);
    assert.equal(cross.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
    assert.equal(await countBlocks(), 0);
  });

  test('porta com total 0 cria direto, com ou sem token', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 0 }) });
    assert.equal((await service.create(ownerId, input(p))).acknowledgedConflictsCount, 0);
    assert.equal((await service.create(ownerId, input(p, { confirmConflictsToken: 'qualquer' }))).acknowledgedConflictsCount, 0);
    assert.equal(await countBlocks(), 2);
  });

  test('porta nula (só nos testes desde o AF-11) cria direto', async () => {
    const p = await makeProfessional();
    const result = await build().create(ownerId, input(p));
    assert.equal(result.acknowledgedConflictsCount, 0);
    assert.deepEqual(result.warnings, []);
  });

  test('porta que lança: 503 CONFLICTS_UNAVAILABLE, log warn e nada gravado', async () => {
    const p = await makeProfessional();
    const { entries, log } = captureLog();
    const service = build({ appointments: fakePort({ total: 0, fail: true }), log });
    const err = await service.create(ownerId, input(p)).catch((e) => e);
    assert.ok(err instanceof ServiceUnavailableError);
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'CONFLICTS_UNAVAILABLE');
    assert.equal(err.message, M.conflictsUnavailable);
    assert.equal(await countBlocks(), 0);
    assert.ok(entries.some((e) => e.level === 'warn' && e.event === 'time_block_conflicts_failed'));
  });

  test('falha da porta é logada com errCode e errName da causa, sem dado de cliente (AF-16 item 4)', async () => {
    const p = await makeProfessional();
    const { entries, log } = captureLog();
    const cause = Object.assign(new TypeError('Cliente Secreto'), { code: 'EBOOM' });
    const service = build({
      appointments: { findConflictsForBlock: async () => { throw cause; } },
      log,
    });
    await service.create(ownerId, input(p)).catch((e) => e);
    const entry = entries.find((e) => e.event === 'time_block_conflicts_failed');
    assert.equal(entry.errCode, 'EBOOM');
    assert.equal(entry.errName, 'TypeError');
    assert.ok(!JSON.stringify(entries).includes('Cliente Secreto'));
  });

  test('mais de 50 conflitos: 50 itens e conflictsTotal real', async () => {
    const service = build({ appointments: fakePort({ total: 120 }) });
    const err = await service.create(ownerId, input(null)).catch((e) => e);
    assert.equal(err.conflicts.length, 50);
    assert.equal(err.conflictsTotal, 120);
  });

  test('"todos": a porta recebe professionalId null', async () => {
    const port = fakePort({ total: 0 });
    await build({ appointments: port }).create(ownerId, input(null));
    assert.equal(port.calls[0].block.professionalId, null);
  });
});

describe('token HMAC de conflitos (AF-11, critério 36)', () => {
  const claimsFor = (p, over = {}) => ({
    userId: ownerId,
    businessId,
    professionalId: p,
    startsAt: '2026-12-24T17:00:00.000Z',
    endsAt: '2026-12-24T21:00:00.000Z',
    versionKey: VK1,
    ...over,
  });

  async function expectChanged(service, p, token, total = 1) {
    const err = await service.create(ownerId, input(p, { confirmConflictsToken: token })).catch((e) => e);
    assert.ok(err instanceof TimeBlockConflictsError, String(err));
    assert.equal(err.code, 'TIME_BLOCK_CONFLICTS_CHANGED');
    assert.equal(err.conflictsTotal, total);
    assert.match(err.conflictsToken, CONFLICTS_TOKEN_RE);
    assert.notEqual(err.conflictsToken, token);
    assert.equal(await countBlocks(), 0);
    return err;
  }

  test('o token assinado para o dono, o alvo e o período atuais cria (57 caracteres, v1.<exp>.<mac>)', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    const token = signConflictsToken(TEST_CONFLICTS_TOKEN_SECRET, claimsFor(p), clock.now().getTime());
    assert.equal(token.length, 57);
    const created = await service.create(ownerId, input(p, { confirmConflictsToken: token }));
    assert.equal(created.acknowledgedConflictsCount, 1);
  });

  test('token assinado com outro userId (signConflictsToken) enviado pelo dono dá …_CHANGED', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    const token = signConflictsToken(TEST_CONFLICTS_TOKEN_SECRET, claimsFor(p, { userId: randomUUID() }), clock.now().getTime());
    await expectChanged(service, p, token);
  });

  test('token de outro período, de outro alvo, de outro negócio ou com outro segredo dá …_CHANGED', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    const nowMs = clock.now().getTime();
    for (const over of [
      { endsAt: '2026-12-24T22:00:00.000Z' },
      { startsAt: '2026-12-24T16:00:00.000Z' },
      { professionalId: null },
      { professionalId: randomUUID() },
      { businessId: randomUUID() },
      { versionKey: VK2 },
    ]) {
      await expectChanged(service, p, signConflictsToken(TEST_CONFLICTS_TOKEN_SECRET, claimsFor(p, over), nowMs));
    }
    await expectChanged(service, p, signConflictsToken('outro-segredo-com-mais-de-32-caracteres!!', claimsFor(p), nowMs));
  });

  test('token expirado (relógio + 11 min) dá …_CHANGED com token novo; nada é gravado', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    const first = await service.create(ownerId, input(p)).catch((e) => e);
    clock.advance(11 * 60_000);
    const second = await expectChanged(service, p, first.conflictsToken);
    const created = await service.create(ownerId, input(p, { confirmConflictsToken: second.conflictsToken }));
    assert.equal(created.acknowledgedConflictsCount, 1);
  });

  test('token malformado (formato antigo de 43 caracteres, null, número, objeto) nunca dá 400', async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 1 }) });
    for (const bad of ['a'.repeat(43), 'v1.0000000000.' + 'a'.repeat(43), 42, {}, ['x'], 'v1.' + 'x'.repeat(10_000)]) {
      await expectChanged(service, p, bad);
    }
    const none = await service.create(ownerId, input(p, { confirmConflictsToken: null })).catch((e) => e);
    assert.equal(none.code, 'TIME_BLOCK_CONFLICTS');
  });
});

describe('versionKey inválido (AF-11, critério 37)', () => {
  test("com total > 0 e versionKey '', null, 42 ou 'curto': 503 CONFLICTS_UNAVAILABLE e nada gravado", async () => {
    const p = await makeProfessional();
    for (const versionKey of ['', null, 42, 'curto', undefined]) {
      const { entries, log } = captureLog();
      const service = build({ appointments: fakePort({ total: 2, versionKey }), log });
      const err = await service.create(ownerId, input(p)).catch((e) => e);
      assert.ok(err instanceof ServiceUnavailableError, String(versionKey));
      assert.equal(err.code, 'CONFLICTS_UNAVAILABLE');
      assert.equal(await countBlocks(), 0);
      assert.equal(entries.find((e) => e.event === 'time_block_conflicts_failed').errCode, 'CONFLICTS_MALFORMED');
    }
  });

  test("com total 0 e versionKey '', cria", async () => {
    const p = await makeProfessional();
    const service = build({ appointments: fakePort({ total: 0, versionKey: '' }) });
    assert.equal((await service.create(ownerId, input(p))).acknowledgedConflictsCount, 0);
    assert.equal(await countBlocks(), 1);
  });

  test('createTimeBlocksService sem conflictsTokenSecret lança', () => {
    assert.throws(() => build({ conflictsTokenSecret: undefined }), /conflictsTokenSecret/);
    assert.throws(() => build({ conflictsTokenSecret: '' }), /conflictsTokenSecret/);
  });
});

describe('validação e alvo', () => {
  test('professionalId malformado, inexistente, removido ou de outro negócio: 404 PROFESSIONAL_NOT_FOUND', async () => {
    const service = build();
    const removed = await makeProfessional('Removida');
    await professionalsRepository.markRemoved(removed, businessId, clock.now().toISOString());
    for (const id of ['abc', 'A'.repeat(5000), randomUUID(), removed]) {
      const err = await service.create(ownerId, input(id)).catch((e) => e);
      assert.ok(err instanceof NotFoundError, String(id).slice(0, 10));
      assert.equal(err.code, 'PROFESSIONAL_NOT_FOUND');
      assert.equal(err.message, 'Profissional não encontrado.');
    }
    assert.equal(await countBlocks(), 0);
  });

  test('erro de campo: ValidationError com fields', async () => {
    const err = await build().create(ownerId, { start: 'x' }).catch((e) => e);
    assert.ok(err instanceof ValidationError);
    assert.equal(err.fields.professionalId, M.targetRequired);
    assert.equal(err.fields.start, M.dateTimeInvalid);
  });

  test('sem negócio: BUSINESS_REQUIRED em list, create e remove', async () => {
    const service = build();
    const stranger = randomUUID();
    for (const run of [() => service.list(stranger, {}), () => service.create(stranger, input(null)), () => service.remove(stranger, randomUUID())]) {
      const err = await run().catch((e) => e);
      assert.ok(err instanceof ConflictError);
      assert.equal(err.code, 'BUSINESS_REQUIRED');
      assert.equal(err.message, M.businessRequired);
    }
  });
});

describe('limite de ativos (critério 6)', () => {
  test('com 500 ativos, o 501º dá 409 TIME_BLOCK_LIMIT_REACHED', async () => {
    await insertBlocks(TIME_BLOCKS_ACTIVE_MAX, { startsAt: '2026-12-10T12:00:00.000Z', endsAt: '2026-12-10T13:00:00.000Z' });
    const err = await build().create(ownerId, input(null)).catch((e) => e);
    assert.ok(err instanceof ConflictError);
    assert.equal(err.code, 'TIME_BLOCK_LIMIT_REACHED');
    assert.equal(err.message, M.limitReached);
    assert.equal(await countBlocks(), TIME_BLOCKS_ACTIVE_MAX);
  });

  test('com 500 encerrados, a criação passa', async () => {
    await insertBlocks(TIME_BLOCKS_ACTIVE_MAX, { startsAt: '2026-11-20T12:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z' });
    await build().create(ownerId, input(null));
    assert.equal(await countBlocks(), TIME_BLOCKS_ACTIVE_MAX + 1);
  });

  test('3 criações simultâneas com 498 ativos: no máximo 500 no fim', async () => {
    await insertBlocks(TIME_BLOCKS_ACTIVE_MAX - 2, { startsAt: '2026-12-10T12:00:00.000Z', endsAt: '2026-12-10T13:00:00.000Z' });
    const service = build();
    const results = await Promise.allSettled([1, 2, 3].map(() => service.create(ownerId, input(null))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'TIME_BLOCK_LIMIT_REACHED');
    assert.equal(await countBlocks(), TIME_BLOCKS_ACTIVE_MAX);
  });

  test('o teto de encerrados retidos (500) é aplicado na criação', async () => {
    await insertBlocks(TIME_BLOCKS_ACTIVE_MAX + 20, { startsAt: '2026-11-20T12:00:00.000Z', endsAt: '2026-11-20T13:00:00.000Z' });
    await build().create(ownerId, input(null));
    assert.equal(await countBlocks(), TIME_BLOCKS_ACTIVE_MAX + 1);
  });
});

describe('retenção (decisão 7)', () => {
  const endedDaysAgo = (days) => {
    const end = clock.now().getTime() - days * DAY_MS;
    return { startsAt: new Date(end - 3_600_000).toISOString(), endsAt: new Date(end).toISOString() };
  };

  test('encerrado há 91 dias some no create; há 89 dias fica', async () => {
    await insertBlocks(1, endedDaysAgo(91));
    await insertBlocks(1, endedDaysAgo(89));
    await build().create(ownerId, input(null));
    const rows = await db.all('SELECT ends_at FROM time_blocks ORDER BY ends_at');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ends_at, endedDaysAgo(89).endsAt);
  });

  test('purgeExpired apaga os de mais de 90 dias e loga a contagem', async () => {
    await insertBlocks(2, endedDaysAgo(91));
    await insertBlocks(1, endedDaysAgo(89));
    const { entries, log } = captureLog();
    assert.equal(await build({ log }).purgeExpired(), 2);
    assert.equal(await countBlocks(), 1);
    assert.ok(entries.some((e) => e.event === 'time_blocks_purged' && e.count === 2));
  });

  test('remove também purga encerrados antigos', async () => {
    const service = build();
    const { timeBlock } = await service.create(ownerId, input(null));
    await insertBlocks(1, endedDaysAgo(91));
    await service.remove(ownerId, timeBlock.id);
    assert.equal(await countBlocks(), 0);
  });
});

describe('remoção de bloqueio (critério 14)', () => {
  test('remove: id malformado, inexistente e de outro negócio dão o mesmo 404', async () => {
    const service = build();
    const { timeBlock } = await service.create(ownerId, input(null));
    for (const id of ['x', randomUUID()]) {
      const err = await service.remove(ownerId, id).catch((e) => e);
      assert.equal(err.code, 'TIME_BLOCK_NOT_FOUND');
      assert.equal(err.message, M.notFound);
    }
    await service.remove(ownerId, timeBlock.id);
    assert.equal(await countBlocks(), 0);
    const again = await service.remove(ownerId, timeBlock.id).catch((e) => e);
    assert.equal(again.code, 'TIME_BLOCK_NOT_FOUND');
  });
});

describe('remoção do profissional (critério 17)', () => {
  function professionalsService(appointments) {
    return createProfessionalsService({
      db,
      professionalsRepository,
      businessesRepository,
      storage: createMemoryStorage(),
      now: clock.now,
      ...(appointments ? { appointments } : {}),
    });
  }

  test('concorrência: 20 rodadas de create(P) x remove(P), sem erro inesperado', async () => {
    const service = build();
    const people = professionalsService();
    for (let round = 0; round < 20; round++) {
      const p = await makeProfessional(`P${round}`);
      const [created, removed] = await Promise.allSettled([service.create(ownerId, input(p)), people.remove(ownerId, p)]);
      assert.equal(removed.status, 'fulfilled', String(removed.reason));
      if (created.status === 'rejected') assert.equal(created.reason.code, 'PROFESSIONAL_NOT_FOUND');
      // Estado final: profissional removido e sem bloqueios, qualquer que seja a ordem.
      const n = await db.get('SELECT COUNT(*) AS n FROM time_blocks WHERE professional_id = ?', [p]);
      assert.equal(Number(n.n), 0);
    }
  });

  test('remoção com agendamentos futuros: ProfessionalHasAppointmentsError e os bloqueios continuam', async () => {
    const p = await makeProfessional();
    await build().create(ownerId, input(p));
    const people = professionalsService({ countFutureByProfessional: async () => 1 });
    const err = await people.remove(ownerId, p).catch((e) => e);
    assert.ok(err instanceof ProfessionalHasAppointmentsError);
    assert.equal(await countBlocks(), 1);
  });
});

describe('listagem e logs', () => {
  test('list: `now` em hora local e filtro de profissional alheio dá lista vazia', async () => {
    const service = build();
    const p = await makeProfessional();
    await service.create(ownerId, input(p));
    await service.create(ownerId, input(null));
    const all = await service.list(ownerId, {});
    assert.equal(all.timezone, 'America/Sao_Paulo');
    assert.equal(all.now, '2026-12-01T09:00');
    assert.equal(all.timeBlocks.length, 2);
    assert.equal(all.truncated, false);
    assert.deepEqual((await service.list(ownerId, { professionalId: randomUUID() })).timeBlocks, []);
    assert.equal((await service.list(ownerId, { professionalId: p })).timeBlocks.length, 2);
    const err = await service.list(ownerId, { from: 'x' }).catch((e) => e);
    assert.ok(err instanceof ValidationError);
  });

  test('logs não levam motivo, nomes nem dados de cliente', async () => {
    const p = await makeProfessional('Profissional Secreta');
    const { entries, log } = captureLog();
    const state = { total: 1 };
    const service = build({ appointments: fakePort(state), log });
    const first = await service.create(ownerId, input(p, { reasonNote: 'Motivo Secreto' })).catch((e) => e);
    await service.create(ownerId, input(p, { reasonNote: 'Motivo Secreto', confirmConflictsToken: first.conflictsToken }));
    const text = JSON.stringify(entries);
    for (const word of ['Motivo Secreto', 'Profissional Secreta', 'Cliente 0', 'Corte']) assert.ok(!text.includes(word), word);
    const created = entries.find((e) => e.event === 'time_block_created');
    assert.equal(created.target, 'professional');
    assert.equal(created.durationMinutes, 240);
    assert.equal(created.conflictsTotal, 1);
    assert.ok(entries.some((e) => e.event === 'time_block_conflicts_pending' && e.changed === false));
  });
});
