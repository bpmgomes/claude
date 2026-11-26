// AF-14 (design 4.2 e 6.1, critérios 1, 3, 8, 31 e 35): regras puras da agenda.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAgendaQuery,
  isoWeekdayOfDate,
  startOfIsoWeek,
  displayKeyOf,
  AGENDA_MESSAGES as M,
  AGENDA_STATUSES,
  AGENDA_STATUS_DISPLAY,
  CANCELLED_BY,
  CANCELLED_BY_LABELS,
  AGENDA_ITEMS_MAX,
} from '../../src/shared/agenda.js';
import { APPOINTMENT_STATUSES } from '../../src/shared/appointments.js';
import { isoWeekdayOf } from '../../src/modules/availability/availability-engine.js';
import { addLocalDays } from '../../src/shared/zoned-time.js';
import { createDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';

const TODAY = '2026-11-26';
const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const v = (query) => validateAgendaQuery(query, { today: TODAY });

describe('validateAgendaQuery (critérios 1 e 3, C-1, C-2)', () => {
  test('dia, semana, 7 dias aceitos; dates na ordem', () => {
    assert.deepEqual(v({ from: TODAY, to: TODAY }).value.dates, [TODAY]);
    const week = v({ from: '2026-11-23', to: '2026-11-29' });
    assert.equal(week.ok, true);
    assert.deepEqual(week.value.dates, ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    assert.deepEqual(v({ from: '2026-12-29', to: '2027-01-04' }).value.dates.at(-1), '2027-01-04');
  });

  test('os dois ausentes (ou vazios) valem hoje, um dia; professionalId all e includeCancelled false', () => {
    for (const q of [{}, { from: '', to: '' }, undefined, null, 'x']) {
      const r = v(q);
      assert.equal(r.ok, true);
      assert.deepEqual(r.value, { from: TODAY, to: TODAY, dates: [TODAY], professionalId: 'all', includeCancelled: false });
    }
  });

  test('só um dos dois: 400 no outro', () => {
    assert.deepEqual(v({ from: TODAY }).fields, { to: M.datePairRequired });
    assert.deepEqual(v({ to: TODAY }).fields, { from: M.datePairRequired });
  });

  test('8 dias, from > to, datas inválidas e texto longo', () => {
    assert.deepEqual(v({ from: '2026-11-23', to: '2026-11-30' }).fields, { to: M.rangeInvalid });
    assert.deepEqual(v({ from: '2026-11-27', to: '2026-11-26' }).fields, { to: M.rangeInvalid });
    assert.deepEqual(v({ from: '2026-02-30', to: '2026-02-30' }).fields, { from: M.dateInvalid, to: M.dateInvalid });
    assert.deepEqual(v({ from: '2026-13-01', to: TODAY }).fields, { from: M.dateInvalid });
    assert.deepEqual(v({ from: 'x'.repeat(10_240), to: TODAY }).fields, { from: M.dateInvalid });
    assert.deepEqual(v({ from: [TODAY, TODAY], to: TODAY }).fields, { from: M.dateInvalid });
  });

  test('janela hoje − 366 aceita e − 367 recusada; + 400 aceita e + 401 recusada', () => {
    const d = (n) => addLocalDays(TODAY, n);
    assert.equal(v({ from: d(-366), to: d(-366) }).ok, true);
    assert.deepEqual(v({ from: d(-367), to: d(-367) }).fields, { from: M.outOfWindow, to: M.outOfWindow });
    assert.equal(v({ from: d(400), to: d(400) }).ok, true);
    assert.deepEqual(v({ from: d(394), to: d(401) }).fields, { to: M.rangeInvalid });
    assert.deepEqual(v({ from: d(395), to: d(401) }).fields, { to: M.outOfWindow });
  });

  test('professionalId: uuid e all aceitos; malformado, ALL, maiúsculas e array dão 400', () => {
    assert.equal(v({ professionalId: P }).value.professionalId, P);
    assert.equal(v({ professionalId: 'all' }).value.professionalId, 'all');
    assert.equal(v({ professionalId: '' }).value.professionalId, 'all');
    for (const bad of ['ALL', 'x', P.toUpperCase(), `${P}0`, [P], 'any']) {
      assert.deepEqual(v({ professionalId: bad }).fields, { professionalId: M.professionalInvalid }, String(bad));
    }
  });

  test('includeCancelled: só true/false', () => {
    assert.equal(v({ includeCancelled: 'true' }).value.includeCancelled, true);
    assert.equal(v({ includeCancelled: 'false' }).value.includeCancelled, false);
    for (const bad of ['1', 'TRUE', '', 'yes', ['true']]) {
      assert.deepEqual(v({ includeCancelled: bad }).fields, { includeCancelled: M.includeCancelledInvalid }, String(bad));
    }
  });

  test('mensagens nunca ecoam a entrada (marcador único); outras chaves ignoradas', () => {
    const marker = 'ZZmarcadorZZ';
    const r = v({ from: marker, to: `${marker}2`, professionalId: marker, includeCancelled: marker, businessId: P });
    assert.equal(r.ok, false);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(marker));
    assert.equal(Object.values(M).every((m) => typeof m === 'string' && !m.includes('${')), true);
  });
});

describe('dia da semana e semana ISO (critério 35, C-3)', () => {
  test('isoWeekdayOfDate igual ao isoWeekdayOf do motor em 2000..2099 (de 13 em 13 dias) e nos limites', () => {
    let d = '2000-01-01';
    let n = 0;
    while (d && d <= '2099-12-31') {
      assert.equal(isoWeekdayOfDate(d), isoWeekdayOf(d), d);
      d = addLocalDays(d, 13);
      n += 1;
    }
    assert.ok(n > 2800);
    for (const x of ['2000-01-01', '2099-12-31', '2024-02-29', '2026-11-26']) assert.equal(isoWeekdayOfDate(x), isoWeekdayOf(x));
    assert.equal(isoWeekdayOfDate('2026-11-26'), 4);
    assert.equal(isoWeekdayOfDate('2026-11-29'), 7);
    for (const bad of ['2026-02-30', '', null, 20261126]) assert.equal(isoWeekdayOfDate(bad), 0);
  });

  test('startOfIsoWeek: segunda-feira; virada de mês e de ano; 2000-01-01 (sábado) e 2099-12-31', () => {
    assert.equal(startOfIsoWeek('2026-11-26'), '2026-11-23');
    assert.equal(startOfIsoWeek('2026-11-23'), '2026-11-23');
    assert.equal(startOfIsoWeek('2026-11-29'), '2026-11-23');
    assert.equal(startOfIsoWeek('2026-12-02'), '2026-11-30');
    assert.equal(startOfIsoWeek('2027-01-01'), '2026-12-28');
    assert.equal(startOfIsoWeek('2000-01-01'), '1999-12-27');
    assert.equal(startOfIsoWeek('2099-12-31'), '2099-12-28');
    assert.equal(startOfIsoWeek('x'), '');
  });
});

describe('status e mapa fixo (critérios 8, 31 e 36)', () => {
  test('AGENDA_STATUSES = APPOINTMENT_STATUSES; todo status tem entrada no mapa; rótulos e ícones distintos', () => {
    assert.deepEqual([...AGENDA_STATUSES], [...APPOINTMENT_STATUSES]);
    for (const s of AGENDA_STATUSES) assert.ok(AGENDA_STATUS_DISPLAY[s], s);
    const entries = Object.values(AGENDA_STATUS_DISPLAY);
    assert.equal(new Set(entries.map((e) => e.label)).size, entries.length);
    assert.equal(new Set(entries.map((e) => e.icon)).size, entries.length);
    assert.equal(new Set(entries.map((e) => e.className)).size, entries.length);
    for (const e of entries) assert.match(e.className, /^ag-status-[a-z-]+$/);
    assert.deepEqual(Object.keys(CANCELLED_BY_LABELS).sort(), [...CANCELLED_BY].sort());
    assert.equal(AGENDA_ITEMS_MAX, 1000);
  });

  test('CANCELLED_BY = CHECK da 014 (lido do sqlite_master)', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    await runMigrations(db);
    const { sql } = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appointments'");
    await db.close();
    const m = /cancelled_by IN \(([^)]*)\)/.exec(sql);
    assert.ok(m);
    assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...CANCELLED_BY]);
  });

  test('displayKeyOf: todos os status, remarcado, bloqueio, desconhecido, vazio e null', () => {
    for (const s of AGENDA_STATUSES) assert.equal(displayKeyOf({ type: 'appointment', status: s, cancelled: null }), s);
    assert.equal(displayKeyOf({ status: 'cancelled', cancelled: { by: 'reschedule', at: null } }), 'rescheduled');
    assert.equal(displayKeyOf({ status: 'cancelled', cancelled: { by: 'owner', at: null } }), 'cancelled');
    assert.equal(displayKeyOf({ status: 'cancelled', cancelled: null }), 'cancelled');
    assert.equal(displayKeyOf({ type: 'block' }), 'block');
    for (const bad of [{ status: 'pending' }, { status: '__proto__' }, { status: 'constructor' }, {}, null, undefined, 'confirmed', []]) {
      assert.equal(displayKeyOf(bad), 'unknown', JSON.stringify(bad));
    }
  });
});
