import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime,
  formatTime,
  validateHoursInput,
  toOwnerHours,
  emptyWeek,
  HOURS_MESSAGES as M,
  WEEKDAYS,
  INTERVALS_PER_DAY_MAX,
  INTERVALS_PER_PROFESSIONAL_MAX,
  TIME_STEP_MINUTES,
  DAY_END_MINUTE,
} from '../../src/shared/working-hours.js';
import { PROFESSIONAL_MESSAGES } from '../../src/shared/professionals.js';

const day = (weekday, ...pairs) => ({ weekday, intervals: pairs.map(([start, end]) => ({ start, end })) });

describe('constantes', () => {
  test('regras de negócio fixas', () => {
    assert.deepEqual(WEEKDAYS, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(INTERVALS_PER_DAY_MAX, 6);
    assert.equal(INTERVALS_PER_PROFESSIONAL_MAX, 42);
    assert.equal(TIME_STEP_MINUTES, 15);
    assert.equal(DAY_END_MINUTE, 1440);
    assert.equal(M.notFound, PROFESSIONAL_MESSAGES.notFound);
    assert.ok(Object.isFrozen(M));
  });
});

describe('parseTime (critérios 5, 6 e 9)', () => {
  test('aceita 00:00, 23:45 e 24:00', () => {
    assert.deepEqual(parseTime('00:00'), { ok: true, minutes: 0 });
    assert.deepEqual(parseTime('23:45'), { ok: true, minutes: 1425 });
    assert.deepEqual(parseTime('24:00'), { ok: true, minutes: 1440 });
  });

  test('formatos inválidos dão format', () => {
    const long = '0'.repeat(10_000);
    for (const raw of ['25:00', '09:60', '24:15', '9:00', '09:00:00', '0900', '', 900, null, undefined, long, '09h00', ' 9:00']) {
      assert.deepEqual(parseTime(raw), { ok: false, reason: 'format' }, String(raw).slice(0, 20));
    }
  });

  test('minutos fora do passo dão step', () => {
    assert.deepEqual(parseTime('09:10'), { ok: false, reason: 'step' });
    assert.deepEqual(parseTime('23:59'), { ok: false, reason: 'step' });
  });

  test('formatTime(1440) = 24:00 e parseTime/formatTime são inversos para os 97 valores', () => {
    assert.equal(formatTime(1440), '24:00');
    assert.equal(formatTime(0), '00:00');
    let count = 0;
    for (let m = 0; m <= 1440; m += 15) {
      const text = formatTime(m);
      assert.match(text, /^\d{2}:\d{2}$/);
      assert.deepEqual(parseTime(text), { ok: true, minutes: m });
      count++;
    }
    assert.equal(count, 97);
  });
});

describe('validateHoursInput', () => {
  test('dois intervalos (almoço) aceitos e ordenados por início (critério 4)', () => {
    const r = validateHoursInput({ days: [day(1, ['13:00', '18:00'], ['09:00', '12:00'])] });
    assert.deepEqual(r, {
      ok: true,
      value: [
        {
          weekday: 1,
          intervals: [
            { startMinute: 540, endMinute: 720 },
            { startMinute: 780, endMinute: 1080 },
          ],
        },
      ],
    });
  });

  test('início >= fim dá endBeforeStart em .end (critério 7)', () => {
    for (const [start, end] of [
      ['09:00', '09:00'],
      ['00:00', '00:00'],
      ['12:00', '09:00'],
      ['24:00', '24:00'],
    ]) {
      const r = validateHoursInput({ days: [day(3, [start, end])] });
      assert.equal(r.ok, false);
      assert.deepEqual(r.fields, { 'days.3.intervals.0.end': M.endBeforeStart }, `${start}-${end}`);
    }
  });

  test('24:00 como fim é aceito', () => {
    const r = validateHoursInput({ days: [day(5, ['18:00', '24:00'])] });
    assert.deepEqual(r.value[0].intervals, [{ startMinute: 1080, endMinute: 1440 }]);
  });

  test('sobreposição marca as duas posições (critério 8)', () => {
    const r = validateHoursInput({ days: [day(1, ['09:00', '12:00'], ['11:00', '13:00'])] });
    assert.deepEqual(r.fields, {
      'days.1.intervals.0': M.overlap(2),
      'days.1.intervals.1': M.overlap(1),
    });
    assert.equal(M.overlap(2), 'Este intervalo se sobrepõe ao intervalo 2.');
  });

  test('intervalo longo que cobre dois outros: todos marcados', () => {
    const r = validateHoursInput({ days: [day(1, ['09:00', '18:00'], ['10:00', '11:00'], ['12:00', '13:00'])] });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.fields).sort(), [
      'days.1.intervals.0',
      'days.1.intervals.1',
      'days.1.intervals.2',
    ]);
  });

  test('intervalos que se tocam são aceitos e mantidos separados', () => {
    const r = validateHoursInput({ days: [day(2, ['12:00', '13:00'], ['13:00', '14:00'])] });
    assert.deepEqual(r.value[0].intervals, [
      { startMinute: 720, endMinute: 780 },
      { startMinute: 780, endMinute: 840 },
    ]);
  });

  test('dois inícios iguais dão overlap', () => {
    const r = validateHoursInput({ days: [day(2, ['09:00', '10:00'], ['09:00', '11:00'])] });
    assert.equal(r.ok, false);
    assert.equal(r.fields['days.2.intervals.0'], M.overlap(2));
    assert.equal(r.fields['days.2.intervals.1'], M.overlap(1));
  });

  test('7 intervalos dão intervalsTooMany sem iterar os itens', () => {
    let reads = 0;
    const tracked = Array.from({ length: 7 }, () => {
      const item = {};
      Object.defineProperty(item, 'start', {
        get() {
          reads++;
          return '09:00';
        },
      });
      item.end = '10:00';
      return item;
    });
    const r = validateHoursInput({ days: [{ weekday: 1, intervals: tracked }] });
    assert.deepEqual(r.fields, { 'days.1': M.intervalsTooMany });
    assert.equal(reads, 0);
  });

  test('8 dias dão daysInvalid sem iterar os dias', () => {
    let reads = 0;
    const days = Array.from({ length: 8 }, (_, i) => {
      const d = { intervals: [] };
      Object.defineProperty(d, 'weekday', {
        get() {
          reads++;
          return (i % 7) + 1;
        },
      });
      return d;
    });
    assert.deepEqual(validateHoursInput({ days }), { ok: false, fields: { days: M.daysInvalid } });
    assert.equal(reads, 0);
    assert.deepEqual(validateHoursInput({ days: 'x' }), { ok: false, fields: { days: M.daysInvalid } });
    assert.deepEqual(validateHoursInput({ days: null }), { ok: false, fields: { days: M.daysInvalid } });
  });

  test('weekday 0, 8, "1", 1.5 e ausente dão weekdayInvalid pela posição', () => {
    const r = validateHoursInput({
      days: [
        { weekday: 0, intervals: [] },
        { weekday: 8, intervals: [] },
        { weekday: '1', intervals: [] },
        { weekday: 1.5, intervals: [] },
        { intervals: [] },
      ],
    });
    assert.deepEqual(r.fields, {
      'days.0': M.weekdayInvalid,
      'days.1': M.weekdayInvalid,
      'days.2': M.weekdayInvalid,
      'days.3': M.weekdayInvalid,
      'days.4': M.weekdayInvalid,
    });
  });

  test('dia repetido', () => {
    const r = validateHoursInput({ days: [day(4), day(4, ['09:00', '10:00'])] });
    assert.deepEqual(r.fields, { 'days.4': M.weekdayRepeated });
  });

  test('intervals que não é array', () => {
    const r = validateHoursInput({ days: [{ weekday: 6, intervals: 'x' }, { weekday: 7 }] });
    assert.deepEqual(r.fields, { 'days.6': M.intervalsInvalid, 'days.7': M.intervalsInvalid });
  });

  test('intervals: [] vira folga (critério 13)', () => {
    assert.deepEqual(validateHoursInput({ days: [day(6)] }), { ok: true, value: [{ weekday: 6, intervals: [] }] });
  });

  test('{}, days: [] e entradas não objeto dão "Nada para atualizar."', () => {
    for (const input of [{}, { days: [] }, null, undefined, 'x', []]) {
      assert.deepEqual(validateHoursInput(input), { ok: false, fields: {}, message: 'Nada para atualizar.' });
    }
  });

  test('erros em vários dias voltam todos de uma vez, com chaves start/end (critério 11)', () => {
    const r = validateHoursInput({
      days: [day(1, ['9:00', '12:00']), day(2, ['09:00', '12:10']), day(3, ['08:00', '09:00']), { weekday: 4, intervals: [null] }],
    });
    assert.deepEqual(r.fields, {
      'days.1.intervals.0.start': M.timeInvalid,
      'days.2.intervals.0.end': M.timeStep,
      'days.4.intervals.0.start': M.timeInvalid,
      'days.4.intervals.0.end': M.timeInvalid,
    });
  });

  test('a semana é devolvida em ordem de weekday; outros campos são ignorados', () => {
    const r = validateHoursInput({ businessId: 'x', days: [day(7), day(1, ['09:00', '10:00'])] });
    assert.deepEqual(
      r.value.map((d) => d.weekday),
      [1, 7],
    );
  });

  test('nenhuma mensagem contém a entrada', () => {
    const evil = '<script>alert(1)</script>' + 'x'.repeat(10_000);
    const r = validateHoursInput({
      days: [
        { weekday: 1, intervals: [{ start: evil, end: evil }] },
        { weekday: evil, intervals: [] },
        { weekday: 2, intervals: evil },
      ],
    });
    const text = JSON.stringify(r);
    assert.ok(!text.includes('<script>'));
    assert.ok(text.length < 1000);
  });
});

describe('toOwnerHours e emptyWeek (critérios 2 e 3)', () => {
  test('sem linhas: 7 dias vazios, na ordem, hasHours false', () => {
    const hours = toOwnerHours([]);
    assert.deepEqual(hours, { days: emptyWeek(), hasHours: false });
    assert.deepEqual(
      hours.days.map((d) => d.weekday),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  test('ordena por dia e início e formata HH:MM', () => {
    const hours = toOwnerHours([
      { weekday: 3, startMinute: 780, endMinute: 1440 },
      { weekday: 3, startMinute: 0, endMinute: 60 },
      { weekday: 1, startMinute: 540, endMinute: 720 },
    ]);
    assert.equal(hours.hasHours, true);
    assert.deepEqual(hours.days[0].intervals, [{ start: '09:00', end: '12:00' }]);
    assert.deepEqual(hours.days[2].intervals, [
      { start: '00:00', end: '01:00' },
      { start: '13:00', end: '24:00' },
    ]);
  });

  test('emptyWeek devolve objetos novos a cada chamada', () => {
    const a = emptyWeek();
    a[0].intervals.push({ start: '09:00', end: '10:00' });
    assert.deepEqual(emptyWeek()[0].intervals, []);
  });
});
