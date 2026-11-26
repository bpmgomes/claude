// Lógica da tela de bloqueios, sem DOM (testável no Node). O servidor é a autoridade; a validação
// aqui é só para UX (as mesmas regras de /shared/time-blocks.js). Datas e horas são sempre a hora
// local do negócio, tratadas como texto: nada aqui usa Date nem o fuso do navegador (critério 18).
import {
  validateTimeBlockInput,
  TIME_BLOCK_ID_RE,
  TIME_BLOCK_MESSAGES,
  TIME_BLOCK_STEP_MINUTES,
  REASON_LABELS,
  DEFAULT_TIME_ZONE,
} from '/shared/time-blocks.js';
import { addLocalDays } from '/shared/zoned-time.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

export const EMPTY_TIME_BLOCKS_MESSAGE =
  'Nenhum bloqueio ativo. Um bloqueio marca um período em que um profissional, ou todos, não atende, como folga, feriado ou férias. Nesse período, o sistema não oferece horários para novos agendamentos. Os agendamentos já marcados continuam valendo.';
export const ALL_PROFESSIONALS_LABEL = 'Todos os profissionais';
export const STILL_BOOKED_MESSAGE = 'Os agendamentos deste período continuam marcados.';

const KNOWN_STATUSES = [400, 401, 404, 409, 413, 415, 429, 503];
const CONFLICT_CODES = ['TIME_BLOCK_CONFLICTS', 'TIME_BLOCK_CONFLICTS_CHANGED'];

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

/**
 * GET /api/time-blocks. Filtros vazios não vão na URL.
 * @param {{ professionalId?: string|null, from?: string, to?: string }} filters
 * @returns {Promise<{ ok: true, timeBlocks: object[], timezone: string, now: string, truncated: boolean }
 *   | { ok: false, status: number, message: string, fields: Record<string,string>, redirectTo?: string }>}
 */
export async function loadTimeBlocks({ professionalId, from, to } = {}, { fetchFn }) {
  const params = new URLSearchParams();
  if (typeof professionalId === 'string' && professionalId !== '') params.set('professionalId', professionalId);
  if (typeof from === 'string' && from !== '') params.set('from', from);
  if (typeof to === 'string' && to !== '') params.set('to', to);
  const query = params.toString();
  const res = await requestJson(`/api/time-blocks${query ? `?${query}` : ''}`, { fetchFn });
  if (res.ok && res.body && Array.isArray(res.body.timeBlocks)) {
    return {
      ok: true,
      timeBlocks: res.body.timeBlocks,
      timezone: typeof res.body.timezone === 'string' ? res.body.timezone : DEFAULT_TIME_ZONE,
      now: typeof res.body.now === 'string' ? res.body.now : '',
      truncated: res.body.truncated === true,
    };
  }
  return failure(res);
}

/**
 * Formulário -> corpo do POST. Dia inteiro: `${startDate}T00:00` até `${endDate + 1}T00:00`
 * (data final inclusive, decisão 2). `professionalId` sempre presente (null = todos).
 * @param {{ professionalId: string|null, allDay: boolean, startDate: string, startTime: string,
 *           endDate: string, endTime: string, reasonKind: string, reasonNote: string }} form
 * @returns {{ professionalId: string|null, start: string, end: string, reasonKind?: string, reasonNote?: string }}
 */
export function toRequestBody(form) {
  const f = form || {};
  const professionalId = typeof f.professionalId === 'string' && f.professionalId !== '' ? f.professionalId : null;
  const startDate = typeof f.startDate === 'string' ? f.startDate : '';
  const endDate = typeof f.endDate === 'string' ? f.endDate : '';
  const body = { professionalId, start: '', end: '' };
  if (f.allDay) {
    body.start = `${startDate}T00:00`;
    const next = addLocalDays(endDate, 1);
    body.end = next ? `${next}T00:00` : `${endDate}T00:00`;
  } else {
    body.start = `${startDate}T${typeof f.startTime === 'string' ? f.startTime : ''}`;
    body.end = `${endDate}T${typeof f.endTime === 'string' ? f.endTime : ''}`;
  }
  if (typeof f.reasonKind === 'string' && f.reasonKind !== '') body.reasonKind = f.reasonKind;
  if (typeof f.reasonNote === 'string' && f.reasonNote.trim() !== '') body.reasonNote = f.reasonNote;
  return body;
}

