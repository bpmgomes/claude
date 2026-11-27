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
/** Quarentena do slug antigo após troca (AF-09, decisão 6; AF-05 item 5). */
export const SLUG_QUARANTINE_DAYS = 30;
/** Teto de slugs em quarentena por negócio: impede o "estoque" de slugs (design AF-09, 5.4). */
export const SLUG_QUARANTINE_PER_BUSINESS_MAX = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  now = () => new Date(), // utc
  log = noopLog,
}) {
  async function getForOwner(ownerId) {
    const business = await businessesRepository.findByOwnerId(ownerId);
    if (!business) throw new NotFoundError('BUSINESS_NOT_FOUND', BUSINESS_NOT_FOUND_MESSAGE);
    return business;
  }

  /** Início da quarentena vigente: liberações depois deste instante ainda valem. */
  function quarantineCutoffIso() {
    return new Date(now().getTime() - SLUG_QUARANTINE_DAYS * DAY_MS).toISOString();
  }

  /** Em uso ou em quarentena de outro negócio. */
  function findTaken(candidates, exceptBusinessId = null) {
    return businessesRepository.findTakenSlugs(candidates, { cutoffIso: quarantineCutoffIso(), exceptBusinessId });
  }

  /**
   * Primeira alternativa livre para `base`, verificada no banco agora; null se nenhuma.
   * Nunca sugere slug em uso nem em quarentena de outro negócio.
   */
  async function suggestSlug(base, { exceptBusinessId = null } = {}) {
    const candidates = [];
    for (let n = SUGGESTION_RANGE.from; n <= SUGGESTION_RANGE.to; n++) {
      const candidate = withSuffix(base, n);
      if (!RESERVED_SLUGS.has(candidate) && validateSlug(candidate).ok) candidates.push(candidate);
    }
    const taken = await findTaken(candidates, exceptBusinessId);
    const free = candidates.find((c) => !taken.has(c));
    if (free) return free;

    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
      const candidate = withSuffix(base, randomInt(1000, 10000));
      if (!validateSlug(candidate).ok) continue;
      const busy = await findTaken([candidate], exceptBusinessId);
      if (!busy.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Slug em uso (constraint) ou em quarentena (SlugTakenError sem sugestão, lançado dentro da
   * transação): a sugestão é calculada aqui, FORA da transação (no SQLite a chamada ao `db`
   * global dentro dela travaria a fila, R2 do AF-07). O corpo é o mesmo nos dois casos.
   */
  async function translateSlugConflict(err, slug, exceptBusinessId = null) {
    if (
      (err instanceof UniqueViolationError && err.constraint === 'businesses_slug_unique') ||
      (err instanceof SlugTakenError && err.suggestion === null)
    ) {
      return new SlugTakenError(await suggestSlug(slug, { exceptBusinessId }));
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
      const id = randomUUID();
      const cutoffIso = quarantineCutoffIso();
      try {
        // Insert e checagem de quarentena na mesma transação (design AF-09, 5.4).
        return await db.transaction(async (tx) => {
          const business = await businessesRepository.insert(
            {
              id,
              ownerId,
              name: value.name,
              slug,
              address: value.address,
              phone: value.phone,
              timezone: DEFAULT_TIMEZONE,
              createdAt,
              cancellationLeadMinutes: value.cancellationLeadMinutes,
            },
            tx,
          );
          if (await businessesRepository.isSlugQuarantined(slug, { cutoffIso, exceptBusinessId: id }, tx)) {
            throw new SlugTakenError(null);
          }
          return business;
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
     * Edição parcial (nome, endereço, telefone, slug e, desde o AF-12, a antecedência de cancelamento).
     * @throws {ValidationError|NotFoundError|SlugTakenError}
     */
    async update(ownerId, input) {
      const business = await getForOwner(ownerId);
      if (!hasBusinessFields(input)) throw new ValidationError({}, MESSAGES.nothingToUpdate);
      const result = validateBusinessInput(input, { partial: true });
      if (!result.ok) throw new ValidationError(result.fields);

      const nowIso = now().toISOString();
      const patch = { ...result.value, updatedAt: nowIso };
      const newSlug = result.value.slug;
      try {
        if (newSlug === undefined || newSlug === business.slug) {
          // Sem troca de slug: sem transação e sem tocar a quarentena.
          await businessesRepository.update(business.id, ownerId, patch);
        } else {
          const cutoffIso = quarantineCutoffIso();
          await db.transaction(async (tx) => {
            const current = await businessesRepository.findByOwnerId(ownerId, tx);
            await businessesRepository.update(business.id, ownerId, patch, tx);
            const quarantined = await businessesRepository.isSlugQuarantined(
              newSlug,
              { cutoffIso, exceptBusinessId: business.id },
              tx,
            );
            if (quarantined) throw new SlugTakenError(null);
            await businessesRepository.releaseQuarantine(newSlug, business.id, tx);
            const oldSlug = current ? current.slug : business.slug;
            if (oldSlug !== newSlug) {
              await businessesRepository.quarantineSlug(oldSlug, business.id, nowIso, tx);
              await businessesRepository.trimQuarantine(business.id, SLUG_QUARANTINE_PER_BUSINESS_MAX, tx);
            }
          });
        }
      } catch (err) {
        throw await translateSlugConflict(err, newSlug, business.id);
      }
      return getForOwner(ownerId);
    },

    /**
     * Checagem de disponibilidade enquanto o dono digita. O slug atual do próprio dono e os
     * slugs dele em quarentena contam como livres; a quarentena de outro negócio dá TAKEN.
     * `INVALID` não ecoa a entrada (sem `slug`, AF-05 item 6).
     * @returns {Promise<{ slug?: string, available: boolean, reason?: string, message?: string, suggestion?: string }>}
     */
    async checkSlug(ownerId, raw) {
      const check = validateSlug(raw);
      if (!check.ok) {
        if (check.reason === 'INVALID') return { available: false, reason: check.reason, message: check.message };
        return { slug: normalizeSlug(raw), available: false, reason: check.reason, message: check.message };
      }
      const slug = check.value;
      const own = await businessesRepository.findByOwnerId(ownerId);
      if (own && own.slug === slug) return { slug, available: true };
      const exceptBusinessId = own ? own.id : null;
      const taken = await findTaken([slug], exceptBusinessId);
      if (!taken.has(slug)) return { slug, available: true };
      const response = { slug, available: false, reason: 'TAKEN', message: SLUG_TAKEN_MESSAGE };
      const suggestion = await suggestSlug(slug, { exceptBusinessId });
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
