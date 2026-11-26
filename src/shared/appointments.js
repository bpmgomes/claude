// Regras do agendamento do cliente final (AF-11, design 4.2). Módulo puro: só importa
// ./zoned-time.js, ./availability.js e ./services.js (também puros). Não entra no
// grafo do navegador (orçamento do AF-09): as mensagens do 409 e do 422 vêm do servidor.
import { parseLocalDateTime, addLocalDays } from './zoned-time.js';
import { ANY_PROFESSIONAL, BOOKING_HORIZON_DAYS, AVAILABILITY_MESSAGES } from './availability.js';
import { SERVICE_ID_RE } from './services.js';

export const APPOINTMENT_STATUSES = Object.freeze(['confirmed', 'cancelled', 'completed', 'no_show']);
export const APPOINTMENT_STATUS_CONFIRMED = 'confirmed';
export const APPOINTMENT_STATUS_CANCELLED = 'cancelled';
/** Sugestões no 409 (decisão 6). */
export const BOOKING_SUGGESTIONS_MAX = 3;
/** Dias locais procurados pelas sugestões, contando o dia de `start` (decisão 6). */
export const BOOKING_SUGGESTIONS_DAYS = 14;
/** Agendamentos futuros não cancelados por (negócio, e-mail) e por (negócio, telefone) (decisão 8). */
export const CUSTOMER_FUTURE_APPOINTMENTS_MAX = 3;
/** Validade da `Idempotency-Key` (decisão 7). */
export const IDEMPOTENCY_TTL_HOURS = 24;
/** UUID v4, sem distinção de maiúsculas; o servidor grava em minúsculas. */
export const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mensagens fixas: nenhuma interpola a entrada (critério 2). */
export const APPOINTMENT_MESSAGES = Object.freeze({
  checkFields: 'Verifique os campos destacados.',
  serviceRequired: AVAILABILITY_MESSAGES.serviceRequired,
  professionalRequired: AVAILABILITY_MESSAGES.professionalRequired,
  startRequired: 'Escolha um horário.',
  startInvalid: 'Escolha um dos horários livres da lista.',
  outOfHorizon: AVAILABILITY_MESSAGES.outOfHorizon,
  slotUnavailable: 'Este horário acabou de ser ocupado. Escolha outro.',
  limitReached:
    'Já existem agendamentos marcados com estes dados. Para marcar outro, ligue para o estabelecimento.',
  idempotencyReused: 'Esta tentativa já foi usada com outros dados. Recarregue a página e tente de novo.',
  unavailable: 'Não foi possível confirmar o agendamento agora. Tente novamente em instantes.',
  badRequest: 'Requisição inválida.',
});

const M = APPOINTMENT_MESSAGES;
const UUID_LENGTH = 36;
const START_LENGTH = 16;
const STEP_MINUTES = 15;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

/** Comprimento antes do regex. */
const isUuid = (value) => typeof value === 'string' && value.length === UUID_LENGTH && SERVICE_ID_RE.test(value);

/**
 * Valida o horário do corpo do POST (sem o cliente, que é do AF-04). `today` é a data local do
 * negócio no instante do servidor. Hoje no passado, menos de 1 h de antecedência ou desalinhado da
 * grade NÃO são erro de formato: o motor decide, e o resultado é 409 (critério 10).
 * @param {unknown} body
 * @param {{ today: string }} options
 * @returns {{ ok: true, value: { serviceId: string, professionalId: string, start: string, date: string } }
 *   | { ok: false, notFound: true }
 *   | { ok: false, fields: Partial<Record<'serviceId'|'professionalId'|'start', string>> }}
 */
export function validateBookingInput(body, { today }) {
  const src = isPlainObject(body) ? body : {};
  const fields = {};
  let notFound = false;

  const serviceId = own(src, 'serviceId');
  if (typeof serviceId !== 'string' || serviceId === '') fields.serviceId = M.serviceRequired;
  else if (!isUuid(serviceId)) notFound = true;

  const professionalId = own(src, 'professionalId');
  if (typeof professionalId !== 'string' || professionalId === '') fields.professionalId = M.professionalRequired;
  else if (professionalId !== ANY_PROFESSIONAL && !isUuid(professionalId)) notFound = true;

  const start = own(src, 'start');
  let date = '';
  if (start === undefined || start === null || start === '') fields.start = M.startRequired;
  else if (typeof start !== 'string' || start.length !== START_LENGTH) fields.start = M.startInvalid;
  else {
    const parsed = parseLocalDateTime(start);
    if (!parsed.ok || parsed.value.minute % STEP_MINUTES !== 0) fields.start = M.startInvalid;
    else {
      date = start.slice(0, 10);
      if (date < today || date > addLocalDays(today, BOOKING_HORIZON_DAYS)) fields.start = M.outOfHorizon;
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  if (notFound) return { ok: false, notFound: true };
  return { ok: true, value: { serviceId, professionalId, start, date } };
}

/**
 * `Idempotency-Key` do cabeçalho: `undefined` (sem idempotência), a chave em minúsculas, ou `null`
 * (fora do formato, inclusive cabeçalho repetido, que o Node junta com `, `).
 * @param {unknown} raw
 * @returns {string|null|undefined}
 */
export function parseIdempotencyKey(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length !== UUID_LENGTH || !IDEMPOTENCY_KEY_RE.test(raw)) return null;
  return raw.toLowerCase();
}
