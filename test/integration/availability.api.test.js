import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from '../helpers/test-app.js';
import { createClock } from '../helpers/clock.js';
import {
  signupAndLogin,
  createBusinessFor,
  createService,
  createProfessional,
  putHours,
  postTimeBlock,
  deleteTimeBlock,
  getAvailability,
  setBusinessTimezone,
  WEEK_9_TO_18,
} from '../helpers/session.js';
import { fakeAppointments } from '../helpers/availability.js';
import { createAvailabilityService } from '../../src/modules/availability/availability.service.js';
import { AVAILABILITY_MESSAGES as M } from '../../src/shared/availability.js';

// Quinta-feira, 09:00 em São Paulo.
const NOW = '2026-11-26T12:00:00.000Z';
const SLUG = 'salao-da-ana';
const FRIDAY = '2026-11-27';
const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } };
const EMPTY_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [] }));

const range = (from, to) => {
  const out = [];
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  for (let m = toMin(from); m <= toMin(to); m += 15) {
    out.push(`${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
};

function assertSecurityHeaders(res, label) {
  assert.equal(res.headers['cache-control'], 'no-store', label);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
  assert.ok(res.headers['content-security-policy'], label);
  assert.ok(res.headers['x-frame-options'], label);
  assert.ok(res.headers['strict-transport-security'], label);
  assert.equal(res.headers['set-cookie'], undefined, label);
  assert.match(res.headers['content-type'], /^application\/json/, label);
}

describe('GET /api/public/:slug/availability', () => {
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
    a = await createProfessional(app, ana, { name: 'Ana Souza', serviceIds: [corte.id] });
    b = await createProfessional(app, ana, { name: 'Bia Lima', serviceIds: [corte.id] });
    for (const p of [a, b]) assert.equal((await putHours(app, ana, p.id, WEEK_9_TO_18)).statusCode, 200);
  });

  afterEach(async () => {
    await app.close();
  });

  const query = (extra = {}) => ({ serviceId: corte.id, professionalId: 'any', from: FRIDAY, ...extra });
  const fetchDay = async (extra = {}, slug = SLUG) => {
    const res = await getAvailability(app, slug, query(extra));
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const starts = (body, date = FRIDAY) => body.days.find((d) => d.date === date).slots.map((s) => s.start.slice(11));

  test('200: formato da 4.1, todas as datas (fim de semana vazio), ordem cronológica, fuso e agora (critérios 1, 18 e 20)', async () => {
    const res = await getAvailability(app, SLUG, query({ from: '2026-11-26', to: '2026-12-02' }));
    assert.equal(res.statusCode, 200);
    assertSecurityHeaders(res, '200');
    const body = res.json();
    assert.deepEqual(Object.keys(body), ['timezone', 'now', 'from', 'to', 'durationMinutes', 'stepMinutes', 'professionals', 'days', 'truncated']);
    assert.equal(body.timezone, 'America/Sao_Paulo');
    assert.equal(body.now, '2026-11-26T09:00');
    assert.equal(body.from, '2026-11-26');
    assert.equal(body.to, '2026-12-02');
    assert.equal(body.durationMinutes, 60);
    assert.equal(body.stepMinutes, 15);
    assert.deepEqual(body.professionals, [a.id, b.id]);
    assert.equal(body.truncated, false);
    assert.deepEqual(
      body.days.map((d) => [d.date, d.weekday, d.slots.length]),
      [
        ['2026-11-26', 4, 22],
        ['2026-11-27', 5, 26],
        ['2026-11-28', 6, 0],
        ['2026-11-29', 7, 0],
        ['2026-11-30', 1, 26],
        ['2026-12-01', 2, 26],
        ['2026-12-02', 3, 26],
      ],
    );
    const friday = body.days[1];
    // Em "qualquer profissional", o horário não diz quem está livre (AF-11, decisão 4).
    assert.deepEqual(friday.slots[0], { start: '2026-11-27T09:00', end: '2026-11-27T10:00' });
    assert.deepEqual(starts(body), [...range('09:00', '11:00'), ...range('13:00', '17:00')]);
    // Hoje às 09:00: antecedência de 1 h, primeiro início 10:00.
    assert.equal(body.days[0].slots[0].start, '2026-11-26T10:00');
    const all = body.days.flatMap((d) => d.slots.map((s) => s.start));
    assert.deepEqual(all, [...all].sort());
  });

  test('específico e qualquer (critérios 2, 11 e 19; AF-11 critério 12): com bloqueio só de A, os horários em que só B está livre continuam em "qualquer", sem a chave professionals', async () => {
    const block = await postTimeBlock(app, ana, { professionalId: a.id, start: `${FRIDAY}T10:00`, end: `${FRIDAY}T11:00` });
    assert.equal(block.statusCode, 201, block.body);
    const any = await fetchDay();
    assert.deepEqual(any.professionals, [a.id, b.id]);
    assert.ok(any.days[0].slots.every((s) => !('professionals' in s) && Object.keys(s).join() === 'start,end'));
    const anyStarts = starts(any);
    for (const t of ['09:00', ...range('09:15', '10:45'), '11:00']) assert.ok(anyStarts.includes(t), t);

    const onlyA = await fetchDay({ professionalId: a.id });
    assert.deepEqual(onlyA.professionals, [a.id]);
    assert.ok(onlyA.days[0].slots.every((s) => s.professionals.length === 1 && s.professionals[0] === 0));
    for (const t of range('09:15', '10:45')) assert.equal(starts(onlyA).includes(t), false, t);
    const onlyB = await fetchDay({ professionalId: b.id });
    assert.deepEqual(onlyB.professionals, [b.id]);
    assert.ok(starts(onlyB).includes('10:00'));
  });

  test('404 uniforme (critérios 4 e 26): corpo idêntico ao de GET /api/nao-existe em todos os casos', async () => {
    const reference = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    assert.deepEqual(reference.json(), NOT_FOUND_BODY);

    // Outro negócio, com serviço e profissional próprios.
    const bia = await signupAndLogin(app, { email: 'bia@x.com', name: 'Bia' });
    await createBusinessFor(app, bia, { name: 'Barbearia da Bia' });
    const other = await createService(app, bia, { name: 'Barba' });
    const otherPro = await createProfessional(app, bia, { name: 'Caio', serviceIds: [other.id] });
    await putHours(app, bia, otherPro.id, WEEK_9_TO_18);

    // Serviço desativado, profissional removido, que não realiza o serviço e sem grade.
    const off = await createService(app, ana, { name: 'Luzes' });
    await createProfessional(app, ana, { name: 'Dani', serviceIds: [off.id] });
    assert.equal((await app.inject({ method: 'POST', url: `/api/services/${off.id}/deactivate`, cookies: ana })).statusCode, 200);
    const removed = await createProfessional(app, ana, { name: 'Edu', serviceIds: [corte.id] });
    await putHours(app, ana, removed.id, WEEK_9_TO_18);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${removed.id}`, cookies: ana })).statusCode, 204);
    const barba = await createService(app, ana, { name: 'Barba' });
    const noCorte = await createProfessional(app, ana, { name: 'Fabi', serviceIds: [barba.id] });
    await putHours(app, ana, noCorte.id, WEEK_9_TO_18);
    const noHours = await createProfessional(app, ana, { name: 'Gil', serviceIds: [corte.id] });

    const cases = [
      ['slug inexistente', 'nao-existe', query()],
      ['slug com maiúsculas', 'Salao-Da-Ana', query()],
      ['slug reservado', 'admin', query()],
      ['slug malformado', 'a--b', query()],
      ['serviço desativado', SLUG, query({ serviceId: off.id })],
      ['serviço de outro negócio', SLUG, query({ serviceId: other.id })],
      ['serviço inexistente', SLUG, query({ serviceId: '00000000-0000-4000-8000-000000000000' })],
      ['serviceId malformado', SLUG, query({ serviceId: 'x'.repeat(36) })],
      ['professionalId malformado', SLUG, query({ professionalId: 'todos' })],
      ['profissional removido', SLUG, query({ professionalId: removed.id })],
      ['profissional de outro negócio', SLUG, query({ professionalId: otherPro.id })],
      ['profissional que não realiza o serviço', SLUG, query({ professionalId: noCorte.id })],
      ['profissional sem grade (R13)', SLUG, query({ professionalId: noHours.id })],
    ];
    for (const [label, slug, q] of cases) {
      const res = await getAvailability(app, slug, q);
      assert.equal(res.statusCode, 404, label);
      assert.equal(res.body, reference.body, label);
      assertSecurityHeaders(res, label);
    }
  });

  test('400 (critério 3): campos com mensagens fixas, corpo < 1 KB e sem eco da entrada', async () => {
    const payload = '<script>alert(1)</script>';
    const cases = [
      [{}, { serviceId: M.serviceRequired, professionalId: M.professionalRequired, from: M.dateInvalid }],
      [query({ professionalId: undefined }), { professionalId: M.professionalRequired }],
      [query({ from: '2026-02-30' }), { from: M.dateInvalid }],
      [query({ to: '2026-11-26' }), { to: M.rangeInvalid }],
      [query({ to: '2026-12-28' }), { to: M.rangeInvalid }],
      [query({ from: '2026-11-24' }), { from: M.outOfHorizon }],
      [query({ from: '2027-02-25' }), { to: M.outOfHorizon }],
      [query({ from: payload, to: payload }), { from: M.dateInvalid, to: M.dateInvalid }],
      [{ ...query(), from: [FRIDAY, FRIDAY] }, { from: M.dateInvalid }],
      [query({ from: '9'.repeat(10_000) }), { from: M.dateInvalid }],
    ];
    for (const [q, fields] of cases) {
      const res = await getAvailability(app, SLUG, Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)));
      assert.equal(res.statusCode, 400, JSON.stringify(q).slice(0, 80));
      assert.deepEqual(res.json(), { error: { code: 'VALIDATION_ERROR', message: 'Verifique os campos destacados.', fields } });
      assert.ok(res.rawPayload.length < 1024);
      assert.equal(res.body.includes('script'), false);
      assertSecurityHeaders(res, '400');
    }
    // O 400 vem antes do 404: slug inexistente com query inválida também dá 400.
    assert.equal((await getAvailability(app, 'nao-existe', {})).statusCode, 400);
  });

  test('serviço oculto (AF-11, decisão 5): serviço cujo único profissional apagou a grade dá 404 uniforme', async () => {
    const luzes = await createService(app, ana, { name: 'Luzes', durationMinutes: 90 });
    const cris = await createProfessional(app, ana, { name: 'Cris', serviceIds: [luzes.id] });
    assert.equal((await putHours(app, ana, cris.id, WEEK_9_TO_18)).statusCode, 200);
    let body = await fetchDay({ serviceId: luzes.id });
    assert.deepEqual(body.professionals, [cris.id]);
    assert.ok(body.days[0].slots.length > 0);
    assert.equal((await putHours(app, ana, cris.id, EMPTY_WEEK)).statusCode, 200);
    for (const professionalId of ['any', cris.id]) {
      const res = await getAvailability(app, SLUG, query({ serviceId: luzes.id, professionalId, to: '2026-11-29' }));
      assert.equal(res.statusCode, 404, professionalId);
      assert.deepEqual(res.json(), NOT_FOUND_BODY);
    }
    // Dia sem horário de quem tem elegíveis continua 200 com slots [].
    body = await fetchDay({ from: '2026-11-28' });
    assert.deepEqual(body.days[0].slots, []);
  });

  test('integração (critério 21): bloqueio, grade e remoção valem na próxima consulta, sem reinício', async () => {
    const before = starts(await fetchDay({ professionalId: a.id }));
    const created = await postTimeBlock(app, ana, { professionalId: a.id, start: `${FRIDAY}T13:00`, end: `${FRIDAY}T18:00` });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(starts(await fetchDay({ professionalId: a.id })), range('09:00', '11:00'));
    assert.equal((await deleteTimeBlock(app, ana, created.json().timeBlock.id)).statusCode, 204);
    assert.deepEqual(starts(await fetchDay({ professionalId: a.id })), before);

    // Bloqueio de "todos" criado ANTES de um profissional novo vale para ele.
    const all = await postTimeBlock(app, ana, { professionalId: null, start: `${FRIDAY}T00:00`, end: `${FRIDAY}T12:00` });
    assert.equal(all.statusCode, 201);
    const novo = await createProfessional(app, ana, { name: 'Novo', serviceIds: [corte.id] });
    assert.equal((await putHours(app, ana, novo.id, WEEK_9_TO_18)).statusCode, 200);
    assert.deepEqual(starts(await fetchDay({ professionalId: novo.id })), range('13:00', '17:00'));
    assert.deepEqual(starts(await fetchDay()), range('13:00', '17:00'));

    // Trocar a grade muda os horários.
    const friday14 = WEEK_9_TO_18.map((d) => (d.weekday === 5 ? { weekday: 5, intervals: [{ start: '14:00', end: '16:00' }] } : d));
    assert.equal((await putHours(app, ana, novo.id, friday14)).statusCode, 200);
    assert.deepEqual(starts(await fetchDay({ professionalId: novo.id })), range('14:00', '15:00'));

    // Remover o profissional tira-o de `professionals`.
    assert.ok((await fetchDay()).professionals.includes(novo.id));
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/professionals/${novo.id}`, cookies: ana })).statusCode, 204);
    assert.equal((await fetchDay()).professionals.includes(novo.id), false);
    assert.equal((await getAvailability(app, SLUG, query({ professionalId: novo.id }))).statusCode, 404);
  });

  test('dados internos (critério 19): sem motivo do bloqueio, businessId, created_at nem nomes', async () => {
    const block = await postTimeBlock(app, ana, {
      professionalId: a.id,
      start: `${FRIDAY}T10:00`,
      end: `${FRIDAY}T11:00`,
      reasonKind: 'vacation',
      reasonNote: 'Férias da Ana',
    });
    assert.equal(block.statusCode, 201);
    const res = await getAvailability(app, SLUG, query({ to: '2026-12-27' }));
    const business = (await app.inject({ method: 'GET', url: '/api/business', cookies: ana })).json().business;
    for (const forbidden of [
      'Férias',
      'vacation',
      business.id,
      business.createdAt,
      'created_at',
      'createdAt',
      'Ana Souza',
      'Bia Lima',
      'Corte',
      'Salão',
      block.json().timeBlock.id,
      'startsAt',
      'Z"',
    ]) {
      assert.equal(res.body.includes(forbidden), false, forbidden);
    }
  });

  test('sessão (critério 24): com cookie válido a resposta é igual, sem set-cookie e last_seen_at não muda', async () => {
    const anonymous = await getAvailability(app, SLUG, query());
    const before = await app.db.get('SELECT last_seen_at FROM sessions');
    clock.advance(5 * 60 * 1000);
    const withCookie = await getAvailability(app, SLUG, query(), { cookies: ana });
    assert.equal(withCookie.statusCode, 200);
    assert.equal(withCookie.headers['set-cookie'], undefined);
    assert.deepEqual(await app.db.get('SELECT last_seen_at FROM sessions'), before);
    clock.advance(-5 * 60 * 1000);
    assert.equal((await getAvailability(app, SLUG, query(), { cookies: ana })).body, anonymous.body);
  });

  test('cabeçalhos (critério 27): 200, 400, 404 e 503 com no-store, nosniff, CSP e X-Frame-Options', async () => {
    assertSecurityHeaders(await getAvailability(app, SLUG, query()), '200');
    assertSecurityHeaders(await getAvailability(app, SLUG, {}), '400');
    assertSecurityHeaders(await getAvailability(app, 'nao-existe', query()), '404');
    const s = app.services;
    s.availabilityService = createAvailabilityService({
      businessesRepository: s.businessesRepository,
      servicesRepository: s.servicesRepository,
      professionalsRepository: s.professionalsRepository,
      workingHoursRepository: s.workingHoursRepository,
      timeBlocksRepository: s.timeBlocksRepository,
      appointments: fakeAppointments({ throws: new Error('fora') }),
      now: clock.now,
    });
    const res = await getAvailability(app, SLUG, query());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: { code: 'AVAILABILITY_UNAVAILABLE', message: M.unavailable } });
    assertSecurityHeaders(res, '503');
    // HEAD automático do GET também sai com no-store.
    const head = await app.inject({ method: 'HEAD', url: `/api/public/${SLUG}/availability`, query: query() });
    assert.equal(head.headers['cache-control'], 'no-store');
  });

  test('fuso (critério 16): mesma resposta com TZ do processo em UTC, Asia/Tokyo e America/Sao_Paulo', async () => {
    const original = process.env.TZ;
    const bodies = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        bodies.push((await getAvailability(app, SLUG, query({ from: '2026-11-26', to: '2026-12-03' }))).body);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[0], bodies[2]);
  });

  test('fuso do negócio America/New_York: horários seguem a grade na hora de Nova York', async () => {
    const businessId = (await app.db.get('SELECT id FROM businesses')).id;
    await setBusinessTimezone(app, businessId, 'America/New_York');
    const body = await fetchDay();
    assert.equal(body.timezone, 'America/New_York');
    assert.equal(body.now, '2026-11-26T07:00');
    assert.deepEqual(starts(body), [...range('09:00', '11:00'), ...range('13:00', '17:00')]);
    // Hoje às 07:00 em NY: primeiro início às 09:00 (grade), e não pela hora de São Paulo.
    assert.equal(starts(await fetchDay({ from: '2026-11-26' }), '2026-11-26')[0], '09:00');
  });

  test('horário de verão (critério 17): negócio em America/New_York, 2027-03-14 sem 02:xx', async () => {
    const businessId = (await app.db.get('SELECT id FROM businesses')).id;
    await setBusinessTimezone(app, businessId, 'America/New_York');
    const sunday = [{ weekday: 7, intervals: [{ start: '00:00', end: '04:00' }] }];
    assert.equal((await putHours(app, ana, a.id, sunday)).statusCode, 200);
    const quick = await createService(app, ana, { name: 'Rápido', durationMinutes: 15 });
    const patch = await app.inject({ method: 'PATCH', url: `/api/professionals/${a.id}`, cookies: ana, payload: { serviceIds: [corte.id, quick.id] } });
    assert.equal(patch.statusCode, 200, patch.body);
    // A consulta pública não usa sessão: o relógio pode avançar até a véspera do salto.
    clock.advance(Date.parse('2027-03-01T12:00:00.000Z') - Date.parse(NOW));
    const body = await fetchDay({ serviceId: quick.id, professionalId: a.id, from: '2027-03-14' });
    const t = starts(body, '2027-03-14');
    assert.deepEqual(t, [...range('00:00', '01:45'), ...range('03:00', '03:45')]);
    assert.equal(t.some((x) => x.startsWith('02:')), false);
  });
});
