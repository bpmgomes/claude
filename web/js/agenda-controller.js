// Lógica da agenda do dono (AF-14, design 4.4), sem DOM (testável no Node). O servidor é a autoridade:
// "hoje" e "agora" vêm do `now` da resposta, e os dias já chegam agrupados no fuso do negócio. Datas e
// horas são texto ('YYYY-MM-DD', 'YYYY-MM-DDTHH:MM'): nada aqui usa o relógio nem o fuso do navegador.
import {
  AGENDA_STATUS_DISPLAY,
  CANCELLED_BY_LABELS,
  displayKeyOf,
  startOfIsoWeek,
  isoWeekdayOfDate,
} from '/shared/agenda.js';
import { REASON_LABELS } from '/shared/time-blocks.js';
import { PROFESSIONAL_ID_RE } from '/shared/professionals.js';
import { parseLocalDate, addLocalDays } from '/shared/zoned-time.js';
import { requestJson, GENERIC_ERROR_MESSAGE } from './api.js';

export const ALL_PROFESSIONALS_LABEL = 'Todos os profissionais';

/** Textos fixos da tela (nenhum interpola dado que não seja de exibição já escapado por textContent). */
export const AGENDA_PAGE_MESSAGES = Object.freeze({
  loading: 'Carregando agenda…',
  loaded: 'Agenda atualizada.',
  empty: 'Nenhum agendamento neste período.',
  professionalGone: 'O profissional escolhido não está mais disponível. Mostrando todos.',
  copyFallback: 'Selecione e copie o e-mail.',
  copied: 'E-mail copiado.',
  detailLoading: 'Carregando detalhes…',
  cancelling: 'Cancelando…',
  alreadyCancelled: 'Este agendamento já estava cancelado.',
  cancelledEmail: 'Agendamento cancelado. O aviso ao cliente será enviado por e-mail.',
  cancelledNoEmail: 'Agendamento cancelado. O cliente não será avisado por e-mail. Avise por telefone.',
  blockLabel: 'Bloqueado',
  removedSuffix: ' (removido)',
});

