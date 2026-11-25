/**
 * @typedef {{ id: string, ownerId: string, name: string, slug: string, address: string, phone: string,
 *   timezone: string, logoKey: string|null, createdAt: string, updatedAt: string }} Business
 * @typedef {{ id: string, name: string, slug: string, address: string, phone: string, timezone: string,
 *   logoUrl: string|null, publicUrl: string, createdAt: string, updatedAt: string }} OwnerBusiness
 */

const COLUMNS = 'id, owner_id, name, slug, address, phone, timezone, logo_key, created_at, updated_at';

/** Colunas que `update` pode alterar. Nunca vêm do cliente. */
const UPDATABLE = Object.freeze({ name: 'name', address: 'address', phone: 'phone', slug: 'slug' });

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
    async insert({ id, ownerId, name, slug, address, phone, timezone, createdAt }, conn = db) {
      await conn.run(
        `INSERT INTO businesses (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, ownerId, name, slug, address, phone, timezone, createdAt, createdAt],
      );
      return { id, ownerId, name, slug, address, phone, timezone, logoKey: null, createdAt, updatedAt: createdAt };
    },

    /** @returns {Promise<Business|undefined>} */
    async findByOwnerId(ownerId, conn = db) {
      return fromRow(await conn.get(`SELECT ${COLUMNS} FROM businesses WHERE owner_id = ?`, [ownerId]));
    },

    /**
     * Atualiza só as colunas da lista fixa presentes em `patch`, filtrando por id e dono.
     * @param {string} id
     * @param {string} ownerId
     * @param {{ name?: string, address?: string, phone?: string, slug?: string, updatedAt: string }} patch
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
     * @param {string[]} candidates
     * @returns {Promise<Set<string>>} os candidatos já usados
     */
    async findTakenSlugs(candidates, conn = db) {
      if (candidates.length === 0) return new Set();
      const placeholders = candidates.map(() => '?').join(', ');
      const rows = await conn.all(`SELECT slug FROM businesses WHERE slug IN (${placeholders})`, candidates);
      return new Set(rows.map((r) => r.slug));
    },
  };
}
