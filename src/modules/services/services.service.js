import { randomUUID } from 'node:crypto';
import {
  validateServiceInput,
  validateStatusFilter,
  hasServiceFields,
  SERVICE_ID_RE,
  SERVICE_MESSAGES,
} from '../../shared/services.js';
import { MESSAGES } from '../../shared/validation.js';
import { UniqueViolationError } from '../../db/errors.js';
import { ValidationError, ConflictError, NotFoundError } from '../../http/errors.js';
import { noAppointments } from './appointments-port.js';

export const SERVICES_PER_BUSINESS_MAX = 100;

const NAME_UNIQUE = 'services_business_id_name_key_unique';

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   servicesRepository: ReturnType<typeof import('./services.repository.js').createServicesRepository>,
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   appointments?: import('./appointments-port.js').AppointmentsPort,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createServicesService({
  db,
  servicesRepository,
  businessesRepository,
  appointments = noAppointments,
  now = () => new Date(),
  log = noopLog,
}) {
  /** O negócio vem sempre da sessão; nunca do cliente. */
  async function businessOf(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new ConflictError('BUSINESS_REQUIRED', SERVICE_MESSAGES.businessRequired);
    return business;
  }

  function notFound() {
    return new NotFoundError('SERVICE_NOT_FOUND', SERVICE_MESSAGES.notFound);
  }

  function checkId(id) {
    if (typeof id !== 'string' || !SERVICE_ID_RE.test(id)) throw notFound();
  }

  async function findOrFail(id, businessId) {
    const service = await servicesRepository.findById(id, businessId);
    if (!service) throw notFound();
    return service;
  }

  /** A constraint é a fonte de verdade; aqui só se escolhe a mensagem do 409. */
  async function translateNameConflict(err, businessId, nameKey) {
    if (!(err instanceof UniqueViolationError) || err.constraint !== NAME_UNIQUE) return err;
    const existing = await servicesRepository.findByNameKey(businessId, nameKey);
    const message = existing && !existing.active ? SERVICE_MESSAGES.nameTakenInactive : SERVICE_MESSAGES.nameTaken;
    return new ConflictError('SERVICE_NAME_TAKEN', message, { name: message });
  }

  return {
    /**
     * @returns {Promise<import('./services.repository.js').Service[]>}
     * @throws {ConflictError|ValidationError}
     */
    async list(ownerId, query) {
      const business = await businessOf(ownerId);
      const filter = validateStatusFilter(query && typeof query === 'object' ? query.status : undefined);
      if (!filter.ok) throw new ValidationError({ status: filter.message });
      return servicesRepository.listByBusinessId(business.id, { status: filter.value });
    },

    /** @throws {ConflictError|NotFoundError} */
    async get(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      return findOrFail(id, business.id);
    },

    /**
     * Cria o serviço. Contagem e INSERT na mesma transação (limite de 100, ativos e desativados).
     * @throws {ValidationError|ConflictError}
     */
    async create(ownerId, input) {
      const business = await businessOf(ownerId);
      const result = validateServiceInput(input);
      if (!result.ok) throw new ValidationError(result.fields);
      const { value } = result;

      const createdAt = now().toISOString();
      const service = {
        id: randomUUID(),
        businessId: business.id,
        name: value.name,
        nameKey: value.nameKey,
        durationMinutes: value.durationMinutes,
        priceCents: value.priceCents,
        priceOnRequest: value.priceOnRequest,
        active: true,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        return await db.transaction(async (tx) => {
          if ((await servicesRepository.countByBusinessId(business.id, tx)) >= SERVICES_PER_BUSINESS_MAX) {
            throw new ConflictError('SERVICE_LIMIT_REACHED', SERVICE_MESSAGES.limitReached);
          }
          return servicesRepository.insert(service, tx);
        });
      } catch (err) {
        throw await translateNameConflict(err, business.id, value.nameKey);
      }
    },

    /**
     * Edição parcial num único UPDATE (última escrita vence; o par preço/sob consulta vai junto).
     * @throws {ValidationError|NotFoundError|ConflictError}
     */
    async update(ownerId, id, input) {
      const business = await businessOf(ownerId);
      checkId(id);
      if (!hasServiceFields(input)) throw new ValidationError({}, MESSAGES.nothingToUpdate);
      const result = validateServiceInput(input, { partial: true });
      if (!result.ok) throw new ValidationError(result.fields);

      let changes;
      try {
        ({ changes } = await servicesRepository.update(id, business.id, {
          ...result.value,
          updatedAt: now().toISOString(),
        }));
      } catch (err) {
        throw await translateNameConflict(err, business.id, result.value.nameKey);
      }
      if (changes === 0) throw notFound();
      return findOrFail(id, business.id);
    },

    /**
     * Desativa sem cancelar nada (decisão 1). Idempotente. Falha ao contar agendamentos futuros
     * não desfaz a desativação: a contagem volta como null.
     * @returns {Promise<{ service: import('./services.repository.js').Service, futureAppointmentsCount: number|null }>}
     */
    async deactivate(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      const nowIso = now().toISOString();
      const { changes } = await servicesRepository.setActive(id, business.id, false, nowIso);
      if (changes === 0) throw notFound();
      let futureAppointmentsCount;
      try {
        futureAppointmentsCount = await appointments.countFutureByService(business.id, id, nowIso);
      } catch {
        log.warn({ event: 'service_future_count_failed', businessId: business.id, serviceId: id });
        futureAppointmentsCount = null;
      }
      const service = await findOrFail(id, business.id);
      return { service, futureAppointmentsCount };
    },

    /** Reativa. Idempotente; sem conflito de nome possível (unicidade cobre desativados). */
    async reactivate(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      const { changes } = await servicesRepository.setActive(id, business.id, true, now().toISOString());
      if (changes === 0) throw notFound();
      return { service: await findOrFail(id, business.id) };
    },
  };
}
