import { performance } from 'node:perf_hooks';
import { parsePublicSlug } from '../../shared/slug.js';
import { DEFAULT_TIME_ZONE } from '../../shared/time-blocks.js';
import { instantToLocal, localToInstant, parseLocalDate, addLocalDays } from '../../shared/zoned-time.js';
import {
  validateAvailabilityQuery,
  ANY_PROFESSIONAL,
  MIN_LEAD_MINUTES,
  SLOT_STEP_MINUTES,
  AVAILABILITY_MESSAGES as M,
} from '../../shared/availability.js';
import { NotFoundError, ValidationError, ServiceUnavailableError } from '../../http/errors.js';
import { noAppointments } from '../appointments/appointments-port.js';
import { computeAvailability } from './availability-engine.js';

const noopLog = { info() {}, warn() {}, error() {} };
const MINUTE_MS = 60_000;
/** Acima disso, log `availability_slow` (warn). */
export const AVAILABILITY_SLOW_MS = 200;

/**
 * @typedef {{
 *   timezone: string, now: string, from: string, to: string, durationMinutes: number, stepMinutes: number,
 *   professionals: string[],
 *   days: Array<{ date: string, weekday: number, slots: Array<{ start: string, end: string, professionals: number[] }> }>,
 *   truncated: boolean,
 * }} AvailabilityResponse
 */

/** 00:00 local da data, em ISO UTC de 24 caracteres. */
function midnightIso(date, timeZone) {
  const day = parseLocalDate(date).value;
  return new Date(localToInstant({ ...day, hour: 0, minute: 0 }, timeZone).ms).toISOString();
}

const toMsIntervals = (list) =>
  (Array.isArray(list) ? list : []).map((i) => ({ startMs: Date.parse(i.startsAt), endMs: Date.parse(i.endsAt) }));

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
  /** Falha da porta vira 503: nunca mostrar horário ocupado como livre. */
  async function readBusy(businessId, professionalId, fromIso, toIso) {
    let busy;
    try {
      busy = await appointments.findBusyByBusiness(businessId, { professionalId }, fromIso, toIso);
      if (!(busy instanceof Map)) throw new TypeError('findBusyByBusiness deve devolver um Map.');
    } catch (err) {
      log.warn({ event: 'availability_appointments_failed', businessId, code: err?.code, name: err?.name });
      throw new ServiceUnavailableError('AVAILABILITY_UNAVAILABLE', M.unavailable);
    }
    return busy;
  }

  /** Grade, bloqueios e ocupados dos elegíveis, uma consulta por camada. */
  async function readLayers(businessId, eligible, specificId, fromIso, toIso) {
    if (eligible.length === 0) return [];
    if (specificId) {
      const [weekly, blocks, busy] = await Promise.all([
        workingHoursRepository.findByProfessional(businessId, specificId),
        timeBlocksRepository.findApplicable(businessId, specificId, fromIso, toIso),
        readBusy(businessId, specificId, fromIso, toIso),
      ]);
      return [
        { id: specificId, weekly, blocks: toMsIntervals(blocks), appointments: toMsIntervals(busy.get(specificId)) },
      ];
    }
    const [weeklyById, blocks, busy] = await Promise.all([
      workingHoursRepository.findWeeklyByBusiness(businessId),
      timeBlocksRepository.findApplicableByBusiness(businessId, fromIso, toIso),
      readBusy(businessId, null, fromIso, toIso),
    ]);
    // Os bloqueios de "todos" valem para todo ativo, inclusive criado depois (critério 9).
    const forAll = toMsIntervals(blocks.all);
    return eligible.map((p) => ({
      id: p.id,
      weekly: weeklyById.get(p.id) ?? [],
      blocks: [...forAll, ...toMsIntervals(blocks.byProfessional.get(p.id))],
      appointments: toMsIntervals(busy.get(p.id)),
    }));
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

      // 3. Serviço ativo e profissionais listados na página pública (ativos, com serviço ativo e grade).
      const [service, listed] = await Promise.all([
        servicesRepository.findBookable(business.id, serviceId),
        professionalsRepository.findListedByBusinessId(business.id),
      ]);
      if (!service) throw new NotFoundError();

      // 4. Elegíveis: listados que realizam o serviço (decisão 13).
      let eligible = listed.filter((p) => (p.services || []).some((s) => s.id === serviceId));
      const specificId = professionalId === ANY_PROFESSIONAL ? null : professionalId;
      if (specificId) {
        eligible = eligible.filter((p) => p.id === specificId);
        if (eligible.length === 0) throw new NotFoundError();
      }

      // 5 e 6. Período em instantes (até 32 dias) e as camadas.
      const fromIso = midnightIso(from, timeZone);
      const toIso = midnightIso(addLocalDays(to, 1), timeZone);
      const professionals = await readLayers(business.id, eligible, specificId, fromIso, toIso);

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

      // 8. Serialização: índices na lista de UUIDs elegíveis (R7).
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
        days: result.days.map((day) => ({
          date: day.date,
          weekday: day.weekday,
          slots: day.slots.map((slot) => ({
            start: slot.start,
            end: slot.end,
            professionals: slot.professionalIds.map((id) => indexOf.get(id)),
          })),
        })),
        truncated: result.truncated,
      };
    },
  };
}
