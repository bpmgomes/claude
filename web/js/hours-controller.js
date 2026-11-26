// Lógica da tela de horários, sem DOM (testável no Node). O servidor é a autoridade;
// a validação aqui é só para UX (as mesmas regras de /shared/working-hours.js).
import { PROFESSIONAL_ID_RE, PROFESSIONAL_MESSAGES } from '/shared/professionals.js';
import {
  validateHoursInput,
  formatTime,
  emptyWeek,
  WEEKDAYS,
  TIME_STEP_MINUTES,
  DAY_END_MINUTE,
  HOURS_MESSAGES,
  OUTSIDE_HOURS_SCAN_MAX,
} from '/shared/working-hours.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

export const EMPTY_HOURS_MESSAGE =
  'Este profissional ainda não tem horários. Ele não aparecerá para os clientes até ter horários e ao menos um serviço ativo.';
const KNOWN_STATUSES = [400, 401, 404, 409, 413, 415, 429];

function redirectFor(res) {
  if (res.status === 401) return '/login';
  if (res.status === 409 && res.error && res.error.code === 'BUSINESS_REQUIRED') return '/onboarding';
  return undefined;
}

function failure(res) {
  const known = KNOWN_STATUSES.includes(res.status);
  const result = {
    ok: false,
    status: res.status,
    fields: (known && res.error && res.error.fields) || {},
    message: known && res.error ? res.error.message : GENERIC_ERROR_MESSAGE,
  };
  const redirectTo = redirectFor(res);
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

const validId = (id) => typeof id === 'string' && PROFESSIONAL_ID_RE.test(id);
const notFound = () => ({ ok: false, status: 404, fields: {}, message: PROFESSIONAL_MESSAGES.notFound });

function isHours(hours) {
  return Boolean(hours && Array.isArray(hours.days));
}

/**
 * GET /api/professionals/:id/hours.
 * @returns {Promise<{ ok: true, hours: { days: object[], hasHours: boolean } }
 *   | { ok: false, status: number, message: string, redirectTo?: string }>}
 */
export async function loadHours(id, { fetchFn }) {
  if (!validId(id)) {
    const { status, message } = notFound();
    return { ok: false, status, message };
  }
  const res = await requestJson(`/api/professionals/${id}/hours`, { fetchFn });
  if (res.ok && res.body && isHours(res.body.hours)) return { ok: true, hours: res.body.hours };
  const { status, message, redirectTo } = failure(res);
  const result = { ok: false, status, message };
  if (redirectTo) result.redirectTo = redirectTo;
  return result;
}

/**
 * PUT da grade. Valida antes com validateHoursInput: com erro, não chama o servidor.
 * @param {Array<{ weekday: number, intervals: Array<{ start: string, end: string }> }>} days
 * @returns {Promise<{ ok: true, hours: object, affectedAppointmentsCount: number|null, warning: string|null }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function saveHours(id, days, { fetchFn }) {
  if (!validId(id)) return notFound();
  const body = { days: Array.isArray(days) ? days : [] };
  const check = validateHoursInput(body);
  if (!check.ok) return { ok: false, fields: check.fields, message: check.message || HOURS_MESSAGES.checkFields };

  const res = await requestJson(`/api/professionals/${id}/hours`, { method: 'PUT', body, fetchFn });
  if (res.ok && res.body && isHours(res.body.hours)) {
    const raw = res.body.affectedAppointmentsCount;
    const affectedAppointmentsCount = Number.isInteger(raw) && raw >= 0 ? raw : null;
    return {
      ok: true,
      hours: res.body.hours,
      affectedAppointmentsCount,
      warning: affectedMessage(affectedAppointmentsCount),
    };
  }
  return failure(res);
}

/**
 * Opções dos `<select>`, passo de 15 min. Início: 00:00..23:45; fim: 00:15..24:00 (96 cada).
 * @returns {string[]}
 */
export function timeOptions({ forEnd = false } = {}) {
  const options = [];
  const first = forEnd ? TIME_STEP_MINUTES : 0;
  const last = forEnd ? DAY_END_MINUTE : DAY_END_MINUTE - TIME_STEP_MINUTES;
  for (let m = first; m <= last; m += TIME_STEP_MINUTES) options.push(formatTime(m));
  return options;
}

function cloneIntervals(intervals) {
  return (Array.isArray(intervals) ? intervals : []).map((i) => ({ start: i && i.start, end: i && i.end }));
}

/** Normaliza para os 7 dias, na ordem 1..7, com cópia profunda. */
function normalizeWeek(days) {
  const byWeekday = new Map((Array.isArray(days) ? days : []).filter(Boolean).map((d) => [d.weekday, d]));
  return WEEKDAYS.map((weekday) => ({
    weekday,
    intervals: cloneIntervals(byWeekday.has(weekday) ? byWeekday.get(weekday).intervals : []),
  }));
}

/**
 * Copia os intervalos de um dia para outros dias (decisão 3: só na interface).
 * @returns {Array<{ weekday: number, intervals: object[] }>} dias novos; o original não muda
 */
export function copyDay(days, fromWeekday, toWeekdays) {
  const week = normalizeWeek(days);
  const source = week.find((d) => d.weekday === fromWeekday);
  if (!source) return week;
  const targets = new Set(Array.isArray(toWeekdays) ? toWeekdays : []);
  return week.map((d) =>
    d.weekday !== fromWeekday && targets.has(d.weekday) ? { weekday: d.weekday, intervals: cloneIntervals(source.intervals) } : d,
  );
}

/**
 * Preenche o formulário com a grade de outro profissional (resposta do GET). Nada é gravado aqui.
 * @param {{ days?: object[] }} otherHours
 */
export function copyFromProfessional(otherHours) {
  return normalizeWeek(otherHours && otherHours.days);
}

/** Comparação estrutural dos 7 dias (ignora a ordem das chaves). */
export function isDirty(savedDays, currentDays) {
  const a = normalizeWeek(savedDays);
  const b = normalizeWeek(currentDays);
  for (let i = 0; i < a.length; i++) {
    const x = a[i].intervals;
    const y = b[i].intervals;
    if (x.length !== y.length) return true;
    for (let n = 0; n < x.length; n++) {
      if (x[n].start !== y[n].start || x[n].end !== y[n].end) return true;
    }
  }
  return false;
}

const FIELD_KEY_RE = /^days\.(\d+)(?:\.intervals\.(\d+)(?:\.(start|end))?)?$/;

/**
 * Agrupa os erros do servidor (ou locais) por intervalo ou por dia, para a tela marcar o lugar certo.
 * `'<weekday>.<n>'` para um intervalo e `'<weekday>'` para o dia. A chave `days` (sem posição) e
 * as desconhecidas são ignoradas (a tela mostra a mensagem geral).
 * @param {Record<string, string>} fields
 * @returns {Map<string, string[]>}
 */
export function errorsByInterval(fields) {
  const result = new Map();
  if (!fields || typeof fields !== 'object') return result;
  for (const [key, message] of Object.entries(fields)) {
    const match = typeof key === 'string' ? key.match(FIELD_KEY_RE) : null;
    if (!match || typeof message !== 'string') continue;
    const group = match[2] !== undefined ? `${match[1]}.${match[2]}` : match[1];
    if (!result.has(group)) result.set(group, []);
    const list = result.get(group);
    if (!list.includes(message)) list.push(message);
  }
  return result;
}

/** Aviso depois de salvar (critério 20). 0 ou null: sem aviso. */
export function affectedMessage(count) {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count === 1) return '1 agendamento futuro fica fora do novo horário. Ele continua marcado.';
  // Teto da varredura (AF-11, decisão 16): o número é um limite inferior.
  if (count >= OUTSIDE_HOURS_SCAN_MAX) {
    return `Pelo menos ${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} agendamentos futuros ficam fora do novo horário. Eles continuam marcados.`;
  }
  return `${count} agendamentos futuros ficam fora do novo horário. Eles continuam marcados.`;
}

export { emptyWeek };
