import { performance } from 'node:perf_hooks';
import { parsePublicSlug } from '../../shared/slug.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import {
  instantToLocal,
  localToInstant,
  parseLocalDate,
  parseLocalDateTime,
  addLocalDays,
} from '../../shared/zoned-time.js';
import {
  validateAvailabilityQuery,
  ANY_PROFESSIONAL,
  MIN_LEAD_MINUTES,
  SLOT_STEP_MINUTES,
  BOOKING_HORIZON_DAYS,
  AVAILABILITY_MESSAGES as M,
} from '../../shared/availability.js';
import { BOOKING_SUGGESTIONS_MAX, BOOKING_SUGGESTIONS_DAYS } from '../../shared/appointments.js';
import { NotFoundError, ValidationError, ServiceUnavailableError } from '../../http/errors.js';
import { noAppointments } from '../appointments/appointments-port.js';
import { computeAvailability } from './availability-engine.js';
import { resolveBookable } from './bookable.js';
import { readLayers, BusyUnavailableError } from './availability-layers.js';

const noopLog = { info() {}, warn() {}, error() {} };
const MINUTE_MS = 60_000;
/** Acima disso, log `availability_slow` (warn). */
export const AVAILABILITY_SLOW_MS = 200;

/**
 * @typedef {{
 *   timezone: string, now: string, from: string, to: string, durationMinutes: number, stepMinutes: number,
 *   professionals: string[],
 *   days: Array<{ date: string, weekday: number, slots: Array<{ start: string, end: string, professionals?: number[] }> }>,
 *   truncated: boolean,
 * }} AvailabilityResponse
 */

/** 00:00 local da data, em ISO UTC de 24 caracteres (sem presumir 24 h por dia). */
export function midnightIso(date, timeZone) {
  const day = parseLocalDate(date).value;
  return new Date(localToInstant({ ...day, hour: 0, minute: 0 }, timeZone).ms).toISOString();
}

/**
 * `days` da resposta: com `specificId`, cada horário leva os índices dos profissionais livres na
 * lista de elegíveis (`indexOf`); sem, só `{ start, end }` (AF-11, decisão 4).
 */
function serializeDays(result, { specificId, indexOf }) {
  return result.days.map((day) => ({
    date: day.date,
    weekday: day.weekday,
    slots: day.slots.map((slot) =>
      specificId
        ? { start: slot.start, end: slot.end, professionals: slot.professionalIds.map((id) => indexOf.get(id)) }
        : { start: slot.start, end: slot.end },
    ),
  }));
}

/**
 * Horários disponíveis da página pública (design AF-10, 5.1). Somente leitura e sem transação: a
 * disponibilidade é uma fotografia, e a autoridade é a checagem transacional do AF-11.
 * No máximo 7 consultas (6 até o AF-11), independentes do número de profissionais e de dias.
 * @param {{
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   servicesRepository: ReturnType<typeof import('../services/services.repository.js').createServicesRepository>,
 *   professionalsRepository: ReturnType<typeof import('../professionals/professionals.repository.js').createProfessionalsRepository>,
 *   workingHoursRepository: ReturnType<typeof import('../working-hours/working-hours.repository.js').createWorkingHoursRepository>,
 *   timeBlocksRepository: ReturnType<typeof import('../time-blocks/time-blocks.repository.js').createTimeBlocksRepository>,
 *   appointments?: import('../appointments/appointments-port.js').AppointmentsPort,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 *   engine?: typeof computeAvailability,   // os testes trocam o motor (log de lentidão)
 *   perfNow?: () => number,                // relógio de medição (ms), padrão performance.now
 * }} deps
 */