const M = AGENDA_PAGE_MESSAGES;
const WEEKDAYS = ['', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const VIEWS = ['day', 'week'];
const UUID_LENGTH = 36;
const TEL_RE = /^tel:\+55\d{10,11}$/;

const str = (v) => (typeof v === 'string' ? v : '');
const ddmm = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const ddmmyyyy = (date) => `${ddmm(date)}/${date.slice(0, 4)}`;
const hhmm = (local) => str(local).slice(11, 16);

/**
 * Query da URL -> estado. Só `view` (day|week, padrão day), `date` (data válida) e `professional`
 * (UUID v4); o resto é ignorado (critério 33).
 * @param {string} search `location.search`
 * @returns {{ view: 'day'|'week', date: string|null, professional: string|null }}
 */
export function parseAgendaUrl(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const view = params.get('view');
  const date = params.get('date');
  const professional = params.get('professional');
  return {
    view: VIEWS.includes(view) ? view : 'day',
    date: date !== null && parseLocalDate(date).ok ? date : null,
    professional:
      professional !== null && professional.length === UUID_LENGTH && PROFESSIONAL_ID_RE.test(professional) ? professional : null,
  };
}

/**
 * Estado -> query (só as três chaves, nunca nome, telefone, e-mail ou id de agendamento).
 * @param {{ view?: string, date?: string|null, professional?: string|null }} state
 * @returns {string} '?view=...&date=...' (ou '')
 */
export function buildAgendaUrl(state) {
  const clean = parseAgendaUrl(
    new URLSearchParams({
      view: str(state?.view),
      date: str(state?.date),
      professional: str(state?.professional),
    }).toString(),
  );
  const params = new URLSearchParams();
  params.set('view', clean.view);
  if (clean.date) params.set('date', clean.date);
  if (clean.professional) params.set('professional', clean.professional);
  return `?${params.toString()}`;
}

/** Período da visão: o dia, ou a semana de segunda a domingo que contém a data. */
export function rangeOf(view, date) {
  if (view === 'week') {
    const from = startOfIsoWeek(date);
    return { from, to: addLocalDays(from, 6) };
  }
  return { from: date, to: date };
}

/** Anterior/Próximo: ± 1 dia ou ± 7 dias. */
export function shift(view, date, direction) {
  return addLocalDays(date, (view === 'week' ? 7 : 1) * (direction < 0 ? -1 : 1));
}

/** "Semana de 23/11 a 29/11" ou "quinta-feira, 26/11/2026". */
export function titleOf(view, from, to) {
  if (view === 'week') return `Semana de ${ddmm(from)} a ${ddmm(to)}`;
  return `${WEEKDAYS[isoWeekdayOfDate(from)] || ''}, ${ddmmyyyy(from)}`;
}

/** C-11: o identificador IANA, como nos e-mails do AF-18. */
export function timezoneLabel(tz) {
  return `Horários no fuso ${str(tz)}`;
}

/** Cabeçalho do dia: "quinta-feira, 26/11 · 6 agendamentos". */
export function dayHeading(day) {
  const n = Number.isInteger(day?.counts?.active) ? day.counts.active : 0;
  const label = n === 0 ? 'nenhum agendamento' : n === 1 ? '1 agendamento' : `${n} agendamentos`;
  return `${WEEKDAYS[isoWeekdayOfDate(day?.date)] || ''}, ${ddmm(str(day?.date))} · ${label}`;
}

/** "2 cancelados e 1 remarcado ocultos"; '' sem ocultos. */
export function hiddenLabel(counts) {
  const c = Number.isInteger(counts?.cancelled) ? counts.cancelled : 0;
  const r = Number.isInteger(counts?.rescheduled) ? counts.rescheduled : 0;
  const parts = [];
  if (c > 0) parts.push(c === 1 ? '1 cancelado' : `${c} cancelados`);
  if (r > 0) parts.push(r === 1 ? '1 remarcado' : `${r} remarcados`);
  if (parts.length === 0) return '';
  return `${parts.join(' e ')} ${c + r === 1 ? 'oculto' : 'ocultos'}`;
}

/** Hora local relativa ao dia exibido: 'HH:MM' no próprio dia, 'dd/mm HH:MM' em outro. */
function edgeLabel(local, date) {
  return str(local).slice(0, 10) === date ? hhmm(local) : `${ddmm(str(local).slice(0, 10))} ${hhmm(local)}`;
}

/**
 * Item da lista -> textos e classe do mapa FIXO (critérios 31 e 36). `className` nunca vem do dado.
 * @param {object} item agendamento ou bloqueio da resposta
 * @param {{ date?: string, showProfessional?: boolean }} [options] dia exibido; com "Todos", o profissional
 * @returns {{ key: string, timeLabel: string, primary: string, secondary: string, professional: string,
 *   statusLabel: string, origin: string, icon: string, className: string, struck: boolean }}
 */
export function describeItem(item, { date, showProfessional = true } = {}) {
  const key = displayKeyOf(item);
  const display = AGENDA_STATUS_DISPLAY[key] || AGENDA_STATUS_DISPLAY.unknown;
  const day = typeof date === 'string' ? date : str(item?.start).slice(0, 10);
  const start = str(item?.start);
  const end = str(item?.end);
  if (key === 'block') {
    const target = item?.professional ? str(item.professional.name) : ALL_PROFESSIONALS_LABEL;
    const kind = item?.reason && typeof item.reason.kind === 'string' ? REASON_LABELS[item.reason.kind] || '' : '';
    const note = item?.reason ? str(item.reason.note) : '';
    const reason = [kind, note].filter(Boolean).join(': ');
    const timeLabel = item?.allDay && start.slice(0, 10) <= day && end.slice(0, 10) > day && start.endsWith('T00:00') && end.endsWith('T00:00')
      ? 'Dia inteiro'
      : `${edgeLabel(start, day)} até ${edgeLabel(end, day)}`;
    return {
      key,
      timeLabel,
      primary: target,
      secondary: reason,
      professional: target,
      statusLabel: display.label,
      origin: '',
      icon: display.icon,
      className: display.className,
      struck: false,
    };
  }
  const sameDay = end.slice(0, 10) === day;
  const timeLabel = `${hhmm(start)} ${sameDay ? 'às' : 'até'} ${edgeLabel(end, day)}`;
  const pro = item?.professional
    ? `${str(item.professional.name)}${item.professional.removed === true ? M.removedSuffix : ''}`
    : '';
  const by = item?.cancelled && typeof item.cancelled.by === 'string' ? item.cancelled.by : null;
  return {
    key,
    timeLabel,
    primary: str(item?.serviceName),
    secondary: str(item?.customerName),
    professional: showProfessional ? pro : '',
    statusLabel: display.label,
    origin: key === 'cancelled' && by && Object.prototype.hasOwnProperty.call(CANCELLED_BY_LABELS, by) ? CANCELLED_BY_LABELS[by] : '',
    icon: display.icon,
    className: display.className,
    struck: key === 'cancelled' || key === 'rescheduled',
  };
}

/** "Cancelar o agendamento de {cliente} em dd/mm às HH:MM? ..." (critério 39). */
export function cancelQuestion(detail, emailEnabled) {
  const a = detail?.appointment ?? detail;
  const start = str(a?.start);
  const tail = emailEnabled ? 'O cliente será avisado por e-mail.' : 'O e-mail está desativado: avise o cliente por telefone.';
  return `Cancelar o agendamento de ${str(a?.customer?.name)} em ${ddmm(start.slice(0, 10))} às ${hhmm(start)}? ${tail}`;
}

/** Mensagem do 200 do cancelamento: a repetição não promete e-mail. */
export function cancelResultMessage(outcome, emailEnabled) {
  if (outcome === 'unchanged') return M.alreadyCancelled;
  return emailEnabled ? M.cancelledEmail : M.cancelledNoEmail;
}

/** "Remarcado de 26/11 15:00" / "Remarcado para 27/11 11:00", pela cadeia do detalhe. */
export function chainLabels(detail) {
  const a = detail?.appointment ?? detail;
  const out = [];
  const at = (local) => `${ddmm(str(local).slice(0, 10))} ${hhmm(local)}`;
  if (a?.rescheduledFrom && typeof a.rescheduledFrom.start === 'string') out.push(`Remarcado de ${at(a.rescheduledFrom.start)}`);
  if (a?.rescheduledTo && typeof a.rescheduledTo.start === 'string') out.push(`Remarcado para ${at(a.rescheduledTo.start)}`);
  return out;
}

/** 'YYYY-MM-DDTHH:MM' -> '20/11/2026 14:12' ('' para outra coisa). */
export function localLabel(local) {
  const s = str(local);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${ddmmyyyy(s.slice(0, 10))} ${hhmm(s)}` : '';
}

/** Horário do detalhe: "sexta-feira, 27/11/2026, 10:00 às 11:00" (fim em outro dia: "até 28/11 00:30"). */
export function detailWhen(detail) {
  const a = detail?.appointment ?? detail;
  const start = str(a?.start);
  const date = start.slice(0, 10);
  const { timeLabel } = describeItem({ type: 'appointment', status: 'confirmed', start, end: str(a?.end) }, { date });
  return `${WEEKDAYS[isoWeekdayOfDate(date)] || ''}, ${ddmmyyyy(date)}, ${timeLabel}`;
}

/** Só `tel:+55` com 10 ou 11 dígitos; outra coisa vira null (o link não é montado). */
export function safeTelHref(href) {
  return typeof href === 'string' && TEL_RE.test(href) ? href : null;
}

/** Linha de origem e horário do cancelamento no detalhe. */
export function cancelledLabel(detail) {
  const a = detail?.appointment ?? detail;
  if (!a?.cancelled) return '';
  const by = typeof a.cancelled.by === 'string' && Object.prototype.hasOwnProperty.call(CANCELLED_BY_LABELS, a.cancelled.by)
    ? CANCELLED_BY_LABELS[a.cancelled.by]
    : AGENDA_STATUS_DISPLAY.cancelled.label;
  const at = str(a.cancelled.at);
  return at ? `${by} em ${ddmm(at.slice(0, 10))} às ${hhmm(at)}` : by;
}

// Falhas da API -> { kind, message, fields, redirectTo }. Mensagem do servidor só com o código esperado.
const EXPECTED = Object.freeze({
  VALIDATION_ERROR: 'fields',
  APPOINTMENT_NOT_FOUND: 'notFound',
  APPOINTMENT_CHANGED: 'changed',
  APPOINTMENT_NOT_CHANGEABLE: 'notChangeable',
  RATE_LIMITED: 'rateLimited',
  AGENDA_UNAVAILABLE: 'unavailable',
});

/** @returns {{ ok: false, status: number, kind: string, message: string, fields: Record<string,string>, redirectTo?: string }} */
export function failureOf(res) {
  const code = res?.error && typeof res.error.code === 'string' ? res.error.code : '';
  const base = { ok: false, status: Number(res?.status) || 0, fields: {}, message: GENERIC_ERROR_MESSAGE };
  if (base.status === 0) return { ...base, kind: 'network' };
  if (base.status === 401) return { ...base, kind: 'unauthenticated', redirectTo: '/login' };
  if (base.status === 409 && code === 'BUSINESS_REQUIRED') return { ...base, kind: 'businessRequired', redirectTo: '/onboarding' };
  const kind = Object.prototype.hasOwnProperty.call(EXPECTED, code) ? EXPECTED[code] : null;
  if (!kind) return { ...base, kind: 'unavailable' };
  const message = typeof res.error.message === 'string' && res.error.message !== '' ? res.error.message : GENERIC_ERROR_MESSAGE;
  const fields = {};
  if (kind === 'fields' && res.error.fields && typeof res.error.fields === 'object') {
    for (const [k, v] of Object.entries(res.error.fields)) if (typeof v === 'string') fields[k] = v;
  }
  return { ...base, kind, message, fields };
}

/**
 * GET /api/agenda. Sem `from`/`to`, o servidor usa hoje (C-1).
 * @returns {Promise<{ ok: true, body: object } | ReturnType<typeof failureOf>>}
 */
export async function loadAgenda({ from, to, professionalId, includeCancelled } = {}, { fetchFn } = {}) {
  const params = new URLSearchParams();
  if (typeof from === 'string' && from !== '' && typeof to === 'string' && to !== '') {
    params.set('from', from);
    params.set('to', to);
  }
  if (typeof professionalId === 'string' && professionalId !== '') params.set('professionalId', professionalId);
  if (includeCancelled === true) params.set('includeCancelled', 'true');
  const query = params.toString();
  const res = await requestJson(`/api/agenda${query ? `?${query}` : ''}`, { fetchFn });
  if (res.ok && res.body && Array.isArray(res.body.days)) return { ok: true, body: res.body };
  return failureOf(res);
}

/** GET /api/agenda/appointments/:id. Id fora do formato não chama o servidor. */
export async function loadAppointment(id, { fetchFn } = {}) {
  if (typeof id !== 'string' || id.length !== UUID_LENGTH || !PROFESSIONAL_ID_RE.test(id)) {
    return { ok: false, status: 404, kind: 'notFound', message: 'Agendamento não encontrado.', fields: {} };
  }
  const res = await requestJson(`/api/agenda/appointments/${id}`, { fetchFn });
  if (res.ok && res.body && res.body.appointment) return { ok: true, body: res.body };
  return failureOf(res);
}

/** POST /api/agenda/appointments/:id/cancel com `{ version }`. */
export async function cancelAppointment(id, { version } = {}, { fetchFn } = {}) {
  if (typeof id !== 'string' || id.length !== UUID_LENGTH || !PROFESSIONAL_ID_RE.test(id)) {
    return { ok: false, status: 404, kind: 'notFound', message: 'Agendamento não encontrado.', fields: {} };
  }
  const res = await requestJson(`/api/agenda/appointments/${id}/cancel`, { method: 'POST', body: { version }, fetchFn });
  if (res.ok && res.body && res.body.appointment) return { ok: true, body: res.body, outcome: res.body.outcome };
  return failureOf(res);
}
