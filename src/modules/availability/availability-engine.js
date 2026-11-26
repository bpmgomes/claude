// Motor de disponibilidade (design AF-10, 4.3). Puro: sem I/O, sem relógio e sem banco. Recebe a
// grade (hora local, sem data), os bloqueios e os agendamentos (instantes), e devolve os inícios
// livres por data local do negócio. Base do AF-21, reaproveitado pelo AF-11 e pelo AF-15.
// Todos os intervalos são semiabertos [início, fim).
import {
  parseLocalDate,
  parseLocalDateTime,
  addLocalDays,
  wallMinutes,
  localToInstant,
  instantToLocal,
  formatLocalDateTime,
} from '../../shared/zoned-time.js';
import { SLOT_STEP_MINUTES, AVAILABILITY_SLOTS_PER_DAY_MAX } from '../../shared/availability.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY_END_MINUTE = 1440;

/**
 * @typedef {{ weekday: number, startMinute: number, endMinute: number }} WorkingInterval   // AF-08
 * @typedef {{ startMs: number, endMs: number }} Interval                                    // semiaberto
 * @typedef {{
 *   id: string,
 *   weekly: WorkingInterval[],        // grade do profissional (hora local, sem data)
 *   blocks: Interval[],               // bloqueios aplicáveis (os dele + os de "todos"), em qualquer ordem
 *   appointments: Interval[],         // ocupados não cancelados (porta), em qualquer ordem
 * }} EngineProfessional
 * @typedef {{
 *   timeZone: string,                 // business.timezone (IANA)
 *   fromDate: string, toDate: string, // 'YYYY-MM-DD', inclusive, já validados
 *   durationMinutes: number,          // 15..480 (AF-06)
 *   stepMinutes?: number,             // padrão SLOT_STEP_MINUTES
 *   notBeforeMs: number,              // início mínimo (agora + 60 min); o AF-15 pode passar `agora`
 *   professionals: EngineProfessional[],  // na ordem em que os ids devem sair
 *   slotsPerDayMax?: number,          // padrão AVAILABILITY_SLOTS_PER_DAY_MAX (os testes reduzem)
 * }} EngineInput
 * @typedef {{ startMs: number, endMs: number, start: string, end: string, professionalIds: string[] }} EngineSlot
 * @typedef {{ date: string, weekday: number, slots: EngineSlot[] }} EngineDay
 * @typedef {{ startMs: number, endMs: number, regular: boolean, offsetMs: number }} DayFrame
 */

