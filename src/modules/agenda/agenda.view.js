// Único caminho de serialização da agenda do dono (AF-14, design 4.3). Módulo puro: só dados de
// exibição em hora local do negócio, nunca instantes UTC, `customer_id`, `business_id`, `service_id`,
// token ou hash do AF-12. As chaves são sempre as mesmas (OWNER_AGENDA_FIELDS e
// OWNER_AGENDA_DETAIL_FIELDS; o teste compara a árvore).
import { formatDuration, formatServicePrice } from '../../shared/services.js';
import { formatPhone } from '../../shared/validation.js';
import { instantToLocal } from '../../shared/zoned-time.js';
import { toOwnerTimeBlock } from '../../shared/time-blocks.js';
import { isoWeekdayOfDate } from '../../shared/agenda.js';
import { appointmentVersionOf } from '../appointments/manage-token.js';

export const OWNER_AGENDA_FIELDS = Object.freeze({
  root: Object.freeze(['timezone', 'now', 'from', 'to', 'days', 'truncated']),
  day: Object.freeze(['date', 'weekday', 'counts', 'items']),
  counts: Object.freeze(['active', 'cancelled', 'rescheduled']),
  appointment: Object.freeze(['type', 'id', 'version', 'start', 'end', 'status', 'customerName', 'serviceName', 'professional', 'cancelled']),
  professional: Object.freeze(['id', 'name', 'removed']),
  cancelled: Object.freeze(['by', 'at']),
  block: Object.freeze(['type', 'id', 'start', 'end', 'allDay', 'professional', 'reason']),
  blockProfessional: Object.freeze(['id', 'name']),
  reason: Object.freeze(['kind', 'note']),
});

export const OWNER_AGENDA_DETAIL_FIELDS = Object.freeze({
  // O cancelamento acrescenta 'outcome' à raiz.
  root: Object.freeze(['timezone', 'now', 'emailEnabled', 'appointment']),
  appointment: Object.freeze([
    'id',
    'version',
    'start',
    'end',
    'weekday',
    'status',
    'createdAt',
    'service',
    'professional',
    'customer',
    'cancelled',
    'rescheduledFrom',
    'rescheduledTo',
    'canCancel',
  ]),
  service: Object.freeze(['name', 'durationMinutes', 'durationLabel', 'priceCents', 'priceOnRequest', 'priceLabel']),
  professional: Object.freeze(['id', 'name', 'removed']),
  customer: Object.freeze(['name', 'phoneDisplay', 'phoneHref', 'email']),
  cancelled: Object.freeze(['by', 'at']),
  chainLink: Object.freeze(['start']),
});

const local = (iso, timeZone) => instantToLocal(Date.parse(iso), timeZone);
const str = (v) => (typeof v === 'string' ? v : '');

/** `{ by, at }` de um cancelado, ou null. `by` nulo para os cancelados antes do AF-14. */
function cancelledOf(row, timeZone) {
  if (row.status !== 'cancelled') return null;
  return {
    by: typeof row.cancelledBy === 'string' ? row.cancelledBy : null,
    at: typeof row.cancelledAt === 'string' ? local(row.cancelledAt, timeZone) : null,
  };
}

/**
 * Linha de `listForAgenda` -> item da lista. `version` = appointmentVersionOf (AF-12).
 * @param {{ id: string, professionalId: string, professionalName: string, professionalRemoved: boolean,
 *   serviceName: string, customerName: string, startsAt: string, endsAt: string, status: string,
 *   updatedAt: string, cancelledAt: string|null, cancelledBy: string|null }} row
 * @param {string} timeZone
 */
export function toOwnerAgendaAppointment(row, timeZone) {
  return {
    type: 'appointment',
    id: row.id,
    version: appointmentVersionOf(row),
    start: local(row.startsAt, timeZone),
    end: local(row.endsAt, timeZone),
    status: row.status,
    customerName: str(row.customerName),
    serviceName: str(row.serviceName),
    professional: { id: row.professionalId, name: str(row.professionalName), removed: Boolean(row.professionalRemoved) },
    cancelled: cancelledOf(row, timeZone),
  };
}

/**
 * Bloqueio do AF-16 -> item da lista: o `toOwnerTimeBlock` sem `startsAt`/`endsAt`/`createdAt`.
 * @param {import('../time-blocks/time-blocks.repository.js').TimeBlockRow} block
 * @param {string} timeZone
 */
export function toOwnerAgendaBlock(block, timeZone) {
  const b = toOwnerTimeBlock(block, timeZone);
  return {
    type: 'block',
    id: b.id,
    start: b.start,
    end: b.end,
    allDay: b.allDay,
    professional: b.professional ? { id: b.professional.id, name: str(b.professional.name) } : null,
    reason: b.reason ? { kind: b.reason.kind, note: b.reason.note ?? null } : null,
  };
}

/**
 * Detalhe do agendamento para o dono (critério 17). Nome e telefone do SNAPSHOT do agendamento;
 * e-mail de `customers` (o canônico do AF-18). `phoneHref` só com os dígitos do snapshot.
 * @param {{ row: object, customer: { email: string }|undefined, previous: object|undefined|null,
 *   next: object|undefined|null, timeZone: string, nowMs: number, emailEnabled: boolean }} input
 */
export function toOwnerAppointmentDetail({ row, customer, previous, next, timeZone, nowMs, emailEnabled }) {
  const start = local(row.startsAt, timeZone);
  const digits = String(row.customerPhone ?? '').replace(/\D/g, '');
  const priceOnRequest = row.priceCents === null || row.priceCents === undefined;
  const priceCents = priceOnRequest ? null : row.priceCents;
  return {
    timezone: timeZone,
    now: instantToLocal(nowMs, timeZone),
    emailEnabled: Boolean(emailEnabled),
    appointment: {
      id: row.id,
      version: appointmentVersionOf(row),
      start,
      end: local(row.endsAt, timeZone),
      weekday: isoWeekdayOfDate(start.slice(0, 10)),
      status: row.status,
      createdAt: local(row.createdAt, timeZone),
      service: {
        name: str(row.serviceName),
        durationMinutes: row.durationMinutes,
        durationLabel: formatDuration(row.durationMinutes),
        priceCents,
        priceOnRequest,
        priceLabel: formatServicePrice({ priceCents, priceOnRequest }),
      },
      professional: { id: row.professionalId, name: str(row.professionalName), removed: Boolean(row.professionalRemoved) },
      customer: {
        name: str(row.customerName),
        phoneDisplay: formatPhone(digits),
        phoneHref: `tel:+55${digits}`,
        email: customer && typeof customer.email === 'string' ? customer.email : null,
      },
      cancelled: cancelledOf(row, timeZone),
      rescheduledFrom: previous ? { start: local(previous.startsAt, timeZone) } : null,
      rescheduledTo: next ? { start: local(next.startsAt, timeZone) } : null,
      canCancel: row.status === 'confirmed' && Date.parse(row.endsAt) > nowMs,
    },
  };
}

/**
 * Dias com `counts` zerados e `items` vazios (professionalId de outro negócio, inexistente ou
 * removido: C-2, sem diferenciar os casos).
 * @param {string[]} dates
 */
export function emptyAgendaDays(dates) {
  return dates.map((date) => ({
    date,
    weekday: isoWeekdayOfDate(date),
    counts: { active: 0, cancelled: 0, rescheduled: 0 },
    items: [],
  }));
}
