import { PROFESSIONAL_ID_RE } from '../../shared/professionals.js';
import {
  validateHoursInput,
  toOwnerHours,
  HOURS_MESSAGES,
  INTERVALS_PER_PROFESSIONAL_MAX,
} from '../../shared/working-hours.js';
import { ValidationError, ConflictError, NotFoundError } from '../../http/errors.js';
import { noAppointments } from '../appointments/appointments-port.js';

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   workingHoursRepository: ReturnType<typeof import('./working-hours.repository.js').createWorkingHoursRepository>,
 *   professionalsRepository: ReturnType<typeof import('../professionals/professionals.repository.js').createProfessionalsRepository>,
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   appointments?: import('../appointments/appointments-port.js').AppointmentsPort,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createWorkingHoursService({
  db,
  workingHoursRepository,
  professionalsRepository,
  businessesRepository,
  appointments = noAppointments,
  now = () => new Date(), // utc
  log = noopLog,
}) {
  /** O negócio vem sempre da sessão; nunca do cliente. */
  async function businessOf(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new ConflictError('BUSINESS_REQUIRED', HOURS_MESSAGES.businessRequired);
    return business;
  }

  /** Mesma resposta do AF-07: inexistente, de outro negócio e removido não se diferenciam (critério 16). */
  function notFound() {
    return new NotFoundError('PROFESSIONAL_NOT_FOUND', HOURS_MESSAGES.notFound);
  }

  function checkId(id) {
    if (typeof id !== 'string' || !PROFESSIONAL_ID_RE.test(id)) throw notFound();
  }

  async function checkActive(id, businessId) {
    const professional = await professionalsRepository.findById(id, businessId);
    if (!professional) throw notFound();
  }

  async function readHours(businessId, id) {
    return toOwnerHours(await workingHoursRepository.findByProfessional(businessId, id));
  }

  return {
    /**
     * Grade do profissional ativo do negócio: sempre os 7 dias.
     * @returns {Promise<{ days: object[], hasHours: boolean }>}
     * @throws {ConflictError|NotFoundError}
     */
    async get(ownerId, professionalId) {
      const business = await businessOf(ownerId);
      checkId(professionalId);
      await checkActive(professionalId, business.id);
      return readHours(business.id, professionalId);
    },

    /**
     * Substitui por inteiro cada dia enviado, numa transação só (critérios 12 e 13). O aviso de
     * agendamentos afetados é calculado depois do commit; se a porta falhar, vale null e a grade
     * continua gravada (critério 20, padrão do AF-06).
     * @returns {Promise<{ hours: { days: object[], hasHours: boolean }, affectedAppointmentsCount: number|null }>}
     * @throws {ValidationError|NotFoundError|ConflictError}
     */
    async replace(ownerId, professionalId, input) {
      const business = await businessOf(ownerId);
      checkId(professionalId);
      const result = validateHoursInput(input);
      if (!result.ok) throw new ValidationError(result.fields, result.message || HOURS_MESSAGES.checkFields);
      const days = result.value;

      const nowIso = now().toISOString();
      await db.transaction(async (tx) => {
        // UPDATE sem efeito: trava a linha do profissional (serializa contra markRemoved e outro PUT).
        const { changes } = await professionalsRepository.lockActive(professionalId, business.id, tx);
        if (changes === 0) throw notFound();
        await workingHoursRepository.replaceDays(professionalId, business.id, days, nowIso, tx);
        const total = await workingHoursRepository.countByProfessional(professionalId, business.id, tx);
        if (total > INTERVALS_PER_PROFESSIONAL_MAX) {
          throw new ValidationError({}, HOURS_MESSAGES.professionalTooMany);
        }
      });

      let affectedAppointmentsCount;
      try {
        affectedAppointmentsCount = await appointments.countFutureOutsideHours(business.id, professionalId, nowIso);
      } catch {
        log.warn({ event: 'working_hours_affected_count_failed', businessId: business.id, professionalId });
        affectedAppointmentsCount = null;
      }

      log.info({
        event: 'working_hours_replaced',
        userId: ownerId,
        businessId: business.id,
        professionalId,
        weekdays: days.map((d) => d.weekday),
        intervalsCount: days.reduce((sum, d) => sum + d.intervals.length, 0),
        affectedAppointmentsCount,
      });

      return { hours: await readHours(business.id, professionalId), affectedAppointmentsCount };
    },
  };
}
