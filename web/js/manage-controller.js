// Lógica da página de gerenciar o agendamento (AF-12, design 4.4). Sem DOM e sem relógio do
// navegador: hoje, prazo e fuso vêm do servidor; datas só por manipulação de string. Todas as
// chamadas usam credentials: 'omit', e o token vai SÓ no caminho da URL (critério 10).
import { requestJson } from './api.js';
import {
  successDetails,
  safePhoneHref,
  dayLabel,
  isoWeekdayOfDate,
  suggestionLabel,
} from './public-booking-controller.js';
import { ANY_PROFESSIONAL } from '/shared/availability.js';
import { parseLocalDate } from '/shared/zoned-time.js';

export { suggestionLabel };

/** Textos fixos da tela. As mensagens do servidor só entram com o `code` esperado. */
export const MANAGE_PAGE_MESSAGES = Object.freeze({
  loading: 'Carregando…',
  notFound: 'Link inválido ou expirado. Se precisar, ligue para o estabelecimento.',
  closed: 'O prazo para alterar online terminou. Ligue para o estabelecimento.',
  cancelled: 'Este agendamento foi cancelado.',
  cancelledNow: 'Agendamento cancelado.',
  rescheduled: 'Agendamento remarcado. O mesmo link continua valendo.',
  notChangeable: 'Este agendamento não pode mais ser alterado online. Ligue para o estabelecimento.',
  changed: 'Este agendamento mudou desde que a página foi aberta. Veja a situação atual abaixo.',
  limit: 'Este agendamento já foi remarcado 3 vezes. Para mudar de novo, ligue para o estabelecimento.',
  slotTaken: 'Este horário acabou de ser ocupado. Escolha outro.',
  noSuggestions: 'Não encontramos outros horários livres próximos. Escolha outra data.',
  unavailable: 'Não foi possível concluir agora. Tente novamente em instantes.',
  rateLimited: 'Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.',
  badRequest: 'Não foi possível enviar. Recarregue a página e tente de novo.',
  loadingSlots: 'Carregando horários…',
  emptyDay: 'Não há horários livres neste dia. Escolha outra data ou outro profissional.',
  chooseDate: 'Escolha uma data para ver os horários.',
  anyProfessional: 'Qualquer profissional',
  cancelling: 'Cancelando…',
  rescheduling: 'Remarcando…',
  cancelButton: 'Sim, cancelar',
  rescheduleButton: 'Confirmar remarcação',
});

const P = MANAGE_PAGE_MESSAGES;

/** Título do resumo por status. */
export const STATUS_TITLES = Object.freeze({
  confirmed: 'Agendamento confirmado',
  cancelled: 'Agendamento cancelado',
  completed: 'Atendimento concluído',
  no_show: 'Agendamento não comparecido',
});

const DATE_TIME_LENGTH = 16;
const SUGGESTIONS_MAX = 3;
const text = (v) => (typeof v === 'string' ? v : '');
const isLocalDateTime = (v) => typeof v === 'string' && v.length === DATE_TIME_LENGTH && v[10] === 'T' && parseLocalDate(v.slice(0, 10)).ok;
const isDate = (v) => typeof v === 'string' && parseLocalDate(v).ok;

/** Segundo segmento do caminho (`/agendamento/<token>`), sem validar: a API decide. */
export function tokenFromPath(pathname) {
  const segment = String(pathname ?? '').split('/')[2] ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** '/api/public/manage/<token><suffix>', com o token codificado. */
export function manageApiUrl(token, suffix = '') {
  return `/api/public/manage/${encodeURIComponent(String(token ?? ''))}${suffix}`;
}

/** `pageUrl` só vira link se for http(s) absoluto. */
export function safePageUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** 'HH:MM' de 'YYYY-MM-DDTHH:MM'; o fim às 00:00 do dia seguinte vira '24:00'. */
function timeOf(local, { end = false, date } = {}) {
  const time = String(local).slice(11, 16);
  if (end && time === '00:00' && String(local).slice(0, 10) !== date) return '24:00';
  return time;
}

/** '2026-11-27T08:00' -> 'Você pode alterar até sex, 27/11 às 08:00'. */
export function deadlineLabel(changeDeadline) {
  if (!isLocalDateTime(changeDeadline)) return '';
  const date = changeDeadline.slice(0, 10);
  return `Você pode alterar até ${dayLabel(date, isoWeekdayOfDate(date))} às ${timeOf(changeDeadline)}`;
}

/** Mensagem do servidor só com o código esperado; senão, a fixa local. */
function serverMessage(error, code, fallback) {
  return error && error.code === code && typeof error.message === 'string' && error.message ? error.message : fallback;
}

/** Sugestões do 409: só `{ start, end }` válidos, até 3, com rótulos. */
function toSuggestions(list, requestedStart) {
  const requestedDate = text(requestedStart).slice(0, 10);
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (out.length >= SUGGESTIONS_MAX) break;
    if (!item || !isLocalDateTime(item.start) || !isLocalDateTime(item.end)) continue;
    const date = item.start.slice(0, 10);
    const suggestion = { start: item.start, end: item.end, label: timeOf(item.start) };
    if (date !== requestedDate) suggestion.dateLabel = dayLabel(date, isoWeekdayOfDate(date));
    out.push(suggestion);
  }
  return out;
}

