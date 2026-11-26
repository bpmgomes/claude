import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUsersRepository } from '../../src/modules/accounts/users.repository.js';
import { createBusinessesRepository } from '../../src/modules/businesses/businesses.repository.js';
import { createProfessionalsRepository } from '../../src/modules/professionals/professionals.repository.js';
import { createProfessionalsService } from '../../src/modules/professionals/professionals.service.js';
import { createWorkingHoursRepository } from '../../src/modules/working-hours/working-hours.repository.js';
import { createWorkingHoursService } from '../../src/modules/working-hours/working-hours.service.js';
import { ValidationError, NotFoundError, ConflictError } from '../../src/http/errors.js';
import { HOURS_MESSAGES as M } from '../../src/shared/working-hours.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { textKey } from '../../src/shared/validation.js';
import { createClock } from '../helpers/clock.js';
import { WEEK_9_TO_18 } from '../helpers/session.js';
import { realAppointmentsPort, seedRealAppointment } from '../helpers/appointments.js';

let db;
let ownerId;
let businessId;
let businessesRepository;
let professionalsRepository;
let workingHoursRepository;
let clock;
let appointments;

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
  professionalsRepository = createProfessionalsRepository(db);
  workingHoursRepository = createWorkingHoursRepository(db);
  appointments = await realAppointmentsPort(db);
});

afterEach(async () => {
  await db.close();
});

function build(extra = {}) {
  return createWorkingHoursService({
    db,
    workingHoursRepository,
    professionalsRepository,
    businessesRepository,
    // Critério 31 do AF-11: o repositório real é o padrão; portas falsas só simulam falha.
    appointments,
    now: clock.now,
    ...extra,
  });
}

async function makeProfessional(name = 'Ana') {
  const id = randomUUID();
  await professionalsRepository.insert({ id, businessId, name, nameKey: textKey(name), createdAt: clock.now().toISOString() });
  return id;
}

const day = (weekday, ...pairs) => ({ weekday, intervals: pairs.map(([start, end]) => ({ start, end })) });

function captureLog() {
  const entries = [];
  const push = (level) => (obj) => entries.push({ level, ...obj });
  return { entries, log: { info: push('info'), warn: push('warn'), error: push('error') } };
}

test('get: grade inicial vazia; sem negócio 409; id inválido e inexistente 404', async () => {
  const service = build();
  const p = await makeProfessional();
  const hours = await service.get(ownerId, p);
  assert.equal(hours.hasHours, false);
  assert.equal(hours.days.length, 7);
  await assert.rejects(service.get(randomUUID(), p), (err) => err instanceof ConflictError && err.code === 'BUSINESS_REQUIRED');
  await assert.rejects(service.get(ownerId, 'x'), (err) => err instanceof NotFoundError && err.code === 'PROFESSIONAL_NOT_FOUND');
  await assert.rejects(service.get(ownerId, randomUUID()), NotFoundError);
});

test('porta falsa com contagem 2: affectedAppointmentsCount 2, grade gravada e porta chamada depois do commit', async () => {
  const p = await makeProfessional();
  const calls = [];
  const appointments = {
    async countFutureOutsideHours(...args) {
      // Com o `db` global: dentro da transação, no SQLite, isto travaria (fila do adapter).
      const rows = await db.all('SELECT weekday FROM working_hours WHERE professional_id = ?', [p]);
      calls.push({ args, rowsSeen: rows.length });
      return 2;
    },
  };
  const { entries, log } = captureLog();
  const result = await build({ appointments, log }).replace(ownerId, p, { days: WEEK_9_TO_18 });
  assert.equal(result.affectedAppointmentsCount, 2);
  assert.equal(result.hours.hasHours, true);
  assert.deepEqual(result.hours.days, WEEK_9_TO_18);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [businessId, p, clock.now().toISOString()]);
  assert.equal(calls[0].rowsSeen, 10);

  const event = entries.find((e) => e.event === 'working_hours_replaced');
  assert.deepEqual(event, {
    level: 'info',
    event: 'working_hours_replaced',
    userId: ownerId,
    businessId,
    professionalId: p,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    intervalsCount: 10,
    affectedAppointmentsCount: 2,
  });
});

