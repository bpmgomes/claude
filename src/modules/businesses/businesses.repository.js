import { CANCELLATION_LEAD_DEFAULT_MINUTES } from '../../shared/validation.js';

/**
 * @typedef {{ id: string, ownerId: string, name: string, slug: string, address: string, phone: string,
 *   timezone: string, logoKey: string|null, cancellationLeadMinutes: number, createdAt: string,
 *   updatedAt: string }} Business
 * @typedef {{ id: string, name: string, slug: string, address: string, phone: string, timezone: string,
 *   logoUrl: string|null, publicUrl: string, cancellationLeadMinutes: number, createdAt: string,
 *   updatedAt: string }} OwnerBusiness
 */

const INSERT_COLUMNS = 'id, owner_id, name, slug, address, phone, timezone, logo_key, created_at, updated_at';
/** Leitura: as do insert mais a antecedência do AF-12 (migração 012, DEFAULT 120). */
const COLUMNS = `${INSERT_COLUMNS}, cancellation_lead_minutes`;

/** Colunas que `update` pode alterar. Nunca vêm do cliente. */
const UPDATABLE = Object.freeze({
  name: 'name',
  address: 'address',
  phone: 'phone',
  slug: 'slug',
  cancellationLeadMinutes: 'cancellation_lead_minutes',
});

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    phone: row.phone,
    timezone: row.timezone,
    logoKey: row.logo_key ?? null,
    cancellationLeadMinutes: Number(row.cancellation_lead_minutes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `logos/<uuid>.png` -> `/media/logos/<uuid>.png` */
export function logoUrlOf(logoKey) {
  return logoKey ? `/media/${logoKey}` : null;
}

/**
 * Único caminho para serializar um negócio para fora do backend (o dono).
 * `ownerId` e `logoKey` não são expostos.
 * @param {Business} business
 * @param {{ publicBaseUrl: string }} options
 * @returns {OwnerBusiness}
 */
export function toOwnerBusiness(business, { publicBaseUrl }) {
  return {
    id: business.id,
    name: business.name,
    slug: business.slug,
    address: business.address,
    phone: business.phone,
    timezone: business.timezone,
    logoUrl: logoUrlOf(business.logoKey),
    publicUrl: `${publicBaseUrl}/${business.slug}`,
    cancellationLeadMinutes: business.cancellationLeadMinutes,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  };
}

/** @param {import('../../db/index.js').Database} db */
export function createBusinessesRepository(db) {
  return {
    /**
     * @returns {Promise<Business>}
     * @throws {import('../../db/errors.js').UniqueViolationError}
     */
    async insert({ id, ownerId, name, slug, address, phone, timezone, createdAt, cancellationLeadMinutes }, conn = db) {
      // Sem a antecedência, vale o DEFAULT 120 do banco (AF-12, critério 1).
      const withLead = cancellationLeadMinutes !== undefined;
      await conn.run(
        withLead
          ? `INSERT INTO businesses (${INSERT_COLUMNS}, cancellation_lead_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
          : `INSERT INTO businesses (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, ownerId, name, slug, address, phone, timezone, createdAt, createdAt, ...(withLead ? [cancellationLeadMinutes] : [])],
      );
      return {
        id,
        ownerId,
        name,
        slug,
        address,
        phone,
        timezone,
        logoKey: null,
        cancellationLeadMinutes: withLead ? cancellationLeadMinutes : CANCELLATION_LEAD_DEFAULT_MINUTES,
        createdAt,
        updatedAt: createdAt,
      };
    },

    /**
     * Por id (AF-12: o token determina o negócio; nunca vem do cliente).
     * @returns {Promise<Business|undefined>}
     */
    async findById(id, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM businesses WHERE id = ?`, [id]));
    },

    /**
     * Trava da linha do negócio: UPDATE sem efeito que, no PostgreSQL, trava a linha até o fim da
     * transação (AF-16: serializa criações e remoções de bloqueio e o teto de 500 ativos).
     * @returns {Promise<{ changes: number }>}
     */
    async lockById(id, conn = db) {
      return conn.run('UPDATE businesses SET updated_at = updated_at WHERE id = ?', [id]);
    },

    /** @returns {Promise<Business|undefined>} */
    async findByOwnerId(ownerId, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM businesses WHERE owner_id = ?`, [ownerId]));
    },

    /**
     * Atualiza só as colunas da lista fixa presentes em `patch`, filtrando por id e dono.
     * @param {string} id
     * @param {string} ownerId
     * @param {{ name?: string, address?: string, phone?: string, slug?: string,
     *   cancellationLeadMinutes?: number, updatedAt: string }} patch
     * @returns {Promise<{ changes: number }>}
     * @throws {import('../../db/errors.js').UniqueViolationError}
     */
    async update(id, ownerId, patch, conn = db) {
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(UPDATABLE)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(patch[key]);
      }
      sets.push('updated_at = ?');
      params.push(patch.updatedAt);
      return conn.run(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, [
        ...params,
        id,
        ownerId,
      ]);
    },

    /**
     * Troca a chave do logo (null remove) e devolve a anterior. Lê e grava na mesma transação.
     * @returns {Promise<{ previousKey: string|null, changes: number }>}
     */
    async setLogoKey(id, ownerId, logoKey, nowIso, conn = db) {
      return conn.transaction(async (tx) => {
        const row = await tx.get('SELECT logo_key FROM businesses WHERE id = ? AND owner_id = ?', [id, ownerId]);
        if (!row) return { previousKey: null, changes: 0 };
        const { changes } = await tx.run(
          'UPDATE businesses SET logo_key = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
          [logoKey, nowIso, id, ownerId],
        );
        return { previousKey: row.logo_key ?? null, changes };
      });
    },

    /** @returns {Promise<boolean>} */
    async existsLogoKey(logoKey, conn = db) {
      const row = await conn.get('SELECT 1 AS found FROM businesses WHERE logo_key = ? LIMIT 1', [logoKey]);
      return Boolean(row);
    },

    /**
     * Igualdade exata (maiúsculas não casam). Só para a rota pública (AF-09), que já recebe
     * o slug canônico.
     * @returns {Promise<Business|undefined>}
     */
    async findBySlug(slug, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM businesses WHERE slug = ?`, [slug]));
    },

    /**
     * Candidatos indisponíveis: em uso (businesses.slug) e, com `cutoffIso`, também os em
     * quarentena vigente de OUTRO negócio (`released_at > cutoffIso` e
     * `business_id <> exceptBusinessId`). Sem `cutoffIso`, só os em uso.
     * @param {string[]} candidates
     * @param {{ cutoffIso?: string, exceptBusinessId?: string|null }} [options]
     * @returns {Promise<Set<string>>}
     */
    async findTakenSlugs(candidates, { cutoffIso, exceptBusinessId = null } = {}, conn = db) {
      if (candidates.length === 0) return new Set();
      const placeholders = candidates.map(() => '?').join(', ');
      let sql = `SELECT slug FROM businesses WHERE slug IN (${placeholders})`;
      const params = [...candidates];
      if (cutoffIso) {
        sql += ` UNION SELECT slug FROM slug_quarantine
                  WHERE slug IN (${placeholders}) AND released_at > ? AND (? IS NULL OR business_id <> ?)`;
        params.push(...candidates, cutoffIso, exceptBusinessId, exceptBusinessId);
      }
      const rows = await conn.all(sql, params);
      return new Set(rows.map((r) => r.slug));
    },

    /**
     * Slug em quarentena vigente de outro negócio (design AF-09, 5.4).
     * @param {string} slug
     * @param {{ cutoffIso: string, exceptBusinessId: string|null }} options
     * @returns {Promise<boolean>}
     */
    async isSlugQuarantined(slug, { cutoffIso, exceptBusinessId = null }, conn = db) {
      const row = await conn.get(
        `SELECT 1 AS found FROM slug_quarantine
          WHERE slug = ? AND released_at > ? AND (? IS NULL OR business_id <> ?) LIMIT 1`,
        [slug, cutoffIso, exceptBusinessId, exceptBusinessId],
      );
      return Boolean(row);
    },

    /** Grava o slug liberado (upsert: um slug só tem uma linha). */
    async quarantineSlug(slug, businessId, releasedAtIso, conn = db) {
      await conn.run(
        `INSERT INTO slug_quarantine (slug, business_id, released_at) VALUES (?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET business_id = excluded.business_id, released_at = excluded.released_at`,
        [slug, businessId, releasedAtIso],
      );
    },

    /** O dono volta ao próprio slug antigo: tira a linha da quarentena. */
    async releaseQuarantine(slug, businessId, conn = db) {
      return conn.run('DELETE FROM slug_quarantine WHERE slug = ? AND business_id = ?', [slug, businessId]);
    },

    /** Mantém só os `keep` slugs mais recentes do negócio em quarentena. */
    async trimQuarantine(businessId, keep, conn = db) {
      return conn.run(
        `DELETE FROM slug_quarantine WHERE business_id = ? AND slug NOT IN (
           SELECT slug FROM slug_quarantine WHERE business_id = ? ORDER BY released_at DESC, slug ASC LIMIT ?
         )`,
        [businessId, businessId, keep],
      );
    },
  };
}
