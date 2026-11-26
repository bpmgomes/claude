// AF-21: horário de verão no motor de disponibilidade (critérios 23 a 32). Único arquivo do motor
// que depende do tzdata do Node. Design: docs/design/AF-21.md, 3.3 e 3.4.
// Todo dia de transição passa por assertTransitionDay ANTES de qualquer outra asserção (o Intl do
// Node decide a data; se o tzdata mudar, a falha diz data, fuso e versão). Os instantes esperados
// são afirmados em UTC. "caracterização:" fixa o comportamento atual (ponto em aberto 5 da história,
// letras a a d), e não uma regra desejada.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeAvailability, dayFrameOf, workWindowsForDay, isoWeekdayOf } from '../../src/modules/availability/availability-engine.js';
import { addLocalDays } from '../../src/shared/zoned-time.js';
import { AVAILABILITY_SLOTS_PER_DAY_MAX } from '../../src/shared/availability.js';
import {
  weekly,
  everyDay,
  clockRange,
  localMs,
  localInterval,
  runEngine,
  slotTimes,
  utcOffsetMinutes,
  assertTransitionDay,
  assertStartRoundTrips,
} from '../helpers/availability.js';

const NY = 'America/New_York';
const ST = 'America/Santiago';
const SP = 'America/Sao_Paulo';
const KOLKATA = 'Asia/Kolkata';
const LORD_HOWE = 'Australia/Lord_Howe';
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ALL_DAY = everyDay([['00:00', '24:00']]);
const TYPICAL = everyDay([['09:00', '12:00'], ['13:00', '18:00']]);
const TYPICAL_TIMES = [...clockRange('09:00', '11:00'), ...clockRange('13:00', '17:00')];

const utc = (iso) => Date.parse(iso);
const day = (result, date) => result.days.find((d) => d.date === date);

/** Rótulos únicos, startMs crescente e ida e volta de todo início. */
function assertCleanDay(dayResult, timeZone) {
  const labels = dayResult.slots.map((s) => s.start);
  assert.equal(new Set(labels).size, labels.length, `rótulo repetido em ${dayResult.date}`);
  for (let i = 1; i < dayResult.slots.length; i++) assert.ok(dayResult.slots[i].startMs > dayResult.slots[i - 1].startMs);
  for (const slot of dayResult.slots) assertStartRoundTrips(slot, timeZone);
}

// Contagens derivadas no design (3.3) e conferidas na primeira execução (seção 10).
const TRANSITIONS = [
  [NY, '2027-03-14', 'salto 02:00→03:00', 23, 92, 89],
  [NY, '2027-11-07', 'dobra 01:00–02:00', 25, 96, 93],
  [ST, '2027-09-05', 'salto 00:00→01:00', 23, 92, 89],
  [ST, '2027-04-03', 'dobra 23:00–24:00', 25, 96, 96],
  [SP, '2018-11-04', 'salto 00:00→01:00', 23, 92, 89],
  [SP, '2019-02-16', 'dobra 23:00–24:00', 25, 96, 96],
  [LORD_HOWE, '2027-10-03', 'salto 02:00→02:30', 23.5, 94, 91],
  [LORD_HOWE, '2027-04-04', 'dobra 01:30–02:00', 24.5, 96, 93],
];

describe('dias de transição: pré-condição e contagem com grade 00:00–24:00', () => {
  for (const [timeZone, date, kind, hours, n15, n60] of TRANSITIONS) {
    test(`${timeZone} ${date} (${kind}, ${hours} h): ${n15} inícios com 15 min e ${n60} com 60 min`, () => {
      assertTransitionDay(date, timeZone, hours);
      for (const [duration, expected] of [
        [15, n15],
        [60, n60],
      ]) {
        const result = runEngine({ timeZone, fromDate: date, grade: ALL_DAY, durationMinutes: duration });
        const d = result.days[0];
        assert.equal(d.slots.length, expected, `${duration} min`);
        assert.equal(result.truncated, false);
        for (const slot of d.slots) assert.equal(slot.endMs - slot.startMs, duration * MINUTE_MS, slot.start);
        assertCleanDay(d, timeZone);
      }
    });
  }
});