export function createAvailabilityService({
  businessesRepository,
  servicesRepository,
  professionalsRepository,
  workingHoursRepository,
  timeBlocksRepository,
  appointments = noAppointments,
  now = () => new Date(),
  log = noopLog,
  engine = computeAvailability,
  perfNow = () => performance.now(),
}) {
  const layersDeps = { workingHoursRepository, timeBlocksRepository, appointments };
  const bookableDeps = { servicesRepository, professionalsRepository };

  /** Falha da porta vira 503: nunca mostrar horário ocupado como livre. */
  async function readLayersOr503(businessId, eligible, specificId, fromIso, toIso, options) {
    try {
      return await readLayers(layersDeps, businessId, eligible, specificId, fromIso, toIso, undefined, options);
    } catch (err) {
      if (!(err instanceof BusyUnavailableError)) throw err;
      log.warn({
        event: 'availability_appointments_failed',
        businessId,
        errCode: err.cause?.code,
        errName: err.cause?.name,
      });
      throw new ServiceUnavailableError('AVAILABILITY_UNAVAILABLE', M.unavailable);
    }
  }

  return {
    /**
     * @param {string} rawSlug request.params.slug, ainda não validado
     * @param {unknown} query
     * @returns {Promise<AvailabilityResponse>}
     * @throws {NotFoundError} corpo padrão NOT_FOUND
     * @throws {ValidationError} fields de AVAILABILITY_MESSAGES
     * @throws {ServiceUnavailableError} AVAILABILITY_UNAVAILABLE
     */
    async getAvailability(rawSlug, query) {
      // 1. Formato do slug, sem banco. Maiúsculas também dão 404: a API não redireciona.
      const parsed = parsePublicSlug(rawSlug);
      if (parsed.kind !== 'ok') throw new NotFoundError();

      // 2. O fuso vem do negócio, mas o 400 vale antes do 404 (mesma regra para slug inexistente).
      const nowMs = now().getTime();
      const business = await businessesRepository.findBySlug(parsed.slug);
      const timeZone = business?.timezone ?? DEFAULT_TIME_ZONE;
      const today = instantToLocal(nowMs, timeZone).slice(0, 10);
      const checked = validateAvailabilityQuery(query, { today });
      if (!checked.ok && checked.fields) throw new ValidationError(checked.fields);
      if (!checked.ok || !business) throw new NotFoundError();
      const { serviceId, professionalId, from, to } = checked.value;

      // 3 e 4. Serviço ativo e elegíveis: listados na página pública que realizam o serviço
      // (decisão 13). Serviço sem elegível (oculto da página) é 404 (AF-11, decisão 5).
      const { service, eligible } = await resolveBookable(bookableDeps, business.id, { serviceId, professionalId });
      const specificId = professionalId === ANY_PROFESSIONAL ? null : professionalId;

      // 5 e 6. Período em instantes (até 32 dias) e as camadas.
      const fromIso = midnightIso(from, timeZone);
      const toIso = midnightIso(addLocalDays(to, 1), timeZone);
      const professionals = await readLayersOr503(business.id, eligible, specificId, fromIso, toIso);

      // 7. Cálculo.
      const startedAt = perfNow();
      const result = engine({
        timeZone,
        fromDate: from,
        toDate: to,
        durationMinutes: service.durationMinutes,
        notBeforeMs: nowMs + MIN_LEAD_MINUTES * MINUTE_MS,
        professionals,
      });
      const durationMs = perfNow() - startedAt;
      if (durationMs > AVAILABILITY_SLOW_MS) {
        log.warn({
          event: 'availability_slow',
          businessId: business.id,
          days: checked.value.days,
          professionalsCount: professionals.length,
          durationMs: Math.round(durationMs),
        });
      }

      // 8. Serialização: índices na lista de UUIDs elegíveis (R7). Em "qualquer profissional", o
      // horário não diz quem está livre (AF-11, decisão 4: sem inferência de ocupação).
      const ids = eligible.map((p) => p.id);
      const indexOf = new Map(ids.map((id, i) => [id, i]));
      return {
        timezone: timeZone,
        now: instantToLocal(nowMs, timeZone),
        from,
        to,
        durationMinutes: service.durationMinutes,
        stepMinutes: SLOT_STEP_MINUTES,
        professionals: ids,
        days: serializeDays(result, { specificId, indexOf }),
        truncated: result.truncated,
      };
    },

    /**
     * Horários de UM dia para remarcar (AF-12, critério 24): as regras do AF-10 (antecedência de 1 h,
     * grade, bloqueios, ocupados) para o mesmo serviço, com o agendamento `excludeAppointmentId`
     * fora dos ocupados. Mesmo formato do AF-10 sem `professionals`, e horários sempre `{ start, end }`.
     * Somente leitura, fora de transação; quem decide é o reschedule, na transação.
     * @param {{ business: { id: string, timezone: string }, serviceId: string, professionalId: string,
     *   date: string, nowMs: number, excludeAppointmentId: string }} args `professionalId`: UUID ou 'any'
     * @throws {NotFoundError} serviço/profissional não reservável (o manage traduz em 409)
     * @throws {ServiceUnavailableError} AVAILABILITY_UNAVAILABLE (o manage traduz em MANAGE_UNAVAILABLE)
     */
    async findForReschedule({ business, serviceId, professionalId, date, nowMs, excludeAppointmentId }) {
      const timeZone = business.timezone || DEFAULT_TIME_ZONE;
      const { service, eligible } = await resolveBookable(bookableDeps, business.id, { serviceId, professionalId });
      const specificId = professionalId === ANY_PROFESSIONAL ? null : professionalId;
      const fromIso = midnightIso(date, timeZone);
      const toIso = midnightIso(addLocalDays(date, 1), timeZone);
      const professionals = await readLayersOr503(business.id, eligible, specificId, fromIso, toIso, { excludeAppointmentId });
      const result = engine({
        timeZone,
        fromDate: date,
        toDate: date,
        durationMinutes: service.durationMinutes,
        notBeforeMs: nowMs + MIN_LEAD_MINUTES * MINUTE_MS,
        professionals,
      });
      return {
        timezone: timeZone,
        now: instantToLocal(nowMs, timeZone),
        from: date,
        to: date,
        durationMinutes: service.durationMinutes,
        stepMinutes: SLOT_STEP_MINUTES,
        days: serializeDays(result, { specificId: null }),
        truncated: result.truncated,
      };
    },

    /**
     * Até `limit` inícios livres estritamente depois de `afterStart`, do dia de `afterStart` até
     * BOOKING_SUGGESTIONS_DAYS - 1 dias depois, sem passar de hoje + 90 (AF-11, critério 16). Mesmo
     * serviço; com um UUID, o mesmo profissional; com 'any', qualquer elegível (um início conta uma
     * vez). Fora de transação, sem trava. Falha da porta, 404 (o serviço sumiu nesse meio-tempo) ou
     * erro de leitura: [] com log warn.
     * `excludeAppointmentId` (AF-12): o agendamento sendo remarcado não ocupa.
     * @param {{ business: { id: string, timezone: string }, serviceId: string, professionalId: string,
     *   afterStart: string, nowMs: number, limit?: number, leadMinutes?: number,
     *   excludeAppointmentId?: string|null }} args
     * @returns {Promise<Array<{ start: string, end: string }>>}
     */
    async findSuggestions({
      business,
      serviceId,
      professionalId,
      afterStart,
      nowMs,
      limit = BOOKING_SUGGESTIONS_MAX,
      leadMinutes = MIN_LEAD_MINUTES,
      excludeAppointmentId = null,
    }) {
      try {
        const timeZone = business.timezone || DEFAULT_TIME_ZONE;
        const parsed = parseLocalDateTime(afterStart);
        if (!parsed.ok) return [];
        const { service, eligible } = await resolveBookable(bookableDeps, business.id, { serviceId, professionalId });
        const specificId = professionalId === ANY_PROFESSIONAL ? null : professionalId;
        const today = instantToLocal(nowMs, timeZone).slice(0, 10);
        const date = afterStart.slice(0, 10);
        const horizon = addLocalDays(today, BOOKING_HORIZON_DAYS);
        const window = addLocalDays(date, BOOKING_SUGGESTIONS_DAYS - 1);
        const lastDate = window < horizon ? window : horizon;
        if (date > lastDate) return [];
        const fromIso = midnightIso(date, timeZone);
        const toIso = midnightIso(addLocalDays(lastDate, 1), timeZone);
        const professionals = await readLayers(layersDeps, business.id, eligible, specificId, fromIso, toIso, undefined, {
          excludeAppointmentId,
        });
        const result = engine({
          timeZone,
          fromDate: date,
          toDate: lastDate,
          durationMinutes: service.durationMinutes,
          notBeforeMs: nowMs + leadMinutes * MINUTE_MS,
          professionals,
        });
        const afterMs = localToInstant(parsed.value, timeZone).ms;
        const out = [];
        for (const day of result.days) {
          for (const slot of day.slots) {
            if (slot.startMs <= afterMs) continue;
            out.push({ start: slot.start, end: slot.end });
            if (out.length >= limit) return out;
          }
        }
        return out;
      } catch (err) {
        log.warn({
          event: 'appointment_suggestions_failed',
          businessId: business?.id,
          errCode: (err?.cause ?? err)?.code,
          errName: (err?.cause ?? err)?.name,
        });
        return [];
      }
    },
  };
}
