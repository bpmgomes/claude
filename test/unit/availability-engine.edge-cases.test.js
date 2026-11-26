// AF-21: casos de borda do motor de disponibilidade sem horário de verão (critérios 7 a 22 e 33).
// Design: docs/design/AF-21.md, 3.2. Datas fixas, sem relógio e sem mexer no TZ do processo.
// São Paulo em 2026 tem offset fixo -03:00 (mesma convenção `sp()` de availability-engine.test.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeAvailability } from '../../src/modules/availability/availability-engine.js';
import { weekly, WEEKDAYS_9_TO_18, clockRange, runEngine, slotTimes } from '../helpers/availability.js';

const SP = 'America/Sao_Paulo';
const TOKYO = 'Asia/Tokyo';
const FRIDAY = '2026-11-27'; // sexta (5)
const SATURDAY = '2026-11-28';
const SUNDAY = '2026-11-29';

/** Instante (ms) de uma hora local em São Paulo (UTC−3, sem horário de verão). */
const sp = (local) => Date.parse(`${local}:00.000-03:00`);
const spInterval = (start, end) => ({ startMs: sp(start), endMs: sp(end) });

/** runEngine em São Paulo, sexta de referência. */
const run = (opts = {}) => runEngine({ timeZone: SP, fromDate: FRIDAY, ...opts });

