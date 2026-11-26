// Lógica da seção de horários da página pública (AF-10, 4.4) e da confirmação (AF-11, 4.4). Sem DOM
// e sem relógio do navegador: a data de hoje e o fuso vêm do servidor (atributos data-* e campos
// `now`/`timezone` da resposta). Datas só por manipulação de string.
import { requestJson } from './api.js';
import { serverFieldErrors } from './customer-form-controller.js';
import { ANY_PROFESSIONAL, AVAILABILITY_MESSAGES } from '/shared/availability.js';
import { SERVICE_ID_RE } from '/shared/services.js';
import { parseLocalDate } from '/shared/zoned-time.js';

/** Mensagens fixas da tela (nenhuma interpola texto do servidor, exceto as de campo, também fixas). */
export const BOOKING_MESSAGES = Object.freeze({
  loading: 'Carregando horários…',
  empty: 'Não há horários livres neste dia. Escolha outra data ou outro profissional.',
  emptyAny: 'Não há horários livres neste dia. Escolha outra data.',
  noneOnline: 'Nenhum profissional atende este serviço pela internet agora. Ligue para o telefone acima.',
  notFound: 'Este serviço ou profissional não está mais disponível. Recarregue a página.',
  rateLimited: 'Muitas consultas em pouco tempo. Aguarde um instante e tente de novo.',
  unavailable: 'Não foi possível carregar os horários. Tente de novo em instantes.',
  chooseService: 'Escolha um serviço para ver os horários.',
  // AF-11: confirmação.
  confirming: 'Confirmando seu agendamento…',
  confirmingButton: 'Confirmando…',
  confirmButton: 'Confirmar agendamento',
  slotTaken: 'Este horário acabou de ser ocupado. Escolha outro.',
  noSuggestions: 'Não encontramos outros horários livres próximos. Escolha outra data.',
  limit: 'Já existem agendamentos marcados com estes dados. Para marcar outro, ligue para o estabelecimento.',
  bookingNotFound: 'Este serviço ou profissional não está mais disponível. Recarregue a página.',
  bookingRateLimited: 'Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.',
  bookingUnavailable: 'Não foi possível confirmar agora. Seus dados continuam aqui. Tente de novo em instantes.',
  reused: 'Esta tentativa já foi usada com outros dados. Recarregue a página e tente de novo.',
  fieldsElsewhere: 'Escolha o horário de novo.',
  checkFields: 'Verifique os campos destacados.',
  slotGone: 'Este horário não está mais livre. Escolha outro.',
});