/** Primeira mensagem de campo do 400 (fixas do servidor). */
function fieldMessage(error) {
  const fields = error && error.fields && typeof error.fields === 'object' ? error.fields : {};
  for (const key of ['start', 'date', 'professionalId']) {
    if (typeof fields[key] === 'string' && fields[key]) return fields[key];
  }
  return null;
}

/**
 * Falha no padrão do AF-11: `{ ok: false, kind, message }`, com `kind` em notFound, changed,
 * notChangeable, limit, slot (+ suggestions), fields, rateLimited, unavailable ou network.
 */
function failureOf(res, { start } = {}) {
  const error = res.error || {};
  switch (res.status) {
    case 0:
      return { ok: false, kind: 'network', message: P.unavailable };
    case 400: {
      const message = fieldMessage(error);
      return message ? { ok: false, kind: 'fields', message } : { ok: false, kind: 'fields', message: P.badRequest };
    }
    case 404:
      return { ok: false, kind: 'notFound', message: P.notFound };
    case 409:
      if (error.code === 'APPOINTMENT_CHANGED') {
        return { ok: false, kind: 'changed', message: serverMessage(error, 'APPOINTMENT_CHANGED', P.changed) };
      }
      if (error.code === 'APPOINTMENT_NOT_CHANGEABLE') {
        return { ok: false, kind: 'notChangeable', message: serverMessage(error, 'APPOINTMENT_NOT_CHANGEABLE', P.notChangeable) };
      }
      if (error.code === 'RESCHEDULE_LIMIT_REACHED') {
        return { ok: false, kind: 'limit', message: serverMessage(error, 'RESCHEDULE_LIMIT_REACHED', P.limit) };
      }
      if (error.code === 'BOOKING_LIMIT_REACHED') {
        return { ok: false, kind: 'limit', message: serverMessage(error, 'BOOKING_LIMIT_REACHED', P.notChangeable) };
      }
      if (error.code === 'SLOT_UNAVAILABLE') {
        return {
          ok: false,
          kind: 'slot',
          message: serverMessage(error, 'SLOT_UNAVAILABLE', P.slotTaken),
          suggestions: toSuggestions(error.suggestions, start),
        };
      }
      return { ok: false, kind: 'unavailable', message: P.unavailable };
    case 429:
      return { ok: false, kind: 'rateLimited', message: P.rateLimited };
    default:
      return { ok: false, kind: 'unavailable', message: P.unavailable };
  }
}

/**
 * Resumo do servidor para a tela: só o que a tela usa, com os links conferidos.
 * @returns {object|null} null se o corpo não tem a forma esperada
 */
export function summaryOf(body) {
  const appointment = body && body.appointment;
  const change = body && body.change;
  if (!appointment || typeof appointment !== 'object' || !change || typeof change !== 'object') return null;
  const business = appointment.business || {};
  const reschedule = change.reschedule || {};
  const status = text(appointment.status);
  return {
    status,
    title: STATUS_TITLES[status] || STATUS_TITLES.confirmed,
    details: successDetails(appointment),
    start: text(appointment.start),
    timezone: text(appointment.timezone),
    serviceName: text(appointment.service && appointment.service.name),
    professionalName: text(appointment.professional && appointment.professional.name),
    phoneHref: safePhoneHref(business.phoneHref),
    phoneDisplay: text(business.phoneDisplay),
    pageUrl: safePageUrl(business.pageUrl),
    canChange: change.canChange === true,
    deadline: deadlineLabel(change.changeDeadline),
    policy: text(change.policy),
    version: text(change.version),
    reschedule: {
      allowed: reschedule.allowed === true,
      sameProfessional: reschedule.sameProfessional === true,
      notice: text(reschedule.notice),
      today: isDate(reschedule.today) ? reschedule.today : '',
      maxDate: isDate(reschedule.maxDate) ? reschedule.maxDate : '',
    },
  };
}

