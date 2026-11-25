// Regras da grade semanal de horários compartilhadas entre backend e browser
// (/shared/working-hours.js). Módulo puro: só importa ./professionals.js (também puro).
// Horários são hora local do negócio em minutos inteiros desde 00:00, sem Date e sem fuso.
import { PROFESSIONAL_MESSAGES } from './professionals.js';

/** Dias ISO 8601 (1 = segunda ... 7 = domingo), na ordem da resposta. */
export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const WEEKDAY_LABELS = Object.freeze({
  1: 'Segunda',
  2: 'Terça',
  3: 'Quarta',
  4: 'Quinta',
  5: 'Sexta',
  6: 'Sábado',
  7: 'Domingo',
});
export const TIME_STEP_MINUTES = 15;
/** '24:00' */
export const DAY_END_MINUTE = 1440;
export const INTERVALS_PER_DAY_MAX = 6;
export const INTERVALS_PER_PROFESSIONAL_MAX = 42;

/** Mensagens fixas: a única interpolação é a posição `k` (1..6), calculada aqui (critério 11). */
export const HOURS_MESSAGES = Object.freeze({
  checkFields: 'Verifique os horários destacados.',
  nothingToUpdate: 'Nada para atualizar.',
  daysInvalid: 'Envie de 1 a 7 dias.',
  weekdayInvalid: 'Dia da semana inválido.',
  weekdayRepeated: 'Este dia foi enviado mais de uma vez.',
  intervalsInvalid: 'Informe os intervalos do dia.',
  intervalsTooMany: 'Cadastre no máximo 6 intervalos por dia.',
  timeInvalid: 'Use o formato HH:MM, de 00:00 a 24:00.',
  timeStep: 'Use minutos 00, 15, 30 ou 45.',
  endBeforeStart: 'O fim deve ser depois do início.',
  overlap: (k) => `Este intervalo se sobrepõe ao intervalo ${Number.isInteger(k) ? k : ''}.`,
  professionalTooMany: 'Cadastre no máximo 42 intervalos por profissional.',
  businessRequired: 'Cadastre seu negócio antes de cadastrar horários.',
  notFound: PROFESSIONAL_MESSAGES.notFound,
  appointmentsOutside: 'Há agendamentos futuros fora do novo horário. Eles continuam marcados.',
});

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIME_LENGTH = 5;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 'HH:MM' -> minutos. Aceita 00:00..23:59 e '24:00'. Só string de 5 caracteres
 * (o regex nunca roda sobre texto longo).
 * @param {unknown} raw
 * @returns {{ ok: true, minutes: number } | { ok: false, reason: 'format' | 'step' }}
 */
export function parseTime(raw) {
  if (typeof raw !== 'string' || raw.length !== TIME_LENGTH) return { ok: false, reason: 'format' };
  if (raw === '24:00') return { ok: true, minutes: DAY_END_MINUTE };
  if (!TIME_RE.test(raw)) return { ok: false, reason: 'format' };
  const minutes = Number(raw.slice(0, 2)) * 60 + Number(raw.slice(3, 5));
  if (minutes % TIME_STEP_MINUTES !== 0) return { ok: false, reason: 'step' };
  return { ok: true, minutes };
}

/**
 * 0..1440 -> 'HH:MM' (1440 -> '24:00').
 * @param {number} minutes
 * @returns {string}
 */
