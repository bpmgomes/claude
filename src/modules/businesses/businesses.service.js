import { randomUUID, randomInt } from 'node:crypto';
import { validateBusinessInput, hasBusinessFields, normalizeText, MESSAGES } from '../../shared/validation.js';
import { slugify, validateSlug, normalizeSlug, withSuffix, RESERVED_SLUGS } from '../../shared/slug.js';
import { UniqueViolationError } from '../../db/errors.js';
import {
  ValidationError,
  ConflictError,
  NotFoundError,
  SlugTakenError,
  SLUG_TAKEN_MESSAGE,
} from '../../http/errors.js';
import { processLogo as defaultProcessLogo } from './logo-image.js';
import { unlimitedImageLimiter } from '../../images/image-limiter.js';

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const NEXT_STEP_PATH = '/servicos';

const BUSINESS_NOT_FOUND_MESSAGE = 'Você ainda não cadastrou seu negócio.';
const BUSINESS_EXISTS_MESSAGE = 'Você já cadastrou seu negócio.';
const SUGGESTION_RANGE = { from: 2, to: 20 };
const RANDOM_ATTEMPTS = 3;

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {{
 *   db: import('../../db/index.js').Database,
 *   businessesRepository: ReturnType<typeof import('./businesses.repository.js').createBusinessesRepository>,
 *   storage: import('../../storage/index.js').Storage,
 *   processLogo?: (buffer: Buffer) => Promise<Buffer>,
 *   imageLimiter?: { run<T>(task: () => Promise<T>): Promise<T> },
 *   config: object,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function },
 * }} deps
 */
