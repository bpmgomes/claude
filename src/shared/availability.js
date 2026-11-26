// Regras do cálculo de horários disponíveis compartilhadas entre backend e browser
// (/shared/availability.js, design AF-10 4.2). Módulo puro: só importa ./zoned-time.js e
// ./services.js (também puros). Datas são datas locais do negócio ('YYYY-MM-DD'); `today` vem
// sempre do relógio do servidor, nunca do cliente.
import { parseLocalDate, addLocalDays, wallMinutes } from './zoned-time.js';
import { SERVICE_ID_RE } from './services.js';

/** Passo fixo dos inícios, alinhado ao início de cada janela de trabalho (decisão 1). */
export const SLOT_STEP_MINUTES = 15;
/** Antecedência mínima: início >= agora + 60 min, sem arredondar o limite (decisão 5). */
export const MIN_LEAD_MINUTES = 60;
/** Período máximo por consulta, em dias locais, `to` inclusive (decisão 3). */
export const AVAILABILITY_RANGE_MAX_DAYS = 31;
/** Horizonte: a última data aceita é hoje + 90 (decisão 3). */
export const BOOKING_HORIZON_DAYS = 90;
/** `from` pode ser ontem: página em cache na virada do dia (R9). */
export const PAST_TOLERANCE_DAYS = 1;
/** Teto de inícios por dia: 25 h / 15 min (defesa; a construção do motor nunca chega nele). */
export const AVAILABILITY_SLOTS_PER_DAY_MAX = 100;
/** Valor explícito de "qualquer profissional" (critério 2). */
export const ANY_PROFESSIONAL = 'any';

/** Mensagens fixas: nenhuma interpola a entrada (critérios 3 e 26). */
export const AVAILABILITY_MESSAGES = Object.freeze({
  serviceRequired: 'Escolha um serviço.',
  professionalRequired: 'Escolha um profissional ou Qualquer profissional.',
  dateInvalid: 'Informe uma data válida.',
  rangeInvalid: 'O período deve ter de 1 a 31 dias.',
  outOfHorizon: 'Escolha uma data entre hoje e os próximos 90 dias.',
  unavailable: 'Não foi possível consultar os horários agora. Tente novamente em instantes.',
});

const M = AVAILABILITY_MESSAGES;
const UUID_LENGTH = 36;
const DAY_MINUTES = 1440;

const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const isMissing = (value) => value === undefined || value === '';

/**
 * Identificador vindo da query: ausente ou vazio -> 'missing'; não string (array, parâmetro
 * repetido) -> 'invalid' (erro de campo); string fora do formato -> 'malformed' (404).
 * O comprimento é conferido antes do regex.
 */
function classifyId(raw, { allowAny = false } = {}) {
  if (isMissing(raw)) return { kind: 'missing' };
  if (typeof raw !== 'string') return { kind: 'invalid' };
  if (allowAny && raw === ANY_PROFESSIONAL) return { kind: 'ok', value: raw };
  if (raw.length !== UUID_LENGTH || !SERVICE_ID_RE.test(raw)) return { kind: 'malformed' };
  return { kind: 'ok', value: raw };
}

/**
 * Valida a query do GET. `today` é a data local do negócio no instante atual do servidor
 * (instantToLocal(now, tz).slice(0, 10)): nunca vem do cliente.
 * Antes de qualquer regex, cada valor precisa ser string com o comprimento exato (array e
 * parâmetro repetido dão erro de campo). Com erro de campo e id malformado ao mesmo tempo, a
 * resposta é o erro de campo (400): o 404 só vem com a query bem formada.
 * @param {unknown} query
 * @param {{ today: string }} options
 * @returns {{ ok: true, value: { serviceId: string, professionalId: string, from: string, to: string, days: number } }
 *   | { ok: false, notFound: true }
 *   | { ok: false, fields: Record<string, string> }}
 */
export function validateAvailabilityQuery(query, { today }) {
  const src = query !== null && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const fields = {};
  let notFound = false;

  const service = classifyId(own(src, 'serviceId'));
  if (service.kind === 'missing' || service.kind === 'invalid') fields.serviceId = M.serviceRequired;
  else if (service.kind === 'malformed') notFound = true;

  const professional = classifyId(own(src, 'professionalId'), { allowAny: true });
  if (professional.kind === 'missing' || professional.kind === 'invalid') fields.professionalId = M.professionalRequired;
  else if (professional.kind === 'malformed') notFound = true;

  const rawFrom = own(src, 'from');
  const rawTo = own(src, 'to');
  const from = parseLocalDate(rawFrom);
  if (!from.ok) fields.from = M.dateInvalid;
  const to = isMissing(rawTo) ? from : parseLocalDate(rawTo);
  if (!to.ok && !isMissing(rawTo)) fields.to = M.dateInvalid;

  let days = 0;
  if (from.ok && to.ok) {
    const fromText = rawFrom;
    const toText = isMissing(rawTo) ? rawFrom : rawTo;
    days = (wallMinutes(to.value) - wallMinutes(from.value)) / DAY_MINUTES + 1;
    if (days < 1 || days > AVAILABILITY_RANGE_MAX_DAYS) fields.to = M.rangeInvalid;
    if (fromText < addLocalDays(today, -PAST_TOLERANCE_DAYS)) fields.from = M.outOfHorizon;
    if (!fields.to && toText > addLocalDays(today, BOOKING_HORIZON_DAYS)) fields.to = M.outOfHorizon;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  if (notFound) return { ok: false, notFound: true };
  return {
    ok: true,
    value: {
      serviceId: service.value,
      professionalId: professional.value,
      from: rawFrom,
      to: isMissing(rawTo) ? rawFrom : rawTo,
      days,
    },
  };
}
