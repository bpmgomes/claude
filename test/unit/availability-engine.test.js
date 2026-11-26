import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvailability,
  isoWeekdayOf,
  unionIntervals,
  subtractIntervals,
  workWindowsForDay,
  dayFrameOf,
} from '../../src/modules/availability/availability-engine.js';
import { instantToLocal, localToInstant, parseLocalDateTime } from '../../src/shared/zoned-time.js';
import { SLOT_STEP_MINUTES, AVAILABILITY_SLOTS_PER_DAY_MAX } from '../../src/shared/availability.js';
import { weekly, interval, WEEKDAYS_9_TO_18 } from '../helpers/availability.js';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const FRIDAY = '2026-11-27'; // sexta-feira (5)
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';

/** Instante (ms) de uma hora local em São Paulo (UTC−3, sem horário de verão). */
const sp = (local) => Date.parse(`${local}:00.000-03:00`);
const spInterval = (start, end) => ({ startMs: sp(start), endMs: sp(end) });

function run({
  professionals,
  grade = WEEKDAYS_9_TO_18,
  blocks = [],
  appointments = [],
  durationMinutes = 60,
  notBeforeMs = Number.NEGATIVE_INFINITY,
  fromDate = FRIDAY,
  toDate = fromDate,
  timeZone = SP,
  ...rest
} = {}) {
  return computeAvailability({
    timeZone,
    fromDate,
    toDate,
    durationMinutes,
    notBeforeMs,
    professionals: professionals || [{ id: A, weekly: grade, blocks, appointments }],
    ...rest,
  });
}

/** Rótulos 'HH:MM' dos inícios do primeiro dia (ou do dia pedido). */
function times(result, date) {
  const day = date ? result.days.find((d) => d.date === date) : result.days[0];
  return day.slots.map((s) => s.start.slice(11));
}