describe('America/New_York (critérios 23 a 26)', () => {
  test('critério 23: salto com 60 min: nenhum 02:xx; 01:00 = 06:00Z, dura 60 min reais e termina com rótulo 03:00', () => {
    assertTransitionDay('2027-03-14', NY, 23);
    const d = runEngine({ timeZone: NY, fromDate: '2027-03-14', grade: ALL_DAY }).days[0];
    assert.equal(slotTimes({ days: [d] }).some((t) => t.startsWith('02:')), false);
    const one = d.slots.find((s) => s.start === '2027-03-14T01:00');
    assert.equal(one.startMs, utc('2027-03-14T06:00:00.000Z'));
    assert.equal(one.endMs - one.startMs, HOUR_MS);
    assert.equal(one.endMs, utc('2027-03-14T07:00:00.000Z'));
    assert.equal(one.end, '2027-03-14T03:00');
    assert.equal(d.slots.length, 89);
  });

  test('critério 24: dobra com 15 min: cada rótulo de 00:00 a 23:45 uma vez, nenhum início na 2ª ocorrência (06:00Z–07:00Z)', () => {
    assertTransitionDay('2027-11-07', NY, 25);
    const result = runEngine({ timeZone: NY, fromDate: '2027-11-07', grade: ALL_DAY, durationMinutes: 15 });
    const d = result.days[0];
    assert.deepEqual(slotTimes(result), clockRange('00:00', '23:45'));
    assert.equal(result.truncated, false);
    for (const slot of d.slots) {
      assert.equal(slot.startMs >= utc('2027-11-07T06:00:00.000Z') && slot.startMs < utc('2027-11-07T07:00:00.000Z'), false, slot.start);
      assert.equal(slot.endMs - slot.startMs, 15 * MINUTE_MS);
    }
    assert.equal(d.slots.find((s) => s.start.endsWith('01:00')).startMs, utc('2027-11-07T05:00:00.000Z'));
  });

  test('critério 24: caracterização (a): dobra com 60 min, 01:30 (05:30Z) termina 06:30Z, com o mesmo rótulo 01:30', () => {
    assertTransitionDay('2027-11-07', NY, 25);
    const d = runEngine({ timeZone: NY, fromDate: '2027-11-07', grade: ALL_DAY }).days[0];
    const slot = d.slots.find((s) => s.start === '2027-11-07T01:30');
    assert.equal(slot.startMs, utc('2027-11-07T05:30:00.000Z'));
    assert.equal(slot.endMs, utc('2027-11-07T06:30:00.000Z'));
    assert.equal(slot.end, '2027-11-07T01:30');
  });

  test('critério 25: caracterização (b): no salto, 01:00–02:00 + 03:00–04:00 vira uma janela 06:00Z–08:00Z e 01:30 (60 min) é oferecido', () => {
    assertTransitionDay('2027-03-14', NY, 23);
    const grade = weekly({ 7: [['01:00', '02:00'], ['03:00', '04:00']] });
    assert.deepEqual(workWindowsForDay(grade, '2027-03-14', NY), [{ startMs: utc('2027-03-14T06:00:00.000Z'), endMs: utc('2027-03-14T08:00:00.000Z') }]);
    const d = runEngine({ timeZone: NY, fromDate: '2027-03-14', grade }).days[0];
    assert.deepEqual(slotTimes({ days: [d] }), ['01:00', '01:15', '01:30', '01:45', '03:00']);
    const slot = d.slots.find((s) => s.start === '2027-03-14T01:30');
    assert.equal(slot.startMs, utc('2027-03-14T06:30:00.000Z'));
    assert.equal(slot.end, '2027-03-14T03:30');
  });

  test('critério 25: caracterização (c): na dobra, 00:00–01:00 + 02:00–04:00 deixa 2 h reais de pausa, nenhum 01:xx', () => {
    assertTransitionDay('2027-11-07', NY, 25);
    const grade = weekly({ 7: [['00:00', '01:00'], ['02:00', '04:00']] });
    assert.deepEqual(workWindowsForDay(grade, '2027-11-07', NY), [
      { startMs: utc('2027-11-07T04:00:00.000Z'), endMs: utc('2027-11-07T05:00:00.000Z') },
      { startMs: utc('2027-11-07T07:00:00.000Z'), endMs: utc('2027-11-07T09:00:00.000Z') },
    ]);
    const t = slotTimes(runEngine({ timeZone: NY, fromDate: '2027-11-07', grade }));
    assert.deepEqual(t, ['00:00', '02:00', '02:15', '02:30', '02:45', '03:00']);
    assert.equal(t.some((x) => x.startsWith('01:')), false);
  });

  test('critério 26: vizinhos regulares com os mesmos rótulos de um dia comum, só com outro offset', () => {
    const neighbors = [
      ['2027-03-13', '2027-03-06', -300],
      ['2027-03-15', '2027-03-22', -240],
      ['2027-11-06', '2027-10-30', -240],
      ['2027-11-08', '2027-11-15', -300],
    ];
    for (const [date, ordinary, offset] of neighbors) {
      const frame = dayFrameOf(date, NY);
      assert.equal(frame.regular, true, date);
      assert.equal(utcOffsetMinutes(frame.startMs, NY), offset, date);
      assert.equal(utcOffsetMinutes(frame.endMs - 1, NY), offset, date);
      assert.equal(isoWeekdayOf(date), isoWeekdayOf(ordinary));
      for (const grade of [ALL_DAY, TYPICAL]) {
        const result = runEngine({ timeZone: NY, fromDate: date, grade });
        assert.deepEqual(slotTimes(result), slotTimes(runEngine({ timeZone: NY, fromDate: ordinary, grade })), date);
        assert.equal(result.days[0].slots[0].startMs, frame.startMs + (grade === ALL_DAY ? 0 : 9 * HOUR_MS), date);
      }
    }
  });

  test('critério 26: bloqueio de dia inteiro de 2027-03-14 não toca 03-13 nem 03-15', () => {
    assertTransitionDay('2027-03-14', NY, 23);
    const opts = { timeZone: NY, fromDate: '2027-03-13', toDate: '2027-03-15', grade: ALL_DAY };
    const blocked = runEngine({ ...opts, blocks: [localInterval('2027-03-14T00:00', '2027-03-15T00:00', NY)] });
    const plain = runEngine(opts);
    assert.deepEqual(day(blocked, '2027-03-14').slots, []);
    assert.deepEqual(day(blocked, '2027-03-13'), day(plain, '2027-03-13'));
    assert.deepEqual(day(blocked, '2027-03-15'), day(plain, '2027-03-15'));
    assert.equal(day(plain, '2027-03-13').slots.length, 93);
  });
});