describe('virada de dia (AF-21, critérios 7 a 12)', () => {
  test('critério 7: sexta 23:30–24:00 com 15 min oferece 23:30 e 23:45 (fim 00:00 de sábado); com 30 min só 23:30', () => {
    const grade = weekly({ 5: [['23:30', '24:00']] });
    const slots = run({ grade, durationMinutes: 15 }).days[0].slots;
    assert.deepEqual(
      slots.map((s) => [s.start, s.end]),
      [
        ['2026-11-27T23:30', '2026-11-27T23:45'],
        ['2026-11-27T23:45', '2026-11-28T00:00'],
      ],
    );
    assert.equal(slots[1].endMs, sp('2026-11-28T00:00'));
    assert.deepEqual(slotTimes(run({ grade, durationMinutes: 30 })), ['23:30']);
  });

  test('critério 8: Tóquio, segunda 00:00–01:00: início da segunda (weekday 1) com instante de domingo no UTC', () => {
    const result = runEngine({ timeZone: TOKYO, fromDate: '2026-11-30', grade: weekly({ 1: [['00:00', '01:00']] }) });
    const day = result.days[0];
    assert.equal(day.date, '2026-11-30');
    assert.equal(day.weekday, 1);
    assert.equal(day.slots.length, 1);
    assert.equal(day.slots[0].start, '2026-11-30T00:00');
    assert.equal(day.slots[0].startMs, Date.parse('2026-11-29T15:00:00.000Z'));
    assert.equal(new Date(day.slots[0].startMs).getUTCDay(), 0, 'domingo no UTC');
  });

  test('critério 8: São Paulo, sexta 22:00–24:00: instante já no sábado em UTC, weekday ainda da sexta', () => {
    const day = run({ grade: weekly({ 5: [['22:00', '24:00']] }) }).days[0];
    assert.equal(day.date, FRIDAY);
    assert.equal(day.weekday, 5);
    assert.equal(day.slots[0].start, '2026-11-27T22:00');
    assert.equal(day.slots[0].startMs, Date.parse('2026-11-28T01:00:00.000Z'));
    assert.equal(new Date(day.slots[0].startMs).getUTCDay(), 6, 'sábado no UTC');
  });

  test('critério 9: bloqueio sexta 22:00 a sábado 02:00 (60 min): último de sexta 21:00 e primeiro de sábado 02:00 (corrigido no design, seção 2)', () => {
    const grade = weekly({ 5: [['20:00', '24:00']], 6: [['00:00', '06:00']] });
    const result = run({ grade, toDate: SATURDAY, blocks: [spInterval('2026-11-27T22:00', '2026-11-28T02:00')] });
    assert.deepEqual(slotTimes(result, FRIDAY), clockRange('20:00', '21:00'));
    assert.deepEqual(slotTimes(result, SATURDAY), clockRange('02:00', '05:00'));
    // A grade de cada dia é independente: sem o bloqueio e com 120 min, nada cruza 24:00.
    const free = run({ grade, toDate: SATURDAY, durationMinutes: 120 });
    assert.deepEqual(slotTimes(free, FRIDAY), clockRange('20:00', '22:00'));
    assert.deepEqual(slotTimes(free, SATURDAY), clockRange('00:00', '04:00'));
    assert.equal(slotTimes(free, FRIDAY).includes('23:00'), false);
  });

  test('critério 10: semiaberto na meia-noite; bloqueio de dia inteiro esvazia só aquele dia', () => {
    const grade = weekly({ 5: [['22:00', '24:00']], 6: [['00:00', '02:00']], 7: [['00:00', '02:00']] });
    const withAppointment = run({ grade, toDate: SATURDAY, durationMinutes: 15, appointments: [spInterval('2026-11-27T23:00', '2026-11-28T00:00')] });
    assert.deepEqual(slotTimes(withAppointment, FRIDAY), clockRange('22:00', '22:45'));
    assert.equal(slotTimes(withAppointment, SATURDAY)[0], '00:00');

    const withBlock = run({ grade, toDate: SATURDAY, durationMinutes: 15, blocks: [spInterval('2026-11-28T00:00', '2026-11-28T01:00')] });
    assert.deepEqual(slotTimes(withBlock, FRIDAY), clockRange('22:00', '23:45'));
    assert.deepEqual(slotTimes(withBlock, SATURDAY), clockRange('01:00', '01:45'));

    const fullDay = run({ grade, toDate: SUNDAY, durationMinutes: 15, blocks: [spInterval('2026-11-28T00:00', '2026-11-29T00:00')] });
    assert.deepEqual(slotTimes(fullDay, FRIDAY), clockRange('22:00', '23:45'));
    assert.deepEqual(slotTimes(fullDay, SATURDAY), []);
    assert.deepEqual(slotTimes(fullDay, SUNDAY), clockRange('00:00', '01:45'));
  });

  test('critério 11: notBeforeMs do dia anterior não remove nada; 23:50 de sexta esvazia a sexta e deixa o sábado completo', () => {
    assert.deepEqual(slotTimes(run({ grade: WEEKDAYS_9_TO_18, notBeforeMs: sp('2026-11-26T23:30') })), slotTimes(run({ grade: WEEKDAYS_9_TO_18 })));
    // O sábado precisa de grade própria para aparecer "completo".
    const grade = weekly({ 5: [['23:00', '24:00']], 6: [['00:00', '01:00']] });
    const result = run({ grade, toDate: SATURDAY, durationMinutes: 15, notBeforeMs: sp('2026-11-27T23:50') });
    assert.deepEqual(slotTimes(result, FRIDAY), []);
    assert.deepEqual(slotTimes(result, SATURDAY), clockRange('00:00', '00:45'));
  });

  const calendar = [
    ['2026-12-31', '2027-01-01', ['2026-12-31', '2027-01-01'], [4, 5]],
    ['2028-02-28', '2028-03-01', ['2028-02-28', '2028-02-29', '2028-03-01'], [1, 2, 3]],
    ['2027-02-28', '2027-03-01', ['2027-02-28', '2027-03-01'], [7, 1]],
  ];
  for (const [from, to, dates, weekdays] of calendar) {
    test(`critério 12: de ${from} a ${to} devolve ${dates.length} datas em ordem, weekday ${weekdays.join(', ')}`, () => {
      const result = run({ grade: weekly(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [['09:00', '10:00']]]))), fromDate: from, toDate: to });
      assert.deepEqual(result.days.map((d) => d.date), dates);
      assert.deepEqual(result.days.map((d) => d.weekday), weekdays);
      for (const day of result.days) {
        assert.deepEqual(day.slots.map((s) => s.start), [`${day.date}T09:00`], day.date);
      }
      assert.equal(result.truncated, false);
    });
  }

  test('critério 12: fromDate > toDate devolve days vazio e truncated false', () => {
    assert.deepEqual(run({ grade: WEEKDAYS_9_TO_18, fromDate: SATURDAY, toDate: FRIDAY }), { days: [], truncated: false });
  });
});

