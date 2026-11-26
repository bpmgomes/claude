// AF-14 (design 5.1 e 6.1, critérios 4 e 35): fronteiras do dia no fuso do negócio, dias de 23 e 25 h
// (horário de verão de São Paulo até 2019) e a mesma resposta com qualquer TZ do processo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../helpers/clock.js';
import { agendaApp, getAgenda, allItems } from '../helpers/agenda.js';
import { insertAppointmentDirect, insertCustomerDirect } from '../helpers/appointments.js';
import { setBusinessTimezone } from '../helpers/session.js';

async function seedAt(ctx, startsAtList) {
  const customerId = await insertCustomerDirect(ctx.app.db, ctx.business.id);
  const ids = {};
  for (const [label, startsAt, pro = 0] of startsAtList) {
    ids[label] = await insertAppointmentDirect(ctx.app.db, {
      businessId: ctx.business.id,
      professionalId: ctx.pros[pro].id,
      customerId,
      serviceId: ctx.service.id,
      startsAt,
      durationMinutes: 30,
      createdAt: '2018-10-01T12:00:00.000Z',
    });
  }
  return ids;
}

const placement = (body) => Object.fromEntries(body.days.map((d) => [d.date, d.items.map((i) => i.id)]));

describe('dias de 23 e 25 h em America/Sao_Paulo (2018/2019)', () => {
  test('04/11/2018 (meia-noite inexistente, 23 h) e 16/02/2019 (25 h): bordas no dia certo e counts certos', async () => {
    const ctx = await agendaApp({ clock: createClock('2018-11-01T15:00:00.000Z') });
    try {
      const ids = await seedAt(ctx, [
        ['d3_last', '2018-11-04T02:45:00.000Z'], // 03/11 23:45 (−3)
        ['d4_first', '2018-11-04T03:00:00.000Z', 1], // 04/11 01:00 (−2), o início real do dia
        ['d4_last', '2018-11-05T01:45:00.000Z'], // 04/11 23:45 (−2)
        ['d5_first', '2018-11-05T02:00:00.000Z', 1], // 05/11 00:00 (−2)
      ]);
      const nov = (await getAgenda(ctx.app, ctx.cookies, { from: '2018-11-03', to: '2018-11-05' })).json();
      assert.deepEqual(placement(nov), {
        '2018-11-03': [ids.d3_last],
        '2018-11-04': [ids.d4_first, ids.d4_last],
        '2018-11-05': [ids.d5_first],
      });
      assert.deepEqual(nov.days.map((d) => d.counts.active), [1, 2, 1]);
      assert.equal(allItems(nov).find((i) => i.id === ids.d4_first).start, '2018-11-04T01:00');

      const feb = await seedAt(ctx, [
        ['d16_first', '2019-02-16T02:00:00.000Z'], // 16/02 00:00 (−2)
        ['d16_fold', '2019-02-17T01:30:00.000Z', 1], // 16/02 23:30 (−2), 1ª ocorrência
        ['d16_last', '2019-02-17T02:30:00.000Z'], // 16/02 23:30 (−3), 2ª ocorrência: ainda dia 16
        ['d17_first', '2019-02-17T03:00:00.000Z'], // 17/02 00:00 (−3)
        ['d15_last', '2019-02-16T01:45:00.000Z', 1], // 15/02 23:45 (−2)
      ]);
      const body = (await getAgenda(ctx.app, ctx.cookies, { from: '2019-02-15', to: '2019-02-17' })).json();
      assert.deepEqual(placement(body), {
        '2019-02-15': [feb.d15_last],
        '2019-02-16': [feb.d16_first, feb.d16_fold, feb.d16_last],
        '2019-02-17': [feb.d17_first],
      });
      assert.deepEqual(body.days.map((d) => d.counts.active), [1, 3, 1]);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('TZ do processo não muda nada (critério 4)', () => {
  test('negócio em Asia/Tokyo e em America/Sao_Paulo com TZ=UTC, Asia/Tokyo e America/Sao_Paulo: respostas idênticas byte a byte', async () => {
    const original = process.env.TZ;
    const ctx = await agendaApp();
    try {
      await seedAt(ctx, [
        ['a', '2026-11-26T14:45:00.000Z'],
        ['b', '2026-11-26T15:00:00.000Z', 1],
        ['c', '2026-11-27T02:45:00.000Z'],
        ['d', '2026-11-27T03:00:00.000Z', 1],
        ['e', '2026-11-29T14:00:00.000Z'],
      ]);
      for (const tz of ['America/Sao_Paulo', 'Asia/Tokyo']) {
        await setBusinessTimezone(ctx.app, ctx.business.id, tz);
        const bodies = [];
        for (const processTz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
          process.env.TZ = processTz;
          const week = await getAgenda(ctx.app, ctx.cookies, { from: '2026-11-23', to: '2026-11-29', includeCancelled: 'true' });
          const day = await getAgenda(ctx.app, ctx.cookies);
          bodies.push(`${week.body}\n${day.body}`);
        }
        assert.equal(new Set(bodies).size, 1, tz);
        const json = JSON.parse(bodies[0].split('\n')[0]);
        assert.equal(json.timezone, tz);
        assert.equal(json.now, tz === 'Asia/Tokyo' ? '2026-11-26T21:00' : '2026-11-26T09:00');
      }
      // Em Tóquio (UTC+9), 2026-11-26T14:45Z é 23:45 do dia 26 e 15:00Z já é dia 27.
      const tokyo = (await getAgenda(ctx.app, ctx.cookies, { from: '2026-11-26', to: '2026-11-27' })).json();
      assert.deepEqual(tokyo.days.map((d) => d.items.map((i) => i.start)), [['2026-11-26T23:45'], ['2026-11-27T00:00', '2026-11-27T11:45', '2026-11-27T12:00']]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
      await ctx.app.close();
    }
  });
});