test('repositório real (AF-11): 0 sem agendamentos; o agendamento das 10:00 fora da grade nova conta 1', async () => {
  const p = await makeProfessional();
  const service = build();
  assert.equal((await service.replace(ownerId, p, { days: WEEK_9_TO_18 })).affectedAppointmentsCount, 0);
  // Segunda 2/3/2026, 10:00 em São Paulo (13:00Z).
  await seedRealAppointment(db, { businessId, professionalId: p, startsAt: '2026-03-02T13:00:00.000Z' });
  assert.equal((await service.replace(ownerId, p, { days: WEEK_9_TO_18 })).affectedAppointmentsCount, 0);
  const afternoon = WEEK_9_TO_18.map((d) => ({ weekday: d.weekday, intervals: d.intervals.length ? [{ start: '13:00', end: '18:00' }] : [] }));
  assert.equal((await service.replace(ownerId, p, { days: afternoon })).affectedAppointmentsCount, 1);
});

test('porta que lança: grade gravada, affectedAppointmentsCount null e log warn', async () => {
  const p = await makeProfessional();
  const appointments = {
    async countFutureOutsideHours() {
      throw new Error('boom');
    },
  };
  const { entries, log } = captureLog();
  const result = await build({ appointments, log }).replace(ownerId, p, { days: [day(1, ['09:00', '10:00'])] });
  assert.equal(result.affectedAppointmentsCount, null);
  assert.equal(await workingHoursRepository.hasHours(businessId, p), true);
  assert.ok(entries.some((e) => e.level === 'warn' && e.event === 'working_hours_affected_count_failed'));
});

test('validação: nada é lido nem gravado; mensagem "Verifique os horários destacados."', async () => {
  const p = await makeProfessional();
  let locks = 0;
  const spyRepo = {
    ...professionalsRepository,
    lockActive: (...args) => {
      locks++;
      return professionalsRepository.lockActive(...args);
    },
  };
  const service = build({ professionalsRepository: spyRepo });
  await assert.rejects(service.replace(ownerId, p, { days: [day(1, ['10:00', '09:00'])] }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.message, M.checkFields);
    assert.deepEqual(err.fields, { 'days.1.intervals.0.end': M.endBeforeStart });
    return true;
  });
  await assert.rejects(service.replace(ownerId, p, {}), (err) => err.message === 'Nada para atualizar.');
  assert.equal(locks, 0);
});

test('atomicidade: INSERT que lança depois do DELETE deixa a grade anterior intacta em todos os dias', async () => {
  const p = await makeProfessional();
  await build().replace(ownerId, p, { days: WEEK_9_TO_18 });
  const failing = {
    ...workingHoursRepository,
    async replaceDays(professionalId, bId, days, nowIso, conn) {
      await conn.run('DELETE FROM working_hours WHERE professional_id = ? AND business_id = ?', [professionalId, bId]);
      throw new Error('insert falhou');
    },
  };
  await assert.rejects(
    build({ workingHoursRepository: failing }).replace(ownerId, p, { days: [day(1), day(2, ['10:00', '11:00'])] }),
    /insert falhou/,
  );
  assert.deepEqual((await build().get(ownerId, p)).days, WEEK_9_TO_18);
});