describe('fim exato do expediente e duração (critérios 13 a 18)', () => {
  test('critério 13: duração igual à janela, maior que a janela e máxima (480 min)', () => {
    assert.deepEqual(slotTimes(run({ grade: weekly({ 5: [['09:00', '10:00']] }) })), ['09:00']);
    assert.deepEqual(slotTimes(run({ grade: weekly({ 5: [['09:00', '09:45']] }) })), []);
    assert.deepEqual(slotTimes(run({ grade: weekly({ 5: [['09:00', '18:00']] }), durationMinutes: 480 })), clockRange('09:00', '10:00'));
    assert.deepEqual(slotTimes(run({ grade: WEEKDAYS_9_TO_18, durationMinutes: 480 })), []);
  });

  test('critério 14: último quarto: 15 min termina às 18:00 em 17:45; 45 min tem último 17:15', () => {
    const slots15 = run({ grade: WEEKDAYS_9_TO_18, durationMinutes: 15 }).days[0].slots;
    const last = slots15[slots15.length - 1];
    assert.equal(last.start, '2026-11-27T17:45');
    assert.equal(last.end, '2026-11-27T18:00');
    assert.equal(last.endMs, sp('2026-11-27T18:00'));
    const times45 = slotTimes(run({ grade: WEEKDAYS_9_TO_18, durationMinutes: 45 }));
    assert.equal(times45[times45.length - 1], '17:15');
  });

  test('critério 15: ocupado 17:30–18:30 remove 16:45 e mantém 16:30; [17:00, 18:00) remove 16:15 a 17:00 e mantém 16:00 (corrigido no design, seção 2)', () => {
    for (const key of ['blocks', 'appointments']) {
      const crossing = slotTimes(run({ grade: WEEKDAYS_9_TO_18, [key]: [spInterval('2026-11-27T17:30', '2026-11-27T18:30')] }));
      assert.equal(crossing[crossing.length - 1], '16:30', key);
      assert.equal(crossing.includes('16:45'), false, key);
    }
    const t = slotTimes(run({ grade: WEEKDAYS_9_TO_18, appointments: [spInterval('2026-11-27T17:00', '2026-11-27T18:00')] }));
    assert.equal(t[t.length - 1], '16:00');
    for (const removed of ['16:15', '16:30', '16:45', '17:00']) assert.equal(t.includes(removed), false, removed);
    assert.deepEqual(t, [...clockRange('09:00', '11:00'), ...clockRange('13:00', '16:00')]);
  });

  test('critério 16: antecedência no limite do fim e o milissegundo conta', () => {
    assert.deepEqual(slotTimes(run({ grade: WEEKDAYS_9_TO_18, notBeforeMs: sp('2026-11-27T17:00') })), ['17:00']);
    assert.deepEqual(slotTimes(run({ grade: WEEKDAYS_9_TO_18, notBeforeMs: sp('2026-11-27T17:00') + 1 })), []);
    assert.equal(slotTimes(run({ grade: WEEKDAYS_9_TO_18, notBeforeMs: sp('2026-11-27T10:00') + 1 }))[0], '10:15');
  });

  test('critério 17: caracterização: grade alinhada ao início da janela; bloqueio 10:00–10:01 dá próximo início 10:15, e não 10:01', () => {
    const t = slotTimes(run({ grade: WEEKDAYS_9_TO_18, blocks: [spInterval('2026-11-27T10:00', '2026-11-27T10:01')] }));
    assert.deepEqual(t, ['09:00', ...clockRange('10:15', '11:00'), ...clockRange('13:00', '17:00')]);
    assert.equal(t.includes('10:01'), false);
  });

  test('critério 18: intervalos inválidos (NaN, fim = início, fim < início) em blocks e appointments são ignorados', () => {
    const invalid = [
      { startMs: Number.NaN, endMs: sp('2026-11-27T12:00') },
      { startMs: sp('2026-11-27T10:00'), endMs: Number.NaN },
      { startMs: sp('2026-11-27T10:00'), endMs: sp('2026-11-27T10:00') },
      { startMs: sp('2026-11-27T15:00'), endMs: sp('2026-11-27T14:00') },
    ];
    const plain = run({ grade: WEEKDAYS_9_TO_18 });
    assert.deepEqual(run({ grade: WEEKDAYS_9_TO_18, blocks: invalid }), plain);
    assert.deepEqual(run({ grade: WEEKDAYS_9_TO_18, appointments: invalid }), plain);
    assert.equal(plain.days[0].slots.length, 26);
  });
});

