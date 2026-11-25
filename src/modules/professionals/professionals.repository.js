/**
 * @typedef {{ id: string, name: string, active: boolean }} ProfessionalService
 * @typedef {{ id: string, businessId: string, name: string, nameKey: string, photoKey: string|null,
 *   removedAt: string|null, createdAt: string, updatedAt: string, services: ProfessionalService[] }} Professional
 * @typedef {{ id: string, name: string, photoUrl: string|null, services: ProfessionalService[],
 *   bookable: boolean, createdAt: string, updatedAt: string }} OwnerProfessional
 */

const COLUMNS = 'id, business_id, name, name_key, photo_key, removed_at, created_at, updated_at';
const P_COLUMNS = COLUMNS.split(', ')
  .map((c) => `p.${c}`)
  .join(', ');

/** Ordem estável da listagem (critério 21). */
const ORDER_BY = 'ORDER BY name_key ASC, id ASC';

/** Ordem dos serviços do profissional: a mesma do AF-06. */
const SERVICES_ORDER_BY = 'ORDER BY s.active DESC, s.name_key ASC, s.id ASC';

/** Profissional ativo com ao menos um serviço ativo vinculado (contrato 5.5). */
const HAS_ACTIVE_SERVICE = `EXISTS (
  SELECT 1 FROM professional_services ps
  JOIN services s ON s.id = ps.service_id AND s.business_id = ps.business_id
  WHERE ps.professional_id = p.id AND ps.business_id = p.business_id AND s.active = 1
)`;

function fromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    nameKey: row.name_key,
    photoKey: row.photo_key ?? null,
    removedAt: row.removed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    services: [],
  };
}

const placeholdersFor = (list) => list.map(() => '?').join(', ');

/** `professionals/<uuid>.png` -> `/media/professionals/<uuid>.png` */
export function photoUrlOf(photoKey) {
  return photoKey ? `/media/${photoKey}` : null;
}

/**
 * Único caminho para serializar um profissional para o dono. `businessId`, `nameKey`,
 * `photoKey` e `removedAt` não são expostos. `bookable` é true se e somente se há ao menos
 * um serviço ativo vinculado (critério 7).
 * @param {Professional} professional
 * @returns {OwnerProfessional}
 */
export function toOwnerProfessional(professional) {
  const services = (professional.services || []).map((s) => ({ id: s.id, name: s.name, active: Boolean(s.active) }));
  return {
    id: professional.id,
    name: professional.name,
    photoUrl: photoUrlOf(professional.photoKey),
    services,
    bookable: services.some((s) => s.active),
    createdAt: professional.createdAt,
    updatedAt: professional.updatedAt,
  };
}

/**
 * Todo acesso filtra por `business_id`: profissional de outro negócio se comporta como inexistente.
 * Todas as consultas (exceto `findByIdIncludingRemoved`) filtram `removed_at IS NULL`.
 * @param {import('../../db/index.js').Database} db
 */