/**
 * POST /api/time-blocks. Valida antes com validateTimeBlockInput (sem nowMs): com erro, não chama
 * o servidor. Com `confirmConflictsToken`, reenvia confirmando a lista exibida.
 * @returns {Promise<{ ok: true, timeBlock: object, acknowledgedConflictsCount: number, warnings: string[] }
 *   | { ok: false, needsConfirmation: true, changed: boolean, conflicts: object[], conflictsTotal: number, conflictsToken: string }
 *   | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function createTimeBlock(form, { fetchFn, confirmConflictsToken, timeZone = DEFAULT_TIME_ZONE }) {
  const body = toRequestBody(form);
  const check = validateTimeBlockInput(body, { timeZone });
  if (!check.ok) return { ok: false, fields: check.fields, message: TIME_BLOCK_MESSAGES.checkFields };
  if (typeof confirmConflictsToken === 'string' && confirmConflictsToken !== '') {
    body.confirmConflictsToken = confirmConflictsToken;
  }

  const res = await requestJson('/api/time-blocks', { method: 'POST', body, fetchFn });
  if (res.ok && res.body && res.body.timeBlock) {
    const raw = res.body.acknowledgedConflictsCount;
    const warnings = Array.isArray(res.body.warnings)
      ? res.body.warnings.filter((w) => w && typeof w.message === 'string').map((w) => w.message)
      : [];
    return {
      ok: true,
      timeBlock: res.body.timeBlock,
      acknowledgedConflictsCount: Number.isInteger(raw) && raw >= 0 ? raw : 0,
      warnings,
    };
  }
  if (res.status === 409 && res.error && CONFLICT_CODES.includes(res.error.code)) {
    const { conflicts, conflictsTotal, conflictsToken } = res.error;
    const list = Array.isArray(conflicts) ? conflicts : [];
    return {
      ok: false,
      needsConfirmation: true,
      changed: res.error.code === 'TIME_BLOCK_CONFLICTS_CHANGED',
      conflicts: list,
      conflictsTotal: Number.isInteger(conflictsTotal) && conflictsTotal >= 0 ? conflictsTotal : list.length,
      conflictsToken: typeof conflictsToken === 'string' ? conflictsToken : '',
    };
  }
  return failure(res);
}

/**
 * DELETE /api/time-blocks/:id. Id fora do formato não chama o servidor.
 * @returns {Promise<{ ok: true } | { ok: false, status?: number, fields: Record<string,string>, message: string, redirectTo?: string }>}
 */
export async function removeTimeBlock(id, { fetchFn }) {
  if (typeof id !== 'string' || !TIME_BLOCK_ID_RE.test(id)) {
    return { ok: false, status: 404, fields: {}, message: TIME_BLOCK_MESSAGES.notFound };
  }
  const res = await requestJson(`/api/time-blocks/${id}`, { method: 'DELETE', fetchFn });
  if (res.ok) return { ok: true };
  return failure(res);
}

// 'YYYY-MM-DDTHH:MM' -> partes, por manipulação de string (sem Date).
const datePart = (local) => (typeof local === 'string' ? local.slice(0, 10) : '');
const timePart = (local) => (typeof local === 'string' ? local.slice(11, 16) : '');
const dayMonth = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const fullDate = (date) => `${dayMonth(date)}/${date.slice(0, 4)}`;

/** '24/12 a 26/12/2026' (mesmo ano) ou '30/12/2026 a 02/01/2027'; um dia só: '24/12/2026'. */
function dateRange(first, last) {
  if (first === last) return fullDate(first);
  if (first.slice(0, 4) === last.slice(0, 4)) return `${dayMonth(first)} a ${fullDate(last)}`;
  return `${fullDate(first)} a ${fullDate(last)}`;
}