/** 'YYYY-MM-DD' -> 1 (segunda) .. 7 (domingo), por Date.UTC (sem fuso). NaN para data inválida. */
export function isoWeekdayOf(date) {
  const parsed = parseLocalDate(date);
  if (!parsed.ok) return Number.NaN;
  const { year, month, day } = parsed.value;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

const isInterval = (i) =>
  i !== null && typeof i === 'object' && Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs;

/**
 * Ordena e funde intervalos sobrepostos e encostados. Descarta `endMs <= startMs` e NaN.
 * Não altera a entrada.
 * @param {Interval[]} intervals
 * @returns {Interval[]}
 */
export function unionIntervals(intervals) {
  const valid = (Array.isArray(intervals) ? intervals : [])
    .filter(isInterval)
    .map((i) => ({ startMs: i.startMs, endMs: i.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const interval of valid) {
    const last = out[out.length - 1];
    if (last && interval.startMs <= last.endMs) {
      if (interval.endMs > last.endMs) last.endMs = interval.endMs;
    } else out.push(interval);
  }
  return out;
}

/** Índice do primeiro ocupado com fim depois de `ms` (lista unida e ordenada). */
function firstEndingAfter(busy, ms) {
  let lo = 0;
  let hi = busy.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (busy[mid].endMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * windows − união(busy). As duas listas já unidas (unionIntervals). Semiabertos: um ocupado
 * [10:00, 11:00) deixa livre [..., 10:00) e [11:00, ...).
 * @param {Interval[]} windows
 * @param {Interval[]} busy
 * @returns {Interval[]}
 */
export function subtractIntervals(windows, busy) {
  const out = [];
  for (const w of windows) {
    let cursor = w.startMs;
    for (let k = firstEndingAfter(busy, w.startMs); k < busy.length && busy[k].startMs < w.endMs; k++) {
      const b = busy[k];
      if (b.startMs > cursor) out.push({ startMs: cursor, endMs: b.startMs });
      if (b.endMs > cursor) cursor = b.endMs;
      if (cursor >= w.endMs) break;
    }
    if (cursor < w.endMs) out.push({ startMs: cursor, endMs: w.endMs });
  }
  return out;
}

/**
 * Moldura do dia local: [00:00 de d, 00:00 de d + 1). `regular` quando tem 24 h, o que pela
 * premissa do zoned-time (no máximo uma transição em 48 h) significa offset constante no dia.
 * @param {string} date
 * @param {string} timeZone
 * @returns {DayFrame}
 */
export function dayFrameOf(date, timeZone) {
  const day = parseLocalDate(date).value;
  const next = parseLocalDate(addLocalDays(date, 1)).value;
  const startMs = localToInstant({ ...day, hour: 0, minute: 0 }, timeZone).ms;
  const endMs = localToInstant({ ...next, hour: 0, minute: 0 }, timeZone).ms;
  const regular = endMs - startMs === DAY_MS;
  const offsetMs = wallMinutes(day) * MINUTE_MS - startMs;
  return { startMs, endMs, regular, offsetMs };
}

/** Instante de `minute` (0..1440) da data local. 1440 = 00:00 do dia seguinte (critério 15). */
function instantOf(date, minute, timeZone, frame, cache) {
  if (minute === DAY_END_MINUTE) return frame.endMs;
  if (frame.regular) return frame.startMs + minute * MINUTE_MS;
  let ms = cache.get(minute);
  if (ms === undefined) {
    const day = parseLocalDate(date).value;
    ms = localToInstant({ ...day, hour: Math.trunc(minute / 60), minute: minute % 60 }, timeZone).ms;
    cache.set(minute, ms);
  }
  return ms;
}

/**
 * Janelas de trabalho do dia em instantes, unidas só dentro do dia. Intervalo convertido com fim
 * UTC não posterior ao início é descartado (nota 4.2 do AF-16): no salto do horário de verão,
 * 02:45–03:00 vira 07:45Z–07:00Z e 02:00–03:00 vira 07:00Z–07:00Z.
 * @param {WorkingInterval[]} weekly
 * @param {string} date
 * @param {string} timeZone
 * @param {DayFrame} [dayFrame]
 * @param {Map<number, number>} [cache] minuto -> instante (dia irregular)
 * @returns {Interval[]}
 */
export function workWindowsForDay(weekly, date, timeZone, dayFrame = dayFrameOf(date, timeZone), cache = new Map()) {
  const weekday = isoWeekdayOf(date);
  const intervals = [];
  for (const w of Array.isArray(weekly) ? weekly : []) {
    if (!w || w.weekday !== weekday) continue;
    const startMs = instantOf(date, w.startMinute, timeZone, dayFrame, cache);
    const endMs = instantOf(date, w.endMinute, timeZone, dayFrame, cache);
    if (endMs > startMs) intervals.push({ startMs, endMs });
  }
  return unionIntervals(intervals);
}

/** Rótulo local por aritmética (dia regular, `ms` dentro da moldura): getters UTC, sem Intl. */
function arithmeticLabel(ms, offsetMs) {
  const d = new Date(ms + offsetMs);
  return formatLocalDateTime({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  });
}

function labelOf(ms, timeZone, frame) {
  if (frame.regular && ms >= frame.startMs && ms < frame.endMs) return arithmeticLabel(ms, frame.offsetMs);
  return instantToLocal(ms, timeZone);
}

/** Início com ida e volta exata pelo localToInstant (dobra: só a primeira ocorrência). */
function roundTrips(label, ms, timeZone) {
  const parsed = parseLocalDateTime(label);
  return parsed.ok && localToInstant(parsed.value, timeZone).ms === ms;
}

/** Datas de `fromDate` a `toDate`, inclusive. */
function datesOf(fromDate, toDate) {
  const dates = [];
  for (let date = fromDate; date && date <= toDate; date = addLocalDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * Inícios livres por data local. Cada data é processada de forma independente.
 * @param {EngineInput} input
 * @returns {{ days: EngineDay[], truncated: boolean }}
 */
export function computeAvailability(input) {
  const {
    timeZone,
    fromDate,
    toDate,
    durationMinutes,
    stepMinutes = SLOT_STEP_MINUTES,
    notBeforeMs,
    professionals = [],
    slotsPerDayMax = AVAILABILITY_SLOTS_PER_DAY_MAX,
  } = input;
  const durationMs = durationMinutes * MINUTE_MS;
  const stepMs = stepMinutes * MINUTE_MS;
  const minStart = Number.isFinite(notBeforeMs) ? notBeforeMs : Number.NEGATIVE_INFINITY;

  // Passo 4: ocupado por profissional, uma vez para o período todo.
  const prepared = professionals.map((p) => ({
    id: p.id,
    weekly: p.weekly,
    busy: unionIntervals([...(p.blocks || []), ...(p.appointments || [])]),
  }));

  let truncated = false;
  const days = datesOf(fromDate, toDate).map((date) => {
    const weekday = isoWeekdayOf(date);
    const frame = dayFrameOf(date, timeZone);
    const cache = new Map();
    /** @type {Map<number, string[]>} */
    const byStart = new Map();

    for (const p of prepared) {
      const windows = workWindowsForDay(p.weekly, date, timeZone, frame, cache);
      for (const w of windows) {
        for (const free of subtractIntervals([w], p.busy)) {
          const lower = Math.max(free.startMs, minStart);
          const k0 = Math.max(0, Math.ceil((lower - w.startMs) / stepMs));
          for (let s = w.startMs + k0 * stepMs; s + durationMs <= free.endMs; s += stepMs) {
            const ids = byStart.get(s);
            if (ids) {
              if (ids[ids.length - 1] !== p.id) ids.push(p.id);
            } else byStart.set(s, [p.id]);
          }
        }
      }
    }

    const slots = [];
    for (const startMs of [...byStart.keys()].sort((a, b) => a - b)) {
      const start = labelOf(startMs, timeZone, frame);
      // Passo 8 (dobra): em dia irregular, só o início com rótulo de ida e volta exata.
      if (!frame.regular && !roundTrips(start, startMs, timeZone)) continue;
      if (slots.length >= slotsPerDayMax) {
        truncated = true;
        break;
      }
      const endMs = startMs + durationMs;
      slots.push({ startMs, endMs, start, end: labelOf(endMs, timeZone, frame), professionalIds: byStart.get(startMs) });
    }
    return { date, weekday, slots };
  });

  return { days, truncated };
}