const WEEKDAY_SHORT = Object.freeze({ 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sáb', 7: 'dom' });

const isUuid = (value) => typeof value === 'string' && value.length === 36 && SERVICE_ID_RE.test(value);

/**
 * URL da consulta de um dia.
 * @param {string} slug
 * @param {{ serviceId: string, professionalId: string, date: string }} selection
 */
export function availabilityUrl(slug, { serviceId, professionalId, date }) {
  const q = (v) => encodeURIComponent(String(v ?? ''));
  return (
    `/api/public/${q(slug)}/availability?serviceId=${q(serviceId)}&professionalId=${q(professionalId)}` +
    `&from=${q(date)}&to=${q(date)}`
  );
}

/** 'HH:MM' de 'YYYY-MM-DDTHH:MM'; o fim às 00:00 do dia seguinte vira '24:00'. */
function timeOf(local, { end = false, date } = {}) {
  const time = String(local).slice(11, 16);
  if (end && time === '00:00' && String(local).slice(0, 10) !== date) return '24:00';
  return time;
}

function failure(status, message) {
  return { ok: false, status, message };
}

/** Primeira mensagem de campo do 400 (fixas do servidor), ou a genérica. */
function fieldMessage(error) {
  const fields = error && error.fields && typeof error.fields === 'object' ? error.fields : {};
  for (const key of ['serviceId', 'professionalId', 'from', 'to']) {
    if (typeof fields[key] === 'string') return fields[key];
  }
  return AVAILABILITY_MESSAGES.dateInvalid;
}

/**
 * Consulta os horários de UM dia.
 * @param {string} slug
 * @param {{ serviceId: string, professionalId: string, date: string }} selection
 * @param {{ fetchFn?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<
 *   { ok: true, day: { date: string, weekday: number, slots: Array<{ label: string, start: string, end: string, endLabel: string }> },
 *     timezone: string, now: string, anyEligible: boolean }
 *   | { ok: false, status: number, message: string, aborted?: boolean }>}
 */
export async function loadAvailability(slug, selection, { fetchFn, signal } = {}) {
  // Rota pública: nunca envia o cookie do dono (AF-10 item 5, AF-04 critério 16).
  const options = { signal, credentials: 'omit' };
  if (fetchFn) options.fetchFn = fetchFn;
  const res = await requestJson(availabilityUrl(slug, selection), options);
  if (signal && signal.aborted) return { ...failure(0, BOOKING_MESSAGES.unavailable), aborted: true };
  if (!res.ok) {
    if (res.status === 400) return failure(400, fieldMessage(res.error));
    if (res.status === 404) return failure(404, BOOKING_MESSAGES.notFound);
    if (res.status === 429) return failure(429, BOOKING_MESSAGES.rateLimited);
    return failure(res.status, BOOKING_MESSAGES.unavailable);
  }
  const body = res.body;
  const day = body && Array.isArray(body.days) ? body.days.find((d) => d && d.date === selection.date) : null;
  if (!day || !Array.isArray(body.professionals) || !Array.isArray(day.slots)) {
    return failure(res.status, BOOKING_MESSAGES.unavailable);
  }
  // Sem ids por horário em "qualquer" (AF-11, decisão 4).
  const ids = body.professionals;
  return {
    ok: true,
    day: {
      date: day.date,
      weekday: day.weekday,
      slots: day.slots.map((slot) => ({
        label: timeOf(slot.start),
        endLabel: timeOf(slot.end, { end: true, date: day.date }),
        start: slot.start,
        end: slot.end,
      })),
    },
    timezone: String(body.timezone ?? ''),
    now: String(body.now ?? ''),
    anyEligible: ids.length > 0,
  };
}

/**
 * Só a consulta mais recente vale (critério 30): `next()` aborta a anterior e devolve um token
 * novo; uma resposta cujo token não é o atual é descartada.
 * @returns {{ next(): { token: number, signal: AbortSignal|undefined }, isCurrent(token: number): boolean }}
 */
export function createLatestOnly() {
  let current = 0;
  let controller = null;
  return {
    next() {
      if (controller) controller.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      current += 1;
      return { token: current, signal: controller ? controller.signal : undefined };
    },
    isCurrent(token) {
      return token === current;
    },
  };
}

/**
 * Profissionais que realizam o serviço, com "Qualquer profissional" sempre primeiro. Sem serviço,
 * todos.
 * @param {Array<{ value: string, serviceIds: string[] }>} options
 * @param {string} serviceId
 */
export function professionalOptionsFor(options, serviceId) {
  const list = Array.isArray(options) ? options : [];
  const any = list.filter((o) => o.value === ANY_PROFESSIONAL);
  const others = list.filter(
    (o) => o.value !== ANY_PROFESSIONAL && (!serviceId || (Array.isArray(o.serviceIds) && o.serviceIds.includes(serviceId))),
  );
  return [...(any.length > 0 ? any : [{ value: ANY_PROFESSIONAL, serviceIds: [] }]), ...others];
}

/**
 * Seleção da URL (`?servico=&profissional=&data=`), para link compartilhável. Valor inválido cai
 * no padrão: sem serviço, qualquer profissional, `today`.
 * @param {string} search
 * @param {{ today: string, maxDate: string }} bounds datas do servidor
 * @returns {{ serviceId: string, professionalId: string, date: string }}
 */
export function readSelection(search, { today, maxDate }) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const servico = params.get('servico');
  const profissional = params.get('profissional');
  const data = params.get('data');
  const dateOk = typeof data === 'string' && parseLocalDate(data).ok && data >= today && data <= maxDate;
  return {
    serviceId: isUuid(servico) ? servico : '',
    professionalId: isUuid(profissional) ? profissional : ANY_PROFESSIONAL,
    date: dateOk ? data : today,
  };
}

/** Query string da seleção (para history.replaceState). */
export function selectionToSearch({ serviceId, professionalId, date }) {
  const params = new URLSearchParams();
  if (serviceId) params.set('servico', serviceId);
  if (professionalId && professionalId !== ANY_PROFESSIONAL) params.set('profissional', professionalId);
  if (date) params.set('data', date);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** '2026-11-27', 5 -> 'sex, 27/11' (só manipulação de string). */
export function dayLabel(date, weekday) {
  const text = String(date);
  const short = WEEKDAY_SHORT[weekday] || '';
  const dm = `${text.slice(8, 10)}/${text.slice(5, 7)}`;
  return short ? `${short}, ${dm}` : dm;
}

/**
 * 'Corte · sex, 27/11 · 09:00 – 10:00 (America/Sao_Paulo)'.
 * @param {{ start: string, end: string, label?: string, endLabel?: string }} slot
 * @param {{ serviceName: string, timezone: string, weekday: number }} options
 */
export function selectedSummary(slot, { serviceName, timezone, weekday }) {
  const date = String(slot.start).slice(0, 10);
  const from = slot.label || timeOf(slot.start);
  const to = slot.endLabel || timeOf(slot.end, { end: true, date });
  return `${serviceName} · ${dayLabel(date, weekday)} · ${from} – ${to} (${timezone})`;
}

/** Estado vazio (critério 29). */
export function emptyDayMessage({ any, anyEligible }) {
  if (!anyEligible) return BOOKING_MESSAGES.noneOnline;
  return any ? BOOKING_MESSAGES.emptyAny : BOOKING_MESSAGES.empty;
}

/** Texto do status com a lista pronta. */
export function readyMessage(count, date, weekday) {
  const label = dayLabel(date, weekday);
  return count === 1 ? `1 horário livre em ${label}.` : `${count} horários livres em ${label}.`;
}

// Confirmação do agendamento (AF-11, 4.4).

const DATE_TIME_LENGTH = 16;
const isLocalDateTime = (v) => typeof v === 'string' && v.length === DATE_TIME_LENGTH && parseLocalDate(v.slice(0, 10)).ok && v[10] === 'T';
const text = (v) => (typeof v === 'string' ? v : '');
const SUGGESTIONS_MAX = 3;

/** Dia ISO (1 = seg .. 7 = dom) de 'YYYY-MM-DD', por aritmética (Sakamoto). */
export function isoWeekdayOfDate(date) {
  const parsed = parseLocalDate(date);
  if (!parsed.ok) return 0;
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let { year } = parsed.value;
  const { month, day } = parsed.value;
  if (month < 3) year -= 1;
  const dow = (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + offsets[month - 1] + day) % 7;
  return dow === 0 ? 7 : dow;
}

/** '/api/public/<slug>/appointments'. */
export function appointmentsUrl(slug) {
  return `/api/public/${encodeURIComponent(String(slug ?? ''))}/appointments`;
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

/**
 * POST de confirmação, sempre com credentials: 'omit' (critério 30) e, com `idempotencyKey`, o
 * cabeçalho Idempotency-Key (critério 25). Resultado: `{ ok: true, appointment }` ou `{ ok: false,
 * kind, message }` com kind 'fields' (+ fields, otherFields), 'slot' (+ suggestions), 'limit',
 * 'notFound', 'rateLimited', 'reused', 'unavailable' ou 'network'.
 */
export async function confirmBooking(slug, { serviceId, professionalId, start, customer }, { fetchFn, idempotencyKey } = {}) {
  const options = {
    method: 'POST',
    credentials: 'omit',
    body: {
      serviceId,
      professionalId,
      start,
      customer: { name: text(customer?.name), phone: text(customer?.phone), email: text(customer?.email) },
    },
  };
  if (typeof idempotencyKey === 'string' && idempotencyKey) options.headers = { 'Idempotency-Key': idempotencyKey };
  if (fetchFn) options.fetchFn = fetchFn;
  const res = await requestJson(appointmentsUrl(slug), options);
  if (res.ok) {
    const appointment = res.body && res.body.appointment;
    if (res.status === 201 && appointment && typeof appointment === 'object') return { ok: true, appointment };
    return { ok: false, kind: 'unavailable', message: BOOKING_MESSAGES.bookingUnavailable };
  }
  const error = res.error || {};
  switch (res.status) {
    case 0:
      return { ok: false, kind: 'network', message: BOOKING_MESSAGES.bookingUnavailable };
    case 400: {
      const fields = serverFieldErrors(error);
      const raw = error.fields && typeof error.fields === 'object' ? error.fields : {};
      const otherFields = ['serviceId', 'professionalId', 'start'].some((k) => Object.prototype.hasOwnProperty.call(raw, k));
      if (Object.keys(fields).length === 0 && !otherFields) {
        return { ok: false, kind: 'unavailable', message: BOOKING_MESSAGES.bookingUnavailable };
      }
      return {
        ok: false,
        kind: 'fields',
        fields,
        otherFields,
        message: otherFields ? BOOKING_MESSAGES.fieldsElsewhere : BOOKING_MESSAGES.checkFields,
      };
    }
    case 404:
      return { ok: false, kind: 'notFound', message: BOOKING_MESSAGES.bookingNotFound };
    case 409:
      if (error.code === 'SLOT_UNAVAILABLE') {
        return {
          ok: false,
          kind: 'slot',
          message: serverMessage(error, 'SLOT_UNAVAILABLE', BOOKING_MESSAGES.slotTaken),
          suggestions: toSuggestions(error.suggestions, start),
        };
      }
      if (error.code === 'BOOKING_LIMIT_REACHED') {
        return { ok: false, kind: 'limit', message: serverMessage(error, 'BOOKING_LIMIT_REACHED', BOOKING_MESSAGES.limit) };
      }
      return { ok: false, kind: 'unavailable', message: BOOKING_MESSAGES.bookingUnavailable };
    case 422:
      return { ok: false, kind: 'reused', message: serverMessage(error, 'IDEMPOTENCY_KEY_REUSED', BOOKING_MESSAGES.reused) };
    case 429:
      return { ok: false, kind: 'rateLimited', message: BOOKING_MESSAGES.bookingRateLimited };
    default:
      return { ok: false, kind: 'unavailable', message: BOOKING_MESSAGES.bookingUnavailable };
  }
}

/** Chave por tentativa (critério 25): a mesma para o mesmo conteúdo; nova quando muda ou após reset(). */
export function createAttemptKeys(randomUUID) {
  let lastPayload = null;
  let key = null;
  return {
    keyFor(payload) {
      const serialized = JSON.stringify(payload);
      if (key === null || serialized !== lastPayload) {
        key = randomUUID();
        lastPayload = serialized;
      }
      return key;
    },
    reset() {
      key = null;
      lastPayload = null;
    },
  };
}

/** Linhas `{ label, value }` da tela de sucesso (critério 27). Não string vira ''. */
export function successDetails(appointment) {
  const a = appointment || {};
  const service = a.service || {};
  const professional = a.professional || {};
  const business = a.business || {};
  const start = text(a.start);
  const end = text(a.end);
  const date = start.slice(0, 10);
  const weekday = Number.isInteger(a.weekday) ? a.weekday : isoWeekdayOfDate(date);
  const short = WEEKDAY_SHORT[weekday] || '';
  const dmy = isLocalDateTime(start) ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '';
  const hours =
    isLocalDateTime(start) && isLocalDateTime(end) ? `${timeOf(start)} – ${timeOf(end, { end: true, date })} (${text(a.timezone)})` : '';
  const serviceParts = [text(service.name), text(service.durationLabel), text(service.priceLabel)].filter(Boolean);
  return [
    { label: 'Data', value: dmy ? (short ? `${short}, ${dmy}` : dmy) : '' },
    { label: 'Horário', value: hours },
    { label: 'Serviço', value: serviceParts.join(' · ') },
    { label: 'Profissional', value: text(professional.name) },
    { label: 'Endereço', value: text(business.address) },
  ];
}

/** Só tel:+55 com 10 ou 11 dígitos; senão null. */
export function safePhoneHref(href) {
  return typeof href === 'string' && /^tel:\+55\d{10,11}$/.test(href) ? href : null;
}

/** 'sex, 27/11 · 10:15' em outro dia; '10:15' no mesmo dia. */
export function suggestionLabel(suggestion) {
  if (!suggestion) return '';
  return suggestion.dateLabel ? `${suggestion.dateLabel} · ${suggestion.label}` : suggestion.label;
}