describe('almoço (critérios 19 a 22)', () => {
  const lunch = [
    [30, '11:30', '13:00'],
    [45, '11:15', '13:00'],
    [120, '10:00', '13:00'],
  ];
  for (const [duration, lastMorning, firstAfternoon] of lunch) {
    test(`critério 19: almoço 12:00–13:00 com ${duration} min: último da manhã ${lastMorning}, primeiro da tarde ${firstAfternoon}`, () => {
      const t = slotTimes(run({ grade: WEEKDAYS_9_TO_18, durationMinutes: duration }));
      const morning = t.filter((x) => x < '12:00');
      const afternoon = t.filter((x) => x >= '12:00');
      assert.equal(morning[morning.length - 1], lastMorning);
      assert.equal(afternoon[0], firstAfternoon);
    });
  }

  test('critério 20: tarde menor que o serviço não oferece tarde; três janelas não cruzam as lacunas', () => {
    assert.deepEqual(slotTimes(run({ grade: weekly({ 5: [['09:00', '12:00'], ['13:00', '13:30']] }) })), clockRange('09:00', '11:00'));
    const three = slotTimes(run({ grade: weekly({ 5: [['09:00', '11:00'], ['12:00', '14:00'], ['15:00', '18:00']] }) }));
    assert.deepEqual(three, [...clockRange('09:00', '10:00'), ...clockRange('12:00', '13:00'), ...clockRange('15:00', '17:00')]);
  });

  test('critério 21: bloqueio 11:30–13:30 move os limites; ocupado dentro do almoço não muda nada', () => {
    const t = slotTimes(run({ grade: WEEKDAYS_9_TO_18, blocks: [spInterval('2026-11-27T11:30', '2026-11-27T13:30')] }));
    assert.deepEqual(t, [...clockRange('09:00', '10:30'), ...clockRange('13:30', '17:00')]);
    const plain = run({ grade: WEEKDAYS_9_TO_18 });
    for (const key of ['blocks', 'appointments']) {
      assert.deepEqual(run({ grade: WEEKDAYS_9_TO_18, [key]: [spInterval('2026-11-27T12:15', '2026-11-27T12:45')] }), plain, key);
    }
  });

  test('critério 22: notBeforeMs 12:20 (dentro do almoço) dá primeiro início 13:00', () => {
    assert.equal(slotTimes(run({ grade: WEEKDAYS_9_TO_18, notBeforeMs: sp('2026-11-27T12:20') }))[0], '13:00');
  });

  test('critério 22: qualquer profissional, A sem almoço e B com almoço: 11:00 [A, B], 11:15 a 12:45 [A], 13:00 [A, B] (corrigido no design, seção 2)', () => {
    const result = run({
      professionals: [
        { id: 'A', weekly: weekly({ 5: [['09:00', '18:00']] }), blocks: [], appointments: [] },
        { id: 'B', weekly: WEEKDAYS_9_TO_18, blocks: [], appointments: [] },
      ],
    });
    const ids = Object.fromEntries(result.days[0].slots.map((s) => [s.start.slice(11), s.professionalIds]));
    assert.deepEqual(ids['11:00'], ['A', 'B']);
    for (const t of clockRange('11:15', '12:45')) assert.deepEqual(ids[t], ['A'], t);
    assert.deepEqual(ids['13:00'], ['A', 'B']);
    assert.deepEqual(ids['17:00'], ['A', 'B']);
  });

  test('critério 22: sexta com almoço e sábado sem almoço no mesmo período', () => {
    const grade = weekly({ 5: [['09:00', '12:00'], ['13:00', '18:00']], 6: [['09:00', '18:00']] });
    const result = run({ grade, toDate: SATURDAY });
    assert.deepEqual(slotTimes(result, FRIDAY), [...clockRange('09:00', '11:00'), ...clockRange('13:00', '17:00')]);
    assert.deepEqual(slotTimes(result, SATURDAY), clockRange('09:00', '17:00'));
  });
});

