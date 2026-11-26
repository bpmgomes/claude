// Helpers dos testes de disponibilidade (AF-10 e AF-21). Sem banco.
import assert from 'node:assert/strict';
import { noAppointments } from '../../src/modules/appointments/appointments-port.js';
import { computeAvailability, dayFrameOf } from '../../src/modules/availability/availability-engine.js';
import { parseLocalDateTime, localToInstant, instantToLocal } from '../../src/shared/zoned-time.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 'HH:MM' -> minutos (24:00 = 1440). */
function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Grade compacta -> WorkingInterval[]: `{ 1: [['09:00', '12:00'], ['13:00', '18:00']] }`.
 * @param {Record<number, Array<[string, string]>>} days
 */
export function weekly(days) {
  const out = [];
  for (const [weekday, intervals] of Object.entries(days)) {
    for (const [start, end] of intervals) {
      out.push({ weekday: Number(weekday), startMinute: minutesOf(start), endMinute: minutesOf(end) });
    }
  }
  return out;
}

/** Segunda a sexta 09:00–12:00 e 13:00–18:00 (igual a WEEK_9_TO_18 da API). */
export const WEEKDAYS_9_TO_18 = weekly(
  Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [['09:00', '12:00'], ['13:00', '18:00']]])),
);

/** Intervalo em ms a partir de dois ISO UTC. */
export function interval(isoStart, isoEnd) {
  return { startMs: Date.parse(isoStart), endMs: Date.parse(isoEnd) };
}

/**
 * Porta de agendamentos falsa (`findBusyByBusiness`), com o resto da porta nula.
 * @param {{ busy?: Record<string, Array<{ startsAt: string, endsAt: string }>>, throws?: Error, result?: unknown }} [options]
 *   `result` substitui o Map devolvido (para testar retorno malformado)
 */
export function fakeAppointments({ busy = {}, throws, result } = {}) {
  const calls = [];
  return {
    ...noAppointments,
    calls,
    async findBusyByBusiness(businessId, filter, fromIso, toIso) {
      calls.push({ businessId, filter, fromIso, toIso });
      if (throws) throw throws;
      if (result !== undefined) return result;
      const map = new Map();
      for (const [id, list] of Object.entries(busy)) {
        if (filter.professionalId === null || filter.professionalId === id) map.set(id, list);
      }
      return map;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// AF-21 (design 3.1): helpers genéricos dos testes de borda do motor. Sem relógio e sem TZ do processo.

/** Grade igual em todos os dias da semana (1..7): everyDay([['00:00', '24:00']]). */
export function everyDay(intervals) {
  return weekly(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, intervals])));
}

/** 'HH:MM' de `from` a `to`, inclusive, de `step` em `step` minutos (padrão 15). */
export function clockRange(from, to, step = 15) {
  const out = [];
  for (let m = minutesOf(from); m <= minutesOf(to); m += step) {
    out.push(`${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

/** Instante de uma hora local 'YYYY-MM-DDTHH:MM' no fuso, por localToInstant (falha o teste se o texto for inválido). */
export function localMs(local, timeZone) {
  const parsed = parseLocalDateTime(local);
  assert.ok(parsed.ok, `hora local inválida: ${local}`);
  return localToInstant(parsed.value, timeZone).ms;
}

/** { startMs, endMs } de duas horas locais no fuso (mesma regra de localMs). */
export function localInterval(start, end, timeZone) {
  return { startMs: localMs(start, timeZone), endMs: localMs(end, timeZone) };
}

/** computeAvailability com padrões de teste: um profissional 'A', 60 min, sem antecedência. */
export function runEngine({
  timeZone,
  fromDate,
  toDate = fromDate,
  grade,
  blocks = [],
  appointments = [],
  durationMinutes = 60,
  notBeforeMs = Number.NEGATIVE_INFINITY,
  professionals,
  ...rest
}) {
  assert.ok(timeZone && fromDate, 'runEngine: timeZone e fromDate são obrigatórios');
  return computeAvailability({
    timeZone,
    fromDate,
    toDate,
    durationMinutes,
    notBeforeMs,
    professionals: professionals || [{ id: 'A', weekly: grade, blocks, appointments }],
    ...rest,
  });
}

/** Rótulos 'HH:MM' dos inícios de `date` (ou do primeiro dia). */
export function slotTimes(result, date) {
  const day = date ? result.days.find((d) => d.date === date) : result.days[0];
  assert.ok(day, `dia ausente no resultado: ${date}`);
  return day.slots.map((s) => s.start.slice(11));
}

const offsetFormatters = new Map();

/** Offset UTC do fuso em `ms`, em minutos, lido pelo Intl ('longOffset'), sem passar pelo zoned-time. */
export function utcOffsetMinutes(ms, timeZone) {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormatters.set(timeZone, formatter);
  }
  const name = formatter.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  if (name === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  assert.ok(match, `offset inesperado do Intl: ${name} (${timeZone})`);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Pré-condição dos dias de transição (critérios 27 e 29): o Intl do Node mostra offsets diferentes
 * em T − 24 h e T + 24 h (T = meio-dia UTC de `date`), a duração derivada desses offsets é `hours`,
 * e dayFrameOf(date).regular é false com a mesma duração. Mensagem explícita com data, fuso e
 * process.versions.tz quando falha.
 */
export function assertTransitionDay(date, timeZone, hours) {
  const where = `${timeZone} ${date} (tzdata ${process.versions.tz}, ICU ${process.versions.icu})`;
  const noon = Date.parse(`${date}T12:00:00.000Z`);
  const before = utcOffsetMinutes(noon - DAY_MS, timeZone);
  const after = utcOffsetMinutes(noon + DAY_MS, timeZone);
  assert.notEqual(before, after, `pré-condição: ${where} não tem transição de offset pelo Intl (${before} = ${after})`);
  const intlHours = 24 - (after - before) / 60;
  assert.equal(intlHours, hours, `pré-condição: ${where} dura ${intlHours} h pelo Intl, esperado ${hours} h`);
  const frame = dayFrameOf(date, timeZone);
  assert.equal(frame.regular, false, `pré-condição: ${where} é regular para dayFrameOf`);
  assert.equal((frame.endMs - frame.startMs) / HOUR_MS, hours, `pré-condição: ${where} não dura ${hours} h em dayFrameOf`);
}

/** Ida e volta exata do início: localToInstant(start) === startMs e instantToLocal(startMs) === start. */
export function assertStartRoundTrips(slot, timeZone) {
  const parsed = parseLocalDateTime(slot.start);
  assert.ok(parsed.ok, `rótulo inválido: ${slot.start}`);
  assert.equal(localToInstant(parsed.value, timeZone).ms, slot.startMs, `ida: ${timeZone} ${slot.start}`);
  assert.equal(instantToLocal(slot.startMs, timeZone), slot.start, `volta: ${timeZone} ${slot.start}`);
}
