// AF-23 (design 6.1, critérios 6 e 13): horário de verão de ponta a ponta pela API, com negócios de
// fixture em America/New_York e America/Santiago. Cada cenário roda com o TZ do processo em
// America/Manaus e Asia/Tokyo: nada muda. O fuso do navegador não afeta a API (fica no E2E).
import '../helpers/web-resolver.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../helpers/clock.js';
import { emailTestApp, drain, icsOf, parseIcs } from '../helpers/email.js';
import { getAvailability } from '../helpers/session.js';
import { postAppointment, bookingBody, insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { getAgenda, getAgendaAppointment } from '../helpers/agenda.js';
import { seedDstBusiness, assertDstFixtures, SATURDAY_NIGHT_GRID, DST_TRANSITIONS } from '../helpers/dst-fixtures.js';

const { describeItem } = await import('../../web/js/agenda-controller.js');

const PROCESS_TZS = ['America/Manaus', 'Asia/Tokyo'];

/** Roda `fn` com cada TZ do processo e restaura o original. */
async function withProcessTz(fn) {
  const saved = process.env.TZ;
  try {
    for (const tz of PROCESS_TZS) {
      process.env.TZ = tz;
      await fn(tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

async function scenario(nowIso, seed) {
  const env = await emailTestApp({ clock: createClock(nowIso) });
  const b = await seedDstBusiness(env.app, seed);
  return { ...env, b };
}

async function labels(app, b, date) {
  const res = await getAvailability(app, b.slug, { serviceId: b.service.id, professionalId: b.professional.id, from: date });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().days[0].slots.map((s) => s.start.slice(11));
}

/** Reserva `start` e devolve o 201, o detalhe da agenda e o e-mail de confirmação. */
async function bookAndRead(env, start, email) {
  const { app, transport, b } = env;
  const res = await postAppointment(app, b.slug, bookingBody({ serviceId: b.service.id, professionalId: b.professional.id, start, customer: { email } }));
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json().appointment;
  await drain(app);
  const mail = transport.messages.find((m) => m.to === email);
  assert.ok(mail, 'e-mail');
  const agenda = (await getAgenda(app, b.cookies, { from: start.slice(0, 10), to: start.slice(0, 10) })).json();
  const item = agenda.days[0].items.find((i) => i.start === start);
  assert.ok(item, JSON.stringify(agenda.days));
  const detail = (await getAgendaAppointment(app, b.cookies, item.id)).json();
  return { created, item, detail, mail, ics: parseIcs(icsOf(mail)) };
}

describe('fixture de horário de verão (R14)', () => {
  test('as datas de transição conferem com o tzdata', () => {
    assert.doesNotThrow(() => assertDstFixtures());
    assert.equal(DST_TRANSITIONS.length, 4);
  });
});

describe('America/New_York, salto em 2026-03-08 (02:00 vira 03:00)', () => {
  test('sem início 02:xx; o resto igual a um domingo comum; reserva às 03:00 mostra 03:00 e DTSTART 07:00Z', async () => {
    await withProcessTz(async (tz) => {
      const env = await scenario('2026-03-01T15:00:00.000Z', { timezone: 'America/New_York' });
      try {
        const jump = await labels(env.app, env.b, '2026-03-08');
        const normal = await labels(env.app, env.b, '2026-03-15');
        assert.deepEqual(jump.filter((t) => t.startsWith('02:')), [], tz);
        assert.ok(jump.includes('01:00') && jump.includes('03:00'), jump.join(' '));
        assert.deepEqual(jump, normal.filter((t) => !t.startsWith('02:')));

        const r = await bookAndRead(env, '2026-03-08T03:00', `ny-salto-${tz.replace('/', '-').toLowerCase()}@example.com`);
        assert.equal(r.created.start, '2026-03-08T03:00');
        assert.equal(r.detail.appointment.start, '2026-03-08T03:00');
        assert.equal(describeItem(r.item, { date: '2026-03-08' }).timeLabel, '03:00 às 04:00');
        assert.ok(r.mail.text.includes('domingo, 08/03/2026, das 03:00 às 04:00 (America/New_York)'), r.mail.text);
        assert.equal(r.ics.get('DTSTART'), '20260308T070000Z');
        for (const wrong of ['02:00 às', '04:00 às 05:00']) assert.equal(r.mail.text.includes(wrong), false, wrong);
      } finally {
        await env.app.close();
      }
    });
  });

  test('os dois lados do salto: criado em 07/03 para 08/03 às 01:30, 60 min reais, 01:30 às 03:30, só no dia 08', async () => {
    await withProcessTz(async (tz) => {
      const env = await scenario('2026-03-07T15:00:00.000Z', { timezone: 'America/New_York' });
      try {
        const res = await postAppointment(env.app, env.b.slug, bookingBody({ serviceId: env.b.service.id, professionalId: env.b.professional.id, start: '2026-03-08T01:30' }));
        assert.equal(res.statusCode, 201, res.body);
        const body = (await getAgenda(env.app, env.b.cookies, { from: '2026-03-07', to: '2026-03-08' })).json();
        const [sat, sun] = body.days;
        assert.equal(sat.date, '2026-03-07');
        assert.deepEqual(sat.items, [], tz);
        assert.equal(sun.items.length, 1);
        const [item] = sun.items;
        assert.equal(item.start, '2026-03-08T01:30');
        assert.equal(item.end, '2026-03-08T03:30');
        assert.equal(describeItem(item, { date: '2026-03-08' }).timeLabel, '01:30 às 03:30');
        const row = await env.app.db.get('SELECT starts_at, ends_at FROM appointments WHERE id = ?', [item.id]);
        assert.equal(Date.parse(row.ends_at) - Date.parse(row.starts_at), 60 * 60_000);
      } finally {
        await env.app.close();
      }
    });
  });
});

describe('America/New_York, volta em 2026-11-01 (02:00 volta a 01:00)', () => {
  test('10:00 mostra 10:00 em 01/11 (15:00Z) e em 31/10 (14:00Z)', async () => {
    await withProcessTz(async (tz) => {
      const grid = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: weekday >= 6 ? [{ start: '08:00', end: '12:00' }] : [] }));
      const env = await scenario('2026-10-25T15:00:00.000Z', { timezone: 'America/New_York', grid });
      try {
        const tag = tz.replace('/', '-').toLowerCase();
        const sun = await bookAndRead(env, '2026-11-01T10:00', `ny-volta-${tag}@example.com`);
        assert.equal(sun.created.start, '2026-11-01T10:00');
        assert.equal(describeItem(sun.item, { date: '2026-11-01' }).timeLabel, '10:00 às 11:00');
        assert.ok(sun.mail.text.includes('domingo, 01/11/2026, das 10:00 às 11:00 (America/New_York)'), sun.mail.text);
        assert.equal(sun.ics.get('DTSTART'), '20261101T150000Z');
        const sat = await bookAndRead(env, '2026-10-31T10:00', `ny-sabado-${tag}@example.com`);
        assert.ok(sat.mail.text.includes('sábado, 31/10/2026, das 10:00 às 11:00 (America/New_York)'));
        assert.equal(sat.ics.get('DTSTART'), '20261031T140000Z');
      } finally {
        await env.app.close();
      }
    });
  });
});

describe('America/Santiago', () => {
  test('salto à meia-noite em 2026-09-06: nenhum início 00:xx; a agenda tem as fronteiras do dia certas', async () => {
    await withProcessTz(async (tz) => {
      const env = await scenario('2026-09-01T12:00:00.000Z', { timezone: 'America/Santiago' });
      try {
        const jump = await labels(env.app, env.b, '2026-09-06');
        const normal = await labels(env.app, env.b, '2026-09-13');
        assert.deepEqual(jump.filter((t) => t.startsWith('00:')), [], tz);
        assert.deepEqual(jump, normal.filter((t) => !t.startsWith('00:')));
        const customerId = await insertCustomerDirect(env.app.db, env.b.business.id);
        const base = { businessId: env.b.business.id, professionalId: env.b.professional.id, customerId, serviceId: env.b.service.id, durationMinutes: 30 };
        const last = await insertAppointmentDirect(env.app.db, { ...base, startsAt: '2026-09-06T03:30:00.000Z' }); // 05/09 23:30 (−4)
        const first = await insertAppointmentDirect(env.app.db, { ...base, startsAt: '2026-09-06T04:00:00.000Z' }); // 06/09 01:00 (−3)
        const body = (await getAgenda(env.app, env.b.cookies, { from: '2026-09-05', to: '2026-09-06' })).json();
        assert.deepEqual(body.days.map((d) => d.items.map((i) => [i.id, i.start])), [[[last, '2026-09-05T23:30']], [[first, '2026-09-06T01:00']]]);
      } finally {
        await env.app.close();
      }
    });
  });

  test('dobra em 2026-04-04 (23:00 se repete): cada rótulo das 22:00 às 23:45 uma vez, sem início na 2ª ocorrência', async () => {
    await withProcessTz(async () => {
      const env = await scenario('2026-03-30T12:00:00.000Z', { timezone: 'America/Santiago', grid: SATURDAY_NIGHT_GRID });
      try {
        const res = await getAvailability(env.app, env.b.slug, { serviceId: env.b.service.id, professionalId: env.b.professional.id, from: '2026-04-04' });
        const slots = res.json().days[0].slots;
        const late = slots.map((s) => s.start.slice(11)).filter((t) => t >= '22:00');
        assert.deepEqual(late, ['22:00', '22:15', '22:30', '22:45', '23:00', '23:15', '23:30', '23:45']);
        assert.equal(new Set(slots.map((s) => s.start)).size, slots.length);
      } finally {
        await env.app.close();
      }
    });
  });
});