/**
 * Textos de um bloqueio para a lista, em pt-BR, a partir de `start`/`end` locais.
 * @param {{ professional: { name: string }|null, start: string, end: string, allDay: boolean,
 *           reason: { kind: string, note: string|null }|null }} block
 * @returns {{ targetLabel: string, periodLabel: string, reasonLabel: string }}
 */
export function describeTimeBlock(block) {
  const b = block || {};
  const targetLabel = b.professional && typeof b.professional.name === 'string' ? b.professional.name : ALL_PROFESSIONALS_LABEL;

  const startDate = datePart(b.start);
  const endDate = datePart(b.end);
  let periodLabel;
  if (b.allDay) {
    const last = addLocalDays(endDate, -1) || endDate;
    periodLabel = `${dateRange(startDate, last)} (dia inteiro)`;
  } else if (startDate === endDate) {
    periodLabel = `${fullDate(startDate)} ${timePart(b.start)} – ${timePart(b.end)}`;
  } else {
    periodLabel = `${fullDate(startDate)} ${timePart(b.start)} – ${fullDate(endDate)} ${timePart(b.end)}`;
  }

  let reasonLabel = '';
  if (b.reason && typeof b.reason.kind === 'string') {
    const label = REASON_LABELS[b.reason.kind] || '';
    const note = typeof b.reason.note === 'string' ? b.reason.note : '';
    if (!note) reasonLabel = label;
    else if (b.reason.kind === 'other') reasonLabel = note;
    else reasonLabel = `${label}: ${note}`;
  }
  return { targetLabel, periodLabel, reasonLabel };
}

/**
 * Resumo do painel de confirmação: singular, plural e "e mais N" quando a lista foi cortada.
 * @param {number} total conflictsTotal
 * @param {number} shown itens exibidos
 * @returns {string}
 */
export function conflictsSummary(total, shown) {
  const t = Number.isInteger(total) && total > 0 ? total : 0;
  const s = Number.isInteger(shown) && shown >= 0 ? Math.min(shown, t) : t;
  const main =
    t === 1
      ? '1 agendamento neste período. Ele continua marcado.'
      : `${t} agendamentos neste período. Eles continuam marcados.`;
  return t > s ? `${main} Abaixo, os ${s} primeiros, e mais ${t - s}.` : main;
}

/**
 * Descrição de um conflito para o painel: data, hora, serviço, profissional e cliente.
 * @param {{ start: string, end: string, serviceName: string, professionalName: string, customerName: string }} item
 * @returns {{ when: string, serviceName: string, professionalName: string, customerName: string }}
 */
export function describeConflict(item) {
  const c = item || {};
  const when = `${fullDate(datePart(c.start))} ${timePart(c.start)} – ${timePart(c.end)}`;
  const text = (v) => (typeof v === 'string' ? v : '');
  return {
    when,
    serviceName: text(c.serviceName),
    professionalName: text(c.professionalName),
    customerName: text(c.customerName),
  };
}

/**
 * Opções do `<select>` de hora: 00:00..23:45, passo de 15 min (96).
 * @returns {string[]}
 */
export function timeOptions() {
  const options = [];
  for (let m = 0; m < 1440; m += TIME_BLOCK_STEP_MINUTES) {
    options.push(`${String(Math.trunc(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return options;
}

/**
 * Hora inicial sugerida no formulário: a próxima hora cheia depois de `now` local ('YYYY-MM-DDTHH:MM').
 * Sem Date: só texto. Perto da meia-noite, usa 23:00–23:45 do mesmo dia.
 * @param {string} now
 * @returns {{ date: string, startTime: string, endTime: string }}
 */
export function defaultFormTimes(now) {
  const date = datePart(now);
  const hour = Number(timePart(now).slice(0, 2));
  const next = Number.isInteger(hour) ? Math.min(hour + 1, 23) : 9;
  const startTime = `${String(next).padStart(2, '0')}:00`;
  const endTime = next >= 23 ? '23:45' : `${String(next + 1).padStart(2, '0')}:00`;
  return { date, startTime, endTime };
}
