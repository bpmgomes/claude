// Regras da agenda do dono (AF-14, design 4.2), compartilhadas entre backend e browser
// (/shared/agenda.js). Módulo puro: só importa ./zoned-time.js e ./professionals.js (também puros).
// ./appointments.js fica FORA do grafo do navegador (orçamento do AF-09): a lista de status é
// repetida aqui e um teste confere que é igual a APPOINTMENT_STATUSES. Datas são 'YYYY-MM-DD' locais
// do negócio, tratadas como texto; nada aqui usa o fuso do processo nem do navegador.
import { parseLocalDate, addLocalDays, wallMinutes } from './zoned-time.js';
import { PROFESSIONAL_ID_RE } from './professionals.js';

export const AGENDA_RANGE_MAX_DAYS = 7;
/** Janela: hoje − 366 ... */
export const AGENDA_PAST_DAYS = 366;
/** ... a hoje + 400 (decisão 8 do Gerente). */
export const AGENDA_FUTURE_DAYS = 400;
/** Itens por resposta, somando todos os dias (decisão 8 do Gerente). */
export const AGENDA_ITEMS_MAX = 1000;
/** = APPOINTMENT_STATUSES (teste). */
export const AGENDA_STATUSES = Object.freeze(['confirmed', 'cancelled', 'completed', 'no_show']);
/** = CHECK `appointments_cancelled_by_check` da migração 014 (teste). */
export const CANCELLED_BY = Object.freeze(['customer', 'owner', 'reschedule']);
/** Valor de "Todos os profissionais" no filtro. */
export const AGENDA_ALL_PROFESSIONALS = 'all';

/** Mensagens fixas: nenhuma interpola a entrada. */
export const AGENDA_MESSAGES = Object.freeze({
  checkFields: 'Verifique os campos destacados.',
  dateInvalid: 'Informe uma data válida.',
  datePairRequired: 'Informe as duas datas do período.',
  rangeInvalid: 'O período deve ter de 1 a 7 dias.',
  outOfWindow: 'Escolha uma data de até 1 ano atrás até 400 dias à frente.',
  professionalInvalid: 'Escolha um profissional ou Todos os profissionais.',
  includeCancelledInvalid: 'Valor inválido.',
  businessRequired: 'Cadastre seu negócio antes de ver a agenda.',
  notFound: 'Agendamento não encontrado.',
  unavailable: 'Não foi possível carregar a agenda agora. Tente novamente em instantes.',
  cancelUnavailable: 'Não foi possível cancelar agora. Tente novamente em instantes.',
  changed: 'Este agendamento mudou desde que a agenda foi carregada. Confira a situação atual.',
  notChangeable: 'Este agendamento não pode ser cancelado: ele já terminou ou não está confirmado.',
  badRequest: 'Requisição inválida.',
});

/**
 * Mapa FIXO de exibição (critérios 31 e 36), indexado pela chave de exibição, nunca por dado.
 * `{ label, icon, className }`; `icon` é um caractere decorativo (aria-hidden na tela).
 */
export const AGENDA_STATUS_DISPLAY = Object.freeze({
  confirmed: Object.freeze({ label: 'Confirmado', icon: '✓', className: 'ag-status-confirmed' }),
  completed: Object.freeze({ label: 'Concluído', icon: '★', className: 'ag-status-completed' }),
  cancelled: Object.freeze({ label: 'Cancelado', icon: '✕', className: 'ag-status-cancelled' }),
  rescheduled: Object.freeze({ label: 'Remarcado', icon: '↻', className: 'ag-status-rescheduled' }),
  no_show: Object.freeze({ label: 'Não compareceu', icon: '!', className: 'ag-status-no-show' }),
  block: Object.freeze({ label: 'Bloqueado', icon: '⊘', className: 'ag-status-block' }),
  unknown: Object.freeze({ label: 'Situação desconhecida', icon: '?', className: 'ag-status-unknown' }),
});

export const CANCELLED_BY_LABELS = Object.freeze({
  customer: 'Cancelado pelo cliente',
  owner: 'Cancelado pelo estabelecimento',
  reschedule: 'Remarcado pelo cliente',
});

const MINUTES_PER_DAY = 1440;
const UUID_LENGTH = 36;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

/**
 * 'block' | 'rescheduled' (cancelled + by reschedule) | status conhecido | 'unknown'. Nunca lança.
 * @param {unknown} item
 * @returns {string} chave de AGENDA_STATUS_DISPLAY
 */
export function displayKeyOf(item) {
  if (!isObject(item)) return 'unknown';
  if (item.type === 'block') return 'block';
  const status = item.status;
  if (typeof status !== 'string' || !AGENDA_STATUSES.includes(status)) return 'unknown';
  if (status === 'cancelled' && isObject(item.cancelled) && item.cancelled.by === 'reschedule') return 'rescheduled';
  return status;
}

