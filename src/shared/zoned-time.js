// Conversão entre hora local de um fuso IANA e instantes UTC (design AF-16, 4.2). Compartilhado
// entre backend e browser (/shared/zoned-time.js). Módulo puro, sem imports: usa só
// Intl.DateTimeFormat e Date.UTC. Nunca usa o fuso do processo nem do navegador (sem Date local,
// sem getTimezoneOffset). É o contrato de fuso do AF-10 (4.5).

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const YEAR_MIN = 2000;
const YEAR_MAX = 2099;
const DATE_LENGTH = 10;
const DATE_TIME_LENGTH = 16;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Só roda o regex sobre texto de comprimento exato (10). */
function parseDateParts(text) {
  if (!DATE_RE.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (year < YEAR_MIN || year > YEAR_MAX) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/**
 * 'YYYY-MM-DDTHH:MM' (16 caracteres, ano 2000..2099, data de calendário válida, hora 00..23).
 * Sem regex sobre texto longo: o comprimento é conferido antes.
 * @param {unknown} raw
 * @returns {{ ok: true, value: { year: number, month: number, day: number, hour: number, minute: number } }
 *         | { ok: false, reason: 'format' }}
 */
export function parseLocalDateTime(raw) {
  if (typeof raw !== 'string' || raw.length !== DATE_TIME_LENGTH || raw[10] !== 'T') return { ok: false, reason: 'format' };
  const date = parseDateParts(raw.slice(0, DATE_LENGTH));
  const time = raw.slice(11);
  if (!date || !TIME_RE.test(time)) return { ok: false, reason: 'format' };
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  if (hour > 23 || minute > 59) return { ok: false, reason: 'format' };
  return { ok: true, value: { ...date, hour, minute } };
}

/**
 * 'YYYY-MM-DD' (10 caracteres), mesmas faixas de parseLocalDateTime.
 * @param {unknown} raw
 * @returns {{ ok: true, value: { year: number, month: number, day: number } } | { ok: false, reason: 'format' }}
 */
export function parseLocalDate(raw) {
  if (typeof raw !== 'string' || raw.length !== DATE_LENGTH) return { ok: false, reason: 'format' };
  const date = parseDateParts(raw);
  return date ? { ok: true, value: date } : { ok: false, reason: 'format' };
}

/**
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} v
 * @returns {string} 'YYYY-MM-DDTHH:MM'
 */
export function formatLocalDateTime(v) {
  return `${String(v.year).padStart(4, '0')}-${pad2(v.month)}-${pad2(v.day)}T${pad2(v.hour)}:${pad2(v.minute)}`;
}

/**
 * Aritmética de calendário pura (Date.UTC), sem fuso. 'YYYY-MM-DD' + n dias.
 * Data inválida devolve '' (quem chama valida depois).
 * @param {string} date
 * @param {number} n
 * @returns {string}
 */
export function addLocalDays(date, n) {
  const parsed = parseLocalDate(date);
  if (!parsed.ok || !Number.isInteger(n)) return '';
  const { year, month, day } = parsed.value;
  const d = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Minutos "de parede" desde 1970-01-01T00:00, sem fuso: serve para comparar e medir durações locais.
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} v
 * @returns {number}
 */
export function wallMinutes(v) {
  return Date.UTC(v.year, v.month - 1, v.day, v.hour || 0, v.minute || 0) / MINUTE_MS;
}

/** Instante -> ISO UTC. Fora daqui, src/shared/ e web/ não usam Date (AF-23, lint). */
export const instantToIso = (ms) => new Date(ms).toISOString();

/** ISO -> instante (NaN se inválido). */
export const isoToInstant = (iso) => Date.parse(iso);

/** Um formatador por fuso (criar Intl.DateTimeFormat é caro). */
const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Hora de parede de `ms` no fuso, como números. */
function wallParts(ms, timeZone) {
  const out = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  // Alguns motores antigos devolvem 24 para meia-noite mesmo com h23.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** Offset do fuso em `ms` (hora de parede lida como UTC − instante), em ms. */
function offsetAt(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Os milissegundos não entram na hora de parede: compara no mesmo segundo.
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Instante -> hora local no fuso ('YYYY-MM-DDTHH:MM'). Segundos ignorados (sempre 0 aqui).
 * @param {number} ms
 * @param {string} timeZone IANA
 * @returns {string}
 */
export function instantToLocal(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  return formatLocalDateTime({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute });
}

/**
 * Hora local no fuso IANA -> instante. Determinístico (regra 'compatible' do Temporal/java.time):
 *  - existe uma vez: esse instante.                                       adjusted: 'none'
 *  - ambígua (volta do horário de verão): a PRIMEIRA ocorrência.          adjusted: 'fold'
 *  - inexistente (salto): avança pelo tamanho do salto (02:30 -> 03:30).  adjusted: 'gap'
 * Premissa: no máximo uma transição de offset em 48 h (vale para os fusos IANA de 2000 a 2099).
 * Atenção: dentro de um salto a regra não é monótona (02:45 vira 03:45, depois de 03:00); quem
 * compara início e fim deve comparar também os instantes (validateTimeBlockInput faz isso).
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} v
 * @param {string} timeZone IANA
 * @returns {{ ms: number, adjusted: 'none' | 'fold' | 'gap' }}
 */
export function localToInstant(v, timeZone) {
  const target = formatLocalDateTime(v);
  const naive = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute);
  const before = offsetAt(naive - DAY_MS, timeZone);
  const after = offsetAt(naive + DAY_MS, timeZone);
  const offsets = before === after ? [before] : [before, after];
  const valid = offsets.map((o) => naive - o).filter((t) => instantToLocal(t, timeZone) === target);
  if (valid.length >= 2) return { ms: Math.min(...valid), adjusted: 'fold' };
  if (valid.length === 1) return { ms: valid[0], adjusted: 'none' };
  return { ms: naive - before, adjusted: 'gap' };
}
