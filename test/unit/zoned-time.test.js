import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocalDateTime,
  parseLocalDate,
  formatLocalDateTime,
  addLocalDays,
  wallMinutes,
  localToInstant,
  instantToLocal,
} from '../../src/shared/zoned-time.js';

const PROCESS_ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'];

/** Roda `fn` com cada `process.env.TZ` (critério 18: o fuso do processo não entra no cálculo). */
function withProcessZones(fn) {
  const original = process.env.TZ;
  try {
    for (const zone of PROCESS_ZONES) {
      process.env.TZ = zone;
      fn(zone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

const local = (text) => {
  const parsed = parseLocalDateTime(text);
  assert.ok(parsed.ok, text);
  return parsed.value;
};
const toIso = (text, zone) => new Date(localToInstant(local(text), zone).ms).toISOString();

describe('parseLocalDateTime e parseLocalDate', () => {
  test('aceita data e hora válidas', () => {
    assert.deepEqual(parseLocalDateTime('2026-12-24T14:00'), {
      ok: true,
      value: { year: 2026, month: 12, day: 24, hour: 14, minute: 0 },
    });
    assert.equal(parseLocalDateTime('2028-02-29T23:59').ok, true);
    assert.deepEqual(parseLocalDate('2026-12-24'), { ok: true, value: { year: 2026, month: 12, day: 24 } });
  });

  test('recusa formatos, faixas e tipos inválidos', () => {
    const invalid = [
      '2026-02-30T10:00',
      '2027-02-29T10:00',
      '2026-12-24T24:00',
      '2026-12-24T14:60',
      '2026-12-24 14:00',
      '2026-12-24T14:00Z',
      '2026-12-24T14:00:00',
      '1999-12-31T10:00',
      '2100-01-01T00:00',
      '2026-13-01T10:00',
      '2026-12-2xT10:00',
      '+026-12-24T10:00',
      20261224,
      null,
      undefined,
      {},
      'A'.repeat(10_000),
    ];
    for (const raw of invalid) assert.deepEqual(parseLocalDateTime(raw), { ok: false, reason: 'format' }, String(raw).slice(0, 30));
    for (const raw of ['2026-02-30', '26-12-24', '2026-12-24T', '2100-01-01', 20261224, null, 'B'.repeat(10_000)]) {
      assert.deepEqual(parseLocalDate(raw), { ok: false, reason: 'format' }, String(raw).slice(0, 30));
    }
  });

  test('formatLocalDateTime é o inverso do parser', () => {
    assert.equal(formatLocalDateTime(local('2026-01-05T07:15')), '2026-01-05T07:15');
  });
});

describe('aritmética de calendário', () => {
  test('addLocalDays atravessa mês, ano e 29 de fevereiro', () => {
    assert.equal(addLocalDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addLocalDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addLocalDays('2028-03-01', -1), '2028-02-29');
    assert.equal(addLocalDays('2026-12-24', 0), '2026-12-24');
    assert.equal(addLocalDays('inválida', 1), '');
  });

  test('wallMinutes mede duração local, sem fuso', () => {
    assert.equal(wallMinutes(local('2026-12-25T00:00')) - wallMinutes(local('2026-12-24T00:00')), 1440);
    assert.equal(wallMinutes(local('2027-03-15T00:00')) - wallMinutes(local('2027-03-14T00:00')), 1440);
  });
});

describe('localToInstant e instantToLocal (critério 18)', () => {
  test('ida e volta em 96 horários de um dia comum, em três fusos', () => {
    withProcessZones(() => {
      for (const zone of ['America/Sao_Paulo', 'Asia/Tokyo', 'America/New_York']) {
        for (let m = 0; m < 1440; m += 15) {
          const text = `2026-06-10T${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const result = localToInstant(local(text), zone);
          assert.equal(result.adjusted, 'none', `${zone} ${text}`);
          assert.equal(instantToLocal(result.ms, zone), text, `${zone} ${text}`);
        }
      }
    });
  });

  test('valores fixos: São Paulo -03:00 e Tóquio +09:00', () => {
    withProcessZones(() => {
      assert.equal(toIso('2026-12-24T14:00', 'America/Sao_Paulo'), '2026-12-24T17:00:00.000Z');
      assert.equal(toIso('2026-12-24T14:00', 'Asia/Tokyo'), '2026-12-24T05:00:00.000Z');
      assert.equal(instantToLocal(Date.parse('2026-12-24T17:00:00.000Z'), 'America/Sao_Paulo'), '2026-12-24T14:00');
    });
  });

  test('salto (America/New_York, 2027-03-14): 02:30 avança para 03:30', () => {
    withProcessZones(() => {
      const zone = 'America/New_York';
      const gap = localToInstant(local('2027-03-14T02:30'), zone);
      assert.equal(new Date(gap.ms).toISOString(), '2027-03-14T07:30:00.000Z');
      assert.equal(gap.adjusted, 'gap');
      assert.equal(instantToLocal(gap.ms, zone), '2027-03-14T03:30');
      assert.equal(localToInstant(local('2027-03-14T01:45'), zone).adjusted, 'none');
      assert.equal(localToInstant(local('2027-03-14T03:00'), zone).adjusted, 'none');
    });
  });

  test('dobra (America/New_York, 2027-11-07): 01:30 fica com a primeira ocorrência', () => {
    withProcessZones(() => {
      const fold = localToInstant(local('2027-11-07T01:30'), 'America/New_York');
      assert.equal(new Date(fold.ms).toISOString(), '2027-11-07T05:30:00.000Z');
      assert.equal(fold.adjusted, 'fold');
    });
  });

  test('Brasil histórico: salto em 2018-11-04 e dobra em 2019-02-16', () => {
    withProcessZones(() => {
      const zone = 'America/Sao_Paulo';
      const gap = localToInstant(local('2018-11-04T00:00'), zone);
      assert.equal(new Date(gap.ms).toISOString(), '2018-11-04T03:00:00.000Z');
      assert.equal(gap.adjusted, 'gap');
      assert.equal(instantToLocal(gap.ms, zone), '2018-11-04T01:00');
      const fold = localToInstant(local('2019-02-16T23:30'), zone);
      assert.equal(new Date(fold.ms).toISOString(), '2019-02-17T01:30:00.000Z');
      assert.equal(fold.adjusted, 'fold');
    });
  });

  test('monotonia: fora das horas inexistentes, horas crescentes dão instantes estritamente crescentes', () => {
    withProcessZones(() => {
      const days = [
        ['America/New_York', '2027-03-13', 3],
        ['America/New_York', '2027-11-06', 3],
        ['America/Sao_Paulo', '2018-11-03', 3],
        ['America/Sao_Paulo', '2019-02-16', 3],
      ];
      for (const [zone, firstDay, count] of days) {
        let previous = -Infinity;
        for (let d = 0; d < count; d++) {
          const date = addLocalDays(firstDay, d);
          for (let m = 0; m < 1440; m += 15) {
            const text = `${date}T${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            const result = localToInstant(local(text), zone);
            if (result.adjusted === 'gap') continue;
            assert.ok(result.ms > previous, `${zone} ${text}`);
            previous = result.ms;
          }
        }
      }
    });
  });

  test('dentro do salto a regra não é monótona: 02:45 vira 03:45, depois de 03:00', () => {
    // Documenta por que validateTimeBlockInput confere também os instantes (início < fim em UTC).
    const zone = 'America/New_York';
    const inGap = localToInstant(local('2027-03-14T02:45'), zone).ms;
    const after = localToInstant(local('2027-03-14T03:00'), zone).ms;
    assert.ok(inGap > after);
  });
});
