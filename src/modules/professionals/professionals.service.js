import { randomUUID } from 'node:crypto';
import {
  validateProfessionalInput,
  hasProfessionalFields,
  PROFESSIONAL_ID_RE,
  PROFESSIONAL_MESSAGES,
} from '../../shared/professionals.js';
import { MESSAGES } from '../../shared/validation.js';
import {
  ValidationError,
  ConflictError,
  NotFoundError,
  InvalidImageError,
  ImageBusyError,
  ProfessionalHasAppointmentsError,
} from '../../http/errors.js';
import { noAppointments } from '../appointments/appointments-port.js';
import { processSquareImage } from '../../images/square-image.js';
import { unlimitedImageLimiter } from '../../images/image-limiter.js';

/** Regra de negócio (decisão 8): só profissionais ativos contam. */
export const PROFESSIONALS_PER_BUSINESS_MAX = 50;

export const NAME_DUPLICATE_WARNING = Object.freeze({
  code: 'PROFESSIONAL_NAME_DUPLICATE',
  field: 'name',
  message: PROFESSIONAL_MESSAGES.nameDuplicate,
});

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   professionalsRepository: ReturnType<typeof import('./professionals.repository.js').createProfessionalsRepository>,
 *   businessesRepository: ReturnType<typeof import('../businesses/businesses.repository.js').createBusinessesRepository>,
 *   storage: import('../../storage/index.js').Storage,
 *   appointments?: import('../appointments/appointments-port.js').AppointmentsPort,
 *   processImage?: (buffer: Buffer) => Promise<Buffer>,
 *   imageLimiter?: { run<T>(task: () => Promise<T>): Promise<T> },
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createProfessionalsService({
  db,
  professionalsRepository,
  businessesRepository,
  storage,
  appointments = noAppointments,
  processImage = processSquareImage,
  imageLimiter = unlimitedImageLimiter,
  now = () => new Date(),
  log = noopLog,
}) {
  /** O negócio vem sempre da sessão; nunca do cliente. */
  async function businessOf(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new ConflictError('BUSINESS_REQUIRED', PROFESSIONAL_MESSAGES.businessRequired);
    return business;
  }

  function notFound() {
    return new NotFoundError('PROFESSIONAL_NOT_FOUND', PROFESSIONAL_MESSAGES.notFound);
  }

  function checkId(id) {
    if (typeof id !== 'string' || !PROFESSIONAL_ID_RE.test(id)) throw notFound();
  }

  async function findOrFail(id, businessId) {
    const professional = await professionalsRepository.findById(id, businessId);
    if (!professional) throw notFound();
    return professional;
  }

  /** Inexistente e de outro negócio dão o mesmo erro (critério 6). */
  async function checkServiceIds(businessId, serviceIds, tx) {
    if (serviceIds.length === 0) return;
    const found = await professionalsRepository.findServiceIdsOfBusiness(businessId, serviceIds, tx);
    if (serviceIds.some((id) => !found.has(id))) {
      throw new ValidationError({ serviceIds: PROFESSIONAL_MESSAGES.serviceIdsInvalid });
    }
  }

  async function duplicateWarnings(businessId, nameKey, id, tx) {
    const same = await professionalsRepository.countSameName(businessId, nameKey, id, tx);
    return same > 0 ? [{ ...NAME_DUPLICATE_WARNING }] : [];
  }

  const event = (name, ownerId, businessId, professionalId, extra = {}) =>
    log.info({ event: name, userId: ownerId, businessId, professionalId, ...extra });

  /** Apaga a chave substituída em best effort: ela já não é servida (não está no banco). */
  async function cleanup(previousKey) {
    if (!previousKey) return;
    try {
      await storage.delete(previousKey);
    } catch {
      log.warn({ event: 'professional_photo_cleanup_failed', key: previousKey });
    }
  }

  return {
    /** @returns {Promise<import('./professionals.repository.js').Professional[]>} */
    async list(ownerId) {
      const business = await businessOf(ownerId);
      return professionalsRepository.listByBusinessId(business.id);
    },

    /** @throws {ConflictError|NotFoundError} */
    async get(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      return findOrFail(id, business.id);
    },

    /**
     * Cria o profissional. Limite, validação dos serviços, INSERT e vínculos numa transação só.
     * @returns {Promise<{ professional: import('./professionals.repository.js').Professional, warnings: object[] }>}
     * @throws {ValidationError|ConflictError}
     */
    async create(ownerId, input) {
      const business = await businessOf(ownerId);
      const result = validateProfessionalInput(input);
      if (!result.ok) throw new ValidationError(result.fields);
      const { name, nameKey, serviceIds } = result.value;

      const id = randomUUID();
      const createdAt = now().toISOString();
      const warnings = await db.transaction(async (tx) => {
        const active = await professionalsRepository.countActiveByBusinessId(business.id, tx);
        if (active >= PROFESSIONALS_PER_BUSINESS_MAX) {
          throw new ConflictError('PROFESSIONAL_LIMIT_REACHED', PROFESSIONAL_MESSAGES.limitReached);
        }
        await checkServiceIds(business.id, serviceIds, tx);
        await professionalsRepository.insert({ id, businessId: business.id, name, nameKey, createdAt }, tx);
        await professionalsRepository.replaceServices(id, business.id, serviceIds, createdAt, tx);
        return duplicateWarnings(business.id, nameKey, id, tx);
      });
      event('professional_created', ownerId, business.id, id);
      return { professional: await findOrFail(id, business.id), warnings };
    },

    /**
     * Edição parcial numa transação só (última escrita vence por inteiro, critério 27).
     * `serviceIds`, se vier, substitui a lista inteira.
     * @returns {Promise<{ professional: import('./professionals.repository.js').Professional, warnings: object[] }>}
     * @throws {ValidationError|NotFoundError|ConflictError}
     */
    async update(ownerId, id, input) {
      const business = await businessOf(ownerId);
      checkId(id);
      if (!hasProfessionalFields(input)) throw new ValidationError({}, MESSAGES.nothingToUpdate);
      const result = validateProfessionalInput(input, { partial: true });
      if (!result.ok) throw new ValidationError(result.fields, result.message);
      const { name, nameKey, serviceIds } = result.value;

      const nowIso = now().toISOString();
      const warnings = await db.transaction(async (tx) => {
        const { changes } =
          name !== undefined
            ? await professionalsRepository.updateName(id, business.id, { name, nameKey, updatedAt: nowIso }, tx)
            : await professionalsRepository.touch(id, business.id, nowIso, tx);
        if (changes === 0) throw notFound();
        if (serviceIds !== undefined) {
          await checkServiceIds(business.id, serviceIds, tx);
          await professionalsRepository.replaceServices(id, business.id, serviceIds, nowIso, tx);
        }
        return name !== undefined ? duplicateWarnings(business.id, nameKey, id, tx) : [];
      });
      event('professional_updated', ownerId, business.id, id);
      return { professional: await findOrFail(id, business.id), warnings };
    },

    /**
     * Remoção lógica, atômica com a contagem de agendamentos futuros (critérios 17 e 19).
     * Se houver agendamentos futuros ou a porta falhar, a transação desfaz tudo.
     * @throws {ProfessionalHasAppointmentsError|NotFoundError|ConflictError}
     */
    async remove(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      const nowIso = now().toISOString();
      let previousPhotoKey;
      try {
        previousPhotoKey = await db.transaction(async (tx) => {
          const removed = await professionalsRepository.markRemoved(id, business.id, nowIso, tx);
          if (removed.changes === 0) throw notFound();
          const count = await appointments.countFutureByProfessional(business.id, id, nowIso, tx);
          if (count > 0) throw new ProfessionalHasAppointmentsError(count);
          return removed.previousPhotoKey;
        });
      } catch (err) {
        if (err instanceof ProfessionalHasAppointmentsError) {
          event('professional_remove_blocked', ownerId, business.id, id, {
            futureAppointmentsCount: err.futureAppointmentsCount,
          });
        }
        throw err;
      }
      event('professional_removed', ownerId, business.id, id);
      await cleanup(previousPhotoKey);
    },

    /**
     * Valida, reprocessa (dentro do limitador de imagem) e grava a foto. A chave é sempre gerada aqui.
     * @param {Buffer} buffer
     * @returns {Promise<import('./professionals.repository.js').Professional>}
     * @throws {NotFoundError|InvalidImageError|ImageBusyError|ConflictError}
     */
    async setPhoto(ownerId, id, buffer) {
      const business = await businessOf(ownerId);
      checkId(id);
      await findOrFail(id, business.id); // 404 antes de processar

      let png;
      try {
        png = await imageLimiter.run(() => processImage(buffer));
      } catch (err) {
        if (err instanceof InvalidImageError) {
          log.info({
            event: 'professional_photo_rejected',
            userId: ownerId,
            businessId: business.id,
            professionalId: id,
            reason: err.reason || 'invalid',
          });
        } else if (err instanceof ImageBusyError) {
          log.warn({ event: 'image_busy', userId: ownerId, businessId: business.id, professionalId: id });
        }
        throw err;
      }

      const key = `professionals/${randomUUID()}.png`;
      await storage.put(key, png);
      let previousKey;
      try {
        let changes;
        ({ previousKey, changes } = await db.transaction((tx) =>
          professionalsRepository.setPhotoKey(id, business.id, key, now().toISOString(), tx),
        ));
        if (changes === 0) throw notFound(); // removido no meio
      } catch (err) {
        await storage.delete(key).catch(() => {});
        throw err;
      }
      await cleanup(previousKey);
      event('professional_photo_updated', ownerId, business.id, id);
      return findOrFail(id, business.id);
    },

    /** Remove a foto. Idempotente (sem foto também passa). @throws {NotFoundError|ConflictError} */
    async removePhoto(ownerId, id) {
      const business = await businessOf(ownerId);
      checkId(id);
      const { previousKey, changes } = await db.transaction((tx) =>
        professionalsRepository.setPhotoKey(id, business.id, null, now().toISOString(), tx),
      );
      if (changes === 0) throw notFound();
      await cleanup(previousKey);
      event('professional_photo_removed', ownerId, business.id, id);
    },
  };
}