/** 'HH:MM' de `from` a `to` (inclusive), de 15 em 15. */
function range(from, to) {
  const out = [];
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  for (let m = toMin(from); m <= toMin(to); m += 15) {
    out.push(`${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

describe('regras básicas (critérios 6, 7, 8 e 13)', () => {
  test('grade 09:00–12:00 + 13:00–18:00, 60 min: 09:00…11:00 e 13:00…17:00 de 15 em 15, sem o almoço', () => {
    const result = run();
    assert.deepEqual(times(result), [...range('09:00', '11:00'), ...range('13:00', '17:00')]);
    const day = result.days[0];
    assert.equal(day.date, FRIDAY);
    assert.equal(day.weekday, 5);
    assert.deepEqual(day.slots[0], {
      startMs: sp('2026-11-27T09:00'),
      endMs: sp('2026-11-27T10:00'),
      start: '2026-11-27T09:00',
      end: '2026-11-27T10:00',
      professionalIds: [A],
    });
    for (const t of range('11:15', '12:45')) assert.equal(times(result).includes(t), false, t);
    assert.equal(result.truncated, false);
    assert.equal(SLOT_STEP_MINUTES, 15);
  });

  test('intervalos que se tocam são contínuos: 12:00–13:00 + 13:00–14:00 oferece 12:30 para 60 min', () => {
    const result = run({ grade: weekly({ 5: [['12:00', '13:00'], ['13:00', '14:00']] }) });
    assert.deepEqual(times(result), range('12:00', '13:00'));
    assert.ok(times(result).includes('12:30'));
  });

  test('intervalos sobrepostos não duplicam horários', () => {
    const result = run({ grade: weekly({ 5: [['09:00', '11:00'], ['10:00', '12:00'], ['09:00', '11:00']] }) });
    assert.deepEqual(times(result), range('09:00', '11:00'));
  });

  test('fim exato do expediente: 17:00 sim, 17:15 não', () => {
    const t = times(run());
    assert.ok(t.includes('17:00'));
    assert.equal(t.includes('17:15'), false);
  });

  test('fim exato no início de um bloqueio às 15:00: 14:00 sim, 14:15 não', () => {
    const t = times(run({ blocks: [spInterval('2026-11-27T15:00', '2026-11-27T16:00')] }));
    assert.ok(t.includes('14:00'));
    assert.equal(t.includes('14:15'), false);
    assert.equal(t.includes('15:45'), false);
    assert.ok(t.includes('16:00'));
  });

  test('fim exato no início de um agendamento às 15:00: 14:00 sim, 14:15 não', () => {
    const t = times(run({ appointments: [spInterval('2026-11-27T15:00', '2026-11-27T15:30')] }));
    assert.ok(t.includes('14:00'));
    assert.equal(t.includes('14:15'), false);
    assert.ok(t.includes('15:30'));
  });

  test('passo alinhado ao início da janela: grade 09:00–10:00 com 45 min dá 09:00 e 09:15', () => {
    assert.deepEqual(times(run({ grade: weekly({ 5: [['09:00', '10:00']] }), durationMinutes: 45 })), ['09:00', '09:15']);
  });
});

describe('bloqueios e agendamentos (critérios 9 e 10)', () => {
  test('bloqueio de 10:00 a 11:00 remove 09:15…10:45 e deixa 09:00 e 11:00', () => {
    const t = times(run({ blocks: [spInterval('2026-11-27T10:00', '2026-11-27T11:00')] }));
    assert.ok(t.includes('09:00'));
    for (const x of range('09:15', '10:45')) assert.equal(t.includes(x), false, x);
    assert.ok(t.includes('11:00'));
  });

  test('bloqueios sobrepostos e encostados agem como união, em qualquer ordem', () => {
    const blocks = [
      spInterval('2026-11-27T14:00', '2026-11-27T15:00'),
      spInterval('2026-11-27T13:00', '2026-11-27T14:00'),
      spInterval('2026-11-27T14:30', '2026-11-27T16:00'),
    ];
    const single = [spInterval('2026-11-27T13:00', '2026-11-27T16:00')];
    assert.deepEqual(times(run({ blocks })), times(run({ blocks: single })));
    assert.deepEqual(times(run({ blocks })), [...range('09:00', '11:00'), ...range('16:00', '17:00')]);
  });

  test('bloqueio fora do período é ignorado', () => {
    const blocks = [spInterval('2026-11-20T09:00', '2026-11-20T18:00'), spInterval('2026-12-01T00:00', '2026-12-02T00:00')];
    assert.deepEqual(times(run({ blocks })), times(run()));
  });

  test('agendamentos removem horários como bloqueios; lista vazia não altera nada', () => {
    const busy = [spInterval('2026-11-27T10:00', '2026-11-27T11:00')];
    assert.deepEqual(times(run({ appointments: busy })), times(run({ blocks: busy })));
    assert.deepEqual(times(run({ appointments: [] })), times(run()));
  });

  test('bloqueio de dia inteiro esvazia o dia, e o resto do período continua', () => {
    const result = run({
      fromDate: '2026-11-26',
      toDate: FRIDAY,
      blocks: [spInterval('2026-11-27T00:00', '2026-11-28T00:00')],
    });
    assert.equal(result.days[0].slots.length, 26);
    assert.deepEqual(result.days[1].slots, []);
  });
});

describe('antecedência (critério 12)', () => {
  test('notBeforeMs = 10:07: o primeiro início é 10:15 (sem arredondar o limite para trás)', () => {
    assert.equal(times(run({ notBeforeMs: sp('2026-11-27T10:07') }))[0], '10:15');
  });

  test('notBeforeMs = 10:00 exato: o primeiro início é 10:00', () => {
    assert.equal(times(run({ notBeforeMs: sp('2026-11-27T10:00') }))[0], '10:00');
  });

  test('dia todo no passado fica vazio', () => {
    assert.deepEqual(run({ notBeforeMs: sp('2026-11-28T00:00') }).days[0].slots, []);
  });
});

describe('qualquer profissional (critério 11)', () => {
  test('A livre às 09:00 e B ocupado: [A]; ambos livres: [A, B] na ordem da entrada; um início por horário', () => {
    const result = run({
      professionals: [
        { id: A, weekly: WEEKDAYS_9_TO_18, blocks: [], appointments: [] },
        { id: B, weekly: WEEKDAYS_9_TO_18, blocks: [spInterval('2026-11-27T09:00', '2026-11-27T10:00')], appointments: [] },
      ],
    });
    const slots = result.days[0].slots;
    assert.deepEqual(slots.find((s) => s.start.endsWith('09:00')).professionalIds, [A]);
    assert.deepEqual(slots.find((s) => s.start.endsWith('10:00')).professionalIds, [A, B]);
    const starts = slots.map((s) => s.start);
    assert.equal(new Set(starts).size, starts.length);
    assert.deepEqual(starts, [...starts].sort());
  });

  test('a ordem dos ids segue a entrada, não a ordem de quem fica livre', () => {
    const result = run({
      professionals: [
        { id: B, weekly: weekly({ 5: [['10:00', '12:00']] }), blocks: [], appointments: [] },
        { id: A, weekly: weekly({ 5: [['09:00', '12:00']] }), blocks: [], appointments: [] },
      ],
    });
    const slots = result.days[0].slots;
    assert.deepEqual(slots[0].professionalIds, [A]);
    assert.deepEqual(slots.find((s) => s.start.endsWith('10:00')).professionalIds, [B, A]);
  });

  test('sem profissionais: todos os dias vazios', () => {
    const result = run({ professionals: [], fromDate: FRIDAY, toDate: '2026-11-29' });
    assert.deepEqual(
      result.days.map((d) => [d.date, d.weekday, d.slots.length]),
      [
        ['2026-11-27', 5, 0],
        ['2026-11-28', 6, 0],
        ['2026-11-29', 7, 0],
      ],
    );
  });
});

describe('dia da semana e meia-noite (critérios 14, 15 e 20)', () => {
  test('isoWeekdayOf por Date.UTC', () => {
    assert.equal(isoWeekdayOf('2026-11-29'), 7);
    assert.equal(isoWeekdayOf('2026-11-30'), 1);
    assert.equal(isoWeekdayOf('2026-11-27'), 5);
    assert.ok(Number.isNaN(isoWeekdayOf('2026-02-30')));
  });

  test('a grade de domingo só vale no domingo', () => {
    const result = run({ grade: weekly({ 7: [['10:00', '11:00']] }), fromDate: '2026-11-27', toDate: '2026-11-30' });
    assert.deepEqual(
      result.days.map((d) => [d.date, times(result, d.date)]),
      [
        ['2026-11-27', []],
        ['2026-11-28', []],
        ['2026-11-29', ['10:00']],
        ['2026-11-30', []],
      ],
    );
  });

  test('22:00–24:00 com 120 min oferece 22:00 terminando às 00:00 do dia seguinte', () => {
    const slots = run({ grade: weekly({ 5: [['22:00', '24:00']] }), durationMinutes: 120 }).days[0].slots;
    assert.deepEqual(
      slots.map((s) => [s.start, s.end]),
      [['2026-11-27T22:00', '2026-11-28T00:00']],
    );
  });

  test('22:00–24:00 + 00:00–02:00 do dia seguinte não é contínuo: sem 23:00 para 120 min', () => {
    const result = run({
      grade: weekly({ 5: [['22:00', '24:00']], 6: [['00:00', '02:00']] }),
      durationMinutes: 120,
      toDate: '2026-11-28',
    });
    assert.deepEqual(times(result, '2026-11-27'), ['22:00']);
    assert.deepEqual(times(result, '2026-11-28'), ['00:00']);
  });

  test('dias em ordem, todas as datas do período, inclusive vazias', () => {
    const result = run({ fromDate: '2026-11-26', toDate: '2026-12-02' });
    assert.deepEqual(
      result.days.map((d) => d.date),
      ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'],
    );
    assert.deepEqual(result.days.map((d) => d.slots.length), [26, 26, 0, 0, 26, 26, 26]);
  });
});

describe('fuso (critério 16)', () => {
  test('o mesmo resultado com TZ do processo em UTC, Asia/Tokyo e America/Sao_Paulo', () => {
    const original = process.env.TZ;
    const outputs = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Sao_Paulo']) {
        process.env.TZ = tz;
        outputs.push(JSON.stringify(run({ fromDate: '2026-11-26', toDate: '2026-12-03', notBeforeMs: sp('2026-11-26T10:07') })));
        outputs.push(JSON.stringify(run({ timeZone: NY, fromDate: '2027-03-13', toDate: '2027-03-15', grade: weekly({ 7: [['01:00', '04:00']] }) })));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(outputs[0], outputs[2]);
    assert.equal(outputs[0], outputs[4]);
    assert.equal(outputs[1], outputs[3]);
    assert.equal(outputs[1], outputs[5]);
  });

  test('Asia/Tokyo como fuso do negócio desloca os instantes, não os rótulos', () => {
    const tokyo = run({ timeZone: TOKYO }).days[0].slots;
    const saoPaulo = run({ timeZone: SP }).days[0].slots;
    assert.deepEqual(
      tokyo.map((s) => [s.start, s.end]),
      saoPaulo.map((s) => [s.start, s.end]),
    );
    assert.equal(tokyo[0].startMs, Date.parse('2026-11-27T00:00:00.000Z'));
    assert.equal(saoPaulo[0].startMs - tokyo[0].startMs, 12 * 3_600_000);
  });
});

describe('horário de verão em America/New_York (critério 17)', () => {
  test('salto (2027-03-14): 01:00–04:00 dá 01:00…01:45 e 03:00…03:45, nenhum 02:xx, com ida e volta exata', () => {
    const result = run({ timeZone: NY, fromDate: '2027-03-14', grade: weekly({ 7: [['01:00', '04:00']] }), durationMinutes: 15 });
    const day = result.days[0];
    assert.equal(day.weekday, 7);
    assert.deepEqual(times(result), [...range('01:00', '01:45'), ...range('03:00', '03:45')]);
    for (const slot of day.slots) {
      assert.equal(localToInstant(parseLocalDateTime(slot.start).value, NY).ms, slot.startMs, slot.start);
      assert.equal(instantToLocal(slot.startMs, NY), slot.start);
      assert.equal(instantToLocal(slot.endMs, NY), slot.end);
    }
    assert.equal(day.slots[3].end, '2027-03-14T03:00');
  });

  test('salto: 02:00–03:00 e 02:45–03:00 são descartados (fim UTC não posterior, nota 4.2 do AF-16)', () => {
    for (const grade of [weekly({ 7: [['02:00', '03:00']] }), weekly({ 7: [['02:45', '03:00']] })]) {
      const result = run({ timeZone: NY, fromDate: '2027-03-14', grade, durationMinutes: 15 });
      assert.deepEqual(result.days[0].slots, []);
      assert.deepEqual(workWindowsForDay(grade, '2027-03-14', NY), []);
    }
    // 02:30–04:00 vira 03:30–04:00 (regra compatible).
    const result = run({ timeZone: NY, fromDate: '2027-03-14', grade: weekly({ 7: [['02:30', '04:00']] }), durationMinutes: 15 });
    assert.deepEqual(times(result), range('03:30', '03:45'));
  });

  test('dobra (2027-11-07): 00:00–03:00 com 15 min dá cada rótulo de 01:00 a 01:45 uma vez (primeira ocorrência)', () => {
    const result = run({ timeZone: NY, fromDate: '2027-11-07', grade: weekly({ 7: [['00:00', '03:00']] }), durationMinutes: 15 });
    const day = result.days[0];
    assert.deepEqual(times(result), range('00:00', '02:45'));
    for (const t of range('01:00', '01:45')) assert.equal(times(result).filter((x) => x === t).length, 1, t);
    const first = day.slots.find((s) => s.start.endsWith('01:00'));
    assert.equal(first.startMs, Date.parse('2027-11-07T05:00:00.000Z'));
    // Os inícios da segunda ocorrência (06:00Z a 06:45Z) não aparecem.
    for (const slot of day.slots) {
      assert.equal(slot.startMs >= Date.parse('2027-11-07T06:00:00.000Z') && slot.startMs < Date.parse('2027-11-07T07:00:00.000Z'), false);
      assert.equal(localToInstant(parseLocalDateTime(slot.start).value, NY).ms, slot.startMs);
    }
    assert.equal(dayFrameOf('2027-11-07', NY).regular, false);
    assert.equal(dayFrameOf('2027-11-08', NY).regular, true);
  });
});

describe('rótulos e teto (critério 20)', () => {
  test('em 3 fusos e 480 instantes, o caminho aritmético do dia regular é igual a instantToLocal', () => {
    for (const timeZone of [SP, TOKYO, NY]) {
      const grade = weekly(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [['00:00', '24:00']]])));
      const result = run({ timeZone, grade, fromDate: '2026-11-23', toDate: '2026-11-27', durationMinutes: 15 });
      let count = 0;
      for (const day of result.days) {
        assert.equal(dayFrameOf(day.date, timeZone).regular, true);
        for (const slot of day.slots) {
          assert.equal(slot.start, instantToLocal(slot.startMs, timeZone));
          assert.equal(slot.end, instantToLocal(slot.endMs, timeZone));
          count += 1;
        }
      }
      assert.equal(count, 480);
    }
  });

  test('teto de inícios por dia: corta e marca truncated', () => {
    const result = run({ slotsPerDayMax: 3, toDate: '2026-11-28' });
    assert.equal(result.truncated, true);
    assert.deepEqual(times(result), ['09:00', '09:15', '09:30']);
    assert.equal(AVAILABILITY_SLOTS_PER_DAY_MAX, 100);
    // Um dia de 24 h com passo de 15 min (96 inícios) não chega ao teto padrão.
    const full = run({ grade: weekly({ 5: [['00:00', '24:00']] }), durationMinutes: 15 });
    assert.equal(full.days[0].slots.length, 96);
    assert.equal(full.truncated, false);
  });
});

describe('funções puras (base do AF-21)', () => {
  test('unionIntervals ordena, funde encostados e sobrepostos e descarta NaN e end <= start', () => {
    const input = [
      { startMs: 50, endMs: 60 },
      { startMs: 10, endMs: 20 },
      { startMs: 20, endMs: 30 },
      { startMs: 25, endMs: 28 },
      { startMs: Number.NaN, endMs: 5 },
      { startMs: 40, endMs: 40 },
      { startMs: 45, endMs: 41 },
      null,
    ];
    assert.deepEqual(unionIntervals(input), [
      { startMs: 10, endMs: 30 },
      { startMs: 50, endMs: 60 },
    ]);
    assert.equal(input[0].startMs, 50, 'não altera a entrada');
    assert.deepEqual(unionIntervals(undefined), []);
  });

  test('subtractIntervals com semiabertos', () => {
    const windows = [{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 300 }];
    assert.deepEqual(subtractIntervals(windows, [{ startMs: 10, endMs: 20 }, { startMs: 90, endMs: 210 }]), [
      { startMs: 0, endMs: 10 },
      { startMs: 20, endMs: 90 },
      { startMs: 210, endMs: 300 },
    ]);
    assert.deepEqual(subtractIntervals(windows, [{ startMs: 100, endMs: 200 }]), windows);
    assert.deepEqual(subtractIntervals(windows, [{ startMs: -5, endMs: 400 }]), []);
    assert.deepEqual(subtractIntervals(windows, []), windows);
  });

  test('interval() do helper e workWindowsForDay une só dentro do dia', () => {
    assert.deepEqual(interval('2026-11-27T12:00:00.000Z', '2026-11-27T13:00:00.000Z'), {
      startMs: Date.parse('2026-11-27T12:00:00.000Z'),
      endMs: Date.parse('2026-11-27T13:00:00.000Z'),
    });
    const windows = workWindowsForDay(weekly({ 5: [['12:00', '13:00'], ['13:00', '14:00']] }), FRIDAY, SP);
    assert.deepEqual(windows, [spInterval('2026-11-27T12:00', '2026-11-27T14:00')]);
  });
});

describe('desempenho', () => {
  test('50 profissionais × 31 dias × 6 intervalos, com bloqueios e ocupados, em < 500 ms', () => {
    const grade = weekly(
      Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((d) => [
          d,
          [
            ['06:00', '08:00'],
            ['08:15', '10:00'],
            ['10:30', '12:00'],
            ['13:00', '15:00'],
            ['15:30', '18:00'],
            ['18:15', '22:00'],
          ],
        ]),
      ),
    );
    const professionals = Array.from({ length: 50 }, (_, i) => {
      const blocks = [];
      const appointments = [];
      for (let d = 0; d < 31; d++) {
        const day = Date.parse('2026-12-01T00:00:00.000-03:00') + d * 86_400_000;
        blocks.push({ startMs: day + (9 + (i % 5)) * 3_600_000, endMs: day + (10 + (i % 5)) * 3_600_000 });
        for (let k = 0; k < 4; k++) {
          const start = day + (14 + k * 2) * 3_600_000 + (i % 4) * 900_000;
          appointments.push({ startMs: start, endMs: start + 45 * 60_000 });
        }
      }
      return { id: `p${i}`, weekly: grade, blocks, appointments };
    });
    const started = performance.now();
    const result = computeAvailability({
      timeZone: SP,
      fromDate: '2026-12-01',
      toDate: '2026-12-31',
      durationMinutes: 30,
      notBeforeMs: 0,
      professionals,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.days.length, 31);
    assert.ok(result.days.every((d) => d.slots.length > 0 && d.slots.length <= AVAILABILITY_SLOTS_PER_DAY_MAX));
    assert.ok(elapsed < 500, `${elapsed.toFixed(1)} ms`);
  });
});
