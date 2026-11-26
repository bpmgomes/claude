/**
 * @typedef {{ id: string, businessId: string, name: string, nameKey: string, durationMinutes: number,
 *   priceCents: number|null, priceOnRequest: boolean, active: boolean, createdAt: string, updatedAt: string }} Service
 * @typedef {{ id: string, name: string, durationMinutes: number, priceCents: number|null,
 *   priceOnRequest: boolean, active: boolean, createdAt: string, updatedAt: string }} OwnerService
 * @typedef {Readonly<{ serviceId: string, name: string, durationMinutes: number, priceCents: number|null,
 *   priceOnRequest: boolean }>} ServiceSnapshot
 */

const COLUMNS =
  'id, business_id, name, name_key, duration_minutes, price_cents, price_on_request, active, created_at, updated_at';

const ORDER_BY = 'ORDER BY active DESC, name_key ASC, id ASC';

/** Colunas que `update` pode alterar. Nunca vêm do cliente. */
const UPDATABLE = Object.freeze({
  name: 'name',
  nameKey: 'name_key',
  durationMinutes: 'duration_minutes',
  priceCents: 'price_cents',
  priceOnRequest: 'price_on_request',
});

const STATUS_WHERE = Object.freeze({ all: '', active: ' AND active = 1', inactive: ' AND active = 0' });

const toFlag = (value) => (value ? 1 : 0);

function toColumnValue(key, value) {
  return key === 'priceOnRequest' ? toFlag(value) : value;
}

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    nameKey: row.name_key,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents ?? null,
    priceOnRequest: row.price_on_request === 1,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Único caminho para serializar um serviço para o dono. `businessId` e `nameKey` não são expostos.
 * @param {Service} service
 * @returns {OwnerService}
 */