function okSummary(res) {
  const summary = summaryOf(res.body);
  return summary ? { ok: true, summary } : { ok: false, kind: 'unavailable', message: P.unavailable };
}

/** GET do resumo. */
export async function loadManage(token, { fetchFn } = {}) {
  const options = { credentials: 'omit' };
  if (fetchFn) options.fetchFn = fetchFn;
  const res = await requestJson(manageApiUrl(token), options);
  return res.ok ? okSummary(res) : failureOf(res);
}

/**
 * Horários de UM dia para remarcar. `professionalId`: 'same' (o atual, sem parâmetro) ou 'any'.
 * @returns {Promise<{ ok: true, day: { date: string, weekday: number, slots: Array<{ label: string,
 *   endLabel: string, start: string, end: string }> }, timezone: string } | { ok: false, kind: string,
 *   message: string, aborted?: boolean }>}
 */
export async function loadRescheduleDay(token, { date, professionalId }, { fetchFn, signal } = {}) {
  const options = { credentials: 'omit', signal };
  if (fetchFn) options.fetchFn = fetchFn;
  let query = `?date=${encodeURIComponent(String(date ?? ''))}`;
  if (professionalId === ANY_PROFESSIONAL) query += `&professionalId=${ANY_PROFESSIONAL}`;
  const res = await requestJson(manageApiUrl(token, `/availability${query}`), options);
  if (signal && signal.aborted) return { ok: false, kind: 'network', message: P.unavailable, aborted: true };
  if (!res.ok) return failureOf(res);
  const body = res.body;
  const day = body && Array.isArray(body.days) ? body.days.find((d) => d && d.date === date) : null;
  if (!day || !Array.isArray(day.slots)) return { ok: false, kind: 'unavailable', message: P.unavailable };
  return {
    ok: true,
    timezone: text(body.timezone),
    day: {
      date: day.date,
      weekday: day.weekday,
      slots: day.slots
        .filter((slot) => slot && isLocalDateTime(slot.start) && isLocalDateTime(slot.end))
        .map((slot) => ({
          label: timeOf(slot.start),
          endLabel: timeOf(slot.end, { end: true, date: day.date }),
          start: slot.start,
          end: slot.end,
        })),
    },
  };
}

/** POST cancel com a `version` do resumo exibido (obrigatória). */
export async function cancelAppointment(token, { version }, { fetchFn } = {}) {
  const options = { method: 'POST', credentials: 'omit', body: { version: text(version) } };
  if (fetchFn) options.fetchFn = fetchFn;
  const res = await requestJson(manageApiUrl(token, '/cancel'), options);
  return res.ok ? okSummary(res) : failureOf(res);
}

/**
 * POST reschedule. `professionalId`: 'same' (o atual, sem enviar a chave) ou 'any'. A tela nunca
 * envia serviço nem dados pessoais (critérios 25 e 37).
 */
export async function rescheduleAppointment(token, { start, professionalId, version }, { fetchFn } = {}) {
  const body = { start: text(start), version: text(version) };
  if (professionalId === ANY_PROFESSIONAL) body.professionalId = ANY_PROFESSIONAL;
  const options = { method: 'POST', credentials: 'omit', body };
  if (fetchFn) options.fetchFn = fetchFn;
  const res = await requestJson(manageApiUrl(token, '/reschedule'), options);
  return res.ok ? okSummary(res) : failureOf(res, { start });
}

/** 'sex, 27/11 · 10:30 – 11:30 (America/Sao_Paulo)'. */
export function rescheduleSummary(slot, { weekday, timezone }) {
  const date = String(slot.start).slice(0, 10);
  return `${dayLabel(date, weekday)} · ${slot.label} – ${slot.endLabel} (${timezone})`;
}

/** Texto do status com a lista pronta. */
export function slotsReadyMessage(count, date, weekday) {
  const label = dayLabel(date, weekday);
  return count === 1 ? `1 horário livre em ${label}.` : `${count} horários livres em ${label}.`;
}

/** Opções do profissional: "Mesmo profissional (nome)" só quando ele ainda atende; "Qualquer" sempre. */
export function professionalChoices(summary) {
  const out = [];
  if (summary.reschedule.sameProfessional) {
    out.push({ value: 'same', label: `Mesmo profissional (${summary.professionalName})` });
  }
  out.push({ value: ANY_PROFESSIONAL, label: P.anyProfessional });
  return out;
}