describe('cache de minuto em dia irregular', () => {
  test('o mesmo minuto como fim de uma janela e início de outra (01:00–01:30 + 01:30–04:00) dá o mesmo que 01:00–04:00', () => {
    assertTransitionDay('2027-03-14', NY, 23);
    const split = runEngine({ timeZone: NY, fromDate: '2027-03-14', grade: weekly({ 7: [['01:00', '01:30'], ['01:30', '04:00']] }), durationMinutes: 15 });
    const single = runEngine({ timeZone: NY, fromDate: '2027-03-14', grade: weekly({ 7: [['01:00', '04:00']] }), durationMinutes: 15 });
    assert.deepEqual(split, single);
    assert.deepEqual(slotTimes(single), [...clockRange('01:00', '01:45'), ...clockRange('03:00', '03:45')]);
  });

  test('dois profissionais com a mesma grade no dia de transição: os mesmos inícios, com [A, B]', () => {
    assertTransitionDay('2027-03-14', NY, 23);
    const grade = weekly({ 7: [['01:00', '04:00']] });
    const both = runEngine({
      timeZone: NY,
      fromDate: '2027-03-14',
      durationMinutes: 15,
      professionals: [
        { id: 'A', weekly: grade, blocks: [], appointments: [] },
        { id: 'B', weekly: grade, blocks: [], appointments: [] },
      ],
    });
    const single = runEngine({ timeZone: NY, fromDate: '2027-03-14', grade, durationMinutes: 15 });
    assert.deepEqual(
      both.days[0].slots.map((s) => [s.startMs, s.start, s.end]),
      single.days[0].slots.map((s) => [s.startMs, s.start, s.end]),
    );
    for (const slot of both.days[0].slots) assert.deepEqual(slot.professionalIds, ['A', 'B']);
  });
});

