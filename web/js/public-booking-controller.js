// Lógica da seção de horários da página pública (AF-10, 4.4). Sem DOM e sem relógio do navegador:
// a data de hoje e o fuso vêm do servidor (atributos data-* e campos `now`/`timezone` da resposta).
import { requestJson } from './api.js';
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
 *   { ok: true, day: { date: string, weekday: number, slots: Array<{ label: string, start: string, end: string, endLabel: string, professionalIds: string[] }> },
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
        professionalIds: (Array.isArray(slot.professionals) ? slot.professionals : [])
          .map((i) => ids[i])
          .filter((id) => typeof id === 'string'),
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