export function formatTime(minutes) {
  const value = Math.trunc(Number(minutes) || 0);
  const h = Math.trunc(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeMessage(reason) {
  return reason === 'step' ? HOURS_MESSAGES.timeStep : HOURS_MESSAGES.timeInvalid;
}

/**
 * Valida um dia: formato, passo, início < fim e sobreposição. Grava os erros em `fields`.
 * @returns {Array<{ startMinute: number, endMinute: number }>|null} intervalos ordenados ou null com erro
 */
function validateDay(weekday, intervals, fields) {
  const prefix = `days.${weekday}`;
  if (!Array.isArray(intervals)) {
    fields[prefix] = HOURS_MESSAGES.intervalsInvalid;
    return null;
  }
  // Para no limite de tamanho antes de iterar os itens.
  if (intervals.length > INTERVALS_PER_DAY_MAX) {
    fields[prefix] = HOURS_MESSAGES.intervalsTooMany;
    return null;
  }

  let failed = false;
  const valid = [];
  for (let n = 0; n < intervals.length; n++) {
    const item = isObject(intervals[n]) ? intervals[n] : {};
    const key = `${prefix}.intervals.${n}`;
    const start = parseTime(item.start);
    const end = parseTime(item.end);
    if (!start.ok) fields[`${key}.start`] = timeMessage(start.reason);
    if (!end.ok) fields[`${key}.end`] = timeMessage(end.reason);
    if (!start.ok || !end.ok) {
      failed = true;
      continue;
    }
    if (start.minutes >= end.minutes) {
      fields[`${key}.end`] = HOURS_MESSAGES.endBeforeStart;
      failed = true;
      continue;
    }
    valid.push({ position: n, startMinute: start.minutes, endMinute: end.minutes });
  }

  // Sobreposição: ordena por início e compara com o intervalo de maior fim visto até agora
  // (detecta também um intervalo longo que cobre vários). Só se tocar (a.end === b.start) é aceito.
  const sorted = [...valid].sort((a, b) => a.startMinute - b.startMinute || a.position - b.position);
  let reach = null;
  for (const current of sorted) {
    if (reach && reach.endMinute > current.startMinute) {
      const a = `${prefix}.intervals.${reach.position}`;
      const b = `${prefix}.intervals.${current.position}`;
      if (!fields[a]) fields[a] = HOURS_MESSAGES.overlap(current.position + 1);
      if (!fields[b]) fields[b] = HOURS_MESSAGES.overlap(reach.position + 1);
      failed = true;
    }
    if (!reach || current.endMinute > reach.endMinute) reach = current;
  }

  if (failed) return null;
  return sorted.map(({ startMinute, endMinute }) => ({ startMinute, endMinute }));
}

/**
 * Valida o corpo do PUT `{ days: [{ weekday, intervals: [{ start, end }] }] }`. Junta os erros
 * de todos os dias. Para no primeiro limite de tamanho (days > 7, intervals > 6) sem iterar o resto.
 * Outros campos (businessId, professionalId...) são ignorados.
 * @param {unknown} input
 * @returns {{ ok: true, value: Array<{ weekday: number, intervals: Array<{ startMinute: number, endMinute: number }> }> }
 *         | { ok: false, fields: Record<string, string>, message?: string }}
 */
export function validateHoursInput(input) {
  const src = isObject(input) ? input : {};
  const { days } = src;
  if (days === undefined || (Array.isArray(days) && days.length === 0)) {
    return { ok: false, fields: {}, message: HOURS_MESSAGES.nothingToUpdate };
  }
  if (!Array.isArray(days) || days.length > WEEKDAYS.length) {
    return { ok: false, fields: { days: HOURS_MESSAGES.daysInvalid } };
  }

  const fields = {};
  const seen = new Set();
  const value = [];
  for (let i = 0; i < days.length; i++) {
    const day = isObject(days[i]) ? days[i] : {};
    const { weekday } = day;
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      fields[`days.${i}`] = HOURS_MESSAGES.weekdayInvalid;
      continue;
    }
    if (seen.has(weekday)) {
      fields[`days.${weekday}`] = HOURS_MESSAGES.weekdayRepeated;
      continue;
    }
    seen.add(weekday);
    const intervals = validateDay(weekday, day.intervals, fields);
    if (intervals) value.push({ weekday, intervals });
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  value.sort((a, b) => a.weekday - b.weekday);
  return { ok: true, value };
}

/** 7 dias vazios, no formato da resposta (usado pela tela). */
export function emptyWeek() {
  return WEEKDAYS.map((weekday) => ({ weekday, intervals: [] }));
}

/**
 * Único caminho de serialização da grade para o dono: sempre os 7 dias, na ordem 1..7,
 * intervalos por início. Não expõe businessId, professionalId nem created_at.
 * @param {Array<{ weekday: number, startMinute: number, endMinute: number }>} rows
 * @returns {{ days: Array<{ weekday: number, intervals: Array<{ start: string, end: string }> }>, hasHours: boolean }}
 */
export function toOwnerHours(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  const days = emptyWeek();
  for (const row of list) {
    const day = days[row.weekday - 1];
    if (!day) continue;
    day.intervals.push({ start: formatTime(row.startMinute), end: formatTime(row.endMinute) });
  }
  return { days, hasHours: days.some((d) => d.intervals.length > 0) };
}