describe('America/Santiago, transição à meia-noite (critérios 27 e 28)', () => {
  test('critério 28: salto (2027-09-05) com 00:00–06:00 e 15 min: primeiro início 01:00 (04:00Z), nenhum 00:xx', () => {
    assertTransitionDay('2027-09-05', ST, 23);
    const result = runEngine({ timeZone: ST, fromDate: '2027-09-05', grade: weekly({ 7: [['00:00', '06:00']] }), durationMinutes: 15 });
    const d = result.days[0];
    assert.deepEqual(slotTimes(result), clockRange('01:00', '05:45'));
    assert.equal(d.slots[0].startMs, utc('2027-09-05T04:00:00.000Z'));
    assertCleanDay(d, ST);
  });

  test('critério 28: caracterização (c): dobra (2027-04-03) 22:00–24:00 com 120 min: 3 h reais, cinco inícios 22:00 a 23:00 (corrigido no design, seção 2)', () => {
    assertTransitionDay('2027-04-03', ST, 25);
    const d = runEngine({ timeZone: ST, fromDate: '2027-04-03', grade: weekly({ 6: [['22:00', '24:00']] }), durationMinutes: 120 }).days[0];
    assert.deepEqual(
      d.slots.map((s) => [s.start, s.end, s.startMs]),
      [
        ['2027-04-03T22:00', '2027-04-03T23:00', utc('2027-04-04T01:00:00.000Z')],
        ['2027-04-03T22:15', '2027-04-03T23:15', utc('2027-04-04T01:15:00.000Z')],
        ['2027-04-03T22:30', '2027-04-03T23:30', utc('2027-04-04T01:30:00.000Z')],
        ['2027-04-03T22:45', '2027-04-03T23:45', utc('2027-04-04T01:45:00.000Z')],
        ['2027-04-03T23:00', '2027-04-04T00:00', utc('2027-04-04T02:00:00.000Z')],
      ],
    );
    assertCleanDay(d, ST);
  });

  test('caracterização (vizinho do salto à meia-noite): 2027-09-04 é regular e 22:00–24:00 com 120 min termina em 2027-09-05T01:00', () => {
    const frame = dayFrameOf('2027-09-04', ST);
    assert.equal(frame.regular, true);
    assertTransitionDay('2027-09-05', ST, 23);
    const slots = runEngine({ timeZone: ST, fromDate: '2027-09-04', grade: weekly({ 6: [['22:00', '24:00']] }), durationMinutes: 120 }).days[0].slots;
    assert.deepEqual(
      slots.map((s) => [s.start, s.end, s.startMs, s.endMs]),
      [['2027-09-04T22:00', '2027-09-05T01:00', utc('2027-09-05T02:00:00.000Z'), utc('2027-09-05T04:00:00.000Z')]],
    );
    assert.equal(slots[0].endMs, frame.endMs);
  });
});