test('teto de 42 por profissional: com linhas inseridas direto até 42, um PUT que soma mais dá 400 e nada muda', async () => {
  const p = await makeProfessional();
  // 7 intervalos por dia em 6 dias (contorna o limite de 6 por dia).
  for (let weekday = 2; weekday <= 7; weekday++) {
    for (let k = 0; k < 7; k++) {
      await db.run(
        `INSERT INTO working_hours (professional_id, business_id, weekday, start_minute, end_minute, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [p, businessId, weekday, k * 60, k * 60 + 30, clock.now().toISOString()],
      );
    }
  }
  const before = await workingHoursRepository.findByProfessional(businessId, p);
  assert.equal(before.length, 42);
  await assert.rejects(build().replace(ownerId, p, { days: [day(1, ['09:00', '10:00'])] }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.message, M.professionalTooMany);
    assert.deepEqual(err.fields, {});
    return true;
  });
  assert.deepEqual(await workingHoursRepository.findByProfessional(businessId, p), before);
  // Substituir um dia sem aumentar o total continua permitido.
  await build().replace(ownerId, p, { days: [day(2, ['09:00', '10:00'])] });
  assert.equal(await workingHoursRepository.countByProfessional(p, businessId), 36);
});

test('concorrência: 20 rodadas de dois replace simultâneos terminam exatamente em A ou B, sem exceção', async () => {
  const p = await makeProfessional();
  const service = build();
  const A = [day(1, ['08:00', '12:00']), day(2, ['08:00', '09:00'], ['10:00', '11:00']), day(3)];
  const B = [day(1, ['13:00', '14:00'], ['15:00', '24:00']), day(2), day(3, ['00:00', '01:00'])];
  const asOwner = (days) => days.map((d) => ({ weekday: d.weekday, intervals: d.intervals }));
  for (let round = 0; round < 20; round++) {
    const [ra, rb] = await Promise.all([service.replace(ownerId, p, { days: A }), service.replace(ownerId, p, { days: B })]);
    assert.ok(ra.hours && rb.hours);
    const final = (await service.get(ownerId, p)).days.slice(0, 3);
    const isA = JSON.stringify(final) === JSON.stringify(asOwner(A));
    const isB = JSON.stringify(final) === JSON.stringify(asOwner(B));
    assert.ok(isA || isB, `rodada ${round}: ${JSON.stringify(final)}`);
  }
});

test('concorrência com a remoção: nenhum 500; ou o replace dá 404 ou a grade fica retida e inacessível', async () => {
  const professionalsService = createProfessionalsService({
    db,
    professionalsRepository,
    businessesRepository,
    storage: createMemoryStorage(),
    now: clock.now,
  });
  const service = build();
  const outcomes = new Set();
  for (let round = 0; round < 10; round++) {
    const p = await makeProfessional(`P${round}`);
    const [replaced, removed] = await Promise.allSettled(
      round % 2 === 0
        ? [service.replace(ownerId, p, { days: WEEK_9_TO_18 }), professionalsService.remove(ownerId, p)]
        : [
            (async () => {
              await Promise.resolve();
              return service.replace(ownerId, p, { days: WEEK_9_TO_18 });
            })(),
            professionalsService.remove(ownerId, p),
          ],
    );
    assert.equal(removed.status, 'fulfilled');
    const rows = (await db.get('SELECT COUNT(*) AS n FROM working_hours WHERE professional_id = ?', [p])).n;
    if (replaced.status === 'rejected') {
      assert.ok(replaced.reason instanceof NotFoundError, String(replaced.reason));
      assert.equal(rows, 0);
      outcomes.add('404');
    } else {
      assert.equal(rows, 10);
      outcomes.add('retained');
    }
    await assert.rejects(service.get(ownerId, p), NotFoundError);
    assert.equal(await workingHoursRepository.hasHours(businessId, p), false);
    assert.equal((await workingHoursRepository.findWeekly(businessId, [p])).size, 0);
  }
  assert.ok(outcomes.size >= 1);
});

test('profissional já removido: replace dá 404 e nada é gravado', async () => {
  const p = await makeProfessional();
  await db.transaction((tx) => professionalsRepository.markRemoved(p, businessId, clock.now().toISOString(), tx));
  await assert.rejects(build().replace(ownerId, p, { days: WEEK_9_TO_18 }), NotFoundError);
  assert.equal(await workingHoursRepository.countByProfessional(p, businessId), 0);
});