describe('stepMinutes, entradas ausentes e ramos (critério 33)', () => {
  test('critério 33: stepMinutes 30 alinha à janela, respeita o fim exato e notBeforeMs', () => {
    const grade = weekly({ 5: [['09:00', '12:00']] });
    assert.deepEqual(slotTimes(run({ grade, stepMinutes: 30 })), clockRange('09:00', '11:00', 30));
    assert.equal(slotTimes(run({ grade, stepMinutes: 30, notBeforeMs: sp('2026-11-27T09:10') }))[0], '09:30');
  });

  test('critério 33: stepMinutes 60 com janela 09:30–12:00 dá 09:30 e 10:30 (alinhado à janela)', () => {
    assert.deepEqual(slotTimes(run({ grade: weekly({ 5: [['09:30', '12:00']] }), stepMinutes: 60 })), ['09:30', '10:30']);
  });

  test('critério 33: weekly undefined, null e com item nulo não lançam', () => {
    for (const grade of [undefined, null]) {
      assert.deepEqual(run({ grade }).days[0].slots, [], String(grade));
    }
    assert.deepEqual(run({ grade: [null, ...weekly({ 5: [['09:00', '10:00']] })] }).days[0].slots.map((s) => s.start), ['2026-11-27T09:00']);
  });

  test('critério 33: blocks e appointments undefined e null equivalem a listas vazias', () => {
    const plain = run({ grade: WEEKDAYS_9_TO_18 });
    for (const value of [undefined, null]) {
      const result = computeAvailability({
        timeZone: SP,
        fromDate: FRIDAY,
        toDate: FRIDAY,
        durationMinutes: 60,
        notBeforeMs: Number.NEGATIVE_INFINITY,
        professionals: [{ id: 'A', weekly: WEEKDAYS_9_TO_18, blocks: value, appointments: value }],
      });
      assert.deepEqual(result, plain, String(value));
    }
  });

  test('critério 33: professionals ausente devolve dias vazios, sem exceção', () => {
    const result = computeAvailability({ timeZone: SP, fromDate: FRIDAY, toDate: SATURDAY, durationMinutes: 60, notBeforeMs: 0 });
    assert.deepEqual(result, {
      days: [
        { date: FRIDAY, weekday: 5, slots: [] },
        { date: SATURDAY, weekday: 6, slots: [] },
      ],
      truncated: false,
    });
  });

  test('critério 33: o mesmo profissional repetido na entrada não duplica o id', () => {
    const p = { id: 'A', weekly: WEEKDAYS_9_TO_18, blocks: [], appointments: [] };
    const result = run({ professionals: [p, p] });
    assert.equal(result.days[0].slots.length, 26);
    for (const slot of result.days[0].slots) assert.deepEqual(slot.professionalIds, ['A'], slot.start);
  });
});