export function createProfessionalsRepository(db) {
  /**
   * Serviços de vários profissionais numa consulta só (sem N+1).
   * @param {{ activeOnly?: boolean }} [options] activeOnly: só serviços ativos (contratos públicos)
   */
  async function attachServices(businessId, professionals, conn, { activeOnly = false } = {}) {
    if (professionals.length === 0) return professionals;
    const ids = professionals.map((p) => p.id);
    const rows = await conn.all(
      `SELECT ps.professional_id, s.id, s.name, s.active
         FROM professional_services ps
         JOIN services s ON s.id = ps.service_id AND s.business_id = ps.business_id
        WHERE ps.business_id = ? AND ps.professional_id IN (${placeholdersFor(ids)})${activeOnly ? ' AND s.active = 1' : ''}
        ${SERVICES_ORDER_BY}`,
      [businessId, ...ids],
    );
    const byId = new Map(professionals.map((p) => [p.id, p]));
    for (const row of rows) {
      byId.get(row.professional_id).services.push({ id: row.id, name: row.name, active: row.active === 1 });
    }
    return professionals;
  }

  async function listWhere(businessId, where, params, conn, options) {
    const rows = await conn.all(`SELECT ${P_COLUMNS} FROM professionals p WHERE ${where} ${ORDER_BY}`, params);
    return attachServices(businessId, rows.map(fromRow), conn, options);
  }

  async function findOne(businessId, where, params, conn, options) {
    const professional = fromRow(await conn.get(`SELECT ${P_COLUMNS} FROM professionals p WHERE ${where}`, params));
    if (!professional) return undefined;
    await attachServices(businessId, [professional], conn, options);
    return professional;
  }

  return {
    /**
     * Só a linha de `professionals` (os serviços vão em `replaceServices`).
     * @param {{ id: string, businessId: string, name: string, nameKey: string, createdAt: string }} professional
     * @returns {Promise<Professional>}
     */
    async insert({ id, businessId, name, nameKey, createdAt }, conn = db) {
      await conn.run(`INSERT INTO professionals (${COLUMNS}) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`, [
        id,
        businessId,
        name,
        nameKey,
        createdAt,
        createdAt,
      ]);
      return {
        id,
        businessId,
        name,
        nameKey,
        photoKey: null,
        removedAt: null,
        createdAt,
        updatedAt: createdAt,
        services: [],
      };
    },

    /** @returns {Promise<number>} só ativos (removed_at IS NULL) */
    async countActiveByBusinessId(businessId, conn = db) {
      const row = await conn.get(
        'SELECT COUNT(*) AS n FROM professionals WHERE business_id = ? AND removed_at IS NULL',
        [businessId],
      );
      return Number(row.n);
    },

    /** @returns {Promise<number>} ativos com a mesma chave, exceto `exceptId` */
    async countSameName(businessId, nameKey, exceptId, conn = db) {
      const row = await conn.get(
        `SELECT COUNT(*) AS n FROM professionals
          WHERE business_id = ? AND name_key = ? AND removed_at IS NULL AND id <> ?`,
        [businessId, nameKey, exceptId ?? ''],
      );
      return Number(row.n);
    },

    /** @returns {Promise<Professional[]>} ativos, por nome sem acento e id; serviços ativos e desativados */
    async listByBusinessId(businessId, conn = db) {
      return listWhere(businessId, 'p.business_id = ? AND p.removed_at IS NULL', [businessId], conn);
    },

    /** @returns {Promise<Professional|undefined>} só ativo */
    async findById(id, businessId, conn = db) {
      return findOne(businessId, 'p.id = ? AND p.business_id = ? AND p.removed_at IS NULL', [id, businessId], conn);
    },

    /** Histórico (AF-11/14, critério 20): devolve também removidos, para exibir o nome. */
    async findByIdIncludingRemoved(id, businessId, conn = db) {
      return findOne(businessId, 'p.id = ? AND p.business_id = ?', [id, businessId], conn);
    },

    /** @returns {Promise<{ changes: number }>} só ativo */
    async updateName(id, businessId, { name, nameKey, updatedAt }, conn = db) {
      return conn.run(
        `UPDATE professionals SET name = ?, name_key = ?, updated_at = ?
          WHERE id = ? AND business_id = ? AND removed_at IS NULL`,
        [name, nameKey, updatedAt, id, businessId],
      );
    },

    /** Só `updated_at` (PATCH apenas de serviços). @returns {Promise<{ changes: number }>} só ativo */
    async touch(id, businessId, nowIso, conn = db) {
      return conn.run(
        'UPDATE professionals SET updated_at = ? WHERE id = ? AND business_id = ? AND removed_at IS NULL',
        [nowIso, id, businessId],
      );
    },

    /**
     * IDs de `ids` que são serviços do negócio (ativos e desativados).
     * @param {string[]} ids já validados (UUID v4, sem repetição, até 100)
     * @returns {Promise<Set<string>>}
     */
    async findServiceIdsOfBusiness(businessId, ids, conn = db) {
      if (ids.length === 0) return new Set();
      const rows = await conn.all(
        `SELECT id FROM services WHERE business_id = ? AND id IN (${placeholdersFor(ids)})`,
        [businessId, ...ids],
      );
      return new Set(rows.map((r) => r.id));
    },

    /**
     * Substitui a lista inteira de serviços do profissional (`[]` limpa tudo).
     * Pares já existentes ficam (ON CONFLICT DO NOTHING); nunca duplica.
     * @param {string[]} serviceIds sem repetição
     */
    async replaceServices(professionalId, businessId, serviceIds, nowIso, conn = db) {
      return conn.transaction(async (tx) => {
        if (serviceIds.length === 0) {
          await tx.run('DELETE FROM professional_services WHERE professional_id = ? AND business_id = ?', [
            professionalId,
            businessId,
          ]);
          return;
        }
        await tx.run(
          `DELETE FROM professional_services
            WHERE professional_id = ? AND business_id = ? AND service_id NOT IN (${placeholdersFor(serviceIds)})`,
          [professionalId, businessId, ...serviceIds],
        );
        for (const serviceId of serviceIds) {
          await tx.run(
            `INSERT INTO professional_services (professional_id, service_id, business_id, created_at)
             VALUES (?, ?, ?, ?) ON CONFLICT (professional_id, service_id) DO NOTHING`,
            [professionalId, serviceId, businessId, nowIso],
          );
        }
      });
    },

    /**
     * Troca a chave da foto (null remove) e devolve a anterior. Lê e grava na mesma transação.
     * Só ativo: removido dá `changes: 0`.
     * @returns {Promise<{ previousKey: string|null, changes: number }>}
     */
    async setPhotoKey(id, businessId, photoKey, nowIso, conn = db) {
      return conn.transaction(async (tx) => {
        const row = await tx.get(
          'SELECT photo_key FROM professionals WHERE id = ? AND business_id = ? AND removed_at IS NULL',
          [id, businessId],
        );
        if (!row) return { previousKey: null, changes: 0 };
        const { changes } = await tx.run(
          `UPDATE professionals SET photo_key = ?, updated_at = ?
            WHERE id = ? AND business_id = ? AND removed_at IS NULL`,
          [photoKey, nowIso, id, businessId],
        );
        return { previousKey: row.photo_key ?? null, changes };
      });
    },

    /** @returns {Promise<boolean>} */
    async existsPhotoKey(photoKey, conn = db) {
      const row = await conn.get(
        'SELECT 1 AS found FROM professionals WHERE photo_key = ? AND removed_at IS NULL LIMIT 1',
        [photoKey],
      );
      return Boolean(row);
    },

    /**
     * Remoção lógica: grava `removed_at` e limpa a foto. Deve rodar na transação da remoção,
     * ANTES da contagem de agendamentos futuros (o UPDATE disputa a linha com `claimForBooking`).
     * @returns {Promise<{ previousPhotoKey: string|null, changes: number }>}
     */
    async markRemoved(id, businessId, nowIso, conn = db) {
      const row = await conn.get(
        'SELECT photo_key FROM professionals WHERE id = ? AND business_id = ? AND removed_at IS NULL',
        [id, businessId],
      );
      const { changes } = await conn.run(
        `UPDATE professionals SET removed_at = ?, photo_key = NULL, updated_at = ?
          WHERE id = ? AND business_id = ? AND removed_at IS NULL`,
        [nowIso, nowIso, id, businessId],
      );
      return { previousPhotoKey: changes > 0 && row ? row.photo_key ?? null : null, changes };
    },

    // Contrato para AF-09, AF-10 e AF-11 (design 5.5): "agendável" é removed_at IS NULL e ao
    // menos um serviço com active = 1. Rotas públicas e disponibilidade usam só as funções
    // abaixo, nunca listByBusinessId. Os `services` devolvidos aqui são só os ativos.

    /** @returns {Promise<Professional[]>} ativos com >= 1 serviço ativo */
    async findBookableByBusinessId(businessId, conn = db) {
      return listWhere(businessId, `p.business_id = ? AND p.removed_at IS NULL AND ${HAS_ACTIVE_SERVICE}`, [businessId], conn, {
        activeOnly: true,
      });
    },

    /** @returns {Promise<Professional|undefined>} */
    async findBookable(businessId, id, conn = db) {
      return findOne(
        businessId,
        `p.id = ? AND p.business_id = ? AND p.removed_at IS NULL AND ${HAS_ACTIVE_SERVICE}`,
        [id, businessId],
        conn,
        { activeOnly: true },
      );
    },

    /**
     * Consulta inversa (critério 10, "qualquer profissional" do AF-10): ativos vinculados ao
     * serviço, e só se o serviço estiver ativo.
     * @returns {Promise<Professional[]>}
     */
    async findBookableForService(businessId, serviceId, conn = db) {
      return listWhere(
        businessId,
        `p.business_id = ? AND p.removed_at IS NULL AND EXISTS (
           SELECT 1 FROM professional_services ps
           JOIN services s ON s.id = ps.service_id AND s.business_id = ps.business_id
           WHERE ps.professional_id = p.id AND ps.business_id = p.business_id
             AND ps.service_id = ? AND s.active = 1
         )`,
        [businessId, serviceId],
        conn,
        { activeOnly: true },
      );
    },

    /**
     * Trava para o AF-11 (critério 19): dentro da transação de criação do agendamento, antes do
     * INSERT. UPDATE sem efeito que disputa a mesma linha com `markRemoved`. `changes === 0`
     * (removido ou de outro negócio) -> o agendamento deve abortar.
     * @returns {Promise<{ changes: number }>}
     */
    async claimForBooking(id, businessId, conn = db) {
      return conn.run(
        'UPDATE professionals SET updated_at = updated_at WHERE id = ? AND business_id = ? AND removed_at IS NULL',
        [id, businessId],
      );
    },
  };
}