export function toOwnerService(service) {
  return {
    id: service.id,
    name: service.name,
    durationMinutes: service.durationMinutes,
    priceCents: service.priceOnRequest ? null : service.priceCents,
    priceOnRequest: service.priceOnRequest,
    active: service.active,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

/**
 * Contrato para o AF-11 (critério 11, decisão 4): cópia rasa e congelada do que vale no
 * momento do agendamento. Editar ou desativar o serviço depois não altera a cópia.
 * @param {Service} service
 * @returns {ServiceSnapshot}
 */
export function toServiceSnapshot(service) {
  return Object.freeze({
    serviceId: service.id,
    name: service.name,
    durationMinutes: service.durationMinutes,
    priceCents: service.priceOnRequest ? null : service.priceCents,
    priceOnRequest: service.priceOnRequest,
  });
}

/**
 * Todo acesso filtra por `business_id`: serviço de outro negócio se comporta como inexistente.
 * @param {import('../../db/index.js').Database} db
 */
export function createServicesRepository(db) {
  return {
    /**
     * @param {Service} service
     * @returns {Promise<Service>}
     * @throws {import('../../db/errors.js').UniqueViolationError} services_business_id_name_key_unique
     */
    async insert(service, conn = db) {
      const { id, businessId, name, nameKey, durationMinutes, priceCents, priceOnRequest, createdAt } = service;
      const active = service.active === undefined ? true : Boolean(service.active);
      const updatedAt = service.updatedAt || createdAt;
      await conn.run(`INSERT INTO services (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        businessId,
        name,
        nameKey,
        durationMinutes,
        priceCents,
        toFlag(priceOnRequest),
        toFlag(active),
        createdAt,
        updatedAt,
      ]);
      return {
        id,
        businessId,
        name,
        nameKey,
        durationMinutes,
        priceCents,
        priceOnRequest: Boolean(priceOnRequest),
        active,
        createdAt,
        updatedAt,
      };
    },

    /** @returns {Promise<number>} ativos e desativados */
    async countByBusinessId(businessId, conn = db) {
      const row = await conn.get('SELECT COUNT(*) AS n FROM services WHERE business_id = ?', [businessId]);
      return Number(row.n);
    },

    /**
     * @param {{ status?: 'all'|'active'|'inactive' }} [options]
     * @returns {Promise<Service[]>} ativos primeiro, depois nome sem acento, desempate por id
     */
    async listByBusinessId(businessId, { status = 'all' } = {}, conn = db) {
      const where = STATUS_WHERE[status];
      if (where === undefined) throw new Error('status inválido');
      const rows = await conn.all(`SELECT ${COLUMNS} FROM services WHERE business_id = ?${where} ${ORDER_BY}`, [
        businessId,
      ]);
      return rows.map(fromRow);
    },

    /** @returns {Promise<Service|undefined>} */
    async findById(id, businessId, conn = db) {
      return fromRow(
        await conn.get(`SELECT ${COLUMNS} FROM services WHERE id = ? AND business_id = ?`, [id, businessId]),
      );
    },

    /** @returns {Promise<Service|undefined>} usado só para escolher a mensagem do 409 */
    async findByNameKey(businessId, nameKey, conn = db) {
      return fromRow(
        await conn.get(`SELECT ${COLUMNS} FROM services WHERE business_id = ? AND name_key = ?`, [
          businessId,
          nameKey,
        ]),
      );
    },

    /**
     * Atualiza só as colunas da lista fixa presentes em `patch` (`!== undefined`: null em
     * `priceCents` grava NULL), num único UPDATE filtrado por id e negócio.
     * @param {{ name?: string, nameKey?: string, durationMinutes?: number, priceCents?: number|null,
     *   priceOnRequest?: boolean, updatedAt: string }} patch
     * @returns {Promise<{ changes: number }>}
     * @throws {import('../../db/errors.js').UniqueViolationError}
     */
    async update(id, businessId, patch, conn = db) {
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(UPDATABLE)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(toColumnValue(key, patch[key]));
      }
      sets.push('updated_at = ?');
      params.push(patch.updatedAt);
      return conn.run(`UPDATE services SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [
        ...params,
        id,
        businessId,
      ]);
    },

    /** @returns {Promise<{ changes: number }>} */
    async setActive(id, businessId, active, nowIso, conn = db) {
      return conn.run('UPDATE services SET active = ?, updated_at = ? WHERE id = ? AND business_id = ?', [
        toFlag(active),
        nowIso,
        id,
        businessId,
      ]);
    },

    // Contrato para AF-09, AF-10 e AF-11 (critério 14): "disponível" é active = 1.
    // Rotas públicas usam só estas duas funções, nunca listByBusinessId.

    /** @returns {Promise<Service[]>} só ativos, mesma ordem da listagem */
    async findActiveByBusinessId(businessId, conn = db) {
      const rows = await conn.all(`SELECT ${COLUMNS} FROM services WHERE business_id = ? AND active = 1 ${ORDER_BY}`, [
        businessId,
      ]);
      return rows.map(fromRow);
    },

    /**
     * Trava da linha do serviço ativo para a reserva (AF-11, 4.3): UPDATE sem efeito que, no
     * PostgreSQL, trava a linha até o fim da transação e serializa contra `setActive` (AF-06).
     * Ordem global de travas: businesses -> services -> professionals (por id).
     * `changes === 0`: desativado (ou de outro negócio) entre a pré-checagem e a trava (404).
     * @returns {Promise<{ changes: number }>}
     */
    async lockBookable(id, businessId, conn = db) {
      return conn.run('UPDATE services SET updated_at = updated_at WHERE id = ? AND business_id = ? AND active = 1', [
        id,
        businessId,
      ]);
    },

    /** @returns {Promise<Service|undefined>} só se ativo; sob consulta incluído (decisão 5) */
    async findBookable(businessId, id, conn = db) {
      return fromRow(
        await conn.get(`SELECT ${COLUMNS} FROM services WHERE id = ? AND business_id = ? AND active = 1`, [
          id,
          businessId,
        ]),
      );
    },
  };
}