export function createBusinessesService({
  db,
  businessesRepository,
  storage,
  processLogo = defaultProcessLogo,
  imageLimiter = unlimitedImageLimiter,
  // eslint-disable-next-line no-unused-vars
  config,
  now = () => new Date(),
  log = noopLog,
}) {
  async function getForOwner(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new NotFoundError('BUSINESS_NOT_FOUND', BUSINESS_NOT_FOUND_MESSAGE);
    return business;
  }

  /** Primeira alternativa livre para `base`, verificada no banco agora; null se nenhuma. */
  async function suggestSlug(base) {
    const candidates = [];
    for (let n = SUGGESTION_RANGE.from; n <= SUGGESTION_RANGE.to; n++) {
      const candidate = withSuffix(base, n);
      if (!RESERVED_SLUGS.has(candidate) && validateSlug(candidate).ok) candidates.push(candidate);
    }
    const taken = await businessesRepository.findTakenSlugs(candidates);
    const free = candidates.find((c) => !taken.has(c));
    if (free) return free;

    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
      const candidate = withSuffix(base, randomInt(1000, 10000));
      if (!validateSlug(candidate).ok) continue;
      const busy = await businessesRepository.findTakenSlugs([candidate]);
      if (!busy.has(candidate)) return candidate;
    }
    return null;
  }

  async function translateSlugConflict(err, slug) {
    if (err instanceof UniqueViolationError && err.constraint === 'businesses_slug_unique') {
      return new SlugTakenError(await suggestSlug(slug));
    }
    return err;
  }

  return {
    getForOwner,
    suggestSlug,

    /**
     * Cria o negócio do dono. Sem SELECT prévio: as constraints são a fonte de verdade.
     * @returns {Promise<import('./businesses.repository.js').Business>}
     * @throws {ValidationError|ConflictError|SlugTakenError}
     */
    async create(ownerId, input) {
      const result = validateBusinessInput(input);
      const fields = result.ok ? {} : { ...result.fields };
      const value = result.ok ? result.value : {};
      let slug = value.slug;
      if (slug === undefined && !fields.slug && !fields.name) {
        const src = input && typeof input === 'object' ? input : {};
        const generated = validateSlug(slugify(normalizeText(src.name)));
        if (generated.ok) slug = generated.value;
        else fields.slug = generated.message;
      }
      if (Object.keys(fields).length > 0) throw new ValidationError(fields);

      const createdAt = now().toISOString();
      try {
        return await businessesRepository.insert({
          id: randomUUID(),
          ownerId,
          name: value.name,
          slug,
          address: value.address,
          phone: value.phone,
          timezone: DEFAULT_TIMEZONE,
          createdAt,
        });
      } catch (err) {
        if (err instanceof UniqueViolationError && err.constraint === 'businesses_owner_id_unique') {
          throw new ConflictError('BUSINESS_ALREADY_EXISTS', BUSINESS_EXISTS_MESSAGE);
        }
        if (err instanceof UniqueViolationError && err.constraint === 'businesses_slug_unique') {
          // Duas criações simultâneas do mesmo dono com o mesmo slug: o SQLite pode acusar
          // o slug antes do dono. Para o dono, o conflito real é já ter negócio.
          if (await businessesRepository.findByOwnerId(ownerId)) {
            throw new ConflictError('BUSINESS_ALREADY_EXISTS', BUSINESS_EXISTS_MESSAGE);
          }
        }
        throw await translateSlugConflict(err, slug);
      }
    },

    /**
     * Edição parcial (nome, endereço, telefone, slug).
     * @throws {ValidationError|NotFoundError|SlugTakenError}
     */
    async update(ownerId, input) {
      const business = await getForOwner(ownerId);
      if (!hasBusinessFields(input)) throw new ValidationError({}, MESSAGES.nothingToUpdate);
      const result = validateBusinessInput(input, { partial: true });
      if (!result.ok) throw new ValidationError(result.fields);

      try {
        await businessesRepository.update(business.id, ownerId, {
          ...result.value,
          updatedAt: now().toISOString(),
        });
      } catch (err) {
        throw await translateSlugConflict(err, result.value.slug);
      }
      return getForOwner(ownerId);
    },

    /**
     * Checagem de disponibilidade enquanto o dono digita. O slug atual do próprio dono conta como livre.
     * @returns {Promise<{ slug: string, available: boolean, reason?: string, message?: string, suggestion?: string }>}
     */
    async checkSlug(ownerId, raw) {
      const check = validateSlug(raw);
      if (!check.ok) {
        return { slug: normalizeSlug(raw), available: false, reason: check.reason, message: check.message };
      }
      const slug = check.value;
      const own = await businessesRepository.findByOwnerId(ownerId);
      if (own && own.slug === slug) return { slug, available: true };
      const taken = await businessesRepository.findTakenSlugs([slug]);
      if (!taken.has(slug)) return { slug, available: true };
      const response = { slug, available: false, reason: 'TAKEN', message: SLUG_TAKEN_MESSAGE };
      const suggestion = await suggestSlug(slug);
      if (suggestion) response.suggestion = suggestion;
      return response;
    },

    /**
     * Valida, reprocessa (dentro do limitador de imagem compartilhado) e grava o logo.
     * A chave é sempre gerada aqui; `storage.put` e a transação ficam fora da vaga.
     * @param {string} ownerId
     * @param {Buffer} buffer
     * @throws {NotFoundError|import('../../http/errors.js').InvalidImageError|import('../../http/errors.js').ImageBusyError}
     */
    async setLogo(ownerId, buffer) {
      const business = await getForOwner(ownerId);
      const png = await imageLimiter.run(() => processLogo(buffer));
      const key = `logos/${randomUUID()}.png`;
      await storage.put(key, png);

      let previousKey;
      try {
        ({ previousKey } = await db.transaction((tx) =>
          businessesRepository.setLogoKey(business.id, ownerId, key, now().toISOString(), tx),
        ));
      } catch (err) {
        await storage.delete(key).catch(() => {});
        throw err;
      }
      await cleanup(previousKey);
      return getForOwner(ownerId);
    },

    /** Remove o logo. Idempotente. @throws {NotFoundError} */
    async removeLogo(ownerId) {
      const business = await getForOwner(ownerId);
      const { previousKey } = await db.transaction((tx) =>
        businessesRepository.setLogoKey(business.id, ownerId, null, now().toISOString(), tx),
      );
      await cleanup(previousKey);
    },
  };

  /** Apaga a chave substituída em best effort: ela já não é servida (não está no banco). */
  async function cleanup(previousKey) {
    if (!previousKey) return;
    try {
      await storage.delete(previousKey);
    } catch {
      log.warn({ event: 'logo_cleanup_failed', key: previousKey });
    }
  }
}