describe('Brasil histórico (critérios 29 a 31)', () => {
  test('critério 29 e 30: entrada (2018-11-04): grade típica com os 26 rótulos de um dia comum, 09:00 = 11:00Z; vizinhos iguais', () => {
    assertTransitionDay('2018-11-04', SP, 23);
    const result = runEngine({ timeZone: SP, fromDate: '2018-11-03', toDate: '2018-11-05', grade: TYPICAL });
    for (const date of ['2018-11-03', '2018-11-04', '2018-11-05']) assert.deepEqual(slotTimes(result, date), TYPICAL_TIMES, date);
    assert.equal(day(result, '2018-11-04').slots[0].startMs, utc('2018-11-04T11:00:00.000Z'));
    assert.equal(day(result, '2018-11-03').slots[0].startMs, utc('2018-11-03T12:00:00.000Z'));
    assert.equal(day(result, '2018-11-05').slots[0].startMs, utc('2018-11-05T11:00:00.000Z'));
    assertCleanDay(day(result, '2018-11-04'), SP);
  });

  test('critério 29 e 30: saída (2019-02-16): grade típica com os 26 rótulos de um dia comum; vizinhos 02-15, 02-17 e 02-18 iguais', () => {
    assertTransitionDay('2019-02-16', SP, 25);
    const result = runEngine({ timeZone: SP, fromDate: '2019-02-15', toDate: '2019-02-18', grade: TYPICAL });
    for (const date of ['2019-02-15', '2019-02-16', '2019-02-17', '2019-02-18']) assert.deepEqual(slotTimes(result, date), TYPICAL_TIMES, date);
    assert.equal(day(result, '2019-02-16').slots[0].startMs, utc('2019-02-16T11:00:00.000Z'));
    assert.equal(day(result, '2019-02-17').slots[0].startMs, utc('2019-02-17T12:00:00.000Z'));
    assertCleanDay(day(result, '2019-02-16'), SP);
  });

  test('critério 30: grade que toca a entrada (domingo 00:00–06:00): primeiro 01:00 (03:00Z), nenhum 00:xx', () => {
    assertTransitionDay('2018-11-04', SP, 23);
    const result = runEngine({ timeZone: SP, fromDate: '2018-11-04', grade: weekly({ 7: [['00:00', '06:00']] }), durationMinutes: 15 });
    assert.deepEqual(slotTimes(result), clockRange('01:00', '05:45'));
    assert.equal(result.days[0].slots[0].startMs, utc('2018-11-04T03:00:00.000Z'));
    assertCleanDay(result.days[0], SP);
  });

  test('critério 30: caracterização (c): grade que toca a saída (sábado 22:00–24:00, 120 min): cinco inícios, como em Santiago', () => {
    assertTransitionDay('2019-02-16', SP, 25);
    const d = runEngine({ timeZone: SP, fromDate: '2019-02-16', grade: weekly({ 6: [['22:00', '24:00']] }), durationMinutes: 120 }).days[0];
    assert.deepEqual(
      d.slots.map((s) => [s.start, s.end]),
      [
        ['2019-02-16T22:00', '2019-02-16T23:00'],
        ['2019-02-16T22:15', '2019-02-16T23:15'],
        ['2019-02-16T22:30', '2019-02-16T23:30'],
        ['2019-02-16T22:45', '2019-02-16T23:45'],
        ['2019-02-16T23:00', '2019-02-17T00:00'],
      ],
    );
    assert.equal(d.slots[0].startMs, utc('2019-02-17T00:00:00.000Z'));
    assertCleanDay(d, SP);
  });

  test('critério 30: bloqueio e agendamento de dia inteiro só esvaziam o próprio dia', () => {
    const cases = [
      ['2018-11-04', '2018-11-03', '2018-11-05', 23],
      ['2019-02-16', '2019-02-15', '2019-02-17', 25],
    ];
    for (const [date, before, after, hours] of cases) {
      assertTransitionDay(date, SP, hours);
      const opts = { timeZone: SP, fromDate: before, toDate: after, grade: ALL_DAY };
      const plain = runEngine(opts);
      const whole = localInterval(`${date}T00:00`, `${after}T00:00`, SP);
      for (const key of ['blocks', 'appointments']) {
        const busy = runEngine({ ...opts, [key]: [whole] });
        assert.deepEqual(day(busy, date).slots, [], `${key} ${date}`);
        assert.deepEqual(day(busy, before), day(plain, before), `${key} ${before}`);
        assert.deepEqual(day(busy, after), day(plain, after), `${key} ${after}`);
      }
    }
  });

  test('caracterização (vizinho do salto à meia-noite): 2018-11-03 22:00–24:00 com 120 min termina em 2018-11-04T01:00', () => {
    assert.equal(dayFrameOf('2018-11-03', SP).regular, true);
    assertTransitionDay('2018-11-04', SP, 23);
    const slots = runEngine({ timeZone: SP, fromDate: '2018-11-03', grade: weekly({ 6: [['22:00', '24:00']] }), durationMinutes: 120 }).days[0].slots;
    assert.deepEqual(
      slots.map((s) => [s.start, s.end, s.endMs]),
      [['2018-11-03T22:00', '2018-11-04T01:00', utc('2018-11-04T03:00:00.000Z')]],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Varredura de invariantes (critério 32; design 3.4).

/**
 * Ocupação fixa por semana: bloqueio todo domingo 01:15–02:45 (saltos e dobras de NY e Lord Howe)
 * e agendamento todo sábado 23:15–23:45 (dobras de Santiago e do Brasil). Intervalo convertido com
 * endMs <= startMs fica na lista: o motor o descarta, e a invariante (e) filtra igual.
 */
function weeklyBusy(fromDate, toDate, timeZone) {
  const blocks = [];
  const appointments = [];
  for (let date = addLocalDays(fromDate, -1); date <= addLocalDays(toDate, 1); date = addLocalDays(date, 1)) {
    const weekday = isoWeekdayOf(date);
    if (weekday === 7) blocks.push(localInterval(`${date}T01:15`, `${date}T02:45`, timeZone));
    if (weekday === 6) appointments.push(localInterval(`${date}T23:15`, `${date}T23:45`, timeZone));
  }
  return { blocks, appointments };
}

// [fuso, de, até, dias irregulares esperados pelo tzdata]
const SWEEP = [
  [SP, '2018-10-25', '2019-03-05', ['2018-11-04', '2019-02-16']],
  [SP, '2026-01-01', '2026-12-31', []],
  [NY, '2027-01-01', '2027-12-31', ['2027-03-14', '2027-11-07']],
  [ST, '2027-01-01', '2027-12-31', ['2027-04-03', '2027-09-05']],
  [KOLKATA, '2027-01-01', '2027-12-31', []],
  [LORD_HOWE, '2027-01-01', '2027-12-31', ['2027-04-04', '2027-10-03']],
];

describe('varredura de invariantes (critérios 31 e 32)', () => {
  for (const [timeZone, fromDate, toDate, irregularDays] of SWEEP) {
    test(`critério 32: ${timeZone} de ${fromDate} a ${toDate}, 15 e 60 min, invariantes (a) a (f)`, () => {
      for (const date of irregularDays) assert.equal(dayFrameOf(date, timeZone).regular, false, `pré-condição: ${timeZone} ${date} (tzdata ${process.versions.tz})`);
      const { blocks, appointments } = weeklyBusy(fromDate, toDate, timeZone);
      const busy = [...blocks, ...appointments].filter((i) => i.endMs > i.startMs);
      const frames = new Map();
      const windows = new Map();
      for (let date = fromDate; date <= toDate; date = addLocalDays(date, 1)) {
        frames.set(date, dayFrameOf(date, timeZone));
        windows.set(date, workWindowsForDay(ALL_DAY, date, timeZone));
      }
      const irregular = [...frames].filter(([, f]) => !f.regular).map(([d]) => d);
      assert.deepEqual(irregular, irregularDays, `dias irregulares de ${timeZone} (tzdata ${process.versions.tz})`);
      const fullRoundTrip = new Set(irregular.flatMap((d) => [addLocalDays(d, -1), d, addLocalDays(d, 1)]));

      for (const duration of [15, 60]) {
        const durationMs = duration * MINUTE_MS;
        const result = computeAvailability({
          timeZone,
          fromDate,
          toDate,
          durationMinutes: duration,
          notBeforeMs: Number.NEGATIVE_INFINITY,
          professionals: [{ id: 'A', weekly: ALL_DAY, blocks, appointments }],
        });
        assert.equal(result.truncated, false, '(f) truncated');
        assert.equal(result.days.length, frames.size);
        for (const d of result.days) {
          const where = `${timeZone} ${d.date} ${duration} min`;
          assert.ok(d.slots.length > 0 && d.slots.length <= AVAILABILITY_SLOTS_PER_DAY_MAX, `(f) ${where}`);
          const dayWindows = windows.get(d.date);
          const frame = frames.get(d.date);
          const dayBusy = busy.filter((b) => b.startMs < frame.endMs + durationMs && b.endMs > frame.startMs);
          const labels = new Set();
          let previous = Number.NEGATIVE_INFINITY;
          for (const slot of d.slots) {
            const at = `${where} ${slot.start}`;
            if (fullRoundTrip.has(d.date) || slot.start.endsWith(':00')) assertStartRoundTrips(slot, timeZone); // (a)
            assert.equal(slot.endMs - slot.startMs, durationMs, `(b) ${at}`);
            assert.ok(slot.startMs > previous, `(c) ${at}`);
            assert.ok(!labels.has(slot.start), `(c) ${at}`);
            labels.add(slot.start);
            previous = slot.startMs;
            assert.equal(slot.start.slice(0, 10), d.date, `(d) ${at}`);
            assert.ok(dayWindows.some((w) => w.startMs <= slot.startMs && slot.endMs <= w.endMs), `(e) janela ${at}`);
            assert.ok(!dayBusy.some((b) => b.startMs < slot.endMs && slot.startMs < b.endMs), `(e) ocupado ${at}`);
          }
        }
      }

      if (timeZone === SP && fromDate === '2026-01-01') {
        // Critério 31: sem horário de verão em 2026, offset fixo -03:00 e todos os dias regulares.
        for (const [date, frame] of frames) {
          assert.equal(frame.regular, true, date);
          assert.equal(utcOffsetMinutes(frame.startMs, timeZone), -180, `${date} 00:00`);
          assert.equal(utcOffsetMinutes(localMs(`${date}T12:00`, timeZone), timeZone), -180, `${date} 12:00`);
        }
      }
    });
  }
});
