// Único caminho dos 200 do gerenciar (AF-12, critérios 11 e 12). Módulo puro, no padrão de
// appointments.view.js: só dados de exibição em hora local, nenhum id, nenhum instante UTC, nenhum
// dado do cliente e nenhum token ou hash. As chaves são sempre as mesmas (PUBLIC_MANAGE_FIELDS).
import { formatDuration, formatServicePrice } from '../../shared/services.js';
import { formatPhone } from '../../shared/validation.js';
import { instantToLocal, addLocalDays } from '../../shared/zoned-time.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { BOOKING_HORIZON_DAYS } from '../../shared/availability.js';
import { changeWindow, formatChangePolicy } from '../../shared/appointments.js';
import { isoWeekdayOf } from '../availability/availability-engine.js';
import { appointmentVersionOf } from './manage-token.js';

/** Árvore de chaves do resumo (o teste compara recursivamente). */
export const PUBLIC_MANAGE_FIELDS = Object.freeze({
  root: Object.freeze(['appointment', 'change']),
  appointment: Object.freeze(['start', 'end', 'weekday', 'timezone', 'status', 'service', 'professional', 'business']),
  service: Object.freeze(['name', 'durationMinutes', 'durationLabel', 'priceCents', 'priceOnRequest', 'priceLabel']),
  professional: Object.freeze(['name']),
  business: Object.freeze(['name', 'address', 'phoneDisplay', 'phoneHref', 'pageUrl']),
  change: Object.freeze(['canChange', 'changeDeadline', 'cancellationLeadMinutes', 'policy', 'version', 'reschedule']),
  reschedule: Object.freeze(['allowed', 'sameProfessional', 'notice', 'today', 'maxDate']),
});

/** Árvore de chaves dos horários para remarcar: a do AF-10 sem `professionals` (decisão 11). */
export const PUBLIC_MANAGE_AVAILABILITY_FIELDS = Object.freeze({
  root: Object.freeze(['timezone', 'now', 'from', 'to', 'durationMinutes', 'stepMinutes', 'days', 'truncated']),
  day: Object.freeze(['date', 'weekday', 'slots']),
  slot: Object.freeze(['start', 'end']),
});

function businessOf(business, publicBaseUrl) {
  const digits = String(business.phone ?? '').replace(/\D/g, '');
  return {
    name: business.name,
    address: business.address,
    phoneDisplay: formatPhone(digits),
    phoneHref: `tel:+55${digits}`,
    pageUrl: `${publicBaseUrl}/${business.slug}`,
  };
}

/**
 * Resumo do agendamento do link.
 * @param {{
 *   row: import('./appointments.repository.js').AppointmentRow & { professionalName: string },
 *   business: import('../businesses/businesses.repository.js').Business,
 *   publicBaseUrl: string,
 *   nowMs: number,
 *   reschedule: { allowed: boolean, sameProfessional: boolean, notice: string|null },
 * }} input
 */
export function toPublicManage({ row, business, publicBaseUrl, nowMs, reschedule }) {
  const timezone = business.timezone || DEFAULT_TIME_ZONE;
  const startsAtMs = Date.parse(row.startsAt);
  const start = instantToLocal(startsAtMs, timezone);
  const leadMinutes = business.cancellationLeadMinutes;
  const window = changeWindow({ status: row.status, startsAtMs, nowMs, leadMinutes });
  const priceOnRequest = row.priceCents === null || row.priceCents === undefined;
  const priceCents = priceOnRequest ? null : row.priceCents;
  const today = instantToLocal(nowMs, timezone).slice(0, 10);
  return {
    appointment: {
      start,
      end: instantToLocal(Date.parse(row.endsAt), timezone),
      weekday: isoWeekdayOf(start.slice(0, 10)),
      timezone,
      status: row.status,
      service: {
        name: row.serviceName,
        durationMinutes: row.durationMinutes,
        durationLabel: formatDuration(row.durationMinutes),
        priceCents,
        priceOnRequest,
        priceLabel: formatServicePrice({ priceCents, priceOnRequest }),
      },
      professional: { name: row.professionalName },
      business: businessOf(business, publicBaseUrl),
    },
    change: {
      canChange: window.canChange,
      changeDeadline: instantToLocal(window.deadlineMs, timezone),
      cancellationLeadMinutes: leadMinutes,
      policy: formatChangePolicy(leadMinutes),
      version: appointmentVersionOf(row),
      reschedule: {
        allowed: Boolean(window.canChange && reschedule?.allowed),
        sameProfessional: Boolean(reschedule?.sameProfessional),
        notice: typeof reschedule?.notice === 'string' ? reschedule.notice : null,
        today,
        maxDate: addLocalDays(today, BOOKING_HORIZON_DAYS),
      },
    },
  };
}

/**
 * `manage` do 201 do AF-11 (critério 8): o link e a política vinda do servidor.
 * @param {{ url: string, business: { cancellationLeadMinutes: number } }} input
 */
export function toManageLink({ url, business }) {
  return {
    url,
    cancellationLeadMinutes: business.cancellationLeadMinutes,
    policy: formatChangePolicy(business.cancellationLeadMinutes),
  };
}

/**
 * Horários para remarcar: só as chaves de PUBLIC_MANAGE_AVAILABILITY_FIELDS, horários `{ start, end }`.
 * @param {{ timezone: string, now: string, from: string, to: string, durationMinutes: number,
 *   stepMinutes: number, days: Array<{ date: string, weekday: number, slots: Array<{ start: string, end: string }> }>,
 *   truncated: boolean }} result
 */
export function toPublicManageAvailability(result) {
  return {
    timezone: result.timezone,
    now: result.now,
    from: result.from,
    to: result.to,
    durationMinutes: result.durationMinutes,
    stepMinutes: result.stepMinutes,
    days: result.days.map((day) => ({
      date: day.date,
      weekday: day.weekday,
      slots: day.slots.map((slot) => ({ start: slot.start, end: slot.end })),
    })),
    truncated: result.truncated,
  };
}
