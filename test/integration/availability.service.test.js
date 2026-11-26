import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import { seedPublicBusiness } from '../helpers/public-fixture.js';
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from '../helpers/session.js';
import { fakeAppointments } from '../helpers/availability.js';
import { createAvailabilityService, AVAILABILITY_SLOW_MS } from '../../src/modules/availability/availability.service.js';
import { computeAvailability } from '../../src/modules/availability/availability-engine.js';
import { AVAILABILITY_MESSAGES } from '../../src/shared/availability.js';

// Quinta-feira, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';

function recordingLog() {
  const entries = [];
  const push = (level) => (obj) => entries.push({ level, ...obj });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Instrumenta o banco do app: registra todo SQL executado até `stop()`. */
function recordSql(app) {
  const calls = [];
  const db = app.db;
  const originals = {};
  for (const method of ['get', 'all', 'run']) {
    originals[method] = db[method];
    db[method] = function recorded(sql, params) {
      calls.push(sql);
      return originals[method].call(this, sql, params);
    };
  }
  return {
    calls,
    stop() {
      for (const [method, fn] of Object.entries(originals)) db[method] = fn;
    },
  };
}

function serviceFor(app, extra = {}) {
  const s = app.services;
  return createAvailabilityService({
    businessesRepository: s.businessesRepository,
    servicesRepository: s.servicesRepository,
    professionalsRepository: s.professionalsRepository,
    workingHoursRepository: s.workingHoursRepository,
    timeBlocksRepository: s.timeBlocksRepository,
    ...extra,
  });
}

const startsOf = (response, date) =>
  response.days.find((d) => d.date === date).slots.map((s) => [s.start.slice(11), s.professionals]);

describe('serviço de disponibilidade', () => {
  let app;
  let clock;
  let ana;
  let corte;
  let a;
  let b;

  beforeEach(async () => {
    clock = createClock(NOW);
    ({ app } = await buildTestApp({ now: clock.now }));
    ana = await signupAndLogin(app);
    await createBusinessFor(app, ana);
    corte = await createService(app, ana, { name: 'Corte', durationMinutes: 60 });
    a = await createProfessional(app, ana, { name: 'Ana', serviceIds: [corte.id] });
    b = await createProfessional(app, ana, { name: 'Bia', serviceIds: [corte.id] });
    for (const p of [a, b]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
  });

  afterEach(async () => {
    await app.close();
  });

  const query = (extra = {}) => ({ serviceId: corte.id, professionalId: 'any', from: '2026-11-27', ...extra });

  test('porta falsa: um ocupado de 10:00 a 11:00 de A tira A desses horários e mantém B (critério 10)', async () => {
    const appointments = fakeAppointments({
      busy: { [a.id]: [{ startsAt: '2026-11-27T13:00:00.000Z', endsAt: '2026-11-27T14:00:00.000Z' }] },
    });
    const service = serviceFor(app, { appointments, now: clock.now });
    const res = await service.getAvailability('salao-da-ana', query());
    assert.deepEqual(res.professionals, [a.id, b.id]);
    // Em "qualquer" (AF-11, decisão 4) o horário não traz `professionals`, mas continua livre por B.
    const starts = new Map(startsOf(res, '2026-11-27'));
    for (const t of ['09:00', '09:15', '10:45', '11:00']) assert.ok(starts.has(t), t);
    assert.ok([...starts.values()].every((v) => v === undefined));
    const onlyA = new Map(startsOf(await service.getAvailability('salao-da-ana', query({ professionalId: a.id })), '2026-11-27'));
    assert.deepEqual(onlyA.get('09:00'), [0]);
    assert.equal(onlyA.has('09:15'), false);
    assert.equal(onlyA.has('10:45'), false);
    assert.deepEqual(onlyA.get('11:00'), [0]);
    const onlyB = new Map(startsOf(await service.getAvailability('salao-da-ana', query({ professionalId: b.id })), '2026-11-27'));
    assert.deepEqual(onlyB.get('09:15'), [0]);
  });

  test('a porta recebe professionalId null em any, o UUID no modo específico e o período em ISO', async () => {
    const appointments = fakeAppointments();
    const service = serviceFor(app, { appointments, now: clock.now });
    await service.getAvailability('salao-da-ana', query({ to: '2026-11-28' }));
    await service.getAvailability('salao-da-ana', query({ professionalId: b.id }));
    const businessId = (await app.db.get('SELECT id FROM businesses')).id;
    assert.deepEqual(appointments.calls, [
      { businessId, filter: { professionalId: null }, fromIso: '2026-11-27T03:00:00.000Z', toIso: '2026-11-29T03:00:00.000Z' },
      { businessId, filter: { professionalId: b.id }, fromIso: '2026-11-27T03:00:00.000Z', toIso: '2026-11-28T03:00:00.000Z' },
    ]);
  });

  test('porta que lança: 503 AVAILABILITY_UNAVAILABLE, nenhum horário, e log sem slug', async () => {
    const err = Object.assign(new Error('banco fora'), { code: 'SQLITE_BUSY' });
    const log = recordingLog();
    const service = serviceFor(app, { appointments: fakeAppointments({ throws: err }), now: clock.now, log });
    await assert.rejects(service.getAvailability('salao-da-ana', query()), (e) => {
      assert.equal(e.statusCode, 503);
      assert.equal(e.code, 'AVAILABILITY_UNAVAILABLE');
      assert.equal(e.message, AVAILABILITY_MESSAGES.unavailable);
      return true;
    });
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].event, 'availability_appointments_failed');
    assert.equal(log.entries[0].level, 'warn');
    // errCode/errName (AF-11, 4.3): `name` é redigido no log do app.
    assert.equal(log.entries[0].errCode, 'SQLITE_BUSY');
    assert.equal(log.entries[0].errName, 'Error');
    assert.equal('name' in log.entries[0], false);
    assert.equal(JSON.stringify(log.entries).includes('salao-da-ana'), false);
    assert.equal(JSON.stringify(log.entries).includes('banco fora'), false);
  });

  test('porta que devolve algo que não é Map também dá 503 (nunca lista otimista)', async () => {
    const service = serviceFor(app, { appointments: fakeAppointments({ result: [] }), now: clock.now });
    await assert.rejects(service.getAvailability('salao-da-ana', query({ professionalId: a.id })), (e) => e.statusCode === 503);
  });

  test('relógio: avançar 2 h remove os horários com menos de 1 h de antecedência (critério 12)', async () => {
    const service = serviceFor(app, { now: clock.now });
    let res = await service.getAvailability('salao-da-ana', query({ from: '2026-11-26' }));
    assert.equal(res.now, '2026-11-26T09:00');
    assert.equal(startsOf(res, '2026-11-26')[0][0], '10:00');
    clock.advance(2 * 60 * 60 * 1000 + 7 * 60 * 1000); // 11:07 local
    res = await service.getAvailability('salao-da-ana', query({ from: '2026-11-26' }));
    assert.equal(res.now, '2026-11-26T11:07');
    assert.equal(startsOf(res, '2026-11-26')[0][0], '13:00');
    clock.advance(5 * 60 * 60 * 1000); // 16:07 local: mínimo 17:07
    res = await service.getAvailability('salao-da-ana', query({ from: '2026-11-26' }));
    assert.deepEqual(startsOf(res, '2026-11-26'), []);
  });

  test('sem gravação: COUNT(*) de todas as tabelas é igual antes e depois (critério 22)', async () => {
    const tables = (await app.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map(
      (r) => r.name,
    );
    const counts = async () => {
      const out = {};
      for (const t of tables) out[t] = Number((await app.db.get(`SELECT COUNT(*) AS n FROM "${t}"`)).n);
      return out;
    };
    const before = await counts();
    const recorder = recordSql(app);
    try {
      const service = serviceFor(app, { now: clock.now });
      await service.getAvailability('salao-da-ana', query({ to: '2026-12-27' }));
      await service.getAvailability('salao-da-ana', query({ professionalId: a.id }));
    } finally {
      recorder.stop();
    }
    assert.deepEqual(await counts(), before);
    for (const sql of recorder.calls) assert.match(sql.trim(), /^SELECT/i, sql);
  });

  test('lento: com o motor demorando 250 ms, log availability_slow sem slug nem horários', async () => {
    let t = 0;
    const log = recordingLog();
    const service = serviceFor(app, {
      now: clock.now,
      log,
      perfNow: () => t,
      engine: (input) => {
        t += 250;
        return computeAvailability(input);
      },
    });
    await service.getAvailability('salao-da-ana', query({ to: '2026-11-28' }));
    assert.ok(250 > AVAILABILITY_SLOW_MS);
    assert.equal(log.entries.length, 1);
    const [entry] = log.entries;
    assert.equal(entry.level, 'warn');
    assert.equal(entry.event, 'availability_slow');
    assert.equal(entry.days, 2);
    assert.equal(entry.professionalsCount, 2);
    assert.equal(entry.durationMs, 250);
    assert.equal(typeof entry.businessId, 'string');
    const text = JSON.stringify(entry);
    for (const forbidden of ['salao-da-ana', '2026-11', 'Ana', 'Bia', 'Corte']) assert.equal(text.includes(forbidden), false, forbidden);
    // Rápido: sem log.
    t = 0;
    const quiet = recordingLog();
    await serviceFor(app, { now: clock.now, log: quiet, perfNow: () => 0 }).getAvailability('salao-da-ana', query());
    assert.deepEqual(quiet.entries, []);
  });
});

describe('consultas constantes (critério 23)', () => {
  test('1 profissional × 1 dia e 10 profissionais × 31 dias fazem o mesmo número de consultas (6), sem IN (', async () => {
    const clock = createClock(NOW);
    const { app } = await buildTestApp({ now: clock.now });
    try {
      const small = await seedPublicBusiness(app, { services: 1, professionals: 1, logo: null, photos: false });
      const large = await seedPublicBusiness(app, { services: 1, professionals: 10, logo: null, photos: false });
      const service = serviceFor(app, { now: clock.now });
      const cases = [
        [small.slug, { serviceId: small.services[0].id, professionalId: 'any', from: '2026-11-27' }],
        [small.slug, { serviceId: small.services[0].id, professionalId: small.professionals[0].id, from: '2026-11-27' }],
        [large.slug, { serviceId: large.services[0].id, professionalId: 'any', from: '2026-11-27', to: '2026-12-27' }],
        [large.slug, { serviceId: large.services[0].id, professionalId: large.professionals[3].id, from: '2026-11-27', to: '2026-12-27' }],
      ];
      const counts = [];
      for (const [slug, q] of cases) {
        const recorder = recordSql(app);
        let res;
        try {
          res = await service.getAvailability(slug, q);
        } finally {
          recorder.stop();
        }
        assert.ok(res.days.some((d) => d.slots.length > 0));
        for (const sql of recorder.calls) assert.equal(/\bIN\s*\(/i.test(sql), false, sql);
        counts.push(recorder.calls.length);
      }
      assert.deepEqual(counts, [6, 6, 6, 6]);
    } finally {
      await app.close();
    }
  });
});