/**
 * ISO 1 (segunda) a 7 (domingo) para 'YYYY-MM-DD'; 0 para data inválida. Dias corridos, sem fuso
 * (= isoWeekdayOf do motor, teste).
 * @param {unknown} date
 * @returns {number}
 */
export function isoWeekdayOfDate(date) {
  const parsed = parseLocalDate(date);
  if (!parsed.ok) return 0;
  // 1970-01-01 (dia 0) foi quinta-feira (ISO 4).
  const days = wallMinutes(parsed.value) / MINUTES_PER_DAY;
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/**
 * Segunda-feira da semana ISO da data (decisão 8 do Gerente). '' para data inválida. Pode cair em
 * 1999-12-27 (semana de 2000-01-01): addLocalDays só valida a data de entrada.
 * @param {unknown} date
 * @returns {string}
 */
export function startOfIsoWeek(date) {
  const weekday = isoWeekdayOfDate(date);
  if (weekday === 0) return '';
  return addLocalDays(date, -(weekday - 1));
}

/** Dias entre duas datas válidas (to − from), em minutos de parede. */
function daysBetween(from, to) {
  const a = parseLocalDate(from).value;
  const b = parseLocalDate(to).value;
  return Math.round((wallMinutes(b) - wallMinutes(a)) / MINUTES_PER_DAY);
}

/**
 * Query do GET /api/agenda (C-1, C-2). `today` é a data local do negócio no instante do servidor.
 * - `from`/`to`: os dois ausentes (ou vazios) valem hoje, um dia; só um dos dois: 400.
 * - `professionalId`: ausente ou vazio = 'all'; 'all' ou UUID v4 (comprimento antes do regex).
 * - `includeCancelled`: ausente = false; só 'true'/'false' (igualdade estrita).
 * Outras chaves são ignoradas. Nenhuma mensagem contém o valor recebido.
 * @param {unknown} query
 * @param {{ today: string }} options
 * @returns {{ ok: true, value: { from: string, to: string, dates: string[], professionalId: string,
 *   includeCancelled: boolean } } | { ok: false, fields: Record<string, string> }}
 */
export function validateAgendaQuery(query, { today }) {
  const src = isObject(query) ? query : {};
  const M = AGENDA_MESSAGES;
  const fields = {};

  const present = (v) => v !== undefined && v !== '';
  const rawFrom = own(src, 'from');
  const rawTo = own(src, 'to');
  let from = null;
  let to = null;
  if (!present(rawFrom) && !present(rawTo)) {
    from = today;
    to = today;
  } else {
    if (!present(rawFrom)) fields.from = M.datePairRequired;
    else if (parseLocalDate(rawFrom).ok) from = rawFrom;
    else fields.from = M.dateInvalid;
    if (!present(rawTo)) fields.to = M.datePairRequired;
    else if (parseLocalDate(rawTo).ok) to = rawTo;
    else fields.to = M.dateInvalid;
  }
  if (from !== null && to !== null) {
    const span = daysBetween(from, to) + 1;
    if (span < 1 || span > AGENDA_RANGE_MAX_DAYS) fields.to = M.rangeInvalid;
    else {
      const min = addLocalDays(today, -AGENDA_PAST_DAYS);
      const max = addLocalDays(today, AGENDA_FUTURE_DAYS);
      // Strings 'YYYY-MM-DD' de largura fixa: a comparação de texto é a cronológica.
      if (from < min || from > max) fields.from = M.outOfWindow;
      if (to < min || to > max) fields.to = M.outOfWindow;
    }
  }

  let professionalId = AGENDA_ALL_PROFESSIONALS;
  const rawProfessional = own(src, 'professionalId');
  if (rawProfessional !== undefined && rawProfessional !== '' && rawProfessional !== AGENDA_ALL_PROFESSIONALS) {
    if (typeof rawProfessional === 'string' && rawProfessional.length === UUID_LENGTH && PROFESSIONAL_ID_RE.test(rawProfessional)) {
      professionalId = rawProfessional;
    } else fields.professionalId = M.professionalInvalid;
  }

  let includeCancelled = false;
  const rawInclude = own(src, 'includeCancelled');
  if (rawInclude === 'true') includeCancelled = true;
  else if (rawInclude !== undefined && rawInclude !== 'false') fields.includeCancelled = M.includeCancelledInvalid;

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  const dates = [];
  for (let i = 0, d = from; i < AGENDA_RANGE_MAX_DAYS && d && d <= to; i++, d = addLocalDays(d, 1)) dates.push(d);
  return { ok: true, value: { from, to, dates, professionalId, includeCancelled } };
}
