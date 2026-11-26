// Regras do agendamento do cliente final (AF-11, design 4.2). Módulo puro: só importa
// ./zoned-time.js, ./availability.js e ./services.js (também puros). Não entra no
// grafo do navegador (orçamento do AF-09): as mensagens do 409 e do 422 vêm do servidor.
import { parseLocalDateTime, parseLocalDate, addLocalDays } from './zoned-time.js';
import { ANY_PROFESSIONAL, BOOKING_HORIZON_DAYS, AVAILABILITY_MESSAGES } from './availability.js';
import { SERVICE_ID_RE, formatDuration } from './services.js';

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

// Gerenciar o agendamento pelo link (AF-12, design 4.2).

/** Bytes aleatórios do token (critério 4). */
export const MANAGE_TOKEN_BYTES = 32;
/** base64url de 32 bytes, sem preenchimento. */
export const MANAGE_TOKEN_LENGTH = 43;
export const MANAGE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** `change.version`: base64url de um SHA-256 (43 caracteres). */
export const MANAGE_VERSION_RE = /^[A-Za-z0-9_-]{43}$/;
/** Purga dos tokens vencidos há mais de 30 dias (critério 7). */
export const MANAGE_TOKEN_RETENTION_DAYS = 30;
/** Remarcações por cadeia de agendamentos (decisão 7). */
export const RESCHEDULES_PER_CHAIN_MAX = 3;
export const MANAGE_PATH_PREFIX = '/agendamento/';
/** Teto de tokens VIVOS por agendamento (AF-18, critério 11; docs/security/AF-12.md item 2). */
export const MANAGE_TOKENS_LIVE_MAX = 5;

/** Mensagens fixas do gerenciar: nenhuma interpola a entrada. */
export const MANAGE_MESSAGES = Object.freeze({
  linkInvalid: 'Link inválido ou expirado.',
  notChangeable: 'Este agendamento não pode mais ser alterado online. Ligue para o estabelecimento.',
  changed: 'Este agendamento mudou desde que a página foi aberta. Veja a situação atual abaixo.',
  rescheduleLimit: 'Este agendamento já foi remarcado 3 vezes. Para mudar de novo, ligue para o estabelecimento.',
  rescheduleServiceUnavailable:
    'Este serviço não pode mais ser remarcado online. Você ainda pode cancelar, ou ligue para o estabelecimento.',
  professionalUnavailable:
    'Este profissional não está mais disponível online. Escolha Qualquer profissional ou ligue para o estabelecimento.',
  unavailable: 'Não foi possível concluir agora. Tente novamente em instantes.',
  badRequest: 'Requisição inválida.',
});

const M = APPOINTMENT_MESSAGES;
const UUID_LENGTH = 36;
const START_LENGTH = 16;
const STEP_MINUTES = 15;
const MINUTE_MS = 60_000;

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
  const startError = startErrorOf(start, today);
  if (startError) fields.start = startError;
  const date = startError ? '' : start.slice(0, 10);

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  if (notFound) return { ok: false, notFound: true };
  return { ok: true, value: { serviceId, professionalId, start, date } };
}

