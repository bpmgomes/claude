// Formatação de datas e horários dos e-mails (AF-18, design 4.2). Módulo puro: só hora local do
// negócio, por `instantToLocal` (src/shared/zoned-time.js) e tabelas fixas em pt-BR. Nada de `Intl`
// com locale do servidor nem de `Date` local: o resultado é o mesmo com qualquer `TZ` do processo.
import { instantToLocal } from '../../shared/zoned-time.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { isoWeekdayOf } from '../availability/availability-engine.js';

/** ISO 8601: 1 = segunda ... 7 = domingo. */
export const WEEKDAYS_LONG = Object.freeze([
  '',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
  'domingo',
]);
export const WEEKDAYS_SHORT = Object.freeze(['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']);

/**
 * Partes locais de um instante no fuso do negócio.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {{ date: string, time: string, ddmm: string, ddmmyyyy: string, weekdayLong: string, weekdayShort: string }}
 */
export function localParts(ms, timeZone) {
  const local = instantToLocal(ms, timeZone || DEFAULT_TIME_ZONE);
  const date = local.slice(0, 10);
  const [year, month, day] = date.split('-');
  const weekday = isoWeekdayOf(date);
  return {
    date,
    time: local.slice(11, 16),
    ddmm: `${day}/${month}`,
    ddmmyyyy: `${day}/${month}/${year}`,
    weekdayLong: WEEKDAYS_LONG[weekday] ?? '',
    weekdayShort: WEEKDAYS_SHORT[weekday] ?? '',
  };
}

/** "sexta-feira, 27/11/2026, das 10:00 às 11:00" */
export function formatWhen(startMs, endMs, timeZone) {
  const s = localParts(startMs, timeZone);
  const e = localParts(endMs, timeZone);
  return `${s.weekdayLong}, ${s.ddmmyyyy}, das ${s.time} às ${e.time}`;
}

/** "sex, 27/11 às 08:00" */
export function formatShortWhen(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.weekdayShort}, ${p.ddmm} às ${p.time}`;
}

/** "sexta-feira, 27/11/2026, às 10:00" (AF-03, aviso de troca de senha). */
export function formatInstant(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.weekdayLong}, ${p.ddmmyyyy}, às ${p.time}`;
}