/** Regras de `start` do AF-11 (formato, grade de 15 min e horizonte). @returns {string|null} */
function startErrorOf(start, today) {
  if (start === undefined || start === null || start === '') return M.startRequired;
  if (typeof start !== 'string' || start.length !== START_LENGTH) return M.startInvalid;
  const parsed = parseLocalDateTime(start);
  if (!parsed.ok || parsed.value.minute % STEP_MINUTES !== 0) return M.startInvalid;
  const date = start.slice(0, 10);
  if (date < today || date > addLocalDays(today, BOOKING_HORIZON_DAYS)) return M.outOfHorizon;
  return null;
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

/**
 * Token do caminho (critério 6): a string, ou null fora do formato. O comprimento é conferido antes
 * do regex (nenhum regex roda sobre texto longo).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseManageToken(raw) {
  if (typeof raw !== 'string' || raw.length !== MANAGE_TOKEN_LENGTH || !MANAGE_TOKEN_RE.test(raw)) return null;
  return raw;
}

const isVersion = (v) => typeof v === 'string' && v.length === MANAGE_TOKEN_LENGTH && MANAGE_VERSION_RE.test(v);

/**
 * Janela de alteração (critério 18). Inclusivo: pode com `nowMs <= startsAtMs - lead`, e só antes do
 * início (`nowMs < startsAtMs`, o que vale também com antecedência 0). Só `confirmed` pode.
 * @param {{ status: string, startsAtMs: number, nowMs: number, leadMinutes: number }} input
 * @returns {{ canChange: boolean, deadlineMs: number }}
 */
export function changeWindow({ status, startsAtMs, nowMs, leadMinutes }) {
  const lead = Number.isInteger(leadMinutes) && leadMinutes > 0 ? leadMinutes : 0;
  const deadlineMs = startsAtMs - lead * MINUTE_MS;
  const canChange = status === APPOINTMENT_STATUS_CONFIRMED && nowMs < startsAtMs && nowMs <= deadlineMs;
  return { canChange, deadlineMs };
}

/**
 * Texto da política, montado só com o número do banco (sem eco).
 * 120 -> "Você pode cancelar ou remarcar por este link até 2 h antes do horário."
 * 0   -> "Você pode cancelar ou remarcar por este link até o horário de início."
 * @param {number} leadMinutes
 * @returns {string}
 */
export function formatChangePolicy(leadMinutes) {
  if (!Number.isInteger(leadMinutes) || leadMinutes <= 0) {
    return 'Você pode cancelar ou remarcar por este link até o horário de início.';
  }
  return `Você pode cancelar ou remarcar por este link até ${formatDuration(leadMinutes)} antes do horário.`;
}

/** Profissional opcional: ausente/null -> null; 'any'; UUID; outro -> 'invalid'. */
function optionalProfessional(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (raw === ANY_PROFESSIONAL || isUuid(raw)) return { ok: true, value: raw };
  return { ok: false };
}

/**
 * Corpo do reschedule (critérios 25 e 37). Campos extras são ignorados.
 * @param {unknown} body
 * @param {{ today: string }} options
 * @returns {{ ok: true, value: { start: string, professionalId: string|null, version: string } }
 *   | { ok: false, fields: Partial<Record<'start'|'professionalId', string>> }
 *   | { ok: false, badRequest: true }}
 */
export function validateRescheduleInput(body, { today }) {
  if (!isPlainObject(body)) return { ok: false, badRequest: true };
  const fields = {};
  const start = own(body, 'start');
  const startError = startErrorOf(start, today);
  if (startError) fields.start = startError;
  const professional = optionalProfessional(own(body, 'professionalId'));
  if (!professional.ok) fields.professionalId = M.professionalRequired;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  const version = own(body, 'version');
  if (!isVersion(version)) return { ok: false, badRequest: true };
  return { ok: true, value: { start, professionalId: professional.value, version } };
}

/**
 * Corpo do cancel. A `version` é OBRIGATÓRIA (decisão do Gerente no AF-12: elimina o R7 do design).
 * @param {unknown} body
 * @returns {{ ok: true, version: string } | { ok: false, badRequest: true }}
 */
export function validateCancelInput(body) {
  if (!isPlainObject(body)) return { ok: false, badRequest: true };
  const version = own(body, 'version');
  if (!isVersion(version)) return { ok: false, badRequest: true };
  return { ok: true, version };
}

/**
 * Query do availability do gerenciar (critério 24). `date` de hoje a hoje + 90 (mensagens do AF-10).
 * Outras chaves são ignoradas.
 * @param {unknown} query
 * @param {{ today: string }} options
 * @returns {{ ok: true, value: { date: string, professionalId: string|null } } | { ok: false, fields: Record<string, string> }}
 */
export function validateManageAvailabilityQuery(query, { today }) {
  const src = isPlainObject(query) ? query : {};
  const fields = {};
  const date = own(src, 'date');
  if (!parseLocalDate(date).ok) fields.date = AVAILABILITY_MESSAGES.dateInvalid;
  else if (date < today || date > addLocalDays(today, BOOKING_HORIZON_DAYS)) fields.date = AVAILABILITY_MESSAGES.outOfHorizon;
  const rawProfessional = own(src, 'professionalId');
  const professional = optionalProfessional(rawProfessional === '' ? undefined : rawProfessional);
  if (!professional.ok) fields.professionalId = AVAILABILITY_MESSAGES.professionalRequired;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { date, professionalId: professional.value } };
}
